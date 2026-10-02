//! Pure tree shaping for UIA snapshots: pruning and node caps.

use std::collections::VecDeque;

use serde::Serialize;
use serde_json::Value;

use crate::geom::Rect;

pub const MAX_CONTEXT_NODES: usize = 40;
pub const NAME_MAX: usize = 120;
pub const VALUE_MAX: usize = 500;

pub const INTERACTIVE: &[&str] = &[
    "button",
    "edit",
    "combobox",
    "checkbox",
    "radiobutton",
    "menuitem",
    "tabitem",
    "listitem",
    "treeitem",
    "hyperlink",
    "slider",
    "spinner",
    "splitbutton",
    "dataitem",
];
pub const CONTEXT: &[&str] = &["text", "header", "headeritem"];

/// UIA ControlType id → C3 role.
pub fn role_of(control_type: i32) -> &'static str {
    const ROLES: [&str; 41] = [
        "button",
        "calendar",
        "checkbox",
        "combobox",
        "edit",
        "hyperlink",
        "image",
        "listitem",
        "list",
        "menu",
        "menubar",
        "menuitem",
        "progressbar",
        "radiobutton",
        "scrollbar",
        "slider",
        "spinner",
        "statusbar",
        "tab",
        "tabitem",
        "text",
        "toolbar",
        "tooltip",
        "tree",
        "treeitem",
        "custom",
        "group",
        "thumb",
        "datagrid",
        "dataitem",
        "document",
        "splitbutton",
        "window",
        "pane",
        "header",
        "headeritem",
        "table",
        "titlebar",
        "separator",
        "semanticzoom",
        "appbar",
    ];
    usize::try_from(control_type - 50000).ok().and_then(|i| ROLES.get(i)).copied().unwrap_or("custom")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub role: &'static str,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub rect: Rect,
    pub monitor_id: u32,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
    pub patterns: Vec<&'static str>,
    #[serde(skip)]
    pub readonly: Option<bool>,
    /// `Some(true)` on password fields (UIA IsPassword); absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<bool>,
    /// SelectionItem IsSelected on item-like roles; absent when the pattern is missing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
    /// Toggle state "on" / "off" / "mixed"; absent when the pattern is missing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toggled: Option<&'static str>,
    /// ExpandCollapse state; absent on leaf nodes and when the pattern is missing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expanded: Option<bool>,
}

/// Roles whose selection / toggle / expand state is put on snapshot nodes.
pub const STATE_ROLES: &[&str] =
    &["tabitem", "listitem", "treeitem", "checkbox", "radiobutton", "button", "menuitem", "dataitem"];

/// Cached UIA state values of one element (`None` = not supported or not fetched).
#[derive(Debug, Clone, Copy, Default)]
pub struct RawState {
    pub is_selected: Option<bool>,
    /// ToggleState: 0 off, 1 on, 2 indeterminate.
    pub toggle: Option<i32>,
    /// ExpandCollapseState: 0 collapsed, 1 expanded, 2 partially expanded, 3 leaf.
    pub expand: Option<i32>,
}

/// Sets `selected` / `toggled` / `expanded` on a node of a [`STATE_ROLES`] role that
/// supports the matching pattern; other nodes stay without them.
pub fn apply_state(node: &mut Node, raw: RawState) {
    if !STATE_ROLES.contains(&node.role) {
        return;
    }
    let has = |p: &str| node.patterns.contains(&p);
    let selected = if has("select") { raw.is_selected } else { None };
    let toggled = if has("toggle") {
        match raw.toggle {
            Some(0) => Some("off"),
            Some(1) => Some("on"),
            Some(2) => Some("mixed"),
            _ => None,
        }
    } else {
        None
    };
    let expanded = if has("expand") {
        match raw.expand {
            Some(0) => Some(false),
            Some(1) | Some(2) => Some(true),
            _ => None,
        }
    } else {
        None
    };
    node.selected = selected;
    node.toggled = toggled;
    node.expanded = expanded;
}

pub fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// "interactive" / "context" / None for an element in an interactive-only snapshot.
pub fn keep(n: &Node) -> Option<&'static str> {
    if INTERACTIVE.contains(&n.role) {
        return Some("interactive");
    }
    if n.role == "document" && n.patterns.contains(&"value") && n.readonly != Some(true) {
        return Some("interactive");
    }
    if CONTEXT.contains(&n.role) {
        return Some("context");
    }
    None
}

/// A pruned tree: `nodes[0]` is the root; `children[i]` lists kept children of node i in document order.
/// `raws[i]` is the source element of node i. Ids are assigned in pre-order.
pub struct Pruned<R> {
    pub nodes: Vec<Node>,
    pub children: Vec<Vec<usize>>,
    pub raws: Vec<R>,
    /// Pre-order visit sequence of node indices.
    pub order: Vec<usize>,
}

/// Keeps nodes passing [`keep`] (all when `!interactive_only`), up to `max_nodes` in BFS order.
/// Dropped nodes' kept descendants attach to the nearest kept ancestor; siblings stay in
/// document order. `check` runs per visited node (cancellation).
pub fn prune<R, E>(
    root: R,
    children_of: impl Fn(&R) -> Vec<R>,
    info_of: impl Fn(&R) -> Node,
    max_nodes: usize,
    interactive_only: bool,
    mut check: impl FnMut() -> Result<(), E>,
) -> Result<Pruned<R>, E> {
    let mut nodes = vec![info_of(&root)];
    let mut paths: Vec<Vec<usize>> = vec![vec![]];
    let mut children: Vec<Vec<usize>> = vec![vec![]];
    let mut queue: VecDeque<(R, usize, Vec<usize>)> =
        children_of(&root).into_iter().enumerate().map(|(i, c)| (c, 0, vec![i])).collect();
    let mut raws = vec![root];
    let mut context = 0;
    while nodes.len() < max_nodes.max(1) {
        let Some((raw, parent, path)) = queue.pop_front() else { break };
        check()?;
        let node = info_of(&raw);
        let mut kind = if interactive_only { keep(&node) } else { Some("interactive") };
        if kind == Some("context") {
            if context >= MAX_CONTEXT_NODES || node.name.is_empty() {
                kind = None;
            } else {
                context += 1;
            }
        }
        let kids = children_of(&raw);
        let attach_to = if kind.is_some() {
            let idx = nodes.len();
            nodes.push(node);
            paths.push(path.clone());
            children.push(vec![]);
            children[parent].push(idx);
            raws.push(raw);
            idx
        } else {
            parent
        };
        queue.extend(kids.into_iter().enumerate().map(|(i, c)| {
            let mut p = path.clone();
            p.push(i);
            (c, attach_to, p)
        }));
    }
    for kids in &mut children {
        kids.sort_by(|a, b| paths[*a].cmp(&paths[*b]));
    }
    let mut order = Vec::with_capacity(nodes.len());
    let mut stack = vec![0usize];
    while let Some(i) = stack.pop() {
        order.push(i);
        stack.extend(children[i].iter().rev());
    }
    for (n, &i) in order.iter().enumerate() {
        nodes[i].id = format!("e{}", n + 1);
    }
    Ok(Pruned { nodes, children, raws, order })
}

impl<R> Pruned<R> {
    pub fn to_json(&self, i: usize) -> Value {
        let mut v = serde_json::to_value(&self.nodes[i]).unwrap_or_default();
        if !self.children[i].is_empty() {
            v["children"] = Value::Array(self.children[i].iter().map(|&c| self.to_json(c)).collect());
        }
        v
    }

    /// Flat nodes in pre-order, without children.
    pub fn flat(&self) -> Vec<Node> {
        self.order.iter().map(|&i| self.nodes[i].clone()).collect()
    }
}

/// Case-insensitive exact name matches first, then substring matches. `nth` is 1-based.
pub fn find<'a>(
    nodes: &'a [Node],
    name: Option<&str>,
    role: Option<&str>,
    automation_id: Option<&str>,
    nth: Option<usize>,
) -> Vec<&'a Node> {
    let role = role.filter(|r| !r.is_empty()).map(str::to_lowercase);
    let automation_id = automation_id.filter(|a| !a.is_empty());
    let pool: Vec<&Node> = nodes
        .iter()
        .filter(|n| role.as_deref().is_none_or(|r| n.role == r))
        .filter(|n| automation_id.is_none_or(|a| n.automation_id.as_deref() == Some(a)))
        .collect();
    let pool = match name.filter(|n| !n.is_empty()) {
        None => pool,
        Some(q) => {
            let q = q.trim().to_lowercase();
            let (exact, rest): (Vec<&Node>, Vec<&Node>) =
                pool.into_iter().partition(|n| n.name.to_lowercase() == q);
            exact.into_iter().chain(rest.into_iter().filter(|n| n.name.to_lowercase().contains(&q))).collect()
        }
    };
    match nth {
        Some(k) if k >= 1 => pool.into_iter().nth(k - 1).into_iter().collect(),
        Some(_) => vec![],
        None => pool,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct Fake(&'static str, &'static str, Vec<Fake>);

    fn info(f: &Fake) -> Node {
        Node {
            id: String::new(),
            role: f.0,
            name: f.1.into(),
            automation_id: None,
            value: None,
            rect: Rect::new(0, 0, 10, 10),
            monitor_id: 0,
            enabled: true,
            focused: None,
            patterns: vec![],
            readonly: None,
            password: None,
            selected: None,
            toggled: None,
            expanded: None,
        }
    }

    fn run(root: Fake, max: usize, interactive_only: bool) -> Pruned<Fake> {
        prune(root, |f| f.2.clone(), info, max, interactive_only, || Ok::<(), ()>(())).unwrap()
    }

    fn sample() -> Fake {
        Fake(
            "window",
            "W",
            vec![
                Fake("pane", "", vec![Fake("button", "A", vec![]), Fake("text", "label", vec![])]),
                Fake("button", "B", vec![]),
                Fake("group", "", vec![Fake("pane", "", vec![Fake("edit", "E", vec![])])]),
            ],
        )
    }

    #[test]
    fn interactive_attach_to_nearest_kept_ancestor_in_document_order() {
        let p = run(sample(), 400, true);
        let names: Vec<(String, String)> = p.flat().into_iter().map(|n| (n.id, n.name)).collect();
        assert_eq!(
            names,
            vec![
                ("e1".into(), "W".into()),
                ("e2".into(), "A".into()),
                ("e3".into(), "label".into()),
                ("e4".into(), "B".into()),
                ("e5".into(), "E".into())
            ]
        );
        let j = p.to_json(0);
        assert_eq!(j["children"].as_array().unwrap().len(), 4);
        assert!(j["children"][0].get("children").is_none());
        assert!(j.get("readonly").is_none());
        assert!(j.get("automationId").is_none());
    }

    #[test]
    fn max_nodes_is_bfs() {
        // BFS keeps W, then B (depth 1), then A (depth 2); document order puts A before B.
        let p = run(sample(), 3, true);
        let names: Vec<String> = p.flat().into_iter().map(|n| n.name).collect();
        assert_eq!(names, ["W", "A", "B"]);
    }

    #[test]
    fn everything_when_not_interactive_only() {
        assert_eq!(run(sample(), 400, false).nodes.len(), 8);
    }

    #[test]
    fn find_exact_before_substring_and_nth() {
        let p = run(
            Fake(
                "window",
                "",
                vec![
                    Fake("button", "Save as", vec![]),
                    Fake("button", "save", vec![]),
                    Fake("edit", "Save", vec![]),
                ],
            ),
            400,
            true,
        );
        let flat = p.flat();
        let hits: Vec<&str> =
            find(&flat, Some("SAVE"), None, None, None).iter().map(|n| n.name.as_str()).collect();
        assert_eq!(hits, ["save", "Save", "Save as"]);
        assert_eq!(find(&flat, Some("save"), Some("Button"), None, Some(2))[0].name, "Save as");
        assert!(find(&flat, Some("save"), None, None, Some(9)).is_empty());
        assert_eq!(role_of(50000), "button");
        assert_eq!(role_of(12), "custom");
    }

    fn with(role: &'static str, patterns: Vec<&'static str>) -> Node {
        let mut n = info(&Fake(role, "x", vec![]));
        n.patterns = patterns;
        n
    }

    #[test]
    fn state_fields_only_with_pattern_and_role() {
        let raw = RawState { is_selected: Some(true), toggle: Some(1), expand: Some(0) };
        let mut tab = with("tabitem", vec!["select"]);
        apply_state(&mut tab, raw);
        assert_eq!((tab.selected, tab.toggled, tab.expanded), (Some(true), None, None));
        let j = serde_json::to_value(&tab).unwrap();
        assert_eq!(j["selected"], true);
        assert!(j.get("toggled").is_none() && j.get("expanded").is_none());

        let mut cb = with("checkbox", vec!["toggle"]);
        for (t, want) in [(0, Some("off")), (1, Some("on")), (2, Some("mixed")), (7, None)] {
            apply_state(&mut cb, RawState { toggle: Some(t), ..raw });
            assert_eq!(cb.toggled, want);
        }
        apply_state(&mut cb, RawState { toggle: Some(2), ..raw });
        assert_eq!(serde_json::to_value(&cb).unwrap()["toggled"], "mixed");

        let mut tree = with("treeitem", vec!["select", "expand"]);
        for (e, want) in [(0, Some(false)), (1, Some(true)), (2, Some(true)), (3, None)] {
            apply_state(&mut tree, RawState { is_selected: Some(false), expand: Some(e), ..raw });
            assert_eq!((tree.selected, tree.expanded), (Some(false), want));
        }

        // Pattern missing, unsupported value, or a role outside the list: nothing set.
        let mut plain = with("button", vec!["invoke"]);
        apply_state(&mut plain, raw);
        assert_eq!((plain.selected, plain.toggled, plain.expanded), (None, None, None));
        let mut unsupported = with("listitem", vec!["select"]);
        apply_state(&mut unsupported, RawState::default());
        assert_eq!(unsupported.selected, None);
        let mut edit = with("edit", vec!["select", "toggle", "expand"]);
        apply_state(&mut edit, raw);
        let j = serde_json::to_value(&edit).unwrap();
        assert!(j.get("selected").is_none() && j.get("toggled").is_none() && j.get("expanded").is_none());
    }
}
