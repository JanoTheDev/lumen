//! The only code that writes stdout. One thread drains a bounded queue of
//! complete lines; senders never touch the pipe.
//!
//! Droppable events (`try_emit`) stop at `QUEUE_CAP - RESERVE` queued lines, so edge
//! events that must not be lost (key and button releases, `try_emit_edge`) still find
//! room when main stops reading for a while. High-rate state events (`emit_latest`)
//! keep one queued line per event name and replace its data until it is written.

use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender, bounded};
use serde_json::Value;

use super::{CmdResult, event_line, response_line};

const QUEUE_CAP: usize = 1024;
/// Queue slots only edge events, responses and blocking emits may use.
const RESERVE: usize = 128;

enum Msg {
    Line(String),
    /// Write the current line in `Out::latest` for this event, if any.
    Latest(&'static str),
    Flush(Sender<()>),
}

type LatestSlots = Arc<Mutex<HashMap<&'static str, String>>>;

#[derive(Clone)]
pub struct Out {
    tx: Sender<Msg>,
    latest: LatestSlots,
}

impl Out {
    pub fn respond(&self, id: &Value, result: &CmdResult) {
        let _ = self.tx.send(Msg::Line(response_line(id, result)));
    }

    /// Queues an event, waiting for room if the queue is full.
    pub fn emit(&self, event: &str, data: Value) {
        let _ = self.tx.send(Msg::Line(event_line(event, data)));
    }

    /// Queues an event without ever blocking (hook callbacks, high-rate events).
    /// Returns false when the queue was nearly full and the event was dropped.
    pub fn try_emit(&self, event: &str, data: Value) -> bool {
        if self.tx.len() >= QUEUE_CAP - RESERVE {
            return false;
        }
        self.tx.try_send(Msg::Line(event_line(event, data))).is_ok()
    }

    /// Like `try_emit`, but may use the reserved slots: releases and other edges main
    /// must see. Returns false only when the whole queue is full.
    pub fn try_emit_edge(&self, event: &str, data: Value) -> bool {
        self.tx.try_send(Msg::Line(event_line(event, data))).is_ok()
    }

    /// Never blocks. While an earlier `event` line is still queued, only its data is
    /// replaced, so a stalled reader sees at most one queued line per event name.
    pub fn emit_latest(&self, event: &'static str, data: Value) -> bool {
        let line = event_line(event, data);
        let mut slots = self.latest.lock().unwrap();
        if let Some(queued) = slots.get_mut(event) {
            *queued = line;
            return true;
        }
        if self.tx.len() >= QUEUE_CAP - RESERVE || self.tx.try_send(Msg::Latest(event)).is_err() {
            return false;
        }
        slots.insert(event, line);
        true
    }

    /// Waits until everything queued so far is written.
    pub fn flush(&self, timeout: Duration) {
        let (tx, rx) = bounded(1);
        if self.tx.send(Msg::Flush(tx)).is_ok() {
            let _ = rx.recv_timeout(timeout);
        }
    }
}

pub fn start(sink: Box<dyn Write + Send>) -> (Out, JoinHandle<()>) {
    let (tx, rx) = bounded(QUEUE_CAP);
    let latest = LatestSlots::default();
    let slots = latest.clone();
    let handle = std::thread::Builder::new()
        .name("proto-writer".into())
        .spawn(move || run(sink, rx, slots))
        .expect("spawn writer");
    (Out { tx, latest }, handle)
}

fn write_line(out: &mut impl Write, line: &str) -> bool {
    out.write_all(line.as_bytes()).and_then(|_| out.write_all(b"\n")).is_ok()
}

fn run(sink: Box<dyn Write + Send>, rx: Receiver<Msg>, latest: LatestSlots) {
    let mut out = std::io::BufWriter::with_capacity(64 * 1024, sink);
    for msg in &rx {
        match msg {
            Msg::Line(line) => {
                if !write_line(&mut out, &line) {
                    return;
                }
            }
            Msg::Latest(event) => {
                let line = latest.lock().unwrap().remove(event);
                if let Some(line) = line
                    && !write_line(&mut out, &line)
                {
                    return;
                }
            }
            Msg::Flush(done) => {
                let _ = out.flush();
                let _ = done.send(());
                continue;
            }
        }
        // Flush once the burst is drained: one syscall per batch, never a stale line.
        if rx.is_empty() && out.flush().is_err() {
            return;
        }
    }
    let _ = out.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn lines_from_many_threads_stay_whole() {
        let sink = Sink::default();
        let (out, _h) = start(Box::new(sink.clone()));
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let out = out.clone();
                std::thread::spawn(move || {
                    for i in 0..500 {
                        out.emit("e", json!({"t": t, "i": i, "pad": "x".repeat(i % 50)}));
                    }
                })
            })
            .collect();
        threads.into_iter().for_each(|t| t.join().unwrap());
        out.flush(Duration::from_secs(5));
        let text = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 4000);
        for l in lines {
            serde_json::from_str::<Value>(l).unwrap();
        }
    }

    /// A sink that blocks every write until released, like a reader that stopped reading.
    #[derive(Clone)]
    struct Gate {
        open: Arc<(Mutex<bool>, std::sync::Condvar)>,
        data: Sink,
    }
    impl Write for Gate {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let (lock, cv) = &*self.open;
            let mut open = lock.lock().unwrap();
            while !*open {
                open = cv.wait(open).unwrap();
            }
            self.data.write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn gated() -> (Out, Gate) {
        let gate = Gate { open: Default::default(), data: Sink::default() };
        let (out, _h) = start(Box::new(gate.clone()));
        // The writer thread takes this first line and blocks on it: the queue is now
        // exactly what the test fills.
        out.emit("first", json!({}));
        while !out.tx.is_empty() {
            std::thread::sleep(Duration::from_millis(1));
        }
        (out, gate)
    }

    fn release(out: &Out, gate: &Gate) -> Vec<Value> {
        let (lock, cv) = &*gate.open;
        *lock.lock().unwrap() = true;
        cv.notify_all();
        out.flush(Duration::from_secs(5));
        let text = String::from_utf8(gate.data.0.lock().unwrap().clone()).unwrap();
        text.lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    #[test]
    fn edge_events_survive_a_full_queue() {
        let (out, gate) = gated();
        let mut sent = 0;
        while out.try_emit("noise", json!({"i": sent})) {
            sent += 1;
        }
        assert_eq!(sent, QUEUE_CAP - RESERVE);
        assert!(out.try_emit_edge("hotkey-up", json!({})));
        let lines = release(&out, &gate);
        assert_eq!(lines.last().unwrap()["event"], "hotkey-up");
    }

    #[test]
    fn latest_events_coalesce_while_queued() {
        let (out, gate) = gated();
        for i in 0..5000 {
            assert!(out.emit_latest("mouse-moved", json!({"x": i})));
        }
        out.emit("other", json!({}));
        let lines = release(&out, &gate);
        let events: Vec<_> = lines.iter().map(|l| l["event"].as_str().unwrap()).collect();
        assert_eq!(events, ["first", "mouse-moved", "other"]);
        assert_eq!(lines[1]["data"]["x"], 4999);
        assert!(out.emit_latest("mouse-moved", json!({"x": -1})), "slot is free once written");
        out.flush(Duration::from_secs(5));
    }
}
