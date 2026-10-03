//! Agent protocol v2 (plans CONTRACTS C2): NDJSON framing, error codes.
//!
//! Requests are `{v:2, id, cmd, args}`; any other object is a protocol error.

pub mod router;
pub mod writer;

use serde::Serialize;
use serde_json::{Map, Value, json};

pub type Args = Map<String, Value>;
pub type CmdResult = Result<Value, AgentError>;

pub const E_TIMEOUT: &str = "E_TIMEOUT";
pub const E_CANCELLED: &str = "E_CANCELLED";
pub const E_NOT_FOUND: &str = "E_NOT_FOUND";
pub const E_DENIED: &str = "E_DENIED";
pub const E_UNSUPPORTED: &str = "E_UNSUPPORTED";
pub const E_INVALID: &str = "E_INVALID";
pub const E_INTERNAL: &str = "E_INTERNAL";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentError {
    pub code: &'static str,
    pub message: String,
}

impl AgentError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(E_INVALID, message)
    }
    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(E_UNSUPPORTED, message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(E_NOT_FOUND, message)
    }
    pub fn denied(message: impl Into<String>) -> Self {
        Self::new(E_DENIED, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(E_INTERNAL, message)
    }
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AgentError {}

#[cfg(windows)]
impl From<windows::core::Error> for AgentError {
    fn from(e: windows::core::Error) -> Self {
        AgentError::internal(format!("{} (0x{:08X})", e.message(), e.code().0))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub id: Value,
    pub cmd: Option<String>,
    pub args: Args,
}

/// Longest prefix of an unparseable line echoed back in `protocol-error`.
const ERROR_ECHO_CHARS: usize = 200;

/// Parses one stdin line. `None` for blank lines; `Err(echo)` when the line is
/// not a v2 request object (the caller emits `protocol-error {line: echo}`).
pub fn parse_line(line: &str) -> Option<Result<Request, String>> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let echo = || line.chars().take(ERROR_ECHO_CHARS).collect();
    let Ok(Value::Object(mut msg)) = serde_json::from_str::<Value>(line) else {
        return Some(Err(echo()));
    };
    if msg.get("v").and_then(Value::as_i64) != Some(2) {
        return Some(Err(echo()));
    }
    let id = msg.get("id").cloned().unwrap_or(json!(0));
    let cmd = msg.get("cmd").and_then(Value::as_str).map(str::to_owned);
    let args = match msg.remove("args") {
        Some(Value::Object(args)) => args,
        _ => Args::new(),
    };
    Some(Ok(Request { id, cmd, args }))
}

#[derive(Serialize)]
struct OkFrame<'a> {
    v: u8,
    id: &'a Value,
    ok: bool,
    result: &'a Value,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    code: &'a str,
    message: &'a str,
}

#[derive(Serialize)]
struct ErrorFrame<'a> {
    v: u8,
    id: &'a Value,
    ok: bool,
    error: ErrorBody<'a>,
}

#[derive(Serialize)]
struct EventFrame<'a> {
    v: u8,
    event: &'a str,
    data: &'a Value,
}

fn to_line<T: Serialize>(frame: &T) -> String {
    serde_json::to_string(frame).unwrap_or_default()
}

pub fn response_line(id: &Value, result: &CmdResult) -> String {
    match result {
        Ok(result) => to_line(&OkFrame { v: 2, id, ok: true, result }),
        Err(e) => to_line(&ErrorFrame {
            v: 2,
            id,
            ok: false,
            error: ErrorBody { code: e.code, message: &e.message },
        }),
    }
}

pub fn event_line(event: &str, data: Value) -> String {
    let empty = Value::Object(Map::new());
    let data = if data.is_null() { &empty } else { &data };
    to_line(&EventFrame { v: 2, event, data })
}

/// Typed argument accessors that fail with E_INVALID.
pub mod arg {
    use super::{AgentError, Args};
    use serde_json::Value;

    pub fn opt_str<'a>(args: &'a Args, key: &str) -> Result<Option<&'a str>, AgentError> {
        match args.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s)),
            Some(_) => Err(AgentError::invalid(format!("{key} must be a string"))),
        }
    }

    pub fn str<'a>(args: &'a Args, key: &str) -> Result<&'a str, AgentError> {
        opt_str(args, key)?.ok_or_else(|| AgentError::invalid(format!("{key} is required")))
    }

    pub fn opt_bool(args: &Args, key: &str) -> Result<Option<bool>, AgentError> {
        match args.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(_) => Err(AgentError::invalid(format!("{key} must be a boolean"))),
        }
    }

    /// Integer (JSON numbers with no fractional part; floats are truncated like Python's int()).
    pub fn opt_i64(args: &Args, key: &str) -> Result<Option<i64>, AgentError> {
        match args.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Number(n)) => n
                .as_i64()
                .or_else(|| n.as_f64().filter(|f| f.is_finite()).map(|f| f as i64))
                .map(Some)
                .ok_or_else(|| AgentError::invalid(format!("{key} must be a number"))),
            Some(_) => Err(AgentError::invalid(format!("{key} must be a number"))),
        }
    }

    pub fn opt_f64(args: &Args, key: &str) -> Result<Option<f64>, AgentError> {
        match args.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Number(n)) => Ok(n.as_f64()),
            Some(_) => Err(AgentError::invalid(format!("{key} must be a number"))),
        }
    }

    pub fn i64(args: &Args, key: &str) -> Result<i64, AgentError> {
        opt_i64(args, key)?.ok_or_else(|| AgentError::invalid(format!("{key} is required")))
    }

    pub fn obj<'a>(args: &'a Args, key: &str) -> Option<&'a Args> {
        args.get(key).and_then(Value::as_object)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn parses_v2_framing() {
        let r = parse_line(r#"{"v":2,"id":7,"cmd":"ping","args":{"a":1}}"#).unwrap().unwrap();
        assert_eq!(r.id, json!(7));
        assert_eq!(r.cmd.as_deref(), Some("ping"));
        assert_eq!(r.args.get("a"), Some(&json!(1)));
    }

    #[test]
    fn rejects_v1_framing() {
        let line = r#"{"id":1,"cmd":"set_hotkey","combo":"Ctrl+A"}"#;
        assert_eq!(parse_line(line).unwrap().unwrap_err(), line);
    }

    #[test]
    fn v2_with_non_object_args_gets_empty_args() {
        let r = parse_line(r#"{"v":2,"id":1,"cmd":"ping","args":[1]}"#).unwrap().unwrap();
        assert!(r.args.is_empty());
    }

    #[test]
    fn missing_id_defaults_to_zero() {
        let r = parse_line(r#"{"v":2,"cmd":"ping"}"#).unwrap().unwrap();
        assert_eq!(r.id, json!(0));
    }

    #[test]
    fn blank_and_garbage() {
        assert!(parse_line("   \r").is_none());
        assert_eq!(parse_line("garbage").unwrap().unwrap_err(), "garbage");
        assert_eq!(parse_line("[1,2]").unwrap().unwrap_err(), "[1,2]");
        let long = "x".repeat(500);
        assert_eq!(parse_line(&long).unwrap().unwrap_err().chars().count(), 200);
    }

    #[test]
    fn frames() {
        assert_eq!(response_line(&json!(3), &Ok(json!({}))), r#"{"v":2,"id":3,"ok":true,"result":{}}"#);
        assert_eq!(
            response_line(&json!(4), &Err(AgentError::invalid("bad"))),
            r#"{"v":2,"id":4,"ok":false,"error":{"code":"E_INVALID","message":"bad"}}"#
        );
        assert_eq!(event_line("x", Value::Null), r#"{"v":2,"event":"x","data":{}}"#);
        let nested = json!({"z": [1, 2.5, null, {"b": "é
\"q\"", "a": true}], "a": {"y": -3}});
        assert_eq!(
            response_line(&json!("k"), &Ok(nested.clone())),
            json!({"v": 2, "id": "k", "ok": true, "result": nested}).to_string()
        );
        assert_eq!(
            event_line("e", nested.clone()),
            json!({"v": 2, "event": "e", "data": nested}).to_string()
        );
        assert_eq!(event_line("x", json!({"s":"é"})), "{\"v\":2,\"event\":\"x\",\"data\":{\"s\":\"é\"}}");
    }

    proptest! {
        #[test]
        fn parser_never_panics(s in "\\PC*") {
            let _ = parse_line(&s);
        }

        #[test]
        fn parser_never_panics_on_json_like(s in r#"\{("[a-z]{0,4}":(-?[0-9]{1,20}(\.[0-9]+)?|"[^"]{0,8}"|null|true|\[\]|\{\}),?){0,6}\}"#) {
            if let Some(Ok(r)) = parse_line(&s) {
                let _ = response_line(&r.id, &Ok(Value::Object(r.args)));
            }
        }
    }
}
