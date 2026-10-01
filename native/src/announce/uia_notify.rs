//! UIA notification events from a hidden tool window that hosts a minimal
//! IRawElementProviderSimple. Narrator (and recent NVDA/JAWS) speak
//! notifications raised by any provider.
//!
//! Requests travel over a channel owned by the host thread; WM_ANNOUNCE only
//! wakes it. Any process can post that message, so its params are ignored.

use std::cell::RefCell;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender, bounded, unbounded};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, MSG, PostMessageW, RegisterClassW,
    WM_APP, WM_GETOBJECT, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
};
use windows::core::{BSTR, IUnknown, implement, w};

use crate::proto::AgentError;

const WM_ANNOUNCE: u32 = WM_APP + 2;
const REPLY_TIMEOUT: Duration = Duration::from_secs(2);

#[implement(IRawElementProviderSimple)]
struct Provider {
    hwnd: isize,
}

impl IRawElementProviderSimple_Impl for Provider_Impl {
    fn ProviderOptions(&self) -> windows::core::Result<ProviderOptions> {
        Ok(ProviderOptions_ServerSideProvider | ProviderOptions_UseComThreading)
    }

    fn GetPatternProvider(&self, _: UIA_PATTERN_ID) -> windows::core::Result<IUnknown> {
        Err(windows::core::Error::empty())
    }

    fn GetPropertyValue(&self, id: UIA_PROPERTY_ID) -> windows::core::Result<VARIANT> {
        Ok(if id == UIA_NamePropertyId {
            VARIANT::from(BSTR::from("Lumen"))
        } else if id == UIA_ControlTypePropertyId {
            VARIANT::from(UIA_PaneControlTypeId.0)
        } else if id == UIA_IsControlElementPropertyId || id == UIA_IsContentElementPropertyId {
            VARIANT::from(false)
        } else {
            VARIANT::default()
        })
    }

    fn HostRawElementProvider(&self) -> windows::core::Result<IRawElementProviderSimple> {
        // SAFETY: the host window outlives the provider.
        unsafe { UiaHostProviderFromHwnd(HWND(self.hwnd as *mut _)) }
    }
}

struct Request {
    text: String,
    assertive: bool,
    /// The caller stops waiting after this; a request found later is dropped unspoken.
    expires: Instant,
    reply: Sender<Result<bool, String>>,
}

thread_local! {
    static PROVIDER: RefCell<Option<IRawElementProviderSimple>> = const { RefCell::new(None) };
    static REQUESTS: RefCell<Option<Receiver<Request>>> = const { RefCell::new(None) };
}

fn notify(req: &Request) -> Result<bool, String> {
    PROVIDER.with(|p| match p.borrow().as_ref() {
        None => Err("no provider".to_string()),
        Some(p) => {
            // SAFETY: plain UIA calls on this thread.
            unsafe {
                if !UiaClientsAreListening().as_bool() {
                    return Ok(false);
                }
                let processing = if req.assertive {
                    NotificationProcessing_ImportantMostRecent
                } else {
                    NotificationProcessing_All
                };
                UiaRaiseNotificationEvent(
                    p,
                    NotificationKind_Other,
                    processing,
                    &BSTR::from(req.text.as_str()),
                    &BSTR::from("lumen-announce"),
                )
                .map(|_| true)
                .map_err(|e| e.message())
            }
        }
    })
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_GETOBJECT && lparam.0 as i32 == UiaRootObjectId {
        let provider = PROVIDER.with(|p| p.borrow().clone());
        if let Some(p) = provider {
            // SAFETY: answering WM_GETOBJECT for our own window with our provider.
            return unsafe { UiaReturnRawElementProvider(hwnd, wparam, lparam, &p) };
        }
    }
    if msg == WM_ANNOUNCE {
        let pending: Vec<Request> =
            REQUESTS.with(|r| r.borrow().as_ref().map(|rx| rx.try_iter().collect()).unwrap_or_default());
        for req in pending {
            if Instant::now() < req.expires {
                let _ = req.reply.send(notify(&req));
            }
        }
        return LRESULT(0);
    }
    // SAFETY: default handling for everything else.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

struct Host {
    hwnd: isize,
    requests: Sender<Request>,
}

/// The host window (created once, on its own message-pump thread).
fn host() -> Option<&'static Host> {
    static HOST: OnceLock<Option<Host>> = OnceLock::new();
    HOST.get_or_init(|| {
        let (tx, rx) = bounded(1);
        let (requests, queue) = unbounded();
        std::thread::Builder::new()
            .name("announce-host".into())
            .spawn(move || {
                crate::com_init();
                // SAFETY: window class/window creation and a standard message loop on this thread.
                unsafe {
                    let instance =
                        GetModuleHandleW(None).ok().map(|m| windows::Win32::Foundation::HINSTANCE(m.0));
                    let class = WNDCLASSW {
                        lpfnWndProc: Some(wndproc),
                        hInstance: instance.unwrap_or_default(),
                        lpszClassName: w!("LumenAnnounceHost"),
                        ..Default::default()
                    };
                    RegisterClassW(&class);
                    let hwnd = CreateWindowExW(
                        WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                        w!("LumenAnnounceHost"),
                        w!("Lumen"),
                        WS_POPUP,
                        0,
                        0,
                        0,
                        0,
                        None,
                        None,
                        instance,
                        None,
                    );
                    let Ok(hwnd) = hwnd else {
                        let _ = tx.send(None);
                        return;
                    };
                    let provider: IRawElementProviderSimple = Provider { hwnd: hwnd.0 as isize }.into();
                    PROVIDER.with(|p| *p.borrow_mut() = Some(provider));
                    REQUESTS.with(|r| *r.borrow_mut() = Some(queue));
                    let _ = tx.send(Some(hwnd.0 as isize));
                    let mut msg = MSG::default();
                    // 0 is WM_QUIT, -1 an error (looping on it would spin).
                    while !matches!(GetMessageW(&mut msg, None, 0, 0).0, 0 | -1) {
                        DispatchMessageW(&msg);
                    }
                }
            })
            .ok()?;
        let hwnd = rx.recv_timeout(Duration::from_secs(2)).ok().flatten()?;
        Some(Host { hwnd, requests })
    })
    .as_ref()
}

/// Raises a notification. Ok(false) when no UIA client is listening (nobody would hear it).
pub fn raise(text: &str, assertive: bool) -> Result<bool, AgentError> {
    let Some(host) = host() else { return Ok(false) };
    let (tx, rx) = bounded(1);
    let expires = Instant::now() + REPLY_TIMEOUT;
    if host.requests.send(Request { text: text.to_owned(), assertive, expires, reply: tx }).is_err() {
        return Ok(false);
    }
    // SAFETY: a parameterless wake-up message for our own window.
    if unsafe { PostMessageW(Some(HWND(host.hwnd as *mut _)), WM_ANNOUNCE, WPARAM(0), LPARAM(0)) }.is_err() {
        return Ok(false);
    }
    rx.recv_timeout(REPLY_TIMEOUT)
        .map_err(|_| AgentError::internal("announce host did not answer"))?
        .map_err(|e| AgentError::internal(format!("UiaRaiseNotificationEvent failed: {e}")))
}
