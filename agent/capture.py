import base64
import io
from PIL import Image
import mss

_MAX_WIDTH = 1280

def grab_jpeg() -> tuple[str, int, int]:
    """Primary-monitor JPEG as (base64, width, height)."""
    with mss.mss() as sct:
        monitor = sct.monitors[1]
        raw = sct.grab(monitor)
        img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")

        if img.width > _MAX_WIDTH:
            new_h = round(img.height * _MAX_WIDTH / img.width)
            img = img.resize((_MAX_WIDTH, new_h), Image.LANCZOS)

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80, optimize=True)
        return base64.b64encode(buf.getvalue()).decode("utf-8"), img.width, img.height


def take_screenshot() -> str:
    return grab_jpeg()[0]


def get_active_window() -> str:
    try:
        import pywinctl as pwc
        win = pwc.getActiveWindow()
        return win.title if win else "Unknown"
    except Exception:
        return "Unknown"
