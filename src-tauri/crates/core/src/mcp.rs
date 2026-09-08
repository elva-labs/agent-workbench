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

use crate::show::{self, ShowRequest};

pub const PROTOCOL_VERSION: &str = "2024-11-05";

/// What the agent is told when it connects.
pub const INSTRUCTIONS: &str = "The user works in Agent Workbench, a desktop app with a file viewer beside this session. When the user asks where something is, or you point them at a particular place in a file, call the show tool with that file and those lines as well as answering in words, so the place opens in front of them. Call it for the answer, once, not for every file you read while looking.";

/// The tool as the agent sees it.
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
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Some(answer) = handle(home, &cwd, &line) else {
            continue;
        };
        let mut out = stdout.lock();
        let _ = writeln!(out, "{answer}");
        let _ = out.flush();
    }
}

/// One message in, at most one out: a notification gets no answer.
pub fn handle(home: &Path, cwd: &Path, line: &str) -> Option<Value> {
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
        "tools/list" => Ok(json!({ "tools": [tool()] })),
        "tools/call" => call(home, cwd, &params),
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

/// The one tool. A path is taken as the agent gave it, resolved against
/// where the agent runs when relative.
fn call(home: &Path, cwd: &Path, params: &Value) -> Result<Value, String> {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    if name != "show" {
        return Err(format!("no such tool: {name}"));
    }
    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
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
    };
    show::append(home, &request)?;
    Ok(json!({
        "content": [{ "type": "text", "text": format!("Shown: {} lines {from} to {to}.", request.path) }]
    }))
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

    #[test]
    fn introduces_itself_with_the_tool_and_the_instructions() {
        let home = home("hello");
        let answer = handle(&home, Path::new("/p"), r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#).unwrap();
        assert_eq!(answer["id"], 1);
        assert_eq!(answer["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert!(answer["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains("show tool"));
        assert!(handle(
            &home,
            Path::new("/p"),
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
        )
        .is_none());
        let tools = handle(
            &home,
            Path::new("/p"),
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        )
        .unwrap();
        assert_eq!(tools["result"]["tools"][0]["name"], "show");
    }

    #[test]
    fn a_call_lands_in_the_log_with_the_path_made_absolute() {
        let home = home("call");
        let cwd = home.join("project");
        std::fs::create_dir_all(cwd.join("infra")).unwrap();
        std::fs::write(cwd.join("infra/variables.tf"), "a\nb\nc\n").unwrap();
        let answer = handle(&home, &cwd, r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"show","arguments":{"path":"infra/variables.tf","from":2,"to":3,"note":"The group."}}}"#).unwrap();
        assert!(answer["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("Shown:"));
        let text = std::fs::read_to_string(show::requests_path(&home)).unwrap();
        let request = show::classify(text.lines().next().unwrap()).unwrap();
        assert!(request.path.ends_with("infra/variables.tf"));
        assert!(Path::new(&request.path).is_absolute());
        assert_eq!((request.from, request.to), (2, 3));
        assert_eq!(request.note.as_deref(), Some("The group."));
        assert_eq!(
            request.cwd,
            dunce::canonicalize(&cwd).unwrap().to_string_lossy()
        );
    }

    #[test]
    fn says_what_is_wrong_with_a_call() {
        let home = home("wrong");
        let missing = handle(&home, Path::new("/p"), r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"show","arguments":{"path":"a.rs"}}}"#).unwrap();
        assert_eq!(missing["result"]["isError"], true);
        let unknown = handle(&home, Path::new("/p"), r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"hide","arguments":{}}}"#).unwrap();
        assert!(unknown["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("no such tool"));
        let method = handle(
            &home,
            Path::new("/p"),
            r#"{"jsonrpc":"2.0","id":6,"method":"resources/list"}"#,
        )
        .unwrap();
        assert_eq!(method["error"]["code"], -32601);
    }
}
