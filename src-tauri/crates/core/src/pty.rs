//! PTY sessions: spawning them, carrying their output, and ending them.
//!
//! Output goes to whoever spawned the session through an [`Output`], one per
//! session: a stream, raw bytes, ordered. Lifecycle, which is to say the end
//! of a session, goes through the [`Sink`] as an event.
//!
//! Bytes go out raw rather than as a string. A read can land in the middle of
//! a UTF-8 sequence, and xterm.js has a decoder that handles exactly that.
//! Decoding here would mean writing a second one.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

use crate::events::{self, Output, Sink};

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
    /// The child's pid, for asking the OS where it is working.
    pid: Option<u32>,
}

#[derive(Default)]
pub struct Sessions {
    inner: Mutex<HashMap<String, Session>>,
}

impl Sessions {
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.inner.lock().expect("sessions lock").len()
    }
}

fn next_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("pty-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Starts a process in a pty. The output is made once the id is known, so
/// whoever carries the bytes can label them.
pub fn spawn(
    sink: Arc<dyn Sink>,
    sessions: Arc<Sessions>,
    command: CommandBuilder,
    size: PtySize,
    make_output: impl FnOnce(&str) -> Output,
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
    let pid = child.process_id();

    let id = next_id();
    let mut output = make_output(&id);
    // The reader holds this for as long as it reads, so the end of the
    // session can wait for the last of the output to have gone out first.
    let (reading, read_done) = std::sync::mpsc::channel::<()>();

    sessions.inner.lock().expect("sessions lock").insert(
        id.clone(),
        Session {
            master: pair.master,
            writer,
            killer,
            pid,
        },
    );

    std::thread::spawn({
        let mut reader = reader;
        move || {
            let _reading = reading;
            let mut buffer = vec![0u8; READ_BUFFER];
            loop {
                match reader.read(&mut buffer) {
                    // EOF: the agent closed its end.
                    Ok(0) => break,
                    Ok(n) => {
                        if !output(&buffer[..n]) {
                            // The listener is gone. Nothing left to deliver to.
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
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
            // Bounded: a grandchild that kept the pty open would otherwise
            // hold the end back for as long as it lived.
            let _ = read_done.recv_timeout(std::time::Duration::from_secs(2));
            sessions.inner.lock().expect("sessions lock").remove(&id);

            let (code, clean) = match status {
                Ok(status) => {
                    let code = status.exit_code();
                    (Some(code as i32), code == 0)
                }
                Err(_) => (None, false),
            };

            events::emit(&sink, SESSION_ENDED, &SessionEnded { id, code, clean });
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

/// The directory the process is working in, or None when the OS will not say.
/// A session that has ended is an error, like any other unknown id.
pub fn cwd(sessions: &Sessions, id: &str) -> Result<Option<String>, String> {
    let guard = sessions.inner.lock().expect("sessions lock");
    let session = guard.get(id).ok_or("no such session")?;
    Ok(session
        .pid
        .and_then(crate::cwd::of_process)
        .map(|path| path.to_string_lossy().to_string()))
}

/// The child's pid, for listing what runs under it.
pub fn pid(sessions: &Sessions, id: &str) -> Result<Option<u32>, String> {
    let guard = sessions.inner.lock().expect("sessions lock");
    let session = guard.get(id).ok_or("no such session")?;
    Ok(session.pid)
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
    fn asking_where_an_unknown_session_is_is_an_error_not_a_panic() {
        let sessions = Sessions::default();
        assert!(cwd(&sessions, "pty-nope").is_err());
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
