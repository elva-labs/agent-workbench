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

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::adapter::{
    prepare_process, process, CLAUDE_CONFIG_VAR, ORCHESTRATOR_ROLE, ROLE_VAR, SESSION_VAR,
};
use crate::env::find_on_path;
use crate::hook;
use crate::integrated::{
    Choice, CommandInfo, Control, Driver, ErrorKind, Event, FileChange, Hunk, Image, Launch,
    ModelInfo, Offer, Outcome, Protocol, Reading, TaskKind, Usage,
};

pub struct ClaudeStream;

pub static CLAUDE_STREAM: ClaudeStream = ClaudeStream;

/// The name the workbench's tool server goes by, the same as when it is
/// written into the agent's own configuration, so its tools are named the
/// same either way.
const TOOL_SERVER: &str = "agent-workbench";

/// The media types the agent takes an image in.
const IMAGE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

/// The arguments that make `claude` a stream session. `-p` with stream-json
/// both ways keeps it running for as long as stdin is open; `--verbose` is
/// required for stream-json output; the partial messages are the text as it
/// streams; subagent text comes only when forwarded; and the permission
/// prompts come to this side over stdio rather than being denied.
const STREAM_ARGS: &[&str] = &[
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--forward-subagent-text",
    "--permission-prompt-tool",
    "stdio",
];

/// A model or a mode goes on the command line as a value, and is checked
/// to be one: never empty, never something that reads as a flag.
fn checked<'a>(what: &str, value: &'a str) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty() || value.starts_with('-') || value.chars().any(char::is_control) {
        return Err(format!("{value:?} is not a {what}"));
    }
    Ok(value)
}

impl Protocol for ClaudeStream {
    fn name(&self) -> &'static str {
        "claude"
    }

    fn command(&self, launch: &Launch) -> Result<std::process::Command, String> {
        let binary = find_on_path(launch.env, "claude").ok_or_else(|| {
            "claude was not found on your PATH. Install Claude Code, or check that \
             it is on the PATH your login shell sets up."
                .to_string()
        })?;
        let mut command = process(&binary, launch.env);
        command.args(STREAM_ARGS);
        if let Some(mode) = launch.permission_mode {
            command.args(["--permission-mode", checked("permission mode", mode)?]);
        }
        if let Some(model) = launch.model {
            command.args(["--model", checked("model", model)?]);
        }
        let session = checked("session id", launch.session)?;
        if launch.resume {
            command.args(["--resume", session]);
        } else {
            command.args(["--session-id", session]);
        }
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
            // Last, since the flag takes as many values as follow it.
            command.args(["--mcp-config", &config.to_string()]);
        }

        prepare_process(&mut command, launch.project, launch.env);
        // The tool server the agent starts reads which session it serves,
        // and whether that session directs the others, from these.
        command.env(SESSION_VAR, launch.session);
        if launch.orchestrator {
            command.env(ROLE_VAR, ORCHESTRATOR_ROLE);
        }
        if let Some(dir) = launch.config_dir {
            command.env(CLAUDE_CONFIG_VAR, dir);
        }
        Ok(command)
    }

    fn driver(&self, launch: &Launch) -> Box<dyn Driver> {
        Box::new(Stream::new(
            launch.session,
            launch.model,
            launch.permission_mode,
        ))
    }

    fn trusted(&self, home: &Path, config_dir: Option<&Path>, folder: &Path) -> bool {
        hook::claude_trusts(&state_file(home, config_dir), folder)
    }

    fn trust(&self, home: &Path, config_dir: Option<&Path>, folder: &Path) -> Result<(), String> {
        hook::claude_trust(&state_file(home, config_dir), folder)
    }
}

/// The file Claude Code keeps its state in, trust among it: in the
/// account's configuration directory, or in the home directory for its
/// own.
fn state_file(home: &Path, config_dir: Option<&Path>) -> PathBuf {
    match config_dir {
        Some(dir) => dir.join(".claude.json"),
        None => home.join(".claude.json"),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Thinking,
    Tool,
}

/// A control request this side sent, by what its reply means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sent {
    Initialize,
    Interrupt,
    Model,
    Mode,
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

/// One session's reading of the stream.
struct Stream {
    session: String,
    model: Option<String>,
    mode: Option<String>,
    next: u64,
    sent: HashMap<String, Sent>,
    asked: HashMap<String, Asked>,
    /// The API message being streamed, by the subagent call it belongs to.
    streaming: HashMap<Option<String>, String>,
    /// Blocks being streamed, by message and index: their kind and id.
    open: HashMap<(String, u64), (Kind, String)>,
    /// Blocks done streaming whose whole form has not come yet, by message.
    closed: HashMap<String, VecDeque<(Kind, String)>>,
    /// Tool calls whose start has been told, by the subagent call they
    /// belong to.
    calls: HashMap<String, Option<String>>,
    /// Tasks running, by the tool call that started each.
    tasks: HashMap<String, Option<String>>,
    interrupting: bool,
    minted: u64,
}

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

fn usage(value: &Value) -> Option<Usage> {
    value.is_object().then(|| Usage {
        input_tokens: value["input_tokens"].as_u64().unwrap_or(0),
        output_tokens: value["output_tokens"].as_u64().unwrap_or(0),
        cache_read_tokens: value["cache_read_input_tokens"].as_u64().unwrap_or(0),
        cache_write_tokens: value["cache_creation_input_tokens"].as_u64().unwrap_or(0),
    })
}

/// The file a tool changed, from the structured result the agent gives
/// beside the plain one: a new file with its content, or an edit with its
/// patch.
fn file_change(result: &Value) -> Option<FileChange> {
    let path = result["filePath"].as_str()?;
    let created = result["type"] == "create";
    let hunks = result["structuredPatch"].as_array();
    if !created && hunks.is_none() {
        return None;
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
                lines: hunk["lines"]
                    .as_array()?
                    .iter()
                    .filter_map(|line| line.as_str().map(str::to_string))
                    .collect(),
            })
        })
        .collect();
    Some(FileChange {
        path: path.to_string(),
        kind: if created { "create" } else { "update" }.to_string(),
        hunks,
        content: created.then(|| text(&result["content"])).flatten(),
    })
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
    fn new(session: &str, model: Option<&str>, mode: Option<&str>) -> Self {
        Self {
            session: session.to_string(),
            model: model.map(str::to_string),
            mode: mode.map(str::to_string),
            next: 0,
            sent: HashMap::new(),
            asked: HashMap::new(),
            streaming: HashMap::new(),
            open: HashMap::new(),
            closed: HashMap::new(),
            calls: HashMap::new(),
            tasks: HashMap::new(),
            interrupting: false,
            minted: 0,
        }
    }

    fn request(&mut self, sent: Sent, request: Value) -> (String, String) {
        self.next += 1;
        let id = format!("wb-{}", self.next);
        self.sent.insert(id.clone(), sent);
        let line = json!({ "type": "control_request", "request_id": id, "request": request });
        (line.to_string(), id)
    }

    /// Takes a model or a mode as the agent now reports it, and says so
    /// when either changed.
    fn configure(&mut self, model: Option<String>, mode: Option<String>, out: &mut Reading) {
        let mut changed = false;
        if model.is_some() && model != self.model {
            self.model = model;
            changed = true;
        }
        if mode.is_some() && mode != self.mode {
            self.mode = mode;
            changed = true;
        }
        if changed {
            out.events.push(Event::Configured {
                model: self.model.clone(),
                permission_mode: self.mode.clone(),
            });
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

    fn stream_event(&mut self, event: &Value, parent: Option<String>, out: &mut Reading) {
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
                        self.calls.insert(call.to_string(), parent.clone());
                        out.events.push(Event::ToolStarted {
                            call: call.to_string(),
                            parent: parent.clone(),
                            name: block["name"].as_str().unwrap_or_default().to_string(),
                        });
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
        let message = &line["message"];
        let id = message["id"].as_str().unwrap_or_default().to_string();
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
                    if !self.calls.contains_key(call) {
                        self.calls.insert(call.to_string(), parent.clone());
                        out.events.push(Event::ToolStarted {
                            call: call.to_string(),
                            parent: parent.clone(),
                            name: block["name"].as_str().unwrap_or_default().to_string(),
                        });
                    }
                    out.events.push(Event::ToolInput {
                        call: call.to_string(),
                        parent: parent.clone(),
                        delta: None,
                        input: Some(block["input"].clone()),
                    });
                }
                _ => {}
            }
        }
    }

    fn user(&mut self, line: &Value, parent: Option<String>, out: &mut Reading) {
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
                change: single
                    .then(|| file_change(&line["tool_use_result"]))
                    .flatten(),
            });
        }
    }

    fn system(&mut self, line: &Value, out: &mut Reading) {
        match line["subtype"].as_str() {
            // Every turn opens with the agent describing itself.
            Some("init") => {
                out.events.push(Event::TurnStarted { message: None });
                self.configure(text(&line["model"]), text(&line["permissionMode"]), out);
            }
            Some("status") => {
                if line["status"] == "compacting" {
                    out.events.push(Event::Compacting);
                }
                self.configure(None, text(&line["permissionMode"]), out);
            }
            Some("compact_boundary") => {
                let meta = &line["compact_metadata"];
                out.events.push(Event::Compacted {
                    trigger: text(&meta["trigger"]),
                    tokens_before: meta["pre_tokens"].as_u64(),
                    tokens_after: meta["post_tokens"].as_u64(),
                });
            }
            Some("task_started") => {
                let Some(task) = line["task_id"].as_str() else {
                    return;
                };
                let call = text(&line["tool_use_id"]);
                self.tasks.insert(task.to_string(), call.clone());
                out.events.push(Event::TaskStarted {
                    task: task.to_string(),
                    call,
                    kind: match line["task_type"].as_str() {
                        Some("local_agent" | "remote_agent") => TaskKind::Agent,
                        Some("local_bash") => TaskKind::Shell,
                        _ => TaskKind::Other,
                    },
                    description: text(&line["description"]),
                    prompt: text(&line["prompt"]),
                    background: line["is_backgrounded"].as_bool().unwrap_or(true),
                });
            }
            Some("task_progress") => {
                let Some(task) = line["task_id"].as_str() else {
                    return;
                };
                out.events.push(Event::TaskProgress {
                    task: task.to_string(),
                    call: text(&line["tool_use_id"])
                        .or_else(|| self.tasks.get(task).cloned().flatten()),
                    tool: text(&line["last_tool_name"]),
                    description: text(&line["description"]),
                });
            }
            Some("task_notification") => {
                let Some(task) = line["task_id"].as_str() else {
                    return;
                };
                let known = self.tasks.remove(task).flatten();
                out.events.push(Event::TaskFinished {
                    task: task.to_string(),
                    call: text(&line["tool_use_id"]).or(known),
                    status: text(&line["status"]).unwrap_or_else(|| "completed".into()),
                    summary: text(&line["summary"]),
                });
            }
            _ => {}
        }
    }

    fn result(&mut self, line: &Value, out: &mut Reading) {
        let failed = line["is_error"].as_bool().unwrap_or(false);
        let outcome = match line["subtype"].as_str() {
            Some("success") if !failed => Outcome::Done,
            Some("error_during_execution") if self.interrupting => Outcome::Interrupted,
            _ => Outcome::Failed,
        };
        self.interrupting = false;
        let error = (outcome == Outcome::Failed).then(|| {
            let said = line["result"].as_str().unwrap_or_default();
            let errors: Vec<&str> = line["errors"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
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
            cost_usd: line["total_cost_usd"].as_f64(),
            duration_ms: line["duration_ms"].as_u64(),
            usage: usage(&line["usage"]),
        });
    }

    /// A control request from the agent: a permission to ask, or something
    /// this side does not do, which is answered as such.
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
        let asked = Asked {
            input: request["input"].clone(),
            suggestions: request["permission_suggestions"]
                .as_array()
                .cloned()
                .unwrap_or_default(),
        };
        let call = text(&request["tool_use_id"]);
        out.events.push(Event::PermissionAsked {
            request: id.to_string(),
            parent: call
                .as_deref()
                .and_then(|call| self.calls.get(call).cloned().flatten()),
            call,
            tool,
            input: asked.input.clone(),
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
        let sent = self.sent.remove(id);
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
            Some(Sent::Initialize) => {
                let body = body.cloned().unwrap_or(Value::Null);
                self.configure(
                    None,
                    text(&body["current_permission_mode"]),
                    &mut Reading::default(),
                );
                out.events.push(Event::Ready {
                    session_id: self.session.clone(),
                    model: self.model.clone(),
                    permission_mode: self.mode.clone(),
                    version: text(&body["claude_code_version"]),
                    models: body["models"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|model| {
                            Some(ModelInfo {
                                value: model["value"].as_str()?.to_string(),
                                name: text(&model["displayName"]),
                                description: text(&model["description"]),
                            })
                        })
                        .collect(),
                    commands: body["commands"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|command| {
                            Some(CommandInfo {
                                name: command["name"].as_str()?.to_string(),
                                description: text(&command["description"]),
                                hint: text(&command["argumentHint"]).filter(|h| !h.is_empty()),
                            })
                        })
                        .collect(),
                });
                if signed_out(&body["account"]) {
                    out.events.push(Event::Error {
                        kind: ErrorKind::NotLoggedIn,
                        message: NOT_LOGGED_IN.to_string(),
                    });
                }
            }
            Some(Sent::Model) => {
                if let Some(model) = body.and_then(|b| text(&b["model"])) {
                    self.configure(Some(model), None, out);
                }
            }
            Some(Sent::Mode) => {
                if let Some(mode) = body.and_then(|b| text(&b["mode"])) {
                    self.configure(None, Some(mode), out);
                }
            }
            Some(Sent::Interrupt) | None => {}
        }
        out.replies.push((id.to_string(), reply));
    }
}

impl Driver for Stream {
    fn opening(&mut self) -> Vec<String> {
        // Optional for the agent, and what it answers with is what the
        // window needs before the first turn.
        let (line, _) = self.request(Sent::Initialize, json!({ "subtype": "initialize" }));
        vec![line]
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
            Some("control_request") => self.asked(&value, &mut out),
            Some("control_cancel_request") => {
                if let Some(id) = value["request_id"].as_str() {
                    if self.asked.remove(id).is_some() {
                        out.events.push(Event::PermissionWithdrawn {
                            request: id.to_string(),
                        });
                    }
                }
            }
            Some("control_response") => self.answered(&value, &mut out),
            _ => {}
        }
        out
    }

    fn message(&mut self, text: &str, images: &[Image]) -> Result<String, String> {
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
        Ok(json!({
            "type": "user",
            "message": { "role": "user", "content": content },
            "parent_tool_use_id": null,
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
            Choice::Cancel => json!({
                "behavior": "deny",
                "message": said.unwrap_or("The user declined this and stopped the turn."),
                "interrupt": true,
            }),
        };
        self.asked.remove(request);
        Ok(json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": request, "response": response },
        })
        .to_string())
    }

    fn control(&mut self, control: &Control) -> Result<(String, String), String> {
        Ok(match control {
            Control::Interrupt => {
                self.interrupting = true;
                self.request(Sent::Interrupt, json!({ "subtype": "interrupt" }))
            }
            Control::SetModel(model) => {
                let model = checked("model", model)?.to_string();
                self.request(
                    Sent::Model,
                    json!({ "subtype": "set_model", "model": model }),
                )
            }
            Control::SetPermissionMode(mode) => {
                let mode = checked("permission mode", mode)?.to_string();
                self.request(
                    Sent::Mode,
                    json!({ "subtype": "set_permission_mode", "mode": mode }),
                )
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream() -> Stream {
        Stream::new("s-1", Some("haiku"), None)
    }

    fn events(stream: &mut Stream, lines: &[Value]) -> Vec<Event> {
        lines
            .iter()
            .flat_map(|line| stream.read(&line.to_string()).events)
            .collect()
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
            .map(|event| match event {
                Event::Text {
                    block, text, done, ..
                } => (block.clone(), text.clone(), *done),
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
        assert_eq!(
            out[0],
            Event::ToolStarted {
                call: "t1".into(),
                parent: None,
                name: "Edit".into()
            }
        );
        assert!(
            matches!(&out[1], Event::ToolInput { delta: Some(d), .. } if d == "{\"file_path\":")
        );
        assert!(
            matches!(&out[2], Event::ToolInput { input: Some(i), delta: None, .. } if i["file_path"] == "/p/a.txt")
        );
        let Event::ToolFinished {
            output,
            change: Some(change),
            error: false,
            ..
        } = &out[3]
        else {
            panic!("{:?}", out[3]);
        };
        assert_eq!(output, "ok");
        assert_eq!(change.kind, "update");
        assert_eq!(change.hunks[0].lines, ["-one", "+two"]);
        assert_eq!(out.len(), 4, "{out:?}");
    }

    #[test]
    fn a_new_file_comes_with_its_content() {
        let change = file_change(&json!({"type":"create","filePath":"/p/n.txt","content":"one\n","structuredPatch":[],"originalFile":null})).unwrap();
        assert_eq!(change.kind, "create");
        assert_eq!(change.content.as_deref(), Some("one\n"));
        // A tool that only read a file changed nothing.
        assert!(file_change(&json!({"type":"text","file":{"filePath":"/p/n.txt"}})).is_none());
        assert!(file_change(&json!("Error: no")).is_none());
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

    #[test]
    fn an_interrupted_turn_says_so_and_a_failed_one_says_why() {
        let mut stream = stream();
        stream.control(&Control::Interrupt).unwrap();
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
        } = &out[0]
        else {
            panic!("{out:?}");
        };
        assert_eq!(*outcome, Outcome::Failed);
        assert_eq!(error.as_deref(), Some("Not logged in · Please run /login"));
        assert_eq!(usage.as_ref().unwrap().input_tokens, 3);
    }

    #[test]
    fn signed_out_is_told_at_the_start_and_on_the_first_message() {
        let mut stream = stream();
        let (line, id) = (stream.opening().remove(0), "wb-1");
        assert!(line.contains("initialize"));
        let reading = stream.read(
            &json!({"type":"control_response","response":{"subtype":"success","request_id":id,"response":{
                "account":{"tokenSource":"none","apiProvider":"firstParty"},
                "current_permission_mode":"default","claude_code_version":"9.9.9",
                "models":[{"value":"haiku","displayName":"Haiku","description":"fast"}],
                "commands":[{"name":"compact","description":"Compact","argumentHint":""}]}}})
            .to_string(),
        );
        let Event::Ready {
            model,
            permission_mode,
            version,
            models,
            commands,
            ..
        } = &reading.events[0]
        else {
            panic!("{:?}", reading.events);
        };
        assert_eq!(model.as_deref(), Some("haiku"));
        assert_eq!(permission_mode.as_deref(), Some("default"));
        assert_eq!(version.as_deref(), Some("9.9.9"));
        assert_eq!(models[0].name.as_deref(), Some("Haiku"));
        assert_eq!(commands[0].hint, None);
        assert!(matches!(
            reading.events[1],
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
            out[0],
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
                json!({"type":"system","subtype":"task_notification","task_id":"a1","status":"completed","summary":"found"}),
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
            matches!(&out[3], Event::TaskFinished { call: Some(c), summary: Some(s), .. } if c == "t1" && s == "found")
        );
    }

    #[test]
    fn model_and_mode_changes_are_told_once_each() {
        let mut stream = stream();
        let (_, key) = stream.control(&Control::SetModel("sonnet".into())).unwrap();
        let reading = stream.read(
            &json!({"type":"control_response","response":{"subtype":"success","request_id":key,"response":{"model":"claude-sonnet"}}}).to_string(),
        );
        assert_eq!(reading.replies[0].0, key);
        assert_eq!(
            reading.events,
            [Event::Configured {
                model: Some("claude-sonnet".into()),
                permission_mode: None
            }]
        );
        // The same model again from the next turn's description is no news.
        let out = events(
            &mut stream,
            &[json!({"type":"system","subtype":"init","model":"claude-sonnet"})],
        );
        assert_eq!(out, [Event::TurnStarted { message: None }]);

        let (_, key) = stream.control(&Control::SetModel("nope".into())).unwrap();
        let reading = stream.read(
            &json!({"type":"control_response","response":{"subtype":"error","request_id":key,"error":"Model 'nope' not found"}}).to_string(),
        );
        assert_eq!(reading.replies[0].1, Err("Model 'nope' not found".into()));
        assert!(reading.events.is_empty());
        assert!(stream.control(&Control::SetModel("--bare".into())).is_err());
    }

    #[test]
    fn images_go_as_content_blocks_beside_the_text() {
        let mut stream = stream();
        let line: Value = serde_json::from_str(
            &stream
                .message(
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
        assert!(stream.message("  ", &[]).is_err());
        assert!(stream
            .message(
                "x",
                &[Image {
                    media_type: "text/html".into(),
                    data: "AAAA".into()
                }]
            )
            .is_err());
        let plain: Value = serde_json::from_str(&stream.message("hi", &[]).unwrap()).unwrap();
        assert_eq!(plain["message"]["content"], "hi");
    }

    #[test]
    fn compaction_is_told_from_start_to_finish() {
        let mut stream = stream();
        let out = events(
            &mut stream,
            &[
                json!({"type":"system","subtype":"status","status":"compacting"}),
                json!({"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"manual","pre_tokens":100,"post_tokens":10}}),
            ],
        );
        assert_eq!(out[0], Event::Compacting);
        assert_eq!(
            out[1],
            Event::Compacted {
                trigger: Some("manual".into()),
                tokens_before: Some(100),
                tokens_after: Some(10)
            }
        );
    }
}
