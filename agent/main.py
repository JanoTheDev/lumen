import proto  # must be first: claims stdout for the protocol
import dpi  # before pyautogui/mss, which would lock in system DPI awareness

import sys
import json
import logging
import threading
import time

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
log = logging.getLogger("agent")
log.info(dpi.describe())

from capture import take_screenshot, get_active_window
from actions import execute_action
import wake
import dwell
from errors import AgentError, E_UNSUPPORTED

respond = proto.respond
emit_event = proto.emit

_hotkey_state = {
    'combo_active': False,
    'hotkey_ref': None,
    'hook_ref': None,
    'release_key': 'space',
    'keyboard': None,
}

def _normalize_combo(combo: str) -> tuple[str, str]:
    # Input like "Ctrl+Shift+Space" or "F4" -> ("ctrl+shift+space", "space")
    parts = [p.strip() for p in combo.split('+') if p.strip()]
    if not parts:
        return ('ctrl+space', 'space')
    norm = []
    for p in parts:
        low = p.lower()
        mapping = {'control': 'ctrl', 'super': 'windows', 'meta': 'windows', 'cmd': 'windows', 'command': 'windows', 'escape': 'esc'}
        norm.append(mapping.get(low, low))
    release_key = norm[-1]
    return ('+'.join(norm), release_key)

def apply_hotkey(combo: str):
    kb = _hotkey_state['keyboard']
    if kb is None:
        import keyboard as kb
        _hotkey_state['keyboard'] = kb

    hk_combo, release_key = _normalize_combo(combo)

    if _hotkey_state['hotkey_ref'] is not None:
        try: kb.remove_hotkey(_hotkey_state['hotkey_ref'])
        except Exception: pass
        _hotkey_state['hotkey_ref'] = None
    if _hotkey_state['hook_ref'] is not None:
        try: kb.unhook(_hotkey_state['hook_ref'])
        except Exception: pass
        _hotkey_state['hook_ref'] = None
    _hotkey_state['combo_active'] = False

    def on_press():
        if not _hotkey_state['combo_active']:
            _hotkey_state['combo_active'] = True
            emit_event('hotkey-down')

    def on_release_event(event):
        if event.event_type == 'up' and _hotkey_state['combo_active']:
            _hotkey_state['combo_active'] = False
            emit_event('hotkey-up')

    _hotkey_state['hotkey_ref'] = kb.add_hotkey(hk_combo, on_press, suppress=True)
    _hotkey_state['hook_ref'] = kb.hook_key(release_key, on_release_event)
    _hotkey_state['release_key'] = release_key
    log.info('hotkey bound %s (release=%s)', hk_combo, release_key)

def hotkey_watcher(initial_combo: str = 'ctrl+space'):
    try:
        import keyboard
        _hotkey_state['keyboard'] = keyboard
        apply_hotkey(initial_combo)
        keyboard.wait()
    except Exception as e:
        log.error('hotkey error: %s', e)

def mouse_watcher():
    try:
        import pyautogui
        last_x, last_y = pyautogui.position()
        while True:
            x, y = pyautogui.position()
            if abs(x - last_x) > 12 or abs(y - last_y) > 12:
                emit_event('mouse-moved')
                last_x, last_y = x, y
            time.sleep(0.05)
    except Exception:
        pass

def _cmd_execute(args):
    return execute_action(args.get("action", {})) or {}


def _cmd_set_hotkey(args):
    combo = args.get("combo", "ctrl+space")
    apply_hotkey(combo)
    return {"ok": True, "combo": combo}


def _cmd_wake_enable(args):
    phrase = args.get("phrase", "")
    cancel_phrases = args.get("cancel_phrases", [])

    def on_match(kind, matched):
        if kind == 'wake':
            emit_event('wake-detected')
        elif kind == 'cancel':
            emit_event('voice-cancel', {"phrase": matched})

    wake.start(phrase, cancel_phrases, on_match)
    return {"ok": True, "phrase": phrase, "cancel_phrases": cancel_phrases}


def _cmd_wake_disable(args):
    wake.stop()
    return {"ok": True}


def _cmd_dwell_enable(args):
    dwell_ms = args.get("dwell_ms", 1400)
    cooldown_ms = args.get("cooldown_ms", 1500)

    def on_progress(x, y, p, active):
        emit_event('dwell-progress', {"x": x, "y": y, "progress": p, "active": active})

    dwell.start(
        dwell_ms,
        lambda x, y: emit_event('dwell-trigger', {"x": x, "y": y}),
        cooldown_ms=cooldown_ms,
        on_progress=on_progress,
    )
    return {"ok": True, "dwell_ms": dwell_ms, "cooldown_ms": cooldown_ms}


def _cmd_dwell_disable(args):
    dwell.stop()
    return {"ok": True}


def _cmd_dwell_set_ms(args):
    dwell.set_dwell_ms(int(args.get("dwell_ms", 1400)))
    return {"ok": True}


COMMANDS = {
    "ping": lambda args: "pong",
    "screenshot": lambda args: take_screenshot(),
    "active_window": lambda args: get_active_window(),
    "execute": _cmd_execute,
    "set_hotkey": _cmd_set_hotkey,
    "wake_enable": _cmd_wake_enable,
    "wake_disable": _cmd_wake_disable,
    "wake_status": lambda args: wake.status(),
    "dwell_enable": _cmd_dwell_enable,
    "dwell_disable": _cmd_dwell_disable,
    "dwell_set_ms": _cmd_dwell_set_ms,
}


def handle_line(line: str) -> None:
    line = line.strip()
    if not line:
        return
    try:
        msg = json.loads(line)
    except ValueError:
        msg = None
    if not isinstance(msg, dict):
        emit_event("protocol-error", {"line": line[:200]})
        return

    id = msg.get("id", 0)
    cmd = msg.get("cmd")
    args = {k: v for k, v in msg.items() if k not in ("id", "cmd")}
    handler = COMMANDS.get(cmd)
    try:
        if handler is None:
            raise AgentError(E_UNSUPPORTED, f"Unknown command: {cmd}")
        result = handler(args)
    except AgentError as e:
        respond(id, error=e.message)
        return
    except Exception as e:
        log.exception("%s failed", cmd)
        respond(id, error=f"{cmd} failed: {e}" if str(e) else f"{cmd} failed")
        return
    respond(id, result)


def main():
    threading.Thread(target=hotkey_watcher, daemon=True).start()
    threading.Thread(target=mouse_watcher, daemon=True).start()

    for line in sys.stdin:
        handle_line(line)
    proto.close()


if __name__ == "__main__":
    main()
