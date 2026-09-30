"""Command dispatch lanes and cancellation.

- inline: runs on the reader thread; must return within a few ms
  (ping, set_hotkey, wake_*, dwell_*, cancel, init, subscribe).
- input: a single FIFO worker, so synthetic input never interleaves.
- read: a small pool for captures, window queries, OCR and UIA.

Every queued call gets a CancelToken. `cancel(target)` answers the target
with E_CANCELLED right away and flags the token; the worker stops at its next
check and its late result is dropped. An optional `timeoutMs` arg does the
same with E_TIMEOUT.
"""
import ctypes
import logging
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from errors import AgentError, E_CANCELLED, E_INTERNAL, E_TIMEOUT, E_UNSUPPORTED

log = logging.getLogger(__name__)

INLINE = "inline"
INPUT = "input"
READ = "read"

COINIT_MULTITHREADED = 0x0


class CancelToken:
    def __init__(self):
        self._event = threading.Event()
        self.code = E_CANCELLED

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def cancel(self, code: str = E_CANCELLED) -> None:
        if not self._event.is_set():
            self.code = code
            self._event.set()

    def check(self) -> None:
        if self._event.is_set():
            raise AgentError(self.code, "cancelled" if self.code == E_CANCELLED else "timed out")

    def sleep(self, seconds: float) -> None:
        """Sleeps up to `seconds`, raising as soon as the token is cancelled."""
        if self._event.wait(max(0.0, seconds)):
            self.check()


def _com_init() -> None:
    # Worker threads join the MTA so UIA/COM objects can be shared between them.
    if sys.platform == "win32":
        ctypes.windll.ole32.CoInitializeEx(None, COINIT_MULTITHREADED)


class _Call:
    __slots__ = ("id", "cmd", "token", "timer")

    def __init__(self, id, cmd):
        self.id = id
        self.cmd = cmd
        self.token = CancelToken()
        self.timer = None


class Dispatcher:
    def __init__(self, reply, read_workers: int = 3):
        """`reply(id, result, error)` sends one response; error is an AgentError or None."""
        self._reply = reply
        self._commands: dict = {}
        self._inflight: dict = {}
        self._lock = threading.Lock()
        self._active = {INPUT: 0, READ: 0}
        self._idle_at = {INPUT: 0.0, READ: 0.0}
        self._lanes = {
            INPUT: ThreadPoolExecutor(1, thread_name_prefix="input", initializer=_com_init),
            READ: ThreadPoolExecutor(read_workers, thread_name_prefix="read", initializer=_com_init),
        }

    def register(self, cmd: str, fn, lane: str = INLINE, timeout_ms: float | None = None) -> None:
        """`fn(args, token)` returns the result or raises AgentError. `timeout_ms` is the default
        agent-side timeout when the request has no `timeoutMs`."""
        self._commands[cmd] = (fn, lane, timeout_ms)

    def lane_of(self, cmd: str):
        entry = self._commands.get(cmd)
        return entry[1] if entry else None

    def dispatch(self, id, cmd, args: dict) -> None:
        entry = self._commands.get(cmd)
        if entry is None:
            self._reply(id, None, AgentError(E_UNSUPPORTED, f"Unknown command: {cmd}"))
            return
        fn, lane, default_timeout = entry
        if lane == INLINE:
            self._reply(id, *self._invoke(cmd, fn, args, CancelToken()))
            return

        call = _Call(id, cmd)
        with self._lock:
            self._inflight[id] = call
        timeout_ms = args.get("timeoutMs", default_timeout) if isinstance(args, dict) else default_timeout
        if isinstance(timeout_ms, (int, float)) and not isinstance(timeout_ms, bool) and timeout_ms > 0:
            call.timer = threading.Timer(timeout_ms / 1000.0, self._expire, (call,))
            call.timer.daemon = True
            call.timer.start()
        with self._lock:
            self._active[lane] += 1
        self._lanes[lane].submit(self._run, call, fn, args, lane)

    def _invoke(self, cmd, fn, args, token):
        try:
            return fn(args, token), None
        except AgentError as e:
            return None, e
        except Exception as e:
            log.exception("%s failed", cmd)
            return None, AgentError(E_INTERNAL, f"{cmd} failed: {e}" if str(e) else f"{cmd} failed")

    def _run(self, call: _Call, fn, args, lane) -> None:
        try:
            if call.token.cancelled:
                return
            result, error = self._invoke(call.cmd, fn, args, call.token)
            self._finish(call, result, error)
        finally:
            with self._lock:
                self._active[lane] -= 1
                self._idle_at[lane] = time.monotonic()

    def lane_busy(self, lane: str, grace_s: float = 0.0) -> bool:
        """True while `lane` has queued/running calls, or finished one less than `grace_s` ago."""
        with self._lock:
            return self._active[lane] > 0 or time.monotonic() - self._idle_at[lane] < grace_s

    def _finish(self, call: _Call, result, error) -> bool:
        with self._lock:
            if self._inflight.get(call.id) is not call:
                return False
            del self._inflight[call.id]
        if call.timer is not None:
            call.timer.cancel()
        self._reply(call.id, result, error)
        return True

    def _expire(self, call: _Call) -> None:
        call.token.cancel(E_TIMEOUT)
        self._finish(call, None, AgentError(E_TIMEOUT, f"{call.cmd} timed out"))

    def cancel(self, target) -> bool:
        """Cancels an in-flight call. Returns False if it already finished."""
        with self._lock:
            call = self._inflight.get(target)
        if call is None:
            return False
        call.token.cancel()
        return self._finish(call, None, AgentError(E_CANCELLED, f"{call.cmd} cancelled"))

    def shutdown(self, wait: bool = True) -> None:
        for pool in self._lanes.values():
            pool.shutdown(wait=wait, cancel_futures=True)
