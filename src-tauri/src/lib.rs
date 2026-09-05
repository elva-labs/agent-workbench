//! Agent Workbench core.
//!
//! Rust owns state, the webview owns pixels. Every PTY, git query, filesystem
//! watch and session index lives here; the frontend renders and dispatches.
//!
//! Every command is `async`. A synchronous Tauri command runs on the main
//! thread, which is the thread that paints the window, so a `git status` on a
//! large tree or a slow `.zshrc` would freeze the UI for as long as it took.
//! The work that can take a while goes through `blocking`, onto the runtime's
//! blocking pool, and the window stays responsive whatever the shell does.

mod activity;
mod adapter;
mod chrome;
mod codex;
mod cwd;
mod env;
mod git;
mod hook;
mod menu;
mod project;
mod pty;
mod shell;
mod transcripts;
mod watch;
mod webdriver;

use std::path::PathBuf;
use std::sync::Arc;

use portable_pty::PtySize;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use adapter::{adapter_for, LaunchCtx, Surface};
use pty::Sessions;
use watch::Watchers;

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

fn detect(id: &str) -> Result<DetectReport, String> {
    let adapter = adapter_for(id).ok_or_else(|| format!("no adapter for {id}"))?;
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

#[tauri::command]
async fn agent_detect(id: String) -> Result<DetectReport, String> {
    blocking(move || detect(&id)).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Spawned {
    /// Handle for `pty_write`, `pty_resize` and `pty_kill`.
    pty_id: String,
    /// The agent's own id for the conversation, chosen here so the workbench
    /// knows it from the first byte rather than after the transcript lands.
    /// None for an agent that mints its own: `session_identified` follows
    /// once the agent has written it down.
    session_id: Option<String>,
}

pub const SESSION_IDENTIFIED: &str = "session_identified";

/// An agent that mints its own ids has written one down.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionIdentified {
    pty_id: String,
    session_id: String,
    title: Option<String>,
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn pty_spawn(
    app: AppHandle,
    sessions: State<'_, Arc<Sessions>>,
    agent: String,
    project: PathBuf,
    session: Option<String>,
    cols: u16,
    rows: u16,
    on_output: Channel,
) -> Result<Spawned, String> {
    let sessions = Arc::clone(&sessions);
    blocking(move || {
        let adapter = adapter_for(&agent).ok_or_else(|| format!("no adapter for {agent}"))?;
        let environment = env::environment();

        let ctx = LaunchCtx {
            project: &project,
            env: &environment.vars,
        };

        let (surface, session_id) = match session {
            Some(id) => (adapter.resume(&ctx, &id)?, Some(id)),
            None if adapter.mints_id() => {
                let id = new_session_id();
                (adapter.launch(&ctx, &id)?, Some(id))
            }
            None => (adapter.launch(&ctx, "")?, None),
        };
        let Surface::Pty(command) = surface;

        let started = now_secs();
        let pty_id = pty::spawn(app.clone(), sessions, command, size(cols, rows), on_output)?;
        if session_id.is_none() {
            identify_later(app, agent, project, started, pty_id.clone());
        }
        Ok(Spawned { pty_id, session_id })
    })
    .await
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Watches for the id an agent mints for the session just spawned, and says
/// so once it appears. Codex writes its thread to its index as it starts;
/// a spawn that never gets that far is simply never identified.
fn identify_later(app: AppHandle, agent: String, project: PathBuf, started: u64, pty_id: String) {
    use tauri::Emitter;
    std::thread::spawn(move || {
        let Some(home) = home_directory() else { return };
        let codex_home = codex::home(&home);
        for _ in 0..60 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if agent != "codex" {
                return;
            }
            // A second of slack: the index's clock and this one need not agree.
            if let Some((session_id, title)) =
                codex::started_since(&codex_home, &project, started.saturating_sub(1))
            {
                let _ = app.emit(
                    SESSION_IDENTIFIED,
                    SessionIdentified {
                        pty_id,
                        session_id,
                        title,
                    },
                );
                return;
            }
        }
    });
}

/// A version 4 UUID, which is what `claude --session-id` accepts.
fn new_session_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// The user's shell in a pty, for the terminal panel. Hands back the pty id
/// alone: a shell has no session to speak of.
#[tauri::command]
async fn pty_shell(
    app: AppHandle,
    sessions: State<'_, Arc<Sessions>>,
    project: PathBuf,
    cols: u16,
    rows: u16,
    on_output: Channel,
) -> Result<String, String> {
    let sessions = Arc::clone(&sessions);
    blocking(move || {
        let environment = env::environment();
        let command = shell::command(&project, &environment.vars);
        pty::spawn(app, sessions, command, size(cols, rows), on_output)
    })
    .await
}

/// Describes a folder the user picked. The dialog itself is the frontend's
/// job; what a folder *is* to the workbench is the core's.
#[tauri::command]
async fn project_info(path: PathBuf) -> Result<project::ProjectInfo, String> {
    blocking(move || project::describe(&path)).await
}

#[tauri::command]
async fn hook_status(project: PathBuf) -> Result<hook::HookStatus, String> {
    let home = home_directory().ok_or("no home directory")?;
    blocking(move || Ok(hook::status(&home, &project))).await
}

#[tauri::command]
async fn hook_install(project: PathBuf) -> Result<hook::HookStatus, String> {
    let home = home_directory().ok_or("no home directory")?;
    blocking(move || hook::install(&home, &project)).await
}

#[tauri::command]
async fn hook_uninstall(project: PathBuf) -> Result<hook::HookStatus, String> {
    let home = home_directory().ok_or("no home directory")?;
    blocking(move || hook::uninstall(&home, &project)).await
}

/// Sessions Claude Code has already had in this project, newest first.
#[tauri::command]
async fn sessions_list(
    project: PathBuf,
    agent: String,
) -> Result<Vec<transcripts::Transcript>, String> {
    let Some(home) = home_directory() else {
        return Ok(Vec::new());
    };
    blocking(move || {
        Ok(match agent.as_str() {
            "claude-code" => transcripts::list(&home, &project),
            "codex" => codex::list(&codex::home(&home), &project),
            _ => Vec::new(),
        })
    })
    .await
}

/// What an agent calls a session now, for agents that keep that in an index
/// of their own rather than in the terminal title.
#[tauri::command]
async fn session_title(agent: String, id: String) -> Result<Option<String>, String> {
    let Some(home) = home_directory() else {
        return Ok(None);
    };
    blocking(move || {
        Ok(match agent.as_str() {
            "codex" => codex::title_of(&codex::home(&home), &id),
            _ => None,
        })
    })
    .await
}

fn home_directory() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[tauri::command]
async fn git_status(root: PathBuf) -> Result<Vec<git::ChangedFile>, String> {
    blocking(move || git::status(&root)).await
}

#[tauri::command]
async fn git_files(root: PathBuf) -> Result<Vec<String>, String> {
    blocking(move || git::list_files(&root)).await
}

/// Lines matching a query, in the changed files only or in every file the
/// tree lists.
#[tauri::command]
async fn git_grep(root: PathBuf, query: String, scope: String) -> Result<git::GrepResult, String> {
    blocking(move || {
        if scope == "changed" {
            let paths: Vec<String> = git::status(&root)?
                .into_iter()
                .filter(|file| file.status != "D")
                .map(|file| file.path)
                .collect();
            git::grep(&root, &query, Some(&paths))
        } else {
            git::grep(&root, &query, None)
        }
    })
    .await
}

#[tauri::command]
async fn git_diff(root: PathBuf, file: String) -> Result<git::FileDiff, String> {
    blocking(move || git::diff(&root, &file)).await
}

#[tauri::command]
async fn git_content(root: PathBuf, file: String) -> Result<git::FileContent, String> {
    blocking(move || git::content(&root, &file)).await
}

/// Starts watching a worktree, replacing whatever was being watched before.
/// One window looks at one project's changes at a time. Calling it again for
/// the same root is how the hook's file joins the watch once it exists.
#[tauri::command]
async fn git_watch(
    app: AppHandle,
    watchers: State<'_, Arc<Watchers>>,
    root: PathBuf,
) -> Result<(), String> {
    let watchers = Arc::clone(&watchers);
    blocking(move || {
        let worktree = git::workdir(&root)?;
        let events = home_directory().map(|home| hook::events_path(&home));
        watch::watch(app, &watchers, worktree, events)
    })
    .await
}

#[tauri::command]
async fn git_unwatch(watchers: State<'_, Arc<Watchers>>) -> Result<(), String> {
    watch::unwatch(&watchers);
    Ok(())
}

#[tauri::command]
async fn pty_write(
    sessions: State<'_, Arc<Sessions>>,
    id: String,
    data: String,
) -> Result<(), String> {
    pty::write(&sessions, &id, data.as_bytes())
}

#[tauri::command]
async fn pty_resize(
    sessions: State<'_, Arc<Sessions>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    pty::resize(&sessions, &id, size(cols, rows))
}

#[tauri::command]
async fn pty_kill(sessions: State<'_, Arc<Sessions>>, id: String) -> Result<(), String> {
    pty::kill(&sessions, &id)
}

#[tauri::command]
async fn pty_cwd(sessions: State<'_, Arc<Sessions>>, id: String) -> Result<Option<String>, String> {
    pty::cwd(&sessions, &id)
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
    webdriver::forward();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Sessions::default()))
        .manage(Arc::new(Watchers::default()))
        .setup(|app| {
            menu::install(app)?;
            if let Some(window) = app.get_webview_window("main") {
                chrome::inset_window_controls(&window);
            }
            // The session log is tailed for the life of the app, whether or
            // not any hook is installed yet: installing one later just
            // starts the lines coming.
            if let Some(home) = home_directory() {
                if let Err(error) =
                    activity::watch(app.handle().clone(), hook::activity_path(&home))
                {
                    eprintln!("session log: {error}");
                }
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
        assert!(detect("not-an-agent").is_err());
    }

    #[test]
    fn detect_reports_capabilities_for_a_known_agent() {
        let report = detect("claude-code").unwrap();
        assert_eq!(report.id, "claude-code");
        assert!(report.caps.is_some());
    }

    #[test]
    fn session_ids_are_uuids_and_unique() {
        let a = new_session_id();
        let b = new_session_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36, "{a}");
        assert_eq!(a.matches('-').count(), 4, "{a}");
    }
}
