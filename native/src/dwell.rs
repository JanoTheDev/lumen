//! Dwell clicking: hold the cursor still to click.
//!
//! `Fsm` is pure (fed timestamps + positions). `Dwell` polls the physical
//! cursor at 25 Hz and turns FSM output into `dwell-progress` / `dwell-trigger`
//! events; main performs the click. After a click the cursor must leave the
//! tolerance radius before the next dwell (`maxRepeats` = 0), or at most
//! `maxRepeats` more clicks in place. Paused explicitly and automatically while
//! the agent injects input (+1 s). Optional `snapToElement` asks UIA for the
//! control under the cursor (50 ms budget) so the ring can wrap it.
//!
//! No WH_MOUSE_LL hook: it slowed wheel delivery and broke Ctrl+scroll zoom.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use crate::monitors::{self, MonitorInfo};
use crate::proto::writer::Out;

pub const CLICK_TYPES: &[&str] = &["left", "right", "double", "drag"];
pub const POLL: Duration = Duration::from_millis(40);
pub const BASE_TOLERANCE_PX: f64 = 12.0;
pub const AUTO_PAUSE_GRACE: Duration = Duration::from_secs(1);
const SNAP_BUDGET: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, PartialEq)]
pub enum Ev {
    Progress { x: i32, y: i32, p: f64, active: bool, phase: Option<&'static str> },
    Trigger { x: i32, y: i32, click_type: &'static str, phase: Option<&'static str> },
}

#[derive(Debug, Clone)]
pub struct Fsm {
    pub ms: u32,
    pub cooldown_ms: u32,
    pub click_type: &'static str,
    pub max_repeats: u32,
    /// Physical px; None → BASE_TOLERANCE_PX × monitor scale.
    pub tolerance_px: Option<f64>,
    anchor: Option<(i32, i32)>,
    stable_since: f64,
    last_trigger: f64,
    armed: bool,
    repeats: u32,
    dragging: bool,
    active: bool,
}

impl Default for Fsm {
    fn default() -> Self {
        Fsm {
            ms: 1400,
            cooldown_ms: 1500,
            click_type: "left",
            max_repeats: 0,
            tolerance_px: None,
            anchor: None,
            stable_since: 0.0,
            last_trigger: -1e9,
            armed: true,
            repeats: 0,
            dragging: false,
            active: false,
        }
    }
}

impl Fsm {
    pub fn reset(&mut self) {
        self.anchor = None;
        self.armed = true;
        self.repeats = 0;
        self.dragging = false;
        self.active = false;
    }

    fn phase(&self) -> Option<&'static str> {
        (self.click_type == "drag").then_some(if self.dragging { "drag-end" } else { "drag-start" })
    }

    fn idle(&mut self, x: i32, y: i32, out: &mut Vec<Ev>) {
        if self.active {
            out.push(Ev::Progress { x, y, p: 0.0, active: false, phase: self.phase() });
            self.active = false;
        }
    }

    pub fn anchor(&self) -> Option<(i32, i32)> {
        self.anchor
    }

    /// A dwell is in progress (progress events are flowing).
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Advances one poll (`now` in seconds).
    pub fn step(&mut self, now: f64, x: i32, y: i32, scale: f64, paused: bool) -> Vec<Ev> {
        let mut out = vec![];
        let tol = self.tolerance_px.unwrap_or(BASE_TOLERANCE_PX * scale);
        let moved = match self.anchor {
            None => true,
            Some((ax, ay)) => (((x - ax) as f64).powi(2) + ((y - ay) as f64).powi(2)).sqrt() > tol,
        };
        if moved {
            self.anchor = Some((x, y));
            self.stable_since = now;
            self.armed = true;
            self.repeats = 0;
            self.idle(x, y, &mut out);
            return out;
        }
        if paused {
            self.stable_since = now; // a full dwell is needed after resuming
            self.idle(x, y, &mut out);
            return out;
        }
        let in_cooldown = (now - self.last_trigger) * 1000.0 < self.cooldown_ms as f64;
        if !self.armed {
            if 0 < self.repeats && self.repeats <= self.max_repeats && !in_cooldown {
                self.armed = true;
                self.stable_since = now;
            }
            return out;
        }
        if in_cooldown {
            self.stable_since = now;
            return out;
        }
        let elapsed_ms = (now - self.stable_since) * 1000.0;
        let p = (elapsed_ms / self.ms.max(1) as f64).clamp(0.0, 1.0);
        if elapsed_ms < self.ms as f64 {
            if p > 0.02 {
                out.push(Ev::Progress { x, y, p, active: true, phase: self.phase() });
                self.active = true;
            }
            return out;
        }
        let phase = self.phase();
        out.push(Ev::Progress { x, y, p: 1.0, active: false, phase });
        out.push(Ev::Trigger { x, y, click_type: self.click_type, phase });
        self.active = false;
        self.last_trigger = now;
        self.stable_since = now;
        self.armed = false;
        if phase == Some("drag-start") {
            self.dragging = true;
            self.repeats = self.max_repeats + 1; // the drop needs a move to the destination
        } else {
            if phase == Some("drag-end") {
                self.dragging = false;
            }
            self.repeats += 1;
        }
        out
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub enabled: bool,
    pub ms: u32,
    pub cooldown_ms: u32,
    pub click_type: &'static str,
    pub max_repeats: u32,
    pub move_tolerance_px: Option<f64>,
    pub snap_to_element: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            enabled: false,
            ms: 1400,
            cooldown_ms: 1500,
            click_type: "left",
            max_repeats: 0,
            move_tolerance_px: None,
            snap_to_element: false,
        }
    }
}

impl Config {
    pub fn to_json(&self) -> Value {
        json!({
            "enabled": self.enabled, "ms": self.ms, "cooldownMs": self.cooldown_ms,
            "clickType": self.click_type, "maxRepeats": self.max_repeats,
            "moveTolerancePx": self.move_tolerance_px, "snapToElement": self.snap_to_element,
        })
    }
}

fn num(v: Option<&Value>, lo: f64, hi: f64) -> Option<f64> {
    v.filter(|v| v.is_number()).and_then(Value::as_f64).filter(|n| (lo..=hi).contains(n))
}

/// Validates a dwell_config / init.dwell object; bad or unknown fields keep `base`. Pure.
pub fn parse_config(cfg: &Map<String, Value>, base: &Config) -> Config {
    let mut out = base.clone();
    if let Some(Value::Bool(b)) = cfg.get("enabled") {
        out.enabled = *b;
    }
    if let Some(v) = num(cfg.get("ms").or_else(|| cfg.get("dwell_ms")), 100.0, 60000.0) {
        out.ms = v as u32;
    }
    if let Some(v) = num(cfg.get("cooldownMs").or_else(|| cfg.get("cooldown_ms")), 0.0, 60000.0) {
        out.cooldown_ms = v as u32;
    }
    if let Some(t) =
        cfg.get("clickType").and_then(Value::as_str).and_then(|t| CLICK_TYPES.iter().find(|c| **c == t))
    {
        out.click_type = t;
    }
    if let Some(v) = num(cfg.get("maxRepeats"), 0.0, 1000.0) {
        out.max_repeats = v as u32;
    }
    match cfg.get("moveTolerancePx") {
        Some(Value::Null) => out.move_tolerance_px = None,
        v => {
            if let Some(t) = num(v, 1.0, 500.0) {
                out.move_tolerance_px = Some(t);
            }
        }
    }
    if let Some(Value::Bool(b)) = cfg.get("snapToElement") {
        out.snap_to_element = *b;
    }
    out
}

pub fn geometry(mons: &[MonitorInfo], x: i32, y: i32) -> Map<String, Value> {
    let mut m = Map::new();
    if let Some(mon) = monitors::containing(mons, x as f64, y as f64) {
        let (lx, ly) = mon.to_logical(x as f64, y as f64);
        m.insert("monitorId".into(), json!(mon.id));
        m.insert("scale".into(), json!(mon.scale));
        m.insert("lx".into(), json!((lx * 10.0).round() / 10.0));
        m.insert("ly".into(), json!((ly * 10.0).round() / 10.0));
    }
    m
}

struct Shared {
    config: Config,
    fsm: Fsm,
    stop: Option<Arc<AtomicBool>>,
}

/// The cursor poller. `busy()` reports agent-injected input (auto-pause).
pub struct Dwell {
    out: Out,
    busy: Arc<dyn Fn() -> bool + Send + Sync>,
    paused: Arc<AtomicBool>,
    shared: Arc<Mutex<Shared>>,
}

impl Dwell {
    pub fn new(out: Out, busy: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        Dwell {
            out,
            busy: Arc::new(busy),
            paused: Arc::new(AtomicBool::new(false)),
            shared: Arc::new(Mutex::new(Shared {
                config: Config::default(),
                fsm: Fsm::default(),
                stop: None,
            })),
        }
    }

    pub fn config(&self) -> Config {
        self.shared.lock().unwrap().config.clone()
    }

    pub fn configure(&self, cfg: &Map<String, Value>) -> Config {
        let mut s = self.shared.lock().unwrap();
        let c = parse_config(cfg, &s.config);
        s.fsm.ms = c.ms;
        s.fsm.cooldown_ms = c.cooldown_ms;
        if s.fsm.click_type != c.click_type {
            s.fsm.reset();
        }
        s.fsm.click_type = c.click_type;
        s.fsm.max_repeats = c.max_repeats;
        s.fsm.tolerance_px = c.move_tolerance_px;
        s.config = c.clone();
        if c.enabled && s.stop.is_none() {
            s.fsm.reset();
            let stop = Arc::new(AtomicBool::new(false));
            match self.spawn(stop.clone()) {
                Ok(()) => {
                    s.stop = Some(stop);
                    tracing::info!("dwell started with {}", c.to_json());
                }
                Err(e) => tracing::error!("dwell thread: {e}"),
            }
        } else if !c.enabled
            && let Some(stop) = s.stop.take()
        {
            stop.store(true, Ordering::SeqCst);
            tracing::info!("dwell stopped");
        }
        c
    }

    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
    }

    fn spawn(&self, stop: Arc<AtomicBool>) -> std::io::Result<()> {
        let (out, busy, paused, shared) =
            (self.out.clone(), self.busy.clone(), self.paused.clone(), self.shared.clone());
        std::thread::Builder::new()
            .name("dwell".into())
            .spawn(move || {
                crate::com_init();
                let t0 = Instant::now();
                let mut mons = monitors::enumerate();
                let mut mons_at = Instant::now();
                let mut snap: Option<Value> = None;
                while !stop.load(Ordering::SeqCst) {
                    std::thread::sleep(POLL);
                    let (x, y) = crate::input::sendinput::cursor_pos();
                    if mons_at.elapsed() > Duration::from_secs(2) {
                        mons = monitors::enumerate();
                        mons_at = Instant::now();
                    }
                    let geo = geometry(&mons, x, y);
                    let scale = geo.get("scale").and_then(Value::as_f64).unwrap_or(1.0);
                    let is_paused = paused.load(Ordering::SeqCst) || busy();
                    let (events, moved, started) = {
                        let mut s = shared.lock().unwrap();
                        let (anchor, was_active) = (s.fsm.anchor(), s.fsm.is_active());
                        let events = s.fsm.step(t0.elapsed().as_secs_f64(), x, y, scale, is_paused);
                        let started = s.config.snap_to_element && !was_active && s.fsm.is_active();
                        (events, s.fsm.anchor() != anchor, started)
                    };
                    if moved {
                        snap = None;
                    }
                    if started {
                        snap = snap_element(x, y);
                    }
                    for ev in events {
                        let mut data = Map::new();
                        match ev {
                            Ev::Progress { x, y, p, active, phase } => {
                                data.insert("x".into(), json!(x));
                                data.insert("y".into(), json!(y));
                                data.insert("progress".into(), json!((p * 1000.0).round() / 1000.0));
                                data.insert("active".into(), json!(active));
                                data.extend(geo.clone());
                                if let Some(ph) = phase {
                                    data.insert("phase".into(), json!(ph));
                                }
                                if let Some(el) = &snap {
                                    data.insert("element".into(), el.clone());
                                }
                                out.try_emit("dwell-progress", Value::Object(data));
                            }
                            Ev::Trigger { x, y, click_type, phase } => {
                                data.insert("x".into(), json!(x));
                                data.insert("y".into(), json!(y));
                                data.extend(geo.clone());
                                data.insert("clickType".into(), json!(click_type));
                                if let Some(ph) = phase {
                                    data.insert("phase".into(), json!(ph));
                                }
                                if let Some(el) = &snap {
                                    data.insert("element".into(), el.clone());
                                }
                                out.emit("dwell-trigger", Value::Object(data));
                            }
                        }
                    }
                }
            })
            .map(drop)
    }
}

#[cfg(windows)]
type SnapRequest = (i32, i32, Instant, crossbeam_channel::Sender<Option<Value>>);

/// One long-lived UIA thread answers snap requests (its UIA client is reused). It holds
/// at most one waiting request: while it is stuck in a slow UIA call, new ones are skipped.
#[cfg(windows)]
static SNAP_WORKER: Mutex<Option<crossbeam_channel::Sender<SnapRequest>>> = Mutex::new(None);

#[cfg(windows)]
fn snap_worker() -> Option<crossbeam_channel::Sender<SnapRequest>> {
    let mut worker = SNAP_WORKER.lock().unwrap();
    if worker.is_none() {
        let (tx, rx) = crossbeam_channel::bounded::<SnapRequest>(1);
        let spawned = std::thread::Builder::new().name("dwell-uia".into()).spawn(move || {
            crate::com_init();
            for (x, y, asked, reply) in rx {
                // Nobody waits for an answer past the budget.
                if asked.elapsed() < SNAP_BUDGET {
                    let _ = reply.send(crate::uia::element_at(x, y));
                }
            }
        });
        if let Err(e) = spawned {
            tracing::warn!("dwell snap thread: {e}");
            return None;
        }
        *worker = Some(tx);
    }
    worker.clone()
}

/// {rect, role, name} of the control under (x, y), or None if UIA is slower than the budget.
fn snap_element(x: i32, y: i32) -> Option<Value> {
    #[cfg(windows)]
    {
        use crossbeam_channel::TrySendError;
        let (tx, rx) = crossbeam_channel::bounded(1);
        // UIA cannot be interrupted: stop waiting after the budget.
        match snap_worker()?.try_send((x, y, Instant::now(), tx)) {
            Ok(()) => rx.recv_timeout(SNAP_BUDGET).ok().flatten(),
            Err(TrySendError::Full(_)) => None,
            Err(TrySendError::Disconnected(_)) => {
                // The worker died (a panic in UIA): start a fresh one next time.
                *SNAP_WORKER.lock().unwrap() = None;
                None
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (x, y);
        None
    }
}

/// `mouse-moved` events while subscribed (20 Hz poll, > 12 px moves).
pub struct MouseWatch {
    out: Out,
    stop: Mutex<Option<Arc<AtomicBool>>>,
}

impl MouseWatch {
    pub const MOVE_PX: f64 = 12.0;

    pub fn new(out: Out) -> Self {
        MouseWatch { out, stop: Mutex::new(None) }
    }

    pub fn set_enabled(&self, enabled: bool) {
        let mut stop = self.stop.lock().unwrap();
        if !enabled {
            if let Some(s) = stop.take() {
                s.store(true, Ordering::SeqCst);
            }
            return;
        }
        if stop.is_some() {
            return;
        }
        let flag = Arc::new(AtomicBool::new(false));
        let thread_flag = flag.clone();
        let out = self.out.clone();
        let spawned = std::thread::Builder::new().name("mouse-watch".into()).spawn(move || {
            let flag = thread_flag;
            let mut last = crate::input::sendinput::cursor_pos();
            while !flag.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(50));
                let cur = crate::input::sendinput::cursor_pos();
                let d = (((cur.0 - last.0) as f64).powi(2) + ((cur.1 - last.1) as f64).powi(2)).sqrt();
                if d > Self::MOVE_PX {
                    last = cur;
                    out.try_emit("mouse-moved", json!({}));
                }
            }
        });
        match spawned {
            Ok(_) => *stop = Some(flag),
            Err(e) => tracing::error!("mouse watch thread: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(f: &mut Fsm, from: f64, to: f64, x: i32, y: i32, paused: bool) -> Vec<Ev> {
        let mut out = vec![];
        let mut t = from;
        while t <= to + 1e-9 {
            out.extend(f.step(t, x, y, 1.0, paused));
            t += 0.04;
        }
        out
    }

    fn triggers(evs: &[Ev]) -> usize {
        evs.iter().filter(|e| matches!(e, Ev::Trigger { .. })).count()
    }

    #[test]
    fn resting_clicks_exactly_once() {
        let mut f = Fsm { ms: 1000, cooldown_ms: 500, ..Fsm::default() };
        let evs = run(&mut f, 0.0, 10.0, 100, 100, false);
        assert_eq!(triggers(&evs), 1);
        // Leaving and coming back re-arms.
        f.step(10.1, 300, 300, 1.0, false);
        let evs = run(&mut f, 10.2, 12.0, 300, 300, false);
        assert_eq!(triggers(&evs), 1);
    }

    #[test]
    fn small_jitter_stays_within_tolerance_scaled() {
        let mut f = Fsm { ms: 400, cooldown_ms: 0, ..Fsm::default() };
        f.step(0.0, 100, 100, 1.5, false);
        let mut n = 0;
        for i in 1..20 {
            n += triggers(&f.step(i as f64 * 0.04, 100 + (i % 2) * 15, 100, 1.5, false));
        }
        assert_eq!(n, 1, "15 px jitter < 18 px tolerance at 150 %");
    }

    #[test]
    fn max_repeats_in_place() {
        let mut f = Fsm { ms: 200, cooldown_ms: 300, max_repeats: 2, ..Fsm::default() };
        assert_eq!(triggers(&run(&mut f, 0.0, 10.0, 5, 5, false)), 3);
    }

    #[test]
    fn paused_never_clicks_and_needs_full_dwell_after() {
        let mut f = Fsm { ms: 500, cooldown_ms: 0, ..Fsm::default() };
        assert_eq!(triggers(&run(&mut f, 0.0, 3.0, 5, 5, true)), 0);
        let evs = run(&mut f, 3.04, 3.4, 5, 5, false);
        assert_eq!(triggers(&evs), 0);
        assert_eq!(triggers(&run(&mut f, 3.44, 3.7, 5, 5, false)), 1);
    }

    #[test]
    fn drag_needs_a_move_between_start_and_end() {
        let mut f = Fsm { ms: 200, cooldown_ms: 0, click_type: "drag", ..Fsm::default() };
        let evs = run(&mut f, 0.0, 2.0, 5, 5, false);
        assert!(evs.contains(&Ev::Trigger { x: 5, y: 5, click_type: "drag", phase: Some("drag-start") }));
        assert_eq!(triggers(&evs), 1);
        let evs = run(&mut f, 2.04, 3.0, 400, 5, false);
        assert!(evs.contains(&Ev::Trigger { x: 400, y: 5, click_type: "drag", phase: Some("drag-end") }));
    }

    #[test]
    fn config_parsing_keeps_base_on_bad_values() {
        let base = Config::default();
        let c = parse_config(
            json!({"enabled": true, "ms": 50, "dwell_ms": 900, "cooldownMs": 700, "clickType": "nope",
                   "maxRepeats": -1, "moveTolerancePx": 20, "snapToElement": true})
            .as_object()
            .unwrap(),
            &base,
        );
        assert!(c.enabled && c.snap_to_element);
        assert_eq!((c.ms, c.cooldown_ms, c.click_type, c.max_repeats), (1400, 700, "left", 0));
        assert_eq!(c.move_tolerance_px, Some(20.0));
        let c = parse_config(json!({"ms": 900, "moveTolerancePx": null}).as_object().unwrap(), &c);
        assert_eq!((c.ms, c.move_tolerance_px), (900, None));
        assert_eq!(c.to_json()["clickType"], "left");
    }
}
