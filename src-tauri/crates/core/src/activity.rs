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

use crate::events::Sink;

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
    /// finished its turn. `delegated`: it ended its turn with subagents of
    /// its own still running, whose report starts the next one. `failed`:
    /// an error from the model's service ended the turn, a usage limit
    /// among them, and the agent did not finish it. `permission`: it is
    /// asking. `idle`: it has been waiting a while and said so.
    pub kind: String,
    /// With a stop, the first line of what the agent last said, for the
    /// row: how the turn ended, in the agent's own words, when the agent
    /// left no line of its own. With a failed turn, the first line of the
    /// error as the agent showed it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// With a stop, that the user cut the turn short rather than the agent
    /// ending it, where the agent says so.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cut: bool,
    /// With a failed turn, the agent's word for the error: `rate_limit`,
    /// `server_error` and the like.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// With a stop, the tasks the agent left running in the background
    /// that are not subagents, by its own description of each: commands,
    /// and calls of its tools it put in the background. When one finishes
    /// the agent takes it up in a turn of its own.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub background: Vec<String>,
}

/// The most background tasks a stop names.
const BACKGROUND_MOST: usize = 3;

/// One line of the log, as an event, if it is one the rows care about.
pub fn classify(line: &str) -> Option<SessionEvent> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let session_id = value.get("session_id")?.as_str()?.to_string();
    let event = value.get("hook_event_name")?.as_str()?;
    let kind = match event {
        "UserPromptSubmit" => "prompt",
        "Stop" if subagents_running(&value) => "delegated",
        "Stop" => "stop",
        "StopFailure" => "failed",
        "PermissionRequest" => "permission",
        "Notification" => match value.get("notification_type").and_then(|v| v.as_str()) {
            Some("permission_prompt") => "permission",
            Some("idle_prompt") => "idle",
            _ => return None,
        },
        _ => return None,
    };
    let note = if matches!(kind, "stop" | "delegated" | "failed") {
        value
            .get("last_assistant_message")
            .and_then(|v| v.as_str())
            .and_then(first_line)
    } else {
        None
    };
    let error = if kind == "failed" {
        value
            .get("error")
            .and_then(|v| v.as_str())
            .map(|word| {
                word.chars()
                    .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .take(40)
                    .collect::<String>()
            })
            .filter(|word| !word.is_empty())
            .or_else(|| Some("unknown".to_string()))
    } else {
        None
    };
    let background = if kind == "stop" {
        work_running(&value)
    } else {
        Vec::new()
    };
    Some(SessionEvent {
        session_id,
        kind: kind.to_string(),
        note,
        cut: false,
        error,
        background,
    })
}

/// The background tasks a stop lists as running that are not subagents,
/// each by its description, or its command where it has none.
fn work_running(value: &serde_json::Value) -> Vec<String> {
    value
        .get("background_tasks")
        .and_then(|tasks| tasks.as_array())
        .map(|tasks| {
            tasks
                .iter()
                .filter(|task| {
                    task.get("type").and_then(|v| v.as_str()) != Some("subagent")
                        && task
                            .get("status")
                            .and_then(|v| v.as_str())
                            .is_none_or(|status| status == "running")
                })
                .filter_map(|task| {
                    let said = |key: &str| {
                        task.get(key)
                            .and_then(|v| v.as_str())
                            .map(crate::show::one_line)
                            .filter(|line| !line.is_empty())
                    };
                    said("description").or_else(|| said("command"))
                })
                .take(BACKGROUND_MOST)
                .collect()
        })
        .unwrap_or_default()
}

/// Whether a stop lists a subagent still running among the session's
/// background tasks. Claude Code runs subagents in the background by
/// default: the agent ends its turn to wait, and the report comes back as a
/// prompt. A shell task is not that: the agent may well have stopped for
/// the user with a server left running.
fn subagents_running(value: &serde_json::Value) -> bool {
    value
        .get("background_tasks")
        .and_then(|tasks| tasks.as_array())
        .is_some_and(|tasks| {
            tasks.iter().any(|task| {
                task.get("type").and_then(|v| v.as_str()) == Some("subagent")
                    && task
                        .get("status")
                        .and_then(|v| v.as_str())
                        .is_none_or(|status| status == "running")
            })
        })
}

/// The first line of a message with something to say, as plain words: a
/// heading's marks, a list's bullet, a quote's bar and emphasis are taken
/// off, a code fence is skipped, and the line is cut to what a row holds.
pub fn first_line(message: &str) -> Option<String> {
    let mut in_fence = false;
    for line in message.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let bare = trimmed
            .trim_start_matches(['#', '>', '-', '*', ' '])
            .trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ')')
            .trim_start();
        let words = bare.replace("**", "").replace("__", "").replace('`', "");
        let line = crate::show::one_line(&words);
        if !line.is_empty() {
            return Some(line);
        }
    }
    None
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

/// What a line of a log means to the window: an event and its payload, or
/// nothing for a line the log's reader does not care about.
pub type Classify = dyn Fn(&str) -> Option<(String, serde_json::Value)> + Send + Sync;

pub struct Tail {
    path: PathBuf,
    offset: Mutex<u64>,
    rotate_at: u64,
    classify: Box<Classify>,
}

impl Tail {
    /// Starts at the end: what happened before the window opened is not
    /// news, and the window has no rows for it.
    pub fn new(path: PathBuf) -> Self {
        Self::reading(path, ROTATE_AT, |line| {
            classify(line).and_then(|event| {
                serde_json::to_value(event)
                    .ok()
                    .map(|value| (SESSION_EVENT.to_string(), value))
            })
        })
    }

    pub fn reading(
        path: PathBuf,
        rotate_at: u64,
        classify: impl Fn(&str) -> Option<(String, serde_json::Value)> + Send + Sync + 'static,
    ) -> Self {
        let end = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Self {
            path,
            offset: Mutex::new(end),
            rotate_at,
            classify: Box::new(classify),
        }
    }

    /// Reads what is new and says it. Rotates a log nothing is waiting on.
    pub fn drain(&self, sink: &Arc<dyn Sink>) {
        let mut offset = self.offset.lock().expect("tail lock");
        let (lines, end) = read_new(&self.path, *offset);
        *offset = end;
        for line in lines {
            if let Some((event, payload)) = (self.classify)(&line) {
                sink.emit(&event, payload);
            }
        }
        if end > self.rotate_at && std::fs::write(&self.path, "").is_ok() {
            *offset = 0;
        }
    }
}

/// Watches the session log for the life of the app.
pub fn watch(sink: Arc<dyn Sink>, path: PathBuf) -> Result<(), String> {
    watch_log(sink, path, ROTATE_AT, |line| {
        classify(line).and_then(|event| {
            serde_json::to_value(event)
                .ok()
                .map(|value| (SESSION_EVENT.to_string(), value))
        })
    })
}

/// Watches a log for the life of the app, reading each new line with
/// `classify`. The file is created first, so there is something to watch
/// before anything has written to it.
pub fn watch_log(
    sink: Arc<dyn Sink>,
    path: PathBuf,
    rotate_at: u64,
    classify: impl Fn(&str) -> Option<(String, serde_json::Value)> + Send + Sync + 'static,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create {parent:?}: {e}"))?;
    }
    if !path.exists() {
        std::fs::write(&path, "").map_err(|e| format!("could not create {path:?}: {e}"))?;
    }
    let tail = Arc::new(Tail::reading(path.clone(), rotate_at, classify));
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
            tail.drain(&sink);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratch::Scratch;

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
            classify(r#"{"session_id":"s1","hook_event_name":"Stop","last_assistant_message":"\n## Done\n\nAll **green**."}"#).unwrap().note.as_deref(),
            Some("Done")
        );
        let delegated = classify(
            r#"{"session_id":"s1","hook_event_name":"Stop","last_assistant_message":"Reviewing in the background.","background_tasks":[{"id":"a1","type":"subagent","status":"running","description":"Review","agent_type":"general-purpose"}]}"#,
        )
        .unwrap();
        assert_eq!(delegated.kind, "delegated");
        assert_eq!(
            delegated.note.as_deref(),
            Some("Reviewing in the background.")
        );
        assert_eq!(
            event(
                r#"{"session_id":"s1","hook_event_name":"Stop","background_tasks":[{"id":"b1","type":"shell","status":"running","description":"dev server","command":"npm run dev"}]}"#
            ),
            Some(("s1".into(), "stop".into()))
        );
        assert_eq!(
            event(
                r#"{"session_id":"s1","hook_event_name":"Stop","background_tasks":[{"id":"a1","type":"subagent","status":"completed"}]}"#
            ),
            Some(("s1".into(), "stop".into()))
        );
        assert_eq!(
            classify(r#"{"session_id":"s1","hook_event_name":"UserPromptSubmit","last_assistant_message":"x"}"#).unwrap().note,
            None
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

    /// Recorded from an idle Claude Code session with every hook of the
    /// kind installed: a turn, then a recap and a compaction it did while
    /// idle. Each ends a subagent of its own and the compaction starts the
    /// session again, none of which is a transition, and each is followed a
    /// minute later by the same idle notice as the turn.
    #[test]
    fn an_idle_session_s_housekeeping_says_only_that_it_is_idle() {
        let lines = [
            r#"{"session_id":"s1","hook_event_name":"SessionStart","source":"startup"}"#,
            r#"{"session_id":"s1","hook_event_name":"UserPromptSubmit","prompt":"Reply with the single word ok."}"#,
            r#"{"session_id":"s1","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"ok","background_tasks":[],"session_crons":[]}"#,
            r#"{"session_id":"s1","hook_event_name":"Notification","message":"Claude is waiting for your input","notification_type":"idle_prompt"}"#,
            r#"{"session_id":"s1","agent_id":"a1","agent_type":"","hook_event_name":"SubagentStop","stop_hook_active":false,"last_assistant_message":"The overall goal so far is a quick check-in.","background_tasks":[],"session_crons":[]}"#,
            r#"{"session_id":"s1","hook_event_name":"Notification","message":"Claude is waiting for your input","notification_type":"idle_prompt"}"#,
            r#"{"session_id":"s1","hook_event_name":"PreCompact","trigger":"manual","custom_instructions":null}"#,
            r#"{"session_id":"s1","agent_id":"a2","agent_type":"","hook_event_name":"SubagentStop","stop_hook_active":false,"last_assistant_message":"<summary>Nothing is in progress.</summary>","background_tasks":[],"session_crons":[]}"#,
            r#"{"session_id":"s1","hook_event_name":"SessionStart","source":"compact"}"#,
            r#"{"session_id":"s1","hook_event_name":"Notification","message":"Claude is waiting for your input","notification_type":"idle_prompt"}"#,
        ];
        let heard: Vec<String> = lines
            .iter()
            .filter_map(|line| classify(line))
            .map(|event| event.kind)
            .collect();
        assert_eq!(heard, ["prompt", "stop", "idle", "idle", "idle"]);
    }

    /// Recorded from an idle Claude Code session: a command the agent ran in
    /// the background ends, and the agent starts a turn by itself to say
    /// so. Its hooks fire as they do for any turn, the task's notice
    /// standing for the prompt.
    #[test]
    fn a_turn_the_agent_starts_by_itself_is_heard_as_a_turn() {
        let lines = [
            r#"{"session_id":"s1","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"started","background_tasks":[{"id":"b1","type":"shell","status":"running","description":"Sleep for 15 seconds in background","command":"sleep 15"}],"session_crons":[]}"#,
            r#"{"session_id":"s1","hook_event_name":"UserPromptSubmit","permission_mode":"default","prompt":"<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>t1</tool-use-id>\n<output-file>/tmp/s1/tasks/b1.output</output-file>\n<status>completed</status>\n<summary>Background command \"Sleep for 15 seconds in background\" completed (exit code 0)</summary>\n</task-notification>"}"#,
            r#"{"session_id":"s1","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"The background `sleep 15` finished with exit code 0. No further action is needed.","background_tasks":[],"session_crons":[]}"#,
        ];
        let heard: Vec<(String, Option<String>)> = lines
            .iter()
            .filter_map(|line| classify(line))
            .map(|event| (event.kind, event.note))
            .collect();
        assert_eq!(
            heard,
            [
                ("stop".to_string(), Some("started".to_string())),
                ("prompt".to_string(), None),
                (
                    "stop".to_string(),
                    Some(
                        "The background sleep 15 finished with exit code 0. No further action is needed."
                            .to_string()
                    )
                ),
            ]
        );
    }

    /// Shaped as Claude Code sends them: a turn that a usage limit ended,
    /// and one a dropped connection ended, each in place of a stop.
    #[test]
    fn a_turn_an_error_ended_is_heard_as_failed_with_what_it_said() {
        let limit = classify(
            r#"{"session_id":"s1","transcript_path":"/t/s1.jsonl","cwd":"/p","hook_event_name":"StopFailure","error":"rate_limit","error_details":"429","last_assistant_message":"You've hit your 5-hour limit · resets 4pm (Europe/Stockholm)"}"#,
        )
        .unwrap();
        assert_eq!(limit.kind, "failed");
        assert_eq!(limit.error.as_deref(), Some("rate_limit"));
        assert_eq!(
            limit.note.as_deref(),
            Some("You've hit your 5-hour limit · resets 4pm (Europe/Stockholm)")
        );
        let lost = classify(
            r#"{"session_id":"s1","hook_event_name":"StopFailure","error":"server_error","last_assistant_message":"API Error: Connection lost mid-response. The response above may be incomplete."}"#,
        )
        .unwrap();
        assert_eq!(lost.error.as_deref(), Some("server_error"));
        assert_eq!(
            lost.note.as_deref(),
            Some("API Error: Connection lost mid-response. The response above may be incomplete.")
        );
        // An error word of another shape is kept to its letters, and one
        // missing is unknown.
        let odd = classify(
            r#"{"session_id":"s1","hook_event_name":"StopFailure","error":"bad\nword <x>"}"#,
        )
        .unwrap();
        assert_eq!(odd.error.as_deref(), Some("badwordx"));
        assert_eq!(odd.note, None);
        let bare = classify(r#"{"session_id":"s1","hook_event_name":"StopFailure"}"#).unwrap();
        assert_eq!(bare.error.as_deref(), Some("unknown"));
        // A stop names no error.
        let stop = classify(r#"{"session_id":"s1","hook_event_name":"Stop"}"#).unwrap();
        assert_eq!(stop.error, None);
        assert!(serde_json::to_value(&stop).unwrap().get("error").is_none());
    }

    #[test]
    fn a_stop_names_the_work_it_left_running_and_no_subagent() {
        let stop = classify(
            r#"{"session_id":"s1","hook_event_name":"Stop","last_assistant_message":"Waiting for the unit suite to finish.","background_tasks":[{"id":"b1","type":"shell","status":"running","description":"Run the  unit\nsuite","command":"npm run test:unit"},{"id":"b2","type":"shell","status":"completed","description":"Build"},{"id":"b3","type":"shell","status":"running","command":"npm run dev"},{"id":"a1","type":"subagent","status":"completed","description":"Review"}]}"#,
        )
        .unwrap();
        assert_eq!(stop.kind, "stop");
        assert_eq!(stop.background, ["Run the unit suite", "npm run dev"]);
        let sent = serde_json::to_value(&stop).unwrap();
        assert_eq!(sent["background"][1], "npm run dev");
        // A call of the agent's tools it put in the background is work of
        // its own as well, as a wait on the sessions it started is.
        let waiting = classify(
            r#"{"session_id":"s1","hook_event_name":"Stop","background_tasks":[{"id":"k1","type":"MCP task","status":"running","description":"agent-workbench/wait","server":"agent-workbench","tool":"wait"}]}"#,
        )
        .unwrap();
        assert_eq!(waiting.background, ["agent-workbench/wait"]);
        // Nothing left running says nothing.
        let done = classify(
            r#"{"session_id":"s1","hook_event_name":"Stop","background_tasks":[{"id":"b1","type":"shell","status":"completed","description":"Build"}]}"#,
        )
        .unwrap();
        assert!(done.background.is_empty());
        assert!(serde_json::to_value(&done)
            .unwrap()
            .get("background")
            .is_none());
        // Many are named up to a few.
        let tasks: Vec<String> = (0..6)
            .map(|n| {
                format!(
                    r#"{{"id":"b{n}","type":"shell","status":"running","description":"task {n}"}}"#
                )
            })
            .collect();
        let many = classify(&format!(
            r#"{{"session_id":"s1","hook_event_name":"Stop","background_tasks":[{}]}}"#,
            tasks.join(",")
        ))
        .unwrap();
        assert_eq!(many.background.len(), BACKGROUND_MOST);
    }

    #[test]
    fn a_stop_says_it_was_cut_short_only_when_it_was() {
        let stop = classify(r#"{"session_id":"s1","hook_event_name":"Stop"}"#).unwrap();
        assert!(!stop.cut);
        let sent = serde_json::to_value(&stop).unwrap();
        assert!(sent.get("cut").is_none(), "{sent}");
        let cut = SessionEvent { cut: true, ..stop };
        assert_eq!(serde_json::to_value(&cut).unwrap()["cut"], true);
    }

    #[test]
    fn takes_the_first_line_that_says_something_as_plain_words() {
        assert_eq!(first_line("").as_deref(), None);
        assert_eq!(first_line("\n\n  \n").as_deref(), None);
        assert_eq!(
            first_line("- **Tests green**, ready to `merge`.\nMore.").as_deref(),
            Some("Tests green, ready to merge.")
        );
        assert_eq!(first_line("1. First step").as_deref(), Some("First step"));
        assert_eq!(first_line("> quoted\nplain").as_deref(), Some("quoted"));
        assert_eq!(
            first_line("```\ncode\n```\nAfter the fence").as_deref(),
            Some("After the fence")
        );
        assert_eq!(first_line("```\nnever closed").as_deref(), None);
        assert_eq!(
            first_line(&"word ".repeat(60)).unwrap().chars().count(),
            120
        );
    }

    #[test]
    fn reads_only_what_is_new_and_only_whole_lines() {
        let dir = Scratch::new("activity-tail");
        let path = dir.join("tail.jsonl");
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
