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

use crate::account::Dirs;
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
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    config_dir: Option<String>,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IntegratedStartParams {
    agent: String,
    project: PathBuf,
    #[serde(default)]
    cwd: Option<PathBuf>,
    #[serde(default)]
    session: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    effort: Option<String>,
    #[serde(default)]
    config_dir: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IntegratedTrustParams {
    agent: String,
    project: PathBuf,
    #[serde(default)]
    cwd: Option<PathBuf>,
    #[serde(default)]
    config_dir: Option<String>,
}

#[derive(Deserialize)]
struct IntegratedSendParams {
    id: String,
    message: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    images: Vec<crate::integrated::Image>,
}

#[derive(Deserialize)]
struct IntegratedAnswerParams {
    id: String,
    request: String,
    choice: crate::integrated::Choice,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize)]
struct IntegratedReplyParams {
    id: String,
    request: String,
    answers: Option<Vec<Vec<String>>>,
}

#[derive(Deserialize)]
struct IntegratedConfigureParams {
    id: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    effort: Option<String>,
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

/// A call's answer, however it is named: the conductor's tools and the
/// browser's both answer through the one underlying method, which just
/// writes where the tool server named `id` waits.
#[derive(Deserialize)]
struct AnswerParams {
    id: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct WorktreeParams {
    project: PathBuf,
    name: String,
    #[serde(default)]
    accounts: Vec<Dirs>,
}

#[derive(Deserialize)]
struct SelectionParams {
    selection: Option<crate::selection::Selection>,
}

#[derive(Deserialize)]
struct ProjectParams {
    project: PathBuf,
}

/// A project and the user's accounts, for what is written into each
/// account's agent state for the project.
#[derive(Deserialize)]
struct HookParams {
    project: PathBuf,
    #[serde(default)]
    accounts: Vec<Dirs>,
}

#[derive(Deserialize)]
struct HookManyParams {
    projects: Vec<PathBuf>,
    #[serde(default)]
    accounts: Vec<Dirs>,
}

#[derive(Deserialize)]
struct RootParams {
    root: PathBuf,
}

#[derive(Deserialize)]
struct ShownParams {
    #[serde(default)]
    files: Vec<PathBuf>,
}

#[derive(Deserialize)]
struct IdParams {
    id: String,
}

#[derive(Deserialize)]
struct ProcessParams {
    id: String,
    pid: u32,
}

#[derive(Deserialize)]
struct PluginAddParams {
    location: String,
    reference: Option<String>,
}

#[derive(Deserialize)]
struct PluginEnableParams {
    id: String,
    name: String,
    on: bool,
}

#[derive(Deserialize)]
struct PluginProjectsParams {
    paths: Vec<String>,
}

#[derive(Deserialize)]
struct PluginActionParams {
    source: String,
    plugin: String,
    section: String,
    action: String,
    #[serde(default)]
    row: Option<String>,
    #[serde(default)]
    input: Value,
    project: String,
}

#[derive(Deserialize)]
struct PluginViewMessageParams {
    source: String,
    plugin: String,
    project: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Deserialize)]
struct AgentParams {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionsParams {
    project: PathBuf,
    agent: String,
    #[serde(default)]
    config_dir: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionsManyParams {
    projects: Vec<PathBuf>,
    agent: String,
    #[serde(default)]
    config_dir: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TitleParams {
    agent: String,
    id: String,
    #[serde(default)]
    config_dir: Option<String>,
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
struct FileWriteParams {
    root: PathBuf,
    file: String,
    text: String,
    #[serde(default)]
    stamp: Option<String>,
    #[serde(default)]
    overwrite: bool,
}

#[derive(Deserialize)]
struct RenameParams {
    root: PathBuf,
    from: String,
    to: String,
}

#[derive(Deserialize)]
struct TreePathParams {
    root: PathBuf,
    path: String,
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
                p.prompt.as_deref(),
                p.model.as_deref(),
                p.config_dir.as_deref(),
                p.cols,
                p.rows,
                make_output,
            )?)
        }
        "integrated_start" => {
            let p: IntegratedStartParams = parse(params)?;
            value(core.integrated_start(
                &p.agent,
                &p.project,
                p.cwd.as_deref(),
                p.session,
                p.model.as_deref(),
                p.mode.as_deref(),
                p.effort.as_deref(),
                p.config_dir.as_deref(),
            )?)
        }
        "integrated_trust" => {
            let p: IntegratedTrustParams = parse(params)?;
            core.integrated_trust(
                &p.agent,
                &p.project,
                p.cwd.as_deref(),
                p.config_dir.as_deref(),
            )?;
            Ok(Value::Null)
        }
        "integrated_send" => {
            let p: IntegratedSendParams = parse(params)?;
            core.integrated_send(&p.id, &p.message, &p.text, &p.images)?;
            Ok(Value::Null)
        }
        "integrated_interrupt" => {
            let p: IdParams = parse(params)?;
            core.integrated_interrupt(&p.id)?;
            Ok(Value::Null)
        }
        "integrated_compact" => {
            let p: IdParams = parse(params)?;
            core.integrated_compact(&p.id)?;
            Ok(Value::Null)
        }
        "integrated_answer" => {
            let p: IntegratedAnswerParams = parse(params)?;
            core.integrated_answer(&p.id, &p.request, p.choice, p.message.as_deref())?;
            Ok(Value::Null)
        }
        "integrated_reply" => {
            let p: IntegratedReplyParams = parse(params)?;
            core.integrated_reply(&p.id, &p.request, p.answers.as_deref())?;
            Ok(Value::Null)
        }
        "integrated_configure" => {
            let p: IntegratedConfigureParams = parse(params)?;
            value(core.integrated_configure(
                &p.id,
                p.model.as_deref(),
                p.mode.as_deref(),
                p.effort.as_deref(),
            )?)
        }
        "integrated_snapshot" => {
            let p: IdParams = parse(params)?;
            value(core.integrated_snapshot(&p.id)?)
        }
        "integrated_stop" => {
            let p: IdParams = parse(params)?;
            core.integrated_stop(&p.id)?;
            Ok(Value::Null)
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
            let p: HookParams = parse(params)?;
            value(core.hook_status(&p.project, &p.accounts)?)
        }
        "hook_status_many" => {
            let p: HookManyParams = parse(params)?;
            value(core.hook_status_many(&p.projects, &p.accounts)?)
        }
        "hook_install" => {
            let p: HookParams = parse(params)?;
            value(core.hook_install(&p.project, &p.accounts)?)
        }
        "hook_uninstall" => {
            let p: HookParams = parse(params)?;
            value(core.hook_uninstall(&p.project, &p.accounts)?)
        }
        "sessions_list" => {
            let p: SessionsParams = parse(params)?;
            value(core.sessions_list(&p.project, &p.agent, p.config_dir.as_deref()))
        }
        "sessions_list_many" => {
            let p: SessionsManyParams = parse(params)?;
            value(core.sessions_list_many(&p.projects, &p.agent, p.config_dir.as_deref()))
        }
        "session_title" => {
            let p: TitleParams = parse(params)?;
            value(core.session_title(&p.agent, &p.id, p.config_dir.as_deref()))
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
        "file_read" => {
            let p: FileParams = parse(params)?;
            value(core.file_read(&p.root, &p.file)?)
        }
        "file_write" => {
            let p: FileWriteParams = parse(params)?;
            value(core.file_write(&p.root, &p.file, &p.text, p.stamp.as_deref(), p.overwrite)?)
        }
        "path_rename" => {
            let p: RenameParams = parse(params)?;
            core.path_rename(&p.root, &p.from, &p.to)?;
            Ok(Value::Null)
        }
        "path_delete" => {
            let p: TreePathParams = parse(params)?;
            core.path_delete(&p.root, &p.path)?;
            Ok(Value::Null)
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
        "watch_shown" => {
            let p: ShownParams = parse(params)?;
            core.watch_shown(&p.files);
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
        "pty_processes" => {
            let p: IdParams = parse(params)?;
            value(core.pty_processes(&p.id)?)
        }
        "pty_stop_process" => {
            let p: ProcessParams = parse(params)?;
            core.pty_stop_process(&p.id, p.pid)?;
            Ok(Value::Null)
        }
        "plugin_sources" => value(core.plugin_sources()?),
        "plugin_add" => {
            let p: PluginAddParams = parse(params)?;
            value(core.plugin_add(&p.location, p.reference.as_deref())?)
        }
        "plugin_fetch" => {
            let p: IdParams = parse(params)?;
            value(core.plugin_fetch(&p.id)?)
        }
        "plugin_remove" => {
            let p: IdParams = parse(params)?;
            core.plugin_remove(&p.id)?;
            Ok(Value::Null)
        }
        "plugin_check" => {
            let p: IdParams = parse(params)?;
            value(core.plugin_check(&p.id)?)
        }
        "plugin_update" => {
            let p: IdParams = parse(params)?;
            value(core.plugin_update(&p.id)?)
        }
        "plugin_enable" => {
            let p: PluginEnableParams = parse(params)?;
            value(core.plugin_enable(&p.id, &p.name, p.on)?)
        }
        "plugin_projects" => {
            let p: PluginProjectsParams = parse(params)?;
            core.plugin_projects(p.paths)?;
            Ok(Value::Null)
        }
        "plugin_action" => {
            let p: PluginActionParams = parse(params)?;
            core.plugin_action(
                &p.source,
                &p.plugin,
                &p.section,
                &p.action,
                p.row.as_deref(),
                &p.input,
                &p.project,
            )?;
            Ok(Value::Null)
        }
        "plugin_view_message" => {
            let p: PluginViewMessageParams = parse(params)?;
            core.plugin_view_message(&p.source, &p.plugin, &p.project, &p.payload)?;
            Ok(Value::Null)
        }
        "list_dirs" => {
            let p: DirsParams = parse(params)?;
            value(core.list_dirs(&p.path)?)
        }
        "read_media" => {
            let p: PathParams = parse(params)?;
            value(core.read_media(&p.path)?)
        }
        "set_selection" => {
            let p: SelectionParams = parse(params)?;
            core.set_selection(p.selection)?;
            Ok(Value::Null)
        }
        "conduct_answer" | "browser_answer" | "settings_answer" => {
            let p: AnswerParams = parse(params)?;
            core.conduct_answer(&p.id, p.content, p.error)?;
            Ok(Value::Null)
        }
        "worktree_add" => {
            let p: WorktreeParams = parse(params)?;
            value(core.worktree_add(&p.project, &p.name, &p.accounts)?)
        }
        "worktrees" => {
            let p: ProjectParams = parse(params)?;
            value(core.worktrees(&p.project)?)
        }
        "worktree_remove" => {
            let p: WorktreeParams = parse(params)?;
            core.worktree_remove(&p.project, &p.name, &p.accounts)?;
            Ok(Value::Null)
        }
        other => Err(format!("no such method: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::testing::Recorder;
    use crate::scratch::Scratch;
    use std::sync::Arc;
    #[cfg(unix)]
    use std::sync::Mutex;

    /// A core made once the test process's environment is settled, so the
    /// shell it starts is the system's `sh` and reads no startup files.
    fn core() -> Core {
        crate::scratch::isolate();
        Core::new(Arc::new(Recorder::default()))
    }

    fn no_output(_: &str) -> Output {
        Box::new(|_| true)
    }

    // The batch answers with one list per project, in the order asked, each
    // the list a request for that project alone would give.
    #[test]
    fn sessions_for_several_projects_come_back_one_list_each_in_order() {
        let dir = Scratch::absent("protocol-sessions-many");
        let project = std::path::Path::new("/home/ada/dev/demo");
        let folder = crate::transcripts::directory_for(&dir, project);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            folder.join("s1.jsonl"),
            r#"{"type":"user","message":{"content":"hello"}}"#,
        )
        .unwrap();

        let params = json!({
            "projects": ["/home/ada/dev/other", "/home/ada/dev/demo"],
            "agent": "claude-code",
            "configDir": dir.to_string_lossy(),
        });
        let many = dispatch(&core(), "sessions_list_many", params, no_output).unwrap();
        let lists = many.as_array().unwrap();
        assert_eq!(lists.len(), 2);
        assert!(lists[0].as_array().unwrap().is_empty());
        assert_eq!(lists[1][0]["id"], "s1");
        assert_eq!(lists[1][0]["title"], "hello");

        let one = dispatch(
            &core(),
            "sessions_list",
            json!({"project": "/home/ada/dev/demo", "agent": "claude-code", "configDir": dir.to_string_lossy()}),
            no_output,
        )
        .unwrap();
        assert_eq!(one, lists[1]);
        std::fs::remove_dir_all(&dir).ok();
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
    fn the_file_methods_read_write_rename_and_delete() {
        let dir = Scratch::new("protocol-files");
        let root = dir.to_string_lossy().into_owned();
        let core = core();
        let call = |method: &str, params: Value| dispatch(&core, method, params, no_output);

        let made = call(
            "file_write",
            json!({"root": root, "file": "a/b.txt", "text": "one", "stamp": null}),
        )
        .unwrap();
        assert_eq!(made["written"], true);

        let read = call("file_read", json!({"root": root, "file": "a/b.txt"})).unwrap();
        assert_eq!(read["text"], "one");
        assert_eq!(read["stamp"], made["stamp"]);

        let stale = call(
            "file_write",
            json!({"root": root, "file": "a/b.txt", "text": "two", "stamp": "nope"}),
        )
        .unwrap();
        assert_eq!(stale["written"], false);
        assert_eq!(stale["stamp"], read["stamp"]);

        let forced = call(
            "file_write",
            json!({"root": root, "file": "a/b.txt", "text": "two", "stamp": "nope", "overwrite": true}),
        )
        .unwrap();
        assert_eq!(forced["written"], true);

        assert_eq!(
            call("path_rename", json!({"root": root, "from": "a", "to": "c"})).unwrap(),
            Value::Null
        );
        let moved = call("file_read", json!({"root": root, "file": "c/b.txt"})).unwrap();
        assert_eq!(moved["text"], "two");

        assert_eq!(
            call("path_delete", json!({"root": root, "path": "c"})).unwrap(),
            Value::Null
        );
        let gone = call("file_read", json!({"root": root, "file": "c/b.txt"})).unwrap_err();
        assert!(gone.contains("does not exist"));
    }

    #[test]
    fn the_file_methods_stay_inside_the_working_tree() {
        // The tree is one level inside the scratch folder, so `../x` is a
        // real file and `.git` a real folder: each call would succeed
        // without its guard.
        let dir = Scratch::new("protocol-files-confined");
        let tree = dir.path().join("tree");
        std::fs::create_dir_all(tree.join(".git")).unwrap();
        std::fs::write(tree.join(".git/HEAD"), "ref").unwrap();
        std::fs::write(tree.join("a.txt"), "a").unwrap();
        std::fs::write(dir.path().join("x"), "outside").unwrap();
        let root = tree.to_string_lossy().into_owned();
        let core = core();

        let outside = "not a path inside the working tree";
        let in_git = "in .git";
        for (method, params, refusal) in [
            ("file_read", json!({"root": root, "file": "../x"}), outside),
            (
                "file_write",
                json!({"root": root, "file": "../x", "text": "t", "stamp": null, "overwrite": true}),
                outside,
            ),
            (
                "file_write",
                json!({"root": root, "file": ".git/HEAD", "text": "t", "stamp": null, "overwrite": true}),
                in_git,
            ),
            (
                "path_rename",
                json!({"root": root, "from": "../x", "to": "y"}),
                outside,
            ),
            (
                "path_rename",
                json!({"root": root, "from": "a.txt", "to": ".git/hook"}),
                in_git,
            ),
            (
                "path_delete",
                json!({"root": root, "path": "../x"}),
                outside,
            ),
            ("path_delete", json!({"root": root, "path": ".git"}), in_git),
            ("path_delete", json!({"root": root, "path": "."}), outside),
        ] {
            let error = dispatch(&core, method, params, no_output).unwrap_err();
            assert!(error.contains(refusal), "{method}: {error}");
        }
        assert_eq!(
            std::fs::read_to_string(dir.path().join("x")).unwrap(),
            "outside"
        );
        assert_eq!(
            std::fs::read_to_string(tree.join(".git/HEAD")).unwrap(),
            "ref"
        );
        assert!(tree.join("a.txt").exists());
        assert!(!tree.join("y").exists() && !dir.path().join("y").exists());
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
    fn an_action_on_a_plugin_is_a_method_of_its_own() {
        let error = dispatch(
            &core(),
            "plugin_action",
            json!({ "source": "s" }),
            no_output,
        )
        .expect_err("an action needs every name");
        assert!(error.contains("bad parameters"), "{error}");
    }

    #[test]
    fn a_message_for_a_plugin_s_page_is_a_method_of_its_own() {
        let core = core();
        let error = dispatch(
            &core,
            "plugin_view_message",
            json!({ "source": "s", "plugin": "p" }),
            no_output,
        )
        .expect_err("a message names the project too");
        assert!(error.contains("bad parameters"), "{error}");
        let sent = dispatch(
            &core,
            "plugin_view_message",
            json!({ "source": "s", "plugin": "p", "project": "/one", "payload": { "want": "rows" } }),
            no_output,
        )
        .expect_err("no such plugin is running");
        assert!(
            sent.contains("not running") || sent.contains("no home directory"),
            "{sent}"
        );
    }

    #[test]
    fn the_hook_status_of_many_projects_is_one_answer_each_in_order() {
        let core = core();
        let error = dispatch(
            &core,
            "hook_status_many",
            json!({ "project": "/a" }),
            no_output,
        )
        .expect_err("the projects are a list");
        assert!(error.contains("bad parameters"), "{error}");
        let missing = Scratch::absent("no-such-project");
        let projects = json!([
            missing.join("one"),
            missing.join("two"),
            missing.join("three")
        ]);
        let answer = dispatch(
            &core,
            "hook_status_many",
            json!({ "projects": projects }),
            no_output,
        );
        match core.home() {
            Some(_) => {
                let answers = answer.unwrap();
                let answers = answers.as_array().unwrap();
                assert_eq!(answers.len(), 3);
                for (at, name) in ["one", "two", "three"].iter().enumerate() {
                    assert_eq!(answers[at]["installed"], false);
                    assert!(answers[at]["settings"].as_str().unwrap().contains(name));
                }
            }
            None => assert!(answer.is_err()),
        }
    }

    #[test]
    fn takes_the_projects_open_on_the_machine() {
        let core = core();
        let error = dispatch(
            &core,
            "plugin_projects",
            json!({ "paths": "/one" }),
            no_output,
        )
        .expect_err("the projects are a list");
        assert!(error.contains("bad parameters"), "{error}");
        let sent = dispatch(
            &core,
            "plugin_projects",
            json!({ "paths": ["/one", "/two"] }),
            no_output,
        );
        // Without a home directory there is nowhere to keep plugins, and
        // the core says so rather than taking the projects.
        match core.home() {
            Some(_) => assert_eq!(sent.unwrap(), Value::Null),
            None => assert!(sent.is_err()),
        }
    }

    #[test]
    fn answers_a_conduct_call_where_the_tool_server_waits() {
        let core = core();
        let Some(home) = core.home().map(|home| home.to_path_buf()) else {
            return;
        };
        let id = format!(
            "workbench-protocol-answer-{}",
            uuid::Uuid::new_v4().simple()
        );
        let sent = dispatch(
            &core,
            "conduct_answer",
            json!({ "id": id, "content": "Started session s-2." }),
            no_output,
        )
        .unwrap();
        assert_eq!(sent, Value::Null);
        let path = crate::show::answer_path(&home, &id);
        let text = std::fs::read_to_string(&path).unwrap();
        let answer: crate::show::Answer = serde_json::from_str(&text).unwrap();
        assert_eq!(answer.content.as_deref(), Some("Started session s-2."));
        assert_eq!(answer.error, None);
        std::fs::remove_file(&path).unwrap();

        let refused = dispatch(
            &core,
            "conduct_answer",
            json!({ "id": "../escape", "error": "no" }),
            no_output,
        )
        .expect_err("an id names a file and nothing else");
        assert!(refused.contains("not a call id"), "{refused}");
        let missing = dispatch(&core, "conduct_answer", json!({}), no_output)
            .expect_err("an answer names its call");
        assert!(missing.contains("bad parameters"), "{missing}");
    }

    #[test]
    fn a_browser_call_is_answered_the_same_way_as_a_conduct_call() {
        let core = core();
        let Some(home) = core.home().map(|home| home.to_path_buf()) else {
            return;
        };
        let id = format!(
            "workbench-protocol-answer-{}",
            uuid::Uuid::new_v4().simple()
        );
        let sent = dispatch(
            &core,
            "browser_answer",
            json!({ "id": id, "content": "1  https://example.com/  Example" }),
            no_output,
        )
        .unwrap();
        assert_eq!(sent, Value::Null);
        let path = crate::show::answer_path(&home, &id);
        let text = std::fs::read_to_string(&path).unwrap();
        let answer: crate::show::Answer = serde_json::from_str(&text).unwrap();
        assert_eq!(
            answer.content.as_deref(),
            Some("1  https://example.com/  Example")
        );
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn a_settings_call_is_answered_the_same_way_as_a_conduct_call() {
        let core = core();
        let Some(home) = core.home().map(|home| home.to_path_buf()) else {
            return;
        };
        let id = format!(
            "workbench-protocol-answer-{}",
            uuid::Uuid::new_v4().simple()
        );
        let sent = dispatch(
            &core,
            "settings_answer",
            json!({ "id": id, "error": "The user declined the change." }),
            no_output,
        )
        .unwrap();
        assert_eq!(sent, Value::Null);
        let path = crate::show::answer_path(&home, &id);
        let text = std::fs::read_to_string(&path).unwrap();
        let answer: crate::show::Answer = serde_json::from_str(&text).unwrap();
        assert_eq!(
            answer.error.as_deref(),
            Some("The user declined the change.")
        );
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn integrated_sessions_are_methods_and_refuse_what_they_cannot_do() {
        let core = core();
        let missing = dispatch(
            &core,
            "integrated_start",
            json!({ "agent": "claude-code" }),
            no_output,
        )
        .expect_err("a start names its project");
        assert!(missing.contains("bad parameters"), "{missing}");
        let missing = dispatch(
            &core,
            "integrated_trust",
            json!({ "agent": "claude-code" }),
            no_output,
        )
        .expect_err("a trust names its project");
        assert!(missing.contains("bad parameters"), "{missing}");
        let codex = dispatch(
            &core,
            "integrated_start",
            json!({ "agent": "codex", "project": "/tmp" }),
            no_output,
        )
        .expect_err("codex has no integrated mode here");
        assert!(codex.contains("integrated"), "{codex}");
        for (method, params) in [
            (
                "integrated_send",
                json!({ "id": "int-none", "message": "11111111-1111-4111-8111-111111111111", "text": "hi" }),
            ),
            ("integrated_interrupt", json!({ "id": "int-none" })),
            ("integrated_compact", json!({ "id": "int-none" })),
            (
                "integrated_answer",
                json!({ "id": "int-none", "request": "r", "choice": "allow" }),
            ),
            (
                "integrated_reply",
                json!({ "id": "int-none", "request": "r", "answers": [["yes"]] }),
            ),
            (
                "integrated_configure",
                json!({ "id": "int-none", "model": "haiku" }),
            ),
            ("integrated_snapshot", json!({ "id": "int-none" })),
            ("integrated_stop", json!({ "id": "int-none" })),
        ] {
            let error = dispatch(&core, method, params, no_output).expect_err(method);
            assert!(error.contains("no such session"), "{method}: {error}");
        }
        let unknown = dispatch(
            &core,
            "integrated_answer",
            json!({ "id": "int-none", "request": "r", "choice": "allowForever" }),
            no_output,
        )
        .expect_err("a choice is one of those a request offers");
        assert!(unknown.contains("bad parameters"), "{unknown}");
    }

    #[test]
    fn a_worktree_is_a_method_of_its_own() {
        let error = dispatch(&core(), "worktree_add", json!({ "name": "x" }), no_output)
            .expect_err("a worktree names its project");
        assert!(error.contains("bad parameters"), "{error}");
        let refused = dispatch(
            &core(),
            "worktree_add",
            json!({ "project": "/definitely/not/here", "name": "one/two" }),
            no_output,
        )
        .expect_err("a name is a plain one");
        assert!(
            refused.contains("is not a name for a worktree"),
            "{refused}"
        );
    }

    #[test]
    fn listing_and_removing_worktrees_are_methods_too() {
        let missing = dispatch(&core(), "worktrees", json!({}), no_output)
            .expect_err("a listing names its project");
        assert!(missing.contains("bad parameters"), "{missing}");
        let nowhere = dispatch(
            &core(),
            "worktrees",
            json!({ "project": "/definitely/not/here" }),
            no_output,
        )
        .expect_err("there is no repository there");
        assert!(nowhere.contains("not a git repository"), "{nowhere}");

        let unnamed = dispatch(
            &core(),
            "worktree_remove",
            json!({ "project": "/definitely/not/here" }),
            no_output,
        )
        .expect_err("a removal names the worktree");
        assert!(unnamed.contains("bad parameters"), "{unnamed}");
        let refused = dispatch(
            &core(),
            "worktree_remove",
            json!({ "project": "/definitely/not/here", "name": "one/two" }),
            no_output,
        )
        .expect_err("a name is a plain one");
        assert!(
            refused.contains("is not a name for a worktree"),
            "{refused}"
        );
    }

    #[test]
    fn takes_the_window_s_own_argument_names() {
        let params = json!({"agent": "codex", "id": "abc"});
        assert_eq!(
            dispatch(&core(), "session_title", params, no_output).unwrap(),
            Value::Null
        );
        let dir = Scratch::new("protocol-dirs");
        std::fs::create_dir_all(dir.join("one")).unwrap();
        let dirs = dispatch(&core(), "list_dirs", json!({"path": dir.path()}), no_output).unwrap();
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
        // The shell is the system's `sh`, which reads no startup files before
        // it reads the line; the bound is only for a shell that never answers.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        let mut text = String::new();
        while std::time::Instant::now() < deadline {
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
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(text.contains("marker-42"), "{text}");
    }
}
