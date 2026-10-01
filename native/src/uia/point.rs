//! `element_at {x, y}`: the control under a physical point, the list item that holds it (a
//! file in File Explorer or an icon on the desktop) and the top-level window it belongs to.
//! Read-only: nothing is clicked, focused or moved. Used by "summarize this file" while the
//! user points at a file.

use serde_json::{Value, json};
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::{GA_ROOT, GetAncestor, WindowFromPoint};

use super::tree::Node;
use super::{Client, com_err, node_of};
use crate::proto::{Args, CmdResult, arg};
use crate::window;

pub const TIMEOUT_MS: u64 = 1500;
/// Ancestors walked from the hit element looking for its list item (Details view: the name
/// text sits two levels under the row).
pub const MAX_ANCESTORS: usize = 5;

/// Index of the list item in a hit chain (the hit element first, then its ancestors), as long
/// as no list / window boundary comes first. Pure.
pub fn pick_item(roles: &[&str]) -> Option<usize> {
    for (i, r) in roles.iter().enumerate().take(MAX_ANCESTORS + 1) {
        match *r {
            "listitem" | "dataitem" | "treeitem" => return Some(i),
            "list" | "tree" | "window" | "pane" | "datagrid" | "table" => return None,
            _ => {}
        }
    }
    None
}

fn node_json(n: &Node) -> Value {
    json!({"role": n.role, "name": n.name, "automationId": n.automation_id, "rect": n.rect.to_json()})
}

pub fn cmd_element_at(args: &Args) -> CmdResult {
    let x = arg::i64(args, "x")? as i32;
    let y = arg::i64(args, "y")? as i32;
    let client = Client::get()?;
    let mons = crate::monitors::enumerate();
    // SAFETY: COM calls on this thread's client; the walker and elements are live.
    let hit = unsafe { client.u.ElementFromPointBuildCache(POINT { x, y }, &client.elem_cr) }
        .map_err(|e| com_err("ElementFromPoint", e))?;
    let walker = unsafe { client.u.ControlViewWalker() }.map_err(|e| com_err("ControlViewWalker", e))?;
    let mut chain = vec![node_of(&hit, &mons)];
    let mut cur = hit;
    for _ in 0..MAX_ANCESTORS {
        let Ok(parent) = (unsafe { walker.GetParentElementBuildCache(&cur, &client.elem_cr) }) else { break };
        chain.push(node_of(&parent, &mons));
        cur = parent;
    }
    let roles: Vec<&str> = chain.iter().map(|n| n.role).collect();
    let item = pick_item(&roles).map(|i| node_json(&chain[i]));
    // SAFETY: pure window queries.
    let root = unsafe {
        let h = WindowFromPoint(POINT { x, y });
        if h.is_invalid() { 0 } else { GetAncestor(h, GA_ROOT).0 as isize }
    };
    let win = window::info(root);
    Ok(json!({
        "element": node_json(&chain[0]),
        "item": item,
        "window": {
            "hwnd": root,
            "className": win["className"],
            "process": win["process"],
            "title": win["title"],
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_row_above_the_name_text() {
        assert_eq!(pick_item(&["edit", "listitem", "list", "pane"]), Some(1));
        assert_eq!(pick_item(&["text", "group", "listitem"]), Some(2));
        assert_eq!(pick_item(&["listitem"]), Some(0));
    }

    #[test]
    fn stops_at_the_list() {
        assert_eq!(pick_item(&["list", "listitem"]), None);
        assert_eq!(pick_item(&["button", "pane", "listitem"]), None);
        assert_eq!(pick_item(&[]), None);
    }

    #[test]
    fn looks_only_a_few_levels_up() {
        let deep = ["text"; MAX_ANCESTORS + 1];
        let mut roles = deep.to_vec();
        roles.push("listitem");
        assert_eq!(pick_item(&roles), None);
    }
}
