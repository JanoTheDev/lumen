import ctypes
import time

import pytest

import sendinput
from errors import AgentError

U = sendinput.KEYEVENTF_UNICODE
UP = sendinput.KEYEVENTF_KEYUP


def units(events):
    return [scan for vk, scan, flags in events if flags == U]


def test_struct_size_matches_win32():
    assert ctypes.sizeof(sendinput.INPUT) == (40 if ctypes.sizeof(ctypes.c_void_p) == 8 else 28)


def test_unicode_units_with_surrogate_pairs():
    text = "héllo \U0001F44B 世界"
    ev = sendinput.key_events(text)
    assert units(ev) == list(memoryview(text.encode("utf-16-le")).cast("H"))
    assert units(ev)[6:8] == [0xD83D, 0xDC4B]  # 👋 is two code units
    # every unit is a down immediately followed by its up
    for down, up in zip(ev[::2], ev[1::2]):
        assert down[1] == up[1] and up[2] == down[2] | UP


def test_newlines_and_tabs_are_keys():
    ev = sendinput.key_events("a\nb\r\nc\rd\te")
    vks = [vk for vk, _, flags in ev if vk and not flags & UP]
    assert vks == [sendinput.VK_RETURN] * 3 + [sendinput.VK_TAB]
    assert units(ev) == [ord(c) for c in "abcde"]


def test_batches_and_cancel(monkeypatch):
    sent = []
    monkeypatch.setattr(sendinput, "send", lambda evs: sent.append(len(evs)))
    checks = []
    n = sendinput.type_text("x" * 40, check=lambda: checks.append(1), sleep=lambda s: None)
    assert n == 80 and sent == [32, 32, 16] and len(checks) == 3

    calls = {"n": 0}

    def check():
        calls["n"] += 1
        if calls["n"] == 2:
            raise AgentError("E_CANCELLED", "cancelled")

    sent.clear()
    with pytest.raises(AgentError):
        sendinput.type_text("y" * 40, check=check, sleep=lambda s: None)
    assert sent == [32]


def test_blocked_input_is_denied(monkeypatch):
    monkeypatch.setattr(sendinput, "_SendInput", lambda n, arr, size: 0)
    with pytest.raises(AgentError) as e:
        sendinput.send(sendinput.key_events("a"))
    assert e.value.code == "E_DENIED"


def test_live_types_into_focused_entry_without_clipboard():
    tk = pytest.importorskip("tkinter")
    try:
        root = tk.Tk()
    except tk.TclError:
        pytest.skip("no display")
    try:
        root.geometry("400x80+200+200")
        entry = tk.Text(root, height=3)
        entry.pack()
        root.clipboard_clear()
        root.clipboard_append("keep me")
        root.update()
        hwnd = int(root.wm_frame(), 16)
        ctypes.windll.user32.SetForegroundWindow(hwnd)
        root.focus_force()
        entry.focus_set()
        root.update()
        if ctypes.windll.user32.GetForegroundWindow() != hwnd:
            pytest.skip("could not take foreground")
        text = "héllo 世界\nline2"
        sendinput.type_text(text)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and entry.get("1.0", "end-1c") != text:
            root.update()
            time.sleep(0.02)
        assert entry.get("1.0", "end-1c") == text
        assert root.clipboard_get() == "keep me"
    finally:
        root.destroy()
