import os
import subprocess
import time

import pytest

import uia
from errors import AgentError

HERE = os.path.dirname(os.path.abspath(__file__))


# ---- pure pruning / find ---------------------------------------------------

def tree(spec):
    """spec: (role, name, patterns, [children]) -> raw nodes the fakes understand."""
    role, name, patterns, children = spec
    return {"role": role, "name": name, "patterns": patterns, "kids": [tree(c) for c in children]}


def info_of(raw):
    return {"role": raw["role"], "name": raw["name"], "patterns": list(raw["patterns"]),
            "rect": {"x": 0, "y": 0, "w": 10, "h": 10}, "monitorId": 0, "enabled": True,
            "_readonly": raw["role"] == "document" and "ro" in raw["name"]}


def children_of(raw):
    return raw["kids"]


SPEC = ("window", "App", [], [
    ("pane", "", [], [
        ("button", "Send", ["invoke"], []),
        ("group", "", [], [("checkbox", "Remember", ["toggle"], []), ("text", "Hint", [], [])]),
        ("document", "editor", ["value", "text"], []),
        ("document", "ro page", ["value", "text"], []),
        ("text", "", [], []),
    ]),
    ("button", "Send later", ["invoke"], []),
])


def test_prune_interactive_attaches_to_nearest_kept_ancestor():
    root, kept = uia.prune(tree(SPEC), children_of, info_of, 400, True)
    assert [(n["id"], n["role"], n["name"]) for n in uia.flatten(root)] == [
        ("e1", "window", "App"), ("e2", "button", "Send"), ("e3", "checkbox", "Remember"),
        ("e4", "text", "Hint"), ("e5", "document", "editor"), ("e6", "button", "Send later")]
    assert [nid for nid, _, _ in kept] == ["e1", "e2", "e3", "e4", "e5", "e6"]
    assert all("_readonly" not in n for _, _, n in kept)


def test_prune_max_nodes_bfs():
    root, kept = uia.prune(tree(SPEC), children_of, info_of, 3, True)
    assert [n["name"] for _, _, n in kept] == ["App", "Send", "Send later"]


def test_prune_everything_when_not_interactive_only():
    root, kept = uia.prune(tree(SPEC), children_of, info_of, 400, False)
    assert len(kept) == 10


def test_find_exact_before_substring_and_nth():
    nodes = [n for _, _, n in uia.prune(tree(SPEC), children_of, info_of, 400, True)[1]]
    assert [n["name"] for n in uia.find(nodes, name="send")] == ["Send", "Send later"]
    assert [n["name"] for n in uia.find(nodes, name="SEND", nth=2)] == ["Send later"]
    assert uia.find(nodes, name="send", nth=3) == []
    assert [n["name"] for n in uia.find(nodes, role="checkbox")] == ["Remember"]


# ---- live against a WinForms fixture ---------------------------------------

@pytest.fixture(scope="module")
def fixture_hwnd():
    proc = subprocess.Popen(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", os.path.join(HERE, "fixture_app.ps1")],
        stdout=subprocess.PIPE, text=True)
    try:
        line = proc.stdout.readline().strip()
        if not line.isdigit():
            pytest.skip("fixture did not start")
        yield int(line)
    finally:
        proc.kill()
        proc.wait()


def _snap(hwnd):
    s = uia.snapshot(hwnd)
    return s, uia.flatten(s["root"])


def _one(nodes, **q):
    hits = uia.find(nodes, **q)
    assert hits, f"no element for {q} in {[(n['role'], n['name']) for n in nodes]}"
    return hits[0]


def test_live_snapshot_shape(fixture_hwnd):
    s, nodes = _snap(fixture_hwnd)
    btn = _one(nodes, name="Increment", role="button")
    assert btn["automationId"] == "incrementButton" and "invoke" in btn["patterns"]
    assert btn["rect"]["w"] > 0 and btn["enabled"] is True and isinstance(btn["monitorId"], int)
    secret = _one(nodes, automation_id="secretBox")
    assert secret.get("value") != "hunter2"
    assert _one(nodes, name="Count: 0", role="text")


def test_live_invoke_toggle_and_set_value(fixture_hwnd):
    import ctypes
    import ctypes.wintypes

    before = ctypes.wintypes.POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(before))

    s, nodes = _snap(fixture_hwnd)
    sid = s["snapshotId"]
    btn = _one(nodes, name="Increment")
    assert uia.act({"snapshotId": sid, "elementId": btn["id"], "action": "invoke"}) == {"done": True}
    chk = _one(nodes, name="Remember")
    assert uia.act({"snapshotId": sid, "elementId": chk["id"], "action": "toggle"}) == {"done": True}
    box = _one(nodes, automation_id="nameBox")
    set_value = {"snapshotId": sid, "elementId": box["id"], "action": "set_value", "value": "héllo"}
    with pytest.raises(AgentError) as e:  # the fixture window belongs to powershell.exe
        uia.act(set_value)
    assert e.value.code == "E_DENIED"
    assert uia.act({**set_value, "allowTerminal": True}) == {"done": True}

    deadline = time.monotonic() + 3
    while True:
        _, nodes = _snap(fixture_hwnd)
        if uia.find(nodes, name="Count: 1") or time.monotonic() > deadline:
            break
        time.sleep(0.1)
    assert uia.find(nodes, name="Count: 1", role="text")
    assert _one(nodes, automation_id="nameBox").get("value") == "héllo"

    after = ctypes.wintypes.POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(after))
    assert (before.x, before.y) == (after.x, after.y)  # patterns, not the pointer


def test_live_find_command_and_errors(fixture_hwnd):
    s = uia.snapshot(fixture_hwnd)
    res = uia.find_command({"snapshotId": s["snapshotId"], "query": {"name": "increment", "role": "button"}})
    assert [e["name"] for e in res["elements"]] == ["Increment"]
    assert "children" not in res["elements"][0]
    with pytest.raises(AgentError) as e:
        uia.act({"snapshotId": s["snapshotId"], "elementId": "e9999", "action": "invoke"})
    assert e.value.code == "E_NOT_FOUND"
    with pytest.raises(AgentError) as e:
        uia.act({"snapshotId": s["snapshotId"], "elementId": "e1", "action": "explode"})
    assert e.value.code == "E_INVALID"


def test_live_fallback_click_when_pattern_missing(fixture_hwnd):
    s, nodes = _snap(fixture_hwnd)
    label = _one(nodes, name="Count", role="text")
    clicks = []
    res = uia.act({"snapshotId": s["snapshotId"], "elementId": label["id"], "action": "invoke"},
                  click=lambda x, y: clicks.append((x, y)))
    assert res == {"done": True, "fallbackUsed": True}
    r = label["rect"]
    assert clicks == [(r["x"] + r["w"] // 2, r["y"] + r["h"] // 2)]


def test_live_find_in_window_for_click_element(fixture_hwnd):
    hit = uia.find_in_window(fixture_hwnd, "Remember")
    assert hit and hit["role"] == "checkbox"


def test_protocol_uia_commands(fixture_hwnd):
    from agent_proc import AgentProc

    a = AgentProc("--protocol", "2")
    try:
        ready = a.next()
        assert "uia" in ready["data"]["capabilities"]

        def req(id, cmd, **args):
            a.send({"v": 2, "id": id, "cmd": cmd, "args": args})
            return a.wait_for(lambda m: m.get("id") == id, timeout=15)

        snap = req(1, "uia_snapshot", scope=fixture_hwnd, maxNodes=50)
        assert snap["ok"], snap
        sid = snap["result"]["snapshotId"]
        found = req(2, "uia_find", snapshotId=sid, query={"name": "Increment", "role": "button"})
        (btn,) = found["result"]["elements"]
        acted = req(3, "uia_act", snapshotId=sid, elementId=btn["id"], action="invoke")
        assert acted["result"] == {"done": True}
        bad = req(4, "uia_snapshot", scope="nope")
        assert bad["error"]["code"] == "E_INVALID"
        gone = req(5, "uia_act", snapshotId="s999", elementId="e1", action="invoke")
        assert gone["error"]["code"] == "E_NOT_FOUND"
    finally:
        a.close()


def test_click_element_uia_lookup(fixture_hwnd):
    import actions

    hit = actions._find_element_uia(fixture_hwnd, "increment", 1.0)
    assert hit["name"] == "Increment" and hit["rect"]["w"] > 0
    t0 = time.monotonic()
    assert actions._find_element_uia(fixture_hwnd, "No such control", 0.3) is None
    assert time.monotonic() - t0 < 5
