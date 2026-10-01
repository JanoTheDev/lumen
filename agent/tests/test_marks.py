import base64
import io

import pytest
from PIL import Image

import capture
from errors import AgentError

MON = {"id": 0, "device": "x", "rect": {"x": -2560, "y": 0, "w": 2560, "h": 1440}, "scale": 2.0, "primary": False}


def _px(img, x, y):
    return img.getpixel((x, y))[:3]


def test_draw_marks_badge_and_outline_on_light_and_dark():
    for bg in ((255, 255, 255), (20, 20, 20)):
        img = Image.new("RGB", (400, 300), bg)
        origin = {"x": 1000, "y": 500}
        out = capture.draw_marks(img, [{"n": 7, "rect": {"x": 1100, "y": 600, "w": 120, "h": 40}}], origin)
        assert img.getpixel((100, 100))[:3] == bg  # source untouched
        # box outline on the right edge, away from the badge
        assert _px(out, 100 + 119, 100 + 30) == capture.MARK_OUTLINE
        # badge: yellow border, black fill, some white text pixels
        assert _px(out, 100, 100) == capture.MARK_OUTLINE
        assert _px(out, 101, 101) == capture.MARK_BADGE
        text = [_px(out, x, y) for x in range(101, 125) for y in range(101, 120)]
        assert any(min(p) > 150 for p in text)  # white-ish glyph pixels (yellow has no blue)


def test_badge_is_clamped_inside_the_image():
    img = Image.new("RGB", (200, 100), (255, 255, 255))
    out = capture.draw_marks(img, [{"n": 120, "rect": {"x": -5, "y": -5, "w": 30, "h": 30}}], {"x": 0, "y": 0})
    assert _px(out, 0, 0) == capture.MARK_OUTLINE
    assert _px(out, 2, 2) == capture.MARK_BADGE


def test_badge_scales_with_downscale_factor():
    img = Image.new("RGB", (800, 400), (255, 255, 255))
    mark = [{"n": 3, "rect": {"x": 100, "y": 100, "w": 200, "h": 100}}]
    small = capture.draw_marks(img, mark, {"x": 0, "y": 0}, 1.0)
    big = capture.draw_marks(img, mark, {"x": 0, "y": 0}, 2.0)

    def badge_width(out):
        row = [_px(out, x, 103) for x in range(100, 200)]
        return sum(1 for p in row if p == capture.MARK_BADGE)

    assert badge_width(big) > 1.5 * badge_width(small)


def test_render_marks_from_cached_frame_keeps_image_size():
    img = Image.new("RGB", (2560, 1440), (240, 240, 240))
    fid = capture.cache_frame(img, MON, MON["rect"])
    res = capture.render_marks(frameId=fid, marks=[{"n": 1, "rect": {"x": -2400, "y": 100, "w": 300, "h": 80}}],
                               maxWidth=1280)
    assert (res["width"], res["height"], res["count"], res["mime"]) == (1280, 720, 1, "image/jpeg")
    out = Image.open(io.BytesIO(base64.b64decode(res["data"])))
    assert out.size == (1280, 720)
    r, g, b = out.getpixel((81, 51))[:3]  # inside the badge at (160,100)/2
    assert r < 80 and g < 80 and b < 80


def test_render_marks_errors():
    with pytest.raises(AgentError) as e:
        capture.render_marks(frameId="nope", marks=[])
    assert e.value.code == "E_NOT_FOUND"
    fid = capture.cache_frame(Image.new("RGB", (10, 10)), MON, MON["rect"])
    for bad in (None, [{"n": "1", "rect": {"x": 0, "y": 0, "w": 1, "h": 1}}], [{"n": 1, "rect": {"x": 0}}]):
        with pytest.raises(AgentError) as e:
            capture.render_marks(frameId=fid, marks=bad)
        assert e.value.code == "E_INVALID"
