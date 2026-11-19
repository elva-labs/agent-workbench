//! The core as one object: what a window or a daemon calls.
//!
//! Every method is synchronous and may take a while: a `git status` on a
//! large tree, a slow `.zshrc`. The caller decides which thread that costs.
//! The desktop app runs them on its blocking pool so the window keeps
//! painting; the daemon gives each request a thread of its own.

use std::collections::HashMap;
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

/// What a terminal session is started with, before its process is: the
/// agent's command, the files of the session's own it is given, and its id
/// when the workbench knows it.
struct Prepared {
    command: portable_pty::CommandBuilder,
    files: SessionFiles,
    session_id: Option<String>,
}

pub const SESSION_IDENTIFIED: &str = "session_identified";

/// What a terminal resume of a conversation held at the point it went back
/// to fails with, before the reason: the window asks the user, and on a yes
/// starts it again saying the user agreed.
pub const HELD: &str = "held";

/// Why a terminal resume of a held conversation is refused.
const TERMINAL_HELD: &str = "This conversation went back to an earlier message, and a terminal would bring back what that left out. Send it a message in the workbench first, or agree to bring that back.";

/// Why a message cannot be gone back to: it is not in the conversation.
const UNSAID: &str = "That message is not in the conversation as the agent keeps it.";

/// Why no message of a Claude Code conversation can be gone back to.
const UNFOLLOWED: &str = "Claude Code's record of this conversation could not be followed.";

/// Why a Claude Code conversation cannot go back to before a message.
const COMPACTED: &str =
    "The conversation was compacted after this message, so it cannot go back to before it.";

/// Why a Codex conversation cannot go back to before a message alone.
const TAKEN_INTO: &str = "Codex took this message into a turn that was running, which goes back with the message that began it.";

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
    /// The prompt calls the window has yet to answer, each with the time
    /// its hook stops waiting.
    deadlines: Arc<crate::show::Deadlines>,
    /// The usage limits of each account on the machine.
    limits: Arc<crate::limits::Limits>,
    /// How each integrated session running was started, by its id, so it
    /// can be started again the same way.
    runs: Arc<std::sync::Mutex<HashMap<String, Run>>>,
    /// The points conversations went back to, held until their transcripts
    /// hold the cut themselves.
    held: Arc<crate::rewind::Held>,
}

/// How an integrated session was started: what [`Core::integrated_start`]
/// was given, its conversation's id where the workbench knows it, and what
/// undoing the going back that started it goes back to.
#[derive(Debug, Clone)]
struct Run {
    agent: String,
    project: PathBuf,
    cwd: Option<PathBuf>,
    session: Option<String>,
    token: Option<String>,
    model: Option<String>,
    mode: Option<String>,
    effort: Option<String>,
    config_dir: Option<String>,
    instructions: Option<String>,
    start_only: bool,
    afresh: bool,
    undo: Option<Undo>,
}

/// The conversation as it was before going back: its id, and the entry it
/// was held at then, where it was.
#[derive(Debug, Clone)]
struct Undo {
    session: String,
    at: Option<String>,
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
            plugins,
            settings,
            deadlines: Arc::default(),
            limits: Arc::new(crate::limits::Limits::new(home.as_deref())),
            runs: Arc::default(),
            held: Arc::new(crate::rewind::Held::new(home.as_deref())),
            home,
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

    /// The machine's settings, and whether a file held them yet. A list of
    /// workflows written before one shipped is offered it first, once.
    pub fn settings_get(&self) -> Result<crate::settings::Stored, String> {
        let store = self.settings()?;
        store.offer_shipped();
        Ok(store.load())
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
                let deadlines = Arc::clone(&self.deadlines);
                crate::show::watch(
                    Arc::clone(&self.sink),
                    crate::show::requests_path(home),
                    move |request| {
                        if let Some(plugins) = &plugins {
                            plugins.call(request);
                        }
                    },
                    move |request| {
                        deadlines.note(&request);
                        events::emit(&sink, crate::show::CONDUCT_REQUEST, &request)
                    },
                    move |request| {
                        events::emit(&browser_sink, crate::show::BROWSER_REQUEST, &request)
                    },
                )?;
                // A prompt hook asks the window only while this core says it
                // is here.
                let beating = home.clone();
                std::thread::spawn(move || loop {
                    let _ = crate::show::beat(&beating);
                    std::thread::sleep(crate::show::HEARTBEAT_EVERY);
                });
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
    /// given. `token` is what the window knows the session by, which the
    /// agent's tools are given so that every call they make names it.
    /// `mode` is the mode the conversation last ran in where the window
    /// knows it, by the name its integrated sessions offer it under.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        agent: &str,
        project: &Path,
        cwd: Option<&Path>,
        session: Option<String>,
        token: Option<&str>,
        prompt: Option<&str>,
        model: Option<&str>,
        mode: Option<&str>,
        config_dir: Option<&str>,
        instructions: Option<&str>,
        start_only: bool,
        afresh: bool,
        bring_back: bool,
        cols: u16,
        rows: u16,
        output: impl FnOnce(&str) -> Output,
    ) -> Result<Spawned, String> {
        let Prepared {
            command,
            files,
            session_id,
        } = self.prepare(
            agent,
            project,
            cwd,
            session,
            token,
            prompt,
            model,
            mode,
            config_dir,
            instructions,
            start_only,
            afresh,
            bring_back,
            &env::environment().vars,
        )?;
        // The project a session belongs to is the one that is open, which
        // is what the plugins know it by, and not the worktree under it
        // the agent may run in.
        let opened = project.to_string_lossy().to_string();
        let token = token.filter(|token| !token.trim().is_empty());
        let config_dir = config_dir.filter(|dir| !dir.trim().is_empty());
        let project = cwd.unwrap_or(project);

        let codex_activity = (agent == "codex")
            .then(|| {
                self.home.as_ref().map(|home| {
                    let home = account::codex_home(home, config_dir, &env::environment().vars);
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
            plugins.session_started(&pty_id, session_id.as_deref(), token, &opened);
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

    /// The command a terminal session is started with, the files of its
    /// own it was given, and its id when the workbench knows it, for
    /// [`Core::spawn`], in the environment `vars`. Whether the session
    /// directs the others is whether it follows a workflow, wherever it
    /// runs.
    #[allow(clippy::too_many_arguments)]
    fn prepare(
        &self,
        agent: &str,
        project: &Path,
        cwd: Option<&Path>,
        session: Option<String>,
        token: Option<&str>,
        prompt: Option<&str>,
        model: Option<&str>,
        mode: Option<&str>,
        config_dir: Option<&str>,
        instructions: Option<&str>,
        start_only: bool,
        afresh: bool,
        bring_back: bool,
        vars: &HashMap<String, String>,
    ) -> Result<Prepared, String> {
        let adapter = adapter_for(agent).ok_or_else(|| format!("no adapter for {agent}"))?;
        // A Claude Code conversation held at the point it went back to would
        // go on in its terminal with what that left out, since the terminal
        // does not take the point: only where the user agreed, which lets
        // the point go. Refused before anything is made.
        if let Some(session) = session.as_deref() {
            if self.held_in(agent, project, cwd, session, config_dir, vars) {
                if !bring_back {
                    return Err(format!("{HELD}: {TERMINAL_HELD}"));
                }
                self.held.release(session);
            }
        }
        let instructions = instructions.filter(|text| !text.trim().is_empty());
        let token = token.filter(|token| !token.trim().is_empty());
        let orchestrator = instructions.is_some();
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
        // Where the agent's own configuration already points at the server,
        // an agent that passes its servers only the variables it is told to
        // is told the server again, with the session's token to pass on.
        // Nothing else needs to know where the server is.
        let found = match self.home.as_deref() {
            Some(home) if instructions.is_some() || adapter.names_server_vars() => {
                Some(hook::tool_server(home, project, agent, config_dir, vars))
            }
            _ => None,
        };
        let server = match (instructions, &found) {
            (None, _) => None,
            (Some(_), Some(hook::ToolServer::Configured)) => None,
            (Some(_), Some(hook::ToolServer::Named(daemon))) => Some(daemon.clone()),
            (Some(_), Some(hook::ToolServer::Missing) | None) => return Err(NO_TOOLS.into()),
        };
        let configured = match (&found, self.home.as_deref()) {
            (Some(hook::ToolServer::Configured), Some(home)) => Some(hook::daemon_path(home)),
            _ => None,
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
        let through_cmd = cfg!(windows)
            && adapter
                .detect(vars)
                .is_some_and(|binary| env::is_shell_script(&binary));
        let prompt = prompt.filter(|prompt| !prompt.trim().is_empty());
        let prompt = first_prompt(prompt, through_cmd, &mut files, self.home.as_deref())?;
        let ctx = LaunchCtx {
            project,
            env: vars,
            session: session_id.as_deref(),
            token,
            prompt: prompt.as_deref(),
            model: model.filter(|model| !model.trim().is_empty()),
            mode: mode.filter(|mode| !mode.trim().is_empty()),
            config_dir: expanded.as_deref(),
            orchestrator,
            instructions,
            instructions_file: instructions_file.as_deref(),
            start_only: instructions.is_some() && start_only,
            server: server.as_deref(),
            server_file: server_file.as_deref(),
            configured: configured.as_deref(),
            afresh: resumed && afresh,
        };
        let surface = match &session_id {
            Some(id) if resumed => adapter.resume(&ctx, id)?,
            Some(id) => adapter.launch(&ctx, id)?,
            None => adapter.launch(&ctx, "")?,
        };
        let Surface::Pty(command) = surface;
        Ok(Prepared {
            command,
            files,
            session_id,
        })
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
    ///
    /// `instructions`, `start_only` and `afresh` are a workflow's, as for
    /// [`Core::spawn`]: a session that follows one directs the others, is
    /// not started where no tool server can reach it, and is given the
    /// instructions, and with `start_only` loses its agent's own subagent
    /// tools, the same way a terminal session is.
    #[allow(clippy::too_many_arguments)]
    pub fn integrated_start(
        &self,
        agent: &str,
        project: &Path,
        cwd: Option<&Path>,
        session: Option<String>,
        token: Option<&str>,
        model: Option<&str>,
        mode: Option<&str>,
        effort: Option<&str>,
        config_dir: Option<&str>,
        instructions: Option<&str>,
        start_only: bool,
        afresh: bool,
    ) -> Result<crate::integrated::Started, String> {
        let run = Run {
            agent: agent.to_string(),
            project: project.to_path_buf(),
            cwd: cwd.map(Path::to_path_buf),
            session,
            token: token.map(str::to_string),
            model: model.map(str::to_string),
            mode: mode.map(str::to_string),
            effort: effort.map(str::to_string),
            config_dir: config_dir.map(str::to_string),
            instructions: instructions.map(str::to_string),
            start_only,
            afresh,
            undo: None,
        };
        // A conversation held at the point it went back to goes on from
        // there.
        let at = match &run.session {
            Some(session) if agent == crate::claude_stream::AGENT => self.held_at(&run, session),
            _ => None,
        };
        self.start_run(run, at)
    }

    /// Starts an integrated session as `run` says, from the entry `at` of a
    /// conversation it resumes where one is given, and keeps how it was
    /// started for as long as it runs.
    fn start_run(
        &self,
        run: Run,
        at: Option<String>,
    ) -> Result<crate::integrated::Started, String> {
        let agent = run.agent.as_str();
        let project = run.project.as_path();
        let cwd = run.cwd.as_deref();
        let token = run.token.as_deref();
        let model = run.model.as_deref();
        let mode = run.mode.as_deref();
        let effort = run.effort.as_deref();
        let config_dir = run.config_dir.as_deref();
        let instructions = run.instructions.as_deref();
        let (start_only, afresh) = (run.start_only, run.afresh);
        let adapter = adapter_for(agent).ok_or_else(|| format!("no adapter for {agent}"))?;
        let protocol = adapter
            .integrated()
            .ok_or_else(|| format!("{agent} cannot run as an integrated session"))?;
        let environment = env::environment();
        let opened = project.to_string_lossy().to_string();
        let instructions = instructions.filter(|text| !text.trim().is_empty());
        let orchestrator = instructions.is_some();
        self.hooks_for(agent, project, cwd, config_dir);
        let project = cwd.unwrap_or(project);
        let resume = run.session.is_some();
        // The workbench chooses a fresh session's id for an agent that takes
        // one; one that makes its own says it in `ready`.
        let session = run
            .session
            .clone()
            .or_else(|| adapter.takes_id().then(new_session_id));
        let config_dir = config_dir.filter(|dir| !dir.trim().is_empty());
        let expanded =
            config_dir.and_then(|dir| self.home.as_deref().map(|home| account::expand(home, dir)));
        let tool_server = self
            .home
            .as_deref()
            .map(hook::daemon_path)
            .filter(|path| path.is_file());
        // A session that follows a workflow hands its work out with the
        // workbench's start tool, which only the tool server gives it,
        // so it is not started, nor its folder asked about, without one.
        if instructions.is_some() && tool_server.is_none() {
            return Err(NO_TOOLS.into());
        }
        let trusted = self.home.as_deref().is_some_and(|home| {
            protocol.trusted(home, expanded.as_deref(), &environment.vars, project)
        });
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
        let mode = start_mode(
            protocol,
            mode,
            resume.then_some(session.as_deref()).flatten(),
            self.home.as_deref(),
            expanded.as_deref(),
            &environment.vars,
            project,
        );
        let launch = crate::integrated::Launch {
            project,
            env: &environment.vars,
            session: session.as_deref(),
            token: token.filter(|token| !token.trim().is_empty()),
            resume,
            model: model.filter(|model| !model.trim().is_empty()),
            mode: mode.as_deref(),
            effort: effort.filter(|effort| !effort.trim().is_empty()),
            config_dir: expanded.as_deref(),
            tool_server: tool_server.as_deref(),
            orchestrator,
            instructions,
            start_only: instructions.is_some() && start_only,
            afresh: resume && afresh,
            resume_at: at.as_deref().filter(|_| resume),
        };
        let (starting, ending) = (self.plugins.clone(), self.plugins.clone());
        let named = token
            .filter(|token| !token.trim().is_empty())
            .map(str::to_string);
        // What the session's agent reports of the account's limits counts
        // for the account, as a read of them here would.
        let sink = match self.limits_dir(agent, config_dir, &environment.vars) {
            Some(dir) => self.limits.tap(Arc::clone(&self.sink), agent, dir),
            None => Arc::clone(&self.sink),
        };
        let kept = Run {
            session: session.clone(),
            ..run.clone()
        };
        let (runs, gone) = (Arc::clone(&self.runs), Arc::clone(&self.runs));
        crate::integrated::start(
            sink,
            Arc::clone(&self.integrated),
            protocol,
            &launch,
            Box::new(move |started| {
                runs.lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(started.id.clone(), kept);
                if let Some(plugins) = starting {
                    plugins.session_started(
                        &started.id,
                        started.session_id.as_deref(),
                        named.as_deref(),
                        &opened,
                    );
                }
            }),
            Box::new(move |id| {
                gone.lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(id);
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
        protocol.trust(
            home,
            expanded.as_deref(),
            &env::environment().vars,
            cwd.unwrap_or(project),
        )
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

    /// Sends the messages that wait for a turn now, in the order sent, or
    /// fails saying why they cannot go now.
    pub fn integrated_send_now(&self, id: &str) -> Result<(), String> {
        crate::integrated::control(&self.integrated, id, &crate::integrated::Control::SendNow)
            .map(|_| ())
    }

    /// Takes back a message the agent has not taken yet.
    pub fn integrated_withdraw(&self, id: &str, message: &str) -> Result<(), String> {
        crate::integrated::control(
            &self.integrated,
            id,
            &crate::integrated::Control::Withdraw(message.to_string()),
        )
        .map(|_| ())
    }

    /// Compacts the conversation, in the agent's own way, with what the
    /// summary should keep where the agent takes that. Comes back once
    /// asked; the compaction's events follow.
    pub fn integrated_compact(&self, id: &str, instructions: Option<&str>) -> Result<(), String> {
        let instructions = instructions
            .map(str::trim)
            .filter(|words| !words.is_empty())
            .map(str::to_string);
        crate::integrated::control(
            &self.integrated,
            id,
            &crate::integrated::Control::Compact { instructions },
        )
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

    /// What a conversation said and did before, read from where its agent
    /// keeps it under the account whose configuration directory is given,
    /// or the agent's own: Claude Code's transcript of the session in the
    /// project, or in the folder under it the session ran in, and Codex's
    /// thread, through Codex itself. None for an agent whose history is not
    /// read here; an error where the agent could not read it, or where
    /// Claude Code has no transcript of the session under the directory.
    pub fn integrated_history(
        &self,
        agent: &str,
        project: &Path,
        cwd: Option<&Path>,
        session: &str,
        config_dir: Option<&str>,
    ) -> Result<Option<crate::integrated::History>, String> {
        let Some(home) = self.home.as_ref() else {
            return Ok(None);
        };
        let environment = env::environment();
        match agent {
            "claude-code" => {
                let dir = account::claude_dir(home, config_dir, &environment.vars);
                let Some(path) = crate::claude_history::find(&dir, project, cwd, session) else {
                    return Err(format!(
                        "Claude Code has no transcript of it in {}",
                        account::shown(home, &dir)
                    ));
                };
                // A conversation held at the point it went back to reads as
                // far as that point.
                let leaf = crate::claude_history::leaf(&path);
                let at = self.held.at(session, leaf.as_deref());
                Ok(Some(crate::claude_history::read_until(
                    &path,
                    at.as_deref(),
                )))
            }
            "codex" => {
                let config_dir = config_dir
                    .filter(|dir| !dir.trim().is_empty())
                    .map(|dir| account::expand(home, dir));
                crate::codex_history::read_thread(
                    &environment.vars,
                    config_dir.as_deref(),
                    project,
                    cwd,
                    session,
                )
                .map(Some)
            }
            _ => Ok(None),
        }
    }

    /// How a session's conversation is taken up again: whole, or for a
    /// Claude Code conversation that is cold and large, as a fresh one
    /// from the briefing this answers with. Whole for any other agent, and
    /// where no transcript of it is found.
    pub fn taken_up(
        &self,
        agent: &str,
        project: &Path,
        cwd: Option<&Path>,
        session: &str,
        config_dir: Option<&str>,
        token: &str,
    ) -> Result<crate::going_on::GoingOn, String> {
        let whole = crate::going_on::GoingOn {
            context: None,
            idle: None,
            goes_on: false,
            briefing: None,
        };
        let Some(home) = self.home.as_ref() else {
            return Ok(whole);
        };
        if agent != "claude-code" {
            return Ok(whole);
        }
        let environment = env::environment();
        let dir = account::claude_dir(home, config_dir, &environment.vars);
        let Some(path) = crate::claude_history::find(&dir, project, cwd, session) else {
            return Ok(whole);
        };
        // A conversation held at a point it went back to is judged and
        // briefed as it stands there.
        let leaf = crate::claude_history::leaf(&path);
        let held = self.held.at(session, leaf.as_deref());
        Ok(crate::going_on::judge(
            &path,
            |since| crate::notes::briefing_since(home, token, since),
            crate::notes::now() as u64 * 1000,
            held.as_deref(),
        ))
    }

    /// How an integrated session that runs was started.
    fn run(&self, id: &str) -> Result<Run, String> {
        self.runs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| "no such session".to_string())
    }

    /// The transcript of a Claude Code conversation a run is on.
    fn transcript(&self, run: &Run, session: &str) -> Option<PathBuf> {
        let home = self.home.as_deref()?;
        let dir = account::claude_dir(home, run.config_dir.as_deref(), &env::environment().vars);
        crate::claude_history::find(&dir, &run.project, run.cwd.as_deref(), session)
    }

    /// The entry a Claude Code conversation is held at, where it went back
    /// and has not gone on since.
    fn held_at(&self, run: &Run, session: &str) -> Option<String> {
        let path = self.transcript(run, session)?;
        let leaf = crate::claude_history::leaf(&path);
        self.held.at(session, leaf.as_deref())
    }

    /// The messages of a Codex thread, read by a Codex of its own.
    fn codex_marks(
        &self,
        run: &Run,
        thread: &str,
    ) -> Result<(Vec<crate::codex_history::Mark>, Option<&'static str>), String> {
        let environment = env::environment();
        let config_dir = run
            .config_dir
            .as_deref()
            .filter(|dir| !dir.trim().is_empty())
            .zip(self.home.as_deref())
            .map(|(dir, home)| account::expand(home, dir));
        crate::codex_history::marks(
            &environment.vars,
            config_dir.as_deref(),
            &run.project,
            run.cwd.as_deref(),
            thread,
        )
    }

    /// Where an integrated session's conversation can go back to: each
    /// message of the user's in it as its agent keeps it now, oldest first,
    /// and whether the conversation and the files can each go back to
    /// before it. Claude Code's are read from its transcript, as far as the
    /// point the conversation is held at; Codex's through a Codex of its
    /// own, which takes a second or two.
    pub fn integrated_rewind_points(&self, id: &str) -> Result<crate::integrated::Points, String> {
        use crate::integrated::{Point, Points};
        let run = self.run(id)?;
        let session = crate::integrated::conversation(&self.integrated, id)?;
        match run.agent.as_str() {
            crate::claude_stream::AGENT => {
                let Some(path) = self.transcript(&run, &session) else {
                    return Ok(Points::default());
                };
                let leaf = crate::claude_history::leaf(&path);
                let at = self.held.at(&session, leaf.as_deref());
                let Some(marks) = crate::claude_history::marks(&path, at.as_deref()) else {
                    return Ok(Points {
                        points: Vec::new(),
                        why: Some(UNFOLLOWED.into()),
                    });
                };
                Ok(Points {
                    points: marks
                        .into_iter()
                        .map(|mark| Point {
                            message: mark.message,
                            conversation: mark.resumable,
                            files: mark.files,
                            why: (!mark.resumable).then(|| COMPACTED.to_string()),
                        })
                        .collect(),
                    why: None,
                })
            }
            crate::codex_app_server::AGENT => {
                let (marks, why) = self.codex_marks(&run, &session)?;
                Ok(Points {
                    points: marks
                        .into_iter()
                        .map(|mark| Point {
                            message: mark.message,
                            conversation: mark.first,
                            files: false,
                            why: (!mark.first).then(|| TAKEN_INTO.to_string()),
                        })
                        .collect(),
                    why: why.map(str::to_string),
                })
            }
            _ => Ok(Points::default()),
        }
    }

    /// What putting the files back as they were before a message would
    /// change, as the agent's own dry run says, with nothing changed. Fails
    /// in the agent's words where it cannot put them back to there, and for
    /// an agent that puts no files back.
    pub fn integrated_rewind_preview(
        &self,
        id: &str,
        message: &str,
    ) -> Result<crate::integrated::Preview, String> {
        crate::integrated::preview(&self.integrated, id, message)
    }

    /// Takes an integrated session at rest back to before a message of the
    /// user's: with `conversation`, the message and everything after it
    /// leave the conversation; with `files`, those the user was shown, the
    /// files go back as they were before it, first, unless the agent would
    /// now change one not among them. Claude Code is started again from the entry before
    /// the message, on the same row's token and the settings it runs on
    /// now, and the conversation is held at that entry until its transcript
    /// holds the cut; before its first message, it starts a new
    /// conversation. Codex goes back in the running process. Fails, with
    /// nothing changed, where it cannot go back there.
    pub fn integrated_rewind(
        &self,
        id: &str,
        message: &str,
        conversation: bool,
        files: Option<&[String]>,
    ) -> Result<crate::integrated::WentBack, String> {
        use crate::integrated::Back;
        crate::integrated::rest(&self.integrated, id)?;
        if !conversation && files.is_none() {
            return Err("neither the conversation nor the files were asked to go back".into());
        }
        let run = self.run(id)?;
        let session = crate::integrated::conversation(&self.integrated, id)?;
        // The entry the conversation is held at already, from going back
        // before, which it goes on from where it does not go back now.
        let mut held = None;
        let back = match run.agent.as_str() {
            crate::claude_stream::AGENT => {
                let path = self.transcript(&run, &session).ok_or(UNSAID)?;
                let leaf = crate::claude_history::leaf(&path);
                held = self.held.at(&session, leaf.as_deref());
                let mark = crate::claude_history::marks(&path, held.as_deref())
                    .ok_or(UNFOLLOWED)?
                    .into_iter()
                    .find(|mark| mark.message == message)
                    .ok_or(UNSAID)?;
                if files.is_some() && !mark.files {
                    return Err("Claude Code kept no files from before this message.".into());
                }
                if !conversation {
                    Back::Files
                } else if !mark.resumable {
                    return Err(COMPACTED.into());
                } else {
                    Back::Entry(mark.at)
                }
            }
            crate::codex_app_server::AGENT => {
                if files.is_some() {
                    return Err(crate::codex_app_server::NO_FILES.into());
                }
                let (marks, why) = self.codex_marks(&run, &session)?;
                if let Some(why) = why {
                    return Err(why.into());
                }
                let mark = marks
                    .into_iter()
                    .find(|mark| mark.message == message)
                    .ok_or(UNSAID)?;
                if !mark.first {
                    return Err(TAKEN_INTO.into());
                }
                Back::Turn(mark.turn)
            }
            agent => return Err(format!("{agent} cannot go back")),
        };
        let restart = |again: &crate::integrated::Again| self.again(&run, again, held.as_deref());
        let went = crate::integrated::rewind(
            &self.integrated,
            id,
            message,
            back.clone(),
            files,
            &restart,
        )?;
        // Going back by starting again can be undone, until the
        // conversation goes on, where it put no files back.
        if let (Back::Entry(_), Some(started), None, true) =
            (&back, &went.id, &went.fallback, went.files.is_empty())
        {
            if let Some(started) = self
                .runs
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get_mut(started)
            {
                started.undo = Some(Undo { session, at: held });
            }
        }
        Ok(went)
    }

    /// Undoes the going back that started an integrated session: it is
    /// started again on the conversation as it was, from its newest entry or
    /// the one it was held at before. Only while the session is at rest and
    /// nothing has gone on in it since. Fails, with nothing changed, where
    /// it cannot.
    pub fn integrated_rewind_undo(&self, id: &str) -> Result<crate::integrated::WentBack, String> {
        let run = self.run(id)?;
        let undo = run
            .undo
            .clone()
            .ok_or("there is no going back to undo in this session")?;
        let restart =
            |again: &crate::integrated::Again| self.again(&run, again, undo.at.as_deref());
        crate::integrated::undo(&self.integrated, id, &undo.session, &restart)
    }

    /// Starts a run again as `again` says, on the run's own launch
    /// otherwise, from the entry [`Core::going_on`] says.
    fn again(
        &self,
        run: &Run,
        again: &crate::integrated::Again,
        held: Option<&str>,
    ) -> Result<crate::integrated::Started, String> {
        let at = self.going_on(run, again, held)?;
        let settings = &again.settings;
        let next = Run {
            session: again.session.clone(),
            model: settings.model.clone().or_else(|| run.model.clone()),
            mode: settings.mode.clone(),
            effort: settings.effort.clone().or_else(|| run.effort.clone()),
            undo: None,
            ..run.clone()
        };
        self.start_run(next, at)
    }

    /// The entry a run started again goes on from: the one `again` names,
    /// or for a conversation resumed from no entry in particular `held`,
    /// the one it was held at before, where there was one. The conversation
    /// is held at that entry, or let go where it goes on from its newest.
    fn going_on(
        &self,
        run: &Run,
        again: &crate::integrated::Again,
        held: Option<&str>,
    ) -> Result<Option<String>, String> {
        let Some(session) = &again.session else {
            return Ok(None);
        };
        let Some(at) = again.at.as_deref().or(held) else {
            self.held.release(session);
            return Ok(None);
        };
        let leaf = self
            .transcript(run, session)
            .and_then(|path| crate::claude_history::leaf(&path))
            .ok_or(UNSAID)?;
        self.held.hold(session, at, &leaf);
        Ok(Some(at.to_string()))
    }

    /// Whether a conversation is held at the point it went back to: its
    /// agent has not written the cut yet, which it does with the next
    /// message sent from there. Until then a terminal that resumes the
    /// conversation goes on with what was gone back on, since Claude Code's
    /// terminal does not take the point a stream session is started from,
    /// and a line typed there makes that the conversation for good. False
    /// for an agent whose conversations go back as they are kept.
    pub fn integrated_held(
        &self,
        agent: &str,
        project: &Path,
        cwd: Option<&Path>,
        session: &str,
        config_dir: Option<&str>,
    ) -> bool {
        self.held_in(
            agent,
            project,
            cwd,
            session,
            config_dir,
            &env::environment().vars,
        )
    }

    /// Whether a conversation is held, its account's directory found in
    /// `vars` where none is named.
    fn held_in(
        &self,
        agent: &str,
        project: &Path,
        cwd: Option<&Path>,
        session: &str,
        config_dir: Option<&str>,
        vars: &HashMap<String, String>,
    ) -> bool {
        if agent != crate::claude_stream::AGENT {
            return false;
        }
        let Some(home) = self.home.as_deref() else {
            return false;
        };
        let dir = account::claude_dir(home, config_dir, vars);
        let Some(path) = crate::claude_history::find(&dir, project, cwd, session) else {
            return false;
        };
        let leaf = crate::claude_history::leaf(&path);
        self.held.at(session, leaf.as_deref()).is_some()
    }

    /// The usage limits of an agent's account on this machine, under the
    /// account whose configuration directory is given, or the agent's own.
    /// With `read`, they are read first where a read is due, as the limits
    /// module says, which takes a second or two of the agent's own process;
    /// without, the figures held are the answer at once. `worked` says a
    /// session of the account worked since its figures were read, which
    /// makes a read due sooner. None where there are no figures, a read
    /// failed and none came before it, or the agent has no limits read here.
    pub fn account_limits(
        &self,
        agent: &str,
        config_dir: Option<&str>,
        read: bool,
        worked: bool,
    ) -> Option<crate::integrated::Event> {
        let environment = env::environment();
        let dir = self.limits_dir(agent, config_dir, &environment.vars)?;
        if !read {
            return self.limits.held(agent, &dir);
        }
        // The agent's own directory is left to the agent to find, as a
        // session started under it does.
        let config_dir = config_dir
            .filter(|named| !named.trim().is_empty())
            .map(|_| dir.clone());
        self.limits.poll(agent, &dir, worked, || {
            // An account whose directory is not there has never been signed
            // in to, and the agent would make the directory to say so.
            if !dir.is_dir() {
                return Err(format!("{} is not there", dir.display()));
            }
            crate::limits::read(
                agent,
                &environment.vars,
                config_dir.as_deref(),
                &self.limits.folder()?,
                crate::limits::READ_WAIT,
            )
        })
    }

    /// The directory an agent keeps the account in whose configuration
    /// directory is given, or its own, which its limits are held under.
    /// None for an agent with no limits read here.
    fn limits_dir(
        &self,
        agent: &str,
        config_dir: Option<&str>,
        vars: &HashMap<String, String>,
    ) -> Option<PathBuf> {
        let home = self.home.as_deref()?;
        match agent {
            "claude-code" => Some(account::claude_dir(home, config_dir, vars)),
            "codex" => Some(account::codex_home(home, config_dir, vars)),
            _ => None,
        }
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
        Ok(hook::status(
            home,
            project,
            accounts,
            &env::environment().vars,
        ))
    }

    /// The status of each project, in the order given, from one read of
    /// every account's state.
    pub fn hook_status_many(
        &self,
        projects: &[PathBuf],
        accounts: &[account::Dirs],
    ) -> Result<Vec<hook::HookStatus>, String> {
        let home = self.home.as_ref().ok_or("no home directory")?;
        Ok(hook::status_many(
            home,
            projects,
            accounts,
            &env::environment().vars,
        ))
    }

    pub fn hook_install(
        &self,
        project: &Path,
        accounts: &[account::Dirs],
    ) -> Result<hook::HookStatus, String> {
        let home = self.home.as_ref().ok_or("no home directory")?;
        hook::install(home, project, accounts, &env::environment().vars)
    }

    pub fn hook_uninstall(
        &self,
        project: &Path,
        accounts: &[account::Dirs],
    ) -> Result<hook::HookStatus, String> {
        let home = self.home.as_ref().ok_or("no home directory")?;
        hook::uninstall(home, project, accounts, &env::environment().vars)
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
            "claude-code" => transcripts::list(
                &account::claude_dir(home, config_dir, &env::environment().vars),
                project,
            ),
            "codex" => codex::list(
                &account::codex_home(home, config_dir, &env::environment().vars),
                project,
            ),
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
            "claude-code" => transcripts::list_many(
                &account::claude_dir(home, config_dir, &env::environment().vars),
                projects,
            ),
            "codex" => codex::list_many(
                &account::codex_home(home, config_dir, &env::environment().vars),
                projects,
            ),
            _ => vec![Vec::new(); projects.len()],
        }
    }

    /// What an agent calls a session now, for agents that keep that in an
    /// index of their own rather than in the terminal title.
    pub fn session_title(&self, agent: &str, id: &str, config_dir: Option<&str>) -> Option<String> {
        let home = self.home.as_ref()?;
        match agent {
            "codex" => codex::title_of(
                &account::codex_home(home, config_dir, &env::environment().vars),
                id,
            ),
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

    pub fn file_read(&self, root: &Path, file: &str) -> Result<crate::files::FileText, String> {
        crate::files::read(root, file)
    }

    pub fn file_write(
        &self,
        root: &Path,
        file: &str,
        text: &str,
        stamp: Option<&str>,
        overwrite: bool,
    ) -> Result<crate::files::FileWritten, String> {
        crate::files::write(root, file, text, stamp, overwrite)
    }

    pub fn path_rename(&self, root: &Path, from: &str, to: &str) -> Result<(), String> {
        crate::files::rename(root, from, to)
    }

    pub fn path_delete(&self, root: &Path, path: &str) -> Result<(), String> {
        crate::files::delete(root, path)
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

    /// The core's home, where the notes are kept.
    fn notes_home(&self) -> Result<&Path, String> {
        self.home
            .as_deref()
            .ok_or_else(|| "this core keeps no notes: it has no home".to_string())
    }

    /// How much a session keeps in its notes, and with `page`, where their
    /// readable copy was written for the viewer.
    pub fn notes_kept(&self, token: &str, page: bool) -> Result<crate::notes::Kept, String> {
        crate::notes::kept(self.notes_home()?, token, page)
    }

    /// The brief and the list of notes a fresh start of the session is
    /// given, or none when nothing is kept.
    pub fn notes_briefing(&self, token: &str) -> Result<Option<String>, String> {
        Ok(crate::notes::briefing(self.notes_home()?, token))
    }

    /// Lets go of the notes of these sessions.
    pub fn notes_forget(&self, tokens: &[String]) -> Result<(), String> {
        crate::notes::forget(self.notes_home()?, tokens)
    }

    pub fn read_media(&self, path: &Path) -> Result<crate::show::Media, String> {
        crate::show::read_media(path)
    }

    pub fn file_info(&self, path: &Path) -> Result<crate::show::FileInfo, String> {
        crate::show::file_info(path)
    }

    /// A file an HTML page names beside it, whole or a range of it, when
    /// the page may load it.
    pub fn read_page_file(
        &self,
        page: &Path,
        file: &str,
        range: Option<(u64, Option<u64>)>,
    ) -> Result<crate::page_files::PageFile, String> {
        crate::page_files::read(page, file, home_directory().as_deref(), range)
    }

    /// What a file an HTML page names beside it is, or why the page may
    /// not load it.
    pub fn check_page_file(
        &self,
        page: &Path,
        file: &str,
    ) -> Result<crate::page_files::PageFileInfo, String> {
        crate::page_files::check(page, file, home_directory().as_deref())
    }

    /// The answer to a call on one of the conductor's tools, left where
    /// the tool server that made the call is waiting for it. A prompt call
    /// whose hook has stopped waiting gets none, nor does a wait whose
    /// tool server has, and the window hears so: nothing in it reached the
    /// agent.
    pub fn conduct_answer(
        &self,
        id: &str,
        content: Option<String>,
        error: Option<String>,
    ) -> Result<(), String> {
        let home = self.home.as_deref().ok_or("no home directory")?;
        if !self.deadlines.open(id) {
            return Err("the call stopped waiting for this answer".to_string());
        }
        crate::show::write_answer(home, id, &crate::show::Answer { content, error })
    }

    /// The folder named `orchestrator` under the workbench's home. Nothing
    /// makes it or starts a session in it: the window lists it while it
    /// holds past sessions, and one resumed there is a session like any
    /// other.
    pub fn orchestrator_dir(&self) -> Result<String, String> {
        let dir = self
            .home
            .as_deref()
            .map(orchestrator_path)
            .ok_or("no home directory")?;
        Ok(dir.to_string_lossy().to_string())
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
            hook::trust_like(
                home,
                project,
                Path::new(&path),
                accounts,
                &env::environment().vars,
            )?;
            if let Err(error) = hook::share(
                home,
                project,
                Path::new(&path),
                accounts,
                &env::environment().vars,
            ) {
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
        if let Err(error) = hook::share(home, project, cwd, &accounts, &env::environment().vars) {
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
            let _ = hook::forget(home, &tree, accounts, &env::environment().vars);
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

/// Where the `orchestrator` folder sits under a home directory.
fn orchestrator_path(home: &Path) -> PathBuf {
    home.join(".agent-workbench").join("orchestrator")
}

/// The mode an integrated session is started in: the one the window named,
/// else for a resumed conversation the one its agent's terminal would
/// resume it in, else none, which leaves it to the agent's own settings.
fn start_mode(
    protocol: &dyn crate::integrated::Protocol,
    named: Option<&str>,
    resumed: Option<&str>,
    home: Option<&Path>,
    config_dir: Option<&Path>,
    env: &HashMap<String, String>,
    folder: &Path,
) -> Option<String> {
    if let Some(mode) = named.filter(|mode| !mode.trim().is_empty()) {
        return Some(mode.to_string());
    }
    protocol.resumed_mode(home?, config_dir, env, folder, resumed?)
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

/// The first prompt as it goes on the command line: as given, or, where it
/// goes through the command interpreter and would not arrive as given, a
/// line naming the file of the session's own it is written to.
fn first_prompt(
    prompt: Option<&str>,
    through_cmd: bool,
    files: &mut SessionFiles,
    home: Option<&Path>,
) -> Result<Option<String>, String> {
    match (prompt, home) {
        (Some(text), Some(home)) if through_cmd && !adapter::safe_through_cmd(text) => {
            let path = files.write(home, "md", text)?;
            Ok(Some(adapter::prompt_in_file(&path)))
        }
        _ => Ok(prompt.map(str::to_string)),
    }
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
    use std::collections::HashMap;

    // A prompt hook, and a wait's tool server, stop waiting at the deadline
    // the call carries: an answer past it is not left, and the window hears
    // it was not, so it tells nothing that did not reach the agent.
    #[test]
    fn leaves_no_answer_to_a_call_that_stopped_waiting() {
        let home = Scratch::new("api-prompt-deadline");
        let core = Core::at_home(Arc::new(Recorder::default()), Some(home.to_path_buf()));
        let call = |id: &str, deadline: u64| crate::show::ConductRequest {
            id: id.to_string(),
            tool: crate::show::CONDUCT_PROMPT.to_string(),
            arguments: serde_json::json!({ "deadline": deadline }),
            cwd: "/p".to_string(),
            session: None,
        };
        core.deadlines
            .note(&call("late", crate::show::now_ms() - 1));
        core.deadlines
            .note(&call("in-time", crate::show::now_ms() + 60_000));
        assert!(core
            .conduct_answer("late", Some("note".into()), None)
            .is_err());
        assert!(!crate::show::answer_path(&home, "late").exists());
        core.conduct_answer("in-time", Some("note".into()), None)
            .unwrap();
        assert!(crate::show::answer_path(&home, "in-time").exists());
        // A wait's answer has the deadline the tool server gave it.
        let wait = |id: &str, deadline: u64| crate::show::ConductRequest {
            tool: crate::show::CONDUCT_WAIT.to_string(),
            ..call(id, deadline)
        };
        core.deadlines
            .note(&wait("a-wait-given-up", crate::show::now_ms() - 1));
        core.deadlines
            .note(&wait("a-wait", crate::show::now_ms() + 60_000));
        assert!(core
            .conduct_answer("a-wait-given-up", Some("stopped".into()), None)
            .is_err());
        assert!(!crate::show::answer_path(&home, "a-wait-given-up").exists());
        core.conduct_answer("a-wait", Some("stopped".into()), None)
            .unwrap();
        assert!(crate::show::answer_path(&home, "a-wait").exists());
        // Any other call's answer is always left.
        core.conduct_answer("a-send", Some("sent".into()), None)
            .unwrap();
        assert!(crate::show::answer_path(&home, "a-send").exists());
    }

    /// A core made once the test process's environment is settled, so the
    /// shell it starts is the system's `sh` and reads no startup files.
    fn core_with(sink: Arc<dyn Sink>) -> Core {
        crate::scratch::isolate();
        Core::new(sink)
    }

    fn core() -> Core {
        core_with(Arc::new(Recorder::default()))
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
            deadlines: Arc::default(),
            limits: Arc::new(crate::limits::Limits::new(Some(home))),
            runs: Arc::default(),
            held: Arc::new(crate::rewind::Held::new(Some(home))),
        }
    }

    #[test]
    fn the_orchestrator_folder_is_named_and_never_made() {
        let home = Scratch::new("api-orchestrator-folder");
        let dir = core_at(&home).orchestrator_dir().unwrap();
        assert_eq!(
            PathBuf::from(&dir),
            home.join(".agent-workbench").join("orchestrator")
        );
        assert!(!PathBuf::from(&dir).exists());
    }

    /// A session resumed in the folder an earlier version ran orchestrators
    /// in is told nothing of directing, even with the hooks and the tool
    /// server that version wrote there: only a workflow makes one direct.
    #[test]
    fn a_session_in_the_orchestrator_folder_directs_only_under_a_workflow() {
        let home = Scratch::new("api-folder-role");
        let folder = PathBuf::from(core_at(&home).orchestrator_dir().unwrap());
        std::fs::create_dir_all(&folder).unwrap();
        let bin = home.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        crate::executable::write(bin.join("claude"), b"#!/bin/sh\n").unwrap();
        let daemon = hook::daemon_path(&home);
        std::fs::create_dir_all(daemon.parent().unwrap()).unwrap();
        std::fs::write(&daemon, b"").unwrap();
        let vars = HashMap::from([("PATH".to_string(), bin.to_string_lossy().to_string())]);
        hook::install(&home, &folder, &[], &vars).unwrap();

        let role = |instructions: Option<&str>| {
            let prepared = core_at(&home)
                .prepare(
                    "claude-code",
                    &folder,
                    None,
                    Some("old-plan".into()),
                    Some("token-1"),
                    None,
                    None,
                    None,
                    None,
                    instructions,
                    true,
                    false,
                    false,
                    &vars,
                )
                .unwrap();
            prepared
                .command
                .get_env(adapter::ROLE_VAR)
                .map(|value| value.to_string_lossy().to_string())
        };
        assert_eq!(role(None), None);
        assert_eq!(
            role(Some("1. Direct the work.")),
            Some(adapter::ORCHESTRATOR_ROLE.to_string())
        );
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
            None,
            None,
            Some("1. Direct the work."),
            true,
            false,
            false,
            80,
            24,
            |_| Box::new(|_: &[u8]| true),
        );
        assert_eq!(spawned.err().as_deref(), Some(NO_TOOLS));
    }

    #[test]
    fn an_integrated_start_names_a_mode_only_where_the_window_or_a_resumed_transcript_does() {
        let home = Scratch::new("api-start-mode");
        let folder = Path::new("/projects/demo");
        let dir = crate::transcripts::directory_for(&home.join(".claude"), folder);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("s-1.jsonl"),
            "{\"type\":\"permission-mode\",\"permissionMode\":\"plan\"}\n",
        )
        .unwrap();
        let claude = &crate::claude_stream::CLAUDE_STREAM;
        let env = HashMap::new();
        let mode =
            |named, resumed| start_mode(claude, named, resumed, Some(&home), None, &env, folder);
        // Named by the window: as named, resumed or not.
        assert_eq!(
            mode(Some("acceptEdits"), Some("s-1")).as_deref(),
            Some("acceptEdits")
        );
        // Resumed with none named: as the agent's terminal resumes it.
        assert_eq!(mode(None, Some("s-1")).as_deref(), Some("plan"));
        assert_eq!(mode(Some(" "), Some("s-1")).as_deref(), Some("plan"));
        // A new conversation, or one with no mode on record: the agent's
        // own settings decide.
        assert_eq!(mode(None, None), None);
        assert_eq!(mode(None, Some("s-2")), None);
    }

    /// A Claude Code conversation that went back is read as far as the
    /// entry it went on from, until its transcript holds the cut itself:
    /// a message sent from there hangs off that entry, and the point is
    /// let go.
    #[test]
    fn a_conversation_held_where_it_went_back_reads_as_far_as_that_until_it_goes_on() {
        let home = Scratch::new("api-held-history");
        let claude = home.join(".claude-work");
        let folder = Path::new("/projects/demo");
        let dir = crate::transcripts::directory_for(&claude, folder);
        std::fs::create_dir_all(&dir).unwrap();
        let session = "5f0c2b1e-7a4d-4c1b-9e3f-2a6b8c0d1e2f";
        let path = dir.join(format!("{session}.jsonl"));
        std::fs::write(
            &path,
            include_str!("../fixtures/claude-history/rewind-compacted.jsonl"),
        )
        .unwrap();
        let core = core_at(&home);
        let messages = || -> Vec<String> {
            core.integrated_history(
                "claude-code",
                folder,
                None,
                session,
                Some(&claude.to_string_lossy()),
            )
            .unwrap()
            .unwrap()
            .items
            .into_iter()
            .filter_map(|said| match said.event {
                crate::integrated::Event::Message { message, .. } => Some(message),
                _ => None,
            })
            .collect()
        };
        let config = claude.to_string_lossy().to_string();
        let held = || core.integrated_held("claude-code", folder, None, session, Some(&config));
        assert_eq!(messages(), ["m-1", "m-2", "m-3", "m-4", "m-5"]);
        assert!(!held());
        core.held.hold(session, "a-5", "a-6");
        assert!(held());
        assert!(!core.integrated_held("codex", folder, None, session, Some(&config)));
        assert_eq!(messages(), ["m-1", "m-2", "m-3", "m-4"]);
        // Read again, by a core that starts again.
        assert_eq!(
            core_at(&home).held.at(session, Some("a-6")).as_deref(),
            Some("a-5")
        );
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        for line in [
            r#"{"type":"user","uuid":"m-6","parentUuid":"a-5","isSidechain":false,"timestamp":"2026-11-17T17:00:00.000Z","message":{"role":"user","content":"instead"}}"#,
            r#"{"type":"assistant","uuid":"a-7","parentUuid":"m-6","isSidechain":false,"timestamp":"2026-11-17T17:00:01.000Z","message":{"id":"msg_7","role":"assistant","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}}"#,
        ] {
            writeln!(file, "{line}").unwrap();
        }
        assert_eq!(messages(), ["m-1", "m-2", "m-3", "m-4", "m-6"]);
        assert_eq!(core.held.at(session, Some("a-6")), None, "let go");
        assert!(!held());
    }

    /// A terminal does not take the point a held conversation goes on from,
    /// so resuming one in a terminal is refused, before anything is made,
    /// unless the user agreed to bring back what it left out, which lets
    /// the point go.
    #[test]
    fn a_terminal_resumes_a_held_conversation_only_where_the_user_agreed() {
        let home = Scratch::new("api-held-terminal");
        let claude = home.join(".claude-work");
        let folder = home.join("demo");
        std::fs::create_dir_all(&folder).unwrap();
        let dir = crate::transcripts::directory_for(&claude, &folder);
        std::fs::create_dir_all(&dir).unwrap();
        let session = "5f0c2b1e-7a4d-4c1b-9e3f-2a6b8c0d1e2f";
        std::fs::write(
            dir.join(format!("{session}.jsonl")),
            include_str!("../fixtures/claude-history/rewind-compacted.jsonl"),
        )
        .unwrap();
        let bin = home.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        for agent in ["claude", "codex"] {
            crate::executable::write(bin.join(agent), b"#!/bin/sh\n").unwrap();
        }
        let vars = HashMap::from([("PATH".to_string(), bin.to_string_lossy().to_string())]);
        let config = claude.to_string_lossy().to_string();
        let core = core_at(&home);
        let resume = |agent: &str, session: Option<&str>, bring_back: bool| {
            core.prepare(
                agent,
                &folder,
                None,
                session.map(str::to_string),
                Some("token-1"),
                None,
                None,
                None,
                Some(&config),
                None,
                false,
                false,
                bring_back,
                &vars,
            )
            .map(|_| ())
        };
        let held = || core.integrated_held("claude-code", &folder, None, session, Some(&config));
        // Not held: resumed as ever.
        assert_eq!(resume("claude-code", Some(session), false), Ok(()));
        core.held.hold(session, "a-5", "a-6");
        let refused = resume("claude-code", Some(session), false).unwrap_err();
        assert!(refused.starts_with(&format!("{HELD}: ")), "{refused}");
        assert!(
            refused.contains("went back to an earlier message"),
            "{refused}"
        );
        assert!(held(), "still held after a refusal");
        // A new conversation, and another agent, are none of its concern.
        assert_eq!(resume("claude-code", None, false), Ok(()));
        assert_eq!(resume("codex", Some(session), false), Ok(()));
        // Agreed: resumed, and the point let go.
        assert_eq!(resume("claude-code", Some(session), true), Ok(()));
        assert!(!held());
        assert_eq!(resume("claude-code", Some(session), false), Ok(()));
    }

    /// A conversation started again goes on from the entry asked for, or,
    /// resumed from none in particular, from the one it was held at before
    /// going back, so a fallback or an undo does not bring back what an
    /// earlier going back left out; and is held there.
    #[test]
    fn a_conversation_started_again_goes_on_from_the_entry_asked_or_held_before() {
        use crate::integrated::{Again, Settings};
        let home = Scratch::new("api-going-on");
        let claude = home.join(".claude-work");
        let folder = Path::new("/projects/demo");
        let dir = crate::transcripts::directory_for(&claude, folder);
        std::fs::create_dir_all(&dir).unwrap();
        let session = "5f0c2b1e-7a4d-4c1b-9e3f-2a6b8c0d1e2f";
        std::fs::write(
            dir.join(format!("{session}.jsonl")),
            include_str!("../fixtures/claude-history/rewind-compacted.jsonl"),
        )
        .unwrap();
        let core = core_at(&home);
        let run = Run {
            agent: "claude-code".into(),
            project: folder.to_path_buf(),
            cwd: None,
            session: Some(session.into()),
            token: Some("token-1".into()),
            model: None,
            mode: None,
            effort: None,
            config_dir: Some(claude.to_string_lossy().to_string()),
            instructions: None,
            start_only: false,
            afresh: false,
            undo: None,
        };
        let again = |session: Option<&str>, at: Option<&str>| Again {
            session: session.map(str::to_string),
            at: at.map(str::to_string),
            settings: Settings::default(),
        };
        let held = || core.held.at(session, Some("a-6"));
        assert_eq!(
            core.going_on(&run, &again(Some(session), Some("a-5")), None),
            Ok(Some("a-5".into()))
        );
        assert_eq!(held().as_deref(), Some("a-5"));
        assert_eq!(
            core.going_on(&run, &again(Some(session), None), Some("o-1")),
            Ok(Some("o-1".into()))
        );
        assert_eq!(held().as_deref(), Some("o-1"));
        // A new conversation leaves the one gone back from as it is held.
        assert_eq!(core.going_on(&run, &again(None, None), None), Ok(None));
        assert_eq!(held().as_deref(), Some("o-1"));
        assert_eq!(
            core.going_on(&run, &again(Some(session), None), None),
            Ok(None)
        );
        assert_eq!(held(), None);
        // With no transcript there is nothing to go on from.
        assert!(core
            .going_on(&run, &again(Some("other-session"), Some("a-5")), None)
            .is_err());
    }

    #[test]
    fn an_integrated_session_under_a_workflow_is_refused_where_no_tool_server_can_reach_it() {
        let home = Scratch::new("api-integrated-workflow");
        for agent in ["claude-code", "codex"] {
            let started = core_at(&home).integrated_start(
                agent,
                &home,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some("1. Direct the work."),
                true,
                false,
            );
            // Refused before the folder is asked about, since trusting it
            // would not let the session start.
            assert_eq!(started.err().as_deref(), Some(NO_TOOLS), "{agent}");
        }
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

    /// Through the command interpreter, a briefing of thousands of
    /// characters with line breaks and quotes would not arrive as given:
    /// it goes in a file of the session's own, which the first prompt names.
    #[test]
    fn a_first_prompt_through_the_command_interpreter_goes_in_a_file() {
        let home = Scratch::new("api-first-prompt");
        let briefing = format!("{}\n\nUser:\nSay \"hi\" & go | wait", "word ".repeat(3000));
        let mut files = SessionFiles::default();
        let line = first_prompt(Some(&briefing), true, &mut files, Some(&home))
            .unwrap()
            .unwrap();
        assert!(adapter::safe_through_cmd(&line), "{line}");
        let path = files.paths[0].clone();
        assert!(line.contains(&path.display().to_string()));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), briefing);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // A short plain prompt, or one not going through it, goes as given.
        let mut none = SessionFiles::default();
        assert_eq!(
            first_prompt(Some("Run the tests."), true, &mut none, Some(&home)).unwrap(),
            Some("Run the tests.".to_string())
        );
        assert_eq!(
            first_prompt(Some(&briefing), false, &mut none, Some(&home)).unwrap(),
            Some(briefing.clone())
        );
        assert!(none.paths.is_empty());
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
        let hooked = |folder: &Path| hook::status(&home, folder, &[], &HashMap::new()).installed;

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
        let state =
            std::fs::read_to_string(account::claude_json(&home, None, &HashMap::new())).unwrap();
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
        hook::install(&home, &donor, &[], &HashMap::new()).unwrap();
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
        let hooked = |folder: &Path| hook::status(&home, folder, &[], &HashMap::new()).installed;
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
        let core = core_with(recorder.clone());
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
        // The shell is the system's `sh`, which reads no startup files before
        // it reads the line; the bound is only for a shell that never ends.
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
