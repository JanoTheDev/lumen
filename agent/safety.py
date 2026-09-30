"""Agent-side action policy (defense in depth; main applies its own first).

- URLs: http/https only.
- Key combos: no Run/terminal/settings/security shortcuts.
- No typing or key combos into terminals or the Run dialog unless the
  action carries `allowTerminal: true` (main sets it only after the user
  explicitly confirmed).
"""
from urllib.parse import urlsplit

from errors import AgentError, E_DENIED

ALLOWED_SCHEMES = {"http", "https"}

TERMINALS = {
    "cmd.exe", "powershell.exe", "powershell_ise.exe", "pwsh.exe", "windowsterminal.exe",
    "conhost.exe", "openconsole.exe", "wsl.exe", "wslhost.exe", "bash.exe", "mintty.exe",
}

_ALIASES = {
    "win": "win", "winleft": "win", "winright": "win", "windows": "win", "super": "win", "meta": "win",
    "cmd": "win", "command": "win", "lwin": "win", "rwin": "win",
    "ctrl": "ctrl", "ctrlleft": "ctrl", "ctrlright": "ctrl", "control": "ctrl", "lctrl": "ctrl", "rctrl": "ctrl",
    "alt": "alt", "altleft": "alt", "altright": "alt", "option": "alt", "lalt": "alt", "ralt": "alt",
    "shift": "shift", "shiftleft": "shift", "shiftright": "shift", "lshift": "shift", "rshift": "shift",
    "esc": "esc", "escape": "esc",
    "del": "delete", "delete": "delete",
    "arrowleft": "left", "arrowright": "right", "arrowup": "up", "arrowdown": "down",
}
_WIN_ALLOWED = {"d", "tab", "left", "right", "up", "down"}


def check_url(url) -> str:
    """Returns the URL if its scheme is http(s) with a host; raises E_DENIED otherwise."""
    if not isinstance(url, str) or not url.strip():
        raise AgentError(E_DENIED, "navigate_url needs an http(s) URL")
    parts = urlsplit(url.strip())
    if parts.scheme.lower() not in ALLOWED_SCHEMES or not parts.netloc:
        raise AgentError(E_DENIED, f"URL scheme not allowed: {parts.scheme or '(none)'}")
    return url.strip()


def normalize_keys(keys) -> list:
    """["Win", "R"] or "win+r" -> ["win", "r"]."""
    if isinstance(keys, str):
        keys = [k for k in keys.split("+") if k.strip()] or ([keys] if keys else [])
    out = []
    for k in keys or []:
        name = str(k).strip().lower()
        out.append(_ALIASES.get(name, name))
    return out


def denied_combo_reason(keys) -> str | None:
    ks = set(normalize_keys(keys))
    if "win" in ks:
        rest = ks - {"win"}
        if len(rest) == 1 and rest <= _WIN_ALLOWED:
            return None
        return "Windows-key shortcuts can open Run, terminals or settings"
    if {"ctrl", "alt"} <= ks:
        return "Ctrl+Alt shortcuts are blocked"
    if {"ctrl", "shift", "esc"} <= ks:
        return "Ctrl+Shift+Esc (Task Manager) is blocked"
    return None


def check_combo(keys) -> None:
    reason = denied_combo_reason(keys)
    if reason:
        raise AgentError(E_DENIED, f"hotkey {'+'.join(normalize_keys(keys))} denied: {reason}")


def is_run_dialog(cls: str, exe: str, child_classes) -> bool:
    """The Win+R dialog: an explorer-owned #32770 with a combo box holding an edit."""
    kids = set(child_classes)
    return cls == "#32770" and exe == "explorer.exe" and "ComboBox" in kids and "Edit" in kids


def denied_target_reason(exe: str, cls: str, child_classes) -> str | None:
    if exe in TERMINALS:
        return f"foreground is a terminal ({exe})"
    if is_run_dialog(cls, exe, child_classes):
        return "foreground is the Run dialog"
    return None


def foreground_target() -> tuple:
    """(exe, class, child classes) of the foreground window."""
    import window

    hwnd = window.foreground()
    if not hwnd:
        return "", "", []
    cls = window.class_name(hwnd)
    kids = [window.class_name(c) for c in window.child_windows(hwnd)] if cls == "#32770" else []
    return window.process_name(hwnd), cls, kids


def check_input_target(action: dict, what: str) -> None:
    """Raises E_DENIED when typing/keys would land in a terminal or the Run dialog."""
    if action.get("allowTerminal") is True:
        return
    reason = denied_target_reason(*foreground_target())
    if reason:
        raise AgentError(E_DENIED, f"{what} denied: {reason}")
