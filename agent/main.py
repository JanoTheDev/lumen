import proto  # must be first: claims stdout for the protocol
import dpi  # before pyautogui/mss, which would lock in system DPI awareness

import argparse
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
from errors import AgentError, E_INVALID, E_UNSUPPORTED
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

def _cmd_execute(args):
    return execute_action(args.get("action", {})) or {}


def _cmd_set_hotkey(args):
    combo = args.get("combo")
    if not isinstance(combo, str):
        raise AgentError(E_INVALID, "set_hotkey needs a combo string")
    hotkeys.bind(combo)
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


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Lumen OS agent")
    parser.add_argument("--hotkey", default="", help="Electron accelerator to bind at startup")
    return parser.parse_args(argv)


def main():
    opts = parse_args()
    if opts.hotkey:
        try:
            hotkeys.bind(opts.hotkey)
        except AgentError as e:
            log.error("--hotkey %r rejected: %s", opts.hotkey, e.message)
    threading.Thread(target=mouse_watcher, daemon=True).start()

    for line in sys.stdin:
        handle_line(line)
    proto.close()


if __name__ == "__main__":
    main()
