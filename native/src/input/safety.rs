//! Agent-side action policy (defense in depth; main applies its own first).
//! Checked against conformance/fixtures/safety-vectors.json.
//!
//! - URLs: http/https with a host only.
//! - Key combos: no Run/terminal/settings/security shortcuts.
//! - No typing or key combos into terminals or the Run dialog unless the
//!   request carries `allowTerminal: true` (main sets it only after the user
//!   explicitly confirmed). An IDE counts as a terminal while its integrated
//!   terminal has the focus (UIA ClassName / Name of the focused element).
//! - IDEs whose focus UIA cannot see (JetBrains and Android Studio are Swing,
//!   Zed and Fleet draw their own UI): typing works, but no line break and no
//!   Enter right after typing into the same window, since the focus may be their
//!   terminal. Lifted by `allowTerminal`, and by `allowPassword` (the user's own
//!   input: this is a guess about the focus, not a known terminal).
//! - No text into a password field (focused element, or the `set_value` target)
//!   unless the request carries `allowPassword: true` (main sets it only for the
//!   user's own direct input).

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

/// Editors with an integrated terminal: the focused element decides (`denied_focus_reason`).
pub const IDES: &[&str] =
    &["code.exe", "code - insiders.exe", "vscodium.exe", "cursor.exe", "windsurf.exe", "devenv.exe"];

/// IDEs with a terminal tool window whose focused element UIA cannot tell apart.
pub const OPAQUE_IDES: &[&str] = &[
    "idea64.exe",
    "idea.exe",
    "pycharm64.exe",
    "webstorm64.exe",
    "rider64.exe",
    "clion64.exe",
    "goland64.exe",
    "phpstorm64.exe",
    "rubymine64.exe",
    "datagrip64.exe",
    "studio64.exe",
    "zed.exe",
    "fleet.exe",
];

/// Enter this soon after typing into the same opaque-IDE window may run a command.
pub const ENTER_AFTER_TYPE: std::time::Duration = std::time::Duration::from_secs(15);

/// Request overrides, each set by main only after its own checks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Allow {
    pub terminal: bool,
    pub password: bool,
}

/// What would be sent to the focused window.
#[derive(Debug, Clone, Copy)]
pub enum Entry<'a> {
    Text(&'a str),
    Keys(&'a [String]),
}

/// UIA ClassName of a focused terminal: xterm.js (VS Code and its forks), Windows Terminal's
/// control (Visual Studio).
const TERMINAL_FOCUS_CLASSES: &[&str] = &["xterm-helper-textarea", "termcontrol"];

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

/// VS Code names its terminal textarea "Terminal 1, pwsh"; Visual Studio "Terminal".
fn is_terminal_name(name: &str) -> bool {
    let n = name.trim().to_lowercase();
    let starts =
        n.strip_prefix("terminal").is_some_and(|rest| !rest.starts_with(|c: char| c.is_alphanumeric()));
    starts
        || n.match_indices("terminal ")
            .any(|(i, m)| n[i + m.len()..].starts_with(|c: char| c.is_ascii_digit()))
}

/// Typing into an IDE's integrated terminal (by the focused element's class or name).
pub fn denied_focus_reason(exe: &str, focus_class: &str, focus_name: &str) -> Option<String> {
    if !IDES.contains(&exe) && !OPAQUE_IDES.contains(&exe) {
        return None;
    }
    let class = focus_class.trim().to_lowercase();
    if TERMINAL_FOCUS_CLASSES.contains(&class.as_str()) || is_terminal_name(focus_name) {
        return Some(format!("target is the integrated terminal of {exe}"));
    }
    None
}

/// An opaque IDE (see `OPAQUE_IDES`) and the entry would submit a line: text with a line break,
/// or Enter (any modifiers) within `ENTER_AFTER_TYPE` of typing into the same window.
pub fn opaque_ide_reason(exe: &str, entry: Entry, typed_recently: bool) -> Option<String> {
    if !OPAQUE_IDES.contains(&exe) {
        return None;
    }
    let submits = match entry {
        Entry::Text(t) => t.contains(['\n', '\r', '\u{2028}', '\u{2029}']),
        Entry::Keys(keys) => typed_recently && keys.iter().any(|k| k == "enter" || k == "return"),
    };
    submits.then(|| format!("{exe} may have its terminal focused, so no Enter after typing there"))
}

/// Text into a password field without `allowPassword`.
pub fn password_reason(entry: Entry, allow_password: bool, is_password: bool) -> Option<String> {
    (matches!(entry, Entry::Text(_)) && !allow_password && is_password)
        .then(|| "target is a password field".to_owned())
}

/// Whether the last typing (window, time) was into `hwnd` within `ENTER_AFTER_TYPE` of `now`.
pub fn typed_recently(
    last: Option<(isize, std::time::Instant)>,
    hwnd: isize,
    now: std::time::Instant,
) -> bool {
    last.is_some_and(|(h, at)| h == hwnd && now.saturating_duration_since(at) < ENTER_AFTER_TYPE)
}

#[cfg(windows)]
static LAST_TYPED: std::sync::Mutex<Option<(isize, std::time::Instant)>> = std::sync::Mutex::new(None);

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

/// E_DENIED when typing/keys would land in a terminal, the Run dialog or a password field.
#[cfg(windows)]
pub fn check_input_target(allow: Allow, what: &str, entry: Entry) -> Result<(), AgentError> {
    let fg = crate::window::foreground();
    let (exe, cls, kids) = window_target(fg);
    let is_text = matches!(entry, Entry::Text(_));
    let ide = IDES.contains(&exe.as_str()) || OPAQUE_IDES.contains(&exe.as_str());
    // One UIA read of the focused element, only when something depends on it; the client's
    // timeouts bound it. Unreadable focus passes (main's policy checks first).
    let focus =
        ((is_text && !allow.password) || (ide && !allow.terminal)).then(crate::uia::focused_target).flatten();
    let mut reason = password_reason(entry, allow.password, focus.as_ref().is_some_and(|f| f.password));
    if !allow.terminal && reason.is_none() {
        let mut last = LAST_TYPED.lock().unwrap();
        let recent = typed_recently(*last, fg, std::time::Instant::now());
        reason = denied_target_reason(&exe, &cls, &kids)
            .or_else(|| focus.as_ref().and_then(|f| denied_focus_reason(&exe, &f.class, &f.name)))
            .or_else(|| if allow.password { None } else { opaque_ide_reason(&exe, entry, recent) });
        if is_text && reason.is_none() {
            *last = Some((fg, std::time::Instant::now()));
        }
    }
    match reason {
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
    fn ide_terminal_focus() {
        let d = |exe, class, name| denied_focus_reason(exe, class, name).is_some();
        assert!(d("code.exe", "xterm-helper-textarea", ""));
        assert!(d("code.exe", "", "Terminal 1, pwsh"));
        assert!(d("cursor.exe", "", "terminal 2, bash"));
        assert!(d("devenv.exe", "TermControl", ""));
        assert!(d("devenv.exe", "", "Terminal"));
        assert!(!d("code.exe", "inputarea", "Editor content"));
        assert!(!d("code.exe", "", "terminals.ts"));
        assert!(!d("code.exe", "", "The editor is not accessible. Terminal settings"));
        assert!(!d("notepad.exe", "xterm-helper-textarea", "Terminal 1"));
        assert!(!d("code.exe", "", ""));
    }

    #[test]
    fn opaque_ides() {
        assert!(denied_focus_reason("idea64.exe", "", "Terminal").is_some());
        assert!(denied_focus_reason("pycharm64.exe", "SunAwtFrame", "proj - main.py").is_none());
        let enter = vec!["enter".to_owned()];
        let shift_enter = vec!["shift".to_owned(), "return".to_owned()];
        let r = |exe, entry, recent| opaque_ide_reason(exe, entry, recent).is_some();
        assert!(!r("idea64.exe", Entry::Text("let x = 1;"), false), "plain typing works");
        assert!(r("idea64.exe", Entry::Text("rm -rf x\n"), false));
        assert!(r("zed.exe", Entry::Text("a\r\nb"), false));
        assert!(!r("fleet.exe", Entry::Keys(&enter), false), "Enter on its own works");
        assert!(r("fleet.exe", Entry::Keys(&enter), true), "not right after typing");
        assert!(r("studio64.exe", Entry::Keys(&shift_enter), true));
        assert!(!r("code.exe", Entry::Text("a\nb"), true), "VS Code is judged by its focus");
        assert!(!r("notepad.exe", Entry::Keys(&enter), true));
    }

    #[test]
    fn enter_window_is_per_window_and_timed() {
        let t0 = std::time::Instant::now();
        assert!(typed_recently(Some((7, t0)), 7, t0 + std::time::Duration::from_secs(3)));
        assert!(!typed_recently(Some((7, t0)), 8, t0));
        assert!(!typed_recently(Some((7, t0)), 7, t0 + ENTER_AFTER_TYPE));
        assert!(!typed_recently(None, 7, t0));
    }

    #[test]
    fn password_fields() {
        let keys = vec!["ctrl".to_owned(), "v".to_owned()];
        assert!(password_reason(Entry::Text("hunter2"), false, true).is_some());
        assert!(password_reason(Entry::Text("hunter2"), true, true).is_none(), "allowPassword");
        assert!(password_reason(Entry::Text("hi"), false, false).is_none());
        assert!(password_reason(Entry::Keys(&keys), false, true).is_none(), "keys are not text");
    }

    #[test]
    fn normalize() {
        assert_eq!(normalize_combo("Ctrl+Shift+Escape"), ["ctrl", "shift", "esc"]);
        assert_eq!(normalize_combo("+"), ["+"]);
        assert_eq!(normalize_list(["LWin", "ArrowLeft"]), ["win", "left"]);
    }
}
