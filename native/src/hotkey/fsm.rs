//! Hotkey state machine (pure; driven by low-level hook events).
//!
//! - Modifier state comes from the event stream. A key-up lost while the secure
//!   desktop was up (Win+L, Ctrl+Alt+Del, UAC) leaves it stale, so `resync` drops
//!   modifiers the async key state says are up before each key-down is handled
//!   (modifiers are never suppressed, so their async state is reliable; it is only
//!   used to clear, since it also counts injected keys). A held trigger whose up was
//!   lost is released when its next down comes later than any auto-repeat could
//!   (`stale_after`: the keyboard delay, or Filter Keys' slower repeat, plus a margin).
//! - Trigger down with the exact modifier set: suppress, emit `<down>` once
//!   (autorepeat ignored). The matching trigger up is suppressed too.
//! - `<up>` fires on trigger up or on release of any modifier in the combo.
//! - Modifiers are never suppressed (no stuck modifiers). When a Win combo
//!   fired, the Win release is preceded by a masking key so Start stays shut.
//! - Taps: a modifier pressed and released alone, repeated within the tap
//!   window, yields `hotkey-tap {key, count}` for counts 2 and 3.

use super::accel::{Hotkey, MOD_ALT, MOD_CTRL, MOD_SHIFT, MOD_WIN, modifier_bit};

pub const TAP_WINDOW_MS: u32 = 400;
/// Auto-repeat of a held key comes far faster (the longest keyboard repeat delay is 1 s).
/// The floor of `stale_after`.
pub const STALE_TRIGGER_MS: u32 = 1500;
/// Slack above the slowest repeat gap before a held key counts as stale.
pub const STALE_MARGIN_MS: u32 = 500;

/// Longest gap between a key's down and its next auto-repeat: the keyboard delay
/// (SPI_GETKEYBOARDDELAY 0..3 = 250..1000 ms), or with Filter Keys on its repeat delay and
/// repeat rate (FILTERKEYS iDelayMSec / iRepeatMSec, up to several seconds).
pub fn repeat_gap_ms(keyboard_delay: u32, filter_keys: Option<(u32, u32)>) -> u32 {
    let keyboard = (keyboard_delay.min(3) + 1) * 250;
    let (delay, rate) = filter_keys.unwrap_or((0, 0));
    keyboard.max(delay).max(rate)
}

/// Gap after which a repeated down of a held key means its up was lost.
pub fn stale_after(repeat_gap_ms: u32) -> u32 {
    STALE_TRIGGER_MS.max(repeat_gap_ms.saturating_add(STALE_MARGIN_MS))
}
/// Generic VK per modifier bit, for the async key state.
const MOD_VKS: [(u8, &[u16]); 4] =
    [(MOD_CTRL, &[0x11]), (MOD_ALT, &[0x12]), (MOD_SHIFT, &[0x10]), (MOD_WIN, &[0x5B, 0x5C])];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Binding {
    pub hotkey: Hotkey,
    pub down: &'static str,
    pub up: &'static str,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Config {
    pub bindings: Vec<Binding>,
    pub taps: bool,
    pub accept_injected: bool,
}

impl Config {
    pub fn is_idle(&self) -> bool {
        self.bindings.is_empty() && !self.taps
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyEvent {
    pub vk: u16,
    pub down: bool,
    pub injected: bool,
    /// Milliseconds (hook `time` field; wraps).
    pub time: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Output {
    Emit(&'static str),
    Tap(&'static str, u32),
    /// Inject a harmless key tap now (Win is held) so its release does not open Start.
    MaskWin,
}

#[derive(Debug, Default)]
pub struct Fsm {
    config: Config,
    mods: u8,
    /// Index of the binding currently held.
    active: Option<usize>,
    /// Trigger VK whose key-up must still be swallowed.
    swallow_up: Option<u16>,
    /// Hook time of the active trigger's last down.
    active_at: u32,
    /// `stale_after` for the current repeat settings (0 = STALE_TRIGGER_MS).
    stale_ms: u32,
    /// Modifier pressed with nothing else since: (bit, down time).
    tap_pending: Option<(u8, u32)>,
    /// Last completed tap: (bit, up time, count).
    last_tap: Option<(u8, u32, u32)>,
}

fn tap_name(bit: u8) -> &'static str {
    match bit {
        MOD_CTRL => "ctrl",
        MOD_ALT => "alt",
        MOD_SHIFT => "shift",
        MOD_WIN => "win",
        _ => "?",
    }
}

impl Fsm {
    pub fn new(config: Config) -> Self {
        Fsm { config, ..Default::default() }
    }

    /// Replaces the bindings. A held combo is released (`<up>` emitted) if it changed.
    pub fn configure(&mut self, config: Config) -> Vec<Output> {
        let mut out = vec![];
        if let Some(i) = self.active
            && config.bindings.get(i) != self.config.bindings.get(i)
        {
            out.push(Output::Emit(self.config.bindings[i].up));
            self.active = None;
        }
        self.config = config;
        out
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub fn mods(&self) -> u8 {
        self.mods
    }

    /// The system's slowest auto-repeat gap (see `repeat_gap_ms`).
    pub fn set_repeat_gap(&mut self, ms: u32) {
        self.stale_ms = stale_after(ms);
    }

    /// Before a key-down: drops modifiers `is_down` (async key state) says are up and
    /// releases a held trigger whose up was lost. Returns `<up>` emits for released combos.
    pub fn resync(&mut self, ev: KeyEvent, is_down: &dyn Fn(u16) -> bool) -> Vec<Output> {
        let mut out = vec![];
        if !ev.down || (ev.injected && !self.config.accept_injected) || modifier_bit(ev.vk) != 0 {
            return out;
        }
        for (bit, vks) in MOD_VKS {
            if self.mods & bit != 0 && !vks.iter().any(|vk| is_down(*vk)) {
                self.mods &= !bit;
                self.tap_pending = None;
                if let Some(i) = self.active
                    && self.config.bindings[i].hotkey.mods & bit != 0
                {
                    self.active = None;
                    out.push(Output::Emit(self.config.bindings[i].up));
                }
            }
        }
        if let Some(i) = self.active
            && self.config.bindings[i].hotkey.vk == ev.vk
            && ev.time.wrapping_sub(self.active_at) > self.stale_ms.max(STALE_TRIGGER_MS)
        {
            self.active = None;
            self.swallow_up = None;
            out.push(Output::Emit(self.config.bindings[i].up));
        }
        out
    }

    /// Feeds one event. Returns (suppress, outputs).
    pub fn step(&mut self, ev: KeyEvent) -> (bool, Vec<Output>) {
        let mut out = vec![];
        if ev.injected && !self.config.accept_injected {
            return (false, out);
        }
        let bit = modifier_bit(ev.vk);
        if bit != 0 {
            self.modifier(bit, ev, &mut out);
            return (false, out);
        }

        // Any other key cancels a pending tap sequence.
        if ev.down {
            self.tap_pending = None;
            self.last_tap = None;
        }

        if ev.down {
            if let Some(i) = self.active
                && self.config.bindings[i].hotkey.vk == ev.vk
            {
                self.active_at = ev.time;
                return (true, out); // autorepeat
            }
            if self.active.is_none()
                && let Some(i) = self
                    .config
                    .bindings
                    .iter()
                    .position(|b| b.hotkey.vk == ev.vk && b.hotkey.mods == self.mods)
            {
                self.active = Some(i);
                self.active_at = ev.time;
                self.swallow_up = Some(ev.vk);
                out.push(Output::Emit(self.config.bindings[i].down));
                if self.mods & MOD_WIN != 0 {
                    out.push(Output::MaskWin);
                }
                return (true, out);
            }
            return (false, out);
        }

        // Key up.
        if self.swallow_up == Some(ev.vk) {
            self.swallow_up = None;
            if let Some(i) = self.active.take() {
                out.push(Output::Emit(self.config.bindings[i].up));
            }
            return (true, out);
        }
        (false, out)
    }

    fn modifier(&mut self, bit: u8, ev: KeyEvent, out: &mut Vec<Output>) {
        if ev.down {
            let repeat = self.mods & bit != 0;
            self.mods |= bit;
            if !repeat {
                // A tap needs the modifier alone.
                self.tap_pending = if self.mods == bit { Some((bit, ev.time)) } else { None };
                if self.mods != bit {
                    self.last_tap = None;
                }
            }
            return;
        }

        self.mods &= !bit;
        if let Some(i) = self.active
            && self.config.bindings[i].hotkey.mods & bit != 0
        {
            self.active = None;
            out.push(Output::Emit(self.config.bindings[i].up));
        }

        if self.config.taps
            && let Some((pbit, t_down)) = self.tap_pending.take()
            && pbit == bit
            && ev.time.wrapping_sub(t_down) <= TAP_WINDOW_MS
        {
            let count = match self.last_tap {
                Some((lbit, t_up, n)) if lbit == bit && ev.time.wrapping_sub(t_up) <= TAP_WINDOW_MS => n + 1,
                _ => 1,
            };
            self.last_tap = if count >= 3 { None } else { Some((bit, ev.time, count)) };
            if count >= 2 {
                out.push(Output::Tap(tap_name(bit), count));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::accel::{VK_LCONTROL, VK_LSHIFT, VK_LWIN, VK_RCONTROL, parse};
    use super::*;

    const SPACE: u16 = 0x20;

    fn fsm(accel: &str) -> Fsm {
        Fsm::new(Config {
            bindings: vec![Binding { hotkey: parse(accel).unwrap(), down: "hotkey-down", up: "hotkey-up" }],
            taps: false,
            accept_injected: false,
        })
    }

    fn ev(vk: u16, down: bool, time: u32) -> KeyEvent {
        KeyEvent { vk, down, injected: false, time }
    }

    fn emits(out: &[Output]) -> Vec<&'static str> {
        out.iter()
            .filter_map(|o| match o {
                Output::Emit(e) => Some(*e),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn press_hold_release_trigger_first() {
        let mut f = fsm("Ctrl+Shift+Space");
        assert_eq!(f.step(ev(VK_LCONTROL, true, 0)), (false, vec![]));
        assert_eq!(f.step(ev(VK_LSHIFT, true, 0)), (false, vec![]));
        let (s, o) = f.step(ev(SPACE, true, 0));
        assert!(s);
        assert_eq!(emits(&o), ["hotkey-down"]);
        for _ in 0..5 {
            assert_eq!(f.step(ev(SPACE, true, 0)), (true, vec![]));
        }
        let (s, o) = f.step(ev(SPACE, false, 0));
        assert!(s);
        assert_eq!(emits(&o), ["hotkey-up"]);
        assert_eq!(f.step(ev(VK_LSHIFT, false, 0)), (false, vec![]));
        assert_eq!(f.step(ev(VK_LCONTROL, false, 0)), (false, vec![]));
    }

    #[test]
    fn modifier_release_ends_press_and_trigger_up_is_still_swallowed() {
        let mut f = fsm("Ctrl+Space");
        f.step(ev(VK_RCONTROL, true, 0));
        f.step(ev(SPACE, true, 0));
        let (s, o) = f.step(ev(VK_RCONTROL, false, 0));
        assert!(!s, "modifiers are never suppressed");
        assert_eq!(emits(&o), ["hotkey-up"]);
        let (s, o) = f.step(ev(SPACE, false, 0));
        assert!(s);
        assert!(o.is_empty());
        // Plain space now passes through.
        assert_eq!(f.step(ev(SPACE, true, 0)), (false, vec![]));
    }

    #[test]
    fn exact_modifier_match_only() {
        let mut f = fsm("Ctrl+Space");
        f.step(ev(VK_LCONTROL, true, 0));
        f.step(ev(VK_LSHIFT, true, 0));
        assert_eq!(f.step(ev(SPACE, true, 0)), (false, vec![]));
        assert_eq!(f.step(ev(SPACE, false, 0)), (false, vec![]));
        let mut f = fsm("Ctrl+Space");
        assert_eq!(f.step(ev(SPACE, true, 0)), (false, vec![]));
    }

    #[test]
    fn injected_events_are_ignored_unless_accepted() {
        let mut f = fsm("F9");
        let inj = KeyEvent { vk: 0x78, down: true, injected: true, time: 0 };
        assert_eq!(f.step(inj), (false, vec![]));
        let mut cfg = f.config().clone();
        cfg.accept_injected = true;
        f.configure(cfg);
        assert!(f.step(inj).0);
    }

    #[test]
    fn win_combo_masks_start_menu() {
        let mut f = fsm("Super+Space");
        f.step(ev(VK_LWIN, true, 0));
        let (_, o) = f.step(ev(SPACE, true, 0));
        assert_eq!(o, vec![Output::Emit("hotkey-down"), Output::MaskWin]);
        f.step(ev(SPACE, false, 0));
        assert_eq!(f.step(ev(VK_LWIN, false, 0)), (false, vec![]));
    }

    #[test]
    fn two_bindings() {
        let mut f = Fsm::new(Config {
            bindings: vec![
                Binding { hotkey: parse("Ctrl+Alt+F23").unwrap(), down: "hotkey-down", up: "hotkey-up" },
                Binding {
                    hotkey: parse("Ctrl+Alt+F22").unwrap(),
                    down: "dictation-down",
                    up: "dictation-up",
                },
            ],
            ..Default::default()
        });
        f.step(ev(VK_LCONTROL, true, 0));
        f.step(ev(0xA4, true, 0));
        assert_eq!(emits(&f.step(ev(0x85, true, 0)).1), ["dictation-down"]);
        assert_eq!(emits(&f.step(ev(0x85, false, 0)).1), ["dictation-up"]);
    }

    #[test]
    fn reconfigure_releases_held_combo() {
        let mut f = fsm("F9");
        f.step(ev(0x78, true, 0));
        let o = f.configure(Config::default());
        assert_eq!(emits(&o), ["hotkey-up"]);
    }

    #[test]
    fn resync_drops_modifiers_lost_on_the_secure_desktop() {
        let mut f = fsm("Ctrl+Space");
        f.step(ev(VK_LCONTROL, true, 0));
        // Win+L: the Ctrl up never reaches the hook. Ctrl is up per the async state.
        let up = |_: u16| false;
        assert!(f.resync(ev(SPACE, true, 5000), &up).is_empty());
        assert_eq!(f.mods(), 0);
        assert_eq!(f.step(ev(SPACE, true, 5000)), (false, vec![]), "plain Space is not the hotkey");
        // Modifiers the async state still reports down stay.
        f.step(ev(VK_LCONTROL, true, 6000));
        f.resync(ev(SPACE, true, 6010), &|vk| vk == 0x11);
        assert_eq!(f.mods(), MOD_CTRL);
        // Injected and modifier events never resync.
        f.resync(KeyEvent { vk: SPACE, down: true, injected: true, time: 6020 }, &up);
        f.resync(ev(VK_LSHIFT, true, 6020), &up);
        assert_eq!(f.mods(), MOD_CTRL);
    }

    #[test]
    fn resync_releases_combo_and_lost_trigger_up() {
        let mut f = fsm("Ctrl+Space");
        f.step(ev(VK_LCONTROL, true, 0));
        assert_eq!(emits(&f.step(ev(SPACE, true, 0)).1), ["hotkey-down"]);
        // Auto-repeat keeps it held; a fresh down long after the lost up starts a new press.
        let down = |_: u16| true;
        assert!(f.resync(ev(SPACE, true, 500), &down).is_empty());
        assert_eq!(f.step(ev(SPACE, true, 500)), (true, vec![]));
        assert_eq!(emits(&f.resync(ev(SPACE, true, 9000), &down)), ["hotkey-up"]);
        assert_eq!(emits(&f.step(ev(SPACE, true, 9000)).1), ["hotkey-down"]);
        // Ctrl lost while held: the combo ends.
        assert_eq!(emits(&f.resync(ev(0x41, true, 9100), &|_| false)), ["hotkey-up"]);
    }

    #[test]
    fn slow_filter_keys_repeat_is_not_a_lost_up() {
        assert_eq!(repeat_gap_ms(1, None), 500);
        assert_eq!(repeat_gap_ms(9, None), 1000);
        assert_eq!(repeat_gap_ms(0, Some((2000, 1000))), 2000);
        assert_eq!(repeat_gap_ms(0, Some((500, 3000))), 3000);
        assert_eq!(stale_after(500), STALE_TRIGGER_MS);
        assert_eq!(stale_after(2000), 2500);
        assert_eq!(stale_after(u32::MAX), u32::MAX);

        let mut f = fsm("Ctrl+Space");
        f.set_repeat_gap(repeat_gap_ms(3, Some((2000, 2000))));
        f.step(ev(VK_LCONTROL, true, 0));
        assert_eq!(emits(&f.step(ev(SPACE, true, 0)).1), ["hotkey-down"]);
        let down = |_: u16| true;
        // Filter Keys repeats every 2 s: still the same press.
        assert!(f.resync(ev(SPACE, true, 2000), &down).is_empty());
        assert_eq!(f.step(ev(SPACE, true, 2000)), (true, vec![]));
        assert!(f.resync(ev(SPACE, true, 4000), &down).is_empty());
        f.step(ev(SPACE, true, 4000));
        // Far later than any repeat: the up was lost.
        assert_eq!(emits(&f.resync(ev(SPACE, true, 7000), &down)), ["hotkey-up"]);
    }

    fn tap(f: &mut Fsm, vk: u16, t: u32) -> Vec<Output> {
        f.step(ev(vk, true, t));
        f.step(ev(vk, false, t + 60)).1
    }

    #[test]
    fn double_and_triple_taps() {
        let mut f = Fsm::new(Config { taps: true, ..Default::default() });
        assert!(tap(&mut f, VK_LCONTROL, 0).is_empty());
        assert_eq!(tap(&mut f, VK_LCONTROL, 200), vec![Output::Tap("ctrl", 2)]);
        assert_eq!(tap(&mut f, VK_RCONTROL, 400), vec![Output::Tap("ctrl", 3)]);
        // Sequence restarts after a triple.
        assert!(tap(&mut f, VK_LCONTROL, 600).is_empty());
    }

    #[test]
    fn taps_break_on_other_keys_slow_gaps_and_chords() {
        let mut f = Fsm::new(Config { taps: true, ..Default::default() });
        tap(&mut f, VK_LCONTROL, 0);
        f.step(ev(0x41, true, 100));
        f.step(ev(0x41, false, 120));
        assert!(tap(&mut f, VK_LCONTROL, 200).is_empty());
        assert!(tap(&mut f, VK_LCONTROL, 1000).is_empty(), "gap > window");
        // Held too long is not a tap.
        f.step(ev(VK_LCONTROL, true, 1100));
        assert!(f.step(ev(VK_LCONTROL, false, 1700)).1.is_empty());
        // Ctrl+Shift chord is not a tap.
        f.step(ev(VK_LCONTROL, true, 2000));
        f.step(ev(VK_LSHIFT, true, 2010));
        f.step(ev(VK_LSHIFT, false, 2020));
        assert!(f.step(ev(VK_LCONTROL, false, 2030)).1.is_empty());
        // Taps disabled: nothing.
        let mut g = Fsm::new(Config::default());
        tap(&mut g, VK_LCONTROL, 0);
        assert!(tap(&mut g, VK_LCONTROL, 100).is_empty());
    }
}
