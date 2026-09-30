"""`mouse-moved` events, only while subscribed (polls the cursor at 20 Hz)."""
import math
import threading

MOVE_PX = 12
POLL_S = 0.05


class MouseWatcher:
    def __init__(self, emit, pos_fn=None):
        self._emit = emit
        self._pos = pos_fn
        self._lock = threading.Lock()
        self._thread = None
        self._stop = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def set_enabled(self, enabled: bool) -> None:
        with self._lock:
            if enabled and not self.running:
                self._stop = threading.Event()
                self._thread = threading.Thread(target=self._loop, args=(self._stop,), name="mouse-watch",
                                                daemon=True)
                self._thread.start()
            elif not enabled and self._stop is not None:
                self._stop.set()
                self._thread = self._stop = None

    def _loop(self, stop: threading.Event) -> None:
        if self._pos is None:
            from dwell import cursor_pos as pos
        else:
            pos = self._pos
        try:
            last = pos()
        except Exception:
            return
        while not stop.wait(POLL_S):
            try:
                cur = pos()
            except Exception:
                continue
            if math.hypot(cur[0] - last[0], cur[1] - last[1]) > MOVE_PX:
                last = cur
                self._emit("mouse-moved")
