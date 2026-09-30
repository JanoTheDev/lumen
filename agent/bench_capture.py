"""Capture + encode latency.

    .venv/Scripts/python bench_capture.py [runs]

Measures the live primary monitor (grab, downscale to 1280, JPEG q75) and,
since not every dev box has a 4K panel, the encode path on a synthetic
3840x2160 frame plus a grab-cost estimate scaled from the live monitor.
"""
import dpi  # noqa: F401  (per-monitor-v2 before mss)

import statistics
import sys
import time

from PIL import Image, ImageDraw

import capture
import monitors


def _median_ms(fn, runs: int) -> float:
    fn()  # warm-up: first mss instance, JPEG tables
    samples = []
    for _ in range(runs):
        t0 = time.perf_counter()
        fn()
        samples.append((time.perf_counter() - t0) * 1000)
    return statistics.median(samples)


def _synthetic(w: int, h: int) -> Image.Image:
    img = Image.new("RGB", (w, h), (245, 245, 245))
    d = ImageDraw.Draw(img)
    for y in range(0, h, 24):
        d.text((40, y), "Lorem ipsum dolor sit amet, consectetur adipiscing elit 0123456789 " * 3, fill=(20, 20, 20))
    for x in range(0, w, 400):
        d.rectangle([x, 0, x + 180, h], outline=(30, 90, 200), width=3)
    return img


def main(runs: int = 30) -> None:
    mon = monitors.primary()
    rect = mon["rect"]
    grab = _median_ms(lambda: capture._grab(rect), runs)
    full = _median_ms(lambda: capture.capture(monitor="primary"), runs)
    print(f"live {rect['w']}x{rect['h']}: grab {grab:.1f} ms, capture+encode {full:.1f} ms (median of {runs})")
    old_live = _median_ms(lambda: _old_path(_old_grab(rect)), max(5, runs // 3))
    print(f"live {rect['w']}x{rect['h']} old path (new mss per call, LANCZOS, q80, optimize): {old_live:.1f} ms")

    img4k = _synthetic(3840, 2160)
    enc4k = _median_ms(lambda: capture._encode(img4k, 1280, 75), runs)
    est = grab * (3840 * 2160) / (rect["w"] * rect["h"]) + enc4k
    print(f"synthetic 3840x2160: downscale+encode {enc4k:.1f} ms, est. capture+encode {est:.1f} ms")

    old = _median_ms(lambda: _old_path(img4k), max(5, runs // 3))
    print(f"synthetic 3840x2160 old path (LANCZOS, q80, optimize): {old:.1f} ms")


def _old_grab(rect: dict) -> Image.Image:
    import mss
    with mss.mss() as sct:
        shot = sct.grab({"left": rect["x"], "top": rect["y"], "width": rect["w"], "height": rect["h"]})
        return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")


def _old_path(img: Image.Image) -> None:
    import io
    small = img.resize((1280, round(img.height * 1280 / img.width)), Image.LANCZOS)
    small.save(io.BytesIO(), format="JPEG", quality=80, optimize=True)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 30)
