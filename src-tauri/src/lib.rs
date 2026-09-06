//! Agent Workbench, the desktop app.
//!
//! The core lives in its own crate with no window attached; this is the
//! window. Every command is a thin wrapper that hands the work to the core
//! on the blocking pool, since a synchronous Tauri command runs on the main
//! thread, the one that paints the window, and a `git status` on a large tree
//! or a slow `.zshrc` would freeze the UI for as long as it took.

mod chrome;
mod menu;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};
use workbench_core::{Core, DetectReport, Output, Sink, Spawned};

/// The core's events, straight to the window.
struct TauriSink(AppHandle);

impl Sink for TauriSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
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

#[tauri::command]
async fn agent_detect(core: State<'_, Arc<Core>>, id: String) -> Result<DetectReport, String> {
    let core = Arc::clone(&core);
    blocking(move || core.detect(&id)).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn pty_spawn(
    core: State<'_, Arc<Core>>,
    agent: String,
    project: PathBuf,
    session: Option<String>,
    cols: u16,
    rows: u16,
    on_output: Channel,
) -> Result<Spawned, String> {
    let core = Arc::clone(&core);
    blocking(move || {
        core.spawn(&agent, &project, session, cols, rows, |_| {
            to_channel(on_output)
        })
    })
    .await
}

#[tauri::command]
async fn pty_shell(
    core: State<'_, Arc<Core>>,
    project: PathBuf,
    cols: u16,
    rows: u16,
    on_output: Channel,
) -> Result<String, String> {
    let core = Arc::clone(&core);
    blocking(move || core.shell(&project, cols, rows, |_| to_channel(on_output))).await
}

#[tauri::command]
async fn project_info(
    core: State<'_, Arc<Core>>,
    path: PathBuf,
) -> Result<workbench_core::project::ProjectInfo, String> {
    let core = Arc::clone(&core);
    blocking(move || core.project_info(&path)).await
}

#[tauri::command]
async fn hook_status(
    core: State<'_, Arc<Core>>,
    project: PathBuf,
) -> Result<workbench_core::hook::HookStatus, String> {
    let core = Arc::clone(&core);
    blocking(move || core.hook_status(&project)).await
}

#[tauri::command]
async fn hook_install(
    core: State<'_, Arc<Core>>,
    project: PathBuf,
) -> Result<workbench_core::hook::HookStatus, String> {
    let core = Arc::clone(&core);
    blocking(move || core.hook_install(&project)).await
}

#[tauri::command]
async fn hook_uninstall(
    core: State<'_, Arc<Core>>,
    project: PathBuf,
) -> Result<workbench_core::hook::HookStatus, String> {
    let core = Arc::clone(&core);
    blocking(move || core.hook_uninstall(&project)).await
}

#[tauri::command]
async fn sessions_list(
    core: State<'_, Arc<Core>>,
    project: PathBuf,
    agent: String,
) -> Result<Vec<workbench_core::transcripts::Transcript>, String> {
    let core = Arc::clone(&core);
    blocking(move || Ok(core.sessions_list(&project, &agent))).await
}

#[tauri::command]
async fn session_title(
    core: State<'_, Arc<Core>>,
    agent: String,
    id: String,
) -> Result<Option<String>, String> {
    let core = Arc::clone(&core);
    blocking(move || Ok(core.session_title(&agent, &id))).await
}

#[tauri::command]
async fn git_status(
    core: State<'_, Arc<Core>>,
    root: PathBuf,
) -> Result<Vec<workbench_core::git::ChangedFile>, String> {
    let core = Arc::clone(&core);
    blocking(move || core.git_status(&root)).await
}

#[tauri::command]
async fn git_files(core: State<'_, Arc<Core>>, root: PathBuf) -> Result<Vec<String>, String> {
    let core = Arc::clone(&core);
    blocking(move || core.git_files(&root)).await
}

#[tauri::command]
async fn git_grep(
    core: State<'_, Arc<Core>>,
    root: PathBuf,
    query: String,
    scope: String,
) -> Result<workbench_core::git::GrepResult, String> {
    let core = Arc::clone(&core);
    blocking(move || core.git_grep(&root, &query, &scope)).await
}

#[tauri::command]
async fn git_diff(
    core: State<'_, Arc<Core>>,
    root: PathBuf,
    file: String,
) -> Result<workbench_core::git::FileDiff, String> {
    let core = Arc::clone(&core);
    blocking(move || core.git_diff(&root, &file)).await
}

#[tauri::command]
async fn git_content(
    core: State<'_, Arc<Core>>,
    root: PathBuf,
    file: String,
) -> Result<workbench_core::git::FileContent, String> {
    let core = Arc::clone(&core);
    blocking(move || core.git_content(&root, &file)).await
}

#[tauri::command]
async fn git_watch(core: State<'_, Arc<Core>>, root: PathBuf) -> Result<(), String> {
    let core = Arc::clone(&core);
    blocking(move || core.git_watch(&root)).await
}

#[tauri::command]
async fn git_unwatch(core: State<'_, Arc<Core>>) -> Result<(), String> {
    core.git_unwatch();
    Ok(())
}

#[tauri::command]
async fn pty_write(core: State<'_, Arc<Core>>, id: String, data: String) -> Result<(), String> {
    core.pty_write(&id, data.as_bytes())
}

#[tauri::command]
async fn pty_resize(
    core: State<'_, Arc<Core>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    core.pty_resize(&id, cols, rows)
}

#[tauri::command]
async fn pty_kill(core: State<'_, Arc<Core>>, id: String) -> Result<(), String> {
    core.pty_kill(&id)
}

#[tauri::command]
async fn pty_cwd(core: State<'_, Arc<Core>>, id: String) -> Result<Option<String>, String> {
    core.pty_cwd(&id)
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
            menu::install(app)?;
            if let Some(window) = app.get_webview_window("main") {
                chrome::inset_window_controls(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_detect,
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
            menu::app_menu
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
