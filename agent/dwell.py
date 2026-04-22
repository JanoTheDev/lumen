import time
import threading

_state = {
    'thread': None,
    'stop_event': None,
    'dwell_ms': 1400,
    'on_trigger': None,
}

def _loop(stop_event: threading.Event, on_trigger, get_dwell_ms):
    try:
        import pyautogui
    except Exception as e:
        print(f'[dwell] pyautogui missing: {e}', flush=True)
        return

    RADIUS = 6  # px of allowed jitter
    COOLDOWN = 1.5  # seconds after a trigger before another can fire

    last_x, last_y = pyautogui.position()
    stable_since = time.time()
    last_trigger = 0.0

    while not stop_event.is_set():
        time.sleep(0.06)
        try:
            x, y = pyautogui.position()
        except Exception:
            continue
        now = time.time()
        moved = abs(x - last_x) > RADIUS or abs(y - last_y) > RADIUS
        if moved:
            last_x, last_y = x, y
            stable_since = now
            continue
        dwell_ms = get_dwell_ms()
        if (now - stable_since) * 1000 >= dwell_ms and (now - last_trigger) > COOLDOWN:
            last_trigger = now
            stable_since = now  # require new dwell cycle after trigger
            try:
                on_trigger(x, y)
            except Exception as e:
                print(f'[dwell] on_trigger error: {e}', flush=True)
    print('[dwell] stopped', flush=True)

def start(dwell_ms: int, on_trigger):
    stop()
    _state['dwell_ms'] = int(dwell_ms)
    _state['on_trigger'] = on_trigger
    ev = threading.Event()
    _state['stop_event'] = ev
    t = threading.Thread(target=_loop, args=(ev, on_trigger, lambda: _state['dwell_ms']), daemon=True)
    _state['thread'] = t
    t.start()
    print(f'[dwell] started with dwell_ms={dwell_ms}', flush=True)

def stop():
    ev = _state['stop_event']
    if ev is not None:
        ev.set()
    _state['thread'] = None
    _state['stop_event'] = None

def set_dwell_ms(dwell_ms: int):
    _state['dwell_ms'] = int(dwell_ms)
