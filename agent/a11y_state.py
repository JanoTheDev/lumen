"""`a11y_state`: which assistive tech is running.

screenReader: "nvda" | "jaws" | "narrator" | "other" | null. Detected from the
running processes, then SPI_GETSCREENREADER (set by any screen reader) as the
"other" fallback. voiceControl lists Voice Access / Dragon, which would also
handle commands like "click 5" (06 T20 coexistence).
"""
import ctypes
import ctypes.wintypes as wt
import os

SPI_GETSCREENREADER = 0x0046
TH32CS_SNAPPROCESS = 0x00000002

SCREEN_READERS = (("nvda", ("nvda.exe",)), ("jaws", ("jfw.exe",)), ("narrator", ("narrator.exe",)))
VOICE_CONTROL = (("voice-access", ("voiceaccess.exe",)), ("dragon", ("natspeak.exe", "dragonbar.exe")))


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wt.DWORD),
                ("cntThreads", wt.DWORD), ("th32ParentProcessID", wt.DWORD),
                ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD), ("szExeFile", wt.WCHAR * 260)]


def process_names() -> set:
    k32 = ctypes.windll.kernel32
    k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    names = set()
    if not snap or snap == wt.HANDLE(-1).value:
        return names
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = k32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            names.add(os.path.basename(entry.szExeFile).lower())
            ok = k32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snap)
    return names


def spi_screen_reader() -> bool:
    flag = wt.BOOL(False)
    if not ctypes.windll.user32.SystemParametersInfoW(SPI_GETSCREENREADER, 0, ctypes.byref(flag), 0):
        return False
    return bool(flag.value)


def classify(names: set, spi_flag: bool) -> dict:
    """Pure: process names (lowercase) + the SPI flag -> the a11y_state result."""
    reader = next((rid for rid, exes in SCREEN_READERS if names & set(exes)), None)
    if reader is None and spi_flag:
        reader = "other"
    voice = [vid for vid, exes in VOICE_CONTROL if names & set(exes)]
    return {"screenReader": reader, "voiceControl": voice}


def state(args=None, token=None) -> dict:
    try:
        names = process_names()
    except OSError:
        names = set()
    try:
        flag = spi_screen_reader()
    except OSError:
        flag = False
    return classify(names, flag)
