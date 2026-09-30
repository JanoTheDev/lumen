import logging
import pyautogui
import time
import threading

import pagediff
import safety
import sendinput
import window
from errors import AgentError, E_NOT_FOUND

log = logging.getLogger(__name__)

pyautogui.FAILSAFE = False  # user's mouse movement must not abort automation
pyautogui.PAUSE = 0.05

# Cancel token of the action running on this thread (set by execute_action).
_ctx = threading.local()


def _check() -> None:
    token = getattr(_ctx, 'token', None)
    if token is not None:
        token.check()


def _sleep(seconds: float) -> None:
    token = getattr(_ctx, 'token', None)
    if token is None:
        time.sleep(seconds)
    else:
        token.sleep(seconds)


def _find_element_uia(hwnd, text: str, wait_s: float) -> dict | None:
    """Polls UIA snapshots of the window, then of its process's other visible windows (menus, popups)."""
    import uia
    pid = window.pid_of(hwnd)
    deadline = time.monotonic() + wait_s
    while True:
        _check()
        popups = [h for h in window.top_level_windows()
                  if h != hwnd and window._user32.IsWindowVisible(h) and window.pid_of(h) == pid]
        for h in [hwnd] + popups:
            try:
                hit = uia.find_in_window(h, text, getattr(_ctx, 'token', None))
            except AgentError as e:
                if e.code in ("E_CANCELLED", "E_TIMEOUT"):
                    raise
                hit = None
            if hit:
                return hit
        if time.monotonic() >= deadline:
            return None
        _sleep(0.25)


def _foreground_rect() -> dict | None:
    hwnd = window.foreground()
    r = window.rect(hwnd) if hwnd else None
    return r if r and r["w"] >= 32 and r["h"] >= 32 else None


def _page_frame():
    """Small grayscale frame of the foreground window (whole monitor if there is none)."""
    import capture
    region = _foreground_rect()
    try:
        frame = capture.grab_full(region=region, cache=False)
    except AgentError:
        frame = capture.grab_full(cache=False)
    return pagediff.small_gray(frame["img"])


def _ocr_scan() -> dict:
    """OCR of the foreground monitor: {words, lines, monitor} in physical px."""
    import ocr
    return ocr.run({}, getattr(_ctx, 'token', None))


def _ocr_norm(s: str) -> str:
    """Normalize common OCR confusables: 0/O, 1/I/l so matching is robust."""
    return s.lower().replace('0', 'o').replace('1', 'l').replace('i', 'l')


ROW_BAND_LOGICAL = 30


def _ocr_matches(words: list, text: str, row_band: float = ROW_BAND_LOGICAL) -> list:
    """Return all (cx, cy, y1) matches for text phrase in OCR words, sorted top-to-bottom.
    Clusters matches within the same row band so that text appearing in both sender
    column and subject line (e.g. '0xGF' in sender + '[0xGF/...' in subject) counts as ONE row.
    Picks the leftmost-x match per cluster (sender column is leftmost)."""
    target_words = [_ocr_norm(w) for w in text.split()]
    nw = len(target_words)
    if nw == 0:
        return []
    raw = []
    for i in range(len(words) - nw + 1):
        chunk = [_ocr_norm(words[j]['text'].strip()) for j in range(i, i + nw)]
        # Short words (≤3 chars) require exact match to avoid "OK" matching "BOOK", etc.
        if all(tw and cw and (cw == tw if len(tw) <= 3 else tw in cw) for tw, cw in zip(target_words, chunk)):
            rects = [words[j]['rect'] for j in range(i, i + nw)]
            x1 = min(r['x'] for r in rects)
            y1 = min(r['y'] for r in rects)
            x2 = max(r['x'] + r['w'] for r in rects)
            y2 = max(r['y'] + r['h'] for r in rects)
            raw.append(((x1 + x2) // 2, (y1 + y2) // 2, y1, x1))
    raw.sort(key=lambda m: m[2])  # sort by y1

    # Cluster by first_y anchor (immutable per cluster) — prevents snowball merging.
    # Gmail: sender and subject are side-by-side (same y, ~0-5px diff).
    # Adjacent rows are ~35-55 logical px apart; a 30 logical px band collapses same-row dupes.
    clusters = []  # each: [first_y, best_match_tuple]
    for m in raw:
        if not clusters or m[2] - clusters[-1][0] > row_band:
            clusters.append([m[2], m])
        elif m[3] < clusters[-1][1][3]:  # prefer smaller x = sender column
            clusters[-1][1] = m

    return [(c[1][0], c[1][1], c[1][2]) for c in clusters]


def _scan_matches(text: str) -> tuple:
    t0 = time.time()
    data = _ocr_scan()
    band = ROW_BAND_LOGICAL * data['monitor'].get('scale', 1.0)
    return _ocr_matches(data['words'], text, band), len(data['words']), time.time() - t0


def _find_text_ocr(text: str) -> tuple | None:
    """Find first occurrence of text on screen via OCR. Returns (cx, cy) or None."""
    try:
        matches, n_words, dt = _scan_matches(text)
        if matches:
            cx, cy, _ = matches[0]
            log.info(f"found '{text}' at ({cx},{cy}) total={len(matches)} in {dt:.2f}s")
            return (cx, cy)
        log.info(f"'{text}' not found ({n_words} words scanned) in {dt:.2f}s")
        return None
    except AgentError:
        raise
    except Exception as e:
        log.error(f"error finding '{text}': {e}")
        return None


def _find_nth_text_ocr(text: str, n: int) -> tuple | None:
    """Find the Nth occurrence (1-indexed, top-to-bottom) of text on screen via OCR."""
    try:
        matches, _, dt = _scan_matches(text)
        ys = [m[2] for m in matches]
        log.info(f"'{text}' clusters={len(matches)} ys={ys} need={n} in {dt:.2f}s")
        if len(matches) >= n:
            cx, cy, _ = matches[n - 1]
            log.info(f"-> occurrence {n} at ({cx},{cy})")
            return (cx, cy)
        log.info(f"only {len(matches)} clusters, need {n}")
        return None
    except AgentError:
        raise
    except Exception as e:
        log.error(f"error finding nth '{text}': {e}")
        return None

def _click_at(x, y, button='left'):
    _check()
    pyautogui.moveTo(x, y, duration=0.2)
    _sleep(0.05)
    pyautogui.click(x, y, button=button)

def _find_browser_hwnd():
    return window.find_browser()

def _bring_to_front(hwnd):
    import ctypes
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    fg_thread = user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), None)
    my_thread = kernel32.GetCurrentThreadId()
    user32.AttachThreadInput(fg_thread, my_thread, True)
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.BringWindowToTop(hwnd)
    user32.SetForegroundWindow(hwnd)
    user32.AttachThreadInput(fg_thread, my_thread, False)
    user32.SwitchToThisWindow(hwnd, True)  # undocumented but reliable, no side effects
    _sleep(0.30)

def execute_action(action: dict, token=None) -> dict:
    _ctx.token = token
    try:
        return _execute(action)
    finally:
        _ctx.token = None


def _execute(action: dict) -> dict:
    _check()
    t = action.get("type")
    t0 = time.time()
    log.info(f"-> {t}")

    if t == "scroll":
        direction = action.get("direction", "down")
        amount = int(action.get("amount", 3))
        x = action.get("x")
        y = action.get("y")
        if direction in ("up", "down"):
            frame_before = _page_frame()
            key = 'pagedown' if direction == 'down' else 'pageup'
            for _ in range(amount):
                _check()
                pyautogui.press(key)
                _sleep(0.02)
            _sleep(0.15)  # let browser render before checking
            reached = pagediff.reached_bottom(frame_before, _page_frame())
            log.info(f"scroll {direction} {amount} done in {time.time()-t0:.2f}s reached_bottom={reached}")
            return {'reached_bottom': reached}
        else:  # left / right — no keyboard equivalent, use hscroll
            if x is None or y is None:
                hwnd = _find_browser_hwnd()
                if hwnd:
                    r = window.rect(hwnd)
                    x, y = r["x"] + r["w"] // 2, r["y"] + r["h"] // 2
                else:
                    sw, sh = pyautogui.size()
                    x, y = sw // 2, sh // 2
            pyautogui.moveTo(x, y, duration=0.1)
            clicks = amount if direction == "right" else -amount
            pyautogui.hscroll(clicks, x=x, y=y)
        log.info(f"scroll {direction} {amount} done in {time.time()-t0:.2f}s")
        return {}

    elif t == "move":
        pyautogui.moveTo(action["x"], action["y"], duration=0.3)

    elif t == "click":
        _click_at(action["x"], action["y"], action.get("button", "left"))
        log.info(f"click done in {time.time()-t0:.2f}s")

    elif t == "type":
        safety.check_input_target(action, "type")
        text = str(action.get("text", ""))
        sendinput.type_text(text, check=_check, sleep=_sleep)
        log.info(f"type done in {time.time()-t0:.2f}s ({len(text)} chars)")

    elif t == "hotkey":
        keys = safety.normalize_keys(action.get("keys", []))
        if keys:
            safety.check_combo(keys)
            safety.check_input_target(action, "hotkey")
            pyautogui.hotkey(*keys)
        log.info(f"hotkey {keys} done in {time.time()-t0:.2f}s")

    elif t == "click_element":
        text = action.get("text", "")
        button = action.get("button", "left")
        bbox = action.get("bbox")  # optional [x1,y1,x2,y2] fallback (screen coords)

        hwnd = window.foreground()
        is_browser = bool(hwnd) and window.is_browser_process(window.process_name(hwnd))

        el = None
        ocr_pos = None
        if is_browser:
            # Browser web content is cross-process — UIA tree traversal hangs.
            # OCR for readable text; bbox center fallback for icons/avatars.
            use_ocr = '...' not in text and len(text) <= 60
            if use_ocr:
                ocr_pos = _find_text_ocr(text)
            else:
                log.info(f"skipping OCR for truncated/long text '{text[:40]}...'")
            if ocr_pos is None and not bbox:
                log.info(f"browser click_element '{text[:40]}': OCR failed, no bbox — cannot click")
        elif hwnd:
            # Only wait long for the element when there is no bbox to fall back to.
            el = _find_element_uia(hwnd, text, 3.0 if bbox else 5.0)

        if ocr_pos is not None:
            log.info(f"click_element OCR '{text}' -> {ocr_pos} in {time.time()-t0:.2f}s")
            _click_at(ocr_pos[0], ocr_pos[1], button)
        elif el is not None:
            r = el["rect"]
            cx, cy = r["x"] + r["w"] // 2, r["y"] + r["h"] // 2
            log.info(f"click_element UIA hit '{text}' -> ({cx},{cy}) in {time.time()-t0:.2f}s")
            _click_at(cx, cy, button)
        elif bbox:
            cx = (bbox[0] + bbox[2]) // 2
            cy = (bbox[1] + bbox[3]) // 2
            log.info(f"click_element bbox raw fallback '{text}' -> ({cx},{cy}) in {time.time()-t0:.2f}s")
            _click_at(cx, cy, button)
        else:
            raise ValueError(f"click_element: element '{text}' not found (no bbox provided)")

    elif t == "click_nth_element":
        text = action.get("text", "")
        n = int(action.get("n", 1))
        button = action.get("button", "left")
        pos = _find_nth_text_ocr(text, n)
        if pos:
            log.info(f"click_nth_element occurrence {n} of '{text}' -> {pos} in {time.time()-t0:.2f}s")
            _click_at(pos[0], pos[1], button)
        else:
            raise ValueError(f"click_nth_element: occurrence {n} of '{text}' not found on screen")

    elif t == "navigate_url":
        url = safety.check_url(action.get("url", ""))
        hwnd = _find_browser_hwnd()
        if hwnd:
            log.info(f"navigate_url hwnd={hwnd} title='{window.title(hwnd)[:60]}' url={url}")
            _bring_to_front(hwnd)
            _sleep(0.2)
            pyautogui.hotkey('ctrl', 'l')
            _sleep(0.15)
            pyautogui.hotkey('ctrl', 'a')
            sendinput.type_text(url, check=_check, sleep=_sleep)
            _sleep(0.1)
            pyautogui.press('delete')  # drop any inline autocompletion so Enter opens exactly `url`
            pyautogui.press('enter')
            _sleep(0.2)
        else:
            # Main opens it with the default browser under its own scheme policy.
            raise AgentError(E_NOT_FOUND, "navigate_url: no browser window")
        log.info(f"navigate_url done in {time.time()-t0:.2f}s")

    elif t == "focus_browser":
        hwnd = _find_browser_hwnd()
        title = ""
        if hwnd:
            title = window.title(hwnd)[:80]
            log.info(f"focus_browser hwnd={hwnd} title='{title}'")
            _bring_to_front(hwnd)
        else:
            log.info("focus_browser: no browser found")
        log.info(f"focus_browser done in {time.time()-t0:.2f}s")
        return {"done": True, "title": title}

    else:
        raise ValueError(f"Unknown action type: {t}")
