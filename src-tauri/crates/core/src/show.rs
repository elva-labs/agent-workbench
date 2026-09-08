//! A place in a file the agent wants the user to see.
//!
//! The agent calls the `show` tool the daemon serves it over MCP; the tool
//! appends one line to a request log under the app's home, and the core
//! tails that log the way it tails the hooks' session log: one event to the
//! window per line. The window opens the file in its viewer at the lines
//! and shows the note. The log is the agent's word, quarantined like the
//! session log: a line that does not parse is skipped.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::activity;
use crate::events::Sink;

pub const SHOW_REQUEST: &str = "show_request";

/// Only the log is truncated by this, and only once it has grown past
/// this many bytes: the window keeps nothing from it.
const ROTATE_AT: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowRequest {
    /// The file, absolute: the tool resolves what the agent said against
    /// where the agent runs.
    pub path: String,
    /// First and last line to highlight, 1-based, inclusive.
    pub from: u32,
    pub to: u32,
    /// What the agent said about the place, shown above it.
    #[serde(default)]
    pub note: Option<String>,
    /// Where the agent runs, which says which project the request is for.
    pub cwd: String,
}

pub fn requests_path(home: &Path) -> PathBuf {
    home.join(".agent-workbench").join("requests.jsonl")
}

/// One line of the log as a request, if it is one.
pub fn classify(line: &str) -> Option<ShowRequest> {
    let request: ShowRequest = serde_json::from_str(line).ok()?;
    if request.path.is_empty() || request.from == 0 {
        return None;
    }
    Some(ShowRequest {
        to: request.to.max(request.from),
        ..request
    })
}

/// Appends a request to the log for the core here to pick up.
pub fn append(home: &Path, request: &ShowRequest) -> Result<(), String> {
    let path = requests_path(home);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create {parent:?}: {e}"))?;
    }
    let line = serde_json::to_string(request).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path)
        .map_err(|e| format!("could not open {}: {e}", path.display()))?;
    writeln!(file, "{line}").map_err(|e| e.to_string())
}

/// Watches the request log for the life of the core.
pub fn watch(sink: Arc<dyn Sink>, path: PathBuf) -> Result<(), String> {
    activity::watch_log(sink, path, ROTATE_AT, |line| {
        classify(line).and_then(|request| {
            serde_json::to_value(request)
                .ok()
                .map(|value| (SHOW_REQUEST.to_string(), value))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_request_and_puts_the_range_the_right_way_round() {
        let request =
            classify(r#"{"path":"/p/variables.tf","from":12,"to":3,"note":"here","cwd":"/p"}"#)
                .unwrap();
        assert_eq!(request.from, 12);
        assert_eq!(request.to, 12);
        assert_eq!(request.note.as_deref(), Some("here"));
        assert!(classify(r#"{"path":"","from":1,"to":1,"cwd":"/p"}"#).is_none());
        assert!(classify(r#"{"path":"/p/a","from":0,"to":1,"cwd":"/p"}"#).is_none());
        assert!(classify("not json").is_none());
    }

    #[test]
    fn appends_lines_the_tail_reads_back() {
        let home = std::env::temp_dir().join("workbench-show-append");
        let _ = std::fs::remove_dir_all(&home);
        let request = ShowRequest {
            path: "/p/a.rs".into(),
            from: 3,
            to: 5,
            note: None,
            cwd: "/p".into(),
        };
        append(&home, &request).unwrap();
        append(&home, &request).unwrap();
        let text = std::fs::read_to_string(requests_path(&home)).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert_eq!(classify(text.lines().next().unwrap()).unwrap(), request);
    }
}
