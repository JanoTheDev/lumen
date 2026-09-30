import os
import sys

import pytest

import window


@pytest.mark.parametrize("name,expected", [
    ("msedge.exe", True), ("chrome.exe", True), ("Firefox.exe", True), ("opera_gx.exe", True),
    ("notepad.exe", False), ("explorer.exe", False), ("", False), ("edge.exe", False),
])
def test_browser_by_process(name, expected):
    assert window.is_browser_process(name) is expected


@pytest.fixture
def tk_window():
    tk = pytest.importorskip("tkinter")
    try:
        root = tk.Tk()
    except tk.TclError:
        pytest.skip("no display")
    root.title("Knowledge base – Microsoft Edge")
    root.geometry("320x200+100+100")
    root.update()
    hwnd = int(root.wm_frame(), 16)
    yield hwnd
    root.destroy()


def test_title_mentioning_edge_is_not_a_browser(tk_window):
    info = window.info(tk_window)
    assert "Edge" in info["title"]
    assert info["process"] == os.path.basename(sys.executable).lower()
    assert info["pid"] == os.getpid()
    assert info["isBrowser"] is False
    assert info["rect"]["w"] >= 320 and isinstance(info["monitor"], int)
    assert tk_window != window.find_browser()


def test_active_shape():
    info = window.active()
    assert set(info) == {"hwnd", "title", "process", "exe", "pid", "rect", "monitor", "isBrowser"}
