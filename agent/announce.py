"""`announce {text, priority}`: speak through NVDA when it runs.

Uses NV Access's controller client DLL (LGPL-2.1, shipped unmodified under
agent/vendor/nvda/ with its license and loaded dynamically). Without NVDA,
without the DLL, or on a locked/secure desktop it returns {spoken: false} so
main can fall back (aria-live / TTS). Narrator and others come with the Rust
sidecar's UIA notifications (B11).
"""
import ctypes
import logging
import os
import platform
import threading

from errors import AgentError, E_INVALID

log = logging.getLogger(__name__)

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_TEXT = 2000
UOI_NAME = 2

_lock = threading.Lock()
_lib = {"dll": None, "tried": False, "path": None}


def _arch() -> str:
    m = platform.machine().lower()
    if m in ("arm64", "aarch64"):
        return "arm64"
    return "x64" if ctypes.sizeof(ctypes.c_void_p) == 8 else "x86"


def dll_candidates(base: str = HERE) -> list:
    arch = _arch()
    return [
        os.path.join(base, "vendor", "nvda", arch, "nvdaControllerClient.dll"),
        os.path.join(base, "vendor", "nvdaControllerClient64.dll" if arch == "x64" else "nvdaControllerClient32.dll"),
    ]


def _load():
    with _lock:
        if _lib["tried"]:
            return _lib["dll"]
        _lib["tried"] = True
        for path in dll_candidates():
            if not os.path.isfile(path):
                continue
            try:
                dll = ctypes.WinDLL(path)
                for name in ("nvdaController_testIfRunning", "nvdaController_cancelSpeech"):
                    getattr(dll, name).restype = ctypes.c_ulong
                    getattr(dll, name).argtypes = []
                dll.nvdaController_speakText.restype = ctypes.c_ulong
                dll.nvdaController_speakText.argtypes = [ctypes.c_wchar_p]
                _lib["dll"], _lib["path"] = dll, path
                log.info("nvda controller loaded from %s", path)
                break
            except (OSError, AttributeError) as e:
                log.warning("cannot load %s: %s", path, e)
        return _lib["dll"]


def input_desktop_is_default() -> bool:
    """False on the lock screen / UAC secure desktop, where speaking could leak content."""
    user32 = ctypes.windll.user32
    user32.OpenInputDesktop.restype = ctypes.c_void_p
    user32.GetUserObjectInformationW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p,
                                                 ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong)]
    user32.CloseDesktop.argtypes = [ctypes.c_void_p]
    h = user32.OpenInputDesktop(0, False, 0)
    if not h:
        return False
    try:
        buf = ctypes.create_unicode_buffer(256)
        needed = ctypes.c_ulong(0)
        if not user32.GetUserObjectInformationW(h, UOI_NAME, buf, ctypes.sizeof(buf), ctypes.byref(needed)):
            return False
        return buf.value.lower() == "default"
    finally:
        user32.CloseDesktop(h)


def announce(args: dict, token=None) -> dict:
    text = args.get("text")
    priority = args.get("priority", "polite")
    if not isinstance(text, str) or not text.strip():
        raise AgentError(E_INVALID, "announce needs non-empty text")
    if priority not in ("polite", "assertive"):
        raise AgentError(E_INVALID, 'priority must be "polite" or "assertive"')
    dll = _load()
    if dll is None:
        return {"spoken": False, "reason": "no-controller"}
    if dll.nvdaController_testIfRunning() != 0:
        return {"spoken": False, "reason": "nvda-not-running"}
    if not input_desktop_is_default():
        return {"spoken": False, "reason": "secure-desktop"}
    if priority == "assertive":
        dll.nvdaController_cancelSpeech()
    rc = dll.nvdaController_speakText(text[:MAX_TEXT])
    if rc != 0:
        return {"spoken": False, "reason": f"nvda-error-{rc}"}
    return {"spoken": True, "via": "nvda"}
