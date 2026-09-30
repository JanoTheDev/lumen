"""Stdio protocol writer.

stdout carries protocol frames only (one JSON object per line). Importing this
module claims the real stdout for the writer thread and points both
``sys.stdout`` and file descriptor 1 at stderr, so stray prints or native
library output can never corrupt the stream. Import it before anything else.
"""
import json
import os
import queue
import sys
import threading

_out = os.fdopen(
    os.dup(sys.stdout.fileno()), "w", encoding="utf-8", errors="replace", newline="\n", buffering=1
)
try:
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
except OSError:
    pass
sys.stdout = sys.stderr
try:
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

version = 1

_STOP = object()
_q: "queue.Queue[object]" = queue.Queue()


def _writer() -> None:
    while True:
        line = _q.get()
        if line is _STOP:
            return
        try:
            _out.write(line + "\n")
            _out.flush()
        except (OSError, ValueError):
            return


_thread = threading.Thread(target=_writer, name="proto-writer", daemon=True)
_thread.start()


def send(obj: dict) -> None:
    """Queues one frame. Non-blocking; safe from any thread, including hook callbacks."""
    _q.put(json.dumps(obj, ensure_ascii=False))


def set_version(v: int) -> None:
    """Selects the wire framing: 1 (flat, default) or 2 (plans CONTRACTS C2)."""
    global version
    version = 2 if v == 2 else 1


def respond(id, result=None, error=None) -> None:
    """Sends a response. `error` is an AgentError-like object (code, message) or a string."""
    if version == 2:
        if error is None:
            send({"v": 2, "id": id, "ok": True, "result": {} if result is None else result})
        else:
            code = getattr(error, "code", "E_INTERNAL")
            message = getattr(error, "message", None) or str(error)
            send({"v": 2, "id": id, "ok": False, "error": {"code": code, "message": message}})
    elif error is not None:
        send({"id": id, "error": getattr(error, "message", None) or str(error)})
    else:
        send({"id": id, "result": result})


def emit(event: str, data: dict | None = None) -> None:
    if version == 2:
        send({"v": 2, "event": event, "data": data or {}})
        return
    msg = {"event": event}
    if data:
        msg.update(data)
    send(msg)


def ready(info: dict) -> None:
    """v2 handshake; must be the first frame on stdout."""
    send({"v": 2, "event": "ready", "data": info})


def close(timeout: float = 2.0) -> None:
    """Flushes queued frames and stops the writer."""
    _q.put(_STOP)
    _thread.join(timeout)
