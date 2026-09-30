"""Monitor geometry in physical virtual-desktop pixels (per-monitor-v2 process).

`id` is the index in enumeration order sorted by (x, y), so it is stable for a
given layout. `device` (\\\\.\\DISPLAY1) lets main match Electron displays.
"""
import ctypes
import ctypes.wintypes as wt
import sys

MONITOR_DEFAULTTONEAREST = 2
MONITORINFOF_PRIMARY = 1
MDT_EFFECTIVE_DPI = 0


class MONITORINFOEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wt.DWORD),
        ("rcMonitor", wt.RECT),
        ("rcWork", wt.RECT),
        ("dwFlags", wt.DWORD),
        ("szDevice", wt.WCHAR * 32),
    ]


_MONITORENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_int, wt.HMONITOR, wt.HDC, ctypes.POINTER(wt.RECT), wt.LPARAM)

if sys.platform == "win32":
    _user32 = ctypes.windll.user32
    _user32.MonitorFromWindow.restype = wt.HMONITOR
    _user32.MonitorFromWindow.argtypes = [wt.HWND, wt.DWORD]
    _user32.MonitorFromPoint.restype = wt.HMONITOR
    _user32.MonitorFromPoint.argtypes = [wt.POINT, wt.DWORD]
    _user32.GetMonitorInfoW.argtypes = [wt.HMONITOR, ctypes.POINTER(MONITORINFOEXW)]
    _user32.EnumDisplayMonitors.argtypes = [wt.HDC, ctypes.c_void_p, _MONITORENUMPROC, wt.LPARAM]
    _user32.GetForegroundWindow.restype = wt.HWND


def _rect(r: wt.RECT) -> dict:
    return {"x": r.left, "y": r.top, "w": r.right - r.left, "h": r.bottom - r.top}


def _dpi(hmon) -> int:
    x, y = ctypes.c_uint(96), ctypes.c_uint(96)
    try:
        if ctypes.windll.shcore.GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, ctypes.byref(x), ctypes.byref(y)) == 0:
            return int(x.value)
    except (AttributeError, OSError):
        pass
    return 96


def _info(hmon) -> dict:
    mi = MONITORINFOEXW()
    mi.cbSize = ctypes.sizeof(MONITORINFOEXW)
    _user32.GetMonitorInfoW(hmon, ctypes.byref(mi))
    dpi = _dpi(hmon)
    return {
        "device": mi.szDevice,
        "rect": _rect(mi.rcMonitor),
        "workArea": _rect(mi.rcWork),
        "dpi": dpi,
        "scale": round(dpi / 96.0, 4),
        "primary": bool(mi.dwFlags & MONITORINFOF_PRIMARY),
    }


def assign_ids(infos: list) -> list:
    """Sorts by (x, y) and numbers from 0. Pure, for tests."""
    ordered = sorted(infos, key=lambda m: (m["rect"]["x"], m["rect"]["y"]))
    return [{"id": i, **m} for i, m in enumerate(ordered)]


def enumerate_monitors() -> list:
    handles = []

    def _cb(hmon, _hdc, _rect_ptr, _lp):
        handles.append(hmon)
        return 1

    _user32.EnumDisplayMonitors(None, None, _MONITORENUMPROC(_cb), 0)
    return assign_ids([_info(h) for h in handles])


def _match(monitors: list, device: str, rect: dict) -> dict:
    for m in monitors:
        if m["device"] == device and m["rect"] == rect:
            return m
    for m in monitors:
        if m["rect"] == rect:
            return m
    return monitors[0]


def primary(monitors: list | None = None) -> dict:
    monitors = monitors or enumerate_monitors()
    return next((m for m in monitors if m["primary"]), monitors[0])


def from_hmonitor(hmon, monitors: list | None = None) -> dict:
    monitors = monitors or enumerate_monitors()
    info = _info(hmon)
    return _match(monitors, info["device"], info["rect"])


def from_window(hwnd, monitors: list | None = None) -> dict:
    return from_hmonitor(_user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), monitors)


def foreground(monitors: list | None = None) -> dict:
    return from_window(_user32.GetForegroundWindow(), monitors)


def from_point(x: int, y: int, monitors: list | None = None) -> dict:
    return from_hmonitor(_user32.MonitorFromPoint(wt.POINT(int(x), int(y)), MONITOR_DEFAULTTONEAREST), monitors)


def containing(monitors: list, x: float, y: float) -> dict:
    """Monitor whose rect contains the point, else the nearest one. Pure."""
    best, best_d = monitors[0], None
    for m in monitors:
        r = m["rect"]
        dx = max(r["x"] - x, 0, x - (r["x"] + r["w"] - 1))
        dy = max(r["y"] - y, 0, y - (r["y"] + r["h"] - 1))
        d = dx * dx + dy * dy
        if d == 0:
            return m
        if best_d is None or d < best_d:
            best, best_d = m, d
    return best


def to_logical(monitor: dict, x: float, y: float) -> tuple:
    """Physical virtual-desktop px -> logical px relative to the monitor's top-left."""
    s = monitor.get("scale") or 1.0
    return (x - monitor["rect"]["x"]) / s, (y - monitor["rect"]["y"]) / s


def image_to_phys(frame: dict, x: float, y: float) -> tuple:
    """Screenshot px -> physical virtual-desktop px. A frame's `region`, when set, is the captured rect."""
    origin = frame.get("region") or frame["monitor"]["rect"]
    s = frame["scale"]
    return round(origin["x"] + x * s), round(origin["y"] + y * s)
