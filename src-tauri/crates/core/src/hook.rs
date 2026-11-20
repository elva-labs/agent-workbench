//! Optional hooks, so the panes hear from the agent rather than guess.
//!
//! Two kinds. A `PostToolUse` hook, so the changes pane hears the moment a
//! tool changed a file; and session hooks, `UserPromptSubmit`, `Stop` and
//! the permission prompt, appended to a log the core tails, so a row says
//! exactly when its agent started, stopped, or asked for permission rather
//! than reading that off the pty. Beside the session hook on the prompt,
//! where there is a daemon, a second one asks the window through it what
//! the sessions this one started did, and gives the agent the answer with
//! the user's message. Both agents take the same shape: Claude Code in the
//! project's `.claude/settings.local.json`, Codex in the project's
//! `.codex/hooks.json`, with the same events and the same stdin.
//!
//! The watcher already works, and this does not replace it: a person editing
//! in another editor still has to show up. What the hook adds is immediacy and
//! provenance. Hooks receive the tool's input on stdin, which makes this a
//! supported integration point rather than a scrape.
//!
//! It writes to the workbench's own file, never into the project, and it goes
//! in `.claude/settings.local.json` because that is the untracked one. Nobody
//! should find this in a diff they did not ask for.
//!
//! The file holds the latest event only, overwritten each time. Nothing reads
//! it back yet beyond the watcher noticing it moved, so a growing log would be
//! a growing log of nothing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::account::{self, Dirs};
use crate::adapter::{
    CODEX_APPROVAL_SETTING, CODEX_APPROVE, CODEX_SERVER_KEY, CODEX_TOOLS, CODEX_TOOL_APPROVAL,
    SERVER_NAME,
};
use crate::mcp::RUN_UNASKED;

/// Held across each read, change and write of an account's agent state, so
/// two installs, removals or trust writes at the same moment cannot each
/// write back a copy that lacks the other's entry. It is taken where a file
/// is read for a change and released once that file is written, never
/// across a loop over files, so no path takes it twice.
static STATE: Mutex<()> = Mutex::new(());

fn lock_state() -> MutexGuard<'static, ()> {
    STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Only the tools that change files. Reacting to a Read would be noise.
const MATCHER: &str = "Edit|Write|MultiEdit|NotebookEdit";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub installed: bool,
    /// Whether the hooks are installed with something in a form the next
    /// install brings up to date: the project's Codex entry for the server
    /// saying nothing of its tools' approval. They work as they are, so a
    /// project that should have no hooks is still uninstalled.
    pub outdated: bool,
    /// Where the settings file is, whether or not it exists yet.
    pub settings: String,
    pub events: String,
}

/// Where session hooks append: one JSON line per event, the hook's stdin as
/// it came. The core tails it; see `activity.rs`.
pub fn activity_path(home: &Path) -> PathBuf {
    crate::home::dir(home).join(ACTIVITY_FILE)
}

const ACTIVITY_FILE: &str = "sessions.jsonl";
const EVENTS_FILE: &str = "last-tool-use.json";

/// The session events each agent can report, by the agent's own name for
/// them. The permission prompt is the one they spell differently.
const CLAUDE_SESSION_EVENTS: &[&str] = &["UserPromptSubmit", "Stop", "Notification"];

/// The event Claude Code reports a turn an error ended with, a usage limit
/// among them, in place of its stop, and the first version that knows it.
/// A Claude Code older than that reads an event it does not know as a
/// broken settings file and ignores the whole file, the user's own
/// permissions with it, so the entry goes in only where the Claude Code on
/// the machine knows the event. Codex has no such event.
const FAILED_TURN_EVENT: &str = "StopFailure";
const FAILED_TURN_SINCE: (u64, u64, u64) = (2, 1, 78);

/// What `claude --version` was found to say of each binary, by its path,
/// its size and when it last changed, so it is asked once for each.
type Known = Vec<(PathBuf, Option<(u64, std::time::SystemTime)>, bool)>;
static KNOWN: Mutex<Known> = Mutex::new(Vec::new());

/// Whether the Claude Code the environment finds knows the failed-turn
/// event: it says a version of that one's or later. False where none is
/// found, or it says no version, so nothing it cannot read goes in.
fn claude_knows_failed_turns(home: &Path, env: &HashMap<String, String>) -> bool {
    let Some(binary) = crate::env::find_on_path(env, "claude") else {
        return false;
    };
    let stamp = std::fs::metadata(&binary)
        .ok()
        .and_then(|meta| Some((meta.len(), meta.modified().ok()?)));
    let mut known = KNOWN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((_, _, knows)) = known
        .iter()
        .find(|(path, at, _)| path == &binary && at == &stamp)
    {
        return *knows;
    }
    let mut command = crate::adapter::process(&binary, env);
    crate::adapter::prepare_process(&mut command, home, env);
    let knows = command
        .arg("--version")
        .output()
        .ok()
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .split_whitespace()
                .find_map(crate::codex_app_server::numbers)
        })
        .is_some_and(|version| version >= FAILED_TURN_SINCE);
    known.retain(|(path, _, _)| path != &binary);
    known.push((binary, stamp, knows));
    knows
}
const CODEX_SESSION_EVENTS: &[&str] = &["UserPromptSubmit", "Stop", "PermissionRequest"];

pub fn events_path(home: &Path) -> PathBuf {
    crate::home::dir(home).join(EVENTS_FILE)
}

/// Where the daemon lives on a machine, which is also the MCP server the
/// agents are pointed at: on a remote the connection runs it from here,
/// and on the desktop the app puts its own build here when the hooks go
/// in. Without one here there is no server to name, and the hooks alone
/// are installed.
pub fn daemon_path(home: &Path) -> PathBuf {
    crate::home::dir(home).join("bin").join(DAEMON_FILE)
}

/// The daemon's file name on this kind of machine.
pub const DAEMON_FILE: &str = if cfg!(windows) {
    "chord-remote.exe"
} else {
    "chord-remote"
};

pub(crate) fn codex_config_path(project: &Path) -> PathBuf {
    project.join(".codex").join("config.toml")
}

/// The files the hooks write in a folder, as paths inside it.
pub(crate) const CLAUDE_LOCAL: &str = ".claude/settings.local.json";
pub(crate) const CODEX_HOOKS: &str = ".codex/hooks.json";
pub(crate) const CODEX_CONFIG: &str = ".codex/config.toml";
const FILES: [&str; 3] = [CLAUDE_LOCAL, CODEX_HOOKS, CODEX_CONFIG];

/// Where a session that needs the workbench's tools finds the tool server.
#[derive(Debug, PartialEq, Eq)]
pub enum ToolServer {
    /// The agent's own configuration for the directory points at it.
    Configured,
    /// The daemon is here and the agent is not pointed at it, so it is
    /// named on the session's own command line.
    Named(PathBuf),
    /// There is no daemon on this machine to serve the tools.
    Missing,
}

/// Where a session in `dir` finds the tool server: the daemon, when there is
/// one here, named on the command line unless the agent's own configuration
/// for the directory already points at it. `config_dir` is the account's
/// directory for the agent, spelled as the settings spell it, and `env` the
/// environment the agent is started with.
pub fn tool_server(
    home: &Path,
    dir: &Path,
    agent: &str,
    config_dir: Option<&str>,
    env: &HashMap<String, String>,
) -> ToolServer {
    let daemon = daemon_path(home);
    if !daemon.is_file() {
        return ToolServer::Missing;
    }
    let command = daemon.to_string_lossy().to_string();
    let installed = match agent {
        "claude-code" => {
            let key = dunce::canonicalize(dir)
                .unwrap_or_else(|_| dir.to_path_buf())
                .to_string_lossy()
                .to_string();
            read_settings(&account::claude_json(home, config_dir, env))
                .get("projects")
                .and_then(|projects| projects.get(&key))
                .and_then(|project| project.get("mcpServers"))
                .and_then(|servers| servers.get(SERVER_NAME))
                .and_then(|server| server.get("command"))
                .and_then(Value::as_str)
                == Some(command.as_str())
        }
        "codex" => std::fs::read_to_string(codex_config_path(dir))
            .ok()
            .and_then(|text| text.parse::<toml_edit::DocumentMut>().ok())
            .is_some_and(|document| {
                document
                    .get("mcp_servers")
                    .and_then(|servers| servers.get(CODEX_SERVER_KEY))
                    .and_then(|server| server.as_table_like())
                    .is_some_and(|server| runs_daemon(server, &command))
            }),
        _ => true,
    };
    if installed {
        ToolServer::Configured
    } else {
        ToolServer::Named(daemon)
    }
}

pub(crate) fn settings_path(project: &Path) -> PathBuf {
    project.join(".claude").join("settings.local.json")
}

pub(crate) fn codex_hooks_path(project: &Path) -> PathBuf {
    project.join(".codex").join("hooks.json")
}

/// The event at which the agent is told what the sessions it started did,
/// as the user's message goes in.
const PROMPT_EVENT: &str = "UserPromptSubmit";

/// The command the prompt hook runs beside the session hook: the daemon
/// asks the window what the agent is told, and prints it for the agent.
/// It never fails the prompt: a daemon from a version without the
/// command, or one that cannot ask, says nothing and the prompt goes on.
fn reports_command(home: &Path) -> String {
    reports_command_of(&daemon_path(home))
}

fn reports_command_of(daemon: &Path) -> String {
    format!(
        "{daemon} reports 2>/dev/null || true",
        daemon = shell_quote(&bash_path(&daemon.to_string_lossy())),
    )
}

fn reports_entry(home: &Path) -> Value {
    json!({ "hooks": [{ "type": "command", "command": reports_command(home) }] })
}

/// The command a session hook runs: add what the agent said to the log.
fn activity_command(home: &Path) -> String {
    file_command(&activity_path(home), ">>")
}

/// A command that writes what it reads to `file`, making its folder
/// first: `>>` adds to the file, `>` replaces it.
fn file_command(file: &Path, how: &str) -> String {
    format!(
        "mkdir -p {parent} && cat {how} {file}",
        parent = shell_quote(&bash_path(&file.parent().unwrap_or(file).to_string_lossy())),
        file = shell_quote(&bash_path(&file.to_string_lossy())),
    )
}

/// The commands the hooks run, as made for the app's folder `dir` and the
/// daemon at `daemon`: the tool event's, the session events', the prompt's.
pub(crate) fn commands_at(dir: &Path, daemon: &Path) -> [String; 3] {
    [
        file_command(&dir.join(EVENTS_FILE), ">"),
        file_command(&dir.join(ACTIVITY_FILE), ">>"),
        reports_command_of(daemon),
    ]
}

/// The command the hook runs: replace our file with what the agent just did.
/// Claude Code runs hooks through a POSIX shell on every platform, Git Bash
/// on Windows, so the command is the same everywhere and the paths are
/// spelled the way that shell reads them.
fn command(home: &Path) -> String {
    file_command(&events_path(home), ">")
}

/// A path as Git Bash reads it: forward slashes. Elsewhere a path is already
/// that, and a backslash in one is a character, not a separator.
fn bash_path(path: &str) -> String {
    if cfg!(windows) {
        path.replace('\\', "/")
    } else {
        path.to_string()
    }
}

/// Makes sure the file exists, so the watcher has something to attach to
/// before the hook has ever fired.
fn touch_events(home: &Path) -> Result<(), String> {
    for path in [events_path(home), activity_path(home)] {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {parent:?}: {e}"))?;
        }
        if !path.exists() {
            std::fs::write(&path, "").map_err(|e| format!("could not create {path:?}: {e}"))?;
        }
    }
    Ok(())
}

/// Single quotes, with the one escape that needs: a path can contain anything.
fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

pub(crate) fn read_settings(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

/// The file as it is, to change one entry of and write back. A file that
/// is not there is empty; a file that is there and cannot be read as an
/// object is left alone, since writing it back would keep only our entry
/// and lose everything the agent kept in it.
fn read_for_writing(path: &Path) -> Result<Map<String, Value>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => return Err(format!("could not read {}: {error}", path.display())),
    };
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(format!(
            "{} is not a JSON object; leaving it alone",
            path.display()
        )),
        Err(error) => Err(format!(
            "{} is not JSON ({error}); leaving it alone",
            path.display()
        )),
    }
}

/// Whether an entry runs one of the commands given.
fn runs(entry: &Value, commands: &[String]) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|command| commands.iter().any(|own| own == command))
            })
        })
}

pub(crate) fn is_ours(entry: &Value, home: &Path) -> bool {
    runs(
        entry,
        &[command(home), activity_command(home), reports_command(home)],
    )
}

/// Whether an event has an entry that runs this command.
fn has_command(settings: &Map<String, Value>, event: &str, command: &str) -> bool {
    let commands = [command.to_string()];
    settings
        .get("hooks")
        .and_then(|hooks| hooks.get(event))
        .and_then(Value::as_array)
        .is_some_and(|entries| entries.iter().any(|entry| runs(entry, &commands)))
}

/// Adds our entry under an event, leaving whatever else is there alone. An
/// event holds each of our commands once, and may hold more than one of
/// them.
fn add_entry(settings: &mut Map<String, Value>, event: &str, entry: Value) -> Result<bool, String> {
    let commands: Vec<String> = entry
        .get("hooks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|hook| hook.get("command").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let hooks = settings
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("the hooks setting is not an object")?;
    let entries = hooks
        .entry(event)
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| format!("the {event} setting is not a list"))?;
    if entries.iter().any(|existing| runs(existing, &commands)) {
        return Ok(false);
    }
    entries.push(entry);
    Ok(true)
}

/// Removes our entries under an event, and the empty scaffolding they leave.
fn remove_entries(settings: &mut Map<String, Value>, event: &str, home: &Path) {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };
    if let Some(entries) = hooks.get_mut(event).and_then(Value::as_array_mut) {
        entries.retain(|entry| !is_ours(entry, home));
        if entries.is_empty() {
            hooks.remove(event);
        }
    }
    if hooks.is_empty() {
        settings.remove("hooks");
    }
}

fn session_entry(home: &Path) -> Value {
    json!({ "hooks": [{ "type": "command", "command": activity_command(home) }] })
}

/// Installed is all of ours in Claude Code's settings. The Codex file is
/// written alongside and not asked about: a project without Codex has none.
pub fn status(
    home: &Path,
    project: &Path,
    accounts: &[Dirs],
    env: &HashMap<String, String>,
) -> HookStatus {
    status_many(home, &[project.to_path_buf()], accounts, env)
        .pop()
        .expect("one answer for one project")
}

/// The status of each project, in the order given. Each account's Claude
/// Code state, which can be large, is read and parsed once for all of
/// them, and only when a project with the hooks in place needs it.
pub fn status_many(
    home: &Path,
    projects: &[PathBuf],
    accounts: &[Dirs],
    env: &HashMap<String, String>,
) -> Vec<HookStatus> {
    for project in projects {
        crate::migrate::project(home, project);
    }
    let daemon_here = daemon_path(home).is_file();
    let failures = claude_knows_failed_turns(home, env);
    let events = events_path(home).to_string_lossy().to_string();
    let mut servers: Option<Vec<Map<String, Value>>> = None;
    projects
        .iter()
        .map(|project| {
            let settings = settings_path(project);
            let read = read_settings(&settings);
            let hooks = has_hooks_in(&read, home, failures);
            // With a daemon here the server and the prompt hook that asks
            // through it are part of what is installed: a project that got
            // the hooks before there was either is brought up to date by the
            // next install.
            let installed = hooks
                && (!daemon_here
                    || has_command(&read, PROMPT_EVENT, &reports_command(home)) && {
                        let states =
                            servers.get_or_insert_with(|| read_servers(home, accounts, env));
                        has_server(states, home, project)
                    });
            HookStatus {
                installed,
                outdated: installed && daemon_here && !codex_current(home, project),
                settings: settings.to_string_lossy().to_string(),
                events: events.clone(),
            }
        })
        .collect()
}

/// Gives a worktree the trust its project has. Both agents ask, the first
/// time they run in a directory, whether its files are to be trusted, and
/// a worktree is the project's own files under another path: what the user
/// said of the project holds for it. Claude Code keeps the answer in its
/// state file, Codex in its own config; each account has its own of both,
/// and each is copied only where the project's says yes. A file that
/// cannot be read is left alone.
pub fn trust_like(
    home: &Path,
    project: &Path,
    worktree: &Path,
    accounts: &[Dirs],
    env: &HashMap<String, String>,
) -> Result<(), String> {
    let canonical = |path: &Path| {
        dunce::canonicalize(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .to_string()
    };
    let (from, to) = (canonical(project), canonical(worktree));
    for claude in account::claude_jsons(home, accounts, env) {
        trust_claude(&claude, &from, &to)?;
    }
    for codex in account::codex_homes(home, accounts, env) {
        trust_codex(&codex.join("config.toml"), &from, &to)?;
    }
    Ok(())
}

fn trust_claude(claude: &Path, from: &str, to: &str) -> Result<(), String> {
    update_settings(claude, |state| {
        let trusted = state
            .get("projects")
            .and_then(|projects| projects.get(from))
            .and_then(|project| project.get("hasTrustDialogAccepted"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if trusted {
            accept_trust(state, to)
        } else {
            Ok(false)
        }
    })
}

/// Sets the record Claude Code's trust question writes for a folder, and
/// says whether it was not set already.
fn accept_trust(state: &mut Map<String, Value>, key: &str) -> Result<bool, String> {
    let entry = state
        .entry("projects")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("Claude's projects state is not an object")?
        .entry(key.to_string())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("Claude's project state is not an object")?;
    if entry.get("hasTrustDialogAccepted") == Some(&Value::Bool(true)) {
        return Ok(false);
    }
    entry.insert("hasTrustDialogAccepted".into(), Value::Bool(true));
    Ok(true)
}

/// The keys Claude Code may file a folder's trust under: the path as given
/// and as resolved, with forward slashes, as it writes them.
fn claude_keys(folder: &Path) -> Vec<String> {
    let mut keys = Vec::new();
    for path in [
        folder.to_path_buf(),
        dunce::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf()),
    ] {
        let key = path.to_string_lossy().replace('\\', "/");
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

/// Whether Claude Code holds a folder as trusted, by the record its own
/// trust question writes in the state file given: the folder's, or that of
/// a folder above it, says yes.
pub fn claude_trusts(state: &Path, folder: &Path) -> bool {
    let read = read_settings(state);
    let Some(projects) = read.get("projects").and_then(Value::as_object) else {
        return false;
    };
    let says_yes = |key: &str| {
        projects
            .get(key)
            .and_then(|project| project.get("hasTrustDialogAccepted"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    claude_keys(folder).iter().any(|key| {
        let mut at = Some(Path::new(key));
        while let Some(path) = at {
            let key = path.to_string_lossy().replace('\\', "/");
            if !key.is_empty() && says_yes(&key) {
                return true;
            }
            at = path.parent();
        }
        false
    })
}

/// Records in the state file given that the user trusts a folder, as
/// Claude Code's own trust question does when the answer is yes.
pub fn claude_trust(state: &Path, folder: &Path) -> Result<(), String> {
    let key = claude_keys(folder)
        .pop()
        .expect("a folder has at least one key");
    update_settings(state, |read| accept_trust(read, &key))
}

/// The keys Codex may file a folder's trust under in its configuration,
/// in the order it looks them up: the path as resolved, then as given.
fn codex_keys(folder: &Path) -> Vec<String> {
    let mut keys = Vec::new();
    for path in [
        dunce::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf()),
        folder.to_path_buf(),
    ] {
        let key = path.to_string_lossy().to_string();
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

/// The most of a git metadata file Codex reads.
const CODEX_GIT_FILE_LIMIT: u64 = 64 * 1024;

/// A git metadata file's text, as Codex reads one: a plain file, not a
/// link, and no larger than its limit.
fn codex_git_file(path: &Path) -> Option<String> {
    let link = std::fs::symlink_metadata(path).ok()?;
    let metadata = std::fs::metadata(path).ok()?;
    if link.file_type().is_symlink() || !metadata.is_file() || metadata.len() > CODEX_GIT_FILE_LIMIT
    {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    (bytes.len() as u64 <= CODEX_GIT_FILE_LIMIT)
        .then(|| String::from_utf8_lossy(&bytes).trim_ascii().to_string())
        .filter(|text| !text.is_empty())
}

/// Where a `.git` file points, from the folder it is in.
fn codex_gitdir(dot_git: &Path) -> Option<PathBuf> {
    let text = codex_git_file(dot_git)?;
    let target = text.strip_prefix("gitdir:")?.trim_ascii();
    if target.is_empty() {
        return None;
    }
    Some(lexical(&dot_git.parent()?.join(target)))
}

/// A path with its `.` and `..` parts worked out by name alone.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !out.pop() {
                    out.push(part);
                }
            }
            _ => out.push(part),
        }
    }
    out
}

/// The repository root Codex takes a folder's trust from when the folder
/// has no record of its own, or None, by Codex's own rule:
///
/// - The checkout is the nearest folder, the given one or above, with a
///   `.git`; a `.git` folder with no `HEAD` in it is passed over.
/// - A checkout with a `.git` folder is its own root.
/// - A checkout with a `.git` file is a root only through a linked
///   worktree: its git directory is in a `worktrees` folder of a common
///   directory, records this checkout and that common directory, and the
///   folder holding the common directory has a `.git` that leads to it.
///   That folder is the root. A checkout whose git directory is kept
///   elsewhere, a submodule among them, has none.
fn codex_repository_root(folder: &Path) -> Option<PathBuf> {
    let canonical = |path: &Path| dunce::canonicalize(path).ok();
    let mut from = if folder.is_dir() {
        folder
    } else {
        folder.parent()?
    };
    let checkout = loop {
        let found = from.ancestors().find(|at| at.join(".git").exists())?;
        let dot_git = found.join(".git");
        if !dot_git.is_dir() || dot_git.join("HEAD").exists() {
            break found;
        }
        from = found.parent()?;
    };
    let dot_git = checkout.join(".git");
    if dot_git.is_dir() {
        return Some(checkout.to_path_buf());
    }
    let git_dir = codex_gitdir(&dot_git)?;
    if !std::fs::metadata(&git_dir).ok()?.is_dir()
        || std::fs::symlink_metadata(&git_dir)
            .ok()?
            .file_type()
            .is_symlink()
    {
        return None;
    }
    let resolved = canonical(&git_dir)?;
    let worktrees = resolved.parent()?;
    if worktrees.file_name()? != "worktrees" {
        return None;
    }
    let common = worktrees.parent()?;
    let registered = lexical(&resolved.join(codex_git_file(&resolved.join("gitdir"))?));
    if registered.file_name()? != ".git" {
        return None;
    }
    let linked = resolved.join(codex_git_file(&resolved.join("commondir"))?);
    if canonical(registered.parent()?)? != canonical(checkout)?
        || canonical(&linked)?.as_path() != common
    {
        return None;
    }
    let root = git_dir.parent()?.parent()?.parent()?;
    let main = root.join(".git");
    let main_git_dir = if main.is_dir() {
        main
    } else {
        codex_gitdir(&main)?
    };
    (canonical(&main_git_dir)?.as_path() == common).then(|| root.to_path_buf())
}

/// Whether Codex holds a folder as trusted, by the records its own trust
/// question writes in the configuration given. The folder's own record
/// decides when there is one, whatever it says; else the record of the
/// repository it is in, as [`codex_repository_root`] finds it. A folder
/// between the two counts for nothing, and only a `trust_level` of
/// `trusted` is a yes.
pub fn codex_trusts(config: &Path, folder: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(config) else {
        return false;
    };
    let Ok(document) = text.parse::<toml_edit::DocumentMut>() else {
        return false;
    };
    let Some(projects) = document.get("projects").and_then(|p| p.as_table_like()) else {
        return false;
    };
    let record = |folder: &Path| {
        codex_keys(folder)
            .iter()
            .find_map(|key| projects.get(key))
            .map(|project| {
                project.get("trust_level").and_then(|level| level.as_str()) == Some("trusted")
            })
    };
    if let Some(trusted) = record(folder) {
        return trusted;
    }
    codex_repository_root(folder)
        .and_then(|root| record(&root))
        .unwrap_or(false)
}

/// Records in the configuration given that the user trusts a folder, as
/// Codex's own trust question does when the answer is yes. Everything
/// else in the file is kept as it was written; a file that cannot be read
/// is left alone.
pub fn codex_trust(config: &Path, folder: &Path) -> Result<(), String> {
    let key = codex_keys(folder).remove(0);
    let _state = lock_state();
    let text = match std::fs::read_to_string(config) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("could not read {}: {error}", config.display())),
    };
    let mut document = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("{} is not TOML ({e}); leaving it alone", config.display()))?;
    let projects = document["projects"].or_insert(toml_edit::Item::Table(toml_edit::Table::new()));
    let Some(projects) = projects.as_table_like_mut() else {
        return Err(format!(
            "projects in {} is not a table; leaving it alone",
            config.display()
        ));
    };
    if projects
        .get(&key)
        .and_then(|project| project.get("trust_level"))
        .and_then(|level| level.as_str())
        == Some("trusted")
    {
        return Ok(());
    }
    match projects.get_mut(&key).and_then(|p| p.as_table_like_mut()) {
        Some(project) => {
            project.insert("trust_level", toml_edit::value("trusted"));
        }
        None => {
            let mut table = toml_edit::Table::new();
            table["trust_level"] = toml_edit::value("trusted");
            projects.insert(&key, toml_edit::Item::Table(table));
        }
    }
    write_whole(config, &document.to_string())
}

fn trust_codex(codex: &Path, from: &str, to: &str) -> Result<(), String> {
    let _state = lock_state();
    let Ok(text) = std::fs::read_to_string(codex) else {
        return Ok(());
    };
    let mut document = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("could not read {}: {e}", codex.display()))?;
    let level = document
        .get("projects")
        .and_then(|projects| projects.get(from))
        .and_then(|project| project.get("trust_level"))
        .and_then(|level| level.as_str())
        .map(str::to_string);
    if level.as_deref() == Some("trusted") {
        let projects =
            document["projects"].or_insert(toml_edit::Item::Table(toml_edit::Table::new()));
        let already = projects
            .get(to)
            .and_then(|project| project.get("trust_level"))
            .and_then(|level| level.as_str())
            == Some("trusted");
        if !already {
            let mut table = toml_edit::Table::new();
            table["trust_level"] = toml_edit::value("trusted");
            projects[to] = toml_edit::Item::Table(table);
            std::fs::write(codex, document.to_string())
                .map_err(|e| format!("could not write {}: {e}", codex.display()))?;
        }
    }
    Ok(())
}

/// Adds the hooks, leaving every other setting and every other hook alone.
/// The server goes into every account's Claude Code state, so a session
/// under any of them has the tools. The worktrees the workbench made for
/// the project get the same, as [`share`] gives them; one whose files
/// cannot be read is left as it is, and the project's own answer stands.
/// Each account's state is read and written once, however many worktrees
/// there are, and loses the server of any worktree of the project's that
/// git no longer lists or whose folder is gone.
pub fn install(
    home: &Path,
    project: &Path,
    accounts: &[Dirs],
    env: &HashMap<String, String>,
) -> Result<HookStatus, String> {
    let failures = claude_knows_failed_turns(home, env);
    crate::migrate::project(home, project);
    add_hooks(home, project, &[], failures)?;
    let listed = sharing(project);
    let mut trees = Vec::new();
    for tree in &listed {
        crate::migrate::project(home, tree);
        let leave = tracked(tree);
        if add_hooks(home, tree, &leave, failures).is_ok() {
            trees.push((tree.clone(), leave));
        }
    }
    touch_events(home)?;

    let live: Vec<String> = listed.iter().map(|tree| state_key(tree)).collect();
    let bases = worktree_bases(project);
    let gone = |key: &str| under(&bases, key) && !live.iter().any(|tree| tree == key);
    if daemon_path(home).is_file() {
        let mut folders = vec![project.to_path_buf()];
        folders.extend(trees.iter().map(|(tree, _)| tree.clone()));
        claude_servers(home, accounts, env, &folders, gone)?;
        point_codex(home, project)?;
        for (tree, leave) in &trees {
            if !leave.contains(&CODEX_CONFIG) {
                let _ = point_codex(home, tree);
            }
        }
    } else {
        claude_servers(home, accounts, env, &[], gone)?;
    }
    exclude_from_git(project);
    Ok(status(home, project, accounts, env))
}

/// Whether the project has the hooks in its own settings, whatever else is
/// or is not in place, the failed-turn hook among them.
fn has_hooks(home: &Path, project: &Path) -> bool {
    has_hooks_in(&read_settings(&settings_path(project)), home, false)
}

/// Whether the workbench hears a turn of this agent's end in a terminal in
/// this folder: the agent's own hooks there write the stop to the session
/// log, which is how the window learns a turn ended.
pub fn hears_turns(home: &Path, folder: &Path, agent: &str) -> bool {
    let settings = match agent {
        "codex" => codex_hooks_path(folder),
        _ => settings_path(folder),
    };
    has_command(&read_settings(&settings), "Stop", &activity_command(home))
}

/// Whether Claude Code's settings hold the tool hook and every session
/// hook, and the failed-turn hook where `failures` says the Claude Code on
/// the machine knows it.
fn has_hooks_in(settings: &Map<String, Value>, home: &Path, failures: bool) -> bool {
    has_command(settings, "PostToolUse", &command(home))
        && CLAUDE_SESSION_EVENTS
            .iter()
            .all(|event| has_command(settings, event, &activity_command(home)))
        && (!failures || has_command(settings, FAILED_TURN_EVENT, &activity_command(home)))
}

/// Gives a worktree of the project the hooks the project has, and says
/// whether it did. A worktree is a checkout of its own, and the agents read
/// their local settings from the directory they run in, so the project's
/// do not reach a session there. Nothing is written when the project has
/// no hooks, when the folder is not one of the project's worktrees that is
/// still there, or when the project does not share with its worktrees, as
/// [`sharing`] says. None of the files is written where the worktree's
/// checkout tracks it, so the worktree shows no change, and a worktree that
/// has them all is left as it is.
pub fn share(
    home: &Path,
    project: &Path,
    worktree: &Path,
    accounts: &[Dirs],
    env: &HashMap<String, String>,
) -> Result<bool, String> {
    if !has_hooks(home, project) || !shares_with(project, worktree) {
        return Ok(false);
    }
    crate::migrate::project(home, worktree);
    let leave = tracked(worktree);
    add_hooks(home, worktree, &leave, claude_knows_failed_turns(home, env))?;
    touch_events(home)?;
    if daemon_path(home).is_file() {
        claude_servers(home, accounts, env, &[worktree.to_path_buf()], |_| false)?;
        if !leave.contains(&CODEX_CONFIG) {
            point_codex(home, worktree)?;
        }
    }
    exclude_from_git(project);
    Ok(true)
}

/// Takes out of the agents' own state what [`share`] put there for a
/// worktree that is gone: the server Claude Code was pointed at for it. Its
/// own files went with it.
pub fn forget(
    home: &Path,
    worktree: &Path,
    accounts: &[Dirs],
    env: &HashMap<String, String>,
) -> Result<(), String> {
    let key = state_key(worktree);
    claude_servers(home, accounts, env, &[], |other| other == key)
}

/// The worktrees the workbench made for the project that it shares its
/// hooks with: those git lists that are still a checkout, a folder with its
/// `.git`, so a folder the user deleted is never made again. A project that
/// is a folder inside its repository shares with none. Its worktrees are
/// checkouts of the whole repository, with the agent run at their top
/// rather than in the project's folder, and files written there could be
/// kept out of git's view only by lines that every checkout of the
/// repository reads, the user's main one included.
fn sharing(project: &Path) -> Vec<PathBuf> {
    if !at_top(project) {
        return Vec::new();
    }
    crate::git::worktree_paths(project)
        .unwrap_or_default()
        .into_iter()
        .filter(|tree| standing(tree))
        .collect()
}

/// Whether a folder is one of the worktrees [`sharing`] gives the project's
/// hooks to, asked of the folder alone, without listing them.
fn shares_with(project: &Path, tree: &Path) -> bool {
    let tree = canonical(tree);
    standing(&tree)
        && worktree_bases(project)
            .iter()
            .any(|base| tree.parent() == Some(base.as_path()))
        && at_top(project)
}

/// Whether a worktree's folder is there with the `.git` that makes it a
/// checkout.
fn standing(tree: &Path) -> bool {
    tree.join(".git").exists()
}

/// Whether a folder is the top of its repository's checkout.
fn at_top(project: &Path) -> bool {
    let Ok(repo) = git2::Repository::discover(project) else {
        return false;
    };
    repo.workdir()
        .is_some_and(|workdir| canonical(workdir) == canonical(project))
}

/// The folder the project's worktrees are made in, as given and resolved.
fn worktree_bases(project: &Path) -> Vec<PathBuf> {
    let mut bases = vec![canonical(&project.join(crate::git::WORKTREES))];
    let resolved = canonical(project).join(crate::git::WORKTREES);
    if !bases.contains(&resolved) {
        bases.push(resolved);
    }
    bases
}

/// Whether a key of Claude Code's per-project state is a folder inside one
/// of `bases`.
fn under(bases: &[PathBuf], key: &str) -> bool {
    let key = Path::new(key);
    bases
        .iter()
        .any(|base| key != base && key.starts_with(base))
}

fn canonical(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The key Claude Code files a folder's state under: its resolved path.
fn state_key(folder: &Path) -> String {
    canonical(folder).to_string_lossy().to_string()
}

/// Which of the files the hooks write the checkout a folder is in tracks.
/// Those are the checkout's own, and writing into one would show as a
/// change to it.
fn tracked(folder: &Path) -> Vec<&'static str> {
    tracked_of(folder, &FILES)
}

/// Which of `files`, as paths inside a folder, the checkout the folder is
/// in tracks.
pub(crate) fn tracked_of<'a>(folder: &Path, files: &[&'a str]) -> Vec<&'a str> {
    let Ok(repo) = git2::Repository::discover(folder) else {
        return Vec::new();
    };
    let (Some(workdir), Ok(index)) = (repo.workdir(), repo.index()) else {
        return Vec::new();
    };
    let workdir = canonical(workdir);
    let folder = canonical(folder);
    let Ok(inside) = folder.strip_prefix(&workdir) else {
        return Vec::new();
    };
    files
        .iter()
        .copied()
        .filter(|file| index.get_path(&inside.join(file), 0).is_some())
        .collect()
}

/// Adds the hooks to the agents' settings files in a folder, all but those
/// named in `leave`, which are not read or written. The prompt hook that
/// asks through the daemon goes in only where there is a daemon, and the
/// failed-turn hook only where `failures` says Claude Code knows it.
fn add_hooks(home: &Path, folder: &Path, leave: &[&str], failures: bool) -> Result<(), String> {
    let asks = daemon_path(home).is_file();
    if !leave.contains(&CLAUDE_LOCAL) {
        let path = settings_path(folder);
        let mut settings = read_for_writing(&path)?;
        let mut changed = add_entry(
            &mut settings,
            "PostToolUse",
            json!({
                "matcher": MATCHER,
                "hooks": [{ "type": "command", "command": command(home) }],
            }),
        )?;
        for event in CLAUDE_SESSION_EVENTS {
            changed |= add_entry(&mut settings, event, session_entry(home))?;
        }
        if failures {
            changed |= add_entry(&mut settings, FAILED_TURN_EVENT, session_entry(home))?;
        }
        if asks {
            changed |= add_entry(&mut settings, PROMPT_EVENT, reports_entry(home))?;
        }
        if changed {
            write_settings(&path, &settings)?;
        }
    }

    if !leave.contains(&CODEX_HOOKS) {
        let codex = codex_hooks_path(folder);
        let mut hooks = read_for_writing(&codex)?;
        let mut changed = false;
        for event in CODEX_SESSION_EVENTS {
            changed |= add_entry(&mut hooks, event, session_entry(home))?;
        }
        if asks {
            changed |= add_entry(&mut hooks, PROMPT_EVENT, reports_entry(home))?;
        }
        if changed {
            write_settings(&codex, &hooks)?;
        }
    }
    Ok(())
}

/// The `projects` of each account's Claude Code state, in the order of the
/// accounts, each file read and parsed once.
fn read_servers(
    home: &Path,
    accounts: &[Dirs],
    env: &HashMap<String, String>,
) -> Vec<Map<String, Value>> {
    account::claude_jsons(home, accounts, env)
        .iter()
        .map(|claude| {
            #[cfg(test)]
            tests::STATE_READS.with(|reads| reads.set(reads.get() + 1));
            match read_settings(claude).remove("projects") {
                Some(Value::Object(projects)) => projects,
                _ => Map::new(),
            }
        })
        .collect()
}

/// Whether every account's state points Claude Code at the daemon here for
/// the project.
fn has_server(states: &[Map<String, Value>], home: &Path, project: &Path) -> bool {
    let key = dunce::canonicalize(project)
        .unwrap_or_else(|_| project.to_path_buf())
        .to_string_lossy()
        .to_string();
    let daemon = daemon_path(home).to_string_lossy().to_string();
    states.iter().all(|projects| {
        projects
            .get(&key)
            .and_then(|project| project.get("mcpServers"))
            .and_then(|servers| servers.get(SERVER_NAME))
            .and_then(|server| server.get("command"))
            .and_then(Value::as_str)
            == Some(daemon.as_str())
    })
}

/// Changes where every account's Claude Code state points Claude Code at
/// the daemon: at it for each folder in `add`, and no longer for each other
/// folder whose key `drop` picks. Each state file is read and written once,
/// however many folders there are, and one that is not there is made only
/// to add to.
fn claude_servers(
    home: &Path,
    accounts: &[Dirs],
    env: &HashMap<String, String>,
    add: &[PathBuf],
    drop: impl Fn(&str) -> bool,
) -> Result<(), String> {
    let daemon = daemon_path(home).to_string_lossy().to_string();
    let entry = json!({ "type": "stdio", "command": daemon, "args": ["mcp"] });
    let add: Vec<String> = add.iter().map(|folder| state_key(folder)).collect();
    for claude in account::claude_jsons(home, accounts, env) {
        if add.is_empty() && !claude.exists() {
            continue;
        }
        update_settings(&claude, |state| {
            let mut changed = false;
            if let Some(projects) = state.get_mut("projects").and_then(Value::as_object_mut) {
                for (key, project) in projects.iter_mut() {
                    if add.contains(key) || !drop(key) {
                        continue;
                    }
                    changed |= project
                        .get_mut("mcpServers")
                        .and_then(Value::as_object_mut)
                        .is_some_and(|servers| servers.remove(SERVER_NAME).is_some());
                }
            }
            for key in &add {
                let servers = state
                    .entry("projects")
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
                    .ok_or("Claude's projects state is not an object")?
                    .entry(key.clone())
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
                    .ok_or("Claude's project state is not an object")?
                    .entry("mcpServers")
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
                    .ok_or("Claude's mcpServers state is not an object")?;
                if servers.get(SERVER_NAME) != Some(&entry) {
                    servers.insert(SERVER_NAME.into(), entry.clone());
                    changed = true;
                }
            }
            Ok(changed)
        })?;
    }
    Ok(())
}

/// Whether a server's entry in a Codex config is the daemon's, by its
/// command.
fn runs_daemon(server: &dyn toml_edit::TableLike, daemon: &str) -> bool {
    server.get("command").and_then(|command| command.as_str()) == Some(daemon)
}

/// A Codex config's text as TOML, past a byte order mark.
pub(crate) fn parse_codex(text: &str) -> Result<toml_edit::DocumentMut, String> {
    text.strip_prefix('\u{feff}')
        .unwrap_or(text)
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| e.to_string())
}

/// A Codex config written back as the user's file was: with its byte
/// order mark, and with a carriage return before each line feed where
/// every line of it had one. The parser writes a bare line feed.
pub(crate) fn as_the_file_was(file: &str, text: String) -> String {
    let crlf = file.contains("\r\n") && !file.replace("\r\n", "").contains('\n');
    let text = if crlf {
        text.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        text
    };
    if file.starts_with('\u{feff}') {
        format!("\u{feff}{text}")
    } else {
        text
    }
}

/// What the hooks make of a folder's Codex config.
struct Pointed {
    /// Whether it already had an entry for the daemon.
    had_entry: bool,
    /// Its text with the entry as the hooks write it, or None where it has
    /// that already.
    text: Option<String>,
}

/// A table holding a tool's approval to run without asking, made in the
/// form of the table of tools it goes into: inline in an inline one, as
/// dotted keys where its siblings are written so or under a header of the
/// table's own, and under a header of its own beside headers.
fn approving(tools: &toml_edit::Item) -> toml_edit::Item {
    if tools.is_inline_table() {
        let mut one = toml_edit::InlineTable::new();
        one.set_dotted(true);
        one.insert(CODEX_TOOL_APPROVAL, toml_edit::Value::from(CODEX_APPROVE));
        return toml_edit::Item::Value(toml_edit::Value::InlineTable(one));
    }
    let mut one = toml_edit::Table::new();
    one.set_dotted(
        tools
            .as_table()
            .is_none_or(|table| table.is_dotted() || !table.is_implicit()),
    );
    one[CODEX_TOOL_APPROVAL] = toml_edit::value(CODEX_APPROVE);
    toml_edit::Item::Table(one)
}

/// Gives the workbench's entry the approvals the hooks write: each tool
/// of [`RUN_UNASKED`] that has no approval of its own is given one to run
/// without asking, and the hooks write none for the whole server, so every
/// other tool asks as the user's approval policy says. An approval for the
/// whole server is the user's own, of whatever value, and the entry is then
/// left as it is; so is an approval a tool already has. Says whether
/// anything changed, or that the entry cannot take them.
fn approve_tools(server: &mut toml_edit::Item) -> Result<bool, String> {
    let inline = server.is_inline_table();
    let entry = server
        .as_table_like_mut()
        .ok_or("the server's entry is not a table")?;
    if entry.contains_key(CODEX_APPROVAL_SETTING) {
        return Ok(false);
    }
    let mut changed = false;
    if !entry.contains_key(CODEX_TOOLS) {
        let tools = if inline {
            let mut tools = toml_edit::InlineTable::new();
            tools.set_dotted(true);
            toml_edit::Item::Value(toml_edit::Value::InlineTable(tools))
        } else {
            let mut tools = toml_edit::Table::new();
            tools.set_dotted(true);
            toml_edit::Item::Table(tools)
        };
        entry.insert(CODEX_TOOLS, tools);
    }
    let tools = entry
        .get_mut(CODEX_TOOLS)
        .ok_or("the server's tools are not a table")?;
    let one = approving(tools);
    let tools = tools
        .as_table_like_mut()
        .ok_or("the server's tools are not a table")?;
    for tool in RUN_UNASKED {
        match tools.get_mut(tool) {
            Some(item) => {
                let own = item
                    .as_table_like_mut()
                    .ok_or_else(|| format!("the server's tool {tool} is not a table"))?;
                if !own.contains_key(CODEX_TOOL_APPROVAL) {
                    own.insert(CODEX_TOOL_APPROVAL, toml_edit::value(CODEX_APPROVE));
                    changed = true;
                }
            }
            None => {
                tools.insert(tool, one.clone());
                changed = true;
            }
        }
    }
    // An inline entry is spaced afresh so what was added sits as the rest
    // does. Only the spaces between its keys and values move; a comment
    // inside an array in it stays where it is.
    if changed {
        if let Some(inline) = server.as_inline_table_mut() {
            inline.fmt();
        }
    }
    Ok(changed)
}

/// A Codex config's text with the daemon's entry as the hooks write it:
/// the entry is made where there is none, and an entry for the daemon is
/// given the approvals [`approve_tools`] says and keeps the rest of what
/// it says. Everything else in the file stays as it was, and an error
/// says it cannot be written to: it is not TOML, or its servers, the
/// entry or its tools are not tables.
fn pointed(daemon: &str, file: &str) -> Result<Pointed, String> {
    let mut document = parse_codex(file)?;
    // A table of servers the hooks make holds only their entry, and is
    // written as the entry's header alone; one the user wrote keeps its
    // own header and whatever is said above it.
    let made = !document.contains_key("mcp_servers");
    let servers = document
        .entry("mcp_servers")
        .or_insert(toml_edit::Item::Table(toml_edit::Table::new()));
    if made {
        if let Some(table) = servers.as_table_mut() {
            table.set_implicit(true);
        }
    }
    let inline = servers.is_inline_table();
    let servers = servers
        .as_table_like_mut()
        .ok_or("the mcp_servers setting is not a table")?;
    let ours = servers.get_mut(CODEX_SERVER_KEY).filter(|item| {
        item.as_table_like()
            .is_some_and(|server| runs_daemon(server, daemon))
    });
    let had_entry = ours.is_some();
    match ours {
        Some(server) => {
            if !approve_tools(server)? {
                return Ok(Pointed {
                    had_entry,
                    text: None,
                });
            }
        }
        None => {
            let mut server = toml_edit::Table::new();
            server["command"] = toml_edit::value(daemon);
            let mut args = toml_edit::Array::new();
            args.push("mcp");
            server["args"] = toml_edit::value(args);
            // Servers the user wrote inline take the entry inline too.
            let entry = if inline {
                toml_edit::Item::Value(toml_edit::Value::InlineTable(server.into_inline_table()))
            } else {
                toml_edit::Item::Table(server)
            };
            servers.insert(CODEX_SERVER_KEY, entry);
            let made = servers
                .get_mut(CODEX_SERVER_KEY)
                .ok_or("the server's entry was not made")?;
            approve_tools(made)?;
            // Inline servers are spaced afresh so the entry sits as the
            // others do, as an inline entry is.
            if inline {
                servers.fmt();
            }
        }
    }
    Ok(Pointed {
        had_entry,
        text: Some(as_the_file_was(file, document.to_string())),
    })
}

/// Whether the folder's Codex config is as [`point_codex`] writes it, as
/// far as an entry for the daemon there goes: one that says nothing of its
/// tools' approval is out of date, and the next install adds the setting.
/// A config with no such entry, or one the install could not write to, has
/// nothing of the hooks' to bring up to date.
fn codex_current(home: &Path, folder: &Path) -> bool {
    let daemon = daemon_path(home).to_string_lossy().to_string();
    let Ok(file) = std::fs::read_to_string(codex_config_path(folder)) else {
        return true;
    };
    !matches!(
        pointed(&daemon, &file),
        Ok(Pointed {
            had_entry: true,
            text: Some(_),
        })
    )
}

/// Points Codex at the daemon as an MCP server in the folder's own config,
/// beside its hooks file, as [`pointed`] says.
fn point_codex(home: &Path, folder: &Path) -> Result<(), String> {
    let daemon = daemon_path(home).to_string_lossy().to_string();
    let codex = codex_config_path(folder);
    let file = std::fs::read_to_string(&codex).unwrap_or_default();
    let pointed =
        pointed(&daemon, &file).map_err(|e| format!("could not read {}: {e}", codex.display()))?;
    if let Some(text) = pointed.text {
        if let Some(parent) = codex.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {parent:?}: {e}"))?;
        }
        std::fs::write(&codex, text)
            .map_err(|e| format!("could not write {}: {e}", codex.display()))?;
    }
    Ok(())
}

/// Takes the server out of the folder's Codex config, and a config that
/// held nothing but it goes too. A `[mcp_servers]` header the user wrote
/// stays, with whatever is said above it, though no server is left under
/// it.
fn unpoint_codex(folder: &Path) -> Result<(), String> {
    let codex = codex_config_path(folder);
    if !codex.exists() {
        return Ok(());
    }
    let file = std::fs::read_to_string(&codex).unwrap_or_default();
    let mut document =
        parse_codex(&file).map_err(|e| format!("could not read {}: {e}", codex.display()))?;
    let mut changed = false;
    if let Some(item) = document.get_mut("mcp_servers") {
        let written = item
            .as_table()
            .is_some_and(|table| !table.is_implicit() && !table.is_dotted());
        if let Some(servers) = item.as_table_like_mut() {
            changed = servers.remove(CODEX_SERVER_KEY).is_some();
            if servers.is_empty() && !written {
                document.remove("mcp_servers");
            }
        }
    }
    if changed {
        if document.as_table().is_empty() {
            std::fs::remove_file(&codex).map_err(|e| format!("could not remove {codex:?}: {e}"))?;
        } else {
            std::fs::write(&codex, as_the_file_was(&file, document.to_string()))
                .map_err(|e| format!("could not write {}: {e}", codex.display()))?;
        }
    }
    Ok(())
}

/// The two files, kept out of the repository's diffs and untracked list by
/// its own exclude file, the one that is never committed. Claude Code does
/// this for its local settings when it writes them first; here the app may
/// be first, and Codex does not do it at all. A project outside any
/// repository has nothing to exclude from.
fn exclude_from_git(project: &Path) {
    let Ok(repo) = git2::Repository::discover(project) else {
        return;
    };
    let Some(workdir) = repo.workdir() else {
        return;
    };
    let project = dunce::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    let workdir = dunce::canonicalize(workdir).unwrap_or_else(|_| workdir.to_path_buf());
    let Ok(inside) = project.strip_prefix(&workdir) else {
        return;
    };
    let exclude = repo.commondir().join("info").join("exclude");
    let mut text = std::fs::read_to_string(&exclude).unwrap_or_default();
    let before = text.len();
    for file in FILES {
        let line = format!(
            "/{}",
            inside.join(file).to_string_lossy().replace('\\', "/")
        );
        if text.lines().any(|existing| existing.trim() == line) {
            continue;
        }
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&line);
        text.push('\n');
    }
    if text.len() != before {
        if let Some(dir) = exclude.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&exclude, text);
    }
}

/// Removes only our entries. Anything else in the files stays, and a Codex
/// file that held nothing but ours goes with them. The worktrees the
/// project shares its hooks with lose theirs too; one whose files cannot
/// be read keeps what is in them. Each account's state is read and written
/// once, and loses the server of the project and of every folder in its
/// worktrees' folder, listed by git or not.
pub fn uninstall(
    home: &Path,
    project: &Path,
    accounts: &[Dirs],
    env: &HashMap<String, String>,
) -> Result<HookStatus, String> {
    remove_hooks(home, project, &[])?;
    let mut trees = Vec::new();
    for tree in sharing(project) {
        let leave = tracked(&tree);
        if remove_hooks(home, &tree, &leave).is_ok() {
            trees.push((tree, leave));
        }
    }
    let own = state_key(project);
    let bases = worktree_bases(project);
    claude_servers(home, accounts, env, &[], |key| {
        key == own || under(&bases, key)
    })?;
    unpoint_codex(project)?;
    for (tree, leave) in &trees {
        if !leave.contains(&CODEX_CONFIG) {
            let _ = unpoint_codex(tree);
        }
    }
    Ok(status(home, project, accounts, env))
}

/// Removes our entries from the agents' settings files in a folder, all
/// but those named in `leave`, which are not read or written.
fn remove_hooks(home: &Path, folder: &Path, leave: &[&str]) -> Result<(), String> {
    let path = settings_path(folder);
    if path.exists() && !leave.contains(&CLAUDE_LOCAL) {
        let mut settings = read_for_writing(&path)?;
        for event in ["PostToolUse", FAILED_TURN_EVENT]
            .iter()
            .chain(CLAUDE_SESSION_EVENTS)
        {
            remove_entries(&mut settings, event, home);
        }
        write_settings(&path, &settings)?;
    }

    let codex = codex_hooks_path(folder);
    if codex.exists() && !leave.contains(&CODEX_HOOKS) {
        let mut hooks = read_for_writing(&codex)?;
        for event in CODEX_SESSION_EVENTS {
            remove_entries(&mut hooks, event, home);
        }
        if hooks.is_empty() {
            std::fs::remove_file(&codex).map_err(|e| format!("could not remove {codex:?}: {e}"))?;
        } else {
            write_settings(&codex, &hooks)?;
        }
    }
    Ok(())
}

/// Changes an account's agent state, a JSON file that the agents' running
/// processes read and rewrite too: the file is read, changed by `change`,
/// which says whether it changed anything, and written back at once. The
/// state lock is held from the read to the write, so no other writer in
/// this process comes between them, and the read comes right before the
/// write so as little as possible of an agent's own work can be lost.
pub(crate) fn update_settings(
    path: &Path,
    change: impl FnOnce(&mut Map<String, Value>) -> Result<bool, String>,
) -> Result<(), String> {
    let _state = lock_state();
    #[cfg(test)]
    tests::STATE_CHANGES.with(|changes| changes.set(changes.get() + 1));
    let mut settings = read_for_writing(path)?;
    if change(&mut settings)? {
        write_settings(path, &settings)?;
    }
    Ok(())
}

/// How old a file of a write's own, beside the file it writes, must be to
/// be taken for one a write cut off by a crash left behind.
const STALE_WRITE: std::time::Duration = std::time::Duration::from_secs(60);

/// The name a write of `name` gives the file it writes first.
fn written_first(name: &str) -> String {
    format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple())
}

/// Removes what writes of `name` left in `parent` when they were cut off
/// between making their own file and moving it over: files named as
/// [`written_first`] names them, and older than [`STALE_WRITE`].
fn remove_stale_writes(parent: &Path, name: &str) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    let prefix = format!(".{name}.");
    for entry in entries.flatten() {
        let file = entry.file_name();
        let Some(id) = file
            .to_str()
            .and_then(|file| file.strip_prefix(&prefix))
            .and_then(|rest| rest.strip_suffix(".tmp"))
        else {
            continue;
        };
        if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > STALE_WRITE);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Writes a JSON file whole, so that a reader never sees it half written:
/// to a file of its own beside it, then moved over it. A link is followed
/// and the file it names is replaced, and the file keeps its permissions.
/// What an earlier write cut off by a crash left beside it goes.
fn write_settings(path: &Path, settings: &Map<String, Value>) -> Result<(), String> {
    let mut text = serde_json::to_string_pretty(&Value::Object(settings.clone()))
        .map_err(|e| format!("could not write settings: {e}"))?;
    text.push('\n');
    write_whole(path, &text)
}

/// Writes a file whole, as [`write_settings`] describes.
pub(crate) fn write_whole(path: &Path, text: &str) -> Result<(), String> {
    let path = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent).map_err(|e| format!("could not create {parent:?}: {e}"))?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    remove_stale_writes(parent, &name);
    let temporary = parent.join(written_first(&name));
    let written = (|| {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        if let Ok(old) = std::fs::metadata(&path) {
            file.set_permissions(old.permissions())?;
        }
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temporary, &path)
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("could not write {}: {e}", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratch::Scratch;

    thread_local! {
        /// How many account states `read_servers` has read on this thread.
        pub(super) static STATE_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
        /// How many reads, changes and writes of a state file this thread
        /// has made.
        pub(super) static STATE_CHANGES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    fn claude_json_path(home: &Path) -> PathBuf {
        account::claude_json(home, None, &HashMap::new())
    }

    fn fixture(name: &str) -> (Scratch, Scratch) {
        (
            Scratch::new(&format!("hook-{name}-home")),
            Scratch::new(&format!("hook-{name}-project")),
        )
    }

    #[test]
    fn turns_are_heard_where_the_agent_has_the_hooks() {
        let (home, project) = fixture("hears-turns");
        for agent in ["claude-code", "codex"] {
            assert!(!hears_turns(&home, &project, agent), "{agent}");
        }
        install(&home, &project, &[], &HashMap::new()).unwrap();
        for agent in ["claude-code", "codex"] {
            assert!(hears_turns(&home, &project, agent), "{agent}");
        }
        uninstall(&home, &project, &[], &HashMap::new()).unwrap();
        for agent in ["claude-code", "codex"] {
            assert!(!hears_turns(&home, &project, agent), "{agent}");
        }
    }

    #[test]
    fn the_server_goes_on_the_command_line_only_where_the_agent_lacks_it() {
        let (home, project) = fixture("server-pending");
        for agent in ["claude-code", "codex"] {
            assert_eq!(
                tool_server(&home, &project, agent, None, &HashMap::new()),
                ToolServer::Missing,
                "{agent}"
            );
        }
        with_daemon(&home);
        for agent in ["claude-code", "codex"] {
            assert_eq!(
                tool_server(&home, &project, agent, None, &HashMap::new()),
                ToolServer::Named(daemon_path(&home)),
                "{agent}"
            );
        }
        install(&home, &project, &[], &HashMap::new()).unwrap();
        for agent in ["claude-code", "codex"] {
            assert_eq!(
                tool_server(&home, &project, agent, None, &HashMap::new()),
                ToolServer::Configured,
                "{agent}"
            );
        }
        // Another account's Claude Code state was not written, so a session
        // under it still needs the server named.
        assert_eq!(
            tool_server(
                &home,
                &project,
                "claude-code",
                Some("~/.claude-work"),
                &HashMap::new()
            ),
            ToolServer::Named(daemon_path(&home))
        );
    }

    #[test]
    fn the_server_is_read_and_written_in_the_directory_the_launch_environment_names() {
        let (home, project) = fixture("launch-dir");
        let daemon = daemon_path(&home);
        std::fs::create_dir_all(daemon.parent().unwrap()).unwrap();
        std::fs::write(&daemon, "").unwrap();
        let shell = home.join("shell-claude");
        let env = HashMap::from([(
            "CLAUDE_CONFIG_DIR".to_string(),
            shell.to_string_lossy().to_string(),
        )]);
        let state = shell.join(".claude.json");

        install(&home, &project, &[], &env).unwrap();
        assert!(state.exists(), "written where the agent reads it");
        assert!(
            !home.join(".claude.json").exists(),
            "nothing under the home"
        );
        assert!(status(&home, &project, &[], &env).installed);
        assert_eq!(
            tool_server(&home, &project, "claude-code", None, &env),
            ToolServer::Configured
        );
        // Under the app's own environment the same project is not set up.
        let none = HashMap::new();
        assert!(!status(&home, &project, &[], &none).installed);
        assert_eq!(
            tool_server(&home, &project, "claude-code", None, &none),
            ToolServer::Named(daemon_path(&home))
        );

        uninstall(&home, &project, &[], &env).unwrap();
        assert!(!status(&home, &project, &[], &env).installed);
    }

    #[test]
    fn never_writes_back_a_file_it_could_not_read() {
        let (home, project) = fixture("unreadable");
        with_daemon(&home);
        // Half a file, as one being written looks: not JSON.
        std::fs::write(
            claude_json_path(&home),
            "{\"projects\": {\"/a\": {\"hasTrust",
        )
        .unwrap();
        let error = install(&home, &project, &[], &HashMap::new()).unwrap_err();
        assert!(error.contains("leaving it alone"), "{error}");
        assert_eq!(
            std::fs::read_to_string(claude_json_path(&home)).unwrap(),
            "{\"projects\": {\"/a\": {\"hasTrust"
        );
        // The project's own settings, the same.
        std::fs::write(claude_json_path(&home), "{}").unwrap();
        std::fs::create_dir_all(settings_path(&project).parent().unwrap()).unwrap();
        std::fs::write(settings_path(&project), "[1, 2").unwrap();
        let error = install(&home, &project, &[], &HashMap::new()).unwrap_err();
        assert!(error.contains("leaving it alone"), "{error}");
        assert_eq!(
            std::fs::read_to_string(settings_path(&project)).unwrap(),
            "[1, 2"
        );
    }

    #[test]
    fn a_reader_of_the_agent_s_state_never_sees_it_half_written() {
        let (home, project) = fixture("claude-trust-race");
        let state = home.join(".claude.json");
        // Big enough that a write of it is more than one write call.
        let padding = "x".repeat(256 * 1024);
        std::fs::write(&state, json!({ "padding": padding }).to_string()).unwrap();
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader = std::thread::spawn({
            let (state, done) = (state.clone(), std::sync::Arc::clone(&done));
            move || {
                let mut torn = 0;
                while !done.load(std::sync::atomic::Ordering::SeqCst) {
                    let text = std::fs::read_to_string(&state).unwrap_or_default();
                    if serde_json::from_str::<Value>(&text).is_err() {
                        torn += 1;
                    }
                }
                torn
            }
        });
        for n in 0..300 {
            claude_trust(&state, &project.join(format!("folder-{n}"))).unwrap();
        }
        done.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(reader.join().unwrap(), 0, "a reader saw a torn file");
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&state).unwrap()).unwrap();
        assert_eq!(written["projects"].as_object().unwrap().len(), 300);
        assert_eq!(written["padding"].as_str().unwrap().len(), padding.len());
        let left: Vec<_> = std::fs::read_dir(&home)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(left.is_empty(), "nothing left beside it: {left:?}");
    }

    #[test]
    fn a_write_cut_off_by_a_crash_leaves_nothing_behind_for_long() {
        let (home, project) = fixture("claude-trust-stale");
        let state = home.join(".claude.json");
        std::fs::write(&state, "{}").unwrap();
        let left = |age: u64| {
            let file = home.join(written_first(".claude.json"));
            std::fs::write(&file, "{").unwrap();
            let then = std::time::SystemTime::now() - std::time::Duration::from_secs(age);
            std::fs::File::options()
                .write(true)
                .open(&file)
                .unwrap()
                .set_modified(then)
                .unwrap();
            file
        };
        let stale = left(STALE_WRITE.as_secs() * 2);
        let fresh = left(0);
        let other = home.join(".claude.json.backup");
        std::fs::write(&other, "{}").unwrap();
        claude_trust(&state, &project).unwrap();
        assert!(!stale.exists(), "what a crash left goes");
        assert!(fresh.exists(), "what may be another write's own stays");
        assert!(other.exists(), "nothing else is touched");
    }

    #[cfg(unix)]
    #[test]
    fn the_agent_s_state_keeps_its_link_and_its_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let (home, project) = fixture("claude-trust-link");
        let real = home.join("dotfiles").join("claude.json");
        std::fs::create_dir_all(real.parent().unwrap()).unwrap();
        std::fs::write(&real, "{}").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();
        let state = home.join(".claude.json");
        std::os::unix::fs::symlink(&real, &state).unwrap();
        claude_trust(&state, &project).unwrap();
        assert!(std::fs::symlink_metadata(&state)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(std::fs::read_to_string(&real)
            .unwrap()
            .contains("hasTrustDialogAccepted"));
        let mode = std::fs::metadata(&real).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn a_folder_is_trusted_by_its_own_record_or_one_above_it() {
        let (home, project) = fixture("claude-trust");
        let state = home.join(".claude.json");
        let inner = project.join("src");
        std::fs::create_dir_all(&inner).unwrap();
        assert!(!claude_trusts(&state, &project), "no state file, no trust");

        std::fs::write(&state, r#"{"numStartups": 3, "projects": {}}"#).unwrap();
        assert!(!claude_trusts(&state, &project));
        claude_trust(&state, &project).unwrap();
        assert!(claude_trusts(&state, &project));
        assert!(
            claude_trusts(&state, &inner),
            "a folder inside a trusted one"
        );
        assert!(!claude_trusts(&state, &home), "nothing above it");

        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&state).unwrap()).unwrap();
        assert_eq!(written["numStartups"], 3, "the rest of the file stays");
        let key = dunce::canonicalize(&project)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        assert_eq!(written["projects"][&key]["hasTrustDialogAccepted"], true);

        // A record that says no is no.
        std::fs::write(
            &state,
            json!({"projects": {key: {"hasTrustDialogAccepted": false}}}).to_string(),
        )
        .unwrap();
        assert!(!claude_trusts(&state, &inner));
    }

    #[test]
    fn codex_records_a_folder_s_trust_and_keeps_the_rest_of_the_file() {
        let (home, project) = fixture("codex-trust");
        let config = home.join(".codex").join("config.toml");
        let inner = project.join("src");
        std::fs::create_dir_all(&inner).unwrap();
        assert!(
            !codex_trusts(&config, &project),
            "no configuration, no trust"
        );

        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(&config, "# mine\nmodel = \"o3\"\n").unwrap();
        assert!(!codex_trusts(&config, &project));
        codex_trust(&config, &project).unwrap();
        assert!(codex_trusts(&config, &project));
        assert!(
            !codex_trusts(&config, &inner),
            "a folder inside a trusted one that is no repository"
        );
        assert!(!codex_trusts(&config, &home), "nothing above it");

        let text = std::fs::read_to_string(&config).unwrap();
        assert!(text.starts_with("# mine\nmodel = \"o3\"\n"), "{text}");
        let document = text.parse::<toml_edit::DocumentMut>().unwrap();
        let key = dunce::canonicalize(&project)
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(
            document["projects"][key.as_str()]["trust_level"].as_str(),
            Some("trusted")
        );
        codex_trust(&config, &project).unwrap();
        assert_eq!(std::fs::read_to_string(&config).unwrap(), text, "once");

        // A record that says otherwise is no, and trusting keeps the rest of
        // the folder's table.
        std::fs::write(
            &config,
            format!("[projects.'{key}']\ntrust_level = \"untrusted\"\nnote = 1\n"),
        )
        .unwrap();
        assert!(!codex_trusts(&config, &project));
        codex_trust(&config, &project).unwrap();
        let document = std::fs::read_to_string(&config)
            .unwrap()
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        assert_eq!(
            document["projects"][key.as_str()]["trust_level"].as_str(),
            Some("trusted")
        );
        assert_eq!(
            document["projects"][key.as_str()]["note"].as_integer(),
            Some(1)
        );

        // A file that is not TOML is left alone.
        std::fs::write(&config, "[[[ half").unwrap();
        assert!(codex_trust(&config, &project).is_err());
        assert_eq!(std::fs::read_to_string(&config).unwrap(), "[[[ half");
    }

    /// A repository with one commit, made without running git, so that
    /// nothing outside the folder given is touched.
    fn repository(at: &Path) -> git2::Repository {
        let repo = git2::Repository::init(at).unwrap();
        let tree = repo.treebuilder(None).unwrap().write().unwrap();
        let tree = repo.find_tree(tree).unwrap();
        let signature = git2::Signature::now("workbench", "workbench@example.invalid").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "one", &tree, &[])
            .unwrap();
        drop(tree);
        repo
    }

    #[test]
    fn codex_trusts_a_folder_by_its_own_record_then_its_repository_s() {
        let (home, base) = fixture("codex-trust-records");
        let config = home.join(".codex").join("config.toml");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        let key = |path: &Path| {
            dunce::canonicalize(path)
                .unwrap()
                .to_string_lossy()
                .to_string()
        };
        let records = |records: &[(&Path, &str)]| {
            let text: String = records
                .iter()
                .map(|(path, record)| format!("[projects.'{}']\n{record}\n", key(path)))
                .collect();
            std::fs::write(&config, text).unwrap();
        };
        let trusted = "trust_level = \"trusted\"";
        let untrusted = "trust_level = \"untrusted\"";

        // A folder above that is no repository counts for nothing.
        let plain = base.join("plain");
        let child = plain.join("child");
        std::fs::create_dir_all(&child).unwrap();
        records(&[(&plain, trusted)]);
        assert!(codex_trusts(&config, &plain));
        assert!(!codex_trusts(&config, &child));

        // The repository's record covers what is in it, its worktrees too,
        // wherever they are, but not a repository of its own inside it.
        let repo_dir = base.join("repo");
        let sub = repo_dir.join("sub");
        let deeper = sub.join("deeper");
        let nested = repo_dir.join("nested");
        std::fs::create_dir_all(&deeper).unwrap();
        let repo = repository(&repo_dir);
        repository(&nested);
        let inside = repo_dir.join(".claude").join("worktrees").join("w");
        std::fs::create_dir_all(inside.parent().unwrap()).unwrap();
        repo.worktree("w", &inside, None).unwrap();
        let outside = base.join("outside");
        repo.worktree("o", &outside, None).unwrap();
        records(&[(&repo_dir, trusted)]);
        for folder in [&repo_dir, &sub, &deeper, &inside, &outside] {
            assert!(codex_trusts(&config, folder), "{folder:?}");
        }
        assert!(!codex_trusts(&config, &nested));

        // The folder's own record decides, whatever it says.
        records(&[(&repo_dir, trusted), (&sub, untrusted)]);
        assert!(!codex_trusts(&config, &sub));
        records(&[(&repo_dir, trusted), (&sub, "note = 1")]);
        assert!(!codex_trusts(&config, &sub), "a record with no level");
        records(&[(&repo_dir, untrusted), (&sub, trusted)]);
        assert!(codex_trusts(&config, &sub));
        assert!(
            !codex_trusts(&config, &deeper),
            "a folder between is no record"
        );
        records(&[(&sub, trusted)]);
        assert!(!codex_trusts(&config, &deeper));
    }

    /// A bare repository with one commit and a worktree of it at `tree`.
    fn bare_with_worktree(bare: &Path, tree: &Path) {
        let repo = git2::Repository::init_bare(bare).unwrap();
        let empty = repo.treebuilder(None).unwrap().write().unwrap();
        let empty = repo.find_tree(empty).unwrap();
        let signature = git2::Signature::now("workbench", "workbench@example.invalid").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "one", &empty, &[])
            .unwrap();
        drop(empty);
        let name = tree.file_name().unwrap().to_str().unwrap();
        repo.worktree(name, tree, None).unwrap();
    }

    #[test]
    fn codex_takes_a_repository_root_only_from_a_worktree_s_main_checkout() {
        let (home, base) = fixture("codex-trust-layouts");
        let config = home.join(".codex").join("config.toml");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        let trusting = |folders: &[&Path]| {
            let text: String = folders
                .iter()
                .map(|folder| {
                    let key = dunce::canonicalize(folder).unwrap();
                    format!(
                        "[projects.'{}']\ntrust_level = \"trusted\"\n",
                        key.to_string_lossy()
                    )
                })
                .collect();
            std::fs::write(&config, text).unwrap();
        };

        // A worktree of a bare repository whose folder has no `.git` of its
        // own: the folder is no repository root. With a `.git` file naming
        // the bare repository, it is.
        let proj = base.join("proj");
        let feature = proj.join("feature");
        bare_with_worktree(&proj.join(".bare"), &feature);
        trusting(&[&proj]);
        assert!(!codex_trusts(&config, &feature), "no proj/.git");
        std::fs::write(proj.join(".git"), "gitdir: ./.bare\n").unwrap();
        assert!(codex_trusts(&config, &feature), "proj/.git names .bare");
        std::fs::write(proj.join(".git"), "gitdir: ./elsewhere\n").unwrap();
        assert!(!codex_trusts(&config, &feature), "proj/.git names another");

        let w = base.join("w");
        let bwt = w.join("bwt");
        bare_with_worktree(&w.join("bare.git"), &bwt);
        trusting(&[&w]);
        assert!(!codex_trusts(&config, &bwt), "no w/.git");
        std::fs::write(w.join(".git"), "gitdir: bare.git\n").unwrap();
        assert!(codex_trusts(&config, &bwt), "w/.git names bare.git");

        // A checkout whose git directory is kept elsewhere has no repository
        // root, even where that elsewhere is a repository itself; its own
        // record still counts.
        let store = base.join("store");
        let sep = base.join("sep");
        let inside = sep.join("inside");
        std::fs::create_dir_all(&store).unwrap();
        let mut options = git2::RepositoryInitOptions::new();
        options.workdir_path(&sep);
        git2::Repository::init_opts(store.join("sep.git"), &options).unwrap();
        assert!(sep.join(".git").is_file());
        std::fs::create_dir_all(&inside).unwrap();
        trusting(&[&store]);
        assert!(!codex_trusts(&config, &sep), "the folder holding it");
        repository(&store);
        assert!(!codex_trusts(&config, &sep), "a repository holding it");
        trusting(&[&sep]);
        assert!(codex_trusts(&config, &sep), "its own record");
        assert!(!codex_trusts(&config, &inside), "a folder inside it");

        // A submodule is a checkout of that kind too.
        let super2 = base.join("super2");
        let modules = super2.join(".git").join("modules");
        let module = super2.join("m");
        let outer = repository(&super2);
        let url = format!("file://{}", base.join("elsewhere").display());
        let submodule = outer.submodule(&url, Path::new("m"), true).unwrap();
        submodule.open().unwrap();
        assert!(module.join(".git").is_file());
        trusting(&[&modules]);
        assert!(!codex_trusts(&config, &module), "super2/.git/modules");
        trusting(&[&super2]);
        assert!(!codex_trusts(&config, &module), "super2");
        trusting(&[&module]);
        assert!(codex_trusts(&config, &module), "its own record");
    }

    #[test]
    fn a_worktrees_codex_trust_goes_to_the_home_the_launch_environment_names() {
        let (home, project) = fixture("trust-launch-home");
        let worktree = project.join(".claude").join("worktrees").join("fix");
        std::fs::create_dir_all(&worktree).unwrap();
        let key = |path: &Path| {
            dunce::canonicalize(path)
                .unwrap()
                .to_string_lossy()
                .to_string()
        };
        let shell = home.join("shell-codex");
        std::fs::create_dir_all(&shell).unwrap();
        let env = HashMap::from([(
            "CODEX_HOME".to_string(),
            shell.to_string_lossy().to_string(),
        )]);
        let trusting = format!(
            "[projects.'{}']\ntrust_level = \"trusted\"\n",
            key(&project)
        );
        std::fs::write(shell.join("config.toml"), &trusting).unwrap();
        let own = home.join(".codex");
        std::fs::create_dir_all(&own).unwrap();
        std::fs::write(own.join("config.toml"), &trusting).unwrap();

        trust_like(&home, &project, &worktree, &[], &env).unwrap();
        assert!(codex_trusts(&shell.join("config.toml"), &worktree));
        assert!(
            !codex_trusts(&own.join("config.toml"), &worktree),
            "nothing under the user's own home"
        );
    }

    #[test]
    fn a_worktree_is_trusted_where_its_project_is_and_nowhere_else() {
        let (home, project) = fixture("trust");
        let worktree = project.join(".claude").join("worktrees").join("fix");
        std::fs::create_dir_all(&worktree).unwrap();
        let key = |path: &Path| {
            dunce::canonicalize(path)
                .unwrap()
                .to_string_lossy()
                .to_string()
        };

        // Neither agent has been told anything: nothing is written, and a
        // missing Codex config is left missing.
        trust_like(&home, &project, &worktree, &[], &HashMap::new()).unwrap();
        assert!(!claude_json_path(&home).exists());
        assert!(!account::codex_home(&home, None, &HashMap::new())
            .join("config.toml")
            .exists());

        // The project is trusted with both: the worktree is too, and the
        // rest of each file stands.
        std::fs::write(
            claude_json_path(&home),
            serde_json::to_string(&json!({
                "projects": { key(&project): { "hasTrustDialogAccepted": true, "allowedTools": ["Bash"] } },
                "theme": "dark"
            }))
            .unwrap(),
        )
        .unwrap();
        let codex = account::codex_home(&home, None, &HashMap::new()).join("config.toml");
        std::fs::create_dir_all(codex.parent().unwrap()).unwrap();
        std::fs::write(
            &codex,
            format!(
                "model = \"o3\"\n\n[projects.'{}']\ntrust_level = \"trusted\"\n",
                key(&project)
            ),
        )
        .unwrap();
        trust_like(&home, &project, &worktree, &[], &HashMap::new()).unwrap();
        let state = read_settings(&claude_json_path(&home));
        assert_eq!(
            state["projects"][key(&worktree)]["hasTrustDialogAccepted"],
            true
        );
        assert_eq!(state["projects"][key(&project)]["allowedTools"][0], "Bash");
        assert_eq!(state["theme"], "dark");
        let text = std::fs::read_to_string(&codex).unwrap();
        let document = text.parse::<toml_edit::DocumentMut>().unwrap();
        assert_eq!(document["model"].as_str(), Some("o3"));
        assert_eq!(
            document["projects"][key(&worktree)]["trust_level"].as_str(),
            Some("trusted")
        );

        // A project the user has not trusted lends nothing.
        let other = Scratch::new("hook-trust-other");
        let tree = other.join("tree");
        std::fs::create_dir_all(&tree).unwrap();
        trust_like(&home, &other, &tree, &[], &HashMap::new()).unwrap();
        let state = read_settings(&claude_json_path(&home));
        assert!(state["projects"].get(key(&tree)).is_none());
    }

    fn settings_of(project: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(settings_path(project)).unwrap()).unwrap()
    }

    #[test]
    fn reports_not_installed_when_there_are_no_settings() {
        let (home, project) = fixture("none");
        assert!(!status(&home, &project, &[], &HashMap::new()).installed);
    }

    #[test]
    fn keeps_both_files_out_of_the_repository() {
        let (home, project) = fixture("exclude");
        git2::Repository::init(&project).unwrap();
        install(&home, &project, &[], &HashMap::new()).unwrap();
        install(&home, &project, &[], &HashMap::new()).unwrap();
        let exclude = std::fs::read_to_string(project.join(".git/info/exclude")).unwrap();
        let ours: Vec<&str> = exclude
            .lines()
            .filter(|line| line.contains("settings.local") || line.contains("hooks.json"))
            .collect();
        assert_eq!(ours, ["/.claude/settings.local.json", "/.codex/hooks.json"]);
    }

    #[test]
    fn excludes_by_the_path_inside_the_repository() {
        let (home, project) = fixture("exclude-sub");
        git2::Repository::init(&project).unwrap();
        let sub = project.join("packages").join("app");
        std::fs::create_dir_all(&sub).unwrap();
        install(&home, &sub, &[], &HashMap::new()).unwrap();
        let exclude = std::fs::read_to_string(project.join(".git/info/exclude")).unwrap();
        assert!(exclude.contains("/packages/app/.claude/settings.local.json"));
    }

    fn with_daemon(home: &Path) {
        let daemon = daemon_path(home);
        std::fs::create_dir_all(daemon.parent().unwrap()).unwrap();
        std::fs::write(&daemon, "").unwrap();
    }

    // The server goes where each agent keeps a project's servers: Claude's
    // own state under the home, Codex's config in the project.
    #[test]
    fn points_both_agents_at_the_daemon_as_a_server_and_takes_it_back() {
        let (home, project) = fixture("server");
        with_daemon(&home);
        std::fs::create_dir_all(project.join(".codex")).unwrap();
        std::fs::write(
            project.join(".codex/config.toml"),
            "model = \"o3\"\n\n[mcp_servers.other]\ncommand = \"other\"\n",
        )
        .unwrap();
        install(&home, &project, &[], &HashMap::new()).unwrap();

        let key = dunce::canonicalize(&project)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let state = read_settings(&claude_json_path(&home));
        let server = &state["projects"][&key]["mcpServers"]["chord"];
        assert_eq!(server["args"], json!(["mcp"]));
        assert_eq!(
            server["command"].as_str().unwrap(),
            daemon_path(&home).to_string_lossy()
        );
        let codex = std::fs::read_to_string(project.join(".codex/config.toml")).unwrap();
        assert!(codex.contains("model = \"o3\""));
        assert!(codex.contains("[mcp_servers.other]"));
        assert!(codex.contains("[mcp_servers.chord]"));
        assert!(codex.contains("args = [\"mcp\"]"));
        // The workbench's tools that read, show or are asked about by the
        // window run without asking, each by its own approval; the rest,
        // and the other server, ask as the user's approval policy says.
        let document = codex.parse::<toml_edit::DocumentMut>().unwrap();
        let ours = &document["mcp_servers"]["chord"];
        assert!(ours.get("default_tools_approval_mode").is_none());
        for tool in RUN_UNASKED {
            assert_eq!(
                ours["tools"][tool]["approval_mode"].as_str(),
                Some("approve"),
                "{tool}"
            );
        }
        for tool in crate::mcp::ASK_AS_POLICY_SAYS {
            assert!(ours["tools"].get(tool).is_none(), "{tool}");
        }
        assert!(document["mcp_servers"]["other"].get("tools").is_none());

        uninstall(&home, &project, &[], &HashMap::new()).unwrap();
        let state = read_settings(&claude_json_path(&home));
        assert!(state["projects"][&key]["mcpServers"].get("chord").is_none());
        let codex = std::fs::read_to_string(project.join(".codex/config.toml")).unwrap();
        assert!(codex.contains("[mcp_servers.other]"));
        assert!(!codex.contains("chord"));
    }

    #[test]
    fn a_codex_config_of_only_the_server_goes_with_it() {
        let (home, project) = fixture("server-only");
        with_daemon(&home);
        install(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(project.join(".codex/config.toml").exists());
        uninstall(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(!project.join(".codex/config.toml").exists());
    }

    // An entry without the approvals the hooks write reads as installed and
    // out of date. The next install gives each listed tool its own approval,
    // leaving the rest of the file as the user has it, whatever its form,
    // and every approval of the user's own as it is. An entry with an
    // approval for the whole server is the user's, and is left alone.
    #[test]
    fn an_older_codex_entry_gets_its_tools_approvals_and_nothing_else() {
        let (home, project) = fixture("codex-approval");
        with_daemon(&home);
        install(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(status(&home, &project, &[], &HashMap::new()).installed);

        let daemon = toml_edit::Value::from(daemon_path(&home).to_string_lossy().as_ref());
        let older = |entry: &str| {
            format!(
                "# the user's own\n\
                 approval_policy = \"on-request\"\n\n\
                 [mcp_servers.chord]\n\
                 command = {daemon}\n\
                 args = [\"mcp\"]\n{entry}\n\
                 [mcp_servers.other] # theirs\n\
                 command = \"other\"\n"
            )
        };
        let config = project.join(".codex/config.toml");
        let checked = || status(&home, &project, &[], &HashMap::new());
        // The file before is read as installed and out of date, the install
        // makes it the file after, and it is then up to date and stays so.
        let brought = |before: &str, after: &str| {
            std::fs::write(&config, before).unwrap();
            let was = checked();
            assert!(was.installed && was.outdated, "{before}");
            install(&home, &project, &[], &HashMap::new()).unwrap();
            assert_eq!(std::fs::read_to_string(&config).unwrap(), after);
            let now = checked();
            assert!(now.installed && !now.outdated, "{after}");
            install(&home, &project, &[], &HashMap::new()).unwrap();
            assert_eq!(std::fs::read_to_string(&config).unwrap(), after);
        };
        // A file with nothing of the hooks' to bring up to date reads as
        // current, and the install leaves it as it is.
        let left = |file: &str| {
            std::fs::write(&config, file).unwrap();
            let was = checked();
            assert!(was.installed && !was.outdated, "{file}");
            install(&home, &project, &[], &HashMap::new()).unwrap();
            assert_eq!(std::fs::read_to_string(&config).unwrap(), file);
        };
        // The approvals the hooks write, as dotted keys under `prefix`,
        // leaving out the tools in `but`.
        let approvals = |prefix: &str, but: &[&str]| -> String {
            RUN_UNASKED
                .iter()
                .filter(|tool| !but.contains(tool))
                .map(|tool| format!("{prefix}{tool}.approval_mode = \"approve\"\n"))
                .collect()
        };
        let approve = approvals("tools.", &[]);
        // From before there were approvals.
        brought(&older(""), &older(&approve));

        // An approval for the whole server is the user's, whatever it says,
        // and the entry is left as it is, run after run.
        for mode in ["approve", "prompt", "writes", "auto"] {
            left(&older(&format!(
                "default_tools_approval_mode = \"{mode}\"\n"
            )));
        }
        // So does a tool's own, listed or not, and the rest are added.
        let theirs = "tools.notify.approval_mode = \"prompt\"\n\
                      tools.git_commit.approval_mode = \"approve\"\n";
        brought(
            &older(theirs),
            &older(&format!("{theirs}{}", approvals("tools.", &["notify"]))),
        );
        left(&older(&format!(
            "{theirs}{}",
            approvals("tools.", &["notify"])
        )));

        // Line breaks of a carriage return and a line feed, and a byte
        // order mark, are written back as they were.
        let crlf = |text: &str| text.replace('\n', "\r\n");
        brought(&crlf(&older("")), &crlf(&older(&approve)));
        brought(
            &format!("\u{feff}{}", older("")),
            &format!("\u{feff}{}", older(&approve)),
        );

        // A table of servers the user wrote out keeps its header and the
        // comment above it, with or without the entry in it yet.
        let header = format!(
            "model = \"o3\"\n\n\
             # My MCP servers, keep this comment\n\
             [mcp_servers]\n\n\
             [mcp_servers.chord]\n\
             command = {daemon}\n\
             args = [\"mcp\"]\n"
        );
        brought(&header, &format!("{header}{approve}"));
        let empty = "model = \"o3\"\n\n# My MCP servers, keep this comment\n[mcp_servers]\n";
        std::fs::write(&config, empty).unwrap();
        install(&home, &project, &[], &HashMap::new()).unwrap();
        assert_eq!(
            std::fs::read_to_string(&config).unwrap(),
            format!(
                "{empty}\n[mcp_servers.chord]\ncommand = {daemon}\n\
                 args = [\"mcp\"]\n{approve}"
            )
        );

        // Dotted keys, at the top and under the servers' header.
        let dotted = format!(
            "mcp_servers.chord.command = {daemon}\n\
             mcp_servers.chord.args = [\"mcp\"]\n"
        );
        brought(
            &dotted,
            &format!("{dotted}{}", approvals("mcp_servers.chord.tools.", &[])),
        );
        let under = format!(
            "[mcp_servers]\n\
             chord.command = {daemon}\n\
             chord.args = [\"mcp\"]\n"
        );
        brought(
            &under,
            &format!("{under}{}", approvals("chord.tools.", &[])),
        );

        // A tool's approval the user wrote under a header of its own: the
        // others go under headers of their own beside it.
        let headed = format!(
            "{}\n[mcp_servers.chord.tools.notify]\napproval_mode = \"prompt\"\n",
            older("").trim_end()
        );
        let headers: String = RUN_UNASKED
            .iter()
            .filter(|tool| **tool != "notify")
            .map(|tool| {
                format!("\n[mcp_servers.chord.tools.{tool}]\napproval_mode = \"approve\"\n")
            })
            .collect();
        brought(&headed, &format!("{headed}{headers}"));

        // An entry the user wrote inline gains it inline, a comment inside
        // it kept.
        // The approvals as dotted keys inside an inline table.
        let inline_approvals: String = RUN_UNASKED
            .iter()
            .map(|tool| format!(", tools.{tool}.approval_mode = \"approve\""))
            .collect();
        brought(
            &format!("[mcp_servers]\nchord = {{ command = {daemon}, args = [\"mcp\"] }}\n"),
            &format!(
                "[mcp_servers]\nchord = {{ command = {daemon}, args = [\"mcp\"]{inline_approvals} }}\n"
            ),
        );
        std::fs::write(
            &config,
            format!(
                "[mcp_servers]\nchord = {{ command = {daemon}, args = [\n  \"mcp\", # the subcommand\n] }}\n"
            ),
        )
        .unwrap();
        install(&home, &project, &[], &HashMap::new()).unwrap();
        let written = std::fs::read_to_string(&config).unwrap();
        assert!(written.contains("# the subcommand"), "{written}");
        assert!(written.contains(&inline_approvals), "{written}");

        // So do servers the user wrote inline, the entry in them or not; the
        // install can write to them, so they are never read as out of date
        // with no way to bring them up to date.
        brought(
            &format!("mcp_servers = {{ chord = {{ command = {daemon}, args = [\"mcp\"] }} }}\n"),
            &format!(
                "mcp_servers = {{ chord = {{ command = {daemon}, args = [\"mcp\"]{inline_approvals} }} }}\n"
            ),
        );
        let inline_servers = "mcp_servers = { other = { command = \"other\" } }\n";
        std::fs::write(&config, inline_servers).unwrap();
        install(&home, &project, &[], &HashMap::new()).unwrap();
        assert_eq!(
            std::fs::read_to_string(&config).unwrap(),
            format!(
                "mcp_servers = {{ other = {{ command = \"other\" }}, chord = {{ command = {daemon}, \
                 args = [\"mcp\"]{inline_approvals} }} }}\n"
            )
        );
        uninstall(&home, &project, &[], &HashMap::new()).unwrap();
        let written = std::fs::read_to_string(&config).unwrap();
        let document = written.parse::<toml_edit::DocumentMut>().unwrap();
        assert!(document["mcp_servers"].get("chord").is_none(), "{written}");
        assert_eq!(
            document["mcp_servers"]["other"]["command"].as_str(),
            Some("other")
        );

        // Servers that are not a table at all cannot be written to, and are
        // not read as out of date either.
        install(&home, &project, &[], &HashMap::new()).unwrap();
        std::fs::write(&config, "mcp_servers = 3\n").unwrap();
        let was = checked();
        assert!(was.installed && !was.outdated);
        assert!(install(&home, &project, &[], &HashMap::new()).is_err());
    }

    // Taking the hooks away takes their entry out of a servers table the
    // user wrote and leaves the table's header and the comment above it,
    // so the file is as it was before the install.
    #[test]
    fn removing_the_codex_entry_keeps_the_user_s_servers_header() {
        let (home, project) = fixture("codex-header");
        with_daemon(&home);
        let config = project.join(".codex/config.toml");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        for theirs in [
            "model = \"o3\"\n\n# My MCP servers, keep this comment\n[mcp_servers]\n",
            "# My MCP servers, keep this comment\r\n[mcp_servers]\r\n",
        ] {
            std::fs::write(&config, theirs).unwrap();
            install(&home, &project, &[], &HashMap::new()).unwrap();
            assert!(std::fs::read_to_string(&config)
                .unwrap()
                .contains("[mcp_servers.chord]"));
            uninstall(&home, &project, &[], &HashMap::new()).unwrap();
            assert_eq!(std::fs::read_to_string(&config).unwrap(), theirs);
        }
        // A table the hooks made goes with their entry, and the file too
        // when nothing else is in it.
        std::fs::remove_file(&config).unwrap();
        install(&home, &project, &[], &HashMap::new()).unwrap();
        uninstall(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(!config.exists());
    }

    #[test]
    fn without_a_daemon_here_only_the_hooks_go_in() {
        let (home, project) = fixture("no-daemon");
        install(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(!claude_json_path(&home).exists());
        assert!(!project.join(".codex/config.toml").exists());
        assert!(status(&home, &project, &[], &HashMap::new()).installed);
    }

    // Hooks from before there was a server: once a daemon is here, they
    // read as not installed until the server is put in with them.
    #[test]
    fn a_daemon_arriving_later_asks_for_the_server() {
        let (home, project) = fixture("daemon-later");
        install(&home, &project, &[], &HashMap::new()).unwrap();
        with_daemon(&home);
        assert!(!status(&home, &project, &[], &HashMap::new()).installed);
        install(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(status(&home, &project, &[], &HashMap::new()).installed);
    }

    #[test]
    fn installs_and_reports_itself() {
        let (home, project) = fixture("install");
        assert!(
            install(&home, &project, &[], &HashMap::new())
                .unwrap()
                .installed
        );
        assert!(status(&home, &project, &[], &HashMap::new()).installed);
    }

    // The untracked settings file, so nobody finds this in a diff.
    #[test]
    fn writes_to_settings_local_not_the_shared_one() {
        let (home, project) = fixture("local");
        install(&home, &project, &[], &HashMap::new()).unwrap();

        assert!(project.join(".claude/settings.local.json").exists());
        assert!(!project.join(".claude/settings.json").exists());
    }

    #[test]
    fn only_reacts_to_tools_that_change_files() {
        let (home, project) = fixture("matcher");
        install(&home, &project, &[], &HashMap::new()).unwrap();

        let entry = &settings_of(&project)["hooks"]["PostToolUse"][0];
        assert_eq!(entry["matcher"], MATCHER);
        assert!(!MATCHER.contains("Read"));
    }

    #[test]
    fn writes_outside_the_project() {
        let (home, project) = fixture("outside");
        install(&home, &project, &[], &HashMap::new()).unwrap();

        let command = settings_of(&project)["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string();
        // Spelled for the shell that runs it: forward slashes on Windows too.
        assert!(command.contains(&bash_path(&home.to_string_lossy())));
        assert!(!command.contains(&bash_path(&project.to_string_lossy())));
    }

    #[test]
    fn spells_paths_for_bash() {
        if cfg!(windows) {
            assert_eq!(bash_path(r"C:\Users\ada\.chord"), "C:/Users/ada/.chord");
        } else {
            assert_eq!(bash_path("/home/ada/.chord"), "/home/ada/.chord");
        }
    }

    #[test]
    fn installing_twice_adds_one_entry() {
        let (home, project) = fixture("twice");
        install(&home, &project, &[], &HashMap::new()).unwrap();
        install(&home, &project, &[], &HashMap::new()).unwrap();

        assert_eq!(
            settings_of(&project)["hooks"]["PostToolUse"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    // Somebody else's settings are not ours to rearrange.
    #[test]
    fn leaves_unrelated_settings_alone() {
        let (home, project) = fixture("merge");
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        std::fs::write(
            settings_path(&project),
            r#"{"model":"opus","permissions":{"allow":["Bash(ls:*)"]}}"#,
        )
        .unwrap();

        install(&home, &project, &[], &HashMap::new()).unwrap();
        let settings = settings_of(&project);
        assert_eq!(settings["model"], "opus");
        assert_eq!(settings["permissions"]["allow"][0], "Bash(ls:*)");
    }

    #[test]
    fn leaves_someone_elses_post_tool_use_hook_alone() {
        let (home, project) = fixture("other-hook");
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        std::fs::write(
            settings_path(&project),
            r#"{"hooks":{"PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo hi"}]}]}}"#,
        )
        .unwrap();

        install(&home, &project, &[], &HashMap::new()).unwrap();
        let entries = settings_of(&project)["hooks"]["PostToolUse"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(entries.len(), 2);

        uninstall(&home, &project, &[], &HashMap::new()).unwrap();
        let after = settings_of(&project)["hooks"]["PostToolUse"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0]["hooks"][0]["command"], "echo hi");
    }

    #[test]
    fn uninstalling_removes_it() {
        let (home, project) = fixture("uninstall");
        install(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(
            !uninstall(&home, &project, &[], &HashMap::new())
                .unwrap()
                .installed
        );
    }

    // Nothing left behind that was not there before.
    #[test]
    fn uninstalling_the_only_hook_leaves_no_empty_scaffolding() {
        let (home, project) = fixture("scaffolding");
        install(&home, &project, &[], &HashMap::new()).unwrap();
        uninstall(&home, &project, &[], &HashMap::new()).unwrap();

        let settings = settings_of(&project);
        assert!(settings.get("hooks").is_none(), "{settings}");
    }

    #[test]
    fn uninstalling_when_it_was_never_there_is_not_an_error() {
        let (home, project) = fixture("absent");
        assert!(
            !uninstall(&home, &project, &[], &HashMap::new())
                .unwrap()
                .installed
        );
    }

    #[test]
    fn refuses_a_settings_file_that_is_not_json_rather_than_replace_it() {
        let (home, project) = fixture("broken");
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        std::fs::write(settings_path(&project), "{ not json").unwrap();

        // The file may be one being written, or one the user is mid-way
        // through: it is theirs, and not ours to start over.
        let error = install(&home, &project, &[], &HashMap::new()).unwrap_err();
        assert!(error.contains("leaving it alone"), "{error}");
        assert_eq!(
            std::fs::read_to_string(settings_path(&project)).unwrap(),
            "{ not json"
        );
        assert!(!status(&home, &project, &[], &HashMap::new()).installed);
    }

    #[test]
    fn quotes_a_path_with_a_space_in_it() {
        assert_eq!(shell_quote("/a b/c"), "'/a b/c'");
        assert_eq!(shell_quote("/it's"), r"'/it'\''s'");
    }

    #[test]
    fn the_events_file_lives_under_the_home_directory() {
        let path = events_path(Path::new("/home/ada"));
        assert_eq!(path, Path::new("/home/ada/.chord/last-tool-use.json"));
    }

    // The watcher can only attach to a file that exists.
    #[test]
    fn installing_creates_the_events_file() {
        let (home, project) = fixture("touch");
        install(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(events_path(&home).exists());
    }

    // Latest event only: nothing reads the history, so nothing should grow.
    #[test]
    fn the_hook_overwrites_rather_than_appends() {
        let command = command(Path::new("/home/ada"));
        assert!(command.contains("cat > "), "{command}");
        assert!(!command.contains(">>"), "{command}");
    }

    fn codex_hooks_of(project: &Path) -> Value {
        std::fs::read_to_string(codex_hooks_path(project))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null)
    }

    #[test]
    fn installs_the_session_hooks_for_both_agents() {
        let (home, project) = fixture("sessions");
        install(&home, &project, &[], &HashMap::new()).unwrap();

        let claude = settings_of(&project);
        // No Claude Code on the PATH says it knows the failed-turn event.
        assert!(claude["hooks"].get("StopFailure").is_none());
        for event in ["UserPromptSubmit", "Stop", "Notification"] {
            let command = claude["hooks"][event][0]["hooks"][0]["command"]
                .as_str()
                .unwrap();
            assert!(command.contains("sessions.jsonl"), "{event}: {command}");
            assert!(command.contains(">>"), "appends, so a burst loses nothing");
        }
        let codex = codex_hooks_of(&project);
        for event in ["UserPromptSubmit", "Stop", "PermissionRequest"] {
            assert!(codex["hooks"][event][0]["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .contains("sessions.jsonl"));
        }
        assert!(activity_path(&home).exists());
        assert!(status(&home, &project, &[], &HashMap::new()).installed);
    }

    /// An environment whose PATH holds a Claude Code that says this version.
    #[cfg(unix)]
    fn claude_saying(dir: &Path, version: &str) -> HashMap<String, String> {
        std::fs::create_dir_all(dir).unwrap();
        let bin = dir.join("claude");
        crate::executable::write(&bin, format!("#!/bin/sh\necho '{version} (Claude Code)'\n"))
            .unwrap();
        HashMap::from([("PATH".to_string(), dir.to_string_lossy().to_string())])
    }

    /// A project given the hooks before Claude Code's failed turns were
    /// heard reads as not installed where the Claude Code on the machine
    /// knows them, so the next install adds that one entry and leaves the
    /// rest as they are.
    #[cfg(unix)]
    #[test]
    fn brings_a_project_without_the_failed_turn_hook_up_to_date() {
        let (home, project) = fixture("sessions-older");
        let env = claude_saying(&home.join("bin-new"), "2.1.325");
        install(&home, &project, &[], &env).unwrap();
        let mut older = settings_of(&project);
        assert!(older["hooks"].get("StopFailure").is_some());
        older["hooks"]
            .as_object_mut()
            .unwrap()
            .remove("StopFailure");
        std::fs::write(settings_path(&project), older.to_string()).unwrap();
        assert!(!status(&home, &project, &[], &env).installed);

        install(&home, &project, &[], &env).unwrap();
        let claude = settings_of(&project);
        assert!(status(&home, &project, &[], &env).installed);
        for event in ["UserPromptSubmit", "Stop", "StopFailure", "Notification"] {
            assert_eq!(
                claude["hooks"][event].as_array().unwrap().len(),
                if event == "UserPromptSubmit" {
                    older["hooks"][event].as_array().unwrap().len()
                } else {
                    1
                },
                "{event}"
            );
        }
        uninstall(&home, &project, &[], &env).unwrap();
        assert!(settings_of(&project).get("hooks").is_none());
    }

    /// A Claude Code before the failed-turn event would ignore the whole
    /// settings file for an event it does not know, the user's permissions
    /// with it: it is not given the entry, and its project reads as
    /// installed without it.
    #[cfg(unix)]
    #[test]
    fn gives_the_failed_turn_hook_only_to_a_claude_code_that_knows_it() {
        let (home, project) = fixture("sessions-old-claude");
        let old = claude_saying(&home.join("bin-old"), "2.1.77");
        install(&home, &project, &[], &old).unwrap();
        assert!(settings_of(&project)["hooks"].get("StopFailure").is_none());
        assert!(status(&home, &project, &[], &old).installed);

        let first = claude_saying(&home.join("bin-first"), "2.1.78");
        assert!(!status(&home, &project, &[], &first).installed);
        install(&home, &project, &[], &first).unwrap();
        assert!(settings_of(&project)["hooks"].get("StopFailure").is_some());
        assert!(status(&home, &project, &[], &first).installed);

        // Taken out whatever the Claude Code there says now.
        uninstall(&home, &project, &[], &old).unwrap();
        assert!(settings_of(&project).get("hooks").is_none());

        // One that says no version is taken for one that does not know it.
        let mute = claude_saying(&home.join("bin-mute"), "claude");
        install(&home, &project, &[], &mute).unwrap();
        assert!(settings_of(&project)["hooks"].get("StopFailure").is_none());
    }

    #[test]
    fn uninstalling_takes_the_session_hooks_too_and_an_empty_codex_file_with_them() {
        let (home, project) = fixture("sessions-off");
        install(&home, &project, &[], &HashMap::new()).unwrap();
        uninstall(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(settings_of(&project).get("hooks").is_none());
        assert!(!codex_hooks_path(&project).exists());
        assert!(!status(&home, &project, &[], &HashMap::new()).installed);
    }

    #[test]
    fn leaves_someone_elses_codex_hooks_alone() {
        let (home, project) = fixture("codex-theirs");
        std::fs::create_dir_all(project.join(".codex")).unwrap();
        std::fs::write(
            codex_hooks_path(&project),
            r#"{"description":"mine","hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}"#,
        )
        .unwrap();
        install(&home, &project, &[], &HashMap::new()).unwrap();
        let hooks = codex_hooks_of(&project);
        assert_eq!(hooks["hooks"]["Stop"].as_array().unwrap().len(), 2);
        uninstall(&home, &project, &[], &HashMap::new()).unwrap();
        let hooks = codex_hooks_of(&project);
        assert_eq!(hooks["description"], "mine");
        assert_eq!(hooks["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(hooks["hooks"]["Stop"][0]["hooks"][0]["command"], "say done");
    }

    /// The commands each of an event's entries runs, in order.
    fn commands_of(hooks: &Value, event: &str) -> Vec<String> {
        hooks["hooks"][event]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|entry| entry["hooks"].as_array().cloned().unwrap_or_default())
            .filter_map(|hook| hook["command"].as_str().map(str::to_string))
            .collect()
    }

    // With a daemon here, a second prompt hook runs it to ask the window
    // what the sessions this one started did, beside the hook that logs the
    // prompt, in both agents' files.
    #[test]
    fn puts_the_prompt_hook_that_asks_beside_the_one_that_logs() {
        let (home, project) = fixture("reports");
        with_daemon(&home);
        install(&home, &project, &[], &HashMap::new()).unwrap();
        install(&home, &project, &[], &HashMap::new()).unwrap();
        for hooks in [settings_of(&project), codex_hooks_of(&project)] {
            let commands = commands_of(&hooks, PROMPT_EVENT);
            assert_eq!(commands, [activity_command(&home), reports_command(&home)]);
            assert!(commands[1].contains(&bash_path(&daemon_path(&home).to_string_lossy())));
            // It can never fail the prompt, whatever the daemon makes of it.
            assert!(
                commands[1].ends_with(" reports 2>/dev/null || true"),
                "{}",
                commands[1]
            );
        }
        assert!(status(&home, &project, &[], &HashMap::new()).installed);
        uninstall(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(settings_of(&project).get("hooks").is_none());
        assert!(!codex_hooks_path(&project).exists());
    }

    #[test]
    fn without_a_daemon_no_prompt_hook_asks() {
        let (home, project) = fixture("reports-no-daemon");
        install(&home, &project, &[], &HashMap::new()).unwrap();
        assert_eq!(
            commands_of(&settings_of(&project), PROMPT_EVENT),
            [activity_command(&home)]
        );
        assert!(status(&home, &project, &[], &HashMap::new()).installed);
    }

    // Hooks put in by a version before the prompt hook asked: they keep
    // working as they are, read as not installed, and the next install adds
    // the hook that asks and leaves the one that logs alone.
    #[test]
    fn hooks_from_before_gain_the_prompt_hook_and_keep_their_own() {
        let (home, project) = fixture("reports-later");
        with_daemon(&home);
        install(&home, &project, &[], &HashMap::new()).unwrap();
        for path in [settings_path(&project), codex_hooks_path(&project)] {
            let mut hooks = read_settings(&path);
            let entries = hooks["hooks"][PROMPT_EVENT].as_array_mut().unwrap();
            entries.retain(|entry| !runs(entry, &[reports_command(&home)]));
            write_settings(&path, &hooks).unwrap();
        }
        assert!(!status(&home, &project, &[], &HashMap::new()).installed);
        install(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(status(&home, &project, &[], &HashMap::new()).installed);
        for hooks in [settings_of(&project), codex_hooks_of(&project)] {
            assert_eq!(
                commands_of(&hooks, PROMPT_EVENT),
                [activity_command(&home), reports_command(&home)]
            );
        }
    }

    #[test]
    fn is_not_installed_until_every_hook_is_there() {
        let (home, project) = fixture("partial");
        install(&home, &project, &[], &HashMap::new()).unwrap();
        let mut settings = read_settings(&settings_path(&project));
        remove_entries(&mut settings, "Stop", &home);
        write_settings(&settings_path(&project), &settings).unwrap();
        assert!(!status(&home, &project, &[], &HashMap::new()).installed);
        install(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(status(&home, &project, &[], &HashMap::new()).installed);
    }
    /// A repository with one commit, holding `files` as given.
    fn committed(project: &Path, files: &[(&str, &str)]) {
        let git = |args: &[&str]| {
            let done = std::process::Command::new("git")
                .args(args)
                .current_dir(project)
                .output()
                .expect("git should be installed");
            assert!(done.status.success(), "git {args:?}: {done:?}");
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(project.join("a.txt"), "one\n").unwrap();
        for (file, text) in files {
            let path = project.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "first"]);
    }

    /// What `git status` says of a checkout, untracked files included.
    fn porcelain(checkout: &Path) -> String {
        let done = std::process::Command::new("git")
            .args(["status", "--porcelain", "--untracked-files=all"])
            .current_dir(checkout)
            .output()
            .unwrap();
        String::from_utf8_lossy(&done.stdout).to_string()
    }

    fn server_for(home: &Path, folder: &Path) -> Option<Value> {
        let key = dunce::canonicalize(folder)
            .unwrap_or_else(|_| folder.to_path_buf())
            .to_string_lossy()
            .to_string();
        read_settings(&claude_json_path(home))
            .get("projects")
            .and_then(|projects| projects.get(&key))
            .and_then(|project| project.get("mcpServers"))
            .and_then(|servers| servers.get(SERVER_NAME))
            .cloned()
    }

    // A worktree is a checkout of its own, and the agent run there reads
    // its local settings from it rather than from the project.
    #[test]
    fn a_worktree_gets_the_hooks_its_project_has_and_shows_no_change() {
        let (home, project) = fixture("share");
        with_daemon(&home);
        let theirs = "model = \"o3\"\n";
        committed(&project, &[(CODEX_CONFIG, theirs)]);
        install(&home, &project, &[], &HashMap::new()).unwrap();

        let tree = PathBuf::from(crate::git::worktree_add(&project, "fix").unwrap());
        assert!(share(&home, &project, &tree, &[], &HashMap::new()).unwrap());

        assert!(
            has_hooks(&home, &tree),
            "Claude Code's hooks are in the tree"
        );
        let codex = codex_hooks_of(&tree);
        for event in CODEX_SESSION_EVENTS {
            assert!(codex["hooks"][event][0]["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .contains("sessions.jsonl"));
        }
        assert!(server_for(&home, &tree).is_some(), "the tools reach it too");
        // The checkout tracks its Codex config, so that is left as it was.
        assert_eq!(
            std::fs::read_to_string(tree.join(CODEX_CONFIG)).unwrap(),
            theirs
        );
        assert_eq!(porcelain(&tree), "", "the worktree shows no change");
        assert!(crate::git::status(&tree).unwrap().is_empty());
    }

    #[test]
    fn a_worktree_of_a_project_without_hooks_gets_nothing() {
        let (home, project) = fixture("share-off");
        with_daemon(&home);
        committed(&project, &[]);

        let tree = PathBuf::from(crate::git::worktree_add(&project, "fix").unwrap());
        assert!(!share(&home, &project, &tree, &[], &HashMap::new()).unwrap());
        assert!(!tree.join(".claude").exists());
        assert!(!tree.join(".codex").exists());
        assert!(!claude_json_path(&home).exists());
        assert_eq!(porcelain(&tree), "");
    }

    // A worktree made before the hooks were turned on has none; turning
    // them on gives it them, and turning them off takes them away again.
    #[test]
    fn hooks_turned_on_or_off_later_reach_the_project_s_worktrees() {
        let (home, project) = fixture("share-later");
        with_daemon(&home);
        committed(&project, &[]);
        let tree = PathBuf::from(crate::git::worktree_add(&project, "fix").unwrap());
        assert!(!share(&home, &project, &tree, &[], &HashMap::new()).unwrap());

        install(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(has_hooks(&home, &tree));
        assert!(server_for(&home, &tree).is_some());
        assert_eq!(porcelain(&tree), "");

        uninstall(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(!has_hooks(&home, &tree));
        assert!(!codex_hooks_path(&tree).exists());
        assert!(server_for(&home, &tree).is_none());
        assert_eq!(porcelain(&tree), "");
    }

    // What the tree held goes with it; what the agents' state held for it
    // is taken out.
    #[test]
    fn a_worktree_s_clean_up_takes_its_hooks_with_it() {
        let (home, project) = fixture("share-gone");
        with_daemon(&home);
        committed(&project, &[]);
        install(&home, &project, &[], &HashMap::new()).unwrap();
        let tree = PathBuf::from(crate::git::worktree_add(&project, "fix").unwrap());
        share(&home, &project, &tree, &[], &HashMap::new()).unwrap();

        // The hooks' files are no work of the tree's: it still goes.
        crate::git::worktree_remove(&project, "fix").unwrap();
        assert!(!tree.exists());
        assert!(server_for(&home, &tree).is_some());
        forget(&home, &tree, &[], &HashMap::new()).unwrap();
        assert!(server_for(&home, &tree).is_none());
        assert!(
            server_for(&home, &project).is_some(),
            "the project keeps its own"
        );
    }

    fn git_in(folder: &Path, args: &[&str]) {
        let done = std::process::Command::new("git")
            .args(args)
            .current_dir(folder)
            .output()
            .expect("git should be installed");
        assert!(done.status.success(), "git {args:?}: {done:?}");
    }

    // A tree the user deleted without telling git is still listed by it,
    // and writing the hooks there would make its folder again, one git can
    // then no longer take away.
    #[test]
    fn a_worktree_whose_folder_is_gone_is_never_made_again() {
        let (home, project) = fixture("share-deleted");
        with_daemon(&home);
        committed(&project, &[]);
        let gone = PathBuf::from(crate::git::worktree_add(&project, "gone").unwrap());
        let hollow = PathBuf::from(crate::git::worktree_add(&project, "hollow").unwrap());
        std::fs::remove_dir_all(&gone).unwrap();
        std::fs::remove_file(hollow.join(".git")).unwrap();

        install(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(!gone.exists(), "the deleted folder stays deleted");
        assert!(!hollow.join(".claude").exists());
        assert!(!hollow.join(".codex").exists());
        assert!(server_for(&home, &gone).is_none());
        assert!(server_for(&home, &hollow).is_none());
        assert!(!share(&home, &project, &gone, &[], &HashMap::new()).unwrap());
        assert!(!gone.exists());

        uninstall(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(!gone.exists());
    }

    // A project in a folder of its repository has worktrees that are
    // checkouts of the whole repository. Keeping files at their top out of
    // git's view would take lines every checkout reads, the main one too.
    #[test]
    fn a_project_inside_its_repository_shares_nothing_and_leaves_the_checkout_alone() {
        let (home, base) = fixture("share-subfolder");
        with_daemon(&home);
        let repo = base.join("repo");
        let project = repo.join("app");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("main.rs"), "fn main() {}\n").unwrap();
        committed(&repo, &[]);
        let exclude = repo.join(".git").join("info").join("exclude");
        install(&home, &project, &[], &HashMap::new()).unwrap();
        let excluded = std::fs::read_to_string(&exclude).unwrap();

        let tree = PathBuf::from(crate::git::worktree_add(&project, "fix").unwrap());
        assert!(!share(&home, &project, &tree, &[], &HashMap::new()).unwrap());
        install(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(!tree.join(".claude").exists());
        assert!(!tree.join(".codex").exists());
        assert!(server_for(&home, &tree).is_none());
        assert_eq!(porcelain(&tree), "", "the worktree shows no change");
        assert_eq!(
            std::fs::read_to_string(&exclude).unwrap(),
            excluded,
            "the shared exclude list holds the project's lines alone"
        );

        // A file of the user's at the top of the main checkout still shows.
        std::fs::create_dir_all(repo.join(".codex")).unwrap();
        std::fs::write(repo.join(CODEX_CONFIG), "model = \"o3\"\n").unwrap();
        assert!(porcelain(&repo).contains("?? .codex/config.toml"));

        uninstall(&home, &project, &[], &HashMap::new()).unwrap();
        assert_eq!(std::fs::read_to_string(&exclude).unwrap(), excluded);
        assert!(porcelain(&repo).contains("?? .codex/config.toml"));
    }

    fn state_with(home: &Path, key: &str, entry: Value) {
        let path = claude_json_path(home);
        let mut state = read_settings(&path);
        state
            .entry("projects")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .unwrap()
            .insert(key.to_string(), entry);
        write_settings(&path, &state).unwrap();
    }

    fn project_state(home: &Path, key: &str) -> Value {
        read_settings(&claude_json_path(home))["projects"][key].clone()
    }

    // A tree removed by hand, or lost between its removal and the clean-up
    // of what was written for it, leaves the server in the agents' state;
    // the next toggle takes it out, and only ours.
    #[test]
    fn a_toggle_drops_the_server_of_worktrees_git_no_longer_lists() {
        let (home, project) = fixture("share-stale");
        with_daemon(&home);
        committed(&project, &[]);
        install(&home, &project, &[], &HashMap::new()).unwrap();
        let kept = PathBuf::from(crate::git::worktree_add(&project, "kept").unwrap());
        let removed = PathBuf::from(crate::git::worktree_add(&project, "removed").unwrap());
        share(&home, &project, &kept, &[], &HashMap::new()).unwrap();
        share(&home, &project, &removed, &[], &HashMap::new()).unwrap();
        let removed_key = state_key(&removed);
        git_in(
            &project,
            &["worktree", "remove", "--force", &removed.to_string_lossy()],
        );
        let old = format!(
            "{}",
            canonical(&project)
                .join(crate::git::WORKTREES)
                .join("old")
                .display()
        );
        state_with(
            &home,
            &old,
            json!({
                "hasTrustDialogAccepted": true,
                "mcpServers": {
                    SERVER_NAME: { "type": "stdio", "command": "x", "args": ["mcp"] },
                    "theirs": { "type": "stdio", "command": "y" },
                },
            }),
        );
        let elsewhere = home.join("elsewhere");
        let elsewhere_key = elsewhere.to_string_lossy().to_string();
        state_with(
            &home,
            &elsewhere_key,
            json!({ "mcpServers": { SERVER_NAME: { "command": "z" } } }),
        );

        install(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(project_state(&home, &removed_key)["mcpServers"]
            .get(SERVER_NAME)
            .is_none());
        let old_state = project_state(&home, &old);
        assert!(old_state["mcpServers"].get(SERVER_NAME).is_none());
        assert!(old_state["mcpServers"].get("theirs").is_some());
        assert_eq!(old_state["hasTrustDialogAccepted"], true);
        assert!(server_for(&home, &kept).is_some());
        assert!(server_for(&home, &project).is_some());
        assert!(
            project_state(&home, &elsewhere_key)["mcpServers"]
                .get(SERVER_NAME)
                .is_some(),
            "a folder outside the project's worktrees is not the toggle's"
        );

        // Turning them off takes out every one under the worktrees' folder.
        state_with(
            &home,
            &old,
            json!({ "mcpServers": { SERVER_NAME: { "command": "x" } } }),
        );
        uninstall(&home, &project, &[], &HashMap::new()).unwrap();
        assert!(server_for(&home, &kept).is_none());
        assert!(project_state(&home, &old)["mcpServers"]
            .get(SERVER_NAME)
            .is_none());
        assert!(project_state(&home, &elsewhere_key)["mcpServers"]
            .get(SERVER_NAME)
            .is_some());
    }

    fn changes_during(run: impl FnOnce()) -> usize {
        let before = STATE_CHANGES.with(|changes| changes.get());
        run();
        STATE_CHANGES.with(|changes| changes.get()) - before
    }

    // An agent's own process rewrites its state without the workbench's
    // lock, so each rewrite of it is a chance to lose one of the agent's.
    #[test]
    fn a_toggle_changes_each_account_s_state_once_however_many_worktrees() {
        let (home, project) = fixture("share-once");
        with_daemon(&home);
        committed(&project, &[]);
        let trees: Vec<PathBuf> = (0..3)
            .map(|at| {
                PathBuf::from(crate::git::worktree_add(&project, &format!("tree-{at}")).unwrap())
            })
            .collect();
        let accounts = [Dirs {
            claude: Some("~/.claude-work".into()),
            codex: None,
        }];

        assert_eq!(
            changes_during(|| {
                install(&home, &project, &accounts, &HashMap::new()).unwrap();
            }),
            2
        );
        for tree in &trees {
            assert!(has_hooks(&home, tree));
            assert!(status(&home, tree, &accounts, &HashMap::new()).installed);
        }
        assert_eq!(
            changes_during(|| {
                uninstall(&home, &project, &accounts, &HashMap::new()).unwrap();
            }),
            2
        );
        for tree in &trees {
            assert!(!has_hooks(&home, tree));
            assert!(server_for(&home, tree).is_none());
        }
    }

    /// Project folders that live as long as this value does.
    struct Projects {
        paths: Vec<PathBuf>,
        _held: Vec<Scratch>,
    }

    impl std::ops::Deref for Projects {
        type Target = Vec<PathBuf>;
        fn deref(&self) -> &Vec<PathBuf> {
            &self.paths
        }
    }

    fn many_projects(name: &str, count: usize) -> (Scratch, Projects) {
        let (home, first) = fixture(name);
        let mut held = vec![first];
        for at in 1..count {
            held.push(Scratch::new(&format!("hook-{name}-project-{at}")));
        }
        let paths = held.iter().map(|folder| folder.to_path_buf()).collect();
        (home, Projects { paths, _held: held })
    }

    fn work_account() -> Vec<Dirs> {
        vec![Dirs {
            claude: Some("~/.claude-work".into()),
            codex: None,
        }]
    }

    fn reads_during(run: impl FnOnce()) -> usize {
        let before = STATE_READS.with(|reads| reads.get());
        run();
        STATE_READS.with(|reads| reads.get()) - before
    }

    #[test]
    fn a_batch_answers_as_each_project_would_alone() {
        let (home, projects) = many_projects("batch-same", 4);
        with_daemon(&home);
        let accounts = work_account();
        install(&home, &projects[0], &accounts, &HashMap::new()).unwrap();
        // Hooks without the server, as a setup from before the server has.
        install(&home, &projects[1], &accounts, &HashMap::new()).unwrap();
        let mut state = read_settings(&claude_json_path(&home));
        let key = dunce::canonicalize(&projects[1]).unwrap();
        state["projects"]
            .as_object_mut()
            .unwrap()
            .remove(key.to_string_lossy().as_ref());
        write_settings(&claude_json_path(&home), &state).unwrap();

        let batch = status_many(&home, &projects, &accounts, &HashMap::new());
        assert_eq!(batch.len(), projects.len());
        for (project, answer) in projects.iter().zip(&batch) {
            let alone = status(&home, project, &accounts, &HashMap::new());
            assert_eq!(answer.installed, alone.installed);
            assert_eq!(answer.settings, alone.settings);
            assert_eq!(answer.events, alone.events);
        }
        let installed: Vec<bool> = batch.iter().map(|answer| answer.installed).collect();
        assert_eq!(installed, [true, false, false, false]);
    }

    // Thirty projects, two accounts: alone each project reads both states,
    // in a batch each is read once.
    #[test]
    fn a_batch_parses_each_accounts_state_once() {
        let (home, projects) = many_projects("batch-reads", 30);
        with_daemon(&home);
        let accounts = work_account();
        for project in projects.iter() {
            install(&home, project, &accounts, &HashMap::new()).unwrap();
        }

        let alone = reads_during(|| {
            for project in projects.iter() {
                assert!(status(&home, project, &accounts, &HashMap::new()).installed);
            }
        });
        let batch = reads_during(|| {
            let answers = status_many(&home, &projects, &accounts, &HashMap::new());
            assert!(answers.iter().all(|answer| answer.installed));
        });
        assert_eq!(alone, 60);
        assert_eq!(batch, 2);
    }

    // Nothing that is not needed is read, and nothing is ever written.
    #[test]
    fn a_batch_reads_no_state_when_no_project_has_the_hooks() {
        let (home, projects) = many_projects("batch-none", 5);
        with_daemon(&home);
        let reads = reads_during(|| {
            let answers = status_many(&home, &projects, &[], &HashMap::new());
            assert!(answers.iter().all(|answer| !answer.installed));
        });
        assert_eq!(reads, 0);
        assert!(!claude_json_path(&home).exists());
        for project in projects.iter() {
            assert!(!settings_path(project).exists());
        }
    }

    // Projects share the account's state file; a batch asked after one's
    // install or removal sees the file as it is then.
    #[test]
    fn a_batch_sees_one_projects_install_and_removal_through_the_shared_state() {
        let (home, projects) = many_projects("batch-shared", 2);
        with_daemon(&home);
        let installed = |home: &Path| -> Vec<bool> {
            status_many(home, &projects, &[], &HashMap::new())
                .iter()
                .map(|answer| answer.installed)
                .collect()
        };
        assert_eq!(installed(&home), [false, false]);
        install(&home, &projects[0], &[], &HashMap::new()).unwrap();
        assert_eq!(installed(&home), [true, false]);
        install(&home, &projects[1], &[], &HashMap::new()).unwrap();
        assert_eq!(installed(&home), [true, true]);
        uninstall(&home, &projects[0], &[], &HashMap::new()).unwrap();
        assert_eq!(installed(&home), [false, true]);
    }

    #[test]
    fn a_batch_of_none_is_none() {
        let (home, _) = fixture("batch-empty");
        assert!(status_many(&home, &[], &[], &HashMap::new()).is_empty());
    }

    #[test]
    fn installs_removals_and_trust_at_the_same_moment_lose_no_entry() {
        let count = 24;
        let (home, projects) = many_projects("concurrent", count);
        with_daemon(&home);
        let accounts = work_account();
        let states = account::claude_jsons(&home, &accounts, &HashMap::new());
        let folders: Vec<PathBuf> = (0..count * 2)
            .map(|at| home.join("trusted").join(format!("folder-{at}")))
            .collect();
        for folder in &folders {
            std::fs::create_dir_all(folder).unwrap();
        }
        // Each run of installs or removals has trust writes for half the
        // folders beside it, on every account's state.
        let run = |projects: &[PathBuf], remove: bool, folders: &[PathBuf]| {
            std::thread::scope(|scope| {
                for project in projects {
                    let (home, accounts) = (&home, &accounts);
                    scope.spawn(move || {
                        if remove {
                            uninstall(home, project, accounts, &HashMap::new()).unwrap();
                        } else {
                            install(home, project, accounts, &HashMap::new()).unwrap();
                        }
                    });
                }
                for folder in folders {
                    for state in &states {
                        scope.spawn(move || claude_trust(state, folder).unwrap());
                    }
                }
            });
        };
        let trusted = |folders: &[PathBuf]| {
            states
                .iter()
                .all(|state| folders.iter().all(|folder| claude_trusts(state, folder)))
        };
        let all = |home: &Path| -> Vec<bool> {
            status_many(home, &projects, &accounts, &HashMap::new())
                .iter()
                .map(|answer| answer.installed)
                .collect()
        };

        let (first, second) = folders.split_at(count);
        run(&projects, false, first);
        assert_eq!(all(&home), vec![true; count]);
        assert!(trusted(first), "a trust write was lost beside installs");

        let (gone, kept) = projects.split_at(count / 2);
        run(gone, true, second);
        let mut expected = vec![false; count / 2];
        expected.extend(vec![true; count - count / 2]);
        assert_eq!(all(&home), expected);
        assert!(kept
            .iter()
            .all(|project| status(&home, project, &accounts, &HashMap::new()).installed));
        assert!(trusted(&folders), "a trust write was lost beside removals");
    }
}
