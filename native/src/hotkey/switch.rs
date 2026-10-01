//! Switch access keys and mouse buttons (`switch_keys`). Pure; driven by the LL hooks.
//!
//! A switch key or button is suppressed on both down and up and reported as
//! `switch {index, down}` (index into keys, then mouse buttons). Auto-repeat is
//! swallowed silently. Keys match with their exact modifier set, like hotkeys; once a
//! switch is down its up is swallowed whatever the modifiers do. Injected input never
//! reaches this (the hooks skip it).

use super::accel::{self, Hotkey};
use crate::proto::AgentError;

pub const MOUSE_BUTTONS: &[&str] = &["left", "right", "middle", "x1", "x2"];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Switches {
    pub keys: Vec<Hotkey>,
    /// Indexes into MOUSE_BUTTONS.
    pub mouse: Vec<u8>,
}

impl Switches {
    pub fn parse(keys: &[&str], mouse: &[&str]) -> Result<Switches, AgentError> {
        let keys = keys.iter().map(|k| accel::parse(k)).collect::<Result<Vec<_>, _>>()?;
        let mouse = mouse
            .iter()
            .map(|m| {
                let low = m.trim().to_ascii_lowercase();
                MOUSE_BUTTONS
                    .iter()
                    .position(|b| *b == low)
                    .map(|i| i as u8)
                    .ok_or_else(|| AgentError::invalid(format!("unknown mouse button '{m}'")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Switches { keys, mouse })
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty() && self.mouse.is_empty()
    }

    pub fn len(&self) -> usize {
        self.keys.len() + self.mouse.len()
    }
}

#[derive(Debug, Default)]
pub struct SwitchFsm {
    switches: Switches,
    held: Vec<bool>,
}

/// (suppress, Some((index, down)) to report).
pub type Step = (bool, Option<(usize, bool)>);

impl SwitchFsm {
    /// New switches; any held one is reported released.
    pub fn configure(&mut self, switches: Switches) -> Vec<(usize, bool)> {
        let released = self.held.iter().enumerate().filter(|(_, h)| **h).map(|(i, _)| (i, false)).collect();
        self.held = vec![false; switches.len()];
        self.switches = switches;
        released
    }

    pub fn has_mouse(&self) -> bool {
        !self.switches.mouse.is_empty()
    }

    fn press(&mut self, index: usize, down: bool) -> Step {
        let was = self.held[index];
        self.held[index] = down;
        match (was, down) {
            (false, true) => (true, Some((index, true))),
            (true, true) => (true, None), // auto-repeat
            (true, false) => (true, Some((index, false))),
            (false, false) => (false, None), // a down we never saw
        }
    }

    /// A physical key event with the current modifier set.
    pub fn key(&mut self, vk: u16, down: bool, mods: u8) -> Step {
        let held = |i: usize| self.held[i];
        let found = self
            .switches
            .keys
            .iter()
            .enumerate()
            .position(|(i, k)| k.vk == vk && (held(i) || (down && k.mods == mods)));
        match found {
            Some(i) => self.press(i, down),
            None => (false, None),
        }
    }

    /// A physical mouse button event (`button` indexes MOUSE_BUTTONS).
    pub fn mouse(&mut self, button: u8, down: bool) -> Step {
        match self.switches.mouse.iter().position(|b| *b == button) {
            Some(i) => self.press(self.switches.keys.len() + i, down),
            None => (false, None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::accel::MOD_CTRL;
    use super::*;

    const SPACE: u16 = 0x20;
    const F8: u16 = 0x77;

    fn fsm(keys: &[&str], mouse: &[&str]) -> SwitchFsm {
        let mut f = SwitchFsm::default();
        f.configure(Switches::parse(keys, mouse).unwrap());
        f
    }

    #[test]
    fn down_up_suppressed_and_repeat_swallowed() {
        let mut f = fsm(&["Space", "F8"], &[]);
        assert_eq!(f.key(SPACE, true, 0), (true, Some((0, true))));
        assert_eq!(f.key(SPACE, true, 0), (true, None));
        assert_eq!(f.key(SPACE, true, 0), (true, None));
        assert_eq!(f.key(SPACE, false, 0), (true, Some((0, false))));
        assert_eq!(f.key(F8, true, 0), (true, Some((1, true))));
        assert_eq!(f.key(F8, false, MOD_CTRL), (true, Some((1, false))), "up swallowed whatever the mods");
        assert_eq!(f.key(0x41, true, 0), (false, None));
    }

    #[test]
    fn exact_modifiers_and_stray_ups() {
        let mut f = fsm(&["Space"], &[]);
        assert_eq!(f.key(SPACE, true, MOD_CTRL), (false, None), "Ctrl+Space is not the switch");
        assert_eq!(f.key(SPACE, false, MOD_CTRL), (false, None));
        assert_eq!(f.key(SPACE, false, 0), (false, None), "up without a seen down passes");
    }

    #[test]
    fn mouse_buttons_index_after_keys() {
        let mut f = fsm(&["Space"], &["right", "x1"]);
        assert!(f.has_mouse());
        assert_eq!(f.mouse(1, true), (true, Some((1, true))));
        assert_eq!(f.mouse(1, false), (true, Some((1, false))));
        assert_eq!(f.mouse(3, true), (true, Some((2, true))));
        assert_eq!(f.mouse(0, true), (false, None), "left click untouched");
    }

    #[test]
    fn reconfigure_releases_and_rejects_bad_names() {
        let mut f = fsm(&["Enter"], &["middle"]);
        f.key(0x0D, true, 0);
        f.mouse(2, true);
        assert_eq!(f.configure(Switches::default()), vec![(0, false), (1, false)]);
        assert_eq!(f.key(0x0D, false, 0), (false, None));
        assert!(Switches::parse(&["Bogus"], &[]).is_err());
        assert!(Switches::parse(&[], &["wheel"]).is_err());
    }
}
