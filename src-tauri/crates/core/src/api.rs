//! The core as one object: what a window or a daemon calls.
//!
//! Every method is synchronous and may take a while: a `git status` on a
//! large tree, a slow `.zshrc`. The caller decides which thread that costs.
//! The desktop app runs them on its blocking pool so the window keeps
//! painting; the daemon gives each request a thread of its own.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use portable_pty::PtySize;
use serde::Serialize;

use crate::adapter::{self, adapter_for, LaunchCtx, Surface};
use crate::events::{self, Output, Sink};
use crate::pty::Sessions;
use crate::watch::Watchers;
use crate::{activity, codex, env, git, hook, project, pty, shell, transcripts, watch};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectReport {
    pub id: String,
    /// Absolute path to the binary, when one was found.
    pub path: Option<String>,
    pub caps: Option<adapter::Caps>,
    /// False when the login shell could not be read. It changes what a missing
    /// binary means, so the pane can say something more useful than "not found".
    pub from_login_shell: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spawned {
    /// Handle for `pty_write`, `pty_resize` and `pty_kill`.
    pub pty_id: String,
    /// The agent's own id for the conversation, chosen here so the workbench
    /// knows it from the first byte rather than after the transcript lands.
    /// None for an agent that mints its own: `session_identified` follows
    /// once the agent has written it down.
    pub session_id: Option<String>,
}

pub const SESSION_IDENTIFIED: &str = "session_identified";

/// An agent that mints its own ids has written one down.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdentified {
    pub pty_id: String,
    pub session_id: String,
    pub title: Option<String>,
}

/// A directory, for picking a project on a machine with no folder dialog.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
}

pub struct Core {
    pub sessions: Arc<Sessions>,
    pub watchers: Arc<Watchers>,
    pub sink: Arc<dyn Sink>,
    home: Option<PathBuf>,
    processes: crate::processes::Processes,
    /// None without a home directory, where there is nowhere to keep them.
    plugins: Option<crate::plugins::Plugins>,
}

/// The sink the core hands to the ptys and the watcher: everything reaches
/// the window as it would, and the three events the plugins follow reach
/// them on the way past.
struct Overheard {
    inner: Arc<dyn Sink>,
    plugins: crate::plugins::Plugins,
}

impl Sink for Overheard {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let text = |key: &str| payload.get(key).and_then(|value| value.as_str());
        match event {
            watch::GIT_CHANGED => {
                if let Some(root) = payload.as_str() {
                    self.plugins.tree_moved(root);
                }
            }
            SESSION_IDENTIFIED => {
                if let (Some(pty), Some(session)) = (text("ptyId"), text("sessionId")) {
                    self.plugins.session_identified(pty, session);
                }
            }
            pty::SESSION_ENDED => {
                if let Some(id) = text("id") {
                    self.plugins.session_ended(id);
                }
            }
            _ => {}
        }
        self.inner.emit(event, payload);
    }
}

impl Core {
    pub fn new(sink: Arc<dyn Sink>) -> Self {
        let home = home_directory();
        let plugins = home
            .as_deref()
            .map(|home| crate::plugins::Plugins::new(home, Arc::clone(&sink)));
        let sink: Arc<dyn Sink> = match plugins.clone() {
            Some(plugins) => Arc::new(Overheard {
                inner: sink,
                plugins,
            }),
            None => sink,
        };
        Self {
            sessions: Arc::new(Sessions::default()),
            processes: crate::processes::Processes::default(),
            watchers: Arc::new(Watchers::default()),
            sink,
            home,
            plugins,
        }
    }

    fn plugins(&self) -> Result<&crate::plugins::Plugins, String> {
        self.plugins
            .as_ref()
            .ok_or_else(|| "no home directory".to_string())
    }

    /// Every plugin source, with its plugins and their states.
    pub fn plugin_sources(&self) -> Result<Vec<crate::plugins::SourceInfo>, String> {
        Ok(self.plugins()?.list())
    }

    pub fn plugin_add(
        &self,
        location: &str,
        reference: Option<&str>,
    ) -> Result<crate::plugins::SourceInfo, String> {
        self.plugins()?.add(location, reference)
    }

    pub fn plugin_remove(&self, id: &str) -> Result<(), String> {
        self.plugins()?.remove(id)
    }

    pub fn plugin_check(&self, id: &str) -> Result<Option<String>, String> {
        self.plugins()?.check(id)
    }

    pub fn plugin_update(&self, id: &str) -> Result<crate::plugins::SourceInfo, String> {
        self.plugins()?.update(id)
    }

    pub fn plugin_enable(
        &self,
        id: &str,
        name: &str,
        on: bool,
    ) -> Result<crate::plugins::SourceInfo, String> {
        self.plugins()?.enable(id, name, on)
    }

    /// The projects open on this machine, for the running plugins to be
    /// told as the set changes.
    pub fn plugin_projects(&self, paths: Vec<String>) -> Result<(), String> {
        self.plugins()?.set_projects(paths);
        Ok(())
    }

    /// Runs an action of a plugin's section, on a row or on the header.
    /// It comes back as soon as the plugin has the line: what the action
    /// does arrives as its own event.
    #[allow(clippy::too_many_arguments)]
    pub fn plugin_action(
        &self,
        source: &str,
        plugin: &str,
        section: &str,
        action: &str,
        row: Option<&str>,
        input: &serde_json::Value,
        project: &str,
    ) -> Result<(), String> {
        self.plugins()?
            .action(source, plugin, section, action, row, input, project)
    }

    /// A message from a plugin's page to the plugin. It comes back as soon
    /// as the plugin has the line: an answer, if there is one, arrives as
    /// the plugin's own event.
    pub fn plugin_view_message(
        &self,
        source: &str,
        plugin: &str,
        project: &str,
        payload: &serde_json::Value,
    ) -> Result<(), String> {
        self.plugins()?
            .view_message(source, plugin, project, payload)
    }

    pub fn home(&self) -> Option<&Path> {
        self.home.as_deref()
    }

    /// Tails the session log for as long as the core lives, whether or not
    /// any hook is installed yet: installing one later just starts the lines
    /// coming.
    pub fn start(&self) -> Result<(), String> {
        match &self.home {
            Some(home) => {
                activity::watch(Arc::clone(&self.sink), hook::activity_path(home))?;
                // A tool call in the log belongs to a plugin, not to the
                // window: it goes to the process that owns the tool.
                let plugins = self.plugins.clone();
                crate::show::watch(
                    Arc::clone(&self.sink),
                    crate::show::requests_path(home),
                    move |request| {
                        if let Some(plugins) = &plugins {
                            plugins.call(request);
                        }
                    },
                )?;
                if let Some(plugins) = &self.plugins {
                    plugins.start_enabled();
                }
                Ok(())
            }
            None => Ok(()),
        }
    }

    pub fn detect(&self, id: &str) -> Result<DetectReport, String> {
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

    /// `cwd` is where the agent runs when that is not the project itself:
    /// a worktree under it that a resumed session belongs to.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        agent: &str,
        project: &Path,
        cwd: Option<&Path>,
        session: Option<String>,
        cols: u16,
        rows: u16,
        output: impl FnOnce(&str) -> Output,
    ) -> Result<Spawned, String> {
        let adapter = adapter_for(agent).ok_or_else(|| format!("no adapter for {agent}"))?;
        let environment = env::environment();
        // The project a session belongs to is the one that is open, which
        // is what the plugins know it by, and not the worktree under it
        // the agent may run in.
        let opened = project.to_string_lossy().to_string();
        let project = cwd.unwrap_or(project);

        // A resumed session's id is known, and a fresh one's when the
        // workbench mints it; an agent that mints its own is found later.
        let resumed = session.is_some();
        let session_id = match session {
            Some(id) => Some(id),
            None if adapter.mints_id() => Some(new_session_id()),
            None => None,
        };
        let ctx = LaunchCtx {
            project,
            env: &environment.vars,
            session: session_id.as_deref(),
        };
        let surface = match &session_id {
            Some(id) if resumed => adapter.resume(&ctx, id)?,
            Some(id) => adapter.launch(&ctx, id)?,
            None => adapter.launch(&ctx, "")?,
        };
        let Surface::Pty(command) = surface;

        let started = now_secs();
        let pty_id = pty::spawn(
            Arc::clone(&self.sink),
            Arc::clone(&self.sessions),
            command,
            size(cols, rows),
            output,
        )?;
        if let Some(plugins) = &self.plugins {
            plugins.session_started(&pty_id, session_id.as_deref(), &opened);
        }
        if session_id.is_none() {
            if let Some(home) = &self.home {
                identify_later(
                    Arc::clone(&self.sink),
                    codex::home(home),
                    agent.to_string(),
                    project.to_path_buf(),
                    started,
                    pty_id.clone(),
                );
            }
        }
        Ok(Spawned { pty_id, session_id })
    }

    /// The user's shell in a pty, for the terminal panel. Hands back the pty
    /// id alone: a shell has no session to speak of.
    pub fn shell(
        &self,
        project: &Path,
        cols: u16,
        rows: u16,
        output: impl FnOnce(&str) -> Output,
    ) -> Result<String, String> {
        let environment = env::environment();
        let command = shell::command(project, &environment.vars);
        pty::spawn(
            Arc::clone(&self.sink),
            Arc::clone(&self.sessions),
            command,
            size(cols, rows),
            output,
        )
    }

    /// Describes a folder the user picked. The dialog itself is the window's
    /// job; what a folder *is* to the workbench is the core's.
    pub fn project_info(&self, path: &Path) -> Result<project::ProjectInfo, String> {
        project::describe(path)
    }

    pub fn hook_status(&self, project: &Path) -> Result<hook::HookStatus, String> {
        let home = self.home.as_ref().ok_or("no home directory")?;
        Ok(hook::status(home, project))
    }

    pub fn hook_install(&self, project: &Path) -> Result<hook::HookStatus, String> {
        let home = self.home.as_ref().ok_or("no home directory")?;
        hook::install(home, project)
    }

    pub fn hook_uninstall(&self, project: &Path) -> Result<hook::HookStatus, String> {
        let home = self.home.as_ref().ok_or("no home directory")?;
        hook::uninstall(home, project)
    }

    /// Sessions an agent has already had in this project, newest first.
    pub fn sessions_list(&self, project: &Path, agent: &str) -> Vec<transcripts::Transcript> {
        let Some(home) = &self.home else {
            return Vec::new();
        };
        match agent {
            "claude-code" => transcripts::list(home, project),
            "codex" => codex::list(&codex::home(home), project),
            _ => Vec::new(),
        }
    }

    /// What an agent calls a session now, for agents that keep that in an
    /// index of their own rather than in the terminal title.
    pub fn session_title(&self, agent: &str, id: &str) -> Option<String> {
        let home = self.home.as_ref()?;
        match agent {
            "codex" => codex::title_of(&codex::home(home), id),
            _ => None,
        }
    }

    pub fn git_status(&self, root: &Path) -> Result<Vec<git::ChangedFile>, String> {
        git::status(root)
    }

    pub fn git_files(&self, root: &Path) -> Result<Vec<String>, String> {
        git::list_files(root)
    }

    /// Lines matching a query, in the changed files only or in every file
    /// the tree lists.
    pub fn git_grep(
        &self,
        root: &Path,
        query: &str,
        scope: &str,
    ) -> Result<git::GrepResult, String> {
        if scope == "changed" {
            let paths: Vec<String> = git::status(root)?
                .into_iter()
                .filter(|file| file.status != "D")
                .map(|file| file.path)
                .collect();
            git::grep(root, query, Some(&paths))
        } else {
            git::grep(root, query, None)
        }
    }

    pub fn git_diff(&self, root: &Path, file: &str) -> Result<git::FileDiff, String> {
        git::diff(root, file)
    }

    pub fn git_content(&self, root: &Path, file: &str) -> Result<git::FileContent, String> {
        git::content(root, file)
    }

    /// An image or a PDF for the window to show, encoded.
    /// What the user is looking at, on record for the tool server to read.
    pub fn set_selection(
        &self,
        selection: Option<crate::selection::Selection>,
    ) -> Result<(), String> {
        let home = self.home.as_deref().ok_or("no home directory")?;
        crate::selection::write(home, selection.as_ref())
    }

    pub fn read_media(&self, path: &Path) -> Result<crate::show::Media, String> {
        crate::show::read_media(path)
    }

    /// Starts watching a worktree, replacing whatever was being watched
    /// before. One window looks at one project's changes at a time. Calling
    /// it again for the same root is how the hook's file joins the watch once
    /// it exists.
    pub fn git_watch(&self, root: &Path) -> Result<(), String> {
        let worktree = git::workdir(root)?;
        let events = self.home.as_ref().map(|home| hook::events_path(home));
        watch::watch(Arc::clone(&self.sink), &self.watchers, worktree, events)
    }

    pub fn git_unwatch(&self) {
        watch::unwatch(&self.watchers);
    }

    pub fn pty_write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        pty::write(&self.sessions, id, data)
    }

    pub fn pty_resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        pty::resize(&self.sessions, id, size(cols, rows))
    }

    pub fn pty_kill(&self, id: &str) -> Result<(), String> {
        pty::kill(&self.sessions, id)
    }

    pub fn pty_cwd(&self, id: &str) -> Result<Option<String>, String> {
        pty::cwd(&self.sessions, id)
    }

    /// What runs under the session's process, the process itself left out.
    pub fn pty_processes(&self, id: &str) -> Result<Vec<crate::processes::Process>, String> {
        let root = pty::pid(&self.sessions, id)?;
        Ok(root
            .map(|root| self.processes.under(root))
            .unwrap_or_default())
    }

    /// Stops a process running under the session.
    pub fn pty_stop_process(&self, id: &str, pid: u32) -> Result<(), String> {
        let root = pty::pid(&self.sessions, id)?.ok_or("the session has no process")?;
        self.processes.stop(root, pid)
    }

    /// The directories directly under a path, by name, hidden ones left out.
    /// An empty path means the home directory: where browsing starts on a
    /// machine you cannot see.
    pub fn list_dirs(&self, path: &str) -> Result<Vec<DirEntry>, String> {
        let base = if path.is_empty() {
            self.home.clone().ok_or("no home directory")?
        } else {
            PathBuf::from(path)
        };
        let entries = std::fs::read_dir(&base)
            .map_err(|e| format!("could not read {}: {e}", base.display()))?;
        let mut dirs: Vec<DirEntry> = entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| !name.starts_with('.'))
            .map(|name| DirEntry {
                path: base.join(&name).to_string_lossy().to_string(),
                name,
            })
            .collect();
        dirs.sort_by_key(|dir| dir.name.to_lowercase());
        Ok(dirs)
    }
}

pub fn home_directory() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
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
fn identify_later(
    sink: Arc<dyn Sink>,
    codex_home: PathBuf,
    agent: String,
    project: PathBuf,
    started: u64,
    pty_id: String,
) {
    std::thread::spawn(move || {
        for _ in 0..60 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if agent != "codex" {
                return;
            }
            // A second of slack: the index's clock and this one need not agree.
            if let Some((session_id, title)) =
                codex::started_since(&codex_home, &project, started.saturating_sub(1))
            {
                events::emit(
                    &sink,
                    SESSION_IDENTIFIED,
                    &SessionIdentified {
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

/// A terminal is a character grid, so a pty is sized in cells. The pixel
/// fields matter only to programs drawing sixels, and xterm.js reports none.
fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::testing::Recorder;

    fn core() -> Core {
        Core::new(Arc::new(Recorder::default()))
    }

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
        assert!(core().detect("not-an-agent").is_err());
    }

    #[test]
    fn detect_reports_capabilities_for_a_known_agent() {
        let report = core().detect("claude-code").unwrap();
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

    #[test]
    fn lists_the_directories_under_a_path_and_skips_the_hidden() {
        let dir = std::env::temp_dir().join("workbench-api-dirs");
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join("beta")).unwrap();
        std::fs::create_dir_all(dir.join("Alpha")).unwrap();
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        std::fs::write(dir.join("file.txt"), "").unwrap();

        let dirs = core().list_dirs(&dir.to_string_lossy()).unwrap();
        assert_eq!(
            dirs.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
            ["Alpha", "beta"]
        );
        assert_eq!(dirs[1].path, dir.join("beta").to_string_lossy());
    }

    #[test]
    fn a_missing_directory_is_an_error_not_a_panic() {
        assert!(core().list_dirs("/definitely/not/here").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_shell_ends_and_says_so_through_the_sink() {
        let recorder = Arc::new(Recorder::default());
        let core = Core::new(recorder.clone());
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let output: Output = Box::new({
            let seen = Arc::clone(&seen);
            move |bytes| {
                seen.lock().unwrap().extend_from_slice(bytes);
                true
            }
        });
        let id = core.shell(Path::new("/tmp"), 80, 24, |_| output).unwrap();
        core.pty_write(&id, b"exit 3\n").unwrap();
        for _ in 0..100 {
            if !recorder.events.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let events = recorder.events.lock().unwrap();
        let (name, payload) = events.first().expect("the end was announced");
        assert_eq!(name, pty::SESSION_ENDED);
        assert_eq!(payload["id"], id);
        assert_eq!(payload["code"], 3);
        assert_eq!(payload["clean"], false);
    }
}
