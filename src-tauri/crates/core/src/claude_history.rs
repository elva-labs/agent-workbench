//! What a Claude Code session said and did before, read from its transcript.
//!
//! The transcript is the agent's own record of a conversation, and its entry
//! format "is internal to Claude Code and changes between versions". So the
//! reading is kept here, apart from the rest, and reads defensively, as the
//! title reader does: an entry it cannot read is skipped, never an error; a
//! line that is not whole, such as the last of a transcript still being
//! written, is skipped; a line past a size limit is passed over without
//! being held; nothing past the file's length when it was opened is read,
//! so a transcript that grows meanwhile never holds the reader; only the end
//! of a very long transcript is read; and it is read twice, once for where
//! each line stands in the conversation and once for what the lines it keeps
//! say, so that no more than what is kept is held at once.
//!
//! What it reads comes out as the events a live session sends, each with the
//! time it happened, so that a window draws a past conversation the way it
//! draws a live one, and can tell what it heard live from what it read.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::claude_stream::{file_changes, steps, text_of, tool_kind, PLAN_TOOL, TODO_TOOL};
use crate::integrated::{
    CompactReason, Event, History, Image, MessageState, Outcome, Said, ToolKind,
};
use crate::transcripts::mangle;

/// A line longer than this is passed over.
#[cfg(not(test))]
const LINE_KEEP: usize = 32 * 1024 * 1024;
#[cfg(test)]
const LINE_KEEP: usize = 64 * 1024;
/// The most of a transcript read: of a longer one, its end.
#[cfg(not(test))]
const FILE_KEEP: u64 = 512 * 1024 * 1024;
#[cfg(test)]
const FILE_KEEP: u64 = 256 * 1024;
/// How deep subagents that started subagents are followed.
const DEPTH: usize = 3;
/// A subagent's description of itself is a few lines.
const META_KEEP: u64 = 64 * 1024;

/// What the session with this id said and did, from its transcript under
/// the account's configuration directory. Empty when there is none.
pub fn read_session(
    claude_dir: &Path,
    project: &Path,
    cwd: Option<&Path>,
    session: &str,
) -> History {
    find(claude_dir, project, cwd, session)
        .map(|path| read(&path))
        .unwrap_or_default()
}

/// The transcript of a session. Claude Code files a session under the
/// folder it ran in, which is the project or a folder under it, and a
/// session resumed in another folder is written there again under the same
/// id: the copy that moved last is the one read. Only a plain file is read,
/// so nothing that would wait to be opened is, and a project with no path
/// names none.
pub fn find(
    claude_dir: &Path,
    project: &Path,
    cwd: Option<&Path>,
    session: &str,
) -> Option<PathBuf> {
    if project.as_os_str().is_empty()
        || session.is_empty()
        || !session
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    let own = mangle(project);
    let under = format!("{own}-");
    let ran = cwd.map(mangle);
    let file = format!("{session}.jsonl");
    std::fs::read_dir(claude_dir.join("projects"))
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name == own || name.starts_with(&under) || ran.as_ref() == Some(&name)
        })
        .filter_map(|entry| {
            let path = entry.path().join(&file);
            let meta = std::fs::metadata(&path).ok()?;
            meta.is_file().then(|| (meta.modified().ok(), path))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

/// What one transcript says was said and done. The first reading finds
/// which lines make up the conversation from their ids alone; the second
/// reads those lines, each made into its events and let go before the next.
pub fn read(path: &Path) -> History {
    let found = survey(path);
    let Some(span) = found.span else {
        return History::default();
    };
    let partial = span.start > 0;
    let kept = conversation(&found.placed, &found.parents, partial);
    let mut reader = Reader::new(Subagents::beside(path));
    let mut index = 0;
    lines(path, Some(span), |line| {
        let at = index;
        index += 1;
        let Some(&only_results) = kept.get(&at) else {
            return;
        };
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        if only_results && results(&value).next().is_none() {
            return;
        }
        reader.main(&value);
    });
    let mut history = reader.finish(modified_millis(path));
    history.cut |= partial;
    history
}

/// A line of a transcript that may say something, by where it stands among
/// the lines read, with the two ids that place it in the conversation.
struct Placed {
    index: usize,
    uuid: Option<String>,
    parent: Option<String>,
}

/// What every line is read for first, without holding the rest of it.
#[derive(Deserialize)]
struct Head {
    #[serde(rename = "type", default)]
    kind: Field,
    #[serde(default)]
    uuid: Field,
    #[serde(rename = "parentUuid", default)]
    parent: Field,
    #[serde(rename = "logicalParentUuid", default)]
    logical: Field,
    #[serde(rename = "isSidechain", default)]
    sidechain: Field,
}

/// A field as a line has it: not there, or there with any value, null
/// among them.
#[derive(Default)]
struct Field(Option<Value>);

impl<'de> Deserialize<'de> for Field {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Value::deserialize(deserializer).map(|value| Field(Some(value)))
    }
}

impl Field {
    fn string(&self) -> Option<String> {
        match &self.0 {
            Some(Value::String(text)) => Some(text.clone()),
            _ => None,
        }
    }
}

/// What a line says comes before it.
enum Link {
    /// Nothing: it begins the conversation.
    Root,
    To(String),
    /// It does not say.
    Unknown,
}

impl Link {
    /// A parent given as null begins the conversation, unless it names the
    /// one it logically follows, as the line after a compaction does.
    fn of(head: &Head) -> Self {
        match (&head.parent.0, head.logical.string()) {
            (Some(Value::String(parent)), _) => Link::To(parent.clone()),
            (Some(Value::Null), Some(logical)) => Link::To(logical),
            (Some(Value::Null), None) => Link::Root,
            _ => Link::Unknown,
        }
    }
}

struct Found {
    /// The lines that can say something: the user's, the agent's, the
    /// system's and attachments, the side chain left out.
    placed: Vec<Placed>,
    /// Every line's parent by its id, entries or not, so the conversation
    /// can be followed through lines that say nothing.
    parents: HashMap<String, Link>,
    /// What was read, none for a file that could not be.
    span: Option<Span>,
}

/// Where each line of a transcript stands, from what every line is read for
/// first, with nothing else of it held.
fn survey(path: &Path) -> Found {
    let mut parents = HashMap::new();
    let mut placed = Vec::new();
    let mut index = 0;
    let span = lines(path, None, |line| {
        let at = index;
        index += 1;
        let Ok(head) = serde_json::from_slice::<Head>(line) else {
            return;
        };
        let uuid = head.uuid.string();
        let link = Link::of(&head);
        let parent = match &link {
            Link::To(parent) => Some(parent.clone()),
            _ => None,
        };
        if let Some(uuid) = &uuid {
            parents.insert(uuid.clone(), link);
        }
        if !matches!(
            head.kind.string().as_deref(),
            Some("user" | "assistant" | "system" | "attachment")
        ) {
            return;
        }
        if head.sidechain.0 == Some(Value::Bool(true)) {
            return;
        }
        placed.push(Placed {
            index: at,
            uuid,
            parent,
        });
    });
    Found {
        placed,
        parents,
        span,
    }
}

/// The bytes of a file that are read: of a very long file, its end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Span {
    start: u64,
    end: u64,
}

/// Hands each whole line of the file to `each`, past a line too long to
/// hold: of `span`, or of the length the file had when it was opened, or
/// of the end of that. Answers what was read, so a second reading reads the
/// same lines; none for a file that is not a plain file, which is not
/// opened, or that could not be read.
fn lines(path: &Path, span: Option<Span>, mut each: impl FnMut(&[u8])) -> Option<Span> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let span = span.unwrap_or_else(|| Span {
        start: meta.len().saturating_sub(FILE_KEEP),
        end: meta.len(),
    });
    if span.start > 0 && file.seek(SeekFrom::Start(span.start)).is_err() {
        return None;
    }
    let mut reader =
        BufReader::with_capacity(256 * 1024, file.take(span.end.saturating_sub(span.start)));
    let mut line = Vec::new();
    // Read from the middle, the first line is the end of one.
    let mut piece = span.start > 0;
    let mut over = false;
    loop {
        let (ended, used) = {
            let buffer = match reader.fill_buf() {
                Ok(buffer) => buffer,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            if buffer.is_empty() {
                break;
            }
            let found = buffer.iter().position(|&byte| byte == b'\n');
            let part = &buffer[..found.unwrap_or(buffer.len())];
            if !over {
                if line.len() + part.len() > LINE_KEEP {
                    over = true;
                    line = Vec::new();
                } else {
                    line.extend_from_slice(part);
                }
            }
            (found.is_some(), part.len() + usize::from(found.is_some()))
        };
        reader.consume(used);
        if ended {
            if !over && !piece {
                each(&line);
            }
            line.clear();
            over = false;
            piece = false;
        }
    }
    // A last line with no end may still be being written; it is read only
    // if it is whole, which reading it as JSON tells.
    if !over && !piece && !line.is_empty() {
        each(&line);
    }
    Some(span)
}

/// The entries that make up the conversation as it stands. A transcript
/// can hold turns the user went back on, which branch off it: the
/// conversation is the line from the last entry back through each one's
/// parent to the first, with the results of the calls the agent made at
/// once, which each hang off their call. Where that line breaks off, at a
/// parent the transcript does not hold, every entry is kept in the order
/// written. Answers the lines kept by where they stand, each saying whether
/// it is kept only if it holds tool results, which its ids cannot tell.
fn conversation(
    placed: &[Placed],
    parents: &HashMap<String, Link>,
    partial: bool,
) -> HashMap<usize, bool> {
    let every = || placed.iter().map(|entry| (entry.index, false)).collect();
    if partial {
        return every();
    }
    let Some(leaf) = placed.iter().rev().find_map(|entry| entry.uuid.clone()) else {
        return every();
    };
    let mut line = HashSet::new();
    let mut at = Some(leaf);
    let mut whole = false;
    while let Some(uuid) = at {
        if !line.insert(uuid.clone()) {
            break;
        }
        at = match parents.get(&uuid) {
            Some(Link::To(parent)) => Some(parent.clone()),
            Some(Link::Root) => {
                whole = true;
                None
            }
            Some(Link::Unknown) | None => None,
        };
    }
    if !whole {
        return every();
    }
    placed
        .iter()
        .filter_map(|entry| match &entry.uuid {
            Some(uuid) if line.contains(uuid) => Some((entry.index, false)),
            _ => entry
                .parent
                .as_ref()
                .filter(|parent| line.contains(*parent))
                .map(|_| (entry.index, true)),
        })
        .collect()
}

/// The tool results a user entry carries.
fn results(entry: &Value) -> impl Iterator<Item = &Value> {
    entry["message"]["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == "tool_result")
}

fn flagged(entry: &Value, key: &str) -> bool {
    entry[key] == true
}

/// The subagents a session started, each with a transcript of its own in a
/// folder beside the session's, found by the call that started it.
struct Subagents {
    folder: PathBuf,
    by_call: Option<HashMap<String, PathBuf>>,
}

impl Subagents {
    fn beside(transcript: &Path) -> Self {
        Self {
            folder: transcript.with_extension("").join("subagents"),
            by_call: None,
        }
    }

    fn of(&mut self, call: &str) -> Option<PathBuf> {
        let folder = &self.folder;
        self.by_call
            .get_or_insert_with(|| described(folder))
            .get(call)
            .cloned()
    }
}

/// Each subagent's transcript in the folder, by the call that started it,
/// as the description beside it names it.
fn described(folder: &Path) -> HashMap<String, PathBuf> {
    let mut found = HashMap::new();
    let Ok(listed) = std::fs::read_dir(folder) else {
        return found;
    };
    for entry in listed.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(stem) = name.strip_suffix(".meta.json") else {
            continue;
        };
        let path = entry.path();
        let small =
            std::fs::metadata(&path).is_ok_and(|meta| meta.is_file() && meta.len() <= META_KEEP);
        if !small {
            continue;
        }
        let Some(call) = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|meta| meta["toolUseId"].as_str().map(str::to_string))
        else {
            continue;
        };
        found.insert(call, folder.join(format!("{stem}.jsonl")));
    }
    found
}

/// A turn as it is read, until its end.
struct Turn {
    /// Where its start is among the items, to give it its model once known.
    start: usize,
    model: bool,
    /// The agent has said or done something in it.
    spoken: bool,
    /// Calls of the main conversation started and not finished.
    open: Vec<String>,
    interrupted: bool,
    duration: Option<u64>,
    /// The record says it is over: the agent stopped of its own accord, or
    /// how long the turn took was noted.
    over: bool,
}

/// What a user entry says, as the conversation shows it.
enum Prompt {
    /// The user's words, with any images.
    Said { text: String, images: Vec<Image> },
    /// The user interrupted the turn.
    Interrupted,
    /// Something the agent was told by itself, such as that background work
    /// finished: a turn it began, with no message behind it.
    Begun,
    /// Nothing the conversation shows.
    Nothing,
}

struct Reader {
    items: Vec<Said>,
    /// When the entry being read happened.
    at: u64,
    turn: Option<Turn>,
    /// How many blocks each message of the agent's has had, to number the
    /// next where the entry does not.
    blocks: HashMap<String, u64>,
    subagents: Subagents,
}

impl Reader {
    fn new(subagents: Subagents) -> Self {
        Self {
            items: Vec::new(),
            at: 0,
            turn: None,
            blocks: HashMap::new(),
            subagents,
        }
    }

    fn push(&mut self, event: Event) {
        self.items.push(Said {
            at: self.at,
            model: None,
            event: History::kept(event),
        });
    }

    fn when(&mut self, entry: &Value) {
        if let Some(at) = entry["timestamp"].as_str().and_then(millis) {
            self.at = at;
        }
    }

    /// An entry of the main conversation: a turn, a message of the user's,
    /// or what the agent said and did in one.
    fn main(&mut self, value: &Value) {
        self.when(value);
        let uuid = value["uuid"].as_str();
        match value["type"].as_str() {
            Some("user") => self.user(value, uuid),
            Some("assistant") => self.assistant(value, None, 0, &mut Vec::new()),
            Some("system") => self.system(value),
            Some("attachment") => self.attachment(value, uuid),
            _ => {}
        }
    }

    fn begin(&mut self, messages: Vec<String>) {
        self.end();
        let start = self.items.len();
        self.push(Event::TurnStarted { messages });
        self.turn = Some(Turn {
            start,
            model: false,
            spoken: false,
            open: Vec::new(),
            interrupted: false,
            duration: None,
            over: false,
        });
    }

    /// Ends the turn being read: a call it left without a finish failed,
    /// as the core says of a live one.
    fn end(&mut self) {
        let Some(turn) = self.turn.take() else {
            return;
        };
        for call in turn.open {
            self.push(failed(call, None));
        }
        self.push(Event::TurnEnded {
            outcome: if turn.interrupted {
                Outcome::Interrupted
            } else {
                Outcome::Done
            },
            error: None,
            total_cost_usd: None,
            duration_ms: turn.duration,
            usage: None,
        });
    }

    /// A message of the user's starts a turn, or joins the one it opened
    /// when the agent has said nothing in it yet.
    fn said(&mut self, id: String, text: String, images: Vec<Image>) {
        if self
            .turn
            .as_ref()
            .is_some_and(|turn| !turn.spoken && !turn.over)
        {
            self.push(Event::Message {
                message: id,
                state: MessageState::Taken,
                error: None,
                text: Some(text),
                images,
            });
            return;
        }
        self.end();
        self.push(Event::Message {
            message: id.clone(),
            state: MessageState::Sent,
            error: None,
            text: Some(text),
            images,
        });
        self.begin(vec![id]);
    }

    fn user(&mut self, entry: &Value, uuid: Option<&str>) {
        if flagged(entry, "isMeta")
            || flagged(entry, "isCompactSummary")
            || flagged(entry, "isVisibleInTranscriptOnly")
        {
            return;
        }
        if results(entry).next().is_some() {
            let mut open = self
                .turn
                .as_mut()
                .map(|turn| std::mem::take(&mut turn.open))
                .unwrap_or_default();
            self.finished(entry, None, &mut open);
            if let Some(turn) = &mut self.turn {
                turn.open = open;
                turn.over = false;
            }
            return;
        }
        match prompt(
            &entry["message"]["content"],
            entry["origin"]["kind"].as_str(),
        ) {
            Prompt::Said { text, images } => {
                let id = uuid.map_or_else(|| format!("said-{}", self.items.len()), str::to_string);
                self.said(id, text, images);
            }
            Prompt::Interrupted => {
                if let Some(turn) = &mut self.turn {
                    turn.interrupted = true;
                    turn.over = true;
                }
            }
            Prompt::Begun => self.begin(Vec::new()),
            Prompt::Nothing => {}
        }
    }

    /// The tool results in a user entry finish their calls.
    fn finished(&mut self, entry: &Value, parent: Option<&str>, open: &mut Vec<String>) {
        let all: Vec<&Value> = results(entry).collect();
        // The structured result is the entry's, so it belongs to its only
        // tool result.
        let structured = if entry["toolUseResult"].is_null() {
            &entry["tool_use_result"]
        } else {
            &entry["toolUseResult"]
        };
        let single = all.len() == 1;
        for block in all {
            let Some(call) = block["tool_use_id"].as_str() else {
                continue;
            };
            open.retain(|known| known != call);
            self.push(Event::ToolFinished {
                call: call.to_string(),
                parent: parent.map(str::to_string),
                output: text_of(&block["content"]),
                error: block["is_error"] == true,
                truncated: false,
                changes: if single {
                    file_changes(structured)
                } else {
                    vec![]
                },
            });
        }
    }

    /// What the agent said and did in one entry: its text, its thinking and
    /// the calls it made, under `parent` for a subagent's.
    fn assistant(
        &mut self,
        entry: &Value,
        parent: Option<&str>,
        depth: usize,
        open: &mut Vec<String>,
    ) {
        let message = &entry["message"];
        let Some(blocks) = message["content"].as_array() else {
            return;
        };
        if parent.is_none() {
            if self.turn.is_none() {
                self.begin(Vec::new());
            }
            let model = message["model"]
                .as_str()
                .filter(|model| !model.is_empty() && !model.starts_with('<'));
            if let (Some(turn), Some(model)) = (&mut self.turn, model) {
                if !turn.model {
                    turn.model = true;
                    self.items[turn.start].model = Some(model.to_string());
                }
            }
        }
        let id = message["id"]
            .as_str()
            .or_else(|| entry["uuid"].as_str())
            .unwrap_or_default()
            .to_string();
        let given = entry["apiBlockIndex"]
            .as_u64()
            .filter(|_| blocks.len() == 1);
        let mut main_open = if parent.is_none() {
            self.turn
                .as_mut()
                .map(|turn| std::mem::take(&mut turn.open))
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let calls = if parent.is_none() {
            &mut main_open
        } else {
            open
        };
        let owner = parent.map(str::to_string);
        let mut spoke = false;
        for block in blocks {
            let next = self.blocks.entry(id.clone()).or_insert(0);
            let index = given.unwrap_or(*next);
            *next = index + 1;
            let block_id = format!("{id}#{index}");
            match block["type"].as_str() {
                Some("text") => {
                    let text = block["text"].as_str().unwrap_or_default();
                    if text.trim().is_empty() {
                        continue;
                    }
                    self.push(Event::Text {
                        block: block_id,
                        parent: owner.clone(),
                        text: text.to_string(),
                        done: true,
                    });
                }
                Some("thinking") => {
                    let thinking = block["thinking"].as_str().unwrap_or_default();
                    if thinking.trim().is_empty() {
                        continue;
                    }
                    self.push(Event::Thinking {
                        block: block_id,
                        parent: owner.clone(),
                        text: thinking.to_string(),
                        done: true,
                    });
                }
                Some("tool_use") => {
                    let Some(call) = block["id"].as_str() else {
                        continue;
                    };
                    let name = block["name"].as_str().unwrap_or_default();
                    let input = &block["input"];
                    self.push(Event::ToolStarted {
                        call: call.to_string(),
                        parent: owner.clone(),
                        name: name.to_string(),
                        kind: tool_kind(name),
                    });
                    self.push(Event::ToolInput {
                        call: call.to_string(),
                        parent: owner.clone(),
                        delta: None,
                        input: Some(input.clone()),
                        truncated: false,
                    });
                    if name == TODO_TOOL {
                        self.push(Event::Plan {
                            call: Some(call.to_string()),
                            parent: owner.clone(),
                            text: None,
                            steps: steps(input),
                        });
                    }
                    if name == PLAN_TOOL {
                        if let Some(plan) = input["plan"].as_str() {
                            self.push(Event::Plan {
                                call: Some(call.to_string()),
                                parent: owner.clone(),
                                text: Some(plan.to_string()),
                                steps: vec![],
                            });
                        }
                    }
                    calls.push(call.to_string());
                    if tool_kind(name) == ToolKind::Agent && depth < DEPTH {
                        self.subagent(call, depth + 1);
                    }
                }
                _ => continue,
            }
            spoke = true;
        }
        if parent.is_none() {
            if let Some(turn) = &mut self.turn {
                turn.open = main_open;
                turn.spoken |= spoke;
                // A message the agent ended for any reason of its own, with
                // no call to wait on, is where its turn ends.
                turn.over = message["stop_reason"]
                    .as_str()
                    .is_some_and(|reason| reason != "tool_use")
                    && turn.open.is_empty();
            }
        }
    }

    /// What a subagent said and did, under the call that started it, from
    /// its own transcript. A call it left without a finish failed when it
    /// ended.
    fn subagent(&mut self, call: &str, depth: usize) {
        let Some(path) = self.subagents.of(call) else {
            return;
        };
        let at = self.at;
        let mut open = Vec::new();
        lines(&path, None, |line| {
            let Ok(value) = serde_json::from_slice::<Value>(line) else {
                return;
            };
            self.when(&value);
            match value["type"].as_str() {
                Some("assistant") => self.assistant(&value, Some(call), depth, &mut open),
                Some("user") => self.finished(&value, Some(call), &mut open),
                _ => {}
            }
        });
        for left in open {
            self.push(failed(left, Some(call)));
        }
        self.at = at;
    }

    fn system(&mut self, entry: &Value) {
        match entry["subtype"].as_str() {
            Some("compact_boundary") => {
                let meta = if entry["compactMetadata"].is_object() {
                    &entry["compactMetadata"]
                } else {
                    &entry["compact_metadata"]
                };
                // A compaction after a turn that is over stands between it
                // and the next.
                if self.turn.as_ref().is_some_and(|turn| turn.over) {
                    self.end();
                }
                self.push(Event::Compacted {
                    reason: match meta["trigger"].as_str() {
                        Some("manual") => Some(CompactReason::Asked),
                        Some("auto") => Some(CompactReason::Full),
                        _ => None,
                    },
                    tokens_before: meta["preTokens"]
                        .as_u64()
                        .or_else(|| meta["pre_tokens"].as_u64()),
                    tokens_after: meta["postTokens"]
                        .as_u64()
                        .or_else(|| meta["post_tokens"].as_u64()),
                });
            }
            Some("turn_duration") => {
                if let Some(turn) = &mut self.turn {
                    turn.duration = entry["durationMs"].as_u64().or(turn.duration);
                    turn.over = true;
                }
            }
            Some("stop_hook_summary") => {
                if let Some(turn) = &mut self.turn {
                    turn.over = true;
                }
            }
            _ => {}
        }
    }

    /// A message the user sent while the agent worked, which it took into
    /// the turn it was in.
    fn attachment(&mut self, entry: &Value, uuid: Option<&str>) {
        let attached = &entry["attachment"];
        if attached["type"] != "queued_command" || flagged(entry, "isMeta") {
            return;
        }
        if attached["commandMode"]
            .as_str()
            .is_some_and(|mode| mode != "prompt")
        {
            return;
        }
        let Prompt::Said { text, images } =
            prompt(&attached["prompt"], attached["origin"]["kind"].as_str())
        else {
            return;
        };
        let Some(id) = attached["source_uuid"]
            .as_str()
            .or(uuid)
            .map(str::to_string)
        else {
            return;
        };
        match &self.turn {
            Some(_) => self.push(Event::Message {
                message: id,
                state: MessageState::Taken,
                error: None,
                text: Some(text),
                images,
            }),
            None => self.said(id, text, images),
        }
    }

    /// The history, with the last turn left open unless the record says it
    /// is over, a time for each item, and no more than it may hold.
    fn finish(mut self, fallback: u64) -> History {
        if self
            .turn
            .as_ref()
            .is_some_and(|turn| turn.over || turn.interrupted)
        {
            self.end();
        }
        let first = self
            .items
            .iter()
            .map(|said| said.at)
            .find(|at| *at > 0)
            .unwrap_or(fallback);
        for said in &mut self.items {
            if said.at == 0 {
                said.at = first;
            }
        }
        let mut history = History {
            items: self.items,
            cut: false,
        };
        keep_within(&mut history);
        history
    }
}

/// A call that ended with no finish of its own.
fn failed(call: String, parent: Option<&str>) -> Event {
    Event::ToolFinished {
        call,
        parent: parent.map(str::to_string),
        output: String::new(),
        error: true,
        truncated: false,
        changes: vec![],
    }
}

/// What a user's message says: its words with the agent's own reminders
/// left out, its images, and the commands it ran by name. A message with
/// an origin other than the user is a turn the agent began.
fn prompt(content: &Value, origin: Option<&str>) -> Prompt {
    let mut texts = Vec::new();
    let mut images = Vec::new();
    match content {
        Value::String(text) => texts.push(text.as_str()),
        Value::Array(blocks) => {
            for block in blocks {
                match block["type"].as_str() {
                    Some("text") => {
                        if let Some(text) = block["text"].as_str() {
                            if !text.trim_start().starts_with("<system-reminder>") {
                                texts.push(text);
                            }
                        }
                    }
                    Some("image") => {
                        let source = &block["source"];
                        if let (Some("base64"), Some(kind), Some(data)) = (
                            source["type"].as_str(),
                            source["media_type"].as_str(),
                            source["data"].as_str(),
                        ) {
                            images.push(Image {
                                media_type: kind.to_string(),
                                data: data.to_string(),
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => return Prompt::Nothing,
    }
    let text = texts.join("\n");
    let trimmed = text.trim();
    if trimmed.starts_with("[Request interrupted by user") {
        return Prompt::Interrupted;
    }
    if origin.is_some_and(|kind| kind != "human") || trimmed.starts_with("<task-notification>") {
        return Prompt::Begun;
    }
    if trimmed.starts_with("<local-command-") {
        return Prompt::Nothing;
    }
    if let Some(name) = between(trimmed, "<command-name>", "</command-name>") {
        // Compacting shows as the compaction itself.
        if name == "/compact" {
            return Prompt::Nothing;
        }
        let args = between(trimmed, "<command-args>", "</command-args>").unwrap_or_default();
        return Prompt::Said {
            text: format!("{name} {args}").trim().to_string(),
            images,
        };
    }
    if trimmed.is_empty() && images.is_empty() {
        return Prompt::Nothing;
    }
    Prompt::Said { text, images }
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let end = text[start..].find(close)? + start;
    Some(text[start..end].trim())
}

/// Leaves out the first turns of a history longer than it may hold, so
/// that what is left starts where a turn does. The last turn is kept
/// whatever its size, each of its items being cut down already.
fn keep_within(history: &mut History) {
    // How much the items before each one take.
    let mut before = Vec::with_capacity(history.items.len() + 1);
    let mut total = 0;
    for said in &history.items {
        before.push(total);
        total += said.size();
    }
    if total <= History::KEEP {
        return;
    }
    // Where a turn starts: at the message it answers, or at its start.
    let starts: Vec<usize> = history
        .items
        .iter()
        .enumerate()
        .filter(|(_, said)| matches!(said.event, Event::TurnStarted { .. }))
        .map(|(at, _)| {
            let message = at > 0
                && matches!(
                    history.items[at - 1].event,
                    Event::Message {
                        state: MessageState::Sent,
                        ..
                    }
                );
            if message {
                at - 1
            } else {
                at
            }
        })
        .collect();
    let from = starts
        .iter()
        .copied()
        .find(|&start| total - before[start] <= History::KEEP)
        .or_else(|| starts.last().copied())
        .unwrap_or(0);
    if from > 0 {
        history.items.drain(..from);
        history.cut = true;
    }
}

/// When the file was last written, in milliseconds since the epoch.
fn modified_millis(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_millis() as u64)
}

/// A time as the transcript writes it, `2026-03-04T05:06:07.890Z` or with
/// an offset, in milliseconds since the epoch.
fn millis(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    if bytes.len() < 19
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't' | b' ')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let number = |from: usize, to: usize| -> Option<i64> {
        let digits = text.get(from..to)?;
        digits
            .bytes()
            .all(|byte| byte.is_ascii_digit())
            .then(|| digits.parse().ok())?
    };
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    // What follows the seconds is read by byte, so only plain characters
    // are taken there.
    let mut rest = &text[19..];
    if !rest.is_ascii() {
        return None;
    }
    let mut fraction = 0;
    if let Some(after) = rest.strip_prefix('.') {
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let first: String = after[..digits.min(3)].chars().collect();
        fraction = format!("{first:0<3}").parse().ok()?;
        rest = &after[digits..];
    }
    let offset = match rest {
        "" | "Z" | "z" => 0,
        zone if zone.len() == 6 && matches!(&zone[..1], "+" | "-") && &zone[3..4] == ":" => {
            let hours: i64 = zone[1..3].parse().ok()?;
            let minutes: i64 = zone[4..6].parse().ok()?;
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            sign * (hours * 60 + minutes)
        }
        _ => return None,
    };
    let seconds =
        days(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second - offset * 60;
    u64::try_from(seconds * 1000 + fraction).ok()
}

/// Days from 1970-01-01 to a date of the proleptic Gregorian calendar.
fn days(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let of_era = year - era * 400;
    let of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let of_cycle = of_era * 365 + of_era / 4 - of_era / 100 + of_year;
    era * 146_097 + of_cycle - 719_468
}

#[cfg(test)]
#[path = "claude_history_tests.rs"]
mod tests;
