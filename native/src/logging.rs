//! tracing → stderr, level switchable at runtime by `init.logLevel`.

use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::reload;
use tracing_subscriber::util::SubscriberInitExt;

use crate::proto::AgentError;

pub type Handle = reload::Handle<LevelFilter, tracing_subscriber::Registry>;

pub fn init() -> Handle {
    let (filter, handle) = reload::Layer::new(LevelFilter::INFO);
    tracing_subscriber::registry()
        .with(filter)
        .with(
            tracing_subscriber::fmt::layer().with_writer(std::io::stderr).with_ansi(false).with_target(true),
        )
        .init();
    handle
}

pub fn parse_level(level: &str) -> Result<LevelFilter, AgentError> {
    match level {
        "debug" => Ok(LevelFilter::DEBUG),
        "info" => Ok(LevelFilter::INFO),
        "warn" => Ok(LevelFilter::WARN),
        "error" => Ok(LevelFilter::ERROR),
        _ => Err(AgentError::invalid("init.logLevel must be one of ['debug', 'error', 'info', 'warn']")),
    }
}

pub fn set_level(handle: &Handle, level: LevelFilter) {
    let _ = handle.modify(|f| *f = level);
}
