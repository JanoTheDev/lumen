//! SendInput primitives: clipboard-free unicode typing, VK combos, mouse.
//! Coordinates are physical px (the process is per-monitor-v2 aware).

use std::time::Duration;

use crate::proto::AgentError;
use crate::proto::router::CancelToken;

pub const KEYEVENTF_KEYUP: u32 = 0x0002;
pub const KEYEVENTF_UNICODE: u32 = 0x0004;
pub const KEYEVENTF_EXTENDEDKEY: u32 = 0x0001;
pub const VK_RETURN: u16 = 0x0D;
pub const VK_TAB: u16 = 0x09;

pub const BATCH: usize = 32;
pub const BATCH_PAUSE: Duration = Duration::from_millis(2);

/// Tag on every injected event so our own hooks can recognise it.
pub const EXTRA_INFO: usize = 0x4C55_4D4E;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Key {
    pub vk: u16,
    pub scan: u16,
    pub flags: u32,
}

impl Key {
    const fn vk(vk: u16, up: bool) -> Key {
        Key { vk, scan: 0, flags: if up { KEYEVENTF_KEYUP } else { 0 } }
    }
}

/// Text → key events in send order: UTF-16 units as KEYEVENTF_UNICODE pairs,
/// `\n`, `\r\n`, `\r` → Return, `\t` → Tab. Pure.
pub fn text_events(text: &str) -> Vec<Key> {
    let mut out = vec![];
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let vk = match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                Some(VK_RETURN)
            }
            '\n' => Some(VK_RETURN),
            '\t' => Some(VK_TAB),
            _ => None,
        };
        if let Some(vk) = vk {
            out.push(Key::vk(vk, false));
            out.push(Key::vk(vk, true));
            continue;
        }
        let mut buf = [0u16; 2];
        for unit in c.encode_utf16(&mut buf) {
            out.push(Key { vk: 0, scan: *unit, flags: KEYEVENTF_UNICODE });
            out.push(Key { vk: 0, scan: *unit, flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP });
        }
    }
    out
}

/// Keys that need KEYEVENTF_EXTENDEDKEY when sent by VK.
pub fn is_extended(vk: u16) -> bool {
    matches!(vk, 0x21..=0x28 | 0x2C | 0x2D | 0x2E | 0x5B | 0x5C | 0x5D | 0x6F | 0x90 | 0xA3 | 0xA5)
}

/// Press all in order, release in reverse (like a human chord). Pure apart from scan lookup.
pub fn chord_events(vks: &[u16], scan: impl Fn(u16) -> u16) -> Vec<Key> {
    let key = |vk: u16, up: bool| Key {
        vk,
        scan: scan(vk),
        flags: (if up { KEYEVENTF_KEYUP } else { 0 })
            | if is_extended(vk) { KEYEVENTF_EXTENDEDKEY } else { 0 },
    };
    vks.iter().map(|&vk| key(vk, false)).chain(vks.iter().rev().map(|&vk| key(vk, true))).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

impl Button {
    pub fn parse(s: Option<&str>) -> Result<Button, AgentError> {
        match s.unwrap_or("left") {
            "left" => Ok(Button::Left),
            "right" => Ok(Button::Right),
            "middle" => Ok(Button::Middle),
            other => Err(AgentError::invalid(format!("unknown button {other:?}"))),
        }
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetDoubleClickTime, GetKeyboardLayout, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE,
        KEYBD_EVENT_FLAGS, KEYBDINPUT, MAPVK_VK_TO_VSC, MOUSE_EVENT_FLAGS, MOUSEEVENTF_HWHEEL,
        MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
        MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT, MapVirtualKeyW, SendInput,
        VIRTUAL_KEY, VkKeyScanExW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};

    fn kb(k: &Key) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(k.vk),
                    wScan: k.scan,
                    dwFlags: KEYBD_EVENT_FLAGS(k.flags),
                    time: 0,
                    dwExtraInfo: EXTRA_INFO,
                },
            },
        }
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: data as u32,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: EXTRA_INFO,
                },
            },
        }
    }

    /// The INPUT structs `send_keys` would hand to SendInput (used by `--bench`).
    pub fn key_inputs(keys: &[Key]) -> Vec<INPUT> {
        keys.iter().map(kb).collect()
    }

    /// Injects one zero-delta relative mouse move: harmless, measures the SendInput call itself.
    pub fn nudge() -> Result<(), AgentError> {
        use windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_MOVE;
        send(&[mouse(MOUSEEVENTF_MOVE, 0)])
    }

    fn send(inputs: &[INPUT]) -> Result<(), AgentError> {
        if inputs.is_empty() {
            return Ok(());
        }
        // SAFETY: inputs are fully initialised INPUT structs.
        let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize != inputs.len() {
            return Err(AgentError::denied("input was blocked (the focused window may be elevated)"));
        }
        Ok(())
    }

    pub fn send_keys(keys: &[Key], token: &CancelToken) -> Result<(), AgentError> {
        for (i, chunk) in keys.chunks(BATCH).enumerate() {
            token.check()?;
            if i > 0 {
                token.sleep(BATCH_PAUSE)?;
            }
            send(&chunk.iter().map(kb).collect::<Vec<_>>())?;
        }
        Ok(())
    }

    pub fn scan_code(vk: u16) -> u16 {
        // SAFETY: pure query.
        unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) as u16 }
    }

    /// Layout-dependent VK typing for apps that ignore KEYEVENTF_UNICODE (games, some RDP).
    /// Characters with no key on the layout fall back to unicode events.
    pub fn text_events_vk(text: &str, thread: u32) -> Vec<Key> {
        // SAFETY: pure queries.
        let layout = unsafe { GetKeyboardLayout(thread) };
        let mut out = vec![];
        for c in text.chars() {
            let mut units = [0u16; 2];
            let encoded = c.encode_utf16(&mut units);
            let scan = if encoded.len() == 1 && !matches!(c, '\r' | '\n' | '\t') {
                // SAFETY: pure query.
                unsafe { VkKeyScanExW(encoded[0], layout) }
            } else {
                -1
            };
            if scan == -1 {
                out.extend(text_events(&c.to_string()));
                continue;
            }
            let vk = (scan & 0xFF) as u16;
            let shift = (scan >> 8) & 0xFF;
            let mut chord = vec![];
            if shift & 1 != 0 {
                chord.push(0x10);
            }
            if shift & 2 != 0 {
                chord.push(0x11);
            }
            if shift & 4 != 0 {
                chord.push(0x12);
            }
            chord.push(vk);
            out.extend(chord_events(&chord, scan_code));
        }
        out
    }

    pub fn cursor_pos() -> (i32, i32) {
        let mut p = Default::default();
        // SAFETY: out-param is valid.
        let _ = unsafe { GetCursorPos(&mut p) };
        (p.x, p.y)
    }

    pub fn move_to(x: i32, y: i32) -> Result<(), AgentError> {
        // SAFETY: pure call; PMv2 makes these physical px.
        unsafe { SetCursorPos(x, y) }
            .map_err(|e| AgentError::denied(format!("cannot move the pointer: {}", e.message())))
    }

    fn button_flags(b: Button) -> (MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS) {
        match b {
            Button::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            Button::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            Button::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        }
    }

    pub fn button(b: Button, down: bool) -> Result<(), AgentError> {
        let (d, u) = button_flags(b);
        send(&[mouse(if down { d } else { u }, 0)])
    }

    pub fn click(b: Button, count: u32, token: &CancelToken) -> Result<(), AgentError> {
        // SAFETY: pure query.
        let gap = Duration::from_millis((unsafe { GetDoubleClickTime() } / 2).clamp(10, 100) as u64);
        let (d, u) = button_flags(b);
        for i in 0..count {
            if i > 0 {
                token.sleep(gap)?;
            }
            send(&[mouse(d, 0), mouse(u, 0)])?;
        }
        Ok(())
    }

    /// Wheel notches: `dy > 0` scrolls down (content moves up), `dx > 0` scrolls right.
    pub fn scroll(dx: f64, dy: f64) -> Result<(), AgentError> {
        let mut inputs = vec![];
        if dy != 0.0 {
            inputs.push(mouse(MOUSEEVENTF_WHEEL, (-dy * 120.0).round() as i32));
        }
        if dx != 0.0 {
            inputs.push(mouse(MOUSEEVENTF_HWHEEL, (dx * 120.0).round() as i32));
        }
        send(&inputs)
    }
}

#[cfg(windows)]
pub use win::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_and_controls() {
        let ev = text_events("é👋\r\nx\t");
        let units: Vec<u16> =
            ev.iter().filter(|k| k.flags & KEYEVENTF_KEYUP == 0).map(|k| k.scan.max(k.vk)).collect();
        assert_eq!(units, vec![0xE9, 0xD83D, 0xDC4B, VK_RETURN, b'x' as u16, VK_TAB]);
        assert_eq!(ev.len(), 12);
        assert_eq!(text_events("a\rb").len(), 6);
    }

    #[test]
    fn chord_order() {
        let ev = chord_events(&[0x11, 0x26], |_| 7);
        let seq: Vec<(u16, bool)> = ev.iter().map(|k| (k.vk, k.flags & KEYEVENTF_KEYUP != 0)).collect();
        assert_eq!(seq, vec![(0x11, false), (0x26, false), (0x26, true), (0x11, true)]);
        assert_eq!(ev[1].flags & KEYEVENTF_EXTENDEDKEY, KEYEVENTF_EXTENDEDKEY);
        assert_eq!(ev[0].flags & KEYEVENTF_EXTENDEDKEY, 0);
    }
}
