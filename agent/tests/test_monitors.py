import dpi  # noqa: F401  (per-monitor-v2 before mss)

import pytest

import capture
import monitors
from errors import AgentError

# Secondary at 150% to the left of a 100% primary.
PRIMARY = {"device": r"\\.\DISPLAY1", "rect": {"x": 0, "y": 0, "w": 2560, "h": 1440},
           "workArea": {"x": 0, "y": 0, "w": 2560, "h": 1392}, "dpi": 96, "scale": 1.0, "primary": True}
SECONDARY = {"device": r"\\.\DISPLAY2", "rect": {"x": -3840, "y": 0, "w": 3840, "h": 2160},
             "workArea": {"x": -3840, "y": 0, "w": 3840, "h": 2100}, "dpi": 144, "scale": 1.5, "primary": False}


def layout():
    return monitors.assign_ids([PRIMARY, SECONDARY])


def test_ids_sorted_by_position():
    mons = layout()
    assert [m["id"] for m in mons] == [0, 1]
    assert mons[0]["device"].endswith("DISPLAY2") and mons[0]["rect"]["x"] < 0
    assert mons[1]["primary"] is True


def test_image_to_phys_on_scaled_secondary():
    sec = layout()[0]
    # 3840 px wide monitor captured at 1280 px wide -> scale 3.
    frame = {"monitor": sec, "width": 1280, "height": 720, "scale": 3.0}
    assert monitors.image_to_phys(frame, 0, 0) == (-3840, 0)
    assert monitors.image_to_phys(frame, 640, 360) == (-1920, 1080)
    assert monitors.image_to_phys(frame, 1279, 719) == (-3, 2157)


def test_image_to_phys_with_region():
    sec = layout()[0]
    frame = {"monitor": sec, "region": {"x": -3000, "y": 100, "w": 600, "h": 400}, "scale": 1.0}
    assert monitors.image_to_phys(frame, 10, 20) == (-2990, 120)


def test_to_logical_uses_monitor_scale():
    sec = layout()[0]
    assert monitors.to_logical(sec, -3840 + 300, 150) == (200.0, 100.0)


def test_containing_and_nearest():
    mons = layout()
    assert monitors.containing(mons, -10, 10)["id"] == 0
    assert monitors.containing(mons, 10, 10)["id"] == 1
    assert monitors.containing(mons, 5000, 10)["id"] == 1


def test_select_monitors():
    mons = layout()
    assert capture.select_monitors(mons, "primary")[0]["primary"] is True
    assert len(capture.select_monitors(mons, "all")) == 2
    assert capture.select_monitors(mons, 0)[0]["rect"]["x"] == -3840
    with pytest.raises(AgentError) as e:
        capture.select_monitors(mons, 7)
    assert e.value.code == "E_NOT_FOUND"
    with pytest.raises(AgentError):
        capture.select_monitors(mons, "left")


def test_live_enumeration_has_one_primary():
    mons = monitors.enumerate_monitors()
    assert mons and sum(m["primary"] for m in mons) == 1
    for m in mons:
        assert m["rect"]["w"] > 0 and m["dpi"] >= 96 and m["scale"] == pytest.approx(m["dpi"] / 96, abs=1e-3)


def test_live_capture_frame_geometry():
    frame = capture.capture(monitor="primary", maxWidth=640)["frames"][0]
    mon = frame["monitor"]
    assert frame["width"] <= 640
    assert frame["scale"] == pytest.approx(mon["rect"]["w"] / frame["width"])
    x, y = monitors.image_to_phys(frame, frame["width"], frame["height"])
    assert abs(x - (mon["rect"]["x"] + mon["rect"]["w"])) <= 2
    assert abs(y - (mon["rect"]["y"] + mon["rect"]["h"])) <= 2


def test_live_region_capture():
    p = monitors.primary()["rect"]
    frame = capture.capture(region={"x": p["x"] + 10, "y": p["y"] + 20, "w": 300, "h": 200})["frames"][0]
    assert frame["region"] == {"x": p["x"] + 10, "y": p["y"] + 20, "w": 300, "h": 200}
    assert (frame["width"], frame["height"]) == (300, 200) and frame["scale"] == 1.0


def test_downscale_integer_reduce_then_bilinear():
    from PIL import Image
    assert capture.downscale(Image.new("RGB", (3840, 2160)), 1280).size == (1280, 720)
    assert capture.downscale(Image.new("RGB", (2560, 1440)), 1280).size == (1280, 720)
    assert capture.downscale(Image.new("RGB", (1920, 1080)), 1280).size == (1280, 720)
    assert capture.downscale(Image.new("RGB", (3000, 1000)), 1280).size == (1280, 427)
    assert capture.downscale(Image.new("RGB", (800, 600)), 1280).size == (800, 600)


def test_frame_cache_keeps_last_three_and_expires(monkeypatch):
    from PIL import Image
    mon = layout()[1]
    ids = [capture.cache_frame(Image.new("RGB", (4, 4)), mon, mon["rect"]) for _ in range(4)]
    assert capture.get_frame(ids[0]) is None
    assert all(capture.get_frame(i) for i in ids[1:])
    t = capture.time.monotonic() + capture.FRAME_TTL_S + 1
    monkeypatch.setattr(capture.time, "monotonic", lambda: t)
    assert capture.get_frame(ids[-1]) is None


def test_live_capture_frame_is_cached():
    frame = capture.capture(monitor="primary")["frames"][0]
    cached = capture.get_frame(frame["id"])
    assert cached["img"].width == frame["monitor"]["rect"]["w"]
