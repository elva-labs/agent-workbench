//! Sessions Claude Code has already had in a project.
//!
//! Built on filenames and stat data, not on contents. The filename is the
//! session id, mtime is recency and size is a rough length: all stable, all
//! cheap, and none of it depends on a format that is documented as internal
//! and version-unstable.
//!
//! Titles are the exception, and they are the reason every line of parsing in
//! this file is quarantined here. The entry format "is internal to Claude Code
//! and changes between versions, so scripts that parse these files directly
//! can break on any release." So a title that cannot be read is a missing
//! title, never an error, and the pane falls back to a timestamp.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Only the head and the tail of a transcript are read looking for a title. A
/// long session is megabytes; the first exchange is where the subject is, and
/// the names Claude Code gives a session are appended as it goes, so the
/// latest is near the end.
const TITLE_SCAN_BYTES: usize = 64 * 1024;
/// A title is a row in a narrow pane, not a paragraph.
const TITLE_MAX_CHARS: usize = 80;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    /// The Claude Code session id, which is the filename without .jsonl. This
    /// is what `claude --resume` takes.
    pub id: String,
    /// Seconds since the epoch, for ordering and for the fallback label.
    pub modified: u64,
    pub size: u64,
    /// Absent when the format moved, which is a missing title rather than a
    /// broken pane.
    pub title: Option<String>,
}

/// Claude Code's directory name for a project: the working directory path with
/// every non-alphanumeric character replaced by a dash.
///
/// This is lossy and cannot be reversed, which is why the workbench keys its
/// own index by the real path and only ever mangles forwards.
pub fn mangle(project: &Path) -> String {
    project
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

pub fn directory_for(home: &Path, project: &Path) -> PathBuf {
    home.join(".claude").join("projects").join(mangle(project))
}

/// Newest first. A project Claude Code has never been used in has none, which
/// is an empty list rather than an error.
pub fn list(home: &Path, project: &Path) -> Vec<Transcript> {
    let directory = directory_for(home, project);
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return Vec::new();
    };

    let mut transcripts: Vec<Transcript> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "jsonl"))
        .filter_map(|entry| {
            let path = entry.path();
            let id = path.file_stem()?.to_string_lossy().to_string();
            let meta = entry.metadata().ok()?;

            Some(Transcript {
                id,
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|since| since.as_secs())
                    .unwrap_or(0),
                size: meta.len(),
                title: read_title(&path),
            })
        })
        .collect();

    transcripts.sort_by_key(|transcript| std::cmp::Reverse(transcript.modified));
    transcripts
}

/// Everything below here is the part that can break on any release.
///
/// What Claude Code's own picker shows, in its order: a name the user gave
/// the session (`custom-title`, last one wins), then the name Claude Code
/// gave it (`ai-title`, last one wins), then an older `summary`, then the
/// first thing the user actually said.
fn read_title(path: &Path) -> Option<String> {
    let tail = read_tail(path)?;
    if let Some(title) = latest(&tail, "custom-title", "customTitle") {
        return Some(tidy(&title));
    }
    if let Some(title) = latest(&tail, "ai-title", "aiTitle") {
        return Some(tidy(&title));
    }

    let head = read_head(path)?;
    for line in head.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match value.get("type").and_then(serde_json::Value::as_str) {
            Some("summary") => {
                if let Some(summary) = value.get("summary").and_then(serde_json::Value::as_str) {
                    return Some(tidy(summary));
                }
            }
            Some("user") => {
                if let Some(text) = prompt_text(&value) {
                    return Some(tidy(&text));
                }
            }
            _ => {}
        }
    }
    None
}

fn read_head(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buffer = vec![0u8; TITLE_SCAN_BYTES];
    let read = file.read(&mut buffer).ok()?;
    buffer.truncate(read);
    Some(String::from_utf8_lossy(&buffer).to_string())
}

/// The last stretch of the file, whole lines only: the first line of the
/// buffer is cut off unless the buffer holds the whole file.
fn read_tail(path: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TITLE_SCAN_BYTES as u64);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buffer = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut buffer).ok()?;
    let text = String::from_utf8_lossy(&buffer).to_string();
    if start == 0 {
        return Some(text);
    }
    Some(
        text.split_once('\n')
            .map(|(_, rest)| rest.to_string())
            .unwrap_or_default(),
    )
}

/// The newest entry of a kind in the tail, and the field it carries. The
/// kind is checked as text before any parsing: most lines are not it.
fn latest(tail: &str, kind: &str, field: &str) -> Option<String> {
    let marker = format!("\"type\":\"{kind}\"");
    tail.lines().rev().find_map(|line| {
        if !line.contains(&marker) {
            return None;
        }
        let value = serde_json::from_str::<serde_json::Value>(line).ok()?;
        if value.get("type").and_then(serde_json::Value::as_str) != Some(kind) {
            return None;
        }
        let title = value.get(field).and_then(serde_json::Value::as_str)?.trim();
        if title.is_empty() {
            None
        } else {
            Some(title.to_string())
        }
    })
}

/// What the user said in a user entry, as the picker would show it: not the
/// caveats Claude Code writes around slash commands, not a command's output,
/// and a slash command itself by its name. Meta and sidechain entries are
/// not the user's.
fn prompt_text(entry: &serde_json::Value) -> Option<String> {
    let flagged = |key: &str| entry.get(key).and_then(serde_json::Value::as_bool) == Some(true);
    if flagged("isMeta") || flagged("isSidechain") {
        return None;
    }
    let text = first_text(entry)?;
    let text = text.trim();
    if text.starts_with("<local-command-caveat>") || text.starts_with("<local-command-stdout>") {
        return None;
    }
    if let Some(name) = between(text, "<command-name>", "</command-name>") {
        return Some(name.to_string());
    }
    Some(text.to_string())
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let end = text[start..].find(close)? + start;
    Some(text[start..end].trim())
}

/// Content has been both a bare string and a list of typed blocks. Accept
/// either, and anything else is simply not a title. A block that is a system
/// reminder is not what the user said.
fn first_text(entry: &serde_json::Value) -> Option<String> {
    let content = entry.get("message")?.get("content")?;

    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }

    content.as_array()?.iter().find_map(|block| {
        let text = block.get("text").and_then(serde_json::Value::as_str)?;
        if text.trim_start().starts_with("<system-reminder>") {
            return None;
        }
        Some(text.to_string())
    })
}

/// One line, trimmed, short enough for a narrow pane.
pub fn tidy(text: &str) -> String {
    let single: String = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    let trimmed = single.trim();
    if trimmed.chars().count() <= TITLE_MAX_CHARS {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(TITLE_MAX_CHARS).collect();
    format!("{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("workbench-transcripts-{name}"));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_transcript(home: &Path, project: &Path, id: &str, body: &str) -> PathBuf {
        let dir = directory_for(home, project);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{id}.jsonl"));
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn mangles_a_path_the_way_claude_code_does() {
        assert_eq!(
            mangle(Path::new("/home/ada/dev/demo")),
            "-home-ada-dev-demo"
        );
    }

    #[test]
    fn mangling_replaces_every_kind_of_separator() {
        assert_eq!(mangle(Path::new("/a/b_c.d-e")), "-a-b-c-d-e");
    }

    // The reason the workbench keeps its own index keyed by the real path.
    #[test]
    fn mangling_is_lossy_and_cannot_be_reversed() {
        assert_eq!(mangle(Path::new("/a/b-c")), mangle(Path::new("/a/b_c")));
    }

    #[test]
    fn a_project_with_no_history_has_no_sessions() {
        let home = home("empty");
        assert!(list(&home, Path::new("/home/ada/dev/never-used")).is_empty());
    }

    #[test]
    fn reads_the_session_id_from_the_filename() {
        let home = home("id");
        let project = Path::new("/home/ada/dev/demo");
        write_transcript(&home, project, "9604da0e-c207-4138", "");

        let found = list(&home, project);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "9604da0e-c207-4138");
    }

    #[test]
    fn ignores_files_that_are_not_transcripts() {
        let home = home("other");
        let project = Path::new("/home/ada/dev/demo");
        write_transcript(&home, project, "real", "");
        std::fs::write(directory_for(&home, project).join("notes.txt"), "x").unwrap();

        assert_eq!(list(&home, project).len(), 1);
    }

    #[test]
    fn orders_newest_first() {
        let home = home("order");
        let project = Path::new("/home/ada/dev/demo");
        let older = write_transcript(&home, project, "older", "");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        write_transcript(&home, project, "newer", "");

        let found = list(&home, project);
        assert_eq!(found[0].id, "newer", "{found:?}");
        let _ = older;
    }

    #[test]
    fn reports_size_so_a_long_session_reads_as_one() {
        let home = home("size");
        let project = Path::new("/home/ada/dev/demo");
        write_transcript(&home, project, "s", "0123456789");
        assert_eq!(list(&home, project)[0].size, 10);
    }

    #[test]
    fn takes_the_title_from_the_first_user_message() {
        let home = home("title");
        let project = Path::new("/home/ada/dev/demo");
        write_transcript(
            &home,
            project,
            "s",
            r#"{"type":"user","message":{"content":"rename the token cache module"}}
{"type":"user","message":{"content":"and the tests"}}
"#,
        );

        assert_eq!(
            list(&home, project)[0].title.as_deref(),
            Some("rename the token cache module")
        );
    }

    // What the picker shows: the user's own name for the session first, then
    // the one Claude Code gave it, then an older summary, then the prompt.
    #[test]
    fn prefers_a_given_name_then_the_ai_title_then_a_summary() {
        let home = home("precedence");
        let project = Path::new("/home/ada/dev/demo");
        write_transcript(
            &home,
            project,
            "s",
            r#"{"type":"summary","summary":"the summary"}
{"type":"user","message":{"content":"the prompt"}}
{"type":"ai-title","aiTitle":"first ai title","sessionId":"s"}
{"type":"ai-title","aiTitle":"websocket-auth-lifetime-bug","sessionId":"s"}
"#,
        );
        assert_eq!(
            list(&home, project)[0].title.as_deref(),
            Some("websocket-auth-lifetime-bug")
        );

        write_transcript(
            &home,
            project,
            "named",
            r#"{"type":"user","message":{"content":"the prompt"}}
{"type":"custom-title","customTitle":"my name","sessionId":"named"}
{"type":"ai-title","aiTitle":"an ai title","sessionId":"named"}
"#,
        );
        let named = list(&home, project)
            .into_iter()
            .find(|t| t.id == "named")
            .unwrap();
        assert_eq!(named.title.as_deref(), Some("my name"));

        write_transcript(
            &home,
            project,
            "summarised",
            r#"{"type":"summary","summary":"the summary"}
{"type":"user","message":{"content":"the prompt"}}
"#,
        );
        let summarised = list(&home, project)
            .into_iter()
            .find(|t| t.id == "summarised")
            .unwrap();
        assert_eq!(summarised.title.as_deref(), Some("the summary"));
    }

    // The name lands near the end of a long file, so the tail is what is read.
    #[test]
    fn finds_the_latest_name_at_the_end_of_a_long_transcript() {
        let home = home("longtail");
        let project = Path::new("/home/ada/dev/demo");
        let filler = format!(
            "{{\"type\":\"assistant\",\"pad\":\"{}\"}}\n",
            "x".repeat(1000)
        );
        let body = format!(
            "{{\"type\":\"user\",\"message\":{{\"content\":\"the prompt\"}}}}\n{}{{\"type\":\"ai-title\",\"aiTitle\":\"late name\"}}\n",
            filler.repeat(200)
        );
        write_transcript(&home, project, "s", &body);
        assert_eq!(list(&home, project)[0].title.as_deref(), Some("late name"));
    }

    // Running a slash command first writes a caveat and the command around
    // it. The picker shows the command, never the caveat.
    #[test]
    fn shows_a_slash_command_by_name_and_never_the_caveat() {
        let home = home("caveat");
        let project = Path::new("/home/ada/dev/demo");
        write_transcript(
            &home,
            project,
            "s",
            r#"{"type":"user","message":{"content":"<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>"}}
{"type":"user","message":{"content":"<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"}}
{"type":"user","message":{"content":"<local-command-stdout>(no content)</local-command-stdout>"}}
{"type":"user","message":{"content":"Review #715"}}
"#,
        );
        assert_eq!(list(&home, project)[0].title.as_deref(), Some("/clear"));
    }

    #[test]
    fn skips_meta_and_sidechain_entries_and_system_reminders() {
        let home = home("meta");
        let project = Path::new("/home/ada/dev/demo");
        write_transcript(
            &home,
            project,
            "s",
            r#"{"type":"user","isMeta":true,"message":{"content":"injected context"}}
{"type":"user","isSidechain":true,"message":{"content":"a subagent's prompt"}}
{"type":"user","message":{"content":[{"type":"text","text":"<system-reminder>ignored</system-reminder>"},{"type":"text","text":"Can you review #717?"}]}}
"#,
        );
        assert_eq!(
            list(&home, project)[0].title.as_deref(),
            Some("Can you review #717?")
        );
    }

    // Content has been both a bare string and a list of typed blocks.
    #[test]
    fn accepts_content_as_a_list_of_blocks() {
        let home = home("blocks");
        let project = Path::new("/home/ada/dev/demo");
        write_transcript(
            &home,
            project,
            "s",
            r#"{"type":"user","message":{"content":[{"type":"text","text":"fix the watcher"}]}}"#,
        );

        assert_eq!(
            list(&home, project)[0].title.as_deref(),
            Some("fix the watcher")
        );
    }

    // The whole reason this parsing is quarantined: it can break on any release.
    #[test]
    fn a_format_it_does_not_recognise_is_a_missing_title_not_an_error() {
        let home = home("unknown");
        let project = Path::new("/home/ada/dev/demo");
        write_transcript(
            &home,
            project,
            "s",
            r#"{"v":3,"kind":"turn","body":{"who":"human"}}"#,
        );

        let found = list(&home, project);
        assert_eq!(found.len(), 1, "the session is still listed");
        assert_eq!(found[0].title, None);
    }

    #[test]
    fn broken_json_is_skipped_rather_than_fatal() {
        let home = home("broken");
        let project = Path::new("/home/ada/dev/demo");
        write_transcript(
            &home,
            project,
            "s",
            "not json at all\n{\"type\":\"user\",\"message\":{\"content\":\"still found\"}}\n",
        );

        assert_eq!(
            list(&home, project)[0].title.as_deref(),
            Some("still found")
        );
    }

    #[test]
    fn an_empty_transcript_has_no_title() {
        let home = home("blank");
        let project = Path::new("/home/ada/dev/demo");
        write_transcript(&home, project, "s", "");
        assert_eq!(list(&home, project)[0].title, None);
    }

    #[test]
    fn a_title_is_one_line() {
        let home = home("multiline");
        let project = Path::new("/home/ada/dev/demo");
        write_transcript(
            &home,
            project,
            "s",
            r#"{"type":"user","message":{"content":"first line\n\nsecond line"}}"#,
        );

        assert_eq!(
            list(&home, project)[0].title.as_deref(),
            Some("first line second line")
        );
    }

    #[test]
    fn a_long_title_is_cut_rather_than_wrapped() {
        let home = home("long");
        let project = Path::new("/home/ada/dev/demo");
        let long = "word ".repeat(60);
        write_transcript(
            &home,
            project,
            "s",
            &format!(r#"{{"type":"user","message":{{"content":"{long}"}}}}"#),
        );

        let title = list(&home, project)[0].title.clone().unwrap();
        assert!(title.chars().count() <= TITLE_MAX_CHARS + 1, "{title}");
        assert!(title.ends_with('…'));
    }

    #[test]
    fn skips_assistant_messages_when_looking_for_a_title() {
        let home = home("assistant");
        let project = Path::new("/home/ada/dev/demo");
        write_transcript(
            &home,
            project,
            "s",
            r#"{"type":"assistant","message":{"content":"I will start by"}}
{"type":"user","message":{"content":"the actual request"}}
"#,
        );

        assert_eq!(
            list(&home, project)[0].title.as_deref(),
            Some("the actual request")
        );
    }
}
