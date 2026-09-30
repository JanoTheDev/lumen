import pytest

from agent_proc import AgentProc


@pytest.fixture
def v2():
    a = AgentProc("--protocol", "2", "--debug")
    yield a
    a.close()


def req(a, id, cmd, **args):
    a.send({"v": 2, "id": id, "cmd": cmd, "args": args})
    return a.wait_for(lambda m: m.get("id") == id)


def test_first_line_is_ready(v2):
    first = v2.next()
    assert first["v"] == 2 and first["event"] == "ready"
    data = first["data"]
    assert data["impl"] == "python"
    assert isinstance(data["version"], str)
    assert {"hotkey", "capture"} <= set(data["capabilities"])


def test_ping_framing(v2):
    msg = req(v2, 1, "ping")
    assert msg["v"] == 2 and msg["ok"] is True
    assert isinstance(msg["result"]["t"], float)


def test_error_framing_has_code(v2):
    msg = req(v2, 2, "nope")
    assert msg["ok"] is False
    assert msg["error"]["code"] == "E_UNSUPPORTED"
    assert "nope" in msg["error"]["message"]
    msg = req(v2, 3, "set_hotkey", combo="Ctrl+Bogus")
    assert msg["error"]["code"] == "E_INVALID"


def test_v1_framed_handshake_ping_still_answered(v2):
    v2.send({"id": 1, "cmd": "ping"})
    msg = v2.wait_for(lambda m: m.get("id") == 1)
    assert msg["v"] == 2 and msg["ok"] is True


def test_events_are_nested(v2):
    v2.send("garbage")
    ev = v2.wait_for(lambda m: m.get("event") == "protocol-error")
    assert ev == {"v": 2, "event": "protocol-error", "data": {"line": "garbage"}}


def test_init_applies_state(v2):
    msg = req(
        v2,
        4,
        "init",
        hotkey="Ctrl+Alt+F23",
        wake={"enabled": False, "phrase": "hey lumen", "cancelPhrases": []},
        dwell={"enabled": False, "ms": 1400, "cooldownMs": 1500},
        logLevel="info",
    )
    assert msg == {"v": 2, "id": 4, "ok": True, "result": {}}
    status = req(v2, 5, "wake_status")
    assert status["result"]["running"] is False


def test_init_rejects_bad_hotkey_without_changing_anything(v2):
    req(v2, 6, "init", hotkey="Ctrl+Alt+F23", logLevel="info")
    bad = req(v2, 7, "init", hotkey="Ctrl+Nope", logLevel="info")
    assert bad["ok"] is False and bad["error"]["code"] == "E_INVALID"
    v2.close()
    assert not any("hotkey bound Ctrl+Nope" in l for l in v2.stderr)
    assert sum("hotkey bound Ctrl+Alt+F23" in l for l in v2.stderr) == 1


def test_capture_and_active_window_shapes(v2):
    cap = req(v2, 8, "capture", monitor="primary")
    frame = cap["result"]["frames"][0]
    assert frame["mime"] == "image/jpeg" and frame["width"] > 0 and frame["height"] > 0
    assert isinstance(frame["data"], str)
    assert frame["monitor"]["primary"] is True and frame["scale"] >= 1
    win = req(v2, 9, "active_window")
    assert isinstance(win["result"]["title"], str)


def test_cancel_in_v2(v2):
    v2.send({"v": 2, "id": 10, "cmd": "debug_sleep", "args": {"ms": 5000}})
    v2.send({"v": 2, "id": 11, "cmd": "cancel", "args": {"target": 10}})
    got = {}
    while len(got) < 2:
        m = v2.next(timeout=1)
        if m.get("id") in (10, 11):
            got[m["id"]] = m
    assert got[11]["result"] == {"cancelled": True}
    target = got[10]
    assert target["ok"] is False and target["error"]["code"] == "E_CANCELLED"


def test_v1_default_has_no_ready_line():
    a = AgentProc()
    a.send({"id": 1, "cmd": "ping"})
    first = a.next()
    a.close()
    assert first == {"id": 1, "result": "pong"}
