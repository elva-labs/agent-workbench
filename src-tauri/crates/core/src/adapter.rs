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
    /// The session's id when the workbench knows it before the process is
    /// up: given to the agent's environment as `WORKBENCH_SESSION`, which
    /// the agent passes on to the MCP server it starts, so a request the
    /// server logs names the session it came from.
    pub session: Option<&'a str>,
    /// The first thing the user, or the session that started this one,
    /// has to say: given on the command line, so the agent has it from
    /// the start rather than typed at it while it is still coming up.
    pub prompt: Option<&'a str>,
}

/// The variable that names the session to the tools the agent starts.
pub const SESSION_VAR: &str = "WORKBENCH_SESSION";

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

    /// Whether the workbench chooses a fresh session's id. When it does not,
    /// the agent mints one and the workbench has to find it afterwards.
    fn mints_id(&self) -> bool {
        true
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
/// Configuration variables under the same prefix are deliberately kept, since
/// those are the user's and are meant to be inherited.
const SESSION_SCOPED: &[&str] = &[
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
];

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

        Ok(Surface::Pty(command))
    }
}

/// Puts the session's id in the agent's environment when it is known.
fn name_session(command: &mut CommandBuilder, ctx: &LaunchCtx) {
    if let Some(session) = ctx.session {
        command.env(SESSION_VAR, session);
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
        // The prompt comes after `--`: it is the agent's text, whatever it
        // starts with, and never one of the agent's flags.
        let mut args = vec!["--session-id", session];
        if let Some(prompt) = ctx.prompt {
            args.extend(["--", prompt]);
        }
        self.command(ctx, &args)
    }

    fn resume(&self, ctx: &LaunchCtx, session: &str) -> Result<Surface, String> {
        self.command(ctx, &["--resume", session])
    }

    fn caps(&self) -> Caps {
        Caps {
            resumable: true,
            titles: true,
            acp: false,
        }
    }
}

/// Codex CLI: a full-screen TUI like Claude Code, run the same way. It
/// mints its own session ids and resumes by `codex resume <id>`.
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

        Ok(Surface::Pty(command))
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
        let args: Vec<&str> = match ctx.prompt {
            Some(prompt) => vec!["--", prompt],
            None => Vec::new(),
        };
        self.command(ctx, &args)
    }

    fn resume(&self, ctx: &LaunchCtx, session: &str) -> Result<Surface, String> {
        self.command(ctx, &["resume", session])
    }

    fn caps(&self) -> Caps {
        Caps {
            resumable: true,
            titles: true,
            acp: false,
        }
    }

    fn mints_id(&self) -> bool {
        false
    }
}

static CLAUDE_CODE: ClaudeCode = ClaudeCode;
static CODEX: Codex = Codex;

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

    fn vars_with_path(dir: &Path) -> HashMap<String, String> {
        HashMap::from([("PATH".to_string(), dir.to_string_lossy().to_string())])
    }

    fn fake_claude(dir_name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(dir_name);
        std::fs::create_dir_all(&dir).unwrap();
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
        assert!(ClaudeCode.mints_id());
        assert!(!Codex.mints_id());

        let dir = std::env::temp_dir().join("workbench-adapter-codex");
        std::fs::create_dir_all(&dir).unwrap();
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
            session: None,
            prompt: None,
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
        let dir = std::env::temp_dir().join("workbench-adapter-prompt");
        std::fs::create_dir_all(&dir).unwrap();
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
            session: Some("abc"),
            prompt: Some("--dangerously-skip-permissions and fix it"),
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
        assert_eq!(&claude[1..], ["--session-id", "abc", "--", "--dangerously-skip-permissions and fix it"]);
        let codex = argv(Codex.launch(&ctx, "").unwrap());
        assert_eq!(&codex[1..], ["--", "--dangerously-skip-permissions and fix it"]);
    }

    #[test]
    fn finds_the_binary_on_the_given_path() {
        let dir = fake_claude("workbench-adapter-detect");
        let vars = vars_with_path(&dir);
        assert_eq!(ClaudeCode.detect(&vars), Some(dir.join("claude")));
    }

    #[test]
    fn detects_nothing_when_the_path_does_not_hold_it() {
        let vars = HashMap::from([("PATH".to_string(), "/nowhere".to_string())]);
        assert_eq!(ClaudeCode.detect(&vars), None);
    }

    #[test]
    fn names_the_session_to_the_agent_when_it_is_known() {
        let dir = fake_claude("workbench-adapter-session");
        let vars = vars_with_path(&dir);
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            session: Some("abc-123"),
            prompt: None,
        };
        let Surface::Pty(command) = ClaudeCode.launch(&ctx, "abc-123").unwrap();
        assert_eq!(
            command
                .get_env(SESSION_VAR)
                .map(|v| v.to_string_lossy().to_string()),
            Some("abc-123".to_string())
        );
        let unnamed = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            session: None,
            prompt: None,
        };
        let Surface::Pty(command) = ClaudeCode.launch(&unnamed, "").unwrap();
        assert!(command.get_env(SESSION_VAR).is_none());
    }

    #[test]
    fn launching_without_the_binary_explains_itself() {
        let vars = HashMap::from([("PATH".to_string(), "/nowhere".to_string())]);
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            session: None,
            prompt: None,
        };
        let error = ClaudeCode.launch(&ctx, "id").unwrap_err();
        assert!(error.contains("claude"), "names the binary: {error}");
        assert!(error.contains("PATH"), "names the cause: {error}");
    }

    #[test]
    fn launch_builds_a_pty_surface() {
        let dir = fake_claude("workbench-adapter-launch");
        let vars = vars_with_path(&dir);
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            session: None,
            prompt: None,
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
        let dir = fake_claude("workbench-adapter-resume");
        let vars = vars_with_path(&dir);
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            session: None,
            prompt: None,
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
        let dir = fake_claude("workbench-adapter-markers");
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
            session: None,
            prompt: None,
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
        let dir = fake_claude("workbench-adapter-config");
        let mut vars = vars_with_path(&dir);
        vars.insert("CLAUDE_CODE_USE_BEDROCK".to_string(), "1".to_string());
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            session: None,
            prompt: None,
        };

        let Surface::Pty(command) = ClaudeCode.launch(&ctx, "id").unwrap();
        assert_eq!(
            command.get_env("CLAUDE_CODE_USE_BEDROCK"),
            Some("1".as_ref())
        );
    }

    #[test]
    fn carries_the_captured_environment_into_the_command() {
        let dir = fake_claude("workbench-adapter-env");
        let mut vars = vars_with_path(&dir);
        vars.insert("NVM_BIN".to_string(), "/home/ada/.nvm/bin".to_string());
        let ctx = LaunchCtx {
            project: Path::new("/tmp"),
            env: &vars,
            session: None,
            prompt: None,
        };

        let Surface::Pty(command) = ClaudeCode.launch(&ctx, "id").unwrap();
        assert_eq!(
            command.get_env("NVM_BIN"),
            Some("/home/ada/.nvm/bin".as_ref())
        );
    }
}
