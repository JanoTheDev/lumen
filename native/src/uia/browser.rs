//! `browser_url {}`: the address of the page in the front browser window, read from its
//! address bar through UIA (the omnibox Edit's value). Used by "summarize this page" when the
//! page's own text is not readable. Nothing is typed or clicked.
//!
//! The foreground window is used when it is a browser, else the front-most browser window.
//! The browser chrome is walked breadth-first in the control view (page Documents are skipped,
//! so fields on the page never count); the address bar is the Edit with AutomationId
//! `urlbar-input` (Firefox), else one named like an address / search bar, else the top-most Edit
//! above the web content.

use std::collections::VecDeque;

use serde_json::json;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Accessibility::*;

use super::{Client, com_err, web_content_child};
use crate::geom::Rect;
use crate::proto::router::CancelToken;
use crate::proto::{AgentError, Args, CmdResult};
use crate::window;

pub const TIMEOUT_MS: u64 = 2000;
/// Elements visited in the browser chrome before giving up.
const MAX_NODES: usize = 800;
const MAX_URL: usize = 4096;

/// One Edit in the browser chrome (pure data for `pick`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cand {
    pub automation_id: String,
    pub name: String,
    /// Top edge in physical px.
    pub top: i32,
}

const ADDRESS_NAMES: &[&str] = &["address", "search bar", "url", "location", "adres", "adresse", "dirección"];

/// Index of the address bar among the chrome's Edits; `content_top` = top of the web content.
pub fn pick(cands: &[Cand], content_top: Option<i32>) -> Option<usize> {
    if let Some(i) = cands.iter().position(|c| c.automation_id == "urlbar-input") {
        return Some(i);
    }
    let named = cands.iter().position(|c| {
        let n = c.name.to_lowercase();
        ADDRESS_NAMES.iter().any(|w| n.contains(w))
    });
    if named.is_some() {
        return named;
    }
    cands
        .iter()
        .enumerate()
        .filter(|(_, c)| content_top.is_none_or(|t| c.top < t))
        .min_by_key(|(_, c)| c.top)
        .map(|(i, _)| i)
}

fn host_like(host: &str) -> bool {
    let h = host.rsplit_once(':').map_or(host, |(h, port)| {
        if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) { h } else { host }
    });
    if h.is_empty() || h.starts_with('.') || h.ends_with('.') || !h.contains('.') {
        return false;
    }
    if !h.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '.') {
        return false;
    }
    let tld = h.rsplit('.').next().unwrap_or("");
    let ipv4 = h.split('.').count() == 4
        && h.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    ipv4 || (tld.chars().count() >= 2 && tld.chars().all(char::is_alphabetic))
}

/// The address-bar text as a web URL: `http(s)://…` as is, a bare `host/path` gets `https://`;
/// search text, `about:` / `chrome://` pages and anything with spaces give None. Pure.
pub fn normalize_url(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.chars().count() > MAX_URL || s.chars().any(char::is_whitespace) {
        return None;
    }
    let lower = s.to_ascii_lowercase();
    if let Some((scheme, rest)) = lower.split_once("://") {
        if scheme == "http" || scheme == "https" {
            let host = rest.split(['/', '?', '#']).next().unwrap_or("");
            return (!host.is_empty()).then(|| s.to_owned());
        }
        return None;
    }
    if lower.contains(':') && !lower.split(['/', '?', '#']).next().unwrap_or("").contains(':') {
        // "about:blank", "mailto:x" … (a scheme without //, not host:port).
        return None;
    }
    let host = s.split(['/', '?', '#']).next().unwrap_or("");
    host_like(host).then(|| format!("https://{s}"))
}

fn control_type(el: &IUIAutomationElement) -> i32 {
    // SAFETY: current-property read on a live element.
    unsafe { el.CurrentControlType() }.map(|c| c.0).unwrap_or(0)
}

fn bstr(r: windows::core::Result<windows::core::BSTR>) -> String {
    r.map(|b| b.to_string()).unwrap_or_default()
}

fn value_of(el: &IUIAutomationElement) -> String {
    // SAFETY: current-property read on a live element.
    unsafe { el.GetCurrentPropertyValue(UIA_ValueValuePropertyId) }
        .ok()
        .and_then(|v| windows::core::BSTR::try_from(&v).ok())
        .map(|b| b.to_string())
        .unwrap_or_default()
}

/// The browser window to read: the foreground one when it is a browser, else the front-most.
fn browser_window() -> Option<isize> {
    let fg = window::foreground();
    if fg != 0 && window::is_browser_process(&window::process_name(fg)) {
        return Some(fg);
    }
    window::find_browser()
}

pub fn cmd_browser_url(_args: &Args, token: &CancelToken) -> CmdResult {
    let hwnd = browser_window().ok_or_else(|| AgentError::not_found("no browser window is open"))?;
    let client = Client::get()?;
    // SAFETY: COM calls on this thread's client and live elements.
    let root = unsafe { client.u.ElementFromHandle(HWND(hwnd as *mut _)) }
        .map_err(|e| com_err("ElementFromHandle", e))?;
    let walker = unsafe { client.u.ControlViewWalker() }.map_err(|e| com_err("ControlViewWalker", e))?;
    let content_top = web_content_child(hwnd).map(|c| window::rect(c).y);

    let mut edits: Vec<(Cand, IUIAutomationElement)> = Vec::new();
    let mut queue = VecDeque::from([root]);
    let mut seen = 0;
    while let Some(el) = queue.pop_front() {
        seen += 1;
        if seen > MAX_NODES {
            break;
        }
        if seen % 50 == 0 {
            token.check()?;
        }
        let ct = control_type(&el);
        if ct == UIA_DocumentControlTypeId.0 {
            continue;
        }
        if ct == UIA_EditControlTypeId.0 {
            // SAFETY: current-property reads on a live element.
            let (automation_id, name, rect) = unsafe {
                (
                    bstr(el.CurrentAutomationId()),
                    bstr(el.CurrentName()),
                    el.CurrentBoundingRectangle().map(Rect::from).unwrap_or_default(),
                )
            };
            edits.push((Cand { automation_id, name, top: rect.y }, el.clone()));
        }
        let mut child = unsafe { walker.GetFirstChildElement(&el) }.ok();
        while let Some(c) = child {
            child = unsafe { walker.GetNextSiblingElement(&c) }.ok();
            queue.push_back(c);
        }
    }
    let cands: Vec<Cand> = edits.iter().map(|(c, _)| c.clone()).collect();
    let url = pick(&cands, content_top).and_then(|i| normalize_url(&value_of(&edits[i].1)));
    Ok(json!({
        "url": url,
        "browser": window::process_name(hwnd),
        "title": window::title(hwnd),
        "hwnd": hwnd,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(id: &str, name: &str, top: i32) -> Cand {
        Cand { automation_id: id.into(), name: name.into(), top }
    }

    #[test]
    fn picks_the_address_bar() {
        let firefox = [cand("", "Search", 40), cand("urlbar-input", "Search or enter address", 80)];
        assert_eq!(pick(&firefox, None), Some(1));
        let chrome = [cand("", "Find", 10), cand("", "Address and search bar", 60)];
        assert_eq!(pick(&chrome, Some(120)), Some(1));
        let unnamed = [cand("", "", 300), cand("", "", 50), cand("", "", 20)];
        assert_eq!(pick(&unnamed, Some(100)), Some(2));
        // Only fields inside the page: no address bar.
        assert_eq!(pick(&[cand("", "", 300)], Some(100)), None);
        assert_eq!(pick(&[], None), None);
    }

    #[test]
    fn normalizes_urls() {
        assert_eq!(normalize_url("https://example.com/a?b=1").as_deref(), Some("https://example.com/a?b=1"));
        assert_eq!(normalize_url(" http://x.org ").as_deref(), Some("http://x.org"));
        assert_eq!(normalize_url("bbc.co.uk/news/world").as_deref(), Some("https://bbc.co.uk/news/world"));
        assert_eq!(normalize_url("example.com:8443/x").as_deref(), Some("https://example.com:8443/x"));
        assert_eq!(normalize_url("93.184.215.14/a").as_deref(), Some("https://93.184.215.14/a"));
        assert_eq!(normalize_url("how to bake bread"), None);
        assert_eq!(normalize_url("weather"), None);
        assert_eq!(normalize_url("about:blank"), None);
        assert_eq!(normalize_url("chrome://newtab/"), None);
        assert_eq!(normalize_url("file:///C:/x.html"), None);
        assert_eq!(normalize_url("https://"), None);
        assert_eq!(normalize_url("version.1"), None);
        assert_eq!(normalize_url(""), None);
    }
}
