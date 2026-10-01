//! The only code that writes stdout. One thread drains a bounded queue of
//! complete lines; senders never touch the pipe.

use std::io::Write;
use std::thread::JoinHandle;
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender, bounded};
use serde_json::Value;

use super::{CmdResult, event_line, response_line};

const QUEUE_CAP: usize = 1024;

enum Msg {
    Line(String),
    Flush(Sender<()>),
}

#[derive(Clone)]
pub struct Out {
    tx: Sender<Msg>,
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
    /// Returns false when the queue was full and the event was dropped.
    pub fn try_emit(&self, event: &str, data: Value) -> bool {
        self.tx.try_send(Msg::Line(event_line(event, data))).is_ok()
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
    let handle = std::thread::Builder::new()
        .name("proto-writer".into())
        .spawn(move || run(sink, rx))
        .expect("spawn writer");
    (Out { tx }, handle)
}

fn run(sink: Box<dyn Write + Send>, rx: Receiver<Msg>) {
    let mut out = std::io::BufWriter::with_capacity(64 * 1024, sink);
    for msg in &rx {
        match msg {
            Msg::Line(line) => {
                if out.write_all(line.as_bytes()).and_then(|_| out.write_all(b"\n")).is_err() {
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
    use std::sync::{Arc, Mutex};

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
}
