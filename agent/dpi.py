"""Per-monitor-v2 DPI awareness.

Must be imported before pyautogui or mss: pyautogui makes the process
system-aware on import, after which awareness can no longer be changed.
With per-monitor-v2 every coordinate the agent reads or injects is in
physical virtual-desktop pixels.
"""
import ctypes
import sys

DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
PROCESS_PER_MONITOR_DPI_AWARE = 2

method = "none"
awareness = -1
error = None


def _enable() -> None:
    global method, error
    user32 = ctypes.windll.user32
    try:
        if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)):
            method = "context-v2"
            return
        error = f"SetProcessDpiAwarenessContext failed ({ctypes.GetLastError()})"
    except AttributeError:
        error = "SetProcessDpiAwarenessContext unavailable"
    try:
        hr = ctypes.windll.shcore.SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE)
        if hr == 0:
            method = "shcore"
        else:
            error = f"{error}; SetProcessDpiAwareness hr=0x{hr & 0xFFFFFFFF:08x}"
    except (AttributeError, OSError) as e:
        error = f"{error}; {e}"


def _query() -> int:
    user32 = ctypes.windll.user32
    try:
        user32.GetThreadDpiAwarenessContext.restype = ctypes.c_void_p
        user32.GetAwarenessFromDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        return int(user32.GetAwarenessFromDpiAwarenessContext(user32.GetThreadDpiAwarenessContext()))
    except AttributeError:
        value = ctypes.c_int(-1)
        try:
            ctypes.windll.shcore.GetProcessDpiAwareness(None, ctypes.byref(value))
        except (AttributeError, OSError):
            pass
        return value.value


if sys.platform == "win32":
    _enable()
    awareness = _query()


def describe() -> str:
    text = f"dpi awareness={awareness} via {method}"
    return f"{text} ({error})" if error and method == "none" else text
