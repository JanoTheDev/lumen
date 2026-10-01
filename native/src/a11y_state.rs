//! `a11y_state`: which assistive tech is running (port of agent/a11y_state.py).
//!
//! screenReader: "nvda" | "jaws" | "narrator" | "other" | null, from the running
//! processes, then SPI_GETSCREENREADER (set by any screen reader) as "other".
//! voiceControl lists Voice Access / Dragon, which also handle "click 5".

use std::collections::BTreeSet;

use serde_json::{Value, json};

const SCREEN_READERS: &[(&str, &[&str])] =
    &[("nvda", &["nvda.exe"]), ("jaws", &["jfw.exe"]), ("narrator", &["narrator.exe"])];
const VOICE_CONTROL: &[(&str, &[&str])] =
    &[("voice-access", &["voiceaccess.exe"]), ("dragon", &["natspeak.exe", "dragonbar.exe"])];

/// Lowercase process names + the SPI flag → the result. Pure.
pub fn classify(names: &BTreeSet<String>, spi_flag: bool) -> Value {
    let running = |exes: &[&str]| exes.iter().any(|e| names.contains(*e));
    let reader = SCREEN_READERS
        .iter()
        .find(|(_, exes)| running(exes))
        .map(|(id, _)| *id)
        .or(spi_flag.then_some("other"));
    let voice: Vec<&str> =
        VOICE_CONTROL.iter().filter(|(_, exes)| running(exes)).map(|(id, _)| *id).collect();
    json!({"screenReader": reader, "voiceControl": voice})
}

#[cfg(windows)]
fn process_names() -> BTreeSet<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };
    let mut names = BTreeSet::new();
    // SAFETY: the snapshot handle is closed below; the entry is sized as the API requires.
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return names };
        let mut entry =
            PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snap, &mut entry).is_ok();
        while ok {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            names.insert(crate::window::basename_lower(&String::from_utf16_lossy(&entry.szExeFile[..len])));
            ok = Process32NextW(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    names
}

#[cfg(windows)]
pub fn cmd_a11y_state() -> crate::proto::CmdResult {
    Ok(classify(&process_names(), crate::announce::screen_reader_running()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(n: &[&str]) -> BTreeSet<String> {
        n.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn classifies_like_python() {
        assert_eq!(classify(&names(&[]), false), json!({"screenReader": null, "voiceControl": []}));
        assert_eq!(classify(&names(&[]), true)["screenReader"], "other");
        assert_eq!(classify(&names(&["jfw.exe", "nvda.exe"]), true)["screenReader"], "nvda");
        assert_eq!(
            classify(&names(&["narrator.exe", "dragonbar.exe", "voiceaccess.exe"]), false),
            json!({"screenReader": "narrator", "voiceControl": ["voice-access", "dragon"]})
        );
    }
}
