//! Offline wake word + voice cancel (Vosk grammar mode). Free, local, no cloud.
//!
//! The recognizer only knows the configured phrases plus "[unk]". Wake fires
//! on a final containing the phrase (or a partial that is exactly it); cancel
//! phrases fire only while main has armed them. Audio: cpal default input →
//! mono → 16 kHz i16 blocks of 250 ms → drop-oldest queue → energy gate →
//! recognizer thread. A device error reopens the default device after 1 s.

pub mod logic;
#[cfg(windows)]
mod vosk;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use crate::proto::writer::Out;
use crate::proto::{AgentError, Args, arg};
use logic::PhraseMap;

const QUEUE_BLOCKS: usize = 20;

pub fn model_dir() -> PathBuf {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default();
    home.join(".ai-overlay").join("vosk-model")
}

#[derive(Default)]
struct State {
    stop: Option<Arc<AtomicBool>>,
    thread: Option<std::thread::JoinHandle<()>>,
    phrase: String,
    last_error: Option<String>,
    grammar: Vec<String>,
    oov: Vec<String>,
}

pub struct Service {
    out: Out,
    armed: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    state: Arc<Mutex<State>>,
}

/// Builds the phrase map; None when there is nothing to listen for. Pure.
pub fn phrase_map(wake: &str, cancel: &[String]) -> Option<PhraseMap> {
    let mut map = PhraseMap::new();
    let w = logic::normalize(wake);
    if !w.is_empty() {
        map.insert("wake", vec![w]);
    }
    let c: Vec<String> = cancel.iter().map(|p| logic::normalize(p)).filter(|p| !p.is_empty()).collect();
    if !c.is_empty() {
        map.insert("cancel", c);
    }
    (!map.is_empty()).then_some(map)
}

pub fn cancel_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

pub fn energy_floor(args: &Args) -> f64 {
    arg::opt_f64(args, "energyFloor")
        .ok()
        .flatten()
        .filter(|f| *f >= 0.0)
        .unwrap_or(logic::DEFAULT_ENERGY_FLOOR)
}

impl Service {
    pub fn new(out: Out) -> Self {
        Service {
            out,
            armed: Arc::new(AtomicBool::new(false)),
            dropped: Arc::new(AtomicU64::new(0)),
            state: Arc::new(Mutex::new(State::default())),
        }
    }

    pub fn set_cancel_armed(&self, armed: bool) {
        self.armed.store(armed, Ordering::SeqCst);
    }

    pub fn stop(&self) {
        let (stop, thread) = {
            let mut s = self.state.lock().unwrap();
            (s.stop.take(), s.thread.take())
        };
        if let Some(stop) = stop {
            stop.store(true, Ordering::SeqCst);
        }
        // Not joined: model loading cannot be interrupted and stop runs on the inline lane.
        // The old thread notices the flag within 250 ms (or right after loading) and exits.
        drop(thread);
    }

    pub fn start(&self, map: PhraseMap, floor: f64) -> Result<(), AgentError> {
        self.stop();
        let stop = Arc::new(AtomicBool::new(false));
        let phrase = map.iter().map(|(k, v)| format!("{k}:{}", v.join(","))).collect::<Vec<_>>().join(" / ");
        let (out, armed, dropped, state) =
            (self.out.clone(), self.armed.clone(), self.dropped.clone(), self.state.clone());
        let flag = stop.clone();
        let thread = std::thread::Builder::new()
            .name("wake".into())
            .spawn(move || listen(map, floor, flag, out, armed, dropped, state))
            .map_err(|e| AgentError::internal(format!("wake thread: {e}")))?;
        let mut s = self.state.lock().unwrap();
        s.stop = Some(stop);
        s.thread = Some(thread);
        s.phrase = phrase;
        s.grammar.clear();
        s.oov.clear();
        self.dropped.store(0, Ordering::SeqCst);
        Ok(())
    }

    pub fn status(&self) -> Value {
        let s = self.state.lock().unwrap();
        let dir = model_dir();
        json!({
            "running": s.thread.as_ref().is_some_and(|t| !t.is_finished()),
            "phrase": s.phrase,
            "model_dir": dir.display().to_string(),
            "model_exists": logic::resolve_model_path(&dir).is_some(),
            "last_error": s.last_error,
            "cancel_armed": self.armed.load(Ordering::SeqCst),
            "grammar": s.grammar,
            "oov": s.oov,
            "dropped": self.dropped.load(Ordering::SeqCst),
        })
    }
}

#[cfg(not(windows))]
fn listen(
    _: PhraseMap,
    _: f64,
    _: Arc<AtomicBool>,
    _: Out,
    _: Arc<AtomicBool>,
    _: Arc<AtomicU64>,
    s: Arc<Mutex<State>>,
) {
    s.lock().unwrap().last_error = Some("wake word needs Windows".into());
}

#[cfg(windows)]
fn listen(
    map: PhraseMap,
    floor: f64,
    stop: Arc<AtomicBool>,
    out: Out,
    armed: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    state: Arc<Mutex<State>>,
) {
    let fail = |msg: String| {
        tracing::error!("wake: {msg}");
        state.lock().unwrap().last_error = Some(msg);
    };
    let api = match vosk::api() {
        Ok(a) => a,
        Err(e) => return fail(e),
    };
    let dir = model_dir();
    let Some(path) = logic::resolve_model_path(&dir) else {
        return fail(format!(
            "Vosk model not found at {}. Download vosk-model-small-en-us-0.15 from \
             https://alphacephei.com/vosk/models and extract it to that folder.",
            dir.display()
        ));
    };
    let model = match cached_model(api, &path) {
        Ok(m) => m,
        Err(e) => return fail(e),
    };
    let (usable, grammar, oov) = logic::build_grammar(&map, |w| model.knows(api, w));
    {
        let mut s = state.lock().unwrap();
        s.grammar = grammar.clone();
        s.oov = oov.clone();
    }
    for word in &oov {
        let phrase = map
            .values()
            .flatten()
            .find(|p| p.split_whitespace().any(|w| w == word))
            .cloned()
            .unwrap_or_default();
        tracing::warn!(
            "phrase {phrase:?} uses {word:?}, which the speech model does not know; it is ignored"
        );
        out.emit("wake-error", json!({"reason": "phrase-oov", "word": word, "phrase": phrase}));
    }
    if usable.is_empty() {
        return fail(format!("no usable phrases (unknown words: {})", oov.join(", ")));
    }
    let mut rec =
        match vosk::Recognizer::new(api, &model, &serde_json::to_string(&grammar).unwrap_or_default()) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };

    let (tx, rx) = crossbeam_channel::bounded::<Vec<i16>>(QUEUE_BLOCKS);
    let mut gate = logic::EnergyGate::new(floor);
    let mut prev: Option<(Vec<i16>, bool)> = None;
    while !stop.load(Ordering::SeqCst) {
        let device_failed = Arc::new(AtomicBool::new(false));
        let stream = match audio::open(tx.clone(), rx.clone(), dropped.clone(), device_failed.clone()) {
            Ok(s) => s,
            Err(e) => {
                state.lock().unwrap().last_error = Some(e.clone());
                tracing::warn!("wake: {e}; retrying in 1 s");
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
        };
        state.lock().unwrap().last_error = None;
        tracing::info!("wake listening (grammar) {usable:?}");
        while !stop.load(Ordering::SeqCst) && !device_failed.load(Ordering::SeqCst) {
            let Ok(block) = rx.recv_timeout(Duration::from_millis(250)) else { continue };
            let (feed, pre_roll) = gate.feed(logic::rms(&block));
            let previous = prev.replace((block.clone(), feed));
            if !feed {
                continue;
            }
            if pre_roll && let Some((p, false)) = &previous {
                rec.accept(p); // speech onset may start in the quiet block
            }
            let (text, final_) =
                if rec.accept(&block) { (rec.result(), true) } else { (rec.partial(), false) };
            if let Some((kind, phrase)) =
                logic::match_text(&text, &usable, final_, armed.load(Ordering::SeqCst))
            {
                tracing::info!("wake matched {kind}={phrase:?} in {text:?}");
                rec.reset();
                let event = if kind == "wake" { "wake-detected" } else { "voice-cancel" };
                out.emit(event, json!({"phrase": phrase}));
            }
        }
        drop(stream);
        if device_failed.load(Ordering::SeqCst) && !stop.load(Ordering::SeqCst) {
            tracing::warn!("wake: audio device lost; reopening the default device in 1 s");
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    tracing::info!("wake stopped");
}

#[cfg(windows)]
fn cached_model(api: &vosk::Api, path: &std::path::Path) -> Result<Arc<vosk::Model>, String> {
    static MODEL: Mutex<Option<(PathBuf, Arc<vosk::Model>)>> = Mutex::new(None);
    let mut m = MODEL.lock().unwrap();
    if let Some((p, model)) = m.as_ref()
        && p == path
    {
        return Ok(model.clone());
    }
    let model = Arc::new(vosk::Model::load(api, path)?);
    *m = Some((path.to_path_buf(), model.clone()));
    Ok(model)
}

#[cfg(windows)]
mod audio {
    use super::*;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use crossbeam_channel::{Receiver, Sender, TrySendError};

    /// Opens the default input device; blocks of 4000 i16 samples @16 kHz go to `tx`
    /// (dropping the oldest block when the recognizer falls behind).
    pub fn open(
        tx: Sender<Vec<i16>>,
        rx: Receiver<Vec<i16>>,
        dropped: Arc<AtomicU64>,
        failed: Arc<AtomicBool>,
    ) -> Result<cpal::Stream, String> {
        let host = cpal::default_host();
        let device = host.default_input_device().ok_or("no microphone found")?;
        let supported = device.default_input_config().map_err(|e| format!("microphone config: {e}"))?;
        let config = supported.config();
        let channels = config.channels.max(1) as usize;
        let mut resampler = logic::Resampler::new(config.sample_rate);
        let mut pending: Vec<i16> = Vec::with_capacity(logic::BLOCK_SAMPLES * 2);
        let mut mono: Vec<f32> = vec![];
        let mut on_samples = move |frames: &mut dyn Iterator<Item = f32>| {
            mono.clear();
            let mut acc = 0.0;
            for (i, s) in frames.enumerate() {
                acc += s;
                if i % channels == channels - 1 {
                    mono.push(acc / channels as f32);
                    acc = 0.0;
                }
            }
            resampler.push(&mono, &mut pending);
            while pending.len() >= logic::BLOCK_SAMPLES {
                let block: Vec<i16> = pending.drain(..logic::BLOCK_SAMPLES).collect();
                if let Err(TrySendError::Full(block)) = tx.try_send(block) {
                    let _ = rx.try_recv();
                    dropped.fetch_add(1, Ordering::Relaxed);
                    let _ = tx.try_send(block);
                }
            }
        };
        let on_error = move |e| {
            tracing::warn!("microphone stream error: {e}");
            failed.store(true, Ordering::SeqCst);
        };
        let stream = match supported.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream::<f32, _, _>(
                config,
                move |data, _| on_samples(&mut data.iter().copied()),
                on_error,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream::<i16, _, _>(
                config,
                move |data, _| on_samples(&mut data.iter().map(|&s| s as f32 / 32768.0)),
                on_error,
                None,
            ),
            cpal::SampleFormat::I32 => device.build_input_stream::<i32, _, _>(
                config,
                move |data, _| on_samples(&mut data.iter().map(|&s| s as f32 / 2_147_483_648.0)),
                on_error,
                None,
            ),
            other => return Err(format!("unsupported microphone sample format {other:?}")),
        }
        .map_err(|e| format!("cannot open the microphone: {e}"))?;
        stream.play().map_err(|e| format!("cannot start the microphone: {e}"))?;
        Ok(stream)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phrase_maps() {
        assert!(phrase_map("", &[]).is_none());
        let m = phrase_map("Hey, Lumen", &["Stop!".into(), " ".into()]).unwrap();
        assert_eq!(m["wake"], ["hey lumen"]);
        assert_eq!(m["cancel"], ["stop"]);
        assert_eq!(cancel_list(Some(&json!(["a", 1, "b"]))), ["a", "b"]);
    }
}
