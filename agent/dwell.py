import time
import threading

_state = {
    'thread': None,
    'stop_event': None,
    'dwell_ms': 1400,
    'cooldown_ms': 1500,
    'on_trigger': None,
}

def _loop(stop_event: threading.Event, on_trigger, on_progress, get_dwell_ms):
    try:
        import pyautogui
    except Exception as e:
        print(f'[dwell] pyautogui missing: {e}', flush=True)
        return

    RADIUS = 6  # px of allowed jitter

    last_x, last_y = pyautogui.position()
    stable_since = time.time()
    last_trigger = 0.0
    last_progress_emit = 0.0
    was_active = False

    while not stop_event.is_set():
        time.sleep(0.04)
        try:
            x, y = pyautogui.position()
        except Exception:
            continue
        now = time.time()
        moved = abs(x - last_x) > RADIUS or abs(y - last_y) > RADIUS
        dwell_ms = get_dwell_ms()
        cooldown = _state['cooldown_ms'] / 1000.0
        in_cooldown = (now - last_trigger) < cooldown

        if moved:
            last_x, last_y = x, y
            stable_since = now
            if was_active:
                try: on_progress(x, y, 0.0, False)
                except Exception: pass
                was_active = False
            continue

        elapsed_ms = (now - stable_since) * 1000
        progress = max(0.0, min(1.0, elapsed_ms / max(1, dwell_ms)))
        if not in_cooldown and progress > 0.02:
            # Emit progress at ~25fps max
            if now - last_progress_emit > 0.04:
                try: on_progress(x, y, progress, True)
                except Exception: pass
                last_progress_emit = now
                was_active = True

        if elapsed_ms >= dwell_ms and not in_cooldown:
            last_trigger = now
            stable_since = now  # require new dwell cycle after trigger
            try: on_progress(x, y, 1.0, False)  # signal ring complete + hide
            except Exception: pass
            was_active = False
            try:
                on_trigger(x, y)
            except Exception as e:
                print(f'[dwell] on_trigger error: {e}', flush=True)
    print('[dwell] stopped', flush=True)

def start(dwell_ms: int, on_trigger, cooldown_ms: int = 1500, on_progress=None):
    stop()
    _state['dwell_ms'] = int(dwell_ms)
    _state['cooldown_ms'] = int(cooldown_ms)
    _state['on_trigger'] = on_trigger
    ev = threading.Event()
    _state['stop_event'] = ev
    noop = lambda *a, **k: None
    t = threading.Thread(
        target=_loop,
        args=(ev, on_trigger, on_progress or noop, lambda: _state['dwell_ms']),
        daemon=True,
    )
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
