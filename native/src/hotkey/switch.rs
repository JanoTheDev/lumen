//! Switch access keys and mouse buttons (`switch_keys`). Pure; driven by the LL hooks.
//!
//! A switch key or button is suppressed on both down and up and reported as
//! `switch {index, down}` (index into keys, then mouse buttons). Auto-repeat is
//! swallowed silently. Keys match with their exact modifier set, like hotkeys; once a
//! switch is down its up is swallowed whatever the modifiers do. Injected input never
//! reaches this (the hooks skip it).
//!
//! An up can be lost (released on the secure desktop: Win+L, UAC). Mouse buttons never
//! auto-repeat, so a second down while held is reported as release then press. A held
//! key's next down later than any auto-repeat could come (`fsm::stale_after`) is too.

use super::accel::{self, Hotkey};
use super::fsm::{STALE_TRIGGER_MS, stale_after};
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
    /// Hook time of each key's last down.
    down_at: Vec<u32>,
    /// `fsm::stale_after` for the current repeat settings (0 = STALE_TRIGGER_MS).
    stale_ms: u32,
}

/// (suppress, (index, down) reports in order).
pub type Step = (bool, Vec<(usize, bool)>);

impl SwitchFsm {
    /// New switches; any held one is reported released.
    pub fn configure(&mut self, switches: Switches) -> Vec<(usize, bool)> {
        let released = self.held.iter().enumerate().filter(|(_, h)| **h).map(|(i, _)| (i, false)).collect();
        self.held = vec![false; switches.len()];
        self.down_at = vec![0; switches.len()];
        self.switches = switches;
        released
    }

    /// The system's slowest auto-repeat gap (see `fsm::repeat_gap_ms`).
    pub fn set_repeat_gap(&mut self, ms: u32) {
        self.stale_ms = stale_after(ms);
    }

    pub fn has_mouse(&self) -> bool {
        !self.switches.mouse.is_empty()
    }

    /// `lost_up`: a down while held means the up was lost, not an auto-repeat.
    fn press(&mut self, index: usize, down: bool, lost_up: bool) -> Step {
        let was = self.held[index];
        self.held[index] = down;
        match (was, down) {
            (false, true) => (true, vec![(index, true)]),
            (true, true) if lost_up => (true, vec![(index, false), (index, true)]),
            (true, true) => (true, vec![]), // auto-repeat
            (true, false) => (true, vec![(index, false)]),
            (false, false) => (false, vec![]), // a down we never saw
        }
    }

    /// A physical key event with the current modifier set and its hook time (ms).
    pub fn key(&mut self, vk: u16, down: bool, mods: u8, time: u32) -> Step {
        let held = |i: usize| self.held[i];
        let found = self
            .switches
            .keys
            .iter()
            .enumerate()
            .position(|(i, k)| k.vk == vk && (held(i) || (down && k.mods == mods)));
        let Some(i) = found else { return (false, vec![]) };
        let stale = down && time.wrapping_sub(self.down_at[i]) > self.stale_ms.max(STALE_TRIGGER_MS);
        if down {
            self.down_at[i] = time;
        }
        self.press(i, down, stale)
    }

    /// A physical mouse button event (`button` indexes MOUSE_BUTTONS).
    pub fn mouse(&mut self, button: u8, down: bool) -> Step {
        match self.switches.mouse.iter().position(|b| *b == button) {
            Some(i) => self.press(self.switches.keys.len() + i, down, true),
            None => (false, vec![]),
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
        assert_eq!(f.key(SPACE, true, 0, 0), (true, vec![(0, true)]));
        assert_eq!(f.key(SPACE, true, 0, 500), (true, vec![]));
        assert_eq!(f.key(SPACE, true, 0, 530), (true, vec![]));
        assert_eq!(f.key(SPACE, false, 0, 0), (true, vec![(0, false)]));
        assert_eq!(f.key(F8, true, 0, 0), (true, vec![(1, true)]));
        assert_eq!(f.key(F8, false, MOD_CTRL, 0), (true, vec![(1, false)]), "up swallowed whatever the mods");
        assert_eq!(f.key(0x41, true, 0, 0), (false, vec![]));
    }

    #[test]
    fn exact_modifiers_and_stray_ups() {
        let mut f = fsm(&["Space"], &[]);
        assert_eq!(f.key(SPACE, true, MOD_CTRL, 0), (false, vec![]), "Ctrl+Space is not the switch");
        assert_eq!(f.key(SPACE, false, MOD_CTRL, 0), (false, vec![]));
        assert_eq!(f.key(SPACE, false, 0, 0), (false, vec![]), "up without a seen down passes");
    }

    #[test]
    fn mouse_buttons_index_after_keys() {
        let mut f = fsm(&["Space"], &["right", "x1"]);
        assert!(f.has_mouse());
        assert_eq!(f.mouse(1, true), (true, vec![(1, true)]));
        assert_eq!(f.mouse(1, false), (true, vec![(1, false)]));
        assert_eq!(f.mouse(3, true), (true, vec![(2, true)]));
        assert_eq!(f.mouse(0, true), (false, vec![]), "left click untouched");
    }

    #[test]
    fn reconfigure_releases_and_rejects_bad_names() {
        let mut f = fsm(&["Enter"], &["middle"]);
        f.key(0x0D, true, 0, 0);
        f.mouse(2, true);
        assert_eq!(f.configure(Switches::default()), vec![(0, false), (1, false)]);
        assert_eq!(f.key(0x0D, false, 0, 0), (false, vec![]));
        assert!(Switches::parse(&["Bogus"], &[]).is_err());
        assert!(Switches::parse(&[], &["wheel"]).is_err());
    }

    #[test]
    fn lost_ups_end_the_old_press() {
        let mut f = fsm(&["F8"], &["x1"]);
        // A button down while held: its up was lost (secure desktop). Buttons never repeat.
        assert_eq!(f.mouse(3, true), (true, vec![(1, true)]));
        assert_eq!(f.mouse(3, true), (true, vec![(1, false), (1, true)]));
        assert_eq!(f.mouse(3, false), (true, vec![(1, false)]));
        // A key: repeats come quickly; a down long after the last one is a new press.
        assert_eq!(f.key(F8, true, 0, 1000), (true, vec![(0, true)]));
        assert_eq!(f.key(F8, true, 0, 1400), (true, vec![]));
        assert_eq!(f.key(F8, true, 0, 9000), (true, vec![(0, false), (0, true)]));
        // Slow Filter Keys repeat (2 s) stays one press.
        f.set_repeat_gap(2000);
        assert_eq!(f.key(F8, true, 0, 11_000), (true, vec![]));
        assert_eq!(f.key(F8, true, 0, 13_600), (true, vec![(0, false), (0, true)]));
    }
}
