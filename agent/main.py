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

import capture
import monitors
from capture import take_screenshot, get_active_window
from actions import execute_action
import wake
import dwell
from dispatch import Dispatcher, INLINE, INPUT, READ
from errors import AgentError, E_INVALID
from hotkey import HotkeyManager, parse_accelerator

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


AGENT_VERSION = "0.2.0"
# Capabilities whose v2 commands match plans CONTRACTS C2; more are added as they land.
CAPABILITIES = ["hotkey", "wake", "dwell", "capture"]

LOG_LEVELS = {"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING, "error": logging.ERROR}

dispatcher = Dispatcher(respond)


def _cmd_execute(args, token):
    return execute_action(args.get("action", {}), token) or {}


def _cmd_set_hotkey(args, token):
    combo = args.get("combo")
    if not isinstance(combo, str):
        raise AgentError(E_INVALID, "set_hotkey needs a combo string")
    hotkeys.bind(combo)
    return {"ok": True, "combo": combo}


def _on_listener_match(kind, matched):
    if kind == 'wake':
        emit_event('wake-detected', {"phrase": matched} if proto.version == 2 else None)
    elif kind == 'cancel':
        emit_event('voice-cancel', {"phrase": matched})


def _cmd_wake_enable(args, token):
    phrase = args.get("phrase", "")
    cancel_phrases = args.get("cancel_phrases", args.get("cancelPhrases", []))
    wake.start(phrase, cancel_phrases, _on_listener_match)
    return {"ok": True, "phrase": phrase, "cancel_phrases": cancel_phrases}


def _cmd_wake_disable(args, token):
    wake.stop()
    return {"ok": True}


def _start_dwell(dwell_ms, cooldown_ms):
    def on_progress(x, y, p, active):
        emit_event('dwell-progress', {"x": x, "y": y, "progress": p, "active": active})

    dwell.start(
        dwell_ms,
        lambda x, y: emit_event('dwell-trigger', {"x": x, "y": y}),
        cooldown_ms=cooldown_ms,
        on_progress=on_progress,
    )


def _cmd_dwell_enable(args, token):
    dwell_ms = args.get("dwell_ms", args.get("ms", 1400))
    cooldown_ms = args.get("cooldown_ms", args.get("cooldownMs", 1500))
    _start_dwell(dwell_ms, cooldown_ms)
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


def _obj(v) -> dict:
    return v if isinstance(v, dict) else {}


def _num(v, fallback):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else fallback


def _cmd_init(args, token):
    """Applies the full agent state. Everything is validated before anything changes."""
    hotkey_accel = args.get("hotkey", "")
    if not isinstance(hotkey_accel, str):
        raise AgentError(E_INVALID, "init.hotkey must be a string")
    if hotkey_accel.strip():
        parse_accelerator(hotkey_accel)
    level = args.get("logLevel", "info")
    if level not in LOG_LEVELS:
        raise AgentError(E_INVALID, f"init.logLevel must be one of {sorted(LOG_LEVELS)}")
    wake_cfg, dwell_cfg = _obj(args.get("wake")), _obj(args.get("dwell"))
    phrase = wake_cfg.get("phrase") if isinstance(wake_cfg.get("phrase"), str) else ""
    cancel_phrases = [p for p in wake_cfg.get("cancelPhrases") or [] if isinstance(p, str) and p.strip()]
    wake_phrase = phrase.strip() if wake_cfg.get("enabled") is True else ""

    logging.getLogger().setLevel(LOG_LEVELS[level])
    hotkeys.bind(hotkey_accel)
    if wake_phrase or cancel_phrases:
        wake.start(wake_phrase, cancel_phrases, _on_listener_match)
    else:
        wake.stop()
    if dwell_cfg.get("enabled") is True:
        _start_dwell(_num(dwell_cfg.get("ms"), 1400), _num(dwell_cfg.get("cooldownMs"), 1500))
    else:
        dwell.stop()
    return {}


def _cmd_capture(args, token):
    return capture.capture(**{k: v for k, v in args.items() if k in ("monitor", "maxWidth", "quality", "region")})


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
    v2 = proto.version == 2
    reg("ping", (lambda args, token: {"t": time.time()}) if v2 else (lambda args, token: "pong"), INLINE)
    reg("init", _cmd_init, INLINE)
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
    reg("capture", _cmd_capture, READ)
    reg("monitors", lambda args, token: {"monitors": monitors.enumerate_monitors()}, READ)
    if v2:
        reg("active_window", lambda args, token: {"title": get_active_window()}, READ)
    else:
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

    if msg.get("v") == 2:
        args = _obj(msg.get("args"))
    else:
        args = {k: v for k, v in msg.items() if k not in ("id", "cmd")}
    dispatcher.dispatch(msg.get("id", 0), msg.get("cmd"), args)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Lumen OS agent")
    parser.add_argument("--hotkey", default="", help="Electron accelerator to bind at startup")
    parser.add_argument("--protocol", type=int, choices=(1, 2), default=1, help="wire protocol version")
    parser.add_argument("--debug", action="store_true", help="enable debug_* test commands")
    return parser.parse_args(argv)


def main():
    opts = parse_args()
    proto.set_version(opts.protocol)
    register_commands(debug=opts.debug)
    if proto.version == 2:
        proto.ready({"impl": "python", "version": AGENT_VERSION, "capabilities": CAPABILITIES})
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
