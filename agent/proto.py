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


def respond(id, result=None, error=None) -> None:
    if error is not None:
        send({"id": id, "error": str(error)})
    else:
        send({"id": id, "result": result})


def emit(event: str, data: dict | None = None) -> None:
    msg = {"event": event}
    if data:
        msg.update(data)
    send(msg)


def close(timeout: float = 2.0) -> None:
    """Flushes queued frames and stops the writer."""
    _q.put(_STOP)
    _thread.join(timeout)
