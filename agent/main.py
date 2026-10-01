import proto  # must be first: claims stdout for the protocol
import dpi  # before pyautogui/mss, which would lock in system DPI awareness

import argparse
import sys
import json
import logging
import threading
import time

# comtypes joins this apartment on import; the dispatch
# workers are MTA too, so COM objects can move between them.
sys.coinit_flags = 0

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
log = logging.getLogger("agent")
log.info(dpi.describe())

import a11y_state
import announce
import capture
import monitors
import ocr
import uia
import window
from capture import take_screenshot, get_active_window
from actions import execute_action
import wake
import dwell
import input_steps
from mousewatch import MouseWatcher
from dispatch import Dispatcher, INLINE, INPUT, READ
from errors import AgentError, E_INVALID, E_UNSUPPORTED
from hotkey import HotkeyManager, parse_accelerator

respond = proto.respond
emit_event = proto.emit

hotkeys = HotkeyManager(emit_event)
dictation_hotkeys = HotkeyManager(emit_event, down_event="dictation-down", up_event="dictation-up")


mouse_watch = MouseWatcher(emit_event)
SUBSCRIBABLE = {"mouse-moved": mouse_watch.set_enabled}
_subscriptions: set = set()


def _set_subscription(event: str, enabled: bool) -> None:
    SUBSCRIBABLE[event](enabled)
    (_subscriptions.add if enabled else _subscriptions.discard)(event)


def _check_events(events) -> list:
    if not isinstance(events, list) or not all(isinstance(e, str) for e in events):
        raise AgentError(E_INVALID, "events must be a list of event names")
    unknown = [e for e in events if e not in SUBSCRIBABLE]
    if unknown:
        raise AgentError(E_UNSUPPORTED, f"cannot subscribe to {', '.join(unknown)}")
    return events


def _cmd_subscribe(args, token):
    events = _check_events(args.get("events", []))
    enabled = args.get("enabled", True)
    if not isinstance(enabled, bool):
        raise AgentError(E_INVALID, "enabled must be a boolean")
    for e in events:
        _set_subscription(e, enabled)
    return {"subscribed": sorted(_subscriptions)}


AGENT_VERSION = "0.2.0"
# Capabilities whose v2 commands match plans CONTRACTS C2; more are added as they land.
CAPABILITIES = ["hotkey", "dictation-hotkey", "wake", "dwell", "capture", "ocr", "uia", "announce", "input",
                "a11y-state"]

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


def _same_combo(a: str, b: str) -> bool:
    if not a.strip() or not b.strip():
        return False
    return parse_accelerator(a).combo == parse_accelerator(b).combo


def _cmd_set_dictation_hotkey(args, token):
    combo = args.get("combo")
    if not isinstance(combo, str):
        raise AgentError(E_INVALID, "set_dictation_hotkey needs a combo string")
    if _same_combo(combo, hotkeys.accelerator):
        raise AgentError(E_INVALID, "dictation hotkey must differ from the assistant hotkey")
    dictation_hotkeys.bind(combo)
    return {"ok": True, "combo": combo}


def _on_listener_match(kind, matched):
    if kind == 'wake':
        emit_event('wake-detected', {"phrase": matched} if proto.version == 2 else None)
    elif kind == 'cancel':
        emit_event('voice-cancel', {"phrase": matched})


def _on_wake_error(data):
    emit_event('wake-error', data)


def _start_wake(phrase, cancel_phrases, energy_floor=None):
    wake.start(phrase, cancel_phrases, _on_listener_match, on_error=_on_wake_error, energy_floor=energy_floor)


def _cmd_wake_enable(args, token):
    phrase = args.get("phrase", "")
    cancel_phrases = args.get("cancel_phrases", args.get("cancelPhrases", []))
    _start_wake(phrase, cancel_phrases, args.get("energyFloor"))
    return {"ok": True, "phrase": phrase, "cancel_phrases": cancel_phrases}


def _cmd_wake_arm_cancel(args, token):
    armed = args.get("armed")
    if not isinstance(armed, bool):
        raise AgentError(E_INVALID, "wake_arm_cancel needs armed: bool")
    wake.set_cancel_armed(armed)
    return {"armed": armed}


def _cmd_wake_disable(args, token):
    wake.stop()
    return {"ok": True}


def _dwell_busy() -> bool:
    # Agent-injected input must never be followed by a dwell click at the same spot.
    return dispatcher.lane_busy(INPUT, dwell.AUTO_PAUSE_GRACE_S)


dwell_ctl = dwell.Dwell(
    on_progress=lambda data: emit_event('dwell-progress', data),
    on_trigger=lambda data: emit_event('dwell-trigger', data),
    busy=_dwell_busy,
)


def _cmd_dwell_enable(args, token):
    c = dwell_ctl.configure({**args, "enabled": True})
    return {"ok": True, "dwell_ms": c["ms"], "cooldown_ms": c["cooldownMs"]}


def _cmd_dwell_disable(args, token):
    dwell_ctl.stop()
    return {"ok": True}


def _cmd_dwell_set_ms(args, token):
    dwell_ctl.set_ms(int(args.get("dwell_ms", args.get("ms", 1400))))
    return {"ok": True}


def _cmd_dwell_config(args, token):
    return dwell_ctl.configure(args)


def _cmd_dwell_pause(args, token):
    dwell_ctl.pause()
    return {"paused": True}


def _cmd_dwell_resume(args, token):
    dwell_ctl.resume()
    return {"paused": False}


def _cmd_cancel(args, token):
    target = args.get("target")
    if not isinstance(target, int) or isinstance(target, bool):
        raise AgentError(E_INVALID, "cancel needs a numeric target")
    return {"cancelled": dispatcher.cancel(target)}


def _obj(v) -> dict:
    return v if isinstance(v, dict) else {}


def _cmd_init(args, token):
    """Applies the full agent state. Everything is validated before anything changes."""
    hotkey_accel = args.get("hotkey", "")
    if not isinstance(hotkey_accel, str):
        raise AgentError(E_INVALID, "init.hotkey must be a string")
    if hotkey_accel.strip():
        parse_accelerator(hotkey_accel)
    dictation_accel = args.get("dictationHotkey", "")
    if not isinstance(dictation_accel, str):
        raise AgentError(E_INVALID, "init.dictationHotkey must be a string")
    if dictation_accel.strip():
        parse_accelerator(dictation_accel)
    if _same_combo(dictation_accel, hotkey_accel):
        log.warning("dictation hotkey %r equals the assistant hotkey; not bound", dictation_accel)
        dictation_accel = ""
    level = args.get("logLevel", "info")
    if level not in LOG_LEVELS:
        raise AgentError(E_INVALID, f"init.logLevel must be one of {sorted(LOG_LEVELS)}")
    subscriptions = _check_events(args.get("subscriptions", []))
    wake_cfg, dwell_cfg = _obj(args.get("wake")), _obj(args.get("dwell"))
    phrase = wake_cfg.get("phrase") if isinstance(wake_cfg.get("phrase"), str) else ""
    cancel_phrases = [p for p in wake_cfg.get("cancelPhrases") or [] if isinstance(p, str) and p.strip()]
    wake_phrase = phrase.strip() if wake_cfg.get("enabled") is True else ""

    logging.getLogger().setLevel(LOG_LEVELS[level])
    hotkeys.bind(hotkey_accel)
    dictation_hotkeys.bind(dictation_accel)
    if wake_phrase or cancel_phrases:
        _start_wake(wake_phrase, cancel_phrases, wake_cfg.get("energyFloor"))
    else:
        wake.stop()
    dwell_ctl.configure({**dwell_cfg, "enabled": dwell_cfg.get("enabled") is True})
    for event in SUBSCRIBABLE:
        _set_subscription(event, event in subscriptions)
    return {}


def _cmd_capture(args, token):
    return capture.capture(**{k: v for k, v in args.items() if k in ("monitor", "maxWidth", "quality", "region")})


def _cmd_active_window(args, token):
    info = window.active()
    uia.warm_up(info["hwnd"])
    return info


def _cmd_uia_snapshot(args, token):
    max_nodes = args.get("maxNodes", uia.DEFAULT_MAX_NODES)
    if not isinstance(max_nodes, int) or isinstance(max_nodes, bool) or max_nodes < 1:
        raise AgentError(E_INVALID, "maxNodes must be a positive integer")
    return uia.snapshot(args.get("scope", "foreground"), max_nodes, args.get("interactiveOnly", True) is not False,
                        token)


def _cmd_uia_act(args, token):
    import actions
    import sendinput

    def click(x, y):
        actions.execute_action({"type": "click", "x": x, "y": y}, token)

    def type_text(text):
        actions.execute_action({"type": "hotkey", "keys": ["ctrl", "a"], "allowTerminal": args.get("allowTerminal")},
                               token)
        sendinput.type_text(text, check=token.check, sleep=token.sleep)

    return uia.act(args, token, click=click, type_text=type_text)


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
    reg("subscribe", _cmd_subscribe, INLINE)
    reg("set_hotkey", _cmd_set_hotkey, INLINE)
    reg("set_dictation_hotkey", _cmd_set_dictation_hotkey, INLINE)
    reg("wake_enable", _cmd_wake_enable, INLINE)
    reg("wake_disable", _cmd_wake_disable, INLINE)
    reg("wake_status", lambda args, token: wake.status(), INLINE)
    reg("wake_arm_cancel", _cmd_wake_arm_cancel, INLINE)
    reg("dwell_enable", _cmd_dwell_enable, INLINE)
    reg("dwell_disable", _cmd_dwell_disable, INLINE)
    reg("dwell_set_ms", _cmd_dwell_set_ms, INLINE)
    reg("dwell_config", _cmd_dwell_config, INLINE)
    reg("dwell_pause", _cmd_dwell_pause, INLINE)
    reg("dwell_resume", _cmd_dwell_resume, INLINE)
    reg("execute", _cmd_execute, INPUT)
    reg("screenshot", lambda args, token: take_screenshot(), READ)
    reg("capture", _cmd_capture, READ)
    reg("marks_render", lambda args, token: capture.render_marks(**args), READ)
    reg("monitors", lambda args, token: {"monitors": monitors.enumerate_monitors()}, READ)
    reg("ocr", lambda args, token: ocr.run(args, token), READ)
    reg("uia_snapshot", _cmd_uia_snapshot, READ, timeout_ms=uia.SNAPSHOT_TIMEOUT_MS)
    reg("uia_find", lambda args, token: uia.find_command(args, token), READ, timeout_ms=uia.SNAPSHOT_TIMEOUT_MS)
    reg("uia_act", _cmd_uia_act, INPUT)
    reg("focus_info", lambda args, token: uia.focus_info(token), READ, timeout_ms=1000)
    reg("announce", announce.announce, READ)
    reg("a11y_state", a11y_state.state, READ, timeout_ms=2000)
    reg("input", lambda args, token: input_steps.run(args, token), INPUT)
    if v2:
        reg("active_window", _cmd_active_window, READ)
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
    # v1 main never arms voice cancel, so it stays live as before; v2 main arms it per action.
    wake.set_cancel_armed(proto.version != 2)
    register_commands(debug=opts.debug)
    if proto.version == 2:
        proto.ready({"impl": "python", "version": AGENT_VERSION, "capabilities": CAPABILITIES})
    if opts.hotkey:
        try:
            hotkeys.bind(opts.hotkey)
        except AgentError as e:
            log.error("--hotkey %r rejected: %s", opts.hotkey, e.message)
    if proto.version == 1:
        _set_subscription("mouse-moved", True)  # v1 main expects it unconditionally

    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    for line in sys.stdin:
        handle_line(line)
    dispatcher.shutdown(wait=True)
    proto.close()


if __name__ == "__main__":
    main()
