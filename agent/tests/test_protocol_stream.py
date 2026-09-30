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


@pytest.mark.parametrize("protocol", ["1", "2"])
def test_event_flood_with_pings_and_screenshots_stays_json(protocol):
    a = AgentProc("--protocol", protocol, "--debug")
    try:
        frame = (lambda i, cmd, **args: {"v": 2, "id": i, "cmd": cmd, "args": args}) if protocol == "2" \
            else (lambda i, cmd, **args: {"id": i, "cmd": cmd, **args})
        a.send(frame(1, "debug_emit", n=5000))
        for i in range(2, 202):
            a.send(frame(i, "ping"))
        for i in range(202, 212):
            a.send(frame(i, "screenshot"))
        ids, events = set(), 0
        while len(ids) < 211 or events < 5000:
            msg = a.next(timeout=30)
            if msg.get("event") == "debug":
                events += 1
            elif "id" in msg:
                ids.add(msg["id"])
    finally:
        a.close()
    for line in a.raw:
        json.loads(line)
    assert not any("stray write" in l for l in a.raw)
    assert any("stray write" in l for l in a.stderr)


_THREADED_WRITER = r"""
import threading
import proto

def worker(t):
    for i in range(1000):
        proto.send({"t": t, "i": i, "pad": "x" * (i % 64), "text": "Größe — 日本"})

threads = [threading.Thread(target=worker, args=(t,)) for t in range(8)]
for th in threads:
    th.start()
for th in threads:
    th.join()
proto.close(timeout=10)
"""


def test_writer_emits_one_line_per_message_across_threads():
    import os
    import subprocess
    import sys

    agent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = subprocess.run(
        [sys.executable, "-c", _THREADED_WRITER],
        cwd=agent_dir,
        capture_output=True,
        timeout=60,
        env={**os.environ, "PYTHONUTF8": "1"},
    ).stdout.decode("utf-8")
    lines = out.split("\n")
    assert lines[-1] == ""
    msgs = [json.loads(l) for l in lines[:-1]]
    assert len(msgs) == 8000
    assert {(m["t"], m["i"]) for m in msgs} == {(t, i) for t in range(8) for i in range(1000)}
    assert all(m["text"] == "Größe — 日本" for m in msgs)


@pytest.mark.parametrize(
    "frame",
    [{"v": 2, "id": 9}, {"v": 2, "id": 9, "cmd": 123}, {"v": 2, "id": 9, "cmd": "ping", "args": "x"}],
)
def test_malformed_v2_request_answers_with_its_own_id(frame):
    a = AgentProc("--protocol", "2")
    try:
        a.send(frame)
        a.send({"v": 2, "id": 10, "cmd": "ping"})
        msg = a.wait_for(lambda m: m.get("id") in (9, 10))
        assert msg["id"] == 9
        if frame.get("cmd") == "ping":
            assert msg["ok"] is True  # non-object args fall back to {}
        else:
            assert msg["ok"] is False and msg["error"]["code"]
        assert a.wait_for(lambda m: m.get("id") == 10)["ok"] is True
    finally:
        a.close()
