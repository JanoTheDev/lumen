//! `announce {text, priority}` (plans CONTRACTS C2): speak through the user's
//! screen reader. Order: NVDA (controller client) → JAWS (FreedomSci.JawsApi)
//! → a UIA notification event from a hidden provider window (Narrator and
//! recent NVDA/JAWS pick these up). Never speaks on the secure desktop.

#[cfg(windows)]
mod jaws;
#[cfg(windows)]
mod nvda;
#[cfg(windows)]
mod uia_notify;

use serde_json::{Value, json};

use crate::proto::{AgentError, Args, CmdResult};

pub const MAX_TEXT: usize = 2000;

/// (text, assertive). Pure.
pub fn parse(args: &Args) -> Result<(String, bool), AgentError> {
    let text = match args.get("text") {
        Some(Value::String(s)) if !s.trim().is_empty() => s.chars().take(MAX_TEXT).collect::<String>(),
        _ => return Err(AgentError::invalid("announce needs non-empty text")),
    };
    let assertive = match args.get("priority") {
        None | Some(Value::Null) => false,
        Some(Value::String(p)) if p == "polite" => false,
        Some(Value::String(p)) if p == "assertive" => true,
        _ => return Err(AgentError::invalid("priority must be \"polite\" or \"assertive\"")),
    };
    Ok((text, assertive))
}

/// The input desktop is the normal one (not the lock screen or a UAC prompt).
#[cfg(windows)]
pub fn input_desktop_is_default() -> bool {
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS, GetUserObjectInformationW,
        OpenInputDesktop, UOI_NAME,
    };
    // SAFETY: the desktop handle is closed before returning; the name buffer is sized correctly.
    unsafe {
        let Ok(desk) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_ACCESS_FLAGS(0)) else {
            return false;
        };
        let mut buf = [0u16; 64];
        let mut needed = 0u32;
        let ok = GetUserObjectInformationW(
            windows::Win32::Foundation::HANDLE(desk.0),
            UOI_NAME,
            Some(buf.as_mut_ptr() as *mut _),
            (buf.len() * 2) as u32,
            Some(&mut needed),
        )
        .is_ok();
        let _ = CloseDesktop(desk);
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        ok && String::from_utf16_lossy(&buf[..len]).eq_ignore_ascii_case("default")
    }
}

/// SPI_GETSCREENREADER: set by Narrator, NVDA, JAWS and other screen readers.
#[cfg(windows)]
pub(crate) fn screen_reader_running() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        SPI_GETSCREENREADER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, SystemParametersInfoW,
    };
    let mut on = windows::core::BOOL(0);
    // SAFETY: out-param is a BOOL as SPI_GETSCREENREADER requires.
    unsafe {
        SystemParametersInfoW(
            SPI_GETSCREENREADER,
            0,
            Some(&mut on as *mut _ as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
        .is_ok()
            && on.as_bool()
    }
}

#[cfg(windows)]
pub fn cmd_announce(args: &Args) -> CmdResult {
    let (text, assertive) = parse(args)?;
    if !input_desktop_is_default() {
        return Ok(json!({"spoken": false, "reason": "secure-desktop"}));
    }
    match nvda::speak(&text, assertive) {
        nvda::Outcome::Spoken => return Ok(json!({"spoken": true, "via": "nvda"})),
        nvda::Outcome::Error(rc) => tracing::debug!("nvda controller error {rc}"),
        nvda::Outcome::NotRunning | nvda::Outcome::NoController => {}
    }
    if jaws::speak(&text, assertive) {
        return Ok(json!({"spoken": true, "via": "jaws"}));
    }
    // Raised regardless (harmless); only claimed as spoken when a screen reader says it is running.
    if uia_notify::raise(&text, assertive)? && screen_reader_running() {
        return Ok(json!({"spoken": true, "via": "uia"}));
    }
    Ok(json!({"spoken": false, "reason": "no-screen-reader"}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses() {
        let a = |v: Value| parse(v.as_object().unwrap());
        assert_eq!(a(json!({"text": "hi"})).unwrap(), ("hi".into(), false));
        assert!(a(json!({"text": "hi", "priority": "assertive"})).unwrap().1);
        assert_eq!(a(json!({"text": "  "})).unwrap_err().code, "E_INVALID");
        assert_eq!(a(json!({"text": "x", "priority": "loud"})).unwrap_err().code, "E_INVALID");
        assert_eq!(a(json!({"text": "x".repeat(5000)})).unwrap().0.len(), MAX_TEXT);
    }
}
