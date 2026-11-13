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

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
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
const READY_TIMEOUT: Duration = Duration::from_secs(90);

/// How long a line may wait to be taken by the agent before the session is
/// taken to be stuck. A pipe holds tens of kilobytes, so a line waits only
/// when the agent has stopped reading.
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

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

/// A session's news. Every event names the session it belongs to by `id`
/// beside the fields listed here, and its kind by `type`.
///
/// Text, thinking and tool calls carry `parent`: the id of the tool call
/// that started the subagent they belong to, or null in the main
/// conversation. A subagent's messages are tied to the call that started
/// it that way.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    /// The agent is up. Sent once, before anything else the agent says.
    /// `model` and `permissionMode` are what the session runs on as far as
    /// is known yet, `configured` follows when either changes; `models` and
    /// `commands` are what the agent offers to switch to and to type.
    Ready {
        session_id: String,
        model: Option<String>,
        permission_mode: Option<String>,
        version: Option<String>,
        models: Vec<ModelInfo>,
        commands: Vec<CommandInfo>,
    },
    /// The model or the permission mode the session runs on changed, or
    /// became known for the first time. Both are given, as they now are.
    Configured {
        model: Option<String>,
        permission_mode: Option<String>,
    },
    /// A message the window sent waits behind a turn already running. Its
    /// own turn starts later, with `turnStarted` naming it.
    MessageQueued { message: String },
    /// The agent began a turn. `message` is the id of the message it
    /// answers, as `send` returned it, or null for a turn the agent began by
    /// itself, after background work it had started finished.
    TurnStarted { message: Option<String> },
    /// The turn ended. `error` says why one that failed did; `costUsd`,
    /// `durationMs` and `usage` are what the agent reports for it.
    TurnEnded {
        outcome: Outcome,
        error: Option<String>,
        cost_usd: Option<f64>,
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
    /// The agent began a tool call.
    ToolStarted {
        call: String,
        parent: Option<String>,
        name: String,
    },
    /// A tool call's input. While it streams `delta` is the next piece of
    /// its JSON text; once complete, `input` is the whole of it.
    ToolInput {
        call: String,
        parent: Option<String>,
        delta: Option<String>,
        input: Option<Value>,
    },
    /// A tool call finished. `output` is its result as text; `change` is
    /// the file it changed, for a tool that changes one.
    ToolFinished {
        call: String,
        parent: Option<String>,
        output: String,
        error: bool,
        change: Option<FileChange>,
    },
    /// The agent asks to use a tool. `request` is what the answer names;
    /// `call` the tool call it is for; `path` the file or directory that
    /// made it ask, when there is one; `rule` what allowing it for the
    /// project would remember; `choices` the answers it takes.
    PermissionAsked {
        request: String,
        call: Option<String>,
        parent: Option<String>,
        tool: String,
        input: Value,
        description: Option<String>,
        path: Option<String>,
        rule: Option<String>,
        choices: Vec<Choice>,
    },
    /// The agent no longer waits for an answer to a permission request: the
    /// turn was interrupted, or the session ended.
    PermissionWithdrawn { request: String },
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
        status: String,
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

/// A file a tool call changed. `kind` is `create` for a new file, whose
/// `content` is given, or `update`, whose `hunks` say what changed.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub kind: String,
    pub hunks: Vec<Hunk>,
    pub content: Option<String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskKind {
    /// A subagent: the agent's own helper, with a conversation of its own.
    Agent,
    /// A shell command run in the background.
    Shell,
    Other,
}

/// What a session is doing, for the sessions pane's row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    /// A turn runs, a message waits for one, the conversation is being
    /// compacted, or a subagent the agent started is still at work.
    Working,
    /// The agent waits for an answer to a permission request.
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

/// An answer to a permission request, as the window gives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Choice {
    /// This call only.
    AllowOnce,
    /// This call and the like of it, for as long as the session lives.
    AllowSession,
    /// This call and the like of it, remembered in the project's own
    /// uncommitted settings.
    AllowProject,
    Deny,
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
    pub permission_mode: Option<&'a str>,
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
    fn command(&self, launch: &Launch) -> Result<std::process::Command, String>;

    /// A fresh reader and writer of the agent's lines for one session.
    fn driver(&self, launch: &Launch) -> Box<dyn Driver>;
}

/// A control request the window sends while the session runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Control {
    Interrupt,
    SetModel(String),
    SetPermissionMode(String),
}

/// What one line from the agent meant.
#[derive(Debug, Default)]
pub struct Reading {
    pub events: Vec<Event>,
    /// Answers to control requests, by the key [`Driver::control`] gave.
    pub replies: Vec<(String, Result<Value, String>)>,
    /// Lines to write back at once.
    pub writes: Vec<String>,
}

/// One session's side of an agent's protocol. It holds whatever the agent's
/// stream needs remembered between lines, and never fails on a line: one it
/// cannot read means nothing.
pub trait Driver: Send {
    /// Lines to write as soon as the process is up. The answer to them
    /// produces [`Event::Ready`].
    fn opening(&mut self) -> Vec<String>;

    /// One line from the agent's stdout, without its newline.
    fn read(&mut self, line: &str) -> Reading;

    /// The line that sends the user's message.
    fn message(&mut self, text: &str, images: &[Image]) -> Result<String, String>;

    /// The line that answers a permission request.
    fn answer(
        &mut self,
        request: &str,
        choice: Choice,
        message: Option<&str>,
    ) -> Result<String, String>;

    /// The line for a control request, and the key its reply comes back by.
    fn control(&mut self, control: &Control) -> Result<(String, String), String>;
}

/// The state of a session as its events say it, and the bookkeeping that
/// says it.
///
/// A message the window sends is pending until a turn starts for it.
/// Turns start in the order the messages were sent, so a turn that starts
/// while messages are pending answers the oldest of them; a turn that
/// starts with none pending is one the agent began by itself. A message
/// sent while a turn runs, or while others still wait, is queued, and says
/// so with [`Event::MessageQueued`].
///
/// The state is derived from the same events, never from timing:
/// [`SessionState::Asking`] while any permission request waits for an
/// answer; [`SessionState::Working`] while a turn runs, a message is
/// pending, the conversation is being compacted, or a subagent is still at
/// work or has finished outside a turn, since its report starts the next
/// one. That keeps a session that ended its turn to wait for its subagents
/// working until the turn that takes their report ends; and
/// [`SessionState::Idle`] otherwise. A background shell command does not
/// keep a session working: it may be a server that runs for as long as the
/// session does.
#[derive(Debug, Default)]
struct Tracker {
    pending: VecDeque<String>,
    turn: bool,
    asking: BTreeSet<String>,
    subagents: BTreeSet<String>,
    /// A subagent finished while no turn ran: the turn its report starts
    /// is coming.
    reporting: bool,
    compacting: bool,
    state: Option<SessionState>,
    next_message: u64,
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

    /// A message the window is sending: its id, and whether it waits behind
    /// something.
    fn send(&mut self) -> (String, bool) {
        self.next_message += 1;
        let id = format!("message-{}", self.next_message);
        let queued = self.turn || !self.pending.is_empty();
        self.pending.push_back(id.clone());
        (id, queued)
    }

    /// Takes an event from the driver, fills in what the tracker knows, and
    /// hands back what goes out.
    fn observe(&mut self, event: Event, out: &mut Vec<Event>) {
        match &event {
            Event::TurnStarted { .. } => {
                if self.turn {
                    // A second start with no end between is the same turn.
                    return;
                }
                self.turn = true;
                self.reporting = false;
                let message = self.pending.pop_front();
                out.push(Event::TurnStarted { message });
                self.push_state(out);
                return;
            }
            // Something of the main conversation arriving with no turn
            // running starts one: the agent began it without saying so.
            Event::Text { parent: None, .. }
            | Event::Thinking { parent: None, .. }
            | Event::ToolStarted { parent: None, .. }
                if !self.turn =>
            {
                self.observe(Event::TurnStarted { message: None }, out);
            }
            Event::TurnEnded { .. } => {
                if !self.turn {
                    // An end for a turn never seen to start: one the agent
                    // ran on a pending message without a start line.
                    self.pending.pop_front();
                }
                self.turn = false;
                self.reporting = false;
                self.compacting = false;
            }
            Event::PermissionAsked { request, .. } => {
                self.asking.insert(request.clone());
            }
            Event::PermissionWithdrawn { request } => {
                self.asking.remove(request);
            }
            Event::TaskStarted {
                task,
                kind: TaskKind::Agent,
                ..
            } => {
                self.subagents.insert(task.clone());
            }
            Event::TaskFinished { task, .. } => {
                if self.subagents.remove(task) && !self.turn {
                    self.reporting = true;
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

    /// The process is gone: whatever was open closes.
    fn end(&mut self, out: &mut Vec<Event>) {
        if self.turn {
            self.turn = false;
            out.push(Event::TurnEnded {
                outcome: Outcome::Failed,
                error: Some("the agent ended during the turn".into()),
                cost_usd: None,
                duration_ms: None,
                usage: None,
            });
        }
        for request in std::mem::take(&mut self.asking) {
            out.push(Event::PermissionWithdrawn { request });
        }
        self.pending.clear();
        self.subagents.clear();
        self.reporting = false;
        self.compacting = false;
    }
}

/// A line for the writer thread, and where to say whether it went.
type Line = (String, Sender<Result<(), String>>);

struct Machine {
    driver: Box<dyn Driver>,
    tracker: Tracker,
    /// Control requests waiting for their reply, by key.
    replies: HashMap<String, Sender<Result<Value, String>>>,
    /// Told when the agent is ready, for the watchdog that bounds the wait.
    ready: Option<Sender<()>>,
    ended: bool,
}

struct Live {
    id: String,
    sink: Arc<dyn Sink>,
    machine: Mutex<Machine>,
    /// None once stdin is closed.
    writer: Mutex<Option<Sender<Line>>>,
    kill: Mutex<Sender<()>>,
    stopping: AtomicBool,
}

impl Live {
    fn emit(&self, events: &[Event]) {
        for event in events {
            events::emit(
                &self.sink,
                INTEGRATED_EVENT,
                &Payload {
                    id: &self.id,
                    event,
                },
            );
        }
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
            machine.tracker.observe(event, &mut out);
        }
        self.emit(&out);
        // After the events, so whoever waits on a reply wakes to a stream
        // that already holds what the reply changed.
        for (key, reply) in reading.replies {
            if let Some(waiting) = machine.replies.remove(&key) {
                let _ = waiting.send(reply);
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

    fn kill(&self) {
        let _ = self.kill.lock().expect("kill lock").send(());
    }
}

/// Waits for a queued line to have gone.
fn written(went: Receiver<Result<(), String>>) -> Result<(), String> {
    match went.recv_timeout(WRITE_TIMEOUT) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err("the agent is not reading its input".into()),
        Err(RecvTimeoutError::Disconnected) => Err("the agent is gone".into()),
    }
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
}

fn next_id() -> String {
    use std::sync::atomic::AtomicU64;
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("int-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Starts an agent as an integrated session. `on_end` hears the session's
/// id once its process is gone and every event has gone out.
pub fn start(
    sink: Arc<dyn Sink>,
    sessions: Arc<Sessions>,
    protocol: &dyn Protocol,
    launch: &Launch,
    on_end: Box<dyn FnOnce(&str) + Send>,
) -> Result<Started, String> {
    let mut command = protocol.command(launch)?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", protocol.name()))?;
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("could not talk to {}", protocol.name()));
    };

    let id = next_id();
    let (lines, queued) = mpsc::channel::<Line>();
    let (kill, killed) = mpsc::channel::<()>();
    let (ready, readied) = mpsc::channel::<()>();
    let mut driver = protocol.driver(launch);
    let opening = driver.opening();
    let live = Arc::new(Live {
        id: id.clone(),
        sink,
        machine: Mutex::new(Machine {
            driver,
            tracker: Tracker::default(),
            replies: HashMap::new(),
            ready: Some(ready),
            ended: false,
        }),
        writer: Mutex::new(Some(lines)),
        kill: Mutex::new(kill),
        stopping: AtomicBool::new(false),
    });
    sessions
        .inner
        .lock()
        .expect("sessions lock")
        .insert(id.clone(), Arc::clone(&live));

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
            on_end(&live.id);
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
                live.fail(
                    ErrorKind::Protocol,
                    format!("{name} did not say it was ready in time"),
                );
                live.kill();
            }
        }
    });

    Ok(Started {
        id,
        session_id: launch.session.to_string(),
    })
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

fn read_lines(live: &Live, stdout: ChildStdout, _reading: Sender<()>) {
    let mut reader = BufReader::new(stdout);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer) {
            Ok(0) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buffer);
                let line = line.trim();
                if !line.is_empty() {
                    live.take(line);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
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

/// Waits for the child to end, killing it when asked, then for the last of
/// its output.
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
                    let _ = child.kill();
                }
            }
            Err(_) => {
                let _ = child.kill();
                break child.wait().ok();
            }
        }
    };
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
        let _ = waiting.send(Err("the agent ended".into()));
    }
    machine.ready.take();
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

/// Sends the user's message. Hands back its id, which the turn that
/// answers it names.
pub fn send(sessions: &Sessions, id: &str, text: &str, images: &[Image]) -> Result<String, String> {
    let live = sessions.get(id)?;
    let (message, went) = {
        let mut machine = live.machine.lock().expect("machine lock");
        let line = machine.driver.message(text, images)?;
        let went = live.enqueue(line)?;
        let (message, queued) = machine.tracker.send();
        let mut out = Vec::new();
        if queued {
            out.push(Event::MessageQueued {
                message: message.clone(),
            });
        }
        machine.tracker.push_state(&mut out);
        live.emit(&out);
        (message, went)
    };
    written(went)?;
    Ok(message)
}

/// Answers a permission request. `message` goes with a denial, for the
/// agent to read.
pub fn answer(
    sessions: &Sessions,
    id: &str,
    request: &str,
    choice: Choice,
    message: Option<&str>,
) -> Result<(), String> {
    let live = sessions.get(id)?;
    let went = {
        let mut machine = live.machine.lock().expect("machine lock");
        let line = machine.driver.answer(request, choice, message)?;
        let went = live.enqueue(line)?;
        machine.tracker.asking.remove(request);
        let mut out = Vec::new();
        machine.tracker.push_state(&mut out);
        live.emit(&out);
        went
    };
    written(went)
}

/// Sends a control request and waits for the agent's reply.
pub fn control(sessions: &Sessions, id: &str, control: &Control) -> Result<Value, String> {
    let live = sessions.get(id)?;
    let (went, reply) = {
        let mut machine = live.machine.lock().expect("machine lock");
        let (line, key) = machine.driver.control(control)?;
        let (replied, reply) = mpsc::channel();
        machine.replies.insert(key.clone(), replied);
        match live.enqueue(line) {
            Ok(went) => (went, (key, reply)),
            Err(error) => {
                machine.replies.remove(&key);
                return Err(error);
            }
        }
    };
    let (key, reply) = reply;
    written(went)?;
    match reply.recv_timeout(CONTROL_TIMEOUT) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => {
            live.machine
                .lock()
                .expect("machine lock")
                .replies
                .remove(&key);
            Err("the agent did not answer in time".into())
        }
        Err(RecvTimeoutError::Disconnected) => Err("the agent ended".into()),
    }
}

/// Ends a session: its stdin closes, which the agent takes as the end of
/// the conversation, and it is killed if it is still there a few seconds
/// later. Comes back at once; [`Event::Ended`] says when it is gone.
pub fn stop(sessions: &Arc<Sessions>, id: &str) -> Result<(), String> {
    let live = sessions.get(id)?;
    live.stopping.store(true, Ordering::SeqCst);
    live.writer.lock().expect("writer lock").take();
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

#[cfg(all(test, unix))]
#[path = "integrated_stand_in.rs"]
mod stand_in;

#[cfg(test)]
mod tests {
    use super::*;

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

    fn ended() -> Event {
        Event::TurnEnded {
            outcome: Outcome::Done,
            error: None,
            cost_usd: None,
            duration_ms: None,
            usage: None,
        }
    }

    #[test]
    fn a_turn_answers_the_oldest_pending_message() {
        let mut tracker = Tracker::default();
        let (first, queued) = tracker.send();
        assert!(!queued);
        let mut out = Vec::new();
        tracker.observe(Event::TurnStarted { message: None }, &mut out);
        let (second, queued) = tracker.send();
        assert!(queued, "a message sent during a turn waits");
        tracker.observe(ended(), &mut out);
        tracker.observe(Event::TurnStarted { message: None }, &mut out);
        let started: Vec<_> = out
            .iter()
            .filter_map(|event| match event {
                Event::TurnStarted { message } => Some(message.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(started, [Some(first), Some(second)]);
    }

    #[test]
    fn a_turn_with_nothing_pending_is_the_agent_s_own() {
        let (_, out) = tracked(vec![Event::TurnStarted { message: None }]);
        assert_eq!(out[0], Event::TurnStarted { message: None });
    }

    #[test]
    fn asking_outranks_working_and_idle_follows_both() {
        let (_, out) = tracked(vec![
            Event::TurnStarted { message: None },
            Event::PermissionAsked {
                request: "r".into(),
                call: None,
                parent: None,
                tool: "Bash".into(),
                input: Value::Null,
                description: None,
                path: None,
                rule: None,
                choices: vec![],
            },
            Event::PermissionWithdrawn {
                request: "r".into(),
            },
            ended(),
        ]);
        assert_eq!(
            states(&out),
            [
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
            Event::TurnStarted { message: None },
            task(TaskKind::Agent),
            ended(),
            Event::TaskFinished {
                task: "t".into(),
                call: Some("c".into()),
                status: "completed".into(),
                summary: None,
            },
            Event::TurnStarted { message: None },
            ended(),
        ]);
        assert_eq!(states(&out), [SessionState::Working, SessionState::Idle]);

        // A shell left running in the background does not.
        let (tracker, _) = tracked(vec![
            Event::TurnStarted { message: None },
            task(TaskKind::Shell),
            ended(),
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
        assert_eq!(out[0], Event::TurnStarted { message: None });
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
    fn the_end_closes_the_turn_and_withdraws_what_was_asked() {
        let (mut tracker, _) = tracked(vec![
            Event::TurnStarted { message: None },
            Event::PermissionAsked {
                request: "r".into(),
                call: None,
                parent: None,
                tool: "Bash".into(),
                input: Value::Null,
                description: None,
                path: None,
                rule: None,
                choices: vec![],
            },
        ]);
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
            Event::PermissionWithdrawn {
                request: "r".into()
            }
        );
    }

    #[test]
    fn an_event_goes_out_with_its_session_and_its_kind() {
        let event = Event::TurnEnded {
            outcome: Outcome::Interrupted,
            error: None,
            cost_usd: Some(0.5),
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
        assert_eq!(value["costUsd"], 0.5);
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
    }
}
