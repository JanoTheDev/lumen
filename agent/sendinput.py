"""Clipboard-free typing with SendInput + KEYEVENTF_UNICODE.

Each UTF-16 code unit is sent as a key down/up pair (a surrogate pair is two
units), so any text reaches the focused control without touching the
clipboard or depending on the keyboard layout. Newlines and tabs are sent as
real Return/Tab keys so editors and forms react to them as usual.
"""
import ctypes
import ctypes.wintypes as wt
import sys
import time

from errors import AgentError, E_DENIED

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
VK_RETURN = 0x0D
VK_TAB = 0x09

BATCH = 32
BATCH_PAUSE_S = 0.002

_ULONG_PTR = ctypes.c_size_t


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", _ULONG_PTR)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD), ("dwFlags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", _ULONG_PTR)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wt.DWORD), ("wParamL", wt.WORD), ("wParamH", wt.WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wt.DWORD), ("u", _INPUTUNION)]


if sys.platform == "win32":
    _SendInput = ctypes.windll.user32.SendInput
    _SendInput.argtypes = [wt.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
    _SendInput.restype = wt.UINT


def key_events(text: str) -> list:
    """Text -> [(vk, scan, flags)] in send order. Pure, for tests."""
    out = []

    def vk(code):
        out.append((code, 0, 0))
        out.append((code, 0, KEYEVENTF_KEYUP))

    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "\r":
            vk(VK_RETURN)
            if i + 1 < n and text[i + 1] == "\n":
                i += 1
        elif ch == "\n":
            vk(VK_RETURN)
        elif ch == "\t":
            vk(VK_TAB)
        else:
            data = ch.encode("utf-16-le")
            for j in range(0, len(data), 2):
                unit = int.from_bytes(data[j:j + 2], "little")
                out.append((0, unit, KEYEVENTF_UNICODE))
                out.append((0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
        i += 1
    return out


def _to_inputs(events) -> ctypes.Array:
    arr = (INPUT * len(events))()
    for k, (vk, scan, flags) in enumerate(events):
        arr[k].type = INPUT_KEYBOARD
        arr[k].ki = KEYBDINPUT(vk, scan, flags, 0, 0)
    return arr


def send(events) -> None:
    if not events:
        return
    arr = _to_inputs(events)
    sent = _SendInput(len(events), arr, ctypes.sizeof(INPUT))
    if sent != len(events):
        raise AgentError(E_DENIED, "input was blocked (the focused window may be elevated)")


def type_text(text: str, check=None, sleep=time.sleep) -> int:
    """Types `text` into the focused control. `check()` runs between batches (cancel point)."""
    events = key_events(text)
    for start in range(0, len(events), BATCH):
        if check is not None:
            check()
        send(events[start:start + BATCH])
        if start + BATCH < len(events):
            sleep(BATCH_PAUSE_S)
    return len(events)
