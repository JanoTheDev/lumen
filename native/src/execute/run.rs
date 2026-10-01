//! OS side of `execute`. Timings follow the Python agent (pyautogui pauses
//! 50 ms after every call; pointer moves glide over 0.2-0.3 s).

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::pagediff::{self, Gray};
use super::textmatch::{self, ROW_BAND_LOGICAL};
use super::{Action, Dir, bbox_center, failed};
use crate::capture::{self, Which};
use crate::geom::{Rect, lerp};
use crate::input::sendinput::{self as si, Button};
use crate::input::{safety, vk_for};
use crate::proto::router::CancelToken;
use crate::proto::{AgentError, Args, CmdResult, E_CANCELLED, E_TIMEOUT};
use crate::{monitors, window};

const PAUSE: Duration = Duration::from_millis(50);
const GLIDE_STEP: Duration = Duration::from_millis(25);
const VK_PAGEDOWN: u16 = 0x22;
const VK_PAGEUP: u16 = 0x21;
const VK_DELETE: u16 = 0x2E;
const VK_RETURN: u16 = 0x0D;
const VK_CONTROL: u16 = 0x11;

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

/// Linear glide from the current pointer position, then a pause.
fn glide(x: i32, y: i32, duration: Duration, token: &CancelToken) -> Result<(), AgentError> {
    let (sx, sy) = si::cursor_pos();
    let steps = (duration.as_millis() / GLIDE_STEP.as_millis()).max(1) as i32;
    for i in 1..=steps {
        token.check()?;
        let f = i as f64 / steps as f64;
        si::move_to(lerp(sx, x, f), lerp(sy, y, f))?;
        if i < steps {
            token.sleep(GLIDE_STEP)?;
        }
    }
    token.sleep(PAUSE)
}

fn click_at(x: i32, y: i32, button: Button, token: &CancelToken) -> Result<(), AgentError> {
    token.check()?;
    glide(x, y, ms(200), token)?;
    token.sleep(ms(50))?;
    si::move_to(x, y)?;
    si::click(button, 1, token)?;
    token.sleep(PAUSE)
}

fn chord(vks: &[u16], token: &CancelToken) -> Result<(), AgentError> {
    si::send_keys(&si::chord_events(vks, si::scan_code), token)?;
    token.sleep(PAUSE)
}

fn type_text(text: &str, token: &CancelToken) -> Result<(), AgentError> {
    si::send_keys(&si::text_events(text), token)
}

/// Small grayscale frame of the foreground window (its monitor when there is none).
fn page_frame() -> Result<Gray, AgentError> {
    let mons = monitors::enumerate();
    let fg = window::foreground();
    let region = (fg != 0).then(|| window::rect(fg)).filter(|r| r.w >= 32 && r.h >= 32);
    let grab = |region: Option<Rect>| -> Result<(Vec<u8>, Rect), AgentError> {
        let (mon, rect, _) = capture::targets(&mons, &Which::Foreground, region)?
            .into_iter()
            .next()
            .ok_or_else(|| AgentError::not_found("no monitors"))?;
        Ok((capture::grab(&mon, rect)?.0, rect))
    };
    let (px, rect) = match region {
        Some(r) => grab(Some(r)).or_else(|_| grab(None))?,
        None => grab(None)?,
    };
    Ok(pagediff::small_gray(&px, rect.w as usize, rect.h as usize))
}

fn browser_center() -> (i32, i32) {
    if let Some(h) = window::find_browser() {
        return window::rect(h).center();
    }
    monitors::primary(&monitors::enumerate()).map(|m| m.rect.center()).unwrap_or((0, 0))
}

fn scroll(dir: Dir, amount: u32, at: Option<(i32, i32)>, token: &CancelToken) -> CmdResult {
    let t0 = Instant::now();
    if let Dir::Up | Dir::Down = dir {
        let before = page_frame()?;
        let vk = if dir == Dir::Down { VK_PAGEDOWN } else { VK_PAGEUP };
        for _ in 0..amount {
            token.check()?;
            chord(&[vk], token)?;
            token.sleep(ms(20))?;
        }
        token.sleep(ms(150))?; // let the page render before comparing
        let reached = pagediff::reached_bottom(&before, &page_frame()?);
        tracing::info!("scroll {dir:?} {amount} done in {:?} reached_bottom={reached}", t0.elapsed());
        return Ok(json!({"reached_bottom": reached}));
    }
    let (x, y) = at.unwrap_or_else(browser_center);
    glide(x, y, ms(100), token)?;
    let notches = if dir == Dir::Right { amount as f64 } else { -(amount as f64) };
    si::scroll(notches, 0.0)?;
    token.sleep(PAUSE)?;
    tracing::info!("scroll {dir:?} {amount} done in {:?}", t0.elapsed());
    Ok(json!({}))
}

/// Presses normalized key names like pyautogui.hotkey: unknown names are skipped.
fn hotkey(keys: &[String], token: &CancelToken) -> Result<(), AgentError> {
    let vks: Vec<u16> = keys
        .iter()
        .filter_map(|k| {
            let vk = vk_for(k);
            if vk.is_none() {
                tracing::warn!("hotkey: unknown key {k:?} skipped");
            }
            vk
        })
        .collect();
    if vks.is_empty() {
        return Ok(());
    }
    chord(&vks, token)
}

fn uia_find(
    hwnd: isize,
    text: &str,
    wait: Duration,
    token: &CancelToken,
) -> Result<Option<Rect>, AgentError> {
    let pid = window::pid_of(hwnd);
    let deadline = Instant::now() + wait;
    loop {
        token.check()?;
        // The window first, then its process's other visible windows (menus, popups).
        let popups = window::top_level_windows()
            .into_iter()
            .filter(|&h| h != hwnd && window::is_visible(h) && window::pid_of(h) == pid);
        for h in std::iter::once(hwnd).chain(popups) {
            match crate::uia::find_in_window(h, text, token) {
                Ok(Some(n)) => return Ok(Some(n.rect)),
                Ok(None) => {}
                Err(e) if e.code == E_CANCELLED || e.code == E_TIMEOUT => return Err(e),
                Err(e) => tracing::debug!("uia find in {h}: {}", e.message),
            }
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        token.sleep(ms(250))?;
    }
}

/// Every OCR hit of `text` on the foreground monitor, top to bottom.
fn ocr_hits(text: &str, token: &CancelToken) -> Result<Vec<(i32, i32, i32)>, AgentError> {
    let t0 = Instant::now();
    let mons = monitors::enumerate();
    let (mon, rect, _) = capture::targets(&mons, &Which::Foreground, None)?
        .into_iter()
        .next()
        .ok_or_else(|| AgentError::not_found("no monitors"))?;
    let frame = capture::cache_frame(capture::grab_frame(&mon, rect)?);
    token.check()?;
    let out = crate::ocr::recognize(&frame.bgra, frame.rect, None, token)?;
    let words: Vec<(String, Rect)> = out.words.into_iter().map(|w| (w.text, w.rect)).collect();
    let band = ROW_BAND_LOGICAL * if mon.scale > 0.0 { mon.scale } else { 1.0 };
    let hits = textmatch::ocr_matches(&words, text, band);
    tracing::info!("ocr '{text}': {} hits in {} words, {:?}", hits.len(), words.len(), t0.elapsed());
    Ok(hits)
}

/// Like the Python agent, an OCR failure is a miss; only cancel/timeout abort.
fn ocr_hits_or_none(text: &str, token: &CancelToken) -> Result<Vec<(i32, i32, i32)>, AgentError> {
    match ocr_hits(text, token) {
        Err(e) if e.code == E_CANCELLED || e.code == E_TIMEOUT => Err(e),
        Err(e) => {
            tracing::error!("error finding '{text}': {}", e.message);
            Ok(vec![])
        }
        ok => ok,
    }
}

fn click_element(
    text: &str,
    button: Button,
    bbox: Option<[f64; 4]>,
    token: &CancelToken,
) -> Result<(), AgentError> {
    let hwnd = window::foreground();
    let is_browser = hwnd != 0 && window::is_browser_process(&window::process_name(hwnd));
    let mut target = None;
    if is_browser {
        // Browser web content is cross-process (UIA walks hang): OCR readable text,
        // else the bbox center for icons and avatars.
        if !text.contains("...") && text.chars().count() <= 60 {
            target = ocr_hits_or_none(text, token)?.first().map(|h| (h.0, h.1));
        }
    } else if hwnd != 0 {
        // Wait longer only when there is no bbox to fall back to.
        let wait = if bbox.is_some() { ms(3000) } else { ms(5000) };
        target = uia_find(hwnd, text, wait, token)?.map(|r| r.center());
    }
    let (x, y) = match (target, bbox) {
        (Some(p), _) => p,
        (None, Some(b)) => bbox_center(b),
        (None, None) => {
            return Err(failed(format!("click_element: element '{text}' not found (no bbox provided)")));
        }
    };
    click_at(x, y, button, token)
}

fn bring_to_front(hwnd: isize, token: &CancelToken) -> Result<(), AgentError> {
    match window::focus(hwnd, token) {
        Err(e) if e.code == E_CANCELLED || e.code == E_TIMEOUT => return Err(e),
        Err(e) => tracing::warn!("bring to front: {}", e.message),
        Ok(()) => {}
    }
    token.sleep(ms(300))
}

fn navigate(url: &str, token: &CancelToken) -> Result<(), AgentError> {
    // No browser: main opens the URL itself under its own scheme policy.
    let hwnd =
        window::find_browser().ok_or_else(|| AgentError::not_found("navigate_url: no browser window"))?;
    // Ctrl+L and the URL must never land in whatever else has focus.
    window::focus(hwnd, token).map_err(|e| match e.code {
        E_CANCELLED | E_TIMEOUT => e,
        _ => failed(format!("navigate_url: could not focus the browser: {}", e.message)),
    })?;
    token.sleep(ms(500))?;
    if window::foreground() != hwnd {
        return Err(failed("navigate_url: the browser lost focus"));
    }
    chord(&[VK_CONTROL, 0x4C], token)?; // Ctrl+L
    token.sleep(ms(150))?;
    chord(&[VK_CONTROL, 0x41], token)?; // Ctrl+A
    type_text(url, token)?;
    token.sleep(ms(100))?;
    chord(&[VK_DELETE], token)?; // drop inline autocompletion so Enter opens exactly `url`
    chord(&[VK_RETURN], token)?;
    token.sleep(ms(200))
}

pub fn run(action: &Action, token: &CancelToken) -> CmdResult {
    token.check()?;
    match action {
        Action::Scroll { dir, amount, at } => return scroll(*dir, *amount, *at, token),
        Action::Move { x, y } => glide(*x, *y, ms(300), token)?,
        Action::Click { x, y, button } => click_at(*x, *y, *button, token)?,
        Action::Type { text, allow_terminal } => {
            safety::check_input_target(*allow_terminal, "type")?;
            type_text(text, token)?;
        }
        Action::Hotkey { keys, allow_terminal } => {
            if !keys.is_empty() {
                safety::check_input_target(*allow_terminal, "hotkey")?;
                hotkey(keys, token)?;
            }
        }
        Action::ClickElement { text, button, bbox } => click_element(text, *button, *bbox, token)?,
        Action::ClickNth { text, n, button } => {
            let hits = ocr_hits_or_none(text, token)?;
            let (x, y, _) = *hits.get(n - 1).ok_or_else(|| {
                failed(format!("click_nth_element: occurrence {n} of '{text}' not found on screen"))
            })?;
            click_at(x, y, *button, token)?;
        }
        Action::NavigateUrl { url } => navigate(url, token)?,
        Action::FocusBrowser => {
            let title = match window::find_browser() {
                Some(h) => {
                    let title: String = window::title(h).chars().take(80).collect();
                    bring_to_front(h, token)?;
                    title
                }
                None => String::new(),
            };
            return Ok(json!({"done": true, "title": title}));
        }
    }
    Ok(Value::Object(Default::default()))
}

pub fn cmd_execute(args: &Args, token: &CancelToken) -> CmdResult {
    let action = super::parse(&super::action_of(args)?)?;
    let t0 = Instant::now();
    let r = run(&action, token);
    tracing::info!("execute {} done in {:?}", action.kind(), t0.elapsed());
    r
}
