//! `input {steps}` (plans CONTRACTS C2): validated up front, then executed in
//! order on the input lane with a cancel check between (and inside) steps.

pub mod safety;
pub mod sendinput;

use std::time::Duration;

use serde_json::{Value, json};

use crate::hotkey::accel;
use crate::proto::router::CancelToken;
use crate::proto::{AgentError, Args, CmdResult, arg};
use sendinput::Button;

pub const MAX_WAIT_MS: u64 = 60_000;
const DRAG_MOVES: u32 = 12;
const DRAG_TIME: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Move { x: i32, y: i32 },
    Click { button: Button, at: Option<(i32, i32)>, count: u32 },
    Drag { from: (i32, i32), to: (i32, i32), button: Button },
    Scroll { dx: f64, dy: f64, at: Option<(i32, i32)> },
    Type { text: String, vk_mode: bool, allow_terminal: bool },
    Keys { keys: Vec<String>, vks: Vec<u16>, allow_terminal: bool },
    Wait { ms: u64 },
}

fn coord(o: &Args, key: &str) -> Result<Option<i32>, AgentError> {
    Ok(arg::opt_f64(o, key)?.filter(|f| f.is_finite()).map(|f| f.round() as i32))
}

fn point(o: &Args, what: &str) -> Result<Option<(i32, i32)>, AgentError> {
    match (coord(o, "x")?, coord(o, "y")?) {
        (Some(x), Some(y)) => Ok(Some((x, y))),
        (None, None) => Ok(None),
        _ => Err(AgentError::invalid(format!("{what} needs both x and y"))),
    }
}

fn point_value(v: Option<&Value>, what: &str) -> Result<(i32, i32), AgentError> {
    let bad = || AgentError::invalid(format!("{what} must be {{x, y}}"));
    let o = v.and_then(Value::as_object).ok_or_else(bad)?;
    point(o, what)?.ok_or_else(bad)
}

/// VK for a normalized key name (see safety::normalize_*).
pub fn vk_for(name: &str) -> Option<u16> {
    match name {
        "ctrl" => Some(accel::VK_CONTROL),
        "alt" => Some(accel::VK_MENU),
        "shift" => Some(accel::VK_SHIFT),
        "win" => Some(accel::VK_LWIN),
        "esc" => Some(0x1B),
        "pgup" => Some(0x21),
        "pgdn" => Some(0x22),
        "apps" | "menu" | "contextmenu" => Some(0x5D),
        "+" => Some(0xBB),
        other => accel::key_vk(other),
    }
}

/// Validates every step before anything runs. Pure.
pub fn parse_steps(args: &Args) -> Result<Vec<Step>, AgentError> {
    let list = args
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| AgentError::invalid("steps must be a list"))?;
    let allow_all = arg::opt_bool(args, "allowTerminal")?.unwrap_or(false);
    let mut steps = Vec::with_capacity(list.len());
    for (i, raw) in list.iter().enumerate() {
        let o = raw.as_object().ok_or_else(|| AgentError::invalid(format!("step {i} must be an object")))?;
        let t = arg::opt_str(o, "t")?.unwrap_or("");
        let allow_terminal = allow_all || arg::opt_bool(o, "allowTerminal")?.unwrap_or(false);
        let step = match t {
            "move" => {
                let (x, y) = point(o, "move")?.ok_or_else(|| AgentError::invalid("move needs x and y"))?;
                Step::Move { x, y }
            }
            "click" => {
                let count = arg::opt_i64(o, "count")?.unwrap_or(1);
                if !(1..=3).contains(&count) {
                    return Err(AgentError::invalid("click count must be 1, 2 or 3"));
                }
                Step::Click {
                    button: Button::parse(arg::opt_str(o, "button")?)?,
                    at: point(o, "click")?,
                    count: count as u32,
                }
            }
            "drag" => Step::Drag {
                from: point_value(o.get("from"), "drag.from")?,
                to: point_value(o.get("to"), "drag.to")?,
                button: Button::parse(arg::opt_str(o, "button")?)?,
            },
            "scroll" => {
                let dx = arg::opt_f64(o, "dx")?.unwrap_or(0.0);
                let dy = arg::opt_f64(o, "dy")?.unwrap_or(0.0);
                if !dx.is_finite() || !dy.is_finite() || dx.abs() > 100.0 || dy.abs() > 100.0 {
                    return Err(AgentError::invalid("scroll dx/dy must be notches within ±100"));
                }
                Step::Scroll { dx, dy, at: point(o, "scroll")? }
            }
            "type" => {
                let text = arg::opt_str(o, "text")?.ok_or_else(|| AgentError::invalid("type needs text"))?;
                let vk_mode = match arg::opt_str(o, "mode")? {
                    None | Some("unicode") => false,
                    Some("vk") => true,
                    Some(m) => return Err(AgentError::invalid(format!("unknown type mode {m:?}"))),
                };
                Step::Type { text: text.to_owned(), vk_mode, allow_terminal }
            }
            "keys" => {
                let keys = match o.get("combo").or_else(|| o.get("keys")) {
                    Some(Value::String(s)) => safety::normalize_combo(s),
                    Some(Value::Array(a)) => safety::normalize_list(a.iter().filter_map(Value::as_str)),
                    _ => return Err(AgentError::invalid("keys needs a combo")),
                };
                if keys.is_empty() {
                    return Err(AgentError::invalid("keys needs a combo"));
                }
                let vks = keys
                    .iter()
                    .map(|k| vk_for(k).ok_or_else(|| AgentError::invalid(format!("unknown key '{k}'"))))
                    .collect::<Result<Vec<_>, _>>()?;
                Step::Keys { keys, vks, allow_terminal }
            }
            "wait" => {
                let ms = arg::opt_f64(o, "ms")?.unwrap_or(0.0);
                if !(0.0..=MAX_WAIT_MS as f64).contains(&ms) {
                    return Err(AgentError::invalid(format!("wait ms must be 0..{MAX_WAIT_MS}")));
                }
                Step::Wait { ms: ms as u64 }
            }
            other => return Err(AgentError::invalid(format!("unknown step type {other:?}"))),
        };
        steps.push(step);
    }
    // Policy checks that need no OS state run before any input is sent.
    for s in &steps {
        if let Step::Keys { keys, .. } = s {
            safety::check_combo(keys)?;
        }
    }
    Ok(steps)
}

#[cfg(windows)]
pub fn run_step(step: &Step, token: &CancelToken) -> Result<(), AgentError> {
    use sendinput as si;
    token.check()?;
    match step {
        Step::Move { x, y } => si::move_to(*x, *y),
        Step::Click { button, at, count } => {
            if let Some((x, y)) = at {
                si::move_to(*x, *y)?;
                token.sleep(Duration::from_millis(30))?;
            }
            si::click(*button, *count, token)
        }
        Step::Drag { from, to, button } => {
            si::move_to(from.0, from.1)?;
            token.sleep(Duration::from_millis(30))?;
            si::button(*button, true)?;
            let result = (|| {
                for i in 1..=DRAG_MOVES {
                    token.sleep(DRAG_TIME / DRAG_MOVES)?;
                    let f = i as f64 / DRAG_MOVES as f64;
                    let x = from.0 as f64 + (to.0 - from.0) as f64 * f;
                    let y = from.1 as f64 + (to.1 - from.1) as f64 * f;
                    si::move_to(x.round() as i32, y.round() as i32)?;
                }
                Ok(())
            })();
            // Never leave a button held, even when cancelled mid-drag.
            si::button(*button, false)?;
            result
        }
        Step::Scroll { dx, dy, at } => {
            if let Some((x, y)) = at {
                si::move_to(*x, *y)?;
            }
            si::scroll(*dx, *dy)
        }
        Step::Type { text, vk_mode, allow_terminal } => {
            safety::check_input_target(*allow_terminal, "type")?;
            let events = if *vk_mode {
                si::text_events_vk(text, crate::window::thread_of(crate::window::foreground()))
            } else {
                si::text_events(text)
            };
            si::send_keys(&events, token)
        }
        Step::Keys { vks, allow_terminal, .. } => {
            safety::check_input_target(*allow_terminal, "keys")?;
            si::send_keys(&si::chord_events(vks, si::scan_code), token)
        }
        Step::Wait { ms } => token.sleep(Duration::from_millis(*ms)),
    }
}

#[cfg(windows)]
pub fn cmd_input(args: &Args, token: &CancelToken) -> CmdResult {
    let steps = parse_steps(args)?;
    for step in &steps {
        run_step(step, token)?;
    }
    Ok(json!({"done": true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(v: Value) -> Result<Vec<Step>, AgentError> {
        parse_steps(v.as_object().unwrap())
    }

    #[test]
    fn parses_all_step_types() {
        let steps = parse(json!({"steps": [
            {"t": "move", "x": 10, "y": 20.6},
            {"t": "click", "button": "right", "count": 2},
            {"t": "click", "x": 1, "y": 2},
            {"t": "drag", "from": {"x": 0, "y": 0}, "to": {"x": 5, "y": 5}},
            {"t": "scroll", "dy": 3},
            {"t": "type", "text": "hi", "allowTerminal": true},
            {"t": "keys", "combo": "Ctrl+L"},
            {"t": "keys", "keys": ["ctrl", "shift", "t"]},
            {"t": "wait", "ms": 5}
        ]}))
        .unwrap();
        assert_eq!(steps[0], Step::Move { x: 10, y: 21 });
        assert_eq!(steps[1], Step::Click { button: Button::Right, at: None, count: 2 });
        assert!(matches!(steps[5], Step::Type { allow_terminal: true, vk_mode: false, .. }));
        assert_eq!(
            steps[6],
            Step::Keys {
                keys: vec!["ctrl".into(), "l".into()],
                vks: vec![0x11, 0x4C],
                allow_terminal: false
            }
        );
        assert_eq!(steps.len(), 9);
    }

    #[test]
    fn rejects_bad_steps() {
        for bad in [
            json!({}),
            json!({"steps": [{"t": "teleport"}]}),
            json!({"steps": [{"t": "move", "x": 1}]}),
            json!({"steps": [{"t": "click", "count": 4}]}),
            json!({"steps": [{"t": "click", "button": "thumb"}]}),
            json!({"steps": [{"t": "drag", "from": {"x": 1}}]}),
            json!({"steps": [{"t": "keys", "combo": "ctrl+nope"}]}),
            json!({"steps": [{"t": "wait", "ms": 999999}]}),
            json!({"steps": [{"t": "type"}]}),
        ] {
            assert_eq!(parse(bad.clone()).unwrap_err().code, "E_INVALID", "{bad}");
        }
    }

    #[test]
    fn denies_before_running() {
        let e =
            parse(json!({"steps": [{"t": "wait", "ms": 1}, {"t": "keys", "combo": "Win+R"}]})).unwrap_err();
        assert_eq!(e.code, "E_DENIED");
    }
}
