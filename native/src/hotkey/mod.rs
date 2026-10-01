//! Global hotkeys via a `WH_KEYBOARD_LL` hook on a dedicated thread, plus what
//! else needs the low-level hooks: switch keys/buttons (`switch.rs`, with a
//! `WH_MOUSE_LL` hook only while mouse switches are set), observe-only `key-combo`
//! events (`combo.rs`), physical key activity for dwell (`activity.rs`) and throttled
//! `user-activity` pings (any physical key or mouse event, never which key) while subscribed,
//! and a mouse push-to-talk button (`ptt_mouse`) reported as `dictation-down` / `dictation-up`.
//!
//! The hook callbacks only step thread-local state, write atomics and queue events
//! with a non-blocking send; they take no locks shared with other threads. Config
//! is swapped through a channel owned by the hook thread; a posted thread message
//! only wakes it (any process can post one, so its params are never trusted). Each
//! hook is only installed while something needs it, so an idle agent adds no
//! latency to system-wide typing. Injected input (`LLKHF_INJECTED`, or our own
//! `dwExtraInfo` tag) is never suppressed, observed or counted as activity.

pub mod accel;
pub mod activity;
pub mod combo;
pub mod fsm;
pub mod switch;

use std::cell::RefCell;
use std::sync::Mutex;
use std::time::Duration;

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, bounded, unbounded};
use serde_json::json;

use crate::proto::AgentError;
use crate::proto::writer::Out;
use fsm::{Binding, Config, Fsm, Output};
use switch::{SwitchFsm, Switches};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Bound {
    assistant: String,
    dictation: String,
    taps: bool,
    switches: Switches,
    combos: bool,
    activity: bool,
    user_activity: bool,
    ptt_mouse: Option<u8>,
}

/// Everything the hook thread needs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HookConfig {
    pub hotkeys: Config,
    pub switches: Switches,
    /// Report `key-combo` (subscribed).
    pub combos: bool,
    /// Track physical key activity (dwell is on).
    pub activity: bool,
    /// Report `user-activity` (subscribed): needs both hooks.
    pub user_activity: bool,
    /// Mouse push-to-talk button (index into switch::MOUSE_BUTTONS) for dictation.
    pub ptt_mouse: Option<u8>,
}

impl HookConfig {
    pub fn is_idle(&self) -> bool {
        self.hotkeys.is_idle()
            && self.switches.is_empty()
            && !self.combos
            && !self.activity
            && !self.user_activity
            && self.ptt_mouse.is_none()
    }

    /// The mouse hook is only needed for mouse switches, push-to-talk and user-activity.
    pub fn wants_mouse(&self) -> bool {
        !self.switches.mouse.is_empty() || self.user_activity || self.ptt_mouse.is_some()
    }
}

/// The hook thread: its id once it has announced itself, and its config queue.
struct HookThread {
    ready: Receiver<u32>,
    id: Option<u32>,
    configs: Sender<ConfigMsg>,
}

pub struct Service {
    out: Out,
    accept_injected: bool,
    hook: Mutex<Option<HookThread>>,
    bound: Mutex<Bound>,
}

/// What to change; `None` keeps the current value.
#[derive(Debug, Default)]
pub struct Update<'a> {
    pub assistant: Option<&'a str>,
    pub dictation: Option<&'a str>,
    pub taps: Option<bool>,
    pub switches: Option<Switches>,
    pub combos: Option<bool>,
    pub activity: Option<bool>,
    pub user_activity: Option<bool>,
    /// `Some(None)` turns mouse push-to-talk off.
    pub ptt_mouse: Option<Option<u8>>,
}

/// Mouse buttons that may be a push-to-talk button: never left or right (normal clicking).
pub const PTT_BUTTONS: &[&str] = &["middle", "x1", "x2"];

/// "" → off; middle / x1 / x2 → its index into switch::MOUSE_BUTTONS.
pub fn parse_ptt_button(name: &str) -> Result<Option<u8>, AgentError> {
    let low = name.trim().to_ascii_lowercase();
    if low.is_empty() {
        return Ok(None);
    }
    if !PTT_BUTTONS.contains(&low.as_str()) {
        return Err(AgentError::invalid(format!(
            "push-to-talk button must be one of middle, x1, x2 (got '{name}')"
        )));
    }
    Ok(switch::MOUSE_BUTTONS.iter().position(|b| *b == low).map(|i| i as u8))
}

fn parse_opt(accel: &str) -> Result<Option<accel::Hotkey>, AgentError> {
    if accel.trim().is_empty() { Ok(None) } else { accel::parse(accel).map(Some) }
}

impl Service {
    pub fn new(out: Out, accept_injected: bool) -> Self {
        Service { out, accept_injected, hook: Mutex::new(None), bound: Mutex::new(Bound::default()) }
    }

    pub fn assistant(&self) -> String {
        self.bound.lock().unwrap().assistant.clone()
    }

    /// Validates first; on error nothing changes.
    pub fn validate(update: &Update) -> Result<(), AgentError> {
        if let Some(a) = update.assistant {
            parse_opt(a)?;
        }
        if let Some(d) = update.dictation {
            parse_opt(d)?;
        }
        Ok(())
    }

    pub fn apply(&self, update: Update) -> Result<(), AgentError> {
        Self::validate(&update)?;
        let mut bound = self.bound.lock().unwrap();
        let mut next = bound.clone();
        if let Some(a) = update.assistant {
            next.assistant = a.to_owned();
        }
        if let Some(d) = update.dictation {
            next.dictation = d.to_owned();
        }
        if let Some(t) = update.taps {
            next.taps = t;
        }
        if let Some(sw) = update.switches {
            next.switches = sw;
        }
        if let Some(c) = update.combos {
            next.combos = c;
        }
        if let Some(a) = update.activity {
            next.activity = a;
        }
        if let Some(u) = update.user_activity {
            next.user_activity = u;
        }
        if let Some(p) = update.ptt_mouse {
            next.ptt_mouse = p;
        }
        let mut bindings = vec![];
        if let Some(hk) = parse_opt(&next.assistant)? {
            bindings.push(Binding { hotkey: hk, down: "hotkey-down", up: "hotkey-up" });
        }
        if let Some(hk) = parse_opt(&next.dictation)? {
            bindings.push(Binding { hotkey: hk, down: "dictation-down", up: "dictation-up" });
        }
        let config = HookConfig {
            hotkeys: Config { bindings, taps: next.taps, accept_injected: self.accept_injected },
            switches: next.switches.clone(),
            combos: next.combos,
            activity: next.activity,
            user_activity: next.user_activity,
            ptt_mouse: next.ptt_mouse,
        };
        if config.is_idle() && self.hook.lock().unwrap().is_none() {
            *bound = next;
            return Ok(());
        }
        self.send(config)?;
        if next.assistant != bound.assistant {
            tracing::info!("hotkey bound {:?}", next.assistant);
        }
        if next.dictation != bound.dictation {
            tracing::info!("dictation hotkey bound {:?}", next.dictation);
        }
        *bound = next;
        Ok(())
    }

    /// Hands `config` to the hook thread, starting it on first use. A thread that
    /// is slow to start is waited for again on the next call; a dead one is replaced.
    fn send(&self, config: HookConfig) -> Result<(), AgentError> {
        let mut slot = self.hook.lock().unwrap();
        let h = match slot.as_mut() {
            Some(h) => h,
            None => {
                let (configs, rx) = unbounded();
                let ready = hook::spawn(self.out.clone(), rx)
                    .map_err(|e| AgentError::unsupported(format!("keyboard hook thread unavailable: {e}")))?;
                slot.insert(HookThread { ready, id: None, configs })
            }
        };
        let id = match h.id {
            Some(id) => id,
            None => match h.ready.recv_timeout(Duration::from_secs(2)) {
                Ok(id) => *h.id.insert(id),
                Err(RecvTimeoutError::Timeout) => {
                    return Err(AgentError::internal("keyboard hook thread is not ready yet"));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    *slot = None;
                    return Err(AgentError::internal("keyboard hook thread exited"));
                }
            },
        };
        let (tx, rx) = bounded(1);
        if h.configs.send((config, tx)).is_err() {
            *slot = None;
            return Err(AgentError::internal("keyboard hook thread exited"));
        }
        hook::wake(id)?;
        drop(slot);
        rx.recv_timeout(Duration::from_secs(2))
            .map_err(|_| AgentError::internal("keyboard hook thread did not answer"))?
            .map_err(AgentError::internal)
    }
}

type ConfigMsg = (HookConfig, Sender<Result<(), String>>);

thread_local! {
    static HOOK_CTX: RefCell<Option<HookCtx>> = const { RefCell::new(None) };
}

#[derive(Default)]
struct HookCtx {
    fsm: Fsm,
    switch: SwitchFsm,
    /// The push-to-talk button as a one-button switch (suppressed; a down while held means
    /// its up was lost, so it reports release then press).
    ptt: SwitchFsm,
    combos: bool,
    /// Last reported key-down, to skip its auto-repeat.
    combo_vk: Option<u16>,
    user_activity: bool,
    pinger: activity::Pinger,
    /// Hook time the repeat settings were last read (None = read on the next key-down).
    repeat_read_at: Option<u32>,
    out: Option<Out>,
}

/// How often the hook re-reads the keyboard repeat settings while keys are pressed.
const REPEAT_REFRESH_MS: u32 = 5000;

impl HookCtx {
    fn configure(&mut self, config: HookConfig) {
        let out = self.out.clone();
        if let Some(out) = &out {
            deliver(out, self.fsm.configure(config.hotkeys));
            for (index, down) in self.switch.configure(config.switches) {
                emit_switch(out, index, down);
            }
            let ptt = Switches { keys: vec![], mouse: config.ptt_mouse.into_iter().collect() };
            for (_, down) in self.ptt.configure(ptt) {
                emit_ptt(out, down);
            }
        }
        self.combos = config.combos;
        self.combo_vk = None;
        self.user_activity = config.user_activity;
        self.pinger.reset();
        self.repeat_read_at = None;
    }

    /// Keeps the lost-up thresholds in step with the keyboard delay and Filter Keys.
    fn refresh_repeat_gap(&mut self, time: u32) {
        if self.repeat_read_at.is_some_and(|t| time.wrapping_sub(t) < REPEAT_REFRESH_MS) {
            return;
        }
        self.repeat_read_at = Some(time);
        let gap = system_repeat_gap_ms();
        self.fsm.set_repeat_gap(gap);
        self.switch.set_repeat_gap(gap);
    }

    /// A physical key or mouse event: a throttled `user-activity` ping while subscribed.
    fn user_ping(&mut self) {
        if !self.user_activity || !self.pinger.hit(std::time::Instant::now()) {
            return;
        }
        if let Some(out) = &self.out {
            out.try_emit("user-activity", json!({}));
        }
    }

    /// One physical key event; returns whether to suppress it.
    fn key(&mut self, ev: fsm::KeyEvent, is_down: &dyn Fn(u16) -> bool) -> bool {
        let Some(out) = self.out.clone() else { return false };
        self.user_ping();
        if ev.down {
            self.refresh_repeat_gap(ev.time);
        }
        deliver(&out, self.fsm.resync(ev, is_down));
        let (suppress, reports) = self.switch.key(ev.vk, ev.down, self.fsm.mods(), ev.time);
        for (index, down) in reports {
            emit_switch(&out, index, down);
        }
        if suppress {
            return true;
        }
        let (suppress, outputs) = self.fsm.step(ev);
        deliver(&out, outputs);
        if !ev.down {
            if self.combo_vk == Some(ev.vk) {
                self.combo_vk = None;
            }
        } else if self.combos
            && !suppress
            && self.combo_vk != Some(ev.vk)
            && let Some(combo) = combo::combo_name(self.fsm.mods(), ev.vk)
        {
            self.combo_vk = Some(ev.vk);
            out.try_emit("key-combo", json!({"combo": combo}));
        }
        suppress
    }

    /// One physical mouse button event; returns whether to suppress it.
    fn button(&mut self, button: u8, down: bool) -> bool {
        let Some(out) = self.out.clone() else { return false };
        let (suppress, reports) = self.switch.mouse(button, down);
        for (index, down) in reports {
            emit_switch(&out, index, down);
        }
        if suppress {
            return true;
        }
        let (suppress, reports) = self.ptt.mouse(button, down);
        for (_, down) in reports {
            emit_ptt(&out, down);
        }
        suppress
    }
}

/// The slowest auto-repeat gap the keyboard settings allow (`fsm::repeat_gap_ms`).
fn system_repeat_gap_ms() -> u32 {
    #[cfg(windows)]
    {
        use windows::Win32::UI::Accessibility::FILTERKEYS;
        use windows::Win32::UI::WindowsAndMessaging::{
            FKF_FILTERKEYSON, SPI_GETFILTERKEYS, SPI_GETKEYBOARDDELAY, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
            SystemParametersInfoW,
        };
        let none = SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0);
        let mut delay = 3u32;
        let mut fk = FILTERKEYS { cbSize: std::mem::size_of::<FILTERKEYS>() as u32, ..Default::default() };
        // SAFETY: out-params are a u32 (SPI_GETKEYBOARDDELAY) and a sized FILTERKEYS.
        let filter = unsafe {
            if SystemParametersInfoW(SPI_GETKEYBOARDDELAY, 0, Some(&mut delay as *mut _ as *mut _), none)
                .is_err()
            {
                delay = 3;
            }
            SystemParametersInfoW(SPI_GETFILTERKEYS, fk.cbSize, Some(&mut fk as *mut _ as *mut _), none)
                .is_ok()
                && fk.dwFlags & FKF_FILTERKEYSON != 0
        };
        fsm::repeat_gap_ms(delay, filter.then_some((fk.iDelayMSec, fk.iRepeatMSec)))
    }
    #[cfg(not(windows))]
    {
        fsm::repeat_gap_ms(3, None)
    }
}

fn emit_switch(out: &Out, index: usize, down: bool) {
    if !out.try_emit_edge("switch", json!({"index": index, "down": down})) {
        tracing::warn!("dropped switch event: writer queue full");
    }
}

/// Mouse push-to-talk acts like the dictation hotkey (hold, double-tap hands-free).
fn emit_ptt(out: &Out, down: bool) {
    let event = if down { "dictation-down" } else { "dictation-up" };
    if !out.try_emit_edge(event, json!({"source": "mouse"})) {
        tracing::warn!("dropped {event}: writer queue full");
    }
}

fn deliver(out: &Out, outputs: Vec<Output>) {
    for o in outputs {
        match o {
            Output::Emit(event) => {
                if !out.try_emit_edge(event, json!({})) {
                    tracing::warn!("dropped {event}: writer queue full");
                }
            }
            Output::Tap(key, count) => {
                out.try_emit("hotkey-tap", json!({"key": key, "count": count}));
            }
            Output::MaskWin => hook::mask_win(),
        }
    }
}
#[cfg(windows)]
mod hook {
    use super::*;
    use crate::input::sendinput::EXTRA_INFO;
    use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput,
        VIRTUAL_KEY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, HC_ACTION, HHOOK, HOOKPROC, KBDLLHOOKSTRUCT, LLKHF_INJECTED,
        LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE, PeekMessageW, PostThreadMessageW,
        SetWindowsHookExW, UnhookWindowsHookEx, WH_KEYBOARD_LL, WH_MOUSE_LL, WINDOWS_HOOK_ID, WM_APP,
        WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP,
        WM_SYSKEYDOWN, WM_XBUTTONDOWN, WM_XBUTTONUP,
    };

    const WM_CONFIG: u32 = WM_APP + 1;
    /// Unassigned VK used to mask the Win key release (standard trick).
    const VK_MASK: u16 = 0xE8;

    #[derive(Default)]
    struct Hooks {
        keyboard: Option<HHOOK>,
        mouse: Option<HHOOK>,
    }

    /// Starts the hook thread; its id arrives on the returned channel once its queue exists.
    pub fn spawn(out: Out, configs: Receiver<ConfigMsg>) -> std::io::Result<Receiver<u32>> {
        let (tx, rx) = bounded(1);
        std::thread::Builder::new().name("hotkey-hook".into()).spawn(move || {
            let mut msg = MSG::default();
            // SAFETY: creates this thread's message queue before announcing its id.
            unsafe {
                let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
                let _ = tx.send(GetCurrentThreadId());
            }
            HOOK_CTX.with(|c| *c.borrow_mut() = Some(HookCtx { out: Some(out), ..Default::default() }));
            pump(configs);
        })?;
        Ok(rx)
    }

    /// Wakes the hook thread to drain its config queue.
    pub fn wake(thread: u32) -> Result<(), AgentError> {
        // SAFETY: a parameterless thread message; the hook thread ignores wParam/lParam.
        unsafe { PostThreadMessageW(thread, WM_CONFIG, WPARAM(0), LPARAM(0)) }.map_err(Into::into)
    }

    fn pump(configs: Receiver<ConfigMsg>) {
        let mut hooks = Hooks::default();
        let mut msg = MSG::default();
        loop {
            // SAFETY: standard message loop on the thread that owns the hooks.
            let r = unsafe { GetMessageW(&mut msg, None, 0, 0) }.0;
            // 0 is WM_QUIT, -1 an error (looping on it would spin).
            if r == 0 || r == -1 {
                break;
            }
            if msg.message != WM_CONFIG {
                continue;
            }
            while let Ok((config, reply)) = configs.try_recv() {
                let _ = reply.send(apply_config(&mut hooks, config));
            }
        }
        let _ = set_hook(&mut hooks.keyboard, None);
        let _ = set_hook(&mut hooks.mouse, None);
    }

    /// Installs (`Some`) or removes (`None`) one hook; runs on the hook thread.
    fn set_hook(slot: &mut Option<HHOOK>, want: Option<(WINDOWS_HOOK_ID, HOOKPROC)>) -> Result<(), String> {
        match (want, slot.is_some()) {
            (None, true) => {
                if let Some(h) = slot.take() {
                    // SAFETY: the hook was installed by this thread.
                    let _ = unsafe { UnhookWindowsHookEx(h) };
                }
                Ok(())
            }
            (Some((id, proc)), false) => {
                // SAFETY: pure query for this module.
                let module = unsafe { GetModuleHandleW(None) }.ok().map(|m| HINSTANCE(m.0));
                // SAFETY: `proc` is a valid LL hook procedure; this thread pumps messages for it.
                match unsafe { SetWindowsHookExW(id, proc, module, 0) } {
                    Ok(h) => {
                        *slot = Some(h);
                        Ok(())
                    }
                    Err(e) => Err(format!("SetWindowsHookExW failed: {}", e.message())),
                }
            }
            _ => Ok(()),
        }
    }

    /// Runs on the hook thread, which owns the hooks.
    fn apply_config(hooks: &mut Hooks, config: HookConfig) -> Result<(), String> {
        let keyboard = !config.is_idle();
        let mouse = config.wants_mouse();
        HOOK_CTX.with(|c| {
            if let Some(ctx) = c.borrow_mut().as_mut() {
                ctx.configure(config);
            }
        });
        let kb: HOOKPROC = Some(keyboard_proc);
        let ms: HOOKPROC = Some(mouse_proc);
        set_hook(&mut hooks.keyboard, keyboard.then_some((WH_KEYBOARD_LL, kb)))?;
        set_hook(&mut hooks.mouse, mouse.then_some((WH_MOUSE_LL, ms)))
    }

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            // SAFETY: for HC_ACTION, lparam points at a KBDLLHOOKSTRUCT owned by the system.
            let kb = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            let down = matches!(wparam.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
            let ev = fsm::KeyEvent {
                vk: kb.vkCode as u16,
                down,
                injected: kb.flags.0 & LLKHF_INJECTED.0 != 0 || kb.dwExtraInfo == EXTRA_INFO,
                time: kb.time,
            };
            if !ev.injected {
                activity::KEYBOARD.record(ev.vk, down);
            }
            let suppress = HOOK_CTX.with(|c| {
                let Ok(mut c) = c.try_borrow_mut() else { return false };
                let Some(ctx) = c.as_mut() else { return false };
                if ev.injected {
                    // Hotkeys may accept injected input (--accept-injected); nothing else does.
                    let (suppress, outputs) = ctx.fsm.step(ev);
                    if let Some(out) = &ctx.out {
                        deliver(out, outputs);
                    }
                    return suppress;
                }
                ctx.key(ev, &activity::async_down)
            });
            if suppress {
                return LRESULT(1);
            }
        }
        // SAFETY: forwarding the unmodified hook arguments.
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    /// Mouse button message → (index into switch::MOUSE_BUTTONS, down); moves and wheel → None.
    fn button_of(msg: u32, mouse_data: u32) -> Option<(u8, bool)> {
        Some(match msg {
            WM_LBUTTONDOWN => (0, true),
            WM_LBUTTONUP => (0, false),
            WM_RBUTTONDOWN => (1, true),
            WM_RBUTTONUP => (1, false),
            WM_MBUTTONDOWN => (2, true),
            WM_MBUTTONUP => (2, false),
            WM_XBUTTONDOWN | WM_XBUTTONUP => match mouse_data >> 16 {
                1 => (3, msg == WM_XBUTTONDOWN),
                2 => (4, msg == WM_XBUTTONDOWN),
                _ => return None,
            },
            _ => return None,
        })
    }

    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            // SAFETY: for HC_ACTION, lparam points at an MSLLHOOKSTRUCT owned by the system.
            let ms = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            let injected = ms.flags & LLMHF_INJECTED != 0 || ms.dwExtraInfo == EXTRA_INFO;
            if !injected {
                let button = button_of(wparam.0 as u32, ms.mouseData);
                let suppress = HOOK_CTX.with(|c| {
                    let Ok(mut c) = c.try_borrow_mut() else { return false };
                    let Some(ctx) = c.as_mut() else { return false };
                    ctx.user_ping();
                    button.is_some_and(|(button, down)| ctx.button(button, down))
                });
                if suppress {
                    return LRESULT(1);
                }
            }
        }
        // SAFETY: forwarding the unmodified hook arguments.
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    pub fn mask_win() {
        let key = |flags: KEYBD_EVENT_FLAGS| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(VK_MASK),
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let inputs = [key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)];
        // SAFETY: two well-formed keyboard INPUTs.
        unsafe {
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }
}

#[cfg(not(windows))]
mod hook {
    use super::*;
    pub fn spawn(_: Out, _: Receiver<ConfigMsg>) -> std::io::Result<Receiver<u32>> {
        Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "hotkeys need Windows"))
    }
    pub fn wake(_: u32) -> Result<(), AgentError> {
        Err(AgentError::unsupported("hotkeys need Windows"))
    }
    pub fn mask_win() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ptt_button_names() {
        assert_eq!(parse_ptt_button("").unwrap(), None);
        assert_eq!(parse_ptt_button(" Middle ").unwrap(), Some(2));
        assert_eq!(parse_ptt_button("x1").unwrap(), Some(3));
        assert_eq!(parse_ptt_button("x2").unwrap(), Some(4));
        assert!(parse_ptt_button("left").is_err(), "left click is never push-to-talk");
        assert!(parse_ptt_button("right").is_err());
        assert!(parse_ptt_button("wheel").is_err());
    }

    #[test]
    fn ptt_needs_only_the_mouse_hook() {
        let idle = HookConfig::default();
        assert!(idle.is_idle() && !idle.wants_mouse());
        let ptt = HookConfig { ptt_mouse: Some(3), ..Default::default() };
        assert!(!ptt.is_idle());
        assert!(ptt.wants_mouse());
    }

    #[test]
    fn ptt_button_is_a_one_button_switch() {
        let mut f = SwitchFsm::default();
        f.configure(Switches { keys: vec![], mouse: vec![3] });
        assert_eq!(f.mouse(3, true), (true, vec![(0, true)]));
        assert_eq!(f.mouse(3, true), (true, vec![(0, false), (0, true)]), "a lost up ends the old press");
        assert_eq!(f.mouse(0, true), (false, vec![]), "left click untouched");
        // Turning it off while held reports the release.
        assert_eq!(f.configure(Switches::default()), vec![(0, false)]);
    }
}
