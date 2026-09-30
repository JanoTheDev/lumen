import pytest

import safety
from errors import AgentError


@pytest.mark.parametrize("url", [
    "https://mail.google.com/mail/u/0/#inbox",
    "http://localhost:3000/x?y=1",
    "  HTTPS://Example.com  ",
])
def test_http_urls_allowed(url):
    assert safety.check_url(url) == url.strip()


@pytest.mark.parametrize("url", [
    "file:///C:/Windows/System32/cmd.exe",
    "C:\\Windows\\System32\\cmd.exe",
    "\\\\evil\\share\\x.exe",
    "ms-settings:privacy",
    "javascript:alert(1)",
    "calculator:",
    "mailto:a@b.c",
    "https://",
    "",
    None,
    "search-ms:query=x",
])
def test_other_urls_denied(url):
    with pytest.raises(AgentError) as e:
        safety.check_url(url)
    assert e.value.code == "E_DENIED"


@pytest.mark.parametrize("keys", [
    ["win", "r"], ["winleft", "x"], ["win", "i"], ["Win", "E"], ["win"], ["win", "shift", "s"],
    ["ctrl", "alt", "delete"], ["ctrlleft", "altright", "t"], ["ctrl", "shift", "esc"],
    ["ctrl", "shift", "escape"], "win+r", "Ctrl+Alt+Del",
])
def test_denied_combos(keys):
    with pytest.raises(AgentError) as e:
        safety.check_combo(keys)
    assert e.value.code == "E_DENIED"


@pytest.mark.parametrize("keys", [
    ["win", "d"], ["win", "tab"], ["win", "left"], ["winright", "up"], ["win", "down"], ["win", "right"],
    ["ctrl", "c"], ["ctrl", "shift", "t"], ["alt", "tab"], ["ctrl", "l"], ["enter"], ["alt", "f4"], "ctrl+v",
])
def test_allowed_combos(keys):
    safety.check_combo(keys)


def test_normalize_keys():
    assert safety.normalize_keys("Ctrl+Shift+Escape") == ["ctrl", "shift", "esc"]
    assert safety.normalize_keys(["WinLeft", "ArrowLeft"]) == ["win", "left"]


@pytest.mark.parametrize("exe", sorted(safety.TERMINALS))
def test_terminals_denied(exe):
    assert safety.denied_target_reason(exe, "ConsoleWindowClass", []) is not None


def test_run_dialog_denied_other_dialogs_allowed():
    assert safety.denied_target_reason("explorer.exe", "#32770", ["Static", "ComboBox", "Edit", "Button"])
    assert safety.denied_target_reason("explorer.exe", "#32770", ["Static", "Button"]) is None
    assert safety.denied_target_reason("notepad.exe", "#32770", ["ComboBox", "Edit"]) is None
    assert safety.denied_target_reason("notepad.exe", "Notepad", []) is None


def test_allow_terminal_flag_skips_target_check(monkeypatch):
    monkeypatch.setattr(safety, "foreground_target", lambda: ("cmd.exe", "ConsoleWindowClass", []))
    with pytest.raises(AgentError) as e:
        safety.check_input_target({"type": "type", "text": "dir"}, "type")
    assert e.value.code == "E_DENIED" and "terminal" in e.value.message
    safety.check_input_target({"type": "type", "text": "dir", "allowTerminal": True}, "type")


def test_actions_type_into_terminal_denied(monkeypatch):
    import actions

    monkeypatch.setattr(safety, "foreground_target", lambda: ("pwsh.exe", "CASCADIA_HOSTING_WINDOW_CLASS", []))
    with pytest.raises(AgentError) as e:
        actions.execute_action({"type": "type", "text": "rm -rf"})
    assert e.value.code == "E_DENIED"
    with pytest.raises(AgentError) as e:
        actions.execute_action({"type": "hotkey", "keys": ["win", "r"]})
    assert e.value.code == "E_DENIED"
    with pytest.raises(AgentError) as e:
        actions.execute_action({"type": "navigate_url", "url": "file:///C:/x.exe"})
    assert e.value.code == "E_DENIED"


def test_live_foreground_target_shape():
    exe, cls, kids = safety.foreground_target()
    assert isinstance(exe, str) and isinstance(cls, str) and isinstance(kids, list)
