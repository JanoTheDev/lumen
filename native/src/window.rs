//! Top-level window facts via Win32: owning process, class, title, rect.
//! HWNDs travel as `isize` (HWND is not Send).

use crate::geom::Rect;

pub const BROWSERS: &[&str] = &[
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "opera_gx.exe",
    "vivaldi.exe",
    "arc.exe",
    "zen.exe",
    "librewolf.exe",
];

pub fn is_browser_process(name: &str) -> bool {
    let low = name.to_ascii_lowercase();
    BROWSERS.contains(&low.as_str())
}

/// Lowercased file name of a path ("C:\\x\\Chrome.EXE" → "chrome.exe").
pub fn basename_lower(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase()
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, GW_OWNER, GetClassNameW, GetForegroundWindow, GetWindow,
        GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindow,
        IsWindowVisible,
    };
    use windows::core::{BOOL, PWSTR};

    pub fn hwnd(h: isize) -> HWND {
        HWND(h as *mut _)
    }

    pub fn foreground() -> isize {
        // SAFETY: pure query.
        unsafe { GetForegroundWindow().0 as isize }
    }

    pub fn is_window(h: isize) -> bool {
        // SAFETY: pure query; any value is accepted.
        h != 0 && unsafe { IsWindow(Some(hwnd(h))).as_bool() }
    }

    pub fn pid_of(h: isize) -> u32 {
        let mut pid = 0u32;
        // SAFETY: out-param is valid.
        unsafe { GetWindowThreadProcessId(hwnd(h), Some(&mut pid)) };
        pid
    }

    pub fn thread_of(h: isize) -> u32 {
        // SAFETY: pure query.
        unsafe { GetWindowThreadProcessId(hwnd(h), None) }
    }

    pub fn exe_path(pid: u32) -> String {
        if pid == 0 {
            return String::new();
        }
        // SAFETY: handle is closed before returning; buffer sizes are passed correctly.
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return String::new();
            };
            let mut buf = vec![0u16; 1024];
            let mut size = buf.len() as u32;
            let ok =
                QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size).is_ok();
            let _ = CloseHandle(h);
            if ok { String::from_utf16_lossy(&buf[..size as usize]) } else { String::new() }
        }
    }

    pub fn process_name(h: isize) -> String {
        basename_lower(&exe_path(pid_of(h)))
    }

    pub fn class_name(h: isize) -> String {
        let mut buf = [0u16; 256];
        // SAFETY: buffer is valid for its length.
        let n = unsafe { GetClassNameW(hwnd(h), &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    pub fn title(h: isize) -> String {
        // SAFETY: buffer is sized from GetWindowTextLengthW (+1 for the terminator).
        unsafe {
            let n = GetWindowTextLengthW(hwnd(h)).max(0) as usize;
            let mut buf = vec![0u16; n + 1];
            let got = GetWindowTextW(hwnd(h), &mut buf).max(0) as usize;
            String::from_utf16_lossy(&buf[..got])
        }
    }

    pub fn rect(h: isize) -> Rect {
        let mut r = RECT::default();
        // SAFETY: out-param is valid.
        let _ = unsafe { GetWindowRect(hwnd(h), &mut r) };
        r.into()
    }

    unsafe extern "system" fn push(h: HWND, lp: LPARAM) -> BOOL {
        // SAFETY: lp is the &mut Vec owned by the enumerating caller.
        unsafe { (*(lp.0 as *mut Vec<isize>)).push(h.0 as isize) };
        BOOL(1)
    }

    /// All descendant HWNDs.
    pub fn child_windows(h: isize) -> Vec<isize> {
        let mut out: Vec<isize> = vec![];
        // SAFETY: callback writes only into `out`, alive for the call.
        unsafe {
            let _ = EnumChildWindows(Some(hwnd(h)), Some(push), LPARAM(&mut out as *mut _ as isize));
        }
        out
    }

    /// Top-level HWNDs in z-order (front first).
    pub fn top_level_windows() -> Vec<isize> {
        let mut out: Vec<isize> = vec![];
        // SAFETY: callback writes only into `out`, alive for the call.
        unsafe {
            let _ = EnumWindows(Some(push), LPARAM(&mut out as *mut _ as isize));
        }
        out
    }

    /// Windows DWM hides (other virtual desktops, suspended UWP frames).
    pub fn is_cloaked(h: isize) -> bool {
        let mut v = 0u32;
        // SAFETY: out buffer matches the attribute size.
        let hr = unsafe {
            DwmGetWindowAttribute(
                hwnd(h),
                DWMWA_CLOAKED,
                &mut v as *mut u32 as *mut _,
                std::mem::size_of::<u32>() as u32,
            )
        };
        hr.is_ok() && v != 0
    }

    /// Visible, uncloaked, unowned top-level window with a title.
    pub fn is_app_window(h: isize) -> bool {
        // SAFETY: pure queries.
        unsafe {
            IsWindowVisible(hwnd(h)).as_bool()
                && GetWindow(hwnd(h), GW_OWNER).map(|o| o.is_invalid()).unwrap_or(true)
                && GetWindowTextLengthW(hwnd(h)) > 0
                && !is_cloaked(h)
        }
    }

    pub fn is_visible(h: isize) -> bool {
        // SAFETY: pure query.
        unsafe { IsWindowVisible(hwnd(h)).as_bool() }
    }
}

#[cfg(windows)]
pub use win::*;

/// C2 `active_window` record for one window (zeros when `hwnd` is 0).
#[cfg(windows)]
pub fn info(hwnd: isize) -> serde_json::Value {
    use serde_json::json;
    if hwnd == 0 {
        return json!({"hwnd": 0, "title": "", "process": "", "exe": "", "pid": 0,
            "rect": Rect::default().to_json(), "monitor": 0, "isBrowser": false, "className": ""});
    }
    let pid = pid_of(hwnd);
    let exe = exe_path(pid);
    let process = basename_lower(&exe);
    let mons = crate::monitors::enumerate();
    let monitor = crate::monitors::from_window(&mons, hwnd).map(|m| m.id).unwrap_or(0);
    json!({
        "hwnd": hwnd,
        "title": title(hwnd),
        "process": process,
        "exe": exe,
        "pid": pid,
        "rect": rect(hwnd).to_json(),
        "monitor": monitor,
        "isBrowser": is_browser_process(&process),
        "className": class_name(hwnd),
    })
}

/// Front-most app window of a process ("chrome" or "chrome.exe", case-insensitive).
#[cfg(windows)]
pub fn find_process_window(process: &str) -> Option<isize> {
    let mut want = process.trim().to_lowercase();
    if !want.ends_with(".exe") {
        want.push_str(".exe");
    }
    top_level_windows().into_iter().find(|&h| is_app_window(h) && process_name(h) == want)
}

/// Brings `hwnd` to the foreground and verifies it got there.
#[cfg(windows)]
pub fn focus(hwnd: isize, token: &crate::proto::router::CancelToken) -> Result<(), crate::proto::AgentError> {
    use crate::proto::AgentError;
    use std::time::{Duration, Instant};
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VK_MENU,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, IsIconic, SW_RESTORE, SetForegroundWindow, ShowWindow,
    };

    if !is_window(hwnd) {
        return Err(AgentError::not_found(format!("no window {hwnd}")));
    }
    if foreground() == hwnd {
        return Ok(());
    }
    let h = win::hwnd(hwnd);
    // SAFETY: plain Win32 calls; thread input is detached again before returning.
    unsafe {
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        let fg_thread = thread_of(foreground());
        let me = GetCurrentThreadId();
        let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, true).as_bool();
        let _ = BringWindowToTop(h);
        let mut ok = SetForegroundWindow(h).as_bool();
        if !ok {
            // The foreground lock lifts after a keypress; a lone Alt tap has no side effects.
            let key = |flags| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT { wVk: VK_MENU, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
                },
            };
            SendInput(
                &[key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)],
                std::mem::size_of::<INPUT>() as i32,
            );
            ok = SetForegroundWindow(h).as_bool();
        }
        if attached {
            let _ = AttachThreadInput(me, fg_thread, false);
        }
        let _ = ok;
    }
    let deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < deadline {
        if foreground() == hwnd {
            return Ok(());
        }
        token.sleep(Duration::from_millis(20))?;
    }
    Err(AgentError::denied("Windows refused to bring the window to the front"))
}

/// Front-most browser window, by process image name.
#[cfg(windows)]
pub fn find_browser() -> Option<isize> {
    top_level_windows().into_iter().find(|&h| is_app_window(h) && is_browser_process(&process_name(h)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(basename_lower(r"C:\Program Files\Google\Chrome.EXE"), "chrome.exe");
        assert!(is_browser_process("MSEdge.exe"));
        assert!(!is_browser_process("notepad.exe"));
    }
}
