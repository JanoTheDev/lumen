import base64
import io
import time

import mss
from PIL import Image

import monitors
from errors import AgentError, E_INVALID, E_NOT_FOUND

_MAX_WIDTH = 1280


def _grab(rect: dict) -> Image.Image:
    with mss.mss() as sct:
        shot = sct.grab({"left": rect["x"], "top": rect["y"], "width": rect["w"], "height": rect["h"]})
        return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")


def _encode(img: Image.Image, max_width: int, quality: int) -> tuple:
    if max_width and img.width > max_width:
        img = img.resize((max_width, max(1, round(img.height * max_width / img.width))), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode("ascii"), img.width, img.height


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
    mons = monitors.enumerate_monitors()
    frames = []
    if region is not None:
        r = _as_rect(region)
        mon = monitors.containing(mons, r["x"] + r["w"] / 2, r["y"] + r["h"] / 2)
        rects = [(mon, _clip(r, mon["rect"]))]
        if rects[0][1] is None:
            raise AgentError(E_INVALID, "region is outside every monitor")
    else:
        rects = [(m, None) for m in select_monitors(mons, monitor)]
    for mon, clip in rects:
        img = _grab(clip or mon["rect"])
        data, w, h = _encode(img, max_width, quality)
        frame = {
            "id": f"f{time.monotonic_ns()}",
            "monitor": mon,
            "width": w,
            "height": h,
            "scale": img.width / w,
            "mime": "image/jpeg",
            "data": data,
        }
        if clip is not None:
            frame["region"] = clip
        frames.append(frame)
    return {"frames": frames}


def take_screenshot() -> str:
    """v1 `screenshot`: base64 JPEG of the primary monitor."""
    img = _grab(monitors.primary()["rect"])
    return _encode(img, _MAX_WIDTH, 80)[0]


def get_active_window() -> str:
    try:
        import pywinctl as pwc
        win = pwc.getActiveWindow()
        return win.title if win else "Unknown"
    except Exception:
        return "Unknown"
