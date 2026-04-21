import pyautogui
import time
import pytesseract
import hashlib

pyautogui.FAILSAFE = False  # user's mouse movement must not abort automation
pyautogui.PAUSE = 0.05
pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'


def _page_hash() -> str:
    """Fast screenshot hash — sample every 8th row to detect page change."""
    import mss as _mss
    with _mss.mss() as sct:
        mon = sct.monitors[1]
        shot = sct.grab(mon)
        stride = mon['width'] * 4 * 8  # every 8th row
        return hashlib.md5(bytes(shot.bgra[::stride])).hexdigest()


def _ocr_scan() -> dict:
    """Take fresh screenshot and return pytesseract image_to_data dict."""
    from PIL import Image
    import mss as _mss
    with _mss.mss() as sct:
        mon = sct.monitors[1]
        shot = sct.grab(mon)
        img = Image.frombytes('RGB', shot.size, shot.bgra, 'raw', 'BGRX')
    return pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT, config='--psm 11')


def _ocr_norm(s: str) -> str:
    """Normalize common OCR confusables: 0/O, 1/I/l so matching is robust."""
    return s.lower().replace('0', 'o').replace('1', 'l').replace('i', 'l')


def _ocr_matches(data: dict, text: str) -> list:
    """Return all (cx, cy, y1) matches for text phrase in OCR data, sorted top-to-bottom.
    Clusters matches within the same row band so that text appearing in both sender
    column and subject line (e.g. '0xGF' in sender + '[0xGF/...' in subject) counts as ONE row.
    Picks the leftmost-x match per cluster (sender column is leftmost)."""
    target_words = [_ocr_norm(w) for w in text.split()]
    nw = len(target_words)
    words = data['text']
    raw = []
    for i in range(len(words) - nw + 1):
        chunk = [_ocr_norm(words[j].strip()) for j in range(i, i + nw)]
        if all(tw and cw and tw in cw for tw, cw in zip(target_words, chunk)):
            confs = [data['conf'][j] for j in range(i, i + nw)]
            if min(confs) < 30:
                continue
            x1 = min(data['left'][j] for j in range(i, i + nw))
            y1 = min(data['top'][j] for j in range(i, i + nw))
            x2 = max(data['left'][j] + data['width'][j] for j in range(i, i + nw))
            y2 = max(data['top'][j] + data['height'][j] for j in range(i, i + nw))
            raw.append(((x1 + x2) // 2, (y1 + y2) // 2, y1, x1))
    raw.sort(key=lambda m: m[2])  # sort by y1

    # Cluster by first_y anchor (immutable per cluster) — prevents snowball merging.
    # Gmail: sender and subject are side-by-side (same y, ~0-5px diff).
    # Adjacent rows are ~35-55px apart. ROW_BAND=25 collapses same-row dupes safely.
    ROW_BAND = 25
    clusters = []  # each: [first_y, best_match_tuple]
    for m in raw:
        if not clusters or m[2] - clusters[-1][0] > ROW_BAND:
            clusters.append([m[2], m])
        elif m[3] < clusters[-1][1][3]:  # prefer smaller x = sender column
            clusters[-1][1] = m

    return [(c[1][0], c[1][1], c[1][2]) for c in clusters]


def _find_text_ocr(text: str) -> tuple | None:
    """Find first occurrence of text on screen via OCR. Returns (cx, cy) or None."""
    try:
        t0 = time.time()
        data = _ocr_scan()
        matches = _ocr_matches(data, text)
        if matches:
            cx, cy, _ = matches[0]
            print(f"[ocr] found '{text}' at ({cx},{cy}) total={len(matches)} in {time.time()-t0:.2f}s", flush=True)
            return (cx, cy)
        print(f"[ocr] '{text}' not found ({len(data['text'])} words scanned) in {time.time()-t0:.2f}s", flush=True)
        return None
    except Exception as e:
        print(f"[ocr] error finding '{text}': {e}", flush=True)
        return None


def _find_nth_text_ocr(text: str, n: int) -> tuple | None:
    """Find the Nth occurrence (1-indexed, top-to-bottom) of text on screen via OCR."""
    try:
        t0 = time.time()
        data = _ocr_scan()
        matches = _ocr_matches(data, text)
        ys = [m[2] for m in matches]
        print(f"[ocr] '{text}' clusters={len(matches)} ys={ys} need={n} in {time.time()-t0:.2f}s", flush=True)
        if len(matches) >= n:
            cx, cy, _ = matches[n - 1]
            print(f"[ocr] -> occurrence {n} at ({cx},{cy})", flush=True)
            return (cx, cy)
        print(f"[ocr] only {len(matches)} clusters, need {n}", flush=True)
        return None
    except Exception as e:
        print(f"[ocr] error finding nth '{text}': {e}", flush=True)
        return None

def _click_at(x, y, button='left'):
    pyautogui.moveTo(x, y, duration=0.2)
    time.sleep(0.05)
    pyautogui.click(x, y, button=button)

def _center(rect):
    return (
        rect.left + (rect.right - rect.left) // 2,
        rect.top + (rect.bottom - rect.top) // 2
    )

def _find_browser_hwnd():
    import ctypes
    user32 = ctypes.windll.user32
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_size_t, ctypes.c_size_t)
    found = ctypes.c_size_t(0)

    def _cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        buf = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, buf, 512)
        if any(b in buf.value.lower() for b in ('firefox', 'chrome', 'edge', 'brave', 'opera')):
            if found.value == 0:
                found.value = hwnd
        return True

    user32.EnumWindows(WNDENUMPROC(_cb), 0)
    return found.value or None

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
    time.sleep(0.30)

def execute_action(action: dict) -> dict:
    t = action.get("type")
    t0 = time.time()
    print(f"[actions] -> {t}", flush=True)

    if t == "scroll":
        direction = action.get("direction", "down")
        amount = int(action.get("amount", 3))
        x = action.get("x")
        y = action.get("y")
        if direction in ("up", "down"):
            hash_before = _page_hash()
            key = 'pagedown' if direction == 'down' else 'pageup'
            for _ in range(amount):
                pyautogui.press(key)
                time.sleep(0.02)
            time.sleep(0.15)  # let browser render before checking
            hash_after = _page_hash()
            reached = hash_before == hash_after
            print(f"[actions] scroll {direction} {amount} done in {time.time()-t0:.2f}s reached_bottom={reached}", flush=True)
            return {'reached_bottom': reached}
        else:  # left / right — no keyboard equivalent, use hscroll
            if x is None or y is None:
                import ctypes
                hwnd = _find_browser_hwnd()
                if hwnd:
                    rect = ctypes.wintypes.RECT()
                    ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect))
                    x = (rect.left + rect.right) // 2
                    y = (rect.top + rect.bottom) // 2
                else:
                    sw, sh = pyautogui.size()
                    x, y = sw // 2, sh // 2
            pyautogui.moveTo(x, y, duration=0.1)
            clicks = amount if direction == "right" else -amount
            pyautogui.hscroll(clicks, x=x, y=y)
        print(f"[actions] scroll {direction} {amount} done in {time.time()-t0:.2f}s", flush=True)
        return {}

    elif t == "move":
        pyautogui.moveTo(action["x"], action["y"], duration=0.3)

    elif t == "click":
        _click_at(action["x"], action["y"], action.get("button", "left"))
        print(f"[actions] click done in {time.time()-t0:.2f}s", flush=True)

    elif t == "type":
        import pyperclip
        text = action.get("text", "")
        pyperclip.copy(text)
        time.sleep(0.05)
        pyautogui.hotkey('ctrl', 'v')
        print(f"[actions] type done in {time.time()-t0:.2f}s ({len(text)} chars)", flush=True)

    elif t == "hotkey":
        keys = action.get("keys", [])
        if keys:
            pyautogui.hotkey(*keys)
        print(f"[actions] hotkey {keys} done in {time.time()-t0:.2f}s", flush=True)

    elif t == "click_element":
        import uiautomation as auto
        import ctypes
        text = action.get("text", "")
        button = action.get("button", "left")
        bbox = action.get("bbox")  # optional [x1,y1,x2,y2] fallback (screen coords)

        hwnd = ctypes.windll.user32.GetForegroundWindow()
        buf = ctypes.create_unicode_buffer(512)
        ctypes.windll.user32.GetWindowTextW(hwnd, buf, 512)
        win_title = buf.value.lower()
        is_browser = any(b in win_title for b in ('firefox', 'chrome', 'edge', 'brave', 'opera'))

        el = None
        ocr_pos = None
        if is_browser:
            # Browser web content is cross-process — UIA tree traversal hangs.
            # OCR for readable text; bbox center fallback for icons/avatars.
            use_ocr = '...' not in text and len(text) <= 60
            if use_ocr:
                ocr_pos = _find_text_ocr(text)
            else:
                print(f"[actions] skipping OCR for truncated/long text '{text[:40]}...'", flush=True)
            if ocr_pos is None and not bbox:
                print(f"[actions] browser click_element '{text[:40]}': OCR failed, no bbox — cannot click", flush=True)
        else:
            root = auto.ControlFromHandle(hwnd) if hwnd else None
            if root:
                c = auto.Control(searchFromControl=root, searchDepth=15, Name=text)
                if c.Exists(3):
                    el = c
                else:
                    c = auto.Control(searchFromControl=root, searchDepth=15, SubName=text)
                    if c.Exists(2):
                        el = c

            if el is None and not bbox:
                # Only pay the slow desktop fallback cost when we have no bbox to fall back to
                print(f"[actions] scoped search failed for '{text}', trying desktop fallback", flush=True)
                c = auto.Control(searchDepth=20, Name=text)
                if c.Exists(5):
                    el = c

        if ocr_pos is not None:
            print(f"[actions] click_element OCR '{text}' -> {ocr_pos} in {time.time()-t0:.2f}s", flush=True)
            _click_at(ocr_pos[0], ocr_pos[1], button)
        elif el is not None:
            cx, cy = _center(el.BoundingRectangle)
            print(f"[actions] click_element UIA hit '{text}' -> ({cx},{cy}) in {time.time()-t0:.2f}s", flush=True)
            _click_at(cx, cy, button)
        elif bbox:
            cx = (bbox[0] + bbox[2]) // 2
            cy = (bbox[1] + bbox[3]) // 2
            print(f"[actions] click_element bbox raw fallback '{text}' -> ({cx},{cy}) in {time.time()-t0:.2f}s", flush=True)
            _click_at(cx, cy, button)
        else:
            raise ValueError(f"click_element: element '{text}' not found (no bbox provided)")

    elif t == "click_nth_element":
        text = action.get("text", "")
        n = int(action.get("n", 1))
        button = action.get("button", "left")
        pos = _find_nth_text_ocr(text, n)
        if pos:
            print(f"[actions] click_nth_element occurrence {n} of '{text}' -> {pos} in {time.time()-t0:.2f}s", flush=True)
            _click_at(pos[0], pos[1], button)
        else:
            raise ValueError(f"click_nth_element: occurrence {n} of '{text}' not found on screen")

    elif t == "navigate_url":
        url = action.get("url", "")
        hwnd = _find_browser_hwnd()
        if hwnd:
            import ctypes
            buf = ctypes.create_unicode_buffer(512)
            ctypes.windll.user32.GetWindowTextW(hwnd, buf, 512)
            print(f"[actions] navigate_url hwnd={hwnd} title='{buf.value[:60]}' url={url}", flush=True)
            _bring_to_front(hwnd)
            time.sleep(0.2)
            pyautogui.hotkey('ctrl', 'l')
            time.sleep(0.15)
            import pyperclip
            pyperclip.copy(url)
            pyautogui.hotkey('ctrl', 'a')
            pyautogui.hotkey('ctrl', 'v')
            time.sleep(0.1)
            pyautogui.press('enter')
            time.sleep(0.2)
        else:
            print("[actions] navigate_url: no browser found, using os.startfile", flush=True)
            import os
            os.startfile(url)
        print(f"[actions] navigate_url done in {time.time()-t0:.2f}s", flush=True)

    elif t == "focus_browser":
        hwnd = _find_browser_hwnd()
        title = ""
        if hwnd:
            import ctypes
            buf = ctypes.create_unicode_buffer(512)
            ctypes.windll.user32.GetWindowTextW(hwnd, buf, 512)
            title = buf.value[:80]
            print(f"[actions] focus_browser hwnd={hwnd} title='{title}'", flush=True)
            _bring_to_front(hwnd)
        else:
            print("[actions] focus_browser: no browser found", flush=True)
        print(f"[actions] focus_browser done in {time.time()-t0:.2f}s", flush=True)
        return {"done": True, "title": title}

    else:
        raise ValueError(f"Unknown action type: {t}")
