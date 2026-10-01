//! `capture` and `monitors` (plans CONTRACTS C2/C4) plus the full-res frame
//! cache that `ocr` reuses (3 frames, 5 s).

#[cfg(windows)]
pub mod dxgi;
pub mod encode;
#[cfg(windows)]
pub mod gdi;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::geom::Rect;
use crate::monitors::{self, MonitorInfo};
use crate::proto::{AgentError, Args, CmdResult, arg};

pub const DEFAULT_MAX_WIDTH: u32 = 1280;
pub const DEFAULT_QUALITY: u8 = 75;
const CACHE_FRAMES: usize = 3;
const CACHE_TTL: Duration = Duration::from_secs(5);

/// A full-resolution BGRA frame of `rect` (physical px) on `monitor`.
pub struct Frame {
    pub id: String,
    pub bgra: Vec<u8>,
    pub rect: Rect,
    pub monitor: MonitorInfo,
    pub via: &'static str,
    t: Instant,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static CACHE: Mutex<VecDeque<Arc<Frame>>> = Mutex::new(VecDeque::new());

fn prune(cache: &mut VecDeque<Arc<Frame>>) {
    cache.retain(|f| f.t.elapsed() <= CACHE_TTL);
    while cache.len() > CACHE_FRAMES {
        cache.pop_front();
    }
}

pub fn cache_frame(f: Frame) -> Arc<Frame> {
    let f = Arc::new(f);
    let mut cache = CACHE.lock().unwrap();
    cache.push_back(f.clone());
    prune(&mut cache);
    f
}

/// A cached full-res frame, or None once evicted/expired.
pub fn get_frame(id: &str) -> Option<Arc<Frame>> {
    let mut cache = CACHE.lock().unwrap();
    prune(&mut cache);
    cache.iter().find(|f| f.id == id).cloned()
}

#[derive(Debug, Clone, PartialEq)]
pub enum Which {
    Foreground,
    Primary,
    All,
    Id(u32),
}

pub fn parse_which(v: Option<&Value>) -> Result<Which, AgentError> {
    match v {
        None | Some(Value::Null) => Ok(Which::Foreground),
        Some(Value::String(s)) if s == "foreground" => Ok(Which::Foreground),
        Some(Value::String(s)) if s == "primary" => Ok(Which::Primary),
        Some(Value::String(s)) if s == "all" => Ok(Which::All),
        Some(Value::Number(n)) if n.is_u64() => Ok(Which::Id(n.as_u64().unwrap() as u32)),
        Some(Value::Number(n)) if n.is_i64() => Err(AgentError::not_found(format!("no monitor {n}"))),
        _ => Err(AgentError::invalid("monitor must be foreground, primary, all or an id")),
    }
}

fn foreground_monitor(mons: &[MonitorInfo]) -> Option<MonitorInfo> {
    #[cfg(windows)]
    {
        monitors::from_window(mons, crate::window::foreground())
    }
    #[cfg(not(windows))]
    {
        mons.first().cloned()
    }
}

pub fn select(mons: &[MonitorInfo], which: &Which) -> Result<Vec<MonitorInfo>, AgentError> {
    let none = || AgentError::not_found("no monitors");
    Ok(match which {
        Which::Foreground => vec![foreground_monitor(mons).ok_or_else(none)?],
        Which::Primary => vec![monitors::primary(mons).cloned().ok_or_else(none)?],
        Which::All => mons.to_vec(),
        Which::Id(id) => {
            vec![
                mons.iter()
                    .find(|m| m.id == *id)
                    .cloned()
                    .ok_or_else(|| AgentError::not_found(format!("no monitor {id}")))?,
            ]
        }
    })
}

/// [(monitor, rect, is_region)] to grab. A region is clipped to the monitor under its center. Pure.
pub fn targets(
    mons: &[MonitorInfo],
    which: &Which,
    region: Option<Rect>,
) -> Result<Vec<(MonitorInfo, Rect, bool)>, AgentError> {
    let Some(r) = region else {
        return Ok(select(mons, which)?.into_iter().map(|m| (m.clone(), m.rect, false)).collect());
    };
    if r.is_empty() {
        return Err(AgentError::invalid("region must have a positive size"));
    }
    let (cx, cy) = (r.x as f64 + r.w as f64 / 2.0, r.y as f64 + r.h as f64 / 2.0);
    let mon = monitors::containing(mons, cx, cy).ok_or_else(|| AgentError::not_found("no monitors"))?;
    let clipped =
        r.intersect(&mon.rect).ok_or_else(|| AgentError::invalid("region is outside every monitor"))?;
    Ok(vec![(mon.clone(), clipped, true)])
}

/// Grabs full-res BGRA for `rect` on `monitor`: DXGI first, GDI on failure.
#[cfg(windows)]
pub fn grab(monitor: &MonitorInfo, rect: Rect) -> Result<(Vec<u8>, &'static str), AgentError> {
    match dxgi::grab(&monitor.device, rect) {
        Ok(px) => Ok((px, "dxgi")),
        Err(e) => {
            tracing::debug!("dxgi capture of {} failed, using gdi: {}", monitor.device, e.message);
            Ok((gdi::grab(rect)?, "gdi"))
        }
    }
}

#[cfg(windows)]
pub fn grab_frame(monitor: &MonitorInfo, rect: Rect) -> Result<Frame, AgentError> {
    let (bgra, via) = grab(monitor, rect)?;
    Ok(Frame {
        id: format!("f{}", NEXT_ID.fetch_add(1, Ordering::Relaxed)),
        bgra,
        rect,
        monitor: monitor.clone(),
        via,
        t: Instant::now(),
    })
}

fn max_width(args: &Args) -> Result<u32, AgentError> {
    Ok(arg::opt_f64(args, "maxWidth")?.filter(|w| *w > 0.0).map(|w| w as u32).unwrap_or(
        match args.get("maxWidth") {
            None | Some(Value::Null) => DEFAULT_MAX_WIDTH,
            _ => 0,
        },
    ))
}

pub fn quality(args: &Args) -> Result<u8, AgentError> {
    Ok(arg::opt_f64(args, "quality")?
        .filter(|q| (1.0..=100.0).contains(q))
        .map(|q| q as u8)
        .unwrap_or(DEFAULT_QUALITY))
}

#[cfg(windows)]
pub fn cmd_capture(args: &Args) -> CmdResult {
    let which = parse_which(args.get("monitor"))?;
    let region = match args.get("region") {
        None | Some(Value::Null) => None,
        Some(v) => Some(Rect::from_json(v, "region")?),
    };
    let (max_width, quality) = (max_width(args)?, quality(args)?);
    let mons = monitors::enumerate();
    let mut frames = vec![];
    for (mon, rect, is_region) in targets(&mons, &which, region)? {
        let t0 = Instant::now();
        let frame = cache_frame(grab_frame(&mon, rect)?);
        let t1 = Instant::now();
        let (data, w, h) = encode::encode(&frame.bgra, rect.w as u32, rect.h as u32, max_width, quality)?;
        tracing::debug!(
            "capture {} {}x{} via {}: grab {:?} encode {:?}",
            frame.id,
            rect.w,
            rect.h,
            frame.via,
            t1 - t0,
            t1.elapsed()
        );
        let mut f = json!({
            "id": frame.id,
            "monitor": mon.to_json(),
            "width": w,
            "height": h,
            "scale": rect.w as f64 / w as f64,
            "mime": "image/jpeg",
            "data": data,
        });
        if is_region {
            f["region"] = rect.to_json();
        }
        frames.push(f);
    }
    Ok(json!({"frames": frames}))
}

pub fn cmd_monitors() -> CmdResult {
    Ok(json!({"monitors": monitors::enumerate().iter().map(MonitorInfo::to_json).collect::<Vec<_>>()}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(id: u32, x: i32, primary: bool) -> MonitorInfo {
        let r = Rect::new(x, 0, 1920, 1080);
        MonitorInfo { id, device: format!("D{id}"), rect: r, work_area: r, dpi: 96, scale: 1.0, primary }
    }

    #[test]
    fn which_and_targets() {
        let mons = vec![mon(0, -1920, false), mon(1, 0, true)];
        assert_eq!(parse_which(Some(&json!("all"))).unwrap(), Which::All);
        assert_eq!(parse_which(Some(&json!(1))).unwrap(), Which::Id(1));
        assert_eq!(parse_which(Some(&json!("left"))).unwrap_err().code, "E_INVALID");
        assert_eq!(parse_which(Some(&json!(1.5))).unwrap_err().code, "E_INVALID");
        assert_eq!(select(&mons, &Which::Id(9)).unwrap_err().code, "E_NOT_FOUND");
        assert_eq!(select(&mons, &Which::Primary).unwrap()[0].id, 1);
        assert_eq!(select(&mons, &Which::All).unwrap().len(), 2);
        let t = targets(&mons, &Which::All, Some(Rect::new(-100, 10, 300, 50))).unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].0.id, 1, "center (50,35) is on monitor 1");
        assert_eq!(t[0].1, Rect::new(0, 10, 200, 50));
        assert!(t[0].2);
        assert_eq!(targets(&mons, &Which::All, Some(Rect::new(0, 0, 0, 5))).unwrap_err().code, "E_INVALID");
        assert_eq!(
            targets(&mons, &Which::All, Some(Rect::new(-99999, -99999, 5, 5))).unwrap_err().code,
            "E_INVALID"
        );
    }

    #[test]
    fn cache_keeps_three() {
        let ids: Vec<String> = (0..5)
            .map(|i| {
                cache_frame(Frame {
                    id: format!("t{i}"),
                    bgra: vec![],
                    rect: Rect::default(),
                    monitor: mon(0, 0, true),
                    via: "test",
                    t: Instant::now(),
                })
                .id
                .clone()
            })
            .collect();
        assert!(get_frame(&ids[0]).is_none());
        assert!(get_frame(&ids[4]).is_some());
    }
}
