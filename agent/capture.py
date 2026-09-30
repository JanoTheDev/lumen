import base64
import io
import itertools
import threading
import time
from collections import OrderedDict

import mss
from PIL import Image

import monitors
from errors import AgentError, E_INVALID, E_NOT_FOUND

_MAX_WIDTH = 1280
FRAME_CACHE_SIZE = 3
FRAME_TTL_S = 5.0

_tls = threading.local()
_cache_lock = threading.Lock()
_frames: "OrderedDict[str, dict]" = OrderedDict()


def _sct():
    # mss holds GDI handles bound to the creating thread: one instance per thread, reused.
    sct = getattr(_tls, "sct", None)
    if sct is None:
        sct = _tls.sct = mss.mss()
    return sct


def _grab(rect: dict) -> Image.Image:
    shot = _sct().grab({"left": rect["x"], "top": rect["y"], "width": rect["w"], "height": rect["h"]})
    return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")


def downscale(img: Image.Image, max_width: int) -> Image.Image:
    """Integer box reduce (fast) down to >= max_width, then one bilinear resize."""
    if not max_width or img.width <= max_width:
        return img
    k = img.width // max_width
    if k >= 2:
        img = img.reduce(k)
    if img.width == max_width:
        return img
    return img.resize((max_width, max(1, round(img.height * max_width / img.width))), Image.BILINEAR)


def _encode(img: Image.Image, max_width: int, quality: int) -> tuple:
    img = downscale(img, max_width)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode("ascii"), img.width, img.height


_frame_seq = itertools.count(1)


def _new_frame_id() -> str:
    # monotonic_ns ticks every ~15 ms on Windows; a counter never collides.
    return f"f{next(_frame_seq)}"


def _prune(now: float) -> None:
    for fid in [k for k, v in _frames.items() if now - v["t"] > FRAME_TTL_S]:
        del _frames[fid]
    while len(_frames) > FRAME_CACHE_SIZE:
        _frames.popitem(last=False)


def cache_frame(img: Image.Image, monitor: dict, rect: dict, frame_id: str | None = None) -> str:
    """Keeps a full-res frame for later ocr/page-diff reuse. Returns its id."""
    fid = frame_id or _new_frame_id()
    with _cache_lock:
        _frames[fid] = {"img": img, "monitor": monitor, "rect": rect, "t": time.monotonic()}
        _prune(time.monotonic())
    return fid


def get_frame(frame_id: str) -> dict | None:
    """Full-res cached frame {img, monitor, rect} or None once evicted/expired."""
    with _cache_lock:
        _prune(time.monotonic())
        return _frames.get(frame_id)


def _targets(monitor, region) -> list:
    """[(monitor, rect, is_region)] to grab. A region is clipped to the monitor under its center."""
    mons = monitors.enumerate_monitors()
    if region is None:
        return [(m, m["rect"], False) for m in select_monitors(mons, monitor)]
    r = _as_rect(region)
    mon = monitors.containing(mons, r["x"] + r["w"] / 2, r["y"] + r["h"] / 2)
    rect = _clip(r, mon["rect"])
    if rect is None:
        raise AgentError(E_INVALID, "region is outside every monitor")
    return [(mon, rect, True)]


def grab_full(monitor="foreground", region=None, cache: bool = True) -> dict:
    """Fresh full-res frame {id, img, monitor, rect}; cached for ocr reuse unless cache=False."""
    mon, rect, _ = _targets(monitor, region)[0]
    img = _grab(rect)
    fid = cache_frame(img, mon, rect) if cache else None
    return {"id": fid, "img": img, "monitor": mon, "rect": rect}


def _clip(region: dict, rect: dict) -> dict | None:
    x1, y1 = max(region["x"], rect["x"]), max(region["y"], rect["y"])
    x2 = min(region["x"] + region["w"], rect["x"] + rect["w"])
    y2 = min(region["y"] + region["h"], rect["y"] + rect["h"])
    if x2 <= x1 or y2 <= y1:
        return None
    return {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}


def _as_rect(v) -> dict:
    try:
        r = {k: int(v[k]) for k in ("x", "y", "w", "h")}
    except (TypeError, KeyError, ValueError):
        raise AgentError(E_INVALID, "region must be {x, y, w, h}") from None
    if r["w"] <= 0 or r["h"] <= 0:
        raise AgentError(E_INVALID, "region must have a positive size")
    return r


def select_monitors(mons: list, which) -> list:
    if which in (None, "foreground"):
        return [monitors.foreground(mons)]
    if which == "primary":
        return [monitors.primary(mons)]
    if which == "all":
        return mons
    if isinstance(which, int) and not isinstance(which, bool):
        for m in mons:
            if m["id"] == which:
                return [m]
        raise AgentError(E_NOT_FOUND, f"no monitor {which}")
    raise AgentError(E_INVALID, "monitor must be foreground, primary, all or an id")


def capture(monitor="foreground", maxWidth=_MAX_WIDTH, quality=75, region=None, **_ignored) -> dict:
    """Captures JPEG frames with their monitor geometry (plans CONTRACTS C2 `capture`)."""
    max_width = int(maxWidth) if isinstance(maxWidth, (int, float)) and maxWidth > 0 else 0
    quality = int(quality) if isinstance(quality, (int, float)) and 1 <= quality <= 100 else 75
    frames = []
    for mon, rect, is_region in _targets(monitor, region):
        img = _grab(rect)
        fid = cache_frame(img, mon, rect)
        data, w, h = _encode(img, max_width, quality)
        frame = {
            "id": fid,
            "monitor": mon,
            "width": w,
            "height": h,
            "scale": img.width / w,
            "mime": "image/jpeg",
            "data": data,
        }
        if is_region:
            frame["region"] = rect
        frames.append(frame)
    return {"frames": frames}


def take_screenshot() -> str:
    """v1 `screenshot`: base64 JPEG of the primary monitor."""
    img = _grab(monitors.primary()["rect"])
    return _encode(img, _MAX_WIDTH, 75)[0]


def get_active_window() -> str:
    try:
        import pywinctl as pwc
        win = pwc.getActiveWindow()
        return win.title if win else "Unknown"
    except Exception:
        return "Unknown"
