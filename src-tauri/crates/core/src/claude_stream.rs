//! Claude Code's stream protocol, spoken directly.
//!
//! `claude -p` with stream-json in and out is a long-lived conversation:
//! user messages and control requests go in as JSON lines, and the agent's
//! messages, the raw API stream events and its own control requests come
//! out. None of it has a published format, so this is the one place that
//! reads it, and it reads defensively: a field is looked up and its absence
//! means nothing, an unknown message type is skipped, a line that is not
//! JSON is skipped, and a control request from the agent that this side
//! does not handle is answered with an error rather than left waiting.
//!
//! Everything leaves as the agent-neutral events of the integrated
//! sessions; nothing Claude-shaped goes past this file.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::{json, Value};

use crate::adapter::{
    prepare_process, process, CLAUDE_CONFIG_VAR, ORCHESTRATOR_ROLE, ROLE_VAR, SESSION_VAR,
};
use crate::env::find_on_path;
use crate::hook;
use crate::integrated::{
    kept_windows, limits_due, now_seconds, percent, ChangeKind, Choice, CommandInfo, CompactReason,
    Control, Driver, ErrorKind, Event, FileChange, Hunk, Image, Launch, LimitKind, LimitSeverity,
    LimitWindow, MessageState, ModeInfo, ModelInfo, NoticeLevel, Offer, Outcome, PlanStep,
    Prepared, Protocol, Question, QuestionOption, Reading, Sending, StepStatus, TaskKind,
    TaskStatus, ToolKind, Usage,
};

pub struct ClaudeStream;

pub static CLAUDE_STREAM: ClaudeStream = ClaudeStream;

/// The name the workbench's tool server goes by, the same as when it is
/// written into the agent's own configuration, so its tools are named the
/// same either way.
const TOOL_SERVER: &str = "agent-workbench";

/// The agent's id, as a start names it, on the limits it reports.
const AGENT: &str = "claude-code";

/// The media types the agent takes an image in.
const IMAGE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

/// The permission modes a session can switch to, by the names the agent
/// takes. Bypassing permissions is left out: the agent takes it only when
/// started with a flag of its own.
const MODES: &[(&str, &str)] = &[
    ("default", "Default"),
    ("acceptEdits", "Accept edits"),
    ("plan", "Plan"),
    ("auto", "Auto"),
    ("dontAsk", "Don't ask"),
];

/// The tool that asks the user questions, answered with a reply rather
/// than a permission.
const ASK_TOOL: &str = "AskUserQuestion";

/// The tool that ends plan mode by asking to go ahead with a plan.
const PLAN_TOOL: &str = "ExitPlanMode";

/// The tool that keeps the agent's list of steps.
const TODO_TOOL: &str = "TodoWrite";

/// The arguments that make `claude` a stream session. `-p` with stream-json
/// both ways keeps it running for as long as stdin is open; `--verbose` is
/// required for stream-json output; the partial messages are the text as it
/// streams; subagent text comes only when forwarded; the user's messages
/// come back with the ids they were sent with, beside the agent's own
/// lines saying when it queued and took each; and the permission prompts
/// come to this side over stdio rather than being denied.
const STREAM_ARGS: &[&str] = &[
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--forward-subagent-text",
    "--replay-user-messages",
    "--permission-prompt-tool",
    "stdio",
];

/// Makes the agent say when its session goes idle: after the turn, and
/// after the turns that report the subagents it left running. That is the
/// moment no task it has not finished can still be at work.
const SESSION_STATE_VAR: &str = "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS";

/// The characters a value on the command line may hold besides letters
/// and digits, by what it is. Nothing a shell or the Windows command
/// interpreter reads as more than a character is among them: a `.cmd`
/// agent on Windows is run through that interpreter, arguments and all.
fn allowed(what: &str) -> &'static str {
    match what {
        // Model names such as `claude-sonnet-5-5[1m]` and
        // `us.anthropic.claude-haiku-5-5`, and ids with a provider prefix.
        "model" => "-._:/@[]",
        "session id" => "-",
        _ => "",
    }
}

/// A value for the command line or a control request, checked to be one:
/// never empty, never something that reads as a flag, and made of letters,
/// digits and the few characters its kind takes.
fn checked<'a>(what: &str, value: &'a str) -> Result<&'a str, String> {
    let value = value.trim();
    let extra = allowed(what);
    if value.is_empty()
        || value.starts_with('-')
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
    {
        return Err(format!("{value:?} is not a {what}"));
    }
    Ok(value)
}

impl Protocol for ClaudeStream {
    fn name(&self) -> &'static str {
        "claude"
    }

    fn command(&self, launch: &Launch) -> Result<Prepared, String> {
        let binary = find_on_path(launch.env, "claude").ok_or_else(|| {
            "claude was not found on your PATH. Install Claude Code, or check that \
             it is on the PATH your login shell sets up."
                .to_string()
        })?;
        let mut command = process(&binary, launch.env);
        command.args(STREAM_ARGS);
        if let Some(mode) = launch.mode {
            command.args(["--permission-mode", checked("permission mode", mode)?]);
        }
        if let Some(model) = launch.model {
            command.args(["--model", checked("model", model)?]);
        }
        if let Some(effort) = launch.effort {
            command.args(["--effort", checked("effort", effort)?]);
        }
        let session = checked(
            "session id",
            launch
                .session
                .ok_or("Claude Code takes its session id from the workbench")?,
        )?;
        if launch.resume {
            command.args(["--resume", session]);
        } else {
            command.args(["--session-id", session]);
        }
        let mut files = Vec::new();
        if let Some(server) = launch.tool_server {
            let config = json!({
                "mcpServers": {
                    TOOL_SERVER: {
                        "type": "stdio",
                        "command": server.to_string_lossy(),
                        "args": ["mcp"],
                    }
                }
            });
            // A file of the session's own rather than an argument, so that
            // no JSON passes through a command interpreter. Its name cannot
            // be guessed, it is made new, and only its owner can read it.
            let file = std::env::temp_dir().join(format!(
                "agent-workbench-mcp-{}.json",
                uuid::Uuid::new_v4().simple()
            ));
            write_private(&file, config.to_string().as_bytes())
                .map_err(|e| format!("could not write {}: {e}", file.display()))?;
            // Last, since the flag takes as many values as follow it.
            command.arg("--mcp-config").arg(&file);
            files.push(file);
        }

        prepare_process(&mut command, launch.project, launch.env);
        command.env(SESSION_STATE_VAR, "1");
        // The tool server the agent starts reads which session it serves,
        // and whether that session directs the others, from these.
        command.env(SESSION_VAR, session);
        if launch.orchestrator {
            command.env(ROLE_VAR, ORCHESTRATOR_ROLE);
        }
        if let Some(dir) = launch.config_dir {
            command.env(CLAUDE_CONFIG_VAR, dir);
        }
        Ok(Prepared { command, files })
    }

    fn driver(&self, launch: &Launch) -> Box<dyn Driver> {
        Box::new(Stream::new(
            launch.session.unwrap_or_default(),
            launch.model,
            launch.mode,
            launch.effort,
        ))
    }

    fn trusted(
        &self,
        home: &Path,
        config_dir: Option<&Path>,
        env: &HashMap<String, String>,
        folder: &Path,
    ) -> bool {
        hook::claude_trusts(&state_file(home, config_dir, env), folder)
    }

    fn trust(
        &self,
        home: &Path,
        config_dir: Option<&Path>,
        env: &HashMap<String, String>,
        folder: &Path,
    ) -> Result<(), String> {
        hook::claude_trust(&state_file(home, config_dir, env), folder)
    }
}

/// Writes a file that must not exist yet, readable by its owner alone.
fn write_private(file: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(file)?.write_all(contents)
}

/// The file Claude Code keeps its state in, trust among it, as a process
/// started with `env` finds it: in the account's configuration directory,
/// else where the environment's `CLAUDE_CONFIG_DIR` puts it, else in the
/// home directory.
fn state_file(home: &Path, config_dir: Option<&Path>, env: &HashMap<String, String>) -> PathBuf {
    let dir = config_dir.map(|dir| dir.to_string_lossy().to_string());
    crate::account::claude_json(home, dir.as_deref(), env)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Thinking,
    Tool,
}

/// A control request this side sent, by what its reply means.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Sent {
    Initialize,
    Settings,
    Interrupt,
    Model,
    Mode,
    Effort(String),
    /// A read of the account's limits, which nothing waits on.
    Usage,
}

/// A permission request the agent waits on, kept until it is answered or
/// withdrawn, since the answer carries the tool's input back.
#[derive(Debug, Clone)]
struct Asked {
    input: Value,
    /// The agent's own suggestions of what to remember, as it sent them.
    suggestions: Vec<Value>,
}

impl Asked {
    /// The first suggestion that adds an allow rule.
    fn rule(&self) -> Option<&Value> {
        self.suggestions
            .iter()
            .find(|s| s["type"] == "addRules" && s["behavior"] == "allow")
    }

    /// The first suggestion that switches the permission mode, for a tool
    /// that has no rule of its own to remember, such as a file write.
    fn mode(&self) -> Option<&Value> {
        self.suggestions
            .iter()
            .find(|s| s["type"] == "setMode" && s["mode"].is_string())
    }

    /// The rules of the suggested rule as the agent writes them in its
    /// settings, `Bash(touch x)`.
    fn described(&self) -> Option<String> {
        let rules = self.rule()?["rules"].as_array()?;
        let named: Vec<String> = rules
            .iter()
            .filter_map(|rule| {
                let tool = rule["toolName"].as_str()?;
                Some(match rule["ruleContent"].as_str() {
                    Some(content) => format!("{tool}({content})"),
                    None => tool.to_string(),
                })
            })
            .collect();
        (!named.is_empty()).then(|| named.join(", "))
    }

    /// The suggestion a choice remembers, sent back with the destination
    /// the choice means, and what it remembers in words. None for a choice
    /// that has nothing the agent suggested to remember.
    fn remembered(&self, choice: Choice) -> Option<(Value, String)> {
        match choice {
            Choice::AllowSession => {
                if let Some(rule) = self.described() {
                    let mut suggestion = self.rule()?.clone();
                    suggestion["destination"] = json!("session");
                    Some((suggestion, format!("{rule} for the rest of this session")))
                } else {
                    let mut suggestion = self.mode()?.clone();
                    let mode = suggestion["mode"].as_str()?.to_string();
                    suggestion["destination"] = json!("session");
                    Some((
                        suggestion,
                        format!("the {mode} permission mode for the rest of this session"),
                    ))
                }
            }
            Choice::AllowAlways => {
                let rule = self.described()?;
                let mut suggestion = self.rule()?.clone();
                suggestion["destination"] = json!("localSettings");
                Some((
                    suggestion,
                    format!("{rule} in this project's uncommitted local settings"),
                ))
            }
            _ => None,
        }
    }

    /// The answers this request takes: a choice that would remember
    /// something is offered only when the agent suggested what.
    fn offers(&self) -> Vec<Offer> {
        let mut offers = vec![Offer {
            choice: Choice::Allow,
            remembers: None,
            message: false,
        }];
        for choice in [Choice::AllowSession, Choice::AllowAlways] {
            if let Some((_, remembers)) = self.remembered(choice) {
                offers.push(Offer {
                    choice,
                    remembers: Some(remembers),
                    message: false,
                });
            }
        }
        for choice in [Choice::Deny, Choice::Cancel] {
            offers.push(Offer {
                choice,
                remembers: None,
                message: true,
            });
        }
        offers
    }
}

/// A task the agent said it started, until it says how it ended.
#[derive(Debug, Clone)]
struct Task {
    /// The tool call that started it.
    call: Option<String>,
    kind: TaskKind,
    /// Run in the background rather than waited on by the call that started
    /// it.
    background: bool,
    /// Its end goes back to the call that waits on it rather than into a
    /// turn of its own.
    awaited: bool,
    /// Started on behalf of a subagent rather than the main conversation.
    nested: bool,
    /// Left out of the agent's last list of what runs in the background.
    unlisted: bool,
}

impl Task {
    /// Whether the agent reports it in a turn of its own: a subagent in the
    /// background that nothing waits on.
    fn reports(&self) -> bool {
        self.kind == TaskKind::Agent && self.background && !self.awaited
    }
}

/// One session's reading of the stream.
struct Stream {
    session: String,
    model: Option<String>,
    mode: Option<String>,
    effort: Option<String>,
    /// The models the agent offers, with the name it resolves each to.
    models: Vec<(ModelInfo, Option<String>)>,
    /// What the agent said of itself at the start, held until the
    /// settings it runs on are known too.
    introduced: Option<Value>,
    /// The slash commands and skills as the agent last listed them.
    listed: Vec<CommandInfo>,
    /// The names of those that are skills, once a turn's start has said.
    skills: Option<Vec<String>>,
    /// The names of those that work only in the agent's own terminal.
    terminal_only: Vec<String>,
    /// The commands as last told.
    commands_told: Vec<CommandInfo>,
    settings_known: bool,
    ready: bool,
    next: u64,
    sent: HashMap<String, Sent>,
    asked: HashMap<String, Asked>,
    /// Questions waiting for a reply, with the input that asked them.
    questions: HashMap<String, Value>,
    /// The API message being streamed, by the subagent call it belongs to.
    streaming: HashMap<Option<String>, String>,
    /// Blocks being streamed, by message and index: their kind and id.
    open: HashMap<(String, u64), (Kind, String)>,
    /// Blocks done streaming whose whole form has not come yet, by message.
    closed: HashMap<String, VecDeque<(Kind, String)>>,
    /// Tool calls whose start has been told, by the subagent call they
    /// belong to.
    calls: HashMap<String, Option<String>>,
    /// Tasks running, by id.
    tasks: HashMap<String, Task>,
    /// Tasks told as lost, whose late word is dropped.
    lost: HashSet<String>,
    /// Whether a turn of the main conversation runs.
    turn: bool,
    /// Messages the agent took while no turn ran, for the turn about to
    /// start.
    starting: Vec<String>,
    /// The messages sent and not yet done with, and those of them the
    /// agent has said it took.
    ours: HashSet<String>,
    taken: HashSet<String>,
    interrupting: bool,
    minted: u64,
    /// What passed of a line too long to read: the end of the last piece,
    /// where a key may be cut in two, and the tool calls whose results it
    /// named.
    skipped_tail: Vec<u8>,
    skipped_calls: Vec<String>,
    /// What the conversation takes of the context window, as the last
    /// request of the main conversation said, and the window's size.
    context: (Option<u64>, Option<u64>),
    /// The same, as last told.
    context_told: (Option<u64>, Option<u64>),
    /// The account is not signed in, so it has no limits to read.
    signed_out: bool,
    /// The account's plan and the windows of its limits, as last told.
    plan: Option<String>,
    windows: Vec<LimitWindow>,
    /// When the last read of the limits was asked, and when the last one
    /// answered was taken, in seconds since the epoch.
    usage_asked: Option<Instant>,
    read_at: Option<u64>,
}

/// What names the tool call a result belongs to, in a line from the agent.
/// Inside a JSON string a quote is escaped, so this is never part of one.
const RESULT_KEY: &[u8] = br#""tool_use_id":""#;

/// The longest tool call id looked for in a line too long to read.
const CALL_KEEP: usize = 128;

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect()
}

/// Where Claude Code says a command that is not its own comes from, in
/// brackets at the end of its description.
const SOURCES: &[&str] = &["project", "user", "claude.ai sync"];

/// The slash commands and skills as the agent lists them, with where each
/// comes from taken out of its description: a plugin's name in brackets
/// before it, or one of [`SOURCES`] after it. One whose name begins with an
/// underscore is the agent's own business and left out.
fn listed_commands(value: &Value) -> Vec<CommandInfo> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|command| {
            let name = command["name"].as_str()?.trim();
            if name.is_empty() || name.starts_with('_') {
                return None;
            }
            let mut description = command["description"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            let mut source = None;
            if let Some((plugin, _)) = name.split_once(':') {
                if let Some(rest) = description.strip_prefix(&format!("({plugin})")) {
                    description = rest.trim_start().to_string();
                    source = Some(plugin.to_string());
                }
            }
            for known in SOURCES {
                if let Some(rest) = description.strip_suffix(&format!("({known})")) {
                    description = rest.trim_end().to_string();
                    source.get_or_insert_with(|| known.to_string());
                    break;
                }
            }
            Some(CommandInfo {
                name: name.to_string(),
                description: Some(description).filter(|d| !d.is_empty()),
                hint: text(&command["argumentHint"]).filter(|h| !h.trim().is_empty()),
                skill: false,
                builtin: command["builtin"] == true,
                source,
            })
        })
        .collect()
}

/// The tokens the model read: the agent counts those it read from its
/// cache and those it wrote to it apart from the rest.
fn read_tokens(value: &Value) -> u64 {
    [
        "input_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    ]
    .iter()
    .filter_map(|key| value[key].as_u64())
    .sum()
}

fn usage(value: &Value) -> Option<Usage> {
    value.is_object().then(|| Usage {
        input_tokens: read_tokens(value),
        cached_tokens: value["cache_read_input_tokens"].as_u64().unwrap_or(0),
        output_tokens: value["output_tokens"].as_u64().unwrap_or(0),
        reasoning_tokens: value["output_tokens_details"]["thinking_tokens"]
            .as_u64()
            .unwrap_or(0),
    })
}

/// What sort of tool the agent's tool of this name is.
fn tool_kind(name: &str) -> ToolKind {
    match name {
        "Bash" | "BashOutput" | "KillShell" | "KillBash" | "PowerShell" => ToolKind::Command,
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => ToolKind::Edit,
        "Read" | "NotebookRead" => ToolKind::Read,
        "Grep" | "Glob" | "LS" => ToolKind::Search,
        "WebFetch" | "WebSearch" => ToolKind::Web,
        "Agent" | "Task" => ToolKind::Agent,
        name if name.starts_with("mcp__") => ToolKind::Mcp,
        _ => ToolKind::Other,
    }
}

/// The files a tool changed, from the structured result the agent gives
/// beside the plain one: a new file with its content, or an edit with its
/// patch.
fn file_changes(result: &Value) -> Vec<FileChange> {
    let Some(path) = result["filePath"].as_str() else {
        return vec![];
    };
    let created = result["type"] == "create";
    let hunks = result["structuredPatch"].as_array();
    if !created && hunks.is_none() {
        return vec![];
    }
    let hunks = hunks
        .into_iter()
        .flatten()
        .filter_map(|hunk| {
            Some(Hunk {
                old_start: hunk["oldStart"].as_u64()?,
                old_lines: hunk["oldLines"].as_u64()?,
                new_start: hunk["newStart"].as_u64()?,
                new_lines: hunk["newLines"].as_u64()?,
                lines: strings(&hunk["lines"]),
            })
        })
        .collect();
    vec![FileChange {
        path: path.to_string(),
        kind: if created {
            ChangeKind::Create
        } else {
            ChangeKind::Update
        },
        to: None,
        hunks,
        content: created.then(|| text(&result["content"])).flatten(),
        truncated: false,
    }]
}

/// The steps of the agent's list, from the list tool's input.
fn steps(input: &Value) -> Vec<PlanStep> {
    input["todos"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|todo| {
            Some(PlanStep {
                text: todo["content"].as_str()?.to_string(),
                status: match todo["status"].as_str() {
                    Some("in_progress") => StepStatus::Active,
                    Some("completed") => StepStatus::Done,
                    _ => StepStatus::Pending,
                },
            })
        })
        .collect()
}

/// The questions the question tool asks, from its input.
fn questions(input: &Value) -> Vec<Question> {
    input["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|question| {
            Some(Question {
                header: text(&question["header"]),
                question: question["question"].as_str()?.to_string(),
                options: question["options"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|option| {
                        Some(QuestionOption {
                            label: option["label"].as_str()?.to_string(),
                            description: text(&option["description"]),
                        })
                    })
                    .collect(),
                multiple: question["multiSelect"].as_bool().unwrap_or(false),
                // The agent's question tool always takes words of the user's
                // own, and asks for nothing secret.
                secret: false,
                other: true,
            })
        })
        .collect()
}

/// The window one of the agent's names for a window stands for. The
/// windows of one model are not among them: their names say nothing of the
/// model the server shows.
fn window_kind(name: &str) -> Option<LimitKind> {
    match name {
        "five_hour" => Some(LimitKind::Session),
        "seven_day" => Some(LimitKind::Weekly),
        _ => None,
    }
}

/// The plan and the windows of a reply to a read of the usage, from the
/// server's own rows of limits, kept as an event may carry them. A row of a
/// kind not known here, or of one model with no model named, is left out.
/// None for a reply with no rows.
fn usage_limits(body: &Value) -> Option<(Option<String>, Vec<LimitWindow>)> {
    let rows = body["rate_limits"]["limits"].as_array()?;
    let windows = rows.iter().filter_map(|row| {
        let (kind, model) = match row["kind"].as_str()? {
            "session" => (LimitKind::Session, None),
            "weekly_all" => (LimitKind::Weekly, None),
            "weekly_scoped" => (
                LimitKind::WeeklyScoped,
                Some(text(&row["scope"]["model"]["display_name"])?),
            ),
            _ => return None,
        };
        Some(LimitWindow {
            kind,
            model,
            percent: percent(row["percent"].as_f64()?)?,
            resets_at: moment(&row["resets_at"]),
            severity: match row["severity"].as_str() {
                Some("normal") => Some(LimitSeverity::Normal),
                // The server reads a window as critical close to its end
                // as well as past it; only the percent says which.
                Some("warning" | "critical") => Some(LimitSeverity::Warning),
                _ => None,
            },
        })
    });
    Some((text(&body["subscription_type"]), kept_windows(windows)))
}

/// Seconds since the epoch of a time the agent gave: a number of them, or
/// an ISO 8601 time with its offset, such as `2030-01-02T03:04:05.5+00:00`.
/// Text that is not ASCII, or a year past 9999, is no time.
fn moment(value: &Value) -> Option<u64> {
    if let Some(seconds) = value.as_u64() {
        return Some(seconds);
    }
    let text = value.as_str().filter(|text| text.is_ascii())?;
    let (date, time) = text.split_once(['T', 't', ' '])?;
    let mut date = date.split('-');
    let year: i64 = date.next()?.parse().ok()?;
    let month: i64 = date.next()?.parse().ok()?;
    let day: i64 = date.next()?.parse().ok()?;
    if date.next().is_some()
        || !(0..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
    {
        return None;
    }
    let (clock, offset) = match time.strip_suffix(['Z', 'z']) {
        Some(clock) => (clock, 0),
        None => {
            let at = time.rfind(['+', '-'])?;
            let (clock, zone) = time.split_at(at);
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            let zone = &zone[1..];
            let (hours, minutes) = match zone.split_once(':') {
                Some(parts) => parts,
                None if zone.len() == 4 => zone.split_at(2),
                None => (zone, "0"),
            };
            let hours: i64 = hours.parse().ok()?;
            let minutes: i64 = minutes.parse().ok()?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            (clock, sign * (hours * 3600 + minutes * 60))
        }
    };
    let mut clock = clock.split(':');
    let hour: i64 = clock.next()?.parse().ok()?;
    let minute: i64 = clock.next()?.parse().ok()?;
    let second = clock.next().unwrap_or("0");
    let second: i64 = second.split('.').next()?.parse().ok()?;
    if clock.next().is_some() || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    // Days from 1970-01-01 to the date, by the proleptic Gregorian
    // calendar, counting years from March so the leap day falls last.
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let of_era = year.rem_euclid(400);
    let of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let of_cycle = of_era * 365 + of_era / 4 - of_era / 100 + of_year;
    let days = era * 146_097 + of_cycle - 719_468;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset;
    u64::try_from(seconds).ok()
}

/// Whether the account the agent reported at the start has no way to sign
/// in: no token, no key, and the agent's own API to reach.
fn signed_out(account: &Value) -> bool {
    account["tokenSource"] == "none"
        && account.get("apiKeySource").is_none()
        && account["apiProvider"] == "firstParty"
}

const NOT_LOGGED_IN: &str =
    "This account is not signed in to Claude Code. Run claude in a terminal and sign in with /login.";

impl Stream {
    fn new(session: &str, model: Option<&str>, mode: Option<&str>, effort: Option<&str>) -> Self {
        Self {
            session: session.to_string(),
            model: model.map(str::to_string),
            mode: mode.map(str::to_string),
            effort: effort.map(str::to_string),
            models: Vec::new(),
            introduced: None,
            listed: Vec::new(),
            skills: None,
            terminal_only: Vec::new(),
            commands_told: Vec::new(),
            settings_known: false,
            ready: false,
            next: 0,
            sent: HashMap::new(),
            asked: HashMap::new(),
            questions: HashMap::new(),
            streaming: HashMap::new(),
            open: HashMap::new(),
            closed: HashMap::new(),
            calls: HashMap::new(),
            tasks: HashMap::new(),
            lost: HashSet::new(),
            turn: false,
            starting: Vec::new(),
            ours: HashSet::new(),
            taken: HashSet::new(),
            interrupting: false,
            minted: 0,
            skipped_tail: Vec::new(),
            skipped_calls: Vec::new(),
            context: (None, None),
            context_told: (None, None),
            signed_out: false,
            plan: None,
            windows: Vec::new(),
            usage_asked: None,
            read_at: None,
        }
    }

    fn request(&mut self, sent: Sent, request: Value) -> (String, String) {
        self.next += 1;
        let id = format!("wb-{}", self.next);
        self.sent.insert(id.clone(), sent);
        let line = json!({ "type": "control_request", "request_id": id, "request": request });
        (line.to_string(), id)
    }

    /// The efforts the model now on takes.
    fn efforts(&self) -> Vec<String> {
        let Some(model) = &self.model else {
            return vec![];
        };
        self.models
            .iter()
            .find(|(info, resolved)| &info.value == model || resolved.as_ref() == Some(model))
            .map(|(info, _)| info.efforts.clone())
            .unwrap_or_default()
    }

    /// Takes a model, a mode or an effort as the agent now reports it, and
    /// says so when any changed.
    fn configure(
        &mut self,
        model: Option<String>,
        mode: Option<String>,
        effort: Option<String>,
        out: &mut Reading,
    ) {
        let mut changed = false;
        for (now, new) in [
            (&mut self.model, model),
            (&mut self.mode, mode),
            (&mut self.effort, effort),
        ] {
            if new.is_some() && new != *now {
                *now = new;
                changed = true;
            }
        }
        if changed && self.ready {
            out.events.push(Event::Configured {
                model: self.model.clone(),
                mode: self.mode.clone(),
                effort: self.effort.clone(),
                efforts: self.efforts(),
            });
        }
    }

    /// The commands and skills as now known: which are skills by the last
    /// turn's word, or until one has said, those that are not the agent's
    /// own; without those that work only in its own terminal.
    fn commands(&self) -> Vec<CommandInfo> {
        self.listed
            .iter()
            .filter(|command| !self.terminal_only.contains(&command.name))
            .map(|command| CommandInfo {
                skill: match &self.skills {
                    // A skill of the user's synced from elsewhere is listed
                    // under a plugin's prefix there, and without it here.
                    Some(skills) => skills.iter().any(|skill| {
                        *skill == command.name
                            || (!command.builtin
                                && skill
                                    .rsplit_once(':')
                                    .is_some_and(|(_, name)| name == command.name))
                    }),
                    None => !command.builtin,
                },
                ..command.clone()
            })
            .collect()
    }

    /// Tells the commands, once the agent is ready, when they changed.
    fn tell_commands(&mut self, out: &mut Reading) {
        if !self.ready {
            return;
        }
        let commands = self.commands();
        if commands != self.commands_told {
            self.commands_told = commands.clone();
            out.events.push(Event::Commands { commands });
        }
    }

    /// Says the agent is ready, once it has said both what it is and what
    /// it runs on.
    fn introduce(&mut self, out: &mut Reading) {
        if self.ready || !self.settings_known {
            return;
        }
        let Some(body) = self.introduced.take() else {
            return;
        };
        self.models = body["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|model| {
                Some((
                    ModelInfo {
                        value: model["value"].as_str()?.to_string(),
                        name: text(&model["displayName"]),
                        description: text(&model["description"]),
                        efforts: strings(&model["supportedEffortLevels"]),
                    },
                    text(&model["resolvedModel"]),
                ))
            })
            .collect();
        if let Some(mode) = text(&body["current_permission_mode"]) {
            self.mode = Some(mode);
        }
        self.ready = true;
        out.events.push(Event::Ready {
            session_id: self.session.clone(),
            model: self.model.clone(),
            mode: self.mode.clone(),
            effort: self.effort.clone(),
            version: text(&body["claude_code_version"]),
            models: self.models.iter().map(|(info, _)| info.clone()).collect(),
            modes: MODES
                .iter()
                .map(|(value, name)| ModeInfo {
                    value: value.to_string(),
                    name: name.to_string(),
                    description: None,
                })
                .collect(),
            efforts: self.efforts(),
            commands: {
                self.listed = listed_commands(&body["commands"]);
                self.commands_told = self.commands();
                self.commands_told.clone()
            },
        });
        if signed_out(&body["account"]) {
            self.signed_out = true;
            out.events.push(Event::Error {
                kind: ErrorKind::NotLoggedIn,
                message: NOT_LOGGED_IN.to_string(),
            });
        }
        self.ask_usage(out);
    }

    /// Asks the agent for the account's limits, once it is ready and then
    /// after a turn once the last read is old enough. The agent answers its
    /// control requests one at a time, and a read can take it seconds, with
    /// whatever the window sends next waiting behind it, so none is asked
    /// while a message waits for the agent to take it.
    fn ask_usage(&mut self, out: &mut Reading) {
        if self.signed_out || !limits_due(self.usage_asked) {
            return;
        }
        if self
            .ours
            .iter()
            .any(|message| !self.taken.contains(message))
        {
            return;
        }
        self.usage_asked = Some(Instant::now());
        // The behaviours a full read adds come from a scan of the past
        // week's transcripts, which the limits do not need.
        let (line, _) = self.request(
            Sent::Usage,
            json!({ "subtype": "get_usage", "skip_behaviors": true }),
        );
        out.writes.push(line);
    }

    /// The limits as they now stand, the last figure of them taken at
    /// `taken_at`.
    fn limits(&self, taken_at: u64) -> Event {
        Event::Limits {
            agent: AGENT.to_string(),
            plan: self.plan.clone(),
            windows: self.windows.clone(),
            read_at: self.read_at,
            taken_at,
        }
    }

    /// What the agent says of the limits as each response of the model
    /// comes: the window that limits it now, and every window at once where
    /// it gives them all, each as a fraction used. Told when it changes what
    /// was told before. A window of one model is left out, since only a
    /// read names the model as the server does.
    fn rate_limited(&mut self, info: &Value, out: &mut Reading) {
        let mut changed = false;
        if let Some(kind) = info["rateLimitType"].as_str().and_then(window_kind) {
            changed |= self.window(
                kind,
                &info["utilization"],
                &info["resetsAt"],
                &info["status"],
            );
        }
        for (name, window) in info["unifiedWindows"].as_object().into_iter().flatten() {
            if let Some(kind) = window_kind(name) {
                changed |= self.window(
                    kind,
                    &window["utilization"],
                    &window["resetsAt"],
                    &window["status"],
                );
            }
        }
        if changed {
            out.events.push(self.limits(now_seconds()));
        }
    }

    /// Takes one window as a response reported it, and says whether that
    /// changed it. What the response leaves out stays as it was.
    fn window(
        &mut self,
        kind: LimitKind,
        utilization: &Value,
        resets_at: &Value,
        status: &Value,
    ) -> bool {
        let Some(used) = utilization.as_f64().and_then(|used| percent(used * 100.0)) else {
            return false;
        };
        let at = self
            .windows
            .iter()
            .position(|window| window.kind == kind && window.model.is_none());
        let mut window = match at {
            Some(at) => self.windows[at].clone(),
            None => LimitWindow {
                kind,
                model: None,
                percent: used,
                resets_at: None,
                severity: None,
            },
        };
        window.percent = used;
        if let Some(resets_at) = resets_at.as_u64() {
            window.resets_at = Some(resets_at);
        }
        if let Some(severity) = match status.as_str() {
            Some("allowed") => Some(LimitSeverity::Normal),
            Some("allowed_warning") => Some(LimitSeverity::Warning),
            Some("rejected") => Some(LimitSeverity::Reached),
            _ => None,
        } {
            window.severity = Some(severity);
        }
        match at {
            Some(at) if self.windows[at] == window => false,
            Some(at) => {
                self.windows[at] = window;
                true
            }
            None => {
                self.windows.push(window);
                self.windows.sort_by_key(|window| window.kind);
                true
            }
        }
    }

    /// The agent began a turn of the main conversation, if one is not
    /// running yet: the messages it took since the last one are what it
    /// answers.
    fn begin(&mut self, out: &mut Reading) {
        if self.turn {
            return;
        }
        self.turn = true;
        self.interrupting = false;
        out.events.push(Event::TurnStarted {
            messages: std::mem::take(&mut self.starting),
        });
    }

    /// The agent says it took a message of ours: into the turn running, or
    /// for the turn about to start.
    fn took(&mut self, message: &str, out: &mut Reading) {
        if !self.ours.contains(message) || !self.taken.insert(message.to_string()) {
            return;
        }
        if self.turn {
            out.events
                .push(Event::message(message, MessageState::Taken, None));
        } else {
            self.starting.push(message.to_string());
        }
    }

    /// The agent is done with a message of ours.
    fn done_with(&mut self, message: &str, out: &mut Reading, dropped: bool) {
        if !self.ours.remove(message) {
            return;
        }
        if !self.taken.remove(message) && dropped {
            self.starting.retain(|m| m != message);
            out.events.push(Event::message(
                message,
                MessageState::Dropped,
                Some("the agent cancelled the message".into()),
            ));
        }
    }

    /// The id of a whole block that arrived after streaming: the first
    /// streamed block of its kind in the same message not yet matched, or
    /// a fresh one for a block that was never streamed.
    fn block_id(&mut self, message: &str, kind: Kind) -> (String, bool) {
        if let Some(closed) = self.closed.get_mut(message) {
            if let Some(at) = closed.iter().position(|(k, _)| *k == kind) {
                let (_, id) = closed.remove(at).expect("position is in range");
                if closed.is_empty() {
                    self.closed.remove(message);
                }
                return (id, true);
            }
        }
        let open = self
            .open
            .iter()
            .filter(|((m, _), (k, _))| m == message && *k == kind)
            .map(|((_, index), _)| *index)
            .min();
        if let Some(index) = open {
            let (_, id) = self
                .open
                .remove(&(message.to_string(), index))
                .expect("found above");
            return (id, true);
        }
        self.minted += 1;
        (format!("{message}#whole-{}", self.minted), false)
    }

    fn tool_started(&mut self, call: &str, name: &str, parent: &Option<String>, out: &mut Reading) {
        self.calls.insert(call.to_string(), parent.clone());
        out.events.push(Event::ToolStarted {
            call: call.to_string(),
            parent: parent.clone(),
            name: name.to_string(),
            kind: tool_kind(name),
        });
    }

    fn stream_event(&mut self, event: &Value, parent: Option<String>, out: &mut Reading) {
        if parent.is_none() {
            self.begin(out);
        }
        match event["type"].as_str() {
            Some("message_start") => {
                if let Some(id) = event["message"]["id"].as_str() {
                    self.streaming.insert(parent, id.to_string());
                }
            }
            Some("content_block_start") => {
                let Some(index) = event["index"].as_u64() else {
                    return;
                };
                let message = self.streaming.get(&parent).cloned().unwrap_or_default();
                let block = &event["content_block"];
                let (kind, id) = match block["type"].as_str() {
                    Some("text") => (Kind::Text, format!("{message}#{index}")),
                    Some("thinking") => (Kind::Thinking, format!("{message}#{index}")),
                    Some("tool_use") => {
                        let Some(call) = block["id"].as_str() else {
                            return;
                        };
                        let name = block["name"].as_str().unwrap_or_default();
                        self.tool_started(call, name, &parent, out);
                        (Kind::Tool, call.to_string())
                    }
                    _ => return,
                };
                self.open.insert((message, index), (kind, id));
            }
            Some("content_block_delta") => {
                let Some(index) = event["index"].as_u64() else {
                    return;
                };
                let message = self.streaming.get(&parent).cloned().unwrap_or_default();
                let Some((_, id)) = self.open.get(&(message, index)) else {
                    return;
                };
                let id = id.clone();
                let delta = &event["delta"];
                match delta["type"].as_str() {
                    Some("text_delta") => {
                        if let Some(text) = delta["text"].as_str().filter(|t| !t.is_empty()) {
                            out.events.push(Event::Text {
                                block: id,
                                parent,
                                text: text.to_string(),
                                done: false,
                            });
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = delta["thinking"].as_str().filter(|t| !t.is_empty()) {
                            out.events.push(Event::Thinking {
                                block: id,
                                parent,
                                text: text.to_string(),
                                done: false,
                            });
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(json) = delta["partial_json"].as_str().filter(|t| !t.is_empty())
                        {
                            out.events.push(Event::ToolInput {
                                call: id,
                                parent,
                                delta: Some(json.to_string()),
                                input: None,
                                truncated: false,
                            });
                        }
                    }
                    _ => {}
                }
            }
            Some("content_block_stop") => {
                let Some(index) = event["index"].as_u64() else {
                    return;
                };
                let message = self.streaming.get(&parent).cloned().unwrap_or_default();
                if let Some((kind, id)) = self.open.remove(&(message.clone(), index)) {
                    if kind != Kind::Tool {
                        self.closed
                            .entry(message)
                            .or_default()
                            .push_back((kind, id));
                    }
                }
            }
            _ => {}
        }
    }

    fn assistant(&mut self, line: &Value, parent: Option<String>, out: &mut Reading) {
        if parent.is_none() {
            self.begin(out);
        }
        let message = &line["message"];
        let id = message["id"].as_str().unwrap_or_default().to_string();
        if parent.is_none() && message["usage"].is_object() {
            let usage = &message["usage"];
            self.context.0 =
                Some(read_tokens(usage) + usage["output_tokens"].as_u64().unwrap_or(0));
        }
        if let Some(error) = line["error"].as_str() {
            let said = text_of(&message["content"]);
            let (kind, message) = if error == "authentication_failed" {
                (ErrorKind::NotLoggedIn, NOT_LOGGED_IN.to_string())
            } else if said.is_empty() {
                (ErrorKind::Agent, error.to_string())
            } else {
                (ErrorKind::Agent, said)
            };
            out.events.push(Event::Error { kind, message });
        }
        for block in message["content"].as_array().into_iter().flatten() {
            match block["type"].as_str() {
                Some("text") => {
                    let (block_id, _) = self.block_id(&id, Kind::Text);
                    out.events.push(Event::Text {
                        block: block_id,
                        parent: parent.clone(),
                        text: block["text"].as_str().unwrap_or_default().to_string(),
                        done: true,
                    });
                }
                Some("thinking") => {
                    let thinking = block["thinking"].as_str().unwrap_or_default();
                    let (block_id, streamed) = self.block_id(&id, Kind::Thinking);
                    if streamed || !thinking.is_empty() {
                        out.events.push(Event::Thinking {
                            block: block_id,
                            parent: parent.clone(),
                            text: thinking.to_string(),
                            done: true,
                        });
                    }
                }
                Some("tool_use") => {
                    let Some(call) = block["id"].as_str() else {
                        continue;
                    };
                    let name = block["name"].as_str().unwrap_or_default();
                    if !self.calls.contains_key(call) {
                        self.tool_started(call, name, &parent, out);
                    }
                    out.events.push(Event::ToolInput {
                        call: call.to_string(),
                        parent: parent.clone(),
                        delta: None,
                        input: Some(block["input"].clone()),
                        truncated: false,
                    });
                    if name == TODO_TOOL {
                        out.events.push(Event::Plan {
                            call: Some(call.to_string()),
                            parent: parent.clone(),
                            text: None,
                            steps: steps(&block["input"]),
                        });
                    }
                }
                _ => {}
            }
        }
    }

    fn user(&mut self, line: &Value, parent: Option<String>, out: &mut Reading) {
        // The user's own message, sent back with the id it went with.
        if line["isReplay"] == true && parent.is_none() {
            if let Some(uuid) = line["uuid"].as_str() {
                self.took(uuid, out);
            }
        }
        let results: Vec<&Value> = line["message"]["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|block| block["type"] == "tool_result")
            .collect();
        // The structured result is the line's, so it belongs to its only
        // tool result.
        let single = results.len() == 1;
        for block in results {
            let Some(call) = block["tool_use_id"].as_str() else {
                continue;
            };
            self.calls.remove(call);
            out.events.push(Event::ToolFinished {
                call: call.to_string(),
                parent: parent.clone(),
                output: text_of(&block["content"]),
                error: block["is_error"].as_bool().unwrap_or(false),
                truncated: false,
                changes: if single {
                    file_changes(&line["tool_use_result"])
                } else {
                    vec![]
                },
            });
        }
    }

    fn system(&mut self, line: &Value, out: &mut Reading) {
        match line["subtype"].as_str() {
            // Every turn opens with the agent describing itself.
            Some("init") => {
                self.begin(out);
                self.configure(
                    text(&line["model"]),
                    text(&line["permissionMode"]),
                    None,
                    out,
                );
                // Only a turn's start says which commands are skills.
                if line["skills"].is_array() {
                    self.skills = Some(strings(&line["skills"]));
                }
                self.terminal_only = strings(&line["terminal_slash_commands"]);
                self.tell_commands(out);
            }
            Some("commands_changed") => {
                self.listed = listed_commands(&line["commands"]);
                self.tell_commands(out);
            }
            Some("status") => {
                if line["status"] == "compacting" {
                    self.begin(out);
                    out.events.push(Event::Compacting);
                }
                for message in strings(&line["user_message_uuids"]) {
                    self.took(&message, out);
                }
                self.configure(None, text(&line["permissionMode"]), None, out);
            }
            Some("compact_boundary") => {
                let meta = &line["compact_metadata"];
                out.events.push(Event::Compacted {
                    reason: match meta["trigger"].as_str() {
                        Some("manual") => Some(CompactReason::Asked),
                        Some("auto") => Some(CompactReason::Full),
                        _ => None,
                    },
                    tokens_before: meta["pre_tokens"].as_u64(),
                    tokens_after: meta["post_tokens"].as_u64(),
                });
                if let Some(after) = meta["post_tokens"].as_u64() {
                    self.context.0 = Some(after);
                    self.tell_context(out);
                }
            }
            Some("api_retry") => {
                let error = &line["error"];
                let message = text(&error["message"])
                    .or_else(|| text(error))
                    .or_else(|| {
                        line["error_status"]
                            .as_u64()
                            .map(|status| format!("the API answered {status}"))
                    })
                    .unwrap_or_else(|| "the API request failed".into());
                out.events.push(Event::Retrying {
                    message,
                    attempt: line["attempt"].as_u64(),
                    attempts: line["max_retries"].as_u64(),
                });
            }
            Some("task_started") => {
                let Some(task) = line["task_id"].as_str() else {
                    return;
                };
                let call = text(&line["tool_use_id"]);
                let background = line["is_backgrounded"].as_bool().unwrap_or(true);
                let kind = match line["task_type"].as_str() {
                    Some("local_agent" | "remote_agent") => TaskKind::Agent,
                    Some("local_bash") => TaskKind::Shell,
                    _ => TaskKind::Other,
                };
                let nested = line["parent_task_id"].is_string()
                    || call
                        .as_ref()
                        .and_then(|call| self.calls.get(call))
                        .is_some_and(Option::is_some);
                self.lost.remove(task);
                self.tasks.insert(
                    task.to_string(),
                    Task {
                        call: call.clone(),
                        kind,
                        background,
                        awaited: line["awaited"] == true,
                        nested,
                        unlisted: false,
                    },
                );
                out.events.push(Event::TaskStarted {
                    task: task.to_string(),
                    call,
                    kind,
                    description: text(&line["description"]),
                    prompt: text(&line["prompt"]),
                    background,
                    ambient: line["ambient"] == true || line["skip_transcript"] == true,
                });
            }
            Some("task_progress") => {
                let Some(task) = line["task_id"].as_str() else {
                    return;
                };
                out.events.push(Event::TaskProgress {
                    task: task.to_string(),
                    call: text(&line["tool_use_id"])
                        .or_else(|| self.tasks.get(task).and_then(|known| known.call.clone())),
                    tool: text(&line["last_tool_name"]),
                    description: text(&line["description"]),
                });
            }
            // What runs in the background, whole. It comes in no promised
            // order with the start and the end of each task, so a task it
            // leaves out is only marked: it is lost if that still holds,
            // with no word of how it ended, once the turn is over.
            Some("background_tasks_changed") => {
                let Some(listed) = line["tasks"].as_array() else {
                    return;
                };
                let listed: HashSet<&str> = listed
                    .iter()
                    .filter_map(|task| task["task_id"].as_str())
                    .collect();
                for (id, task) in &mut self.tasks {
                    task.unlisted = task.background && !listed.contains(id.as_str());
                }
            }
            Some("task_updated") => {
                let (Some(task), Some(background)) = (
                    line["task_id"].as_str(),
                    line["patch"]["is_backgrounded"].as_bool(),
                ) else {
                    return;
                };
                if let Some(task) = self.tasks.get_mut(task) {
                    task.background = background;
                }
            }
            Some("task_notification") => {
                let Some(task) = line["task_id"].as_str() else {
                    return;
                };
                if self.lost.remove(task) {
                    return;
                }
                let known = self.tasks.remove(task);
                out.events.push(Event::TaskFinished {
                    task: task.to_string(),
                    call: text(&line["tool_use_id"])
                        .or_else(|| known.as_ref().and_then(|known| known.call.clone())),
                    status: match line["status"].as_str() {
                        Some("completed") | None => TaskStatus::Completed,
                        Some("stopped" | "killed") => TaskStatus::Stopped,
                        Some(_) => TaskStatus::Failed,
                    },
                    summary: text(&line["summary"]),
                    reports: known.as_ref().is_some_and(Task::reports),
                });
            }
            Some("notification") => {
                let level = match line["priority"].as_str() {
                    Some("high" | "immediate") => NoticeLevel::Warning,
                    _ => NoticeLevel::Info,
                };
                self.notice(level, text(&line["text"]), out);
            }
            Some("informational") => {
                let level = match line["level"].as_str() {
                    Some("warning") => NoticeLevel::Warning,
                    Some("notice" | "suggestion") => NoticeLevel::Info,
                    // Shown only in the terminal's transcript view.
                    _ => return,
                };
                self.notice(level, text(&line["content"]), out);
            }
            Some("model_fallback") => {
                let said = text(&line["content"]).filter(|said| !said.is_empty());
                let message = said.or_else(|| {
                    Some(format!(
                        "{} is unavailable, so this turn uses {}",
                        line["original_model"].as_str()?,
                        line["fallback_model"].as_str()?
                    ))
                });
                self.notice(NoticeLevel::Warning, message, out);
            }
            // The agent's own word that its work is over, its subagents'
            // reports included: no task it has not finished, other than
            // what it still lists in the background, is running.
            Some("session_state_changed") if line["state"] == "idle" => {
                self.lose(out, |task| !task.background || task.unlisted);
            }
            _ => {}
        }
    }

    /// Where the agent stands with a message: queued, started or done.
    /// A message it cancelled, discarded or refused before taking it is
    /// dropped.
    fn lifecycle(&mut self, line: &Value, out: &mut Reading) {
        let Some(message) = line["command_uuid"].as_str() else {
            return;
        };
        match line["state"].as_str() {
            Some("started") => self.took(message, out),
            Some("completed") => self.done_with(message, out, false),
            Some("cancelled" | "discarded" | "refused") => self.done_with(message, out, true),
            _ => {}
        }
    }

    fn result(&mut self, line: &Value, out: &mut Reading) {
        self.begin(out);
        // A task of the main conversation that its call waited on is over
        // with the turn, and so is one gone from the background that has no
        // report to come. One that reports may still be told of after the
        // result, so it is left for the agent's word that it is idle.
        self.lose(out, |task| {
            (!task.background && !task.nested) || (task.unlisted && !task.reports())
        });
        let failed = line["is_error"].as_bool().unwrap_or(false);
        // The agent names an abort as the reason its loop ended; an older
        // one says only that the turn failed during execution.
        let aborted = matches!(
            line["terminal_reason"].as_str(),
            Some("aborted_streaming" | "aborted_tools")
        );
        let outcome = match line["subtype"].as_str() {
            Some("success") if !failed => Outcome::Done,
            Some("error_during_execution") if self.interrupting || aborted => Outcome::Interrupted,
            _ => Outcome::Failed,
        };
        self.interrupting = false;
        self.turn = false;
        self.forget_turn();
        if let Some(models) = line["modelUsage"].as_object() {
            let window = |entry: &Value| entry["contextWindow"].as_u64();
            let size = self
                .model
                .as_ref()
                .and_then(|model| models.get(model))
                .and_then(window)
                .or_else(|| models.values().filter_map(window).max());
            if size.is_some() {
                self.context.1 = size;
            }
        }
        self.tell_context(out);
        let error = (outcome == Outcome::Failed).then(|| {
            let said = line["result"].as_str().unwrap_or_default();
            let errors = strings(&line["errors"]);
            if !said.is_empty() {
                said.to_string()
            } else if !errors.is_empty() {
                errors.join("\n")
            } else {
                line["subtype"]
                    .as_str()
                    .unwrap_or("the turn failed")
                    .to_string()
            }
        });
        out.events.push(Event::TurnEnded {
            outcome,
            error,
            total_cost_usd: line["total_cost_usd"].as_f64(),
            duration_ms: line["duration_ms"].as_u64(),
            usage: usage(&line["usage"]),
        });
        self.ask_usage(out);
    }

    fn notice(&mut self, level: NoticeLevel, message: Option<String>, out: &mut Reading) {
        if let Some(message) = message.filter(|message| !message.trim().is_empty()) {
            out.events.push(Event::Notice { level, message });
        }
    }

    /// Tells what the conversation takes of the context window, when that
    /// changed.
    fn tell_context(&mut self, out: &mut Reading) {
        if self.context != self.context_told && self.context != (None, None) {
            self.context_told = self.context;
            out.events.push(Event::Context {
                used: self.context.0,
                size: self.context.1,
            });
        }
    }

    /// Finishes as lost the tasks `which` picks: their end was never told.
    fn lose(&mut self, out: &mut Reading, which: impl Fn(&Task) -> bool) {
        let mut gone: Vec<String> = self
            .tasks
            .iter()
            .filter(|(_, task)| which(task))
            .map(|(id, _)| id.clone())
            .collect();
        gone.sort();
        for id in gone {
            let task = self.tasks.remove(&id).expect("picked above");
            self.lost.insert(id.clone());
            out.events.push(Event::TaskFinished {
                task: id,
                call: task.call,
                status: TaskStatus::Lost,
                summary: None,
                reports: false,
            });
        }
    }

    /// Lets go of what was kept of the turn that ended: its streams and its
    /// calls. What belongs to a subagent still at work is kept.
    fn forget_turn(&mut self) {
        let working: HashSet<String> = self
            .tasks
            .values()
            .filter_map(|task| task.call.clone())
            .collect();
        let kept = |parent: &Option<String>| parent.as_ref().is_some_and(|p| working.contains(p));
        self.streaming.retain(|parent, _| kept(parent));
        self.calls.retain(|_, parent| kept(parent));
        let messages: HashSet<String> = self.streaming.values().cloned().collect();
        self.open
            .retain(|(message, _), _| messages.contains(message));
        self.closed.retain(|message, _| messages.contains(message));
    }

    /// A control request from the agent: a permission or a question to
    /// ask, or something this side does not do, which is answered as such.
    fn asked(&mut self, line: &Value, out: &mut Reading) {
        let Some(id) = line["request_id"].as_str() else {
            return;
        };
        let request = &line["request"];
        if request["subtype"] != "can_use_tool" {
            out.writes.push(
                json!({
                    "type": "control_response",
                    "response": {
                        "subtype": "error",
                        "request_id": id,
                        "error": "not handled by Agent Workbench",
                    },
                })
                .to_string(),
            );
            return;
        }
        let tool = request["tool_name"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let input = request["input"].clone();
        let call = text(&request["tool_use_id"]);
        let parent = call
            .as_deref()
            .and_then(|call| self.calls.get(call).cloned().flatten());
        if tool == ASK_TOOL {
            out.events.push(Event::QuestionAsked {
                request: id.to_string(),
                call,
                parent,
                questions: questions(&input),
            });
            self.questions.insert(id.to_string(), input);
            return;
        }
        if tool == PLAN_TOOL {
            out.events.push(Event::Plan {
                call: call.clone(),
                parent: parent.clone(),
                text: text(&input["plan"]),
                steps: vec![],
            });
        }
        let asked = Asked {
            input,
            suggestions: request["permission_suggestions"]
                .as_array()
                .cloned()
                .unwrap_or_default(),
        };
        out.events.push(Event::PermissionAsked {
            request: id.to_string(),
            call,
            parent,
            tool,
            input: asked.input.clone(),
            truncated: false,
            description: text(&request["description"])
                .or_else(|| text(&request["input"]["description"])),
            path: text(&request["blocked_path"]),
            choices: asked.offers(),
        });
        self.asked.insert(id.to_string(), asked);
    }

    fn answered(&mut self, line: &Value, out: &mut Reading) {
        let response = &line["response"];
        let Some(id) = response["request_id"].as_str() else {
            return;
        };
        let Some(sent) = self.sent.remove(id) else {
            // An answer of this side's own, sent back with the user's
            // messages.
            return;
        };
        if sent == Sent::Usage {
            // Nothing waits on it, and a read that fails or answers in a
            // shape not known here leaves the limits as they were.
            if response["subtype"] == "success" {
                if let Some((plan, windows)) = usage_limits(&response["response"]) {
                    self.plan = plan;
                    self.windows = windows;
                    let now = now_seconds();
                    self.read_at = Some(now);
                    out.events.push(self.limits(now));
                }
            }
            return;
        }
        let reply = if response["subtype"] == "success" {
            Ok(response["response"].clone())
        } else {
            Err(response["error"]
                .as_str()
                .unwrap_or("the agent refused")
                .to_string())
        };
        let body = reply.as_ref().ok();
        match sent {
            Sent::Initialize => {
                self.introduced = Some(body.cloned().unwrap_or(Value::Null));
                self.introduce(out);
            }
            Sent::Settings => {
                if let Some(applied) = body.map(|b| &b["applied"]) {
                    if let Some(model) = text(&applied["model"]) {
                        self.model = Some(model);
                    }
                    if let Some(effort) = text(&applied["effort"]) {
                        self.effort = Some(effort);
                    }
                }
                self.settings_known = true;
                self.introduce(out);
            }
            Sent::Model => {
                if let Some(model) = body.and_then(|b| text(&b["model"])) {
                    self.configure(Some(model), None, None, out);
                }
            }
            Sent::Mode => {
                if let Some(mode) = body.and_then(|b| text(&b["mode"])) {
                    self.configure(None, Some(mode), None, out);
                }
            }
            Sent::Effort(effort) => {
                if reply.is_ok() {
                    self.configure(None, None, Some(effort), out);
                }
            }
            Sent::Interrupt => {
                if reply.is_err() {
                    self.interrupting = false;
                }
            }
            Sent::Usage => {}
        }
        out.replies.push((id.to_string(), reply));
    }
}

impl Driver for Stream {
    fn opening(&mut self) -> Vec<String> {
        // Both optional for the agent, and what it answers with is what the
        // window needs before the first turn: what the agent is, and the
        // model and effort it runs on.
        let (initialize, _) = self.request(Sent::Initialize, json!({ "subtype": "initialize" }));
        let (settings, _) = self.request(Sent::Settings, json!({ "subtype": "get_settings" }));
        vec![initialize, settings]
    }

    fn read(&mut self, line: &str) -> Reading {
        let mut out = Reading::default();
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return out;
        };
        let parent = text(&value["parent_tool_use_id"]);
        match value["type"].as_str() {
            Some("stream_event") => self.stream_event(&value["event"], parent, &mut out),
            Some("assistant") => self.assistant(&value, parent, &mut out),
            Some("user") => self.user(&value, parent, &mut out),
            Some("system") => self.system(&value, &mut out),
            Some("result") => self.result(&value, &mut out),
            Some("command_lifecycle") => self.lifecycle(&value, &mut out),
            Some("control_request") => self.asked(&value, &mut out),
            Some("control_cancel_request") => {
                if let Some(id) = value["request_id"].as_str() {
                    if self.asked.remove(id).is_some() || self.questions.remove(id).is_some() {
                        out.events.push(Event::Withdrawn {
                            request: id.to_string(),
                        });
                    }
                }
            }
            Some("control_response") => self.answered(&value, &mut out),
            Some("rate_limit_event") => self.rate_limited(&value["rate_limit_info"], &mut out),
            _ => {}
        }
        out
    }

    fn takes_while_busy(&self) -> bool {
        true
    }

    fn message(&mut self, message: &str, text: &str, images: &[Image]) -> Result<String, String> {
        if text.trim().is_empty() && images.is_empty() {
            return Err("there is nothing to send".into());
        }
        let content = if images.is_empty() {
            json!(text)
        } else {
            let mut blocks = Vec::new();
            if !text.trim().is_empty() {
                blocks.push(json!({ "type": "text", "text": text }));
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
                blocks.push(json!({
                    "type": "image",
                    "source": { "type": "base64", "media_type": image.media_type, "data": image.data },
                }));
            }
            Value::Array(blocks)
        };
        self.ours.insert(message.to_string());
        Ok(json!({
            "type": "user",
            "message": { "role": "user", "content": content },
            "parent_tool_use_id": null,
            "uuid": message,
        })
        .to_string())
    }

    fn answer(
        &mut self,
        request: &str,
        choice: Choice,
        message: Option<&str>,
    ) -> Result<String, String> {
        let asked = self
            .asked
            .get(request)
            .ok_or("the agent is not waiting on that request")?;
        let said = message.map(str::trim).filter(|m| !m.is_empty());
        let response = match choice {
            Choice::Allow => json!({ "behavior": "allow", "updatedInput": asked.input }),
            Choice::AllowSession | Choice::AllowAlways => {
                let (suggestion, _) = asked
                    .remembered(choice)
                    .ok_or("that choice was not offered for this request")?;
                json!({
                    "behavior": "allow",
                    "updatedInput": asked.input,
                    "updatedPermissions": [suggestion],
                })
            }
            Choice::Deny => json!({
                "behavior": "deny",
                "message": said.unwrap_or("The user declined this."),
            }),
            Choice::Cancel => {
                // The turn this stops ends as interrupted, not as failed.
                self.interrupting = self.turn;
                json!({
                    "behavior": "deny",
                    "message": said.unwrap_or("The user declined this and stopped the turn."),
                    "interrupt": true,
                })
            }
        };
        self.asked.remove(request);
        Ok(json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": request, "response": response },
        })
        .to_string())
    }

    fn reply(&mut self, request: &str, answers: Option<&[Vec<String>]>) -> Result<String, String> {
        let input = self
            .questions
            .get(request)
            .ok_or("the agent is not waiting on that question")?;
        let response = match answers {
            None => json!({
                "behavior": "deny",
                "message": "The user declined to answer.",
            }),
            Some(answers) => {
                let asked = questions(input);
                if answers.len() != asked.len() {
                    return Err(format!(
                        "{} answers for {} questions",
                        answers.len(),
                        asked.len()
                    ));
                }
                let mut by_question = serde_json::Map::new();
                for (question, answer) in asked.iter().zip(answers) {
                    let answer: Vec<&str> = answer
                        .iter()
                        .map(|a| a.trim())
                        .filter(|a| !a.is_empty())
                        .collect();
                    if answer.is_empty() {
                        return Err(format!("no answer to {:?}", question.question));
                    }
                    by_question.insert(question.question.clone(), json!(answer.join(", ")));
                }
                let mut updated = input.clone();
                updated["answers"] = Value::Object(by_question);
                json!({ "behavior": "allow", "updatedInput": updated })
            }
        };
        self.questions.remove(request);
        Ok(json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": request, "response": response },
        })
        .to_string())
    }

    fn control(&mut self, control: &Control) -> Result<Sending, String> {
        let (line, key) = match control {
            // The agent compacts when told so in a message of its own, which
            // starts a turn that names no message of the window's.
            Control::Compact { instructions } => {
                let content = match instructions {
                    Some(words) => format!("/compact {words}"),
                    None => "/compact".to_string(),
                };
                let line = json!({
                    "type": "user",
                    "message": { "role": "user", "content": content },
                    "parent_tool_use_id": null,
                    "uuid": uuid::Uuid::new_v4().to_string(),
                });
                return Ok(Sending::Line {
                    line: line.to_string(),
                });
            }
            Control::Interrupt => {
                // An interrupt with no turn running ends nothing, so the
                // next failure is not taken for one.
                self.interrupting = self.turn;
                self.request(Sent::Interrupt, json!({ "subtype": "interrupt" }))
            }
            Control::SetModel(model) => {
                let model = checked("model", model)?.to_string();
                self.request(
                    Sent::Model,
                    json!({ "subtype": "set_model", "model": model }),
                )
            }
            Control::SetMode(mode) => {
                let mode = checked("permission mode", mode)?.to_string();
                self.request(
                    Sent::Mode,
                    json!({ "subtype": "set_permission_mode", "mode": mode }),
                )
            }
            Control::SetEffort(effort) => {
                let effort = checked("effort", effort)?.to_string();
                self.request(
                    Sent::Effort(effort.clone()),
                    json!({ "subtype": "apply_flag_settings", "settings": { "effortLevel": effort } }),
                )
            }
        };
        Ok(Sending::Request { line, key })
    }

    fn forget(&mut self, key: &str) {
        if self.sent.remove(key) == Some(Sent::Interrupt) {
            self.interrupting = false;
        }
    }

    fn skipping(&mut self, bytes: &[u8]) {
        let mut seen = std::mem::take(&mut self.skipped_tail);
        seen.extend_from_slice(bytes);
        let mut from = 0;
        while let Some(at) = seen[from..]
            .windows(RESULT_KEY.len())
            .position(|window| window == RESULT_KEY)
        {
            let start = from + at + RESULT_KEY.len();
            let Some(length) = seen[start..].iter().position(|&byte| byte == b'"') else {
                // The id runs past what has come: keep the key for the
                // next piece.
                from = start - RESULT_KEY.len();
                break;
            };
            if length <= CALL_KEEP {
                let call = String::from_utf8_lossy(&seen[start..start + length]).to_string();
                if !self.skipped_calls.contains(&call) {
                    self.skipped_calls.push(call);
                }
            }
            from = start + length;
        }
        // Enough of the end to hold a key and an id cut by the next piece.
        let keep = seen
            .len()
            .saturating_sub(RESULT_KEY.len() + CALL_KEEP)
            .max(from);
        self.skipped_tail = seen[keep.min(seen.len())..].to_vec();
    }

    /// A result too long to read finishes its call as cut short, with no
    /// output, so the call does not wait for the end of the turn.
    fn skipped(&mut self) -> Reading {
        let mut out = Reading::default();
        self.skipped_tail.clear();
        for call in std::mem::take(&mut self.skipped_calls) {
            if let Some(parent) = self.calls.remove(&call) {
                out.events.push(Event::ToolFinished {
                    call,
                    parent,
                    output: String::new(),
                    error: true,
                    truncated: true,
                    changes: vec![],
                });
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const M1: &str = "11111111-1111-4111-8111-111111111111";
    const M2: &str = "22222222-2222-4222-8222-222222222222";
    const M3: &str = "33333333-3333-4333-8333-333333333333";

    fn stream() -> Stream {
        Stream::new("s-1", Some("haiku"), None, None)
    }

    fn events(stream: &mut Stream, lines: &[Value]) -> Vec<Event> {
        lines
            .iter()
            .flat_map(|line| stream.read(&line.to_string()).events)
            .collect()
    }

    fn lifecycle(message: &str, state: &str) -> Value {
        json!({"type":"command_lifecycle","command_uuid":message,"state":state})
    }

    fn init() -> Value {
        json!({"type":"system","subtype":"init","model":"haiku","permissionMode":"default"})
    }

    fn result() -> Value {
        json!({"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.01})
    }

    fn started(out: &[Event]) -> Vec<Vec<String>> {
        out.iter()
            .filter_map(|event| match event {
                Event::TurnStarted { messages } => Some(messages.clone()),
                _ => None,
            })
            .collect()
    }

    fn sent(stream: &mut Stream, message: &str) {
        stream.message(message, "hi", &[]).unwrap();
    }

    #[test]
    fn a_line_that_is_not_json_or_not_known_means_nothing() {
        let mut stream = stream();
        for line in [
            "not json",
            "{",
            "[]",
            r#"{"type":"from_the_future","x":1}"#,
            "null",
        ] {
            let reading = stream.read(line);
            assert!(reading.events.is_empty(), "{line}");
            assert!(reading.writes.is_empty(), "{line}");
        }
    }

    #[test]
    fn a_turn_names_the_messages_the_agent_said_it_took() {
        let mut stream = stream();
        sent(&mut stream, M1);
        let out = events(
            &mut stream,
            &[
                lifecycle(M1, "queued"),
                lifecycle(M1, "started"),
                init(),
                json!({"type":"user","message":{"role":"user","content":"hi"},"parent_tool_use_id":null,"uuid":M1,"isReplay":true}),
                result(),
                lifecycle(M1, "completed"),
            ],
        );
        assert_eq!(started(&out), [vec![M1.to_string()]]);
        assert!(
            !out.iter().any(|e| matches!(e, Event::Message { .. })),
            "{out:?}"
        );
        assert!(stream.ours.is_empty() && stream.taken.is_empty());
    }

    #[test]
    fn messages_the_agent_took_together_start_one_turn() {
        // As the real agent does with two messages sent while a turn ran.
        let mut stream = stream();
        sent(&mut stream, M1);
        events(&mut stream, &[lifecycle(M1, "started"), init()]);
        sent(&mut stream, M2);
        sent(&mut stream, M3);
        let out = events(
            &mut stream,
            &[
                lifecycle(M2, "queued"),
                lifecycle(M3, "queued"),
                result(),
                lifecycle(M1, "completed"),
                lifecycle(M2, "started"),
                lifecycle(M3, "started"),
                init(),
                json!({"type":"system","subtype":"status","status":"requesting","user_message_uuids":[M2, M3]}),
                result(),
            ],
        );
        assert_eq!(started(&out), [vec![M2.to_string(), M3.to_string()]]);
    }

    #[test]
    fn a_message_taken_while_a_turn_runs_is_taken_into_it() {
        let mut stream = stream();
        events(&mut stream, &[init()]);
        sent(&mut stream, M1);
        let out = events(&mut stream, &[lifecycle(M1, "started")]);
        assert_eq!(out, [Event::message(M1, MessageState::Taken, None)]);
    }

    #[test]
    fn without_the_agent_s_own_lines_the_echo_names_the_message() {
        let mut stream = stream();
        sent(&mut stream, M1);
        let out = events(
            &mut stream,
            &[
                json!({"type":"user","message":{"role":"user","content":"hi"},"parent_tool_use_id":null,"uuid":M1,"isReplay":true}),
                init(),
            ],
        );
        assert_eq!(started(&out), [vec![M1.to_string()]]);
        // An echo of something that is not one of this side's messages,
        // such as the summary compaction writes, names nothing.
        let out = events(
            &mut stream,
            &[
                result(),
                json!({"type":"user","message":{"role":"user","content":"summary"},"parent_tool_use_id":null,"uuid":"99999999-9999-4999-8999-999999999999","isReplay":true}),
                init(),
            ],
        );
        assert_eq!(started(&out), [Vec::<String>::new()]);
    }

    #[test]
    fn a_turn_the_agent_began_itself_names_nothing() {
        let mut stream = stream();
        let out = events(&mut stream, &[init(), result()]);
        assert_eq!(started(&out), [Vec::<String>::new()]);
    }

    #[test]
    fn a_cancelled_message_is_dropped() {
        let mut stream = stream();
        sent(&mut stream, M1);
        let out = events(&mut stream, &[lifecycle(M1, "cancelled")]);
        assert!(matches!(
            &out[0],
            Event::Message { message, state: MessageState::Dropped, .. } if message == M1
        ));
    }

    #[test]
    fn a_refused_or_discarded_message_is_dropped() {
        let mut stream = stream();
        sent(&mut stream, M1);
        sent(&mut stream, M2);
        // Refused before it was queued, and discarded from the queue.
        let out = events(
            &mut stream,
            &[
                lifecycle(M1, "refused"),
                lifecycle(M2, "queued"),
                lifecycle(M2, "discarded"),
            ],
        );
        let dropped: Vec<&str> = out
            .iter()
            .filter_map(|event| match event {
                Event::Message {
                    message,
                    state: MessageState::Dropped,
                    ..
                } => Some(message.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(dropped, [M1, M2]);
        assert!(stream.ours.is_empty());
    }

    #[test]
    fn cancelling_a_permission_ends_the_turn_as_interrupted() {
        // As the real agent ends it: an error during execution, aborted at
        // the tools, and the message it was answering cancelled.
        for reason in [Some("aborted_tools"), None] {
            let mut stream = stream();
            sent(&mut stream, M1);
            events(
                &mut stream,
                &[
                    lifecycle(M1, "started"),
                    init(),
                    json!({"type":"control_request","request_id":"p1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"touch x"}}}),
                ],
            );
            stream.answer("p1", Choice::Cancel, None).unwrap();
            let mut ended = json!({"type":"result","subtype":"error_during_execution","is_error":true,"errors":["[ede_diagnostic] result_type=user"]});
            if let Some(reason) = reason {
                ended["terminal_reason"] = json!(reason);
            }
            let out = events(&mut stream, &[ended, lifecycle(M1, "cancelled")]);
            assert!(
                matches!(
                    out[0],
                    Event::TurnEnded {
                        outcome: Outcome::Interrupted,
                        error: None,
                        ..
                    }
                ),
                "{reason:?}: {out:?}"
            );
            assert_eq!(out.len(), 1, "the message was answered: {out:?}");
        }
        // An abort the agent reports needs no interrupt of this side's.
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                init(),
                json!({"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming"}),
            ],
        );
        assert!(matches!(
            out[1],
            Event::TurnEnded {
                outcome: Outcome::Interrupted,
                ..
            }
        ));
    }

    #[test]
    fn a_result_too_long_to_read_finishes_its_call_as_cut_short() {
        let mut stream = stream();
        events(
            &mut stream,
            &[
                init(),
                json!({"type":"assistant","message":{"id":"m1","content":[
                    {"type":"tool_use","id":"toolu_read","name":"Read","input":{}},
                    {"type":"tool_use","id":"toolu_other","name":"Read","input":{}}]},"parent_tool_use_id":null}),
            ],
        );
        // As the agent writes it: the content first, then the call's id,
        // the line passing in pieces that cut the key and the id apart.
        let line = format!(
            r#"{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","content":"{}","tool_use_id":"toolu_read"}}]}},"parent_tool_use_id":null,"tool_use_result":{{"note":"\"tool_use_id\":\"toolu_other\""}}}}"#,
            "x".repeat(5000)
        );
        let bytes = line.as_bytes();
        let cut = line.find("toolu_read").unwrap();
        for piece in [
            &bytes[..cut - 7],
            &bytes[cut - 7..cut + 3],
            &bytes[cut + 3..cut + 4],
            &bytes[cut + 4..],
        ] {
            stream.skipping(piece);
        }
        let out = stream.skipped().events;
        assert_eq!(
            out,
            [Event::ToolFinished {
                call: "toolu_read".into(),
                parent: None,
                output: String::new(),
                error: true,
                truncated: true,
                changes: vec![],
            }],
            "only the call the result names, not one quoted inside a string"
        );
        assert!(stream.calls.contains_key("toolu_other"));
        assert!(stream.skipped().events.is_empty(), "said once");
    }

    #[test]
    fn compacting_is_asked_for_in_a_message_that_names_no_turn_of_the_window_s() {
        let mut stream = stream();
        let Sending::Line { line } = stream
            .control(&Control::Compact { instructions: None })
            .unwrap()
        else {
            panic!("the agent answers with events alone");
        };
        let line: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(line["message"]["content"], "/compact");
        let uuid = line["uuid"].as_str().unwrap();
        let out = events(
            &mut stream,
            &[
                lifecycle(uuid, "started"),
                json!({"type":"system","subtype":"status","status":"compacting"}),
            ],
        );
        assert_eq!(out[0], Event::TurnStarted { messages: vec![] });
        assert_eq!(out[1], Event::Compacting);
    }

    #[test]
    fn the_context_window_is_told_when_its_use_or_size_changes() {
        let mut stream = stream();
        let assistant = |input: u64| {
            json!({"type":"assistant","message":{"id":"m1","content":[],"usage":{
                "input_tokens":input,"cache_read_input_tokens":100,"cache_creation_input_tokens":10,"output_tokens":5}},
                "parent_tool_use_id":null})
        };
        let ended = json!({"type":"result","subtype":"success","is_error":false,
            "usage":{"input_tokens":3,"cache_read_input_tokens":100,"cache_creation_input_tokens":10,"output_tokens":7,"output_tokens_details":{"thinking_tokens":2}},
            "modelUsage":{"haiku":{"contextWindow":200000},"other":{"contextWindow":1000000}}});
        let out = events(&mut stream, &[assistant(1), ended.clone()]);
        let told = |out: &[Event]| -> Vec<Event> {
            out.iter()
                .filter(|e| matches!(e, Event::Context { .. }))
                .cloned()
                .collect()
        };
        assert_eq!(
            told(&out),
            [Event::Context {
                used: Some(116),
                size: Some(200_000)
            }],
            "the window of the model the session runs on"
        );
        let Some(Event::TurnEnded {
            usage: Some(usage), ..
        }) = out.last()
        else {
            panic!("{out:?}");
        };
        assert_eq!(
            usage,
            &Usage {
                input_tokens: 113,
                cached_tokens: 100,
                output_tokens: 7,
                reasoning_tokens: 2
            }
        );
        // The same again is no news; a subagent's use is not the
        // conversation's.
        let out = events(
            &mut stream,
            &[
                assistant(1),
                json!({"type":"assistant","message":{"id":"m2","content":[],"usage":{"input_tokens":9000}},"parent_tool_use_id":"t1"}),
                ended,
            ],
        );
        assert!(told(&out).is_empty(), "{out:?}");
        let out = events(
            &mut stream,
            &[
                json!({"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":116,"post_tokens":20}}),
            ],
        );
        assert_eq!(
            out,
            [
                Event::Compacted {
                    reason: Some(CompactReason::Full),
                    tokens_before: Some(116),
                    tokens_after: Some(20)
                },
                Event::Context {
                    used: Some(20),
                    size: Some(200_000)
                }
            ]
        );
    }

    #[test]
    fn notices_are_told_apart_from_errors_and_turns() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                json!({"type":"system","subtype":"notification","key":"k","text":"Update available","priority":"low"}),
                json!({"type":"system","subtype":"notification","key":"k","text":"Usage limit soon","priority":"high"}),
                json!({"type":"system","subtype":"informational","content":"Only in the transcript","level":"info"}),
                json!({"type":"system","subtype":"informational","content":"Instructions are long","level":"warning"}),
                json!({"type":"system","subtype":"model_fallback","trigger":"overloaded","original_model":"opus","fallback_model":"sonnet","content":""}),
            ],
        );
        assert_eq!(
            out,
            [
                Event::Notice {
                    level: NoticeLevel::Info,
                    message: "Update available".into()
                },
                Event::Notice {
                    level: NoticeLevel::Warning,
                    message: "Usage limit soon".into()
                },
                Event::Notice {
                    level: NoticeLevel::Warning,
                    message: "Instructions are long".into()
                },
                Event::Notice {
                    level: NoticeLevel::Warning,
                    message: "opus is unavailable, so this turn uses sonnet".into()
                },
            ]
        );
        assert!(!stream.turn, "a notice starts no turn");
    }

    #[test]
    fn compacting_by_hand_is_a_turn_from_start_to_finish() {
        // As the real agent answers `/compact`: no init before compacting.
        let mut stream = stream();
        stream.message(M1, "/compact", &[]).unwrap();
        let out = events(
            &mut stream,
            &[
                lifecycle(M1, "started"),
                json!({"type":"system","subtype":"status","status":"compacting"}),
                json!({"type":"system","subtype":"status","status":null,"compact_result":"success"}),
                init(),
                json!({"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"manual","pre_tokens":100,"post_tokens":10}}),
                json!({"type":"result","subtype":"success","is_error":false,"num_turns":0,"result":""}),
            ],
        );
        assert_eq!(
            out[0],
            Event::TurnStarted {
                messages: vec![M1.into()]
            }
        );
        assert_eq!(out[1], Event::Compacting);
        assert!(out.contains(&Event::Compacted {
            reason: Some(CompactReason::Asked),
            tokens_before: Some(100),
            tokens_after: Some(10)
        }));
        assert!(matches!(
            out.last(),
            Some(Event::TurnEnded {
                outcome: Outcome::Done,
                ..
            })
        ));
        assert_eq!(started(&out).len(), 1);
    }

    #[test]
    fn streamed_text_and_its_whole_block_share_an_id() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}},"parent_tool_use_id":null}),
                json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}),
                json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}}),
                json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}}),
                json!({"type":"stream_event","event":{"type":"content_block_stop","index":0}}),
                json!({"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Hello"}]},"parent_tool_use_id":null}),
            ],
        );
        let blocks: Vec<_> = out
            .iter()
            .filter_map(|event| match event {
                Event::Text {
                    block, text, done, ..
                } => Some((block.clone(), text.clone(), *done)),
                Event::TurnStarted { .. } => None,
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(
            blocks,
            [
                ("m1#0".into(), "Hel".into(), false),
                ("m1#0".into(), "lo".into(), false),
                ("m1#0".into(), "Hello".into(), true),
            ]
        );
        assert!(stream.closed.is_empty() && stream.open.is_empty());
    }

    #[test]
    fn streamed_thinking_is_told_like_text() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}),
                json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}),
                json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}}),
                json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"x"}}}),
                json!({"type":"stream_event","event":{"type":"content_block_stop","index":0}}),
                json!({"type":"assistant","message":{"id":"m1","content":[{"type":"thinking","thinking":"hmm","signature":"x"}]}}),
                // A block that never streamed and carries no text is not told.
                json!({"type":"assistant","message":{"id":"m2","content":[{"type":"thinking","thinking":"","signature":"y"}]}}),
            ],
        );
        let thinking: Vec<_> = out
            .iter()
            .filter_map(|event| match event {
                Event::Thinking {
                    block, text, done, ..
                } => Some((block.as_str(), text.as_str(), *done)),
                _ => None,
            })
            .collect();
        assert_eq!(thinking, [("m1#0", "hmm", false), ("m1#0", "hmm", true)]);
    }

    #[test]
    fn text_a_tool_and_text_in_one_message_keep_their_own_ids() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}),
                json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}),
                json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first"}}}),
                json!({"type":"stream_event","event":{"type":"content_block_stop","index":0}}),
                json!({"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"Read"}}}),
                json!({"type":"stream_event","event":{"type":"content_block_stop","index":1}}),
                json!({"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"text"}}}),
                json!({"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"second"}}}),
                json!({"type":"stream_event","event":{"type":"content_block_stop","index":2}}),
                json!({"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"first"}]}}),
                json!({"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/a"}}]}}),
                json!({"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"second"}]}}),
            ],
        );
        let whole: Vec<_> = out
            .iter()
            .filter_map(|event| match event {
                Event::Text {
                    block,
                    text,
                    done: true,
                    ..
                } => Some((block.as_str(), text.as_str())),
                _ => None,
            })
            .collect();
        assert_eq!(whole, [("m1#0", "first"), ("m1#2", "second")]);
        assert!(out.contains(&Event::ToolStarted {
            call: "t1".into(),
            parent: None,
            name: "Read".into(),
            kind: ToolKind::Read
        }));
        assert!(stream.closed.is_empty() && stream.open.is_empty());
    }

    #[test]
    fn parallel_tool_calls_stream_their_input_apart() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}),
                json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"a","name":"Grep"}}}),
                json!({"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"b","name":"Bash"}}}),
                json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"command\""}}}),
                json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"pattern\""}}}),
            ],
        );
        let deltas: Vec<_> = out
            .iter()
            .filter_map(|event| match event {
                Event::ToolInput {
                    call,
                    delta: Some(delta),
                    ..
                } => Some((call.as_str(), delta.as_str())),
                _ => None,
            })
            .collect();
        assert_eq!(deltas, [("b", "{\"command\""), ("a", "{\"pattern\"")]);
        let kinds: Vec<_> = out
            .iter()
            .filter_map(|event| match event {
                Event::ToolStarted { kind, .. } => Some(*kind),
                _ => None,
            })
            .collect();
        assert_eq!(kinds, [ToolKind::Search, ToolKind::Command]);
    }

    #[test]
    fn a_tool_call_streams_its_input_and_ends_with_a_patch() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}),
                json!({"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"Edit","input":{}}}}),
                json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\":"}}}),
                json!({"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/p/a.txt"}}]}}),
                json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},
                    "tool_use_result":{"filePath":"/p/a.txt","oldString":"one","newString":"two","structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-one","+two"]}]}}),
            ],
        );
        assert_eq!(out[0], Event::TurnStarted { messages: vec![] });
        assert_eq!(
            out[1],
            Event::ToolStarted {
                call: "t1".into(),
                parent: None,
                name: "Edit".into(),
                kind: ToolKind::Edit
            }
        );
        assert!(
            matches!(&out[2], Event::ToolInput { delta: Some(d), .. } if d == "{\"file_path\":")
        );
        assert!(
            matches!(&out[3], Event::ToolInput { input: Some(i), delta: None, .. } if i["file_path"] == "/p/a.txt")
        );
        let Event::ToolFinished {
            output,
            changes,
            error: false,
            ..
        } = &out[4]
        else {
            panic!("{:?}", out[4]);
        };
        assert_eq!(output, "ok");
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, ChangeKind::Update);
        assert_eq!(changes[0].hunks[0].lines, ["-one", "+two"]);
        assert_eq!(out.len(), 5, "{out:?}");
    }

    #[test]
    fn a_new_file_comes_with_its_content() {
        let changes = file_changes(
            &json!({"type":"create","filePath":"/p/n.txt","content":"one\n","structuredPatch":[],"originalFile":null}),
        );
        assert_eq!(changes[0].kind, ChangeKind::Create);
        assert_eq!(changes[0].content.as_deref(), Some("one\n"));
        // A tool that only read a file changed nothing.
        assert!(file_changes(&json!({"type":"text","file":{"filePath":"/p/n.txt"}})).is_empty());
        assert!(file_changes(&json!("Error: no")).is_empty());
    }

    #[test]
    fn tools_are_sorted_by_what_they_do() {
        for (name, kind) in [
            ("Bash", ToolKind::Command),
            ("Write", ToolKind::Edit),
            ("Read", ToolKind::Read),
            ("Glob", ToolKind::Search),
            ("WebFetch", ToolKind::Web),
            ("Agent", ToolKind::Agent),
            ("mcp__agent-workbench__show", ToolKind::Mcp),
            ("Skill", ToolKind::Other),
        ] {
            assert_eq!(tool_kind(name), kind, "{name}");
        }
    }

    #[test]
    fn the_list_of_steps_and_a_plan_to_go_ahead_with_are_plans() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                json!({"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"TodoWrite","input":{"todos":[
                    {"content":"read","status":"completed","activeForm":"Reading"},
                    {"content":"write","status":"in_progress","activeForm":"Writing"},
                    {"content":"test","status":"pending","activeForm":"Testing"}]}}]}}),
                json!({"type":"control_request","request_id":"p1","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{"plan":"1. do it"},"tool_use_id":"t2",
                    "permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}),
            ],
        );
        let plans: Vec<_> = out
            .iter()
            .filter(|e| matches!(e, Event::Plan { .. }))
            .collect();
        assert_eq!(
            plans[0],
            &Event::Plan {
                call: Some("t1".into()),
                parent: None,
                text: None,
                steps: vec![
                    PlanStep {
                        text: "read".into(),
                        status: StepStatus::Done
                    },
                    PlanStep {
                        text: "write".into(),
                        status: StepStatus::Active
                    },
                    PlanStep {
                        text: "test".into(),
                        status: StepStatus::Pending
                    },
                ],
            }
        );
        assert_eq!(
            plans[1],
            &Event::Plan {
                call: Some("t2".into()),
                parent: None,
                text: Some("1. do it".into()),
                steps: vec![],
            }
        );
        // Going ahead with the plan is a permission: allowing it is the
        // answer, with the input as it was.
        assert!(
            matches!(out.last(), Some(Event::PermissionAsked { tool, .. }) if tool == "ExitPlanMode")
        );
        let line: Value =
            serde_json::from_str(&stream.answer("p1", Choice::Allow, None).unwrap()).unwrap();
        assert_eq!(
            line["response"]["response"]["updatedInput"]["plan"],
            "1. do it"
        );
    }

    #[test]
    fn a_question_is_asked_and_answered_apart_from_permissions() {
        let mut stream = stream();
        let asked = json!({"type":"control_request","request_id":"q1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","tool_use_id":"t1","requires_user_interaction":true,
            "input":{"questions":[
                {"question":"Which colour?","header":"Colour","options":[{"label":"Red","description":"warm"},{"label":"Blue","description":"cool"}],"multiSelect":false},
                {"question":"Which sizes?","header":"Size","options":[{"label":"S"},{"label":"M"}],"multiSelect":true}]}}});
        let out = events(&mut stream, std::slice::from_ref(&asked));
        let Event::QuestionAsked {
            request,
            call,
            questions,
            ..
        } = &out[0]
        else {
            panic!("{out:?}");
        };
        assert_eq!((request.as_str(), call.as_deref()), ("q1", Some("t1")));
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].header.as_deref(), Some("Colour"));
        assert_eq!(questions[0].options[1].label, "Blue");
        assert!(!questions[0].multiple && questions[1].multiple);
        assert!(
            questions.iter().all(|q| !q.secret && q.other),
            "the agent's questions take the user's own words and keep nothing secret"
        );
        assert!(
            stream.answer("q1", Choice::Allow, None).is_err(),
            "not a permission"
        );
        assert!(
            stream.reply("q1", Some(&[vec!["Red".into()]])).is_err(),
            "one answer short"
        );
        assert!(stream
            .reply("q1", Some(&[vec!["Red".into()], vec![" ".into()]]))
            .is_err());

        let line: Value = serde_json::from_str(
            &stream
                .reply(
                    "q1",
                    Some(&[vec!["Teal, my own".into()], vec!["S".into(), "M".into()]]),
                )
                .unwrap(),
        )
        .unwrap();
        let response = &line["response"]["response"];
        assert_eq!(response["behavior"], "allow");
        assert_eq!(
            response["updatedInput"]["answers"],
            json!({"Which colour?": "Teal, my own", "Which sizes?": "S, M"})
        );
        assert_eq!(response["updatedInput"]["questions"][0]["header"], "Colour");
        assert!(stream.reply("q1", None).is_err(), "answered once");

        events(&mut stream, &[asked]);
        let line: Value = serde_json::from_str(&stream.reply("q1", None).unwrap()).unwrap();
        assert_eq!(line["response"]["response"]["behavior"], "deny");
    }

    #[test]
    fn a_withdrawn_question_is_withdrawn() {
        let mut stream = stream();
        events(
            &mut stream,
            &[
                json!({"type":"control_request","request_id":"q1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[]}}}),
            ],
        );
        let out = events(
            &mut stream,
            &[json!({"type":"control_cancel_request","request_id":"q1"})],
        );
        assert_eq!(
            out,
            [Event::Withdrawn {
                request: "q1".into()
            }]
        );
        assert!(stream.reply("q1", None).is_err());
    }

    fn offered(out: &[Event]) -> Vec<(Choice, Option<String>)> {
        let Event::PermissionAsked { choices, .. } = &out[0] else {
            panic!("{out:?}");
        };
        choices
            .iter()
            .map(|offer| (offer.choice, offer.remembers.clone()))
            .collect()
    }

    fn answered(
        stream: &mut Stream,
        request: &str,
        choice: Choice,
        message: Option<&str>,
    ) -> Value {
        let line: Value =
            serde_json::from_str(&stream.answer(request, choice, message).unwrap()).unwrap();
        assert_eq!(line["response"]["request_id"], request);
        line["response"]["response"].clone()
    }

    #[test]
    fn permission_answers_carry_the_input_back_and_only_the_chosen_rule() {
        let mut stream = stream();
        let asked = json!({"type":"control_request","request_id":"p1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"touch c.txt"},"tool_use_id":"t9","blocked_path":"/p/c.txt",
            "permission_suggestions":[
                {"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch c.txt"}],"behavior":"allow","destination":"localSettings"},
                {"type":"addDirectories","directories":["/p"],"destination":"session"},
                {"type":"setMode","mode":"acceptEdits","destination":"session"}]}});
        let out = events(&mut stream, std::slice::from_ref(&asked));
        let Event::PermissionAsked {
            request,
            path,
            call,
            ..
        } = &out[0]
        else {
            panic!("{out:?}");
        };
        assert_eq!(request, "p1");
        assert_eq!(path.as_deref(), Some("/p/c.txt"));
        assert_eq!(call.as_deref(), Some("t9"));
        assert_eq!(
            offered(&out),
            [
                (Choice::Allow, None),
                (
                    Choice::AllowSession,
                    Some("Bash(touch c.txt) for the rest of this session".into())
                ),
                (
                    Choice::AllowAlways,
                    Some("Bash(touch c.txt) in this project's uncommitted local settings".into())
                ),
                (Choice::Deny, None),
                (Choice::Cancel, None),
            ]
        );

        let response = answered(&mut stream, "p1", Choice::AllowSession, None);
        assert_eq!(response["updatedInput"]["command"], "touch c.txt");
        assert_eq!(
            response["updatedPermissions"],
            json!([{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch c.txt"}],"behavior":"allow","destination":"session"}]),
            "the rule alone, never the mode or the directory beside it"
        );
        assert!(
            stream.answer("p1", Choice::Allow, None).is_err(),
            "answered once"
        );

        events(&mut stream, std::slice::from_ref(&asked));
        let response = answered(&mut stream, "p1", Choice::AllowAlways, None);
        assert_eq!(response["updatedPermissions"].as_array().unwrap().len(), 1);
        assert_eq!(
            response["updatedPermissions"][0]["destination"],
            "localSettings"
        );

        events(&mut stream, std::slice::from_ref(&asked));
        let response = answered(&mut stream, "p1", Choice::Allow, None);
        assert!(response.get("updatedPermissions").is_none());

        events(&mut stream, std::slice::from_ref(&asked));
        let response = answered(&mut stream, "p1", Choice::Deny, Some("not now"));
        assert_eq!(response["behavior"], "deny");
        assert_eq!(response["message"], "not now");
        assert!(response.get("interrupt").is_none());

        events(&mut stream, &[asked]);
        let response = answered(&mut stream, "p1", Choice::Cancel, None);
        assert_eq!(response["behavior"], "deny");
        assert_eq!(response["interrupt"], true);
    }

    #[test]
    fn a_request_that_suggests_a_mode_remembers_the_mode_for_the_session_alone() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                json!({"type":"control_request","request_id":"p2","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"/p/x"},
                "permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}),
            ],
        );
        assert_eq!(
            offered(&out),
            [
                (Choice::Allow, None),
                (
                    Choice::AllowSession,
                    Some("the acceptEdits permission mode for the rest of this session".into())
                ),
                (Choice::Deny, None),
                (Choice::Cancel, None),
            ]
        );
        assert!(stream.answer("p2", Choice::AllowAlways, None).is_err());
        let response = answered(&mut stream, "p2", Choice::AllowSession, None);
        assert_eq!(
            response["updatedPermissions"],
            json!([{"type":"setMode","mode":"acceptEdits","destination":"session"}])
        );
    }

    #[test]
    fn a_request_that_suggests_nothing_remembers_nothing() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                json!({"type":"control_request","request_id":"p3","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -rf build"}}}),
            ],
        );
        assert_eq!(
            offered(&out),
            [
                (Choice::Allow, None),
                (Choice::Deny, None),
                (Choice::Cancel, None),
            ]
        );
        assert!(
            stream.answer("p3", Choice::AllowSession, None).is_err(),
            "no rule is made up for the whole tool"
        );
        assert!(stream.answer("p3", Choice::AllowAlways, None).is_err());
        let response = answered(&mut stream, "p3", Choice::Allow, None);
        assert!(response.get("updatedPermissions").is_none());
    }

    #[test]
    fn a_control_request_this_side_does_not_handle_is_refused_not_left_waiting() {
        let mut stream = stream();
        let reading = stream.read(
            &json!({"type":"control_request","request_id":"h1","request":{"subtype":"hook_callback"}})
                .to_string(),
        );
        assert!(reading.events.is_empty());
        let answer: Value = serde_json::from_str(&reading.writes[0]).unwrap();
        assert_eq!(answer["response"]["subtype"], "error");
        assert_eq!(answer["response"]["request_id"], "h1");
    }

    fn interrupt(stream: &mut Stream) -> String {
        let Sending::Request { key, .. } = stream.control(&Control::Interrupt).unwrap() else {
            panic!("an interrupt asks the agent");
        };
        key
    }

    #[test]
    fn an_interrupted_turn_says_so_and_a_failed_one_says_why() {
        let mut stream = stream();
        events(&mut stream, &[init()]);
        interrupt(&mut stream);
        let out = events(
            &mut stream,
            &[
                json!({"type":"result","subtype":"error_during_execution","is_error":true,"result":""}),
            ],
        );
        assert!(matches!(
            out[0],
            Event::TurnEnded {
                outcome: Outcome::Interrupted,
                error: None,
                ..
            }
        ));
        let out = events(
            &mut stream,
            &[
                json!({"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","total_cost_usd":0,"usage":{"input_tokens":3}}),
            ],
        );
        let Event::TurnEnded {
            outcome,
            error,
            usage,
            ..
        } = &out[1]
        else {
            panic!("{out:?}");
        };
        assert_eq!(*outcome, Outcome::Failed);
        assert_eq!(error.as_deref(), Some("Not logged in · Please run /login"));
        assert_eq!(usage.as_ref().unwrap().input_tokens, 3);
    }

    #[test]
    fn an_interrupt_with_no_turn_running_marks_nothing() {
        // The real agent answers it and says nothing more.
        let mut stream = stream();
        let key = interrupt(&mut stream);
        let reading = stream.read(
            &json!({"type":"control_response","response":{"subtype":"success","request_id":key,"response":{"still_queued":[]}}}).to_string(),
        );
        assert!(reading.events.is_empty());
        let out = events(
            &mut stream,
            &[
                init(),
                json!({"type":"result","subtype":"error_during_execution","is_error":true,"errors":["the API failed"]}),
            ],
        );
        assert!(
            matches!(&out[1], Event::TurnEnded { outcome: Outcome::Failed, error: Some(e), .. } if e == "the API failed"),
            "{out:?}"
        );
    }

    #[test]
    fn an_interrupt_the_agent_refused_or_never_answered_marks_nothing() {
        let mut stream = stream();
        events(&mut stream, &[init()]);
        let key = interrupt(&mut stream);
        stream.read(
            &json!({"type":"control_response","response":{"subtype":"error","request_id":key,"error":"no"}}).to_string(),
        );
        let failed = json!({"type":"result","subtype":"error_during_execution","is_error":true});
        let out = events(&mut stream, std::slice::from_ref(&failed));
        assert!(matches!(
            out[0],
            Event::TurnEnded {
                outcome: Outcome::Failed,
                ..
            }
        ));

        events(&mut stream, &[init()]);
        let key = interrupt(&mut stream);
        stream.forget(&key);
        let out = events(&mut stream, &[failed]);
        assert!(matches!(
            out[0],
            Event::TurnEnded {
                outcome: Outcome::Failed,
                ..
            }
        ));
    }

    fn opened(stream: &mut Stream, account: Value, applied: Value) -> Vec<Event> {
        let lines = stream.opening();
        assert!(lines[0].contains("\"initialize\"") && lines[1].contains("\"get_settings\""));
        let mut out = events(
            stream,
            &[
                json!({"type":"control_response","response":{"subtype":"success","request_id":"wb-1","response":{
                "account":account,
                "current_permission_mode":"default","claude_code_version":"9.9.9",
                "models":[
                    {"value":"haiku","resolvedModel":"claude-haiku","displayName":"Haiku","description":"fast"},
                    {"value":"sonnet","resolvedModel":"claude-sonnet","displayName":"Sonnet","supportedEffortLevels":["low","high"]}],
                "commands":[{"name":"compact","description":"Compact","argumentHint":""}]}}}),
            ],
        );
        assert!(out.is_empty(), "ready waits for the settings: {out:?}");
        out.extend(events(
            stream,
            &[json!({"type":"control_response","response":{"subtype":"success","request_id":"wb-2","response":{"applied":applied}}})],
        ));
        out
    }

    #[test]
    fn ready_says_what_the_agent_is_and_offers() {
        let mut stream = stream();
        let out = opened(
            &mut stream,
            json!({"apiProvider":"firstParty","subscriptionType":"pro"}),
            json!({"model":"claude-sonnet","effort":"high"}),
        );
        let Event::Ready {
            model,
            mode,
            effort,
            version,
            models,
            modes,
            efforts,
            commands,
            ..
        } = &out[0]
        else {
            panic!("{out:?}");
        };
        assert_eq!(model.as_deref(), Some("claude-sonnet"));
        assert_eq!(mode.as_deref(), Some("default"));
        assert_eq!(effort.as_deref(), Some("high"));
        assert_eq!(version.as_deref(), Some("9.9.9"));
        assert_eq!(models[1].efforts, ["low", "high"]);
        assert_eq!(
            efforts,
            &["low", "high"],
            "the efforts of the model it runs on"
        );
        assert!(modes.iter().any(|mode| mode.value == "plan"));
        assert!(!modes.iter().any(|mode| mode.value == "bypassPermissions"));
        assert_eq!(commands[0].hint, None);
        assert_eq!(out.len(), 1, "signed in: {out:?}");
    }

    /// The commands a stream is ready with, after an initialize listing
    /// these.
    fn ready_with(stream: &mut Stream, commands: Value) -> Vec<CommandInfo> {
        stream.opening();
        let out = events(
            stream,
            &[
                json!({"type":"control_response","response":{"subtype":"success","request_id":"wb-1","response":{
                    "account":{"apiProvider":"firstParty","subscriptionType":"pro"},"commands":commands}}}),
                json!({"type":"control_response","response":{"subtype":"success","request_id":"wb-2","response":{"applied":{}}}}),
            ],
        );
        let Some(Event::Ready { commands, .. }) = out.first() else {
            panic!("{out:?}");
        };
        commands.clone()
    }

    fn told_commands(out: &[Event]) -> Vec<Vec<CommandInfo>> {
        out.iter()
            .filter_map(|event| match event {
                Event::Commands { commands } => Some(commands.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn commands_say_where_they_come_from() {
        let mut stream = stream();
        let commands = ready_with(
            &mut stream,
            json!([
                {"name":"compact","description":"Free up context","argumentHint":"<instructions>","builtin":true},
                {"name":"release","description":"Bump and tag a release (project)","argumentHint":"<version>"},
                {"name":"tidy","description":"Tidy up (user)","argumentHint":" "},
                {"name":"kit:deploy","description":"(kit) Ship it to production","argumentHint":""},
                {"name":"pdf","description":"Read a PDF. (claude.ai sync)\n"},
                {"name":"plain","description":"Says (something) in brackets"},
                {"name":"__internal","description":"Not for people","builtin":true},
                {"description":"No name"},
            ]),
        );
        let seen: Vec<_> = commands
            .iter()
            .map(|c| {
                (
                    c.name.as_str(),
                    c.description.as_deref(),
                    c.hint.as_deref(),
                    c.builtin,
                    c.source.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            seen,
            [
                (
                    "compact",
                    Some("Free up context"),
                    Some("<instructions>"),
                    true,
                    None
                ),
                (
                    "release",
                    Some("Bump and tag a release"),
                    Some("<version>"),
                    false,
                    Some("project")
                ),
                ("tidy", Some("Tidy up"), None, false, Some("user")),
                (
                    "kit:deploy",
                    Some("Ship it to production"),
                    None,
                    false,
                    Some("kit")
                ),
                (
                    "pdf",
                    Some("Read a PDF."),
                    None,
                    false,
                    Some("claude.ai sync")
                ),
                (
                    "plain",
                    Some("Says (something) in brackets"),
                    None,
                    false,
                    None
                ),
            ]
        );
        assert_eq!(
            commands.iter().map(|c| c.skill).collect::<Vec<_>>(),
            [false, true, true, true, true, true],
            "until a turn says, those that are not the agent's own are skills"
        );
    }

    #[test]
    fn a_turn_s_start_says_which_commands_are_skills() {
        let mut stream = stream();
        ready_with(
            &mut stream,
            json!([
                {"name":"compact","description":"Compact","builtin":true},
                {"name":"code-review","description":"Review the diff","builtin":true},
                {"name":"color","description":"Colour the prompt","builtin":true},
                {"name":"release","description":"Release (project)"},
                {"name":"pdf","description":"Read a PDF (claude.ai sync)"},
            ]),
        );
        let start = json!({"type":"system","subtype":"init","model":"haiku","permissionMode":"default",
            "skills":["code-review","anthropic-skills:pdf"],
            "slash_commands":["compact","code-review","color","release","anthropic-skills:pdf"],
            "terminal_slash_commands":["color"]});
        let out = events(&mut stream, std::slice::from_ref(&start));
        let told = told_commands(&out);
        assert_eq!(told.len(), 1, "{out:?}");
        assert_eq!(
            told[0]
                .iter()
                .map(|c| (c.name.as_str(), c.skill))
                .collect::<Vec<_>>(),
            [
                ("compact", false),
                ("code-review", true),
                ("release", false),
                ("pdf", true)
            ],
            "a skill of the agent's own, a command of a project's, and one \
             listed under a prefix are told apart; one for the terminal goes"
        );
        let out = events(&mut stream, &[result(), start]);
        assert!(told_commands(&out).is_empty(), "the same again is no news");
        let out = events(
            &mut stream,
            &[
                json!({"type":"system","subtype":"commands_changed","commands":[
                    {"name":"compact","description":"Compact","builtin":true},
                    {"name":"new-skill","description":"Found in a folder (project)"},
                ]}),
            ],
        );
        assert_eq!(
            told_commands(&out)[0]
                .iter()
                .map(|c| (c.name.as_str(), c.skill))
                .collect::<Vec<_>>(),
            [("compact", false), ("new-skill", false)],
            "a list the agent pushes takes the place of the last, marked by \
             the skills the last turn named"
        );
    }

    #[test]
    fn a_turn_s_start_before_the_agent_is_ready_tells_nothing_of_commands() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[json!({"type":"system","subtype":"init","model":"haiku","skills":["review"]})],
        );
        assert!(told_commands(&out).is_empty(), "{out:?}");
        let commands = ready_with(
            &mut stream,
            json!([{"name":"review","description":"Review","builtin":true}]),
        );
        assert!(commands[0].skill, "the ready event says what was heard");
    }

    #[test]
    fn compacting_takes_what_the_summary_should_keep() {
        let mut stream = stream();
        let Sending::Line { line } = stream
            .control(&Control::Compact {
                instructions: Some("keep the API notes".into()),
            })
            .unwrap()
        else {
            panic!("the agent answers with events alone");
        };
        let line: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(line["message"]["content"], "/compact keep the API notes");
    }

    #[test]
    fn signed_out_is_told_at_the_start_and_on_the_first_message() {
        let mut stream = stream();
        let out = opened(
            &mut stream,
            json!({"tokenSource":"none","apiProvider":"firstParty"}),
            json!({}),
        );
        assert!(matches!(out[0], Event::Ready { .. }));
        assert!(matches!(
            out[1],
            Event::Error {
                kind: ErrorKind::NotLoggedIn,
                ..
            }
        ));

        let out = events(
            &mut stream,
            &[
                json!({"type":"assistant","error":"authentication_failed","message":{"id":"x","content":[{"type":"text","text":"Not logged in · Please run /login"}]}}),
            ],
        );
        assert!(matches!(
            out[1],
            Event::Error {
                kind: ErrorKind::NotLoggedIn,
                ..
            }
        ));

        // An account with a login says nothing of the kind.
        assert!(!signed_out(
            &json!({"apiProvider":"firstParty","subscriptionType":"pro"})
        ));
    }

    #[test]
    fn subagent_lines_name_the_call_that_started_them() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                json!({"type":"system","subtype":"task_started","task_id":"a1","tool_use_id":"t1","description":"look","task_type":"local_agent","is_backgrounded":true,"prompt":"find it"}),
                json!({"type":"assistant","parent_tool_use_id":"t1","message":{"id":"m9","content":[{"type":"text","text":"banana"}]}}),
                json!({"type":"system","subtype":"task_progress","task_id":"a1","last_tool_name":"Grep"}),
                json!({"type":"system","subtype":"task_notification","task_id":"a1","status":"stopped","summary":"found"}),
            ],
        );
        assert!(
            matches!(&out[0], Event::TaskStarted { kind: TaskKind::Agent, background: true, call: Some(c), .. } if c == "t1")
        );
        assert!(matches!(&out[1], Event::Text { parent: Some(p), done: true, .. } if p == "t1"));
        assert!(
            matches!(&out[2], Event::TaskProgress { call: Some(c), tool: Some(t), .. } if c == "t1" && t == "Grep")
        );
        assert!(
            matches!(&out[3], Event::TaskFinished { call: Some(c), summary: Some(s), status: TaskStatus::Stopped, .. } if c == "t1" && s == "found")
        );
        assert!(!stream.turn, "a subagent's lines start no turn");
    }

    fn finished(out: &[Event]) -> Vec<(String, TaskStatus)> {
        out.iter()
            .filter_map(|event| match event {
                Event::TaskFinished { task, status, .. } => Some((task.clone(), *status)),
                _ => None,
            })
            .collect()
    }

    fn background_agent(task: &str, call: &str) -> Value {
        json!({"type":"system","subtype":"task_started","task_id":task,"tool_use_id":call,"description":"look","task_type":"local_agent","is_backgrounded":true})
    }

    fn listed(tasks: &[&str]) -> Value {
        let tasks: Vec<Value> = tasks
            .iter()
            .map(|task| json!({"task_id":task,"task_type":"local_agent","description":"look"}))
            .collect();
        json!({"type":"system","subtype":"background_tasks_changed","tasks":tasks})
    }

    fn notified(task: &str, status: &str) -> Value {
        json!({"type":"system","subtype":"task_notification","task_id":task,"status":status,"summary":"done"})
    }

    #[test]
    fn a_task_the_list_drops_before_its_notification_is_not_lost() {
        // The list and the notification come in no promised order.
        for list_first in [true, false] {
            let mut stream = stream();
            let mut lines = vec![
                init(),
                background_agent("a1", "t1"),
                listed(&["a1"]),
                result(),
            ];
            if list_first {
                lines.extend([listed(&[]), notified("a1", "completed")]);
            } else {
                lines.extend([notified("a1", "completed"), listed(&[])]);
            }
            let out = events(&mut stream, &lines);
            assert_eq!(
                finished(&out),
                [("a1".to_string(), TaskStatus::Completed)],
                "list first: {list_first}"
            );
        }
    }

    #[test]
    fn a_task_unlisted_with_no_word_when_the_turn_ends_is_lost_once() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                init(),
                json!({"type":"system","subtype":"task_started","task_id":"a1","tool_use_id":"t1","description":"look","task_type":"local_agent","is_backgrounded":true,"awaited":true}),
                listed(&["a1"]),
                listed(&[]),
            ],
        );
        assert!(finished(&out).is_empty(), "not lost while the turn runs");
        let out = events(&mut stream, &[result()]);
        assert_eq!(finished(&out), [("a1".to_string(), TaskStatus::Lost)]);
        assert!(
            matches!(out.last(), Some(Event::TurnEnded { .. })),
            "lost before the turn ends: {out:?}"
        );
        let out = events(&mut stream, &[notified("a1", "completed")]);
        assert!(finished(&out).is_empty(), "a late word of it is dropped");
    }

    #[test]
    fn a_subagent_that_reports_is_left_for_idle_when_the_list_drops_it_mid_turn() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                init(),
                background_agent("a1", "t1"),
                listed(&["a1"]),
                listed(&[]),
                result(),
                notified("a1", "completed"),
            ],
        );
        assert_eq!(
            finished(&out),
            [("a1".to_string(), TaskStatus::Completed)],
            "its own word, not lost at the result"
        );
        // With no word of it by the time the agent is idle, it is lost.
        let out = events(
            &mut stream,
            &[init(), background_agent("a2", "t2"), listed(&[]), result()],
        );
        assert!(finished(&out).is_empty(), "{out:?}");
        let out = events(&mut stream, &[idle()]);
        assert_eq!(finished(&out), [("a2".to_string(), TaskStatus::Lost)]);
    }

    fn foreground_agent(task: &str, call: &str) -> Value {
        json!({"type":"system","subtype":"task_started","task_id":task,"tool_use_id":call,"description":"look","task_type":"local_agent","is_backgrounded":false})
    }

    fn idle() -> Value {
        json!({"type":"system","subtype":"session_state_changed","state":"idle"})
    }

    #[test]
    fn a_foreground_subagent_with_no_word_is_lost_when_its_turn_ends() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                init(),
                json!({"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Agent","input":{}}]},"parent_tool_use_id":null}),
                foreground_agent("a1", "t1"),
                // One its own subagent started waits on that subagent, not
                // on the main turn.
                json!({"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","id":"t2","name":"Agent","input":{}}]},"parent_tool_use_id":"t1"}),
                foreground_agent("a2", "t2"),
                result(),
            ],
        );
        assert_eq!(finished(&out), [("a1".to_string(), TaskStatus::Lost)]);
        // Once the agent says its work is over, nothing it began still runs.
        let out = events(&mut stream, &[idle()]);
        assert_eq!(finished(&out), [("a2".to_string(), TaskStatus::Lost)]);
    }

    #[test]
    fn idle_loses_what_is_gone_from_the_background_and_keeps_what_runs() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                init(),
                background_agent("a1", "t1"),
                json!({"type":"system","subtype":"task_started","task_id":"b1","tool_use_id":"t2","description":"serve","task_type":"local_bash","is_backgrounded":true}),
                json!({"type":"system","subtype":"background_tasks_changed","tasks":[
                    {"task_id":"a1","task_type":"local_agent","description":"look"},
                    {"task_id":"b1","task_type":"local_bash","description":"serve"}]}),
                result(),
                json!({"type":"system","subtype":"background_tasks_changed","tasks":[
                    {"task_id":"b1","task_type":"local_bash","description":"serve"}]}),
                idle(),
            ],
        );
        assert_eq!(finished(&out), [("a1".to_string(), TaskStatus::Lost)]);
        assert!(stream.tasks.contains_key("b1"), "the server still runs");
    }

    #[test]
    fn a_background_subagent_nothing_waits_on_reports_in_a_turn_of_its_own() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                background_agent("a1", "t1"),
                json!({"type":"system","subtype":"task_started","task_id":"a2","tool_use_id":"t2","description":"look","task_type":"local_agent","is_backgrounded":true,"awaited":true}),
                json!({"type":"system","subtype":"task_started","task_id":"b1","tool_use_id":"t3","description":"sleep","task_type":"local_bash","is_backgrounded":true}),
                notified("a1", "stopped"),
                notified("a2", "completed"),
                notified("b1", "completed"),
            ],
        );
        let reports: Vec<(String, bool)> = out
            .iter()
            .filter_map(|event| match event {
                Event::TaskFinished { task, reports, .. } => Some((task.clone(), *reports)),
                _ => None,
            })
            .collect();
        assert_eq!(
            reports,
            [
                ("a1".to_string(), true),
                ("a2".to_string(), false),
                ("b1".to_string(), false)
            ]
        );
    }

    #[test]
    fn housekeeping_tasks_are_marked_ambient() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                json!({"type":"system","subtype":"task_started","task_id":"a1","description":"tidy","task_type":"local_agent","ambient":true}),
                json!({"type":"system","subtype":"task_started","task_id":"a2","description":"tidy","task_type":"local_agent","skip_transcript":true}),
                background_agent("a3", "t3"),
            ],
        );
        let ambient: Vec<bool> = out
            .iter()
            .filter_map(|event| match event {
                Event::TaskStarted { ambient, .. } => Some(*ambient),
                _ => None,
            })
            .collect();
        assert_eq!(ambient, [true, true, false]);
    }

    fn control_key(stream: &mut Stream, control: Control) -> String {
        let Sending::Request { key, .. } = stream.control(&control).unwrap() else {
            panic!("asks the agent");
        };
        key
    }

    #[test]
    fn the_model_the_mode_and_the_effort_change_and_are_told_once_each() {
        let mut stream = stream();
        opened(
            &mut stream,
            json!({"apiProvider":"firstParty","subscriptionType":"pro"}),
            json!({"model":"claude-haiku"}),
        );
        let key = control_key(&mut stream, Control::SetModel("sonnet".into()));
        let reading = stream.read(
            &json!({"type":"control_response","response":{"subtype":"success","request_id":key,"response":{"model":"claude-sonnet"}}}).to_string(),
        );
        assert_eq!(reading.replies[0].0, key);
        assert_eq!(
            reading.events,
            [Event::Configured {
                model: Some("claude-sonnet".into()),
                mode: Some("default".into()),
                effort: None,
                efforts: vec!["low".into(), "high".into()],
            }]
        );
        // The same model again from the next turn's description is no news.
        let out = events(
            &mut stream,
            &[
                json!({"type":"system","subtype":"init","model":"claude-sonnet","permissionMode":"default"}),
            ],
        );
        assert_eq!(out, [Event::TurnStarted { messages: vec![] }]);

        let key = control_key(&mut stream, Control::SetEffort("low".into()));
        let reading = stream.read(
            &json!({"type":"control_response","response":{"subtype":"success","request_id":key}})
                .to_string(),
        );
        assert!(
            matches!(&reading.events[0], Event::Configured { effort: Some(e), .. } if e == "low")
        );

        let key = control_key(&mut stream, Control::SetMode("plan".into()));
        let reading = stream.read(
            &json!({"type":"control_response","response":{"subtype":"success","request_id":key,"response":{"mode":"plan"}}}).to_string(),
        );
        assert!(
            matches!(&reading.events[0], Event::Configured { mode: Some(m), .. } if m == "plan")
        );

        let key = control_key(&mut stream, Control::SetModel("nope".into()));
        let reading = stream.read(
            &json!({"type":"control_response","response":{"subtype":"error","request_id":key,"error":"Model 'nope' not found"}}).to_string(),
        );
        assert_eq!(reading.replies[0].1, Err("Model 'nope' not found".into()));
        assert!(reading.events.is_empty());
        assert!(stream.control(&Control::SetModel("--bare".into())).is_err());
    }

    #[test]
    fn a_mode_change_the_agent_reports_by_itself_is_told() {
        let mut stream = stream();
        opened(
            &mut stream,
            json!({"apiProvider":"firstParty","subscriptionType":"pro"}),
            json!({}),
        );
        let out = events(
            &mut stream,
            &[
                json!({"type":"system","subtype":"status","status":null,"permissionMode":"acceptEdits"}),
            ],
        );
        assert!(
            matches!(&out[..], [Event::Configured { mode: Some(m), .. }] if m == "acceptEdits")
        );
    }

    #[test]
    fn a_retry_is_told_and_the_turn_goes_on() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                init(),
                json!({"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"retry_delay_ms":500,"error_status":529,"error":{"message":"Overloaded"}}),
            ],
        );
        assert_eq!(
            out[1],
            Event::Retrying {
                message: "Overloaded".into(),
                attempt: Some(2),
                attempts: Some(10)
            }
        );
        assert!(stream.turn);
    }

    #[test]
    fn images_go_as_content_blocks_beside_the_text() {
        let mut stream = stream();
        let line: Value = serde_json::from_str(
            &stream
                .message(
                    M1,
                    "look",
                    &[Image {
                        media_type: "image/png".into(),
                        data: "AAAA".into(),
                    }],
                )
                .unwrap(),
        )
        .unwrap();
        let content = &line["message"]["content"];
        assert_eq!(content[0]["text"], "look");
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert_eq!(line["uuid"], M1);
        assert!(stream.message(M2, "  ", &[]).is_err());
        assert!(stream
            .message(
                M2,
                "x",
                &[Image {
                    media_type: "text/html".into(),
                    data: "AAAA".into()
                }]
            )
            .is_err());
        let plain: Value = serde_json::from_str(&stream.message(M3, "hi", &[]).unwrap()).unwrap();
        assert_eq!(plain["message"]["content"], "hi");
    }

    #[test]
    fn trust_is_read_and_written_in_the_directory_the_claude_process_runs_with() {
        let base = crate::scratch::Scratch::new("claude-trust-dir");
        let home = base.join("home");
        let shell = base.join("shell-claude");
        let folder = base.join("work");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&shell).unwrap();
        std::fs::create_dir_all(&folder).unwrap();
        let env = HashMap::from([(
            "CLAUDE_CONFIG_DIR".to_string(),
            shell.to_string_lossy().to_string(),
        )]);
        // The home's own state trusts the folder; the one the launch
        // environment names does not.
        hook::claude_trust(&home.join(".claude.json"), &folder).unwrap();
        assert!(!CLAUDE_STREAM.trusted(&home, None, &env, &folder));
        CLAUDE_STREAM.trust(&home, None, &env, &folder).unwrap();
        assert!(shell.join(".claude.json").exists());
        assert!(CLAUDE_STREAM.trusted(&home, None, &env, &folder));

        // With no variable, or an empty one, the home's own.
        assert!(CLAUDE_STREAM.trusted(&home, None, &HashMap::new(), &folder));
        let empty = HashMap::from([("CLAUDE_CONFIG_DIR".to_string(), String::new())]);
        assert!(CLAUDE_STREAM.trusted(&home, None, &empty, &folder));

        // An account's directory wins over the environment.
        let account = base.join("account");
        std::fs::create_dir_all(&account).unwrap();
        assert!(!CLAUDE_STREAM.trusted(&home, Some(&account), &env, &folder));
    }

    /// What each line meant, writes and all.
    fn readings(stream: &mut Stream, lines: &[Value]) -> Reading {
        let mut all = Reading::default();
        for line in lines {
            let reading = stream.read(&line.to_string());
            all.events.extend(reading.events);
            all.writes.extend(reading.writes);
            all.replies.extend(reading.replies);
        }
        all
    }

    /// The reads of the usage among lines written, by request id.
    fn usage_reads(writes: &[String]) -> Vec<String> {
        writes
            .iter()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|line| line["request"]["subtype"] == "get_usage")
            .map(|line| {
                assert_eq!(line["request"]["skip_behaviors"], true);
                line["request_id"].as_str().unwrap().to_string()
            })
            .collect()
    }

    /// A stream that is ready, and the id of the read of the usage it
    /// asked for then.
    fn ready_reading() -> (Stream, String) {
        let mut stream = stream();
        stream.opening();
        let reading = readings(
            &mut stream,
            &[
                json!({"type":"control_response","response":{"subtype":"success","request_id":"wb-1","response":{
                    "account":{"apiProvider":"firstParty","subscriptionType":"max"},"models":[]}}}),
                json!({"type":"control_response","response":{"subtype":"success","request_id":"wb-2","response":{"applied":{}}}}),
            ],
        );
        assert!(matches!(reading.events[0], Event::Ready { .. }));
        let reads = usage_reads(&reading.writes);
        assert_eq!(reads.len(), 1, "read once ready: {:?}", reading.writes);
        (stream, reads[0].clone())
    }

    /// Makes the last read asked as old as a read stands for. A clock that
    /// cannot go back that far forgets the read, which is older still.
    fn aged(stream: &mut Stream) {
        stream.usage_asked = stream
            .usage_asked
            .and_then(|asked| asked.checked_sub(crate::integrated::LIMITS_AGE));
    }

    /// A turn of a message, from its start to its end.
    fn turn_of(stream: &mut Stream, message: &str) -> Reading {
        sent(stream, message);
        readings(stream, &[lifecycle(message, "started"), init(), result()])
    }

    /// A reply to a read of the usage, in the shape Claude Code 2.1.323
    /// answers one, with the rows given.
    fn usage_reply(request: &str, limits: Value) -> Value {
        json!({"type":"control_response","response":{"subtype":"success","request_id":request,"response":{
            "session":{"total_cost_usd":0,"model_usage":{}},
            "subscription_type":"max","rate_limits_available":true,"behaviors":null,
            "rate_limits":{
                "five_hour":{"utilization":20,"resets_at":"2030-01-01T05:00:00.5+00:00"},
                "seven_day_opus":null,"something_new":{"a":1},
                "limits":limits}}}})
    }

    fn rows() -> Value {
        json!([
            {"kind":"session","group":"session","percent":20,"severity":"normal",
             "resets_at":"2030-01-01T05:00:00.5+00:00","scope":null,"is_active":false},
            {"kind":"weekly_all","group":"weekly","percent":40,"severity":"warning",
             "resets_at":"2030-01-05T00:00:00+00:00","scope":null,"is_active":false},
            {"kind":"weekly_scoped","group":"weekly","percent":60,"severity":"critical",
             "resets_at":"2030-01-05T00:00:00Z",
             "scope":{"model":{"id":null,"display_name":"Fable"},"surface":null},"is_active":true},
            {"kind":"weekly_scoped","group":"weekly","percent":5,"severity":"normal",
             "resets_at":null,"scope":{"model":null,"surface":{"display_name":"Elsewhere"}}},
            {"kind":"monthly_spend","percent":10,"severity":"normal"},
            {"kind":"session","percent":"lots"}
        ])
    }

    /// The limits told: the plan, the windows, when the last read was
    /// taken and when the last figure moved.
    type Told = (Option<String>, Vec<LimitWindow>, Option<u64>, u64);

    fn limits_of(events: &[Event]) -> Vec<Told> {
        events
            .iter()
            .filter_map(|event| match event {
                Event::Limits {
                    agent,
                    plan,
                    windows,
                    read_at,
                    taken_at,
                } => {
                    assert_eq!(agent, "claude-code");
                    assert!(taken_at.abs_diff(now_seconds()) < 60);
                    assert!(read_at.is_none_or(|read_at| read_at <= *taken_at));
                    Some((plan.clone(), windows.clone(), *read_at, *taken_at))
                }
                _ => None,
            })
            .collect()
    }

    fn window(
        kind: LimitKind,
        model: Option<&str>,
        percent: f64,
        resets_at: Option<u64>,
        severity: Option<LimitSeverity>,
    ) -> LimitWindow {
        LimitWindow {
            kind,
            model: model.map(str::to_string),
            percent,
            resets_at,
            severity,
        }
    }

    #[test]
    fn the_limits_are_read_once_ready_and_after_a_turn_once_the_last_read_is_old() {
        let (mut stream, read) = ready_reading();
        let reading = readings(&mut stream, &[usage_reply(&read, rows())]);
        assert!(reading.replies.is_empty(), "nothing waits on the read");
        let told = limits_of(&reading.events);
        assert_eq!(told.len(), 1, "{:?}", reading.events);
        let (plan, windows, read_at, taken_at) = &told[0];
        assert_eq!(plan.as_deref(), Some("max"));
        assert_eq!(*read_at, Some(*taken_at), "a read gives every figure");
        assert_eq!(
            windows,
            &[
                window(
                    LimitKind::Session,
                    None,
                    20.0,
                    Some(1_893_474_000),
                    Some(LimitSeverity::Normal)
                ),
                window(
                    LimitKind::Weekly,
                    None,
                    40.0,
                    Some(1_893_801_600),
                    Some(LimitSeverity::Warning)
                ),
                // The server's critical is near the end as well as past
                // it, so it reads as a warning.
                window(
                    LimitKind::WeeklyScoped,
                    Some("Fable"),
                    60.0,
                    Some(1_893_801_600),
                    Some(LimitSeverity::Warning)
                ),
            ],
            "a row of no model, of a kind not known or with no percent is left out"
        );

        // A turn that ends soon after asks nothing: what the agent pushed
        // during it moved the session window and the week.
        let reading = turn_of(&mut stream, M1);
        assert!(usage_reads(&reading.writes).is_empty());

        // Once the last read is old, the end of a turn reads again, and
        // the figures are told again whole even where nothing moved.
        aged(&mut stream);
        let reading = turn_of(&mut stream, M2);
        let reads = usage_reads(&reading.writes);
        assert_eq!(reads.len(), 1, "{:?}", reading.writes);
        let told = limits_of(&readings(&mut stream, &[usage_reply(&reads[0], rows())]).events);
        assert_eq!(told.len(), 1);
        assert_eq!(told[0].1.len(), 3);
    }

    #[test]
    fn two_turns_in_quick_succession_ask_once() {
        let (mut stream, read) = ready_reading();
        readings(&mut stream, &[usage_reply(&read, rows())]);
        aged(&mut stream);
        let first = usage_reads(&turn_of(&mut stream, M1).writes);
        assert_eq!(first.len(), 1);
        readings(&mut stream, &[usage_reply(&first[0], rows())]);
        let second = turn_of(&mut stream, M2);
        assert!(
            usage_reads(&second.writes).is_empty(),
            "answered, and too young to ask again"
        );
    }

    #[test]
    fn a_read_never_answered_holds_back_none_past_its_age() {
        let (mut stream, _) = ready_reading();
        let reading = turn_of(&mut stream, M1);
        assert!(usage_reads(&reading.writes).is_empty(), "still young");
        aged(&mut stream);
        let reading = turn_of(&mut stream, M2);
        assert_eq!(
            usage_reads(&reading.writes).len(),
            1,
            "the lost read is gone"
        );
    }

    #[test]
    fn no_read_while_a_message_waits() {
        let (mut stream, read) = ready_reading();
        readings(&mut stream, &[usage_reply(&read, rows())]);
        aged(&mut stream);
        // A message sent during a turn waits for the next one, which the
        // agent starts as soon as this one ends: nothing is read before
        // it, so nothing the window sends waits behind the read.
        sent(&mut stream, M1);
        let reading = readings(&mut stream, &[lifecycle(M1, "started"), init()]);
        assert_eq!(started(&reading.events), [vec![M1.to_string()]]);
        sent(&mut stream, M2);
        let reading = readings(&mut stream, &[result()]);
        assert!(usage_reads(&reading.writes).is_empty());
        let reading = readings(&mut stream, &[lifecycle(M2, "started"), init(), result()]);
        assert_eq!(usage_reads(&reading.writes).len(), 1);
    }

    #[test]
    fn a_read_that_fails_or_is_not_understood_tells_nothing_and_the_session_goes_on() {
        for reply in [
            json!({"subtype":"error","error":"get_usage is not supported in this context"}),
            json!({"subtype":"success","response":{"rate_limits":null,"subscription_type":null}}),
            json!({"subtype":"success","response":{"rate_limits":{"limits":"soon"}}}),
            json!({"subtype":"success","response":"what"}),
        ] {
            let (mut stream, read) = ready_reading();
            let mut reply = reply.clone();
            reply["request_id"] = json!(read);
            let reading = readings(
                &mut stream,
                &[json!({"type":"control_response","response":reply})],
            );
            assert!(reading.events.is_empty(), "{:?}", reading.events);
            assert!(reading.replies.is_empty());
            let reading = turn_of(&mut stream, M1);
            assert!(reading.events.iter().any(|event| matches!(
                event,
                Event::TurnEnded {
                    outcome: Outcome::Done,
                    ..
                }
            )));
            assert!(
                usage_reads(&reading.writes).is_empty(),
                "a read that failed counts towards the next one's age"
            );
            aged(&mut stream);
            assert_eq!(usage_reads(&turn_of(&mut stream, M2).writes).len(), 1);
        }
        // A server with no rows to give has no windows to tell.
        let (mut stream, read) = ready_reading();
        let told = limits_of(&readings(&mut stream, &[usage_reply(&read, json!([]))]).events);
        assert_eq!(told.len(), 1);
        assert!(told[0].1.is_empty());
    }

    #[test]
    fn the_windows_told_are_one_of_each_and_few_with_short_names() {
        let (mut stream, read) = ready_reading();
        let mut rows = vec![
            json!({"kind":"weekly_scoped","percent":10,"scope":{"model":{"display_name":"Fable"}}}),
            json!({"kind":"session","percent":20}),
            json!({"kind":"session","percent":30}),
            json!({"kind":"weekly_scoped","percent":40,"scope":{"model":{"display_name":"Fable"}}}),
            json!({"kind":"weekly_scoped","percent":50,"scope":{"model":{"display_name":"é".repeat(100)}}}),
        ];
        for model in 0..12 {
            rows.push(json!({"kind":"weekly_scoped","percent":1,
                "scope":{"model":{"display_name":format!("Model {model}")}}}));
        }
        let told = limits_of(&readings(&mut stream, &[usage_reply(&read, json!(rows))]).events);
        let windows = &told[0].1;
        assert_eq!(windows.len(), 8, "{windows:?}");
        assert_eq!(windows[0].kind, LimitKind::Session, "kinds in order");
        assert_eq!(windows[0].percent, 20.0, "the first of a kind is kept");
        assert_eq!(windows[1].model.as_deref(), Some("Fable"));
        assert_eq!(windows[1].percent, 10.0);
        let long = windows[2].model.as_deref().unwrap();
        assert_eq!(long, "é".repeat(32), "cut short on a character's edge");
        assert!(
            windows
                .iter()
                .filter(|window| window.model.as_deref() == Some("Fable"))
                .count()
                == 1
        );
    }

    #[test]
    fn an_account_that_is_not_signed_in_is_not_read() {
        let mut stream = stream();
        stream.opening();
        let reading = readings(
            &mut stream,
            &[
                json!({"type":"control_response","response":{"subtype":"success","request_id":"wb-1","response":{
                    "account":{"tokenSource":"none","apiProvider":"firstParty"},"models":[]}}}),
                json!({"type":"control_response","response":{"subtype":"success","request_id":"wb-2","response":{"applied":{}}}}),
            ],
        );
        assert!(usage_reads(&reading.writes).is_empty());
        let reading = readings(&mut stream, &[init(), result()]);
        assert!(usage_reads(&reading.writes).is_empty());
    }

    fn rate_limit(info: Value) -> Value {
        json!({"type":"rate_limit_event","rate_limit_info":info,"uuid":"u","session_id":"s"})
    }

    #[test]
    fn what_each_response_says_of_the_limits_moves_the_windows_it_names() {
        let (mut stream, read) = ready_reading();
        let read_at = limits_of(&readings(&mut stream, &[usage_reply(&read, rows())]).events)[0].2;
        let out = events(
            &mut stream,
            &[
                // The window that limits the agent now, as a fraction.
                rate_limit(json!({"status":"allowed_warning","resetsAt":1_893_480_000,
                    "rateLimitType":"five_hour","utilization":0.5,"isUsingOverage":false})),
                // The same again moves nothing.
                rate_limit(json!({"status":"allowed_warning","resetsAt":1_893_480_000,
                    "rateLimitType":"five_hour","utilization":0.5})),
                // Every window at once; one of a model, and one past its
                // end, which is held at a hundred.
                rate_limit(
                    json!({"status":"allowed","rateLimitType":"seven_day_opus","utilization":0.9,
                    "unifiedWindows":{
                        "seven_day":{"utilization":1.25,"resetsAt":1_893_900_000,"status":"rejected","surpassedThreshold":1},
                        "seven_day_overage_included":{"utilization":0.1,"resetsAt":1_893_900_000}}}),
                ),
                // Nothing it can read.
                rate_limit(json!({"status":"allowed"})),
                rate_limit(json!("limited")),
                json!({"type":"rate_limit_event"}),
            ],
        );
        let told = limits_of(&out);
        assert_eq!(told.len(), 2, "{out:?}");
        assert_eq!(told[0].0.as_deref(), Some("max"), "the plan stays");
        assert_eq!(told[0].2, read_at, "the read is as old as it was");
        assert_eq!(
            told[0].1[0],
            window(
                LimitKind::Session,
                None,
                50.0,
                Some(1_893_480_000),
                Some(LimitSeverity::Warning)
            )
        );
        assert_eq!(told[0].1[1].percent, 40.0, "the week as the read said");
        assert_eq!(
            told[1].1[1],
            window(
                LimitKind::Weekly,
                None,
                100.0,
                Some(1_893_900_000),
                Some(LimitSeverity::Reached)
            )
        );
        assert_eq!(
            told[1].1[2],
            window(
                LimitKind::WeeklyScoped,
                Some("Fable"),
                60.0,
                Some(1_893_801_600),
                Some(LimitSeverity::Warning)
            ),
            "a window of one model moves only with a read"
        );
        assert_eq!(told[1].1.len(), 3);
    }

    #[test]
    fn a_response_before_any_read_tells_the_windows_it_names() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[rate_limit(
                json!({"status":"allowed","rateLimitType":"seven_day","utilization":0.25,
                "unifiedWindows":{"five_hour":{"utilization":0.75,"resetsAt":1_893_480_000}}}),
            )],
        );
        let told = limits_of(&out);
        assert_eq!(told.len(), 1);
        assert_eq!(told[0].0, None);
        assert_eq!(told[0].2, None, "no read yet");
        assert_eq!(
            told[0].1,
            [
                window(LimitKind::Session, None, 75.0, Some(1_893_480_000), None),
                window(
                    LimitKind::Weekly,
                    None,
                    25.0,
                    None,
                    Some(LimitSeverity::Normal)
                ),
            ]
        );
    }

    #[test]
    fn times_are_read_with_their_offsets() {
        let at = |value: Value| moment(&value);
        assert_eq!(at(json!("1970-01-01T00:00:00Z")), Some(0));
        assert_eq!(
            at(json!("2030-01-02T03:04:05.123456+00:00")),
            Some(1_893_553_445)
        );
        assert_eq!(at(json!("2030-01-02T05:04:05+02:00")), Some(1_893_553_445));
        assert_eq!(at(json!("2030-01-01T22:34:05-0430")), Some(1_893_553_445));
        assert_eq!(at(json!("2024-02-29T00:00:00Z")), Some(1_709_164_800));
        assert_eq!(at(json!("2000-03-01T00:00:00Z")), Some(951_868_800));
        assert_eq!(at(json!(1_893_553_445)), Some(1_893_553_445));
        for wrong in [
            json!("2030-01-02T03:04:05"),
            json!("2030-13-02T03:04:05Z"),
            json!("2030-01-02 25:00:00Z"),
            json!("soon"),
            json!("1969-12-31T23:59:59Z"),
            json!("2026-11-19T18:00:00+1é1"),
            json!("999999999999-01-01T00:00:00Z"),
            json!("10000-01-01T00:00:00Z"),
            json!(-5),
            Value::Null,
        ] {
            assert_eq!(at(wrong.clone()), None, "{wrong}");
        }
    }
}
