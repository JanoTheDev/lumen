import os

import pytest

import announce
from errors import AgentError


def test_bundled_controller_is_found():
    assert any(os.path.isfile(p) for p in announce.dll_candidates())


def test_validation():
    for bad in ({}, {"text": "  "}, {"text": "hi", "priority": "loud"}):
        with pytest.raises(AgentError) as e:
            announce.announce(bad)
        assert e.value.code == "E_INVALID"


def test_without_nvda_reports_not_spoken():
    res = announce.announce({"text": "Opening Gmail", "priority": "assertive"})
    if res["spoken"]:
        pytest.skip("NVDA is running on this machine")
    assert res["reason"] in ("nvda-not-running", "no-controller")


def test_missing_dll_falls_back(monkeypatch, tmp_path):
    monkeypatch.setattr(announce, "HERE", str(tmp_path))
    monkeypatch.setattr(announce, "dll_candidates", lambda base=str(tmp_path): [str(tmp_path / "x.dll")])
    monkeypatch.setitem(announce._lib, "tried", False)
    monkeypatch.setitem(announce._lib, "dll", None)
    assert announce.announce({"text": "hello"}) == {"spoken": False, "reason": "no-controller"}


def test_desktop_check_runs():
    assert announce.input_desktop_is_default() in (True, False)
