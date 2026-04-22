import sys
import json
import threading
import time

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
from capture import take_screenshot, get_active_window
from actions import execute_action
import wake

_print_lock = threading.Lock()

def _write(msg: dict):
    with _print_lock:
        print(json.dumps(msg), flush=True)

def respond(id: int, result=None, error=None):
    msg = {"id": id}
    if error:
        msg["error"] = str(error)
    else:
        msg["result"] = result
    _write(msg)

def emit_event(name: str, data: dict = None):
    msg = {"event": name}
    if data:
        msg.update(data)
    _write(msg)

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
    print(f'[hotkey] bound {hk_combo} (release={release_key})', flush=True)

def hotkey_watcher(initial_combo: str = 'ctrl+space'):
    try:
        import keyboard
        _hotkey_state['keyboard'] = keyboard
        apply_hotkey(initial_combo)
        keyboard.wait()
    except Exception as e:
        print(f'[hotkey] error: {e}', flush=True)

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

def main():
    threading.Thread(target=hotkey_watcher, daemon=True).start()
    threading.Thread(target=mouse_watcher, daemon=True).start()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            id = msg.get("id", 0)
            cmd = msg.get("cmd")

            if cmd == "ping":
                respond(id, "pong")
            elif cmd == "screenshot":
                b64 = take_screenshot()
                respond(id, b64)
            elif cmd == "active_window":
                title = get_active_window()
                respond(id, title)
            elif cmd == "execute":
                action = msg.get("action", {})
                result = execute_action(action)
                respond(id, result or {})
            elif cmd == "set_hotkey":
                combo = msg.get("combo", "ctrl+space")
                try:
                    apply_hotkey(combo)
                    respond(id, {"ok": True, "combo": combo})
                except Exception as e:
                    respond(id, error=f"set_hotkey failed: {e}")
            elif cmd == "wake_enable":
                phrase = msg.get("phrase", "hey lumen")
                try:
                    wake.start(phrase, lambda: emit_event('wake-detected'))
                    respond(id, {"ok": True, "phrase": phrase})
                except Exception as e:
                    respond(id, error=f"wake_enable failed: {e}")
            elif cmd == "wake_disable":
                try:
                    wake.stop()
                    respond(id, {"ok": True})
                except Exception as e:
                    respond(id, error=f"wake_disable failed: {e}")
            elif cmd == "wake_status":
                respond(id, wake.status())
            else:
                respond(id, error=f"Unknown command: {cmd}")
        except Exception as e:
            try:
                respond(msg.get("id", 0), error=str(e))
            except Exception:
                pass

if __name__ == "__main__":
    main()
