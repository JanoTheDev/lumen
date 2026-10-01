//! OCR with the built-in Windows.Media.Ocr engine (nothing to install).
//!
//! Works on cached full-res frames (physical px), so word rects map straight
//! to the virtual desktop: rect = crop origin + image px. Images larger than
//! `OcrEngine::MaxImageDimension` are tiled with overlap and duplicate words
//! from the overlaps are dropped. Port of agent/ocr.py.

use serde_json::{Value, json};

use crate::geom::Rect;
use crate::proto::{AgentError, Args, CmdResult, arg};

pub const TILE_OVERLAP: u32 = 64;
pub const NO_ENGINE: &str = "No Windows OCR language is installed. Install a Windows language pack with OCR \
     (Settings > Time & language > Language).";

#[derive(Debug, Clone, PartialEq)]
pub struct Word {
    pub text: String,
    pub rect: Rect,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub text: String,
    pub rect: Rect,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct OcrOut {
    pub words: Vec<Word>,
    pub lines: Vec<Line>,
}

impl OcrOut {
    pub fn to_json(&self) -> Value {
        json!({
            "words": self.words.iter().map(|w| json!({
                "text": w.text, "rect": w.rect.to_json(), "conf": 1.0, "lineIndex": w.line,
            })).collect::<Vec<_>>(),
            "lines": self.lines.iter().map(|l| json!({"text": l.text, "rect": l.rect.to_json()})).collect::<Vec<_>>(),
        })
    }
}

/// [(x, y, w, h)] covering the image, each side <= limit, neighbours overlapping. Pure.
pub fn tiles(width: u32, height: u32, limit: u32) -> Vec<(u32, u32, u32, u32)> {
    let spans = |total: u32| -> Vec<(u32, u32)> {
        if total <= limit {
            return vec![(0, total)];
        }
        let step = limit.saturating_sub(TILE_OVERLAP).max(1);
        let mut out = vec![];
        let mut start = 0;
        loop {
            let end = (start + limit).min(total);
            out.push((start, end - start));
            if end >= total {
                return out;
            }
            start += step;
        }
    };
    let (xs, ys) = (spans(width), spans(height));
    ys.iter().flat_map(|&(y, h)| xs.iter().map(move |&(x, w)| (x, y, w, h))).collect()
}

pub fn union(rects: &[Rect]) -> Rect {
    let x1 = rects.iter().map(|r| r.x).min().unwrap_or(0);
    let y1 = rects.iter().map(|r| r.y).min().unwrap_or(0);
    let x2 = rects.iter().map(Rect::right).max().unwrap_or(0);
    let y2 = rects.iter().map(Rect::bottom).max().unwrap_or(0);
    Rect::new(x1, y1, x2 - x1, y2 - y1)
}

fn overlaps(a: &Rect, b: &Rect) -> bool {
    let ix = a.right().min(b.right()) - a.x.max(b.x);
    let iy = a.bottom().min(b.bottom()) - a.y.max(b.y);
    if ix <= 0 || iy <= 0 {
        return false;
    }
    (ix as i64 * iy as i64) as f64 >= 0.5 * ((a.w as i64 * a.h as i64).min(b.w as i64 * b.h as i64)) as f64
}

/// Joins per-tile results (absolute coords), dropping duplicate words from overlaps. Pure.
pub fn merge_tiles(results: Vec<OcrOut>) -> OcrOut {
    let mut out = OcrOut::default();
    for res in results {
        let mut by_line: Vec<Vec<Word>> = vec![vec![]; res.lines.len()];
        for w in res.words {
            if out.words.iter().any(|o| o.text == w.text && overlaps(&o.rect, &w.rect)) {
                continue;
            }
            if let Some(slot) = by_line.get_mut(w.line) {
                slot.push(w);
            }
        }
        for ws in by_line.into_iter().filter(|ws| !ws.is_empty()) {
            let idx = out.lines.len();
            let text = ws.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
            let rect = union(&ws.iter().map(|w| w.rect).collect::<Vec<_>>());
            out.words.extend(ws.into_iter().map(|w| Word { line: idx, ..w }));
            out.lines.push(Line { text, rect });
        }
    }
    out
}

/// Copies `r` (absolute) out of a BGRA image whose top-left is at `origin`.
pub fn crop_bgra(px: &[u8], img: Rect, r: Rect) -> Option<(Vec<u8>, Rect)> {
    let c = img.intersect(&r)?;
    let row = c.w as usize * 4;
    let mut out = Vec::with_capacity(row * c.h as usize);
    for y in 0..c.h {
        let start = ((c.y - img.y + y) as usize * img.w as usize + (c.x - img.x) as usize) * 4;
        out.extend_from_slice(&px[start..start + row]);
    }
    Some((out, c))
}

#[cfg(windows)]
mod engine {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Security::Cryptography::CryptographicBuffer;
    use windows::core::HSTRING;

    static ENGINES: Mutex<Option<HashMap<String, OcrEngine>>> = Mutex::new(None);

    pub fn get(lang: Option<&str>) -> Result<OcrEngine, AgentError> {
        let key = lang.unwrap_or("").to_lowercase();
        let mut guard = ENGINES.lock().unwrap();
        let map = guard.get_or_insert_with(HashMap::new);
        if let Some(e) = map.get(&key) {
            return Ok(e.clone());
        }
        let engine = match lang {
            Some(tag) => {
                let language = Language::CreateLanguage(&HSTRING::from(tag))
                    .map_err(|_| AgentError::invalid(format!("bad language tag {tag:?}")))?;
                if !OcrEngine::IsLanguageSupported(&language).unwrap_or(false) {
                    return Err(AgentError::unsupported(format!(
                        "OCR language {tag} is not installed. {NO_ENGINE}"
                    )));
                }
                OcrEngine::TryCreateFromLanguage(&language)
            }
            None => OcrEngine::TryCreateFromUserProfileLanguages(),
        }
        .map_err(|_| AgentError::unsupported(NO_ENGINE))?;
        map.insert(key, engine.clone());
        Ok(engine)
    }

    pub fn max_dimension() -> u32 {
        OcrEngine::MaxImageDimension().unwrap_or(2600)
    }

    /// OCR one BGRA image whose top-left sits at (ox, oy).
    pub fn recognize_one(
        engine: &OcrEngine,
        px: &[u8],
        w: u32,
        h: u32,
        ox: i32,
        oy: i32,
    ) -> Result<OcrOut, AgentError> {
        let buffer = CryptographicBuffer::CreateFromByteArray(px)?;
        let bmp = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
            &buffer,
            BitmapPixelFormat::Bgra8,
            w as i32,
            h as i32,
            BitmapAlphaMode::Ignore,
        )?;
        let t = std::time::Instant::now();
        let result = engine.RecognizeAsync(&bmp)?.join()?;
        tracing::debug!("ocr recognize {w}x{h} {:?}", t.elapsed());
        let mut out = OcrOut::default();
        for (li, line) in result.Lines()?.into_iter().enumerate() {
            let mut rects = vec![];
            for word in line.Words()? {
                let b = word.BoundingRect()?;
                let rect = Rect::new(
                    ox + b.X.round() as i32,
                    oy + b.Y.round() as i32,
                    b.Width.round() as i32,
                    b.Height.round() as i32,
                );
                rects.push(rect);
                out.words.push(Word { text: word.Text()?.to_string(), rect, line: li });
            }
            let rect = if rects.is_empty() { Rect::new(ox, oy, 0, 0) } else { union(&rects) };
            out.lines.push(Line { text: line.Text()?.to_string(), rect });
        }
        Ok(out)
    }
}

/// OCR a BGRA image at `origin` (physical px), tiling above the engine's max dimension.
#[cfg(windows)]
pub fn recognize(
    px: &[u8],
    img: Rect,
    lang: Option<&str>,
    token: &crate::proto::router::CancelToken,
) -> Result<OcrOut, AgentError> {
    let engine = engine::get(lang)?;
    let parts = tiles(img.w as u32, img.h as u32, engine::max_dimension());
    if parts.len() == 1 {
        return engine::recognize_one(&engine, px, img.w as u32, img.h as u32, img.x, img.y);
    }
    let mut results = vec![];
    for (x, y, w, h) in parts {
        token.check()?;
        let r = Rect::new(img.x + x as i32, img.y + y as i32, w as i32, h as i32);
        let (tile, tr) = crop_bgra(px, img, r).ok_or_else(|| AgentError::internal("bad tile"))?;
        results.push(engine::recognize_one(&engine, &tile, tr.w as u32, tr.h as u32, tr.x, tr.y)?);
    }
    Ok(merge_tiles(results))
}

/// `ocr {frameId?, region?, lang?, monitor?}` (plans CONTRACTS C2).
#[cfg(windows)]
pub fn cmd_ocr(args: &Args, token: &crate::proto::router::CancelToken) -> CmdResult {
    use crate::capture;
    let region = match args.get("region") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let r = Rect::from_json(v, "region")?;
            if r.is_empty() {
                return Err(AgentError::invalid("region must have a positive size"));
            }
            Some(r)
        }
    };
    let frame = match arg::opt_str(args, "frameId")?.filter(|s| !s.is_empty()) {
        Some(id) => capture::get_frame(id)
            .ok_or_else(|| AgentError::not_found(format!("frame {id} expired; capture again")))?,
        None => {
            let mons = crate::monitors::enumerate();
            let which = capture::parse_which(args.get("monitor"))?;
            let (mon, rect, _) = capture::targets(&mons, &which, region)?
                .into_iter()
                .next()
                .ok_or_else(|| AgentError::not_found("no monitors"))?;
            capture::cache_frame(capture::grab_frame(&mon, rect)?)
        }
    };
    token.check()?;
    let t0 = std::time::Instant::now();
    let lang = arg::opt_str(args, "lang")?.filter(|s| !s.is_empty());
    let out = match region {
        Some(r) => {
            let (px, c) = crop_bgra(&frame.bgra, frame.rect, r)
                .ok_or_else(|| AgentError::invalid("region is outside the frame"))?;
            recognize(&px, c, lang, token)?
        }
        None => recognize(&frame.bgra, frame.rect, lang, token)?,
    };
    tracing::debug!(
        "ocr {} {}x{}: {} words in {:?}",
        frame.id,
        frame.rect.w,
        frame.rect.h,
        out.words.len(),
        t0.elapsed()
    );
    let mut v = out.to_json();
    v["frameId"] = json!(frame.id);
    v["monitor"] = frame.monitor.to_json();
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiling_covers_with_overlap() {
        assert_eq!(tiles(100, 50, 500), vec![(0, 0, 100, 50)]);
        let t = tiles(1000, 300, 500);
        assert_eq!(t, vec![(0, 0, 500, 300), (436, 0, 500, 300), (872, 0, 128, 300)]);
        assert_eq!(tiles(1000, 1000, 500).len(), 9);
    }

    fn w(text: &str, x: i32, line: usize) -> Word {
        Word { text: text.into(), rect: Rect::new(x, 0, 40, 10), line }
    }

    #[test]
    fn merge_drops_overlap_duplicates_and_renumbers_lines() {
        let a = OcrOut {
            words: vec![w("hello", 0, 0), w("world", 450, 0)],
            lines: vec![Line { text: "hello world".into(), rect: Rect::default() }],
        };
        let b = OcrOut {
            words: vec![w("world", 452, 0), w("again", 520, 0), w("solo", 600, 1)],
            lines: vec![
                Line { text: "world again".into(), rect: Rect::default() },
                Line { text: "solo".into(), rect: Rect::default() },
            ],
        };
        let m = merge_tiles(vec![a, b]);
        let texts: Vec<&str> = m.words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, ["hello", "world", "again", "solo"]);
        assert_eq!(
            m.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(),
            ["hello world", "again", "solo"]
        );
        assert_eq!(m.words[2].line, 1);
        assert_eq!(m.lines[1].rect, Rect::new(520, 0, 40, 10));
    }

    #[test]
    fn crop() {
        let img = Rect::new(10, 20, 4, 3);
        let px: Vec<u8> = (0..4 * 3 * 4).map(|i| i as u8).collect();
        let (c, r) = crop_bgra(&px, img, Rect::new(11, 21, 10, 10)).unwrap();
        assert_eq!(r, Rect::new(11, 21, 3, 2));
        assert_eq!(&c[..4], &px[(4 + 1) * 4..(4 + 1) * 4 + 4]);
        assert!(crop_bgra(&px, img, Rect::new(0, 0, 5, 5)).is_none());
    }
}
