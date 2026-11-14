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

use crate::account;
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

/// Why an integrated session is not started with a workflow's instructions:
/// an integrated session has no way to be given them, and starting it
/// without them would drop the workflow unseen.
pub const NO_INTEGRATED_WORKFLOW: &str = "An integrated session cannot follow a workflow, because it is not given a workflow's instructions. Start a session that follows a workflow in a terminal.";

/// Why a session that follows a workflow is not started: it would have no
/// start tool to hand its work out with.
pub const NO_TOOLS: &str = "This session follows a workflow, which hands out its work with the workbench's tools, and this machine has no tool server to give it them. Pick an agent to start one alone instead.";

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
    /// The integrated sessions, beside the ptys.
    pub integrated: Arc<crate::integrated::Sessions>,
    pub watchers: Arc<Watchers>,
    pub sink: Arc<dyn Sink>,
    home: Option<PathBuf>,
    processes: crate::processes::Processes,
    /// None without a home directory, where there is nowhere to keep them.
    plugins: Option<crate::plugins::Plugins>,
    /// None without a home directory, for the same reason.
    settings: Option<Arc<crate::settings::Store>>,
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
        Self::at_home(sink, home_directory())
    }

    /// A core whose home is the one given rather than the user's.
    fn at_home(sink: Arc<dyn Sink>, home: Option<PathBuf>) -> Self {
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
        let settings = home
            .as_deref()
            .map(|home| Arc::new(crate::settings::Store::new(home, Arc::clone(&sink))));
        Self {
            sessions: Arc::new(Sessions::default()),
            integrated: Arc::new(crate::integrated::Sessions::default()),
            processes: crate::processes::Processes::default(),
            watchers: Arc::new(Watchers::default()),
            sink,
            home,
            plugins,
            settings,
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

    /// Clones a source the app's own list names, so its plugins can be
    /// turned on.
    pub fn plugin_fetch(&self, id: &str) -> Result<crate::plugins::SourceInfo, String> {
        self.plugins()?.fetch(id)
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

    fn settings(&self) -> Result<&Arc<crate::settings::Store>, String> {
        self.settings
            .as_ref()
            .ok_or_else(|| "no home directory".to_string())
    }

    /// The machine's settings, and whether a file held them yet.
    pub fn settings_get(&self) -> Result<crate::settings::Stored, String> {
        Ok(self.settings()?.load())
    }

    /// The user's own stylesheet, or none and why it is not handed over.
    pub fn styles_get(&self) -> Result<crate::styles::Styles, String> {
        Ok(self.settings()?.styles())
    }

    /// Writes the user's own stylesheet once it passes; an empty one takes
    /// the file away. Every window hears of it.
    pub fn styles_set(&self, css: &str) -> Result<crate::styles::Styles, String> {
        self.settings()?.set_styles(css)
    }

    /// Watches the settings file, so an edit to it reaches the window. The
    /// app does this for the machine it runs on; a daemon on another machine
    /// does not, since the settings a window follows are its own machine's.
    pub fn watch_settings(&self) -> Result<(), String> {
        self.settings()?.watch()
    }

    /// Lays a change over the machine's settings. Answers with the settings
    /// as they now are, which every window hears as well.
    pub fn settings_set(
        &self,
        change: &serde_json::Value,
    ) -> Result<crate::settings::Settings, String> {
        self.settings()?.set(change)
    }

    /// Hands over the settings a window holds, for a machine whose file is
    /// not there. They are written only if it is still not there; a file
    /// that is there by then stands, and is what the answer holds.
    pub fn settings_hand_over(
        &self,
        held: &serde_json::Value,
    ) -> Result<crate::settings::Stored, String> {
        self.settings()?.hand_over(held)
    }

    /// Tails the session log for as long as the core lives, whether or not
    /// any hook is installed yet: installing one later just starts the lines
    /// coming.
    pub fn start(&self) -> Result<(), String> {
        match &self.home {
            Some(home) => {
                activity::watch(Arc::clone(&self.sink), hook::activity_path(home))?;
                // A tool call in the log belongs to a plugin, not to the
                // window: it goes to the process that owns the tool. A
                // conductor's call is the window's, which owns the
                // sessions, and it answers through `conduct_answer`. A
                // browser call is the window's too, which owns the
                // browser's tabs, and it answers through `browser_answer`.
                let plugins = self.plugins.clone();
                let sink = Arc::clone(&self.sink);
                let browser_sink = Arc::clone(&self.sink);
                crate::show::watch(
                    Arc::clone(&self.sink),
                    crate::show::requests_path(home),
                    move |request| {
                        if let Some(plugins) = &plugins {
                            plugins.call(request);
                        }
                    },
                    move |request| events::emit(&sink, crate::show::CONDUCT_REQUEST, &request),
                    move |request| {
                        events::emit(&browser_sink, crate::show::BROWSER_REQUEST, &request)
                    },
                )?;
                // Starting the plugins reads manifests and spawns runtimes,
                // which is not for the thread the window is being drawn on.
                if let Some(plugins) = self.plugins.clone() {
                    std::thread::spawn(move || plugins.start_enabled());
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
    /// a worktree under it that a resumed session belongs to. `config_dir`
    /// is where the agent keeps its configuration when the session runs
    /// under an account of the user's own, spelled with `~` for the home.
    /// `instructions` are a workflow's, for a session that follows one: it
    /// directs the others, has the workbench's tools whatever its project
    /// was told about live updates, and, with `start_only`, delegates only
    /// through them. `afresh` says what a resumed session is told now, its
    /// instructions or none, differs from what its conversation was first
    /// given.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        agent: &str,
        project: &Path,
        cwd: Option<&Path>,
        session: Option<String>,
        prompt: Option<&str>,
        model: Option<&str>,
        config_dir: Option<&str>,
        instructions: Option<&str>,
        start_only: bool,
        afresh: bool,
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
        let instructions = instructions.filter(|text| !text.trim().is_empty());
        let orchestrator = instructions.is_some() || self.is_orchestrator(project);
        self.hooks_for(agent, project, cwd, config_dir);
        let project = cwd.unwrap_or(project);

        // A resumed session's id is known, and a fresh one's when the agent
        // takes the one the workbench chooses; one it mints is found later.
        let resumed = session.is_some();
        let session_id = match session {
            Some(id) => Some(id),
            None if adapter.takes_id() => Some(new_session_id()),
            None => None,
        };
        let config_dir = config_dir.filter(|dir| !dir.trim().is_empty());
        let expanded =
            config_dir.and_then(|dir| self.home.as_deref().map(|home| account::expand(home, dir)));
        // An account's directory exists before the agent is pointed at it:
        // Claude Code makes its own, Codex refuses to start without one.
        if let Some(dir) = &expanded {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        }
        // A session that follows a workflow hands its work out with the
        // workbench's start tool, so it is not started where no tool server
        // can reach it.
        let server = match (instructions, self.home.as_deref()) {
            (None, _) => None,
            (Some(_), Some(home)) => match hook::tool_server(home, project, agent, config_dir) {
                hook::ToolServer::Configured => None,
                hook::ToolServer::Named(daemon) => Some(daemon),
                hook::ToolServer::Missing => return Err(NO_TOOLS.into()),
            },
            (Some(_), None) => return Err(NO_TOOLS.into()),
        };
        // An agent that reads the instructions and the server from files is
        // given files of the session's own, which go when the session does.
        let mut files = SessionFiles::default();
        let mut instructions_file = None;
        let mut server_file = None;
        if let (Some(text), Some(home), true) =
            (instructions, self.home.as_deref(), adapter.reads_files())
        {
            instructions_file = Some(files.write(home, "md", text)?);
            if let Some(daemon) = &server {
                server_file =
                    Some(files.write(home, "json", &adapter::claude_server_config(daemon))?);
            }
        }
        let ctx = LaunchCtx {
            project,
            env: &environment.vars,
            session: session_id.as_deref(),
            prompt: prompt.filter(|prompt| !prompt.trim().is_empty()),
            model: model.filter(|model| !model.trim().is_empty()),
            config_dir: expanded.as_deref(),
            orchestrator,
            instructions,
            instructions_file: instructions_file.as_deref(),
            start_only: instructions.is_some() && start_only,
            server: server.as_deref(),
            server_file: server_file.as_deref(),
            afresh: resumed && afresh,
        };
        let surface = match &session_id {
            Some(id) if resumed => adapter.resume(&ctx, id)?,
            Some(id) => adapter.launch(&ctx, id)?,
            None => adapter.launch(&ctx, "")?,
        };
        let Surface::Pty(command) = surface;

        let codex_activity = (agent == "codex")
            .then(|| {
                self.home.as_ref().map(|home| {
                    let home = account::codex_home(home, config_dir);
                    let activity = codex::Activity::new(&home, session_id.clone());
                    (home, activity)
                })
            })
            .flatten();
        let started = now_secs();
        let pty_id = pty::spawn(
            Arc::clone(&self.sink),
            Arc::clone(&self.sessions),
            command,
            size(cols, rows),
            output,
            files,
        )?;
        if let Some(plugins) = &self.plugins {
            plugins.session_started(&pty_id, session_id.as_deref(), &opened);
        }
        if let Some((home, activity)) = codex_activity {
            codex::observe(
                Arc::clone(&self.sink),
                Arc::clone(&self.sessions),
                home,
                project.to_path_buf(),
                started,
                pty_id.clone(),
                activity,
            );
        }
        Ok(Spawned { pty_id, session_id })
    }

    /// Starts an agent as an integrated session: a process spoken to in
    /// messages, whose news goes out as `integrated_event`. A fresh
    /// session's id is chosen here, as for a pty; `session` resumes one.
    /// The rest is as for [`Core::spawn`], with the mode and the effort the
    /// session starts in, and the workbench's tool server attached to the
    /// session when the daemon is installed where the agents look for it.
    ///
    /// The agent skips its own trust question when driven this way, so a
    /// folder it does not hold as trusted is refused with an error that
    /// starts with [`crate::integrated::UNTRUSTED`], until
    /// [`Core::integrated_trust`] records the user's yes.
    #[allow(clippy::too_many_arguments)]
    pub fn integrated_start(
        &self,
        agent: &str,
        project: &Path,
        cwd: Option<&Path>,
        session: Option<String>,
        model: Option<&str>,
        mode: Option<&str>,
        effort: Option<&str>,
        config_dir: Option<&str>,
        instructions: Option<&str>,
    ) -> Result<crate::integrated::Started, String> {
        if instructions.is_some_and(|text| !text.trim().is_empty()) {
            return Err(NO_INTEGRATED_WORKFLOW.to_string());
        }
        let adapter = adapter_for(agent).ok_or_else(|| format!("no adapter for {agent}"))?;
        let protocol = adapter
            .integrated()
            .ok_or_else(|| format!("{agent} cannot run as an integrated session"))?;
        let environment = env::environment();
        let opened = project.to_string_lossy().to_string();
        let orchestrator = self.is_orchestrator(project);
        self.hooks_for(agent, project, cwd, config_dir);
        let project = cwd.unwrap_or(project);
        let resume = session.is_some();
        // The workbench chooses a fresh session's id for an agent that takes
        // one; one that makes its own says it in `ready`.
        let session = session.or_else(|| adapter.takes_id().then(new_session_id));
        let config_dir = config_dir.filter(|dir| !dir.trim().is_empty());
        let expanded =
            config_dir.and_then(|dir| self.home.as_deref().map(|home| account::expand(home, dir)));
        let trusted = self
            .home
            .as_deref()
            .is_some_and(|home| protocol.trusted(home, expanded.as_deref(), project));
        if !trusted {
            return Err(format!(
                "{}: {} has not been trusted in {} yet",
                crate::integrated::UNTRUSTED,
                project.display(),
                protocol.name()
            ));
        }
        if let Some(dir) = &expanded {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        }
        let tool_server = self
            .home
            .as_deref()
            .map(hook::daemon_path)
            .filter(|path| path.is_file());
        let launch = crate::integrated::Launch {
            project,
            env: &environment.vars,
            session: session.as_deref(),
            resume,
            model: model.filter(|model| !model.trim().is_empty()),
            mode: mode.filter(|mode| !mode.trim().is_empty()),
            effort: effort.filter(|effort| !effort.trim().is_empty()),
            config_dir: expanded.as_deref(),
            tool_server: tool_server.as_deref(),
            orchestrator,
        };
        let (starting, ending) = (self.plugins.clone(), self.plugins.clone());
        crate::integrated::start(
            Arc::clone(&self.sink),
            Arc::clone(&self.integrated),
            protocol,
            &launch,
            Box::new(move |started| {
                if let Some(plugins) = starting {
                    plugins.session_started(&started.id, started.session_id.as_deref(), &opened);
                }
            }),
            Box::new(move |id| {
                if let Some(plugins) = ending {
                    plugins.session_ended(id);
                }
            }),
        )
    }

    /// Records that the user trusts the folder an integrated session of the
    /// agent would run in, under the account whose configuration directory
    /// is given, where the agent's own trust question would.
    pub fn integrated_trust(
        &self,
        agent: &str,
        project: &Path,
        cwd: Option<&Path>,
        config_dir: Option<&str>,
    ) -> Result<(), String> {
        let adapter = adapter_for(agent).ok_or_else(|| format!("no adapter for {agent}"))?;
        let protocol = adapter
            .integrated()
            .ok_or_else(|| format!("{agent} cannot run as an integrated session"))?;
        let home = self.home.as_deref().ok_or("no home directory")?;
        let expanded = config_dir
            .filter(|dir| !dir.trim().is_empty())
            .map(|dir| account::expand(home, dir));
        protocol.trust(home, expanded.as_deref(), cwd.unwrap_or(project))
    }

    /// Sends the user's message, with any images, under the id the window
    /// chose for it, which the turn that answers it names.
    pub fn integrated_send(
        &self,
        id: &str,
        message: &str,
        text: &str,
        images: &[crate::integrated::Image],
    ) -> Result<(), String> {
        crate::integrated::send(&self.integrated, id, message, text, images)
    }

    /// Stops the turn that is running. Queued messages stay queued.
    pub fn integrated_interrupt(&self, id: &str) -> Result<(), String> {
        crate::integrated::control(&self.integrated, id, &crate::integrated::Control::Interrupt)
            .map(|_| ())
    }

    /// Compacts the conversation, in the agent's own way. Comes back once
    /// asked; the compaction's events follow.
    pub fn integrated_compact(&self, id: &str) -> Result<(), String> {
        crate::integrated::control(&self.integrated, id, &crate::integrated::Control::Compact)
            .map(|_| ())
    }

    /// Answers a permission request the session asked.
    pub fn integrated_answer(
        &self,
        id: &str,
        request: &str,
        choice: crate::integrated::Choice,
        message: Option<&str>,
    ) -> Result<(), String> {
        crate::integrated::answer(&self.integrated, id, request, choice, message)
    }

    /// Answers a question the session asked; None declines.
    pub fn integrated_reply(
        &self,
        id: &str,
        request: &str,
        answers: Option<&[Vec<String>]>,
    ) -> Result<(), String> {
        crate::integrated::reply(&self.integrated, id, request, answers)
    }

    /// Switches the session's model, mode or effort, each that is given.
    /// Answers with what the session now runs on.
    pub fn integrated_configure(
        &self,
        id: &str,
        model: Option<&str>,
        mode: Option<&str>,
        effort: Option<&str>,
    ) -> Result<crate::integrated::Settings, String> {
        crate::integrated::configure(&self.integrated, id, model, mode, effort)
    }

    /// What a window that comes to an integrated session late reads to
    /// catch up, after every event that went out before it.
    pub fn integrated_snapshot(&self, id: &str) -> Result<crate::integrated::Snapshot, String> {
        crate::integrated::snapshot(&self.integrated, id)
    }

    /// Stops every integrated session, and waits a few seconds for them to
    /// be gone: for the end of the app or the daemon.
    pub fn integrated_stop_all(&self) {
        crate::integrated::stop_all(&self.integrated);
    }

    /// Ends an integrated session. Comes back at once; the session's
    /// `ended` event follows.
    pub fn integrated_stop(&self, id: &str) -> Result<(), String> {
        crate::integrated::stop(&self.integrated, id)
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
            (),
        )
    }

    /// Describes a folder the user picked. The dialog itself is the window's
    /// job; what a folder *is* to the workbench is the core's.
    pub fn project_info(&self, path: &Path) -> Result<project::ProjectInfo, String> {
        project::describe(path)
    }

    /// The accounts are the user's own, so the server the hooks point the
    /// agents at is written for every one of them.
    pub fn hook_status(
        &self,
        project: &Path,
        accounts: &[account::Dirs],
    ) -> Result<hook::HookStatus, String> {
        let home = self.home.as_ref().ok_or("no home directory")?;
        Ok(hook::status(home, project, accounts))
    }

    /// The status of each project, in the order given, from one read of
    /// every account's state.
    pub fn hook_status_many(
        &self,
        projects: &[PathBuf],
        accounts: &[account::Dirs],
    ) -> Result<Vec<hook::HookStatus>, String> {
        let home = self.home.as_ref().ok_or("no home directory")?;
        Ok(hook::status_many(home, projects, accounts))
    }

    pub fn hook_install(
        &self,
        project: &Path,
        accounts: &[account::Dirs],
    ) -> Result<hook::HookStatus, String> {
        let home = self.home.as_ref().ok_or("no home directory")?;
        hook::install(home, project, accounts)
    }

    pub fn hook_uninstall(
        &self,
        project: &Path,
        accounts: &[account::Dirs],
    ) -> Result<hook::HookStatus, String> {
        let home = self.home.as_ref().ok_or("no home directory")?;
        hook::uninstall(home, project, accounts)
    }

    /// Sessions an agent has already had in this project, newest first,
    /// from the account whose configuration directory is given, or the
    /// agent's own.
    pub fn sessions_list(
        &self,
        project: &Path,
        agent: &str,
        config_dir: Option<&str>,
    ) -> Vec<transcripts::Transcript> {
        let Some(home) = &self.home else {
            return Vec::new();
        };
        match agent {
            "claude-code" => transcripts::list(&account::claude_dir(home, config_dir), project),
            "codex" => codex::list(&account::codex_home(home, config_dir), project),
            _ => Vec::new(),
        }
    }

    /// The past sessions of several projects at once, in the order given,
    /// from one read of the account's directory.
    pub fn sessions_list_many(
        &self,
        projects: &[PathBuf],
        agent: &str,
        config_dir: Option<&str>,
    ) -> Vec<Vec<transcripts::Transcript>> {
        let Some(home) = &self.home else {
            return vec![Vec::new(); projects.len()];
        };
        match agent {
            "claude-code" => {
                transcripts::list_many(&account::claude_dir(home, config_dir), projects)
            }
            "codex" => codex::list_many(&account::codex_home(home, config_dir), projects),
            _ => vec![Vec::new(); projects.len()],
        }
    }

    /// What an agent calls a session now, for agents that keep that in an
    /// index of their own rather than in the terminal title.
    pub fn session_title(&self, agent: &str, id: &str, config_dir: Option<&str>) -> Option<String> {
        let home = self.home.as_ref()?;
        match agent {
            "codex" => codex::title_of(&account::codex_home(home, config_dir), id),
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

    /// The answer to a call on one of the conductor's tools, left where
    /// the tool server that made the call is waiting for it.
    pub fn conduct_answer(
        &self,
        id: &str,
        content: Option<String>,
        error: Option<String>,
    ) -> Result<(), String> {
        let home = self.home.as_deref().ok_or("no home directory")?;
        crate::show::write_answer(home, id, &crate::show::Answer { content, error })
    }

    /// Where an orchestrator session runs: a directory of its own under the
    /// workbench's home, made the first time it is asked for. A session
    /// there is a session like any other; what it has is a place to keep
    /// the notes of the work it is directing.
    pub fn orchestrator_dir(&self) -> Result<String, String> {
        let dir = self
            .home
            .as_deref()
            .map(orchestrator_path)
            .ok_or("no home directory")?;
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        Ok(dir.to_string_lossy().to_string())
    }

    /// Whether a session spawned in this project is the one that directs
    /// the others. The comparison is between canonical paths, so a link on
    /// the way to the home directory is the same place either way round.
    fn is_orchestrator(&self, project: &Path) -> bool {
        let Some(dir) = self.home.as_deref().map(orchestrator_path) else {
            return false;
        };
        match (dunce::canonicalize(project), dunce::canonicalize(&dir)) {
            (Ok(project), Ok(dir)) => project == dir,
            _ => false,
        }
    }

    /// A worktree of the project, on a branch of the same name, for a
    /// session to work in without touching the branch the user is on.
    /// Answers with where it is.
    pub fn worktree_add(
        &self,
        project: &Path,
        name: &str,
        accounts: &[account::Dirs],
    ) -> Result<String, String> {
        let path = git::worktree_add(project, name)?;
        // The agents ask about a directory they have not run in; a worktree
        // is the project under another path, and has the project's answer,
        // under every account. It has the project's hooks too, so a session
        // there reports its state as one in the project does; a session
        // without them still runs, read off its output, so a failure to give
        // them is logged rather than refused.
        if let Some(home) = &self.home {
            hook::trust_like(home, project, Path::new(&path), accounts)?;
            if let Err(error) = hook::share(home, project, Path::new(&path), accounts) {
                eprintln!("hooks for the worktree {path}: {error}");
            }
        }
        Ok(path)
    }

    /// Gives a worktree a session is about to run in the hooks its project
    /// has, when it lacks them: a worktree made before its project had them
    /// gets them then. `cwd` is where the session runs, and nothing is done
    /// when that is the project itself or not one of its worktrees. The
    /// session runs either way, so a failure is logged rather than refused.
    fn hooks_for(&self, agent: &str, project: &Path, cwd: Option<&Path>, config_dir: Option<&str>) {
        let (Some(home), Some(cwd)) = (&self.home, cwd) else {
            return;
        };
        if cwd == project {
            return;
        }
        let dir = config_dir
            .filter(|dir| !dir.trim().is_empty())
            .map(str::to_string);
        let accounts = [account::Dirs {
            claude: dir.clone().filter(|_| agent == "claude-code"),
            codex: dir.filter(|_| agent == "codex"),
        }];
        if let Err(error) = hook::share(home, project, cwd, &accounts) {
            eprintln!("hooks for the worktree {}: {error}", cwd.display());
        }
    }

    /// The worktrees the workbench has made for the project, each saying
    /// whether it holds work the project does not and whether anything in
    /// it is uncommitted.
    pub fn worktrees(&self, project: &Path) -> Result<Vec<git::Worktree>, String> {
        git::worktrees(project)
    }

    /// Takes one of those worktrees away, and its branch with it. Refuses
    /// one that still holds work. The hooks' files go with the tree; what
    /// they put in the agents' own state for it goes too.
    pub fn worktree_remove(
        &self,
        project: &Path,
        name: &str,
        accounts: &[account::Dirs],
    ) -> Result<(), String> {
        let tree = project.join(git::WORKTREES).join(name);
        let tree = dunce::canonicalize(&tree).unwrap_or(tree);
        git::worktree_remove(project, name)?;
        // The tree is gone, which is what the call is for. A state file
        // that cannot be read keeps the entry rather than turn the removal
        // into an error.
        if let Some(home) = &self.home {
            let _ = hook::forget(home, &tree, accounts);
        }
        Ok(())
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

    /// The files the viewer shows as they are on disk, wherever they are,
    /// so a change to one reaches the viewer. An empty list is none.
    pub fn watch_shown(&self, files: &[PathBuf]) {
        watch::watch_shown(&self.watchers, files);
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

/// Where the orchestrator's own project sits under a home directory.
fn orchestrator_path(home: &Path) -> PathBuf {
    home.join(".agent-workbench").join("orchestrator")
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

/// A version 4 UUID, which is what `claude --session-id` accepts.
fn new_session_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Files a session reads while it runs, each made new and readable by its
/// owner alone, and removed when the session is done with them: when its
/// process ends, or when it never starts.
#[derive(Default)]
struct SessionFiles {
    paths: Vec<PathBuf>,
}

impl SessionFiles {
    /// Writes a file of the session's own under the workbench's directory,
    /// and answers with where it is.
    fn write(&mut self, home: &Path, extension: &str, text: &str) -> Result<PathBuf, String> {
        let dir = own_dir(home)?;
        let path = dir.join(format!("{}.{extension}", new_session_id()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .map_err(|e| format!("could not create {}: {e}", path.display()))?;
        self.paths.push(path.clone());
        std::io::Write::write_all(&mut file, text.as_bytes())
            .map_err(|e| format!("could not write {}: {e}", path.display()))?;
        Ok(path)
    }
}

impl Drop for SessionFiles {
    fn drop(&mut self) {
        for path in &self.paths {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Where the files sessions read while they run are kept.
fn sessions_dir(home: &Path) -> PathBuf {
    home.join(".agent-workbench").join("sessions")
}

/// How long a lock file is left alone after it is made, so one whose
/// process has made it and not yet taken it is never mistaken for one left
/// behind.
const LOCK_SETTLES: std::time::Duration = std::time::Duration::from_secs(60);

/// The folder this process keeps its sessions' files in, under the
/// sessions folder: one of its own, beside a lock file it holds for as long
/// as it runs. The first time it is asked for, what processes that ended
/// without removing their files left behind is removed.
fn own_dir(home: &Path) -> Result<PathBuf, String> {
    own_dir_locking(home, |file| file.try_lock())
}

/// `own_dir`, taking the lock with `lock`. Where the lock cannot be taken,
/// as on a filesystem that does not lock, the folder has no lock file, so
/// no process sweeps it, and this one sweeps nothing: it cannot tell a
/// folder left behind from one in use.
fn own_dir_locking(
    home: &Path,
    lock: impl Fn(&std::fs::File) -> Result<(), std::fs::TryLockError>,
) -> Result<PathBuf, String> {
    // Each folder with the lock this process holds on it, where it could
    // take one.
    type Owned = Vec<(PathBuf, PathBuf, Option<std::fs::File>)>;
    static OWNED: std::sync::Mutex<Owned> = std::sync::Mutex::new(Vec::new());
    let mut owned = OWNED.lock().unwrap_or_else(|e| e.into_inner());
    let made = |dir: &Path| {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))
    };
    if let Some((_, dir, _)) = owned.iter().find(|(at, _, _)| at == home) {
        made(dir)?;
        return Ok(dir.clone());
    }
    let root = sessions_dir(home);
    made(&root)?;
    let name = new_session_id();
    let lock_path = root.join(format!("{name}.lock"));
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .map_err(|e| format!("could not create {}: {e}", lock_path.display()))?;
    let held = if lock(&file).is_ok() {
        sweep_sessions(&root);
        Some(file)
    } else {
        drop(file);
        std::fs::remove_file(&lock_path)
            .map_err(|e| format!("could not remove {}: {e}", lock_path.display()))?;
        None
    };
    let dir = root.join(&name);
    made(&dir)?;
    owned.push((home.to_path_buf(), dir.clone(), held));
    Ok(dir)
}

/// Removes the folders of processes that are gone: those whose lock file
/// no process holds and that were not made a moment ago. A process that
/// ends lets go of its lock however it ends, so this is what a crash left.
fn sweep_sessions(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("lock") {
            continue;
        }
        let settled = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|at| at.elapsed().ok())
            .is_some_and(|age| age >= LOCK_SETTLES);
        if !settled {
            continue;
        }
        let Ok(file) = std::fs::OpenOptions::new().write(true).open(&path) else {
            continue;
        };
        if file.try_lock().is_err() {
            continue;
        }
        std::fs::remove_dir_all(path.with_extension("")).ok();
        drop(file);
        std::fs::remove_file(&path).ok();
    }
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
    use crate::scratch::Scratch;

    fn core() -> Core {
        Core::new(Arc::new(Recorder::default()))
    }

    /// A core whose home is the given directory, with no plugins and no
    /// settings.
    fn core_at(home: &Path) -> Core {
        Core {
            sessions: Arc::new(Sessions::default()),
            integrated: Arc::new(crate::integrated::Sessions::default()),
            processes: crate::processes::Processes::default(),
            watchers: Arc::new(Watchers::default()),
            sink: Arc::new(Recorder::default()),
            home: Some(home.to_path_buf()),
            plugins: None,
            settings: None,
        }
    }

    #[test]
    fn a_session_under_a_workflow_is_refused_where_no_tool_server_can_reach_it() {
        let home = Scratch::new("api-no-tools");
        let spawned = core_at(&home).spawn(
            "claude-code",
            &home,
            None,
            None,
            None,
            None,
            None,
            Some("1. Direct the work."),
            true,
            false,
            80,
            24,
            |_| Box::new(|_: &[u8]| true),
        );
        assert_eq!(spawned.err().as_deref(), Some(NO_TOOLS));
    }

    #[test]
    fn an_integrated_session_is_refused_workflow_instructions_it_cannot_be_given() {
        let home = Scratch::new("api-integrated-workflow");
        let started = core_at(&home).integrated_start(
            "claude-code",
            &home,
            None,
            None,
            None,
            None,
            None,
            None,
            Some("1. Direct the work."),
        );
        assert_eq!(started.err().as_deref(), Some(NO_INTEGRATED_WORKFLOW));
    }

    #[test]
    fn a_session_file_is_made_new_for_its_owner_alone_and_goes_with_the_session() {
        let home = Scratch::new("api-session-files");
        let mut files = SessionFiles::default();
        let told = files
            .write(&home, "md", "1. Direct the work.\n2. Report.")
            .unwrap();
        assert_eq!(
            told.parent().unwrap().parent().unwrap(),
            sessions_dir(&home)
        );
        assert_eq!(
            std::fs::read_to_string(&told).unwrap(),
            "1. Direct the work.\n2. Report."
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&told).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let other = files.write(&home, "json", "{}").unwrap();
        assert_ne!(told, other);
        drop(files);
        assert!(!told.exists() && !other.exists());
    }

    #[test]
    fn what_a_process_that_is_gone_left_is_swept_and_nothing_else() {
        let home = Scratch::new("api-sweep");
        let root = sessions_dir(&home);
        std::fs::create_dir_all(&root).unwrap();
        let long_ago = std::time::SystemTime::now() - 2 * LOCK_SETTLES;
        // Left by a process that crashed: its lock is free and old.
        let gone = root.join("gone");
        std::fs::create_dir_all(&gone).unwrap();
        std::fs::write(gone.join("a.md"), "1. Direct the work.").unwrap();
        let gone_lock = std::fs::File::create(root.join("gone.lock")).unwrap();
        gone_lock.set_modified(long_ago).unwrap();
        drop(gone_lock);
        // Held by a process that runs.
        let held = root.join("held");
        std::fs::create_dir_all(&held).unwrap();
        std::fs::write(held.join("b.md"), "text").unwrap();
        let held_lock = std::fs::File::create(root.join("held.lock")).unwrap();
        held_lock.set_modified(long_ago).unwrap();
        held_lock.try_lock().unwrap();
        // Just made, by a process that has not taken its lock yet.
        let new = root.join("new");
        std::fs::create_dir_all(&new).unwrap();
        std::fs::File::create(root.join("new.lock")).unwrap();

        let mut files = SessionFiles::default();
        let told = files.write(&home, "md", "text").unwrap();
        assert!(!gone.exists() && !root.join("gone.lock").exists());
        assert!(held.join("b.md").exists() && root.join("held.lock").exists());
        assert!(new.exists() && root.join("new.lock").exists());
        // This process's own folder has its lock, which it holds.
        let own = told.parent().unwrap();
        let own_lock = own.with_extension("lock");
        assert!(own_lock.exists());
        assert!(std::fs::File::open(&own_lock).unwrap().try_lock().is_err());
        drop(held_lock);
        drop(files);
    }

    #[test]
    fn a_filesystem_that_cannot_lock_still_starts_sessions_and_sweeps_nothing() {
        let home = Scratch::new("api-no-lock");
        let root = sessions_dir(&home);
        std::fs::create_dir_all(&root).unwrap();
        // What looks left behind, which a process that cannot lock cannot
        // tell from a folder in use.
        let gone = root.join("gone");
        std::fs::create_dir_all(&gone).unwrap();
        let gone_lock = std::fs::File::create(root.join("gone.lock")).unwrap();
        gone_lock
            .set_modified(std::time::SystemTime::now() - 2 * LOCK_SETTLES)
            .unwrap();
        drop(gone_lock);

        let unsupported = |_: &std::fs::File| {
            Err(std::fs::TryLockError::Error(std::io::Error::from(
                std::io::ErrorKind::Unsupported,
            )))
        };
        let own = own_dir_locking(&home, unsupported).unwrap();
        assert!(own.is_dir());
        assert!(gone.exists() && root.join("gone.lock").exists());
        // Its folder has no lock file, so no other process sweeps it.
        assert!(!own.with_extension("lock").exists());
        // Asked again, it answers with the same folder.
        assert_eq!(own_dir_locking(&home, unsupported).unwrap(), own);
    }

    #[cfg(unix)]
    #[test]
    fn what_a_session_holds_goes_once_its_process_has_ended() {
        let home = Scratch::new("api-held");
        let mut files = SessionFiles::default();
        let told = files.write(&home, "md", "text").unwrap();
        let recorder = Arc::new(Recorder::default());
        let mut command = portable_pty::CommandBuilder::new("/bin/sh");
        command.args(["-c", "sleep 0.3"]);
        pty::spawn(
            recorder.clone(),
            Arc::new(Sessions::default()),
            command,
            size(80, 24),
            |_| Box::new(|_: &[u8]| true),
            files,
        )
        .unwrap();
        // There while the process runs, gone once it has ended.
        assert!(told.exists());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while recorder.events.lock().unwrap().is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(
            !recorder.events.lock().unwrap().is_empty(),
            "the session ended"
        );
        assert!(!told.exists());
    }

    // A session started on a worktree runs with the hooks its project
    // has, and the worktree's clean-up takes them away again.
    #[test]
    fn a_worktree_made_for_a_session_has_the_project_s_hooks_until_it_goes() {
        let base = Scratch::new("api-worktree-hooks");
        let (home, project) = (base.join("home"), base.join("project"));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        let git = |args: &[&str]| {
            let done = std::process::Command::new("git")
                .args(args)
                .current_dir(&project)
                .output()
                .expect("git should be installed");
            assert!(done.status.success(), "git {args:?}: {done:?}");
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(project.join("a.txt"), "one\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "first"]);
        let daemon = hook::daemon_path(&home);
        std::fs::create_dir_all(daemon.parent().unwrap()).unwrap();
        std::fs::write(&daemon, "").unwrap();

        let core = Core::at_home(Arc::new(Recorder::default()), Some(home.clone()));
        let hooked = |folder: &Path| hook::status(&home, folder, &[]).installed;

        // Hooks off: the worktree gets none.
        let bare = PathBuf::from(core.worktree_add(&project, "bare", &[]).unwrap());
        assert!(!hooked(&bare));
        assert!(!bare.join(".claude").join("settings.local.json").exists());
        core.worktree_remove(&project, "bare", &[]).unwrap();

        // Hooks on: the worktree has them before anything runs in it, and
        // its checkout shows nothing new.
        core.hook_install(&project, &[]).unwrap();
        let tree = PathBuf::from(core.worktree_add(&project, "fix", &[]).unwrap());
        assert!(hooked(&tree));
        let status = std::process::Command::new("git")
            .args(["status", "--porcelain", "--untracked-files=all"])
            .current_dir(&tree)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&status.stdout), "");

        core.worktree_remove(&project, "fix", &[]).unwrap();
        assert!(!tree.exists());
        let state = std::fs::read_to_string(account::claude_json(&home, None)).unwrap();
        let state: serde_json::Value = serde_json::from_str(&state).unwrap();
        let key = tree.to_string_lossy().to_string();
        assert!(state["projects"][&key]["mcpServers"]
            .get("agent-workbench")
            .is_none());
        assert!(hooked(&project), "the project keeps its own");
    }

    /// A repository with one commit, and a home with the daemon in place,
    /// both under a scratch folder that lives as long as the first value.
    fn hooked_repository(name: &str, files: &[(&str, &str)]) -> (Scratch, PathBuf, PathBuf) {
        let base = Scratch::new(&format!("api-{name}"));
        let (home, project) = (base.join("home"), base.join("project"));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        let git = |args: &[&str]| {
            let done = std::process::Command::new("git")
                .args(args)
                .current_dir(&project)
                .output()
                .expect("git should be installed");
            assert!(done.status.success(), "git {args:?}: {done:?}");
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(project.join("a.txt"), "one\n").unwrap();
        for (file, text) in files {
            std::fs::write(project.join(file), text).unwrap();
        }
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "first"]);
        let daemon = hook::daemon_path(&home);
        std::fs::create_dir_all(daemon.parent().unwrap()).unwrap();
        std::fs::write(&daemon, "").unwrap();
        (base, home, project)
    }

    // The session works without the hooks, read off its output, so their
    // failing is no reason to refuse it a worktree that was made.
    #[test]
    fn a_worktree_is_made_when_its_hooks_cannot_be_written() {
        // A file where Codex keeps its folder: the tree cannot have one.
        let (_base, home, project) = hooked_repository("worktree-hooks-fail", &[(".codex", "x\n")]);
        let core = Core::at_home(Arc::new(Recorder::default()), Some(home.clone()));
        // The project's hooks are Claude Code's file, as a project without
        // that file of Codex's would have them.
        let donor = home.join("donor");
        std::fs::create_dir_all(&donor).unwrap();
        hook::install(&home, &donor, &[]).unwrap();
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        std::fs::copy(
            donor.join(".claude").join("settings.local.json"),
            project.join(".claude").join("settings.local.json"),
        )
        .unwrap();

        let tree = core.worktree_add(&project, "fix", &[]).unwrap();
        assert!(Path::new(&tree).join(".git").exists());
    }

    // A worktree made before its project had the hooks gets them when a
    // session starts or resumes in it.
    #[test]
    fn a_session_in_a_worktree_without_the_hooks_brings_them() {
        let (_base, home, project) = hooked_repository("worktree-hooks-later", &[]);
        let core = Core::at_home(Arc::new(Recorder::default()), Some(home.clone()));
        core.hook_install(&project, &[]).unwrap();
        // A tree made without them, as one from before they were shared.
        let tree = PathBuf::from(git::worktree_add(&project, "old").unwrap());
        let hooked = |folder: &Path| hook::status(&home, folder, &[]).installed;
        assert!(!hooked(&tree));

        core.hooks_for("claude-code", &project, Some(&tree), None);
        assert!(hooked(&tree));

        // A folder that is not one of the project's worktrees is left alone.
        let other = home.join("other");
        std::fs::create_dir_all(&other).unwrap();
        core.hooks_for("claude-code", &project, Some(&other), None);
        assert!(!other.join(".claude").exists());
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
        let dir = Scratch::absent("api-dirs");
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
        // The shell reads its own startup files before it reads the line, so
        // the end comes when it comes; the bound is only for a shell that
        // never ends.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        while recorder.events.lock().unwrap().is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let events = recorder.events.lock().unwrap();
        let (name, payload) = events.first().expect("the end was announced");
        assert_eq!(name, pty::SESSION_ENDED);
        assert_eq!(payload["id"], id);
        assert_eq!(payload["code"], 3);
        assert_eq!(payload["clean"], false);
    }
}
