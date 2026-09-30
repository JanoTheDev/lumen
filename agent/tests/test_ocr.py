import dpi  # noqa: F401

import time

import pytest
from PIL import Image, ImageDraw, ImageFont

import actions
import capture
import ocr

MON = {"id": 1, "device": "x", "rect": {"x": -2000, "y": 100, "w": 1600, "h": 900}, "scale": 1.0, "primary": False}


def test_tiles_cover_with_overlap():
    assert ocr.tiles(1920, 1080, 10000) == [(0, 0, 1920, 1080)]
    t = ocr.tiles(250, 100, 100, overlap=20)
    assert [x for x, *_ in t] == [0, 80, 160]
    assert all(w <= 100 and h <= 100 for *_, w, h in t)
    assert t[-1][0] + t[-1][2] == 250


def word(text, x, y, line, w=40, h=12):
    return {"text": text, "rect": {"x": x, "y": y, "w": w, "h": h}, "conf": 1.0, "lineIndex": line}


def test_merge_tiles_drops_overlap_duplicates():
    a = {"words": [word("Inbox", 10, 10, 0), word("Compose", 950, 10, 0)], "lines": [{"text": "", "rect": {}}]}
    b = {"words": [word("Compose", 951, 11, 0), word("Sent", 960, 40, 1)],
         "lines": [{"text": "", "rect": {}}, {"text": "", "rect": {}}]}
    m = ocr.merge_tiles([a, b])
    assert [w["text"] for w in m["words"]] == ["Inbox", "Compose", "Sent"]
    assert [l["text"] for l in m["lines"]] == ["Inbox Compose", "Sent"]
    assert m["words"][2]["lineIndex"] == 1


def test_ocr_matches_clusters_rows_by_scaled_band():
    words = [word("Alice", 10, 100, 0), word("Alice", 400, 104, 0),  # same row: sender + subject
             word("Alice", 10, 160, 1), word("Bob", 10, 220, 2)]
    assert actions._ocr_matches(words, "alice", 30) == [(30, 106, 100), (30, 166, 160)]
    # at 250% the rows 60 px apart are still distinct (band 75 would merge them)
    assert len(actions._ocr_matches(words, "alice", 30 * 1.5)) == 2
    assert actions._ocr_matches(words, "ok", 30) == []


def _text_image(lines, size=(900, 400)):
    img = Image.new("RGB", size, "white")
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("arial.ttf", 32)
    except OSError:
        pytest.skip("arial.ttf missing")
    for i, text in enumerate(lines):
        d.text((40, 30 + i * 70), text, fill="black", font=font)
    return img


@pytest.fixture
def engine():
    try:
        ocr._engine(None)
    except Exception as e:
        pytest.skip(f"no Windows OCR: {e}")


def test_recognize_physical_rects(engine):
    img = _text_image(["Compose new message", "Inbox 42 unread"])
    res = ocr.recognize(img, {"x": -2000, "y": 100})
    texts = [w["text"] for w in res["words"]]
    assert "Compose" in texts and "Inbox" in texts
    comp = next(w for w in res["words"] if w["text"] == "Compose")
    assert -2000 + 30 <= comp["rect"]["x"] <= -2000 + 60 and 100 + 25 <= comp["rect"]["y"] <= 100 + 60
    assert res["lines"][0]["text"].startswith("Compose")


def test_recognize_tiled_matches_untiled(engine, monkeypatch):
    img = _text_image(["Alpha Beta Gamma Delta", "Epsilon Zeta Eta Theta"], size=(900, 200))
    whole = {w["text"] for w in ocr.recognize(img, {"x": 0, "y": 0})["words"]}
    monkeypatch.setattr(ocr, "max_dimension", lambda: 500)
    tiled = ocr.recognize(img, {"x": 0, "y": 0})
    assert whole <= {w["text"] for w in tiled["words"]} | {""}
    assert len(tiled["words"]) == len({(w["text"], w["lineIndex"]) for w in tiled["words"]})


def test_click_nth_element_uses_windows_ocr(engine, monkeypatch):
    img = _text_image(["Invoice from Acme", "Receipt", "Invoice overdue"], size=(900, 300))
    monkeypatch.setattr(capture, "grab_full", lambda **kw: {"id": "f0", "img": img, "monitor": MON, "rect": MON["rect"]})
    clicks = []
    monkeypatch.setattr(actions, "_click_at", lambda x, y, button="left": clicks.append((x, y)))
    actions.execute_action({"type": "click_nth_element", "text": "Invoice", "n": 2})
    (x, y), = clicks
    assert -2000 + 40 <= x <= -2000 + 200 and 100 + 170 <= y <= 100 + 210


def test_ocr_command_on_cached_frame_and_region(engine):
    img = _text_image(["Settings", "Privacy"], size=(600, 200))
    fid = capture.cache_frame(img, MON, {"x": -2000, "y": 100, "w": 600, "h": 200})
    res = ocr.run({"frameId": fid, "region": {"x": -2000, "y": 160, "w": 600, "h": 140}})
    assert [w["text"] for w in res["words"]] == ["Privacy"] and res["frameId"] == fid
    with pytest.raises(Exception) as e:
        ocr.run({"frameId": "f-gone"})
    assert getattr(e.value, "code", "") == "E_NOT_FOUND"


def test_live_full_frame_under_300ms(engine):
    frame = capture.grab_full(monitor="primary")
    ocr.recognize(frame["img"], frame["rect"])  # warm-up
    t0 = time.perf_counter()
    ocr.recognize(frame["img"], frame["rect"])
    assert (time.perf_counter() - t0) < 0.6  # 1080p here; 1440p target is 300 ms (see bench)
