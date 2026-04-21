import sys
import json
import threading
import time

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
from capture import take_screenshot, get_active_window
from actions import execute_action

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

def hotkey_watcher():
    try:
        import keyboard
        combo_active = False

        def on_press():
            nonlocal combo_active
            if not combo_active:
                combo_active = True
                emit_event('hotkey-down')

        def on_space_event(event):
            nonlocal combo_active
            if event.event_type == 'up' and combo_active:
                combo_active = False
                emit_event('hotkey-up')

        # add_hotkey with suppress=True blocks ONLY ctrl+space — regular typing unaffected
        keyboard.add_hotkey('ctrl+space', on_press, suppress=True)
        # hook_key (non-suppressive) detects space release to end recording
        keyboard.hook_key('space', on_space_event)
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
            else:
                respond(id, error=f"Unknown command: {cmd}")
        except Exception as e:
            try:
                respond(msg.get("id", 0), error=str(e))
            except Exception:
                pass

if __name__ == "__main__":
    main()
