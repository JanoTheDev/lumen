import random

from PIL import Image, ImageDraw

import pagediff


def page(seed: int, w: int = 1280, h: int = 900, offset: int = 0) -> Image.Image:
    """White page with random 'text' bars; `offset` scrolls the content up by that many px."""
    rnd = random.Random(seed)
    tall = Image.new("RGB", (w, h * 3), "white")
    d = ImageDraw.Draw(tall)
    for y in range(0, h * 3, 22):
        x = 40
        while x < w - 80:
            word = rnd.randint(20, 90)
            d.rectangle([x, y + 4, x + word, y + 16], fill=(30, 30, 30))
            x += word + rnd.randint(8, 16)
    view = tall.crop((0, offset, w, offset + h))
    # Fixed chrome: title bar + status bar that never scroll.
    ImageDraw.Draw(view).rectangle([0, 0, w, 60], fill=(40, 60, 120))
    ImageDraw.Draw(view).rectangle([0, h - 40, w, h], fill=(220, 220, 220))
    return view


def test_scrolled_middle_band_is_not_bottom():
    before = pagediff.small_gray(page(1))
    after = pagediff.small_gray(page(1, offset=600))
    assert pagediff.diff_ratio(before, after) > pagediff.BOTTOM_THRESHOLD
    assert not pagediff.reached_bottom(before, after)


def test_small_scroll_still_detected():
    before = pagediff.small_gray(page(2))
    after = pagediff.small_gray(page(2, offset=88))
    assert not pagediff.reached_bottom(before, after)


def test_blinking_cursor_only_is_bottom():
    a = page(3)
    b = a.copy()
    ImageDraw.Draw(b).rectangle([500, 400, 509, 419], fill="black")  # 10x20 caret
    assert pagediff.reached_bottom(pagediff.small_gray(a), pagediff.small_gray(b))


def test_identical_is_bottom_and_size_change_is_not():
    a = pagediff.small_gray(page(4))
    assert pagediff.diff_ratio(a, a) == 0
    assert not pagediff.reached_bottom(a, pagediff.small_gray(page(4, w=1000)))


def test_edge_chrome_changes_ignored():
    a = page(5)
    b = a.copy()
    ImageDraw.Draw(b).rectangle([0, 860, 1280, 900], fill=(0, 120, 0))  # status bar / clock
    assert pagediff.reached_bottom(pagediff.small_gray(a), pagediff.small_gray(b))
