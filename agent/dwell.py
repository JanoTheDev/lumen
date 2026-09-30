"""Dwell clicking: hold the cursor still to click.

`DwellFSM` is pure (fed timestamps + positions) so it is unit tested; `Dwell`
polls the physical cursor at 25 Hz and turns FSM output into events. The
agent only reports; main performs the click.

Safety: after a click the cursor must leave the tolerance radius before the
next dwell can start (`maxRepeats=0`), or at most `maxRepeats` more clicks in
place. Paused explicitly (`dwell_pause`) and automatically while the agent
itself is injecting input and for a grace period afterwards.

NOTE: no low-level mouse hook (WH_MOUSE_LL) - it slowed wheel delivery and
broke Ctrl+scroll zoom in other apps.
"""
import ctypes
import ctypes.wintypes as wt
import logging
import math
import threading
import time

log = logging.getLogger(__name__)

CLICK_TYPES = ("left", "right", "double", "drag")
POLL_S = 0.04
BASE_TOLERANCE_PX = 12
AUTO_PAUSE_GRACE_S = 1.0


class DwellFSM:
    def __init__(self, ms=1400, cooldown_ms=1500, click_type="left", max_repeats=0, tolerance_px=None):
        self.ms = ms
        self.cooldown_ms = cooldown_ms
        self.click_type = click_type
        self.max_repeats = max_repeats
        self.tolerance_px = tolerance_px  # physical px; None -> BASE_TOLERANCE_PX * monitor scale
        self.anchor = None
        self.stable_since = 0.0
        self.last_trigger = -1e9
        self.armed = True
        self.repeats = 0
        self.dragging = False
        self.active = False

    def reset(self) -> None:
        self.anchor = None
        self.armed = True
        self.repeats = 0
        self.dragging = False
        self.active = False

    def phase(self):
        if self.click_type != "drag":
            return None
        return "drag-end" if self.dragging else "drag-start"

    def _idle(self, x, y, out) -> None:
        if self.active:
            out.append(("progress", x, y, 0.0, False, self.phase()))
            self.active = False

    def step(self, now: float, x: int, y: int, scale: float = 1.0, paused: bool = False) -> list:
        """Advances one poll. Returns events: ("progress", x, y, p, active, phase) / ("trigger", x, y, type, phase)."""
        out: list = []
        tol = self.tolerance_px if self.tolerance_px is not None else BASE_TOLERANCE_PX * scale
        if self.anchor is None or math.hypot(x - self.anchor[0], y - self.anchor[1]) > tol:
            self.anchor = (x, y)
            self.stable_since = now
            self.armed = True
            self.repeats = 0
            self._idle(x, y, out)
            return out
        if paused:
            self.stable_since = now  # a full dwell is needed after resuming
            self._idle(x, y, out)
            return out
        in_cooldown = (now - self.last_trigger) * 1000 < self.cooldown_ms
        if not self.armed:
            if 0 < self.repeats <= self.max_repeats and not in_cooldown:
                self.armed = True
                self.stable_since = now
            return out
        if in_cooldown:
            self.stable_since = now
            return out
        elapsed_ms = (now - self.stable_since) * 1000
        p = max(0.0, min(1.0, elapsed_ms / max(1, self.ms)))
        if elapsed_ms < self.ms:
            if p > 0.02:
                out.append(("progress", x, y, p, True, self.phase()))
                self.active = True
            return out
        phase = self.phase()
        out.append(("progress", x, y, 1.0, False, phase))
        out.append(("trigger", x, y, self.click_type, phase))
        self.active = False
        self.last_trigger = now
        self.stable_since = now
        self.armed = False
        if phase == "drag-start":
            self.dragging = True
            self.repeats = self.max_repeats + 1  # the drop needs a move to the destination
        else:
            if phase == "drag-end":
                self.dragging = False
            self.repeats += 1
        return out


def cursor_pos() -> tuple:
    pt = wt.POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
    return pt.x, pt.y


def parse_config(cfg: dict, base: dict | None = None) -> dict:
    """Validates a dwell_config/init.dwell object into FSM settings (unknown/bad fields keep `base`)."""
    out = dict(base or {"enabled": False, "ms": 1400, "cooldownMs": 1500, "clickType": "left",
                        "maxRepeats": 0, "moveTolerancePx": None})

    def num(v, lo, hi):
        return isinstance(v, (int, float)) and not isinstance(v, bool) and lo <= v <= hi

    if isinstance(cfg.get("enabled"), bool):
        out["enabled"] = cfg["enabled"]
    for key, alias, lo, hi in (("ms", "dwell_ms", 100, 60000), ("cooldownMs", "cooldown_ms", 0, 60000)):
        v = cfg.get(key, cfg.get(alias))
        if num(v, lo, hi):
            out[key] = int(v)
    if cfg.get("clickType") in CLICK_TYPES:
        out["clickType"] = cfg["clickType"]
    if num(cfg.get("maxRepeats"), 0, 1000):
        out["maxRepeats"] = int(cfg["maxRepeats"])
    if cfg.get("moveTolerancePx") is None and "moveTolerancePx" in cfg:
        out["moveTolerancePx"] = None
    elif num(cfg.get("moveTolerancePx"), 1, 500):
        out["moveTolerancePx"] = float(cfg["moveTolerancePx"])
    return out


class Dwell:
    """Cursor poller. `on_progress(data)` / `on_trigger(data)` receive event payloads."""

    def __init__(self, on_progress, on_trigger, busy=lambda: False, monitors_fn=None, pos_fn=cursor_pos):
        self._on_progress = on_progress
        self._on_trigger = on_trigger
        self._busy = busy
        self._monitors_fn = monitors_fn
        self._pos = pos_fn
        self._lock = threading.Lock()
        self._thread = None
        self._stop = None
        self._paused = False
        self.config = parse_config({})
        self.fsm = DwellFSM()

    def configure(self, cfg: dict) -> dict:
        with self._lock:
            self.config = parse_config(cfg, self.config)
            c = self.config
            self.fsm.ms, self.fsm.cooldown_ms = c["ms"], c["cooldownMs"]
            if self.fsm.click_type != c["clickType"]:
                self.fsm.reset()
            self.fsm.click_type = c["clickType"]
            self.fsm.max_repeats = c["maxRepeats"]
            self.fsm.tolerance_px = c["moveTolerancePx"]
        if c["enabled"]:
            self._ensure_running()
        else:
            self.stop()
        return dict(c)

    def set_ms(self, ms: int) -> None:
        self.configure({"ms": ms})

    def pause(self) -> None:
        self._paused = True

    def resume(self) -> None:
        self._paused = False

    @property
    def paused(self) -> bool:
        return self._paused

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def _ensure_running(self) -> None:
        if self.running:
            return
        self.fsm.reset()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, args=(self._stop,), name="dwell", daemon=True)
        self._thread.start()
        log.info("started with %s", self.config)

    def stop(self) -> None:
        with self._lock:
            self.config["enabled"] = False
        ev, t = self._stop, self._thread
        if ev is not None:
            ev.set()
        if t is not None and t is not threading.current_thread():
            t.join(timeout=1)
        self._thread = self._stop = None

    def _geometry(self, mons, x, y) -> dict:
        import monitors

        mon = monitors.containing(mons, x, y)
        lx, ly = monitors.to_logical(mon, x, y)
        return {"monitorId": mon["id"], "scale": mon["scale"], "lx": round(lx, 1), "ly": round(ly, 1)}

    def _loop(self, stop: threading.Event) -> None:
        import monitors

        mons_fn = self._monitors_fn or monitors.enumerate_monitors
        mons, mons_at = mons_fn(), time.monotonic()
        while not stop.wait(POLL_S):
            try:
                x, y = self._pos()
            except Exception:
                continue
            now = time.monotonic()
            if now - mons_at > 2.0:
                try:
                    mons, mons_at = mons_fn(), now
                except Exception:
                    pass
            geo = self._geometry(mons, x, y)
            paused = self._paused or self._busy()
            with self._lock:
                events = self.fsm.step(now, x, y, geo["scale"], paused)
            for ev in events:
                try:
                    if ev[0] == "progress":
                        data = {"x": ev[1], "y": ev[2], "progress": round(ev[3], 3), "active": ev[4], **geo}
                        if ev[5]:
                            data["phase"] = ev[5]
                        self._on_progress(data)
                    else:
                        data = {"x": ev[1], "y": ev[2], **geo, "clickType": ev[3]}
                        if ev[4]:
                            data["phase"] = ev[4]
                        self._on_trigger(data)
                except Exception as e:
                    log.error("dwell callback failed: %s", e)
        log.info("stopped")
