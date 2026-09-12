//! The daemon as an MCP server: what the agent calls to show the user a
//! place in a file.
//!
//! `agent-workbench-remote mcp` speaks the Model Context Protocol over
//! stdin and stdout, one JSON-RPC message a line, and offers the app's own
//! tools, the tools one session starts and directs the others with, and
//! the tools of the plugins running here. A call appends a request to the
//! log the core tails; the window does the rest, or, for a plugin's tool,
//! the plugin's process does, and the call waits here for the answer the
//! core leaves it. The server also hands the agent a few lines of
//! instruction when it starts, so nothing needs writing into the user's
//! own instruction files for the tool to be used at the right moment.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::plugins::{self, PublishedTool};
use crate::show::{
    self, resolve, Answer, ConductRequest, DiffRequest, NotifyRequest, PresentRequest, Request,
    ShowRequest, TerminalRequest, ToolRequest, CONDUCT_TOOLS, MEDIA_EXTENSIONS,
};

pub const PROTOCOL_VERSION: &str = "2024-11-05";

/// What the agent is told when it connects.
pub const INSTRUCTIONS: &str = "The user works in Agent Workbench, a desktop app with a file viewer beside this session. When the user asks where something is, or you point them at a particular place in a file, call the show tool with that file and those lines as well as answering in words, so the place opens in front of them. Call it for the answer, once, not for every file you read while looking. When you point them at what changed in a file, yours or theirs, call the diff tool with the file so its diff opens in front of them. When the user asks to see a screenshot, a diagram or a rendering, or you have made an image, a PDF, a Markdown document, an HTML page or a Mermaid diagram for them, call the present tool with the files so they open in front of them, rendered; several files go in one call. When the user says this, here, or that without naming a file, call the selection tool first: it says what they have open in the viewer and which lines are highlighted. The terminal tool types a command into a terminal for the user to run themselves, a dev server or a watch they asked for; run your own commands yourself. The notify tool leaves one line on this session's row for when the user is in another session: why you stopped or what you need, once, not progress. When the user asks for work across projects or for several things at once, start a session for each with the start tool and wait on them, rather than doing it all here.";

/// The app's own tools, as the agent sees them.
pub fn tools() -> Vec<Value> {
    vec![
        tool(),
        diff_tool(),
        present_tool(),
        selection_tool(),
        terminal_tool(),
        notify_tool(),
    ]
}

/// How long a plugin or the app has to answer a call before the agent is
/// told it did not. A call that is over is over: the answer is dropped if
/// it lands.
pub const ANSWER_WAIT: Duration = Duration::from_secs(60);

/// How long the wait tool waits when the call names no seconds, and the
/// most it waits whatever the call names.
pub const WATCH_WAIT: Duration = Duration::from_secs(600);
pub const WATCH_CAP: Duration = Duration::from_secs(1800);

/// How long the waiting kinds of call may take. The wait tool is the one
/// that sits there for as long as the agent asked; everything else is
/// answered by something that is already running.
#[derive(Debug, Clone, Copy)]
pub struct Waits {
    /// For a tool a plugin or the app answers.
    pub answer: Duration,
    /// For the wait tool, when the call names no seconds.
    pub watching: Duration,
    /// For the wait tool, the most it waits.
    pub longest: Duration,
}

impl Default for Waits {
    fn default() -> Self {
        Self {
            answer: ANSWER_WAIT,
            watching: WATCH_WAIT,
            longest: WATCH_CAP,
        }
    }
}

/// How often the answer is looked for while the call waits.
const POLL: Duration = Duration::from_millis(50);

/// The tools of the plugins running here, as the core published them. No
/// file means no plugin is running.
fn plugin_tools(home: &Path) -> Vec<PublishedTool> {
    std::fs::read_to_string(plugins::tools_path(home))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Every tool the agent may call: the app's own first, the conductor's
/// next, the plugins' after.
fn all_tools(home: &Path) -> Vec<Value> {
    let mut listed = tools();
    listed.extend(conductor_tools());
    for tool in plugin_tools(home) {
        listed.push(json!({
            "name": tool.name,
            "description": tool.description,
            "inputSchema": tool.input_schema,
        }));
    }
    listed
}

/// The terminal tool as the agent sees it.
pub fn terminal_tool() -> Value {
    json!({
        "name": "terminal",
        "description": "Opens a new terminal in the user's Agent Workbench with a command typed into it, not run: the user reads it and presses Enter. Only for a command the user will want to run themselves and keep an eye on, a dev server, a watch, a script they asked to try. Never for a command you need the output of: run those with your own tools. One call, when they ask for it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "The command line, as the user would type it." }
            },
            "required": ["command"]
        }
    })
}

/// The notify tool as the agent sees it.
pub fn notify_tool() -> Value {
    json!({
        "name": "notify",
        "description": "Leaves a few words on this session's row in the user's sessions list, and marks the row as wanting attention. For when the user may be working in another session: why you stopped, what you need from them, what is done. The row has room for about forty characters on one line and cuts the rest off, so write it like a commit subject: 'Tests green, ready to merge', 'Need the API key'. At most once per turn, and only when you stop. Not for progress, and not when you are still working.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": { "type": "string", "description": "A few words, under 60 characters; the row shows about forty." }
            },
            "required": ["text"]
        }
    })
}

/// The diff tool as the agent sees it.
pub fn diff_tool() -> Value {
    json!({
        "name": "diff",
        "description": "Opens a file's changes, its diff against the last commit, in the user's Agent Workbench viewer, with a short note above. Use it when the user asks what changed in a file, or when your answer points at changes you or they made there: one call, for the file you are telling them about. A file with no changes opens as it is.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "The file, relative to the working directory or absolute." },
                "note": { "type": "string", "description": "One sentence on what changed, shown above the diff." }
            },
            "required": ["path"]
        }
    })
}

/// The selection tool as the agent sees it.
pub fn selection_tool() -> Value {
    json!({
        "name": "selection",
        "description": "Says what the user is looking at in Agent Workbench right now: the file open in the viewer, whether as its diff or as it is, the lines they selected in it or that were pointed at, or the images and documents presented to them. Call it when the user refers to this, here, that, or these lines without naming a file. It takes no arguments.",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

pub fn present_tool() -> Value {
    json!({
        "name": "present",
        "description": "Opens one or more images, PDFs, Markdown documents, HTML pages or Mermaid diagrams in front of the user in Agent Workbench, rendered, one under the other with a caption, and keeps them on this session's media list. Use it when the user asks to see a screenshot, a diagram, a rendering or a document you drafted, or when you have made one for them. An HTML page runs in a frame of its own with no access to anything; a Mermaid file or a mermaid fence in a document is drawn. Files must exist; give them in the order to look at them.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "files": {
                    "type": "array",
                    "items": { "type": "string" },
                    "minItems": 1,
                    "maxItems": 12,
                    "description": "The files, relative to the working directory or absolute: png, jpg, gif, webp, svg, bmp, pdf, md, html or mmd."
                },
                "caption": { "type": "string", "description": "One sentence on what the files show." }
            },
            "required": ["files"]
        }
    })
}

/// The conductor's tools, as the agent sees them: what one session calls
/// to start and direct the others.
pub fn conductor_tools() -> Vec<Value> {
    vec![
        projects_tool(),
        sessions_tool(),
        start_tool(),
        send_tool(),
        stop_tool(),
        wait_tool(),
        read_tool(),
    ]
}

/// The projects tool as the agent sees it.
pub fn projects_tool() -> Value {
    json!({
        "name": "projects",
        "description": "The projects open in the user's Agent Workbench, each with its path and whether it is the one you are running in. Call it before starting a session somewhere else, so the project you name is one the app has open. It takes no arguments.",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

/// The sessions tool as the agent sees it.
pub fn sessions_tool() -> Value {
    json!({
        "name": "sessions",
        "description": "The sessions in the user's Agent Workbench: for each one its id, the project and the worktree it runs in, which agent it is, whether it is working, waiting on a question or stopped, and the last line it left. The ids here are what send, stop, wait and read take. Call it to see what is already running before starting anything.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": { "type": "string", "description": "A project's path, to list that project's sessions alone." }
            }
        }
    })
}

/// The start tool as the agent sees it.
pub fn start_tool() -> Value {
    json!({
        "name": "start",
        "description": "Starts a session in the user's Agent Workbench with a prompt, and answers with its id. Use it for work that can run on its own while you carry on here: a change in another project, a long job, one of several things the user asked for at once. The session starts knowing nothing of this conversation, so put everything it needs in the prompt. Then call wait to hear how it went, and send to answer anything it asks.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": { "type": "string", "description": "The project's path, as the projects tool gives it." },
                "prompt": { "type": "string", "description": "What the session is to do, whole: it knows nothing of this conversation." },
                "agent": { "type": "string", "enum": ["claude-code", "codex"], "description": "Which agent to run. The one this project last used when left out." },
                "worktree": { "type": "boolean", "description": "True to run in a worktree of its own, on a branch named after it, so its changes stay off the branch the user is on." }
            },
            "required": ["project", "prompt"]
        }
    })
}

/// The send tool as the agent sees it.
pub fn send_tool() -> Value {
    json!({
        "name": "send",
        "description": "Sends a line to a session, as though the user had typed it: the answer to a question it asked, a correction, or the next thing to do. The session id is one the sessions or start tool answered with. Call wait afterwards to hear what it does next.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session": { "type": "string", "description": "The session's id, as sessions or start gives it." },
                "text": { "type": "string", "description": "The line to send." }
            },
            "required": ["session", "text"]
        }
    })
}

/// The stop tool as the agent sees it.
pub fn stop_tool() -> Value {
    json!({
        "name": "stop",
        "description": "Stops a session in the user's Agent Workbench. The session id is one the sessions or start tool answered with. For work that is finished or no longer wanted; a session that is merely waiting on a question is answered with send instead.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session": { "type": "string", "description": "The session's id, as sessions or start gives it." }
            },
            "required": ["session"]
        }
    })
}

/// The wait tool as the agent sees it.
pub fn wait_tool() -> Value {
    json!({
        "name": "wait",
        "description": "Waits until a session you started stops or asks a question, and says which one and what it said. It blocks and costs nothing while it waits, so wait rather than asking for the sessions again in a loop. With no session named it comes back for whichever of yours moves first. A question a session asks comes back here: relay it to the user, and answer it with the send tool. When nothing has happened by the time it gives up, it says so and you can call it again.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session": { "type": "string", "description": "One session to wait for. Any of the ones you started when left out." },
                "seconds": { "type": "integer", "minimum": 1, "maximum": 1800, "description": "How long to wait before giving up. 600 when left out, 1800 at most." }
            }
        }
    })
}

/// The read tool as the agent sees it.
pub fn read_tool() -> Value {
    json!({
        "name": "read",
        "description": "The recent turns of a session, what it was told and what it said, oldest first. Use it to catch up on a session you started before answering for it or telling the user how it went. The session id is one the sessions or start tool answered with.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session": { "type": "string", "description": "The session's id, as sessions or start gives it." },
                "turns": { "type": "integer", "minimum": 1, "description": "How many of the latest turns to read." }
            },
            "required": ["session"]
        }
    })
}

/// The show tool as the agent sees it.
pub fn tool() -> Value {
    json!({
        "name": "show",
        "description": "Opens a file in the user's Agent Workbench viewer, scrolled to a range of lines with those lines highlighted, and shows a short note above it. Use it when the user asks where something is, or when your answer points at a specific place in a file: one call, for the place you are telling them about.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "The file, relative to the working directory or absolute." },
                "from": { "type": "integer", "minimum": 1, "description": "First line to highlight, 1-based." },
                "to": { "type": "integer", "minimum": 1, "description": "Last line to highlight, inclusive. The same as from for one line." },
                "note": { "type": "string", "description": "One sentence on what is there, shown above the file." }
            },
            "required": ["path", "from"]
        }
    })
}

/// Serves until stdin ends.
pub fn serve(home: &Path) {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    // The agent passes its environment on, and the workbench named the
    // session there when it started the agent.
    let session = std::env::var(crate::adapter::SESSION_VAR)
        .ok()
        .filter(|id| !id.trim().is_empty());
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Some(answer) = handle(home, &cwd, session.as_deref(), &line) else {
            continue;
        };
        let mut out = stdout.lock();
        let _ = writeln!(out, "{answer}");
        let _ = out.flush();
    }
}

/// One message in, at most one out: a notification gets no answer.
pub fn handle(home: &Path, cwd: &Path, session: Option<&str>, line: &str) -> Option<Value> {
    handle_with(home, cwd, session, line, Waits::default())
}

/// One message in, with how long a tool someone else answers has.
pub fn handle_within(
    home: &Path,
    cwd: &Path,
    session: Option<&str>,
    line: &str,
    wait: Duration,
) -> Option<Value> {
    handle_with(
        home,
        cwd,
        session,
        line,
        Waits {
            answer: wait,
            ..Waits::default()
        },
    )
}

/// One message in, with how long each kind of call may take.
pub fn handle_with(
    home: &Path,
    cwd: &Path,
    session: Option<&str>,
    line: &str,
    waits: Waits,
) -> Option<Value> {
    // The directory as the window names it: a temporary directory's link
    // on macOS and a short name on Windows would not match the project.
    let cwd = dunce::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let cwd = cwd.as_path();
    let message: Value = match serde_json::from_str(line) {
        Ok(message) => message,
        Err(_) => return Some(error(Value::Null, -32700, "not JSON")),
    };
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    if id.is_null() {
        // A notification: initialized, cancelled, whatever else. Nothing
        // to say back.
        return None;
    }
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "agent-workbench", "version": env!("CARGO_PKG_VERSION") },
            "instructions": INSTRUCTIONS,
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": all_tools(home) })),
        "tools/call" => call(home, cwd, session, &params, waits),
        _ => return Some(error(id, -32601, &format!("no such method: {method}"))),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(text) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "content": [{ "type": "text", "text": text }], "isError": true }
        }),
    })
}

fn error(id: Value, code: i64, text: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": text } })
}

/// A tool call. A path is taken as the agent gave it, resolved against
/// where the agent runs when relative.
fn call(
    home: &Path,
    cwd: &Path,
    session: Option<&str>,
    params: &Value,
    waits: Waits,
) -> Result<Value, String> {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
    match name {
        "show" => show_call(home, cwd, session, &arguments),
        "diff" => diff_call(home, cwd, session, &arguments),
        "present" => present_call(home, cwd, session, &arguments),
        "selection" => selection_call(home, cwd),
        "terminal" => terminal_call(home, cwd, session, &arguments),
        "notify" => notify_call(home, cwd, session, &arguments),
        _ if CONDUCT_TOOLS.contains(&name) => {
            conduct_call(home, cwd, session, name, &arguments, waits)
        }
        _ => plugin_call(home, cwd, session, name, &arguments, waits.answer),
    }
}

/// How long a wait call waits: what it asked for, no longer than the most
/// on offer, and the usual wait when it asked for nothing.
fn waiting_for(arguments: &Value, waits: &Waits) -> Duration {
    match arguments.get("seconds").and_then(Value::as_u64) {
        Some(seconds) if seconds > 0 => Duration::from_secs(seconds).min(waits.longest),
        _ => waits.watching,
    }
}

/// One of the conductor's tools: the sessions are the app's, so the call
/// goes in the log for the app to answer, and the answer comes back as a
/// file named after the call.
fn conduct_call(
    home: &Path,
    cwd: &Path,
    session: Option<&str>,
    name: &str,
    arguments: &Value,
    waits: Waits,
) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    show::append(
        home,
        &Request::Conduct(ConductRequest {
            id: id.clone(),
            tool: name.to_string(),
            arguments: arguments.clone(),
            cwd: cwd.to_string_lossy().to_string(),
            session: session.map(str::to_string),
        }),
    )?;
    let watching = name == "wait";
    let wait = if watching {
        waiting_for(arguments, &waits)
    } else {
        waits.answer
    };
    let Some(answer) = await_answer(home, &id, wait) else {
        return Err(if watching {
            "nothing happened within that time: no session stopped and none asked anything. Call wait again to go on waiting.".to_string()
        } else {
            format!("the app did not answer the {name} tool within a minute")
        });
    };
    if let Some(error) = answer.error {
        return Err(error);
    }
    Ok(json!({ "content": [{ "type": "text", "text": answer.content.unwrap_or_default() }] }))
}

/// A plugin's tool: the call goes in the log for the core to hand to the
/// plugin, and the answer comes back as a file named after the call.
fn plugin_call(
    home: &Path,
    cwd: &Path,
    session: Option<&str>,
    name: &str,
    arguments: &Value,
    wait: Duration,
) -> Result<Value, String> {
    let found = plugin_tools(home)
        .into_iter()
        .find(|tool| tool.name == name)
        .ok_or_else(|| format!("no such tool: {name}"))?;
    let id = uuid::Uuid::new_v4().to_string();
    show::append(
        home,
        &Request::Tool(ToolRequest {
            id: id.clone(),
            source: found.source,
            plugin: found.plugin,
            tool: found.tool,
            arguments: arguments.clone(),
            cwd: cwd.to_string_lossy().to_string(),
            session: session.map(str::to_string),
        }),
    )?;
    let Some(answer) = await_answer(home, &id, wait) else {
        return Err(format!("the {name} tool did not answer within a minute"));
    };
    if let Some(error) = answer.error {
        return Err(error);
    }
    Ok(json!({ "content": [{ "type": "text", "text": answer.content.unwrap_or_default() }] }))
}

/// Waits for the plugin's answer, and takes it away once it is read.
fn await_answer(home: &Path, id: &str, wait: Duration) -> Option<Answer> {
    let path = show::answer_path(home, id);
    let until = Instant::now() + wait;
    loop {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let _ = std::fs::remove_file(&path);
            return serde_json::from_str(&text).ok().or(Some(Answer {
                content: None,
                error: Some("the plugin answered with something unreadable".to_string()),
            }));
        }
        if Instant::now() >= until {
            return None;
        }
        std::thread::sleep(POLL);
    }
}

/// Media, checked to be there and to be a kind the window shows, so the
/// agent hears about a wrong path now rather than the user seeing a gap.
fn present_call(
    home: &Path,
    cwd: &Path,
    session: Option<&str>,
    arguments: &Value,
) -> Result<Value, String> {
    let given: Vec<String> = arguments
        .get("files")
        .and_then(Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|file| !file.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if given.is_empty() {
        return Err("present needs at least one file".into());
    }
    if given.len() > 12 {
        return Err("present takes twelve files at most".into());
    }
    let mut files = Vec::new();
    for file in &given {
        let absolute = resolve(cwd, file);
        if show::media_type(&absolute).is_none() {
            return Err(format!(
                "{file} is not a kind the workbench shows; it takes {}",
                MEDIA_EXTENSIONS.join(", ")
            ));
        }
        if !absolute.is_file() {
            return Err(format!("{file} is not there, at {}", absolute.display()));
        }
        files.push(absolute.to_string_lossy().to_string());
    }
    let caption = arguments
        .get("caption")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|caption| !caption.is_empty())
        .map(str::to_string);
    let count = files.len();
    show::append(
        home,
        &Request::Present(PresentRequest {
            files,
            caption,
            cwd: cwd.to_string_lossy().to_string(),
            session: session.map(str::to_string),
        }),
    )?;
    let noun = if count == 1 { "file" } else { "files" };
    Ok(json!({ "content": [{ "type": "text", "text": format!("Presented {count} {noun}.") }] }))
}

fn show_call(
    home: &Path,
    cwd: &Path,
    session: Option<&str>,
    arguments: &Value,
) -> Result<Value, String> {
    let path = arguments
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .ok_or("show needs a path")?;
    let from = arguments
        .get("from")
        .and_then(Value::as_u64)
        .filter(|from| *from >= 1)
        .ok_or("show needs a line number, from, of 1 or more")? as u32;
    let to = arguments
        .get("to")
        .and_then(Value::as_u64)
        .map(|to| to as u32)
        .unwrap_or(from)
        .max(from);
    let note = arguments
        .get("note")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|note| !note.is_empty())
        .map(str::to_string);
    let absolute = resolve(cwd, path);
    let request = ShowRequest {
        path: absolute.to_string_lossy().to_string(),
        from,
        to,
        note,
        cwd: cwd.to_string_lossy().to_string(),
        session: session.map(str::to_string),
    };
    let text = format!("Shown: {} lines {from} to {to}.", request.path);
    show::append(home, &Request::Show(request))?;
    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

fn diff_call(
    home: &Path,
    cwd: &Path,
    session: Option<&str>,
    arguments: &Value,
) -> Result<Value, String> {
    let path = arguments
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .ok_or("diff needs a path")?;
    let note = arguments
        .get("note")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|note| !note.is_empty())
        .map(str::to_string);
    let absolute = resolve(cwd, path);
    if !absolute.is_file() {
        return Err(format!("{} is not a file", absolute.display()));
    }
    let request = DiffRequest {
        path: absolute.to_string_lossy().to_string(),
        note,
        cwd: cwd.to_string_lossy().to_string(),
        session: session.map(str::to_string),
    };
    let text = format!("Opened the diff of {}.", request.path);
    show::append(home, &Request::Diff(request))?;
    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

fn terminal_call(
    home: &Path,
    cwd: &Path,
    session: Option<&str>,
    arguments: &Value,
) -> Result<Value, String> {
    let command = arguments
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|command| !command.is_empty())
        .ok_or("terminal needs a command")?;
    // Typed, not run: a carriage return would run it, and an escape
    // sequence could drive the terminal. Only printable text goes in.
    if command.chars().any(char::is_control) {
        return Err("terminal takes one line of printable text".to_string());
    }
    show::append(
        home,
        &Request::Terminal(TerminalRequest {
            command: command.to_string(),
            cwd: cwd.to_string_lossy().to_string(),
            session: session.map(str::to_string),
        }),
    )?;
    Ok(
        json!({ "content": [{ "type": "text", "text": format!("Typed into a new terminal, for the user to run: {command}") }] }),
    )
}

fn notify_call(
    home: &Path,
    cwd: &Path,
    session: Option<&str>,
    arguments: &Value,
) -> Result<Value, String> {
    let text = arguments
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or("notify needs a text")?;
    let line = show::one_line(text);
    show::append(
        home,
        &Request::Notify(NotifyRequest {
            text: line,
            cwd: cwd.to_string_lossy().to_string(),
            session: session.map(str::to_string),
        }),
    )?;
    Ok(json!({ "content": [{ "type": "text", "text": "Left on the session's row." }] }))
}

/// What the user is looking at, in words, when it is in this project.
fn selection_call(home: &Path, cwd: &Path) -> Result<Value, String> {
    let text = describe_selection(crate::selection::read(home).as_ref(), cwd);
    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

pub fn describe_selection(selection: Option<&crate::selection::Selection>, cwd: &Path) -> String {
    let Some(selection) = selection else {
        return "The user has nothing open in the viewer.".to_string();
    };
    let project = dunce::canonicalize(&selection.project)
        .unwrap_or_else(|_| PathBuf::from(&selection.project));
    let cwd = dunce::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    if !cwd.starts_with(&project) && !project.starts_with(&cwd) {
        return format!(
            "The user is looking at another project, {}, not this one.",
            selection.project
        );
    }
    // A file is named as the window named it, under the project as the
    // window named that, or under its canonical form.
    let recorded = Path::new(&selection.project);
    let relative = |path: &str| {
        let file = Path::new(path);
        file.strip_prefix(recorded)
            .or_else(|_| file.strip_prefix(&project))
            .map(|rest| rest.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string())
    };
    if let Some(media) = &selection.media {
        let files: Vec<String> = media.files.iter().map(|file| relative(file)).collect();
        let caption = media
            .caption
            .as_deref()
            .map(|caption| format!(" Caption: {caption}"))
            .unwrap_or_default();
        return format!(
            "The user is looking at what was presented: {}.{caption}",
            files.join(", ")
        );
    }
    let Some(file) = &selection.file else {
        return "The user has nothing open in the viewer.".to_string();
    };
    let what = match selection.view.as_deref() {
        Some("diff") => "its diff against the last commit",
        _ => "the file as it is",
    };
    let lines = match (selection.from, selection.to) {
        (Some(from), Some(to)) if to > from => format!(", lines {from} to {to} highlighted"),
        (Some(from), _) => format!(", line {from} highlighted"),
        _ => String::new(),
    };
    format!(
        "The user is looking at {} in the viewer, {what}{lines}.",
        relative(file)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("workbench-mcp-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn first(home: &Path) -> Request {
        let text = std::fs::read_to_string(show::requests_path(home)).unwrap();
        show::classify(text.lines().next().unwrap()).unwrap()
    }

    /// One plugin tool published, as a running plugin's greeting leaves it.
    fn publish_a_tool(home: &Path) {
        let path = plugins::tools_path(home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let tools = json!([{
            "name": "github_pr",
            "description": "The branch's pull request.",
            "inputSchema": { "type": "object", "properties": { "state": { "type": "string" } } },
            "source": "workbench-plugins-1",
            "plugin": "github",
            "tool": "pr",
        }]);
        std::fs::write(&path, serde_json::to_string(&tools).unwrap()).unwrap();
    }

    /// Answers the tool call as it lands, the way the core does once the
    /// plugin has spoken.
    fn answer_the_call(home: &Path, answer: Answer) {
        let home = home.to_path_buf();
        std::thread::spawn(move || {
            for _ in 0..200 {
                let text = std::fs::read_to_string(show::requests_path(&home)).unwrap_or_default();
                let call = text
                    .lines()
                    .rev()
                    .find_map(|line| match show::classify(line) {
                        Some(Request::Tool(call)) => Some(call),
                        _ => None,
                    });
                if let Some(call) = call {
                    show::write_answer(&home, &call.id, &answer).unwrap();
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
    }

    /// Answers the conductor's call as it lands, the way the window does
    /// once it has looked.
    fn answer_the_conduct_call(home: &Path, answer: Answer) {
        let home = home.to_path_buf();
        std::thread::spawn(move || {
            for _ in 0..200 {
                let text = std::fs::read_to_string(show::requests_path(&home)).unwrap_or_default();
                let call = text
                    .lines()
                    .rev()
                    .find_map(|line| match show::classify(line) {
                        Some(Request::Conduct(call)) => Some(call),
                        _ => None,
                    });
                if let Some(call) = call {
                    show::write_answer(&home, &call.id, &answer).unwrap();
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
    }

    #[test]
    fn lists_a_plugin_tool_after_the_app_s_own() {
        let home = home("plugin-list");
        let ask = |home: &Path| {
            let listed = handle(
                home,
                Path::new("/p"),
                None,
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
            )
            .unwrap();
            listed["result"]["tools"].as_array().unwrap().clone()
        };
        assert_eq!(ask(&home).len(), 13);
        publish_a_tool(&home);
        let listed = ask(&home);
        let names: Vec<&str> = listed
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "show",
                "diff",
                "present",
                "selection",
                "terminal",
                "notify",
                "projects",
                "sessions",
                "start",
                "send",
                "stop",
                "wait",
                "read",
                "github_pr"
            ]
        );
        assert_eq!(listed[13]["description"], "The branch's pull request.");
        assert_eq!(
            listed[13]["inputSchema"]["properties"]["state"]["type"],
            "string"
        );
    }

    #[test]
    fn a_plugin_call_lands_in_the_log_and_answers_with_what_the_plugin_said() {
        let home = home("plugin-call");
        publish_a_tool(&home);
        answer_the_call(
            &home,
            Answer {
                content: Some("#42 Retry with jitter".into()),
                error: None,
            },
        );
        let answer = handle_within(&home, Path::new("/p"), Some("s-1"), r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"github_pr","arguments":{"state":"open"}}}"#, Duration::from_secs(10)).unwrap();
        assert_eq!(
            answer["result"]["content"][0]["text"],
            "#42 Retry with jitter"
        );
        assert!(answer["result"]["isError"].is_null());
        let Request::Tool(call) = first(&home) else {
            panic!("not a tool request");
        };
        assert!(!call.id.is_empty());
        assert_eq!(call.source, "workbench-plugins-1");
        assert_eq!(call.plugin, "github");
        assert_eq!(call.tool, "pr");
        assert_eq!(call.arguments["state"], "open");
        assert_eq!(call.session.as_deref(), Some("s-1"));
        // The answer is taken away once it has been read.
        assert!(!show::answer_path(&home, &call.id).exists());
    }

    #[test]
    fn a_plugin_s_error_comes_back_as_a_tool_error() {
        let home = home("plugin-error");
        publish_a_tool(&home);
        answer_the_call(
            &home,
            Answer {
                content: None,
                error: Some("gh is not logged in".into()),
            },
        );
        let answer = handle_within(&home, Path::new("/p"), None, r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"github_pr","arguments":{}}}"#, Duration::from_secs(10)).unwrap();
        assert_eq!(answer["result"]["isError"], true);
        assert_eq!(
            answer["result"]["content"][0]["text"],
            "gh is not logged in"
        );
    }

    #[test]
    fn a_plugin_that_does_not_answer_is_reported_to_the_agent() {
        let home = home("plugin-silent");
        publish_a_tool(&home);
        let answer = handle_within(&home, Path::new("/p"), None, r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"github_pr","arguments":{}}}"#, Duration::from_millis(150)).unwrap();
        assert_eq!(answer["result"]["isError"], true);
        assert_eq!(
            answer["result"]["content"][0]["text"],
            "the github_pr tool did not answer within a minute"
        );
        let unknown = handle_within(&home, Path::new("/p"), None, r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"github_issues","arguments":{}}}"#, Duration::from_millis(150)).unwrap();
        assert!(unknown["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("no such tool"));
    }

    #[test]
    fn introduces_itself_with_the_tools_and_the_instructions() {
        let home = home("hello");
        let answer = handle(&home, Path::new("/p"), None, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#).unwrap();
        assert_eq!(answer["id"], 1);
        assert_eq!(answer["result"]["protocolVersion"], PROTOCOL_VERSION);
        let instructions = answer["result"]["instructions"].as_str().unwrap();
        assert!(instructions.contains("show tool"));
        assert!(instructions.contains("present tool"));
        assert!(handle(
            &home,
            Path::new("/p"),
            None,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
        )
        .is_none());
        let tools = handle(
            &home,
            Path::new("/p"),
            None,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        )
        .unwrap();
        let names: Vec<&str> = tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "show",
                "diff",
                "present",
                "selection",
                "terminal",
                "notify",
                "projects",
                "sessions",
                "start",
                "send",
                "stop",
                "wait",
                "read"
            ]
        );
        assert!(instructions.contains("start tool"));
    }

    #[test]
    fn the_conductor_s_tools_come_after_the_app_s_own_and_say_what_they_take() {
        let home = home("conductor-list");
        let listed = handle(
            &home,
            Path::new("/p"),
            None,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
        )
        .unwrap();
        let listed = listed["result"]["tools"].as_array().unwrap().clone();
        assert_eq!(listed.len(), 13);
        let named = |name: &str| {
            listed
                .iter()
                .find(|tool| tool["name"] == name)
                .unwrap()
                .clone()
        };
        let start = named("start");
        assert_eq!(
            start["inputSchema"]["required"],
            json!(["project", "prompt"])
        );
        assert_eq!(
            start["inputSchema"]["properties"]["agent"]["enum"],
            json!(["claude-code", "codex"])
        );
        assert_eq!(
            start["inputSchema"]["properties"]["worktree"]["type"],
            "boolean"
        );
        assert!(start["description"]
            .as_str()
            .unwrap()
            .contains("on its own"));
        let wait = named("wait");
        assert_eq!(
            wait["inputSchema"]["properties"]["seconds"]["maximum"],
            1800
        );
        assert!(wait["description"].as_str().unwrap().contains("blocks"));
        assert_eq!(
            named("send")["inputSchema"]["required"],
            json!(["session", "text"])
        );
        assert_eq!(named("stop")["inputSchema"]["required"], json!(["session"]));
        assert_eq!(named("read")["inputSchema"]["required"], json!(["session"]));
        assert_eq!(named("projects")["inputSchema"]["properties"], json!({}));
        assert_eq!(
            named("sessions")["inputSchema"]["properties"]["project"]["type"],
            "string"
        );
    }

    #[test]
    fn a_call_lands_in_the_log_with_the_path_made_absolute() {
        let home = home("call");
        let cwd = home.join("project");
        std::fs::create_dir_all(cwd.join("infra")).unwrap();
        std::fs::write(cwd.join("infra/variables.tf"), "a\nb\nc\n").unwrap();
        let answer = handle(&home, &cwd, None, r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"show","arguments":{"path":"infra/variables.tf","from":2,"to":3,"note":"The group."}}}"#).unwrap();
        assert!(answer["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("Shown:"));
        let Request::Show(request) = first(&home) else {
            panic!("a show request");
        };
        assert!(request
            .path
            .replace('\\', "/")
            .ends_with("infra/variables.tf"));
        assert!(Path::new(&request.path).is_absolute());
        assert_eq!((request.from, request.to), (2, 3));
        assert_eq!(request.note.as_deref(), Some("The group."));
        assert_eq!(
            request.cwd,
            dunce::canonicalize(&cwd).unwrap().to_string_lossy()
        );
    }

    #[test]
    fn a_diff_call_lands_in_the_log_and_needs_a_file_that_is_there() {
        let home = home("workbench-mcp-diff");
        let cwd = home.join("project");
        std::fs::create_dir_all(cwd.join("src")).unwrap();
        std::fs::write(cwd.join("src/a.rs"), "a\n").unwrap();
        let answer = handle(&home, &cwd, Some("s-4"), r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"diff","arguments":{"path":"src/a.rs","note":"The rename."}}}"#).unwrap();
        assert!(answer["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("Opened the diff of "));
        let Request::Diff(request) = first(&home) else {
            panic!("not a diff request");
        };
        assert!(request.path.ends_with("a.rs"));
        assert_eq!(request.note.as_deref(), Some("The rename."));
        assert_eq!(request.session.as_deref(), Some("s-4"));
        let missing = handle(&home, &cwd, None, r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"diff","arguments":{"path":"src/b.rs"}}}"#).unwrap();
        assert_eq!(missing["result"]["isError"], true);
    }

    #[test]
    fn a_terminal_call_and_a_notify_call_land_in_the_log() {
        let home = home("workbench-mcp-terminal");
        let cwd = home.join("project");
        std::fs::create_dir_all(&cwd).unwrap();
        let said = handle(&home, &cwd, Some("s-8"), r#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"terminal","arguments":{"command":"  npm run dev "}}}"#).unwrap();
        assert_eq!(
            said["result"]["content"][0]["text"],
            "Typed into a new terminal, for the user to run: npm run dev"
        );
        let Request::Terminal(request) = first(&home) else {
            panic!("not a terminal request");
        };
        assert_eq!(request.command, "npm run dev");
        assert_eq!(request.session.as_deref(), Some("s-8"));
        for command in ["a\nb", "npm\rtest", "echo \u{001b}[2J", "a\tb"] {
            let refused = handle(&home, &cwd, None, &format!(r#"{{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{{"name":"terminal","arguments":{{"command":{}}}}}}}"#, serde_json::to_string(command).unwrap())).unwrap();
            assert_eq!(refused["result"]["isError"], true, "{command:?}");
        }

        let home = self::home("workbench-mcp-notify");
        let noted = handle(&home, &cwd, Some("s-9"), r#"{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"notify","arguments":{"text":"Tests green,\n  ready to merge."}}}"#).unwrap();
        assert_eq!(
            noted["result"]["content"][0]["text"],
            "Left on the session's row."
        );
        let Request::Notify(request) = first(&home) else {
            panic!("not a notify request");
        };
        assert_eq!(request.text, "Tests green, ready to merge.");
        assert_eq!(request.session.as_deref(), Some("s-9"));
        let empty = handle(&home, &cwd, None, r#"{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"notify","arguments":{"text":"  "}}}"#).unwrap();
        assert_eq!(empty["result"]["isError"], true);
    }

    #[test]
    fn the_selection_is_told_in_words_for_this_project_only() {
        use crate::selection::{Presented, Selection};
        let home = home("workbench-mcp-selection");
        let cwd = home.join("project");
        std::fs::create_dir_all(&cwd).unwrap();
        let ask = |home: &Path| {
            handle(home, &cwd, None, r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"selection","arguments":{}}}"#)
                .unwrap()["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .to_string()
        };
        assert_eq!(ask(&home), "The user has nothing open in the viewer.");
        let project = cwd.to_string_lossy().to_string();
        crate::selection::write(
            &home,
            Some(&Selection {
                project: project.clone(),
                file: Some(format!("{project}/src/a.rs")),
                view: Some("diff".into()),
                from: Some(3),
                to: Some(5),
                media: None,
            }),
        )
        .unwrap();
        assert_eq!(
            ask(&home),
            "The user is looking at src/a.rs in the viewer, its diff against the last commit, lines 3 to 5 highlighted."
        );
        crate::selection::write(
            &home,
            Some(&Selection {
                project: project.clone(),
                file: None,
                view: None,
                from: None,
                to: None,
                media: Some(Presented {
                    files: vec![format!("{project}/shots/one.png")],
                    caption: Some("Before.".into()),
                }),
            }),
        )
        .unwrap();
        assert_eq!(
            ask(&home),
            "The user is looking at what was presented: shots/one.png. Caption: Before."
        );
        crate::selection::write(
            &home,
            Some(&Selection {
                project: "/elsewhere".into(),
                file: Some("/elsewhere/x".into()),
                view: None,
                from: None,
                to: None,
                media: None,
            }),
        )
        .unwrap();
        assert!(ask(&home).starts_with("The user is looking at another project"));
    }

    #[test]
    fn presents_files_that_are_there_and_refuses_the_rest() {
        let home = home("present");
        let cwd = home.join("project");
        std::fs::create_dir_all(cwd.join("shots")).unwrap();
        std::fs::write(cwd.join("shots/one.png"), [1]).unwrap();
        std::fs::write(cwd.join("shots/two.pdf"), [1]).unwrap();
        let answer = handle(&home, &cwd, Some("s-7"), r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"present","arguments":{"files":["shots/one.png","shots/two.pdf"],"caption":"Both."}}}"#).unwrap();
        assert_eq!(answer["result"]["content"][0]["text"], "Presented 2 files.");
        let Request::Present(request) = first(&home) else {
            panic!("a present request");
        };
        assert_eq!(request.files.len(), 2);
        assert!(request.files[0]
            .replace('\\', "/")
            .ends_with("shots/one.png"));
        assert_eq!(request.caption.as_deref(), Some("Both."));
        assert_eq!(request.session.as_deref(), Some("s-7"));

        let missing = handle(&home, &cwd, None, r#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"present","arguments":{"files":["shots/three.png"]}}}"#).unwrap();
        assert_eq!(missing["result"]["isError"], true);
        assert!(missing["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("not there"));
        let kind = handle(&home, &cwd, None, r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"present","arguments":{"files":["shots/clip.mp4"]}}}"#).unwrap();
        assert!(kind["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("not a kind"));
        let none = handle(&home, &cwd, None, r#"{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"present","arguments":{"files":[]}}}"#).unwrap();
        assert_eq!(none["result"]["isError"], true);
    }

    #[test]
    fn a_start_call_lands_in_the_log_and_answers_with_what_the_app_said() {
        let home = home("conduct-start");
        answer_the_conduct_call(
            &home,
            Answer {
                content: Some("Started session s-2.".into()),
                error: None,
            },
        );
        let answer = handle_within(&home, Path::new("/p"), Some("s-1"), r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"start","arguments":{"project":"/p","prompt":"Fix the flake","worktree":true}}}"#, Duration::from_secs(10)).unwrap();
        assert_eq!(
            answer["result"]["content"][0]["text"],
            "Started session s-2."
        );
        assert!(answer["result"]["isError"].is_null());
        let Request::Conduct(call) = first(&home) else {
            panic!("not a conduct request");
        };
        assert!(!call.id.is_empty());
        assert_eq!(call.tool, "start");
        assert_eq!(call.arguments["prompt"], "Fix the flake");
        assert_eq!(call.arguments["worktree"], true);
        assert_eq!(call.cwd, "/p");
        assert_eq!(call.session.as_deref(), Some("s-1"));
        // The answer is taken away once it has been read.
        assert!(!show::answer_path(&home, &call.id).exists());
    }

    #[test]
    fn the_app_s_error_on_a_conduct_call_comes_back_as_a_tool_error() {
        let home = home("conduct-error");
        answer_the_conduct_call(
            &home,
            Answer {
                content: None,
                error: Some("there is no project at /nowhere".into()),
            },
        );
        let answer = handle_within(&home, Path::new("/p"), None, r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"start","arguments":{"project":"/nowhere","prompt":"go"}}}"#, Duration::from_secs(10)).unwrap();
        assert_eq!(answer["result"]["isError"], true);
        assert_eq!(
            answer["result"]["content"][0]["text"],
            "there is no project at /nowhere"
        );
    }

    #[test]
    fn an_app_that_does_not_answer_is_reported_to_the_agent() {
        let home = home("conduct-silent");
        let answer = handle_within(&home, Path::new("/p"), None, r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"sessions","arguments":{}}}"#, Duration::from_millis(150)).unwrap();
        assert_eq!(answer["result"]["isError"], true);
        assert_eq!(
            answer["result"]["content"][0]["text"],
            "the app did not answer the sessions tool within a minute"
        );
    }

    #[test]
    fn waiting_takes_the_seconds_the_call_names_and_says_when_nothing_happened() {
        let home = home("conduct-wait");
        let waits = Waits {
            answer: Duration::from_millis(50),
            watching: Duration::from_millis(60),
            longest: Duration::from_millis(120),
        };
        // Half an hour asked for, and the cap is what it waits.
        let started = Instant::now();
        let answer = handle_with(&home, Path::new("/p"), None, r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"wait","arguments":{"seconds":1800}}}"#, waits).unwrap();
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(answer["result"]["isError"], true);
        let text = answer["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.starts_with("nothing happened within that time"),
            "{text}"
        );
        let Request::Conduct(call) = first(&home) else {
            panic!("not a conduct request");
        };
        assert_eq!(call.tool, "wait");
        assert_eq!(call.arguments["seconds"], 1800);

        // Asked for nothing, and the default is what it waits.
        let home = self::home("conduct-wait-default");
        let started = Instant::now();
        let answer = handle_with(&home, Path::new("/p"), None, r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"wait","arguments":{}}}"#, waits).unwrap();
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(answer["result"]["isError"], true);

        // A wait that is answered comes back with what the app said.
        let home = self::home("conduct-wait-answered");
        answer_the_conduct_call(
            &home,
            Answer {
                content: Some("s-2 is asking: which branch?".into()),
                error: None,
            },
        );
        let answer = handle_with(&home, Path::new("/p"), None, r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"wait","arguments":{"seconds":9}}}"#, Waits::default()).unwrap();
        assert_eq!(
            answer["result"]["content"][0]["text"],
            "s-2 is asking: which branch?"
        );
    }

    #[test]
    fn the_wait_is_what_the_call_asked_for_within_the_bounds() {
        let waits = Waits::default();
        assert_eq!(waiting_for(&json!({}), &waits), WATCH_WAIT);
        assert_eq!(waiting_for(&json!({"seconds": 0}), &waits), WATCH_WAIT);
        assert_eq!(waiting_for(&json!({"seconds": "ten"}), &waits), WATCH_WAIT);
        assert_eq!(
            waiting_for(&json!({"seconds": 30}), &waits),
            Duration::from_secs(30)
        );
        assert_eq!(waiting_for(&json!({"seconds": 9000}), &waits), WATCH_CAP);
    }

    #[test]
    fn says_what_is_wrong_with_a_call() {
        let home = home("wrong");
        let missing = handle(&home, Path::new("/p"), None, r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"show","arguments":{"path":"a.rs"}}}"#).unwrap();
        assert_eq!(missing["result"]["isError"], true);
        let unknown = handle(&home, Path::new("/p"), None, r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"hide","arguments":{}}}"#).unwrap();
        assert!(unknown["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("no such tool"));
        let method = handle(
            &home,
            Path::new("/p"),
            None,
            r#"{"jsonrpc":"2.0","id":6,"method":"resources/list"}"#,
        )
        .unwrap();
        assert_eq!(method["error"]["code"], -32601);
    }
}
