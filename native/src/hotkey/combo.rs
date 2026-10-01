//! Observe-only `key-combo` names (lesson keypress checks). Pure.
//!
//! Privacy rule: only shortcuts are reported, never typing. A key-down is reported only
//! when Ctrl, Alt or Win is held, or when the key is F1-F24 or Escape. Plain and
//! Shift-only keys are never reported, and neither are Ctrl+Alt (AltGr) + character
//! keys, which type characters on many layouts. The hook skips injected input,
//! auto-repeat and keys it suppressed itself, and reports only while subscribed.

use super::accel::{MOD_ALT, MOD_CTRL, MOD_SHIFT, MOD_WIN, PUNCT, modifier_bit};

const VK_ESCAPE: u16 = 0x1B;

fn is_fkey(vk: u16) -> bool {
    (0x70..=0x87).contains(&vk)
}

/// Letters, digits and OEM punctuation: keys that produce characters.
fn is_char_key(vk: u16) -> bool {
    matches!(vk, 0x30..=0x39 | 0x41..=0x5A | 0xBA..=0xC0 | 0xDB..=0xDF | 0xE2)
}

fn key_label(vk: u16) -> Option<String> {
    let named = match vk {
        0x08 => "Backspace",
        0x09 => "Tab",
        0x0D => "Enter",
        0x1B => "Escape",
        0x20 => "Space",
        0x21 => "PageUp",
        0x22 => "PageDown",
        0x23 => "End",
        0x24 => "Home",
        0x25 => "Left",
        0x26 => "Up",
        0x27 => "Right",
        0x28 => "Down",
        0x2C => "PrintScreen",
        0x2D => "Insert",
        0x2E => "Delete",
        0x6A => "NumMult",
        0x6B => "NumAdd",
        0x6D => "NumSub",
        0x6E => "NumDec",
        0x6F => "NumDiv",
        0xBB => "Plus",
        _ => "",
    };
    if !named.is_empty() {
        return Some(named.into());
    }
    match vk {
        0x30..=0x39 | 0x41..=0x5A => Some((vk as u8 as char).to_string()),
        0x60..=0x69 => Some(format!("Numpad{}", vk - 0x60)),
        0x70..=0x87 => Some(format!("F{}", vk - 0x6F)),
        _ => PUNCT.iter().find(|(_, v)| *v == vk).map(|(c, _)| c.to_string()),
    }
}

/// "Ctrl+Shift+S" for a reportable key-down, None for typing, modifiers and unknown keys.
pub fn combo_name(mods: u8, vk: u16) -> Option<String> {
    if modifier_bit(vk) != 0 {
        return None;
    }
    let command = mods & (MOD_CTRL | MOD_ALT | MOD_WIN) != 0;
    if !command && !is_fkey(vk) && vk != VK_ESCAPE {
        return None;
    }
    let altgr = mods & MOD_CTRL != 0 && mods & MOD_ALT != 0 && mods & MOD_WIN == 0;
    if altgr && is_char_key(vk) {
        return None;
    }
    let mut parts: Vec<String> =
        [(MOD_CTRL, "Ctrl"), (MOD_ALT, "Alt"), (MOD_SHIFT, "Shift"), (MOD_WIN, "Win")]
            .into_iter()
            .filter(|(bit, _)| mods & bit != 0)
            .map(|(_, n)| n.to_owned())
            .collect();
    parts.push(key_label(vk)?);
    Some(parts.join("+"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcuts_are_named() {
        assert_eq!(combo_name(MOD_CTRL, 0x53).as_deref(), Some("Ctrl+S"));
        assert_eq!(combo_name(MOD_CTRL | MOD_SHIFT, 0x4E).as_deref(), Some("Ctrl+Shift+N"));
        assert_eq!(combo_name(MOD_WIN, 0x49).as_deref(), Some("Win+I"));
        assert_eq!(combo_name(MOD_WIN, 0xBB).as_deref(), Some("Win+Plus"));
        assert_eq!(combo_name(MOD_WIN, 0x1B).as_deref(), Some("Win+Escape"));
        assert_eq!(combo_name(MOD_ALT, 0x73).as_deref(), Some("Alt+F4"));
        assert_eq!(combo_name(MOD_CTRL, 0xC0).as_deref(), Some("Ctrl+`"));
        assert_eq!(combo_name(MOD_CTRL, 0x64).as_deref(), Some("Ctrl+Numpad4"));
        assert_eq!(combo_name(MOD_CTRL, 0x0D).as_deref(), Some("Ctrl+Enter"));
        assert_eq!(combo_name(0, 0x74).as_deref(), Some("F5"));
        assert_eq!(combo_name(MOD_SHIFT, 0x74).as_deref(), Some("Shift+F5"));
        assert_eq!(combo_name(0, 0x1B).as_deref(), Some("Escape"));
        assert_eq!(combo_name(MOD_CTRL | MOD_ALT | MOD_WIN, 0x41).as_deref(), Some("Ctrl+Alt+Win+A"));
        assert_eq!(combo_name(MOD_CTRL | MOD_ALT, 0x2E).as_deref(), Some("Ctrl+Alt+Delete"));
    }

    #[test]
    fn typing_is_never_reported() {
        for vk in [0x41, 0x31, 0x20, 0x0D, 0x09, 0x08, 0xBE, 0x25, 0x60] {
            assert_eq!(combo_name(0, vk), None, "plain {vk:#x}");
            assert_eq!(combo_name(MOD_SHIFT, vk), None, "shift {vk:#x}");
        }
        // AltGr (Ctrl+Alt) + character keys type characters (e.g. @ on German layouts).
        for vk in [0x51, 0x32, 0xDB, 0xE2] {
            assert_eq!(combo_name(MOD_CTRL | MOD_ALT, vk), None, "altgr {vk:#x}");
            assert_eq!(combo_name(MOD_CTRL | MOD_ALT | MOD_SHIFT, vk), None);
        }
        assert_eq!(combo_name(MOD_CTRL, 0xA2), None, "modifier alone");
        assert_eq!(combo_name(MOD_CTRL, 0xFF), None, "unknown key");
    }
}
