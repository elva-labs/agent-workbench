//! What the session hooks say, as it lands.
//!
//! Both agents' hooks append their stdin to one log, a JSON object per line,
//! and this tails it: a watcher on the file, a remembered offset, and one
//! event to the window per line that is one of the transitions a row shows.
//! The log is the agents' format, quarantined here like the transcripts:
//! a line that does not parse is skipped, never fatal.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const SESSION_EVENT: &str = "session_event";

/// Only the log is truncated by this, and only when it has grown past this
/// many bytes with nothing behind the offset; the hooks append to it and the
/// window keeps the state, so old lines are worth nothing.
const ROTATE_AT: u64 = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub session_id: String,
    /// `prompt`: the user sent one, the agent is at work. `stop`: the agent
    /// finished its turn. `permission`: it is asking. `idle`: it has been
    /// waiting a while and said so.
    pub kind: String,
}

/// One line of the log, as an event, if it is one the rows care about.
pub fn classify(line: &str) -> Option<SessionEvent> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let session_id = value.get("session_id")?.as_str()?.to_string();
    let event = value.get("hook_event_name")?.as_str()?;
    let kind = match event {
        "UserPromptSubmit" => "prompt",
        "Stop" => "stop",
        "PermissionRequest" => "permission",
        "Notification" => match value.get("notification_type").and_then(|v| v.as_str()) {
            Some("permission_prompt") => "permission",
            Some("idle_prompt") => "idle",
            _ => return None,
        },
        _ => return None,
    };
    Some(SessionEvent {
        session_id,
        kind: kind.to_string(),
    })
}

/// The lines added since `offset`, and where the log ends now. A log that
/// shrank was rotated: read it from the start.
pub fn read_new(path: &Path, offset: u64) -> (Vec<String>, u64) {
    let Ok(mut file) = std::fs::File::open(path) else {
        return (Vec::new(), offset);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = if len < offset { 0 } else { offset };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return (Vec::new(), offset);
    }
    let mut text = String::new();
    if file.read_to_string(&mut text).is_err() {
        return (Vec::new(), offset);
    }
    // A line still being written has no newline yet: leave it for next time.
    let complete = match text.rfind('\n') {
        Some(at) => &text[..=at],
        None => "",
    };
    let lines = complete
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_string)
        .collect();
    (lines, start + complete.len() as u64)
}

pub struct Tail {
    path: PathBuf,
    offset: Mutex<u64>,
}

impl Tail {
    /// Starts at the end: what happened before the window opened is not
    /// news, and the window has no rows for it.
    pub fn new(path: PathBuf) -> Self {
        let end = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Self {
            path,
            offset: Mutex::new(end),
        }
    }

    /// Reads what is new and says it. Rotates a log nothing is waiting on.
    pub fn drain(&self, app: &AppHandle) {
        let mut offset = self.offset.lock().expect("tail lock");
        let (lines, end) = read_new(&self.path, *offset);
        *offset = end;
        for line in lines {
            if let Some(event) = classify(&line) {
                let _ = app.emit(SESSION_EVENT, event);
            }
        }
        if end > ROTATE_AT && std::fs::write(&self.path, "").is_ok() {
            *offset = 0;
        }
    }
}

/// Watches the log for the life of the app. The file is created first, so
/// there is something to watch before any hook has fired.
pub fn watch(app: AppHandle, path: PathBuf) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create {parent:?}: {e}"))?;
    }
    if !path.exists() {
        std::fs::write(&path, "").map_err(|e| format!("could not create {path:?}: {e}"))?;
    }
    let tail = Arc::new(Tail::new(path.clone()));
    let (sender, receiver) = channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = sender.send(event);
    })
    .map_err(|e| format!("could not watch the session log: {e}"))?;
    watcher
        .watch(&path, RecursiveMode::NonRecursive)
        .map_err(|e| format!("could not watch {}: {e}", path.display()))?;

    std::thread::spawn(move || {
        // The watcher lives on this thread; dropping it would end the watch.
        let _watcher = watcher;
        while receiver.recv().is_ok() {
            // Coalesce a burst: whatever arrived is read in one go.
            while receiver.try_recv().is_ok() {}
            tail.drain(&app);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_what_the_rows_show_and_nothing_else() {
        let event = |line: &str| classify(line).map(|e| (e.session_id, e.kind));
        assert_eq!(
            event(r#"{"session_id":"s1","hook_event_name":"UserPromptSubmit","prompt":"hi"}"#),
            Some(("s1".into(), "prompt".into()))
        );
        assert_eq!(
            event(r#"{"session_id":"s1","hook_event_name":"Stop","stop_hook_active":false}"#),
            Some(("s1".into(), "stop".into()))
        );
        assert_eq!(
            event(
                r#"{"session_id":"s1","hook_event_name":"Notification","notification_type":"permission_prompt"}"#
            ),
            Some(("s1".into(), "permission".into()))
        );
        assert_eq!(
            event(
                r#"{"session_id":"s1","hook_event_name":"Notification","notification_type":"idle_prompt"}"#
            ),
            Some(("s1".into(), "idle".into()))
        );
        assert_eq!(
            event(
                r#"{"session_id":"cx","hook_event_name":"PermissionRequest","tool_name":"shell"}"#
            ),
            Some(("cx".into(), "permission".into()))
        );
        assert_eq!(
            event(
                r#"{"session_id":"s1","hook_event_name":"Notification","notification_type":"auth_success"}"#
            ),
            None
        );
        assert_eq!(
            event(r#"{"session_id":"s1","hook_event_name":"PostToolUse"}"#),
            None
        );
        assert_eq!(event(r#"{"hook_event_name":"Stop"}"#), None);
        assert_eq!(event("not json"), None);
    }

    #[test]
    fn reads_only_what_is_new_and_only_whole_lines() {
        let path = std::env::temp_dir().join("workbench-activity-tail.jsonl");
        std::fs::write(&path, "{\"a\":1}\n{\"b\":2}\n").unwrap();
        let (lines, offset) = read_new(&path, 0);
        assert_eq!(lines, ["{\"a\":1}", "{\"b\":2}"]);

        std::fs::write(&path, "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n{\"half").unwrap();
        let (lines, next) = read_new(&path, offset);
        assert_eq!(lines, ["{\"c\":3}"]);
        assert_eq!(next, offset + "{\"c\":3}\n".len() as u64);

        // Rotated: shorter than the offset, so read from the start.
        std::fs::write(&path, "{\"d\":4}\n").unwrap();
        let (lines, _) = read_new(&path, next);
        assert_eq!(lines, ["{\"d\":4}"]);
    }

    #[test]
    fn a_missing_log_is_nothing_new() {
        let (lines, offset) = read_new(Path::new("/nowhere/sessions.jsonl"), 7);
        assert!(lines.is_empty());
        assert_eq!(offset, 7);
    }
}
