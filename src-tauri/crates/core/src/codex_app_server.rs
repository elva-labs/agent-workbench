//! Codex's app-server protocol, spoken directly.
//!
//! `codex app-server` speaks JSON-RPC without the version field, one
//! message a line on stdio: the client's requests and the server's answers,
//! the server's notifications, and requests the server makes of the client,
//! approvals and questions among them. The protocol is generated from
//! Codex's own types for each version, and it does not only grow, so this
//! is the one place that reads it, and it reads it the way the transcript
//! readers read theirs: a field is looked up and its absence means nothing,
//! every enum and union has a fallback for a value it does not know, an
//! unknown method is skipped, a line that is not JSON is skipped, and a
//! request from the server that this side does not handle is answered with
//! an error rather than left waiting.
//!
//! A conversation is a thread, a message starts a turn, and what happens in
//! a turn arrives as items: text, reasoning, a command, a file change, a
//! tool call. Codex folds a message sent while a turn runs into that turn,
//! so the core holds each one and hands it over once the last turn is over,
//! and each message starts a turn of its own. The model, the effort and the
//! mode go with the next turn, so a change of any is settled here without
//! asking the agent.
//!
//! Everything leaves as the agent-neutral events of the integrated
//! sessions; nothing Codex-shaped goes past this file.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::adapter::{
    prepare_process, process, CODEX_HOME_VAR, ORCHESTRATOR_ROLE, ROLE_VAR, SESSION_VAR,
};
use crate::env::find_on_path;
use crate::hook;
use crate::integrated::{
    ChangeKind, Choice, CompactReason, Control, Driver, ErrorKind, Event, FileChange, Hunk, Image,
    Launch, MessageState, ModeInfo, ModelInfo, NoticeLevel, Offer, Outcome, PlanStep, Prepared,
    Protocol, Question, QuestionOption, Reading, Sending, StepStatus, ToolKind, Usage,
};

pub struct CodexAppServer;

pub static CODEX_APP_SERVER: CodexAppServer = CodexAppServer;

/// The name the workbench gives itself in the handshake. Codex files the
/// threads it starts under it, as their originator.
const CLIENT_NAME: &str = "agent-workbench";

/// The oldest Codex whose app-server this driver has been run against.
const OLDEST: (u64, u64, u64) = (0, 168, 0);

/// The media types the agent takes an image in.
const IMAGE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

/// A mode the session runs in: how much the agent may do without asking,
/// as Codex's approval policy and sandbox together.
struct Mode {
    value: &'static str,
    name: &'static str,
    description: &'static str,
    approval: &'static str,
    sandbox: &'static str,
}

const MODES: &[Mode] = &[
    Mode {
        value: "read-only",
        name: "Read only",
        description:
            "Reads files, and asks before it changes anything or runs a command that would",
        approval: "on-request",
        sandbox: "read-only",
    },
    Mode {
        value: "auto",
        name: "Auto",
        description:
            "Changes files and runs commands in the project, and asks before going beyond it",
        approval: "on-request",
        sandbox: "workspace-write",
    },
    Mode {
        value: "full-access",
        name: "Full access",
        description: "Changes anything and runs anything without asking",
        approval: "never",
        sandbox: "danger-full-access",
    },
];

fn mode(value: &str) -> Option<&'static Mode> {
    MODES.iter().find(|mode| mode.value == value)
}

/// A sandbox as `thread/start` spells it, from either spelling.
fn sandbox_name(sandbox: &Value) -> Option<String> {
    let name = sandbox.as_str().or_else(|| sandbox["type"].as_str())?;
    Some(
        match name {
            "readOnly" => "read-only",
            "workspaceWrite" => "workspace-write",
            "dangerFullAccess" => "danger-full-access",
            "externalSandbox" => "external-sandbox",
            other => other,
        }
        .to_string(),
    )
}

/// The sandbox as `turn/start` takes it. Writing in the workspace keeps
/// the writable roots and the network access the user gave it, where they
/// are known; a name this side does not know is read only.
fn sandbox_policy(sandbox: &str, workspace: Option<&Value>) -> Value {
    match sandbox {
        "workspace-write" => workspace
            .cloned()
            .unwrap_or_else(|| json!({ "type": "workspaceWrite" })),
        "danger-full-access" => json!({ "type": "dangerFullAccess" }),
        _ => json!({ "type": "readOnly" }),
    }
}

/// The workspace sandbox the user's configuration sets up, as `turn/start`
/// takes it, from the `sandbox_workspace_write` table `config/read` gives.
fn configured_workspace(config: &Value) -> Option<Value> {
    let table = config["sandbox_workspace_write"].as_object()?;
    let mut policy = json!({ "type": "workspaceWrite" });
    for (from, to) in [
        ("writable_roots", "writableRoots"),
        ("network_access", "networkAccess"),
        ("exclude_tmpdir_env_var", "excludeTmpdirEnvVar"),
        ("exclude_slash_tmp", "excludeSlashTmp"),
    ] {
        if let Some(value) = table.get(from).filter(|value| !value.is_null()) {
            policy[to] = value.clone();
        }
    }
    Some(policy)
}

/// The mode an approval policy and a sandbox make: one of the modes when
/// they are one, else the two as they are, as the user's own configuration
/// may set them.
fn mode_of(approval: &Value, sandbox: &Value) -> Option<String> {
    let approval = match approval {
        Value::String(policy) => policy.clone(),
        Value::Object(policy) => policy.keys().next()?.clone(),
        _ => return None,
    };
    let sandbox = sandbox_name(sandbox)?;
    Some(
        MODES
            .iter()
            .find(|mode| mode.approval == approval && mode.sandbox == sandbox)
            .map(|mode| mode.value.to_string())
            .unwrap_or_else(|| format!("{approval}, {sandbox}")),
    )
}

impl Protocol for CodexAppServer {
    fn name(&self) -> &'static str {
        "codex"
    }

    fn command(&self, launch: &Launch) -> Result<Prepared, String> {
        let binary = find_on_path(launch.env, "codex").ok_or_else(|| {
            "codex was not found on your PATH. Install Codex CLI, or check that it is on \
             the PATH your login shell sets up."
                .to_string()
        })?;
        if let Some(value) = launch.mode {
            mode(value).ok_or_else(|| format!("{value:?} is not a mode Codex runs in"))?;
        }
        if launch.resume && launch.session.is_none() {
            return Err("there is no Codex thread to resume".into());
        }
        let mut command = process(&binary, launch.env);
        command.arg("app-server");
        prepare_process(&mut command, launch.project, launch.env);
        // The hooks read which session they serve from these; the tool
        // server is given them in the thread's configuration, since Codex
        // passes its servers only an environment of its own choosing.
        if let Some(session) = launch.session {
            command.env(SESSION_VAR, session);
        }
        if launch.orchestrator {
            command.env(ROLE_VAR, ORCHESTRATOR_ROLE);
        }
        if let Some(dir) = launch.config_dir {
            command.env(CODEX_HOME_VAR, dir);
        }
        Ok(Prepared {
            command,
            files: vec![],
        })
    }

    fn driver(&self, launch: &Launch) -> Box<dyn Driver> {
        Box::new(AppServer::new(launch))
    }

    fn trusted(&self, home: &Path, config_dir: Option<&Path>, folder: &Path) -> bool {
        hook::codex_trusts(&config_file(home, config_dir), folder)
    }

    fn trust(&self, home: &Path, config_dir: Option<&Path>, folder: &Path) -> Result<(), String> {
        hook::codex_trust(&config_file(home, config_dir), folder)
    }
}

/// Codex's configuration, where the trust it was given is kept: in the
/// account's home, or in its own.
fn config_file(home: &Path, config_dir: Option<&Path>) -> PathBuf {
    match config_dir {
        Some(dir) => dir.join("config.toml"),
        None => crate::codex::home(home).join("config.toml"),
    }
}

const NOT_LOGGED_IN: &str =
    "This account is not signed in to Codex. Run codex login in a terminal and sign in.";

/// A request this side sent, by what its answer means.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Sent {
    Initialize,
    Account,
    Models,
    /// The user's own configuration, for the sandbox settings a mode keeps.
    Config,
    Thread,
    /// The turn a message starts, with the changes of settings it carries.
    Turn(String, Next),
    /// An interrupt whose answer the window waits for.
    Interrupt,
    /// An interrupt asked for before the turn had an id, sent once it did.
    LateInterrupt,
    Compact,
}

/// What a request from the server is, by what its answer takes.
#[derive(Debug, Clone)]
enum Asking {
    Command {
        command: Option<String>,
        /// The prefix the agent proposes its rules allow from now on.
        prefix: Vec<String>,
        /// A host the agent proposes its network policy allow.
        network: Option<Value>,
    },
    File {
        root: Option<String>,
    },
    Permissions {
        asked: Value,
        described: String,
    },
    Question {
        ids: Vec<String>,
        /// For each question that takes its options alone, their labels.
        options: Vec<Option<Vec<String>>>,
    },
    Mcp {
        server: String,
        tool: String,
        persist: Vec<String>,
    },
}

/// Changes of settings settled here that go with the next turn.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Next {
    model: Option<String>,
    effort: Option<String>,
    mode: Option<String>,
}

impl Next {
    /// Keeps what is set here, and takes what is not from `older`: a
    /// change made since wins over the one it would bring back.
    fn or(self, older: Next) -> Next {
        Next {
            model: self.model.or(older.model),
            effort: self.effort.or(older.effort),
            mode: self.mode.or(older.mode),
        }
    }
}

/// A request from the server waiting for an answer.
#[derive(Debug, Clone)]
struct Asked {
    /// The id the answer goes back under, as the server gave it.
    id: Value,
    turn: Option<String>,
    asking: Asking,
}

impl Asked {
    /// What a choice remembers beyond this call, in words, and whether it
    /// is offered.
    fn remembers(&self, choice: Choice) -> Option<Option<String>> {
        match (&self.asking, choice) {
            (Asking::Question { .. }, _) => None,
            (_, Choice::Deny) => Some(None),
            (Asking::Permissions { .. }, Choice::Cancel) => None,
            (_, Choice::Cancel) => Some(None),
            (Asking::Command { .. } | Asking::File { .. } | Asking::Mcp { .. }, Choice::Allow) => {
                Some(None)
            }
            (Asking::Permissions { described, .. }, Choice::Allow) => {
                Some(Some(format!("{described} for the rest of this turn")))
            }
            (Asking::Permissions { described, .. }, Choice::AllowSession) => {
                Some(Some(format!("{described} for the rest of this session")))
            }
            (Asking::Permissions { .. }, Choice::AllowAlways) => None,
            (Asking::Command { command, .. }, Choice::AllowSession) => Some(Some(match command {
                Some(command) => format!("{command} for the rest of this session"),
                None => "this command for the rest of this session".to_string(),
            })),
            (
                Asking::Command {
                    prefix, network, ..
                },
                Choice::AllowAlways,
            ) => {
                if !prefix.is_empty() {
                    Some(Some(format!(
                        "commands that start with {} in Codex's rules, from now on",
                        prefix.join(" ")
                    )))
                } else {
                    let host = network.as_ref()?["host"].as_str()?;
                    Some(Some(format!(
                        "network access to {host} in Codex's network policy, from now on"
                    )))
                }
            }
            (Asking::File { root }, Choice::AllowSession) => Some(Some(match root {
                Some(root) => format!("changes under {root} for the rest of this session"),
                None => "changes to these files for the rest of this session".to_string(),
            })),
            (Asking::File { .. }, Choice::AllowAlways) => None,
            (
                Asking::Mcp {
                    server,
                    tool,
                    persist,
                },
                Choice::AllowSession,
            ) => persist.iter().any(|p| p == "session").then(|| {
                Some(format!(
                    "the {tool} tool of the {server} MCP server for the rest of this session"
                ))
            }),
            (
                Asking::Mcp {
                    server,
                    tool,
                    persist,
                },
                Choice::AllowAlways,
            ) => persist.iter().any(|p| p == "always").then(|| {
                Some(format!(
                    "the {tool} tool of the {server} MCP server, from now on"
                ))
            }),
        }
    }

    fn offers(&self) -> Vec<Offer> {
        [
            Choice::Allow,
            Choice::AllowSession,
            Choice::AllowAlways,
            Choice::Deny,
            Choice::Cancel,
        ]
        .into_iter()
        .filter_map(|choice| {
            Some(Offer {
                choice,
                remembers: self.remembers(choice)?,
                message: false,
            })
        })
        .collect()
    }

    /// The answer a choice makes, for a request that offered it.
    fn answer(&self, choice: Choice) -> Result<Value, String> {
        if self.remembers(choice).is_none() {
            return Err("that choice was not offered for this request".into());
        }
        Ok(match &self.asking {
            Asking::Command {
                prefix, network, ..
            } => json!({ "decision": match choice {
                Choice::Allow => json!("accept"),
                Choice::AllowSession => json!("acceptForSession"),
                Choice::AllowAlways if !prefix.is_empty() => json!({
                    "acceptWithExecpolicyAmendment": { "execpolicy_amendment": prefix }
                }),
                Choice::AllowAlways => json!({
                    "applyNetworkPolicyAmendment": { "network_policy_amendment": network }
                }),
                Choice::Deny => json!("decline"),
                Choice::Cancel => json!("cancel"),
            }}),
            Asking::File { .. } => json!({ "decision": match choice {
                Choice::Allow => "accept",
                Choice::AllowSession => "acceptForSession",
                Choice::Deny | Choice::AllowAlways => "decline",
                Choice::Cancel => "cancel",
            }}),
            Asking::Permissions { asked, .. } => match choice {
                Choice::Allow => json!({ "permissions": asked, "scope": "turn" }),
                Choice::AllowSession => json!({ "permissions": asked, "scope": "session" }),
                _ => json!({ "permissions": {}, "scope": "turn" }),
            },
            Asking::Mcp { .. } => match choice {
                Choice::Allow => json!({ "action": "accept", "content": null }),
                Choice::AllowSession => {
                    json!({ "action": "accept", "content": null, "_meta": { "persist": "session" } })
                }
                Choice::AllowAlways => {
                    json!({ "action": "accept", "content": null, "_meta": { "persist": "always" } })
                }
                Choice::Deny => json!({ "action": "decline", "content": null }),
                Choice::Cancel => json!({ "action": "cancel", "content": null }),
            },
            Asking::Question { .. } => return Err("a question is answered with a reply".into()),
        })
    }

    /// The answer that lets the server go on when nobody will answer: no.
    fn refusal(&self) -> Value {
        let method = match &self.asking {
            Asking::Command { .. } => "item/commandExecution/requestApproval",
            Asking::File { .. } => "item/fileChange/requestApproval",
            Asking::Permissions { .. } => "item/permissions/requestApproval",
            Asking::Question { .. } => "item/tool/requestUserInput",
            Asking::Mcp { .. } => "mcpServer/elicitation/request",
        };
        refusal(method).expect("a request this side asks of the user")
    }
}

/// The answer that says no to a request of the method given, for one this
/// side handles.
fn refusal(method: &str) -> Option<Value> {
    Some(match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            json!({ "decision": "decline" })
        }
        "item/permissions/requestApproval" => json!({ "permissions": {}, "scope": "turn" }),
        "item/tool/requestUserInput" => json!({ "answers": {} }),
        "mcpServer/elicitation/request" => json!({ "action": "decline", "content": null }),
        _ => return None,
    })
}

/// The line that turns a request down: no, for one this side handles, and
/// an error that says so for one it does not.
fn turned_down(id: &Value, method: &str) -> String {
    match refusal(method) {
        Some(result) => json!({ "id": id, "result": result }),
        None => json!({
            "id": id,
            "error": { "code": -32601, "message": "not handled by Agent Workbench" },
        }),
    }
    .to_string()
}

/// The id and the method of a request from the head of its line, where the
/// head holds both at the top level of the message.
fn head_request(head: &str) -> Option<(Value, String)> {
    let bytes = head.as_bytes();
    // The end of the string that starts at `at`, past its closing quote.
    let string_end = |at: usize| -> Option<usize> {
        let mut i = at + 1;
        while i < bytes.len() {
            match bytes[i] {
                b'\\' => i += 2,
                b'"' => return Some(i + 1),
                _ => i += 1,
            }
        }
        None
    };
    let skip_space = |mut i: usize| {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        i
    };
    let (mut id, mut method) = (None, None);
    let (mut depth, mut i) = (0usize, 0usize);
    while i < bytes.len() {
        match bytes[i] {
            b'{' | b'[' => {
                depth += 1;
                i += 1;
            }
            b'}' | b']' => {
                depth = depth.checked_sub(1)?;
                i += 1;
            }
            b'"' => {
                let end = string_end(i)?;
                let after = skip_space(end);
                if depth == 1 && bytes.get(after) == Some(&b':') {
                    let key: String = serde_json::from_str(&head[i..end]).ok()?;
                    let at = skip_space(after + 1);
                    let value = match bytes.get(at) {
                        Some(b'"') => {
                            let end = string_end(at)?;
                            serde_json::from_str::<Value>(&head[at..end]).ok()
                        }
                        _ => {
                            let digits = head[at..]
                                .bytes()
                                .take_while(|b| b.is_ascii_digit() || *b == b'-')
                                .count();
                            head[at..at + digits].parse::<i64>().ok().map(Value::from)
                        }
                    };
                    match key.as_str() {
                        "id" => id = value,
                        "method" => method = value.and_then(|v| text(&v)),
                        _ => {}
                    }
                    if let (Some(id), Some(method)) = (&id, &method) {
                        return Some((id.clone(), method.clone()));
                    }
                }
                i = end;
            }
            _ => i += 1,
        }
    }
    None
}

/// The tokens one request or a running total took, as Codex counts them.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Tokens {
    input: u64,
    cached: u64,
    output: u64,
    reasoning: u64,
    total: u64,
}

impl Tokens {
    fn read(value: &Value) -> Option<Self> {
        value.is_object().then(|| Self {
            input: value["inputTokens"].as_u64().unwrap_or(0),
            cached: value["cachedInputTokens"].as_u64().unwrap_or(0),
            output: value["outputTokens"].as_u64().unwrap_or(0),
            reasoning: value["reasoningOutputTokens"].as_u64().unwrap_or(0),
            total: value["totalTokens"].as_u64().unwrap_or(0),
        })
    }

    fn plus(self, other: Self) -> Self {
        Self {
            input: self.input + other.input,
            cached: self.cached + other.cached,
            output: self.output + other.output,
            reasoning: self.reasoning + other.reasoning,
            total: self.total + other.total,
        }
    }

    fn minus(self, other: Self) -> Self {
        Self {
            input: self.input.saturating_sub(other.input),
            cached: self.cached.saturating_sub(other.cached),
            output: self.output.saturating_sub(other.output),
            reasoning: self.reasoning.saturating_sub(other.reasoning),
            total: self.total.saturating_sub(other.total),
        }
    }

    fn usage(self) -> Usage {
        Usage {
            input_tokens: self.input,
            cached_tokens: self.cached,
            output_tokens: self.output,
            reasoning_tokens: self.reasoning,
        }
    }
}

/// A tool call as an item began it, until it completes.
#[derive(Debug, Clone)]
struct Call {
    /// The agent's name for the tool, as the tool started event gives it.
    name: String,
    kind: ToolKind,
    /// What the call was started with, which a permission request for it
    /// shows.
    input: Value,
}

/// One session's reading of the app-server's lines.
struct AppServer {
    project: PathBuf,
    /// The thread to resume, or None for a fresh one.
    resume: Option<String>,
    start_model: Option<String>,
    start_mode: Option<String>,
    start_effort: Option<String>,
    tool_server: Option<PathBuf>,
    session: Option<String>,
    orchestrator: bool,

    next: i64,
    sent: HashMap<i64, Sent>,
    version: Option<String>,
    /// The answers the session needs before it is ready, as they come.
    account_known: bool,
    signed_out: bool,
    models_known: bool,
    started: Option<Value>,
    ready: bool,
    thread: Option<String>,

    model: Option<String>,
    mode: Option<String>,
    effort: Option<String>,
    /// The models offered, with the effort each defaults to.
    models: Vec<(ModelInfo, Option<String>)>,
    /// Changes settled here that go with the next turn, until a request
    /// for one takes them.
    changes: Next,
    config_known: bool,
    /// The sandbox the auto mode runs in, with the writable roots and the
    /// network access the user configured.
    workspace: Option<Value>,

    /// The turn running, once its id is known.
    turn: Option<String>,
    /// The request that starts a turn for a message, until it is answered.
    starting: Option<i64>,
    /// A message whose turn Codex named in its answer, until that turn
    /// starts: the turn's id, where the answer gave one, and the message.
    awaited: Option<(Option<String>, String)>,
    /// The turn that ended last, which an answer that comes late may name.
    ended: Option<String>,
    interrupt_wanted: bool,
    compact_asked: bool,
    /// Why the running turn failed, as the agent said before it ended.
    failure: Option<String>,
    told_signed_out: bool,

    calls: HashMap<String, Call>,
    /// Blocks of thinking that streamed, so their whole is told too.
    streamed: HashSet<String>,
    /// Compaction items started and not yet completed.
    compacting: HashSet<String>,
    asked: HashMap<String, Asked>,

    /// The thread's running total, as the agent last said it, and what it
    /// was when the turn began.
    total: Option<Tokens>,
    base: Option<Tokens>,
    /// What each request of the turn took, added up.
    lasts: Tokens,
    context: (Option<u64>, Option<u64>),
    context_told: (Option<u64>, Option<u64>),

    /// The start of a line too long to read, from which the item it
    /// completes can be named.
    skipped_head: Vec<u8>,
}

/// How much of a line too long to read is kept to name what it was.
const HEAD_KEEP: usize = 4096;

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

/// The key a request from the server is known by in the events: its id
/// as it is, for a string, or as JSON.
fn request_key(id: &Value) -> String {
    match id {
        Value::String(id) => id.clone(),
        other => other.to_string(),
    }
}

/// The version in a user agent: what follows the client's name and a
/// slash, up to a space.
fn version_of(agent: &str) -> Option<String> {
    let (_, rest) = agent.split_once('/')?;
    let version = rest.split_whitespace().next()?;
    (!version.is_empty()).then(|| version.to_string())
}

/// A version's three numbers, with anything after a dash left out.
fn numbers(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    Some((
        parts.next()??,
        parts.next()??,
        parts.next().flatten().unwrap_or(0),
    ))
}

/// The attempt and the attempts in a retry's message, which says them as
/// `2/5`.
fn attempts(message: &str) -> (Option<u64>, Option<u64>) {
    message
        .rsplit(|c: char| !c.is_ascii_digit() && c != '/')
        .find_map(|word| {
            let (attempt, of) = word.split_once('/')?;
            Some((attempt.parse().ok()?, of.parse().ok()?))
        })
        .map_or((None, None), |(attempt, of)| (Some(attempt), Some(of)))
}

/// Whether an error says the account is not signed in.
fn unauthorized(info: &Value) -> bool {
    info == "unauthorized"
        || info
            .as_object()
            .into_iter()
            .flat_map(|info| info.values())
            .any(|detail| detail["httpStatusCode"] == 401)
}

/// A hunk header's numbers: `@@ -1,2 +1,3 @@`, a count left out being one.
fn hunk_header(line: &str) -> Option<(u64, u64, u64, u64)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    let range = |range: &str| -> Option<(u64, u64)> {
        match range.split_once(',') {
            Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
            None => Some((range.parse().ok()?, 1)),
        }
    };
    let (old_start, old_lines) = range(old)?;
    let (new_start, new_lines) = range(new)?;
    Some((old_start, old_lines, new_start, new_lines))
}

/// The hunks of a unified diff. What comes before the first hunk, the
/// headers of a file, is left out, and so is a hunk's note that a file has
/// no newline at its end.
fn hunks(diff: &str) -> Vec<Hunk> {
    let mut hunks: Vec<Hunk> = Vec::new();
    let (mut old_left, mut new_left) = (0u64, 0u64);
    for line in diff.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if old_left == 0 && new_left == 0 {
            if let Some((old_start, old_lines, new_start, new_lines)) = hunk_header(line) {
                hunks.push(Hunk {
                    old_start,
                    old_lines,
                    new_start,
                    new_lines,
                    lines: vec![],
                });
                (old_left, new_left) = (old_lines, new_lines);
            }
            continue;
        }
        let Some(hunk) = hunks.last_mut() else {
            continue;
        };
        if line.starts_with('\\') {
            continue;
        }
        // A context line left empty by whatever wrote the diff.
        let line = if line.is_empty() { " " } else { line };
        match line.as_bytes()[0] {
            b'+' => new_left = new_left.saturating_sub(1),
            b'-' => old_left = old_left.saturating_sub(1),
            b' ' => {
                old_left = old_left.saturating_sub(1);
                new_left = new_left.saturating_sub(1);
            }
            _ => {
                (old_left, new_left) = (0, 0);
                continue;
            }
        }
        hunk.lines.push(line.to_string());
    }
    hunks
}

/// The files a file change item changes. A new file comes with its
/// content, which Codex gives where the diff would be; a change, with the
/// hunks of its diff; a move, with where it went. A kind Codex has added
/// since is left out.
fn file_changes(changes: &Value, project: &Path) -> Vec<FileChange> {
    let absolute = |path: &str| {
        let path = Path::new(path);
        if path.is_absolute() {
            path.to_string_lossy().to_string()
        } else {
            project.join(path).to_string_lossy().to_string()
        }
    };
    changes
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|change| {
            let path = absolute(change["path"].as_str()?);
            let diff = change["diff"].as_str().unwrap_or_default();
            let kind = &change["kind"];
            let kind = kind["type"].as_str().or_else(|| kind.as_str())?;
            Some(match kind {
                "add" => FileChange {
                    path,
                    kind: ChangeKind::Create,
                    to: None,
                    hunks: vec![],
                    content: Some(diff.to_string()),
                    truncated: false,
                },
                "delete" => FileChange {
                    path,
                    kind: ChangeKind::Delete,
                    to: None,
                    hunks: vec![],
                    content: None,
                    truncated: false,
                },
                "update" => {
                    let to = change["kind"]["move_path"]
                        .as_str()
                        .or_else(|| change["kind"]["movePath"].as_str())
                        .map(absolute);
                    FileChange {
                        path,
                        kind: if to.is_some() {
                            ChangeKind::Move
                        } else {
                            ChangeKind::Update
                        },
                        to,
                        hunks: hunks(diff),
                        content: None,
                        truncated: false,
                    }
                }
                _ => return None,
            })
        })
        .collect()
}

/// An MCP call's result as text: its text, and a word for what is not.
fn mcp_output(result: &Value) -> String {
    result["content"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| match item["type"].as_str() {
            Some("text") => item["text"].as_str().unwrap_or_default().to_string(),
            Some("image") => "[image]".to_string(),
            Some("audio") => "[audio]".to_string(),
            Some("resource") => item["resource"]["text"]
                .as_str()
                .or_else(|| item["resource"]["uri"].as_str())
                .unwrap_or("[resource]")
                .to_string(),
            Some("resource_link") => item["uri"].as_str().unwrap_or("[resource]").to_string(),
            _ => item.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// What a request for more permissions asks for, in words.
fn described(permissions: &Value) -> String {
    let mut parts = Vec::new();
    if permissions["network"]["enabled"] == true {
        parts.push("network access".to_string());
    }
    let paths = |key: &str| -> Vec<String> {
        permissions["fileSystem"][key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|path| path.as_str().map(str::to_string))
            .collect()
    };
    let write = paths("write");
    if !write.is_empty() {
        parts.push(format!("writing to {}", write.join(", ")));
    }
    let read = paths("read");
    if !read.is_empty() {
        parts.push(format!("reading {}", read.join(", ")));
    }
    for entry in permissions["fileSystem"]["entries"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let path = &entry["path"];
        let place = path["path"]
            .as_str()
            .or_else(|| path["pattern"].as_str())
            .map(str::to_string)
            .or_else(|| {
                path["value"]["kind"]
                    .as_str()
                    .map(|kind| kind.replace('_', " "))
            });
        if let (Some(access), Some(place)) = (entry["access"].as_str(), place) {
            parts.push(format!("{access} access to {place}"));
        }
    }
    if parts.is_empty() {
        "the permissions asked for".to_string()
    } else {
        parts.join(", ")
    }
}

/// What a question tool asks, from its request.
fn questions(params: &Value) -> (Vec<Question>, Vec<String>) {
    params["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|question| {
            let id = question["id"].as_str()?.to_string();
            let options: Vec<QuestionOption> = question["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|option| {
                    Some(QuestionOption {
                        label: option["label"].as_str()?.to_string(),
                        description: text(&option["description"]).filter(|d| !d.is_empty()),
                    })
                })
                .collect();
            Some((
                Question {
                    header: text(&question["header"]).filter(|h| !h.is_empty()),
                    question: question["question"].as_str()?.to_string(),
                    // With no options to pick from, the user's own words are
                    // the only answer there is.
                    other: question["isOther"] == true || options.is_empty(),
                    options,
                    multiple: false,
                    secret: question["isSecret"] == true,
                },
                id,
            ))
        })
        .unzip()
}

impl AppServer {
    fn new(launch: &Launch) -> Self {
        Self {
            project: launch.project.to_path_buf(),
            resume: launch
                .resume
                .then(|| launch.session.map(str::to_string))
                .flatten(),
            start_model: launch.model.map(str::to_string),
            start_mode: launch.mode.map(str::to_string),
            start_effort: launch.effort.map(str::to_string),
            tool_server: launch.tool_server.map(Path::to_path_buf),
            session: launch.session.map(str::to_string),
            orchestrator: launch.orchestrator,
            next: 0,
            sent: HashMap::new(),
            version: None,
            account_known: false,
            signed_out: false,
            models_known: false,
            started: None,
            ready: false,
            thread: None,
            model: None,
            mode: None,
            effort: None,
            models: Vec::new(),
            changes: Next::default(),
            config_known: false,
            workspace: None,
            turn: None,
            starting: None,
            awaited: None,
            ended: None,
            interrupt_wanted: false,
            compact_asked: false,
            failure: None,
            told_signed_out: false,
            calls: HashMap::new(),
            streamed: HashSet::new(),
            compacting: HashSet::new(),
            asked: HashMap::new(),
            total: None,
            base: None,
            lasts: Tokens::default(),
            context: (None, None),
            context_told: (None, None),
            skipped_head: Vec::new(),
        }
    }

    /// A request line, with the id its answer comes back under.
    fn request(&mut self, sent: Sent, method: &str, params: Value) -> (String, i64) {
        self.next += 1;
        self.sent.insert(self.next, sent);
        let line = json!({ "id": self.next, "method": method, "params": params });
        (line.to_string(), self.next)
    }

    /// What starts or resumes the thread, with the workbench's settings.
    fn thread_request(&mut self) -> String {
        let mut params = json!({
            "cwd": self.project.to_string_lossy(),
            // Approvals come to the window, whoever the user's own
            // configuration says reviews them.
            "approvalsReviewer": "user",
        });
        if let Some(thread) = &self.resume {
            params["threadId"] = json!(thread);
            // The window reads past turns from the transcript.
            params["excludeTurns"] = json!(true);
        }
        if let Some(model) = &self.start_model {
            params["model"] = json!(model);
        }
        if let Some(mode) = self.start_mode.as_deref().and_then(mode) {
            params["approvalPolicy"] = json!(mode.approval);
            params["sandbox"] = json!(mode.sandbox);
        }
        let mut config = Map::new();
        if let Some(effort) = &self.start_effort {
            config.insert("model_reasoning_effort".into(), json!(effort));
        }
        if let Some(server) = &self.tool_server {
            let mut env = Map::new();
            if let Some(session) = &self.session {
                env.insert(SESSION_VAR.into(), json!(session));
            }
            if self.orchestrator {
                env.insert(ROLE_VAR.into(), json!(ORCHESTRATOR_ROLE));
            }
            config.insert(
                "mcp_servers".into(),
                json!({
                    hook::CODEX_SERVER_KEY: {
                        "command": server.to_string_lossy(),
                        "args": ["mcp"],
                        "env": env,
                        // The workbench's own tools run without asking, as
                        // they do in a terminal session.
                        "default_tools_approval_mode": "approve",
                    }
                }),
            );
        }
        if !config.is_empty() {
            params["config"] = Value::Object(config);
        }
        let method = if self.resume.is_some() {
            "thread/resume"
        } else {
            "thread/start"
        };
        self.request(Sent::Thread, method, params).0
    }

    fn efforts_of(&self, model: Option<&str>) -> Vec<String> {
        let Some(model) = model else {
            return vec![];
        };
        self.models
            .iter()
            .find(|(info, _)| info.value == model)
            .map(|(info, _)| info.efforts.clone())
            .unwrap_or_default()
    }

    fn configured(&self) -> Event {
        Event::Configured {
            model: self.model.clone(),
            mode: self.mode.clone(),
            effort: self.effort.clone(),
            efforts: self.efforts_of(self.model.as_deref()),
        }
    }

    /// Says the session is ready, once the thread is there and the account
    /// and the models are known.
    fn introduce(&mut self, out: &mut Reading) {
        if self.ready || !self.account_known || !self.models_known || !self.config_known {
            return;
        }
        let Some(started) = self.started.take() else {
            return;
        };
        let thread = started["thread"]["id"]
            .as_str()
            .map(str::to_string)
            .or_else(|| self.resume.clone());
        let Some(thread) = thread else {
            out.fatal = Some((
                ErrorKind::Protocol,
                "Codex started a thread without saying its id".into(),
            ));
            return;
        };
        self.thread = Some(thread.clone());
        if started["sandbox"]["type"] == "workspaceWrite" {
            self.workspace = Some(started["sandbox"].clone());
        }
        self.model = text(&started["model"]).or_else(|| self.start_model.clone());
        self.effort = text(&started["reasoningEffort"]).or_else(|| self.start_effort.clone());
        self.mode =
            mode_of(&started["approvalPolicy"], &started["sandbox"]).or(self.start_mode.clone());
        self.ready = true;
        out.events.push(Event::Ready {
            session_id: thread,
            model: self.model.clone(),
            mode: self.mode.clone(),
            effort: self.effort.clone(),
            version: self.version.clone(),
            models: self.models.iter().map(|(info, _)| info.clone()).collect(),
            modes: MODES
                .iter()
                .map(|mode| ModeInfo {
                    value: mode.value.to_string(),
                    name: mode.name.to_string(),
                    description: Some(mode.description.to_string()),
                })
                .collect(),
            efforts: self.efforts_of(self.model.as_deref()),
            commands: vec![],
        });
        if self.signed_out {
            self.told_signed_out = true;
            out.events.push(Event::Error {
                kind: ErrorKind::NotLoggedIn,
                message: NOT_LOGGED_IN.to_string(),
            });
        }
    }

    /// An answer to a request this side sent.
    fn answered(&mut self, id: i64, line: &Value, out: &mut Reading) {
        let Some(sent) = self.sent.remove(&id) else {
            return;
        };
        let reply: Result<Value, String> = match line.get("error") {
            Some(error) => Err(error["message"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| error.to_string())),
            None => Ok(line["result"].clone()),
        };
        match sent {
            Sent::Initialize => match &reply {
                Ok(result) => {
                    self.version = result["userAgent"].as_str().and_then(version_of);
                    if let Some(version) = &self.version {
                        if numbers(version).is_some_and(|found| found < OLDEST) {
                            let (major, minor, patch) = OLDEST;
                            out.fatal = Some((
                                ErrorKind::Protocol,
                                format!(
                                    "Codex {version} is older than {major}.{minor}.{patch}, the \
                                     oldest the workbench speaks to. Update Codex, or run it in a \
                                     terminal session."
                                ),
                            ));
                            return;
                        }
                    }
                    out.writes
                        .push(json!({ "method": "initialized" }).to_string());
                    let (account, _) = self.request(
                        Sent::Account,
                        "account/read",
                        json!({ "refreshToken": false }),
                    );
                    let (models, _) = self.request(Sent::Models, "model/list", json!({}));
                    let (config, _) = self.request(
                        Sent::Config,
                        "config/read",
                        json!({ "cwd": self.project.to_string_lossy(), "includeLayers": false }),
                    );
                    let thread = self.thread_request();
                    out.writes.extend([account, models, config, thread]);
                }
                Err(error) => {
                    out.fatal = Some((
                        ErrorKind::Protocol,
                        format!("Codex refused to begin the conversation: {error}"),
                    ));
                }
            },
            Sent::Account => {
                if let Ok(result) = &reply {
                    self.signed_out =
                        result["account"].is_null() && result["requiresOpenaiAuth"] == true;
                }
                self.account_known = true;
                self.introduce(out);
            }
            Sent::Models => {
                if let Ok(result) = &reply {
                    self.models = result["data"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|model| model["hidden"] != true)
                        .filter_map(|model| {
                            let value = text(&model["model"]).or_else(|| text(&model["id"]))?;
                            Some((
                                ModelInfo {
                                    name: text(&model["displayName"]),
                                    description: text(&model["description"])
                                        .filter(|d| !d.is_empty()),
                                    efforts: model["supportedReasoningEfforts"]
                                        .as_array()
                                        .into_iter()
                                        .flatten()
                                        .filter_map(|effort| {
                                            text(&effort["reasoningEffort"])
                                                .or_else(|| text(effort))
                                        })
                                        .collect(),
                                    value,
                                },
                                text(&model["defaultReasoningEffort"]),
                            ))
                        })
                        .collect();
                }
                self.models_known = true;
                self.introduce(out);
            }
            Sent::Config => {
                if let Ok(result) = &reply {
                    if self.workspace.is_none() {
                        self.workspace = configured_workspace(&result["config"]);
                    }
                }
                self.config_known = true;
                self.introduce(out);
            }
            Sent::Thread => match reply {
                Ok(result) => {
                    self.started = Some(result);
                    self.introduce(out);
                }
                Err(error) => {
                    let what = match &self.resume {
                        Some(thread) => format!("Codex could not resume the thread {thread}"),
                        None => "Codex could not start a thread".to_string(),
                    };
                    out.fatal = Some((ErrorKind::Agent, format!("{what}: {error}")));
                }
            },
            Sent::Turn(message, carried) => {
                if self.starting == Some(id) {
                    self.starting = None;
                }
                match reply {
                    Ok(result) => self.turn_answered(text(&result["turn"]["id"]), message, out),
                    Err(error) => {
                        // What it carried goes with the next one, unless
                        // changed again since; and an interrupt meant for
                        // the turn it would have started has none to stop.
                        self.changes = std::mem::take(&mut self.changes).or(carried);
                        self.interrupt_wanted = false;
                        out.events.push(Event::message(
                            &message,
                            MessageState::Dropped,
                            Some(error),
                        ));
                    }
                }
            }
            Sent::Interrupt => out.replies.push((id.to_string(), reply)),
            Sent::LateInterrupt => {}
            Sent::Compact => {
                if reply.is_err() {
                    self.compact_asked = false;
                }
                out.replies.push((id.to_string(), reply));
            }
        }
    }

    /// A turn began: the messages it answers are those named.
    fn begin(&mut self, turn: &str, messages: Vec<String>, out: &mut Reading) {
        if self.turn.as_deref() == Some(turn) {
            return;
        }
        self.turn = Some(turn.to_string());
        self.failure = None;
        self.base = self.total;
        self.lasts = Tokens::default();
        out.events.push(Event::TurnStarted { messages });
        if std::mem::take(&mut self.interrupt_wanted) {
            if let Some(thread) = self.thread.clone() {
                let (line, _) = self.request(
                    Sent::LateInterrupt,
                    "turn/interrupt",
                    json!({ "threadId": thread, "turnId": turn }),
                );
                out.writes.push(line);
            }
        }
    }

    /// Codex took a message, as the turn named, where it named one.
    fn turn_answered(&mut self, turn: Option<String>, message: String, out: &mut Reading) {
        match (turn, self.turn.clone()) {
            // Its turn began before the answer came, naming nothing then:
            // a second start names it, and the core takes it as taken into
            // the turn that runs.
            (Some(turn), Some(running)) if turn == running => {
                out.events.push(Event::TurnStarted {
                    messages: vec![message],
                });
            }
            // Its turn has begun and ended already: the message was taken
            // into it.
            (Some(turn), None) if self.ended.as_deref() == Some(turn.as_str()) => {
                out.events
                    .push(Event::message(&message, MessageState::Taken, None));
            }
            (Some(turn), None) => self.begin(&turn, vec![message], out),
            // Another turn runs, or the answer named none: its own start
            // names it.
            (turn, _) => self.awaited = Some((turn, message)),
        }
    }

    fn turn_started(&mut self, params: &Value, out: &mut Reading) {
        let Some(turn) = params["turn"]["id"].as_str() else {
            return;
        };
        if self.turn.as_deref() == Some(turn) {
            return;
        }
        // The turn Codex said a message starts; any other is one it began
        // by itself, such as to compact, or one whose message's answer has
        // not come yet.
        let messages = match &self.awaited {
            Some((awaited, _)) if awaited.as_deref().is_none_or(|awaited| awaited == turn) => {
                vec![self.awaited.take().expect("matched above").1]
            }
            _ => vec![],
        };
        self.begin(turn, messages, out);
    }

    fn turn_completed(&mut self, params: &Value, out: &mut Reading) {
        let turn = &params["turn"];
        if let (None, Some(ended)) = (&self.turn, turn["id"].as_str()) {
            // The end of a message's turn never seen to start.
            if matches!(&self.awaited, Some((Some(awaited), _)) if awaited == ended) {
                let message = self.awaited.take().expect("matched above").1;
                self.begin(ended, vec![message], out);
            }
        }
        let outcome = match turn["status"].as_str() {
            Some("completed") => Outcome::Done,
            Some("interrupted") => Outcome::Interrupted,
            _ => Outcome::Failed,
        };
        let error = (outcome == Outcome::Failed).then(|| {
            let error = &turn["error"];
            match (text(&error["message"]), text(&error["additionalDetails"])) {
                (Some(message), Some(details)) if !details.is_empty() => {
                    format!("{message}: {details}")
                }
                (Some(message), _) => message,
                _ => self
                    .failure
                    .clone()
                    .unwrap_or_else(|| "the turn failed".into()),
            }
        });
        let usage = match (self.base, self.total) {
            (Some(base), Some(total)) => Some(total.minus(base).usage()),
            _ => (self.lasts != Tokens::default()).then(|| self.lasts.usage()),
        };
        // What the turn left waiting for an answer is answered no, so the
        // agent is not left holding it, and withdrawn.
        let ended = text(&turn["id"]);
        let left: Vec<String> = self
            .asked
            .iter()
            .filter(|(_, asked)| asked.turn.is_none() || asked.turn == ended)
            .map(|(key, _)| key.clone())
            .collect();
        for key in left {
            let asked = self.asked.remove(&key).expect("listed above");
            out.writes
                .push(json!({ "id": asked.id, "result": asked.refusal() }).to_string());
            out.events.push(Event::Withdrawn { request: key });
        }
        self.ended = self.turn.take().or(text(&turn["id"]));
        self.failure = None;
        self.told_signed_out = false;
        self.interrupt_wanted = false;
        self.calls.clear();
        self.streamed.clear();
        self.compacting.clear();
        out.events.push(Event::TurnEnded {
            outcome,
            error,
            total_cost_usd: None,
            duration_ms: turn["durationMs"].as_u64(),
            usage,
        });
    }

    /// The tool call an item is, with the agent's name for it, its kind and
    /// its input. None for an item that is no tool call.
    fn call_of(item: &Value) -> Option<(String, ToolKind, Value)> {
        let kind = item["type"].as_str()?;
        Some(match kind {
            "commandExecution" => (
                kind.to_string(),
                ToolKind::Command,
                json!({
                    "command": item["command"],
                    "cwd": item["cwd"],
                    "actions": item["commandActions"],
                }),
            ),
            "fileChange" => (
                kind.to_string(),
                ToolKind::Edit,
                json!({ "changes": item["changes"] }),
            ),
            "mcpToolCall" => {
                let server = item["server"].as_str().unwrap_or_default();
                let tool = item["tool"].as_str().unwrap_or_default();
                (
                    format!("mcp__{server}__{tool}"),
                    ToolKind::Mcp,
                    item["arguments"].clone(),
                )
            }
            "dynamicToolCall" => (
                text(&item["tool"]).unwrap_or_else(|| kind.to_string()),
                ToolKind::Other,
                item["arguments"].clone(),
            ),
            "collabAgentToolCall" => (
                text(&item["tool"]).unwrap_or_else(|| kind.to_string()),
                ToolKind::Agent,
                json!({ "prompt": item["prompt"], "model": item["model"] }),
            ),
            "webSearch" => (
                kind.to_string(),
                ToolKind::Web,
                json!({ "query": item["query"], "action": item["action"] }),
            ),
            "imageView" => (
                kind.to_string(),
                ToolKind::Read,
                json!({ "path": item["path"] }),
            ),
            _ => return None,
        })
    }

    /// Starts the tool call an item is, once.
    fn start_call(&mut self, id: &str, item: &Value, out: &mut Reading) -> bool {
        if self.calls.contains_key(id) {
            return true;
        }
        let Some((name, kind, input)) = Self::call_of(item) else {
            return false;
        };
        out.events.push(Event::ToolStarted {
            call: id.to_string(),
            parent: None,
            name: name.clone(),
            kind,
        });
        out.events.push(Event::ToolInput {
            call: id.to_string(),
            parent: None,
            delta: None,
            input: Some(input.clone()),
            truncated: false,
        });
        self.calls
            .insert(id.to_string(), Call { name, kind, input });
        true
    }

    fn item_started(&mut self, item: &Value, out: &mut Reading) {
        let Some(id) = item["id"].as_str() else {
            return;
        };
        if item["type"] == "contextCompaction" {
            if self.compacting.insert(id.to_string()) {
                out.events.push(Event::Compacting);
            }
            return;
        }
        self.start_call(id, item, out);
    }

    fn item_completed(&mut self, item: &Value, out: &mut Reading) {
        let Some(id) = item["id"].as_str() else {
            return;
        };
        match item["type"].as_str() {
            Some("agentMessage") => {
                out.events.push(Event::Text {
                    block: id.to_string(),
                    parent: None,
                    text: item["text"].as_str().unwrap_or_default().to_string(),
                    done: true,
                });
            }
            Some("reasoning") => {
                let parts = |key: &str| -> Vec<String> {
                    item[key]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|part| {
                            part.as_str()
                                .or_else(|| part["text"].as_str())
                                .unwrap_or_default()
                                .to_string()
                        })
                        .collect()
                };
                let summary = parts("summary");
                for (at, part) in summary.iter().enumerate() {
                    out.events.push(Event::Thinking {
                        block: format!("{id}:{at}"),
                        parent: None,
                        text: part.clone(),
                        done: true,
                    });
                }
                for (at, part) in parts("content").into_iter().enumerate() {
                    let block = format!("{id}:raw:{at}");
                    if summary.is_empty() || self.streamed.contains(&block) {
                        out.events.push(Event::Thinking {
                            block,
                            parent: None,
                            text: part,
                            done: true,
                        });
                    }
                }
            }
            Some("plan") => out.events.push(Event::Plan {
                call: None,
                parent: None,
                text: text(&item["text"]),
                steps: vec![],
            }),
            Some("contextCompaction") => {
                self.compacting.remove(id);
                let asked = std::mem::take(&mut self.compact_asked);
                out.events.push(Event::Compacted {
                    reason: Some(if asked {
                        CompactReason::Asked
                    } else {
                        CompactReason::Full
                    }),
                    tokens_before: None,
                    tokens_after: None,
                });
            }
            _ => {
                if !self.start_call(id, item, out) {
                    return;
                }
                let call = self.calls.remove(id).expect("started above");
                let status = item["status"].as_str();
                let (output, error, changes) = match call.kind {
                    ToolKind::Command => (
                        item["aggregatedOutput"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string(),
                        status != Some("completed")
                            || item["exitCode"].as_i64().is_some_and(|code| code != 0),
                        vec![],
                    ),
                    ToolKind::Edit => (
                        String::new(),
                        status != Some("completed"),
                        if status == Some("completed") {
                            file_changes(&item["changes"], &self.project)
                        } else {
                            vec![]
                        },
                    ),
                    ToolKind::Mcp => match text(&item["error"]["message"]) {
                        Some(error) => (error, true, vec![]),
                        None => (
                            mcp_output(&item["result"]),
                            status == Some("failed"),
                            vec![],
                        ),
                    },
                    _ => (
                        mcp_output(&json!({ "content": item["contentItems"] })),
                        status == Some("failed") || item["success"] == false,
                        vec![],
                    ),
                };
                out.events.push(Event::ToolFinished {
                    call: id.to_string(),
                    parent: None,
                    output,
                    error,
                    truncated: false,
                    changes,
                });
            }
        }
    }

    fn token_usage(&mut self, params: &Value, out: &mut Reading) {
        let usage = &params["tokenUsage"];
        if let Some(total) = Tokens::read(&usage["total"]) {
            self.total = Some(total);
        }
        if let Some(last) = Tokens::read(&usage["last"]) {
            if self.turn.is_some() {
                self.lasts = self.lasts.plus(last);
            }
            self.context.0 = Some(last.total);
        }
        if let Some(size) = usage["modelContextWindow"].as_u64() {
            self.context.1 = Some(size);
        }
        if self.context != self.context_told && self.context != (None, None) {
            self.context_told = self.context;
            out.events.push(Event::Context {
                used: self.context.0,
                size: self.context.1,
            });
        }
    }

    fn notice(&mut self, level: NoticeLevel, message: Option<String>, out: &mut Reading) {
        if let Some(message) = message.filter(|message| !message.trim().is_empty()) {
            out.events.push(Event::Notice { level, message });
        }
    }

    /// The summary of a warning, with its details where it gives them.
    fn summary(params: &Value) -> Option<String> {
        let summary = text(&params["summary"])?;
        Some(match text(&params["details"]).filter(|d| !d.is_empty()) {
            Some(details) => format!("{summary}: {details}"),
            None => summary,
        })
    }

    fn notified(&mut self, method: &str, params: &Value, out: &mut Reading) {
        match method {
            "turn/started" => self.turn_started(params, out),
            "turn/completed" => self.turn_completed(params, out),
            "item/started" => self.item_started(&params["item"], out),
            "item/completed" => self.item_completed(&params["item"], out),
            "item/agentMessage/delta" => {
                if let (Some(block), Some(delta)) =
                    (params["itemId"].as_str(), params["delta"].as_str())
                {
                    out.events.push(Event::Text {
                        block: block.to_string(),
                        parent: None,
                        text: delta.to_string(),
                        done: false,
                    });
                }
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                let (Some(item), Some(delta)) =
                    (params["itemId"].as_str(), params["delta"].as_str())
                else {
                    return;
                };
                let block = if method == "item/reasoning/textDelta" {
                    format!(
                        "{item}:raw:{}",
                        params["contentIndex"].as_u64().unwrap_or(0)
                    )
                } else {
                    format!("{item}:{}", params["summaryIndex"].as_u64().unwrap_or(0))
                };
                self.streamed.insert(block.clone());
                out.events.push(Event::Thinking {
                    block,
                    parent: None,
                    text: delta.to_string(),
                    done: false,
                });
            }
            "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
                if let (Some(call), Some(delta)) =
                    (params["itemId"].as_str(), params["delta"].as_str())
                {
                    if self.calls.contains_key(call) {
                        out.events.push(Event::ToolOutput {
                            call: call.to_string(),
                            parent: None,
                            delta: delta.to_string(),
                        });
                    }
                }
            }
            "item/fileChange/patchUpdated" => {
                let Some(call) = params["itemId"].as_str() else {
                    return;
                };
                if let Some(open) = self.calls.get_mut(call) {
                    let input = json!({ "changes": params["changes"] });
                    if open.input != input {
                        open.input = input.clone();
                        out.events.push(Event::ToolInput {
                            call: call.to_string(),
                            parent: None,
                            delta: None,
                            input: Some(input),
                            truncated: false,
                        });
                    }
                }
            }
            "turn/plan/updated" => out.events.push(Event::Plan {
                call: None,
                parent: None,
                text: None,
                steps: params["plan"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|step| {
                        Some(PlanStep {
                            text: step["step"].as_str()?.to_string(),
                            status: match step["status"].as_str() {
                                Some("inProgress") => StepStatus::Active,
                                Some("completed") => StepStatus::Done,
                                _ => StepStatus::Pending,
                            },
                        })
                    })
                    .collect(),
            }),
            "turn/diff/updated" => {
                if let Some(diff) = params["diff"].as_str() {
                    out.events.push(Event::TurnDiff {
                        diff: diff.to_string(),
                        truncated: false,
                    });
                }
            }
            "thread/tokenUsage/updated" => self.token_usage(params, out),
            "thread/settings/updated" => {
                let settings = &params["threadSettings"];
                let mut changed = false;
                if settings["sandboxPolicy"]["type"] == "workspaceWrite" {
                    self.workspace = Some(settings["sandboxPolicy"].clone());
                }
                let model = text(&settings["model"]).filter(|_| self.changes.model.is_none());
                let effort = text(&settings["effort"]).filter(|_| self.changes.effort.is_none());
                let mode = mode_of(&settings["approvalPolicy"], &settings["sandboxPolicy"])
                    .filter(|_| self.changes.mode.is_none());
                for (now, new) in [
                    (&mut self.model, model),
                    (&mut self.effort, effort),
                    (&mut self.mode, mode),
                ] {
                    if new.is_some() && new != *now {
                        *now = new;
                        changed = true;
                    }
                }
                if changed && self.ready {
                    out.events.push(self.configured());
                }
            }
            "thread/compacted" => {
                // What an older Codex says in place of a compaction item.
                if self.compacting.is_empty() {
                    let asked = std::mem::take(&mut self.compact_asked);
                    out.events.push(Event::Compacted {
                        reason: Some(if asked {
                            CompactReason::Asked
                        } else {
                            CompactReason::Full
                        }),
                        tokens_before: None,
                        tokens_after: None,
                    });
                }
            }
            "error" => {
                let error = &params["error"];
                let message =
                    text(&error["message"]).unwrap_or_else(|| "the request failed".into());
                if unauthorized(&error["codexErrorInfo"]) && !self.told_signed_out {
                    self.told_signed_out = true;
                    out.events.push(Event::Error {
                        kind: ErrorKind::NotLoggedIn,
                        message: NOT_LOGGED_IN.to_string(),
                    });
                }
                if params["willRetry"] == true {
                    let (attempt, of) = attempts(&message);
                    out.events.push(Event::Retrying {
                        message,
                        attempt,
                        attempts: of,
                    });
                } else if self.turn.is_some() {
                    self.failure = Some(message);
                } else {
                    out.events.push(Event::Error {
                        kind: ErrorKind::Agent,
                        message,
                    });
                }
            }
            "thread/status/changed" => {
                if params["status"]["type"] == "systemError" {
                    out.events.push(Event::Error {
                        kind: ErrorKind::Agent,
                        message: "Codex reported an error of its own on the thread".into(),
                    });
                }
            }
            "serverRequest/resolved" => {
                let key = request_key(&params["requestId"]);
                if self.asked.remove(&key).is_some() {
                    out.events.push(Event::Withdrawn { request: key });
                }
            }
            "warning" | "guardianWarning" => {
                self.notice(NoticeLevel::Warning, text(&params["message"]), out)
            }
            "configWarning" | "deprecationNotice" => {
                self.notice(NoticeLevel::Warning, Self::summary(params), out)
            }
            "model/rerouted" => {
                let message = match (params["fromModel"].as_str(), params["toModel"].as_str()) {
                    (Some(from), Some(to)) => {
                        Some(format!("Codex moved this turn from {from} to {to}"))
                    }
                    _ => None,
                };
                self.notice(NoticeLevel::Warning, message, out);
            }
            "mcpServer/startupStatus/updated" if params["status"] == "failed" => {
                let name = params["name"].as_str().unwrap_or("an");
                let message = match text(&params["error"]).filter(|e| !e.is_empty()) {
                    Some(error) => format!("The {name} MCP server could not start: {error}"),
                    None => format!("The {name} MCP server could not start"),
                };
                self.notice(NoticeLevel::Warning, Some(message), out);
            }
            _ => {}
        }
    }

    /// A request from the server: a permission or a question to ask, or
    /// something this side does not do, which is answered as such.
    fn asked_of(&mut self, id: &Value, method: &str, params: &Value, out: &mut Reading) {
        let key = request_key(id);
        let call = text(&params["itemId"]);
        let turn = text(&params["turnId"]);
        let open_input = call
            .as_ref()
            .and_then(|call| self.calls.get(call))
            .map(|open| open.input.clone());
        let (asking, tool, input, description, path) = match method {
            "item/commandExecution/requestApproval" => {
                let command = text(&params["command"]);
                let network = params["proposedNetworkPolicyAmendments"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|amendment| amendment["action"] == "allow")
                    .cloned();
                (
                    Asking::Command {
                        command: command.clone(),
                        prefix: params["proposedExecpolicyAmendment"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|part| part.as_str().map(str::to_string))
                            .collect(),
                        network,
                    },
                    "commandExecution".to_string(),
                    open_input.unwrap_or_else(|| {
                        json!({
                            "command": params["command"],
                            "cwd": params["cwd"],
                            "actions": params["commandActions"],
                        })
                    }),
                    text(&params["reason"]),
                    text(&params["networkApprovalContext"]["host"]),
                )
            }
            "item/fileChange/requestApproval" => {
                let root = text(&params["grantRoot"]);
                (
                    Asking::File { root: root.clone() },
                    "fileChange".to_string(),
                    open_input.unwrap_or(Value::Null),
                    text(&params["reason"]),
                    root,
                )
            }
            "item/permissions/requestApproval" => {
                let asked = params["permissions"].clone();
                (
                    Asking::Permissions {
                        described: described(&asked),
                        asked: asked.clone(),
                    },
                    "permissions".to_string(),
                    asked,
                    text(&params["reason"]),
                    text(&params["cwd"]),
                )
            }
            "item/tool/requestUserInput" => {
                let (questions, ids) = questions(params);
                let options = questions
                    .iter()
                    .map(|question| {
                        (!question.other).then(|| {
                            question
                                .options
                                .iter()
                                .map(|option| option.label.clone())
                                .collect()
                        })
                    })
                    .collect();
                out.events.push(Event::QuestionAsked {
                    request: key.clone(),
                    call,
                    parent: None,
                    questions,
                });
                self.asked.insert(
                    key,
                    Asked {
                        id: id.clone(),
                        turn,
                        asking: Asking::Question { ids, options },
                    },
                );
                return;
            }
            "mcpServer/elicitation/request"
                if params["_meta"]["codex_approval_kind"] == "mcp_tool_call" =>
            {
                let server = params["serverName"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                let tool = params["_meta"]["tool_name"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                let input = params["_meta"]["tool_params"].clone();
                // The call it is for: the one open call of that tool, or of
                // those the one with these arguments. None where that does
                // not tell one call from another.
                let name = format!("mcp__{server}__{tool}");
                let named: Vec<(&String, &Call)> = self
                    .calls
                    .iter()
                    .filter(|(_, open)| open.kind == ToolKind::Mcp && open.name == name)
                    .collect();
                let call = match named.as_slice() {
                    [(call, _)] => Some((*call).clone()),
                    _ => {
                        let same: Vec<&String> = named
                            .iter()
                            .filter(|(_, open)| open.input == input)
                            .map(|(call, _)| *call)
                            .collect();
                        match same.as_slice() {
                            [call] => Some((*call).clone()),
                            _ => None,
                        }
                    }
                };
                let persist = params["_meta"]["persist"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|p| p.as_str().map(str::to_string))
                    .collect();
                let asked = Asked {
                    id: id.clone(),
                    turn,
                    asking: Asking::Mcp {
                        server: server.clone(),
                        tool: tool.clone(),
                        persist,
                    },
                };
                out.events.push(Event::PermissionAsked {
                    request: key.clone(),
                    call,
                    parent: None,
                    tool: format!("mcp__{server}__{tool}"),
                    input,
                    truncated: false,
                    description: text(&params["message"]),
                    path: None,
                    choices: asked.offers(),
                });
                self.asked.insert(key, asked);
                return;
            }
            "mcpServer/elicitation/request" => {
                // A form from an MCP server, which no window draws.
                let server = params["serverName"].as_str().unwrap_or("an");
                out.writes.push(
                    json!({ "id": id, "result": { "action": "decline", "content": null } })
                        .to_string(),
                );
                self.notice(
                    NoticeLevel::Warning,
                    Some(format!(
                        "The {server} MCP server asked for something the workbench cannot show, \
                         and was told no"
                    )),
                    out,
                );
                return;
            }
            _ => {
                out.writes.push(turned_down(id, method));
                return;
            }
        };
        let asked = Asked {
            id: id.clone(),
            turn,
            asking,
        };
        out.events.push(Event::PermissionAsked {
            request: key.clone(),
            call,
            parent: None,
            tool,
            input,
            truncated: false,
            description,
            path,
            choices: asked.offers(),
        });
        self.asked.insert(key, asked);
    }

    /// The thread this session holds, once Codex has said which.
    fn own_thread(&self) -> Option<&str> {
        self.thread
            .as_deref()
            .or_else(|| self.started.as_ref()?["thread"]["id"].as_str())
            .or(self.resume.as_deref())
    }

    /// Whether a message names a thread other than this session's, as a
    /// sub-agent's notifications and requests do.
    fn another_thread(&self, params: &Value) -> bool {
        match (params["threadId"].as_str(), self.own_thread()) {
            (Some(named), Some(own)) => named != own,
            _ => false,
        }
    }

    /// Whether a model is one the agent offers, where it said which.
    fn offered(&self, model: &str) -> bool {
        self.models.is_empty() || self.models.iter().any(|(info, _)| info.value == model)
    }
}

impl Driver for AppServer {
    fn opening(&mut self) -> Vec<String> {
        let (line, _) = self.request(
            Sent::Initialize,
            "initialize",
            json!({
                "clientInfo": {
                    "name": CLIENT_NAME,
                    "title": "Agent Workbench",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": { "experimentalApi": false },
            }),
        );
        vec![line]
    }

    fn read(&mut self, line: &str) -> Reading {
        let mut out = Reading::default();
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return out;
        };
        let method = value["method"].as_str();
        let elsewhere = self.another_thread(&value["params"]);
        match (value.get("id"), method) {
            // Another thread's request, such as a sub-agent's, is not this
            // session's to ask; it is told no rather than left waiting.
            (Some(id), Some(method)) if elsewhere => out.writes.push(turned_down(id, method)),
            (Some(id), Some(method)) => self.asked_of(id, method, &value["params"], &mut out),
            (Some(id), None) => {
                if let Some(id) = id.as_i64() {
                    self.answered(id, &value, &mut out);
                }
            }
            (None, Some(_)) if elsewhere => {}
            (None, Some(method)) => self.notified(method, &value["params"], &mut out),
            (None, None) => {}
        }
        out
    }

    /// Codex folds a `turn/start` sent while a turn runs into that turn,
    /// answering with its id, so a message held until it ends gets a turn
    /// and settings of its own.
    fn takes_while_busy(&self) -> bool {
        false
    }

    fn message(&mut self, message: &str, text: &str, images: &[Image]) -> Result<String, String> {
        let thread = self
            .thread
            .clone()
            .ok_or("Codex has no thread to take the message yet")?;
        if text.trim().is_empty() && images.is_empty() {
            return Err("there is nothing to send".into());
        }
        let mut input = Vec::new();
        if !text.trim().is_empty() {
            input.push(json!({ "type": "text", "text": text, "text_elements": [] }));
        }
        for image in images {
            if !IMAGE_TYPES.contains(&image.media_type.as_str()) {
                return Err(format!(
                    "{} is not an image the agent takes",
                    image.media_type
                ));
            }
            if image.data.is_empty() {
                return Err("an attached image is empty".into());
            }
            input.push(json!({
                "type": "image",
                "url": format!("data:{};base64,{}", image.media_type, image.data),
            }));
        }
        let mut params = json!({
            "threadId": thread,
            "input": input,
            "clientUserMessageId": message,
        });
        // The changes go with this turn, and come back if it fails.
        let carried = std::mem::take(&mut self.changes);
        if let Some(model) = &carried.model {
            params["model"] = json!(model);
        }
        if let Some(effort) = &carried.effort {
            params["effort"] = json!(effort);
        }
        if let Some(mode) = carried.mode.as_deref().and_then(mode) {
            params["approvalPolicy"] = json!(mode.approval);
            params["sandboxPolicy"] = sandbox_policy(mode.sandbox, self.workspace.as_ref());
        }
        let (line, id) = self.request(
            Sent::Turn(message.to_string(), carried),
            "turn/start",
            params,
        );
        self.starting = Some(id);
        // The core hands a message over only once the one before it has its
        // turn or is dropped, so an interrupt still waiting was for neither.
        self.interrupt_wanted = false;
        Ok(line)
    }

    fn answer(
        &mut self,
        request: &str,
        choice: Choice,
        _message: Option<&str>,
    ) -> Result<String, String> {
        let asked = self
            .asked
            .get(request)
            .ok_or("the agent is not waiting on that request")?;
        let result = asked.answer(choice)?;
        let line = json!({ "id": asked.id, "result": result }).to_string();
        self.asked.remove(request);
        Ok(line)
    }

    fn reply(&mut self, request: &str, answers: Option<&[Vec<String>]>) -> Result<String, String> {
        let asked = self
            .asked
            .get(request)
            .ok_or("the agent is not waiting on that question")?;
        let Asking::Question { ids, options } = &asked.asking else {
            return Err("that request is a permission, answered with a choice".into());
        };
        let mut by_question = Map::new();
        if let Some(answers) = answers {
            if answers.len() != ids.len() {
                return Err(format!(
                    "{} answers for {} questions",
                    answers.len(),
                    ids.len()
                ));
            }
            for ((id, answer), options) in ids.iter().zip(answers).zip(options) {
                let answer: Vec<&str> = answer
                    .iter()
                    .map(|a| a.trim())
                    .filter(|a| !a.is_empty())
                    .collect();
                if answer.is_empty() {
                    return Err(format!("no answer to question {id}"));
                }
                if let Some(options) = options {
                    if let Some(other) = answer.iter().find(|a| !options.iter().any(|o| o == *a)) {
                        return Err(format!(
                            "{other:?} is not one of the options of question {id}"
                        ));
                    }
                }
                by_question.insert(id.clone(), json!({ "answers": answer }));
            }
        }
        let line = json!({ "id": asked.id, "result": { "answers": by_question } }).to_string();
        self.asked.remove(request);
        Ok(line)
    }

    fn control(&mut self, control: &Control) -> Result<Sending, String> {
        let local = |reply: Value, events: Vec<Event>| Ok(Sending::Local { reply, events });
        match control {
            Control::Interrupt => match (&self.thread, &self.turn) {
                (Some(thread), Some(turn)) => {
                    let params = json!({ "threadId": thread, "turnId": turn });
                    let (line, id) = self.request(Sent::Interrupt, "turn/interrupt", params);
                    Ok(Sending::Request {
                        line,
                        key: id.to_string(),
                    })
                }
                _ => {
                    // A turn on its way is stopped once it has an id.
                    self.interrupt_wanted = self.starting.is_some() || self.awaited.is_some();
                    local(Value::Null, vec![])
                }
            },
            Control::Compact => {
                let thread = self
                    .thread
                    .clone()
                    .ok_or("Codex has no conversation to compact yet")?;
                self.compact_asked = true;
                let (line, id) = self.request(
                    Sent::Compact,
                    "thread/compact/start",
                    json!({ "threadId": thread }),
                );
                Ok(Sending::Request {
                    line,
                    key: id.to_string(),
                })
            }
            Control::SetModel(model) => {
                if !self.ready {
                    return Err("Codex is not ready yet".into());
                }
                let model = model.trim();
                if model.is_empty() || !self.offered(model) {
                    return Err(format!("Codex does not offer the model {model:?}"));
                }
                self.model = Some(model.to_string());
                self.changes.model = Some(model.to_string());
                // An effort the model does not take gives way to the one it
                // takes by default.
                let efforts = self.efforts_of(Some(model));
                if !efforts.is_empty() && !self.effort.as_ref().is_some_and(|e| efforts.contains(e))
                {
                    let default = self
                        .models
                        .iter()
                        .find(|(info, _)| info.value == model)
                        .and_then(|(_, default)| default.clone())
                        .filter(|default| efforts.contains(default))
                        .or_else(|| efforts.first().cloned());
                    self.effort = default.clone();
                    self.changes.effort = default;
                }
                local(json!({ "model": model }), vec![self.configured()])
            }
            Control::SetEffort(effort) => {
                if !self.ready {
                    return Err("Codex is not ready yet".into());
                }
                let effort = effort.trim();
                let efforts = self.efforts_of(self.model.as_deref());
                if effort.is_empty()
                    || (!efforts.is_empty() && !efforts.iter().any(|e| e == effort))
                {
                    return Err(format!("the model takes no {effort:?} effort"));
                }
                self.effort = Some(effort.to_string());
                self.changes.effort = Some(effort.to_string());
                local(json!({ "effort": effort }), vec![self.configured()])
            }
            Control::SetMode(value) => {
                if !self.ready {
                    return Err("Codex is not ready yet".into());
                }
                let found = mode(value.trim())
                    .ok_or_else(|| format!("{value:?} is not a mode Codex runs in"))?;
                self.mode = Some(found.value.to_string());
                self.changes.mode = Some(found.value.to_string());
                local(json!({ "mode": found.value }), vec![self.configured()])
            }
        }
    }

    fn forget(&mut self, key: &str) {
        if let Ok(id) = key.parse::<i64>() {
            if self.sent.remove(&id) == Some(Sent::Compact) {
                self.compact_asked = false;
            }
        }
    }

    fn skipping(&mut self, bytes: &[u8]) {
        let room = HEAD_KEEP.saturating_sub(self.skipped_head.len());
        self.skipped_head
            .extend_from_slice(&bytes[..bytes.len().min(room)]);
    }

    /// A request too long to read is told no, and a completed item too long
    /// to read finishes its call as cut short, with no output, so neither
    /// waits for the end of the turn.
    fn skipped(&mut self) -> Reading {
        let mut out = Reading::default();
        let head = String::from_utf8_lossy(&std::mem::take(&mut self.skipped_head)).to_string();
        // A request nobody can read is told no, so the turn does not wait on
        // it.
        if let Some((id, method)) = head_request(&head) {
            out.writes.push(turned_down(&id, &method));
            return out;
        }
        if !head.contains(r#""method":"item/completed""#) {
            return out;
        }
        let Some(item) = head.find(r#""item":{"#) else {
            return out;
        };
        let rest = &head[item..];
        let Some(at) = rest.find(r#""id":""#) else {
            return out;
        };
        let rest = &rest[at + r#""id":""#.len()..];
        let Some(end) = rest.find('"') else {
            return out;
        };
        let call = &rest[..end];
        if self.calls.remove(call).is_some() {
            out.events.push(Event::ToolFinished {
                call: call.to_string(),
                parent: None,
                output: String::new(),
                error: true,
                truncated: true,
                changes: vec![],
            });
        }
        out
    }
}

#[cfg(test)]
#[path = "codex_app_server_tests.rs"]
mod tests;
