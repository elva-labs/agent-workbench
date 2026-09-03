//! PTY sessions: spawning them, carrying their output, and ending them.
//!
//! Output goes to the frontend on a Tauri `Channel`, one per session. Channels
//! are built for ordered, high-throughput delivery and are what Tauri itself
//! uses for child process output; the event system is explicitly not for low
//! latency or high throughput, so it carries lifecycle only.
//!
//! Bytes go over the channel raw rather than as a string. A read can land in
//! the middle of a UTF-8 sequence, and xterm.js has a decoder that handles
//! exactly that. Decoding here would mean writing a second one.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};

/// 64 KiB: comfortably more than a full-screen redraw, so a busy TUI is read
/// in a handful of syscalls rather than hundreds.
const READ_BUFFER: usize = 64 * 1024;

pub const SESSION_ENDED: &str = "session_ended";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEnded {
    pub id: String,
    /// None when the process was killed by a signal.
    pub code: Option<i32>,
    /// A clean exit is code 0. Anything else is a crash as far as the pane is
    /// concerned, and it says so rather than quietly clearing itself.
    pub clean: bool,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct Sessions {
    inner: Mutex<HashMap<String, Session>>,
}

impl Sessions {
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.lock().expect("sessions lock").len()
    }
}

fn next_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("pty-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

pub fn spawn(
    app: AppHandle,
    sessions: Arc<Sessions>,
    command: CommandBuilder,
    size: PtySize,
    output: Channel,
) -> Result<String, String> {
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("could not open a pty: {e}"))?;

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("could not start the process: {e}"))?;

    // The slave is the child's end. Holding it open here would keep the pty
    // alive after the agent exits, and the reader below would never see EOF.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("could not read from the pty: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("could not write to the pty: {e}"))?;
    let killer = child.clone_killer();

    let id = next_id();

    sessions.inner.lock().expect("sessions lock").insert(
        id.clone(),
        Session {
            master: pair.master,
            writer,
            killer,
        },
    );

    std::thread::spawn({
        let mut reader = reader;
        move || {
            let mut buffer = vec![0u8; READ_BUFFER];
            loop {
                match reader.read(&mut buffer) {
                    // EOF: the agent closed its end.
                    Ok(0) => break,
                    Ok(n) => {
                        if output
                            .send(InvokeResponseBody::Raw(buffer[..n].to_vec()))
                            .is_err()
                        {
                            // The webview is gone. Nothing left to deliver to.
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    });

    std::thread::spawn({
        let id = id.clone();
        let sessions = Arc::clone(&sessions);
        move || {
            let status = child.wait();
            sessions.inner.lock().expect("sessions lock").remove(&id);

            let (code, clean) = match status {
                Ok(status) => {
                    let code = status.exit_code();
                    (Some(code as i32), code == 0)
                }
                Err(_) => (None, false),
            };

            let _ = app.emit(SESSION_ENDED, SessionEnded { id, code, clean });
        }
    });

    Ok(id)
}

pub fn write(sessions: &Sessions, id: &str, data: &[u8]) -> Result<(), String> {
    let mut guard = sessions.inner.lock().expect("sessions lock");
    let session = guard.get_mut(id).ok_or("no such session")?;
    session
        .writer
        .write_all(data)
        .map_err(|e| format!("could not write to the agent: {e}"))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("could not flush to the agent: {e}"))
}

pub fn resize(sessions: &Sessions, id: &str, size: PtySize) -> Result<(), String> {
    let guard = sessions.inner.lock().expect("sessions lock");
    let session = guard.get(id).ok_or("no such session")?;
    session
        .master
        .resize(size)
        .map_err(|e| format!("could not resize the agent: {e}"))
}

pub fn kill(sessions: &Sessions, id: &str) -> Result<(), String> {
    let mut guard = sessions.inner.lock().expect("sessions lock");
    let session = guard.get_mut(id).ok_or("no such session")?;
    session
        .killer
        .kill()
        .map_err(|e| format!("could not stop the agent: {e}"))
    // The entry is removed by the waiter thread once the process actually goes,
    // so a kill and a natural exit take the same path out.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique() {
        let a = next_id();
        let b = next_id();
        assert_ne!(a, b);
        assert!(a.starts_with("pty-"));
    }

    #[test]
    fn a_fresh_registry_is_empty() {
        assert_eq!(Sessions::default().len(), 0);
    }

    #[test]
    fn writing_to_an_unknown_session_is_an_error_not_a_panic() {
        let sessions = Sessions::default();
        assert!(write(&sessions, "pty-nope", b"hello").is_err());
    }

    #[test]
    fn resizing_an_unknown_session_is_an_error_not_a_panic() {
        let sessions = Sessions::default();
        let size = PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        };
        assert!(resize(&sessions, "pty-nope", size).is_err());
    }

    #[test]
    fn killing_an_unknown_session_is_an_error_not_a_panic() {
        let sessions = Sessions::default();
        assert!(kill(&sessions, "pty-nope").is_err());
    }

    #[test]
    fn a_clean_exit_is_code_zero() {
        let ended = SessionEnded {
            id: "pty-1".into(),
            code: Some(0),
            clean: true,
        };
        let json = serde_json::to_value(&ended).unwrap();
        assert_eq!(json["clean"], true);
        assert_eq!(json["code"], 0);
    }
}
