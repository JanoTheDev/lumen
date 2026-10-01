//! lumen-native: the Lumen OS sidecar. Speaks agent protocol v2 over stdio.
// Shared helpers land before every module uses them; dropped once the port is complete.
#![allow(dead_code)]

mod a11y_state;
mod announce;
mod app;
mod bench;
mod capture;
mod dpi;
mod dwell;
#[cfg(windows)]
mod execute;
mod geom;
mod hotkey;
mod input;
mod logging;
mod monitors;
mod ocr;
mod proto;
mod stdio;
#[cfg(windows)]
mod uia;
mod wake;
mod window;

use std::io::BufRead;
use std::time::{Duration, Instant};

use app::{App, Opts};
use proto::router::Router;

const READ_WORKERS: usize = 3;
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);

/// Lane workers join the COM multithreaded apartment so UIA/WinRT objects can move between them.
pub(crate) fn com_init() {
    #[cfg(windows)]
    // SAFETY: called once at thread start; the apartment lives as long as the thread.
    unsafe {
        use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn main() {
    let sink = stdio::claim_stdout();
    let log = logging::init();
    let awareness = dpi::init();

    let opts = match Opts::parse(std::env::args().skip(1)) {
        Ok(o) => o,
        Err(e) => {
            tracing::error!("{e}");
            std::process::exit(2);
        }
    };
    tracing::info!("lumen-native {} dpi awareness={awareness}", app::VERSION);
    if opts.bench {
        std::process::exit(bench::run(sink));
    }

    let (out, writer) = proto::writer::start(sink);
    let router = Router::new(out.clone(), READ_WORKERS, com_init);
    let app = App::new(router.clone(), opts, log);
    out.emit("ready", app.ready_data());
    app::register_core(&app);
    #[cfg(windows)]
    std::thread::spawn(|| {
        com_init();
        let devices: Vec<String> = monitors::enumerate().into_iter().map(|m| m.device).collect();
        capture::dxgi::warm(&devices);
    });
    if let Some(accel) = app.opts.hotkey.clone()
        && let Err(e) = app.hotkeys.apply(hotkey::Update { assistant: Some(&accel), ..Default::default() })
    {
        tracing::error!("--hotkey {accel:?} rejected: {}", e.message);
    }

    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let mut buf = Vec::with_capacity(4096);
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        match proto::parse_line(&String::from_utf8_lossy(&buf)) {
            None => {}
            Some(Ok(req)) => router.dispatch(req),
            Some(Err(line)) => out.emit("protocol-error", serde_json::json!({"line": line})),
        }
    }

    // stdin closed: let in-flight calls answer, then flush and exit (hook/pump threads die with us).
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while router.inflight_count() > 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    out.flush(Duration::from_secs(2));
    drop(writer);
    std::process::exit(0);
}
