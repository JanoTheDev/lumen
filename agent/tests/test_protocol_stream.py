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
