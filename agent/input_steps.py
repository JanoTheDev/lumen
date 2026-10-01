"""`input {steps}` (plans CONTRACTS C2), mirroring the Rust sidecar's input module.

Steps are validated up front (pure `parse_steps`), then run in order with a
cancel check between them. Coordinates are physical virtual-desktop px.
Scroll `dy > 0` scrolls down (content moves up), `dx > 0` scrolls right, in
wheel notches.
"""
import math
import time

from errors import AgentError, E_INVALID
import safety

MAX_STEPS = 64
MAX_WAIT_MS = 60_000
BUTTONS = ("left", "right", "middle")
WHEEL_DELTA = 120
DRAG_MOVES = 12
DRAG_S = 0.15


def _bad(msg: str):
    return AgentError(E_INVALID, msg)


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _point(o: dict, what: str):
    x, y = o.get("x"), o.get("y")
    if x is None and y is None:
        return None
    if not (_num(x) and _num(y)):
        raise _bad(f"{what} needs both x and y")
    return round(x), round(y)


def _point_value(v, what: str):
    if not isinstance(v, dict):
        raise _bad(f"{what} must be {{x, y}}")
    p = _point(v, what)
    if p is None:
        raise _bad(f"{what} must be {{x, y}}")
    return p


def _button(o: dict) -> str:
    b = o.get("button", "left")
    if b not in BUTTONS:
        raise _bad(f"unknown button {b!r}")
    return b


def parse_steps(args: dict) -> list:
    """Validates every step before anything runs. Returns normalized step dicts."""
    steps = args.get("steps")
    if not isinstance(steps, list):
        raise _bad("steps must be a list")
    if len(steps) > MAX_STEPS:
        raise _bad(f"at most {MAX_STEPS} steps")
    allow_all = args.get("allowTerminal") is True
    out = []
    for i, raw in enumerate(steps):
        if not isinstance(raw, dict):
            raise _bad(f"step {i} must be an object")
        t = raw.get("t")
        allow = allow_all or raw.get("allowTerminal") is True
        if t == "move":
            p = _point(raw, "move")
            if p is None:
                raise _bad("move needs x and y")
            out.append({"t": "move", "at": p})
        elif t == "click":
            count = raw.get("count", 1)
            if count not in (1, 2, 3) or isinstance(count, bool):
                raise _bad("click count must be 1, 2 or 3")
            out.append({"t": "click", "button": _button(raw), "at": _point(raw, "click"), "count": count})
        elif t == "drag":
            out.append({"t": "drag", "from": _point_value(raw.get("from"), "drag.from"),
                        "to": _point_value(raw.get("to"), "drag.to"), "button": _button(raw)})
        elif t == "scroll":
            dx, dy = raw.get("dx", 0), raw.get("dy", 0)
            if not (_num(dx) and _num(dy)) or abs(dx) > 100 or abs(dy) > 100:
                raise _bad("scroll dx/dy must be notches within ±100")
            out.append({"t": "scroll", "dx": dx, "dy": dy, "at": _point(raw, "scroll")})
        elif t == "type":
            text = raw.get("text")
            if not isinstance(text, str):
                raise _bad("type needs text")
            out.append({"t": "type", "text": text, "allowTerminal": allow})
        elif t == "keys":
            combo = raw.get("combo", raw.get("keys"))
            keys = safety.normalize_keys(combo) if isinstance(combo, (str, list)) else []
            if not keys:
                raise _bad("keys needs a combo")
            out.append({"t": "keys", "keys": keys, "allowTerminal": allow})
        elif t == "wait":
            ms = raw.get("ms", 0)
            if not _num(ms) or not 0 <= ms <= MAX_WAIT_MS:
                raise _bad(f"wait ms must be 0..{MAX_WAIT_MS}")
            out.append({"t": "wait", "ms": ms})
        else:
            raise _bad(f"unknown step type {t!r}")
    # Policy checks that need no OS state run before any input is sent.
    for s in out:
        if s["t"] == "keys":
            safety.check_combo(s["keys"])
    return out


class _NoToken:
    def check(self):
        pass

    def sleep(self, s):
        time.sleep(s)


def run_step(step: dict, token, gui=None) -> None:
    import pyautogui
    import sendinput

    g = gui or pyautogui
    token.check()
    t = step["t"]
    if t == "move":
        g.moveTo(*step["at"])
    elif t == "click":
        if step["at"]:
            g.moveTo(*step["at"])
            token.sleep(0.03)
        g.click(clicks=step["count"], interval=0.06, button=step["button"])
    elif t == "drag":
        (fx, fy), (tx, ty) = step["from"], step["to"]
        g.moveTo(fx, fy)
        token.sleep(0.03)
        g.mouseDown(button=step["button"])
        try:
            for i in range(1, DRAG_MOVES + 1):
                token.sleep(DRAG_S / DRAG_MOVES)
                f = i / DRAG_MOVES
                g.moveTo(round(fx + (tx - fx) * f), round(fy + (ty - fy) * f))
        finally:
            # Never leave a button held, even when cancelled mid-drag.
            g.mouseUp(button=step["button"])
    elif t == "scroll":
        x, y = step["at"] or (None, None)
        if step["at"]:
            g.moveTo(x, y)
        if step["dy"]:
            g.scroll(-round(step["dy"] * WHEEL_DELTA), x=x, y=y)
        if step["dx"]:
            g.hscroll(round(step["dx"] * WHEEL_DELTA), x=x, y=y)
    elif t == "type":
        safety.check_input_target(step, "type")
        sendinput.type_text(step["text"], check=token.check, sleep=token.sleep)
    elif t == "keys":
        safety.check_input_target(step, "keys")
        g.hotkey(*step["keys"])
    elif t == "wait":
        token.sleep(step["ms"] / 1000.0)


def run(args: dict, token=None, gui=None) -> dict:
    steps = parse_steps(args)
    tok = token or _NoToken()
    for s in steps:
        run_step(s, tok, gui)
    return {"done": True}
