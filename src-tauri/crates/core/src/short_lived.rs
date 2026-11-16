//! An agent's process started to answer a question or two and ended once
//! it has.
//!
//! Some of what the workbench reads needs no session of the agent's
//! running: a Codex thread's history, an account's limits. For each read
//! the agent's binary is started on its own, in a process group of its
//! own, with its errors dropped. Its output is read a line at a time on a
//! thread of its own, and every wait on it is held to one deadline for the
//! whole read. Once it is dropped, its input is closed, which ends it, and
//! whatever is left in its group is killed a little later, Codex or Claude
//! Code too if it has not ended by then, without anyone waiting for that.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use crate::integrated::kill_tree;

/// The longest line read. A longer one is passed over without being held.
#[cfg(not(test))]
const LINE_KEEP: usize = 32 * 1024 * 1024;
#[cfg(test)]
const LINE_KEEP: usize = 64 * 1024;
/// How much of the start of a line too long to read is kept, to tell
/// which request it answers.
const HEAD_KEEP: usize = 64;
/// How long the process has to end once its input is closed, before it is
/// killed.
const END_GRACE: Duration = Duration::from_secs(2);

/// A line of the process's output: whole, or too long to read, with the id
/// of the request it answers where its start names one.
pub(crate) enum Line {
    Whole(String),
    Long(Option<i64>),
}

/// Why no line came.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Gone {
    /// The deadline passed.
    Late,
    /// The process ended, or closed its output.
    Ended,
}

/// A process started for one read, ended when it is dropped.
pub(crate) struct ShortLived {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    lines: Receiver<Line>,
    deadline: Instant,
}

impl ShortLived {
    /// Starts `command` with its input and output piped to this side and
    /// its errors dropped, in a process group of its own. Every wait on it
    /// ends by `deadline`. `answered` names the request a line too long to
    /// read answers, from the start of that line.
    pub(crate) fn start(
        mut command: Command,
        deadline: Instant,
        answered: fn(&[u8]) -> Option<i64>,
    ) -> Result<Self, String> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let (stdin, stdout) = match (child.stdin.take(), child.stdout.take()) {
            (Some(stdin), Some(stdout)) => (stdin, stdout),
            _ => {
                kill_tree(&mut child);
                let _ = child.wait();
                return Err("its input or output could not be opened".into());
            }
        };
        let (sender, lines) = mpsc::channel();
        std::thread::spawn(move || read_lines(stdout, &sender, answered));
        Ok(Self {
            child: Some(child),
            stdin: Some(stdin),
            lines,
            deadline,
        })
    }

    /// Writes one line to the process's input.
    pub(crate) fn write(&mut self, line: &str) -> Result<(), String> {
        let stdin = self.stdin.as_mut().ok_or("it has ended")?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| e.to_string())
    }

    /// The next line of the process's output, waiting for it no later than
    /// the deadline.
    pub(crate) fn next(&mut self) -> Result<Line, Gone> {
        let left = self.deadline.saturating_duration_since(Instant::now());
        match self.lines.recv_timeout(left) {
            Ok(line) => Ok(line),
            Err(RecvTimeoutError::Timeout) => Err(Gone::Late),
            Err(RecvTimeoutError::Disconnected) => Err(Gone::Ended),
        }
    }
}

impl Drop for ShortLived {
    /// Closes the process's input, which ends it, then kills whatever is
    /// left in its group, the process too once it has had a little while,
    /// without waiting here for either. The group goes before the process
    /// is reaped, so that its id is still the process's own when it is
    /// signalled.
    fn drop(&mut self) {
        self.stdin.take();
        let Some(mut child) = self.child.take() else {
            return;
        };
        std::thread::spawn(move || {
            let until = Instant::now() + END_GRACE;
            while !ended(&mut child) && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(50));
            }
            kill_tree(&mut child);
            let _ = child.wait();
        });
    }
}

/// Whether the process has ended, leaving it unreaped where the system
/// allows, so that what it started can still be reached through its group.
#[cfg(unix)]
fn ended(child: &mut Child) -> bool {
    // SAFETY: a zeroed siginfo is a valid one for waitid to fill, and
    // WNOWAIT leaves the child to be reaped by its wait.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id() as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    result != 0 || unsafe { info.si_pid() } != 0
}

#[cfg(not(unix))]
fn ended(child: &mut Child) -> bool {
    !matches!(child.try_wait(), Ok(None))
}

/// Hands each line of the output on, past a line too long to hold, which
/// is named by the request its start says it answers.
fn read_lines(stdout: impl Read, lines: &Sender<Line>, answered: fn(&[u8]) -> Option<i64>) {
    let mut reader = BufReader::new(stdout);
    let mut line: Vec<u8> = Vec::new();
    let mut head: Vec<u8> = Vec::new();
    let mut long = false;
    loop {
        let available = match reader.fill_buf() {
            Ok([]) => break,
            Ok(available) => available,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let end = available.iter().position(|&byte| byte == b'\n');
        let piece = &available[..end.unwrap_or(available.len())];
        if !long && line.len() + piece.len() > LINE_KEEP {
            long = true;
            head = line.iter().chain(piece).take(HEAD_KEEP).copied().collect();
            line = Vec::new();
        } else if !long {
            line.extend_from_slice(piece);
        }
        let used = end.map_or(available.len(), |at| at + 1);
        reader.consume(used);
        if end.is_some() {
            let sent = if long {
                lines.send(Line::Long(answered(&head)))
            } else {
                let text = String::from_utf8_lossy(&line).trim().to_string();
                if text.is_empty() {
                    Ok(())
                } else {
                    lines.send(Line::Whole(text))
                }
            };
            if sent.is_err() {
                return;
            }
            line.clear();
            long = false;
        }
    }
}
