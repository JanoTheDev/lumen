//! Per-monitor-v2 DPI awareness. The manifest already requests it; the call
//! here is a defensive fallback for hosts that strip manifests.

#[cfg(windows)]
pub fn init() -> &'static str {
    use windows::Win32::UI::HiDpi::{
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetAwarenessFromDpiAwarenessContext,
        GetThreadDpiAwarenessContext, PROCESS_PER_MONITOR_DPI_AWARE, SetProcessDpiAwareness,
        SetProcessDpiAwarenessContext,
    };
    // SAFETY: plain Win32 calls with constant arguments; failure only means awareness is already set.
    unsafe {
        if SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2).is_err() {
            let _ = SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE);
        }
        match GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()).0 {
            0 => "unaware",
            1 => "system",
            2 => "per-monitor",
            _ => "unknown",
        }
    }
}

#[cfg(not(windows))]
pub fn init() -> &'static str {
    "unsupported"
}
