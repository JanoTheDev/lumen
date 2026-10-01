//! Pure wake/cancel logic, ported from agent/wake.py so both agents match the
//! same phrases the same way.

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};

pub const SAMPLE_RATE: u32 = 16000;
pub const BLOCK_SAMPLES: usize = 4000; // 250 ms
pub const DEFAULT_ENERGY_FLOOR: f64 = 120.0; // int16 RMS; quiet room ~20-80, speech ~500+
pub const HANGOVER_BLOCKS: u32 = 6; // keep feeding 1.5 s after the last loud block so finals arrive
pub const GATED_EVERY_N: u32 = 8; // while quiet, still feed every Nth block
pub const UNK: &str = "[unk]";

pub type PhraseMap = BTreeMap<&'static str, Vec<String>>;

/// Lowercase, punctuation (except apostrophes) → spaces, collapsed whitespace.
pub fn normalize(s: &str) -> String {
    let cleaned: String = s
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '\'' || c.is_whitespace() { c } else { ' ' })
        .collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Recognizer text → normalized words, keeping "[unk]" markers.
pub fn tokens(text: &str) -> Vec<String> {
    let mut out = vec![];
    for t in text.to_lowercase().split_whitespace() {
        if t == UNK {
            out.push(UNK.to_owned());
        } else {
            out.extend(normalize(t).split_whitespace().map(str::to_owned));
        }
    }
    out
}

fn find(toks: &[String], phrase: &str, allow_unk_after: bool) -> bool {
    let want: Vec<&str> = phrase.split_whitespace().collect();
    let n = want.len();
    if n == 0 || toks.len() < n {
        return false;
    }
    (0..=toks.len() - n).any(|i| {
        toks[i..i + n].iter().map(String::as_str).eq(want.iter().copied())
            && (allow_unk_after || i + n >= toks.len() || toks[i + n] != UNK)
    })
}

/// (kind, phrase) for a recognizer result. Wake: a final containing the phrase as whole words,
/// or a partial that is exactly the phrase after leading unknowns. Cancel: finals only, only
/// while armed, and not when unknown speech follows ("stopwatch" decodes as "stop [unk]").
pub fn match_text(text: &str, map: &PhraseMap, final_: bool, armed: bool) -> Option<(&'static str, String)> {
    let toks = tokens(text);
    if toks.is_empty() {
        return None;
    }
    for p in map.get("wake").into_iter().flatten() {
        if final_ && find(&toks, p, true) {
            return Some(("wake", p.clone()));
        }
        if !final_ {
            let rest: Vec<&str> = toks.iter().skip_while(|t| *t == UNK).map(String::as_str).collect();
            if rest.join(" ") == *p {
                return Some(("wake", p.clone()));
            }
        }
    }
    if final_ && armed {
        for p in map.get("cancel").into_iter().flatten() {
            if find(&toks, p, false) {
                return Some(("cancel", p.clone()));
            }
        }
    }
    None
}

/// Words `known` rejects, in first-seen order.
pub fn oov_words<'a>(
    phrases: impl IntoIterator<Item = &'a String>,
    known: impl Fn(&str) -> bool,
) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for p in phrases {
        for w in p.split_whitespace() {
            if !out.iter().any(|o| o == w) && !known(w) {
                out.push(w.to_owned());
            }
        }
    }
    out
}

/// (usable phrase map, grammar list incl. "[unk]", oov words). Phrases with an OOV word are dropped.
pub fn build_grammar(map: &PhraseMap, known: impl Fn(&str) -> bool) -> (PhraseMap, Vec<String>, Vec<String>) {
    let oov = oov_words(map.values().flatten(), known);
    let mut usable = PhraseMap::new();
    for (k, ps) in map {
        let kept: Vec<String> = ps
            .iter()
            .filter(|p| !p.split_whitespace().any(|w| oov.iter().any(|o| o == w)))
            .cloned()
            .collect();
        if !kept.is_empty() {
            usable.insert(k, kept);
        }
    }
    let mut grammar: Vec<String> = usable.values().flatten().cloned().collect();
    grammar.sort();
    grammar.dedup();
    grammar.push(UNK.to_owned());
    (usable, grammar, oov)
}

pub fn rms(block: &[i16]) -> f64 {
    if block.is_empty() {
        return 0.0;
    }
    (block.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>() / block.len() as f64).sqrt()
}

/// Decides which audio blocks reach the recognizer.
pub struct EnergyGate {
    pub floor: f64,
    open_left: u32,
    quiet: u32,
}

impl EnergyGate {
    pub fn new(floor: f64) -> Self {
        EnergyGate { floor, open_left: 0, quiet: 0 }
    }

    /// (feed this block, also feed the previous block first as pre-roll).
    pub fn feed(&mut self, level: f64) -> (bool, bool) {
        if level >= self.floor {
            let pre_roll = self.open_left == 0;
            self.open_left = HANGOVER_BLOCKS;
            self.quiet = 0;
            return (true, pre_roll);
        }
        if self.open_left > 0 {
            self.open_left -= 1;
            return (true, false);
        }
        self.quiet += 1;
        (self.quiet.is_multiple_of(GATED_EVERY_N), false)
    }
}

/// `root` itself when it holds am/, else its single subfolder that does (wake-model.ts rule).
pub fn resolve_model_path(root: &Path) -> Option<PathBuf> {
    if !root.is_dir() {
        return None;
    }
    if root.join("am").is_dir() {
        return Some(root.to_path_buf());
    }
    let nested: Vec<PathBuf> = std::fs::read_dir(root)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.join("am").is_dir())
        .collect();
    (nested.len() == 1).then(|| nested[0].clone())
}

/// Device audio (any rate, mono f32) → 16 kHz i16: box low-pass over the decimation
/// factor, then linear interpolation. Crude but plenty for a small-vocabulary grammar.
pub struct Resampler {
    step: f64,
    pos: f64,
    buf: Vec<f32>,
    k: usize,
    hist: VecDeque<f32>,
    sum: f32,
}

impl Resampler {
    pub fn new(in_rate: u32) -> Self {
        let step = in_rate as f64 / SAMPLE_RATE as f64;
        Resampler {
            step,
            pos: 0.0,
            buf: vec![],
            k: step.round().max(1.0) as usize,
            hist: VecDeque::new(),
            sum: 0.0,
        }
    }

    pub fn push(&mut self, mono: &[f32], out: &mut Vec<i16>) {
        for &x in mono {
            self.hist.push_back(x);
            self.sum += x;
            if self.hist.len() > self.k {
                self.sum -= self.hist.pop_front().unwrap_or(0.0);
            }
            self.buf.push(self.sum / self.hist.len() as f32);
        }
        while self.pos + 1.0 < self.buf.len() as f64 {
            let i = self.pos.floor() as usize;
            let f = (self.pos - i as f64) as f32;
            let v = self.buf[i] * (1.0 - f) + self.buf[i + 1] * f;
            out.push((v.clamp(-1.0, 1.0) * 32767.0) as i16);
            self.pos += self.step;
        }
        let consumed = (self.pos.floor() as usize).min(self.buf.len().saturating_sub(1));
        self.buf.drain(..consumed);
        self.pos -= consumed as f64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(wake: &[&str], cancel: &[&str]) -> PhraseMap {
        let mut m = PhraseMap::new();
        if !wake.is_empty() {
            m.insert("wake", wake.iter().map(|s| s.to_string()).collect());
        }
        if !cancel.is_empty() {
            m.insert("cancel", cancel.iter().map(|s| s.to_string()).collect());
        }
        m
    }

    #[test]
    fn normalizing() {
        assert_eq!(normalize("  Hey, LUMEN!  "), "hey lumen");
        assert_eq!(normalize("don't-stop"), "don't stop");
        assert_eq!(tokens("[unk] Hey lumen"), ["[unk]", "hey", "lumen"]);
    }

    #[test]
    fn wake_and_cancel_matching() {
        let m = map(&["hey lumen"], &["stop", "cancel"]);
        assert_eq!(match_text("hey lumen", &m, true, false), Some(("wake", "hey lumen".into())));
        assert_eq!(match_text("[unk] hey lumen [unk]", &m, true, false), Some(("wake", "hey lumen".into())));
        assert_eq!(match_text("[unk] hey lumen", &m, false, false), Some(("wake", "hey lumen".into())));
        assert_eq!(
            match_text("hey lumen [unk]", &m, false, false),
            None,
            "partial must be exactly the phrase"
        );
        assert_eq!(match_text("hey", &m, true, false), None);
        assert_eq!(match_text("stop", &m, true, false), None, "cancel only while armed");
        assert_eq!(match_text("stop", &m, true, true), Some(("cancel", "stop".into())));
        assert_eq!(match_text("stop [unk]", &m, true, true), None, "stopwatch");
        assert_eq!(match_text("cancel [unk]", &m, true, true), None, "cancel my subscription");
        assert_eq!(match_text("stop", &m, false, true), None, "cancel needs a final");
    }

    #[test]
    fn grammar_drops_oov_phrases() {
        let m = map(&["hey zorblax"], &["stop", "cancel that"]);
        let (usable, grammar, oov) = build_grammar(&m, |w| w != "zorblax");
        assert_eq!(oov, ["zorblax"]);
        assert!(!usable.contains_key("wake"));
        assert_eq!(grammar, ["cancel that", "stop", "[unk]"]);
    }

    #[test]
    fn gate() {
        let mut g = EnergyGate::new(100.0);
        assert_eq!(g.feed(500.0), (true, true));
        for _ in 0..HANGOVER_BLOCKS {
            assert_eq!(g.feed(10.0), (true, false));
        }
        let fed: Vec<bool> = (0..16).map(|_| g.feed(10.0).0).collect();
        assert_eq!(fed.iter().filter(|b| **b).count(), 2);
        assert_eq!(g.feed(500.0), (true, true));
        assert_eq!(rms(&[3, -4]), (12.5f64).sqrt());
    }

    #[test]
    fn resampling_rates() {
        for rate in [16000u32, 44100, 48000] {
            let mut r = Resampler::new(rate);
            let mut out = vec![];
            let tone: Vec<f32> = (0..rate)
                .map(|i| (i as f32 / rate as f32 * 440.0 * std::f32::consts::TAU).sin() * 0.5)
                .collect();
            for chunk in tone.chunks(480) {
                r.push(chunk, &mut out);
            }
            assert!((out.len() as i64 - 16000).abs() <= 2, "{rate}: {}", out.len());
            let level = rms(&out);
            assert!(level > 9000.0 && level < 13000.0, "{rate}: rms {level}");
        }
    }

    #[test]
    fn model_path_rule() {
        let base = std::env::temp_dir().join(format!("lumen-wake-test-{}", std::process::id()));
        let nested = base.join("vosk-model-small").join("am");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(resolve_model_path(&base), Some(base.join("vosk-model-small")));
        std::fs::create_dir_all(base.join("am")).unwrap();
        assert_eq!(resolve_model_path(&base), Some(base.clone()));
        std::fs::remove_dir_all(&base).unwrap();
        assert_eq!(resolve_model_path(&base), None);
    }
}
