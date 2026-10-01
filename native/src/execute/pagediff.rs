//! Did a scroll move the page? Compares two small grayscale frames
//! (port of agent/pagediff.py).
//!
//! Frames are reduced 16x so a blinking caret or a ticking clock barely moves
//! the mean; only the central 80% is compared so window chrome at the edges
//! (title bar, taskbar, status bars) is ignored.

pub const REDUCE: usize = 16;
/// Trimmed from each edge.
pub const BAND: f64 = 0.10;
/// Below 0.5% mean absolute difference nothing scrolled.
pub const BOTTOM_THRESHOLD: f64 = 0.005;

#[derive(Debug, Clone, PartialEq)]
pub struct Gray {
    pub w: usize,
    pub h: usize,
    pub px: Vec<u8>,
}

/// BGRA → luma (ITU-R 601, like Pillow's "L"), box-reduced by up to 16x.
/// Edge blocks average only the pixels they cover, like `Image.reduce`. Pure.
pub fn small_gray(bgra: &[u8], w: usize, h: usize) -> Gray {
    let k = REDUCE.min(w).min(h).max(1);
    let (gw, gh) = (w.div_ceil(k), h.div_ceil(k));
    let mut sums = vec![0u64; gw * gh];
    let mut counts = vec![0u32; gw * gh];
    for y in 0..h {
        let row = &bgra[y * w * 4..(y + 1) * w * 4];
        let gy = y / k;
        for (x, p) in row.as_chunks::<4>().0.iter().enumerate() {
            let l = (p[2] as u32 * 299 + p[1] as u32 * 587 + p[0] as u32 * 114 + 500) / 1000;
            let i = gy * gw + x / k;
            sums[i] += l as u64;
            counts[i] += 1;
        }
    }
    let px = sums
        .iter()
        .zip(&counts)
        .map(|(s, c)| if *c == 0 { 0 } else { ((s + *c as u64 / 2) / *c as u64) as u8 })
        .collect();
    Gray { w: gw, h: gh, px }
}

/// Mean absolute difference over the central band, 0..1 (1 when sizes differ). Pure.
pub fn diff_ratio(a: &Gray, b: &Gray) -> f64 {
    if a.w != b.w || a.h != b.h || a.px.len() != b.px.len() {
        return 1.0;
    }
    let (dx, dy) = ((a.w as f64 * BAND) as usize, (a.h as f64 * BAND) as usize);
    let (x2, y2) =
        ((dx + 1).max(a.w.saturating_sub(dx)).min(a.w), (dy + 1).max(a.h.saturating_sub(dy)).min(a.h));
    let (mut sum, mut n) = (0u64, 0u64);
    for y in dy..y2 {
        for x in dx..x2 {
            let i = y * a.w + x;
            sum += a.px[i].abs_diff(b.px[i]) as u64;
            n += 1;
        }
    }
    if n == 0 {
        return 0.0;
    }
    sum as f64 / n as f64 / 255.0
}

pub fn reached_bottom(before: &Gray, after: &Gray) -> bool {
    diff_ratio(before, after) < BOTTOM_THRESHOLD
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: usize, h: usize, v: u8) -> Vec<u8> {
        [v, v, v, 255].repeat(w * h)
    }

    #[test]
    fn reduces_with_partial_edge_blocks() {
        let g = small_gray(&solid(40, 20, 200), 40, 20);
        assert_eq!((g.w, g.h), (3, 2));
        assert!(g.px.iter().all(|&p| p == 200));
        // Smaller than the reduce factor: k shrinks to the short side.
        let g = small_gray(&solid(5, 3, 10), 5, 3);
        assert_eq!((g.w, g.h), (2, 1));
    }

    #[test]
    fn luma_weights() {
        // Pure blue / red / green pixels.
        assert_eq!(small_gray(&[255, 0, 0, 255], 1, 1).px, [29]);
        assert_eq!(small_gray(&[0, 0, 255, 255], 1, 1).px, [76]);
        assert_eq!(small_gray(&[0, 255, 0, 255], 1, 1).px, [150]);
    }

    #[test]
    fn same_frame_reached_bottom_moved_frame_not() {
        let a = small_gray(&solid(320, 320, 100), 320, 320);
        assert!(reached_bottom(&a, &a.clone()));
        let b = small_gray(&solid(320, 320, 140), 320, 320);
        assert!(!reached_bottom(&a, &b));
        let c = small_gray(&solid(160, 320, 100), 160, 320);
        assert_eq!(diff_ratio(&a, &c), 1.0);
    }

    #[test]
    fn edges_are_ignored() {
        let a = Gray { w: 10, h: 10, px: vec![0; 100] };
        let mut b = a.clone();
        for x in 0..10 {
            b.px[x] = 255; // top row (title bar)
        }
        assert_eq!(diff_ratio(&a, &b), 0.0);
        b.px[55] = 255;
        assert!(diff_ratio(&a, &b) > 0.0);
    }
}
