//! `execute {action}`: the model action command (click, type, scroll,
//! navigate, ...). Coordinates are physical px. Runs on the input lane with a cancel check
//! between (and inside) every step.

pub mod pagediff;
pub mod textmatch;

use serde_json::{Map, Value};

use crate::input::safety;
use crate::input::sendinput::Button;
use crate::proto::{AgentError, Args, arg};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dir {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Scroll { dir: Dir, amount: u32, at: Option<(i32, i32)> },
    Move { x: i32, y: i32 },
    Click { x: i32, y: i32, button: Button },
    Type { text: String, allow_terminal: bool, allow_password: bool },
    Hotkey { keys: Vec<String>, allow_terminal: bool, allow_password: bool },
    ClickElement { text: String, button: Button, bbox: Option<[f64; 4]> },
    ClickNth { text: String, n: usize, button: Button },
    NavigateUrl { url: String },
    FocusBrowser,
}

impl Action {
    /// The wire `type` (for logs; never the typed text).
    pub fn kind(&self) -> &'static str {
        match self {
            Action::Scroll { .. } => "scroll",
            Action::Move { .. } => "move",
            Action::Click { .. } => "click",
            Action::Type { .. } => "type",
            Action::Hotkey { .. } => "hotkey",
            Action::ClickElement { .. } => "click_element",
            Action::ClickNth { .. } => "click_nth_element",
            Action::NavigateUrl { .. } => "navigate_url",
            Action::FocusBrowser => "focus_browser",
        }
    }
}

/// E_INTERNAL with the Python agent's "execute failed: ..." wording.
pub fn failed(msg: impl std::fmt::Display) -> AgentError {
    AgentError::internal(format!("execute failed: {msg}"))
}

fn coord(o: &Args, key: &str, what: &str) -> Result<i32, AgentError> {
    arg::opt_f64(o, key)?
        .filter(|f| f.is_finite())
        .map(|f| f.round() as i32)
        .ok_or_else(|| AgentError::invalid(format!("{what} needs x and y")))
}

fn opt_point(o: &Args) -> Result<Option<(i32, i32)>, AgentError> {
    let get = |k| arg::opt_f64(o, k).map(|v| v.filter(|f| f.is_finite()).map(|f| f.round() as i32));
    Ok(match (get("x")?, get("y")?) {
        (Some(x), Some(y)) => Some((x, y)),
        _ => None,
    })
}

/// `int(v)` like Python: numbers truncate, numeric strings parse.
fn int_like(o: &Args, key: &str, default: i64) -> Result<i64, AgentError> {
    match o.get(key) {
        None => Ok(default),
        Some(Value::String(s)) => {
            s.trim().parse::<i64>().map_err(|_| AgentError::invalid(format!("{key} must be a number")))
        }
        Some(_) => {
            arg::opt_i64(o, key)?.ok_or_else(|| AgentError::invalid(format!("{key} must be a number")))
        }
    }
}

fn text(o: &Args, key: &str) -> Result<String, AgentError> {
    Ok(match o.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(_) => return Err(AgentError::invalid(format!("{key} must be a string"))),
    })
}

fn keys(v: Option<&Value>) -> Result<Vec<String>, AgentError> {
    Ok(match v {
        None | Some(Value::Null) => vec![],
        Some(Value::String(s)) => safety::normalize_combo(s),
        Some(Value::Array(a)) => {
            let names: Vec<String> = a
                .iter()
                .map(|k| match k {
                    Value::String(s) => Ok(s.clone()),
                    Value::Number(n) => Ok(n.to_string()),
                    _ => Err(AgentError::invalid("keys must be key names")),
                })
                .collect::<Result<_, _>>()?;
            safety::normalize_list(names.iter().map(String::as_str))
        }
        Some(_) => return Err(AgentError::invalid("keys must be a list or a combo string")),
    })
}

fn bbox(v: Option<&Value>) -> Result<Option<[f64; 4]>, AgentError> {
    let bad = || AgentError::invalid("click_element bbox must be [x1, y1, x2, y2]");
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(a)) if a.is_empty() => Ok(None),
        Some(Value::Array(a)) if a.len() == 4 => {
            let mut out = [0.0; 4];
            for (o, v) in out.iter_mut().zip(a) {
                *o = v.as_f64().filter(|f| f.is_finite()).ok_or_else(bad)?;
            }
            Ok(Some(out))
        }
        Some(_) => Err(bad()),
    }
}

/// Center of an `[x1, y1, x2, y2]` box, floor-divided like Python's `//`.
pub fn bbox_center(b: [f64; 4]) -> (i32, i32) {
    (((b[0] + b[2]) / 2.0).floor() as i32, ((b[1] + b[3]) / 2.0).floor() as i32)
}

/// Validates the action and runs the policy checks that need no OS state. Pure.
pub fn parse(action: &Args) -> Result<Action, AgentError> {
    let t = match action.get("type") {
        None | Some(Value::Null) => "None".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
    };
    let button = || Button::parse(arg::opt_str(action, "button")?);
    let allow_terminal = action.get("allowTerminal") == Some(&Value::Bool(true));
    let allow_password = action.get("allowPassword") == Some(&Value::Bool(true));
    Ok(match t.as_str() {
        "scroll" => {
            let dir = match arg::opt_str(action, "direction")?.unwrap_or("down") {
                "down" => Dir::Down,
                "up" => Dir::Up,
                "right" => Dir::Right,
                // Python treats every other value as a horizontal scroll to the left.
                _ => Dir::Left,
            };
            let amount = int_like(action, "amount", 3)?.clamp(0, 100) as u32;
            Action::Scroll { dir, amount, at: opt_point(action)? }
        }
        "move" => Action::Move { x: coord(action, "x", "move")?, y: coord(action, "y", "move")? },
        "click" => Action::Click {
            x: coord(action, "x", "click")?,
            y: coord(action, "y", "click")?,
            button: button()?,
        },
        "type" => Action::Type { text: text(action, "text")?, allow_terminal, allow_password },
        "hotkey" => {
            let keys = keys(action.get("keys"))?;
            if !keys.is_empty() {
                safety::check_combo(&keys)?;
            }
            Action::Hotkey { keys, allow_terminal, allow_password }
        }
        "click_element" => Action::ClickElement {
            text: text(action, "text")?,
            button: button()?,
            bbox: bbox(action.get("bbox"))?,
        },
        "click_nth_element" => Action::ClickNth {
            text: text(action, "text")?,
            n: int_like(action, "n", 1)?.max(1) as usize,
            button: button()?,
        },
        "navigate_url" => Action::NavigateUrl {
            url: match action.get("url") {
                Some(Value::String(s)) => safety::check_url(s)?,
                _ => safety::check_url("")?,
            },
        },
        "focus_browser" => Action::FocusBrowser,
        other => return Err(failed(format!("Unknown action type: {other}"))),
    })
}

/// The `action` object of an `execute` request (missing = `{}`, like Python).
pub fn action_of(args: &Args) -> Result<Map<String, Value>, AgentError> {
    match args.get("action") {
        None => Ok(Map::new()),
        Some(Value::Object(o)) => Ok(o.clone()),
        Some(_) => Err(AgentError::invalid("action must be an object")),
    }
}

#[cfg(windows)]
mod run;
#[cfg(windows)]
pub use run::cmd_execute;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(v: Value) -> Result<Action, AgentError> {
        parse(v.as_object().unwrap())
    }

    #[test]
    fn parses_every_action() {
        assert_eq!(
            p(json!({"type": "scroll"})).unwrap(),
            Action::Scroll { dir: Dir::Down, amount: 3, at: None }
        );
        assert_eq!(
            p(json!({"type": "scroll", "direction": "left", "amount": "2", "x": 5.6, "y": 7})).unwrap(),
            Action::Scroll { dir: Dir::Left, amount: 2, at: Some((6, 7)) }
        );
        assert!(matches!(
            p(json!({"type": "scroll", "direction": "sideways", "amount": 1.9})).unwrap(),
            Action::Scroll { dir: Dir::Left, amount: 1, .. }
        ));
        assert_eq!(p(json!({"type": "move", "x": 1, "y": 2})).unwrap(), Action::Move { x: 1, y: 2 });
        assert_eq!(
            p(json!({"type": "click", "x": 1, "y": 2, "button": "right"})).unwrap(),
            Action::Click { x: 1, y: 2, button: Button::Right }
        );
        assert_eq!(
            p(json!({"type": "type", "text": "hi", "allowTerminal": true})).unwrap(),
            Action::Type { text: "hi".into(), allow_terminal: true, allow_password: false }
        );
        assert_eq!(
            p(json!({"type": "type", "text": "hi", "allowPassword": true})).unwrap(),
            Action::Type { text: "hi".into(), allow_terminal: false, allow_password: true }
        );
        // allowTerminal must be exactly true.
        assert_eq!(
            p(json!({"type": "type", "text": "hi", "allowTerminal": "yes"})).unwrap(),
            Action::Type { text: "hi".into(), allow_terminal: false, allow_password: false }
        );
        assert_eq!(
            p(json!({"type": "hotkey", "keys": ["Ctrl", "L"]})).unwrap(),
            Action::Hotkey {
                keys: vec!["ctrl".into(), "l".into()],
                allow_terminal: false,
                allow_password: false
            }
        );
        assert_eq!(
            p(json!({"type": "hotkey", "keys": "ctrl+shift+t"})).unwrap(),
            Action::Hotkey {
                keys: vec!["ctrl".into(), "shift".into(), "t".into()],
                allow_terminal: false,
                allow_password: false
            }
        );
        assert_eq!(
            p(json!({"type": "hotkey"})).unwrap(),
            Action::Hotkey { keys: vec![], allow_terminal: false, allow_password: false }
        );
        assert_eq!(
            p(json!({"type": "click_element", "text": "OK", "bbox": [10, 20, 31, 41]})).unwrap(),
            Action::ClickElement {
                text: "OK".into(),
                button: Button::Left,
                bbox: Some([10.0, 20.0, 31.0, 41.0])
            }
        );
        assert_eq!(
            p(json!({"type": "click_element", "text": "OK", "bbox": []})).unwrap(),
            Action::ClickElement { text: "OK".into(), button: Button::Left, bbox: None }
        );
        assert_eq!(
            p(json!({"type": "click_nth_element", "text": "a", "n": 3})).unwrap(),
            Action::ClickNth { text: "a".into(), n: 3, button: Button::Left }
        );
        assert_eq!(
            p(json!({"type": "navigate_url", "url": " https://example.com/x "})).unwrap(),
            Action::NavigateUrl { url: "https://example.com/x".into() }
        );
        assert_eq!(p(json!({"type": "focus_browser"})).unwrap(), Action::FocusBrowser);
    }

    #[test]
    fn errors_match_python() {
        let e = p(json!({"type": "teleport"})).unwrap_err();
        assert_eq!(
            (e.code, e.message.as_str()),
            ("E_INTERNAL", "execute failed: Unknown action type: teleport")
        );
        let e = p(json!({})).unwrap_err();
        assert_eq!(e.message, "execute failed: Unknown action type: None");
        for bad in [
            json!({"type": "click", "x": 1}),
            json!({"type": "move"}),
            json!({"type": "click", "x": 1, "y": 1, "button": "thumb"}),
            json!({"type": "click_element", "text": "a", "bbox": [1, 2]}),
            json!({"type": "scroll", "amount": "lots"}),
        ] {
            assert_eq!(p(bad.clone()).unwrap_err().code, "E_INVALID", "{bad}");
        }
    }

    #[test]
    fn safety_runs_before_input() {
        for (action, code) in [
            (json!({"type": "hotkey", "keys": ["win", "r"]}), "E_DENIED"),
            (json!({"type": "hotkey", "keys": ["ctrl", "alt", "delete"]}), "E_DENIED"),
            (json!({"type": "hotkey", "keys": ["ctrl", "shift", "escape"]}), "E_DENIED"),
            (json!({"type": "navigate_url", "url": "file:///C:/Windows/system32/cmd.exe"}), "E_DENIED"),
            (json!({"type": "navigate_url", "url": "javascript:alert(1)"}), "E_DENIED"),
            (json!({"type": "navigate_url"}), "E_DENIED"),
        ] {
            assert_eq!(p(action.clone()).unwrap_err().code, code, "{action}");
        }
        assert!(p(json!({"type": "hotkey", "keys": ["win", "d"]})).is_ok());
    }

    #[test]
    fn combo_vectors_through_execute() {
        let v: Value =
            serde_json::from_str(include_str!("../../conformance/fixtures/safety-vectors.json")).unwrap();
        for c in v["combos"].as_array().unwrap() {
            let r = p(json!({"type": "hotkey", "keys": c["keys"]}));
            assert_eq!(r.is_err(), c["denied"].as_bool().unwrap(), "{c}");
        }
    }

    #[test]
    fn bbox_center_floors() {
        assert_eq!(bbox_center([10.0, 20.0, 31.0, 41.0]), (20, 30));
        assert_eq!(bbox_center([-3.0, 0.0, 0.0, 0.0]), (-2, 0));
    }

    #[test]
    fn action_object() {
        assert!(action_of(json!({}).as_object().unwrap()).unwrap().is_empty());
        assert_eq!(action_of(json!({"action": 1}).as_object().unwrap()).unwrap_err().code, "E_INVALID");
    }
}
