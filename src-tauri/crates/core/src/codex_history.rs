//! What a Codex thread said and did before, read through Codex's own
//! app-server.
//!
//! Codex keeps each thread's turns and their items itself, and its
//! app-server gives them back a page at a time: `thread/turns/list` pages
//! through a thread's turns, newest first, each with its items, and
//! `thread/items/list` through the items of one turn. A `codex app-server`
//! of its own is started under the account's home for each read, with its
//! plugins off so that it starts nothing, and ended with whatever is left
//! in its process group once it is done, so a thread is read whether a
//! session of it runs or not, here, in a terminal, or nowhere.
//!
//! Every item comes out as the events a live session sends for it, through
//! the driver's own mapping and under the same ids, so that a window draws
//! an item it both read and heard once, and a message under the id the
//! window gave it when it sent it. The reading is kept apart and reads
//! defensively, as the driver does: an item of a kind it does not know is
//! skipped, never an error; a page too long to read is asked for again a
//! turn at a time, and a turn too long for that without its items, which
//! are then read a page at a time; a turn that cannot be read, an answer
//! that is not understood and a read that runs out of time each end the
//! reading with what was read.
//!
//! What is held is bounded. Turns are read newest first, each cut down as
//! any history's events are, until the history holds as much as it may;
//! the older turns are left out, and the history says its start was.

use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::adapter::{prepare_process, process, CODEX_HOME_VAR};
use crate::codex_app_server::{call_of, finished, said, turned_down};
use crate::env::find_on_path;
use crate::integrated::{
    cut, now_millis, CompactReason, Event, History, Image, MessageState, Outcome, Said,
};
use crate::short_lived::{Gone, Line, ShortLived};

/// How long a whole read may take. A read still going then keeps what it
/// has.
const READ_WAIT: Duration = Duration::from_secs(20);
/// Turns asked for at once, with their items.
const TURNS_PAGE: u64 = 16;
/// Items of one turn asked for at once.
const ITEMS_PAGE: u64 = 64;
/// The most of a reason Codex gives for not reading a thread that is kept.
const WHY_KEEP: usize = 200;

/// What the thread with this id said and did, read by the Codex on the
/// PATH of `env`, under the account's home where one is given. Empty for a
/// request that names no project or no thread; an error for a thread Codex
/// says it cannot read, and for a Codex that cannot be started or answers
/// nothing in time.
pub fn read_thread(
    env: &HashMap<String, String>,
    config_dir: Option<&Path>,
    project: &Path,
    cwd: Option<&Path>,
    thread: &str,
) -> Result<History, String> {
    read_within(env, config_dir, project, cwd, thread, READ_WAIT)
}

pub(crate) fn read_within(
    env: &HashMap<String, String>,
    config_dir: Option<&Path>,
    project: &Path,
    cwd: Option<&Path>,
    thread: &str,
    wait: Duration,
) -> Result<History, String> {
    if project.as_os_str().is_empty() || !is_thread(thread) {
        return Ok(History::default());
    }
    let folder = cwd.unwrap_or(project);
    let mut server =
        AppServer::start(env, config_dir, folder, Instant::now() + wait).map_err(plain)?;
    server.introduce().map_err(plain)?;
    read(&mut server, thread, folder)
}

/// Whether an id can be a thread's: Codex's are UUIDs.
fn is_thread(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Why a thread could not be read, in a few plain words that follow "its
/// earlier messages could not be read": Codex's own refusals said the way a
/// user can follow them, and anything else on one short line.
fn plain(error: String) -> String {
    if error.contains("thread not loaded") || error.contains("no rollout found") {
        return "Codex does not have this conversation".into();
    }
    if error.contains("unknown variant") || error.contains("not supported") {
        return "this version of Codex cannot give them back".into();
    }
    let mut first = error
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .trim_end_matches('.')
        .to_string();
    if cut(&mut first, WHY_KEEP) {
        first.push('…');
    }
    first
}

/// What came back for a request.
#[derive(Debug)]
pub(crate) enum Answer {
    Result(Value),
    /// Codex answered with an error, which says why.
    Refused(String),
    /// The answer was too long to read.
    TooLong,
    /// No answer will come: Codex ended, or the read ran out of time.
    Gone(String),
}

/// Something that answers the app-server's requests: Codex itself, or a
/// test.
pub(crate) trait Ask {
    fn ask(&mut self, method: &str, params: Value) -> Answer;
}

/// The thread's turns, newest first, until there are no more or the
/// history holds as much as it may, each made into its events with the
/// items Codex keeps of it. `folder` is the folder the session ran in,
/// which a changed file's path is taken from where Codex gives it no other.
pub(crate) fn read(server: &mut dyn Ask, thread: &str, folder: &Path) -> Result<History, String> {
    // Newest first, each turn's events in order.
    let mut turns: Vec<Vec<Said>> = Vec::new();
    let mut held = 0;
    let mut cursor: Option<String> = None;
    let mut cut = false;
    'pages: loop {
        let page = match turns_page(server, thread, cursor.as_deref()) {
            Ok(page) => page,
            Err(error) if turns.is_empty() && cursor.is_none() => return Err(plain(error)),
            Err(_) => {
                cut = true;
                break;
            }
        };
        let next = page["nextCursor"].as_str().map(str::to_string);
        for turn in page["data"].as_array().into_iter().flatten() {
            let Some(items) = items_of(server, thread, turn) else {
                cut = true;
                break 'pages;
            };
            let said = turn_events(turn, &items, folder, turns.is_empty());
            let size: usize = said.iter().map(Said::size).sum();
            if !turns.is_empty() && held + size > History::KEEP {
                cut = true;
                break 'pages;
            }
            held += size;
            turns.push(said);
        }
        match next {
            Some(next) if Some(&next) != cursor.as_ref() => cursor = Some(next),
            _ => break,
        }
    }
    let mut items: Vec<Said> = turns.into_iter().rev().flatten().collect();
    // What has no time of its own takes the first time known.
    let first = items
        .iter()
        .map(|said| said.at)
        .find(|at| *at > 0)
        .unwrap_or_else(now_millis);
    for said in &mut items {
        if said.at == 0 {
            said.at = first;
        }
    }
    Ok(History { items, cut })
}

/// A page of turns, newest first, with their items. A page too long to
/// read comes again a turn at a time, and a turn too long for that comes
/// again without its items, which a thread kept the older way cannot give
/// on their own.
fn turns_page(server: &mut dyn Ask, thread: &str, cursor: Option<&str>) -> Result<Value, String> {
    let ask = |server: &mut dyn Ask, limit: u64, view: &str| {
        server.ask(
            "thread/turns/list",
            json!({
                "threadId": thread,
                "cursor": cursor,
                "limit": limit,
                "sortDirection": "desc",
                "itemsView": view,
            }),
        )
    };
    let answer = match ask(server, TURNS_PAGE, "full") {
        Answer::TooLong => match ask(server, 1, "full") {
            Answer::TooLong => ask(server, 1, "notLoaded"),
            answer => answer,
        },
        answer => answer,
    };
    match answer {
        Answer::Result(page) if page["data"].is_array() => Ok(page),
        Answer::Result(_) => Err("Codex answered with no turns".into()),
        Answer::Refused(error) | Answer::Gone(error) => Err(error),
        Answer::TooLong => Err("Codex's turns were too long to read".into()),
    }
}

/// The items of a turn: those its page carries, or else those read a page
/// at a time. An item too long to read ends what is read of its turn.
/// None for a turn none of whose items could be read.
fn items_of(server: &mut dyn Ask, thread: &str, turn: &Value) -> Option<Vec<Value>> {
    let view = turn["itemsView"].as_str().unwrap_or("full");
    if view == "full" {
        return Some(turn["items"].as_array().cloned().unwrap_or_default());
    }
    let id = turn["id"].as_str()?;
    let mut items = Vec::new();
    let mut cursor: Option<String> = None;
    let mut limit = ITEMS_PAGE;
    loop {
        let answer = server.ask(
            "thread/items/list",
            json!({
                "threadId": thread,
                "turnId": id,
                "cursor": cursor,
                "limit": limit,
                "sortDirection": "asc",
            }),
        );
        let page = match answer {
            Answer::Result(page) => page,
            Answer::TooLong if limit > 1 => {
                limit = 1;
                continue;
            }
            Answer::TooLong => return Some(items),
            Answer::Refused(_) | Answer::Gone(_) if items.is_empty() => return None,
            Answer::Refused(_) | Answer::Gone(_) => return Some(items),
        };
        for entry in page["data"].as_array().into_iter().flatten() {
            let mut item = entry["item"].clone();
            if !item.is_object() {
                continue;
            }
            // The entry says when its item started and ended, where the
            // item does not.
            for key in ["startedAtMs", "completedAtMs"] {
                if item[key].is_null() && !entry[key].is_null() {
                    item[key] = entry[key].clone();
                }
            }
            items.push(item);
        }
        limit = ITEMS_PAGE;
        match page["nextCursor"].as_str() {
            Some(next) if Some(next) != cursor.as_deref() => cursor = Some(next.to_string()),
            _ => return Some(items),
        }
    }
}

/// When an item started, or ended, in milliseconds since the epoch.
fn millis(item: &Value, key: &str) -> Option<u64> {
    item[key].as_u64().filter(|at| *at > 0)
}

/// A time a turn gives in seconds, in milliseconds.
fn seconds(turn: &Value, key: &str) -> Option<u64> {
    turn[key]
        .as_u64()
        .filter(|at| *at > 0)
        .map(|at| at.saturating_mul(1000))
}

/// A message of the user's: the id the window gave it where it sent it,
/// else Codex's own, with its words and its images. None for one with
/// neither words nor an image.
fn message(item: &Value) -> Option<(String, String, Vec<Image>)> {
    let id = item["clientId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .or_else(|| item["id"].as_str())?;
    let mut texts = Vec::new();
    let mut images = Vec::new();
    for part in item["content"].as_array().into_iter().flatten() {
        match part["type"].as_str() {
            Some("text") => texts.extend(part["text"].as_str()),
            Some("image") => images.extend(
                part["url"]
                    .as_str()
                    .or_else(|| part["image_url"].as_str())
                    .and_then(data_image),
            ),
            _ => {}
        }
    }
    let text = texts.join("\n");
    if text.trim().is_empty() && images.is_empty() {
        return None;
    }
    Some((id.to_string(), text, images))
}

/// An image given as a data URL, as the driver sends one.
fn data_image(url: &str) -> Option<Image> {
    let rest = url.strip_prefix("data:")?;
    let (media_type, data) = rest.split_once(";base64,")?;
    media_type.starts_with("image/").then(|| Image {
        media_type: media_type.to_string(),
        data: data.to_string(),
    })
}

/// Whether an item is something the agent said or did, rather than the
/// user's message or Codex's own housekeeping.
fn agent_s(item: &Value) -> bool {
    matches!(
        item["type"].as_str(),
        Some("agentMessage" | "reasoning" | "plan")
    ) || call_of(item).is_some()
}

/// One turn as the events a session sends for it, each at the time Codex
/// gives, or the last time known before it. The turn answers the first
/// message of the user's that comes before anything of the agent's; a
/// message after that was taken into the turn. A turn with no message is
/// one the agent began by itself, such as to compact, and a compaction in
/// one was asked for, while one in a turn the user began was made because
/// the context was full. A tool call Codex keeps as still running finishes
/// as failed when its turn has ended. The newest turn, `last`, is left
/// open while it has no end: a turn that still runs, read from a process
/// of Codex's own, comes back as interrupted with no time it completed,
/// where one that was interrupted has one. An older turn Codex never ended
/// was interrupted.
fn turn_events(turn: &Value, items: &[Value], folder: &Path, last: bool) -> Vec<Said> {
    let mut out: Vec<Said> = Vec::new();
    let mut now = items
        .iter()
        .find_map(|item| millis(item, "startedAtMs").or_else(|| millis(item, "completedAtMs")))
        .or_else(|| seconds(turn, "startedAt"))
        .unwrap_or(0);
    let push = |out: &mut Vec<Said>, at: u64, event: Event| {
        out.push(Said {
            at,
            model: None,
            event: History::kept(event),
        });
    };
    let messages = items.iter().any(|item| item["type"] == "userMessage");
    let opener = items
        .iter()
        .take_while(|item| !agent_s(item))
        .position(|item| item["type"] == "userMessage" && message(item).is_some());
    match opener.and_then(|at| Some((at, message(&items[at])?))) {
        Some((at, (id, text, images))) => {
            now = millis(&items[at], "startedAtMs").unwrap_or(now);
            push(
                &mut out,
                now,
                Event::Message {
                    message: id.clone(),
                    state: MessageState::Sent,
                    error: None,
                    text: Some(text),
                    images,
                },
            );
            push(&mut out, now, Event::TurnStarted { messages: vec![id] });
        }
        None => push(&mut out, now, Event::TurnStarted { messages: vec![] }),
    }
    let mut open: Vec<String> = Vec::new();
    for (at, item) in items.iter().enumerate() {
        let Some(id) = item["id"].as_str() else {
            continue;
        };
        let started = millis(item, "startedAtMs").unwrap_or(now);
        let ended = millis(item, "completedAtMs").unwrap_or(started);
        now = now.max(ended);
        match item["type"].as_str() {
            Some("userMessage") => {
                if Some(at) == opener {
                    continue;
                }
                if let Some((id, text, images)) = message(item) {
                    push(
                        &mut out,
                        started,
                        Event::Message {
                            message: id,
                            state: MessageState::Taken,
                            error: None,
                            text: Some(text),
                            images,
                        },
                    );
                }
            }
            Some("contextCompaction") => push(
                &mut out,
                ended,
                Event::Compacted {
                    reason: Some(if messages {
                        CompactReason::Full
                    } else {
                        CompactReason::Asked
                    }),
                    tokens_before: None,
                    tokens_after: None,
                },
            ),
            Some("agentMessage" | "reasoning" | "plan") => {
                for event in said(item, id, |_| false) {
                    push(&mut out, ended, event);
                }
            }
            _ => {
                let Some((name, kind, input)) = call_of(item) else {
                    continue;
                };
                push(
                    &mut out,
                    started,
                    Event::ToolStarted {
                        call: id.to_string(),
                        parent: None,
                        name,
                        kind,
                    },
                );
                push(
                    &mut out,
                    started,
                    Event::ToolInput {
                        call: id.to_string(),
                        parent: None,
                        delta: None,
                        input: Some(input),
                        truncated: false,
                    },
                );
                if item["status"] == "inProgress" {
                    open.push(id.to_string());
                    continue;
                }
                let (output, error, changes) = finished(item, kind, folder);
                push(
                    &mut out,
                    ended,
                    Event::ToolFinished {
                        call: id.to_string(),
                        parent: None,
                        output,
                        error,
                        truncated: false,
                        changes,
                    },
                );
            }
        }
    }
    let status = turn["status"].as_str();
    let running = matches!(status, Some("inProgress" | "interrupted"))
        && turn["completedAt"].as_u64().is_none_or(|at| at == 0);
    if last && running {
        return out;
    }
    let end = seconds(turn, "completedAt").map_or(now, |at| at.max(now));
    for call in open {
        push(
            &mut out,
            end,
            Event::ToolFinished {
                call,
                parent: None,
                output: String::new(),
                error: true,
                truncated: false,
                changes: vec![],
            },
        );
    }
    let outcome = match status {
        Some("completed") => Outcome::Done,
        Some("interrupted" | "inProgress") => Outcome::Interrupted,
        _ => Outcome::Failed,
    };
    let error = (outcome == Outcome::Failed).then(|| {
        let error = &turn["error"];
        match (
            error["message"].as_str(),
            error["additionalDetails"].as_str(),
        ) {
            (Some(message), Some(details)) if !details.is_empty() => {
                format!("{message}: {details}")
            }
            (Some(message), _) => message.to_string(),
            _ => "the turn failed".to_string(),
        }
    });
    push(
        &mut out,
        end,
        Event::TurnEnded {
            outcome,
            error,
            total_cost_usd: None,
            duration_ms: turn["durationMs"].as_u64(),
            usage: None,
        },
    );
    out
}

/// A `codex app-server` started for one read, ended when it is dropped.
pub(crate) struct AppServer {
    process: ShortLived,
    next: i64,
}

impl AppServer {
    /// Starts the Codex on the PATH of `env` under the account's home
    /// where one is given, in `folder`, or where that is gone, in the
    /// system's temporary folder. Every wait on it ends by `deadline`.
    pub(crate) fn start(
        env: &HashMap<String, String>,
        config_dir: Option<&Path>,
        folder: &Path,
        deadline: Instant,
    ) -> Result<Self, String> {
        let binary =
            find_on_path(env, "codex").ok_or_else(|| "codex is not on your PATH".to_string())?;
        let mut command = process(&binary, env);
        // Codex syncs its plugins when it starts, which runs git and leaves
        // a folder in its home each time; a read has no use for them.
        command.args(["app-server", "-c", "features.plugins=false"]);
        // Codex reads the folder it runs in only for a project's own
        // settings, so one that is gone takes nothing from the read.
        let folder = if folder.is_dir() {
            folder.to_path_buf()
        } else {
            std::env::temp_dir()
        };
        prepare_process(&mut command, &folder, env);
        if let Some(dir) = config_dir {
            command.env(CODEX_HOME_VAR, dir);
        }
        let process = ShortLived::start(command, deadline, answered)
            .map_err(|e| format!("codex could not be started: {e}"))?;
        Ok(Self { process, next: 0 })
    }

    /// The handshake every client begins with.
    pub(crate) fn introduce(&mut self) -> Result<(), String> {
        let answer = self.ask(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "agent-workbench",
                    "title": "Chord",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": { "experimentalApi": false },
            }),
        );
        match answer {
            Answer::Result(_) => self.write(&json!({ "method": "initialized" }).to_string()),
            Answer::Refused(error) | Answer::Gone(error) => {
                Err(format!("Codex would not begin: {error}"))
            }
            Answer::TooLong => Err("Codex would not begin".into()),
        }
    }

    fn write(&mut self, line: &str) -> Result<(), String> {
        self.process
            .write(line)
            .map_err(|e| format!("could not write to codex: {e}"))
    }
}

impl Ask for AppServer {
    fn ask(&mut self, method: &str, params: Value) -> Answer {
        self.next += 1;
        let id = self.next;
        let line = json!({ "id": id, "method": method, "params": params }).to_string();
        if let Err(error) = self.write(&line) {
            return Answer::Gone(error);
        }
        loop {
            let text = match self.process.next() {
                Ok(Line::Long(Some(of))) if of == id => return Answer::TooLong,
                Ok(Line::Long(_)) => continue,
                Ok(Line::Whole(text)) => text,
                Err(Gone::Late) => return Answer::Gone("Codex did not answer in time".into()),
                Err(Gone::Ended) => return Answer::Gone("Codex ended before it answered".into()),
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            match (value.get("id"), value["method"].as_str()) {
                // A request of Codex's own is not this read's to answer.
                (Some(asked), Some(method)) => {
                    let _ = self.write(&turned_down(asked, method));
                }
                (Some(answered), None) if answered.as_i64() == Some(id) => {
                    return match value.get("error") {
                        Some(error) => Answer::Refused(
                            error["message"]
                                .as_str()
                                .map_or_else(|| error.to_string(), str::to_string),
                        ),
                        None => Answer::Result(value["result"].clone()),
                    };
                }
                _ => {}
            }
        }
    }
}

/// The id of the request a line answers, from its start: Codex writes an
/// answer's id first.
fn answered(head: &[u8]) -> Option<i64> {
    let head = String::from_utf8_lossy(head);
    let rest = head.strip_prefix("{\"id\":")?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let after = rest[digits.len()..].chars().next();
    (after == Some(',')).then(|| digits.parse().ok()).flatten()
}

#[cfg(test)]
#[path = "codex_history_tests.rs"]
mod tests;
