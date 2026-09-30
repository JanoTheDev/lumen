import json

import pytest

from agent_proc import AgentProc


@pytest.fixture
def agent():
    a = AgentProc()
    yield a
    a.close()


def test_ping_flood_every_stdout_line_is_json(agent):
    for i in range(1, 201):
        agent.send({"id": i, "cmd": "ping"})
    seen = set()
    while len(seen) < 200:
        msg = agent.next()
        if "id" in msg:
            assert msg["result"] == "pong"
            seen.add(msg["id"])
    agent.close()
    for line in agent.raw:
        json.loads(line)


def test_screenshots_interleaved_with_pings_stay_framed(agent):
    for i in range(1, 11):
        agent.send({"id": i, "cmd": "screenshot"})
        agent.send({"id": 100 + i, "cmd": "ping"})
    got = {}
    while len(got) < 20:
        msg = agent.next(timeout=30)
        if "id" in msg:
            got[msg["id"]] = msg
    assert all(isinstance(got[i]["result"], str) for i in range(1, 11))
    agent.close()
    for line in agent.raw:
        json.loads(line)


def test_garbage_line_emits_protocol_error_then_ping_answers(agent):
    agent.send("this is {not json")
    agent.send({"id": 7, "cmd": "ping"})
    first = agent.wait_for(lambda m: m.get("event") == "protocol-error" or "id" in m)
    assert first["event"] == "protocol-error"
    assert first["line"].startswith("this is")
    pong = agent.wait_for(lambda m: "id" in m)
    assert pong == {"id": 7, "result": "pong"}


def test_non_object_json_is_protocol_error_not_reuse_of_previous_id(agent):
    agent.send({"id": 1, "cmd": "ping"})
    agent.wait_for(lambda m: m.get("id") == 1)
    agent.send("[1, 2]")
    msg = agent.wait_for(lambda m: m.get("event") == "protocol-error" or "id" in m)
    assert msg["event"] == "protocol-error"


def test_unknown_command_is_an_error(agent):
    agent.send({"id": 3, "cmd": "nope"})
    msg = agent.wait_for(lambda m: m.get("id") == 3)
    assert "result" not in msg
    assert "nope" in msg["error"]


def test_set_hotkey_rejects_invalid_and_accepts_valid(agent):
    agent.send({"id": 1, "cmd": "set_hotkey", "combo": "Ctrl+Nope"})
    bad = agent.wait_for(lambda m: m.get("id") == 1)
    assert "Nope" in bad["error"]
    agent.send({"id": 2, "cmd": "set_hotkey", "combo": "Ctrl+Alt+F23"})
    ok = agent.wait_for(lambda m: m.get("id") == 2)
    assert ok["result"]["ok"] is True


def test_hotkey_argv_binds_at_startup():
    a = AgentProc("--hotkey", "Ctrl+Alt+F23")
    a.send({"id": 1, "cmd": "ping"})
    a.wait_for(lambda m: m.get("id") == 1)
    a.close()
    assert any("hotkey bound Ctrl+Alt+F23" in l for l in a.stderr)


def test_no_hotkey_bound_by_default(agent):
    agent.send({"id": 1, "cmd": "ping"})
    agent.wait_for(lambda m: m.get("id") == 1)
    agent.close()
    assert not any("hotkey bound" in l for l in agent.stderr)
