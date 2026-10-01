//! Command routing: lanes, cancel tokens and timeouts.
//!
//! - inline: runs on the reader thread and must return within a few ms.
//! - input: one FIFO worker, so synthetic input never interleaves.
//! - read: a pool of three for capture, window queries, OCR.
//! - uia: one dedicated COM worker (UI Automation calls cannot be interrupted).
//!
//! Every queued call gets a [`CancelToken`]. `cancel` answers the target with
//! E_CANCELLED immediately and flags the token; the worker stops at its next
//! check and its late result is dropped. `timeoutMs` (or the command default)
//! does the same with E_TIMEOUT.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock, Weak};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender, unbounded};
use serde_json::Value;

use super::writer::Out;
use super::{AgentError, Args, CmdResult, E_CANCELLED, E_TIMEOUT, Request};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Lane {
    Inline,
    Input,
    Read,
    Uia,
}

const QUEUED_LANES: [Lane; 3] = [Lane::Input, Lane::Read, Lane::Uia];

fn lane_index(lane: Lane) -> usize {
    match lane {
        Lane::Inline => 0,
        Lane::Input => 1,
        Lane::Read => 2,
        Lane::Uia => 3,
    }
}

pub type Handler = Arc<dyn Fn(&Args, &CancelToken) -> CmdResult + Send + Sync>;

#[derive(Default)]
struct TokenState {
    code: Mutex<Option<&'static str>>,
    cv: Condvar,
}

#[derive(Clone, Default)]
pub struct CancelToken(Arc<TokenState>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.code.lock().unwrap().is_some()
    }

    pub fn cancel(&self, code: &'static str) {
        let mut c = self.0.code.lock().unwrap();
        if c.is_none() {
            *c = Some(code);
            self.0.cv.notify_all();
        }
    }

    fn error(code: &'static str) -> AgentError {
        AgentError::new(code, if code == E_CANCELLED { "cancelled" } else { "timed out" })
    }

    /// Err(E_CANCELLED | E_TIMEOUT) once cancelled.
    pub fn check(&self) -> Result<(), AgentError> {
        match *self.0.code.lock().unwrap() {
            Some(code) => Err(Self::error(code)),
            None => Ok(()),
        }
    }

    /// Sleeps up to `d`, returning early with an error when cancelled.
    pub fn sleep(&self, d: Duration) -> Result<(), AgentError> {
        let deadline = Instant::now() + d;
        let mut code = self.0.code.lock().unwrap();
        loop {
            if let Some(c) = *code {
                return Err(Self::error(c));
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(());
            }
            code = self.0.cv.wait_timeout(code, deadline - now).unwrap().0;
        }
    }
}

struct Entry {
    handler: Handler,
    lane: Lane,
    timeout: Option<Duration>,
}

struct Call {
    key: String,
    id: Value,
    cmd: String,
    token: CancelToken,
}

type Job = Box<dyn FnOnce() + Send>;

struct LaneStats {
    active: AtomicUsize,
    idle_at: Mutex<Option<Instant>>,
}

pub struct Router {
    out: Out,
    commands: RwLock<HashMap<String, Entry>>,
    inflight: Mutex<HashMap<String, Arc<Call>>>,
    lanes: HashMap<Lane, Sender<Job>>,
    stats: [LaneStats; 4],
    timer: Sender<(Instant, Arc<Call>)>,
}

fn key_of(id: &Value) -> String {
    id.to_string()
}

fn run_handler(cmd: &str, handler: &Handler, args: &Args, token: &CancelToken) -> CmdResult {
    match catch_unwind(AssertUnwindSafe(|| handler(args, token))) {
        Ok(r) => r,
        Err(panic) => {
            let msg = panic
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_default();
            tracing::error!("{cmd} panicked: {msg}");
            Err(AgentError::internal(format!("{cmd} failed: {msg}")))
        }
    }
}

impl Router {
    /// `worker_init` runs once on every lane worker thread (COM apartment setup).
    pub fn new(out: Out, read_workers: usize, worker_init: fn()) -> Arc<Self> {
        let (timer_tx, timer_rx) = unbounded();
        let mut lanes = HashMap::new();
        let mut receivers = Vec::new();
        for lane in QUEUED_LANES {
            let (tx, rx) = unbounded::<Job>();
            lanes.insert(lane, tx);
            let n = if lane == Lane::Read { read_workers.max(1) } else { 1 };
            receivers.push((lane, rx, n));
        }
        let router = Arc::new(Router {
            out,
            commands: RwLock::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
            lanes,
            stats: std::array::from_fn(|_| LaneStats {
                active: AtomicUsize::new(0),
                idle_at: Mutex::new(None),
            }),
            timer: timer_tx,
        });
        for (lane, rx, n) in receivers {
            for i in 0..n {
                let rx: Receiver<Job> = rx.clone();
                std::thread::Builder::new()
                    .name(format!("{lane:?}-{i}").to_lowercase())
                    .spawn(move || {
                        worker_init();
                        for job in rx {
                            job();
                        }
                    })
                    .expect("spawn lane worker");
            }
        }
        let weak = Arc::downgrade(&router);
        std::thread::Builder::new()
            .name("timeouts".into())
            .spawn(move || timer_loop(weak, timer_rx))
            .expect("spawn timer");
        router
    }

    pub fn out(&self) -> &Out {
        &self.out
    }

    pub fn register<F>(&self, cmd: &str, lane: Lane, timeout_ms: Option<u64>, f: F)
    where
        F: Fn(&Args, &CancelToken) -> CmdResult + Send + Sync + 'static,
    {
        self.commands.write().unwrap().insert(
            cmd.to_owned(),
            Entry { handler: Arc::new(f), lane, timeout: timeout_ms.map(Duration::from_millis) },
        );
    }

    pub fn dispatch(self: &Arc<Self>, req: Request) {
        let Request { id, cmd, args } = req;
        let found = cmd.as_deref().and_then(|c| {
            let map = self.commands.read().unwrap();
            map.get(c).map(|e| (e.handler.clone(), e.lane, e.timeout))
        });
        let cmd = cmd.unwrap_or_else(|| "(none)".into());
        let Some((handler, lane, default_timeout)) = found else {
            self.out.respond(&id, &Err(AgentError::unsupported(format!("Unknown command: {cmd}"))));
            return;
        };
        if lane == Lane::Inline {
            let result = run_handler(&cmd, &handler, &args, &CancelToken::new());
            self.out.respond(&id, &result);
            return;
        }

        let call = Arc::new(Call { key: key_of(&id), id, cmd, token: CancelToken::new() });
        self.inflight.lock().unwrap().insert(call.key.clone(), call.clone());
        let timeout = match args.get("timeoutMs") {
            Some(Value::Number(n)) => {
                n.as_f64().filter(|ms| *ms > 0.0).map(|ms| Duration::from_secs_f64(ms / 1000.0))
            }
            _ => None,
        }
        .or(default_timeout);
        if let Some(t) = timeout {
            let _ = self.timer.send((Instant::now() + t, call.clone()));
        }

        let stats = &self.stats[lane_index(lane)];
        stats.active.fetch_add(1, Ordering::SeqCst);
        let router = self.clone();
        let job: Job = Box::new(move || {
            if !call.token.is_cancelled() {
                let result = run_handler(&call.cmd, &handler, &args, &call.token);
                router.finish(&call, result);
            }
            let stats = &router.stats[lane_index(lane)];
            *stats.idle_at.lock().unwrap() = Some(Instant::now());
            stats.active.fetch_sub(1, Ordering::SeqCst);
        });
        if self.lanes[&lane].send(job).is_err() {
            tracing::error!("lane {lane:?} is gone");
        }
    }

    /// Sends the call's response unless it was already answered (cancel/timeout).
    fn finish(&self, call: &Arc<Call>, result: CmdResult) -> bool {
        {
            let mut map = self.inflight.lock().unwrap();
            match map.get(&call.key) {
                Some(c) if Arc::ptr_eq(c, call) => {
                    map.remove(&call.key);
                }
                _ => return false,
            }
        }
        self.out.respond(&call.id, &result);
        true
    }

    /// Cancels an in-flight call by numeric id. False when it already finished.
    pub fn cancel(&self, target: &Value) -> bool {
        let call = self.inflight.lock().unwrap().get(&key_of(target)).cloned();
        let Some(call) = call else { return false };
        call.token.cancel(E_CANCELLED);
        self.finish(&call, Err(AgentError::new(E_CANCELLED, format!("{} cancelled", call.cmd))))
    }

    /// True while `lane` has queued/running calls, or went idle less than `grace` ago.
    pub fn lane_busy(&self, lane: Lane, grace: Duration) -> bool {
        let stats = &self.stats[lane_index(lane)];
        if stats.active.load(Ordering::SeqCst) > 0 {
            return true;
        }
        stats.idle_at.lock().unwrap().is_some_and(|t| t.elapsed() < grace)
    }

    pub fn inflight_count(&self) -> usize {
        self.inflight.lock().unwrap().len()
    }
}

struct Deadline(Instant, Arc<Call>);
impl PartialEq for Deadline {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}
impl Eq for Deadline {}
impl PartialOrd for Deadline {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Deadline {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.cmp(&other.0)
    }
}

fn timer_loop(router: Weak<Router>, rx: Receiver<(Instant, Arc<Call>)>) {
    let mut heap: BinaryHeap<Reverse<Deadline>> = BinaryHeap::new();
    loop {
        let wait = heap.peek().map(|Reverse(d)| d.0.saturating_duration_since(Instant::now()));
        let got = match wait {
            Some(w) => rx.recv_timeout(w).map_err(|e| e.is_disconnected()),
            None => rx.recv().map_err(|_| true),
        };
        match got {
            Ok((at, call)) => heap.push(Reverse(Deadline(at, call))),
            Err(true) => return,
            Err(false) => {}
        }
        let now = Instant::now();
        while heap.peek().is_some_and(|Reverse(d)| d.0 <= now) {
            let Reverse(Deadline(_, call)) = heap.pop().unwrap();
            let Some(router) = router.upgrade() else { return };
            if !call.token.is_cancelled() {
                call.token.cancel(E_TIMEOUT);
                router.finish(&call, Err(AgentError::new(E_TIMEOUT, format!("{} timed out", call.cmd))));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::writer;
    use serde_json::json;
    use std::io::Write;

    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn setup() -> (Arc<Router>, Sink) {
        let sink = Sink::default();
        let (out, _) = writer::start(Box::new(sink.clone()));
        let router = Router::new(out, 3, || {});
        router.register("echo", Lane::Inline, None, |args, _| Ok(Value::Object(args.clone())));
        router.register("sleep", Lane::Read, None, |args, t| {
            t.sleep(Duration::from_millis(args["ms"].as_u64().unwrap()))?;
            Ok(json!({"slept": true}))
        });
        router.register("boom", Lane::Input, None, |_, _| panic!("kaboom"));
        (router, sink)
    }

    fn lines(router: &Router, sink: &Sink) -> Vec<Value> {
        router.out().flush(Duration::from_secs(2));
        String::from_utf8(sink.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn req(id: i64, cmd: &str, args: Value) -> Request {
        Request { id: json!(id), cmd: Some(cmd.into()), args: args.as_object().cloned().unwrap_or_default() }
    }

    fn wait_for(router: &Router, sink: &Sink, n: usize) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let l = lines(router, sink);
            if l.len() >= n || Instant::now() > deadline {
                return l;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn unknown_and_inline() {
        let (r, s) = setup();
        r.dispatch(req(1, "nope", json!({})));
        r.dispatch(req(2, "echo", json!({"a": 1})));
        let l = wait_for(&r, &s, 2);
        assert_eq!(l[0]["error"]["code"], "E_UNSUPPORTED");
        assert_eq!(l[1]["result"], json!({"a": 1}));
    }

    #[test]
    fn cancel_answers_immediately_and_drops_late_result() {
        let (r, s) = setup();
        r.dispatch(req(5, "sleep", json!({"ms": 5000})));
        std::thread::sleep(Duration::from_millis(50));
        let t0 = Instant::now();
        assert!(r.cancel(&json!(5)));
        let l = wait_for(&r, &s, 1);
        assert!(t0.elapsed() < Duration::from_millis(300));
        assert_eq!(l[0]["error"]["code"], "E_CANCELLED");
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(lines(&r, &s).len(), 1);
        assert!(!r.cancel(&json!(5)));
    }

    #[test]
    fn timeout_ms_arg() {
        let (r, s) = setup();
        r.dispatch(req(6, "sleep", json!({"ms": 3000, "timeoutMs": 100})));
        let l = wait_for(&r, &s, 1);
        assert_eq!(l[0]["error"]["code"], "E_TIMEOUT");
    }

    #[test]
    fn panic_becomes_internal_error() {
        let (r, s) = setup();
        r.dispatch(req(7, "boom", json!({})));
        let l = wait_for(&r, &s, 1);
        assert_eq!(l[0]["error"]["code"], "E_INTERNAL");
        assert!(l[0]["error"]["message"].as_str().unwrap().contains("kaboom"));
    }

    #[test]
    fn lane_busy_with_grace() {
        let (r, s) = setup();
        r.dispatch(req(8, "sleep", json!({"ms": 100})));
        assert!(r.lane_busy(Lane::Read, Duration::ZERO));
        wait_for(&r, &s, 1);
        std::thread::sleep(Duration::from_millis(20));
        assert!(!r.lane_busy(Lane::Read, Duration::ZERO));
        assert!(r.lane_busy(Lane::Read, Duration::from_secs(5)));
    }
}
