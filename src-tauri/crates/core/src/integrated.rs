//! Integrated sessions: an agent run as a process the core talks to in
//! messages, with no terminal, while the window draws the conversation.
//!
//! Everything here is agent-neutral. What an agent's own protocol looks
//! like, the command line that starts it and the lines it reads and writes,
//! sits behind [`Protocol`] and [`Driver`], one of each per agent, kept apart
//! the way the transcript readers are: a line the driver cannot read is
//! skipped, and whatever goes wrong comes out as an [`Event::Error`] and a
//! session that ends, never a panic or a wait without end.
//!
//! A session is a child process with three threads beside it: one writes
//! the lines queued for its stdin, one reads its stdout a line at a time,
//! and one waits for it to end. Every line read goes through the driver,
//! which turns it into [`Event`]s, and through the [`Tracker`], which
//! derives the session's state from those events. Both sit behind one lock,
//! so the events leave in the order the lines came, and a line written by a
//! command is queued under the same lock as the state it changes.
//!
//! Events reach the window through the [`Sink`] as [`INTEGRATED_EVENT`],
//! each carrying the id of the session it belongs to.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::events::{self, Sink};

/// The one event name every integrated session's news goes out under.
pub const INTEGRATED_EVENT: &str = "integrated_event";

/// How long the agent has to say what it is after it starts. It loads its
/// MCP servers first, which can take a while over a slow network.
#[cfg(not(test))]
const READY_TIMEOUT: Duration = Duration::from_secs(90);
#[cfg(test)]
const READY_TIMEOUT: Duration = Duration::from_secs(3);

/// How long a line may wait to be taken by the agent before the session is
/// taken to be stuck. A pipe holds tens of kilobytes, so a line waits only
/// when the agent has stopped reading.
#[cfg(not(test))]
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(test)]
const WRITE_TIMEOUT: Duration = Duration::from_secs(3);

/// How long the agent has to answer a control request: an interrupt, a
/// model or a permission mode.
#[cfg(not(test))]
const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(test)]
const CONTROL_TIMEOUT: Duration = Duration::from_millis(2500);

/// How long a change of settings has in all, however many requests it
/// takes: less than a call to another machine is given, so that one
/// answers before the call gives up on it.
#[cfg(not(test))]
const CONFIGURE_TIMEOUT: Duration = Duration::from_secs(45);
#[cfg(test)]
const CONFIGURE_TIMEOUT: Duration = Duration::from_secs(3);

/// How long a stopped session has to end once its stdin is closed before it
/// is asked to end.
const STOP_GRACE: Duration = Duration::from_secs(5);

/// How long an agent asked to end has before it is killed with its group.
#[cfg(not(test))]
const TERM_GRACE: Duration = Duration::from_secs(3);
#[cfg(test)]
const TERM_GRACE: Duration = Duration::from_secs(1);

/// How long what the agent left in its process group has, once asked to
/// end with the agent gone, before it is killed.
#[cfg(not(test))]
const GROUP_GRACE: Duration = Duration::from_secs(1);
#[cfg(test)]
const GROUP_GRACE: Duration = Duration::from_millis(500);

/// How often the waiter looks at the child between kill requests.
const POLL: Duration = Duration::from_millis(50);

/// How long the end of a session waits for the last of its output to be
/// read. Bounded, since a grandchild can hold the pipe open.
const DRAIN: Duration = Duration::from_secs(2);

/// The tail of stderr kept to explain a session that ended badly.
const STDERR_KEEP: usize = 4096;

/// The longest line read from the agent. The rest of a longer one is
/// skipped, and said to be.
#[cfg(not(test))]
const LINE_KEEP: usize = 8 * 1024 * 1024;
#[cfg(test)]
const LINE_KEEP: usize = 1024 * 1024;

/// The most of a tool call's output, and of each string in its input,
/// passed on to the window.
const OUTPUT_KEEP: usize = 64 * 1024;

/// The most of a changed file, a turn's diff, or a tool call's streamed
/// input or output, passed on to the window.
const CONTENT_KEEP: usize = 256 * 1024;

/// How much of a session's news may wait for a slow window or connection
/// before streamed pieces are left out of it.
#[cfg(not(test))]
const OUTBOX_PIECES: usize = 1024;
#[cfg(test)]
const OUTBOX_PIECES: usize = 16;

/// How much may wait before the agent's lines are no longer read, which in
/// time stops the agent itself as it waits to write.
#[cfg(not(test))]
const OUTBOX_FULL: usize = 4096;
#[cfg(test)]
const OUTBOX_FULL: usize = 64;

/// A session's news. Every event names the session it belongs to by `id`
/// beside the fields listed here, and its kind by `type`.
///
/// Text, thinking, tool calls, plans and requests carry `parent`: the id of
/// the tool call that started the subagent they belong to, or null in the
/// main conversation. A subagent's messages are tied to the call that
/// started it that way.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    /// The agent is up. Sent once, before anything else the agent says.
    /// `sessionId` is the agent's id for the conversation, the one resuming
    /// takes, whatever the start said. `model`, `mode` and `effort` are
    /// what the session runs on as far as
    /// is known yet, and `configured` follows when any changes. `models`,
    /// `modes` and `efforts` are what the agent offers to switch to, the
    /// efforts being those of the model it runs on; `commands` are the
    /// slash commands it takes in a message.
    Ready {
        session_id: String,
        model: Option<String>,
        mode: Option<String>,
        effort: Option<String>,
        version: Option<String>,
        models: Vec<ModelInfo>,
        modes: Vec<ModeInfo>,
        efforts: Vec<String>,
        commands: Vec<CommandInfo>,
    },
    /// The model, the mode or the effort changed, or became known. All
    /// are given as they now are, with the efforts the model now on takes.
    Configured {
        model: Option<String>,
        mode: Option<String>,
        effort: Option<String>,
        efforts: Vec<String>,
    },
    /// Where a message the window sent stands, between `send` and the turn
    /// that answers it: `sent` when it went to the agent with nothing ahead
    /// of it, `queued` while it waits behind a turn already running,
    /// `taken` when the running turn took it in, and `dropped`, with
    /// `error`, when it will not be answered at all. The first event for a
    /// message, `sent` or `queued`, carries its `text` and `images` as they
    /// were sent, so that any window can draw it; the others carry neither.
    Message {
        message: String,
        state: MessageState,
        error: Option<String>,
        text: Option<String>,
        images: Vec<Image>,
    },
    /// The agent began a turn. `messages` are the ids of the messages it
    /// answers, as the window chose them; several sent while the last turn
    /// ran may be answered by one. Empty for a turn the agent began by
    /// itself, after background work it had started finished.
    TurnStarted { messages: Vec<String> },
    /// The turn ended. `error` says why one that failed did. `durationMs`
    /// and `usage` are the turn's own; `totalCostUsd` is the running total
    /// the agent reports for its whole process so far, turns it began by
    /// itself and compaction included, not the turn's cost.
    TurnEnded {
        outcome: Outcome,
        error: Option<String>,
        total_cost_usd: Option<f64>,
        duration_ms: Option<u64>,
        usage: Option<Usage>,
    },
    /// Text from the agent, by block. While it streams `done` is false and
    /// `text` is the piece that just came; once the block is complete
    /// `done` is true and `text` is the whole of it.
    Text {
        block: String,
        parent: Option<String>,
        text: String,
        done: bool,
    },
    /// The agent's thinking, where it shows it, the same way as text.
    Thinking {
        block: String,
        parent: Option<String>,
        text: String,
        done: bool,
    },
    /// The agent began a tool call. `name` is the agent's own name for the
    /// tool; `kind` what sort of tool it is, for a window that draws each
    /// sort its own way.
    ToolStarted {
        call: String,
        parent: Option<String>,
        name: String,
        kind: ToolKind,
    },
    /// A tool call's input, in the agent's own shape. While it streams
    /// `delta` is the next piece of its JSON text; once complete, `input`
    /// is the whole of it. Pieces stop coming past a limit, and
    /// `truncated` says a string in the whole input was cut short.
    ToolInput {
        call: String,
        parent: Option<String>,
        delta: Option<String>,
        input: Option<Value>,
        truncated: bool,
    },
    /// The next piece of a running tool call's output, for an agent that
    /// streams it. Pieces stop coming past a limit; the output it finishes
    /// with says what it was.
    ToolOutput {
        call: String,
        parent: Option<String>,
        delta: String,
    },
    /// A tool call finished. `output` is its result as text, `truncated`
    /// when it was cut short; `changes` the files it created, updated,
    /// deleted or moved. A call the turn ended without finishing finishes
    /// as an error with no output.
    ToolFinished {
        call: String,
        parent: Option<String>,
        output: String,
        error: bool,
        truncated: bool,
        changes: Vec<FileChange>,
    },
    /// The agent's plan for the work, whole each time it changes: `text`
    /// where it wrote one out, `steps` where it keeps a list. `call` is
    /// the tool call that carried it, when one did.
    Plan {
        call: Option<String>,
        parent: Option<String>,
        text: Option<String>,
        steps: Vec<PlanStep>,
    },
    /// Everything the turn has changed so far, as one unified diff, for an
    /// agent that keeps one; `truncated` when it was cut short.
    TurnDiff { diff: String, truncated: bool },
    /// The agent asks to use a tool. `request` is what the answer names;
    /// `call` the tool call it is for; `path` the file or directory that
    /// made it ask, when there is one; `choices` the answers it takes, each
    /// with what it remembers. `truncated` says a string in `input` was
    /// cut short; the answer carries the whole input back regardless.
    PermissionAsked {
        request: String,
        call: Option<String>,
        parent: Option<String>,
        tool: String,
        input: Value,
        truncated: bool,
        description: Option<String>,
        path: Option<String>,
        choices: Vec<Offer>,
    },
    /// The agent asks the user something, answered with `reply`: each
    /// question with options to pick from, and, where it says so, room for
    /// an answer of the user's own.
    QuestionAsked {
        request: String,
        call: Option<String>,
        parent: Option<String>,
        questions: Vec<Question>,
    },
    /// A permission request or a question was answered, from this window
    /// or another: with `choice` for a permission, and for a question with
    /// `allow` and the `answers`, or `deny` with none when it was declined.
    /// The answer to a secret question is left out, as null in its place.
    /// `message` is what went to the agent with a denial.
    Answered {
        request: String,
        choice: Choice,
        answers: Option<Vec<Option<Vec<String>>>>,
        message: Option<String>,
    },
    /// The agent no longer waits for an answer to a permission request or
    /// a question: the turn was interrupted, or the session ended.
    Withdrawn { request: String },
    /// A subagent or a background task started. `call` is the tool call
    /// that started it, which its messages name as their parent.
    /// `ambient` marks housekeeping the agent does on its own account:
    /// it never keeps the session working, and a window may leave it out
    /// of the conversation.
    TaskStarted {
        task: String,
        call: Option<String>,
        kind: TaskKind,
        description: Option<String>,
        prompt: Option<String>,
        background: bool,
        ambient: bool,
    },
    /// A task is still at work. `tool` is the last tool it used.
    TaskProgress {
        task: String,
        call: Option<String>,
        tool: Option<String>,
        description: Option<String>,
    },
    /// A task ended, with how and the agent's summary of it. `reports`
    /// says the agent reports it in a turn of its own, which it begins by
    /// itself once no turn runs: the session stays working until then.
    TaskFinished {
        task: String,
        call: Option<String>,
        status: TaskStatus,
        summary: Option<String>,
        reports: bool,
    },
    /// The agent began compacting the conversation.
    Compacting,
    /// The conversation was compacted, asked for or because it was full,
    /// where the agent says which.
    Compacted {
        reason: Option<CompactReason>,
        tokens_before: Option<u64>,
        tokens_after: Option<u64>,
    },
    /// How much of the model's context window the conversation takes, in
    /// tokens, and how big the window is, where the agent reports either.
    /// Sent when either changes.
    Context {
        used: Option<u64>,
        size: Option<u64>,
    },
    /// Something the agent says that is neither an error nor part of a
    /// turn: that it fell back to another model, that its instructions are
    /// long, that something it uses is going away.
    Notice { level: NoticeLevel, message: String },
    /// A request to the agent's model failed and the agent will try again
    /// by itself: the turn goes on. `attempt` of `attempts`, where told.
    Retrying {
        message: String,
        attempt: Option<u64>,
        attempts: Option<u64>,
    },
    /// What the session is doing changed. Sent on every change, so the last
    /// one is the session's state.
    State { state: SessionState },
    /// Streamed pieces of text, thinking, or a tool call's input or
    /// output were left out, `pieces` of them, because the window or the
    /// connection to it fell behind. The whole that follows each holds
    /// all of it.
    Skipped { pieces: u64 },
    /// Something went wrong that the window should say.
    Error { kind: ErrorKind, message: String },
    /// The process is gone. Nothing follows it.
    Ended { code: Option<i32>, clean: bool },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// What a model change takes.
    pub value: String,
    pub name: Option<String>,
    pub description: Option<String>,
    /// The efforts it takes, none for a model that takes no effort.
    pub efforts: Vec<String>,
}

/// A mode the session can run in: how much the agent may do without asking.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeInfo {
    /// What a mode change takes.
    pub value: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandInfo {
    /// Without the slash.
    pub name: String,
    pub description: Option<String>,
    /// What the command takes after its name, for a placeholder.
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageState {
    Sent,
    Queued,
    Taken,
    Dropped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Done,
    Interrupted,
    Failed,
}

/// The tokens a turn took. `inputTokens` are all the model read, cached
/// or not, and `cachedTokens` how many of them came from a cache;
/// `outputTokens` are all it wrote, its reasoning among them, and
/// `reasoningTokens` how many of them were reasoning.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub cached_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
}

/// Why the conversation was compacted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CompactReason {
    /// The user or the window asked for it.
    Asked,
    /// The context window was full.
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeLevel {
    Info,
    Warning,
}

/// What sort of tool a call is, whatever the agent calls it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolKind {
    /// Runs a shell command.
    Command,
    /// Creates, changes or deletes files.
    Edit,
    /// Reads a file.
    Read,
    /// Looks for files or for text in them.
    Search,
    /// Reads from the web.
    Web,
    /// A tool of an MCP server.
    Mcp,
    /// Starts a subagent.
    Agent,
    Other,
}

/// A file a tool call changed. `create` comes with the new file's
/// `content`; `update` with `hunks` saying what changed; `delete` with
/// neither; `move` with `to`, where it went, and hunks if it changed too.
/// `truncated` says the content or the hunks were cut short.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub kind: ChangeKind,
    pub to: Option<String>,
    pub hunks: Vec<Hunk>,
    pub content: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Create,
    Update,
    Delete,
    Move,
}

/// A hunk of a unified diff: each line starts with `+`, `-` or a space.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u64,
    pub old_lines: u64,
    pub new_start: u64,
    pub new_lines: u64,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub text: String,
    pub status: StepStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StepStatus {
    Pending,
    Active,
    Done,
}

/// One thing the agent asks the user. `header` is a short label for it;
/// `multiple` whether more than one option may be picked; `secret` whether
/// the answer is one not to show, such as a password, which no window is
/// told; `other` whether the user may answer in words of their own rather
/// than with an option.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub header: Option<String>,
    pub question: String,
    pub options: Vec<QuestionOption>,
    pub multiple: bool,
    pub secret: bool,
    pub other: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskKind {
    /// A subagent: the agent's own helper, with a conversation of its own.
    Agent,
    /// A shell command run in the background.
    Shell,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Completed,
    Failed,
    /// Stopped by the user or the agent before it was done.
    Stopped,
    /// Ended without a word of how, by the time the agent's turn or its
    /// work as a whole was over. No report of it follows.
    Lost,
}

/// What a session is doing, for the sessions pane's row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    /// A turn runs, a message waits for one, the conversation is being
    /// compacted, or a subagent the agent started is still at work.
    Working,
    /// The agent waits for an answer to a permission request or a question.
    Asking,
    /// Nothing runs: the agent waits for the user.
    Idle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// The account the session runs under is not signed in. The user signs
    /// in with the agent's own command, in a terminal.
    NotLoggedIn,
    /// The agent reported an error of its own, from its API or a tool.
    Agent,
    /// The agent did not answer as expected, or not in time.
    Protocol,
    /// The process could not be talked to, or ended when it should not have.
    Process,
}

/// An answer to a permission request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Choice {
    /// This call only.
    Allow,
    /// This call, and what the offer remembers for as long as the session
    /// lives.
    AllowSession,
    /// This call, and what the offer remembers from now on, where the offer
    /// says.
    AllowAlways,
    /// Not this call; the turn goes on, and the agent is told, with the
    /// user's message where the offer takes one.
    Deny,
    /// Not this call, and the turn stops.
    Cancel,
}

/// One answer a permission request takes. `remembers` says, in words the
/// window can show, what the choice keeps beyond this call; a choice with
/// nothing precise to remember is not offered. `message` is whether the
/// choice carries a message from the user to the agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub choice: Choice,
    pub remembers: Option<String>,
    pub message: bool,
}

/// An image attached to a message: base64 data and its media type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub media_type: String,
    pub data: String,
}

/// What starting a session hands back: the id the window addresses it by,
/// and the conversation's id where the workbench knows it at the start,
/// the one it chose or the one it resumes. For an agent that makes its own
/// id there is none yet; `ready` carries the agent's id either way, and
/// that is the one resuming takes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub id: String,
    pub session_id: Option<String>,
}

impl Event {
    /// Where a message stands after it was sent, with nothing of what it
    /// said.
    pub fn message(message: &str, state: MessageState, error: Option<String>) -> Self {
        Event::Message {
            message: message.to_string(),
            state,
            error,
            text: None,
            images: vec![],
        }
    }
}

/// An event, with the session it belongs to, as it goes out.
#[derive(Serialize)]
struct Payload<'a> {
    id: &'a str,
    #[serde(flatten)]
    event: &'a Event,
}

/// What an agent needs to be started as an integrated session.
pub struct Launch<'a> {
    /// Where it runs.
    pub project: &'a Path,
    /// The captured login-shell environment.
    pub env: &'a HashMap<String, String>,
    /// The conversation's id: a fresh one the workbench chose, or the one
    /// to resume. None for a fresh conversation of an agent that makes its
    /// own id.
    pub session: Option<&'a str>,
    pub resume: bool,
    pub model: Option<&'a str>,
    pub mode: Option<&'a str>,
    pub effort: Option<&'a str>,
    /// The account's configuration directory, expanded. The agent's own
    /// when None.
    pub config_dir: Option<&'a Path>,
    /// The workbench's tool server, attached to this session alone.
    pub tool_server: Option<&'a Path>,
    /// Whether the session directs the others.
    pub orchestrator: bool,
}

/// How one agent is started and spoken to as an integrated session.
pub trait Protocol: Send + Sync {
    /// The agent's name in what the window is told, "claude" for a missing
    /// binary and the like.
    fn name(&self) -> &'static str;

    /// The process to start, with its arguments, environment and directory.
    fn command(&self, launch: &Launch) -> Result<Prepared, String>;

    /// A fresh reader and writer of the agent's lines for one session.
    fn driver(&self, launch: &Launch) -> Box<dyn Driver>;

    /// Whether the agent holds a folder as trusted to run its project's
    /// own hooks and servers, by the record the agent's own question
    /// writes, under the account whose configuration directory is given.
    fn trusted(&self, home: &Path, config_dir: Option<&Path>, folder: &Path) -> bool;

    /// Records that the user trusts a folder, where the agent's own
    /// question would.
    fn trust(&self, home: &Path, config_dir: Option<&Path>, folder: &Path) -> Result<(), String>;
}

/// What a start in a folder the agent does not trust fails with, before
/// the folder: the window asks the user, and records the answer with the
/// trust command.
pub const UNTRUSTED: &str = "untrusted";

/// A request the window makes of a running session, beside its messages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Control {
    Interrupt,
    /// Compact the conversation, in whatever way the agent does it.
    Compact,
    SetModel(String),
    SetMode(String),
    SetEffort(String),
}

/// A process ready to start, and the files written for it, which go when
/// the session ends.
pub struct Prepared {
    pub command: std::process::Command,
    pub files: Vec<std::path::PathBuf>,
}

/// How a driver carries out a control request.
#[derive(Debug)]
pub enum Sending {
    /// A line for the agent, whose reply comes back by `key` in a
    /// [`Reading`].
    Request { line: String, key: String },
    /// A line for the agent that it answers with events alone: done once
    /// it is written.
    Line { line: String },
    /// Settled without asking the agent, such as a setting the agent takes
    /// with the next message: the reply, and the events it makes, which go
    /// out before the reply does.
    Local { reply: Value, events: Vec<Event> },
}

/// What one line from the agent meant.
#[derive(Debug, Default)]
pub struct Reading {
    pub events: Vec<Event>,
    /// Answers to control requests, by the key [`Sending::Request`] gave.
    pub replies: Vec<(String, Result<Value, String>)>,
    /// Lines to write back at once.
    pub writes: Vec<String>,
    /// The session cannot go on, such as when the agent refused to begin
    /// or speaks a version the driver cannot: it is ended, with this said
    /// once as an error after the events.
    pub fatal: Option<(ErrorKind, String)>,
}

/// One session's side of an agent's protocol. It holds whatever the agent's
/// stream needs remembered between lines, and never fails on a line: one it
/// cannot read means nothing.
///
/// The driver says what the agent says; the core keeps the session's
/// state. A message is sent under the id the window chose for it, and the
/// driver names it again in [`Event::TurnStarted`] or [`Event::Message`]
/// when the agent says it took it, or dropped it. Whatever a driver leaves
/// open when a turn ends, the core closes: a tool call with no finish
/// finishes as failed.
pub trait Driver: Send {
    /// Lines to write as soon as the process is up. The answer to them
    /// produces [`Event::Ready`].
    fn opening(&mut self) -> Vec<String>;

    /// One line from the agent's stdout, without its newline.
    fn read(&mut self, line: &str) -> Reading;

    /// Whether the agent takes a message while a turn runs. When it does
    /// not, the core holds each message, and hands one over only when the
    /// agent is ready, no turn runs and it has named the last one handed
    /// over, in a turn's start or as dropped. Its line is made then.
    fn takes_while_busy(&self) -> bool;

    /// The line that sends the user's message, under the window's id. An
    /// error refuses the message: at once, or as dropped for one held.
    fn message(&mut self, message: &str, text: &str, images: &[Image]) -> Result<String, String>;

    /// The line that answers a permission request.
    fn answer(
        &mut self,
        request: &str,
        choice: Choice,
        message: Option<&str>,
    ) -> Result<String, String>;

    /// The line that answers a question, each answer the labels picked or
    /// the user's own words; None declines to answer.
    fn reply(&mut self, request: &str, answers: Option<&[Vec<String>]>) -> Result<String, String>;

    /// How a control request goes.
    fn control(&mut self, control: &Control) -> Result<Sending, String>;

    /// A control request whose reply the core no longer waits for.
    fn forget(&mut self, _key: &str) {}

    /// The next bytes of a line too long to read, as they pass: what a
    /// driver can still learn from them without the whole.
    fn skipping(&mut self, _bytes: &[u8]) {}

    /// The end of a line too long to read: what the driver makes of what
    /// passed.
    fn skipped(&mut self) -> Reading {
        Reading::default()
    }
}

/// The model, mode and effort the session runs on, as its events last
/// said.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub model: Option<String>,
    pub mode: Option<String>,
    pub effort: Option<String>,
}

/// What a window that comes to a session late, after a reload or as a
/// second window, reads to catch up: what no transcript holds. It reflects
/// every event that went out before it, and none after.
///
/// `state` is the session's state and `turn` whether a turn runs;
/// `settings` what it runs on and `efforts` the efforts of the model it is
/// on; `ready` the ready event as it went out, null before the agent was
/// ready; `requests` every permission request and question still waiting
/// for an answer, each as it was asked; `messages` every message sent and
/// not yet taken into a turn, in the order sent, each as its first message
/// event told it, with its text and images.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub state: SessionState,
    pub turn: bool,
    pub settings: Settings,
    pub efforts: Vec<String>,
    pub ready: Option<Event>,
    pub requests: Vec<Event>,
    pub messages: Vec<Event>,
}

/// The state of a session as its events say it, and the bookkeeping that
/// says it.
///
/// A message the window sends is pending until the agent takes it, which
/// the driver says by naming it in a turn's start or as taken into the
/// running turn. A message sent while a turn runs, or while others still
/// wait, is queued, and says so.
///
/// The state is derived from the same events, never from timing:
/// [`SessionState::Asking`] while any request waits for an answer;
/// [`SessionState::Working`] while a turn runs, a message is pending, the
/// conversation is being compacted, or a subagent is still at work or has
/// finished outside a turn with a report to come, which the driver says.
/// That keeps a session that ended its turn to wait for its subagents
/// working until the turn that takes their report ends; and
/// [`SessionState::Idle`] otherwise. A background shell command does not
/// keep a session working: it may be a server that runs for as long as the
/// session does. Nor does a task the agent marks as housekeeping.
///
/// Tool calls the agent leaves open are closed here: those of the main
/// conversation when the turn ends, a subagent's when it finishes, and
/// all of them when the session does.
#[derive(Debug, Default)]
struct Tracker {
    /// Sent and not yet taken, in the order sent.
    pending: Vec<String>,
    /// The first message event of each pending message, as it went out.
    told: HashMap<String, Event>,
    /// Every message id used, so none is used twice.
    used: BTreeSet<String>,
    turn: bool,
    /// Permission requests and questions waiting for an answer, in the
    /// order asked, each as it went out.
    asking: Vec<Event>,
    /// Subagents at work, with the tool call that started each.
    subagents: BTreeMap<String, Option<String>>,
    /// Tool calls started and not finished, with the subagent call each
    /// belongs to.
    calls: BTreeMap<String, Option<String>>,
    /// How much of each open call's input and output has streamed.
    streamed: HashMap<String, usize>,
    /// A task finished while no turn ran, and the driver said its report
    /// starts a turn: that turn is coming.
    reporting: bool,
    compacting: bool,
    settings: Settings,
    /// The efforts of the model the session is on, as the events last said.
    efforts: Vec<String>,
    /// The ready event, as it went out.
    ready: Option<Event>,
    state: Option<SessionState>,
}

impl Tracker {
    fn state(&self) -> SessionState {
        if !self.asking.is_empty() {
            SessionState::Asking
        } else if self.turn
            || !self.pending.is_empty()
            || self.compacting
            || !self.subagents.is_empty()
            || self.reporting
        {
            SessionState::Working
        } else {
            SessionState::Idle
        }
    }

    /// The state, when it differs from the last one told.
    fn changed(&mut self) -> Option<Event> {
        let state = self.state();
        (self.state != Some(state)).then(|| {
            self.state = Some(state);
            Event::State { state }
        })
    }

    /// Takes a message id the window chose, and says whether the message
    /// waits behind something.
    fn send(&mut self, message: &str) -> Result<bool, String> {
        if uuid::Uuid::parse_str(message).is_err() {
            return Err(format!("{message:?} is not a UUID"));
        }
        if !self.used.insert(message.to_string()) {
            return Err(format!("message {message} was sent already"));
        }
        let queued = self.turn || !self.pending.is_empty();
        self.pending.push(message.to_string());
        Ok(queued)
    }

    /// A message that could not be sent after all.
    fn unsend(&mut self, message: &str) {
        self.pending.retain(|m| m != message);
        self.told.remove(message);
    }

    /// A message the agent refused before it went: as if it was never
    /// sent, so its id can be used again.
    fn refused(&mut self, message: &str) {
        self.unsend(message);
        self.used.remove(message);
    }

    /// Takes an event from the driver, fills in what the tracker knows, and
    /// hands back what goes out.
    fn observe(&mut self, event: Event, out: &mut Vec<Event>) {
        match &event {
            Event::Ready {
                model,
                mode,
                effort,
                efforts,
                ..
            }
            | Event::Configured {
                model,
                mode,
                effort,
                efforts,
            } => {
                self.settings = Settings {
                    model: model.clone(),
                    mode: mode.clone(),
                    effort: effort.clone(),
                };
                self.efforts = efforts.clone();
                if matches!(event, Event::Ready { .. }) {
                    self.ready = Some(event.clone());
                }
            }
            Event::TurnStarted { messages } => {
                let messages: Vec<String> = messages
                    .iter()
                    .filter(|message| self.pending.contains(message))
                    .cloned()
                    .collect();
                if self.turn {
                    // A second start with no end between is the same turn,
                    // and what it names was taken into it.
                    for message in messages {
                        self.observe(Event::message(&message, MessageState::Taken, None), out);
                    }
                    return;
                }
                self.turn = true;
                self.reporting = false;
                self.pending.retain(|m| !messages.contains(m));
                self.told.retain(|m, _| !messages.contains(m));
                out.push(Event::TurnStarted { messages });
                self.push_state(out);
                return;
            }
            Event::Message {
                message,
                state: MessageState::Taken | MessageState::Dropped,
                ..
            } => {
                if !self.pending.contains(message) {
                    return;
                }
                self.unsend(message);
            }
            // Something of the main conversation arriving with no turn
            // running starts one: the agent began it without saying so.
            Event::Text { parent: None, .. }
            | Event::Thinking { parent: None, .. }
            | Event::ToolStarted { parent: None, .. }
                if !self.turn =>
            {
                self.observe(Event::TurnStarted { messages: vec![] }, out);
            }
            Event::TurnEnded { .. } => {
                if !self.turn {
                    // An end for a turn never seen to start.
                    self.observe(Event::TurnStarted { messages: vec![] }, out);
                }
                let working: BTreeSet<Option<String>> = self
                    .subagents
                    .values()
                    .flatten()
                    .cloned()
                    .map(Some)
                    .collect();
                self.close(out, |parent| !working.contains(parent));
                self.turn = false;
                self.reporting = false;
                self.compacting = false;
            }
            Event::ToolStarted { call, parent, .. } => {
                self.calls.insert(call.clone(), parent.clone());
            }
            Event::ToolInput {
                call,
                delta: Some(delta),
                ..
            }
            | Event::ToolOutput { call, delta, .. } => {
                let streamed = self.streamed.entry(call.clone()).or_default();
                *streamed += delta.len();
                if *streamed > CONTENT_KEEP {
                    return;
                }
            }
            Event::ToolFinished { call, .. } => {
                self.calls.remove(call);
                self.streamed.remove(call);
            }
            Event::PermissionAsked { request, .. } | Event::QuestionAsked { request, .. } => {
                self.asking.retain(|asked| asked_by(asked) != Some(request));
                self.asking.push(event.clone());
            }
            Event::Withdrawn { request } | Event::Answered { request, .. } => {
                self.asking.retain(|asked| asked_by(asked) != Some(request));
            }
            Event::TaskStarted {
                task,
                call,
                kind: TaskKind::Agent,
                ambient: false,
                ..
            } => {
                self.subagents.insert(task.clone(), call.clone());
            }
            Event::TaskFinished {
                task,
                status,
                reports,
                ..
            } => {
                if *reports && !self.turn && *status != TaskStatus::Lost {
                    self.reporting = true;
                }
                if let Some(Some(call)) = self.subagents.remove(task) {
                    let call = Some(call);
                    self.close(out, |parent| *parent == call);
                }
            }
            Event::Compacting => self.compacting = true,
            Event::Compacted { .. } => self.compacting = false,
            _ => {}
        }
        out.push(event);
        self.push_state(out);
    }

    fn push_state(&mut self, out: &mut Vec<Event>) {
        if let Some(state) = self.changed() {
            out.push(state);
        }
    }

    /// Finishes the open tool calls whose parent `which` picks, as failed.
    fn close(&mut self, out: &mut Vec<Event>, which: impl Fn(&Option<String>) -> bool) {
        let closing: Vec<(String, Option<String>)> = self
            .calls
            .iter()
            .filter(|(_, parent)| which(parent))
            .map(|(call, parent)| (call.clone(), parent.clone()))
            .collect();
        for (call, parent) in closing {
            self.calls.remove(&call);
            self.streamed.remove(&call);
            out.push(Event::ToolFinished {
                call,
                parent,
                output: String::new(),
                error: true,
                truncated: false,
                changes: vec![],
            });
        }
    }

    /// What a window that comes late reads to catch up.
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            state: self.state(),
            turn: self.turn,
            settings: self.settings.clone(),
            efforts: self.efforts.clone(),
            ready: self.ready.clone(),
            requests: self.asking.clone(),
            messages: self
                .pending
                .iter()
                .filter_map(|message| self.told.get(message).cloned())
                .collect(),
        }
    }

    /// The questions of an open question request.
    fn questions(&self, request: &str) -> Option<&[Question]> {
        self.asking.iter().find_map(|asked| match asked {
            Event::QuestionAsked {
                request: asking,
                questions,
                ..
            } if asking == request => Some(questions.as_slice()),
            _ => None,
        })
    }

    /// The window asked for the running turn to stop while none runs: a
    /// report the session waits for may never come, and stops being
    /// waited for.
    fn interrupted(&mut self, out: &mut Vec<Event>) {
        if !self.turn {
            self.reporting = false;
            self.push_state(out);
        }
    }

    /// The process is gone: whatever was open closes.
    fn end(&mut self, out: &mut Vec<Event>) {
        self.close(out, |_| true);
        if self.turn {
            self.turn = false;
            out.push(Event::TurnEnded {
                outcome: Outcome::Failed,
                error: Some("the agent ended during the turn".into()),
                total_cost_usd: None,
                duration_ms: None,
                usage: None,
            });
        }
        for asked in std::mem::take(&mut self.asking) {
            if let Some(request) = asked_by(&asked) {
                out.push(Event::Withdrawn {
                    request: request.to_string(),
                });
            }
        }
        self.told.clear();
        for message in std::mem::take(&mut self.pending) {
            out.push(Event::message(
                &message,
                MessageState::Dropped,
                Some("the agent ended before it took the message".into()),
            ));
        }
        self.subagents.clear();
        self.reporting = false;
        self.compacting = false;
    }
}

/// The request a permission request or a question goes by.
fn asked_by(event: &Event) -> Option<&str> {
    match event {
        Event::PermissionAsked { request, .. } | Event::QuestionAsked { request, .. } => {
            Some(request)
        }
        _ => None,
    }
}

/// A line for the writer thread, and where to say whether it went.
type Line = (String, Sender<Result<(), String>>);

/// What goes out of a session, in order, through the thread that talks to
/// the sink: events, the replies they explain, and what runs once the
/// session's last event is out.
enum Out {
    Event(Event),
    Reply(Sender<Result<Value, String>>, Result<Value, String>),
    Last(Box<dyn FnOnce() + Send>),
}

/// Whether an event is a streamed piece of something whose whole follows.
fn piece(event: &Event) -> bool {
    matches!(
        event,
        Event::Text { done: false, .. }
            | Event::Thinking { done: false, .. }
            | Event::ToolInput { delta: Some(_), .. }
            | Event::ToolOutput { .. }
    )
}

/// What a session has put out and the sink has not taken yet.
///
/// Putting never waits, so a command is never held up by a slow window.
/// Past [`OUTBOX_PIECES`] waiting, streamed pieces are left out, and the
/// next event to go in after them says how many; whole events and replies
/// always go in. Past [`OUTBOX_FULL`], the reader of the agent's lines
/// waits for room before it reads on.
#[derive(Default)]
struct Outbox {
    queue: Mutex<Queue>,
    changed: Condvar,
}

#[derive(Default)]
struct Queue {
    waiting: VecDeque<Out>,
    /// Pieces left out since the last event that went in.
    skipped: u64,
    /// The session is over: nothing waits for room any more.
    over: bool,
}

impl Outbox {
    fn put(&self, out: Out) {
        let mut queue = self.queue.lock().expect("outbox lock");
        if let Out::Event(event) = &out {
            if piece(event) && queue.waiting.len() >= OUTBOX_PIECES {
                queue.skipped += 1;
                return;
            }
            if queue.skipped > 0 {
                let pieces = std::mem::take(&mut queue.skipped);
                queue
                    .waiting
                    .push_back(Out::Event(Event::Skipped { pieces }));
            }
        }
        queue.waiting.push_back(out);
        self.changed.notify_all();
    }

    /// The next thing to go out, once there is one.
    fn next(&self) -> Out {
        let mut queue = self.queue.lock().expect("outbox lock");
        loop {
            if let Some(out) = queue.waiting.pop_front() {
                self.changed.notify_all();
                return out;
            }
            queue = self.changed.wait(queue).expect("outbox lock");
        }
    }

    /// Waits while the outbox is full, unless the session is over.
    fn room(&self) {
        let mut queue = self.queue.lock().expect("outbox lock");
        while queue.waiting.len() >= OUTBOX_FULL && !queue.over {
            queue = self.changed.wait(queue).expect("outbox lock");
        }
    }

    /// The session is over: whoever waits for room stops waiting.
    fn close(&self) {
        self.queue.lock().expect("outbox lock").over = true;
        self.changed.notify_all();
    }
}

/// A message held for an agent that takes none while a turn runs. Its line
/// is made when it is handed over, so that it goes with what the session
/// runs on then.
struct Held {
    message: String,
    text: String,
    images: Vec<Image>,
}

struct Machine {
    driver: Box<dyn Driver>,
    tracker: Tracker,
    /// Messages held for an agent that takes none while a turn runs, in
    /// the order sent.
    held: VecDeque<Held>,
    /// The message last handed over to such an agent, until the agent
    /// names it in a turn or drops it. Nothing more is handed over before.
    handed: Option<String>,
    /// Control requests waiting for their reply, by key.
    replies: HashMap<String, Sender<Result<Value, String>>>,
    /// Told when the agent is ready, for the watchdog that bounds the wait.
    ready: Option<Sender<()>>,
    ended: bool,
}

impl Machine {
    fn new(driver: Box<dyn Driver>, ready: Option<Sender<()>>) -> Self {
        Self {
            driver,
            tracker: Tracker::default(),
            held: VecDeque::new(),
            handed: None,
            replies: HashMap::new(),
            ready,
            ended: false,
        }
    }
}

struct Live {
    id: String,
    machine: Mutex<Machine>,
    /// What goes out, in the order it is put here, which is always under
    /// the machine's lock. A sink that is slow holds up only the thread
    /// that empties it, and the reader once too much waits.
    outbox: Arc<Outbox>,
    /// None once stdin is closed.
    writer: Mutex<Option<Sender<Line>>>,
    kill: Mutex<Sender<()>>,
    /// Set when the session is ended on purpose: by a stop, or by the core
    /// after saying why.
    stopping: AtomicBool,
}

impl Live {
    fn new(
        id: String,
        machine: Machine,
        outbox: Arc<Outbox>,
        writer: Sender<Line>,
        kill: Sender<()>,
    ) -> Self {
        Self {
            id,
            machine: Mutex::new(machine),
            outbox,
            writer: Mutex::new(Some(writer)),
            kill: Mutex::new(kill),
            stopping: AtomicBool::new(false),
        }
    }

    fn emit(&self, events: &[Event]) {
        for event in events {
            self.put(Out::Event(event.clone()));
        }
    }

    fn put(&self, out: Out) {
        self.outbox.put(out);
    }

    /// Queues a line for stdin, and hands back where to hear whether it
    /// went. Called under the machine's lock, so lines go in the order the
    /// state changed.
    fn enqueue(&self, line: String) -> Result<Receiver<Result<(), String>>, String> {
        let (sent, went) = mpsc::channel();
        self.writer
            .lock()
            .expect("writer lock")
            .as_ref()
            .ok_or("the session is closing")?
            .send((line, sent))
            .map_err(|_| "the agent is gone".to_string())?;
        Ok(went)
    }

    /// Takes one line from the agent's stdout.
    fn take(&self, line: &str) {
        let mut machine = self.machine.lock().expect("machine lock");
        if machine.ended {
            return;
        }
        let reading = machine.driver.read(line);
        self.absorb(&mut machine, reading);
    }

    /// Passes the driver the next bytes of a line too long to read.
    fn skipping(&self, bytes: &[u8]) {
        let mut machine = self.machine.lock().expect("machine lock");
        if !machine.ended {
            machine.driver.skipping(bytes);
        }
    }

    /// The end of a line too long to read.
    fn skipped(&self) {
        let mut machine = self.machine.lock().expect("machine lock");
        if machine.ended {
            return;
        }
        let reading = machine.driver.skipped();
        self.absorb(&mut machine, reading);
    }

    /// Acts on what the driver made of a line.
    fn absorb(&self, machine: &mut Machine, reading: Reading) {
        for line in reading.writes {
            // Nothing waits on these: the agent is reading, since it just
            // asked, and a failure shows as the session ending.
            let _ = self.enqueue(line);
        }
        let mut out = Vec::new();
        for event in reading.events {
            if matches!(event, Event::Ready { .. }) {
                if let Some(ready) = machine.ready.take() {
                    let _ = ready.send(());
                }
            }
            machine.tracker.observe(bounded(event), &mut out);
        }
        if let Some((kind, message)) = reading.fatal {
            // Said once, as `abandon` does, and ended as `stop` ends it:
            // stdin closes once what is queued has gone, and an agent still
            // there a little later is asked to end. Nothing held is handed
            // over any more.
            if !self.stopping.swap(true, Ordering::SeqCst) {
                out.push(Event::Error { kind, message });
                self.writer.lock().expect("writer lock").take();
                let kill = self.kill.lock().expect("kill lock").clone();
                std::thread::spawn(move || {
                    std::thread::sleep(STOP_GRACE);
                    let _ = kill.send(());
                });
            }
        } else {
            self.release(machine, &mut out);
        }
        self.emit(&out);
        // After the events, so whoever waits on a reply wakes to a stream
        // that already holds what the reply changed.
        for (key, reply) in reading.replies {
            if let Some(waiting) = machine.replies.remove(&key) {
                self.put(Out::Reply(waiting, reply));
            }
        }
    }

    /// Hands the agent the next held message, once it is ready, no turn
    /// runs and it has named the one handed over before. One the driver
    /// cannot make a line of is dropped, and the next one goes.
    fn release(&self, machine: &mut Machine, out: &mut Vec<Event>) {
        if let Some(message) = &machine.handed {
            if !machine.tracker.pending.contains(message) {
                machine.handed = None;
            }
        }
        while machine.ready.is_none() && !machine.tracker.turn && machine.handed.is_none() {
            let Some(held) = machine.held.pop_front() else {
                return;
            };
            if !machine.tracker.pending.contains(&held.message) {
                continue;
            }
            match machine
                .driver
                .message(&held.message, &held.text, &held.images)
            {
                Ok(line) => {
                    // A failure to write shows as the session ending.
                    let _ = self.enqueue(line);
                    machine.handed = Some(held.message);
                }
                Err(error) => machine.tracker.observe(
                    Event::message(&held.message, MessageState::Dropped, Some(error)),
                    out,
                ),
            }
        }
    }

    /// Says something went wrong, in the stream with everything else.
    fn fail(&self, kind: ErrorKind, message: String) {
        let machine = self.machine.lock().expect("machine lock");
        if !machine.ended {
            self.emit(&[Event::Error { kind, message }]);
        }
    }

    /// Ends the session for a reason the core gives, said once.
    fn abandon(&self, kind: ErrorKind, message: String) {
        if !self.stopping.swap(true, Ordering::SeqCst) {
            self.fail(kind, message);
        }
        self.kill();
    }

    fn kill(&self) {
        let _ = self.kill.lock().expect("kill lock").send(());
    }

    /// Waits for a queued line to have gone. A line the agent does not take
    /// in time means it has stopped reading, and the session ends, so that
    /// nothing queued behind it is written late.
    fn written(&self, went: Receiver<Result<(), String>>) -> Result<(), String> {
        match went.recv_timeout(WRITE_TIMEOUT) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                let error = "the agent stopped reading its input".to_string();
                self.abandon(ErrorKind::Process, error.clone());
                Err(error)
            }
            Err(RecvTimeoutError::Disconnected) => Err("the agent is gone".into()),
        }
    }
}

/// Cuts a string down to at most `keep` bytes, on a character boundary.
fn cut(text: &mut String, keep: usize) -> bool {
    if text.len() <= keep {
        return false;
    }
    let at = (0..=keep)
        .rev()
        .find(|&i| text.is_char_boundary(i))
        .unwrap_or(0);
    text.truncate(at);
    true
}

/// Cuts every string in a JSON value down to `keep` bytes.
fn cut_strings(value: &mut Value, keep: usize) -> bool {
    match value {
        Value::String(text) => cut(text, keep),
        Value::Array(items) => items
            .iter_mut()
            .fold(false, |cut, item| cut_strings(item, keep) | cut),
        Value::Object(fields) => fields
            .values_mut()
            .fold(false, |cut, item| cut_strings(item, keep) | cut),
        _ => false,
    }
}

/// Cuts a file change down: its content, and its hunks past what the
/// limit holds of their lines.
fn cut_change(change: &mut FileChange) {
    if let Some(content) = &mut change.content {
        change.truncated |= cut(content, CONTENT_KEEP);
    }
    let mut room = CONTENT_KEEP;
    let mut keep = 0;
    for hunk in &change.hunks {
        let size: usize = hunk.lines.iter().map(|line| line.len() + 1).sum();
        if size > room {
            break;
        }
        room -= size;
        keep += 1;
    }
    if keep < change.hunks.len() {
        change.hunks.truncate(keep);
        change.truncated = true;
    }
}

/// An event as it may go out: whole files and long outputs cut down to
/// what the window and a connection to another machine should carry.
fn bounded(mut event: Event) -> Event {
    match &mut event {
        Event::ToolInput {
            input: Some(input),
            truncated,
            ..
        }
        | Event::PermissionAsked {
            input, truncated, ..
        } => *truncated |= cut_strings(input, OUTPUT_KEEP),
        Event::ToolFinished {
            output,
            truncated,
            changes,
            ..
        } => {
            *truncated |= cut(output, OUTPUT_KEEP);
            changes.iter_mut().for_each(cut_change);
        }
        Event::TurnDiff { diff, truncated } => *truncated |= cut(diff, CONTENT_KEEP),
        _ => {}
    }
    event
}

#[derive(Default)]
pub struct Sessions {
    inner: Mutex<HashMap<String, Arc<Live>>>,
}

impl Sessions {
    fn get(&self, id: &str) -> Result<Arc<Live>, String> {
        self.inner
            .lock()
            .expect("sessions lock")
            .get(id)
            .cloned()
            .ok_or_else(|| "no such session".to_string())
    }

    /// Whether a session is still here: it goes when its process ends.
    pub fn holds(&self, id: &str) -> bool {
        self.inner.lock().expect("sessions lock").contains_key(id)
    }

    fn ids(&self) -> Vec<String> {
        self.inner
            .lock()
            .expect("sessions lock")
            .keys()
            .cloned()
            .collect()
    }
}

fn next_id() -> String {
    use std::sync::atomic::AtomicU64;
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("int-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Starts an agent as an integrated session. `on_start` hears the session
/// before anything of it goes out; `on_end` hears its id once its process
/// is gone and every event has gone out.
///
/// The agent runs in a process group of its own, so that ending it ends
/// what it started too: its MCP servers and the commands it left running.
pub fn start(
    sink: Arc<dyn Sink>,
    sessions: Arc<Sessions>,
    protocol: &dyn Protocol,
    launch: &Launch,
    on_start: Box<dyn FnOnce(&Started) + Send>,
    on_end: Box<dyn FnOnce(&str) + Send>,
) -> Result<Started, String> {
    let Prepared { mut command, files } = protocol.command(launch)?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let remove = move || {
        for file in &files {
            let _ = std::fs::remove_file(file);
        }
    };
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            remove();
            return Err(format!("could not start {}: {e}", protocol.name()));
        }
    };
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        kill_tree(&mut child);
        let _ = child.wait();
        remove();
        return Err(format!("could not talk to {}", protocol.name()));
    };

    let id = next_id();
    let started = Started {
        id: id.clone(),
        session_id: launch.session.map(str::to_string),
    };
    on_start(&started);
    let (lines, queued) = mpsc::channel::<Line>();
    let (kill, killed) = mpsc::channel::<()>();
    let (ready, readied) = mpsc::channel::<()>();
    let outbox = Arc::new(Outbox::default());
    let mut driver = protocol.driver(launch);
    let opening = driver.opening();
    let live = Arc::new(Live::new(
        id.clone(),
        Machine::new(driver, Some(ready)),
        Arc::clone(&outbox),
        lines,
        kill,
    ));
    sessions
        .inner
        .lock()
        .expect("sessions lock")
        .insert(id.clone(), Arc::clone(&live));

    std::thread::spawn({
        let id = id.clone();
        move || send_out(&id, &sink, &outbox)
    });
    std::thread::spawn(move || write_lines(stdin, queued));
    let tail = Arc::new(Mutex::new(String::new()));
    std::thread::spawn({
        let tail = Arc::clone(&tail);
        move || keep_tail(stderr, tail)
    });
    let (reading, read_done) = mpsc::channel::<()>();
    std::thread::spawn({
        let live = Arc::clone(&live);
        move || read_lines(&live, stdout, reading)
    });
    std::thread::spawn({
        let live = Arc::clone(&live);
        let name = protocol.name();
        move || {
            let status = wait(&live, child, killed, read_done);
            sessions
                .inner
                .lock()
                .expect("sessions lock")
                .remove(&live.id);
            let said = tail.lock().expect("stderr lock").trim().to_string();
            finish(&live, name, status, said);
            let id = live.id.clone();
            live.put(Out::Last(Box::new(move || {
                remove();
                on_end(&id);
            })));
        }
    });

    for line in opening {
        // A failure here shows as the session ending, which the waiter
        // reports.
        let _ = live.enqueue(line);
    }
    std::thread::spawn({
        let live = Arc::clone(&live);
        let name = protocol.name();
        move || {
            if let Err(RecvTimeoutError::Timeout) = readied.recv_timeout(READY_TIMEOUT) {
                live.abandon(
                    ErrorKind::Protocol,
                    format!("{name} did not say it was ready in time"),
                );
            }
        }
    });

    Ok(started)
}

/// Hands what a session puts out to the sink, in order, until its last.
fn send_out(id: &str, sink: &Arc<dyn Sink>, outbox: &Outbox) {
    loop {
        match outbox.next() {
            Out::Event(event) => {
                events::emit(sink, INTEGRATED_EVENT, &Payload { id, event: &event });
            }
            Out::Reply(waiting, reply) => {
                let _ = waiting.send(reply);
            }
            Out::Last(then) => {
                then();
                return;
            }
        }
    }
}

fn write_lines(mut stdin: ChildStdin, lines: Receiver<Line>) {
    for (line, went) in lines {
        let result = stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("could not write to the agent: {e}"));
        let failed = result.is_err();
        let _ = went.send(result);
        if failed {
            break;
        }
    }
    // Dropping stdin here is what closes it.
}

/// Reads the agent's stdout a line at a time, each line at most
/// [`LINE_KEEP`] long: the rest of a longer one is skipped, and said to be.
fn read_lines(live: &Live, stdout: impl Read, _reading: Sender<()>) {
    let mut reader = BufReader::new(stdout);
    let mut line: Vec<u8> = Vec::new();
    let mut skipping = false;
    loop {
        let available = match reader.fill_buf() {
            Ok([]) => break,
            Ok(available) => available,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let end = available.iter().position(|&byte| byte == b'\n');
        let piece = &available[..end.unwrap_or(available.len())];
        if skipping {
            live.skipping(piece);
        } else if line.len() + piece.len() > LINE_KEEP {
            skipping = true;
            live.fail(
                ErrorKind::Protocol,
                format!(
                    "the agent wrote a line longer than {} MiB, which was skipped",
                    LINE_KEEP / (1024 * 1024)
                ),
            );
            live.skipping(&line);
            live.skipping(piece);
            line.clear();
        } else {
            line.extend_from_slice(piece);
        }
        let used = end.map_or(available.len(), |at| at + 1);
        reader.consume(used);
        if end.is_some() {
            if skipping {
                live.skipped();
            } else {
                let text = String::from_utf8_lossy(&line);
                let text = text.trim();
                if !text.is_empty() {
                    live.outbox.room();
                    live.take(text);
                }
            }
            line.clear();
            skipping = false;
        }
    }
}

fn keep_tail(mut stderr: impl Read, tail: Arc<Mutex<String>>) {
    let mut buffer = [0u8; 1024];
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let mut text = tail.lock().expect("stderr lock");
                text.push_str(&String::from_utf8_lossy(&buffer[..n]));
                if text.len() > STDERR_KEEP {
                    let cut = text.len() - STDERR_KEEP;
                    let at = (cut..=text.len())
                        .find(|&i| text.is_char_boundary(i))
                        .unwrap_or(text.len());
                    text.drain(..at);
                }
            }
        }
    }
}

/// Kills the agent and everything in its process group.
fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    if let Ok(group) = i32::try_from(child.id()) {
        // The group is the child's own, made at its start.
        unsafe {
            libc::killpg(group, libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    let _ = child.kill();
}

/// Ends what the agent left running in its process group once it is gone
/// itself: asked to end, and killed if any of it is still there a little
/// later.
fn end_group(child: &Child) {
    #[cfg(unix)]
    if let Ok(group) = i32::try_from(child.id()) {
        // The group lives as long as one of its members does, so its id is
        // not given to another process until it is empty.
        let left = || unsafe { libc::killpg(group, 0) } == 0;
        unsafe {
            libc::killpg(group, libc::SIGTERM);
        }
        let deadline = std::time::Instant::now() + GROUP_GRACE;
        while left() && std::time::Instant::now() < deadline {
            std::thread::sleep(POLL);
        }
        if left() {
            unsafe {
                libc::killpg(group, libc::SIGKILL);
            }
        }
    }
    #[cfg(not(unix))]
    let _ = child;
}

/// Asks the agent alone to end, as a terminal's close would. Claude Code
/// ends the commands it left running in the background then, which run in
/// process groups of their own that killing its group does not reach.
/// Whether there was a way to ask.
fn ask_to_end(child: &Child) -> bool {
    #[cfg(unix)]
    if let Ok(pid) = i32::try_from(child.id()) {
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        return true;
    }
    let _ = child;
    false
}

/// Waits for the child to end, then for the last of its output. Asked to
/// end it, the waiter asks the agent to end, and kills it and its group
/// if it is still there a little later.
fn wait(
    live: &Live,
    mut child: Child,
    killed: Receiver<()>,
    read_done: Receiver<()>,
) -> Option<std::process::ExitStatus> {
    let mut deadline: Option<std::time::Instant> = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                let asked = killed.recv_timeout(POLL).is_ok();
                if asked && deadline.is_none() {
                    if ask_to_end(&child) {
                        deadline = Some(std::time::Instant::now() + TERM_GRACE);
                    } else {
                        kill_tree(&mut child);
                    }
                }
                if deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline) {
                    kill_tree(&mut child);
                }
            }
            Err(_) => {
                kill_tree(&mut child);
                break child.wait().ok();
            }
        }
    };
    end_group(&child);
    let _ = read_done.recv_timeout(DRAIN);
    live.outbox.close();
    live.writer.lock().expect("writer lock").take();
    status
}

/// Closes what the process left open and says it is gone.
fn finish(live: &Live, name: &str, status: Option<std::process::ExitStatus>, said: String) {
    let mut machine = live.machine.lock().expect("machine lock");
    let mut out = Vec::new();
    machine.tracker.end(&mut out);
    for (_, waiting) in machine.replies.drain() {
        live.put(Out::Reply(waiting, Err("the agent ended".into())));
    }
    machine.ready.take();
    machine.held.clear();
    machine.handed = None;
    let code = status.and_then(|status| status.code());
    let clean = status.is_some_and(|status| status.success());
    if !clean && !live.stopping.load(Ordering::SeqCst) {
        let how = match code {
            Some(code) => format!("{name} ended with code {code}"),
            None => format!("{name} was ended by a signal"),
        };
        let message = if said.is_empty() {
            how
        } else {
            format!("{how}: {said}")
        };
        out.push(Event::Error {
            kind: ErrorKind::Process,
            message,
        });
    }
    out.push(Event::Ended { code, clean });
    live.emit(&out);
    machine.ended = true;
}

/// Sends the user's message under `message`, the id the window chose for
/// it, a UUID it has not used before in the session. The events that name
/// the message may arrive before this returns.
pub fn send(
    sessions: &Sessions,
    id: &str,
    message: &str,
    text: &str,
    images: &[Image],
) -> Result<(), String> {
    let live = sessions.get(id)?;
    if text.trim().is_empty() && images.is_empty() {
        return Err("there is nothing to send".into());
    }
    let went = {
        let mut machine = live.machine.lock().expect("machine lock");
        let queued = machine.tracker.send(message)?;
        // An agent that takes no message mid-turn may have no conversation
        // to take one into before it is ready, so it is held till then too.
        let holding = !machine.driver.takes_while_busy();
        let hold = holding
            && (machine.ready.is_some()
                || machine.tracker.turn
                || machine.handed.is_some()
                || !machine.held.is_empty());
        let went = if hold {
            machine.held.push_back(Held {
                message: message.to_string(),
                text: text.to_string(),
                images: images.to_vec(),
            });
            None
        } else {
            let sent = machine
                .driver
                .message(message, text, images)
                .and_then(|line| live.enqueue(line));
            match sent {
                Ok(went) => {
                    if holding {
                        machine.handed = Some(message.to_string());
                    }
                    Some(went)
                }
                Err(error) => {
                    machine.tracker.refused(message);
                    return Err(error);
                }
            }
        };
        let told = Event::Message {
            message: message.to_string(),
            state: if queued {
                MessageState::Queued
            } else {
                MessageState::Sent
            },
            error: None,
            text: Some(text.to_string()),
            images: images.to_vec(),
        };
        machine
            .tracker
            .told
            .insert(message.to_string(), told.clone());
        let mut out = vec![told];
        machine.tracker.push_state(&mut out);
        live.emit(&out);
        went
    };
    match went {
        Some(went) => live.written(went),
        None => Ok(()),
    }
}

/// Answers a permission request with one of the choices it offered.
/// `message` goes with a denial, for the agent to read.
pub fn answer(
    sessions: &Sessions,
    id: &str,
    request: &str,
    choice: Choice,
    message: Option<&str>,
) -> Result<(), String> {
    let live = sessions.get(id)?;
    let said = message
        .map(str::trim)
        .filter(|said| !said.is_empty() && matches!(choice, Choice::Deny | Choice::Cancel));
    let answered = Event::Answered {
        request: request.to_string(),
        choice,
        answers: None,
        message: said.map(str::to_string),
    };
    settle(
        &live,
        |_| Ok(answered),
        |driver| driver.answer(request, choice, message),
    )
}

/// Answers a question the agent asked: for each question, the labels the
/// user picked or, where the question takes them, words of their own. None
/// declines to answer. Every window is told the answers but those to a
/// secret question.
pub fn reply(
    sessions: &Sessions,
    id: &str,
    request: &str,
    answers: Option<&[Vec<String>]>,
) -> Result<(), String> {
    let live = sessions.get(id)?;
    let answered = |tracker: &Tracker| {
        let questions = tracker.questions(request).unwrap_or_default();
        if let Some(answers) = answers {
            for (question, answer) in questions.iter().zip(answers) {
                if question.other {
                    continue;
                }
                let labels: Vec<&str> = question.options.iter().map(|o| o.label.as_str()).collect();
                if let Some(own) = answer
                    .iter()
                    .map(|picked| picked.trim())
                    .find(|picked| !picked.is_empty() && !labels.contains(picked))
                {
                    return Err(format!(
                        "{own:?} is not one of the options of {:?}",
                        question.question
                    ));
                }
            }
        }
        Ok(Event::Answered {
            request: request.to_string(),
            choice: if answers.is_some() {
                Choice::Allow
            } else {
                Choice::Deny
            },
            answers: answers.map(|answers| {
                answers
                    .iter()
                    .enumerate()
                    .map(|(at, answer)| {
                        let secret = questions.get(at).is_some_and(|question| question.secret);
                        (!secret).then(|| answer.clone())
                    })
                    .collect()
            }),
            message: None,
        })
    };
    settle(&live, answered, |driver| driver.reply(request, answers))
}

/// Writes the line that settles a request the agent is waiting on, and
/// says it was answered, as `answered` tells it from what was asked.
fn settle(
    live: &Live,
    answered: impl FnOnce(&Tracker) -> Result<Event, String>,
    line: impl FnOnce(&mut dyn Driver) -> Result<String, String>,
) -> Result<(), String> {
    let went = {
        let mut machine = live.machine.lock().expect("machine lock");
        let answered = answered(&machine.tracker)?;
        let line = line(machine.driver.as_mut())?;
        let went = live.enqueue(line)?;
        let mut out = Vec::new();
        machine.tracker.observe(answered, &mut out);
        live.emit(&out);
        went
    };
    live.written(went)
}

/// Sends a control request and waits for the agent's reply.
pub fn control(sessions: &Sessions, id: &str, control: &Control) -> Result<Value, String> {
    request(
        sessions,
        id,
        control,
        std::time::Instant::now() + CONTROL_TIMEOUT,
    )
}

/// Sends a control request and waits for the agent's reply, for as long
/// as a request may and no later than `by`. Nothing is sent once `by` has
/// passed, so that no change is made after its caller was told it failed.
fn request(
    sessions: &Sessions,
    id: &str,
    control: &Control,
    by: std::time::Instant,
) -> Result<Value, String> {
    let live = sessions.get(id)?;
    if std::time::Instant::now() >= by {
        return Err("no time was left to ask the agent".into());
    }
    let (went, waiting) = {
        let mut machine = live.machine.lock().expect("machine lock");
        let sending = machine.driver.control(control)?;
        let mut out = Vec::new();
        if *control == Control::Interrupt {
            machine.tracker.interrupted(&mut out);
        }
        match sending {
            Sending::Local { reply, events } => {
                for event in events {
                    machine.tracker.observe(bounded(event), &mut out);
                }
                live.emit(&out);
                // Through the outbox like the agent's own replies, so that
                // it comes back after the events it made.
                let (replied, local) = mpsc::channel();
                live.put(Out::Reply(replied, Ok(reply)));
                (None, Some((None, local)))
            }
            Sending::Line { line } => {
                live.emit(&out);
                (Some(live.enqueue(line)?), None)
            }
            Sending::Request { line, key } => {
                live.emit(&out);
                let (replied, reply) = mpsc::channel();
                machine.replies.insert(key.clone(), replied);
                match live.enqueue(line) {
                    Ok(went) => (Some(went), Some((Some(key), reply))),
                    Err(error) => {
                        machine.replies.remove(&key);
                        machine.driver.forget(&key);
                        return Err(error);
                    }
                }
            }
        }
    };
    if let Some(went) = went {
        live.written(went)?;
    }
    let Some((key, reply)) = waiting else {
        return Ok(Value::Null);
    };
    let by = by.min(std::time::Instant::now() + CONTROL_TIMEOUT);
    match reply.recv_timeout(by.saturating_duration_since(std::time::Instant::now())) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => match key {
            Some(key) => {
                let mut machine = live.machine.lock().expect("machine lock");
                machine.replies.remove(&key);
                machine.driver.forget(&key);
                Err("the agent did not answer in time".into())
            }
            None => Err("the session's news did not go out in time".into()),
        },
        Err(RecvTimeoutError::Disconnected) => Err("the agent ended".into()),
    }
}

/// What a window that comes to the session late reads to catch up. Comes
/// back once every event that went out before it has reached the sink.
pub fn snapshot(sessions: &Sessions, id: &str) -> Result<Snapshot, String> {
    let live = sessions.get(id)?;
    let (snapshot, out) = {
        let machine = live.machine.lock().expect("machine lock");
        let (passed, out) = mpsc::channel();
        live.put(Out::Reply(passed, Ok(Value::Null)));
        (machine.tracker.snapshot(), out)
    };
    match out.recv_timeout(CONTROL_TIMEOUT) {
        Ok(_) => Ok(snapshot),
        Err(RecvTimeoutError::Timeout) => Err("the session's news did not go out in time".into()),
        Err(RecvTimeoutError::Disconnected) => Err("the agent ended".into()),
    }
}

/// Switches what the session runs on: each of the model, the mode and the
/// effort that is given, in that order, all within [`CONFIGURE_TIMEOUT`].
/// Answers with the settings as the session's events now say them.
pub fn configure(
    sessions: &Sessions,
    id: &str,
    model: Option<&str>,
    mode: Option<&str>,
    effort: Option<&str>,
) -> Result<Settings, String> {
    let by = std::time::Instant::now() + CONFIGURE_TIMEOUT;
    if let Some(model) = model {
        request(sessions, id, &Control::SetModel(model.to_string()), by)?;
    }
    if let Some(mode) = mode {
        request(sessions, id, &Control::SetMode(mode.to_string()), by)?;
    }
    if let Some(effort) = effort {
        request(sessions, id, &Control::SetEffort(effort.to_string()), by)?;
    }
    let live = sessions.get(id)?;
    let machine = live.machine.lock().expect("machine lock");
    Ok(machine.tracker.settings.clone())
}

/// Ends a session: its stdin closes, which the agent takes as the end of
/// the conversation. One still there a few seconds later is asked to end,
/// and killed with its group if it is still there after that. Comes back
/// at once; [`Event::Ended`] says when it is gone.
pub fn stop(sessions: &Arc<Sessions>, id: &str) -> Result<(), String> {
    let live = sessions.get(id)?;
    live.stopping.store(true, Ordering::SeqCst);
    if live.writer.lock().expect("writer lock").take().is_none() {
        // Stopped already, and on its way out.
        return Ok(());
    }
    let sessions = Arc::clone(sessions);
    let id = id.to_string();
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + STOP_GRACE;
        while sessions.holds(&id) && std::time::Instant::now() < deadline {
            std::thread::sleep(POLL);
        }
        if sessions.holds(&id) {
            live.kill();
        }
    });
    Ok(())
}

/// Stops every session, and waits, a little longer than one stop takes,
/// for them to be gone: for the end of the app or of the daemon, so that
/// no agent outlives either.
pub fn stop_all(sessions: &Arc<Sessions>) {
    for id in sessions.ids() {
        let _ = stop(sessions, &id);
    }
    let deadline =
        std::time::Instant::now() + STOP_GRACE + TERM_GRACE + GROUP_GRACE + Duration::from_secs(1);
    while !sessions.ids().is_empty() && std::time::Instant::now() < deadline {
        std::thread::sleep(POLL);
    }
}

#[cfg(all(test, unix))]
#[path = "integrated_stand_in.rs"]
mod stand_in;

#[cfg(all(test, unix))]
#[path = "codex_stand_in.rs"]
mod codex_stand_in;

#[cfg(test)]
mod tests {
    use super::*;

    const M1: &str = "11111111-1111-4111-8111-111111111111";
    const M2: &str = "22222222-2222-4222-8222-222222222222";
    const M3: &str = "33333333-3333-4333-8333-333333333333";

    fn tracked(events: Vec<Event>) -> (Tracker, Vec<Event>) {
        let mut tracker = Tracker::default();
        let mut out = Vec::new();
        for event in events {
            tracker.observe(event, &mut out);
        }
        (tracker, out)
    }

    fn states(out: &[Event]) -> Vec<SessionState> {
        out.iter()
            .filter_map(|event| match event {
                Event::State { state } => Some(*state),
                _ => None,
            })
            .collect()
    }

    fn started(out: &[Event]) -> Vec<Vec<String>> {
        out.iter()
            .filter_map(|event| match event {
                Event::TurnStarted { messages } => Some(messages.clone()),
                _ => None,
            })
            .collect()
    }

    fn turn(messages: &[&str]) -> Event {
        Event::TurnStarted {
            messages: messages.iter().map(|m| m.to_string()).collect(),
        }
    }

    fn ended() -> Event {
        Event::TurnEnded {
            outcome: Outcome::Done,
            error: None,
            total_cost_usd: None,
            duration_ms: None,
            usage: None,
        }
    }

    fn asked(request: &str) -> Event {
        Event::PermissionAsked {
            request: request.into(),
            call: None,
            parent: None,
            tool: "Bash".into(),
            input: Value::Null,
            truncated: false,
            description: None,
            path: None,
            choices: vec![],
        }
    }

    #[test]
    fn a_turn_answers_the_messages_the_agent_names() {
        let mut tracker = Tracker::default();
        assert!(!tracker.send(M1).unwrap());
        let mut out = Vec::new();
        tracker.observe(turn(&[M1]), &mut out);
        assert!(
            tracker.send(M2).unwrap(),
            "a message sent during a turn waits"
        );
        assert!(tracker.send(M3).unwrap());
        tracker.observe(ended(), &mut out);
        // The agent took both waiting messages into one turn.
        tracker.observe(turn(&[M2, M3]), &mut out);
        assert_eq!(
            started(&out),
            [vec![M1.to_string()], vec![M2.to_string(), M3.to_string()]]
        );
        assert!(tracker.pending.is_empty());
    }

    #[test]
    fn a_message_id_is_a_uuid_used_once() {
        let mut tracker = Tracker::default();
        assert!(tracker.send("message-1").is_err());
        tracker.send(M1).unwrap();
        assert!(tracker.send(M1).is_err(), "used already");
    }

    #[test]
    fn a_turn_the_agent_began_takes_no_message_waiting_for_another() {
        // A message is waiting when the agent starts a turn of its own: the
        // turn names nothing, and the message stays waiting for its own.
        let mut tracker = Tracker::default();
        tracker.send(M1).unwrap();
        let mut out = Vec::new();
        tracker.observe(turn(&[]), &mut out);
        tracker.observe(ended(), &mut out);
        tracker.observe(turn(&[M1]), &mut out);
        assert_eq!(started(&out), [vec![], vec![M1.to_string()]]);
    }

    #[test]
    fn a_message_taken_into_the_running_turn_is_no_longer_waiting() {
        let mut tracker = Tracker::default();
        let mut out = Vec::new();
        tracker.observe(turn(&[]), &mut out);
        tracker.send(M1).unwrap();
        tracker.observe(turn(&[M1]), &mut out);
        assert_eq!(started(&out).len(), 1, "the same turn");
        assert!(out.contains(&Event::message(M1, MessageState::Taken, None)));
        tracker.observe(ended(), &mut out);
        assert_eq!(tracker.state(), SessionState::Idle);
    }

    #[test]
    fn an_end_with_no_start_starts_the_turn_first() {
        let (_, out) = tracked(vec![ended()]);
        assert_eq!(out[0], turn(&[]));
        assert!(matches!(out[2], Event::TurnEnded { .. }), "{out:?}");
    }

    #[test]
    fn names_the_agent_never_had_are_left_out() {
        let (_, out) = tracked(vec![turn(&[M1])]);
        assert_eq!(out[0], turn(&[]));
    }

    #[test]
    fn asking_outranks_working_and_idle_follows_both() {
        let (_, out) = tracked(vec![
            turn(&[]),
            asked("r"),
            Event::Withdrawn {
                request: "r".into(),
            },
            Event::QuestionAsked {
                request: "q".into(),
                call: None,
                parent: None,
                questions: vec![],
            },
            Event::Withdrawn {
                request: "q".into(),
            },
            ended(),
        ]);
        assert_eq!(
            states(&out),
            [
                SessionState::Working,
                SessionState::Asking,
                SessionState::Working,
                SessionState::Asking,
                SessionState::Working,
                SessionState::Idle
            ]
        );
    }

    #[test]
    fn a_running_subagent_keeps_the_session_working_after_the_turn() {
        let task = |kind| Event::TaskStarted {
            task: "t".into(),
            call: Some("c".into()),
            kind,
            description: None,
            prompt: None,
            background: true,
            ambient: false,
        };
        let (_, out) = tracked(vec![
            turn(&[]),
            task(TaskKind::Agent),
            ended(),
            Event::TaskFinished {
                task: "t".into(),
                call: Some("c".into()),
                status: TaskStatus::Completed,
                summary: None,
                reports: true,
            },
            turn(&[]),
            ended(),
        ]);
        assert_eq!(states(&out), [SessionState::Working, SessionState::Idle]);

        // A shell left running in the background does not.
        let (tracker, _) = tracked(vec![turn(&[]), task(TaskKind::Shell), ended()]);
        assert_eq!(tracker.state(), SessionState::Idle);
    }

    #[test]
    fn housekeeping_and_tasks_with_no_report_leave_the_session_idle() {
        let task = |ambient| Event::TaskStarted {
            task: "t".into(),
            call: Some("c".into()),
            kind: TaskKind::Agent,
            description: None,
            prompt: None,
            background: true,
            ambient,
        };
        let (tracker, _) = tracked(vec![turn(&[]), task(true), ended()]);
        assert_eq!(tracker.state(), SessionState::Idle, "housekeeping");

        // An agent that reports no task in a turn of its own is idle once
        // the task is done.
        let (tracker, _) = tracked(vec![
            turn(&[]),
            task(false),
            ended(),
            Event::TaskFinished {
                task: "t".into(),
                call: Some("c".into()),
                status: TaskStatus::Completed,
                summary: None,
                reports: false,
            },
        ]);
        assert_eq!(tracker.state(), SessionState::Idle);
    }

    #[test]
    fn text_with_no_turn_running_starts_one() {
        let (_, out) = tracked(vec![Event::Text {
            block: "b".into(),
            parent: None,
            text: "hi".into(),
            done: false,
        }]);
        assert_eq!(out[0], turn(&[]));
        // A subagent's text does not: the main conversation may be idle.
        let (tracker, _) = tracked(vec![Event::Text {
            block: "b".into(),
            parent: Some("c".into()),
            text: "hi".into(),
            done: false,
        }]);
        assert!(!tracker.turn);
    }

    #[test]
    fn the_end_closes_the_turn_withdraws_what_was_asked_and_drops_what_waits() {
        let (mut tracker, _) = tracked(vec![turn(&[]), asked("r")]);
        tracker.send(M1).unwrap();
        let mut out = Vec::new();
        tracker.end(&mut out);
        assert!(matches!(
            out[0],
            Event::TurnEnded {
                outcome: Outcome::Failed,
                ..
            }
        ));
        assert_eq!(
            out[1],
            Event::Withdrawn {
                request: "r".into()
            }
        );
        assert!(matches!(
            &out[2],
            Event::Message { message, state: MessageState::Dropped, .. } if message == M1
        ));
    }

    #[test]
    fn the_settings_are_what_the_events_last_said() {
        let (tracker, _) = tracked(vec![
            Event::Ready {
                session_id: "s".into(),
                model: Some("haiku".into()),
                mode: Some("default".into()),
                effort: None,
                version: None,
                models: vec![],
                modes: vec![],
                efforts: vec![],
                commands: vec![],
            },
            Event::Configured {
                model: Some("sonnet".into()),
                mode: Some("default".into()),
                effort: Some("high".into()),
                efforts: vec!["high".into()],
            },
        ]);
        assert_eq!(
            tracker.settings,
            Settings {
                model: Some("sonnet".into()),
                mode: Some("default".into()),
                effort: Some("high".into())
            }
        );
    }

    #[test]
    fn compacting_keeps_the_session_working_until_it_is_done() {
        let (_, out) = tracked(vec![
            Event::Compacting,
            Event::Compacted {
                reason: Some(CompactReason::Full),
                tokens_before: None,
                tokens_after: None,
            },
        ]);
        assert_eq!(states(&out), [SessionState::Working, SessionState::Idle]);
    }

    #[test]
    fn calls_left_open_close_with_the_turn_or_their_subagent() {
        let started = |call: &str, parent: Option<&str>| Event::ToolStarted {
            call: call.into(),
            parent: parent.map(str::to_string),
            name: "Bash".into(),
            kind: ToolKind::Command,
        };
        let (mut tracker, out) = tracked(vec![
            turn(&[]),
            started("main", None),
            Event::TaskStarted {
                task: "t".into(),
                call: Some("agent".into()),
                kind: TaskKind::Agent,
                description: None,
                prompt: None,
                background: true,
                ambient: false,
            },
            started("sub", Some("agent")),
            ended(),
        ]);
        let closed = |out: &[Event]| -> Vec<String> {
            out.iter()
                .filter_map(|event| match event {
                    Event::ToolFinished {
                        call, error: true, ..
                    } => Some(call.clone()),
                    _ => None,
                })
                .collect()
        };
        assert_eq!(closed(&out), ["main"], "the subagent's call runs on");
        let at = out
            .iter()
            .position(|e| matches!(e, Event::TurnEnded { .. }))
            .unwrap();
        assert!(
            matches!(out[at - 1], Event::ToolFinished { .. }),
            "before the end"
        );
        let mut out = Vec::new();
        tracker.observe(
            Event::TaskFinished {
                task: "t".into(),
                call: Some("agent".into()),
                status: TaskStatus::Lost,
                summary: None,
                reports: false,
            },
            &mut out,
        );
        assert_eq!(closed(&out), ["sub"]);
        assert_eq!(
            tracker.state(),
            SessionState::Idle,
            "no report follows a lost task"
        );
    }

    #[test]
    fn an_interrupt_while_idle_stops_waiting_for_a_report() {
        let (mut tracker, _) = tracked(vec![
            Event::TaskStarted {
                task: "t".into(),
                call: None,
                kind: TaskKind::Agent,
                description: None,
                prompt: None,
                background: true,
                ambient: false,
            },
            Event::TaskFinished {
                task: "t".into(),
                call: None,
                status: TaskStatus::Failed,
                summary: None,
                reports: true,
            },
        ]);
        assert_eq!(tracker.state(), SessionState::Working);
        let mut out = Vec::new();
        tracker.interrupted(&mut out);
        assert_eq!(states(&out), [SessionState::Idle]);
    }

    #[test]
    fn long_output_and_whole_files_are_cut_down_and_say_so() {
        let event = bounded(Event::ToolFinished {
            call: "c".into(),
            parent: None,
            output: "é".repeat(OUTPUT_KEEP),
            error: false,
            truncated: false,
            changes: vec![FileChange {
                path: "/a".into(),
                kind: ChangeKind::Create,
                to: None,
                hunks: vec![],
                content: Some("x".repeat(CONTENT_KEEP + 1)),
                truncated: false,
            }],
        });
        let Event::ToolFinished {
            output,
            truncated,
            changes,
            ..
        } = event
        else {
            unreachable!()
        };
        assert!(truncated && output.len() <= OUTPUT_KEEP);
        assert!(changes[0].truncated);
        assert_eq!(changes[0].content.as_ref().unwrap().len(), CONTENT_KEEP);

        let event = bounded(Event::ToolInput {
            call: "c".into(),
            parent: None,
            delta: None,
            input: Some(serde_json::json!({"content": "x".repeat(OUTPUT_KEEP + 1), "n": 1})),
            truncated: false,
        });
        assert!(matches!(
            event,
            Event::ToolInput {
                truncated: true,
                ..
            }
        ));

        // Streamed pieces past the limit are not passed on.
        let mut tracker = Tracker::default();
        let mut out = Vec::new();
        for _ in 0..3 {
            tracker.observe(
                Event::ToolOutput {
                    call: "c".into(),
                    parent: None,
                    delta: "x".repeat(CONTENT_KEEP / 2),
                },
                &mut out,
            );
        }
        let pieces = out
            .iter()
            .filter(|e| matches!(e, Event::ToolOutput { .. }))
            .count();
        assert_eq!(pieces, 2);
    }

    /// An agent that takes no message while a turn runs, spoken to in
    /// lines of words: `start <ids>` begins a turn for the messages named,
    /// `end` ends it, `ack` is a reply that means nothing, `drop <id>`
    /// says a message will not be answered, `answer <key>` answers a
    /// request, `fatal` ends the turn and says the session cannot go on. The line it sends a message with names the model it runs
    /// on when it is sent. A model is settled without asking it; a mode or
    /// an effort is asked for with `ask <key>`.
    struct Fake {
        model: String,
    }

    fn fake() -> Box<Fake> {
        Box::new(Fake {
            model: "haiku".into(),
        })
    }

    impl Driver for Fake {
        fn opening(&mut self) -> Vec<String> {
            vec![]
        }

        fn read(&mut self, line: &str) -> Reading {
            let mut words = line.split(' ');
            let events = match (words.next(), words.next()) {
                (Some("start"), named) => vec![Event::TurnStarted {
                    messages: named
                        .into_iter()
                        .flat_map(|named| named.split(','))
                        .map(str::to_string)
                        .collect(),
                }],
                (Some("end"), _) => vec![ended()],
                (Some("ready"), _) => vec![Event::Ready {
                    session_id: "minted".into(),
                    model: Some(self.model.clone()),
                    mode: None,
                    effort: None,
                    version: None,
                    models: vec![],
                    modes: vec![],
                    efforts: vec![],
                    commands: vec![],
                }],
                (Some("drop"), Some(message)) => vec![Event::message(
                    message,
                    MessageState::Dropped,
                    Some("refused".into()),
                )],
                (Some("question"), Some(request)) => vec![Event::QuestionAsked {
                    request: request.to_string(),
                    call: None,
                    parent: None,
                    questions: vec![
                        Question {
                            header: None,
                            question: "Password?".into(),
                            options: vec![],
                            multiple: false,
                            secret: true,
                            other: true,
                        },
                        Question {
                            header: None,
                            question: "Go on?".into(),
                            options: ["yes", "no"]
                                .map(|label| QuestionOption {
                                    label: label.into(),
                                    description: None,
                                })
                                .into(),
                            multiple: false,
                            secret: false,
                            other: false,
                        },
                    ],
                }],
                (Some("answer"), Some(key)) => {
                    return Reading {
                        replies: vec![(key.to_string(), Ok(Value::Null))],
                        ..Reading::default()
                    }
                }
                (Some("fatal"), _) => {
                    return Reading {
                        events: vec![ended()],
                        fatal: Some((ErrorKind::Protocol, "cannot go on".into())),
                        ..Reading::default()
                    }
                }
                _ => vec![],
            };
            Reading {
                events,
                ..Reading::default()
            }
        }

        fn takes_while_busy(&self) -> bool {
            false
        }

        fn message(&mut self, message: &str, text: &str, _: &[Image]) -> Result<String, String> {
            if text == "bad" {
                return Err("not a message this agent takes".into());
            }
            Ok(format!("send {message} {text} on {}", self.model))
        }

        fn answer(&mut self, _: &str, _: Choice, _: Option<&str>) -> Result<String, String> {
            Err("nothing asked".into())
        }

        fn reply(&mut self, request: &str, _: Option<&[Vec<String>]>) -> Result<String, String> {
            Ok(format!("reply {request}"))
        }

        fn control(&mut self, control: &Control) -> Result<Sending, String> {
            let model = match control {
                Control::SetModel(model) => model,
                Control::SetMode(key) | Control::SetEffort(key) => {
                    return Ok(Sending::Request {
                        line: format!("ask {key}"),
                        key: key.clone(),
                    })
                }
                Control::Compact => {
                    return Ok(Sending::Line {
                        line: "compact".into(),
                    })
                }
                Control::Interrupt => return Err("not here".into()),
            };
            self.model = model.clone();
            Ok(Sending::Local {
                reply: serde_json::json!({ "model": model }),
                events: vec![Event::Configured {
                    model: Some(model.clone()),
                    mode: None,
                    effort: None,
                    efforts: vec![],
                }],
            })
        }
    }

    /// A session around a driver with no process: what it writes comes out
    /// of the receiver, and what the agent says goes in through `take`.
    struct Bench {
        sessions: Arc<Sessions>,
        live: Arc<Live>,
        written: Receiver<String>,
        recorder: Arc<crate::events::testing::Recorder>,
    }

    impl Bench {
        fn new(driver: Box<dyn Driver>) -> Self {
            Self::with(driver, None, None)
        }

        /// A session whose agent has not said it is ready yet.
        fn starting(driver: Box<dyn Driver>) -> Self {
            Self::with(driver, Some(mpsc::channel().0), None)
        }

        /// A session whose news goes to `sink` rather than the recorder.
        fn into(driver: Box<dyn Driver>, sink: Arc<dyn Sink>) -> Self {
            Self::with(driver, None, Some(sink))
        }

        fn with(
            driver: Box<dyn Driver>,
            ready: Option<Sender<()>>,
            sink: Option<Arc<dyn Sink>>,
        ) -> Self {
            let recorder = Arc::new(crate::events::testing::Recorder::default());
            let outbox = Arc::new(Outbox::default());
            let (lines, queued) = mpsc::channel::<Line>();
            let (kill, _) = mpsc::channel();
            let (seen, written) = mpsc::channel();
            std::thread::spawn({
                let sink: Arc<dyn Sink> = sink.unwrap_or_else(|| recorder.clone());
                let outbox = Arc::clone(&outbox);
                move || send_out("int-bench", &sink, &outbox)
            });
            std::thread::spawn(move || {
                for (line, went) in queued {
                    let _ = went.send(Ok(()));
                    let _ = seen.send(line);
                }
            });
            let live = Arc::new(Live::new(
                "int-bench".into(),
                Machine::new(driver, ready),
                outbox,
                lines,
                kill,
            ));
            let sessions = Arc::new(Sessions::default());
            sessions
                .inner
                .lock()
                .unwrap()
                .insert("int-bench".into(), Arc::clone(&live));
            Self {
                sessions,
                live,
                written,
                recorder,
            }
        }

        fn send(&self, message: &str, text: &str) {
            send(&self.sessions, "int-bench", message, text, &[]).unwrap();
        }

        /// The next line written, or None when none comes.
        fn next(&self) -> Option<String> {
            self.written.recv_timeout(Duration::from_millis(200)).ok()
        }

        fn events(&self) -> Vec<Value> {
            // What has been put out reaches the recorder in order; a reply
            // put out after it means everything before it is there.
            let (replied, reply) = mpsc::channel();
            self.live.put(Out::Reply(replied, Ok(Value::Null)));
            reply.recv().unwrap().unwrap();
            self.recorder
                .events
                .lock()
                .unwrap()
                .iter()
                .map(|(_, payload)| payload.clone())
                .collect()
        }
    }

    #[test]
    fn a_driver_that_cannot_go_on_ends_the_session_saying_why_once() {
        let bench = Bench::new(fake());
        bench.send(M1, "one");
        assert!(bench.next().is_some());
        bench.live.take("ack");
        bench.send(M2, "two");
        bench.live.take(&format!("start {M1}"));
        bench.live.take("fatal");
        bench.live.take("fatal");
        assert_eq!(bench.next(), None, "nothing held is handed over");
        let events = bench.events();
        let errors: Vec<&Value> = events.iter().filter(|e| e["type"] == "error").collect();
        assert_eq!(errors.len(), 1, "{events:?}");
        assert_eq!(errors[0]["kind"], "protocol");
        assert_eq!(errors[0]["message"], "cannot go on");
        let at = |kind: &str| events.iter().position(|e| e["type"] == kind).unwrap();
        assert!(at("turnEnded") < at("error"), "after the events");
        assert!(bench.live.stopping.load(Ordering::SeqCst));
    }

    #[test]
    fn an_agent_that_takes_no_message_mid_turn_gets_one_at_a_time() {
        let bench = Bench::new(fake());
        bench.send(M1, "one");
        assert_eq!(
            bench.next().as_deref(),
            Some(&*format!("send {M1} one on haiku"))
        );
        // The agent's answer to the request that started the turn, before
        // the turn itself: the next message waits for the turn to be named.
        bench.live.take("ack");
        bench.send(M2, "two");
        assert_eq!(bench.next(), None, "held until the first is named");
        bench.live.take(&format!("start {M1}"));
        bench.send(M3, "three");
        assert_eq!(bench.next(), None, "held while the turn runs");
        // A setting settled without the agent reaches the held message.
        let reply = control(
            &bench.sessions,
            "int-bench",
            &Control::SetModel("sonnet".into()),
        );
        assert_eq!(reply.unwrap()["model"], "sonnet");
        bench.live.take("end");
        assert_eq!(
            bench.next().as_deref(),
            Some(&*format!("send {M2} two on sonnet")),
            "built when it is handed over"
        );
        bench.live.take("ack");
        assert_eq!(bench.next(), None, "one at a time");
        bench.live.take(&format!("start {M2}"));
        bench.live.take("end");
        assert_eq!(
            bench.next().as_deref(),
            Some(&*format!("send {M3} three on sonnet"))
        );
        bench.live.take(&format!("start {M3}"));
        bench.live.take("end");
        assert_eq!(bench.next(), None);

        let events = bench.events();
        assert!(
            events
                .iter()
                .any(|event| event["type"] == "configured" && event["model"] == "sonnet"),
            "a setting settled without the agent is told"
        );
        assert_eq!(
            bench
                .live
                .machine
                .lock()
                .unwrap()
                .tracker
                .settings
                .model
                .as_deref(),
            Some("sonnet")
        );
        let states: Vec<Value> = events
            .into_iter()
            .filter(|event| event["type"] == "message")
            .map(|event| serde_json::json!([event["message"], event["state"]]))
            .collect();
        assert_eq!(
            states,
            [
                serde_json::json!([M1, "sent"]),
                serde_json::json!([M2, "queued"]),
                serde_json::json!([M3, "queued"]),
            ]
        );
        assert_eq!(
            bench.live.machine.lock().unwrap().tracker.state(),
            SessionState::Idle
        );
    }

    #[test]
    fn an_agent_that_takes_no_message_mid_turn_gets_none_before_it_is_ready() {
        let bench = Bench::starting(fake());
        bench.send(M1, "one");
        bench.send(M2, "two");
        assert_eq!(bench.next(), None, "held until the agent is ready");
        bench.live.take("ready");
        assert_eq!(
            bench.next().as_deref(),
            Some(&*format!("send {M1} one on haiku"))
        );
        assert_eq!(bench.next(), None, "one at a time");
        bench.live.take(&format!("start {M1}"));
        bench.live.take("end");
        assert_eq!(
            bench.next().as_deref(),
            Some(&*format!("send {M2} two on haiku"))
        );
    }

    #[test]
    fn a_change_of_settings_answers_in_time_however_many_requests_it_takes() {
        let Bench {
            sessions,
            live,
            written,
            ..
        } = Bench::new(fake());
        // The agent answers each request, but slowly: each in time on its
        // own, the two together not.
        let slow = CONFIGURE_TIMEOUT.mul_f64(0.66);
        assert!(slow < CONTROL_TIMEOUT);
        std::thread::spawn(move || {
            for line in written {
                if let Some(key) = line.strip_prefix("ask ") {
                    std::thread::sleep(slow);
                    live.take(&format!("answer {key}"));
                }
            }
        });
        let started = std::time::Instant::now();
        let changed = configure(&sessions, "int-bench", None, Some("plan"), Some("high"));
        assert!(changed.is_err(), "{changed:?}");
        let took = started.elapsed();
        assert!(
            took < CONFIGURE_TIMEOUT + Duration::from_millis(500),
            "{took:?}"
        );
    }

    #[test]
    fn a_snapshot_holds_what_no_transcript_does_and_follows_what_went_out() {
        let bench = Bench::new(fake());
        let empty = snapshot(&bench.sessions, "int-bench").unwrap();
        assert!(empty.ready.is_none(), "nothing before the agent is ready");
        bench.live.take("ready");
        bench.send(M1, "one");
        bench.live.take(&format!("start {M1}"));
        bench.send(M2, "two");
        bench.live.take("question q1");

        let taken = snapshot(&bench.sessions, "int-bench").unwrap();
        let seen: Vec<Value> = bench
            .recorder
            .events
            .lock()
            .unwrap()
            .iter()
            .map(|(_, payload)| payload.clone())
            .collect();
        assert!(
            seen.iter().any(|event| event["type"] == "questionAsked"),
            "what went out before it has reached the sink: {seen:?}"
        );
        let json = serde_json::to_value(&taken).unwrap();
        assert_eq!(json["state"], "asking");
        assert_eq!(json["turn"], true);
        assert_eq!(json["settings"]["model"], "haiku");
        assert_eq!(json["ready"]["type"], "ready");
        assert_eq!(json["ready"]["sessionId"], "minted");
        assert_eq!(json["requests"].as_array().unwrap().len(), 1);
        assert_eq!(json["requests"][0]["type"], "questionAsked");
        assert_eq!(json["requests"][0]["request"], "q1");
        assert_eq!(json["requests"][0]["questions"][0]["secret"], true);
        assert_eq!(
            json["messages"],
            serde_json::json!([{
                "type": "message", "message": M2, "state": "queued",
                "error": null, "text": "two", "images": [],
            }]),
            "only what no turn has taken yet"
        );

        reply(
            &bench.sessions,
            "int-bench",
            "q1",
            Some(&[vec!["x".into()], vec!["yes".into()]]),
        )
        .unwrap();
        bench.live.take("end");
        bench.live.take(&format!("start {M2}"));
        let later = snapshot(&bench.sessions, "int-bench").unwrap();
        assert!(later.requests.is_empty() && later.messages.is_empty());
        assert_eq!(later.state, SessionState::Working);
    }

    #[test]
    fn a_setting_settled_without_the_agent_answers_after_its_events() {
        let gate = Arc::new(Gate::default());
        let bench = Bench::into(fake(), gate.clone());
        let (answered, answer) = mpsc::channel();
        std::thread::spawn({
            let sessions = Arc::clone(&bench.sessions);
            move || {
                let reply = control(&sessions, "int-bench", &Control::SetModel("sonnet".into()));
                let _ = answered.send(reply);
            }
        });
        assert!(
            answer.recv_timeout(Duration::from_millis(300)).is_err(),
            "no answer while its event waits for the window"
        );
        *gate.open.lock().unwrap() = true;
        gate.opened.notify_all();
        let reply = answer.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(reply.unwrap()["model"], "sonnet");
        let taken = gate.taken.events.lock().unwrap();
        assert!(
            taken
                .iter()
                .any(|(_, event)| event["type"] == "configured" && event["model"] == "sonnet"),
            "{taken:?}"
        );
    }

    #[test]
    fn a_request_past_its_deadline_is_not_sent() {
        let bench = Bench::new(fake());
        let late = request(
            &bench.sessions,
            "int-bench",
            &Control::SetMode("plan".into()),
            std::time::Instant::now(),
        );
        assert!(late.is_err(), "{late:?}");
        assert_eq!(bench.next(), None, "nothing goes to the agent");
    }

    #[test]
    fn a_request_the_agent_answers_with_events_alone_is_done_once_written() {
        let bench = Bench::new(fake());
        let done = control(&bench.sessions, "int-bench", &Control::Compact).unwrap();
        assert_eq!(done, Value::Null);
        assert_eq!(bench.next().as_deref(), Some("compact"));
    }

    #[test]
    fn a_held_message_the_agent_cannot_take_is_dropped_and_the_next_goes() {
        let bench = Bench::new(fake());
        bench.send(M1, "one");
        bench.next();
        bench.send(M2, "bad");
        bench.send(M3, "three");
        // The agent turned the first down rather than take it.
        bench.live.take(&format!("drop {M1}"));
        assert_eq!(
            bench.next().as_deref(),
            Some(&*format!("send {M3} three on haiku"))
        );
        let dropped: Vec<Value> = bench
            .events()
            .into_iter()
            .filter(|event| event["type"] == "message" && event["state"] == "dropped")
            .map(|event| event["message"].clone())
            .collect();
        assert_eq!(dropped, [M1, M2]);
        // A message the agent refused on sending is not sent at all, and
        // its id is free again.
        assert!(send(&bench.sessions, "int-bench", M1, "again", &[]).is_err());
        assert!(send(&bench.sessions, "int-bench", "not-a-uuid", "x", &[]).is_err());
    }

    #[test]
    fn a_secret_answer_is_told_to_no_window_and_options_alone_take_no_own_words() {
        let bench = Bench::new(fake());
        bench.live.take("question q1");
        let own = reply(
            &bench.sessions,
            "int-bench",
            "q1",
            Some(&[vec!["hunter2".into()], vec!["maybe".into()]]),
        );
        assert!(own.unwrap_err().contains("not one of the options"));
        assert_eq!(bench.next(), None, "nothing goes to the agent");
        reply(
            &bench.sessions,
            "int-bench",
            "q1",
            Some(&[vec!["hunter2".into()], vec!["yes".into()]]),
        )
        .unwrap();
        assert_eq!(bench.next().as_deref(), Some("reply q1"));
        let events = bench.events();
        let asked = events
            .iter()
            .find(|event| event["type"] == "questionAsked")
            .unwrap();
        assert_eq!(asked["questions"][0]["secret"], true);
        assert_eq!(asked["questions"][1]["other"], false);
        let answered = events
            .iter()
            .find(|event| event["type"] == "answered")
            .unwrap();
        assert_eq!(answered["answers"], serde_json::json!([null, ["yes"]]));
        assert!(
            !serde_json::to_string(&events).unwrap().contains("hunter2"),
            "the secret is in no event"
        );
    }

    /// An agent that makes its own conversation ids, run as `cat`.
    #[cfg(unix)]
    struct Minting;

    #[cfg(unix)]
    impl Protocol for Minting {
        fn name(&self) -> &'static str {
            "minting"
        }

        fn command(&self, _: &Launch) -> Result<Prepared, String> {
            Ok(Prepared {
                command: std::process::Command::new("cat"),
                files: vec![],
            })
        }

        fn driver(&self, _: &Launch) -> Box<dyn Driver> {
            fake()
        }

        fn trusted(&self, _: &Path, _: Option<&Path>, _: &Path) -> bool {
            true
        }

        fn trust(&self, _: &Path, _: Option<&Path>, _: &Path) -> Result<(), String> {
            Ok(())
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_start_says_no_conversation_id_it_does_not_know() {
        let vars = HashMap::new();
        let launch = |session| Launch {
            project: Path::new("/"),
            env: &vars,
            session,
            resume: session.is_some(),
            model: None,
            mode: None,
            effort: None,
            config_dir: None,
            tool_server: None,
            orchestrator: false,
        };
        let sessions = Arc::new(Sessions::default());
        for (session, said) in [(None, None), (Some("resumed"), Some("resumed".to_string()))] {
            let started = start(
                Arc::new(crate::events::testing::Recorder::default()),
                Arc::clone(&sessions),
                &Minting,
                &launch(session),
                Box::new(|_| {}),
                Box::new(|_| {}),
            )
            .unwrap();
            assert_eq!(started.session_id, said);
            let json = serde_json::to_value(&started).unwrap();
            assert_eq!(json["sessionId"], serde_json::json!(said));
            stop(&sessions, &started.id).unwrap();
        }
    }

    /// A sink that takes nothing until it is opened.
    #[derive(Default)]
    struct Gate {
        open: Mutex<bool>,
        opened: Condvar,
        taken: crate::events::testing::Recorder,
    }

    impl Sink for Gate {
        fn emit(&self, event: &str, payload: Value) {
            let mut open = self.open.lock().unwrap();
            while !*open {
                open = self.opened.wait(open).unwrap();
            }
            drop(open);
            self.taken.emit(event, payload);
        }
    }

    fn piece_of(n: usize) -> Event {
        Event::Text {
            block: "b".into(),
            parent: None,
            text: format!("{n} "),
            done: false,
        }
    }

    #[test]
    fn a_stalled_window_loses_streamed_pieces_but_never_a_whole_or_a_reply() {
        let gate = Arc::new(Gate::default());
        let outbox = Arc::new(Outbox::default());
        std::thread::spawn({
            let sink: Arc<dyn Sink> = gate.clone();
            let outbox = Arc::clone(&outbox);
            move || send_out("int-1", &sink, &outbox)
        });
        let started = std::time::Instant::now();
        for n in 0..OUTBOX_FULL * 2 {
            outbox.put(Out::Event(piece_of(n)));
        }
        outbox.put(Out::Event(Event::Text {
            block: "b".into(),
            parent: None,
            text: "whole".into(),
            done: true,
        }));
        let (replied, reply) = mpsc::channel();
        outbox.put(Out::Reply(replied, Ok(Value::Null)));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "putting never waits on the window"
        );
        // The pieces up to the limit, the count of those left out before
        // the whole, the whole and the reply, and one taken out meanwhile.
        let waiting = outbox.queue.lock().unwrap().waiting.len();
        assert!(waiting <= OUTBOX_PIECES + 4, "{waiting} waiting");

        *gate.open.lock().unwrap() = true;
        gate.opened.notify_all();
        reply.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
        let taken: Vec<Value> = gate
            .taken
            .events
            .lock()
            .unwrap()
            .iter()
            .map(|(_, payload)| payload.clone())
            .collect();
        let skipped: u64 = taken
            .iter()
            .filter(|event| event["type"] == "skipped")
            .map(|event| event["pieces"].as_u64().unwrap())
            .sum();
        assert!(skipped > 0, "the window is told");
        let pieces = taken
            .iter()
            .filter(|event| event["type"] == "text" && event["done"] == false)
            .count();
        assert_eq!(pieces as u64 + skipped, (OUTBOX_FULL * 2) as u64);
        assert_eq!(
            taken.last().unwrap()["text"],
            "whole",
            "the whole goes out last"
        );
    }

    #[test]
    fn a_full_outbox_holds_up_the_reader_until_there_is_room_or_the_end() {
        let gate = Arc::new(Gate::default());
        let outbox = Arc::new(Outbox::default());
        std::thread::spawn({
            let sink: Arc<dyn Sink> = gate.clone();
            let outbox = Arc::clone(&outbox);
            move || send_out("int-1", &sink, &outbox)
        });
        for _ in 0..=OUTBOX_FULL {
            outbox.put(Out::Event(Event::Compacting));
        }
        let (roomy, room) = mpsc::channel();
        std::thread::spawn({
            let outbox = Arc::clone(&outbox);
            move || {
                outbox.room();
                let _ = roomy.send(());
            }
        });
        assert!(
            room.recv_timeout(Duration::from_millis(200)).is_err(),
            "it waits"
        );
        *gate.open.lock().unwrap() = true;
        gate.opened.notify_all();
        room.recv_timeout(Duration::from_secs(5)).unwrap();

        // Once the session is over nothing waits, however full.
        let stalled = Outbox::default();
        for _ in 0..=OUTBOX_FULL {
            stalled.put(Out::Event(Event::Compacting));
        }
        stalled.close();
        stalled.room();
    }

    #[test]
    fn an_event_goes_out_with_its_session_and_its_kind() {
        let event = Event::TurnEnded {
            outcome: Outcome::Interrupted,
            error: None,
            total_cost_usd: Some(0.5),
            duration_ms: Some(10),
            usage: Some(Usage::default()),
        };
        let value = serde_json::to_value(Payload {
            id: "int-1",
            event: &event,
        })
        .unwrap();
        assert_eq!(value["id"], "int-1");
        assert_eq!(value["type"], "turnEnded");
        assert_eq!(value["outcome"], "interrupted");
        assert_eq!(value["totalCostUsd"], 0.5);
        assert_eq!(value["usage"]["cachedTokens"], 0);
        assert_eq!(value["usage"]["reasoningTokens"], 0);
        let compacting = serde_json::to_value(Payload {
            id: "int-1",
            event: &Event::Compacting,
        })
        .unwrap();
        assert_eq!(
            compacting,
            serde_json::json!({"id": "int-1", "type": "compacting"})
        );
        let change = serde_json::to_value(FileChange {
            path: "/a".into(),
            kind: ChangeKind::Move,
            to: Some("/b".into()),
            hunks: vec![],
            content: None,
            truncated: false,
        })
        .unwrap();
        assert_eq!(change["kind"], "move");
        assert_eq!(change["to"], "/b");
    }
}
