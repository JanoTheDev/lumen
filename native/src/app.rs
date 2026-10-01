//! Shared agent state and command registration.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::dwell::{self, Dwell, MouseWatch};
use crate::hotkey::{self, accel};
use crate::logging;
use crate::proto::router::{CancelToken, Lane, Router};
use crate::proto::{AgentError, Args, CmdResult, arg};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Capabilities whose v2 commands match plans CONTRACTS C2.
pub const CAPABILITIES: &[&str] = &[
    "hotkey",
    "dictation-hotkey",
    "input",
    "capture",
    "ocr",
    "uia",
    "dwell",
    "announce",
    "execute",
    "a11y-state",
];

#[derive(Debug, Clone, Default)]
pub struct Opts {
    pub debug: bool,
    pub accept_injected: bool,
    pub hotkey: Option<String>,
    pub bench: bool,
}

impl Opts {
    pub fn parse(mut args: impl Iterator<Item = String>) -> Result<Self, String> {
        let mut o = Opts::default();
        while let Some(a) = args.next() {
            match a.as_str() {
                "--debug" => o.debug = true,
                "--accept-injected" => o.accept_injected = true,
                "--bench" => o.bench = true,
                "--hotkey" => o.hotkey = Some(args.next().ok_or("--hotkey needs a value")?),
                "--protocol" => match args.next().as_deref() {
                    Some("2") => {}
                    other => return Err(format!("--protocol {other:?} unsupported (native speaks 2)")),
                },
                other if other.starts_with("--hotkey=") => o.hotkey = Some(other[9..].to_owned()),
                other => return Err(format!("unknown argument {other}")),
            }
        }
        Ok(o)
    }
}

type SubscribeFn = Box<dyn Fn(bool) + Send + Sync>;

pub struct App {
    pub router: Arc<Router>,
    pub opts: Opts,
    pub hotkeys: hotkey::Service,
    pub dwell: Dwell,
    pub mouse: MouseWatch,
    log: logging::Handle,
    subscribable: Mutex<BTreeMap<&'static str, SubscribeFn>>,
    subscriptions: Mutex<BTreeSet<String>>,
}

impl App {
    pub fn new(router: Arc<Router>, opts: Opts, log: logging::Handle) -> Arc<Self> {
        let hotkeys = hotkey::Service::new(router.out().clone(), opts.accept_injected);
        let r = router.clone();
        let dwell =
            Dwell::new(router.out().clone(), move || r.lane_busy(Lane::Input, dwell::AUTO_PAUSE_GRACE));
        let mouse = MouseWatch::new(router.out().clone());
        Arc::new(App {
            router,
            hotkeys,
            dwell,
            mouse,
            opts,
            log,
            subscribable: Mutex::new(BTreeMap::new()),
            subscriptions: Mutex::new(BTreeSet::new()),
        })
    }

    pub fn ready_data(&self) -> Value {
        json!({"impl": "native", "version": VERSION, "capabilities": CAPABILITIES})
    }

    /// Registers a command whose handler gets the shared app.
    pub fn cmd<F>(self: &Arc<Self>, name: &str, lane: Lane, timeout_ms: Option<u64>, f: F)
    where
        F: Fn(&Arc<App>, &Args, &CancelToken) -> CmdResult + Send + Sync + 'static,
    {
        let weak = Arc::downgrade(self);
        self.router.register(name, lane, timeout_ms, move |args, token| {
            let app = weak.upgrade().ok_or_else(|| AgentError::internal("shutting down"))?;
            f(&app, args, token)
        });
    }

    pub fn add_subscribable(&self, event: &'static str, toggle: impl Fn(bool) + Send + Sync + 'static) {
        self.subscribable.lock().unwrap().insert(event, Box::new(toggle));
    }

    fn check_events(&self, v: Option<&Value>) -> Result<Vec<String>, AgentError> {
        let list = match v {
            None => return Ok(vec![]),
            Some(Value::Array(a)) => a,
            Some(_) => return Err(AgentError::invalid("events must be a list of event names")),
        };
        let names: Vec<String> = list
            .iter()
            .map(|e| e.as_str().map(str::to_owned))
            .collect::<Option<_>>()
            .ok_or_else(|| AgentError::invalid("events must be a list of event names"))?;
        let known = self.subscribable.lock().unwrap();
        let unknown: Vec<&str> =
            names.iter().filter(|n| !known.contains_key(n.as_str())).map(|s| s.as_str()).collect();
        if !unknown.is_empty() {
            return Err(AgentError::unsupported(format!("cannot subscribe to {}", unknown.join(", "))));
        }
        Ok(names)
    }

    fn set_subscription(&self, event: &str, enabled: bool) {
        if let Some(toggle) = self.subscribable.lock().unwrap().get(event) {
            toggle(enabled);
        }
        let mut subs = self.subscriptions.lock().unwrap();
        if enabled {
            subs.insert(event.to_owned());
        } else {
            subs.remove(event);
        }
    }

    pub fn emit(&self, event: &str, data: Value) {
        self.router.out().emit(event, data);
    }
}

pub fn register_core(app: &Arc<App>) {
    app.cmd("ping", Lane::Inline, None, |_, _, _| {
        let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64();
        Ok(json!({"t": t}))
    });

    app.cmd("cancel", Lane::Inline, None, |app, args, _| {
        let target = args.get("target").filter(|v| v.is_i64() || v.is_u64());
        let target = target.ok_or_else(|| AgentError::invalid("cancel needs a numeric target"))?;
        Ok(json!({"cancelled": app.router.cancel(target)}))
    });

    app.cmd("subscribe", Lane::Inline, None, |app, args, _| {
        let events = app.check_events(args.get("events"))?;
        let enabled = arg::opt_bool(args, "enabled")?.unwrap_or(true);
        for e in &events {
            app.set_subscription(e, enabled);
        }
        Ok(json!({"subscribed": *app.subscriptions.lock().unwrap()}))
    });

    app.cmd("init", Lane::Inline, None, cmd_init);

    app.cmd("input", Lane::Input, None, |_, args, token| crate::input::cmd_input(args, token));
    app.cmd("execute", Lane::Input, None, |_, args, token| crate::execute::cmd_execute(args, token));

    app.cmd("capture", Lane::Read, None, |_, args, _| crate::capture::cmd_capture(args));
    app.cmd("ocr", Lane::Read, None, |_, args, token| crate::ocr::cmd_ocr(args, token));
    app.cmd("monitors", Lane::Read, None, |_, _, _| crate::capture::cmd_monitors());
    app.cmd("marks_render", Lane::Read, None, |_, args, _| crate::capture::marks::cmd_marks_render(args));

    app.cmd("active_window", Lane::Read, None, |_, _, _| {
        let hwnd = crate::window::foreground();
        crate::uia::warm_up(hwnd);
        Ok(crate::window::info(hwnd))
    });
    let uia_timeout = Some(crate::uia::SNAPSHOT_TIMEOUT_MS);
    app.cmd("uia_snapshot", Lane::Uia, uia_timeout, |_, args, token| crate::uia::cmd_snapshot(args, token));
    app.cmd("uia_find", Lane::Uia, uia_timeout, |_, args, token| crate::uia::cmd_find(args, token));
    app.cmd("uia_act", Lane::Input, None, |_, args, token| crate::uia::cmd_act(args, token));
    app.cmd("focus_info", Lane::Read, Some(crate::uia::FOCUS_INFO_TIMEOUT_MS), |_, _, token| {
        crate::uia::cmd_focus_info(token)
    });
    let out = app.router.out().clone();
    app.add_subscribable("focus-changed", move |on| crate::uia::events::set_enabled(&out, on));
    app.cmd("focus_window", Lane::Input, None, |_, args, token| {
        let hwnd = match (arg::opt_i64(args, "hwnd")?, arg::opt_str(args, "process")?) {
            (Some(h), _) => h as isize,
            (None, Some(p)) => crate::window::find_process_window(p)
                .ok_or_else(|| AgentError::not_found(format!("no window for process {p}")))?,
            (None, None) => return Err(AgentError::invalid("focus_window needs hwnd or process")),
        };
        crate::window::focus(hwnd, token)?;
        Ok(json!({"done": true, "hwnd": hwnd}))
    });

    app.cmd("dwell_config", Lane::Inline, None, |app, args, _| Ok(app.dwell.configure(args).to_json()));
    app.cmd("dwell_pause", Lane::Inline, None, |app, _, _| {
        app.dwell.set_paused(true);
        Ok(json!({"paused": true}))
    });
    app.cmd("dwell_resume", Lane::Inline, None, |app, _, _| {
        app.dwell.set_paused(false);
        Ok(json!({"paused": false}))
    });
    let weak = Arc::downgrade(app);
    app.add_subscribable("mouse-moved", move |on| {
        if let Some(app) = weak.upgrade() {
            app.mouse.set_enabled(on);
        }
    });

    app.cmd("announce", Lane::Read, None, |_, args, _| crate::announce::cmd_announce(args));
    app.cmd("a11y_state", Lane::Read, Some(2000), |_, _, _| crate::a11y_state::cmd_a11y_state());

    app.cmd("set_hotkey", Lane::Inline, None, |app, args, _| {
        let combo = arg::opt_str(args, "combo")
            .ok()
            .flatten()
            .ok_or_else(|| AgentError::invalid("set_hotkey needs a combo string"))?;
        app.hotkeys.apply(hotkey::Update { assistant: Some(combo), ..Default::default() })?;
        Ok(json!({"ok": true, "combo": combo}))
    });

    app.cmd("set_dictation_hotkey", Lane::Inline, None, |app, args, _| {
        let combo = arg::opt_str(args, "combo")
            .ok()
            .flatten()
            .ok_or_else(|| AgentError::invalid("set_dictation_hotkey needs a combo string"))?;
        hotkey::Service::validate(&hotkey::Update { dictation: Some(combo), ..Default::default() })?;
        if accel::same_combo(combo, &app.hotkeys.assistant()) {
            return Err(AgentError::invalid("dictation hotkey must differ from the assistant hotkey"));
        }
        app.hotkeys.apply(hotkey::Update { dictation: Some(combo), ..Default::default() })?;
        Ok(json!({"ok": true, "combo": combo}))
    });

    if app.opts.debug {
        app.cmd("debug_emit", Lane::Inline, None, |app, args, _| {
            let n = arg::opt_i64(args, "n")?.unwrap_or(100).clamp(0, 100_000);
            let out = app.router.out().clone();
            std::thread::spawn(move || {
                for i in 0..n {
                    out.emit("debug", json!({"seq": i}));
                    if i % 10 == 0 {
                        println!("stray write {i}");
                        tracing::info!("debug log {i}");
                    }
                }
            });
            Ok(json!({"n": n}))
        });
        let sleep = |_: &Arc<App>, args: &Args, token: &CancelToken| {
            let ms = arg::opt_f64(args, "ms")?.unwrap_or(1000.0).max(0.0);
            token.sleep(Duration::from_secs_f64(ms / 1000.0))?;
            Ok(json!({"slept": true}))
        };
        app.cmd("debug_sleep", Lane::Read, None, sleep);
        app.cmd("debug_sleep_input", Lane::Input, None, sleep);
        app.cmd("debug_parse_hotkey", Lane::Inline, None, |_, args, _| {
            let hk = accel::parse(arg::str(args, "combo")?)?;
            Ok(json!({"mods": accel::mod_names(hk.mods), "key": accel::key_name(hk.vk), "vk": hk.vk, "combo": hk.combo()}))
        });
        app.cmd("debug_panic", Lane::Read, None, |_, _, _| panic!("debug panic"));
    }
}

/// Applies the full agent state. Everything is validated before anything changes.
fn cmd_init(app: &Arc<App>, args: &Args, _: &CancelToken) -> CmdResult {
    let level = logging::parse_level(arg::opt_str(args, "logLevel")?.unwrap_or("info"))?;
    let hotkey = arg::opt_str(args, "hotkey")
        .map_err(|_| AgentError::invalid("init.hotkey must be a string"))?
        .unwrap_or("");
    let mut dictation = arg::opt_str(args, "dictationHotkey")
        .map_err(|_| AgentError::invalid("init.dictationHotkey must be a string"))?
        .unwrap_or("");
    let taps = arg::opt_bool(args, "taps")?.unwrap_or(false);
    let hotkeys = hotkey::Update { assistant: Some(hotkey), dictation: Some(dictation), taps: Some(taps) };
    hotkey::Service::validate(&hotkeys)?;
    let subscriptions = app.check_events(args.get("subscriptions"))?;

    logging::set_level(&app.log, level);
    if accel::same_combo(dictation, hotkey) {
        tracing::warn!("dictation hotkey {dictation:?} equals the assistant hotkey; not bound");
        dictation = "";
    }
    app.hotkeys.apply(hotkey::Update { dictation: Some(dictation), ..hotkeys })?;
    let mut dwell_cfg = arg::obj(args, "dwell").cloned().unwrap_or_default();
    let enabled = dwell_cfg.get("enabled") == Some(&Value::Bool(true));
    dwell_cfg.insert("enabled".into(), json!(enabled));
    app.dwell.configure(&dwell_cfg);
    let known: Vec<&'static str> = app.subscribable.lock().unwrap().keys().copied().collect();
    for event in known {
        app.set_subscription(event, subscriptions.iter().any(|s| s == event));
    }
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(a: &[&str]) -> Result<Opts, String> {
        Opts::parse(a.iter().map(|s| s.to_string()))
    }

    #[test]
    fn opts() {
        let o = parse(&["--protocol", "2", "--debug", "--hotkey", "Ctrl+Shift+Space"]).unwrap();
        assert!(o.debug && !o.accept_injected);
        assert_eq!(o.hotkey.as_deref(), Some("Ctrl+Shift+Space"));
        assert_eq!(parse(&["--hotkey=F9"]).unwrap().hotkey.as_deref(), Some("F9"));
        assert!(parse(&["--protocol", "1"]).is_err());
        assert!(parse(&["--wat"]).is_err());
    }
}
