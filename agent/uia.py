"""Interim UI Automation snapshot / find / act (plans CONTRACTS C2, C3).

One CacheRequest (Subtree, filter: control elements that are on screen)
fetches every property in a single cross-process round trip; the cached tree
is then pruned to interactive nodes and serialized as ElementNodes with
per-snapshot ids ("e1", "e2", ...). Live element references are kept per
snapshot (LRU 3, 30 s) so `uia_act` can use patterns without moving the
pointer. Browser/Electron windows are scoped to their web content child.
"""
import itertools
import logging
import threading
import time
from collections import OrderedDict, deque

import monitors
import window
from errors import AgentError, E_DENIED, E_INVALID, E_NOT_FOUND, E_UNSUPPORTED

log = logging.getLogger(__name__)

SNAPSHOT_CACHE = 3
SNAPSHOT_TTL_S = 30.0
DEFAULT_MAX_NODES = 400
MAX_CONTEXT_NODES = 40
NAME_MAX = 120
CONNECTION_TIMEOUT_MS = 1000
TRANSACTION_TIMEOUT_MS = 1500
SNAPSHOT_TIMEOUT_MS = 1500  # default agent-side timeout for uia_snapshot/uia_find

CUIAutomation8 = "{e22ad333-b25f-460c-83d0-0581107395c9}"

ROLES = {
    50000: "button", 50001: "calendar", 50002: "checkbox", 50003: "combobox", 50004: "edit",
    50005: "hyperlink", 50006: "image", 50007: "listitem", 50008: "list", 50009: "menu",
    50010: "menubar", 50011: "menuitem", 50012: "progressbar", 50013: "radiobutton", 50014: "scrollbar",
    50015: "slider", 50016: "spinner", 50017: "statusbar", 50018: "tab", 50019: "tabitem",
    50020: "text", 50021: "toolbar", 50022: "tooltip", 50023: "tree", 50024: "treeitem",
    50025: "custom", 50026: "group", 50027: "thumb", 50028: "datagrid", 50029: "dataitem",
    50030: "document", 50031: "splitbutton", 50032: "window", 50033: "pane", 50034: "header",
    50035: "headeritem", 50036: "table", 50037: "titlebar", 50038: "separator", 50039: "semanticzoom",
    50040: "appbar",
}
INTERACTIVE = {
    "button", "edit", "combobox", "checkbox", "radiobutton", "menuitem", "tabitem", "listitem",
    "treeitem", "hyperlink", "slider", "spinner", "splitbutton", "dataitem",
}
CONTEXT = {"text", "header", "headeritem"}
WEB_CONTENT_CLASSES = ("Chrome_RenderWidgetHostHWND",)
FIREFOX_PROCESSES = {"firefox.exe", "librewolf.exe", "zen.exe"}

_PATTERNS = (  # (availability property, ElementNode pattern name)
    ("UIA_IsInvokePatternAvailablePropertyId", "invoke"),
    ("UIA_IsTogglePatternAvailablePropertyId", "toggle"),
    ("UIA_IsSelectionItemPatternAvailablePropertyId", "select"),
    ("UIA_IsExpandCollapsePatternAvailablePropertyId", "expand"),
    ("UIA_IsValuePatternAvailablePropertyId", "value"),
    ("UIA_IsScrollPatternAvailablePropertyId", "scroll"),
    ("UIA_IsTextPatternAvailablePropertyId", "text"),
)

ACTIONS = {  # action -> (pattern id attr, interface attr, method)
    "invoke": ("UIA_InvokePatternId", "IUIAutomationInvokePattern", "Invoke"),
    "toggle": ("UIA_TogglePatternId", "IUIAutomationTogglePattern", "Toggle"),
    "select": ("UIA_SelectionItemPatternId", "IUIAutomationSelectionItemPattern", "Select"),
    "expand": ("UIA_ExpandCollapsePatternId", "IUIAutomationExpandCollapsePattern", "Expand"),
    "collapse": ("UIA_ExpandCollapsePatternId", "IUIAutomationExpandCollapsePattern", "Collapse"),
    "set_value": ("UIA_ValuePatternId", "IUIAutomationValuePattern", "SetValue"),
    "scroll_into_view": ("UIA_ScrollItemPatternId", "IUIAutomationScrollItemPattern", "ScrollIntoView"),
    "focus": (None, None, None),
}


class _Client:
    _lock = threading.Lock()
    _inst = None

    def __init__(self):
        import comtypes.client

        self.m = comtypes.client.GetModule("UIAutomationCore.dll")
        self.u = comtypes.client.CreateObject(CUIAutomation8, interface=self.m.IUIAutomation2)
        try:
            self.u.ConnectionTimeout = CONNECTION_TIMEOUT_MS
            self.u.TransactionTimeout = TRANSACTION_TIMEOUT_MS
        except Exception:
            pass
        m = self.m
        self.props = {
            "role": m.UIA_ControlTypePropertyId, "name": m.UIA_NamePropertyId,
            "automationId": m.UIA_AutomationIdPropertyId, "rect": m.UIA_BoundingRectanglePropertyId,
            "enabled": m.UIA_IsEnabledPropertyId, "offscreen": m.UIA_IsOffscreenPropertyId,
            "focused": m.UIA_HasKeyboardFocusPropertyId, "password": m.UIA_IsPasswordPropertyId,
            "value": m.UIA_ValueValuePropertyId, "readonly": m.UIA_ValueIsReadOnlyPropertyId,
        }
        self.pattern_props = [(getattr(m, prop), name) for prop, name in _PATTERNS]
        cr = self.u.CreateCacheRequest()
        for pid in list(self.props.values()) + [p for p, _ in self.pattern_props]:
            cr.AddProperty(pid)
        cr.TreeScope = m.TreeScope_Subtree
        cr.TreeFilter = self.u.CreateAndCondition(
            self.u.CreatePropertyCondition(m.UIA_IsControlElementPropertyId, True),
            self.u.CreatePropertyCondition(m.UIA_IsOffscreenPropertyId, False),
        )
        self.cache_request = cr

    @classmethod
    def get(cls) -> "_Client":
        with cls._lock:
            if cls._inst is None:
                cls._inst = cls()
            return cls._inst


# ---- pure tree shaping ---------------------------------------------------

def keep(role: str, patterns, readonly: bool) -> str | None:
    """'interactive' / 'context' / None for an element in an interactive-only snapshot."""
    if role in INTERACTIVE:
        return "interactive"
    if role == "document" and "value" in patterns and not readonly:
        return "interactive"
    if role in CONTEXT:
        return "context"
    return None


def prune(root, children_of, info_of, max_nodes: int, interactive_only: bool, check=None) -> tuple:
    """Keeps nodes that pass `keep` (all when not interactive_only), up to `max_nodes` in BFS order.

    `children_of(raw)` lists raw children, `info_of(raw)` returns a node dict
    (role, name, patterns, _readonly...). Dropped nodes' kept descendants attach
    to the nearest kept ancestor; siblings stay in document order and ids are
    assigned in document (pre-)order. Returns (root node, [(id, raw, node)]).
    """
    root_node = info_of(root)
    root_node["_path"] = ()
    kept = [(root, root_node)]
    queue = deque((c, root_node, (i,)) for i, c in enumerate(children_of(root)))
    context = 0
    while queue and len(kept) < max_nodes:
        if check is not None:
            check()
        raw, parent, path = queue.popleft()
        node = info_of(raw)
        kind = "interactive" if not interactive_only else keep(node["role"], node["patterns"], node.get("_readonly"))
        if kind == "context":
            if context >= MAX_CONTEXT_NODES or not node["name"]:
                kind = None
            else:
                context += 1
        attach_to = parent
        if kind:
            node["_path"] = path
            parent.setdefault("children", []).append(node)
            kept.append((raw, node))
            attach_to = node
        queue.extend((c, attach_to, path + (i,)) for i, c in enumerate(children_of(raw)))

    ids = itertools.count(1)

    def number(node):
        node["id"] = f"e{next(ids)}"
        kids = node.get("children")
        if kids:
            kids.sort(key=lambda n: n["_path"])
            for k in kids:
                number(k)

    number(root_node)
    for _, node in kept:
        node.pop("_readonly", None)
        node.pop("_path", None)
    raw_of = {id(node): raw for raw, node in kept}
    return root_node, [(n["id"], raw_of[id(n)], n) for n in flatten(root_node)]


def flatten(node) -> list:
    out, stack = [], [node]
    while stack:
        n = stack.pop()
        out.append(n)
        stack.extend(reversed(n.get("children", [])))
    return out


def find(nodes, name=None, role=None, automation_id=None, nth=None) -> list:
    """Case-insensitive exact name matches first, then substring matches. `nth` is 1-based."""
    def base(n):
        return (not role or n["role"] == role.lower()) and (not automation_id or n.get("automationId") == automation_id)

    pool = [n for n in nodes if base(n)]
    if name:
        q = name.strip().lower()
        exact = [n for n in pool if n["name"].lower() == q]
        sub = [n for n in pool if q in n["name"].lower() and n not in exact]
        pool = exact + sub
    if nth:
        return pool[nth - 1:nth] if 0 < nth <= len(pool) else []
    return pool


def strip_children(node) -> dict:
    return {k: v for k, v in node.items() if k != "children"}


# ---- live UIA --------------------------------------------------------------

_snap_lock = threading.Lock()
_snapshots: "OrderedDict[str, dict]" = OrderedDict()
_snap_seq = itertools.count(1)


def _prune_snapshots() -> None:
    now = time.monotonic()
    for sid in [k for k, v in _snapshots.items() if now - v["t"] > SNAPSHOT_TTL_S]:
        del _snapshots[sid]
    while len(_snapshots) > SNAPSHOT_CACHE:
        _snapshots.popitem(last=False)


def get_snapshot(snapshot_id: str | None) -> dict | None:
    with _snap_lock:
        _prune_snapshots()
        if snapshot_id:
            return _snapshots.get(snapshot_id)
        return next(reversed(_snapshots.values()), None)


def web_content_child(hwnd) -> int | None:
    """Largest visible web-content child (Chromium/Electron render widget, Firefox content)."""
    best, best_area = None, 0
    firefox = window.process_name(hwnd) in FIREFOX_PROCESSES
    for child in window.child_windows(hwnd):
        cls = window.class_name(child)
        if cls in WEB_CONTENT_CLASSES or (firefox and cls == "MozillaWindowClass"):
            if not window._user32.IsWindowVisible(child):
                continue
            r = window.rect(child)
            area = r["w"] * r["h"]
            if area > best_area:
                best, best_area = child, area
    return best


def _resolve_scope(scope) -> int:
    if scope in (None, "foreground"):
        hwnd = window.foreground()
    elif isinstance(scope, int) and not isinstance(scope, bool):
        hwnd = scope
    else:
        raise AgentError(E_INVALID, 'scope must be "foreground" or an hwnd')
    if not hwnd:
        raise AgentError(E_NOT_FOUND, "no foreground window")
    return hwnd


def _info_fn(client, mons):
    p = client.props

    def info_of(el) -> dict:
        role = ROLES.get(el.GetCachedPropertyValue(p["role"]), "custom")
        name = (el.GetCachedPropertyValue(p["name"]) or "").strip()
        r = el.CachedBoundingRectangle
        rect = {"x": r.left, "y": r.top, "w": max(0, r.right - r.left), "h": max(0, r.bottom - r.top)}
        patterns = [n for pid, n in client.pattern_props if el.GetCachedPropertyValue(pid)]
        node = {
            "role": role,
            "name": name[:NAME_MAX],
            "rect": rect,
            "monitorId": monitors.containing(mons, rect["x"] + rect["w"] / 2, rect["y"] + rect["h"] / 2)["id"],
            "enabled": bool(el.GetCachedPropertyValue(p["enabled"])),
            "patterns": patterns,
        }
        aid = el.GetCachedPropertyValue(p["automationId"])
        if aid:
            node["automationId"] = str(aid)
        if el.GetCachedPropertyValue(p["focused"]):
            node["focused"] = True
        if "value" in patterns:
            value = el.GetCachedPropertyValue(p["value"])
            if el.GetCachedPropertyValue(p["password"]):
                node["value"] = "••••" if value else ""
            elif value:
                node["value"] = str(value)[:500]
            node["_readonly"] = bool(el.GetCachedPropertyValue(p["readonly"]))
        return node

    return info_of


def _children_fn():
    def children_of(el) -> list:
        arr = el.GetCachedChildren()
        if not arr:
            return []
        return [arr.GetElement(i) for i in range(arr.Length)]

    return children_of


def _build(hwnd, max_nodes: int, interactive_only: bool, token=None) -> tuple:
    root_hwnd = web_content_child(hwnd) or hwnd
    client = _Client.get()
    t0 = time.perf_counter()
    try:
        root = client.u.ElementFromHandleBuildCache(root_hwnd, client.cache_request)
    except Exception as e:
        raise AgentError(E_NOT_FOUND, f"window {hwnd} has no UI Automation tree ({e})") from None
    if token is not None:
        token.check()
    t1 = time.perf_counter()
    mons = monitors.enumerate_monitors()
    root_node, kept = prune(root, _children_fn(), _info_fn(client, mons), max(1, int(max_nodes)),
                            interactive_only, token.check if token is not None else None)
    log.debug("uia hwnd=%s nodes=%d cache=%.0fms walk=%.0fms", hwnd, len(kept),
              (t1 - t0) * 1000, (time.perf_counter() - t1) * 1000)
    return root_node, kept


def snapshot(scope="foreground", max_nodes=DEFAULT_MAX_NODES, interactive_only=True, token=None) -> dict:
    """`uia_snapshot`: builds, stores (for find/act) and returns {snapshotId, hwnd, root}."""
    hwnd = _resolve_scope(scope)
    root_node, kept = _build(hwnd, max_nodes, interactive_only, token)
    sid = f"s{next(_snap_seq)}"
    with _snap_lock:
        _snapshots[sid] = {
            "t": time.monotonic(), "hwnd": hwnd,
            "elements": {nid: raw for nid, raw, _ in kept},
            "nodes": [node for _, _, node in kept],
        }
        _prune_snapshots()
    return {"snapshotId": sid, "hwnd": int(hwnd), "root": root_node}


def find_command(args: dict, token=None) -> dict:
    q = args.get("query") if isinstance(args.get("query"), dict) else {}
    nth = q.get("nth")
    if nth is not None and (not isinstance(nth, int) or isinstance(nth, bool) or nth < 1):
        raise AgentError(E_INVALID, "query.nth must be a positive integer")
    snap = get_snapshot(args.get("snapshotId"))
    if snap is None:
        if args.get("snapshotId"):
            raise AgentError(E_NOT_FOUND, f"snapshot {args['snapshotId']} expired")
        sid = snapshot(token=token)["snapshotId"]
        snap = get_snapshot(sid)
    hits = find(snap["nodes"], q.get("name"), q.get("role"), q.get("automationId"), nth)
    return {"elements": [strip_children(n) for n in hits]}


def _element(args):
    eid = args.get("elementId")
    if not isinstance(eid, str):
        raise AgentError(E_INVALID, "elementId must be a string")
    snap = get_snapshot(args.get("snapshotId"))
    if snap is None or eid not in snap["elements"]:
        raise AgentError(E_NOT_FOUND, f"element {eid} not in a live snapshot; take a new uia_snapshot")
    node = next(n for n in snap["nodes"] if n["id"] == eid)
    return snap["elements"][eid], node, snap["hwnd"]


def _pattern(client, el, pid_attr, iface_attr):
    unk = el.GetCurrentPattern(getattr(client.m, pid_attr))
    if not unk:
        return None
    return unk.QueryInterface(getattr(client.m, iface_attr))


def act(args: dict, token=None, click=None, type_text=None) -> dict:
    """`uia_act {elementId, action, value?, snapshotId?}`. Falls back to a click at the element center."""
    action = args.get("action")
    if action not in ACTIONS:
        raise AgentError(E_INVALID, f"action must be one of {sorted(ACTIONS)}")
    el, node, snap_hwnd = _element(args)
    value = args.get("value")
    if action == "set_value":
        if not isinstance(value, str):
            raise AgentError(E_INVALID, "set_value needs a string value")
        import safety

        if args.get("allowTerminal") is not True:
            reason = safety.window_target_reason(snap_hwnd)
            if reason:
                raise AgentError(E_DENIED, f"set_value denied: {reason}")
    client = _Client.get()
    pid_attr, iface_attr, method = ACTIONS[action]
    try:
        if action == "focus":
            el.SetFocus()
            return {"done": True}
        pat = _pattern(client, el, pid_attr, iface_attr)
        if pat is not None:
            getattr(pat, method)(*([value] if action == "set_value" else []))
            return {"done": True}
        r = el.CurrentBoundingRectangle
        rect = {"x": r.left, "y": r.top, "w": r.right - r.left, "h": r.bottom - r.top}
    except AgentError:
        raise
    except Exception as e:
        raise AgentError(E_NOT_FOUND, f"element {node['id']} is gone or refused {action}: {e}") from None
    if rect["w"] <= 0 or rect["h"] <= 0:
        raise AgentError(E_UNSUPPORTED, f"{node['role']} {node['id']} has no {action} pattern and no visible rect")
    if click is None:
        raise AgentError(E_UNSUPPORTED, f"{node['role']} {node['id']} has no {action} pattern")
    click(rect["x"] + rect["w"] // 2, rect["y"] + rect["h"] // 2)
    if action == "set_value" and type_text is not None:
        type_text(value)
    return {"done": True, "fallbackUsed": True}


def find_in_window(hwnd, text: str, token=None) -> dict | None:
    """First element named `text` (exact, then substring) anywhere in the window. For click_element."""
    _, kept = _build(hwnd, 3000, False, token)
    hits = find([node for _, _, node in kept], name=text)
    hits = [h for h in hits if h["rect"]["w"] > 0 and h["rect"]["h"] > 0]
    return hits[0] if hits else None


# ---- warm-up ---------------------------------------------------------------

_warm = {"hwnd": None, "thread": None}


def warm_up(hwnd) -> None:
    """First snapshot of a new window (esp. Chromium) can take seconds; pay it in the background."""
    if not hwnd or hwnd == _warm["hwnd"]:
        return
    t = _warm["thread"]
    if t is not None and t.is_alive():
        return
    _warm["hwnd"] = hwnd

    def run():
        from dispatch import _com_init

        _com_init()
        try:
            _build(hwnd, DEFAULT_MAX_NODES, True)
        except Exception as e:
            log.debug("warm-up of %s failed: %s", hwnd, e)

    _warm["thread"] = threading.Thread(target=run, name="uia-warm", daemon=True)
    _warm["thread"].start()


# ---- focused element (dictation) --------------------------------------------

FOCUS_VALUE_TAIL = 200
_FREE_TEXT_ROLES = {"edit", "document", "combobox", "custom", "group", "pane"}


def is_editable(role: str, has_value: bool, readonly, has_text_edit: bool, password: bool) -> bool:
    """Whether typed text would land in an editable text field."""
    if password or readonly is True:
        return False
    if role == "edit" or has_text_edit:
        return True
    return has_value and readonly is False and role in _FREE_TEXT_ROLES


def focus_info(token=None) -> dict:
    """`focus_info`: foreground process plus the keyboard-focused element (role, editable, value tail)."""
    info = window.active()
    out = {"process": info["process"], "title": info["title"], "uia": False, "role": "", "name": "",
           "editable": False, "password": False, "valueTail": ""}
    try:
        client = _Client.get()
        el = client.u.GetFocusedElement()
    except Exception as e:
        log.debug("focus_info: no focused element (%s)", e)
        return out
    if token is not None:
        token.check()
    m, p = client.m, client.props

    def prop(pid, default=None):
        try:
            return el.GetCurrentPropertyValue(pid)
        except Exception:
            return default

    role = ROLES.get(prop(p["role"]), "custom")
    password = bool(prop(p["password"], False))
    has_value = bool(prop(m.UIA_IsValuePatternAvailablePropertyId, False))
    readonly = bool(prop(p["readonly"], False)) if has_value else None
    text_edit_id = getattr(m, "UIA_IsTextEditPatternAvailablePropertyId", None)
    has_text_edit = bool(prop(text_edit_id, False)) if text_edit_id is not None else False
    value = prop(p["value"], "") if has_value and not password else ""
    out.update({
        "uia": True,
        "role": role,
        "name": str(prop(p["name"], "") or "")[:NAME_MAX],
        "editable": is_editable(role, has_value, readonly, has_text_edit, password),
        "password": password,
        "valueTail": str(value or "")[-FOCUS_VALUE_TAIL:],
    })
    return out
