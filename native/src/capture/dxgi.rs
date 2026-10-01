//! DXGI Desktop Duplication, one persistent duplication per output.
//!
//! The newest desktop image is kept in a CPU-readable staging texture, so a
//! static screen (AcquireNextFrame timing out) still answers immediately.
//! Access loss (mode change, secure desktop) drops the output's state; the
//! next grab recreates it. Callers fall back to GDI on any error.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE,
    D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING, D3D11CreateDevice, ID3D11Device,
    ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_MODE_ROTATION_IDENTITY, DXGI_MODE_ROTATION_UNSPECIFIED,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_NOT_FOUND, DXGI_ERROR_WAIT_TIMEOUT,
    DXGI_OUTDUPL_FRAME_INFO, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication, IDXGIResource,
};
use windows::core::Interface;

use crate::geom::Rect;
use crate::proto::AgentError;

/// With an image in hand, only take what is already queued (a static screen costs nothing).
const ACQUIRE_TIMEOUT_MS: u32 = 0;
/// A fresh duplication usually delivers its first image within a frame or two.
const FIRST_FRAME_TIMEOUT_MS: u32 = 25;
const FIRST_FRAME_BUDGET_MS: u64 = 120;
const ACCESS_LOST: &str = "desktop duplication access lost";

struct Output {
    ctx: ID3D11DeviceContext,
    device: ID3D11Device,
    dup: IDXGIOutputDuplication,
    staging: Option<ID3D11Texture2D>,
    /// `staging` holds a real desktop image.
    valid: bool,
    desktop: Rect,
}

#[derive(Default)]
struct State {
    outputs: HashMap<String, Output>,
}

struct Shared(Mutex<State>);
// SAFETY: the D3D11 device is free-threaded and every use of the (single-threaded)
// immediate context and duplication goes through the mutex.
unsafe impl Send for Shared {}
// SAFETY: see above.
unsafe impl Sync for Shared {}

static STATE: std::sync::LazyLock<Shared> = std::sync::LazyLock::new(|| Shared(Mutex::new(State::default())));

fn err(what: &str, e: windows::core::Error) -> AgentError {
    AgentError::internal(format!("{what}: {} (0x{:08X})", e.message(), e.code().0))
}

fn utf16(s: &[u16]) -> String {
    String::from_utf16_lossy(&s[..s.iter().position(|&c| c == 0).unwrap_or(s.len())])
}

fn open(device_name: &str) -> Result<Output, AgentError> {
    // SAFETY: COM calls on interfaces we own; out-params are valid.
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(|e| err("CreateDXGIFactory1", e))?;
        let mut ai = 0;
        loop {
            let adapter = match factory.EnumAdapters1(ai) {
                Ok(a) => a,
                Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(e) => return Err(err("EnumAdapters1", e)),
            };
            ai += 1;
            let mut oi = 0;
            while let Ok(output) = adapter.EnumOutputs(oi) {
                oi += 1;
                let desc = output.GetDesc().map_err(|e| err("GetDesc", e))?;
                if utf16(&desc.DeviceName) != device_name {
                    continue;
                }
                if desc.Rotation != DXGI_MODE_ROTATION_IDENTITY
                    && desc.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED
                {
                    return Err(AgentError::unsupported("rotated output"));
                }
                let mut device = None;
                let mut ctx = None;
                D3D11CreateDevice(
                    &adapter,
                    D3D_DRIVER_TYPE_UNKNOWN,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut ctx),
                )
                .map_err(|e| err("D3D11CreateDevice", e))?;
                let device = device.ok_or_else(|| AgentError::internal("no D3D11 device"))?;
                let ctx = ctx.ok_or_else(|| AgentError::internal("no D3D11 context"))?;
                let output1: IDXGIOutput1 = output.cast().map_err(|e| err("IDXGIOutput1", e))?;
                let dup = output1.DuplicateOutput(&device).map_err(|e| err("DuplicateOutput", e))?;
                return Ok(Output {
                    ctx,
                    device,
                    dup,
                    staging: None,
                    valid: false,
                    desktop: desc.DesktopCoordinates.into(),
                });
            }
        }
    }
    Err(AgentError::not_found(format!("no DXGI output {device_name}")))
}

impl Output {
    /// Pulls the newest desktop image into `staging`. Returns whether `staging` holds a
    /// real desktop image yet (pointer-only frames carry no image, LastPresentTime == 0).
    fn refresh(&mut self) -> Result<bool, AgentError> {
        let first = !self.valid;
        let deadline = Instant::now() + Duration::from_millis(FIRST_FRAME_BUDGET_MS);
        loop {
            let timeout = if first { FIRST_FRAME_TIMEOUT_MS } else { ACQUIRE_TIMEOUT_MS };
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource: Option<IDXGIResource> = None;
            // SAFETY: COM calls on owned interfaces; the acquired frame is released before returning.
            unsafe {
                match self.dup.AcquireNextFrame(timeout, &mut info, &mut resource) {
                    Ok(()) => {}
                    Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(self.valid),
                    Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST => {
                        return Err(AgentError::internal(ACCESS_LOST));
                    }
                    Err(e) => return Err(err("AcquireNextFrame", e)),
                }
                let has_image = info.LastPresentTime != 0;
                let copied = if has_image { self.copy(resource) } else { Ok(()) };
                let _ = self.dup.ReleaseFrame();
                copied?;
                if has_image {
                    self.valid = true;
                }
            }
            if self.valid || !first || Instant::now() >= deadline {
                return Ok(self.valid);
            }
        }
    }

    /// Copies an acquired desktop texture into the staging texture (created on first use).
    unsafe fn copy(&mut self, resource: Option<IDXGIResource>) -> Result<(), AgentError> {
        let tex: ID3D11Texture2D = resource
            .ok_or_else(|| AgentError::internal("no frame"))?
            .cast()
            .map_err(|e| err("texture", e))?;
        // SAFETY: COM calls on owned interfaces with valid descriptors.
        unsafe {
            if self.staging.is_none() {
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                tex.GetDesc(&mut desc);
                if desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM {
                    return Err(AgentError::unsupported("non-BGRA desktop format"));
                }
                desc.Usage = D3D11_USAGE_STAGING;
                desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                desc.BindFlags = 0;
                desc.MiscFlags = 0;
                desc.MipLevels = 1;
                desc.ArraySize = 1;
                let mut staging = None;
                self.device
                    .CreateTexture2D(&desc, None, Some(&mut staging))
                    .map_err(|e| err("staging", e))?;
                self.staging = staging;
            }
            let staging = self.staging.as_ref().ok_or_else(|| AgentError::internal("no staging texture"))?;
            self.ctx.CopyResource(staging, &tex);
        }
        Ok(())
    }

    /// Copies `r` (desktop coordinates, inside this output) out of the staging texture.
    fn read(&self, r: Rect) -> Result<Vec<u8>, AgentError> {
        let staging = self.staging.as_ref().ok_or_else(|| AgentError::internal("no frame yet"))?;
        let local = Rect::new(r.x - self.desktop.x, r.y - self.desktop.y, r.w, r.h);
        if local.x < 0 || local.y < 0 || local.right() > self.desktop.w || local.bottom() > self.desktop.h {
            return Err(AgentError::invalid("rect outside the output"));
        }
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        // SAFETY: the mapping is valid for RowPitch * height bytes until Unmap.
        unsafe {
            self.ctx.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(|e| err("Map", e))?;
            let pitch = mapped.RowPitch as usize;
            let row = local.w as usize * 4;
            let mut out = Vec::with_capacity(row * local.h as usize);
            let base = mapped.pData as *const u8;
            for y in 0..local.h as usize {
                let start = (local.y as usize + y) * pitch + local.x as usize * 4;
                out.extend_from_slice(std::slice::from_raw_parts(base.add(start), row));
            }
            self.ctx.Unmap(staging, 0);
            Ok(out)
        }
    }
}

/// BGRA pixels of `r`, which must lie inside the output named `device_name` (\\.\DISPLAYn).
pub fn grab(device_name: &str, r: Rect) -> Result<Vec<u8>, AgentError> {
    let mut state = STATE.0.lock().unwrap();
    for attempt in 0..2 {
        if !state.outputs.contains_key(device_name) {
            let out = open(device_name)?;
            state.outputs.insert(device_name.to_owned(), out);
        }
        let out = state.outputs.get_mut(device_name).unwrap();
        match out.refresh() {
            Ok(true) => return out.read(r),
            // Static screen since the duplication was created: no image yet, keep it for next time.
            Ok(false) => return Err(AgentError::unsupported("no desktop frame yet")),
            Err(e) => {
                state.outputs.remove(device_name);
                if e.message != ACCESS_LOST || attempt == 1 {
                    return Err(e);
                }
            }
        }
    }
    unreachable!()
}

/// Opens the duplications ahead of the first capture (device creation is the slow part).
pub fn warm(devices: &[String]) {
    let mut state = STATE.0.lock().unwrap();
    for d in devices {
        if !state.outputs.contains_key(d) {
            match open(d) {
                Ok(mut out) => {
                    let _ = out.refresh();
                    state.outputs.insert(d.clone(), out);
                }
                Err(e) => tracing::debug!("dxgi warm-up of {d} failed: {}", e.message),
            }
        }
    }
}

/// Drops every duplication (e.g. after a display change).
pub fn reset() {
    STATE.0.lock().unwrap().outputs.clear();
}
