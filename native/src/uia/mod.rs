//! UI Automation: `uia_snapshot`, `uia_find`, `uia_act`, `focus_info` and
//! `focus-changed` events (plans CONTRACTS C2/C3).
//!
//! One CacheRequest (Subtree, filter: control elements that are on screen)
//! fetches every property in a single cross-process round trip
//! (ElementFromHandleBuildCache + GetCachedChildren); the cached tree is then
//! pruned (tree.rs) and numbered per snapshot. Live element references are
//! kept per snapshot (3 snapshots, 30 s) so `uia_act` can use patterns
//! without moving the pointer. Browser/Electron windows are scoped to their
//! web content child.

pub mod browser;
pub mod text;
pub mod tree;

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::*;
use windows::core::{BSTR, Interface};

use crate::geom::Rect;
use crate::monitors::{self, MonitorInfo};
use crate::proto::router::CancelToken;
use crate::proto::{AgentError, Args, CmdResult, arg};
use crate::window;
use tree::{Node, Pruned};

pub const DEFAULT_MAX_NODES: usize = 400;
pub const SNAPSHOT_TIMEOUT_MS: u64 = 1500;
pub const FOCUS_INFO_TIMEOUT_MS: u64 = 1000;
const CONNECTION_TIMEOUT_MS: u32 = 1000;
const TRANSACTION_TIMEOUT_MS: u32 = 1500;
const SNAPSHOT_CACHE: usize = 3;
const SNAPSHOT_TTL: Duration = Duration::from_secs(30);
const FIND_IN_WINDOW_MAX_NODES: usize = 3000;
const FOCUS_VALUE_TAIL: usize = 200;
/// UIA_E_ELEMENTNOTAVAILABLE
const ELEMENT_NOT_AVAILABLE: i32 = 0x8004_0201_u32 as i32;

const WEB_CONTENT_CLASSES: &[&str] = &["Chrome_RenderWidgetHostHWND"];
const FIREFOX_PROCESSES: &[&str] = &["firefox.exe", "librewolf.exe", "zen.exe"];

const PATTERN_PROPS: [(UIA_PROPERTY_ID, &str); 7] = [
    (UIA_IsInvokePatternAvailablePropertyId, "invoke"),
    (UIA_IsTogglePatternAvailablePropertyId, "toggle"),
    (UIA_IsSelectionItemPatternAvailablePropertyId, "select"),
    (UIA_IsExpandCollapsePatternAvailablePropertyId, "expand"),
    (UIA_IsValuePatternAvailablePropertyId, "value"),
    (UIA_IsScrollPatternAvailablePropertyId, "scroll"),
    (UIA_IsTextPatternAvailablePropertyId, "text"),
];

const BASE_PROPS: [UIA_PROPERTY_ID; 10] = [
    UIA_ControlTypePropertyId,
    UIA_NamePropertyId,
    UIA_AutomationIdPropertyId,
    UIA_BoundingRectanglePropertyId,
    UIA_IsEnabledPropertyId,
    UIA_IsOffscreenPropertyId,
    UIA_HasKeyboardFocusPropertyId,
    UIA_IsPasswordPropertyId,
    UIA_ValueValuePropertyId,
    UIA_ValueIsReadOnlyPropertyId,
];

pub const ACTIONS: &[&str] =
    &["invoke", "toggle", "select", "expand", "collapse", "set_value", "scroll_into_view", "focus"];

fn com_err(what: &str, e: windows::core::Error) -> AgentError {
    if e.code().0 == ELEMENT_NOT_AVAILABLE {
        return AgentError::not_found(format!("{what}: element is no longer available"));
    }
    AgentError::internal(format!("{what}: {} (0x{:08X})", e.message(), e.code().0))
}

/// One IUIAutomation + CacheRequest per thread (all lane threads are MTA).
pub struct Client {
    pub u: IUIAutomation,
    /// Subtree of on-screen control elements with every snapshot property.
    pub tree_cr: IUIAutomationCacheRequest,
    /// Same properties for a single element (focus events, focused element).
    pub elem_cr: IUIAutomationCacheRequest,
}

thread_local! {
    static CLIENT: RefCell<Option<Rc<Client>>> = const { RefCell::new(None) };
}

impl Client {
    fn create() -> Result<Client, AgentError> {
        // SAFETY: COM is initialised (MTA) on every thread that reaches here.
        unsafe {
            let u2: IUIAutomation2 = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| com_err("CUIAutomation8", e))?;
            let _ = u2.SetConnectionTimeout(CONNECTION_TIMEOUT_MS);
            let _ = u2.SetTransactionTimeout(TRANSACTION_TIMEOUT_MS);
            let u: IUIAutomation = u2.cast().map_err(|e| com_err("IUIAutomation", e))?;
            let request = |scope: TreeScope| -> Result<IUIAutomationCacheRequest, AgentError> {
                let cr = u.CreateCacheRequest().map_err(|e| com_err("CreateCacheRequest", e))?;
                for pid in BASE_PROPS.iter().copied().chain(PATTERN_PROPS.iter().map(|(p, _)| *p)) {
                    cr.AddProperty(pid).map_err(|e| com_err("AddProperty", e))?;
                }
                cr.SetTreeScope(scope).map_err(|e| com_err("SetTreeScope", e))?;
                let filter = u
                    .CreateAndCondition(
                        &u.CreatePropertyCondition(UIA_IsControlElementPropertyId, &VARIANT::from(true))
                            .map_err(|e| com_err("condition", e))?,
                        &u.CreatePropertyCondition(UIA_IsOffscreenPropertyId, &VARIANT::from(false))
                            .map_err(|e| com_err("condition", e))?,
                    )
                    .map_err(|e| com_err("condition", e))?;
                cr.SetTreeFilter(&filter).map_err(|e| com_err("SetTreeFilter", e))?;
                Ok(cr)
            };
            Ok(Client { tree_cr: request(TreeScope_Subtree)?, elem_cr: request(TreeScope_Element)?, u })
        }
    }

    pub fn get() -> Result<Rc<Client>, AgentError> {
        CLIENT.with(|c| {
            if let Some(client) = c.borrow().as_ref() {
                return Ok(client.clone());
            }
            // Two threads creating their first client at once can get E_FAIL from UIA;
            // serialise creation and retry once.
            static CREATE: Mutex<()> = Mutex::new(());
            let _guard = CREATE.lock().unwrap();
            let client = match Client::create() {
                Ok(c) => c,
                Err(e) => {
                    tracing::debug!("uia client creation failed, retrying: {}", e.message);
                    std::thread::sleep(Duration::from_millis(50));
                    Client::create()?
                }
            };
            let client = Rc::new(client);
            *c.borrow_mut() = Some(client.clone());
            Ok(client)
        })
    }
}

fn cached_bool(el: &IUIAutomationElement, pid: UIA_PROPERTY_ID) -> bool {
    // SAFETY: reading a cached property of a live element.
    unsafe { el.GetCachedPropertyValue(pid) }.ok().and_then(|v| bool::try_from(&v).ok()).unwrap_or(false)
}

fn cached_string(el: &IUIAutomationElement, pid: UIA_PROPERTY_ID) -> String {
    // SAFETY: reading a cached property of a live element.
    unsafe { el.GetCachedPropertyValue(pid) }
        .ok()
        .and_then(|v| BSTR::try_from(&v).ok())
        .map(|b| b.to_string())
        .unwrap_or_default()
}

/// ElementNode for an element whose properties were fetched with our cache request.
pub fn node_of(el: &IUIAutomationElement, mons: &[MonitorInfo]) -> Node {
    // SAFETY: cached property reads; failures fall back to defaults.
    let (control_type, name, rect, enabled, automation_id, focused) = unsafe {
        (
            el.CachedControlType().map(|c| c.0).unwrap_or(0),
            el.CachedName().map(|b| b.to_string()).unwrap_or_default(),
            el.CachedBoundingRectangle().map(Rect::from).unwrap_or_default(),
            el.CachedIsEnabled().map(|b| b.as_bool()).unwrap_or(false),
            el.CachedAutomationId().map(|b| b.to_string()).unwrap_or_default(),
            el.CachedHasKeyboardFocus().map(|b| b.as_bool()).unwrap_or(false),
        )
    };
    let rect = Rect::new(rect.x, rect.y, rect.w.max(0), rect.h.max(0));
    let patterns: Vec<&'static str> =
        PATTERN_PROPS.iter().filter(|(pid, _)| cached_bool(el, *pid)).map(|(_, n)| *n).collect();
    let (cx, cy) = (rect.x as f64 + rect.w as f64 / 2.0, rect.y as f64 + rect.h as f64 / 2.0);
    let mut node = Node {
        id: String::new(),
        role: tree::role_of(control_type),
        name: tree::truncate(name.trim(), tree::NAME_MAX),
        automation_id: (!automation_id.is_empty()).then_some(automation_id),
        value: None,
        rect,
        monitor_id: monitors::containing(mons, cx, cy).map(|m| m.id).unwrap_or(0),
        enabled,
        focused: focused.then_some(true),
        patterns,
        readonly: None,
    };
    if node.patterns.contains(&"value") {
        let value = cached_string(el, UIA_ValueValuePropertyId);
        if cached_bool(el, UIA_IsPasswordPropertyId) {
            node.value = Some(if value.is_empty() { String::new() } else { "••••".into() });
        } else if !value.is_empty() {
            node.value = Some(tree::truncate(&value, tree::VALUE_MAX));
        }
        node.readonly = Some(cached_bool(el, UIA_ValueIsReadOnlyPropertyId));
    }
    node
}

fn cached_children(el: &IUIAutomationElement) -> Vec<IUIAutomationElement> {
    // SAFETY: walking the cached tree of a live element.
    unsafe {
        let Ok(arr) = el.GetCachedChildren() else { return vec![] };
        let n = arr.Length().unwrap_or(0);
        (0..n).filter_map(|i| arr.GetElement(i).ok()).collect()
    }
}

/// Largest visible web-content child (Chromium/Electron render widget, Firefox content).
pub fn web_content_child(hwnd: isize) -> Option<isize> {
    let firefox = FIREFOX_PROCESSES.contains(&window::process_name(hwnd).as_str());
    window::child_windows(hwnd)
        .into_iter()
        .filter(|&c| {
            let cls = window::class_name(c);
            WEB_CONTENT_CLASSES.contains(&cls.as_str()) || (firefox && cls == "MozillaWindowClass")
        })
        .filter(|&c| window::is_visible(c))
        .map(|c| (c, window::rect(c)))
        .filter(|(_, r)| r.w > 0 && r.h > 0)
        .max_by_key(|(_, r)| r.w as i64 * r.h as i64)
        .map(|(c, _)| c)
}

pub fn build(
    hwnd: isize,
    max_nodes: usize,
    interactive_only: bool,
    token: Option<&CancelToken>,
) -> Result<Pruned<IUIAutomationElement>, AgentError> {
    let root_hwnd = web_content_child(hwnd).unwrap_or(hwnd);
    let client = Client::get()?;
    let t0 = Instant::now();
    // SAFETY: COM call on this thread's client.
    let root = unsafe { client.u.ElementFromHandleBuildCache(HWND(root_hwnd as *mut _), &client.tree_cr) }
        .map_err(|e| {
            AgentError::not_found(format!("window {hwnd} has no UI Automation tree ({})", e.message()))
        })?;
    if let Some(t) = token {
        t.check()?;
    }
    let t1 = Instant::now();
    let mons = monitors::enumerate();
    let pruned = tree::prune(
        root,
        cached_children,
        |el| node_of(el, &mons),
        max_nodes,
        interactive_only,
        || token.map_or(Ok(()), CancelToken::check),
    )?;
    tracing::debug!(
        "uia hwnd={hwnd} nodes={} cache={:?} walk={:?}",
        pruned.nodes.len(),
        t1 - t0,
        t1.elapsed()
    );
    Ok(pruned)
}

// ---- snapshot store --------------------------------------------------------

struct Elem(IUIAutomationElement);
// SAFETY: elements come from MTA threads and are only used from MTA threads.
unsafe impl Send for Elem {}

struct Snapshot {
    id: String,
    t: Instant,
    hwnd: isize,
    elements: HashMap<String, Elem>,
    nodes: Vec<Node>,
}

struct Store {
    seq: u64,
    snaps: VecDeque<Snapshot>,
}

static STORE: Mutex<Store> = Mutex::new(Store { seq: 0, snaps: VecDeque::new() });

fn prune_store(s: &mut Store) {
    s.snaps.retain(|x| x.t.elapsed() <= SNAPSHOT_TTL);
    while s.snaps.len() > SNAPSHOT_CACHE {
        s.snaps.pop_front();
    }
}

fn store(hwnd: isize, p: Pruned<IUIAutomationElement>) -> (String, Value) {
    let root = p.to_json(0);
    let nodes = p.flat();
    let Pruned { nodes: raw_nodes, raws, .. } = p;
    let elements = raw_nodes.into_iter().map(|n| n.id).zip(raws.into_iter().map(Elem)).collect();
    let mut s = STORE.lock().unwrap();
    s.seq += 1;
    let id = format!("s{}", s.seq);
    s.snaps.push_back(Snapshot { id: id.clone(), t: Instant::now(), hwnd, elements, nodes });
    prune_store(&mut s);
    (id, root)
}

fn resolve_scope(v: Option<&Value>) -> Result<isize, AgentError> {
    let hwnd = match v {
        None | Some(Value::Null) => window::foreground(),
        Some(Value::String(s)) if s == "foreground" => window::foreground(),
        Some(Value::Number(n)) if n.is_i64() => n.as_i64().unwrap() as isize,
        _ => return Err(AgentError::invalid("scope must be \"foreground\" or an hwnd")),
    };
    if hwnd == 0 {
        return Err(AgentError::not_found("no foreground window"));
    }
    Ok(hwnd)
}

fn snapshot(
    scope: Option<&Value>,
    max_nodes: usize,
    interactive_only: bool,
    token: &CancelToken,
) -> CmdResult {
    let hwnd = resolve_scope(scope)?;
    let pruned = build(hwnd, max_nodes, interactive_only, Some(token))?;
    let (id, root) = store(hwnd, pruned);
    Ok(json!({"snapshotId": id, "hwnd": hwnd, "root": root}))
}

pub fn cmd_snapshot(args: &Args, token: &CancelToken) -> CmdResult {
    let max_nodes = match args.get("maxNodes") {
        None | Some(Value::Null) => DEFAULT_MAX_NODES,
        Some(Value::Number(n)) if n.as_u64().is_some_and(|n| n >= 1) => n.as_u64().unwrap() as usize,
        _ => return Err(AgentError::invalid("maxNodes must be a positive integer")),
    };
    let interactive_only = args.get("interactiveOnly") != Some(&Value::Bool(false));
    snapshot(args.get("scope"), max_nodes, interactive_only, token)
}

fn without_children(n: &Node) -> Value {
    serde_json::to_value(n).unwrap_or_default()
}

pub fn cmd_find(args: &Args, token: &CancelToken) -> CmdResult {
    let empty = Args::new();
    let q = arg::obj(args, "query").unwrap_or(&empty);
    let nth = match q.get("nth") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) if n.as_u64().is_some_and(|n| n >= 1) => Some(n.as_u64().unwrap() as usize),
        _ => return Err(AgentError::invalid("query.nth must be a positive integer")),
    };
    let sid = arg::opt_str(args, "snapshotId")?.filter(|s| !s.is_empty()).map(str::to_owned);
    let sid = match sid {
        Some(sid) => sid,
        None => {
            let latest = {
                let mut s = STORE.lock().unwrap();
                prune_store(&mut s);
                s.snaps.back().map(|x| x.id.clone())
            };
            match latest {
                Some(id) => id,
                None => snapshot(None, DEFAULT_MAX_NODES, true, token)?["snapshotId"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned(),
            }
        }
    };
    let mut s = STORE.lock().unwrap();
    prune_store(&mut s);
    let snap = s
        .snaps
        .iter()
        .find(|x| x.id == sid)
        .ok_or_else(|| AgentError::not_found(format!("snapshot {sid} expired")))?;
    let text = |k: &str| q.get(k).and_then(Value::as_str);
    let hits = tree::find(&snap.nodes, text("name"), text("role"), text("automationId"), nth);
    Ok(json!({"elements": hits.into_iter().map(without_children).collect::<Vec<_>>()}))
}

/// (element, node, snapshot hwnd) for `elementId` in the given (or latest) snapshot.
fn element(args: &Args) -> Result<(IUIAutomationElement, Node, isize), AgentError> {
    let eid = match args.get("elementId") {
        Some(Value::String(s)) => s.clone(),
        _ => return Err(AgentError::invalid("elementId must be a string")),
    };
    let sid = arg::opt_str(args, "snapshotId")?.filter(|s| !s.is_empty());
    let mut s = STORE.lock().unwrap();
    prune_store(&mut s);
    let snap = match sid {
        Some(sid) => s.snaps.iter().find(|x| x.id == sid),
        None => s.snaps.back(),
    };
    let gone =
        || AgentError::not_found(format!("element {eid} not in a live snapshot; take a new uia_snapshot"));
    let snap = snap.ok_or_else(gone)?;
    let el = snap.elements.get(&eid).ok_or_else(gone)?;
    let node = snap.nodes.iter().find(|n| n.id == eid).cloned().ok_or_else(gone)?;
    Ok((el.0.clone(), node, snap.hwnd))
}

/// Calls the action's pattern. Ok(false) when the element has no such pattern.
fn call_pattern(el: &IUIAutomationElement, action: &str, value: Option<&str>) -> Result<bool, AgentError> {
    macro_rules! with {
        ($iface:ty, $pid:expr, |$p:ident| $call:expr) => {{
            // SAFETY: COM calls on a live element; a missing pattern yields an error/null.
            match unsafe { el.GetCurrentPatternAs::<$iface>($pid) } {
                Ok($p) => unsafe { $call }.map(|_| true).map_err(|e| com_err(action, e)),
                Err(e) if e.code().0 == ELEMENT_NOT_AVAILABLE => Err(com_err(action, e)),
                Err(_) => Ok(false),
            }
        }};
    }
    match action {
        "invoke" => with!(IUIAutomationInvokePattern, UIA_InvokePatternId, |p| p.Invoke()),
        "toggle" => with!(IUIAutomationTogglePattern, UIA_TogglePatternId, |p| p.Toggle()),
        "select" => with!(IUIAutomationSelectionItemPattern, UIA_SelectionItemPatternId, |p| p.Select()),
        "expand" => with!(IUIAutomationExpandCollapsePattern, UIA_ExpandCollapsePatternId, |p| p.Expand()),
        "collapse" => {
            with!(IUIAutomationExpandCollapsePattern, UIA_ExpandCollapsePatternId, |p| p.Collapse())
        }
        "scroll_into_view" => {
            with!(IUIAutomationScrollItemPattern, UIA_ScrollItemPatternId, |p| p.ScrollIntoView())
        }
        "set_value" => {
            let v = BSTR::from(value.unwrap_or(""));
            with!(IUIAutomationValuePattern, UIA_ValuePatternId, |p| p.SetValue(&v))
        }
        "focus" => {
            // SAFETY: COM call on a live element.
            unsafe { el.SetFocus() }.map(|_| true).map_err(|e| com_err(action, e))
        }
        _ => Err(AgentError::invalid(format!("action must be one of {ACTIONS:?}"))),
    }
}

/// `uia_act {elementId, action, value?, snapshotId?, allowTerminal?}`; falls back to a click at
/// the element's center (then select-all + typing for set_value) when the pattern is missing.
pub fn cmd_act(args: &Args, token: &CancelToken) -> CmdResult {
    use crate::input::{safety, sendinput};
    let action = arg::opt_str(args, "action")?.unwrap_or("");
    if !ACTIONS.contains(&action) {
        return Err(AgentError::invalid(format!("action must be one of {ACTIONS:?}")));
    }
    let (el, node, snap_hwnd) = element(args)?;
    let allow_terminal = arg::opt_bool(args, "allowTerminal")?.unwrap_or(false);
    let value = match args.get("value") {
        Some(Value::String(s)) => Some(s.as_str()),
        _ => None,
    };
    if action == "set_value" {
        if value.is_none() {
            return Err(AgentError::invalid("set_value needs a string value"));
        }
        if !allow_terminal && let Some(reason) = safety::window_target_reason(snap_hwnd) {
            return Err(AgentError::denied(format!("set_value denied: {reason}")));
        }
    }
    token.check()?;
    if call_pattern(&el, action, value)? {
        return Ok(json!({"done": true}));
    }
    // SAFETY: COM call on a live element.
    let rect: Rect =
        unsafe { el.CurrentBoundingRectangle() }.map(Rect::from).map_err(|e| com_err(action, e))?;
    if rect.is_empty() {
        return Err(AgentError::unsupported(format!(
            "{} {} has no {action} pattern and no visible rect",
            node.role, node.id
        )));
    }
    let (x, y) = rect.center();
    sendinput::move_to(x, y)?;
    token.sleep(Duration::from_millis(30))?;
    sendinput::click(sendinput::Button::Left, 1, token)?;
    if action == "set_value" {
        token.sleep(Duration::from_millis(50))?;
        sendinput::send_keys(&sendinput::chord_events(&[0x11, 0x41], sendinput::scan_code), token)?;
        sendinput::send_keys(&sendinput::text_events(value.unwrap_or("")), token)?;
    }
    Ok(json!({"done": true, "fallbackUsed": true}))
}

/// First element named `text` (exact, then substring) anywhere in the window.
pub fn find_in_window(hwnd: isize, text: &str, token: &CancelToken) -> Result<Option<Node>, AgentError> {
    let p = build(hwnd, FIND_IN_WINDOW_MAX_NODES, false, Some(token))?;
    let flat = p.flat();
    Ok(tree::find(&flat, Some(text), None, None, None).into_iter().find(|n| !n.rect.is_empty()).cloned())
}

/// {rect, role, name} of the control under a physical point (dwell snap-to-element).
pub fn element_at(x: i32, y: i32) -> Option<Value> {
    let client = Client::get().ok()?;
    // SAFETY: COM call on this thread's client.
    let el = unsafe {
        client.u.ElementFromPointBuildCache(windows::Win32::Foundation::POINT { x, y }, &client.elem_cr)
    }
    .ok()?;
    let node = node_of(&el, &monitors::enumerate());
    (!node.rect.is_empty())
        .then(|| json!({"rect": node.rect.to_json(), "role": node.role, "name": node.name}))
}

// ---- warm-up ---------------------------------------------------------------

static WARM: Mutex<(isize, bool)> = Mutex::new((0, false));

/// The first snapshot of a new window (esp. Chromium) can take seconds; pay it in the background.
pub fn warm_up(hwnd: isize) {
    {
        let mut w = WARM.lock().unwrap();
        if hwnd == 0 || w.0 == hwnd || w.1 {
            return;
        }
        *w = (hwnd, true);
    }
    std::thread::spawn(move || {
        crate::com_init();
        if let Err(e) = build(hwnd, DEFAULT_MAX_NODES, true, None) {
            tracing::debug!("uia warm-up of {hwnd} failed: {}", e.message);
        }
        WARM.lock().unwrap().1 = false;
    });
}

// ---- focused element -------------------------------------------------------

const FREE_TEXT_ROLES: &[&str] = &["edit", "document", "combobox", "custom", "group", "pane"];

/// Whether typed text would land in an editable text field. Pure.
pub fn is_editable(
    role: &str,
    has_value: bool,
    readonly: Option<bool>,
    has_text_edit: bool,
    password: bool,
) -> bool {
    if password || readonly == Some(true) {
        return false;
    }
    if role == "edit" || has_text_edit {
        return true;
    }
    has_value && readonly == Some(false) && FREE_TEXT_ROLES.contains(&role)
}

/// `focus_info`: foreground process plus the keyboard-focused element.
pub fn cmd_focus_info(token: &CancelToken) -> CmdResult {
    let info = window::info(window::foreground());
    let mut out = json!({
        "process": info["process"], "title": info["title"], "uia": false, "role": "", "name": "",
        "editable": false, "password": false, "valueTail": "",
    });
    let client = Client::get()?;
    // SAFETY: COM call on this thread's client.
    let Ok(el) = (unsafe { client.u.GetFocusedElement() }) else { return Ok(out) };
    token.check()?;
    let prop = |pid: UIA_PROPERTY_ID| {
        // SAFETY: current-property read on a live element.
        unsafe { el.GetCurrentPropertyValue(pid) }.ok()
    };
    let as_bool = |pid| prop(pid).and_then(|v| bool::try_from(&v).ok()).unwrap_or(false);
    let role =
        tree::role_of(prop(UIA_ControlTypePropertyId).and_then(|v| i32::try_from(&v).ok()).unwrap_or(0));
    let password = as_bool(UIA_IsPasswordPropertyId);
    let has_value = as_bool(UIA_IsValuePatternAvailablePropertyId);
    let readonly = has_value.then(|| as_bool(UIA_ValueIsReadOnlyPropertyId));
    let has_text_edit = as_bool(UIA_IsTextEditPatternAvailablePropertyId);
    let text =
        |pid| prop(pid).and_then(|v| BSTR::try_from(&v).ok()).map(|b| b.to_string()).unwrap_or_default();
    let value = if has_value && !password { text(UIA_ValueValuePropertyId) } else { String::new() };
    let tail: String = {
        let chars: Vec<char> = value.chars().collect();
        chars[chars.len().saturating_sub(FOCUS_VALUE_TAIL)..].iter().collect()
    };
    out["uia"] = json!(true);
    out["role"] = json!(role);
    out["name"] = json!(tree::truncate(&text(UIA_NamePropertyId), tree::NAME_MAX));
    out["editable"] = json!(is_editable(role, has_value, readonly, has_text_edit, password));
    out["password"] = json!(password);
    out["valueTail"] = json!(tail);
    // Where to show the dictation pill: the text caret, else the focused element.
    // SAFETY: current-property read on a live element.
    let rect = unsafe { el.CurrentBoundingRectangle() }.ok().map(Rect::from).filter(|r| !r.is_empty());
    out["rect"] = rect.map_or(Value::Null, Rect::to_json);
    out["caret"] = system_caret().map_or(Value::Null, Rect::to_json);
    Ok(out)
}

/// A caret rect worth showing something next to: some height, not absurdly large.
pub fn caret_from(x: i32, y: i32, w: i32, h: i32) -> Option<Rect> {
    (h > 0 && h <= 400 && (0..=400).contains(&w)).then(|| Rect::new(x, y, w.max(1), h))
}

/// The foreground thread's system caret (Win32 edits, many editors and browsers), in screen px.
fn system_caret() -> Option<Rect> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::WindowsAndMessaging::{
        GUITHREADINFO, GetGUIThreadInfo, GetWindowThreadProcessId,
    };
    let fg = HWND(window::foreground() as *mut _);
    // SAFETY: pure query; a stale handle yields 0.
    let thread = unsafe { GetWindowThreadProcessId(fg, None) };
    if thread == 0 {
        return None;
    }
    let mut gti = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
    // SAFETY: cbSize is set; the out-param is valid.
    unsafe { GetGUIThreadInfo(thread, &mut gti) }.ok()?;
    if gti.hwndCaret.is_invalid() {
        return None;
    }
    let r = gti.rcCaret;
    let mut tl = POINT { x: r.left, y: r.top };
    // SAFETY: valid out-param; the caret window may be gone, which returns false.
    if !unsafe { ClientToScreen(gti.hwndCaret, &mut tl) }.as_bool() {
        return None;
    }
    caret_from(tl.x, tl.y, r.right - r.left, r.bottom - r.top)
}

// ---- focus-changed events --------------------------------------------------

pub mod events;
pub mod watch;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caret_rect_sanity() {
        assert_eq!(caret_from(10, 20, 0, 18), Some(Rect::new(10, 20, 1, 18)));
        assert_eq!(caret_from(10, 20, 2, 0), None);
        assert_eq!(caret_from(10, 20, 2, 2000), None);
    }

    #[test]
    fn editable() {
        assert!(is_editable("edit", false, None, false, false));
        assert!(!is_editable("edit", true, Some(true), false, false));
        assert!(!is_editable("edit", true, Some(false), false, true));
        assert!(is_editable("document", false, None, true, false));
        assert!(is_editable("pane", true, Some(false), false, false));
        assert!(!is_editable("button", true, Some(false), false, false));
    }
}
