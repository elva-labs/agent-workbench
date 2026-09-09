//! The daemon as an MCP server: what the agent calls to show the user a
//! place in a file.
//!
//! `agent-workbench-remote mcp` speaks the Model Context Protocol over
//! stdin and stdout, one JSON-RPC message a line, and offers one tool,
//! `show`. A call appends a request to the log the core tails; the window
//! does the rest. The server also hands the agent a few lines of
//! instruction when it starts, so nothing needs writing into the user's
//! own instruction files for the tool to be used at the right moment.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::show::{
    self, DiffRequest, NotifyRequest, PresentRequest, Request, ShowRequest, TerminalRequest,
    MEDIA_EXTENSIONS,
};

pub const PROTOCOL_VERSION: &str = "2024-11-05";

/// What the agent is told when it connects.
pub const INSTRUCTIONS: &str = "The user works in Agent Workbench, a desktop app with a file viewer beside this session. When the user asks where something is, or you point them at a particular place in a file, call the show tool with that file and those lines as well as answering in words, so the place opens in front of them. Call it for the answer, once, not for every file you read while looking. When you point them at what changed in a file, yours or theirs, call the diff tool with the file so its diff opens in front of them. When the user asks to see a screenshot, a diagram or a rendering, or you have made an image, a PDF, a Markdown document, an HTML page or a Mermaid diagram for them, call the present tool with the files so they open in front of them, rendered; several files go in one call. When the user says this, here, or that without naming a file, call the selection tool first: it says what they have open in the viewer and which lines are highlighted. The terminal tool types a command into a terminal for the user to run themselves, a dev server or a watch they asked for; run your own commands yourself. The notify tool leaves one line on this session's row for when the user is in another session: why you stopped or what you need, once, not progress.";

/// The tools as the agent sees them.
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
        "description": "Leaves one line of text on this session's row in the user's sessions list, and marks the row as wanting attention. For when the user may be working in another session: why you stopped, what you need from them, what is done. One short sentence, at most once per turn, and only when you stop. Not for progress, and not when you are still working.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": { "type": "string", "description": "One sentence, under 120 characters." }
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
        "description": "Says what the user is looking at in Agent Workbench right now: the file open in the viewer, whether as its diff or as it is, the lines highlighted in it, or the images and documents presented to them. Call it when the user refers to this, here, that, or these lines without naming a file. It takes no arguments.",
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
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => call(home, cwd, session, &params),
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
fn call(home: &Path, cwd: &Path, session: Option<&str>, params: &Value) -> Result<Value, String> {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
    match name {
        "show" => show_call(home, cwd, session, &arguments),
        "diff" => diff_call(home, cwd, session, &arguments),
        "present" => present_call(home, cwd, session, &arguments),
        "selection" => selection_call(home, cwd),
        "terminal" => terminal_call(home, cwd, session, &arguments),
        "notify" => notify_call(home, cwd, session, &arguments),
        _ => Err(format!("no such tool: {name}")),
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

/// How much of a note the row shows: one line, so the rest is dropped.
const NOTE_CAP: usize = 160;

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
    let line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let line: String = line.chars().take(NOTE_CAP).collect();
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

fn resolve(cwd: &Path, path: &str) -> PathBuf {
    let given = Path::new(path);
    let joined = if given.is_absolute() {
        given.to_path_buf()
    } else {
        cwd.join(given)
    };
    dunce::canonicalize(&joined).unwrap_or(joined)
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
            ["show", "diff", "present", "selection", "terminal", "notify"]
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
