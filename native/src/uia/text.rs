//! `uia_text {scope, maxChars?, x?, y?}`: text for "read this" / "read the page" through the
//! UIA TextPattern (plans 06 T13).
//!
//! - `selection`: the selected text of the focused text control (or its nearest ancestor with
//!   a TextPattern, e.g. a browser document or the Edge PDF viewer).
//! - `focused`: the focused element's whole text (TextPattern), else its value, else its name.
//! - `document`: the focused document's text, else the first TextPattern element in the
//!   foreground window (browser web content first).
//! - `point`: the paragraph under a physical point (`x`, `y`), else that element's name/value.
//!
//! Password fields never return text.

use serde_json::{Value, json};
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::*;

use super::{Client, com_err, tree, web_content_child};
use crate::proto::router::CancelToken;
use crate::proto::{AgentError, Args, CmdResult, arg};
use crate::window;

pub const DEFAULT_MAX_CHARS: usize = 20_000;
pub const MAX_CHARS: usize = 200_000;
pub const TIMEOUT_MS: u64 = 3000;
/// Ancestors searched for a TextPattern above the focused element.
const MAX_ANCESTORS: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Selection,
    Focused,
    Document,
    Point,
}

pub fn parse_scope(s: Option<&str>) -> Result<Scope, AgentError> {
    match s.unwrap_or("selection") {
        "selection" => Ok(Scope::Selection),
        "focused" => Ok(Scope::Focused),
        "document" => Ok(Scope::Document),
        "point" => Ok(Scope::Point),
        other => Err(AgentError::invalid(format!(
            "scope must be selection, focused, document or point (got {other:?})"
        ))),
    }
}

/// CRLF/CR → LF, NULs and the object replacement char dropped, runs of 3+ newlines cut to 2,
/// trailing spaces trimmed, then clipped to `max` chars. Returns (text, truncated). Pure.
pub fn clean(raw: &str, max: usize) -> (String, bool) {
    let mut out = String::with_capacity(raw.len().min(max * 4));
    let mut newlines = 0;
    let mut chars = 0;
    let mut truncated = false;
    let text = raw.replace("\r\n", "\n").replace('\r', "\n");
    for ch in text.chars() {
        if ch == '\0' || ch == '\u{FFFC}' {
            continue;
        }
        if ch == '\n' {
            newlines += 1;
            if newlines > 2 {
                continue;
            }
            while out.ends_with([' ', '\t']) {
                out.pop();
            }
        } else {
            newlines = 0;
        }
        if chars >= max {
            truncated = true;
            break;
        }
        out.push(ch);
        chars += 1;
    }
    (out.trim().to_owned(), truncated)
}

fn max_chars(args: &Args) -> Result<usize, AgentError> {
    match args.get("maxChars") {
        None | Some(Value::Null) => Ok(DEFAULT_MAX_CHARS),
        Some(Value::Number(n)) if n.as_u64().is_some_and(|n| n >= 1) => {
            Ok((n.as_u64().unwrap() as usize).min(MAX_CHARS))
        }
        _ => Err(AgentError::invalid("maxChars must be a positive integer")),
    }
}

fn prop_bool(el: &IUIAutomationElement, pid: UIA_PROPERTY_ID) -> bool {
    // SAFETY: current-property read on a live element.
    unsafe { el.GetCurrentPropertyValue(pid) }.ok().and_then(|v| bool::try_from(&v).ok()).unwrap_or(false)
}

fn prop_string(el: &IUIAutomationElement, pid: UIA_PROPERTY_ID) -> String {
    // SAFETY: current-property read on a live element.
    unsafe { el.GetCurrentPropertyValue(pid) }
        .ok()
        .and_then(|v| windows::core::BSTR::try_from(&v).ok())
        .map(|b| b.to_string())
        .unwrap_or_default()
}

fn role(el: &IUIAutomationElement) -> &'static str {
    // SAFETY: current-property read on a live element.
    tree::role_of(unsafe { el.CurrentControlType() }.map(|c| c.0).unwrap_or(0))
}

fn text_pattern(el: &IUIAutomationElement) -> Option<IUIAutomationTextPattern> {
    // SAFETY: COM call on a live element; a missing pattern is an error/null.
    unsafe { el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) }.ok()
}

/// The element itself or its nearest control-view ancestor that has a TextPattern.
fn with_text_pattern(
    client: &Client,
    el: &IUIAutomationElement,
) -> Option<(IUIAutomationElement, IUIAutomationTextPattern)> {
    // SAFETY: COM calls on this thread's client and live elements.
    let walker = unsafe { client.u.ControlViewWalker() }.ok()?;
    let mut cur = el.clone();
    for _ in 0..=MAX_ANCESTORS {
        if prop_bool(&cur, UIA_IsTextPatternAvailablePropertyId)
            && let Some(p) = text_pattern(&cur)
        {
            return Some((cur, p));
        }
        cur = unsafe { walker.GetParentElement(&cur) }.ok()?;
    }
    None
}

fn range_text(range: &IUIAutomationTextRange, max: usize) -> String {
    // SAFETY: COM call on a live range. One extra char tells `clean` the text was cut.
    unsafe { range.GetText((max + 1).min(i32::MAX as usize) as i32) }
        .map(|b| b.to_string())
        .unwrap_or_default()
}

fn selection_text(p: &IUIAutomationTextPattern, max: usize) -> String {
    // SAFETY: COM calls on a live pattern.
    let Ok(arr) = (unsafe { p.GetSelection() }) else { return String::new() };
    let n = unsafe { arr.Length() }.unwrap_or(0);
    let mut parts = Vec::new();
    let mut total = 0;
    for i in 0..n {
        let Ok(r) = (unsafe { arr.GetElement(i) }) else { continue };
        let t = range_text(&r, max.saturating_sub(total));
        total += t.chars().count();
        if !t.trim().is_empty() {
            parts.push(t);
        }
        if total > max {
            break;
        }
    }
    parts.join("\n")
}

fn document_text(p: &IUIAutomationTextPattern, max: usize) -> String {
    // SAFETY: COM call on a live pattern.
    unsafe { p.DocumentRange() }.map(|r| range_text(&r, max)).unwrap_or_default()
}

/// First element with a TextPattern in the foreground window (web content first).
fn window_document(client: &Client, hwnd: isize) -> Option<(IUIAutomationElement, IUIAutomationTextPattern)> {
    let root_hwnd = web_content_child(hwnd).unwrap_or(hwnd);
    // SAFETY: COM calls on this thread's client.
    let root = unsafe { client.u.ElementFromHandle(HWND(root_hwnd as *mut _)) }.ok()?;
    if let Some(p) = text_pattern(&root).filter(|_| prop_bool(&root, UIA_IsTextPatternAvailablePropertyId)) {
        return Some((root, p));
    }
    let cond = unsafe {
        client.u.CreatePropertyCondition(UIA_IsTextPatternAvailablePropertyId, &VARIANT::from(true))
    }
    .ok()?;
    let el = unsafe { root.FindFirst(TreeScope_Descendants, &cond) }.ok()?;
    let p = text_pattern(&el)?;
    Some((el, p))
}

struct Found {
    text: String,
    source: &'static str,
    el: Option<IUIAutomationElement>,
}

impl Found {
    fn none() -> Self {
        Found { text: String::new(), source: "none", el: None }
    }
}

/// Value, else name, of an element (never a password).
fn value_or_name(el: &IUIAutomationElement, max: usize) -> Found {
    let value = if prop_bool(el, UIA_IsValuePatternAvailablePropertyId) {
        prop_string(el, UIA_ValueValuePropertyId)
    } else {
        String::new()
    };
    if !value.trim().is_empty() {
        return Found { text: clean(&value, max).0, source: "value", el: Some(el.clone()) };
    }
    let name = prop_string(el, UIA_NamePropertyId);
    if !name.trim().is_empty() {
        return Found { text: clean(&name, max).0, source: "name", el: Some(el.clone()) };
    }
    Found { text: String::new(), source: "none", el: Some(el.clone()) }
}

fn read(scope: Scope, max: usize, pt: Option<(i32, i32)>, token: &CancelToken) -> Result<Found, AgentError> {
    let client = Client::get()?;
    let el = match scope {
        // SAFETY: COM call on this thread's client.
        Scope::Point => {
            let (x, y) = pt.ok_or_else(|| AgentError::invalid("scope point needs x and y"))?;
            unsafe { client.u.ElementFromPoint(POINT { x, y }) }
                .map_err(|e| com_err("ElementFromPoint", e))?
        }
        _ => match unsafe { client.u.GetFocusedElement() } {
            Ok(el) => el,
            Err(e) if scope == Scope::Document => {
                tracing::debug!("uia_text: no focused element ({})", e.message());
                return Ok(window_document(&client, window::foreground())
                    .map(|(el, p)| Found { text: document_text(&p, max), source: "document", el: Some(el) })
                    .unwrap_or_else(Found::none));
            }
            Err(e) => return Err(com_err("GetFocusedElement", e)),
        },
    };
    token.check()?;
    if prop_bool(&el, UIA_IsPasswordPropertyId) {
        return Ok(Found { text: String::new(), source: "password", el: Some(el) });
    }
    let found = with_text_pattern(&client, &el);
    token.check()?;
    Ok(match scope {
        Scope::Selection => match found {
            Some((tel, p)) => {
                let t = selection_text(&p, max);
                if t.trim().is_empty() {
                    Found { text: String::new(), source: "none", el: Some(tel) }
                } else {
                    Found { text: t, source: "selection", el: Some(tel) }
                }
            }
            None => Found { text: String::new(), source: "none", el: Some(el) },
        },
        Scope::Focused => match found {
            Some((tel, p)) => {
                let t = document_text(&p, max);
                if t.trim().is_empty() {
                    value_or_name(&el, max)
                } else {
                    Found { text: t, source: "text", el: Some(tel) }
                }
            }
            None => value_or_name(&el, max),
        },
        Scope::Document => {
            let doc = found.or_else(|| window_document(&client, window::foreground()));
            match doc {
                Some((tel, p)) => Found { text: document_text(&p, max), source: "document", el: Some(tel) },
                None => Found::none(),
            }
        }
        Scope::Point => {
            let (x, y) = pt.unwrap_or_default();
            let para = found.and_then(|(tel, p)| {
                // SAFETY: COM calls on a live pattern and range.
                let r = unsafe { p.RangeFromPoint(POINT { x, y }) }.ok()?;
                unsafe { r.ExpandToEnclosingUnit(TextUnit_Paragraph) }.ok()?;
                let t = range_text(&r, max);
                (!t.trim().is_empty()).then_some(Found { text: t, source: "paragraph", el: Some(tel) })
            });
            para.unwrap_or_else(|| value_or_name(&el, max))
        }
    })
}

pub fn cmd_text(args: &Args, token: &CancelToken) -> CmdResult {
    let scope = parse_scope(arg::opt_str(args, "scope")?)?;
    let max = max_chars(args)?;
    let pt = match (arg::opt_i64(args, "x")?, arg::opt_i64(args, "y")?) {
        (Some(x), Some(y)) => Some((x as i32, y as i32)),
        _ => None,
    };
    let found = read(scope, max, pt, token)?;
    let (text, truncated) = clean(&found.text, max);
    let mut out = json!({"text": text, "source": found.source, "truncated": truncated});
    if let Some(el) = found.el {
        out["role"] = json!(role(&el));
        out["name"] = json!(tree::truncate(prop_string(&el, UIA_NamePropertyId).trim(), tree::NAME_MAX));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes() {
        assert_eq!(parse_scope(None).unwrap(), Scope::Selection);
        assert_eq!(parse_scope(Some("document")).unwrap(), Scope::Document);
        assert_eq!(parse_scope(Some("point")).unwrap(), Scope::Point);
        assert!(parse_scope(Some("page")).is_err());
    }

    #[test]
    fn cleans_text() {
        assert_eq!(clean("a\r\nb\rc", 100), ("a\nb\nc".into(), false));
        assert_eq!(clean("a  \n\n\n\n b", 100), ("a\n\n b".into(), false));
        assert_eq!(clean("x\u{FFFC}y\0z", 100), ("xyz".into(), false));
        assert_eq!(clean("  hello  ", 100), ("hello".into(), false));
    }

    #[test]
    fn clips_by_chars() {
        assert_eq!(clean("héllo wörld", 5), ("héllo".into(), true));
        assert_eq!(clean("abc", 3), ("abc".into(), false));
    }

    #[test]
    fn max_chars_arg() {
        let mut a = Args::new();
        assert_eq!(max_chars(&a).unwrap(), DEFAULT_MAX_CHARS);
        a.insert("maxChars".into(), json!(10));
        assert_eq!(max_chars(&a).unwrap(), 10);
        a.insert("maxChars".into(), json!(10_000_000));
        assert_eq!(max_chars(&a).unwrap(), MAX_CHARS);
        a.insert("maxChars".into(), json!(0));
        assert!(max_chars(&a).is_err());
    }
}
