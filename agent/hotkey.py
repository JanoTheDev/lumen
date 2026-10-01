"""Global push-to-talk hotkeys (assistant and dictation each own one manager).

Electron accelerators ("CommandOrControl+Shift+Space") are parsed into
`keyboard` key names. Hook callbacks only flip state under a lock and queue an
event: no logging or other I/O runs inside the low-level hook.
"""
import logging
import threading
from dataclasses import dataclass

from errors import AgentError, E_INVALID

log = logging.getLogger(__name__)

MODIFIER_ORDER = ("ctrl", "alt", "alt gr", "shift", "windows")

_NAMED = {
    "commandorcontrol": "ctrl",
    "cmdorctrl": "ctrl",
    "control": "ctrl",
    "ctrl": "ctrl",
    "alt": "alt",
    "option": "alt",
    "altgr": "alt gr",
    "shift": "shift",
    "super": "windows",
    "meta": "windows",
    "cmd": "windows",
    "command": "windows",
    "plus": "plus",
    "space": "space",
    "tab": "tab",
    "backspace": "backspace",
    "delete": "delete",
    "insert": "insert",
    "return": "enter",
    "enter": "enter",
    "up": "up",
    "down": "down",
    "left": "left",
    "right": "right",
    "home": "home",
    "end": "end",
    "pageup": "page up",
    "pagedown": "page down",
    "escape": "esc",
    "esc": "esc",
    "capslock": "caps lock",
    "numlock": "num lock",
    "scrolllock": "scroll lock",
    "printscreen": "print screen",
    "numadd": "plus",
    "numsub": "num -",
    "nummult": "num *",
    "numdiv": "num /",
    "numdec": "decimal",
}
_NAMED.update({f"f{i}": f"f{i}" for i in range(1, 25)})
_NAMED.update({f"num{i}": f"num {i}" for i in range(10)})

_PUNCTUATION = set(",-./;'[]=`\\")


class HotkeyError(AgentError):
    def __init__(self, message: str):
        super().__init__(E_INVALID, message)


@dataclass(frozen=True)
class Hotkey:
    modifiers: tuple
    key: str

    @property
    def keys(self) -> tuple:
        return (*self.modifiers, self.key)

    @property
    def combo(self) -> str:
        return "+".join(self.keys)


def _token_name(token: str) -> str:
    low = token.strip().lower()
    if low in _NAMED:
        return _NAMED[low]
    if len(low) == 1 and (low.isalnum() or low in _PUNCTUATION):
        return low
    raise HotkeyError(f"unknown key '{token}'")


def parse_accelerator(accelerator: str) -> Hotkey:
    """Parses an Electron accelerator. Raises HotkeyError (E_INVALID) on bad input."""
    if not isinstance(accelerator, str) or not accelerator.strip():
        raise HotkeyError("empty accelerator")
    text = accelerator.strip()
    tokens = text.split("+")
    # A literal '+' key: "Ctrl++" or "+".
    if text == "+" or text.endswith("++"):
        tokens = text[:-1].split("+")[:-1] + ["plus"]
        if any(not t.strip() for t in tokens):
            raise HotkeyError(f"malformed accelerator '{accelerator}'")
    elif any(not t.strip() for t in tokens):
        raise HotkeyError(f"malformed accelerator '{accelerator}'")

    modifiers: list = []
    key = None
    for token in tokens:
        name = _token_name(token)
        if name in MODIFIER_ORDER:
            if name not in modifiers:
                modifiers.append(name)
        elif key is None:
            key = name
        else:
            raise HotkeyError(f"accelerator '{accelerator}' has more than one non-modifier key")
    if key is None:
        raise HotkeyError(f"accelerator '{accelerator}' has no non-modifier key")
    modifiers.sort(key=MODIFIER_ORDER.index)
    return Hotkey(tuple(modifiers), key)


class HotkeyManager:
    """Owns the keyboard hooks for one push-to-talk combo."""

    def __init__(self, emit, keyboard_module=None, down_event="hotkey-down", up_event="hotkey-up"):
        self._emit = emit
        self._down_event = down_event
        self._up_event = up_event
        self._label = "hotkey" if down_event == "hotkey-down" else down_event.replace("-down", " hotkey")
        self._kb = keyboard_module
        self._lock = threading.Lock()
        self._active = False
        self._refs: list = []
        self._accelerator = ""
        self._hotkey = None

    @property
    def accelerator(self) -> str:
        return self._accelerator

    def _keyboard(self):
        if self._kb is None:
            import keyboard

            self._kb = keyboard
        return self._kb

    def _on_press(self):
        with self._lock:
            if self._active:
                return
            self._active = True
            self._emit(self._down_event)

    def _on_key_event(self, event):
        if event.event_type != "up":
            return
        with self._lock:
            if not self._active:
                return
            self._active = False
            self._emit(self._up_event)

    def _unhook(self) -> None:
        kb = self._kb
        for kind, ref in self._refs:
            try:
                if kind == "hotkey":
                    kb.remove_hotkey(ref)
                else:
                    kb.unhook(ref)
            except Exception:
                pass
        self._refs = []
        with self._lock:
            self._active = False

    def _hook(self, hk: Hotkey) -> None:
        kb = self._keyboard()
        self._refs.append(("hotkey", kb.add_hotkey(hk.combo, self._on_press, suppress=True)))
        # Release of the trigger or of any modifier in the combo ends the press.
        for name in hk.keys:
            self._refs.append(("hook", kb.hook_key(name, self._on_key_event)))

    def bind(self, accelerator: str) -> Hotkey | None:
        """Binds a new combo; an empty string unbinds. Keeps the old binding on error."""
        if not accelerator or not accelerator.strip():
            self._unhook()
            self._accelerator, self._hotkey = "", None
            log.info("%s unbound", self._label)
            return None
        hk = parse_accelerator(accelerator)
        kb = self._keyboard()
        try:
            kb.parse_hotkey(hk.combo)
        except ValueError as e:
            raise HotkeyError(f"key not available on this keyboard layout: {e}") from None

        previous = self._hotkey
        self._unhook()
        try:
            self._hook(hk)
        except Exception:
            self._unhook()
            if previous is not None:
                try:
                    self._hook(previous)
                except Exception:
                    self._unhook()
                    self._accelerator, self._hotkey = "", None
            raise
        self._accelerator, self._hotkey = accelerator, hk
        log.info("%s bound %s -> %s", self._label, accelerator, hk.combo)
        return hk

    def unbind(self) -> None:
        self.bind("")
