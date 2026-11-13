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

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

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
    /// Where the session ran when that is not the project itself: a worktree
    /// under it, which is where it resumes.
    pub cwd: Option<String>,
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

/// Where Claude Code files a project's transcripts, under the directory it
/// keeps its configuration in: `.claude` under the home for the agent's
/// own account, or the account's own directory.
pub fn directory_for(claude_dir: &Path, project: &Path) -> PathBuf {
    claude_dir.join("projects").join(mangle(project))
}

/// What is read from inside a transcript, and so what is kept against its
/// path. The title is read the first time it is wanted: a transcript that
/// belongs to no project asked for never needs one.
struct Details {
    cwd: Option<String>,
    title: OnceLock<Option<String>>,
}

impl Details {
    fn title(&self, path: &Path, size: u64) -> Option<String> {
        self.title.get_or_init(|| read_title(path, size)).clone()
    }
}

/// A transcript as it was when it was read: a change to its modification
/// time or size, and on unix to the file that is there (its inode) or to its
/// metadata (ctime), is a different transcript.
#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    modified: Option<std::time::SystemTime>,
    size: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed: (i64, i64),
}

impl Stamp {
    fn of(meta: &std::fs::Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Stamp {
            modified: meta.modified().ok(),
            size: meta.len(),
            #[cfg(unix)]
            inode: meta.ino(),
            #[cfg(unix)]
            changed: (meta.ctime(), meta.ctime_nsec()),
        }
    }
}

#[derive(Clone)]
struct Cached {
    stamp: Stamp,
    details: Arc<Details>,
}

/// What was read from transcripts, by directory and then file name. A
/// directory's entry is replaced each time the directory is listed, so a
/// transcript that is gone is gone from here too.
type Cache = HashMap<PathBuf, HashMap<OsString, Cached>>;

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

static OPENED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// How many transcripts have been opened to read their details since the
/// process began. A listing that is served from what was kept does not add
/// to it.
pub fn opened() -> u64 {
    OPENED.load(std::sync::atomic::Ordering::Relaxed)
}

/// One transcript file found in a directory.
struct Found {
    path: PathBuf,
    id: String,
    modified: u64,
    size: u64,
    details: Arc<Details>,
}

/// Newest first. A project Claude Code has never been used in has none, which
/// is an empty list rather than an error.
pub fn list(claude_dir: &Path, project: &Path) -> Vec<Transcript> {
    list_many(claude_dir, &[project.to_path_buf()])
        .pop()
        .unwrap_or_default()
}

/// The sessions of every project given, in the order given, from one read of
/// the account's projects directory. A directory several projects draw on
/// is listed once, and a transcript that has not changed since it was last
/// read is not opened again.
///
/// A session started in a directory under the project, a worktree most of
/// all, is filed by Claude Code under that directory's own name. Those are
/// the project's sessions too, so every directory whose name begins with
/// the project's is read, and each transcript in one is kept when it says
/// it ran under the project: the names alone would take a sibling project
/// with a longer name for a subdirectory.
pub fn list_many(claude_dir: &Path, projects: &[PathBuf]) -> Vec<Vec<Transcript>> {
    let root = claude_dir.join("projects");
    let Ok(directories) = std::fs::read_dir(&root) else {
        forget_directories(&root, &[]);
        return vec![Vec::new(); projects.len()];
    };
    let names: Vec<String> = directories
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    forget_directories(&root, &names);

    let wanted: Vec<(String, String, String, String)> = projects
        .iter()
        .map(|project| {
            let own = mangle(project);
            let under = format!("{own}-");
            let text = project.to_string_lossy().to_string();
            let inside = format!("{text}/");
            (own, under, text, inside)
        })
        .collect();
    let needed: Vec<&String> = names
        .iter()
        .filter(|name| {
            wanted
                .iter()
                .any(|(own, under, ..)| *name == own || name.starts_with(under.as_str()))
        })
        .collect();
    let scanned = scan_directories(&root, &needed);

    // Which transcripts each project keeps. Titles are read afterwards, for
    // those only.
    let kept: Vec<Vec<&Found>> = wanted
        .iter()
        .map(|(own, under, root_text, inside_prefix)| {
            let mut keep: Vec<&Found> = Vec::new();
            for name in &names {
                let exact = name == own;
                if !exact && !name.starts_with(under.as_str()) {
                    continue;
                }
                let Some(found) = scanned.get(name.as_str()) else {
                    continue;
                };
                for item in found {
                    let cwd = item.details.cwd.as_deref();
                    let inside =
                        cwd.is_some_and(|cwd| cwd == root_text || cwd.starts_with(inside_prefix));
                    if exact || inside {
                        keep.push(item);
                    }
                }
            }

            // A session resumed from another directory is written again there
            // under the same id, so one session can be in several folders: it
            // is listed once, as the copy that moved last.
            keep.sort_by_key(|item| std::cmp::Reverse(item.modified));
            let mut seen = HashSet::new();
            keep.retain(|item| seen.insert(item.id.as_str()));
            keep
        })
        .collect();

    let mut unique: Vec<&Found> = kept.iter().flatten().copied().collect();
    unique.sort_by_key(|item| Arc::as_ptr(&item.details));
    unique.dedup_by_key(|item| Arc::as_ptr(&item.details));
    read_titles(&unique);

    kept.iter()
        .zip(&wanted)
        .map(|(keep, (_, _, root_text, _))| {
            keep.iter()
                .map(|item| Transcript {
                    id: item.id.clone(),
                    modified: item.modified,
                    size: item.size,
                    title: item.details.title(&item.path, item.size),
                    cwd: item
                        .details
                        .cwd
                        .as_deref()
                        .filter(|cwd| *cwd != root_text.as_str())
                        .map(str::to_string),
                })
                .collect()
        })
        .collect()
}

/// Reads the titles not yet read, spread over a few threads.
fn read_titles(items: &[&Found]) {
    let queue = Mutex::new(items.iter());
    std::thread::scope(|scope| {
        for _ in 0..SCAN_THREADS.min(items.len()) {
            scope.spawn(|| loop {
                let next = queue
                    .lock()
                    .ok()
                    .and_then(|mut queue| queue.next().copied());
                let Some(item) = next else { break };
                item.details.title(&item.path, item.size);
            });
        }
    });
}

/// How many directories are read at once. Reading a transcript is mostly
/// waiting on the disk, so a handful in flight is faster than one.
const SCAN_THREADS: usize = 8;

/// The directories listed, each by its name, spread over a few threads.
fn scan_directories<'a>(root: &Path, names: &[&'a String]) -> HashMap<&'a str, Vec<Found>> {
    let queue = Mutex::new(names.iter());
    let mut scanned = HashMap::new();
    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..SCAN_THREADS.min(names.len()))
            .map(|_| {
                scope.spawn(|| {
                    let mut done = Vec::new();
                    loop {
                        let next = queue
                            .lock()
                            .ok()
                            .and_then(|mut queue| queue.next().copied());
                        let Some(name) = next else { break };
                        done.push((name.as_str(), scan_directory(&root.join(name))));
                    }
                    done
                })
            })
            .collect();
        for worker in workers {
            scanned.extend(worker.join().unwrap_or_default());
        }
    });
    scanned
}

/// Drops what was kept for directories under `root` that are not among
/// `names` any more.
fn forget_directories(root: &Path, names: &[String]) {
    let Ok(mut kept) = cache().lock() else { return };
    kept.retain(|directory, _| {
        directory.parent() != Some(root)
            || directory
                .file_name()
                .is_some_and(|name| names.iter().any(|known| known.as_str() == name))
    });
}

/// The transcripts in one directory. What is in each is read only when the
/// file's modification time or size is not what it was when it was last read.
fn scan_directory(directory: &Path) -> Vec<Found> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        if let Ok(mut kept) = cache().lock() {
            kept.remove(directory);
        }
        return Vec::new();
    };
    let before: HashMap<OsString, Cached> = cache()
        .lock()
        .ok()
        .and_then(|kept| kept.get(directory).cloned())
        .unwrap_or_default();

    let mut after: HashMap<OsString, Cached> = HashMap::new();
    let mut found = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.extension().is_some_and(|ext| ext == "jsonl") {
            continue;
        }
        let Some(id) = path
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
        else {
            continue;
        };
        // Followed through a link, so a linked transcript is the file it
        // points at.
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let stamp = Stamp::of(&meta);
        let name = entry.file_name();
        let details = match before.get(&name) {
            Some(cached) if cached.stamp == stamp => Arc::clone(&cached.details),
            _ => Arc::new(read_details(&path)),
        };
        found.push(Found {
            path,
            id,
            modified: stamp
                .modified
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|since| since.as_secs())
                .unwrap_or(0),
            size: stamp.size,
            details: Arc::clone(&details),
        });
        after.insert(name, Cached { stamp, details });
    }
    if let Ok(mut kept) = cache().lock() {
        kept.insert(directory.to_path_buf(), after);
    }
    found
}

/// Where the session ran, from one read of the head of the file.
fn read_details(path: &Path) -> Details {
    OPENED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Details {
        cwd: read_head(path).as_deref().and_then(cwd_in),
        title: OnceLock::new(),
    }
}

/// Where the session ran, from the first line that says.
fn cwd_in(head: &str) -> Option<String> {
    head.lines().find_map(|line| {
        let value: serde_json::Value = serde_json::from_str(line).ok()?;
        value.get("cwd")?.as_str().map(str::to_string)
    })
}

/// Everything below here is the part that can break on any release.
///
/// What Claude Code's own picker shows, in its order: a name the user gave
/// the session (`custom-title`, last one wins), then the name Claude Code
/// gave it (`ai-title`, last one wins), then an older `summary`, then the
/// first thing the user actually said.
fn read_title(path: &Path, size: u64) -> Option<String> {
    let head = read_head(path)?;
    // A file no longer than the head is the head.
    let read;
    let tail = if size <= TITLE_SCAN_BYTES as u64 {
        head.as_str()
    } else {
        read = read_tail(path)?;
        read.as_str()
    };
    if let Some(title) = latest(tail, "custom-title", "customTitle") {
        return Some(tidy(&title));
    }
    if let Some(title) = latest(tail, "ai-title", "aiTitle") {
        return Some(tidy(&title));
    }

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

    // A worktree's sessions belong to the project it is under, and say
    // where they ran; a sibling project with a longer name is not one.
    // The same session resumed inside a worktree is written there again
    // under its id. One row, the one that moved last.
    #[test]
    fn lists_a_session_found_in_two_folders_once() {
        let home = home("twice");
        let project = Path::new("/home/ada/dev/demo");
        let worktree = Path::new("/home/ada/dev/demo/.claude/worktrees/gerrit");
        let older = write_transcript(
            &home,
            project,
            "same",
            r#"{"cwd":"/home/ada/dev/demo","type":"user"}"#,
        );
        write_transcript(
            &home,
            worktree,
            "same",
            r#"{"cwd":"/home/ada/dev/demo/.claude/worktrees/gerrit","type":"user"}"#,
        );
        let earlier = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        std::fs::File::options()
            .write(true)
            .open(&older)
            .unwrap()
            .set_modified(earlier)
            .unwrap();
        let found = list(&home, project);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "same");
        assert_eq!(
            found[0].cwd.as_deref(),
            Some("/home/ada/dev/demo/.claude/worktrees/gerrit")
        );
    }

    #[test]
    fn lists_sessions_from_worktrees_under_the_project() {
        let home = home("worktrees");
        let project = Path::new("/home/ada/dev/demo");
        let worktree = Path::new("/home/ada/dev/demo/.claude/worktrees/gerrit");
        let sibling = Path::new("/home/ada/dev/demo-v2");
        write_transcript(
            &home,
            project,
            "own",
            r#"{"cwd":"/home/ada/dev/demo","type":"user"}"#,
        );
        write_transcript(
            &home,
            worktree,
            "tree",
            r#"{"cwd":"/home/ada/dev/demo/.claude/worktrees/gerrit","type":"user"}"#,
        );
        write_transcript(
            &home,
            sibling,
            "other",
            r#"{"cwd":"/home/ada/dev/demo-v2","type":"user"}"#,
        );

        let found = list(&home, project);
        let mut ids: Vec<&str> = found.iter().map(|t| t.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["own", "tree"]);
        let tree = found.iter().find(|t| t.id == "tree").unwrap();
        assert_eq!(
            tree.cwd.as_deref(),
            Some("/home/ada/dev/demo/.claude/worktrees/gerrit")
        );
        let own = found.iter().find(|t| t.id == "own").unwrap();
        assert_eq!(own.cwd, None);
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

    /// Sets the modification time to a whole second after the epoch, so the
    /// same call twice gives the same time.
    fn pin_mtime(path: &Path, seconds: u64) {
        let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds);
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(when)
            .unwrap();
    }

    fn user(text: &str) -> String {
        format!(r#"{{"type":"user","cwd":"/home/ada/dev/demo","message":{{"content":"{text}"}}}}"#)
    }

    /// The kept details of the only transcript in the project's directory.
    fn kept(home: &Path, project: &Path) -> Arc<Details> {
        let directory = directory_for(home, project);
        let cache = cache().lock().unwrap();
        Arc::clone(&cache[&directory].values().next().unwrap().details)
    }

    // A transcript nothing has touched is not opened again.
    #[test]
    fn an_unchanged_transcript_is_served_from_the_cache() {
        let home = home("cache-hit");
        let project = Path::new("/home/ada/dev/demo");
        let path = write_transcript(&home, project, "s", &user("alpha"));
        pin_mtime(&path, 1_700_000_600);
        assert_eq!(list(&home, project)[0].title.as_deref(), Some("alpha"));
        let first = kept(&home, project);
        assert_eq!(list(&home, project)[0].title.as_deref(), Some("alpha"));
        assert!(Arc::ptr_eq(&first, &kept(&home, project)));
    }

    // Same size and same modification time, but another file put in its
    // place: it is read again.
    #[cfg(unix)]
    #[test]
    fn a_transcript_swapped_for_one_of_the_same_size_and_time_is_read_again() {
        let home = home("cache-swap");
        let project = Path::new("/home/ada/dev/demo");
        let path = write_transcript(&home, project, "s", &user("alpha"));
        pin_mtime(&path, 1_700_000_600);
        assert_eq!(list(&home, project)[0].title.as_deref(), Some("alpha"));

        let other = path.with_extension("tmp");
        std::fs::write(&other, user("omega")).unwrap();
        pin_mtime(&other, 1_700_000_600);
        std::fs::rename(&other, &path).unwrap();
        assert_eq!(list(&home, project)[0].title.as_deref(), Some("omega"));
    }

    // Rewritten in place with the size and time put back: the change time
    // still moved.
    #[cfg(unix)]
    #[test]
    fn a_transcript_rewritten_with_its_time_put_back_is_read_again() {
        let home = home("cache-rewrite");
        let project = Path::new("/home/ada/dev/demo");
        let path = write_transcript(&home, project, "s", &user("alpha"));
        pin_mtime(&path, 1_700_000_600);
        assert_eq!(list(&home, project)[0].title.as_deref(), Some("alpha"));

        std::fs::write(&path, user("omega")).unwrap();
        pin_mtime(&path, 1_700_000_600);
        assert_eq!(list(&home, project)[0].title.as_deref(), Some("omega"));
    }

    // A linked transcript is the file it points at: a change there shows.
    #[cfg(unix)]
    #[test]
    fn a_linked_transcript_follows_its_target() {
        let home = home("cache-link");
        let project = Path::new("/home/ada/dev/demo");
        let target = home.join("elsewhere.jsonl");
        std::fs::write(&target, user("alpha")).unwrap();
        let directory = directory_for(&home, project);
        std::fs::create_dir_all(&directory).unwrap();
        std::os::unix::fs::symlink(&target, directory.join("s.jsonl")).unwrap();
        assert_eq!(list(&home, project)[0].title.as_deref(), Some("alpha"));

        std::fs::write(&target, user("omega, a little longer")).unwrap();
        let found = list(&home, project);
        assert_eq!(found[0].title.as_deref(), Some("omega, a little longer"));
        assert_eq!(found[0].size, user("omega, a little longer").len() as u64);
    }

    // The title is read for a transcript that is kept, and for no other.
    #[test]
    fn a_sibling_projects_transcript_is_not_read_for_its_title() {
        let home = home("lazy-title");
        let demo = Path::new("/home/ada/dev/demo");
        let sibling = Path::new("/home/ada/dev/demo-v2");
        write_transcript(&home, demo, "own", &user("own"));
        write_transcript(
            &home,
            sibling,
            "other",
            r#"{"type":"user","cwd":"/home/ada/dev/demo-v2","message":{"content":"theirs"}}"#,
        );
        let found = list(&home, demo);
        assert_eq!(found.len(), 1);
        let directory = directory_for(&home, sibling);
        let cache = cache().lock().unwrap();
        let theirs = cache[&directory].values().next().unwrap();
        assert!(theirs.details.title.get().is_none());
    }

    #[test]
    fn a_transcript_with_a_new_modification_time_is_read_again() {
        let home = home("cache-mtime");
        let project = Path::new("/home/ada/dev/demo");
        let path = write_transcript(&home, project, "s", &user("alpha"));
        pin_mtime(&path, 1_700_000_600);
        assert_eq!(list(&home, project)[0].title.as_deref(), Some("alpha"));

        std::fs::write(&path, user("omega")).unwrap();
        pin_mtime(&path, 1_700_000_900);
        let found = list(&home, project);
        assert_eq!(found[0].title.as_deref(), Some("omega"));
    }

    #[test]
    fn a_transcript_with_a_new_size_is_read_again() {
        let home = home("cache-size");
        let project = Path::new("/home/ada/dev/demo");
        let path = write_transcript(&home, project, "s", &user("alpha"));
        pin_mtime(&path, 1_700_000_600);
        assert_eq!(list(&home, project)[0].title.as_deref(), Some("alpha"));

        std::fs::write(&path, user("a longer second thought")).unwrap();
        pin_mtime(&path, 1_700_000_600);
        let found = list(&home, project);
        assert_eq!(found[0].title.as_deref(), Some("a longer second thought"));
    }

    #[test]
    fn a_removed_transcript_drops_out_and_out_of_the_cache() {
        let home = home("cache-removed");
        let project = Path::new("/home/ada/dev/demo");
        let keep = write_transcript(&home, project, "keep", &user("kept"));
        let gone = write_transcript(&home, project, "gone", &user("gone"));
        assert_eq!(list(&home, project).len(), 2);
        let directory = directory_for(&home, project);
        assert_eq!(cache().lock().unwrap()[&directory].len(), 2);

        std::fs::remove_file(&gone).unwrap();
        let found = list(&home, project);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "keep");
        assert_eq!(cache().lock().unwrap()[&directory].len(), 1);

        // Written again, it is read afresh rather than remembered.
        std::fs::write(&gone, user("back")).unwrap();
        let found = list(&home, project);
        let back = found.iter().find(|t| t.id == "gone").unwrap();
        assert_eq!(back.title.as_deref(), Some("back"));
        let _ = keep;
    }

    #[test]
    fn a_removed_project_directory_leaves_the_cache() {
        let home = home("cache-directory");
        let project = Path::new("/home/ada/dev/demo");
        write_transcript(&home, project, "s", &user("alpha"));
        assert_eq!(list(&home, project).len(), 1);
        let directory = directory_for(&home, project);
        assert!(cache().lock().unwrap().contains_key(&directory));

        std::fs::remove_dir_all(&directory).unwrap();
        assert!(list(&home, project).is_empty());
        assert!(!cache().lock().unwrap().contains_key(&directory));
    }

    // One read of the projects directory serves every project, each getting
    // its own, in the order asked, as if listed alone.
    #[test]
    fn many_projects_are_listed_together_as_they_are_alone() {
        let home = home("many");
        let demo = Path::new("/home/ada/dev/demo");
        let tree = Path::new("/home/ada/dev/demo/.claude/worktrees/gerrit");
        let longer = Path::new("/home/ada/dev/demo-v2");
        let empty = Path::new("/home/ada/dev/untouched");
        write_transcript(&home, demo, "own", &user("own"));
        write_transcript(
            &home,
            tree,
            "tree",
            r#"{"type":"user","cwd":"/home/ada/dev/demo/.claude/worktrees/gerrit"}"#,
        );
        write_transcript(
            &home,
            longer,
            "other",
            r#"{"type":"user","cwd":"/home/ada/dev/demo-v2"}"#,
        );

        let projects = vec![
            longer.to_path_buf(),
            empty.to_path_buf(),
            demo.to_path_buf(),
        ];
        let together = list_many(&home, &projects);
        assert_eq!(together.len(), 3);
        for (project, found) in projects.iter().zip(&together) {
            let alone = list(&home, project);
            let ids = |list: &[Transcript]| {
                let mut ids: Vec<String> = list.iter().map(|t| t.id.clone()).collect();
                ids.sort();
                ids
            };
            assert_eq!(ids(found), ids(&alone), "{project:?}");
        }
        assert_eq!(together[0].len(), 1);
        assert!(together[1].is_empty());
        assert_eq!(together[2].len(), 2);
    }

    // Several listings at once, as the window asks for more than one agent
    // or account together, each get the whole answer.
    #[test]
    fn concurrent_listings_each_get_the_whole_answer() {
        let home = home("concurrent");
        let projects: Vec<PathBuf> = (0..6)
            .map(|n| PathBuf::from(format!("/home/ada/dev/p{n}")))
            .collect();
        for project in &projects {
            for t in 0..5 {
                let body = format!(
                    r#"{{"type":"user","cwd":"{}","message":{{"content":"t{t}"}}}}"#,
                    project.display()
                );
                write_transcript(&home, project, &format!("s{t}"), &body);
            }
        }
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    for _ in 0..5 {
                        let found = list_many(&home, &projects);
                        assert_eq!(found.len(), 6);
                        assert!(found.iter().all(|list| list.len() == 5));
                        assert!(found.iter().flatten().all(|t| t.title.is_some()));
                    }
                });
            }
        });
    }

    // The same session id under two accounts is two files, each kept
    // against its own directory.
    #[test]
    fn two_accounts_holding_the_same_id_are_cached_apart() {
        let one = home("same-id-one");
        let two = home("same-id-two");
        let project = Path::new("/home/ada/dev/demo");
        write_transcript(&one, project, "shared", &user("from one"));
        write_transcript(&two, project, "shared", &user("from two"));
        assert_eq!(list(&one, project)[0].title.as_deref(), Some("from one"));
        assert_eq!(list(&two, project)[0].title.as_deref(), Some("from two"));
        assert_eq!(list(&one, project)[0].title.as_deref(), Some("from one"));
    }

    #[test]
    fn many_projects_with_no_projects_directory_have_no_sessions() {
        let home = home("many-empty");
        let projects = vec![PathBuf::from("/a"), PathBuf::from("/b")];
        let found = list_many(&home, &projects);
        assert_eq!(found.len(), 2);
        assert!(found.iter().all(Vec::is_empty));
    }
}
