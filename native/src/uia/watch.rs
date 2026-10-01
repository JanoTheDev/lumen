//! `uia-event {kind, element}` while subscribed (lesson checks):
//!
//! - `invoked`  Invoke_Invoked in the foreground window
//! - `value`    ValueProperty changed in the foreground window (password values masked)
//! - `selected` SelectionItem_ElementSelected in the foreground window
//! - `window-opened` Window_WindowOpened in the foreground window or any new top-level window
//!
//! A dedicated MTA thread owns the registrations (UIA guidance: never on a UI
//! thread, and never the hotkey hook thread). It polls the foreground window every
//! 250 ms and moves the subtree handlers when it changes. Handlers only read
//! cached properties and queue an event with a non-blocking send.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use crossbeam_channel::{RecvTimeoutError, Sender, bounded};
use serde_json::json;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::*;
use windows::core::{BSTR, Ref, implement};

use super::{Client, node_of};
use crate::monitors::{self, MonitorInfo};
use crate::proto::writer::Out;

const FOREGROUND_POLL: Duration = Duration::from_millis(250);
const MONITORS_TTL: Duration = Duration::from_secs(2);

const SUBTREE_EVENTS: [UIA_EVENT_ID; 3] =
    [UIA_Invoke_InvokedEventId, UIA_SelectionItem_ElementSelectedEventId, UIA_Window_WindowOpenedEventId];

/// Event kind for a UIA event id. Pure.
pub fn kind_of(event: UIA_EVENT_ID) -> Option<&'static str> {
    [
        (UIA_Invoke_InvokedEventId, "invoked"),
        (UIA_SelectionItem_ElementSelectedEventId, "selected"),
        (UIA_Window_WindowOpenedEventId, "window-opened"),
    ]
    .into_iter()
    .find(|(id, _)| *id == event)
    .map(|(_, kind)| kind)
}

struct Emitter {
    out: Out,
    monitors: Mutex<(Instant, Vec<MonitorInfo>)>,
}

impl Emitter {
    fn emit(&self, kind: &str, el: &IUIAutomationElement, value: Option<String>) {
        let mons = {
            let mut m = self.monitors.lock().unwrap();
            if m.0.elapsed() > MONITORS_TTL {
                *m = (Instant::now(), monitors::enumerate());
            }
            m.1.clone()
        };
        let mut node = node_of(el, &mons);
        // node_of masks password values; only a plain field takes the event's new value.
        if let Some(v) = value
            && node.readonly.is_some()
            && !super::cached_bool(el, UIA_IsPasswordPropertyId)
        {
            node.value = Some(super::tree::truncate(&v, super::tree::VALUE_MAX));
        }
        let mut node = serde_json::to_value(node).unwrap_or_default();
        if let Some(o) = node.as_object_mut() {
            o.remove("id");
        }
        self.out.try_emit("uia-event", json!({"kind": kind, "element": node}));
    }
}

#[implement(IUIAutomationEventHandler)]
struct EventHandler(std::sync::Arc<Emitter>);

impl IUIAutomationEventHandler_Impl for EventHandler_Impl {
    fn HandleAutomationEvent(
        &self,
        sender: Ref<IUIAutomationElement>,
        event: UIA_EVENT_ID,
    ) -> windows::core::Result<()> {
        if let (Some(el), Some(kind)) = (sender.as_ref(), kind_of(event)) {
            self.0.emit(kind, el, None);
        }
        Ok(())
    }
}

#[implement(IUIAutomationPropertyChangedEventHandler)]
struct ValueHandler(std::sync::Arc<Emitter>);

impl IUIAutomationPropertyChangedEventHandler_Impl for ValueHandler_Impl {
    fn HandlePropertyChangedEvent(
        &self,
        sender: Ref<IUIAutomationElement>,
        _property: UIA_PROPERTY_ID,
        value: &VARIANT,
    ) -> windows::core::Result<()> {
        if let Some(el) = sender.as_ref() {
            self.0.emit("value", el, BSTR::try_from(value).ok().map(|b| b.to_string()));
        }
        Ok(())
    }
}

/// Subtree handlers on one foreground window.
struct Watched {
    hwnd: isize,
    element: Option<IUIAutomationElement>,
}

struct Registrar {
    client: std::rc::Rc<Client>,
    events: IUIAutomationEventHandler,
    values: IUIAutomationPropertyChangedEventHandler,
}

impl Registrar {
    fn watch(&self, hwnd: isize) -> Watched {
        let element = (hwnd != 0).then(|| self.add(hwnd)).flatten();
        Watched { hwnd, element }
    }

    fn add(&self, hwnd: isize) -> Option<IUIAutomationElement> {
        let c = &self.client;
        // SAFETY: UIA calls on this MTA thread with live interfaces.
        unsafe {
            let el = c.u.ElementFromHandle(HWND(hwnd as *mut _)).ok()?;
            for event in SUBTREE_EVENTS {
                if let Err(e) =
                    c.u.AddAutomationEventHandler(event, &el, TreeScope_Subtree, &c.elem_cr, &self.events)
                {
                    tracing::debug!("uia-event: add {} failed: {}", event.0, e.message());
                }
            }
            if let Err(e) = c.u.AddPropertyChangedEventHandlerNativeArray(
                &el,
                TreeScope_Subtree,
                &c.elem_cr,
                &self.values,
                &[UIA_ValueValuePropertyId],
            ) {
                tracing::debug!("uia-event: add value handler failed: {}", e.message());
            }
            Some(el)
        }
    }

    fn unwatch(&self, w: Watched) {
        let Some(el) = w.element else { return };
        // SAFETY: as in `add`; removal of handlers that may already be gone is harmless.
        unsafe {
            for event in SUBTREE_EVENTS {
                let _ = self.client.u.RemoveAutomationEventHandler(event, &el, &self.events);
            }
            let _ = self.client.u.RemovePropertyChangedEventHandler(&el, &self.values);
        }
    }
}

fn run(out: Out, stop: crossbeam_channel::Receiver<()>) -> Result<(), String> {
    let client = Client::get().map_err(|e| e.message)?;
    let emitter =
        std::sync::Arc::new(Emitter { out, monitors: Mutex::new((Instant::now(), monitors::enumerate())) });
    let r = Registrar {
        client,
        events: EventHandler(emitter.clone()).into(),
        values: ValueHandler(emitter).into(),
    };
    // SAFETY: UIA calls on this MTA thread with live interfaces.
    let root =
        unsafe { r.client.u.GetRootElement() }.map_err(|e| format!("GetRootElement: {}", e.message()))?;
    // New top-level windows anywhere (dialogs, Settings opened by a shortcut).
    // SAFETY: as above.
    unsafe {
        r.client
            .u
            .AddAutomationEventHandler(
                UIA_Window_WindowOpenedEventId,
                &root,
                TreeScope_Children,
                &r.client.elem_cr,
                &r.events,
            )
            .map_err(|e| format!("AddAutomationEventHandler: {}", e.message()))?;
    }
    let mut watched = r.watch(crate::window::foreground());
    while let Err(RecvTimeoutError::Timeout) = stop.recv_timeout(FOREGROUND_POLL) {
        let fg = crate::window::foreground();
        if fg != watched.hwnd {
            r.unwatch(watched);
            watched = r.watch(fg);
        }
    }
    r.unwatch(watched);
    // SAFETY: as above.
    let _ =
        unsafe { r.client.u.RemoveAutomationEventHandler(UIA_Window_WindowOpenedEventId, &root, &r.events) };
    Ok(())
}

static RUNNING: Mutex<Option<Sender<()>>> = Mutex::new(None);

/// Starts or stops the uia-event watcher.
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
    let spawned = std::thread::Builder::new().name("uia-events".into()).spawn(move || {
        crate::com_init();
        if let Err(e) = run(out, stop_rx) {
            tracing::error!("uia-event: {e}");
            // Not running after all: let the next subscribe try again.
            let mut running = RUNNING.lock().unwrap();
            if running.as_ref().is_some_and(|tx| tx.same_channel(&mine)) {
                *running = None;
            }
        }
    });
    match spawned {
        Ok(_) => *running = Some(stop_tx),
        Err(e) => tracing::error!("uia-event thread: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds() {
        assert_eq!(kind_of(UIA_Invoke_InvokedEventId), Some("invoked"));
        assert_eq!(kind_of(UIA_SelectionItem_ElementSelectedEventId), Some("selected"));
        assert_eq!(kind_of(UIA_Window_WindowOpenedEventId), Some("window-opened"));
        assert_eq!(kind_of(UIA_AutomationFocusChangedEventId), None);
    }
}
