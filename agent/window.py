"""Top-level window facts via Win32: owning process, class, title, rect."""
import ctypes
import ctypes.wintypes as wt
import os
import sys

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
DWMWA_CLOAKED = 14
GW_OWNER = 4

BROWSERS = {
    "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "opera_gx.exe",
    "vivaldi.exe", "arc.exe", "zen.exe", "librewolf.exe",
}

if sys.platform == "win32":
    _user32 = ctypes.windll.user32
    _kernel32 = ctypes.windll.kernel32
    _user32.GetForegroundWindow.restype = wt.HWND
    _user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
    _user32.GetClassNameW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
    _user32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
    _user32.GetWindowTextLengthW.argtypes = [wt.HWND]
    _user32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
    _user32.IsWindowVisible.argtypes = [wt.HWND]
    _kernel32.OpenProcess.restype = wt.HANDLE
    _kernel32.QueryFullProcessImageNameW.argtypes = [wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)]
    _kernel32.CloseHandle.argtypes = [wt.HANDLE]
    _user32.GetWindow.restype = wt.HWND
    _user32.GetWindow.argtypes = [wt.HWND, ctypes.c_uint]

_ENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def foreground() -> int:
    return _user32.GetForegroundWindow() or 0


def pid_of(hwnd) -> int:
    pid = wt.DWORD(0)
    _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def exe_path(pid: int) -> str:
    if not pid:
        return ""
    h = _kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""
    try:
        size = wt.DWORD(1024)
        buf = ctypes.create_unicode_buffer(size.value)
        if _kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value
        return ""
    finally:
        _kernel32.CloseHandle(h)


def process_name(hwnd) -> str:
    """Lowercased image name ("chrome.exe"), "" when unknown."""
    return os.path.basename(exe_path(pid_of(hwnd))).lower()


def class_name(hwnd) -> str:
    buf = ctypes.create_unicode_buffer(256)
    _user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def title(hwnd) -> str:
    n = _user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(max(n + 1, 2))
    _user32.GetWindowTextW(hwnd, buf, len(buf))
    return buf.value


def rect(hwnd) -> dict:
    r = wt.RECT()
    _user32.GetWindowRect(hwnd, ctypes.byref(r))
    return {"x": r.left, "y": r.top, "w": r.right - r.left, "h": r.bottom - r.top}


def child_windows(hwnd) -> list:
    """All descendant HWNDs."""
    out = []

    def _cb(child, _lp):
        out.append(child)
        return True

    _user32.EnumChildWindows(hwnd, _ENUMPROC(_cb), 0)
    return out


def top_level_windows() -> list:
    """Top-level HWNDs in z-order (front first)."""
    out = []

    def _cb(h, _lp):
        out.append(h)
        return True

    _user32.EnumWindows(_ENUMPROC(_cb), 0)
    return out


def is_browser_process(name: str) -> bool:
    return name.lower() in BROWSERS


def is_cloaked(hwnd) -> bool:
    """True for windows DWM hides (other virtual desktops, suspended UWP frames)."""
    val = ctypes.c_int(0)
    try:
        hr = ctypes.windll.dwmapi.DwmGetWindowAttribute(
            wt.HWND(hwnd), DWMWA_CLOAKED, ctypes.byref(val), ctypes.sizeof(val))
    except (AttributeError, OSError):
        return False
    return hr == 0 and val.value != 0


def is_app_window(hwnd) -> bool:
    """Visible, uncloaked, unowned top-level window with a title."""
    return bool(
        _user32.IsWindowVisible(hwnd)
        and not _user32.GetWindow(hwnd, GW_OWNER)
        and _user32.GetWindowTextLengthW(hwnd) > 0
        and not is_cloaked(hwnd)
    )


def find_browser() -> int | None:
    """Front-most browser window, by process image name."""
    for hwnd in top_level_windows():
        if is_app_window(hwnd) and is_browser_process(process_name(hwnd)):
            return hwnd
    return None


def info(hwnd) -> dict:
    """plans CONTRACTS C2 `active_window` result for one window."""
    import monitors

    pid = pid_of(hwnd)
    exe = exe_path(pid)
    process = os.path.basename(exe).lower()
    return {
        "hwnd": int(hwnd),
        "title": title(hwnd),
        "process": process,
        "exe": exe,
        "pid": pid,
        "rect": rect(hwnd),
        "monitor": monitors.from_window(hwnd)["id"],
        "isBrowser": is_browser_process(process),
    }


def active() -> dict:
    hwnd = foreground()
    if not hwnd:
        return {"hwnd": 0, "title": "", "process": "", "exe": "", "pid": 0,
                "rect": {"x": 0, "y": 0, "w": 0, "h": 0}, "monitor": 0, "isBrowser": False}
    return info(hwnd)
