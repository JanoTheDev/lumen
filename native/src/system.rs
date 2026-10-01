//! System settings and assistive tech as events.
//!
//! `system-settings {textScale, highContrast, reduceMotion}` and `a11y-state` (same shape as
//! the `a11y_state` command) are subscribable. A hidden top-level window on its own thread
//! gets WM_SETTINGCHANGE (message-only windows miss broadcasts): every change re-reads the
//! settings, SPI_SETSCREENREADER also re-checks the screen reader. A 10 s timer re-checks the
//! assistive-tech processes (NVDA does not always toggle the SPI flag) and the text size.
//! Each event goes out once on subscribe and then only when its value changes.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

use serde_json::{Value, json};

use crate::proto::writer::Out;

pub const SETTINGS_EVENT: &str = "system-settings";
pub const A11Y_EVENT: &str = "a11y-state";
const RECHECK_MS: u32 = 10_000;

/// Windows text size in percent; anything missing or outside 100–225 is 100.
pub fn text_scale_of(raw: Option<u32>) -> u32 {
    raw.filter(|v| (100..=225).contains(v)).unwrap_or(100)
}

pub fn settings_value(text_scale: Option<u32>, high_contrast: bool, client_animation: bool) -> Value {
    json!({
        "textScale": text_scale_of(text_scale),
        "highContrast": high_contrast,
        "reduceMotion": !client_animation,
    })
}

/// One subscribable event: emits on subscribe and on change.
#[derive(Default)]
pub struct Feed {
    on: AtomicBool,
    last: Mutex<Option<Value>>,
}

impl Feed {
    pub fn set_enabled(&self, on: bool) {
        *self.last.lock().unwrap() = None;
        self.on.store(on, Ordering::SeqCst);
    }

    pub fn enabled(&self) -> bool {
        self.on.load(Ordering::SeqCst)
    }

    /// The value to emit, if subscribed and it differs from the last one sent.
    pub fn offer(&self, v: Value) -> Option<Value> {
        if !self.enabled() {
            return None;
        }
        let mut last = self.last.lock().unwrap();
        if last.as_ref() == Some(&v) {
            return None;
        }
        *last = Some(v.clone());
        Some(v)
    }
}

struct Watch {
    out: Out,
    settings: Feed,
    a11y: Feed,
    hwnd: AtomicIsize,
}

static WATCH: std::sync::OnceLock<Watch> = std::sync::OnceLock::new();

impl Watch {
    fn check_settings(&self) {
        if !self.settings.enabled() {
            return;
        }
        if let Some(v) = self.settings.offer(read_settings()) {
            self.out.emit(SETTINGS_EVENT, v);
        }
    }

    fn check_a11y(&self) {
        if !self.a11y.enabled() {
            return;
        }
        if let Some(v) = self.a11y.offer(crate::a11y_state::current()) {
            self.out.emit(A11Y_EVENT, v);
        }
    }
}

/// Turns one of the two events on or off. The watcher thread starts on first use.
pub fn set_enabled(out: &Out, event: &str, on: bool) {
    let watch = WATCH.get_or_init(|| Watch {
        out: out.clone(),
        settings: Feed::default(),
        a11y: Feed::default(),
        hwnd: AtomicIsize::new(0),
    });
    #[cfg(windows)]
    {
        static STARTED: std::sync::Once = std::sync::Once::new();
        STARTED.call_once(imp::spawn);
    }
    let feed = if event == SETTINGS_EVENT { &watch.settings } else { &watch.a11y };
    feed.set_enabled(on);
    if on {
        #[cfg(windows)]
        imp::refresh(watch.hwnd.load(Ordering::SeqCst));
    }
}

#[cfg(windows)]
fn read_settings() -> Value {
    settings_value(imp::text_scale(), imp::high_contrast(), imp::client_animation())
}

#[cfg(not(windows))]
fn read_settings() -> Value {
    settings_value(None, false, true)
}

/// `system_info`: whether this process (and so Lumen, which spawned it) runs elevated, and the
/// Windows build ("26200" and its update revision).
pub fn info_value(elevated: bool, build: Option<&str>, ubr: Option<u32>) -> Value {
    let build = build.and_then(|b| b.trim().parse::<u32>().ok());
    json!({"elevated": elevated, "osBuild": build, "osRevision": build.and(ubr)})
}

#[cfg(windows)]
pub fn cmd_system_info() -> crate::proto::CmdResult {
    Ok(info_value(imp::elevated(), imp::os_build().as_deref(), imp::os_revision()))
}

#[cfg(not(windows))]
pub fn cmd_system_info() -> crate::proto::CmdResult {
    Ok(info_value(false, None, None))
}

#[cfg(windows)]
pub(crate) mod imp {
    use std::sync::atomic::Ordering;

    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegGetValueW,
    };
    use windows::Win32::UI::Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, MSG, PostMessageW, RegisterClassW,
        SPI_GETCLIENTAREAANIMATION, SPI_GETHIGHCONTRAST, SPI_SETSCREENREADER,
        SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, SetTimer, SystemParametersInfoW, WM_APP, WM_SETTINGCHANGE,
        WM_TIMER, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
    };
    use windows::core::{BOOL, PCWSTR, w};

    use super::{RECHECK_MS, WATCH};

    const WM_REFRESH: u32 = WM_APP + 3;

    pub fn reg_dword(root: HKEY, key: PCWSTR, value: PCWSTR) -> Option<u32> {
        let mut v = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: the out-buffer is a u32 and `size` says so.
        let r = unsafe {
            RegGetValueW(
                root,
                key,
                value,
                RRF_RT_REG_DWORD,
                None,
                Some(&mut v as *mut u32 as *mut _),
                Some(&mut size),
            )
        };
        r.is_ok().then_some(v)
    }

    pub fn reg_string(root: HKEY, key: PCWSTR, value: PCWSTR) -> Option<String> {
        let mut buf = [0u16; 128];
        let mut size = std::mem::size_of_val(&buf) as u32;
        // SAFETY: the out-buffer is `size` bytes; REG_SZ comes back NUL-terminated.
        let r = unsafe {
            RegGetValueW(
                root,
                key,
                value,
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr() as *mut _),
                Some(&mut size),
            )
        };
        if r.is_err() {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }

    const CURRENT_VERSION: PCWSTR = w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion");

    pub fn os_build() -> Option<String> {
        reg_string(HKEY_LOCAL_MACHINE, CURRENT_VERSION, w!("CurrentBuildNumber"))
    }

    pub fn os_revision() -> Option<u32> {
        reg_dword(HKEY_LOCAL_MACHINE, CURRENT_VERSION, w!("UBR"))
    }

    /// TokenElevation of our own process token.
    pub fn elevated() -> bool {
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        use windows::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation};
        use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        let mut token = HANDLE::default();
        let mut elevation = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        // SAFETY: the token handle is closed below; the out-buffer is a sized TOKEN_ELEVATION.
        unsafe {
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
                return false;
            }
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut elevation as *mut _ as *mut _),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut len,
            )
            .is_ok();
            let _ = CloseHandle(token);
            ok && elevation.TokenIsElevated != 0
        }
    }

    pub fn text_scale() -> Option<u32> {
        reg_dword(HKEY_CURRENT_USER, w!("Software\\Microsoft\\Accessibility"), w!("TextScaleFactor"))
    }

    pub fn high_contrast() -> bool {
        let mut hc =
            HIGHCONTRASTW { cbSize: std::mem::size_of::<HIGHCONTRASTW>() as u32, ..Default::default() };
        // SAFETY: out-param is a sized HIGHCONTRASTW as SPI_GETHIGHCONTRAST requires.
        unsafe {
            SystemParametersInfoW(
                SPI_GETHIGHCONTRAST,
                hc.cbSize,
                Some(&mut hc as *mut _ as *mut _),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
            .is_ok()
                && hc.dwFlags.contains(HCF_HIGHCONTRASTON)
        }
    }

    /// "Animation effects" (Settings → Accessibility → Visual effects). On when unknown.
    pub fn client_animation() -> bool {
        let mut on = BOOL(1);
        // SAFETY: out-param is a BOOL as SPI_GETCLIENTAREAANIMATION requires.
        let ok = unsafe {
            SystemParametersInfoW(
                SPI_GETCLIENTAREAANIMATION,
                0,
                Some(&mut on as *mut _ as *mut _),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
            .is_ok()
        };
        !ok || on.as_bool()
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if let Some(watch) = WATCH.get() {
            match msg {
                WM_SETTINGCHANGE => {
                    watch.check_settings();
                    if wparam.0 as u32 == SPI_SETSCREENREADER.0 {
                        watch.check_a11y();
                    }
                    return LRESULT(0);
                }
                WM_TIMER | WM_REFRESH => {
                    watch.check_settings();
                    watch.check_a11y();
                    return LRESULT(0);
                }
                _ => {}
            }
        }
        // SAFETY: default handling for everything else.
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    pub fn spawn() {
        let spawned = std::thread::Builder::new().name("system-watch".into()).spawn(|| {
            // SAFETY: window class/window creation, a timer and a standard message loop on this thread.
            unsafe {
                let instance = GetModuleHandleW(None).ok().map(|m| HINSTANCE(m.0));
                let class = WNDCLASSW {
                    lpfnWndProc: Some(wndproc),
                    hInstance: instance.unwrap_or_default(),
                    lpszClassName: w!("LumenSystemWatch"),
                    ..Default::default()
                };
                RegisterClassW(&class);
                // A hidden top-level window: broadcasts skip message-only windows.
                let hwnd = CreateWindowExW(
                    WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                    w!("LumenSystemWatch"),
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
                    tracing::error!("system watch window could not be created");
                    return;
                };
                let Some(watch) = WATCH.get() else { return };
                watch.hwnd.store(hwnd.0 as isize, Ordering::SeqCst);
                SetTimer(Some(hwnd), 1, RECHECK_MS, None);
                // Subscriptions made before the window existed.
                watch.check_settings();
                watch.check_a11y();
                let mut msg = MSG::default();
                // 0 is WM_QUIT, -1 an error (looping on it would spin).
                while !matches!(GetMessageW(&mut msg, None, 0, 0).0, 0 | -1) {
                    DispatchMessageW(&msg);
                }
            }
        });
        if let Err(e) = spawned {
            tracing::error!("system watch thread: {e}");
        }
    }

    /// Asks the watcher thread to emit the current values (0 = not up yet; it does so on start).
    pub fn refresh(hwnd: isize) {
        if hwnd != 0 {
            // SAFETY: a parameterless wake-up message for our own window.
            let _ = unsafe { PostMessageW(Some(HWND(hwnd as *mut _)), WM_REFRESH, WPARAM(0), LPARAM(0)) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_scale_is_clamped_to_windows_range() {
        assert_eq!(text_scale_of(None), 100);
        assert_eq!(text_scale_of(Some(150)), 150);
        assert_eq!(text_scale_of(Some(99)), 100);
        assert_eq!(text_scale_of(Some(300)), 100);
        assert_eq!(
            settings_value(Some(125), true, false),
            json!({"textScale": 125, "highContrast": true, "reduceMotion": true})
        );
    }

    #[test]
    fn system_info_shape() {
        assert_eq!(
            info_value(true, Some("26200"), Some(6584)),
            json!({"elevated": true, "osBuild": 26200, "osRevision": 6584})
        );
        assert_eq!(
            info_value(false, Some("bogus"), Some(1)),
            json!({"elevated": false, "osBuild": null, "osRevision": null})
        );
    }

    #[cfg(windows)]
    #[test]
    fn reads_this_machine() {
        let v = cmd_system_info().unwrap();
        assert!(v["osBuild"].as_u64().is_some_and(|b| b >= 10_000), "{v}");
        assert!(v["elevated"].is_boolean());
    }

    #[test]
    fn feed_emits_on_subscribe_and_change_only() {
        let f = Feed::default();
        assert_eq!(f.offer(json!(1)), None, "not subscribed");
        f.set_enabled(true);
        assert_eq!(f.offer(json!(1)), Some(json!(1)));
        assert_eq!(f.offer(json!(1)), None);
        assert_eq!(f.offer(json!(2)), Some(json!(2)));
        f.set_enabled(true);
        assert_eq!(f.offer(json!(2)), Some(json!(2)), "re-subscribe re-sends");
        f.set_enabled(false);
        assert_eq!(f.offer(json!(3)), None);
    }
}
