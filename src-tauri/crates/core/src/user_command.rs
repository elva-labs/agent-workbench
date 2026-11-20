//! A command the user typed with a leading `!` in a session's composer.
//!
//! For an agent that runs no command of the user's itself, the core runs
//! it: with the user's shell, in the session's folder and with the agent's
//! own environment, in a process group of its own so a stop reaches all of
//! it. What it prints streams to the window as it comes; what goes to the
//! agent is each stream cut to [`AGENT_KEEP`], its head and its tail. For an
//! agent that runs it itself, the core only finds its process group, so a
//! stop reaches what the agent's own interrupt leaves running.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::time::Duration;

/// The most of each stream of a command's output the agent is given, in
/// bytes: its head and its tail, with a line between them saying how many
/// lines were left out.
pub(crate) const AGENT_KEEP: usize = 30_000;

/// How a session runs a command of the user's: the shell, where, and with
/// what environment.
#[derive(Debug, Clone)]
pub(crate) struct Shell {
    program: String,
    folder: PathBuf,
    env: Vec<(OsString, Option<OsString>)>,
}

impl Shell {
    /// The shell for a session whose agent `agent` starts: in its folder,
    /// with its environment, the shell the captured environment names.
    pub(crate) fn of(
        agent: &std::process::Command,
        project: &std::path::Path,
        vars: &HashMap<String, String>,
    ) -> Self {
        Self {
            program: crate::shell::program(vars),
            folder: agent
                .get_current_dir()
                .map_or_else(|| project.to_path_buf(), PathBuf::from),
            env: agent
                .get_envs()
                .map(|(key, value)| (key.to_os_string(), value.map(OsString::from)))
                .collect(),
        }
    }

    /// Starts `text`, its output piped and nothing to read from, leading a
    /// process group of its own.
    pub(crate) fn spawn(&self, text: &str) -> std::io::Result<Child> {
        let mut command = std::process::Command::new(&self.program);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.args(["-c", text]).process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            command
                .arg("/C")
                .raw_arg(text)
                .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        }
        command.current_dir(&self.folder).env_clear();
        for (key, value) in &self.env {
            match value {
                Some(value) => command.env(key, value),
                None => command.env_remove(key),
            };
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    }
}

/// Ends the process group `group` leads: asked to end, and killed if any of
/// it is still there after `grace`. Waits as long.
pub(crate) fn end_group(group: u32, grace: Duration) {
    #[cfg(unix)]
    if let Ok(group) = i32::try_from(group) {
        // The group lives as long as one of its members does, so its id is
        // not given to another process until it is empty.
        let left = || unsafe { libc::killpg(group, 0) } == 0;
        unsafe {
            libc::killpg(group, libc::SIGTERM);
        }
        let deadline = std::time::Instant::now() + grace;
        while left() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        if left() {
            unsafe {
                libc::killpg(group, libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = grace;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &group.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
}

/// The process group of the shell an agent with process `agent` runs
/// `text` in, started at `since` seconds since the epoch or later: its
/// direct child whose last argument is the command and that leads a group
/// of its own, the newest where the agent runs more than one such.
pub(crate) fn group_of(agent: u32, text: &str, since: u64) -> Option<u32> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::OnlyIfNotSet),
    );
    system
        .processes()
        .iter()
        .filter(|(_, process)| process.parent().map(|parent| parent.as_u32()) == Some(agent))
        .filter(|(_, process)| process.cmd().last().is_some_and(|last| last == text))
        // Start times are whole seconds, read at a different moment.
        .filter(|(_, process)| process.start_time() + 1 >= since)
        .filter(|(pid, _)| leads_group(pid.as_u32()))
        .max_by_key(|(_, process)| process.start_time())
        .map(|(pid, _)| pid.as_u32())
}

#[cfg(unix)]
fn leads_group(pid: u32) -> bool {
    i32::try_from(pid).is_ok_and(|pid| unsafe { libc::getpgid(pid) } == pid)
}

#[cfg(not(unix))]
fn leads_group(_pid: u32) -> bool {
    true
}

/// Turns the bytes of a stream into text as they come, holding back the
/// start of a character split between two reads. Bytes that are no UTF-8
/// read as the replacement character.
#[derive(Debug, Default)]
pub(crate) struct Decoder {
    rest: Vec<u8>,
}

impl Decoder {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> String {
        self.rest.extend_from_slice(bytes);
        let mut text = String::new();
        let mut at = 0;
        loop {
            match std::str::from_utf8(&self.rest[at..]) {
                Ok(valid) => {
                    text.push_str(valid);
                    at = self.rest.len();
                    break;
                }
                Err(error) => {
                    let valid = at + error.valid_up_to();
                    text.push_str(
                        std::str::from_utf8(&self.rest[at..valid]).expect("valid up to here"),
                    );
                    match error.error_len() {
                        Some(bad) => {
                            text.push(char::REPLACEMENT_CHARACTER);
                            at = valid + bad;
                        }
                        None => {
                            at = valid;
                            break;
                        }
                    }
                }
            }
        }
        self.rest.drain(..at);
        text
    }

    /// What is held back when the stream ends.
    pub(crate) fn finish(&mut self) -> String {
        let text = String::from_utf8_lossy(&self.rest).into_owned();
        self.rest.clear();
        text
    }
}

/// One stream of a command's output as the agent is given it: up to
/// [`AGENT_KEEP`] bytes whole, and past that its head and its tail, with a
/// line between them saying how many lines were left out.
#[derive(Debug, Default)]
pub(crate) struct ForAgent {
    head: String,
    tail: String,
    /// Lines left out of the middle so far.
    left_out: usize,
    cut: bool,
}

impl ForAgent {
    const HALF: usize = AGENT_KEEP / 2;

    pub(crate) fn push(&mut self, mut piece: &str) {
        if !self.cut && self.tail.is_empty() && self.head.len() < Self::HALF {
            let room = floor(piece, Self::HALF - self.head.len());
            self.head.push_str(&piece[..room]);
            piece = &piece[room..];
        }
        self.tail.push_str(piece);
        if self.tail.len() > 2 * AGENT_KEEP {
            self.trim();
        }
    }

    /// Leaves out the front of the tail past half of what is kept.
    fn trim(&mut self) {
        let over = self.tail.len().saturating_sub(Self::HALF);
        let over = ceil(&self.tail, over);
        if over == 0 {
            return;
        }
        self.left_out += self.tail[..over].matches('\n').count();
        self.tail.drain(..over);
        self.cut = true;
    }

    pub(crate) fn finish(mut self) -> String {
        if !self.cut && self.head.len() + self.tail.len() <= AGENT_KEEP {
            return self.head + &self.tail;
        }
        self.trim();
        format!(
            "{}\n\n... [{} lines truncated] ...\n\n{}",
            self.head, self.left_out, self.tail
        )
    }
}

/// The largest char boundary of `text` at or below `at`.
fn floor(text: &str, at: usize) -> usize {
    let mut at = at.min(text.len());
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// The smallest char boundary of `text` at or above `at`.
fn ceil(text: &str, at: usize) -> usize {
    let mut at = at.min(text.len());
    while !text.is_char_boundary(at) {
        at += 1;
    }
    at
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_character_split_between_reads_waits_for_its_end() {
        let mut decoder = Decoder::default();
        let bytes = "aé€b".as_bytes();
        assert_eq!(decoder.push(&bytes[..2]), "a");
        assert_eq!(decoder.push(&bytes[2..4]), "é");
        assert_eq!(decoder.push(&bytes[4..]), "€b");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn bytes_that_are_no_utf8_read_as_the_replacement_character() {
        let mut decoder = Decoder::default();
        assert_eq!(decoder.push(b"a\xffb"), "a\u{fffd}b");
        assert_eq!(decoder.push(b"\xe2\x82"), "");
        assert_eq!(decoder.finish(), "\u{fffd}");
    }

    #[test]
    fn output_within_the_limit_goes_to_the_agent_whole() {
        let mut kept = ForAgent::default();
        let line = "x".repeat(99) + "\n";
        for _ in 0..300 {
            kept.push(&line);
        }
        assert_eq!(kept.finish(), line.repeat(300));
    }

    #[test]
    fn longer_output_keeps_its_head_and_tail_and_counts_the_lines_between() {
        let mut kept = ForAgent::default();
        for n in 0..10_000 {
            kept.push(&format!("{n:09}\n"));
        }
        let given = kept.finish();
        assert!(given.starts_with("000000000\n000000001\n"));
        assert!(given.ends_with("000009998\n000009999\n"));
        // Each line is ten bytes: half of the limit holds 1,500 of them at
        // each end.
        assert!(given.contains("\n\n... [7000 lines truncated] ...\n\n"));
        assert!(given.len() < AGENT_KEEP + 100);
    }

    #[test]
    fn the_cut_never_splits_a_character() {
        let mut kept = ForAgent::default();
        for _ in 0..40_000 {
            kept.push("é");
        }
        let given = kept.finish();
        assert!(given.contains("... [0 lines truncated] ..."));
        assert!(given.len() <= AGENT_KEEP + 64);
    }

    #[cfg(unix)]
    #[test]
    fn a_command_runs_in_the_folder_with_the_environment_given() {
        let folder = std::env::temp_dir();
        let mut agent = std::process::Command::new("true");
        agent
            .current_dir(&folder)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("BANG_SPIKE", "here");
        let vars = HashMap::from([("SHELL".to_string(), "/bin/sh".to_string())]);
        let shell = Shell::of(&agent, &folder, &vars);
        let output = shell
            .spawn("pwd -P; echo \"$BANG_SPIKE\"; echo \"${HOME:-none}\"")
            .expect("spawn")
            .wait_with_output()
            .expect("wait");
        let printed = String::from_utf8_lossy(&output.stdout);
        let lines: Vec<&str> = printed.lines().collect();
        assert_eq!(
            PathBuf::from(lines[0]),
            folder.canonicalize().expect("canonical")
        );
        assert_eq!(lines[1..], ["here", "none"]);
    }
}
