//! Where the core's news goes.
//!
//! The core does not know whether a window or a socket is listening. Events
//! that mean something changed (a session ended, the tree moved, a hook
//! fired) go through a [`Sink`]; a pty's bytes go straight to the [`Output`]
//! its spawner handed over, since that is a stream and not news.

use std::sync::Arc;

/// Named events with a JSON payload, the shape the window listens to.
pub trait Sink: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: serde_json::Value);
}

/// A pty's output as it arrives, raw: a read can land in the middle of a
/// UTF-8 sequence and the terminal's decoder is the one that handles that.
/// Returns false once nobody is listening any more, which ends the reader.
pub type Output = Box<dyn FnMut(&[u8]) -> bool + Send>;

/// Serializes and emits, dropping a payload that will not serialize: none
/// of them can, and an event is not worth a panic.
pub fn emit<T: serde::Serialize>(sink: &Arc<dyn Sink>, event: &str, payload: &T) {
    if let Ok(value) = serde_json::to_value(payload) {
        sink.emit(event, value);
    }
}

#[cfg(test)]
pub mod testing {
    use super::*;
    use std::cell::Cell;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    /// Where a test's waits for a session's events have got to. A wait
    /// looks only at events told after the one the last wait matched, so it
    /// cannot take an event that came before what the test did since, or
    /// miss a state that came and went before it looked.
    #[derive(Default)]
    pub struct Waits {
        /// How many of the events the waits have gone past.
        past: Cell<usize>,
    }

    impl Waits {
        /// Waits for an event past the last match, and hands back every
        /// event from the start up to and with it.
        pub fn until(
            &self,
            events: impl Fn() -> Vec<serde_json::Value>,
            what: impl Fn(&serde_json::Value) -> bool,
        ) -> Vec<serde_json::Value> {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                let events = events();
                let from = self.past.get();
                if let Some(at) = events[from..].iter().position(&what) {
                    let at = from + at;
                    self.past.set(at + 1);
                    return events[..=at].to_vec();
                }
                assert!(
                    Instant::now() < deadline,
                    "never came; the session said {events:#?}"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }

    /// Keeps what was emitted, for tests to look at.
    #[derive(Default)]
    pub struct Recorder {
        pub events: Mutex<Vec<(String, serde_json::Value)>>,
    }

    impl Sink for Recorder {
        fn emit(&self, event: &str, payload: serde_json::Value) {
            self.events
                .lock()
                .expect("recorder lock")
                .push((event.to_string(), payload));
        }
    }
}
