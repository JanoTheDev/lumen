"""OCR with the built-in Windows.Media.Ocr engine (nothing to install).

Works on full-res frames (physical px) so word rects map straight to the
virtual desktop: rect = frame origin + image px. Frames larger than
`OcrEngine.max_image_dimension` are tiled with overlap and duplicate words
from the overlaps are dropped.
"""
import logging
import threading

from errors import AgentError, E_INVALID, E_NOT_FOUND, E_UNSUPPORTED

log = logging.getLogger(__name__)

TILE_OVERLAP = 64
NO_ENGINE = ("No Windows OCR language is installed. Install a Windows language pack with OCR "
             "(Settings > Time & language > Language).")

_engines: dict = {}
_engine_lock = threading.Lock()


def _engine(lang: str | None):
    from winrt.windows.media.ocr import OcrEngine

    key = (lang or "").lower()
    with _engine_lock:
        if key not in _engines:
            if lang:
                from winrt.windows.globalization import Language

                try:
                    language = Language(lang)
                except Exception:
                    raise AgentError(E_INVALID, f"bad language tag {lang!r}") from None
                if not OcrEngine.is_language_supported(language):
                    raise AgentError(E_UNSUPPORTED, f"OCR language {lang} is not installed. {NO_ENGINE}")
                _engines[key] = OcrEngine.try_create_from_language(language)
            else:
                _engines[key] = OcrEngine.try_create_from_user_profile_languages()
        engine = _engines[key]
    if engine is None:
        raise AgentError(E_UNSUPPORTED, NO_ENGINE)
    return engine


def max_dimension() -> int:
    from winrt.windows.media.ocr import OcrEngine

    return int(OcrEngine.max_image_dimension)


def tiles(width: int, height: int, limit: int, overlap: int = TILE_OVERLAP) -> list:
    """[(x, y, w, h)] covering the image, each side <= limit, neighbours overlapping. Pure."""
    def spans(total):
        if total <= limit:
            return [(0, total)]
        step = limit - overlap
        out, start = [], 0
        while True:
            end = min(start + limit, total)
            out.append((start, end - start))
            if end >= total:
                return out
            start += step

    return [(x, y, w, h) for y, h in spans(height) for x, w in spans(width)]


def _overlaps(a: dict, b: dict) -> bool:
    ix = min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"])
    iy = min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"])
    if ix <= 0 or iy <= 0:
        return False
    return ix * iy >= 0.5 * min(a["w"] * a["h"], b["w"] * b["h"])


def merge_tiles(results: list) -> dict:
    """Joins per-tile {words, lines} (already in absolute coords), dropping duplicate words. Pure."""
    words, lines = [], []
    for res in results:
        kept_line_words = {}
        for w in res["words"]:
            if any(o["text"] == w["text"] and _overlaps(o["rect"], w["rect"]) for o in words):
                continue
            kept_line_words.setdefault(w["lineIndex"], []).append(w)
        for li, line in enumerate(res["lines"]):
            ws = kept_line_words.get(li)
            if not ws:
                continue
            new_index = len(lines)
            for w in ws:
                words.append({**w, "lineIndex": new_index})
            lines.append({"text": " ".join(w["text"] for w in ws), "rect": union([w["rect"] for w in ws])})
    return {"words": words, "lines": lines}


def union(rects: list) -> dict:
    x1 = min(r["x"] for r in rects)
    y1 = min(r["y"] for r in rects)
    x2 = max(r["x"] + r["w"] for r in rects)
    y2 = max(r["y"] + r["h"] for r in rects)
    return {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}


def _recognize_one(engine, img, ox: int, oy: int) -> dict:
    from winrt.windows.graphics.imaging import BitmapPixelFormat, SoftwareBitmap

    bmp = SoftwareBitmap.create_copy_from_buffer(
        img.convert("RGB").tobytes("raw", "BGRX"), BitmapPixelFormat.BGRA8, img.width, img.height)
    result = engine.recognize_async(bmp).get()
    words, lines = [], []
    for li, line in enumerate(result.lines):
        lw = []
        for w in line.words:
            b = w.bounding_rect
            rect = {"x": ox + round(b.x), "y": oy + round(b.y), "w": round(b.width), "h": round(b.height)}
            lw.append({"text": w.text, "rect": rect, "conf": 1.0, "lineIndex": li})
        words += lw
        lines.append({"text": line.text, "rect": union([w["rect"] for w in lw]) if lw else
                      {"x": ox, "y": oy, "w": 0, "h": 0}})
    return {"words": words, "lines": lines}


def recognize(img, origin: dict, lang: str | None = None, token=None) -> dict:
    """OCR a PIL image whose top-left sits at `origin` (physical px). Words/lines in physical px."""
    engine = _engine(lang)
    limit = max_dimension()
    parts = tiles(img.width, img.height, limit)
    if len(parts) == 1:
        return _recognize_one(engine, img, origin["x"], origin["y"])
    results = []
    for x, y, w, h in parts:
        if token is not None:
            token.check()
        results.append(_recognize_one(engine, img.crop((x, y, x + w, y + h)), origin["x"] + x, origin["y"] + y))
    return merge_tiles(results)


def _crop(frame: dict, region: dict):
    """Crops a cached frame to a physical region; returns (img, origin)."""
    r = frame["rect"]
    x1, y1 = max(region["x"], r["x"]), max(region["y"], r["y"])
    x2 = min(region["x"] + region["w"], r["x"] + r["w"])
    y2 = min(region["y"] + region["h"], r["y"] + r["h"])
    if x2 <= x1 or y2 <= y1:
        raise AgentError(E_INVALID, "region is outside the frame")
    img = frame["img"].crop((x1 - r["x"], y1 - r["y"], x2 - r["x"], y2 - r["y"]))
    return img, {"x": x1, "y": y1}


def run(args: dict, token=None) -> dict:
    """`ocr {frameId?, region?, lang?, monitor?}` (plans CONTRACTS C2)."""
    import capture

    region = args.get("region")
    if region is not None:
        region = capture._as_rect(region)
    frame_id = args.get("frameId")
    if frame_id:
        frame = capture.get_frame(str(frame_id))
        if frame is None:
            raise AgentError(E_NOT_FOUND, f"frame {frame_id} expired; capture again")
    else:
        frame = capture.grab_full(monitor=args.get("monitor", "foreground"), region=region)
        frame_id = frame["id"]
    if region is not None:
        img, origin = _crop(frame, region)
    else:
        img, origin = frame["img"], frame["rect"]
    out = recognize(img, origin, args.get("lang"), token)
    out["frameId"] = frame_id
    out["monitor"] = frame["monitor"]
    return out
