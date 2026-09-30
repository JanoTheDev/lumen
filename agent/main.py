import proto  # must be first: claims stdout for the protocol
import dpi  # before pyautogui/mss, which would lock in system DPI awareness

import argparse
import sys
import json
import logging
import threading
import time

# comtypes (via uiautomation) joins this apartment on import; the dispatch
# workers are MTA too, so COM objects can move between them.
sys.coinit_flags = 0

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
from dispatch import Dispatcher, INLINE, INPUT, READ
from errors import AgentError, E_INVALID
from hotkey import HotkeyManager

respond = proto.respond
emit_event = proto.emit

hotkeys = HotkeyManager(emit_event)


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


def _reply(id, result, error):
    if error is not None:
        respond(id, error=error.message)
    else:
        respond(id, result)


dispatcher = Dispatcher(_reply)


def _cmd_execute(args, token):
    return execute_action(args.get("action", {}), token) or {}


def _cmd_set_hotkey(args, token):
    combo = args.get("combo")
    if not isinstance(combo, str):
        raise AgentError(E_INVALID, "set_hotkey needs a combo string")
    hotkeys.bind(combo)
    return {"ok": True, "combo": combo}


def _cmd_wake_enable(args, token):
    phrase = args.get("phrase", "")
    cancel_phrases = args.get("cancel_phrases", [])

    def on_match(kind, matched):
        if kind == 'wake':
            emit_event('wake-detected')
        elif kind == 'cancel':
            emit_event('voice-cancel', {"phrase": matched})

    wake.start(phrase, cancel_phrases, on_match)
    return {"ok": True, "phrase": phrase, "cancel_phrases": cancel_phrases}


def _cmd_wake_disable(args, token):
    wake.stop()
    return {"ok": True}


def _cmd_dwell_enable(args, token):
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


def _cmd_dwell_disable(args, token):
    dwell.stop()
    return {"ok": True}


def _cmd_dwell_set_ms(args, token):
    dwell.set_dwell_ms(int(args.get("dwell_ms", 1400)))
    return {"ok": True}


def _cmd_cancel(args, token):
    target = args.get("target")
    if not isinstance(target, int) or isinstance(target, bool):
        raise AgentError(E_INVALID, "cancel needs a numeric target")
    return {"cancelled": dispatcher.cancel(target)}


def _debug_emit(args, token):
    n = max(0, min(int(args.get("n", 100)), 100000))

    def flood():
        for i in range(n):
            emit_event("debug", {"seq": i})
            if i % 10 == 0:
                sys.stdout.write(f"stray write {i}\n")
                log.info("debug log %d", i)

    threading.Thread(target=flood, name="debug-emit", daemon=True).start()
    return {"n": n}


def _debug_sleep(args, token):
    token.sleep(float(args.get("ms", 1000)) / 1000.0)
    return {"slept": True}


def register_commands(debug: bool = False) -> None:
    reg = dispatcher.register
    reg("ping", lambda args, token: "pong", INLINE)
    reg("cancel", _cmd_cancel, INLINE)
    reg("set_hotkey", _cmd_set_hotkey, INLINE)
    reg("wake_enable", _cmd_wake_enable, INLINE)
    reg("wake_disable", _cmd_wake_disable, INLINE)
    reg("wake_status", lambda args, token: wake.status(), INLINE)
    reg("dwell_enable", _cmd_dwell_enable, INLINE)
    reg("dwell_disable", _cmd_dwell_disable, INLINE)
    reg("dwell_set_ms", _cmd_dwell_set_ms, INLINE)
    reg("execute", _cmd_execute, INPUT)
    reg("screenshot", lambda args, token: take_screenshot(), READ)
    reg("active_window", lambda args, token: get_active_window(), READ)
    if debug:
        reg("debug_emit", _debug_emit, INLINE)
        reg("debug_sleep", _debug_sleep, READ)
        reg("debug_sleep_input", _debug_sleep, INPUT)


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

    args = {k: v for k, v in msg.items() if k not in ("id", "cmd")}
    dispatcher.dispatch(msg.get("id", 0), msg.get("cmd"), args)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Lumen OS agent")
    parser.add_argument("--hotkey", default="", help="Electron accelerator to bind at startup")
    parser.add_argument("--debug", action="store_true", help="enable debug_* test commands")
    return parser.parse_args(argv)


def main():
    opts = parse_args()
    register_commands(debug=opts.debug)
    if opts.hotkey:
        try:
            hotkeys.bind(opts.hotkey)
        except AgentError as e:
            log.error("--hotkey %r rejected: %s", opts.hotkey, e.message)
    threading.Thread(target=mouse_watcher, daemon=True).start()

    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    for line in sys.stdin:
        handle_line(line)
    dispatcher.shutdown(wait=True)
    proto.close()


if __name__ == "__main__":
    main()
