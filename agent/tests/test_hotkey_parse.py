import pytest

from errors import E_INVALID
from hotkey import HotkeyError, HotkeyManager, parse_accelerator


@pytest.mark.parametrize(
    "accel, combo",
    [
        ("Ctrl+Shift+Space", "ctrl+shift+space"),
        ("CommandOrControl+Shift+Space", "ctrl+shift+space"),
        ("CmdOrCtrl+K", "ctrl+k"),
        ("Control+Alt+Delete", "ctrl+alt+delete"),
        ("Shift+Alt+Ctrl+A", "ctrl+alt+shift+a"),
        ("Option+Tab", "alt+tab"),
        ("Super+Space", "windows+space"),
        ("Meta+Up", "windows+up"),
        ("Cmd+Down", "windows+down"),
        ("Ctrl+Plus", "ctrl+plus"),
        ("Ctrl++", "ctrl+plus"),
        ("Alt+Backspace", "alt+backspace"),
        ("Alt+Insert", "alt+insert"),
        ("Ctrl+Return", "ctrl+enter"),
        ("Ctrl+Enter", "ctrl+enter"),
        ("Ctrl+Left", "ctrl+left"),
        ("Ctrl+Right", "ctrl+right"),
        ("Ctrl+Home", "ctrl+home"),
        ("Ctrl+End", "ctrl+end"),
        ("Ctrl+PageUp", "ctrl+page up"),
        ("Ctrl+PageDown", "ctrl+page down"),
        ("Shift+Escape", "shift+esc"),
        ("Shift+Esc", "shift+esc"),
        ("F4", "f4"),
        ("Ctrl+F24", "ctrl+f24"),
        ("Ctrl+num0", "ctrl+num 0"),
        ("Ctrl+num9", "ctrl+num 9"),
        ("Ctrl+numadd", "ctrl+plus"),
        ("Ctrl+numsub", "ctrl+num -"),
        ("Ctrl+nummult", "ctrl+num *"),
        ("Ctrl+numdiv", "ctrl+num /"),
        ("Ctrl+numdec", "ctrl+decimal"),
        ("ctrl+shift+space", "ctrl+shift+space"),
        ("Alt+B", "alt+b"),
        ("Ctrl+7", "ctrl+7"),
        ("Ctrl+,", "ctrl+,"),
        ("Ctrl+/", "ctrl+/"),
    ],
)
def test_parse_table(accel, combo):
    assert parse_accelerator(accel).combo == combo


def test_trigger_is_last_key():
    hk = parse_accelerator("Ctrl+Shift+Space")
    assert hk.key == "space"
    assert hk.modifiers == ("ctrl", "shift")


@pytest.mark.parametrize(
    "accel",
    ["", "   ", "Ctrl+", "Ctrl+Shift", "Ctrl+Hyper+A", "Ctrl+A+B", "Ctrl++Shift+A", "Foo", None, 5],
)
def test_rejects_invalid(accel):
    with pytest.raises(HotkeyError) as info:
        parse_accelerator(accel)
    assert info.value.code == E_INVALID


class FakeKeyboard:
    def __init__(self):
        self.hotkeys = {}
        self.hooks = {}
        self._n = 0

    def parse_hotkey(self, combo):
        return combo

    def add_hotkey(self, combo, cb, suppress=False):
        self._n += 1
        self.hotkeys[self._n] = (combo, cb)
        return self._n

    def remove_hotkey(self, ref):
        del self.hotkeys[ref]

    def hook_key(self, name, cb):
        self._n += 1
        self.hooks[self._n] = (name, cb)
        return self._n

    def unhook(self, ref):
        del self.hooks[ref]

    def press(self):
        for _, cb in list(self.hotkeys.values()):
            cb()

    def release(self, name):
        ev = type("E", (), {"event_type": "up", "name": name})()
        for key, cb in list(self.hooks.values()):
            if key == name:
                cb(ev)


def make():
    events = []
    kb = FakeKeyboard()
    return HotkeyManager(events.append, keyboard_module=kb), kb, events


def test_release_of_trigger_or_any_modifier_emits_up_once():
    mgr, kb, events = make()
    mgr.bind("Ctrl+Shift+Space")
    assert sorted(n for n, _ in kb.hooks.values()) == ["ctrl", "shift", "space"]
    kb.press()
    kb.press()
    kb.release("shift")
    kb.release("space")
    assert events == ["hotkey-down", "hotkey-up"]
    kb.press()
    kb.release("space")
    assert events == ["hotkey-down", "hotkey-up", "hotkey-down", "hotkey-up"]


def test_invalid_rebind_keeps_previous_binding():
    mgr, kb, _ = make()
    mgr.bind("Ctrl+Shift+Space")
    with pytest.raises(HotkeyError):
        mgr.bind("Ctrl+Nope")
    assert mgr.accelerator == "Ctrl+Shift+Space"
    assert [c for c, _ in kb.hotkeys.values()] == ["ctrl+shift+space"]


def test_rebind_replaces_hooks_and_empty_unbinds():
    mgr, kb, _ = make()
    mgr.bind("Ctrl+Shift+Space")
    mgr.bind("Alt+B")
    assert [c for c, _ in kb.hotkeys.values()] == ["alt+b"]
    assert sorted(n for n, _ in kb.hooks.values()) == ["alt", "b"]
    mgr.bind("")
    assert kb.hotkeys == {} and kb.hooks == {}
    assert mgr.accelerator == ""
