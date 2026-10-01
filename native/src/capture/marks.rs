//! `marks_render {frameId, marks:[{n, rect}], maxWidth?, quality?}`: the
//! cached full-res frame with a thin
//! box per mark and a numbered badge at its top-left, encoded like `capture`.
//! White digits on black with a yellow outline stay legible on any UI.

use serde_json::{Value, json};

use crate::geom::Rect;
use crate::proto::{AgentError, Args, CmdResult, arg};

pub const MAX_MARKS: usize = 200;
/// Badge text height in the image the model sees.
pub const MARK_FONT_PX: f64 = 12.0;
const OUTLINE: [u8; 4] = [0, 212, 255, 255]; // BGRA of (255, 212, 0)
const BADGE: [u8; 4] = [0, 0, 0, 255];
const TEXT: [u8; 4] = [255, 255, 255, 255];

/// 5x7 digit glyphs, one row per byte (bit 4 = left column).
const DIGITS: [[u8; 7]; 10] = [
    [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
    [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
    [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
    [0x1E, 0x01, 0x01, 0x0E, 0x01, 0x01, 0x1E],
    [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
    [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
    [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
    [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
    [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
    [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
];

#[derive(Debug, Clone, PartialEq)]
pub struct Mark {
    pub n: u64,
    pub rect: Rect,
}

pub fn parse_marks(v: Option<&Value>) -> Result<Vec<Mark>, AgentError> {
    let list = v
        .and_then(Value::as_array)
        .filter(|l| l.len() <= MAX_MARKS)
        .ok_or_else(|| AgentError::invalid(format!("marks must be a list of at most {MAX_MARKS}")))?;
    list.iter()
        .map(|m| {
            let n = m
                .get("n")
                .and_then(Value::as_u64)
                .ok_or_else(|| AgentError::invalid("each mark needs an integer n"))?;
            let rect = Rect::from_json(m.get("rect").unwrap_or(&Value::Null), "region")?;
            if rect.is_empty() {
                return Err(AgentError::invalid("region must have a positive size"));
            }
            Ok(Mark { n, rect })
        })
        .collect()
}

/// A BGRA image being drawn on; every write is clipped.
pub struct Canvas<'a> {
    pub px: &'a mut [u8],
    pub w: i32,
    pub h: i32,
}

impl Canvas<'_> {
    fn fill(&mut self, x1: i32, y1: i32, x2: i32, y2: i32, c: [u8; 4]) {
        let (x1, y1, x2, y2) = (x1.max(0), y1.max(0), x2.min(self.w - 1), y2.min(self.h - 1));
        for y in y1..=y2 {
            for x in x1..=x2 {
                let i = ((y * self.w + x) * 4) as usize;
                self.px[i..i + 4].copy_from_slice(&c);
            }
        }
    }

    /// Outline of the inclusive box, `line` px thick, drawn inward (like Pillow).
    fn outline(&mut self, x1: i32, y1: i32, x2: i32, y2: i32, line: i32, c: [u8; 4]) {
        self.fill(x1, y1, x2, (y1 + line - 1).min(y2), c);
        self.fill(x1, (y2 - line + 1).max(y1), x2, y2, c);
        self.fill(x1, y1, (x1 + line - 1).min(x2), y2, c);
        self.fill((x2 - line + 1).max(x1), y1, x2, y2, c);
    }

    fn text(&mut self, label: &str, x: i32, y: i32, scale: i32, c: [u8; 4]) {
        for (i, d) in label.bytes().filter(u8::is_ascii_digit).enumerate() {
            let gx = x + i as i32 * 6 * scale;
            for (row, bits) in DIGITS[(d - b'0') as usize].iter().enumerate() {
                for col in 0..5 {
                    if bits & (0x10 >> col) != 0 {
                        let (px, py) = (gx + col * scale, y + row as i32 * scale);
                        self.fill(px, py, px + scale - 1, py + scale - 1, c);
                    }
                }
            }
        }
    }
}

/// Glyph scale for a font height in px.
pub fn glyph_scale(font_px: f64) -> i32 {
    ((font_px / 8.0).round() as i32).max(1)
}

/// (w, h) of a label at a glyph scale (5x7 glyphs, 1 column gap).
pub fn text_size(label: &str, scale: i32) -> (i32, i32) {
    let n = label.len() as i32;
    ((n * 6 - 1).max(0) * scale, 7 * scale)
}

/// Draws the marks in place. Mark rects are physical px; `origin` is the image's
/// top-left on the virtual desktop; `out_scale` is full-res px per output px so
/// badges keep their size after downscaling. Pure.
pub fn draw_marks(c: &mut Canvas, marks: &[Mark], origin: (i32, i32), out_scale: f64) {
    let k = out_scale.max(1.0);
    let line = (k.round() as i32).max(1);
    let pad = ((2.0 * k).round() as i32).max(1);
    let scale = glyph_scale((MARK_FONT_PX * k).round().max(8.0));
    for m in marks {
        let (x, y) = (m.rect.x - origin.0, m.rect.y - origin.1);
        c.outline(x, y, x + m.rect.w - 1, y + m.rect.h - 1, line, OUTLINE);
    }
    // Badges last so no outline crosses a number.
    for m in marks {
        let label = m.n.to_string();
        let (tw, th) = text_size(&label, scale);
        let (bw, bh) = (tw + 2 * pad, th + 2 * pad);
        let bx = (m.rect.x - origin.0).max(0).min((c.w - bw).max(0));
        let by = (m.rect.y - origin.1).max(0).min((c.h - bh).max(0));
        c.fill(bx, by, bx + bw - 1, by + bh - 1, BADGE);
        c.outline(bx, by, bx + bw - 1, by + bh - 1, line, OUTLINE);
        c.text(&label, bx + pad, by + pad, scale, TEXT);
    }
}

pub fn cmd_marks_render(args: &Args) -> CmdResult {
    let id = arg::opt_str(args, "frameId")?.unwrap_or("");
    let frame = (!id.is_empty())
        .then(|| super::get_frame(id))
        .flatten()
        .ok_or_else(|| AgentError::not_found(format!("frame {id} expired; capture again")))?;
    let marks = parse_marks(args.get("marks"))?;
    let (max_width, quality) = (super::max_width(args)?, super::quality(args)?);
    let (w, h) = (frame.rect.w, frame.rect.h);
    let out_w = if max_width > 0 { (w as u32).min(max_width) } else { w as u32 };
    let mut px = frame.bgra.clone();
    draw_marks(
        &mut Canvas { px: &mut px, w, h },
        &marks,
        (frame.rect.x, frame.rect.y),
        w as f64 / out_w.max(1) as f64,
    );
    let (data, ow, oh) = super::encode::encode(&px, w as u32, h as u32, max_width, quality)?;
    Ok(json!({"data": data, "width": ow, "height": oh, "mime": "image/jpeg", "count": marks.len()}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_marks_like_python() {
        let ok = parse_marks(Some(&json!([{"n": 3, "rect": {"x": 1, "y": 2, "w": 3, "h": 4}}]))).unwrap();
        assert_eq!(ok, vec![Mark { n: 3, rect: Rect::new(1, 2, 3, 4) }]);
        for bad in [
            json!(null),
            json!({}),
            json!([{"rect": {"x": 0, "y": 0, "w": 1, "h": 1}}]),
            json!([{"n": -1, "rect": {"x": 0, "y": 0, "w": 1, "h": 1}}]),
            json!([{"n": true, "rect": {"x": 0, "y": 0, "w": 1, "h": 1}}]),
            json!([{"n": 1, "rect": {"x": 0, "y": 0, "w": 0, "h": 1}}]),
            json!([{"n": 1}]),
            Value::Array(vec![json!({"n": 1, "rect": {"x": 0, "y": 0, "w": 1, "h": 1}}); MAX_MARKS + 1]),
        ] {
            assert_eq!(parse_marks(Some(&bad)).unwrap_err().code, "E_INVALID", "{bad}");
        }
    }

    fn at(px: &[u8], w: i32, x: i32, y: i32) -> [u8; 4] {
        let i = ((y * w + x) * 4) as usize;
        px[i..i + 4].try_into().unwrap()
    }

    #[test]
    fn draws_box_and_badge_inside_the_image() {
        let (w, h) = (100, 80);
        let mut px = vec![128u8; (w * h * 4) as usize];
        let marks = [Mark { n: 7, rect: Rect::new(1040, 520, 30, 20) }];
        draw_marks(&mut Canvas { px: &mut px, w, h }, &marks, (1000, 500), 1.0);
        // Badge (black, outlined) sits at the box's top-left; the outline runs along the box.
        assert_eq!(at(&px, w, 40, 520 - 500), OUTLINE);
        assert_eq!(at(&px, w, 41, 21), BADGE);
        assert_eq!(at(&px, w, 69, 39), OUTLINE, "bottom-right corner of the box");
        assert_eq!(at(&px, w, 55, 30), [128; 4], "inside the box stays untouched");
        // Some white digit pixels were drawn.
        assert!(px.chunks(4).any(|p| p == TEXT));
    }

    #[test]
    fn badge_is_clamped_and_offscreen_marks_do_not_panic() {
        let (w, h) = (20, 20);
        let mut px = vec![0u8; (w * h * 4) as usize];
        let marks = [
            Mark { n: 123, rect: Rect::new(-50, -50, 10, 10) },
            Mark { n: 9, rect: Rect::new(500, 500, 10, 10) },
        ];
        draw_marks(&mut Canvas { px: &mut px, w, h }, &marks, (0, 0), 3.0);
        assert_eq!(at(&px, w, 0, 0), OUTLINE);
    }

    #[test]
    fn badge_scales_with_downscale() {
        assert_eq!(glyph_scale(12.0), 2);
        assert_eq!(glyph_scale(36.0), 5);
        assert_eq!(text_size("12", 2), (22, 14));
    }
}
