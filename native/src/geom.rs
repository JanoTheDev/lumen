//! Rect = {x, y, w, h} in physical virtual-desktop px (plans CONTRACTS C4).

use serde::Serialize;
use serde_json::Value;

use crate::proto::AgentError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// `a + (b - a) * f` in f64, so far-apart coordinates cannot overflow i32. Pure.
pub fn lerp(a: i32, b: i32, f: f64) -> i32 {
    (a as f64 + (b as f64 - a as f64) * f).round() as i32
}

impl Rect {
    pub const fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Rect { x, y, w, h }
    }

    pub fn right(&self) -> i32 {
        self.x + self.w
    }

    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }

    pub fn is_empty(&self) -> bool {
        self.w <= 0 || self.h <= 0
    }

    pub fn center(&self) -> (i32, i32) {
        (self.x + self.w / 2, self.y + self.h / 2)
    }

    pub fn intersect(&self, o: &Rect) -> Option<Rect> {
        let x1 = self.x.max(o.x);
        let y1 = self.y.max(o.y);
        let x2 = self.right().min(o.right());
        let y2 = self.bottom().min(o.bottom());
        (x2 > x1 && y2 > y1).then(|| Rect::new(x1, y1, x2 - x1, y2 - y1))
    }

    /// Squared distance from a point to the rect (0 inside).
    pub fn dist2(&self, x: f64, y: f64) -> f64 {
        let dx = (self.x as f64 - x).max(0.0).max(x - (self.right() - 1) as f64);
        let dy = (self.y as f64 - y).max(0.0).max(y - (self.bottom() - 1) as f64);
        dx * dx + dy * dy
    }

    pub fn to_json(self) -> Value {
        serde_json::to_value(self).unwrap_or_default()
    }

    /// Parses `{x, y, w, h}` (numbers, truncated to int). E_INVALID otherwise.
    pub fn from_json(v: &Value, what: &str) -> Result<Rect, AgentError> {
        let bad = || AgentError::invalid(format!("{what} must be {{x, y, w, h}}"));
        let o = v.as_object().ok_or_else(bad)?;
        let get = |k: &str| {
            o.get(k).and_then(Value::as_f64).filter(|f| f.is_finite()).map(|f| f as i32).ok_or_else(bad)
        };
        Ok(Rect::new(get("x")?, get("y")?, get("w")?, get("h")?))
    }
}

#[cfg(windows)]
impl From<windows::Win32::Foundation::RECT> for Rect {
    fn from(r: windows::Win32::Foundation::RECT) -> Self {
        Rect::new(r.left, r.top, r.right - r.left, r.bottom - r.top)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn intersect_and_dist() {
        let a = Rect::new(0, 0, 100, 100);
        assert_eq!(a.intersect(&Rect::new(50, 50, 100, 100)), Some(Rect::new(50, 50, 50, 50)));
        assert_eq!(a.intersect(&Rect::new(100, 0, 10, 10)), None);
        assert_eq!(a.dist2(10.0, 10.0), 0.0);
        assert_eq!(a.dist2(-3.0, 0.0), 9.0);
    }

    #[test]
    fn parse() {
        assert_eq!(Rect::from_json(&json!({"x":1,"y":2.9,"w":3,"h":4}), "r").unwrap(), Rect::new(1, 2, 3, 4));
        assert_eq!(Rect::from_json(&json!({"x":1}), "r").unwrap_err().code, "E_INVALID");
        assert_eq!(Rect::from_json(&json!([1, 2, 3, 4]), "r").unwrap_err().code, "E_INVALID");
    }

    #[test]
    fn lerp_does_not_overflow() {
        assert_eq!(lerp(i32::MIN, i32::MAX, 1.0), i32::MAX);
        assert_eq!(lerp(i32::MAX, i32::MIN, 1.0), i32::MIN);
        assert_eq!(lerp(i32::MAX, i32::MIN, 0.0), i32::MAX);
        assert_eq!(lerp(10, 20, 0.5), 15);
        assert_eq!(lerp(-10, 10, 0.25), -5);
    }
}
