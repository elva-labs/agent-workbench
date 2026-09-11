//! What the agent wants the user to see: a place in a file, or media.
//!
//! The agent calls the `show` or `present` tool the daemon serves it over
//! MCP; the tool appends one line to a request log under the app's home,
//! and the core tails that log the way it tails the hooks' session log:
//! one event to the window per line. For `show` the window opens the file
//! in its viewer at the lines and shows the note; for `present` it opens
//! the images in a modal and keeps them on the session's list. A call on
//! a plugin's tool goes down the same log and is the one kind the window
//! has no part in: the core hands it to the plugin's process and leaves
//! the plugin's answer in a file named after the call, where the tool
//! server is waiting for it. The log is the agent's word, quarantined
//! like the session log: a line that does not parse is skipped.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::activity;
use crate::events::Sink;

pub const SHOW_REQUEST: &str = "show_request";
pub const PRESENT_REQUEST: &str = "present_request";
pub const DIFF_REQUEST: &str = "diff_request";
pub const TERMINAL_REQUEST: &str = "terminal_request";
pub const NOTIFY_REQUEST: &str = "notify_request";

/// The kinds the `present` tool takes, by extension: images, PDFs, and
/// Markdown, which the window renders. Video is not among them yet.
pub const MEDIA_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "pdf", "md", "markdown", "html", "htm",
    "mmd", "mermaid",
];

/// The MIME type a file is served to the window as, by extension; None
/// for a file that is not media the window shows.
pub fn media_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "md" | "markdown" => "text/markdown",
        "html" | "htm" => "text/html",
        "mmd" | "mermaid" => "text/vnd.mermaid",
        _ => return None,
    })
}

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
    /// The session the agent runs as, when its environment named one.
    #[serde(default)]
    pub session: Option<String>,
}

/// Media the agent wants the user to see, one or several files, the first
/// on screen and the rest a click away.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentRequest {
    /// The files, absolute, in the order given.
    pub files: Vec<String>,
    #[serde(default)]
    pub caption: Option<String>,
    /// Where the agent runs, which says which project, and which session
    /// when none is named.
    pub cwd: String,
    /// The session the agent runs as, when its environment named one.
    #[serde(default)]
    pub session: Option<String>,
}

/// A file whose changes the agent wants the user to see: its diff in the
/// viewer, with a note above.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRequest {
    /// The file, absolute.
    pub path: String,
    #[serde(default)]
    pub note: Option<String>,
    pub cwd: String,
    #[serde(default)]
    pub session: Option<String>,
}

/// A command the agent wants typed into a new terminal for the user to
/// run, not run by itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRequest {
    pub command: String,
    pub cwd: String,
    #[serde(default)]
    pub session: Option<String>,
}

/// A line the agent leaves on its session's row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyRequest {
    pub text: String,
    pub cwd: String,
    #[serde(default)]
    pub session: Option<String>,
}

/// A call the agent made on a plugin's tool. The core hands it to the
/// plugin's process and writes the answer where the tool server waits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRequest {
    /// What the answer file is named after, unique to this call.
    pub id: String,
    /// The source the plugin came from, and the plugin itself.
    pub source: String,
    pub plugin: String,
    /// The tool as the plugin calls it, without the plugin's name.
    pub tool: String,
    #[serde(default)]
    pub arguments: serde_json::Value,
    /// Where the agent runs, which says which project the call is for.
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub session: Option<String>,
}

/// A line of the log, whichever tool wrote it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Request {
    Show(ShowRequest),
    Present(PresentRequest),
    Diff(DiffRequest),
    Terminal(TerminalRequest),
    Notify(NotifyRequest),
    Tool(ToolRequest),
}

/// What a plugin answered a tool call with: the text for the agent, or
/// why there is none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Answer {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

pub fn requests_path(home: &Path) -> PathBuf {
    home.join(".agent-workbench").join("requests.jsonl")
}

/// Where a call's answer is left for the tool server to pick up.
pub fn answers_path(home: &Path) -> PathBuf {
    home.join(".agent-workbench").join("answers")
}

pub fn answer_path(home: &Path, id: &str) -> PathBuf {
    answers_path(home).join(format!("{id}.json"))
}

/// An id names a file, so it holds the characters a uuid holds and no
/// others: a plugin's word never reaches beyond the answers directory.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Writes the answer to a call, for whoever is waiting on it. Written
/// whole and moved into place, so the waiter reads an answer or nothing.
pub fn write_answer(home: &Path, id: &str, answer: &Answer) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("{id:?} is not a call id"));
    }
    let path = answer_path(home, id);
    let directory = answers_path(home);
    std::fs::create_dir_all(&directory)
        .map_err(|e| format!("could not create {}: {e}", directory.display()))?;
    let text = serde_json::to_string(answer).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, text)
        .map_err(|e| format!("could not write {}: {e}", temporary.display()))?;
    std::fs::rename(&temporary, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        format!("could not write {}: {e}", path.display())
    })
}

/// One line of the log as a request, if it is one. A line without a kind
/// is a show request from before there were two.
pub fn classify(line: &str) -> Option<Request> {
    let request = match serde_json::from_str::<Request>(line) {
        Ok(request) => request,
        Err(_) => Request::Show(serde_json::from_str::<ShowRequest>(line).ok()?),
    };
    match request {
        Request::Show(show) => {
            if show.path.is_empty() || show.from == 0 {
                return None;
            }
            Some(Request::Show(ShowRequest {
                to: show.to.max(show.from),
                ..show
            }))
        }
        Request::Present(present) => {
            if present.files.is_empty() || present.files.iter().any(String::is_empty) {
                return None;
            }
            Some(Request::Present(present))
        }
        Request::Diff(diff) => {
            if diff.path.is_empty() {
                return None;
            }
            Some(Request::Diff(diff))
        }
        Request::Terminal(terminal) => {
            if terminal.command.trim().is_empty() {
                return None;
            }
            Some(Request::Terminal(terminal))
        }
        Request::Notify(notify) => {
            if notify.text.trim().is_empty() {
                return None;
            }
            Some(Request::Notify(notify))
        }
        Request::Tool(tool) => {
            if !valid_id(&tool.id)
                || tool.source.is_empty()
                || tool.plugin.is_empty()
                || tool.tool.is_empty()
            {
                return None;
            }
            Some(Request::Tool(tool))
        }
    }
}

/// Appends a request to the log for the core here to pick up.
pub fn append(home: &Path, request: &Request) -> Result<(), String> {
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

/// Watches the request log for the life of the core. A tool call is the
/// one kind the window has no part in: it goes to `on_tool`, which hands
/// it to the plugin that owns the tool.
pub fn watch(
    sink: Arc<dyn Sink>,
    path: PathBuf,
    on_tool: impl Fn(ToolRequest) + Send + Sync + 'static,
) -> Result<(), String> {
    activity::watch_log(sink, path, ROTATE_AT, move |line| {
        classify(line).and_then(|request| match request {
            Request::Show(show) => serde_json::to_value(show)
                .ok()
                .map(|value| (SHOW_REQUEST.to_string(), value)),
            Request::Present(present) => serde_json::to_value(present)
                .ok()
                .map(|value| (PRESENT_REQUEST.to_string(), value)),
            Request::Diff(diff) => serde_json::to_value(diff)
                .ok()
                .map(|value| (DIFF_REQUEST.to_string(), value)),
            Request::Terminal(terminal) => serde_json::to_value(terminal)
                .ok()
                .map(|value| (TERMINAL_REQUEST.to_string(), value)),
            Request::Notify(notify) => serde_json::to_value(notify)
                .ok()
                .map(|value| (NOTIFY_REQUEST.to_string(), value)),
            Request::Tool(tool) => {
                on_tool(tool);
                None
            }
        })
    })
}

/// A media file's bytes for the window, encoded, with its type. Capped:
/// the window shows a screenshot, not a film.
pub const MEDIA_CAP: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub mime: String,
    pub data: String,
    pub size: u64,
}

pub fn read_media(path: &Path) -> Result<Media, String> {
    use base64::Engine;
    let mime = media_type(path)
        .ok_or_else(|| format!("{} is not an image, a PDF or a document", path.display()))?;
    let size = std::fs::metadata(path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?
        .len();
    if size > MEDIA_CAP {
        return Err(format!(
            "{} is {} MB, more than the {} MB shown here",
            path.display(),
            size / (1024 * 1024),
            MEDIA_CAP / (1024 * 1024)
        ));
    }
    let bytes =
        std::fs::read(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    Ok(Media {
        mime: mime.to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn show(line: &str) -> Option<ShowRequest> {
        match classify(line)? {
            Request::Show(show) => Some(show),
            Request::Present(_)
            | Request::Diff(_)
            | Request::Terminal(_)
            | Request::Notify(_)
            | Request::Tool(_) => None,
        }
    }

    #[test]
    fn reads_a_request_and_puts_the_range_the_right_way_round() {
        let request =
            show(r#"{"path":"/p/variables.tf","from":12,"to":3,"note":"here","cwd":"/p"}"#)
                .unwrap();
        assert_eq!(request.from, 12);
        assert_eq!(request.to, 12);
        assert_eq!(request.note.as_deref(), Some("here"));
        assert!(show(r#"{"kind":"show","path":"/p/a","from":2,"to":2,"cwd":"/p"}"#).is_some());
        assert!(classify(r#"{"path":"","from":1,"to":1,"cwd":"/p"}"#).is_none());
        assert!(classify(r#"{"path":"/p/a","from":0,"to":1,"cwd":"/p"}"#).is_none());
        assert!(classify("not json").is_none());
    }

    #[test]
    fn appends_lines_the_tail_reads_back() {
        let home = std::env::temp_dir().join("workbench-show-append");
        let _ = std::fs::remove_dir_all(&home);
        let request = Request::Show(ShowRequest {
            path: "/p/a.rs".into(),
            from: 3,
            to: 5,
            note: None,
            cwd: "/p".into(),
            session: Some("s-1".into()),
        });
        let media = Request::Present(PresentRequest {
            files: vec!["/p/shot.png".into(), "/p/plan.pdf".into()],
            caption: Some("Before and after.".into()),
            cwd: "/p".into(),
            session: None,
        });
        append(&home, &request).unwrap();
        append(&home, &media).unwrap();
        let text = std::fs::read_to_string(requests_path(&home)).unwrap();
        assert_eq!(text.lines().count(), 2);
        let mut lines = text.lines();
        assert_eq!(classify(lines.next().unwrap()).unwrap(), request);
        assert_eq!(classify(lines.next().unwrap()).unwrap(), media);
        assert!(classify(r#"{"kind":"present","files":[],"cwd":"/p"}"#).is_none());
    }

    #[test]
    fn reads_a_tool_call_and_refuses_one_without_an_id() {
        let line = r#"{"kind":"tool","id":"c-1","source":"src-1","plugin":"github","tool":"pr","arguments":{"state":"open"},"cwd":"/p","session":"s-1"}"#;
        let Some(Request::Tool(request)) = classify(line) else {
            panic!("not a tool request");
        };
        assert_eq!(request.id, "c-1");
        assert_eq!(request.plugin, "github");
        assert_eq!(request.tool, "pr");
        assert_eq!(request.arguments["state"], "open");
        assert_eq!(request.session.as_deref(), Some("s-1"));
        assert!(classify(
            r#"{"kind":"tool","id":"","source":"src-1","plugin":"github","tool":"pr","cwd":"/p"}"#
        )
        .is_none());
        assert!(classify(
            r#"{"kind":"tool","id":"../out","source":"src-1","plugin":"github","tool":"pr","cwd":"/p"}"#
        )
        .is_none());
        assert!(classify(
            r#"{"kind":"tool","id":"c-2","source":"src-1","plugin":"","tool":"pr","cwd":"/p"}"#
        )
        .is_none());
    }

    #[test]
    fn writes_an_answer_where_the_tool_server_waits() {
        let home = std::env::temp_dir().join("workbench-show-answer");
        let _ = std::fs::remove_dir_all(&home);
        let answer = Answer {
            content: Some("pong".into()),
            error: None,
        };
        write_answer(&home, "c-1", &answer).unwrap();
        let text = std::fs::read_to_string(answer_path(&home, "c-1")).unwrap();
        assert_eq!(serde_json::from_str::<Answer>(&text).unwrap(), answer);
        assert!(write_answer(&home, "../escape", &answer).is_err());
    }

    #[test]
    fn reads_media_by_its_extension_and_refuses_the_rest() {
        let dir = std::env::temp_dir().join("workbench-show-media");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("a.PNG");
        std::fs::write(&png, [137, 80, 78, 71]).unwrap();
        let media = read_media(&png).unwrap();
        assert_eq!(media.mime, "image/png");
        assert_eq!(media.size, 4);
        assert_eq!(media.data, "iVBORw==");
        assert_eq!(media_type(Path::new("x.pdf")), Some("application/pdf"));
        assert_eq!(media_type(Path::new("notes.md")), Some("text/markdown"));
        assert_eq!(media_type(Path::new("page.html")), Some("text/html"));
        assert_eq!(media_type(Path::new("flow.mmd")), Some("text/vnd.mermaid"));
        assert_eq!(media_type(Path::new("x.mp4")), None);
        let text = dir.join("a.txt");
        std::fs::write(&text, "hello").unwrap();
        assert!(read_media(&text).unwrap_err().contains("not an image"));
        assert!(read_media(&dir.join("missing.png"))
            .unwrap_err()
            .contains("could not read"));
    }
}
