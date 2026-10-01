import pytest

import a11y_state
import input_steps
from errors import AgentError


class FakeGui:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def rec(*a, **kw):
            self.calls.append((name, a, kw))
        return rec


class Tok:
    def __init__(self):
        self.slept = 0.0

    def check(self):
        pass

    def sleep(self, s):
        self.slept += s


def run(steps, **extra):
    gui = FakeGui()
    input_steps.run({"steps": steps, **extra}, Tok(), gui)
    return gui.calls


def test_click_types():
    calls = run([{"t": "click", "button": "right", "x": 10.4, "y": 20, "count": 2}])
    assert calls[0] == ("moveTo", (10, 20), {})
    assert calls[1] == ("click", (), {"clicks": 2, "interval": 0.06, "button": "right"})


def test_click_without_point_clicks_in_place():
    calls = run([{"t": "click", "button": "middle"}])
    assert [c[0] for c in calls] == ["click"]


def test_drag_always_releases():
    calls = run([{"t": "drag", "from": {"x": 0, "y": 0}, "to": {"x": 120, "y": 60}}])
    names = [c[0] for c in calls]
    assert names[0] == "moveTo" and names[1] == "mouseDown" and names[-1] == "mouseUp"
    assert calls[-2] == ("moveTo", (120, 60), {})


def test_drag_released_when_cancelled():
    gui = FakeGui()

    class Cancelling(Tok):
        def sleep(self, s):
            if any(c[0] == "mouseDown" for c in gui.calls):
                raise AgentError("E_CANCELLED", "cancelled")

    with pytest.raises(AgentError):
        input_steps.run({"steps": [{"t": "drag", "from": {"x": 0, "y": 0}, "to": {"x": 9, "y": 9}}]},
                        Cancelling(), gui)
    assert gui.calls[-1][0] == "mouseUp"


def test_scroll_notches_and_direction():
    calls = run([{"t": "scroll", "dy": 3, "dx": -1, "x": 5, "y": 6}])
    assert ("scroll", (-360,), {"x": 5, "y": 6}) in calls
    assert ("hscroll", (-120,), {"x": 5, "y": 6}) in calls


@pytest.mark.parametrize("step", [
    {"t": "click", "count": 4},
    {"t": "click", "button": "x1"},
    {"t": "click", "x": 1},
    {"t": "drag", "from": {"x": 1}, "to": {"x": 1, "y": 2}},
    {"t": "scroll", "dy": 500},
    {"t": "type"},
    {"t": "keys", "combo": ""},
    {"t": "wait", "ms": -1},
    {"t": "explode"},
])
def test_invalid_steps_rejected_before_anything_runs(step):
    gui = FakeGui()
    with pytest.raises(AgentError) as e:
        input_steps.run({"steps": [{"t": "move", "x": 1, "y": 1}, step]}, Tok(), gui)
    assert e.value.code == "E_INVALID"
    assert gui.calls == []


def test_denied_combo_rejected_up_front():
    gui = FakeGui()
    with pytest.raises(AgentError) as e:
        input_steps.run({"steps": [{"t": "move", "x": 1, "y": 1}, {"t": "keys", "combo": "win+r"}]}, Tok(), gui)
    assert e.value.code == "E_DENIED"
    assert gui.calls == []


def test_keys_and_wait(monkeypatch):
    monkeypatch.setattr(input_steps.safety, "check_input_target", lambda *a: None)
    tok = Tok()
    gui = FakeGui()
    input_steps.run({"steps": [{"t": "keys", "combo": "Control+S"}, {"t": "wait", "ms": 250}]}, tok, gui)
    assert gui.calls == [("hotkey", ("ctrl", "s"), {})]
    assert tok.slept == pytest.approx(0.25)


def test_a11y_classify():
    assert a11y_state.classify({"nvda.exe", "explorer.exe"}, True) == {"screenReader": "nvda", "voiceControl": []}
    assert a11y_state.classify({"narrator.exe"}, False)["screenReader"] == "narrator"
    assert a11y_state.classify(set(), True)["screenReader"] == "other"
    assert a11y_state.classify({"voiceaccess.exe", "natspeak.exe"}, False) == {
        "screenReader": None, "voiceControl": ["voice-access", "dragon"]}


def test_a11y_state_runs_on_this_machine():
    s = a11y_state.state()
    assert set(s) == {"screenReader", "voiceControl"}
