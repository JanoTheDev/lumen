//! GDI BitBlt fallback (works everywhere DXGI duplication does not: RDP,
//! rotated outputs, some hybrid-GPU setups). Alpha is left as GDI writes it.

use crate::geom::Rect;
use crate::proto::AgentError;

pub fn grab(r: Rect) -> Result<Vec<u8>, AgentError> {
    use windows::Win32::Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleDC, CreateDIBSection,
        DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, ReleaseDC, SRCCOPY, SelectObject,
    };

    if r.is_empty() {
        return Err(AgentError::invalid("empty capture rect"));
    }
    let (w, h) = (r.w as usize, r.h as usize);
    // SAFETY: every GDI object created here is released before returning; the DIB
    // section's bits are valid for w*h*4 bytes while it is alive.
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err(AgentError::internal("GetDC failed"));
        }
        let mem = CreateCompatibleDC(Some(screen));
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: r.w,
                biHeight: -r.h, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let result = match CreateDIBSection(Some(mem), &bmi, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(dib) => {
                let old = SelectObject(mem, dib.into());
                let blt = BitBlt(mem, 0, 0, r.w, r.h, Some(screen), r.x, r.y, SRCCOPY | CAPTUREBLT);
                let out = match blt {
                    Ok(()) => Ok(std::slice::from_raw_parts(bits as *const u8, w * h * 4).to_vec()),
                    Err(e) => Err(AgentError::internal(format!("BitBlt failed: {}", e.message()))),
                };
                SelectObject(mem, old);
                let _ = DeleteObject(dib.into());
                out
            }
            Err(e) => Err(AgentError::internal(format!("CreateDIBSection failed: {}", e.message()))),
        };
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        result
    }
}
