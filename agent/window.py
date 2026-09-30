"""Top-level window facts via Win32: owning process, class, title, rect."""
import ctypes
import ctypes.wintypes as wt
import os
import sys

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

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
