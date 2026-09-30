"""Did a scroll move the page? Compares two small grayscale frames.

Frames are reduced 16x so a blinking caret or a ticking clock barely moves the
mean; only the central 80% of the frame is compared so window chrome at the
edges (title bar, taskbar, status bars) is ignored.
"""
from PIL import Image, ImageChops, ImageStat

REDUCE = 16
BAND = 0.10  # trimmed from each edge
BOTTOM_THRESHOLD = 0.005  # < 0.5% mean abs difference = nothing scrolled


def small_gray(img: Image.Image) -> Image.Image:
    g = img.convert("L")
    k = min(REDUCE, g.width, g.height)
    return g.reduce(k) if k > 1 else g


def _band(img: Image.Image) -> Image.Image:
    w, h = img.size
    dx, dy = int(w * BAND), int(h * BAND)
    return img.crop((dx, dy, max(dx + 1, w - dx), max(dy + 1, h - dy)))


def diff_ratio(before: Image.Image, after: Image.Image) -> float:
    """Mean absolute difference over the central band, 0..1."""
    if before.size != after.size:
        return 1.0
    diff = ImageChops.difference(_band(before), _band(after))
    return ImageStat.Stat(diff).mean[0] / 255.0


def reached_bottom(before: Image.Image, after: Image.Image, threshold: float = BOTTOM_THRESHOLD) -> bool:
    return diff_ratio(before, after) < threshold
