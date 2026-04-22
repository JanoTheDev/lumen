import time
import threading

_state = {
    'thread': None,
    'stop_event': None,
    'dwell_ms': 1400,
    'cooldown_ms': 1500,
    'on_trigger': None,
    'rearm_request': False,  # external signal (scroll/key) to re-arm even if cursor still
    'mouse_hook': None,
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
    # After a trigger, cursor MUST move out of RADIUS before another trigger can arm.
    # Prevents repeat-fire when cooldown >= dwell_ms and cursor stays still.
    armed = True

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
            armed = True
            if was_active:
                try: on_progress(x, y, 0.0, False)
                except Exception: pass
                was_active = False
            continue

        # External re-arm signal (scroll wheel, etc.) — reset dwell timer too
        if _state['rearm_request']:
            _state['rearm_request'] = False
            armed = True
            stable_since = now
            if was_active:
                try: on_progress(x, y, 0.0, False)
                except Exception: pass
                was_active = False
            continue

        if not armed:
            continue

        elapsed_ms = (now - stable_since) * 1000
        progress = max(0.0, min(1.0, elapsed_ms / max(1, dwell_ms)))
        if not in_cooldown and progress > 0.02:
            if now - last_progress_emit > 0.04:
                try: on_progress(x, y, progress, True)
                except Exception: pass
                last_progress_emit = now
                was_active = True

        if elapsed_ms >= dwell_ms and not in_cooldown:
            last_trigger = now
            stable_since = now
            armed = False  # require cursor to move before re-arming
            try: on_progress(x, y, 1.0, False)
            except Exception: pass
            was_active = False
            try:
                on_trigger(x, y)
            except Exception as e:
                print(f'[dwell] on_trigger error: {e}', flush=True)
    print('[dwell] stopped', flush=True)

def _install_scroll_rearm():
    if _state.get('mouse_hook') is not None:
        return
    try:
        import mouse
        def _on_event(ev):
            # Wheel events (scroll) re-arm. WheelEvent has a `delta` attribute; MoveEvent
            # and ButtonEvent do not. Explicitly ignore button down/up — programmatic
            # clicks from our own dwell trigger produce those, and re-arming on them
            # causes instant repeat-fire.
            if hasattr(ev, 'delta') or getattr(ev, 'event_type', None) == 'wheel':
                _state['rearm_request'] = True
        mouse.hook(_on_event)
        _state['mouse_hook'] = _on_event
        print('[dwell] mouse hook installed (scroll-only re-arm)', flush=True)
    except Exception as e:
        print(f'[dwell] mouse hook unavailable: {e}', flush=True)

def _uninstall_scroll_rearm():
    handler = _state.get('mouse_hook')
    if handler is None:
        return
    try:
        import mouse
        mouse.unhook(handler)
    except Exception:
        pass
    _state['mouse_hook'] = None

def start(dwell_ms: int, on_trigger, cooldown_ms: int = 1500, on_progress=None):
    stop()
    _state['dwell_ms'] = int(dwell_ms)
    _state['cooldown_ms'] = int(cooldown_ms)
    _state['on_trigger'] = on_trigger
    _install_scroll_rearm()
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
    _uninstall_scroll_rearm()

def set_dwell_ms(dwell_ms: int):
    _state['dwell_ms'] = int(dwell_ms)
