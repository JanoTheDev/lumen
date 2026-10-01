//! Monitor geometry in physical virtual-desktop px (per-monitor-v2 process).
//!
//! `id` is the index after sorting by (x, y), stable for a given layout;
//! `device` (\\.\DISPLAY1) lets main match Electron displays by rect.

use serde::Serialize;
use serde_json::Value;

use crate::geom::Rect;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub id: u32,
    pub device: String,
    pub rect: Rect,
    pub work_area: Rect,
    pub dpi: u32,
    pub scale: f64,
    pub primary: bool,
}

impl MonitorInfo {
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or_default()
    }

    /// Physical virtual-desktop px → logical px relative to this monitor's origin.
    pub fn to_logical(&self, x: f64, y: f64) -> (f64, f64) {
        let s = if self.scale > 0.0 { self.scale } else { 1.0 };
        ((x - self.rect.x as f64) / s, (y - self.rect.y as f64) / s)
    }
}

pub fn round_scale(dpi: u32) -> f64 {
    (dpi as f64 / 96.0 * 10000.0).round() / 10000.0
}

/// Sorts by (x, y) and numbers from 0. Pure.
pub fn assign_ids(mut mons: Vec<MonitorInfo>) -> Vec<MonitorInfo> {
    mons.sort_by_key(|m| (m.rect.x, m.rect.y));
    for (i, m) in mons.iter_mut().enumerate() {
        m.id = i as u32;
    }
    mons
}

/// Monitor containing the point, else the nearest one. Pure.
pub fn containing(mons: &[MonitorInfo], x: f64, y: f64) -> Option<&MonitorInfo> {
    mons.iter().min_by(|a, b| a.rect.dist2(x, y).total_cmp(&b.rect.dist2(x, y)))
}

pub fn primary(mons: &[MonitorInfo]) -> Option<&MonitorInfo> {
    mons.iter().find(|m| m.primary).or(mons.first())
}

fn matching<'a>(mons: &'a [MonitorInfo], device: &str, rect: Rect) -> Option<&'a MonitorInfo> {
    mons.iter()
        .find(|m| m.device == device && m.rect == rect)
        .or_else(|| mons.iter().find(|m| m.rect == rect))
        .or(mons.first())
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITORINFO,
        MONITORINFOEXW, MonitorFromPoint, MonitorFromWindow,
    };
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    use windows::core::BOOL;

    const MONITORINFOF_PRIMARY: u32 = 1;

    fn info(hmon: HMONITOR) -> MonitorInfo {
        let mut mi = MONITORINFOEXW::default();
        mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        let (mut dx, mut dy) = (96u32, 96u32);
        // SAFETY: mi is a correctly sized MONITORINFOEXW; out-params are valid.
        unsafe {
            let _ = GetMonitorInfoW(hmon, &mut mi as *mut MONITORINFOEXW as *mut MONITORINFO);
            if GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy).is_err() {
                dx = 96;
            }
        }
        let len = mi.szDevice.iter().position(|&c| c == 0).unwrap_or(mi.szDevice.len());
        MonitorInfo {
            id: 0,
            device: String::from_utf16_lossy(&mi.szDevice[..len]),
            rect: mi.monitorInfo.rcMonitor.into(),
            work_area: mi.monitorInfo.rcWork.into(),
            dpi: dx,
            scale: round_scale(dx),
            primary: mi.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
        }
    }

    unsafe extern "system" fn collect(hmon: HMONITOR, _: HDC, _: *mut RECT, lp: LPARAM) -> BOOL {
        // SAFETY: lp is the &mut Vec passed by enumerate() for the duration of the call.
        let v = unsafe { &mut *(lp.0 as *mut Vec<HMONITOR>) };
        v.push(hmon);
        BOOL(1)
    }

    pub fn enumerate() -> Vec<MonitorInfo> {
        let mut handles: Vec<HMONITOR> = vec![];
        // SAFETY: the callback only pushes into `handles`, which outlives the call.
        unsafe {
            let _ = EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut handles as *mut _ as isize));
        }
        assign_ids(handles.into_iter().map(info).collect())
    }

    pub fn from_hmonitor(mons: &[MonitorInfo], hmon: HMONITOR) -> Option<MonitorInfo> {
        let i = info(hmon);
        matching(mons, &i.device, i.rect).cloned()
    }

    pub fn from_window(mons: &[MonitorInfo], hwnd: isize) -> Option<MonitorInfo> {
        // SAFETY: MonitorFromWindow accepts any (even stale) HWND with DEFAULTTONEAREST.
        let hmon = unsafe { MonitorFromWindow(HWND(hwnd as *mut _), MONITOR_DEFAULTTONEAREST) };
        from_hmonitor(mons, hmon)
    }

    pub fn from_point(mons: &[MonitorInfo], x: i32, y: i32) -> Option<MonitorInfo> {
        // SAFETY: pure query.
        let hmon = unsafe { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST) };
        from_hmonitor(mons, hmon)
    }
}

#[cfg(windows)]
pub use win::{enumerate, from_window};

#[cfg(not(windows))]
pub fn enumerate() -> Vec<MonitorInfo> {
    vec![]
}
#[cfg(not(windows))]
pub fn from_window(_: &[MonitorInfo], _: isize) -> Option<MonitorInfo> {
    None
}
#[cfg(not(windows))]
pub fn from_point(_: &[MonitorInfo], _: i32, _: i32) -> Option<MonitorInfo> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(device: &str, x: i32, y: i32, dpi: u32, primary: bool) -> MonitorInfo {
        let r = Rect::new(x, y, 1920, 1080);
        MonitorInfo {
            id: 99,
            device: device.into(),
            rect: r,
            work_area: r,
            dpi,
            scale: round_scale(dpi),
            primary,
        }
    }

    #[test]
    fn ids_sorted_by_position() {
        let m = assign_ids(vec![mon("A", 0, 0, 96, true), mon("B", -1920, 0, 144, false)]);
        assert_eq!((m[0].device.as_str(), m[0].id), ("B", 0));
        assert_eq!((m[1].device.as_str(), m[1].id), ("A", 1));
        assert_eq!(m[0].scale, 1.5);
        assert_eq!(primary(&m).unwrap().device, "A");
        assert_eq!(containing(&m, -5.0, 10.0).unwrap().device, "B");
        assert_eq!(containing(&m, 5000.0, 10.0).unwrap().device, "A");
        assert_eq!(m[0].to_logical(-1920.0 + 300.0, 150.0), (200.0, 100.0));
        let j = m[0].to_json();
        assert_eq!(j["workArea"]["w"], 1920);
        assert_eq!(j["device"], "B");
    }
}
