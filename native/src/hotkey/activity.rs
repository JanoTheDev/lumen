//! Physical keyboard activity seen by the keyboard hook, for dwell: no dwell progress while
//! a key is held or right after a keystroke. The hook writes lock-free atomics; readers
//! confirm a held key with the async key state so a key-up lost on the secure desktop
//! (Win+L, UAC) cannot block dwell forever.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

pub struct Activity {
    held: [AtomicU64; 4],
    /// Ms since `epoch` of the last physical key event + 1 (0 = never).
    last: AtomicU64,
    epoch: OnceLock<Instant>,
}

impl Activity {
    pub const fn new() -> Self {
        Activity {
            held: [AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)],
            last: AtomicU64::new(0),
            epoch: OnceLock::new(),
        }
    }

    fn now_ms(&self) -> u64 {
        self.epoch.get_or_init(Instant::now).elapsed().as_millis() as u64
    }

    /// A physical (not injected) key event. Called from the hook: atomics only.
    pub fn record(&self, vk: u16, down: bool) {
        let (word, bit) = ((vk as usize >> 6) & 3, 1u64 << (vk & 63));
        if down {
            self.held[word].fetch_or(bit, Ordering::Relaxed);
        } else {
            self.held[word].fetch_and(!bit, Ordering::Relaxed);
        }
        self.last.store(self.now_ms() + 1, Ordering::Relaxed);
    }

    /// True while a key the hook saw go down is still down per `is_down` (async key state).
    pub fn key_held(&self, is_down: impl Fn(u16) -> bool) -> bool {
        for (w, word) in self.held.iter().enumerate() {
            let mut bits = word.load(Ordering::Relaxed);
            while bits != 0 {
                let b = bits.trailing_zeros() as u16;
                bits &= bits - 1;
                let vk = (w as u16) << 6 | b;
                if is_down(vk) {
                    return true;
                }
                // Stale: the key-up never reached the hook.
                word.fetch_and(!(1u64 << b), Ordering::Relaxed);
            }
        }
        false
    }

    /// True when the last physical key event was less than `grace` ago.
    pub fn recent(&self, grace: Duration) -> bool {
        match self.last.load(Ordering::Relaxed) {
            0 => false,
            t => self.now_ms().saturating_sub(t - 1) < grace.as_millis() as u64,
        }
    }

    /// Key held (confirmed by `is_down`) or typed within `grace`.
    pub fn busy(&self, grace: Duration, is_down: impl Fn(u16) -> bool) -> bool {
        self.recent(grace) || self.key_held(is_down)
    }
}

impl Default for Activity {
    fn default() -> Self {
        Self::new()
    }
}

/// `user-activity` pings: at most one per `gap`, so a moving mouse costs a few events a
/// second. Owned by the hook thread (no atomics needed).
#[derive(Debug, Clone, Copy)]
pub struct Pinger {
    gap: Duration,
    last: Option<Instant>,
}

/// At most 4 `user-activity` events a second.
pub const PING_GAP: Duration = Duration::from_millis(250);

impl Pinger {
    pub const fn new(gap: Duration) -> Self {
        Pinger { gap, last: None }
    }

    /// True when a ping may go out at `now` (and records it).
    pub fn hit(&mut self, now: Instant) -> bool {
        if self.last.is_some_and(|t| now.saturating_duration_since(t) < self.gap) {
            return false;
        }
        self.last = Some(now);
        true
    }

    pub fn reset(&mut self) {
        self.last = None;
    }
}

impl Default for Pinger {
    fn default() -> Self {
        Self::new(PING_GAP)
    }
}

/// The hook's activity record (process-wide: there is one keyboard hook).
pub static KEYBOARD: Activity = Activity::new();

/// Async key state of `vk` (true = down now).
pub fn async_down(vk: u16) -> bool {
    #[cfg(windows)]
    {
        // SAFETY: pure query.
        (unsafe { windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(vk as i32) } as u16 & 0x8000)
            != 0
    }
    #[cfg(not(windows))]
    {
        let _ = vk;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn held_keys_are_confirmed_and_stale_ones_dropped() {
        let a = Activity::new();
        assert!(!a.key_held(|_| true));
        a.record(0x41, true);
        a.record(0xA2, true);
        assert!(a.key_held(|vk| vk == 0x41 || vk == 0xA2));
        a.record(0xA2, false);
        assert!(a.key_held(|vk| vk == 0x41));
        // 'A' is not down per the async state: dropped for good.
        assert!(!a.key_held(|_| false));
        assert!(!a.key_held(|_| true));
    }

    #[test]
    fn pings_are_throttled() {
        let mut p = Pinger::new(Duration::from_millis(250));
        let t0 = Instant::now();
        assert!(p.hit(t0));
        assert!(!p.hit(t0 + Duration::from_millis(100)));
        assert!(!p.hit(t0 + Duration::from_millis(249)));
        assert!(p.hit(t0 + Duration::from_millis(250)));
        // 1000 Hz mouse for one second: at most 4 pings.
        let mut p = Pinger::default();
        let n = (0..1000).filter(|i| p.hit(t0 + Duration::from_millis(*i))).count();
        assert_eq!(n, 4);
        p.reset();
        assert!(p.hit(t0 + Duration::from_millis(1000)));
    }

    #[test]
    fn recent_keystroke_window() {
        let a = Activity::new();
        assert!(!a.recent(Duration::from_secs(1)));
        a.record(0x20, true);
        a.record(0x20, false);
        assert!(a.recent(Duration::from_secs(1)));
        assert!(!a.recent(Duration::ZERO));
        assert!(a.busy(Duration::from_secs(1), |_| false));
    }
}
