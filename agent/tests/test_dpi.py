import subprocess
import sys

from agent_proc import AGENT_DIR

PROBE = """
import proto, dpi, pyautogui, mss, ctypes, sys
u = ctypes.windll.user32
u.GetThreadDpiAwarenessContext.restype = ctypes.c_void_p
u.GetAwarenessFromDpiAwarenessContext.argtypes = [ctypes.c_void_p]
aw = u.GetAwarenessFromDpiAwarenessContext(u.GetThreadDpiAwarenessContext())
class P(ctypes.Structure):
    _fields_ = [('x', ctypes.c_long), ('y', ctypes.c_long)]
p = P()
u.GetPhysicalCursorPos(ctypes.byref(p))
x, y = pyautogui.position()
sys.stderr.write('AW=%d POS=%d,%d,%d,%d' % (aw, x, y, p.x, p.y) + chr(10))
"""


def test_per_monitor_v2_survives_pyautogui_import():
    out = subprocess.run(
        [sys.executable, "-c", PROBE], cwd=AGENT_DIR, capture_output=True, text=True, timeout=30
    )
    assert out.stdout == ""
    line = next(l for l in out.stderr.splitlines() if l.startswith("AW="))
    aw, pos = line.split(" ")
    assert aw == "AW=2", out.stderr
    x, y, px, py = map(int, pos[4:].split(","))
    assert abs(x - px) <= 2 and abs(y - py) <= 2
