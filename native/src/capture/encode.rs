//! BGRA → (SIMD bilinear downscale) → JPEG → base64.

use base64::Engine;
use fast_image_resize::images::{Image, ImageRef};
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};
use jpeg_encoder::{ColorType, Encoder};

use crate::proto::AgentError;

/// Output size for a max width (0 = keep), never upscaling. Pure.
pub fn target_size(w: u32, h: u32, max_width: u32) -> (u32, u32) {
    if max_width == 0 || w <= max_width {
        return (w, h);
    }
    let dh = ((h as f64) * (max_width as f64) / (w as f64)).round().max(1.0) as u32;
    (max_width, dh)
}

pub fn resize_bgra(bgra: &[u8], w: u32, h: u32, dw: u32, dh: u32) -> Result<Vec<u8>, AgentError> {
    let src = ImageRef::new(w, h, bgra, PixelType::U8x4)
        .map_err(|e| AgentError::internal(format!("resize: {e}")))?;
    let mut dst = Image::new(dw, dh, PixelType::U8x4);
    // GDI leaves alpha at 0; treat the buffer as opaque so colours are not premultiplied away.
    let opts = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Bilinear)).use_alpha(false);
    Resizer::new().resize(&src, &mut dst, &opts).map_err(|e| AgentError::internal(format!("resize: {e}")))?;
    Ok(dst.into_vec())
}

pub fn jpeg_bgra(bgra: &[u8], w: u32, h: u32, quality: u8) -> Result<Vec<u8>, AgentError> {
    if w > u16::MAX as u32 || h > u16::MAX as u32 {
        return Err(AgentError::invalid("image too large for JPEG"));
    }
    let mut out = Vec::with_capacity((w * h / 4) as usize);
    Encoder::new(&mut out, quality)
        .encode(bgra, w as u16, h as u16, ColorType::Bgra)
        .map_err(|e| AgentError::internal(format!("jpeg: {e}")))?;
    Ok(out)
}

/// (base64 JPEG, width, height).
pub fn encode(
    bgra: &[u8],
    w: u32,
    h: u32,
    max_width: u32,
    quality: u8,
) -> Result<(String, u32, u32), AgentError> {
    let (dw, dh) = target_size(w, h, max_width);
    let jpeg = if (dw, dh) == (w, h) {
        jpeg_bgra(bgra, w, h, quality)?
    } else {
        jpeg_bgra(&resize_bgra(bgra, w, h, dw, dh)?, dw, dh, quality)?
    };
    Ok((base64::engine::general_purpose::STANDARD.encode(jpeg), dw, dh))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes() {
        assert_eq!(target_size(3840, 2160, 1280), (1280, 720));
        assert_eq!(target_size(800, 600, 1280), (800, 600));
        assert_eq!(target_size(800, 600, 0), (800, 600));
        assert_eq!(target_size(5000, 1, 1280), (1280, 1));
    }

    #[test]
    fn encodes_a_jpeg() {
        let (w, h) = (64u32, 32u32);
        let mut px = vec![0u8; (w * h * 4) as usize];
        for (i, p) in px.chunks_mut(4).enumerate() {
            p[0] = (i % 255) as u8; // alpha stays 0 like GDI
            p[2] = 200;
        }
        let (b64, dw, dh) = encode(&px, w, h, 16, 75).unwrap();
        assert_eq!((dw, dh), (16, 8));
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xD8]);
        let small = resize_bgra(&px, w, h, 16, 8).unwrap();
        assert!(small.chunks(4).all(|p| p[2] > 150), "colour survives alpha 0");
    }

    #[test]
    #[ignore = "timing; run with --profile fastrel -- --ignored --nocapture"]
    fn bench_encode() {
        for (w, h) in [(1920u32, 1080u32), (3840, 2160)] {
            let px: Vec<u8> = (0..w * h * 4).map(|i| (i % 251) as u8).collect();
            let t = std::time::Instant::now();
            let small = resize_bgra(&px, w, h, 1280, h * 1280 / w).unwrap();
            let r = t.elapsed();
            let t = std::time::Instant::now();
            jpeg_bgra(&small, 1280, h * 1280 / w, 75).unwrap();
            println!("{w}x{h}: resize {r:?} jpeg {:?}", t.elapsed());
        }
    }
}
