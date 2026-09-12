//! Agent Workbench, the desktop app.
//!
//! The core lives in its own crate with no window attached; this is the
//! window. Every command is a thin wrapper that routes by the path or id it
//! was given: a plain one goes to the core here, an `ssh://host` one to the
//! same core on that host (see `remote`). Either way the work runs on the
//! blocking pool, since a synchronous Tauri command runs on the main thread,
//! the one that paints the window, and a `git status` on a large tree or a
//! slow `.zshrc` would freeze the UI for as long as it took.

mod chrome;
mod menu;
pub mod remote;
pub mod ssh;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};
use workbench_core::{Core, Output, Sink};

use remote::{route, with_host, with_host_id, Remotes, Route};

/// The core's events, straight to the window.
struct TauriSink(AppHandle);

impl Sink for TauriSink {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.0.emit(event, payload);
    }
}

/// A pty's bytes to the window on a Tauri `Channel`. Channels are built for
/// ordered, high-throughput delivery and are what Tauri itself uses for child
/// process output; the event system is explicitly not for low latency or high
/// throughput, so it carries lifecycle only.
fn to_channel(channel: Channel) -> Output {
    Box::new(move |bytes| {
        channel
            .send(InvokeResponseBody::Raw(bytes.to_vec()))
            .is_ok()
    })
}

/// Runs a closure on the blocking pool and waits for it.
async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("the task failed: {e}"))?
}

fn value<T: Serialize>(result: T) -> Result<Value, String> {
    serde_json::to_value(result).map_err(|e| format!("could not encode the result: {e}"))
}

/// Runs a command against the core here, or forwards it to the host the
/// route names, with the same parameters.
async fn routed<T, F>(
    core: Arc<Core>,
    remotes: Arc<Remotes>,
    route: Route,
    method: &'static str,
    params: impl FnOnce(String) -> Value + Send + 'static,
    local: F,
) -> Result<Value, String>
where
    T: Serialize + Send + 'static,
    F: FnOnce(&Core, &str) -> Result<T, String> + Send + 'static,
{
    match route {
        Route::Local(rest) => blocking(move || local(&core, &rest).and_then(value)).await,
        Route::Remote { host, rest } => {
            blocking(move || remotes.connection(&host)?.call(method, params(rest))).await
        }
    }
}

#[tauri::command]
async fn agent_detect(core: State<'_, Arc<Core>>, id: String) -> Result<Value, String> {
    let core = Arc::clone(&core);
    blocking(move || core.detect(&id).and_then(value)).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn pty_spawn(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    agent: String,
    project: String,
    cwd: Option<String>,
    session: Option<String>,
    cols: u16,
    rows: u16,
    on_output: Channel,
) -> Result<Value, String> {
    let core = Arc::clone(&core);
    let remotes = Arc::clone(&remotes);
    // A working directory is on the project's machine, with or without the
    // host on it.
    let cwd = cwd.map(|cwd| match route(&cwd) {
        Route::Remote { rest, .. } => rest,
        Route::Local(cwd) => cwd,
    });
    blocking(move || match route(&project) {
        Route::Local(project) => {
            let spawned = core.spawn(
                &agent,
                Path::new(&project),
                cwd.as_deref().map(Path::new),
                session,
                cols,
                rows,
                |_| to_channel(on_output),
            )?;
            value(spawned)
        }
        Route::Remote { host, rest } => {
            let connection = remotes.connection(&host)?;
            let spawned = connection.call(
                "pty_spawn",
                json!({ "agent": agent, "project": rest, "cwd": cwd, "session": session, "cols": cols, "rows": rows }),
            )?;
            let id = spawned["ptyId"].as_str().ok_or("no pty id")?.to_string();
            connection.attach_output(&id, to_channel(on_output));
            Ok(json!({ "ptyId": with_host_id(&host, &id), "sessionId": spawned["sessionId"] }))
        }
    })
    .await
}

#[tauri::command]
async fn pty_shell(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    project: String,
    cols: u16,
    rows: u16,
    on_output: Channel,
) -> Result<Value, String> {
    let core = Arc::clone(&core);
    let remotes = Arc::clone(&remotes);
    blocking(move || match route(&project) {
        Route::Local(project) => {
            let id = core.shell(Path::new(&project), cols, rows, |_| to_channel(on_output))?;
            Ok(Value::String(id))
        }
        Route::Remote { host, rest } => {
            let connection = remotes.connection(&host)?;
            let id = connection.call(
                "pty_shell",
                json!({ "project": rest, "cols": cols, "rows": rows }),
            )?;
            let id = id.as_str().ok_or("no pty id")?.to_string();
            connection.attach_output(&id, to_channel(on_output));
            Ok(Value::String(with_host_id(&host, &id)))
        }
    })
    .await
}

#[tauri::command]
async fn project_info(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    path: String,
) -> Result<Value, String> {
    let core = Arc::clone(&core);
    let remotes = Arc::clone(&remotes);
    blocking(move || match route(&path) {
        Route::Local(path) => core.project_info(Path::new(&path)).and_then(value),
        Route::Remote { host, rest } => {
            let project = remotes
                .connection(&host)?
                .call("project_info", json!({ "path": rest }))?;
            Ok(remote::project_homeward(&host, project))
        }
    })
    .await
}

#[tauri::command]
async fn hook_status(
    app: tauri::AppHandle,
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    project: String,
) -> Result<Value, String> {
    // The daemon is put in place before the status is read, so a project
    // with hooks from before there was a server reads as wanting one.
    if let Route::Local(_) = route(&project) {
        if let Some(home) = core.home() {
            let resources = app.path().resource_dir().ok();
            let _ = ssh::ensure_local_daemon(home, resources.as_deref());
        }
    }
    routed(
        Arc::clone(&core),
        Arc::clone(&remotes),
        route(&project),
        "hook_status",
        |rest| json!({ "project": rest }),
        |core, project| core.hook_status(Path::new(project)),
    )
    .await
}

#[tauri::command]
async fn hook_install(
    app: tauri::AppHandle,
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    project: String,
) -> Result<Value, String> {
    // The server the hooks point the agents at is the daemon; on this
    // machine the app puts its own build in place first. A remote has it
    // already, since the connection runs it.
    if let Route::Local(_) = route(&project) {
        if let Some(home) = core.home() {
            let resources = app.path().resource_dir().ok();
            ssh::ensure_local_daemon(home, resources.as_deref())?;
        }
    }
    routed(
        Arc::clone(&core),
        Arc::clone(&remotes),
        route(&project),
        "hook_install",
        |rest| json!({ "project": rest }),
        |core, project| core.hook_install(Path::new(project)),
    )
    .await
}

#[tauri::command]
async fn hook_uninstall(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    project: String,
) -> Result<Value, String> {
    routed(
        Arc::clone(&core),
        Arc::clone(&remotes),
        route(&project),
        "hook_uninstall",
        |rest| json!({ "project": rest }),
        |core, project| core.hook_uninstall(Path::new(project)),
    )
    .await
}

#[tauri::command]
async fn sessions_list(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    project: String,
    agent: String,
) -> Result<Value, String> {
    let for_local = agent.clone();
    routed(
        Arc::clone(&core),
        Arc::clone(&remotes),
        route(&project),
        "sessions_list",
        move |rest| json!({ "project": rest, "agent": agent }),
        move |core, project| Ok(core.sessions_list(Path::new(project), &for_local)),
    )
    .await
}

/// A session's title has no path to route by, so the core here is asked
/// first and then every host with a connection open.
#[tauri::command]
async fn session_title(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    agent: String,
    id: String,
) -> Result<Option<String>, String> {
    let core = Arc::clone(&core);
    let remotes = Arc::clone(&remotes);
    blocking(move || {
        if let Some(title) = core.session_title(&agent, &id) {
            return Ok(Some(title));
        }
        for connection in remotes.all() {
            let params = json!({ "agent": agent, "id": id });
            if let Ok(Value::String(title)) = connection.call("session_title", params) {
                return Ok(Some(title));
            }
        }
        Ok(None)
    })
    .await
}

#[tauri::command]
async fn git_status(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    root: String,
) -> Result<Value, String> {
    routed(
        Arc::clone(&core),
        Arc::clone(&remotes),
        route(&root),
        "git_status",
        |rest| json!({ "root": rest }),
        |core, root| core.git_status(Path::new(root)),
    )
    .await
}

#[tauri::command]
async fn git_files(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    root: String,
) -> Result<Value, String> {
    routed(
        Arc::clone(&core),
        Arc::clone(&remotes),
        route(&root),
        "git_files",
        |rest| json!({ "root": rest }),
        |core, root| core.git_files(Path::new(root)),
    )
    .await
}

#[tauri::command]
async fn git_grep(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    root: String,
    query: String,
    scope: String,
) -> Result<Value, String> {
    let (q, s) = (query.clone(), scope.clone());
    routed(
        Arc::clone(&core),
        Arc::clone(&remotes),
        route(&root),
        "git_grep",
        move |rest| json!({ "root": rest, "query": query, "scope": scope }),
        move |core, root| core.git_grep(Path::new(root), &q, &s),
    )
    .await
}

#[tauri::command]
async fn git_diff(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    root: String,
    file: String,
) -> Result<Value, String> {
    let f = file.clone();
    routed(
        Arc::clone(&core),
        Arc::clone(&remotes),
        route(&root),
        "git_diff",
        move |rest| json!({ "root": rest, "file": file }),
        move |core, root| core.git_diff(Path::new(root), &f),
    )
    .await
}

/// An image or a PDF the agent presented, read where it is.
#[tauri::command]
async fn read_media(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    path: String,
) -> Result<Value, String> {
    routed(
        Arc::clone(&core),
        Arc::clone(&remotes),
        route(&path),
        "read_media",
        |rest| json!({ "path": rest }),
        |core, path| core.read_media(Path::new(path)),
    )
    .await
}

/// What the user is looking at, put on record on the project's machine
/// for the agent's tool server to read. The paths carry no host: the
/// window strips it, and the project names the machine.
#[tauri::command]
async fn set_selection(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    project: String,
    selection: Option<workbench_core::selection::Selection>,
) -> Result<Value, String> {
    let sent = selection.clone();
    routed(
        Arc::clone(&core),
        Arc::clone(&remotes),
        route(&project),
        "set_selection",
        move |_| json!({ "selection": sent }),
        move |core, _| core.set_selection(selection),
    )
    .await
}

/// The window's answer to a call one of its agents made on a conductor's
/// tool. The tool server waiting for it runs beside the core that took the
/// call, which is the core on the machine the calling session runs on: the
/// directory it called from says which.
#[tauri::command]
async fn conduct_answer(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    id: String,
    cwd: String,
    content: Option<String>,
    error: Option<String>,
) -> Result<Value, String> {
    let sent = (id.clone(), content.clone(), error.clone());
    routed(
        Arc::clone(&core),
        Arc::clone(&remotes),
        route(&cwd),
        "conduct_answer",
        move |_| {
            let (id, content, error) = sent;
            json!({ "id": id, "content": content, "error": error })
        },
        move |core, _| {
            core.conduct_answer(&id, content, error)?;
            Ok(Value::Null)
        },
    )
    .await
}

/// Where an orchestrator session runs. It is on this machine whatever the
/// projects it directs are on.
#[tauri::command]
async fn orchestrator_dir(core: State<'_, Arc<Core>>) -> Result<String, String> {
    let core = Arc::clone(&core);
    blocking(move || core.orchestrator_dir()).await
}

/// A worktree of the project, on a branch of the same name, made where the
/// project is.
#[tauri::command]
async fn worktree_add(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    project: String,
    name: String,
) -> Result<Value, String> {
    let wanted = name.clone();
    routed(
        Arc::clone(&core),
        Arc::clone(&remotes),
        route(&project),
        "worktree_add",
        move |rest| json!({ "project": rest, "name": name }),
        move |core, project| core.worktree_add(Path::new(project), &wanted),
    )
    .await
}

#[tauri::command]
async fn git_content(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    root: String,
    file: String,
) -> Result<Value, String> {
    let f = file.clone();
    routed(
        Arc::clone(&core),
        Arc::clone(&remotes),
        route(&root),
        "git_content",
        move |rest| json!({ "root": rest, "file": file }),
        move |core, root| core.git_content(Path::new(root), &f),
    )
    .await
}

#[tauri::command]
async fn git_watch(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    root: String,
) -> Result<Value, String> {
    routed(
        Arc::clone(&core),
        Arc::clone(&remotes),
        route(&root),
        "git_watch",
        |rest| json!({ "root": rest }),
        |core, root| core.git_watch(Path::new(root)),
    )
    .await
}

/// Nothing to route by, so every core stops watching.
#[tauri::command]
async fn git_unwatch(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
) -> Result<(), String> {
    core.git_unwatch();
    let remotes = Arc::clone(&remotes);
    blocking(move || {
        for connection in remotes.all() {
            let _ = connection.call("git_unwatch", Value::Null);
        }
        Ok(())
    })
    .await
}

#[tauri::command]
async fn pty_write(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    id: String,
    data: String,
) -> Result<(), String> {
    match route(&id) {
        Route::Local(id) => core.pty_write(&id, data.as_bytes()),
        Route::Remote { host, rest } => {
            let remotes = Arc::clone(&remotes);
            blocking(move || {
                remotes
                    .connection(&host)?
                    .call("pty_write", json!({ "id": rest, "data": data }))
                    .map(|_| ())
            })
            .await
        }
    }
}

#[tauri::command]
async fn pty_resize(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    match route(&id) {
        Route::Local(id) => core.pty_resize(&id, cols, rows),
        Route::Remote { host, rest } => {
            let remotes = Arc::clone(&remotes);
            blocking(move || {
                remotes
                    .connection(&host)?
                    .call(
                        "pty_resize",
                        json!({ "id": rest, "cols": cols, "rows": rows }),
                    )
                    .map(|_| ())
            })
            .await
        }
    }
}

#[tauri::command]
async fn pty_kill(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    id: String,
) -> Result<(), String> {
    match route(&id) {
        Route::Local(id) => core.pty_kill(&id),
        Route::Remote { host, rest } => {
            let remotes = Arc::clone(&remotes);
            blocking(move || {
                remotes
                    .connection(&host)?
                    .call("pty_kill", json!({ "id": rest }))
                    .map(|_| ())
            })
            .await
        }
    }
}

#[tauri::command]
async fn pty_cwd(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    id: String,
) -> Result<Option<String>, String> {
    match route(&id) {
        Route::Local(id) => core.pty_cwd(&id),
        Route::Remote { host, rest } => {
            let remotes = Arc::clone(&remotes);
            blocking(move || {
                let cwd = remotes
                    .connection(&host)?
                    .call("pty_cwd", json!({ "id": rest }))?;
                Ok(cwd.as_str().map(|path| with_host(&host, path)))
            })
            .await
        }
    }
}

/// What runs under a session's process, on whichever machine it is.
#[tauri::command]
async fn pty_processes(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    id: String,
) -> Result<Value, String> {
    routed(
        Arc::clone(&core),
        Arc::clone(&remotes),
        route(&id),
        "pty_processes",
        |rest| json!({ "id": rest }),
        |core, id| core.pty_processes(id),
    )
    .await
}

#[tauri::command]
async fn pty_stop_process(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    id: String,
    pid: u32,
) -> Result<Value, String> {
    routed(
        Arc::clone(&core),
        Arc::clone(&remotes),
        route(&id),
        "pty_stop_process",
        move |rest| json!({ "id": rest, "pid": pid }),
        move |core, id| core.pty_stop_process(id, pid),
    )
    .await
}

/// The plugin sources on this machine, with their plugins and states.
#[tauri::command]
async fn plugin_sources(core: State<'_, Arc<Core>>) -> Result<Value, String> {
    let core = Arc::clone(&core);
    blocking(move || core.plugin_sources().and_then(value)).await
}

#[tauri::command]
async fn plugin_add(
    core: State<'_, Arc<Core>>,
    location: String,
    reference: Option<String>,
) -> Result<Value, String> {
    let core = Arc::clone(&core);
    blocking(move || {
        core.plugin_add(&location, reference.as_deref())
            .and_then(value)
    })
    .await
}

#[tauri::command]
async fn plugin_remove(core: State<'_, Arc<Core>>, id: String) -> Result<(), String> {
    let core = Arc::clone(&core);
    blocking(move || core.plugin_remove(&id)).await
}

#[tauri::command]
async fn plugin_check(core: State<'_, Arc<Core>>, id: String) -> Result<Value, String> {
    let core = Arc::clone(&core);
    blocking(move || core.plugin_check(&id).and_then(value)).await
}

#[tauri::command]
async fn plugin_update(core: State<'_, Arc<Core>>, id: String) -> Result<Value, String> {
    let core = Arc::clone(&core);
    blocking(move || core.plugin_update(&id).and_then(value)).await
}

#[tauri::command]
async fn plugin_enable(
    core: State<'_, Arc<Core>>,
    id: String,
    name: String,
    on: bool,
) -> Result<Value, String> {
    let core = Arc::clone(&core);
    blocking(move || core.plugin_enable(&id, &name, on).and_then(value)).await
}

/// The projects open in the window, each machine told the ones on it: a
/// plugin runs where its project is, so the paths are split by host and go
/// on without it. A host whose last project closed is told so too.
#[tauri::command]
async fn plugin_projects(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    paths: Vec<String>,
) -> Result<(), String> {
    let core = Arc::clone(&core);
    let remotes = Arc::clone(&remotes);
    blocking(move || {
        let mut here: Vec<String> = Vec::new();
        let mut elsewhere: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for host in remotes.hosts() {
            elsewhere.entry(host).or_default();
        }
        for path in paths {
            match route(&path) {
                Route::Local(path) => here.push(path),
                Route::Remote { host, rest } => elsewhere.entry(host).or_default().push(rest),
            }
        }
        core.plugin_projects(here)?;
        for (host, paths) in elsewhere {
            // Saying which projects are open is news, not a request: a
            // machine that cannot be reached hears it the next time.
            let _ = remotes.connection(&host).and_then(|connection| {
                connection.call("plugin_projects", json!({ "paths": paths }))
            });
        }
        Ok(())
    })
    .await
}

/// An action on a plugin's row or its section's header, run by the plugin
/// where the project is.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn plugin_action(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    source: String,
    plugin: String,
    section: String,
    action: String,
    row: Option<String>,
    input: Value,
    project: String,
) -> Result<Value, String> {
    let (s, p, c, a, r, i) = (
        source.clone(),
        plugin.clone(),
        section.clone(),
        action.clone(),
        row.clone(),
        input.clone(),
    );
    routed(
        Arc::clone(&core),
        Arc::clone(&remotes),
        route(&project),
        "plugin_action",
        move |rest| {
            json!({ "source": source, "plugin": plugin, "section": section, "action": action, "row": row, "input": input, "project": rest })
        },
        move |core, project| core.plugin_action(&s, &p, &c, &a, r.as_deref(), &i, project),
    )
    .await
}

/// A message from a plugin's page to the plugin, which runs where the
/// project is.
#[tauri::command]
async fn plugin_view_message(
    core: State<'_, Arc<Core>>,
    remotes: State<'_, Arc<Remotes>>,
    source: String,
    plugin: String,
    project: String,
    payload: Value,
) -> Result<Value, String> {
    let (s, p, d) = (source.clone(), plugin.clone(), payload.clone());
    routed(
        Arc::clone(&core),
        Arc::clone(&remotes),
        route(&project),
        "plugin_view_message",
        move |rest| {
            json!({ "source": source, "plugin": plugin, "project": rest, "payload": payload })
        },
        move |core, project| core.plugin_view_message(&s, &p, project, &d),
    )
    .await
}

/// Opens the connection to a host, or says why it cannot.
#[tauri::command]
async fn remote_connect(remotes: State<'_, Arc<Remotes>>, host: String) -> Result<Value, String> {
    let remotes = Arc::clone(&remotes);
    blocking(move || remotes.connect(&host)).await
}

/// The hosts the user's ssh configuration names, and the ones the app set
/// up itself.
#[tauri::command]
async fn remote_hosts(remotes: State<'_, Arc<Remotes>>) -> Result<Value, String> {
    let remotes = Arc::clone(&remotes);
    blocking(move || {
        let files = remotes.files()?;
        let home = workbench_core::api::home_directory().ok_or("no home directory")?;
        let saved: Vec<Value> = files
            .saved()
            .into_iter()
            .map(
                |saved| json!({ "name": saved.name, "host": saved.host, "user": saved.user, "port": saved.port, "target": saved.target() }),
            )
            .collect();
        Ok(json!({
            "configured": ssh::config_hosts(&ssh::ssh_config(&home)),
            "saved": saved,
        }))
    })
    .await
}

/// Takes in the token `agent-workbench-remote connect` printed on a
/// machine: keeps its key and host key, remembers the machine, and opens
/// the connection. Gives back the target that names the machine in paths.
#[tauri::command]
async fn remote_pair(remotes: State<'_, Arc<Remotes>>, token: String) -> Result<Value, String> {
    let remotes = Arc::clone(&remotes);
    blocking(move || {
        let saved = remotes.files()?.pair(&token)?;
        remotes.connect(&saved.target())
    })
    .await
}

/// Forgets a machine the app set up: its entry, not its key on the
/// machine, which the user removes there if they want it gone.
#[tauri::command]
async fn remote_forget(remotes: State<'_, Arc<Remotes>>, target: String) -> Result<(), String> {
    remotes.disconnect(&target);
    remotes.files()?.forget(&target)
}

#[tauri::command]
async fn remote_disconnect(remotes: State<'_, Arc<Remotes>>, host: String) -> Result<(), String> {
    remotes.disconnect(&host);
    Ok(())
}

/// The directories under a path on a host, or under its home for an empty
/// path, each with the host on so the window can open it as it is.
#[tauri::command]
async fn remote_dirs(
    remotes: State<'_, Arc<Remotes>>,
    host: String,
    path: String,
) -> Result<Value, String> {
    let remotes = Arc::clone(&remotes);
    blocking(move || {
        let connection = remotes.connection(&host)?;
        let home = connection.call("home", Value::Null)?;
        // The path may come back the way it went out, with the host on.
        let path = match route(&path) {
            Route::Remote { rest, .. } => rest,
            Route::Local(path) => path,
        };
        let base = if path.is_empty() {
            home.as_str()
                .ok_or("the host has no home directory")?
                .to_string()
        } else {
            path
        };
        let mut dirs = connection.call("list_dirs", json!({ "path": base }))?;
        if let Some(entries) = dirs.as_array_mut() {
            for entry in entries {
                if let Some(path) = entry.get("path").and_then(Value::as_str) {
                    let qualified = with_host(&host, path);
                    entry["path"] = Value::String(qualified);
                }
            }
        }
        Ok(json!({ "path": with_host(&host, &base), "dirs": dirs }))
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let core = Arc::new(Core::new(Arc::new(TauriSink(app.handle().clone()))));
            if let Err(error) = core.start() {
                eprintln!("session log: {error}");
            }
            app.manage(core);
            app.manage(Arc::new(Remotes::new(app.handle().clone())));
            menu::install(app)?;
            if let Some(window) = app.get_webview_window("main") {
                chrome::inset_window_controls(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_detect,
            read_media,
            set_selection,
            project_info,
            sessions_list,
            session_title,
            hook_status,
            hook_install,
            hook_uninstall,
            git_status,
            git_files,
            git_grep,
            git_diff,
            git_content,
            git_watch,
            git_unwatch,
            pty_spawn,
            pty_shell,
            pty_write,
            pty_resize,
            pty_kill,
            pty_cwd,
            pty_processes,
            pty_stop_process,
            plugin_sources,
            plugin_add,
            plugin_remove,
            plugin_check,
            plugin_update,
            plugin_enable,
            plugin_projects,
            plugin_action,
            plugin_view_message,
            conduct_answer,
            orchestrator_dir,
            worktree_add,
            remote_connect,
            remote_disconnect,
            remote_dirs,
            remote_hosts,
            remote_pair,
            remote_forget,
            menu::app_menu
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
