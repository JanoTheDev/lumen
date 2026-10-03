//! `lumen-native --bench`: latency of the hot paths on this machine, printed
//! as a table on stdout. Read-only except one zero-delta mouse move per
//! `inject` sample: typing is measured up to the SendInput call (event build +
//! INPUT structs) and never sent, so nothing lands in the user's apps. Speech is
//! synthesized to a byte buffer only, never played.

use std::io::Write;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::proto::Args;
use crate::proto::router::CancelToken;

const TYPE_TEXT: &str = "The quick brown fox jumps over the lazy dog. Ünïcödé ✓ 12345\n";

struct Stats {
    name: &'static str,
    note: String,
    samples: Vec<Duration>,
}

impl Stats {
    fn line(&self) -> String {
        let mut s = self.samples.clone();
        if s.is_empty() {
            return format!("{:<16} {:>4}  {:>9} {:>9} {:>9}  {}", self.name, 0, "-", "-", "-", self.note);
        }
        s.sort();
        let ms = |d: Duration| format!("{:.3}", d.as_secs_f64() * 1000.0);
        let p95 = s[((s.len() as f64 * 0.95).ceil() as usize).saturating_sub(1)];
        format!(
            "{:<16} {:>4}  {:>9} {:>9} {:>9}  {}",
            self.name,
            s.len(),
            ms(s[0]),
            ms(s[s.len() / 2]),
            ms(p95),
            self.note
        )
    }
}

fn time<T>(n: usize, mut f: impl FnMut() -> Result<T, String>) -> (Vec<Duration>, Option<T>, Option<String>) {
    let mut out = Vec::with_capacity(n);
    let mut last = None;
    for _ in 0..n {
        let t0 = Instant::now();
        match f() {
            Ok(v) => {
                out.push(t0.elapsed());
                last = Some(v);
            }
            Err(e) => return (out, last, Some(e)),
        }
    }
    (out, last, None)
}

fn args(v: Value) -> Args {
    v.as_object().cloned().unwrap_or_default()
}

fn count_nodes(v: &Value) -> usize {
    1 + v.get("children").and_then(Value::as_array).map_or(0, |c| c.iter().map(count_nodes).sum())
}

fn tts_note(out: Option<&Value>) -> String {
    let field = |k: &str| out.and_then(|v| v.get(k)).cloned().unwrap_or(Value::Null);
    format!("44 chars → {} WAV bytes, {} (not played)", field("bytes"), field("voice"))
}

#[cfg(windows)]
fn run_all() -> Vec<Stats> {
    use crate::input::sendinput;
    use crate::{capture, monitors, ocr, tts, uia, window};

    let token = CancelToken::new();
    let mut rows = vec![];
    let err = |e: crate::proto::AgentError| e.message;

    let mons = monitors::enumerate();
    let primary = monitors::primary(&mons).cloned();
    let size = primary.as_ref().map_or(String::new(), |m| format!("{}x{}", m.rect.w, m.rect.h));
    capture::dxgi::warm(&mons.iter().map(|m| m.device.clone()).collect::<Vec<_>>());

    if let Some(mon) = primary.clone() {
        let (s, f, e) = time(30, || capture::grab_frame(&mon, mon.rect).map_err(err));
        let via = f.map_or("?", |f| f.via);
        rows.push(Stats { name: "capture.grab", note: e.unwrap_or(format!("{size} via {via}")), samples: s });
    }
    let cap = args(json!({"monitor": "primary"}));
    let (s, _, e) = time(30, || capture::cmd_capture(&cap).map_err(err));
    rows.push(Stats {
        name: "capture",
        note: e.unwrap_or(format!("{size} grab+jpeg 1280 q75+base64")),
        samples: s,
    });

    match primary.as_ref().map(|m| capture::grab_frame(m, m.rect)) {
        Some(Ok(frame)) => {
            let (s, out, e) = time(5, || ocr::recognize(&frame.bgra, frame.rect, None, &token).map_err(err));
            let words = out.map_or(0, |o| o.words.len());
            rows.push(Stats { name: "ocr", note: e.unwrap_or(format!("{size}, {words} words")), samples: s });
        }
        Some(Err(e)) => rows.push(Stats { name: "ocr", note: e.message, samples: vec![] }),
        None => rows.push(Stats { name: "ocr", note: "no monitor".into(), samples: vec![] }),
    }

    let fg = window::foreground();
    let title: String =
        window::info(fg).get("title").and_then(Value::as_str).unwrap_or("").chars().take(40).collect();
    let snap = args(json!({"scope": fg}));
    let (s, _, e) = time(1, || uia::cmd_snapshot(&snap, &token).map_err(err));
    rows.push(Stats { name: "uia.cold", note: e.unwrap_or_else(|| format!("\"{title}\"")), samples: s });
    let (s, out, e) = time(10, || uia::cmd_snapshot(&snap, &token).map_err(err));
    let nodes = out.as_ref().and_then(|v| v.get("root")).map_or(0, count_nodes);
    rows.push(Stats { name: "uia.warm", note: e.unwrap_or(format!("{nodes} nodes")), samples: s });
    let (s, out, e) = time(20, || uia::cmd_focus_info(&token).map_err(err));
    let role = out.as_ref().and_then(|v| v.get("role")).cloned().unwrap_or(Value::Null);
    rows.push(Stats { name: "focus_info", note: e.unwrap_or(format!("focused {role}")), samples: s });
    if window::find_browser().is_some() {
        let (s, out, e) = time(5, || uia::browser::cmd_browser_url(&Args::new(), &token).map_err(err));
        let browser = out.as_ref().and_then(|v| v.get("browser")).cloned().unwrap_or(Value::Null);
        rows.push(Stats { name: "browser_url", note: e.unwrap_or(format!("{browser}")), samples: s });
    }

    let chars = TYPE_TEXT.chars().count();
    let (s, keys, _) = time(200, || Ok(sendinput::key_inputs(&sendinput::text_events(TYPE_TEXT)).len()));
    let keys = keys.unwrap_or(0);
    let batches = keys.div_ceil(sendinput::BATCH);
    let pauses = batches.saturating_sub(1) as u32 * sendinput::BATCH_PAUSE;
    rows.push(Stats {
        name: "type.prep",
        note: format!(
            "{chars} chars → {keys} events, {batches} batches (+{pauses:?} pauses when sent; not sent)"
        ),
        samples: s,
    });
    let thread = 0;
    let (s, _, _) =
        time(200, || Ok(sendinput::key_inputs(&sendinput::text_events_vk(TYPE_TEXT, thread)).len()));
    rows.push(Stats { name: "type.prep.vk", note: "VkKeyScanExW layout mode (not sent)".into(), samples: s });
    let tts_args = args(json!({"text": "The quick brown fox jumps over the lazy dog."}));
    let (s, out, e) = time(1, || tts::cmd_synthesize(&tts_args, &token).map_err(err));
    rows.push(Stats { name: "tts.cold", note: e.unwrap_or_else(|| tts_note(out.as_ref())), samples: s });
    let (s, out, e) = time(5, || tts::cmd_synthesize(&tts_args, &token).map_err(err));
    rows.push(Stats { name: "tts.warm", note: e.unwrap_or_else(|| tts_note(out.as_ref())), samples: s });
    let (s, _, e) = time(50, || sendinput::nudge().map_err(err));
    rows.push(Stats {
        name: "inject",
        note: e.unwrap_or("SendInput, 1 zero-delta mouse move".into()),
        samples: s,
    });
    rows
}

#[cfg(not(windows))]
fn run_all() -> Vec<Stats> {
    vec![]
}

pub fn run(mut out: Box<dyn Write + Send>) -> i32 {
    crate::com_init();
    let started = Instant::now();
    let rows = run_all();
    let mut text = format!(
        "lumen-native {} bench (ms)\n{:<16} {:>4}  {:>9} {:>9} {:>9}  note\n",
        crate::app::VERSION,
        "metric",
        "n",
        "min",
        "median",
        "p95"
    );
    for r in &rows {
        text.push_str(&r.line());
        text.push('\n');
    }
    text.push_str(&format!("total {:.1} s\n", started.elapsed().as_secs_f64()));
    let ok = out.write_all(text.as_bytes()).and_then(|_| out.flush()).is_ok();
    if ok && rows.iter().all(|r| !r.samples.is_empty()) { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_line() {
        let ms = Duration::from_millis;
        let s = Stats { name: "x", note: "n".into(), samples: vec![ms(3), ms(1), ms(2)] };
        let line = s.line();
        assert!(line.contains("1.00") && line.contains("2.00") && line.contains("3.00"), "{line}");
        assert!(Stats { name: "y", note: String::new(), samples: vec![] }.line().contains('-'));
    }

    #[test]
    fn nodes() {
        assert_eq!(count_nodes(&json!({"children": [{}, {"children": [{}]}]})), 4);
    }
}
