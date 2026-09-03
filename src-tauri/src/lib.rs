//! Agent Workbench core.
//!
//! Rust owns state, the webview owns pixels. Every PTY, git query, filesystem
//! watch and session index lives here; the frontend renders and dispatches.

mod adapter;
mod env;
mod git;
mod project;
mod pty;
mod watch;

use std::path::PathBuf;
use std::sync::Arc;

use portable_pty::PtySize;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use adapter::{LaunchCtx, Surface, adapter_for};
use pty::Sessions;
use watch::Watchers;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DetectReport {
    id: String,
    /// Absolute path to the binary, when one was found.
    path: Option<String>,
    caps: Option<adapter::Caps>,
    /// False when the login shell could not be read. It changes what a missing
    /// binary means, so the pane can say something more useful than "not found".
    from_login_shell: bool,
}

#[tauri::command]
fn agent_detect(id: String) -> Result<DetectReport, String> {
    let adapter = adapter_for(&id).ok_or_else(|| format!("no adapter for {id}"))?;
    let environment = env::environment();

    Ok(DetectReport {
        id: adapter.id().to_string(),
        path: adapter
            .detect(&environment.vars)
            .map(|p| p.to_string_lossy().to_string()),
        caps: Some(adapter.caps()),
        from_login_shell: environment.from_login_shell,
    })
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    sessions: State<'_, Arc<Sessions>>,
    agent: String,
    project: PathBuf,
    session: Option<String>,
    cols: u16,
    rows: u16,
    on_output: Channel,
) -> Result<String, String> {
    let adapter = adapter_for(&agent).ok_or_else(|| format!("no adapter for {agent}"))?;
    let environment = env::environment();

    let ctx = LaunchCtx {
        project: &project,
        env: &environment.vars,
    };

    let surface = match session {
        Some(id) => adapter.resume(&ctx, &id)?,
        None => adapter.launch(&ctx)?,
    };

    let Surface::Pty(command) = surface;

    pty::spawn(
        app,
        Arc::clone(&sessions),
        command,
        size(cols, rows),
        on_output,
    )
}

/// Describes a folder the user picked. The dialog itself is the frontend's
/// job; what a folder *is* to the workbench is the core's.
#[tauri::command]
fn project_info(path: PathBuf) -> Result<project::ProjectInfo, String> {
    project::describe(&path)
}

#[tauri::command]
fn git_status(root: PathBuf) -> Result<Vec<git::ChangedFile>, String> {
    git::status(&root)
}

#[tauri::command]
fn git_files(root: PathBuf) -> Result<Vec<String>, String> {
    git::list_files(&root)
}

#[tauri::command]
fn git_diff(root: PathBuf, file: String) -> Result<git::FileDiff, String> {
    git::diff(&root, &file)
}

#[tauri::command]
fn git_content(root: PathBuf, file: String) -> Result<git::FileContent, String> {
    git::content(&root, &file)
}

/// Starts watching a worktree, replacing whatever was being watched before.
/// One window looks at one project's changes at a time.
#[tauri::command]
fn git_watch(
    app: AppHandle,
    watchers: State<'_, Watchers>,
    root: PathBuf,
) -> Result<(), String> {
    let worktree = git::workdir(&root)?;
    watch::watch(app, &watchers, worktree)
}

#[tauri::command]
fn git_unwatch(watchers: State<'_, Watchers>) {
    watch::unwatch(&watchers);
}

#[tauri::command]
fn pty_write(sessions: State<'_, Arc<Sessions>>, id: String, data: String) -> Result<(), String> {
    pty::write(&sessions, &id, data.as_bytes())
}

#[tauri::command]
fn pty_resize(
    sessions: State<'_, Arc<Sessions>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    pty::resize(&sessions, &id, size(cols, rows))
}

#[tauri::command]
fn pty_kill(sessions: State<'_, Arc<Sessions>>, id: String) -> Result<(), String> {
    pty::kill(&sessions, &id)
}

/// A terminal is a character grid, so a pty is sized in cells. The pixel fields
/// matter only to programs drawing sixels, and xterm.js reports none.
fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Sessions::default()))
        .manage(Watchers::default())
        .invoke_handler(tauri::generate_handler![
            agent_detect,
            project_info,
            git_status,
            git_files,
            git_diff,
            git_content,
            git_watch,
            git_unwatch,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pty_is_never_zero_sized() {
        // FitAddon reports 0 before the pane has been laid out, and a pty of
        // zero columns makes a TUI draw nothing at all.
        let s = size(0, 0);
        assert_eq!((s.cols, s.rows), (1, 1));
    }

    #[test]
    fn passes_real_sizes_through() {
        let s = size(120, 40);
        assert_eq!((s.cols, s.rows), (120, 40));
        assert_eq!((s.pixel_width, s.pixel_height), (0, 0));
    }

    #[test]
    fn detect_rejects_an_unknown_agent() {
        assert!(agent_detect("not-an-agent".into()).is_err());
    }

    #[test]
    fn detect_reports_capabilities_for_a_known_agent() {
        let report = agent_detect("claude-code".into()).unwrap();
        assert_eq!(report.id, "claude-code");
        assert!(report.caps.is_some());
    }
}
