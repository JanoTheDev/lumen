//! `focus-changed` events, only while subscribed. A dedicated MTA thread
//! registers the handler (UIA guidance: never on a UI thread); the handler only
//! reads cached properties and queues a throttled event.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use crossbeam_channel::{Sender, bounded};
use serde_json::json;
use windows::Win32::UI::Accessibility::{
    IUIAutomationElement, IUIAutomationFocusChangedEventHandler, IUIAutomationFocusChangedEventHandler_Impl,
};
use windows::core::{Ref, implement};

use super::{Client, node_of};
use crate::monitors;
use crate::proto::writer::Out;

const MIN_INTERVAL: Duration = Duration::from_millis(200);

#[implement(IUIAutomationFocusChangedEventHandler)]
struct Handler {
    out: Out,
    last: Mutex<Option<Instant>>,
}

impl IUIAutomationFocusChangedEventHandler_Impl for Handler_Impl {
    fn HandleFocusChangedEvent(&self, sender: Ref<IUIAutomationElement>) -> windows::core::Result<()> {
        let Some(el) = sender.as_ref() else { return Ok(()) };
        {
            let mut last = self.last.lock().unwrap();
            if last.is_some_and(|t| t.elapsed() < MIN_INTERVAL) {
                return Ok(());
            }
            *last = Some(Instant::now());
        }
        let mons = monitors::enumerate();
        let mut node = serde_json::to_value(node_of(el, &mons)).unwrap_or_default();
        if let Some(o) = node.as_object_mut() {
            o.remove("id");
        }
        self.out.try_emit("focus-changed", json!({"element": node}));
        Ok(())
    }
}

static RUNNING: Mutex<Option<Sender<()>>> = Mutex::new(None);

/// Starts or stops the focus-changed listener.
pub fn set_enabled(out: &Out, enabled: bool) {
    let mut running = RUNNING.lock().unwrap();
    if !enabled {
        if let Some(stop) = running.take() {
            let _ = stop.send(());
        }
        return;
    }
    if running.is_some() {
        return;
    }
    let (stop_tx, stop_rx) = bounded::<()>(1);
    let mine = stop_tx.clone();
    let out = out.clone();
    let spawned = std::thread::Builder::new().name("uia-focus-events".into()).spawn(move || {
        crate::com_init();
        let registered = Client::get().map_err(|e| e.message).and_then(|client| {
            let handler: IUIAutomationFocusChangedEventHandler =
                Handler { out, last: Mutex::new(None) }.into();
            // SAFETY: registration/removal happen on this MTA thread with live interfaces.
            unsafe {
                client
                    .u
                    .AddFocusChangedEventHandler(&client.elem_cr, &handler)
                    .map_err(|e| format!("AddFocusChangedEventHandler failed: {}", e.message()))?;
                let _ = stop_rx.recv();
                let _ = client.u.RemoveFocusChangedEventHandler(&handler);
            }
            Ok(())
        });
        if let Err(e) = registered {
            tracing::error!("focus-changed: {e}");
            // Not running after all: let the next subscribe try again.
            let mut running = RUNNING.lock().unwrap();
            if running.as_ref().is_some_and(|tx| tx.same_channel(&mine)) {
                *running = None;
            }
        }
    });
    match spawned {
        Ok(_) => *running = Some(stop_tx),
        Err(e) => tracing::error!("focus-changed thread: {e}"),
    }
}
