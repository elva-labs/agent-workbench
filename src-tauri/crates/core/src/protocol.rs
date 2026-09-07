//! The wire between a window and a core that is somewhere else.
//!
//! One JSON object a line, both ways. The window sends requests; the core
//! answers each by id and, in between, sends events, the same ones it would
//! emit to a window of its own, plus one more for a pty's bytes. Method
//! names and parameters are the desktop app's own command names and
//! arguments, so the app can forward what its window asked for as it is.

use std::path::PathBuf;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::events::Output;
use crate::Core;

/// The event that carries a pty's bytes, base64 in `data`, since a line of
/// JSON cannot hold them raw.
pub const PTY_OUTPUT: &str = "pty_output";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// What the core sends: an answer to a request, or news.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum Message {
    Response {
        id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Event {
        event: String,
        payload: Value,
    },
}

impl Message {
    pub fn ok(id: u64, result: Value) -> Self {
        Message::Response {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: u64, error: impl Into<String>) -> Self {
        Message::Response {
            id,
            result: None,
            error: Some(error.into()),
        }
    }

    pub fn event(event: &str, payload: Value) -> Self {
        Message::Event {
            event: event.to_string(),
            payload,
        }
    }

    /// The event for a pty's bytes.
    pub fn output(id: &str, bytes: &[u8]) -> Self {
        Message::event(
            PTY_OUTPUT,
            json!({ "id": id, "data": base64::engine::general_purpose::STANDARD.encode(bytes) }),
        )
    }
}

/// The bytes of a `pty_output` event, or None for anything else.
pub fn output_bytes(event: &str, payload: &Value) -> Option<(String, Vec<u8>)> {
    if event != PTY_OUTPUT {
        return None;
    }
    let id = payload.get("id")?.as_str()?.to_string();
    let data = payload.get("data")?.as_str()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .ok()?;
    Some((id, bytes))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnParams {
    agent: String,
    project: PathBuf,
    #[serde(default)]
    cwd: Option<PathBuf>,
    #[serde(default)]
    session: Option<String>,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellParams {
    project: PathBuf,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
struct PathParams {
    path: PathBuf,
}

#[derive(Deserialize)]
struct ProjectParams {
    project: PathBuf,
}

#[derive(Deserialize)]
struct RootParams {
    root: PathBuf,
}

#[derive(Deserialize)]
struct IdParams {
    id: String,
}

#[derive(Deserialize)]
struct AgentParams {
    id: String,
}

#[derive(Deserialize)]
struct SessionsParams {
    project: PathBuf,
    agent: String,
}

#[derive(Deserialize)]
struct TitleParams {
    agent: String,
    id: String,
}

#[derive(Deserialize)]
struct GrepParams {
    root: PathBuf,
    query: String,
    scope: String,
}

#[derive(Deserialize)]
struct FileParams {
    root: PathBuf,
    file: String,
}

#[derive(Deserialize)]
struct WriteParams {
    id: String,
    data: String,
}

#[derive(Deserialize)]
struct ResizeParams {
    id: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
struct DirsParams {
    #[serde(default)]
    path: String,
}

fn parse<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|e| format!("bad parameters: {e}"))
}

fn value<T: Serialize>(result: T) -> Result<Value, String> {
    serde_json::to_value(result).map_err(|e| format!("could not encode the result: {e}"))
}

/// Runs one request against the core. A pty started here gets its output
/// from `make_output`, given the new pty's id.
pub fn dispatch(
    core: &Core,
    method: &str,
    params: Value,
    make_output: impl FnOnce(&str) -> Output,
) -> Result<Value, String> {
    match method {
        "ping" => Ok(json!({ "version": env!("CARGO_PKG_VERSION") })),
        "home" => Ok(json!(core
            .home()
            .map(|home| home.to_string_lossy().to_string()))),
        "agent_detect" => {
            let p: AgentParams = parse(params)?;
            value(core.detect(&p.id)?)
        }
        "pty_spawn" => {
            let p: SpawnParams = parse(params)?;
            value(core.spawn(
                &p.agent,
                &p.project,
                p.cwd.as_deref(),
                p.session,
                p.cols,
                p.rows,
                make_output,
            )?)
        }
        "pty_shell" => {
            let p: ShellParams = parse(params)?;
            value(core.shell(&p.project, p.cols, p.rows, make_output)?)
        }
        "project_info" => {
            let p: PathParams = parse(params)?;
            value(core.project_info(&p.path)?)
        }
        "hook_status" => {
            let p: ProjectParams = parse(params)?;
            value(core.hook_status(&p.project)?)
        }
        "hook_install" => {
            let p: ProjectParams = parse(params)?;
            value(core.hook_install(&p.project)?)
        }
        "hook_uninstall" => {
            let p: ProjectParams = parse(params)?;
            value(core.hook_uninstall(&p.project)?)
        }
        "sessions_list" => {
            let p: SessionsParams = parse(params)?;
            value(core.sessions_list(&p.project, &p.agent))
        }
        "session_title" => {
            let p: TitleParams = parse(params)?;
            value(core.session_title(&p.agent, &p.id))
        }
        "git_status" => {
            let p: RootParams = parse(params)?;
            value(core.git_status(&p.root)?)
        }
        "git_files" => {
            let p: RootParams = parse(params)?;
            value(core.git_files(&p.root)?)
        }
        "git_grep" => {
            let p: GrepParams = parse(params)?;
            value(core.git_grep(&p.root, &p.query, &p.scope)?)
        }
        "git_diff" => {
            let p: FileParams = parse(params)?;
            value(core.git_diff(&p.root, &p.file)?)
        }
        "git_content" => {
            let p: FileParams = parse(params)?;
            value(core.git_content(&p.root, &p.file)?)
        }
        "git_watch" => {
            let p: RootParams = parse(params)?;
            core.git_watch(&p.root)?;
            Ok(Value::Null)
        }
        "git_unwatch" => {
            core.git_unwatch();
            Ok(Value::Null)
        }
        "pty_write" => {
            let p: WriteParams = parse(params)?;
            core.pty_write(&p.id, p.data.as_bytes())?;
            Ok(Value::Null)
        }
        "pty_resize" => {
            let p: ResizeParams = parse(params)?;
            core.pty_resize(&p.id, p.cols, p.rows)?;
            Ok(Value::Null)
        }
        "pty_kill" => {
            let p: IdParams = parse(params)?;
            core.pty_kill(&p.id)?;
            Ok(Value::Null)
        }
        "pty_cwd" => {
            let p: IdParams = parse(params)?;
            value(core.pty_cwd(&p.id)?)
        }
        "list_dirs" => {
            let p: DirsParams = parse(params)?;
            value(core.list_dirs(&p.path)?)
        }
        other => Err(format!("no such method: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::testing::Recorder;
    use std::sync::Arc;
    #[cfg(unix)]
    use std::sync::Mutex;

    fn core() -> Core {
        Core::new(Arc::new(Recorder::default()))
    }

    fn no_output(_: &str) -> Output {
        Box::new(|_| true)
    }

    #[test]
    fn a_line_is_a_request_and_the_answer_names_it() {
        let request: Request =
            serde_json::from_str(r#"{"id":7,"method":"ping","params":{}}"#).unwrap();
        assert_eq!(request.method, "ping");
        let answer = Message::ok(request.id, json!({"version": "x"}));
        let line = serde_json::to_string(&answer).unwrap();
        assert_eq!(line, r#"{"id":7,"result":{"version":"x"}}"#);
        let back: Message = serde_json::from_str(&line).unwrap();
        assert_eq!(back, answer);
    }

    #[test]
    fn params_may_be_left_out() {
        let request: Request = serde_json::from_str(r#"{"id":1,"method":"home"}"#).unwrap();
        assert_eq!(request.params, Value::Null);
    }

    #[test]
    fn an_error_carries_no_result() {
        let line = serde_json::to_string(&Message::err(3, "no")).unwrap();
        assert_eq!(line, r#"{"id":3,"error":"no"}"#);
    }

    #[test]
    fn events_and_output_tell_apart() {
        let event = Message::event("git_changed", json!("/repo"));
        let line = serde_json::to_string(&event).unwrap();
        assert!(line.starts_with(r#"{"event":"git_changed""#));
        let Message::Event { event, payload } = Message::output("pty-1", b"hi\n") else {
            panic!("output is an event");
        };
        assert_eq!(
            output_bytes(&event, &payload),
            Some(("pty-1".into(), b"hi\n".to_vec()))
        );
        assert_eq!(output_bytes("git_changed", &json!("/repo")), None);
    }

    #[test]
    fn answers_a_ping_with_the_version() {
        let result = dispatch(&core(), "ping", Value::Null, no_output).unwrap();
        assert_eq!(result["version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn says_which_method_it_does_not_have() {
        let error = dispatch(&core(), "make_coffee", Value::Null, no_output).unwrap_err();
        assert!(error.contains("make_coffee"));
    }

    #[test]
    fn bad_parameters_are_an_error_not_a_panic() {
        let error = dispatch(&core(), "git_status", json!({"nope": 1}), no_output).unwrap_err();
        assert!(error.contains("bad parameters"));
    }

    #[test]
    fn takes_the_window_s_own_argument_names() {
        let params = json!({"agent": "codex", "id": "abc"});
        assert_eq!(
            dispatch(&core(), "session_title", params, no_output).unwrap(),
            Value::Null
        );
        let dir = std::env::temp_dir().join("workbench-protocol-dirs");
        std::fs::create_dir_all(dir.join("one")).unwrap();
        let dirs = dispatch(&core(), "list_dirs", json!({"path": dir}), no_output).unwrap();
        assert_eq!(dirs[0]["name"], "one");
    }

    #[cfg(unix)]
    #[test]
    fn a_shell_s_bytes_come_back_labelled_with_its_id() {
        let core = core();
        let frames = Arc::new(Mutex::new(Vec::<Message>::new()));
        let params = json!({"project": "/tmp", "cols": 80, "rows": 24});
        let id = dispatch(&core, "pty_shell", params, {
            let frames = Arc::clone(&frames);
            move |id: &str| {
                let id = id.to_string();
                Box::new(move |bytes: &[u8]| {
                    frames.lock().unwrap().push(Message::output(&id, bytes));
                    true
                })
            }
        })
        .unwrap();
        let id = id.as_str().unwrap().to_string();
        dispatch(
            &core,
            "pty_write",
            json!({"id": id, "data": "echo marker-$((40+2))\nexit\n"}),
            no_output,
        )
        .unwrap();
        let mut text = String::new();
        for _ in 0..100 {
            text = frames
                .lock()
                .unwrap()
                .iter()
                .filter_map(|frame| match frame {
                    Message::Event { event, payload } => output_bytes(event, payload),
                    _ => None,
                })
                .map(|(frame_id, bytes)| {
                    assert_eq!(frame_id, id);
                    String::from_utf8_lossy(&bytes).to_string()
                })
                .collect();
            if text.contains("marker-42") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(text.contains("marker-42"), "{text}");
    }
}
