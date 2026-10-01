//! OCR phrase matching for `click_element` / `click_nth_element`
//! (port of `_ocr_matches` in agent/actions.py). Pure.

use crate::geom::Rect;

/// Same-row band in logical px; scaled by the monitor's DPI scale.
pub const ROW_BAND_LOGICAL: f64 = 30.0;

/// Folds common OCR confusables (0/O, 1/I/l) so matching is robust.
pub fn ocr_norm(s: &str) -> String {
    s.to_lowercase().replace('0', "o").replace(['1', 'i'], "l")
}

fn word_matches(target: &str, word: &str) -> bool {
    // Short words (<= 3 chars) must match exactly so "OK" does not hit "BOOK".
    !target.is_empty()
        && !word.is_empty()
        && if target.chars().count() <= 3 { word == target } else { word.contains(target) }
}

/// (cx, cy, top) of every occurrence of `text` in the OCR words, top to bottom.
/// Hits in one row band count once (the leftmost wins), so a name that shows
/// in both the sender and the subject column is one row.
pub fn ocr_matches(words: &[(String, Rect)], text: &str, row_band: f64) -> Vec<(i32, i32, i32)> {
    let targets: Vec<String> = text.split_whitespace().map(ocr_norm).collect();
    let nw = targets.len();
    if nw == 0 || words.len() < nw {
        return vec![];
    }
    let norm: Vec<String> = words.iter().map(|(t, _)| ocr_norm(t.trim())).collect();
    // (cx, cy, y1, x1)
    let mut raw: Vec<(i32, i32, i32, i32)> = vec![];
    for i in 0..=words.len() - nw {
        if targets.iter().zip(&norm[i..i + nw]).all(|(t, w)| word_matches(t, w)) {
            let rects = words[i..i + nw].iter().map(|(_, r)| r);
            let x1 = rects.clone().map(|r| r.x).min().unwrap_or(0);
            let y1 = rects.clone().map(|r| r.y).min().unwrap_or(0);
            let x2 = rects.clone().map(Rect::right).max().unwrap_or(0);
            let y2 = rects.map(Rect::bottom).max().unwrap_or(0);
            raw.push(((x1 + x2).div_euclid(2), (y1 + y2).div_euclid(2), y1, x1));
        }
    }
    raw.sort_by_key(|m| m.2);
    // Each cluster is anchored on its first y so neighbouring rows cannot snowball into one.
    let mut clusters: Vec<(i32, (i32, i32, i32, i32))> = vec![];
    for m in raw {
        match clusters.last_mut() {
            Some((first_y, best)) if (m.2 - *first_y) as f64 <= row_band => {
                if m.3 < best.3 {
                    *best = m;
                }
            }
            _ => clusters.push((m.2, m)),
        }
    }
    clusters.into_iter().map(|(_, m)| (m.0, m.1, m.2)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(t: &str, x: i32, y: i32) -> (String, Rect) {
        (t.into(), Rect::new(x, y, 40, 12))
    }

    #[test]
    fn norm_folds_confusables() {
        assert_eq!(ocr_norm("0xGF Inbox1"), "oxgf lnboxl");
    }

    #[test]
    fn short_words_exact_long_words_substring() {
        let words = [w("BOOK", 0, 0), w("OK", 100, 50)];
        assert_eq!(ocr_matches(&words, "ok", 30.0), vec![(120, 56, 50)]);
        let words = [w("[0xGF/repo]", 10, 0)];
        assert_eq!(ocr_matches(&words, "0xGF", 30.0).len(), 1);
    }

    #[test]
    fn multi_word_phrase_spans_rects() {
        let words = [w("Save", 0, 0), w("as", 50, 2), w("Save", 0, 100)];
        assert_eq!(ocr_matches(&words, "save as", 30.0), vec![(45, 7, 0)]);
    }

    #[test]
    fn same_row_collapses_to_leftmost() {
        let words = [w("Alice", 300, 102), w("Alice", 20, 100), w("x", 0, 150), w("Alice", 20, 160)];
        let m = ocr_matches(&words, "alice", 30.0);
        assert_eq!(m, vec![(40, 106, 100), (40, 166, 160)]);
        // A wider band merges the rows.
        assert_eq!(ocr_matches(&words, "alice", 90.0).len(), 1);
    }

    #[test]
    fn empty_inputs() {
        assert!(ocr_matches(&[w("a", 0, 0)], "  ", 30.0).is_empty());
        assert!(ocr_matches(&[], "a", 30.0).is_empty());
    }
}
