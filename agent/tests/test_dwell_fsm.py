import threading
import time

import pytest

import dwell
from dispatch import Dispatcher, INPUT


def run(fsm, points, t0=0.0, dt=0.04, scale=1.0, paused=False):
    """Feeds (x, y) samples every dt; returns (events, end time)."""
    out, t = [], t0
    for x, y in points:
        out += fsm.step(t, x, y, scale, paused)
        t += dt
    return out, t


def triggers(events):
    return [e for e in events if e[0] == "trigger"]


def still(n, x=100, y=100):
    return [(x, y)] * n


def test_resting_cursor_clicks_exactly_once():
    fsm = dwell.DwellFSM(ms=400, cooldown_ms=300)
    ev, _ = run(fsm, still(400))  # 16 s
    assert len(triggers(ev)) == 1
    assert triggers(ev)[0][1:4] == (100, 100, "left")


def test_jitter_inside_tolerance_still_clicks():
    fsm = dwell.DwellFSM(ms=400, cooldown_ms=0)
    pts = [(100 + (i % 3) * 3, 100 - (i % 2) * 4) for i in range(30)]
    assert len(triggers(run(fsm, pts)[0])) == 1


def test_move_away_rearms():
    fsm = dwell.DwellFSM(ms=400, cooldown_ms=0)
    ev, t = run(fsm, still(20))
    ev2, _ = run(fsm, still(20, 300, 300), t0=t)
    assert len(triggers(ev)) == 1 and len(triggers(ev2)) == 1
    assert triggers(ev2)[0][1:3] == (300, 300)


def test_max_repeats_limits_in_place_clicks():
    fsm = dwell.DwellFSM(ms=200, cooldown_ms=200, max_repeats=2)
    ev, _ = run(fsm, still(500))
    assert len(triggers(ev)) == 3  # first click + 2 repeats


def test_tolerance_scales_with_monitor():
    fsm = dwell.DwellFSM(ms=400, cooldown_ms=0)
    # 15 px wobble: movement at 100% scale (tol 12), stillness at 150% (tol 18)
    wobble = [(100 + 15 * (i % 2), 100) for i in range(40)]
    assert triggers(run(fsm, wobble, scale=1.0)[0]) == []
    fsm = dwell.DwellFSM(ms=400, cooldown_ms=0)
    assert len(triggers(run(fsm, wobble, scale=1.5)[0])) == 1


def test_pause_blocks_and_needs_full_dwell_after():
    fsm = dwell.DwellFSM(ms=400, cooldown_ms=0)
    ev, t = run(fsm, still(50), paused=True)
    assert triggers(ev) == []
    ev, _ = run(fsm, still(9), t0=t)  # 0.36 s < ms after resume
    assert triggers(ev) == []
    ev, _ = run(fsm, still(3), t0=t + 0.36)
    assert len(triggers(ev)) == 1


def test_drag_start_then_end_at_destination():
    fsm = dwell.DwellFSM(ms=200, cooldown_ms=0, click_type="drag")
    ev, t = run(fsm, still(20))
    assert [e[4] for e in triggers(ev)] == ["drag-start"]
    assert all(e[5] == "drag-start" for e in ev if e[0] == "progress")
    ev, t = run(fsm, still(30), t0=t)  # staying put never drops
    assert triggers(ev) == []
    ev, _ = run(fsm, [(100 + i * 10, 100) for i in range(20)] + still(20, 290, 100), t0=t)
    assert [(e[1], e[4]) for e in triggers(ev)] == [(290, "drag-end")]


def test_progress_events_then_idle():
    fsm = dwell.DwellFSM(ms=400, cooldown_ms=0)
    ev, t = run(fsm, still(5))
    assert ev and all(e[0] == "progress" and e[4] for e in ev)
    ev, _ = run(fsm, [(400, 400)], t0=t)
    assert ev == [("progress", 400, 400, 0.0, False, None)]


def test_parse_config():
    c = dwell.parse_config({"enabled": True, "ms": 900, "cooldownMs": 50, "clickType": "right",
                            "maxRepeats": 3, "moveTolerancePx": 20})
    assert c == {"enabled": True, "ms": 900, "cooldownMs": 50, "clickType": "right", "maxRepeats": 3,
                 "moveTolerancePx": 20.0}
    bad = dwell.parse_config({"ms": -1, "clickType": "triple", "maxRepeats": True}, c)
    assert bad == c
    assert dwell.parse_config({"dwell_ms": 700})["ms"] == 700


class FakeCursor:
    def __init__(self):
        self.pos = (500, 500)

    def __call__(self):
        return self.pos


MON = [{"id": 0, "rect": {"x": -1920, "y": 0, "w": 2880, "h": 1620}, "scale": 1.5, "primary": False},
       {"id": 1, "rect": {"x": 960, "y": 0, "w": 1920, "h": 1080}, "scale": 1.0, "primary": True}]


def test_controller_events_carry_logical_coords_and_pause():
    cur, trig, prog = FakeCursor(), [], []
    cur.pos = (-1920 + 300, 150)
    ctl = dwell.Dwell(prog.append, trig.append, monitors_fn=lambda: MON, pos_fn=cur)
    ctl.configure({"enabled": True, "ms": 150, "cooldownMs": 0})
    try:
        deadline = time.monotonic() + 3
        while not trig and time.monotonic() < deadline:
            time.sleep(0.02)
        assert len(trig) == 1
        t = trig[0]
        assert (t["x"], t["y"], t["monitorId"], t["scale"], t["lx"], t["ly"]) == (-1620, 150, 0, 1.5, 200.0, 100.0)
        assert t["clickType"] == "left"
        assert {"x", "y", "progress", "active", "lx", "ly", "monitorId"} <= set(prog[0])

        ctl.pause()
        cur.pos = (1500, 500)
        time.sleep(0.5)
        assert len(trig) == 1
        ctl.resume()
        deadline = time.monotonic() + 3
        while len(trig) < 2 and time.monotonic() < deadline:
            time.sleep(0.02)
        assert trig[1]["monitorId"] == 1 and (trig[1]["lx"], trig[1]["ly"]) == (540.0, 500.0)
    finally:
        ctl.stop()
    assert not ctl.running


def test_no_dwell_click_while_input_lane_busy():
    d = Dispatcher(lambda *a: None)
    gate = threading.Event()
    d.register("slow", lambda args, token: gate.wait(2), INPUT)
    cur, trig = FakeCursor(), []
    ctl = dwell.Dwell(lambda _: None, trig.append, busy=lambda: d.lane_busy(INPUT, 0.3),
                      monitors_fn=lambda: MON, pos_fn=cur)
    d.dispatch(1, "slow", {})
    ctl.configure({"enabled": True, "ms": 100, "cooldownMs": 0})
    try:
        time.sleep(0.5)
        assert trig == []  # lane busy
        gate.set()
        time.sleep(0.2)
        assert trig == []  # grace period after the lane drains
        deadline = time.monotonic() + 3
        while not trig and time.monotonic() < deadline:
            time.sleep(0.02)
        assert len(trig) == 1
    finally:
        ctl.stop()
        d.shutdown()


def test_v1_dwell_commands_keep_shape():
    from agent_proc import AgentProc

    a = AgentProc()
    try:
        def call(id, cmd, **kw):
            a.send({"id": id, "cmd": cmd, **kw})
            return a.wait_for(lambda m: m.get("id") == id)

        assert call(1, "dwell_enable", dwell_ms=5000, cooldown_ms=1500) == {
            "id": 1, "result": {"ok": True, "dwell_ms": 5000, "cooldown_ms": 1500}}
        assert call(2, "dwell_set_ms", dwell_ms=6000) == {"id": 2, "result": {"ok": True}}
        assert call(3, "dwell_pause")["result"] == {"paused": True}
        assert call(4, "dwell_resume")["result"] == {"paused": False}
        cfg = call(5, "dwell_config", clickType="double", maxRepeats=1)["result"]
        assert cfg["clickType"] == "double" and cfg["ms"] == 6000 and cfg["enabled"] is True
        assert call(6, "dwell_disable") == {"id": 6, "result": {"ok": True}}
    finally:
        a.close()
