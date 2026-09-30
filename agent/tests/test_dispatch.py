import threading
import time

import pytest

from agent_proc import AgentProc
from dispatch import CancelToken, Dispatcher, INLINE, INPUT, READ
from errors import AgentError, E_CANCELLED, E_TIMEOUT, E_UNSUPPORTED


class Replies:
    def __init__(self):
        self.items = {}
        self.cond = threading.Condition()

    def __call__(self, id, result, error):
        with self.cond:
            self.items[id] = (result, error)
            self.cond.notify_all()

    def wait(self, id, timeout=5.0):
        with self.cond:
            assert self.cond.wait_for(lambda: id in self.items, timeout), f"no reply for {id}"
            return self.items[id]


@pytest.fixture
def disp():
    replies = Replies()
    d = Dispatcher(replies)
    d.register("echo", lambda a, t: a.get("x"), INLINE)
    d.register("sleep", lambda a, t: (t.sleep(a["s"]), "done")[1], READ)
    d.register("isleep", lambda a, t: (t.sleep(a["s"]), "done")[1], INPUT)
    yield d, replies
    d.shutdown(wait=False)


def test_token_sleep_raises_when_cancelled():
    tok = CancelToken()
    threading.Timer(0.05, tok.cancel).start()
    t0 = time.monotonic()
    with pytest.raises(AgentError) as info:
        tok.sleep(5)
    assert info.value.code == E_CANCELLED
    assert time.monotonic() - t0 < 1


def test_unknown_is_unsupported(disp):
    d, r = disp
    d.dispatch(1, "nope", {})
    assert r.wait(1)[1].code == E_UNSUPPORTED


def test_inline_answers_while_read_lane_busy(disp):
    d, r = disp
    d.dispatch(1, "sleep", {"s": 2})
    t0 = time.monotonic()
    d.dispatch(2, "echo", {"x": 5})
    assert r.wait(2) == (5, None)
    assert time.monotonic() - t0 < 0.05


def test_cancel_answers_target_immediately_and_drops_late_result(disp):
    d, r = disp
    d.dispatch(1, "sleep", {"s": 5})
    time.sleep(0.05)
    t0 = time.monotonic()
    assert d.cancel(1) is True
    result, err = r.wait(1)
    assert err.code == E_CANCELLED
    assert time.monotonic() - t0 < 0.3
    assert d.cancel(1) is False


def test_timeout_ms(disp):
    d, r = disp
    d.dispatch(1, "sleep", {"s": 5, "timeoutMs": 100})
    assert r.wait(1, 2)[1].code == E_TIMEOUT


def test_input_lane_is_fifo(disp):
    d, r = disp
    order = []
    d.register("mark", lambda a, t: (time.sleep(a["s"]), order.append(a["n"]))[1], INPUT)
    d.dispatch(1, "mark", {"s": 0.1, "n": 1})
    d.dispatch(2, "mark", {"s": 0, "n": 2})
    r.wait(2)
    assert order == [1, 2]


def test_read_lane_runs_in_parallel(disp):
    d, r = disp
    t0 = time.monotonic()
    for i in range(3):
        d.dispatch(i, "sleep", {"s": 0.3})
    for i in range(3):
        r.wait(i)
    assert time.monotonic() - t0 < 0.8


def test_agent_ping_and_capture_while_long_op_runs_then_cancel():
    a = AgentProc("--debug")
    try:
        a.send({"id": 99, "cmd": "ping"})
        a.wait_for(lambda m: m.get("id") == 99)
        a.send({"id": 1, "cmd": "debug_sleep_input", "ms": 5000})
        a.send({"id": 2, "cmd": "debug_sleep", "ms": 5000})
        time.sleep(0.2)
        t0 = time.monotonic()
        a.send({"id": 3, "cmd": "ping"})
        a.wait_for(lambda m: m.get("id") == 3)
        assert time.monotonic() - t0 < 0.05
        a.send({"id": 4, "cmd": "screenshot"})
        shot = a.wait_for(lambda m: m.get("id") == 4, timeout=10)
        assert isinstance(shot["result"], str)
        t0 = time.monotonic()
        a.send({"id": 5, "cmd": "cancel", "target": 1})
        a.send({"id": 6, "cmd": "cancel", "target": 2})
        got = {}
        while len(got) < 4:
            m = a.next(5)
            if m.get("id") in (1, 2, 5, 6):
                got[m["id"]] = m
        assert time.monotonic() - t0 < 0.3
        assert "cancelled" in got[1]["error"] and "cancelled" in got[2]["error"]
        assert got[5]["result"] == {"cancelled": True}
    finally:
        a.close()
