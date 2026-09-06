//! The near end of the wire: a core somewhere else, as an object here.
//!
//! A [`Connection`] owns the process that carries the conversation, ssh or
//! anything else that joins two stdios, and turns its lines back into
//! answers and events. Calls block until their answer comes, which is how
//! the desktop app's blocking pool likes them. Events go to one callback,
//! and a pty's bytes to the [`Output`] attached for that pty; bytes that
//! arrive before anyone has attached wait for them.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::events::Output;
use crate::protocol::{output_bytes, Message, Request};

/// How long an answer may take. Long, because a remote `git status` on a
/// cold disk is slow and a wrong guess here turns into a spurious error.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// The tail of the process's stderr kept for error messages: what ssh said
/// is the whole explanation when a connection fails.
const STDERR_KEEP: usize = 4096;

pub type OnEvent = Box<dyn Fn(&str, Value) + Send + Sync>;

pub struct Connection {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    next: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    outputs: Mutex<Outputs>,
    alive: AtomicBool,
    stderr: Arc<Mutex<String>>,
}

#[derive(Default)]
struct Outputs {
    attached: HashMap<String, Output>,
    /// Bytes for a pty nobody has attached to yet: the answer naming the
    /// pty and its first output race, and the bytes must not lose.
    early: HashMap<String, Vec<u8>>,
}

impl Outputs {
    fn deliver(&mut self, id: &str, bytes: &[u8]) {
        match self.attached.get_mut(id) {
            Some(output) => {
                if !output(bytes) {
                    self.attached.remove(id);
                }
            }
            None => self.early.entry(id.to_string()).or_default().extend(bytes),
        }
    }

    fn attach(&mut self, id: &str, mut output: Output) {
        if let Some(early) = self.early.remove(id) {
            if !output(&early) {
                return;
            }
        }
        self.attached.insert(id.to_string(), output);
    }

    fn detach(&mut self, id: &str) {
        self.attached.remove(id);
        self.early.remove(id);
    }
}

impl Connection {
    /// Starts the process and the threads that read it. `on_event` gets
    /// every event but a pty's bytes; those go to the attached output.
    pub fn open(command: &mut Command, on_event: OnEvent) -> Result<Arc<Self>, String> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not start the connection: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;

        let connection = Arc::new(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            next: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            outputs: Mutex::new(Outputs::default()),
            alive: AtomicBool::new(true),
            stderr: Arc::new(Mutex::new(String::new())),
        });

        std::thread::spawn({
            let kept = Arc::clone(&connection.stderr);
            move || keep_tail(stderr, kept)
        });
        std::thread::spawn({
            let connection = Arc::clone(&connection);
            move || connection.read(stdout, on_event)
        });
        Ok(connection)
    }

    fn read(&self, stdout: impl Read, on_event: OnEvent) {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(message) = serde_json::from_str::<Message>(&line) else {
                continue;
            };
            match message {
                Message::Response { id, result, error } => {
                    let sender = self.pending.lock().expect("pending lock").remove(&id);
                    if let Some(sender) = sender {
                        let _ = sender.send(match error {
                            Some(error) => Err(error),
                            None => Ok(result.unwrap_or(Value::Null)),
                        });
                    }
                }
                Message::Event { event, payload } => {
                    if let Some((id, bytes)) = output_bytes(&event, &payload) {
                        self.outputs
                            .lock()
                            .expect("outputs lock")
                            .deliver(&id, &bytes);
                    } else {
                        if event == crate::pty::SESSION_ENDED {
                            if let Some(id) = payload.get("id").and_then(Value::as_str) {
                                self.outputs.lock().expect("outputs lock").detach(id);
                            }
                        }
                        on_event(&event, payload);
                    }
                }
            }
        }
        // The far end is gone: everyone waiting hears so, and so does the
        // owner.
        self.alive.store(false, Ordering::SeqCst);
        let waiting: Vec<_> = self
            .pending
            .lock()
            .expect("pending lock")
            .drain()
            .map(|(_, sender)| sender)
            .collect();
        let why = self.explain("the connection closed");
        for sender in waiting {
            let _ = sender.send(Err(why.clone()));
        }
        on_event(CLOSED, Value::String(why));
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// What the process said on stderr, appended to a reason.
    pub fn explain(&self, reason: &str) -> String {
        let said = self.stderr.lock().expect("stderr lock").trim().to_string();
        if said.is_empty() {
            reason.to_string()
        } else {
            format!("{reason}: {said}")
        }
    }

    /// Sends a request and waits for its answer.
    pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.call_within(method, params, CALL_TIMEOUT)
    }

    /// The same, with its own patience: the first exchange over a fresh
    /// connection should not take a minute to fail.
    pub fn call_within(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if !self.is_alive() {
            return Err(self.explain("not connected"));
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .expect("pending lock")
            .insert(id, sender);
        let request = Request {
            id,
            method: method.to_string(),
            params,
        };
        let line = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        {
            let mut stdin = self.stdin.lock().expect("stdin lock");
            if writeln!(stdin, "{line}")
                .and_then(|_| stdin.flush())
                .is_err()
            {
                self.pending.lock().expect("pending lock").remove(&id);
                return Err(self.explain("the connection is closed"));
            }
        }
        match receiver.recv_timeout(timeout) {
            Ok(answer) => answer,
            Err(_) => {
                self.pending.lock().expect("pending lock").remove(&id);
                Err(self.explain(&format!("no answer to {method} in time")))
            }
        }
    }

    /// Where a pty's bytes go from now on, including any that came first.
    pub fn attach_output(&self, id: &str, output: Output) {
        self.outputs
            .lock()
            .expect("outputs lock")
            .attach(id, output);
    }

    /// Ends the process, and with it every session it was running.
    pub fn close(&self) {
        self.alive.store(false, Ordering::SeqCst);
        let mut child = self.child.lock().expect("child lock");
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// The event the connection itself raises when the far end goes away. The
/// payload is the reason, with what the process said.
pub const CLOSED: &str = "connection_closed";

fn keep_tail(mut stderr: impl Read, kept: Arc<Mutex<String>>) {
    let mut buffer = [0u8; 1024];
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let mut text = kept.lock().expect("stderr lock");
                text.push_str(&String::from_utf8_lossy(&buffer[..n]));
                if text.len() > STDERR_KEEP {
                    let cut = text.len() - STDERR_KEEP;
                    let at = text
                        .char_indices()
                        .map(|(i, _)| i)
                        .find(|&i| i >= cut)
                        .unwrap_or(0);
                    text.drain(..at);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_that_come_first_wait_for_the_output() {
        let mut outputs = Outputs::default();
        outputs.deliver("pty-1", b"hel");
        outputs.deliver("pty-1", b"lo");
        let seen = Arc::new(Mutex::new(Vec::new()));
        outputs.attach("pty-1", {
            let seen = Arc::clone(&seen);
            Box::new(move |bytes| {
                seen.lock().unwrap().extend_from_slice(bytes);
                true
            })
        });
        outputs.deliver("pty-1", b"!");
        assert_eq!(seen.lock().unwrap().as_slice(), b"hello!");
    }

    #[test]
    fn an_output_that_declines_is_dropped() {
        let mut outputs = Outputs::default();
        outputs.attach("pty-1", Box::new(|_| false));
        outputs.deliver("pty-1", b"x");
        assert!(outputs.attached.is_empty());
        // From here the bytes wait again rather than vanish.
        outputs.deliver("pty-1", b"y");
        assert_eq!(outputs.early["pty-1"], b"y");
    }

    #[test]
    fn keeps_only_the_tail_of_stderr() {
        let kept = Arc::new(Mutex::new(String::new()));
        let long = "x".repeat(STDERR_KEEP + 100) + "end";
        keep_tail(long.as_bytes(), Arc::clone(&kept));
        let text = kept.lock().unwrap();
        assert!(text.len() <= STDERR_KEEP);
        assert!(text.ends_with("end"));
    }

    #[cfg(unix)]
    #[test]
    fn a_process_that_never_speaks_is_not_connected_for_long() {
        let connection = Connection::open(
            Command::new("sh").args(["-c", "echo nope >&2; exit 3"]),
            Box::new(|_, _| {}),
        )
        .unwrap();
        for _ in 0..100 {
            if !connection.is_alive() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!connection.is_alive());
        let error = connection.call("ping", Value::Null).unwrap_err();
        assert!(error.contains("nope"), "{error}");
    }
}
