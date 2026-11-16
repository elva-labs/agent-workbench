//! The seam between the workbench and whatever agent it is driving.
//!
//! Defined as a *surface*, not as a command. Modelling an agent as "a binary to
//! run in a PTY" works perfectly until the second agent speaks ACP and has no
//! TUI at all, and by then the seam is in the wrong place and every pane above
//! it has to move.
//!
//! Phase 1 has one implementation and that is fine. The point is that the panes
//! talk to the trait rather than to the terminal.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;
use serde::Serialize;

use crate::env::{find_on_path, is_shell_script};

/// What an agent can and cannot do. Be honest here: a pane greys itself out
/// rather than failing when it asks for something the agent has no notion of.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Caps {
    /// Sessions can be reopened by id.
    pub resumable: bool,
    /// Sessions carry a human-readable title.
    pub titles: bool,
    /// Speaks the Agent Client Protocol, so no TUI scraping is needed.
    pub acp: bool,
    /// Can run as an integrated session: a process the core talks to in
    /// messages, with the conversation drawn by the window.
    pub integrated: bool,
}

/// How the workbench talks to a running agent. `Acp` joins in phase 5; the
/// enum exists now so that adding it does not move the seam.
#[derive(Debug)]
pub enum Surface {
    Pty(CommandBuilder),
}

pub struct LaunchCtx<'a> {
    pub project: &'a Path,
    pub env: &'a HashMap<String, String>,
    /// The agent's id for the session when the workbench knows it before
    /// the process is up: one it chose, or the one it resumes.
    pub session: Option<&'a str>,
    /// The token the workbench chose for the session: given to the agent's
    /// environment as `WORKBENCH_SESSION`, which the agent passes on to the
    /// tool server it starts, so every call the server makes names the
    /// session it came from.
    pub token: Option<&'a str>,
    /// The first thing the user, or the session that started this one,
    /// has to say: given on the command line, so the agent has it from
    /// the start rather than typed at it while it is still coming up.
    pub prompt: Option<&'a str>,
    /// The model to run on, by the name the agent takes on its command
    /// line, when the caller chose one. The agent's own default otherwise.
    pub model: Option<&'a str>,
    /// The mode to start in, by the name the agent's integrated sessions
    /// offer it under, when the caller knows the one the conversation last
    /// ran in. The agent's own settings decide otherwise. Only a mode a
    /// session can switch to is taken, so never bypassing permissions.
    pub mode: Option<&'a str>,
    /// Where the agent keeps its configuration and its login, when the
    /// session runs under an account of the user's own: Claude Code reads
    /// it as `CLAUDE_CONFIG_DIR`, Codex as `CODEX_HOME`. The agent's own
    /// directory otherwise.
    pub config_dir: Option<&'a Path>,
    /// Whether this session is the one that directs the others, which is
    /// a session that follows a workflow. The tools it starts tell it what
    /// directing work means.
    pub orchestrator: bool,
    /// What a session that follows a workflow is told: the workflow's
    /// instructions, added to what the agent tells itself, from the first
    /// turn and on every resume.
    pub instructions: Option<&'a str>,
    /// The same instructions in a file of the session's own, for an agent
    /// that reads them from one rather than from its command line.
    pub instructions_file: Option<&'a Path>,
    /// Whether the agent's own ways of handing work to agents the user
    /// cannot see are taken away, so that the workbench's start tool is the
    /// one way the session delegates.
    pub start_only: bool,
    /// The workbench's tool server, named on the command line for a session
    /// that needs the tools where the agent's own configuration does not
    /// point at it.
    pub server: Option<&'a Path>,
    /// A file naming the same server, for an agent that reads its server
    /// configuration from one.
    pub server_file: Option<&'a Path>,
    /// The workbench's tool server when the agent's own configuration for
    /// the directory already points at it. An agent that passes its servers
    /// only the variables it is told to is told the server again here, with
    /// the session's variables to pass on.
    pub configured: Option<&'a Path>,
    /// For a resumed session, whether what it is told now differs from what
    /// its conversation was first given, no instructions at all among
    /// them. Claude Code records what it was first told and gives that on
    /// every resume until told otherwise.
    pub afresh: bool,
}

/// The tools Claude Code hands work to agents the user cannot see with: its
/// subagents, its multi-agent workflows, messages to other agents and the
/// listing of them, and remote agents run in the cloud.
pub const CLAUDE_SUBAGENT_TOOLS: &[&str] = &[
    "Agent",
    "Workflow",
    "SendMessage",
    "ListAgents",
    "RemoteTrigger",
];

/// The settings that take Codex's own subagent tools away. The second
/// takes spawn_agent, send_message, wait_agent, list_agents,
/// interrupt_agent and followup_task from a model on the newer multi-agent
/// version, which is given them whatever the first says. The first turns
/// off the multi-agent tools of a Codex that has no newer version, which
/// passes over the second without a word.
pub const CODEX_NO_SUBAGENTS: &[&str] = &[
    "features.multi_agent=false",
    "features.multi_agent_v2.disable_native_tools=true",
];

/// The name the tool server goes by, to Claude Code and to Codex.
pub const SERVER_NAME: &str = "agent-workbench";
pub const CODEX_SERVER_KEY: &str = "agent_workbench";

/// The setting of a Codex server's entry that says whether its tools ask
/// before they run, and the value that lets them run without asking. The
/// workbench's own entry carries it wherever the workbench names the
/// server to Codex; the servers the user configured ask as their entries
/// say. A Codex that does not know the setting passes over it.
pub const CODEX_APPROVAL_SETTING: &str = "default_tools_approval_mode";
pub const CODEX_APPROVE: &str = "approve";

/// The variable that names the session to the tools the agent starts: the
/// token the workbench chose for it.
pub const SESSION_VAR: &str = "WORKBENCH_SESSION";

/// The variable that says what the session is for, when it is for anything
/// in particular. Only the orchestrator has a role.
pub const ROLE_VAR: &str = "WORKBENCH_ROLE";

/// The one role there is.
pub const ORCHESTRATOR_ROLE: &str = "orchestrator";

pub trait AgentAdapter: Send + Sync {
    fn id(&self) -> &'static str;

    /// Where the agent's binary lives, looked up on the captured environment's
    /// PATH rather than on this process's own.
    fn detect(&self, vars: &HashMap<String, String>) -> Option<PathBuf>;

    /// Starts a fresh conversation under an id the workbench chose. Owning the
    /// id from the start is what lets the pane tell a running session's
    /// transcript apart from the history it can offer to resume.
    fn launch(&self, ctx: &LaunchCtx, session: &str) -> Result<Surface, String>;

    fn resume(&self, ctx: &LaunchCtx, session: &str) -> Result<Surface, String>;

    fn caps(&self) -> Caps;

    /// How the agent is driven as an integrated session, for an agent that
    /// has a structured protocol to drive it by.
    fn integrated(&self) -> Option<&'static dyn crate::integrated::Protocol> {
        None
    }

    /// Whether the agent takes a fresh session's id from the workbench,
    /// which then chooses it. When it does not, the agent mints one and the
    /// workbench has to find it afterwards.
    fn takes_id(&self) -> bool {
        true
    }

    /// Whether the agent reads a workflow's instructions and its tool
    /// server from files of the session's own, rather than from its
    /// command line.
    fn reads_files(&self) -> bool {
        false
    }

    /// Whether the agent passes its tool server only the variables the
    /// server's entry names, so a session's server that its configuration
    /// names is named again on the command line with the session's
    /// variables.
    fn names_server_vars(&self) -> bool {
        false
    }
}

/// Variables that identify the *parent* Claude Code session rather than the
/// user's configuration.
///
/// The captured environment is the login shell's merged with this process's
/// own, so when the workbench is itself launched from inside a Claude Code
/// session these come along. The child then believes it is a nested session:
/// it disables transcript saving, which is precisely the data phase 3's
/// session index reads, and it points its messaging socket at the parent.
///
/// `CLAUDECODE` marks a process as running inside Claude Code, and the
/// agent refuses or misbehaves under it. `WORKBENCH_SESSION` names the
/// parent's own session to its tools; a session of the workbench's gets its
/// own token instead.
///
/// Configuration variables under the same prefix are deliberately kept, since
/// those are the user's and are meant to be inherited.
const SESSION_SCOPED: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_PID",
    SESSION_VAR,
];

/// Gives a plain process, one with no terminal, the project directory and
/// the captured environment, the parent session's markers left out, as
/// [`prepare`] does for a pty.
pub fn prepare_process(
    command: &mut std::process::Command,
    project: &Path,
    vars: &HashMap<String, String>,
) {
    command.current_dir(project);
    command.env_clear();
    command.envs(
        vars.iter()
            .filter(|(key, _)| !SESSION_SCOPED.contains(&key.as_str())),
    );
}

/// A plain process for a program found on PATH. A `.cmd` or `.bat` on
/// Windows goes through the command interpreter, as in [`program`], and no
/// console window opens for it.
pub fn process(binary: &Path, vars: &HashMap<String, String>) -> std::process::Command {
    let command = if cfg!(windows) && is_shell_script(binary) {
        let comspec = vars
            .get("COMSPEC")
            .cloned()
            .unwrap_or_else(|| "cmd.exe".to_string());
        let mut command = std::process::Command::new(comspec);
        command.arg("/c").arg(binary);
        command
    } else {
        std::process::Command::new(binary)
    };
    #[cfg(windows)]
    let command = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = command;
        command.creation_flags(CREATE_NO_WINDOW);
        command
    };
    command
}

/// Gives a command the project directory and the captured environment.
///
/// Shared by the agent and by the plain shell in the terminal panel, so that
/// `claude` typed into that shell behaves exactly like the agent pane's own.
pub fn prepare(command: &mut CommandBuilder, project: &Path, vars: &HashMap<String, String>) {
    command.cwd(project);

    // Start from nothing rather than from this process's environment. The
    // captured login-shell environment is meant to be the whole story, and
    // a merge would quietly reintroduce whatever the app happened to
    // inherit, including the markers dropped just below.
    command.env_clear();

    for (key, value) in vars {
        if SESSION_SCOPED.contains(&key.as_str()) {
            continue;
        }
        command.env(key, value);
    }

    // Without TERM the TUI falls back to something without colour or cursor
    // addressing, which looks like a rendering bug rather than a missing
    // variable. xterm.js speaks xterm-256color.
    command.env("TERM", "xterm-256color");
    // Claude Code reads this to decide how wide to draw before the first
    // SIGWINCH arrives.
    command.env("COLORTERM", "truecolor");
}

/// A command for a program found on PATH, with its arguments. A `.cmd` or
/// `.bat` on Windows cannot be started by the OS; it goes through the command
/// interpreter, which is what a shell would do with it.
fn program(binary: PathBuf, args: &[&str], vars: &HashMap<String, String>) -> CommandBuilder {
    let mut command = if cfg!(windows) && is_shell_script(&binary) {
        let comspec = vars
            .get("COMSPEC")
            .cloned()
            .unwrap_or_else(|| "cmd.exe".to_string());
        let mut command = CommandBuilder::new(comspec);
        command.arg("/c");
        command.arg(binary);
        command
    } else {
        CommandBuilder::new(binary)
    };
    for arg in args {
        command.arg(arg);
    }
    command
}

/// The configuration that names the tool server to Claude Code, which the
/// session reads from a file of its own.
pub fn claude_server_config(server: &Path) -> String {
    serde_json::json!({ "mcpServers": { SERVER_NAME: {
        "type": "stdio",
        "command": server.to_string_lossy(),
        "args": ["mcp"],
    } } })
    .to_string()
}

/// What Claude Code is given for a session that follows a workflow: the
/// tool server and the instructions, each by a file of the session's own,
/// so no line of either is on the command line, and its own ways to hand
/// work out taken away. The list of tools comes before a flag of its own,
/// which ends it.
fn claude_workflow(ctx: &LaunchCtx) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(file) = ctx.server_file {
        args.push("--mcp-config".to_string());
        args.push(file.to_string_lossy().to_string());
    }
    if ctx.start_only {
        args.push("--disallowedTools".to_string());
        args.extend(CLAUDE_SUBAGENT_TOOLS.iter().map(|tool| tool.to_string()));
    }
    if let Some(file) = ctx.instructions_file {
        args.push("--append-system-prompt-file".to_string());
        args.push(file.to_string_lossy().to_string());
    }
    if ctx.afresh {
        args.extend(["--system-prompt-snapshot", "off"].map(str::to_string));
    }
    args
}

/// Why Codex does not start a session that follows a workflow in a
/// terminal on Windows: it takes the instructions only on its command line
/// there, and an install run through the command interpreter loses every
/// line of them after the first. Run integrated, it takes them in a
/// message, so the first way out keeps the workflow on Codex.
pub const CODEX_WORKFLOW_ON_WINDOWS: &str = "Codex in a terminal takes a workflow's instructions only on its command line, which Windows cuts short, so a Codex session in a terminal cannot follow a workflow here. Set Codex to run integrated in the settings' Sessions tab, choose Claude Code for the workflow's orchestrator, or pick Codex to start it alone.";

/// The first Codex that passes a server the variables its entry names,
/// which is how a session on Codex names itself to the workbench's tools.
pub const CODEX_NAMES_ITSELF: (u64, u64, u64) = (0, 47, 0);

/// Why a session on an older Codex does not follow a workflow: its calls
/// would name no session, so it could not direct one.
pub const CODEX_TOO_OLD: &str = "This Codex is older than 0.47.0, which passes the workbench's tool server none of the session's variables, so its calls cannot say which session they come from and it cannot direct a workflow. Update Codex, or choose Claude Code for the workflow's orchestrator.";

/// The version of the Codex at `binary`, from what `codex --version`
/// prints: `codex-cli 0.169.0`. None when it cannot be run or prints no
/// version.
fn codex_version(
    binary: &Path,
    project: &Path,
    vars: &HashMap<String, String>,
) -> Option<(u64, u64, u64)> {
    let mut command = process(binary, vars);
    prepare_process(&mut command, project, vars);
    let output = command.arg("--version").output().ok()?;
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .rev()
        .find_map(crate::codex_app_server::numbers)
}

/// The same for Codex, which takes each as a setting of its configuration:
/// the instructions as developer instructions, its own subagent tools taken
/// away, and the tool server as one of its servers. Codex has no setting
/// that reads developer instructions from a file, so they go on the command
/// line, which is refused on Windows.
///
/// Codex starts a server with only the variables its entry names, so the
/// server is named whole wherever the session has it, with the variables
/// that say which session it serves among those passed on: an entry that
/// named only the variables, where no configuration Codex reads names the
/// server, would stop Codex from starting.
///
/// A server no configuration names is told to let its tools run without
/// asking. One the project's configuration names keeps the approval its
/// entry there says, which the hooks write as the same unless the user
/// chose another: Codex takes the command line over the project's file.
///
/// A Codex the command interpreter runs, a script on Windows, is not told
/// the server its configuration already names. Each setting of the server
/// holds quotes, and the interpreter takes the first and the last quote off
/// a line that has more than two, which cuts a script path with a space in
/// it short. Codex then starts the server from its configuration alone, and
/// the session's calls name no session.
fn codex_workflow(ctx: &LaunchCtx, windows: bool, script: bool) -> Result<Vec<String>, String> {
    if windows && ctx.instructions.is_some() {
        return Err(CODEX_WORKFLOW_ON_WINDOWS.into());
    }
    // A JSON string is a TOML basic string as well: quoted, on one line,
    // with the same escapes.
    let text = |value: &str| serde_json::Value::from(value).to_string();
    let configured = ctx.configured.filter(|_| !(windows && script));
    let mut settings = Vec::new();
    if let Some(server) = ctx.server.or(configured) {
        settings.push(format!(
            "mcp_servers.{CODEX_SERVER_KEY}.command={}",
            text(&server.to_string_lossy())
        ));
        settings.push(format!("mcp_servers.{CODEX_SERVER_KEY}.args=[\"mcp\"]"));
        settings.push(format!(
            "mcp_servers.{CODEX_SERVER_KEY}.env_vars=[{}, {}]",
            text(SESSION_VAR),
            text(ROLE_VAR)
        ));
        if ctx.server.is_some() {
            settings.push(format!(
                "mcp_servers.{CODEX_SERVER_KEY}.{CODEX_APPROVAL_SETTING}={}",
                text(CODEX_APPROVE)
            ));
        }
    }
    if ctx.start_only {
        settings.extend(CODEX_NO_SUBAGENTS.iter().map(|setting| setting.to_string()));
    }
    if let Some(instructions) = ctx.instructions {
        settings.push(format!("developer_instructions={}", text(instructions)));
    }
    Ok(settings
        .into_iter()
        .flat_map(|setting| ["-c".to_string(), setting])
        .collect())
}

/// Claude Code's flag for the mode a session starts in, for a mode its
/// integrated sessions offer; any other is refused.
fn claude_mode<'a>(ctx: &LaunchCtx<'a>) -> Result<Vec<&'a str>, String> {
    match ctx.mode {
        None => Ok(vec![]),
        Some(mode) if crate::claude_stream::offers_mode(mode) => {
            Ok(vec!["--permission-mode", mode])
        }
        Some(mode) => Err(format!("{mode:?} is not a mode Claude Code starts in here")),
    }
}

/// Codex's flags for the mode a session starts in: the approval policy and
/// the sandbox its integrated sessions make that mode of. Any other mode is
/// refused.
fn codex_mode<'a>(ctx: &LaunchCtx<'a>) -> Result<Vec<&'a str>, String> {
    match ctx.mode {
        None => Ok(vec![]),
        Some(mode) => {
            let (approval, sandbox) = crate::codex_app_server::mode_flags(mode)
                .ok_or_else(|| format!("{mode:?} is not a mode Codex runs in"))?;
            Ok(vec!["--ask-for-approval", approval, "--sandbox", sandbox])
        }
    }
}

/// The model flag and the prompt on the end of an agent's arguments. Both
/// agents take `--model`, and both take the prompt after `--`: it is the
/// agent's text, whatever it starts with, and never one of the agent's flags.
fn with_prompt<'a>(ctx: &LaunchCtx<'a>, mut args: Vec<&'a str>) -> Vec<&'a str> {
    if let Some(model) = ctx.model {
        args.extend(["--model", model]);
    }
    if let Some(prompt) = ctx.prompt {
        args.extend(["--", prompt]);
    }
    args
}

pub struct ClaudeCode;

impl ClaudeCode {
    fn command(&self, ctx: &LaunchCtx, args: &[&str]) -> Result<Surface, String> {
        let binary = self.detect(ctx.env).ok_or_else(|| {
            "claude was not found on your PATH. Install Claude Code, or check that \
             it is on the PATH your login shell sets up."
                .to_string()
        })?;

        let mut command = program(binary, args, ctx.env);
        prepare(&mut command, ctx.project, ctx.env);
        name_session(&mut command, ctx);
        if let Some(dir) = ctx.config_dir {
            command.env(CLAUDE_CONFIG_VAR, dir);
        }

        Ok(Surface::Pty(command))
    }
}

/// The variable Claude Code reads its configuration directory from.
pub const CLAUDE_CONFIG_VAR: &str = "CLAUDE_CONFIG_DIR";

/// The variable Codex reads its home from.
pub const CODEX_HOME_VAR: &str = "CODEX_HOME";

/// Puts the session's token in the agent's environment, and its role when
/// it has one. The agent passes both on to the tool server it starts, which
/// is where they are read.
fn name_session(command: &mut CommandBuilder, ctx: &LaunchCtx) {
    if let Some(token) = ctx.token {
        command.env(SESSION_VAR, token);
    }
    if ctx.orchestrator {
        command.env(ROLE_VAR, ORCHESTRATOR_ROLE);
    }
}

impl AgentAdapter for ClaudeCode {
    fn id(&self) -> &'static str {
        "claude-code"
    }

    fn detect(&self, vars: &HashMap<String, String>) -> Option<PathBuf> {
        find_on_path(vars, "claude")
    }

    fn launch(&self, ctx: &LaunchCtx, session: &str) -> Result<Surface, String> {
        let workflow = claude_workflow(ctx);
        let mut args = vec!["--session-id", session];
        args.extend(workflow.iter().map(String::as_str));
        args.extend(claude_mode(ctx)?);
        self.command(ctx, &with_prompt(ctx, args))
    }

    fn resume(&self, ctx: &LaunchCtx, session: &str) -> Result<Surface, String> {
        let workflow = claude_workflow(ctx);
        let mut args = vec!["--resume", session];
        args.extend(workflow.iter().map(String::as_str));
        args.extend(claude_mode(ctx)?);
        self.command(ctx, &with_prompt(ctx, args))
    }

    fn caps(&self) -> Caps {
        Caps {
            resumable: true,
            titles: true,
            acp: false,
            integrated: true,
        }
    }

    fn reads_files(&self) -> bool {
        true
    }

    fn integrated(&self) -> Option<&'static dyn crate::integrated::Protocol> {
        Some(&crate::claude_stream::CLAUDE_STREAM)
    }
}

/// Codex CLI: a full-screen TUI like Claude Code, run the same way, or an
/// integrated session through its app-server. It mints its own session ids
/// and resumes by `codex resume <id>`.
pub struct Codex;

impl Codex {
    fn command(&self, ctx: &LaunchCtx, args: &[&str]) -> Result<Surface, String> {
        let binary = self.detect(ctx.env).ok_or_else(|| {
            "codex was not found on your PATH. Install Codex CLI, or check that it is on \
             the PATH your login shell sets up."
                .to_string()
        })?;

        let mut command = program(binary, args, ctx.env);
        prepare(&mut command, ctx.project, ctx.env);
        name_session(&mut command, ctx);
        if let Some(dir) = ctx.config_dir {
            command.env(CODEX_HOME_VAR, dir);
        }

        Ok(Surface::Pty(command))
    }

    /// Refuses a session that follows a workflow on a Codex too old to name
    /// itself to its tools. A Codex whose version cannot be read is let
    /// through: its calls naming no session cost it its starts and sends,
    /// nothing more.
    fn names_itself(&self, ctx: &LaunchCtx) -> Result<(), String> {
        if ctx.instructions.is_none() {
            return Ok(());
        }
        let Some(binary) = self.detect(ctx.env) else {
            return Ok(());
        };
        match codex_version(&binary, ctx.project, ctx.env) {
            Some(version) if version < CODEX_NAMES_ITSELF => Err(CODEX_TOO_OLD.into()),
            _ => Ok(()),
        }
    }

    /// Whether the Codex found is a script, which Windows runs through the
    /// command interpreter.
    fn script(&self, ctx: &LaunchCtx) -> bool {
        self.detect(ctx.env)
            .is_some_and(|binary| is_shell_script(&binary))
    }
}

impl AgentAdapter for Codex {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn detect(&self, vars: &HashMap<String, String>) -> Option<PathBuf> {
        find_on_path(vars, "codex")
    }

    fn launch(&self, ctx: &LaunchCtx, _session: &str) -> Result<Surface, String> {
        let workflow = codex_workflow(ctx, cfg!(windows), self.script(ctx))?;
        self.names_itself(ctx)?;
        let mut args: Vec<&str> = workflow.iter().map(String::as_str).collect();
        args.extend(codex_mode(ctx)?);
        self.command(ctx, &with_prompt(ctx, args))
    }

    fn resume(&self, ctx: &LaunchCtx, session: &str) -> Result<Surface, String> {
        let workflow = codex_workflow(ctx, cfg!(windows), self.script(ctx))?;
        self.names_itself(ctx)?;
        let mut args = vec!["resume", session];
        args.extend(workflow.iter().map(String::as_str));
        args.extend(codex_mode(ctx)?);
        self.command(ctx, &with_prompt(ctx, args))
    }

    fn caps(&self) -> Caps {
        Caps {
            resumable: true,
            titles: true,
            acp: false,
            integrated: true,
        }
    }

    fn integrated(&self) -> Option<&'static dyn crate::integrated::Protocol> {
        Some(&crate::codex_app_server::CODEX_APP_SERVER)
    }

    fn takes_id(&self) -> bool {
        false
    }

    fn names_server_vars(&self) -> bool {
        true
    }
}

static CLAUDE_CODE: ClaudeCode = ClaudeCode;
static CODEX: Codex = Codex;

/// Every agent the workbench drives, by id.
pub const AGENT_IDS: &[&str] = &["claude-code", "codex"];

/// The agents whose sessions can run integrated: the ones whose adapter
/// drives them in messages. Asked here alone, so the settings, the window
/// and every start agree.
pub fn integrated_agents() -> Vec<&'static str> {
    AGENT_IDS
        .iter()
        .copied()
        .filter(|id| adapter_for(id).is_some_and(|adapter| adapter.caps().integrated))
        .collect()
}

pub fn adapter_for(id: &str) -> Option<&'static dyn AgentAdapter> {
    match id {
        "claude-code" => Some(&CLAUDE_CODE),
        "codex" => Some(&CODEX),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratch::Scratch;

    #[test]
    fn the_agents_that_run_integrated_are_the_ones_whose_adapter_drives_them() {
        assert_eq!(integrated_agents(), vec!["claude-code", "codex"]);
        for id in integrated_agents() {
            assert!(adapter_for(id).unwrap().integrated().is_some(), "{id}");
        }
    }

    fn vars_with_path(dir: &Path) -> HashMap<String, String> {
        HashMap::from([("PATH".to_string(), dir.to_string_lossy().to_string())])
    }

    fn fake_claude(label: &str) -> Scratch {
        let dir = Scratch::new(label);
        let bin = dir.join("claude");
        std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        dir
    }

    #[test]
    fn resolves_by_id() {
        assert!(adapter_for("claude-code").is_some());
        assert!(adapter_for("codex").is_some());
        assert!(adapter_for("some-other-agent").is_none());
        for id in ["claude-code", "codex"] {
            assert_eq!(adapter_for(id).unwrap().id(), id);
        }
    }

    #[test]
    fn codex_mints_its_own_ids_and_resumes_by_subcommand() {
        assert!(ClaudeCode.takes_id());
        assert!(!Codex.takes_id());

        let dir = Scratch::new("adapter-codex");
        let bin = dir.join("codex");
        std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let vars = vars_with_path(&dir);
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            config_dir: None,
            session: None,
            token: None,
            prompt: None,
            model: None,
            mode: None,
            orchestrator: false,
            instructions: None,
            start_only: false,
            server: None,
            instructions_file: None,
            server_file: None,
            configured: None,
            afresh: false,
        };
        let Surface::Pty(resumed) = Codex.resume(&ctx, "abc").unwrap();
        let argv: Vec<String> = resumed
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(&argv[1..], ["resume", "abc"]);
        let Surface::Pty(fresh) = Codex.launch(&ctx, "ignored").unwrap();
        assert_eq!(fresh.get_argv().len(), 1, "no id is handed to codex");
    }

    #[test]
    fn reports_what_claude_code_can_do() {
        let caps = ClaudeCode.caps();
        assert!(caps.resumable);
        assert!(caps.titles);
        assert!(!caps.acp, "phase 5 turns this on, not before");
    }

    #[test]
    fn a_first_prompt_follows_the_flags_and_cannot_be_one() {
        let dir = Scratch::new("adapter-prompt");
        for name in ["claude", "codex"] {
            let bin = dir.join(name);
            std::fs::write(&bin, "#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        let vars = vars_with_path(&dir);
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            config_dir: None,
            session: Some("abc"),
            token: None,
            prompt: Some("--dangerously-skip-permissions and fix it"),
            model: None,
            mode: None,
            orchestrator: false,
            instructions: None,
            start_only: false,
            server: None,
            instructions_file: None,
            server_file: None,
            configured: None,
            afresh: false,
        };
        let argv = |surface: Surface| {
            let Surface::Pty(command) = surface;
            command
                .get_argv()
                .iter()
                .map(|arg| arg.to_string_lossy().to_string())
                .collect::<Vec<_>>()
        };
        let claude = argv(ClaudeCode.launch(&ctx, "abc").unwrap());
        assert_eq!(
            &claude[1..],
            [
                "--session-id",
                "abc",
                "--",
                "--dangerously-skip-permissions and fix it"
            ]
        );
        let codex = argv(Codex.launch(&ctx, "").unwrap());
        assert_eq!(
            &codex[1..],
            ["--", "--dangerously-skip-permissions and fix it"]
        );
    }

    #[test]
    fn an_account_s_directory_reaches_each_agent_as_its_own_variable() {
        let dir = Scratch::new("adapter-account");
        for name in ["claude", "codex"] {
            let bin = dir.join(name);
            std::fs::write(&bin, "#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        let vars = vars_with_path(&dir);
        let own = Path::new("/home/ada/.claude-work");
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            config_dir: Some(own),
            session: None,
            token: None,
            prompt: None,
            model: None,
            mode: None,
            orchestrator: false,
            instructions: None,
            start_only: false,
            server: None,
            instructions_file: None,
            server_file: None,
            configured: None,
            afresh: false,
        };
        let Surface::Pty(claude) = ClaudeCode.launch(&ctx, "abc").unwrap();
        assert_eq!(claude.get_env(CLAUDE_CONFIG_VAR), Some(own.as_os_str()));
        assert!(claude.get_env(CODEX_HOME_VAR).is_none());
        let Surface::Pty(codex) = Codex.launch(&ctx, "").unwrap();
        assert_eq!(codex.get_env(CODEX_HOME_VAR), Some(own.as_os_str()));
        assert!(codex.get_env(CLAUDE_CONFIG_VAR).is_none());

        // Without one, neither variable is set by the workbench.
        let ctx = LaunchCtx {
            config_dir: None,
            ..ctx
        };
        let Surface::Pty(claude) = ClaudeCode.launch(&ctx, "abc").unwrap();
        assert!(claude.get_env(CLAUDE_CONFIG_VAR).is_none());
    }

    #[test]
    fn the_model_goes_on_the_command_line_before_the_prompt_for_a_launch_and_a_resume() {
        let dir = Scratch::new("adapter-model");
        for name in ["claude", "codex"] {
            let bin = dir.join(name);
            std::fs::write(&bin, "#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        let vars = vars_with_path(&dir);
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            config_dir: None,
            session: Some("abc"),
            token: None,
            prompt: Some("Go on with the cache test"),
            model: Some("sonnet"),
            mode: None,
            orchestrator: false,
            instructions: None,
            start_only: false,
            server: None,
            instructions_file: None,
            server_file: None,
            configured: None,
            afresh: false,
        };
        let argv = |surface: Surface| {
            let Surface::Pty(command) = surface;
            command
                .get_argv()
                .iter()
                .map(|arg| arg.to_string_lossy().to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            &argv(ClaudeCode.launch(&ctx, "abc").unwrap())[1..],
            [
                "--session-id",
                "abc",
                "--model",
                "sonnet",
                "--",
                "Go on with the cache test"
            ]
        );
        assert_eq!(
            &argv(ClaudeCode.resume(&ctx, "abc").unwrap())[1..],
            [
                "--resume",
                "abc",
                "--model",
                "sonnet",
                "--",
                "Go on with the cache test"
            ]
        );
        assert_eq!(
            &argv(Codex.launch(&ctx, "").unwrap())[1..],
            ["--model", "sonnet", "--", "Go on with the cache test"]
        );
        assert_eq!(
            &argv(Codex.resume(&ctx, "abc").unwrap())[1..],
            [
                "resume",
                "abc",
                "--model",
                "sonnet",
                "--",
                "Go on with the cache test"
            ]
        );
    }

    #[test]
    fn a_resume_starts_in_the_mode_named_as_each_agent_spells_it_and_never_in_another() {
        let dir = Scratch::new("adapter-mode");
        for name in ["claude", "codex"] {
            let bin = dir.join(name);
            std::fs::write(&bin, "#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        let vars = vars_with_path(&dir);
        let with = |mode| LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            config_dir: None,
            session: Some("abc"),
            token: None,
            prompt: None,
            model: Some("sonnet"),
            mode: Some(mode),
            orchestrator: false,
            instructions: None,
            start_only: false,
            server: None,
            instructions_file: None,
            server_file: None,
            configured: None,
            afresh: false,
        };
        let argv = |surface: Surface| {
            let Surface::Pty(command) = surface;
            command
                .get_argv()
                .iter()
                .map(|arg| arg.to_string_lossy().to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            &argv(ClaudeCode.resume(&with("default"), "abc").unwrap())[1..],
            [
                "--resume",
                "abc",
                "--permission-mode",
                "default",
                "--model",
                "sonnet"
            ]
        );
        assert_eq!(
            &argv(Codex.resume(&with("read-only"), "abc").unwrap())[1..],
            [
                "resume",
                "abc",
                "--ask-for-approval",
                "on-request",
                "--sandbox",
                "read-only",
                "--model",
                "sonnet"
            ]
        );
        // Bypassing permissions, a mode of the other agent's or anything a
        // session cannot switch to is refused rather than passed on.
        for mode in [
            "bypassPermissions",
            "read-only",
            "--dangerously-skip-permissions",
        ] {
            assert!(ClaudeCode.resume(&with(mode), "abc").is_err(), "{mode}");
        }
        for mode in ["acceptEdits", "danger-full-access", "-c x=y"] {
            assert!(Codex.resume(&with(mode), "abc").is_err(), "{mode}");
        }
    }

    #[test]
    fn a_session_under_a_workflow_is_told_it_and_delegates_only_through_start() {
        let dir = Scratch::new("adapter-workflow");
        for name in ["claude", "codex"] {
            let bin = dir.join(name);
            std::fs::write(&bin, "#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        let vars = vars_with_path(&dir);
        let server = Path::new("/home/ada/.agent-workbench/bin/agent-workbench-remote");
        let told = Path::new("/home/ada/.agent-workbench/sessions/abc.md");
        let named = Path::new("/home/ada/.agent-workbench/sessions/abc.json");
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            config_dir: None,
            session: Some("abc"),
            token: None,
            prompt: Some("Fix the flaky test"),
            model: Some("fable"),
            mode: None,
            orchestrator: true,
            instructions: Some("1. Direct the work.\n2. Say \"done\"."),
            instructions_file: Some(told),
            start_only: true,
            server: Some(server),
            server_file: Some(named),
            configured: None,
            afresh: false,
        };
        let argv = |surface: Surface| {
            let Surface::Pty(command) = surface;
            command
                .get_argv()
                .iter()
                .map(|arg| arg.to_string_lossy().to_string())
                .collect::<Vec<_>>()
        };
        // Claude Code reads the server and the instructions from the
        // session's files, so nothing on its command line has a line break
        // or a quote for a command interpreter to cut at.
        let claude_after = |first: &str| {
            [
                first,
                "abc",
                "--mcp-config",
                "/home/ada/.agent-workbench/sessions/abc.json",
                "--disallowedTools",
                "Agent",
                "Workflow",
                "SendMessage",
                "ListAgents",
                "RemoteTrigger",
                "--append-system-prompt-file",
                "/home/ada/.agent-workbench/sessions/abc.md",
                "--model",
                "fable",
                "--",
                "Fix the flaky test",
            ]
            .map(str::to_string)
            .to_vec()
        };
        let launched = argv(ClaudeCode.launch(&ctx, "abc").unwrap());
        assert_eq!(launched[1..], claude_after("--session-id"));
        assert!(launched.iter().all(|arg| !arg.contains(['\n', '"'])));
        assert_eq!(
            argv(ClaudeCode.resume(&ctx, "abc").unwrap())[1..],
            claude_after("--resume")
        );
        assert_eq!(
            claude_server_config(server),
            format!(
                r#"{{"mcpServers":{{"agent-workbench":{{"args":["mcp"],"command":"{}","type":"stdio"}}}}}}"#,
                server.display()
            )
        );

        let codex_settings = [
            "-c".to_string(),
            format!(
                "mcp_servers.agent_workbench.command=\"{}\"",
                server.display()
            ),
            "-c".to_string(),
            "mcp_servers.agent_workbench.args=[\"mcp\"]".to_string(),
            "-c".to_string(),
            "mcp_servers.agent_workbench.env_vars=[\"WORKBENCH_SESSION\", \"WORKBENCH_ROLE\"]"
                .to_string(),
            "-c".to_string(),
            "mcp_servers.agent_workbench.default_tools_approval_mode=\"approve\"".to_string(),
            "-c".to_string(),
            "features.multi_agent=false".to_string(),
            "-c".to_string(),
            "features.multi_agent_v2.disable_native_tools=true".to_string(),
            "-c".to_string(),
            r#"developer_instructions="1. Direct the work.\n2. Say \"done\".""#.to_string(),
        ];
        assert_eq!(codex_workflow(&ctx, false, false).unwrap(), codex_settings);
        let tail = ["--model", "fable", "--", "Fix the flaky test"].map(str::to_string);
        if !cfg!(windows) {
            assert_eq!(
                argv(Codex.launch(&ctx, "").unwrap())[1..],
                [codex_settings.to_vec(), tail.to_vec()].concat()
            );
            assert_eq!(
                argv(Codex.resume(&ctx, "abc").unwrap())[1..],
                [
                    vec!["resume".to_string(), "abc".to_string()],
                    codex_settings.to_vec(),
                    tail.to_vec()
                ]
                .concat()
            );
        }
        // On Windows the instructions would be cut at their first line, and
        // the refusal names the way that keeps the workflow on Codex.
        assert_eq!(
            codex_workflow(&ctx, true, false).unwrap_err(),
            CODEX_WORKFLOW_ON_WINDOWS
        );
        assert!(CODEX_WORKFLOW_ON_WINDOWS
            .contains("Set Codex to run integrated in the settings' Sessions tab"));

        // With its own tools left alone and the server already configured,
        // the session is told the workflow and nothing else changes.
        let ctx = LaunchCtx {
            start_only: false,
            server: None,
            server_file: None,
            configured: None,
            model: None,
            mode: None,
            prompt: None,
            ..ctx
        };
        assert_eq!(
            argv(ClaudeCode.launch(&ctx, "abc").unwrap())[1..],
            [
                "--session-id",
                "abc",
                "--append-system-prompt-file",
                "/home/ada/.agent-workbench/sessions/abc.md"
            ]
        );
        assert_eq!(
            codex_workflow(&ctx, false, false).unwrap(),
            [
                "-c",
                r#"developer_instructions="1. Direct the work.\n2. Say \"done\".""#
            ]
        );
        // Resumed with instructions other than those it was first given,
        // Claude Code is told to read them rather than the record it keeps.
        let changed = LaunchCtx {
            afresh: true,
            ..ctx
        };
        assert_eq!(
            argv(ClaudeCode.resume(&changed, "abc").unwrap())[1..],
            [
                "--resume",
                "abc",
                "--append-system-prompt-file",
                "/home/ada/.agent-workbench/sessions/abc.md",
                "--system-prompt-snapshot",
                "off"
            ]
        );
        let ctx = LaunchCtx {
            afresh: false,
            ..changed
        };
        // A session with no workflow starts on Windows as anywhere.
        let plain = LaunchCtx {
            instructions: None,
            instructions_file: None,
            ..ctx
        };
        assert!(codex_workflow(&plain, true, false).unwrap().is_empty());
        // Resumed with no workflow where its conversation was first given
        // one, Claude Code is told to let go of what it recorded, and given
        // nothing in its place.
        let without = LaunchCtx {
            afresh: true,
            start_only: false,
            server_file: None,
            configured: None,
            ..plain
        };
        assert_eq!(
            argv(ClaudeCode.resume(&without, "abc").unwrap())[1..],
            ["--resume", "abc", "--system-prompt-snapshot", "off"]
        );
    }

    /// Codex's own subagent tools are gone from what the model is given
    /// with the settings the workbench passes, and there without them. Run
    /// where Codex is installed, on a home of its own; a machine without it
    /// has nothing to check.
    #[test]
    fn codex_lists_no_subagent_tools_with_the_settings() {
        let vars: HashMap<String, String> = std::env::vars().collect();
        let Some(codex) = find_on_path(&vars, "codex") else {
            return;
        };
        let home = Scratch::new("codex-home");
        let input = |settings: &[&str]| {
            let mut command = std::process::Command::new(&codex);
            command
                .args(["debug", "prompt-input"])
                .env(CODEX_HOME_VAR, home.path())
                .current_dir(&home);
            for setting in settings {
                command.args(["-c", setting]);
            }
            let output = command.arg("hi").output().unwrap();
            String::from_utf8_lossy(&output.stdout).to_string()
        };
        let tools = ["spawn_agent", "send_message", "wait_agent", "list_agents"];
        let with = input(&[]);
        let without = input(CODEX_NO_SUBAGENTS);
        assert!(!with.is_empty(), "codex debug prompt-input answered");
        assert!(!without.is_empty(), "codex debug prompt-input answered");
        for tool in tools {
            assert!(with.contains(tool), "{tool} is there without the settings");
            assert!(!without.contains(tool), "{tool} is gone with them");
        }
    }

    /// Codex reads the workbench's server, as the command line names it and
    /// as the hooks write it into a project's configuration, with its tools
    /// allowed without asking. A Codex from before the setting starts all
    /// the same. Run where Codex is installed, on a home of its own; a
    /// machine without it has nothing to check.
    #[test]
    fn codex_runs_the_workbench_s_tools_without_asking_from_either_entry() {
        /// The first Codex that knows the setting.
        const KNOWS_APPROVAL: (u64, u64, u64) = (0, 122, 0);
        let vars: HashMap<String, String> = std::env::vars().collect();
        let Some(codex) = find_on_path(&vars, "codex") else {
            return;
        };
        let workbench = Scratch::new("codex-approval-workbench");
        let codex_home = Scratch::new("codex-approval-codex-home");
        let project = Scratch::new("codex-approval-project");
        let knows =
            codex_version(&codex, &project, &vars).is_some_and(|version| version >= KNOWS_APPROVAL);
        let get = |settings: &[String]| {
            let output = std::process::Command::new(&codex)
                .args(settings)
                .args(["mcp", "get", CODEX_SERVER_KEY])
                .env(CODEX_HOME_VAR, codex_home.path())
                .current_dir(&project)
                .output()
                .unwrap();
            let said = String::from_utf8_lossy(&output.stdout).to_string();
            assert!(
                output.status.success(),
                "{said}{}",
                String::from_utf8_lossy(&output.stderr)
            );
            said
        };
        let approves = format!("{CODEX_APPROVAL_SETTING}: {CODEX_APPROVE}");

        let daemon = crate::hook::daemon_path(&workbench);
        let named = LaunchCtx {
            project: &project,
            env: &vars,
            config_dir: None,
            session: None,
            token: None,
            prompt: None,
            model: None,
            mode: None,
            orchestrator: false,
            instructions: None,
            instructions_file: None,
            start_only: false,
            server: Some(&daemon),
            server_file: None,
            configured: None,
            afresh: false,
        };
        let said = get(&codex_workflow(&named, false, false).unwrap());
        assert!(said.contains(&*daemon.to_string_lossy()), "{said}");
        assert_eq!(said.contains(&approves), knows, "{said}");

        std::fs::create_dir_all(daemon.parent().unwrap()).unwrap();
        std::fs::write(&daemon, "").unwrap();
        crate::hook::install(&workbench, &project, &[], &HashMap::new()).unwrap();
        crate::hook::codex_trust(&codex_home.join("config.toml"), &project).unwrap();
        let said = get(&[]);
        assert!(said.contains(&*daemon.to_string_lossy()), "{said}");
        assert_eq!(said.contains(&approves), knows, "{said}");

        // A session in that project is told the server again, for the
        // variables, and the approval is the project entry's: the hooks'
        // own, or one the user chose there.
        let configured = LaunchCtx {
            server: None,
            configured: Some(&daemon),
            ..named
        };
        let again = codex_workflow(&configured, false, false).unwrap();
        assert_eq!(get(&again).contains(&approves), knows);
        let config = project.join(".codex").join("config.toml");
        let theirs = std::fs::read_to_string(&config).unwrap().replace(
            &format!("{CODEX_APPROVAL_SETTING} = \"{CODEX_APPROVE}\""),
            &format!("{CODEX_APPROVAL_SETTING} = \"prompt\""),
        );
        std::fs::write(&config, theirs).unwrap();
        let said = get(&again);
        assert_eq!(
            said.contains(&format!("{CODEX_APPROVAL_SETTING}: prompt")),
            knows,
            "{said}"
        );
        // And the variables are still passed on.
        if knows {
            let read = std::process::Command::new(&codex)
                .args(&again)
                .args(["mcp", "get", CODEX_SERVER_KEY, "--json"])
                .env(CODEX_HOME_VAR, codex_home.path())
                .current_dir(&project)
                .output()
                .unwrap();
            let entry: serde_json::Value = serde_json::from_slice(&read.stdout).unwrap();
            assert_eq!(
                entry["transport"]["env_vars"],
                serde_json::json!([SESSION_VAR, ROLE_VAR])
            );
        }
    }

    #[test]
    fn finds_the_binary_on_the_given_path() {
        let dir = fake_claude("adapter-detect");
        let vars = vars_with_path(&dir);
        assert_eq!(ClaudeCode.detect(&vars), Some(dir.join("claude")));
    }

    #[test]
    fn detects_nothing_when_the_path_does_not_hold_it() {
        let vars = HashMap::from([("PATH".to_string(), "/nowhere".to_string())]);
        assert_eq!(ClaudeCode.detect(&vars), None);
    }

    #[test]
    fn names_the_session_to_its_tools_by_the_workbench_s_token() {
        let dir = fake_claude("adapter-session");
        let codex = dir.join("codex");
        std::fs::write(&codex, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let vars = vars_with_path(&dir);
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            config_dir: None,
            session: Some("abc-123"),
            token: Some("token-1"),
            prompt: None,
            model: None,
            mode: None,
            orchestrator: false,
            instructions: None,
            start_only: false,
            server: None,
            instructions_file: None,
            server_file: None,
            configured: None,
            afresh: false,
        };
        let Surface::Pty(command) = ClaudeCode.launch(&ctx, "abc-123").unwrap();
        assert_eq!(
            command
                .get_env(SESSION_VAR)
                .map(|v| v.to_string_lossy().to_string()),
            Some("token-1".to_string())
        );
        // An agent that mints its own id has the token all the same, from
        // the start.
        let fresh = LaunchCtx {
            session: None,
            ..ctx
        };
        let Surface::Pty(command) = Codex.launch(&fresh, "").unwrap();
        assert_eq!(
            command
                .get_env(SESSION_VAR)
                .map(|v| v.to_string_lossy().to_string()),
            Some("token-1".to_string())
        );
        let unnamed = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            config_dir: None,
            session: Some("abc-123"),
            token: None,
            prompt: None,
            model: None,
            mode: None,
            orchestrator: false,
            instructions: None,
            start_only: false,
            server: None,
            instructions_file: None,
            server_file: None,
            configured: None,
            afresh: false,
        };
        let Surface::Pty(command) = ClaudeCode.launch(&unnamed, "abc-123").unwrap();
        assert!(command.get_env(SESSION_VAR).is_none());
    }

    #[test]
    fn codex_passes_the_session_s_variables_to_the_tool_server_it_has() {
        let vars = HashMap::new();
        let daemon = Path::new("/home/ada/.agent-workbench/bin/agent-workbench-remote");
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            config_dir: None,
            session: None,
            token: Some("token-1"),
            prompt: None,
            model: None,
            mode: None,
            orchestrator: false,
            instructions: None,
            instructions_file: None,
            start_only: false,
            server: None,
            server_file: None,
            configured: None,
            afresh: false,
        };
        // No server anywhere: nothing is said of one, since an entry Codex
        // cannot start would stop the session from starting.
        assert!(codex_workflow(&ctx, false, false).unwrap().is_empty());
        // The project's configuration names it: it is named again, whole,
        // with the variables Codex is to pass on, and nothing of its tools'
        // approval, so the one the project's entry says holds.
        let configured = LaunchCtx {
            configured: Some(daemon),
            ..ctx
        };
        let whole = [
            "-c".to_string(),
            format!(
                "mcp_servers.agent_workbench.command=\"{}\"",
                daemon.display()
            ),
            "-c".to_string(),
            "mcp_servers.agent_workbench.args=[\"mcp\"]".to_string(),
            "-c".to_string(),
            "mcp_servers.agent_workbench.env_vars=[\"WORKBENCH_SESSION\", \"WORKBENCH_ROLE\"]"
                .to_string(),
        ];
        assert_eq!(codex_workflow(&configured, false, false).unwrap(), whole);
        // Named where no configuration names it, its tools run without
        // asking. No other server and no approval policy of the user's is
        // spoken of either way.
        let named = LaunchCtx {
            server: Some(daemon),
            ..ctx
        };
        let approving = [
            whole.to_vec(),
            vec![
                "-c".to_string(),
                "mcp_servers.agent_workbench.default_tools_approval_mode=\"approve\"".to_string(),
            ],
        ]
        .concat();
        assert_eq!(codex_workflow(&named, false, false).unwrap(), approving);
        assert!(approving
            .iter()
            .all(|arg| arg == "-c" || arg.starts_with("mcp_servers.agent_workbench.")));
        assert_eq!(codex_workflow(&configured, true, false).unwrap(), whole);
        // A script on Windows is told nothing of it: the interpreter would
        // cut the script's path short at the settings' quotes.
        assert!(codex_workflow(&configured, true, true).unwrap().is_empty());
        // Elsewhere a script is run as itself and takes the settings.
        assert_eq!(codex_workflow(&configured, false, true).unwrap(), whole);
        // Claude Code passes its servers its whole environment, so it is
        // told nothing more.
        let dir = fake_claude("adapter-configured");
        let path = vars_with_path(&dir);
        let claude = LaunchCtx {
            env: &path,
            ..configured
        };
        let Surface::Pty(command) = ClaudeCode.launch(&claude, "abc").unwrap();
        assert!(command
            .get_argv()
            .iter()
            .all(|arg| !arg.to_string_lossy().contains("mcp")));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_workflow_on_a_codex_too_old_to_name_its_session() {
        use std::os::unix::fs::PermissionsExt;
        let dir = Scratch::new("adapter-codex-version");
        let bin = dir.join("codex");
        let vars = vars_with_path(&dir);
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            config_dir: None,
            session: None,
            token: Some("token-1"),
            prompt: None,
            model: None,
            mode: None,
            orchestrator: true,
            instructions: Some("Direct the work."),
            instructions_file: None,
            start_only: false,
            server: None,
            server_file: None,
            configured: None,
            afresh: false,
        };
        let says = |text: &str| {
            std::fs::write(&bin, format!("#!/bin/sh\necho '{text}'\n")).unwrap();
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        says("codex-cli 0.46.0");
        assert_eq!(
            Codex.launch(&ctx, "").err(),
            Some(CODEX_TOO_OLD.to_string())
        );
        assert_eq!(
            Codex.resume(&ctx, "abc").err(),
            Some(CODEX_TOO_OLD.to_string())
        );
        // Without a workflow it starts, its calls naming no session.
        let plain = LaunchCtx {
            instructions: None,
            orchestrator: false,
            ..ctx
        };
        assert!(Codex.launch(&plain, "").is_ok());
        for version in [
            "codex-cli 0.47.0",
            "codex-cli 0.169.0",
            "codex-cli 1.0.0-alpha.1",
        ] {
            says(version);
            assert!(Codex.launch(&ctx, "").is_ok(), "{version}");
        }
        // A version it cannot read lets it through.
        says("");
        assert!(Codex.launch(&ctx, "").is_ok());
    }

    #[test]
    fn tells_the_agent_its_role_only_when_it_directs_the_others() {
        let dir = Scratch::new("adapter-role");
        for name in ["claude", "codex"] {
            let bin = dir.join(name);
            std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        let vars = vars_with_path(&dir);
        let role = |orchestrator: bool, adapter: &dyn AgentAdapter| {
            let ctx = LaunchCtx {
                project: Path::new("/tmp"),
                env: &vars,
                config_dir: None,
                session: Some("abc"),
                token: None,
                prompt: None,
                model: None,
                mode: None,
                orchestrator,
                instructions: None,
                start_only: false,
                server: None,
                instructions_file: None,
                server_file: None,
                configured: None,
                afresh: false,
            };
            let Surface::Pty(command) = adapter.launch(&ctx, "abc").unwrap();
            command
                .get_env(ROLE_VAR)
                .map(|value| value.to_string_lossy().to_string())
        };
        for adapter in [&ClaudeCode as &dyn AgentAdapter, &Codex] {
            assert_eq!(
                role(true, adapter),
                Some(ORCHESTRATOR_ROLE.to_string()),
                "{}",
                adapter.id()
            );
            assert_eq!(role(false, adapter), None, "{}", adapter.id());
        }
    }

    #[test]
    fn launching_without_the_binary_explains_itself() {
        let vars = HashMap::from([("PATH".to_string(), "/nowhere".to_string())]);
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            config_dir: None,
            session: None,
            token: None,
            prompt: None,
            model: None,
            mode: None,
            orchestrator: false,
            instructions: None,
            start_only: false,
            server: None,
            instructions_file: None,
            server_file: None,
            configured: None,
            afresh: false,
        };
        let error = ClaudeCode.launch(&ctx, "id").unwrap_err();
        assert!(error.contains("claude"), "names the binary: {error}");
        assert!(error.contains("PATH"), "names the cause: {error}");
    }

    #[test]
    fn launch_builds_a_pty_surface() {
        let dir = fake_claude("adapter-launch");
        let vars = vars_with_path(&dir);
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            config_dir: None,
            session: None,
            token: None,
            prompt: None,
            model: None,
            mode: None,
            orchestrator: false,
            instructions: None,
            start_only: false,
            server: None,
            instructions_file: None,
            server_file: None,
            configured: None,
            afresh: false,
        };

        let Surface::Pty(command) = ClaudeCode.launch(&ctx, "fresh-id").unwrap();
        let argv: Vec<String> = command
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert_eq!(&argv[1..], ["--session-id", "fresh-id"], "{argv:?}");
        assert_eq!(command.get_env("TERM"), Some("xterm-256color".as_ref()));
    }

    #[test]
    fn resume_passes_the_session_id_through() {
        let dir = fake_claude("adapter-resume");
        let vars = vars_with_path(&dir);
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            config_dir: None,
            session: None,
            token: None,
            prompt: None,
            model: None,
            mode: None,
            orchestrator: false,
            instructions: None,
            start_only: false,
            server: None,
            instructions_file: None,
            server_file: None,
            configured: None,
            afresh: false,
        };

        let Surface::Pty(command) = ClaudeCode.resume(&ctx, "abc-123").unwrap();
        let argv: Vec<String> = command
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert!(argv.contains(&"--resume".to_string()), "{argv:?}");
        assert!(argv.contains(&"abc-123".to_string()), "{argv:?}");
    }

    #[test]
    fn drops_the_parent_session_markers() {
        let dir = fake_claude("adapter-markers");
        let mut vars = vars_with_path(&dir);
        vars.insert("CLAUDE_CODE_CHILD_SESSION".to_string(), "1".to_string());
        vars.insert("CLAUDE_CODE_SESSION_ID".to_string(), "abc".to_string());
        vars.insert(
            "CLAUDE_CODE_MESSAGING_SOCKET".to_string(),
            "/tmp/s".to_string(),
        );
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            config_dir: None,
            session: None,
            token: None,
            prompt: None,
            model: None,
            mode: None,
            orchestrator: false,
            instructions: None,
            start_only: false,
            server: None,
            instructions_file: None,
            server_file: None,
            configured: None,
            afresh: false,
        };

        let Surface::Pty(command) = ClaudeCode.launch(&ctx, "id").unwrap();
        for marker in SESSION_SCOPED {
            assert_eq!(
                command.get_env(marker),
                None,
                "{marker} should not be inherited"
            );
        }
    }

    #[test]
    fn keeps_configuration_under_the_same_prefix() {
        // The user's own settings are meant to be inherited; only the parent's
        // session identity is not.
        let dir = fake_claude("adapter-config");
        let mut vars = vars_with_path(&dir);
        vars.insert("CLAUDE_CODE_USE_BEDROCK".to_string(), "1".to_string());
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            config_dir: None,
            session: None,
            token: None,
            prompt: None,
            model: None,
            mode: None,
            orchestrator: false,
            instructions: None,
            start_only: false,
            server: None,
            instructions_file: None,
            server_file: None,
            configured: None,
            afresh: false,
        };

        let Surface::Pty(command) = ClaudeCode.launch(&ctx, "id").unwrap();
        assert_eq!(
            command.get_env("CLAUDE_CODE_USE_BEDROCK"),
            Some("1".as_ref())
        );
    }

    #[test]
    fn carries_the_captured_environment_into_the_command() {
        let dir = fake_claude("adapter-env");
        let mut vars = vars_with_path(&dir);
        vars.insert("NVM_BIN".to_string(), "/home/ada/.nvm/bin".to_string());
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            config_dir: None,
            session: None,
            token: None,
            prompt: None,
            model: None,
            mode: None,
            orchestrator: false,
            instructions: None,
            start_only: false,
            server: None,
            instructions_file: None,
            server_file: None,
            configured: None,
            afresh: false,
        };

        let Surface::Pty(command) = ClaudeCode.launch(&ctx, "id").unwrap();
        assert_eq!(
            command.get_env("NVM_BIN"),
            Some("/home/ada/.nvm/bin".as_ref())
        );
    }
}
