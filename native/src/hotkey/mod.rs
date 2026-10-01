//! Global hotkeys via a `WH_KEYBOARD_LL` hook on a dedicated thread.
//!
//! The hook callback only steps the thread-local FSM and queues events with a
//! non-blocking send; it takes no locks shared with other threads. Bindings
//! are swapped by posting a boxed config to the hook thread. The hook is only
//! installed while something is bound, so an idle agent adds no latency to
//! system-wide typing.

pub mod accel;
pub mod fsm;

use std::cell::RefCell;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crossbeam_channel::{Sender, bounded};
use serde_json::json;

use crate::proto::AgentError;
use crate::proto::writer::Out;
use fsm::{Binding, Config, Fsm, Output};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Bound {
    assistant: String,
    dictation: String,
    taps: bool,
}

pub struct Service {
    out: Out,
    accept_injected: bool,
    thread: OnceLock<Option<u32>>,
    bound: Mutex<Bound>,
}

/// What to change; `None` keeps the current value.
#[derive(Debug, Default)]
pub struct Update<'a> {
    pub assistant: Option<&'a str>,
    pub dictation: Option<&'a str>,
    pub taps: Option<bool>,
}

fn parse_opt(accel: &str) -> Result<Option<accel::Hotkey>, AgentError> {
    if accel.trim().is_empty() { Ok(None) } else { accel::parse(accel).map(Some) }
}

impl Service {
    pub fn new(out: Out, accept_injected: bool) -> Self {
        Service { out, accept_injected, thread: OnceLock::new(), bound: Mutex::new(Bound::default()) }
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
        let mut bindings = vec![];
        if let Some(hk) = parse_opt(&next.assistant)? {
            bindings.push(Binding { hotkey: hk, down: "hotkey-down", up: "hotkey-up" });
        }
        if let Some(hk) = parse_opt(&next.dictation)? {
            bindings.push(Binding { hotkey: hk, down: "dictation-down", up: "dictation-up" });
        }
        let config = Config { bindings, taps: next.taps, accept_injected: self.accept_injected };
        if config.is_idle() && self.thread.get().is_none() {
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

    fn send(&self, config: Config) -> Result<(), AgentError> {
        let thread = *self.thread.get_or_init(|| hook::spawn(self.out.clone()));
        let thread = thread.ok_or_else(|| AgentError::unsupported("keyboard hook thread unavailable"))?;
        let (tx, rx) = bounded(1);
        hook::post(thread, Box::new((config, tx)))?;
        rx.recv_timeout(Duration::from_secs(2))
            .map_err(|_| AgentError::internal("keyboard hook thread did not answer"))?
            .map_err(AgentError::internal)
    }
}

type ConfigMsg = (Config, Sender<Result<(), String>>);

thread_local! {
    static HOOK_CTX: RefCell<Option<HookCtx>> = const { RefCell::new(None) };
}

struct HookCtx {
    fsm: Fsm,
    out: Out,
}

fn deliver(out: &Out, outputs: Vec<Output>) {
    for o in outputs {
        match o {
            Output::Emit(event) => {
                if !out.try_emit(event, json!({})) {
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
    use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput,
        VIRTUAL_KEY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, HC_ACTION, HHOOK, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, PM_NOREMOVE,
        PeekMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, WH_KEYBOARD_LL, WM_APP,
        WM_KEYDOWN, WM_SYSKEYDOWN,
    };

    const WM_CONFIG: u32 = WM_APP + 1;
    /// Unassigned VK used to mask the Win key release (standard trick).
    const VK_MASK: u16 = 0xE8;

    pub fn spawn(out: Out) -> Option<u32> {
        let (tx, rx) = bounded(1);
        let spawned = std::thread::Builder::new().name("hotkey-hook".into()).spawn(move || {
            let mut msg = MSG::default();
            // SAFETY: creates this thread's message queue before announcing its id.
            unsafe {
                let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
                let _ = tx.send(GetCurrentThreadId());
            }
            HOOK_CTX.with(|c| *c.borrow_mut() = Some(HookCtx { fsm: Fsm::default(), out }));
            pump();
        });
        if let Err(e) = spawned {
            tracing::error!("hotkey thread: {e}");
            return None;
        }
        rx.recv_timeout(Duration::from_secs(2)).ok()
    }

    pub fn post(thread: u32, msg: Box<ConfigMsg>) -> Result<(), AgentError> {
        let ptr = Box::into_raw(msg);
        // SAFETY: the hook thread takes ownership of `ptr` when it receives WM_CONFIG.
        unsafe {
            if let Err(e) = PostThreadMessageW(thread, WM_CONFIG, WPARAM(0), LPARAM(ptr as isize)) {
                drop(Box::from_raw(ptr));
                return Err(e.into());
            }
        }
        Ok(())
    }

    fn pump() {
        let mut hook: Option<HHOOK> = None;
        let mut msg = MSG::default();
        // SAFETY: standard message loop on the thread that owns the hook.
        unsafe {
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                if msg.message != WM_CONFIG {
                    continue;
                }
                let (config, reply) = *Box::from_raw(msg.lParam.0 as *mut ConfigMsg);
                let idle = config.is_idle();
                HOOK_CTX.with(|c| {
                    if let Some(ctx) = c.borrow_mut().as_mut() {
                        let outputs = ctx.fsm.configure(config);
                        deliver(&ctx.out, outputs);
                    }
                });
                let result = if idle {
                    if let Some(h) = hook.take() {
                        let _ = UnhookWindowsHookEx(h);
                    }
                    Ok(())
                } else if hook.is_none() {
                    let module = GetModuleHandleW(None).ok().map(|m| HINSTANCE(m.0));
                    match SetWindowsHookExW(WH_KEYBOARD_LL, Some(proc), module, 0) {
                        Ok(h) => {
                            hook = Some(h);
                            Ok(())
                        }
                        Err(e) => Err(format!("SetWindowsHookExW failed: {}", e.message())),
                    }
                } else {
                    Ok(())
                };
                let _ = reply.send(result);
            }
        }
    }

    unsafe extern "system" fn proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            // SAFETY: for HC_ACTION, lparam points at a KBDLLHOOKSTRUCT owned by the system.
            let kb = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            let down = matches!(wparam.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
            let ev = fsm::KeyEvent {
                vk: kb.vkCode as u16,
                down,
                injected: kb.flags.0 & LLKHF_INJECTED.0 != 0,
                time: kb.time,
            };
            let suppress = HOOK_CTX.with(|c| {
                let Ok(mut c) = c.try_borrow_mut() else { return false };
                let Some(ctx) = c.as_mut() else { return false };
                let (suppress, outputs) = ctx.fsm.step(ev);
                deliver(&ctx.out, outputs);
                suppress
            });
            if suppress {
                return LRESULT(1);
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
    pub fn spawn(_: Out) -> Option<u32> {
        None
    }
    pub fn post(_: u32, _: Box<ConfigMsg>) -> Result<(), AgentError> {
        Err(AgentError::unsupported("hotkeys need Windows"))
    }
    pub fn mask_win() {}
}
