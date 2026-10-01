//! Electron accelerator parsing ("CommandOrControl+Shift+Space") into a
//! modifier set + virtual-key code. Shared by the hotkey hook and `keys` input.

use crate::proto::AgentError;

pub const MOD_CTRL: u8 = 1;
pub const MOD_ALT: u8 = 2;
pub const MOD_SHIFT: u8 = 4;
pub const MOD_WIN: u8 = 8;

pub const VK_SHIFT: u16 = 0x10;
pub const VK_CONTROL: u16 = 0x11;
pub const VK_MENU: u16 = 0x12;
pub const VK_LWIN: u16 = 0x5B;
pub const VK_RWIN: u16 = 0x5C;
pub const VK_LSHIFT: u16 = 0xA0;
pub const VK_RSHIFT: u16 = 0xA1;
pub const VK_LCONTROL: u16 = 0xA2;
pub const VK_RCONTROL: u16 = 0xA3;
pub const VK_LMENU: u16 = 0xA4;
pub const VK_RMENU: u16 = 0xA5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hotkey {
    pub mods: u8,
    pub vk: u16,
}

impl Hotkey {
    /// Canonical lowercase form ("ctrl+shift+space"), used to compare combos.
    pub fn combo(&self) -> String {
        let mut parts: Vec<&str> = mod_names(self.mods);
        parts.push(key_name(self.vk));
        parts.join("+")
    }
}

pub fn mod_names(mods: u8) -> Vec<&'static str> {
    [(MOD_CTRL, "ctrl"), (MOD_ALT, "alt"), (MOD_SHIFT, "shift"), (MOD_WIN, "win")]
        .into_iter()
        .filter(|(bit, _)| mods & bit != 0)
        .map(|(_, n)| n)
        .collect()
}

/// Modifier bit for a VK (generic or left/right), 0 for other keys.
pub fn modifier_bit(vk: u16) -> u8 {
    match vk {
        VK_CONTROL | VK_LCONTROL | VK_RCONTROL => MOD_CTRL,
        VK_MENU | VK_LMENU | VK_RMENU => MOD_ALT,
        VK_SHIFT | VK_LSHIFT | VK_RSHIFT => MOD_SHIFT,
        VK_LWIN | VK_RWIN => MOD_WIN,
        _ => 0,
    }
}

/// Named keys (lowercase token → VK). Single letters, digits and punctuation are handled separately.
const NAMED: &[(&str, u16)] = &[
    ("space", 0x20),
    ("tab", 0x09),
    ("backspace", 0x08),
    ("delete", 0x2E),
    ("del", 0x2E),
    ("insert", 0x2D),
    ("return", 0x0D),
    ("enter", 0x0D),
    ("up", 0x26),
    ("down", 0x28),
    ("left", 0x25),
    ("right", 0x27),
    ("home", 0x24),
    ("end", 0x23),
    ("pageup", 0x21),
    ("pagedown", 0x22),
    ("escape", 0x1B),
    ("esc", 0x1B),
    ("capslock", 0x14),
    ("numlock", 0x90),
    ("scrolllock", 0x91),
    ("printscreen", 0x2C),
    ("plus", 0xBB),
    ("numadd", 0x6B),
    ("numsub", 0x6D),
    ("nummult", 0x6A),
    ("numdiv", 0x6F),
    ("numdec", 0x6E),
    ("volumeup", 0xAF),
    ("volumedown", 0xAE),
    ("volumemute", 0xAD),
    ("medianexttrack", 0xB0),
    ("mediaprevioustrack", 0xB1),
    ("mediastop", 0xB2),
    ("mediaplaypause", 0xB3),
];

/// US-layout OEM keys for single punctuation characters.
const PUNCT: &[(char, u16)] = &[
    (',', 0xBC),
    ('-', 0xBD),
    ('.', 0xBE),
    ('/', 0xBF),
    (';', 0xBA),
    ('\'', 0xDE),
    ('[', 0xDB),
    (']', 0xDD),
    ('=', 0xBB),
    ('`', 0xC0),
    ('\\', 0xDC),
];

fn modifier_token(low: &str) -> Option<u8> {
    Some(match low {
        "commandorcontrol" | "cmdorctrl" | "control" | "ctrl" => MOD_CTRL,
        "alt" | "option" => MOD_ALT,
        "altgr" => MOD_CTRL | MOD_ALT,
        "shift" => MOD_SHIFT,
        "super" | "meta" | "cmd" | "command" | "win" | "windows" => MOD_WIN,
        _ => return None,
    })
}

/// VK for a non-modifier key token (case-insensitive), None if unknown.
pub fn key_vk(token: &str) -> Option<u16> {
    let low = token.trim().to_ascii_lowercase();
    if let Some((_, vk)) = NAMED.iter().find(|(n, _)| *n == low) {
        return Some(*vk);
    }
    if let Some(n) = low.strip_prefix('f').and_then(|d| d.parse::<u16>().ok())
        && (1..=24).contains(&n)
        && !low[1..].starts_with('0')
    {
        return Some(0x70 + n - 1);
    }
    if let Some(n) = low.strip_prefix("num").and_then(|d| d.parse::<u16>().ok())
        && low.len() == 4
    {
        return Some(0x60 + n);
    }
    let mut chars = low.chars();
    let (Some(c), None) = (chars.next(), chars.next()) else { return None };
    match c {
        'a'..='z' => Some(c.to_ascii_uppercase() as u16),
        '0'..='9' => Some(c as u16),
        _ => PUNCT.iter().find(|(p, _)| *p == c).map(|(_, vk)| *vk),
    }
}

pub fn key_name(vk: u16) -> &'static str {
    const LETTERS: [&str; 26] = [
        "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t",
        "u", "v", "w", "x", "y", "z",
    ];
    const DIGITS: [&str; 10] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
    const FKEYS: [&str; 24] = [
        "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12", "f13", "f14", "f15",
        "f16", "f17", "f18", "f19", "f20", "f21", "f22", "f23", "f24",
    ];
    const NUMS: [&str; 10] = ["num0", "num1", "num2", "num3", "num4", "num5", "num6", "num7", "num8", "num9"];
    match vk {
        0x41..=0x5A => LETTERS[(vk - 0x41) as usize],
        0x30..=0x39 => DIGITS[(vk - 0x30) as usize],
        0x70..=0x87 => FKEYS[(vk - 0x70) as usize],
        0x60..=0x69 => NUMS[(vk - 0x60) as usize],
        _ => NAMED
            .iter()
            .find(|(_, v)| *v == vk)
            .map(|(n, _)| *n)
            .or_else(|| PUNCT.iter().find(|(_, v)| *v == vk).map(|_| "oem"))
            .unwrap_or("?"),
    }
}

fn err(msg: String) -> AgentError {
    AgentError::invalid(msg)
}

/// Parses an Electron accelerator. E_INVALID on bad input.
pub fn parse(accelerator: &str) -> Result<Hotkey, AgentError> {
    let text = accelerator.trim();
    if text.is_empty() {
        return Err(err("empty accelerator".into()));
    }
    let mut tokens: Vec<&str> = text.split('+').collect();
    // A literal '+' key: "Ctrl++" or "+".
    if text == "+" || text.ends_with("++") {
        tokens = text[..text.len() - 1].split('+').collect();
        tokens.pop();
        tokens.push("plus");
    }
    if tokens.iter().any(|t| t.trim().is_empty()) {
        return Err(err(format!("malformed accelerator '{accelerator}'")));
    }
    let mut mods = 0u8;
    let mut vk = None;
    for token in tokens {
        let low = token.trim().to_ascii_lowercase();
        if let Some(bit) = modifier_token(&low) {
            mods |= bit;
        } else if let Some(k) = key_vk(&low) {
            if vk.is_some() {
                return Err(err(format!("accelerator '{accelerator}' has more than one non-modifier key")));
            }
            vk = Some(k);
        } else {
            return Err(err(format!("unknown key '{}'", token.trim())));
        }
    }
    let vk = vk.ok_or_else(|| err(format!("accelerator '{accelerator}' has no non-modifier key")))?;
    Ok(Hotkey { mods, vk })
}

/// True when both accelerators are non-empty and name the same combo.
pub fn same_combo(a: &str, b: &str) -> bool {
    if a.trim().is_empty() || b.trim().is_empty() {
        return false;
    }
    matches!((parse(a), parse(b)), (Ok(x), Ok(y)) if x == y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_table() {
        let cases: &[(&str, u8, u16)] = &[
            ("Ctrl+Shift+Space", MOD_CTRL | MOD_SHIFT, 0x20),
            ("CommandOrControl+Alt+K", MOD_CTRL | MOD_ALT, 0x4B),
            ("CmdOrCtrl+F12", MOD_CTRL, 0x7B),
            ("Alt+Return", MOD_ALT, 0x0D),
            ("Shift+F24", MOD_SHIFT, 0x87),
            ("Ctrl+Plus", MOD_CTRL, 0xBB),
            ("Ctrl++", MOD_CTRL, 0xBB),
            ("+", 0, 0xBB),
            ("Super+Up", MOD_WIN, 0x26),
            ("Meta+Down", MOD_WIN, 0x28),
            ("Ctrl+num5", MOD_CTRL, 0x65),
            ("Ctrl+numadd", MOD_CTRL, 0x6B),
            ("Alt+PageDown", MOD_ALT, 0x22),
            ("ctrl+escape", MOD_CTRL, 0x1B),
            ("Ctrl+/", MOD_CTRL, 0xBF),
            ("F9", 0, 0x78),
            ("Option+1", MOD_ALT, 0x31),
            ("AltGr+E", MOD_CTRL | MOD_ALT, 0x45),
            (" Ctrl + Shift + A ", MOD_CTRL | MOD_SHIFT, 0x41),
        ];
        for (accel, mods, vk) in cases {
            assert_eq!(parse(accel).unwrap(), Hotkey { mods: *mods, vk: *vk }, "{accel}");
        }
    }

    #[test]
    fn rejects_bad() {
        for bad in [
            "",
            "  ",
            "Ctrl+Bogus",
            "Ctrl+Shift",
            "Ctrl+A+B",
            "Ctrl++Shift",
            "+Ctrl",
            "Ctrl+F25",
            "Ctrl+F0",
            "F01",
        ] {
            assert_eq!(parse(bad).unwrap_err().code, "E_INVALID", "{bad}");
        }
    }

    #[test]
    fn combos() {
        assert_eq!(parse("Shift+CmdOrCtrl+space").unwrap().combo(), "ctrl+shift+space");
        assert!(same_combo("Ctrl+Alt+F23", "control+alt+f23"));
        assert!(!same_combo("Ctrl+Alt+F23", ""));
        assert!(!same_combo("Ctrl+Alt+F23", "Ctrl+F23"));
        assert_eq!(key_name(0x6B), "numadd");
    }
}
