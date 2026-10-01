//! Agent-side action policy (defense in depth; main applies its own first).
//! Port of agent/safety.py; both are checked against
//! conformance/fixtures/safety-vectors.json.
//!
//! - URLs: http/https with a host only.
//! - Key combos: no Run/terminal/settings/security shortcuts.
//! - No typing or key combos into terminals or the Run dialog unless the
//!   request carries `allowTerminal: true` (main sets it only after the user
//!   explicitly confirmed).

use crate::proto::AgentError;

pub const TERMINALS: &[&str] = &[
    "cmd.exe",
    "powershell.exe",
    "powershell_ise.exe",
    "pwsh.exe",
    "windowsterminal.exe",
    "conhost.exe",
    "openconsole.exe",
    "wsl.exe",
    "wslhost.exe",
    "bash.exe",
    "mintty.exe",
];

const WIN_ALLOWED: &[&str] = &["d", "tab", "left", "right", "up", "down"];

fn alias(name: &str) -> &str {
    match name {
        "win" | "winleft" | "winright" | "windows" | "super" | "meta" | "cmd" | "command" | "lwin"
        | "rwin" => "win",
        "ctrl" | "ctrlleft" | "ctrlright" | "control" | "lctrl" | "rctrl" | "commandorcontrol"
        | "cmdorctrl" => "ctrl",
        "alt" | "altleft" | "altright" | "option" | "lalt" | "ralt" => "alt",
        "shift" | "shiftleft" | "shiftright" | "lshift" | "rshift" => "shift",
        "esc" | "escape" => "esc",
        "del" | "delete" => "delete",
        "arrowleft" => "left",
        "arrowright" => "right",
        "arrowup" => "up",
        "arrowdown" => "down",
        other => other,
    }
}

/// `"win+r"` → `["win", "r"]`; names lowercased and aliased.
pub fn normalize_combo(combo: &str) -> Vec<String> {
    let parts: Vec<&str> = combo.split('+').filter(|k| !k.trim().is_empty()).collect();
    let parts = if parts.is_empty() && !combo.is_empty() { vec![combo] } else { parts };
    normalize_list(parts)
}

pub fn normalize_list<'a>(keys: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    keys.into_iter().map(|k| alias(&k.trim().to_lowercase()).to_owned()).collect()
}

pub fn denied_combo_reason(keys: &[String]) -> Option<&'static str> {
    let has = |k: &str| keys.iter().any(|x| x == k);
    if has("win") {
        let mut rest: Vec<&str> = keys.iter().map(String::as_str).filter(|k| *k != "win").collect();
        rest.sort_unstable();
        rest.dedup();
        if rest.len() == 1 && WIN_ALLOWED.contains(&rest[0]) {
            return None;
        }
        return Some("Windows-key shortcuts can open Run, terminals or settings");
    }
    if has("ctrl") && has("alt") {
        return Some("Ctrl+Alt shortcuts are blocked");
    }
    if has("ctrl") && has("shift") && has("esc") {
        return Some("Ctrl+Shift+Esc (Task Manager) is blocked");
    }
    None
}

pub fn check_combo(keys: &[String]) -> Result<(), AgentError> {
    match denied_combo_reason(keys) {
        Some(reason) => Err(AgentError::denied(format!("hotkey {} denied: {reason}", keys.join("+")))),
        None => Ok(()),
    }
}

/// Returns the trimmed URL if its scheme is http(s) with a host.
pub fn check_url(url: &str) -> Result<String, AgentError> {
    let u = url.trim();
    if u.is_empty() {
        return Err(AgentError::denied("navigate_url needs an http(s) URL"));
    }
    let scheme = u
        .split_once(':')
        .map(|(s, _)| s)
        .filter(|s| {
            let mut c = s.chars();
            c.next().is_some_and(|f| f.is_ascii_alphabetic())
                && c.all(|ch| ch.is_ascii_alphanumeric() || "+-.".contains(ch))
        })
        .unwrap_or("");
    let rest = &u[scheme.len()..].trim_start_matches(':');
    let netloc = rest.strip_prefix("//").map(|r| r.split(['/', '?', '#']).next().unwrap_or("")).unwrap_or("");
    let lower = scheme.to_ascii_lowercase();
    if !(lower == "http" || lower == "https") || netloc.is_empty() {
        let shown = if scheme.is_empty() { "(none)" } else { scheme };
        return Err(AgentError::denied(format!("URL scheme not allowed: {shown}")));
    }
    Ok(u.to_owned())
}

/// The Win+R dialog: an explorer-owned #32770 with a combo box holding an edit.
pub fn is_run_dialog(cls: &str, exe: &str, children: &[String]) -> bool {
    cls == "#32770"
        && exe == "explorer.exe"
        && children.iter().any(|c| c == "ComboBox")
        && children.iter().any(|c| c == "Edit")
}

pub fn denied_target_reason(exe: &str, cls: &str, children: &[String]) -> Option<String> {
    if TERMINALS.contains(&exe) {
        return Some(format!("target is a terminal ({exe})"));
    }
    if is_run_dialog(cls, exe, children) {
        return Some("target is the Run dialog".into());
    }
    None
}

/// (exe, class, child classes) of a top-level window.
#[cfg(windows)]
pub fn window_target(hwnd: isize) -> (String, String, Vec<String>) {
    use crate::window;
    if hwnd == 0 {
        return Default::default();
    }
    let cls = window::class_name(hwnd);
    let kids = if cls == "#32770" {
        window::child_windows(hwnd).into_iter().map(window::class_name).collect()
    } else {
        vec![]
    };
    (window::process_name(hwnd), cls, kids)
}

#[cfg(windows)]
pub fn window_target_reason(hwnd: isize) -> Option<String> {
    let (exe, cls, kids) = window_target(hwnd);
    denied_target_reason(&exe, &cls, &kids)
}

/// E_DENIED when typing/keys would land in a terminal or the Run dialog.
#[cfg(windows)]
pub fn check_input_target(allow_terminal: bool, what: &str) -> Result<(), AgentError> {
    if allow_terminal {
        return Ok(());
    }
    match window_target_reason(crate::window::foreground()) {
        Some(reason) => Err(AgentError::denied(format!("{what} denied: {reason}"))),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../../conformance/fixtures/safety-vectors.json")).unwrap()
    }

    #[test]
    fn combo_vectors() {
        for v in vectors()["combos"].as_array().unwrap() {
            let keys = normalize_combo(v["keys"].as_str().unwrap());
            assert_eq!(denied_combo_reason(&keys).is_some(), v["denied"].as_bool().unwrap(), "{v}");
        }
    }

    #[test]
    fn url_vectors() {
        for v in vectors()["urls"].as_array().unwrap() {
            let r = check_url(v["url"].as_str().unwrap());
            assert_eq!(r.is_ok(), v["allowed"].as_bool().unwrap(), "{v}");
            if let Err(e) = r {
                assert_eq!(e.code, "E_DENIED");
            }
        }
    }

    #[test]
    fn target_vectors() {
        for v in vectors()["targets"].as_array().unwrap() {
            let kids: Vec<String> =
                v["children"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_owned()).collect();
            let r = denied_target_reason(v["exe"].as_str().unwrap(), v["cls"].as_str().unwrap(), &kids);
            assert_eq!(r.is_some(), v["denied"].as_bool().unwrap(), "{v}");
        }
    }

    #[test]
    fn normalize() {
        assert_eq!(normalize_combo("Ctrl+Shift+Escape"), ["ctrl", "shift", "esc"]);
        assert_eq!(normalize_combo("+"), ["+"]);
        assert_eq!(normalize_list(["LWin", "ArrowLeft"]), ["win", "left"]);
    }
}
