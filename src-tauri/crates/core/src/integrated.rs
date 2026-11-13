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
use std::sync::{Arc, Mutex};
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
const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a stopped session has to end once its stdin is closed before it
/// is killed.
const STOP_GRACE: Duration = Duration::from_secs(5);

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
    /// `model`, `mode` and `effort` are what the session runs on as far as
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
    /// that answers it: `queued` while it waits behind a turn already
    /// running, `taken` when the running turn took it in, and `dropped`,
    /// with `error`, when it will not be answered at all.
    Message {
        message: String,
        state: MessageState,
        error: Option<String>,
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
    /// question with options to pick from, and room for an answer of the
    /// user's own.
    QuestionAsked {
        request: String,
        call: Option<String>,
        parent: Option<String>,
        questions: Vec<Question>,
    },
    /// The agent no longer waits for an answer to a permission request or
    /// a question: the turn was interrupted, or the session ended.
    Withdrawn { request: String },
    /// A subagent or a background task started. `call` is the tool call
    /// that started it, which its messages name as their parent.
    TaskStarted {
        task: String,
        call: Option<String>,
        kind: TaskKind,
        description: Option<String>,
        prompt: Option<String>,
        background: bool,
    },
    /// A task is still at work. `tool` is the last tool it used.
    TaskProgress {
        task: String,
        call: Option<String>,
        tool: Option<String>,
        description: Option<String>,
    },
    /// A task ended, with how and the agent's summary of it.
    TaskFinished {
        task: String,
        call: Option<String>,
        status: TaskStatus,
        summary: Option<String>,
    },
    /// The agent began compacting the conversation.
    Compacting,
    /// The conversation was compacted, by hand or because it was full.
    Compacted {
        trigger: Option<String>,
        tokens_before: Option<u64>,
        tokens_after: Option<u64>,
    },
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

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
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
/// `multiple` whether more than one option may be picked.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub header: Option<String>,
    pub question: String,
    pub options: Vec<QuestionOption>,
    pub multiple: bool,
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
    /// Gone from what the agent says is running, without a word of how it
    /// ended. No report of it follows.
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
/// and the agent's own id for the conversation, which resuming takes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub id: String,
    pub session_id: String,
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
    /// to resume.
    pub session: &'a str,
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
    /// Settled without asking the agent, such as a setting the agent takes
    /// with the next message: the reply, and the events it makes.
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
    /// not, the core holds each message until no turn runs, and hands it
    /// over then.
    fn takes_while_busy(&self) -> bool;

    /// The line that sends the user's message, under the window's id.
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
/// finished outside a turn, since its report starts the next one. That
/// keeps a session that ended its turn to wait for its subagents working
/// until the turn that takes their report ends; and
/// [`SessionState::Idle`] otherwise. A background shell command does not
/// keep a session working: it may be a server that runs for as long as the
/// session does.
///
/// Tool calls the agent leaves open are closed here: those of the main
/// conversation when the turn ends, a subagent's when it finishes, and
/// all of them when the session does.
#[derive(Debug, Default)]
struct Tracker {
    /// Sent and not yet taken, in the order sent.
    pending: Vec<String>,
    /// Every message id used, so none is used twice.
    used: BTreeSet<String>,
    turn: bool,
    asking: BTreeSet<String>,
    /// Subagents at work, with the tool call that started each.
    subagents: BTreeMap<String, Option<String>>,
    /// Tool calls started and not finished, with the subagent call each
    /// belongs to.
    calls: BTreeMap<String, Option<String>>,
    /// How much of each open call's input and output has streamed.
    streamed: HashMap<String, usize>,
    /// A subagent finished while no turn ran: the turn its report starts
    /// is coming.
    reporting: bool,
    compacting: bool,
    settings: Settings,
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
    }

    /// Takes an event from the driver, fills in what the tracker knows, and
    /// hands back what goes out.
    fn observe(&mut self, event: Event, out: &mut Vec<Event>) {
        match &event {
            Event::Ready {
                model,
                mode,
                effort,
                ..
            }
            | Event::Configured {
                model,
                mode,
                effort,
                ..
            } => {
                self.settings = Settings {
                    model: model.clone(),
                    mode: mode.clone(),
                    effort: effort.clone(),
                };
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
                        self.observe(
                            Event::Message {
                                message,
                                state: MessageState::Taken,
                                error: None,
                            },
                            out,
                        );
                    }
                    return;
                }
                self.turn = true;
                self.reporting = false;
                self.pending.retain(|m| !messages.contains(m));
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
                self.asking.insert(request.clone());
            }
            Event::Withdrawn { request } => {
                self.asking.remove(request);
            }
            Event::TaskStarted {
                task,
                call,
                kind: TaskKind::Agent,
                ..
            } => {
                self.subagents.insert(task.clone(), call.clone());
            }
            Event::TaskFinished { task, status, .. } => {
                if let Some(call) = self.subagents.remove(task) {
                    // Its report starts a turn of its own, unless the agent
                    // lost track of it.
                    if !self.turn && *status != TaskStatus::Lost {
                        self.reporting = true;
                    }
                    if let Some(call) = call {
                        let call = Some(call);
                        self.close(out, |parent| *parent == call);
                    }
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
        for request in std::mem::take(&mut self.asking) {
            out.push(Event::Withdrawn { request });
        }
        for message in std::mem::take(&mut self.pending) {
            out.push(Event::Message {
                message,
                state: MessageState::Dropped,
                error: Some("the agent ended before it took the message".into()),
            });
        }
        self.subagents.clear();
        self.reporting = false;
        self.compacting = false;
    }
}

/// A line for the writer thread, and where to say whether it went.
type Line = (String, Sender<Result<(), String>>);

/// What goes out of a session, in order, through the thread that talks to
/// the sink: events, the replies they explain, and what runs once the
/// session's last event is out.
enum Out {
    Events(Vec<Event>),
    Reply(Sender<Result<Value, String>>, Result<Value, String>),
    Last(Box<dyn FnOnce() + Send>),
}

struct Machine {
    driver: Box<dyn Driver>,
    tracker: Tracker,
    /// Messages' lines held for an agent that takes none while a turn
    /// runs, in the order sent.
    held: VecDeque<String>,
    /// Control requests waiting for their reply, by key.
    replies: HashMap<String, Sender<Result<Value, String>>>,
    /// Told when the agent is ready, for the watchdog that bounds the wait.
    ready: Option<Sender<()>>,
    ended: bool,
}

struct Live {
    id: String,
    machine: Mutex<Machine>,
    /// What goes out, in the order it is put here, which is always under
    /// the machine's lock. A sink that is slow holds up only the thread
    /// that empties it.
    outbox: Mutex<Sender<Out>>,
    /// None once stdin is closed.
    writer: Mutex<Option<Sender<Line>>>,
    kill: Mutex<Sender<()>>,
    /// Set when the session is ended on purpose: by a stop, or by the core
    /// after saying why.
    stopping: AtomicBool,
}

impl Live {
    fn emit(&self, events: &[Event]) {
        if !events.is_empty() {
            self.put(Out::Events(events.to_vec()));
        }
    }

    fn put(&self, out: Out) {
        // The thread that empties the outbox outlives every session's
        // events, so a send can fail only once it is all over.
        let _ = self.outbox.lock().expect("outbox lock").send(out);
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
        self.release(&mut machine);
        self.emit(&out);
        // After the events, so whoever waits on a reply wakes to a stream
        // that already holds what the reply changed.
        for (key, reply) in reading.replies {
            if let Some(waiting) = machine.replies.remove(&key) {
                self.put(Out::Reply(waiting, reply));
            }
        }
    }

    /// Hands the agent the next held message, once no turn runs.
    fn release(&self, machine: &mut Machine) {
        if !machine.tracker.turn {
            if let Some(line) = machine.held.pop_front() {
                // A failure shows as the session ending.
                let _ = self.enqueue(line);
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
        session_id: launch.session.to_string(),
    };
    on_start(&started);
    let (lines, queued) = mpsc::channel::<Line>();
    let (kill, killed) = mpsc::channel::<()>();
    let (ready, readied) = mpsc::channel::<()>();
    let (outbox, outgoing) = mpsc::channel::<Out>();
    let mut driver = protocol.driver(launch);
    let opening = driver.opening();
    let live = Arc::new(Live {
        id: id.clone(),
        machine: Mutex::new(Machine {
            driver,
            tracker: Tracker::default(),
            held: VecDeque::new(),
            replies: HashMap::new(),
            ready: Some(ready),
            ended: false,
        }),
        outbox: Mutex::new(outbox),
        writer: Mutex::new(Some(lines)),
        kill: Mutex::new(kill),
        stopping: AtomicBool::new(false),
    });
    sessions
        .inner
        .lock()
        .expect("sessions lock")
        .insert(id.clone(), Arc::clone(&live));

    std::thread::spawn({
        let id = id.clone();
        move || send_out(&id, &sink, outgoing)
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
fn send_out(id: &str, sink: &Arc<dyn Sink>, outgoing: Receiver<Out>) {
    for out in outgoing {
        match out {
            Out::Events(list) => {
                for event in &list {
                    events::emit(sink, INTEGRATED_EVENT, &Payload { id, event });
                }
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
        if !skipping {
            if line.len() + piece.len() > LINE_KEEP {
                skipping = true;
                line.clear();
                live.fail(
                    ErrorKind::Protocol,
                    format!(
                        "the agent wrote a line longer than {} MiB, which was skipped",
                        LINE_KEEP / (1024 * 1024)
                    ),
                );
            } else {
                line.extend_from_slice(piece);
            }
        }
        let used = end.map_or(available.len(), |at| at + 1);
        reader.consume(used);
        if end.is_some() {
            if !skipping {
                let text = String::from_utf8_lossy(&line);
                let text = text.trim();
                if !text.is_empty() {
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
/// itself.
fn end_group(child: &Child) {
    #[cfg(unix)]
    if let Ok(group) = i32::try_from(child.id()) {
        unsafe {
            libc::killpg(group, libc::SIGTERM);
        }
    }
    #[cfg(not(unix))]
    let _ = child;
}

/// Waits for the child to end, killing it and its group when asked, then
/// for the last of its output.
fn wait(
    live: &Live,
    mut child: Child,
    killed: Receiver<()>,
    read_done: Receiver<()>,
) -> Option<std::process::ExitStatus> {
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if killed.recv_timeout(POLL).is_ok() {
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
    let went = {
        let mut machine = live.machine.lock().expect("machine lock");
        let line = machine.driver.message(message, text, images)?;
        let queued = machine.tracker.send(message)?;
        let hold = !machine.driver.takes_while_busy()
            && (machine.tracker.turn || !machine.held.is_empty());
        let went = if hold {
            machine.held.push_back(line);
            None
        } else {
            match live.enqueue(line) {
                Ok(went) => Some(went),
                Err(error) => {
                    machine.tracker.unsend(message);
                    return Err(error);
                }
            }
        };
        let mut out = Vec::new();
        if queued {
            out.push(Event::Message {
                message: message.to_string(),
                state: MessageState::Queued,
                error: None,
            });
        }
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
    settle(&live, request, |driver| {
        driver.answer(request, choice, message)
    })
}

/// Answers a question the agent asked: for each question, the labels the
/// user picked or words of their own. None declines to answer.
pub fn reply(
    sessions: &Sessions,
    id: &str,
    request: &str,
    answers: Option<&[Vec<String>]>,
) -> Result<(), String> {
    let live = sessions.get(id)?;
    settle(&live, request, |driver| driver.reply(request, answers))
}

/// Writes the line that settles a request the agent is waiting on.
fn settle(
    live: &Live,
    request: &str,
    line: impl FnOnce(&mut dyn Driver) -> Result<String, String>,
) -> Result<(), String> {
    let went = {
        let mut machine = live.machine.lock().expect("machine lock");
        let line = line(machine.driver.as_mut())?;
        let went = live.enqueue(line)?;
        machine.tracker.asking.remove(request);
        let mut out = Vec::new();
        machine.tracker.push_state(&mut out);
        live.emit(&out);
        went
    };
    live.written(went)
}

/// Sends a control request and waits for the agent's reply.
pub fn control(sessions: &Sessions, id: &str, control: &Control) -> Result<Value, String> {
    let live = sessions.get(id)?;
    let (went, key, reply) = {
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
                return Ok(reply);
            }
            Sending::Request { line, key } => {
                live.emit(&out);
                let (replied, reply) = mpsc::channel();
                machine.replies.insert(key.clone(), replied);
                match live.enqueue(line) {
                    Ok(went) => (went, key, reply),
                    Err(error) => {
                        machine.replies.remove(&key);
                        machine.driver.forget(&key);
                        return Err(error);
                    }
                }
            }
        }
    };
    live.written(went)?;
    match reply.recv_timeout(CONTROL_TIMEOUT) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => {
            let mut machine = live.machine.lock().expect("machine lock");
            machine.replies.remove(&key);
            machine.driver.forget(&key);
            Err("the agent did not answer in time".into())
        }
        Err(RecvTimeoutError::Disconnected) => Err("the agent ended".into()),
    }
}

/// Switches what the session runs on: each of the model, the mode and the
/// effort that is given, in that order. Answers with the settings as the
/// session's events now say them.
pub fn configure(
    sessions: &Sessions,
    id: &str,
    model: Option<&str>,
    mode: Option<&str>,
    effort: Option<&str>,
) -> Result<Settings, String> {
    if let Some(model) = model {
        control(sessions, id, &Control::SetModel(model.to_string()))?;
    }
    if let Some(mode) = mode {
        control(sessions, id, &Control::SetMode(mode.to_string()))?;
    }
    if let Some(effort) = effort {
        control(sessions, id, &Control::SetEffort(effort.to_string()))?;
    }
    let live = sessions.get(id)?;
    let machine = live.machine.lock().expect("machine lock");
    Ok(machine.tracker.settings.clone())
}

/// Ends a session: its stdin closes, which the agent takes as the end of
/// the conversation, and it is killed with its group if it is still there
/// a few seconds later. Comes back at once; [`Event::Ended`] says when it
/// is gone.
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
    let deadline = std::time::Instant::now() + STOP_GRACE + Duration::from_secs(1);
    while !sessions.ids().is_empty() && std::time::Instant::now() < deadline {
        std::thread::sleep(POLL);
    }
}

#[cfg(all(test, unix))]
#[path = "integrated_stand_in.rs"]
mod stand_in;

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
        assert!(out.contains(&Event::Message {
            message: M1.into(),
            state: MessageState::Taken,
            error: None
        }));
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
                trigger: Some("auto".into()),
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
            },
            Event::TaskFinished {
                task: "t".into(),
                call: None,
                status: TaskStatus::Failed,
                summary: None,
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
        assert_eq!(value["usage"]["cacheReadTokens"], 0);
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
