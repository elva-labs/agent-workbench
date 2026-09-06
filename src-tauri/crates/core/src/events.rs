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
    use std::sync::Mutex;

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
