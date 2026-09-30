import time

import pytest

from agent_proc import AgentProc
from mousewatch import MouseWatcher


def test_emits_only_while_enabled_and_past_threshold():
    pos = [(0, 0)]
    events = []
    w = MouseWatcher(events.append, pos_fn=lambda: pos[0])
    pos[0] = (50, 50)
    time.sleep(0.15)
    assert events == [] and not w.running
    w.set_enabled(True)
    time.sleep(0.12)
    pos[0] = (55, 55)  # within 12 px
    time.sleep(0.12)
    assert events == []
    pos[0] = (200, 50)
    time.sleep(0.15)
    assert events == ["mouse-moved"]
    w.set_enabled(False)
    time.sleep(0.1)
    pos[0] = (900, 900)
    time.sleep(0.15)
    assert events == ["mouse-moved"] and not w.running


@pytest.fixture
def v2():
    a = AgentProc("--protocol", "2")
    yield a
    a.close()


def req(a, id, cmd, **args):
    a.send({"v": 2, "id": id, "cmd": cmd, "args": args})
    return a.wait_for(lambda m: m.get("id") == id)


def test_subscribe_protocol(v2):
    assert req(v2, 1, "subscribe", events=["mouse-moved"], enabled=True)["result"] == {"subscribed": ["mouse-moved"]}
    assert req(v2, 2, "subscribe", events=["mouse-moved"], enabled=False)["result"] == {"subscribed": []}
    bad = req(v2, 3, "subscribe", events=["focus-changed"])
    assert bad["ok"] is False and bad["error"]["code"] == "E_UNSUPPORTED"
    assert req(v2, 4, "init", subscriptions=["mouse-moved"])["ok"] is True
    assert req(v2, 5, "subscribe", events=[])["result"] == {"subscribed": ["mouse-moved"]}
    assert req(v2, 6, "init")["ok"] is True
    assert req(v2, 7, "subscribe", events=[])["result"] == {"subscribed": []}
