//! Optional hooks, so the panes hear from the agent rather than guess.
//!
//! Two kinds. A `PostToolUse` hook, so the changes pane hears the moment a
//! tool changed a file; and session hooks, `UserPromptSubmit`, `Stop` and
//! the permission prompt, appended to a log the core tails, so a row says
//! exactly when its agent started, stopped, or asked for permission rather
//! than reading that off the pty. Both agents take the same shape: Claude
//! Code in the project's `.claude/settings.local.json`, Codex in the
//! project's `.codex/hooks.json`, with the same events and the same stdin.
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

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::account::{self, Dirs};

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
    /// Where the settings file is, whether or not it exists yet.
    pub settings: String,
    pub events: String,
}

/// Where session hooks append: one JSON line per event, the hook's stdin as
/// it came. The core tails it; see `activity.rs`.
pub fn activity_path(home: &Path) -> PathBuf {
    home.join(".agent-workbench").join("sessions.jsonl")
}

/// The session events each agent can report, by the agent's own name for
/// them. The permission prompt is the one they spell differently.
const CLAUDE_SESSION_EVENTS: &[&str] = &["UserPromptSubmit", "Stop", "Notification"];
const CODEX_SESSION_EVENTS: &[&str] = &["UserPromptSubmit", "Stop", "PermissionRequest"];

pub fn events_path(home: &Path) -> PathBuf {
    home.join(".agent-workbench").join("last-tool-use.json")
}

/// Where the daemon lives on a machine, which is also the MCP server the
/// agents are pointed at: on a remote the connection runs it from here,
/// and on the desktop the app puts its own build here when the hooks go
/// in. Without one here there is no server to name, and the hooks alone
/// are installed.
pub fn daemon_path(home: &Path) -> PathBuf {
    home.join(".agent-workbench")
        .join("bin")
        .join(if cfg!(windows) {
            "agent-workbench-remote.exe"
        } else {
            "agent-workbench-remote"
        })
}

fn codex_config_path(project: &Path) -> PathBuf {
    project.join(".codex").join("config.toml")
}

/// The files the hooks write in a folder, as paths inside it.
const CLAUDE_LOCAL: &str = ".claude/settings.local.json";
const CODEX_HOOKS: &str = ".codex/hooks.json";
const CODEX_CONFIG: &str = ".codex/config.toml";
const FILES: [&str; 3] = [CLAUDE_LOCAL, CODEX_HOOKS, CODEX_CONFIG];

const SERVER_NAME: &str = "agent-workbench";
const CODEX_SERVER_KEY: &str = "agent_workbench";

fn settings_path(project: &Path) -> PathBuf {
    project.join(".claude").join("settings.local.json")
}

fn codex_hooks_path(project: &Path) -> PathBuf {
    project.join(".codex").join("hooks.json")
}

/// The command a session hook runs: add what the agent said to the log.
fn activity_command(home: &Path) -> String {
    let log = activity_path(home);
    format!(
        "mkdir -p {parent} && cat >> {file}",
        parent = shell_quote(&bash_path(&log.parent().unwrap_or(home).to_string_lossy())),
        file = shell_quote(&bash_path(&log.to_string_lossy())),
    )
}

/// The command the hook runs: replace our file with what the agent just did.
/// Claude Code runs hooks through a POSIX shell on every platform, Git Bash
/// on Windows, so the command is the same everywhere and the paths are
/// spelled the way that shell reads them.
fn command(home: &Path) -> String {
    let events = events_path(home);
    format!(
        "mkdir -p {parent} && cat > {file}",
        parent = shell_quote(&bash_path(
            &events.parent().unwrap_or(home).to_string_lossy()
        )),
        file = shell_quote(&bash_path(&events.to_string_lossy())),
    )
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

fn read_settings(path: &Path) -> Map<String, Value> {
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

fn is_ours(entry: &Value, home: &Path) -> bool {
    let ours = [command(home), activity_command(home)];
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|command| ours.iter().any(|own| own == command))
            })
        })
}

fn has_ours(settings: &Map<String, Value>, event: &str, home: &Path) -> bool {
    settings
        .get("hooks")
        .and_then(|hooks| hooks.get(event))
        .and_then(Value::as_array)
        .is_some_and(|entries| entries.iter().any(|entry| is_ours(entry, home)))
}

/// Adds our entry under an event, leaving whatever else is there alone.
fn add_entry(
    settings: &mut Map<String, Value>,
    event: &str,
    entry: Value,
    home: &Path,
) -> Result<bool, String> {
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
    if entries.iter().any(|entry| is_ours(entry, home)) {
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
pub fn status(home: &Path, project: &Path, accounts: &[Dirs]) -> HookStatus {
    status_many(home, &[project.to_path_buf()], accounts)
        .pop()
        .expect("one answer for one project")
}

/// The status of each project, in the order given. Each account's Claude
/// Code state, which can be large, is read and parsed once for all of
/// them, and only when a project with the hooks in place needs it.
pub fn status_many(home: &Path, projects: &[PathBuf], accounts: &[Dirs]) -> Vec<HookStatus> {
    let daemon_here = daemon_path(home).is_file();
    let events = events_path(home).to_string_lossy().to_string();
    let mut servers: Option<Vec<Map<String, Value>>> = None;
    projects
        .iter()
        .map(|project| {
            let settings = settings_path(project);
            let read = read_settings(&settings);
            let hooks = has_ours(&read, "PostToolUse", home)
                && CLAUDE_SESSION_EVENTS
                    .iter()
                    .all(|event| has_ours(&read, event, home));
            // With a daemon here the server is part of what is installed: a
            // project that got the hooks before there was a server is brought
            // up to date by the next install.
            let installed = hooks
                && (!daemon_here || {
                    let states = servers.get_or_insert_with(|| read_servers(home, accounts));
                    has_server(states, home, project)
                });
            HookStatus {
                installed,
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
) -> Result<(), String> {
    let canonical = |path: &Path| {
        dunce::canonicalize(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .to_string()
    };
    let (from, to) = (canonical(project), canonical(worktree));
    for claude in account::claude_jsons(home, accounts) {
        trust_claude(&claude, &from, &to)?;
    }
    for codex in account::codex_homes(home, accounts) {
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
pub fn install(home: &Path, project: &Path, accounts: &[Dirs]) -> Result<HookStatus, String> {
    add_hooks(home, project, &[])?;
    let listed = sharing(project);
    let mut trees = Vec::new();
    for tree in &listed {
        let leave = tracked(tree);
        if add_hooks(home, tree, &leave).is_ok() {
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
        claude_servers(home, accounts, &folders, gone)?;
        point_codex(home, project)?;
        for (tree, leave) in &trees {
            if !leave.contains(&CODEX_CONFIG) {
                let _ = point_codex(home, tree);
            }
        }
    } else {
        claude_servers(home, accounts, &[], gone)?;
    }
    exclude_from_git(project);
    Ok(status(home, project, accounts))
}

/// Whether the project has the hooks in its own settings, whatever else is
/// or is not in place.
fn has_hooks(home: &Path, project: &Path) -> bool {
    let read = read_settings(&settings_path(project));
    ["PostToolUse"]
        .iter()
        .chain(CLAUDE_SESSION_EVENTS)
        .all(|event| has_ours(&read, event, home))
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
) -> Result<bool, String> {
    if !has_hooks(home, project) || !shares_with(project, worktree) {
        return Ok(false);
    }
    let leave = tracked(worktree);
    add_hooks(home, worktree, &leave)?;
    touch_events(home)?;
    if daemon_path(home).is_file() {
        claude_servers(home, accounts, &[worktree.to_path_buf()], |_| false)?;
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
pub fn forget(home: &Path, worktree: &Path, accounts: &[Dirs]) -> Result<(), String> {
    let key = state_key(worktree);
    claude_servers(home, accounts, &[], |other| other == key)
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
    FILES
        .into_iter()
        .filter(|file| index.get_path(&inside.join(file), 0).is_some())
        .collect()
}

/// Adds the hooks to the agents' settings files in a folder, all but those
/// named in `leave`, which are not read or written.
fn add_hooks(home: &Path, folder: &Path, leave: &[&str]) -> Result<(), String> {
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
            home,
        )?;
        for event in CLAUDE_SESSION_EVENTS {
            changed |= add_entry(&mut settings, event, session_entry(home), home)?;
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
            changed |= add_entry(&mut hooks, event, session_entry(home), home)?;
        }
        if changed {
            write_settings(&codex, &hooks)?;
        }
    }
    Ok(())
}

/// The `projects` of each account's Claude Code state, in the order of the
/// accounts, each file read and parsed once.
fn read_servers(home: &Path, accounts: &[Dirs]) -> Vec<Map<String, Value>> {
    account::claude_jsons(home, accounts)
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
    add: &[PathBuf],
    drop: impl Fn(&str) -> bool,
) -> Result<(), String> {
    let daemon = daemon_path(home).to_string_lossy().to_string();
    let entry = json!({ "type": "stdio", "command": daemon, "args": ["mcp"] });
    let add: Vec<String> = add.iter().map(|folder| state_key(folder)).collect();
    for claude in account::claude_jsons(home, accounts) {
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

/// Points Codex at the daemon as an MCP server in the folder's own config,
/// beside its hooks file.
fn point_codex(home: &Path, folder: &Path) -> Result<(), String> {
    let daemon = daemon_path(home).to_string_lossy().to_string();
    let codex = codex_config_path(folder);
    let text = std::fs::read_to_string(&codex).unwrap_or_default();
    let mut document = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("could not read {}: {e}", codex.display()))?;
    let mut server = toml_edit::Table::new();
    server["command"] = toml_edit::value(daemon.as_str());
    let mut args = toml_edit::Array::new();
    args.push("mcp");
    server["args"] = toml_edit::value(args);
    let servers = document
        .entry("mcp_servers")
        .or_insert(toml_edit::Item::Table(toml_edit::Table::new()));
    let servers = servers
        .as_table_mut()
        .ok_or("the mcp_servers setting is not a table")?;
    servers.set_implicit(true);
    let same = servers
        .get(CODEX_SERVER_KEY)
        .and_then(|item| item.as_table())
        .is_some_and(|table| {
            table.get("command").and_then(|c| c.as_str()) == Some(daemon.as_str())
        });
    if !same {
        servers.insert(CODEX_SERVER_KEY, toml_edit::Item::Table(server));
        if let Some(parent) = codex.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {parent:?}: {e}"))?;
        }
        std::fs::write(&codex, document.to_string())
            .map_err(|e| format!("could not write {}: {e}", codex.display()))?;
    }
    Ok(())
}

/// Takes the server out of the folder's Codex config, and a config that
/// held nothing but it goes too.
fn unpoint_codex(folder: &Path) -> Result<(), String> {
    let codex = codex_config_path(folder);
    if !codex.exists() {
        return Ok(());
    }
    let text = std::fs::read_to_string(&codex).unwrap_or_default();
    let mut document = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("could not read {}: {e}", codex.display()))?;
    let mut changed = false;
    if let Some(servers) = document
        .get_mut("mcp_servers")
        .and_then(|item| item.as_table_mut())
    {
        changed = servers.remove(CODEX_SERVER_KEY).is_some();
        if servers.is_empty() {
            document.remove("mcp_servers");
        }
    }
    if changed {
        if document.as_table().is_empty() {
            std::fs::remove_file(&codex).map_err(|e| format!("could not remove {codex:?}: {e}"))?;
        } else {
            std::fs::write(&codex, document.to_string())
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
pub fn uninstall(home: &Path, project: &Path, accounts: &[Dirs]) -> Result<HookStatus, String> {
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
    claude_servers(home, accounts, &[], |key| key == own || under(&bases, key))?;
    unpoint_codex(project)?;
    for (tree, leave) in &trees {
        if !leave.contains(&CODEX_CONFIG) {
            let _ = unpoint_codex(tree);
        }
    }
    Ok(status(home, project, accounts))
}

/// Removes our entries from the agents' settings files in a folder, all
/// but those named in `leave`, which are not read or written.
fn remove_hooks(home: &Path, folder: &Path, leave: &[&str]) -> Result<(), String> {
    let path = settings_path(folder);
    if path.exists() && !leave.contains(&CLAUDE_LOCAL) {
        let mut settings = read_for_writing(&path)?;
        for event in ["PostToolUse"].iter().chain(CLAUDE_SESSION_EVENTS) {
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
fn update_settings(
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
    let path = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent).map_err(|e| format!("could not create {parent:?}: {e}"))?;
    let text = serde_json::to_string_pretty(&Value::Object(settings.clone()))
        .map_err(|e| format!("could not write settings: {e}"))?;
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
        file.write_all(b"\n")?;
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

    thread_local! {
        /// How many account states `read_servers` has read on this thread.
        pub(super) static STATE_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
        /// How many reads, changes and writes of a state file this thread
        /// has made.
        pub(super) static STATE_CHANGES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    fn claude_json_path(home: &Path) -> PathBuf {
        account::claude_json(home, None)
    }

    fn fixture(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("workbench-hook-{name}"));
        std::fs::remove_dir_all(&base).ok();
        let home = base.join("home");
        let project = base.join("project");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        (home, project)
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
        let error = install(&home, &project, &[]).unwrap_err();
        assert!(error.contains("leaving it alone"), "{error}");
        assert_eq!(
            std::fs::read_to_string(claude_json_path(&home)).unwrap(),
            "{\"projects\": {\"/a\": {\"hasTrust"
        );
        // The project's own settings, the same.
        std::fs::write(claude_json_path(&home), "{}").unwrap();
        std::fs::create_dir_all(settings_path(&project).parent().unwrap()).unwrap();
        std::fs::write(settings_path(&project), "[1, 2").unwrap();
        let error = install(&home, &project, &[]).unwrap_err();
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
        trust_like(&home, &project, &worktree, &[]).unwrap();
        assert!(!claude_json_path(&home).exists());
        assert!(!crate::codex::home(&home).join("config.toml").exists());

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
        let codex = crate::codex::home(&home).join("config.toml");
        std::fs::create_dir_all(codex.parent().unwrap()).unwrap();
        std::fs::write(
            &codex,
            format!(
                "model = \"o3\"\n\n[projects.'{}']\ntrust_level = \"trusted\"\n",
                key(&project)
            ),
        )
        .unwrap();
        trust_like(&home, &project, &worktree, &[]).unwrap();
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
        let other = project.parent().unwrap().join("other");
        let tree = other.join("tree");
        std::fs::create_dir_all(&tree).unwrap();
        trust_like(&home, &other, &tree, &[]).unwrap();
        let state = read_settings(&claude_json_path(&home));
        assert!(state["projects"].get(key(&tree)).is_none());
    }

    fn settings_of(project: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(settings_path(project)).unwrap()).unwrap()
    }

    #[test]
    fn reports_not_installed_when_there_are_no_settings() {
        let (home, project) = fixture("none");
        assert!(!status(&home, &project, &[]).installed);
    }

    #[test]
    fn keeps_both_files_out_of_the_repository() {
        let (home, project) = fixture("exclude");
        git2::Repository::init(&project).unwrap();
        install(&home, &project, &[]).unwrap();
        install(&home, &project, &[]).unwrap();
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
        install(&home, &sub, &[]).unwrap();
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
        install(&home, &project, &[]).unwrap();

        let key = dunce::canonicalize(&project)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let state = read_settings(&claude_json_path(&home));
        let server = &state["projects"][&key]["mcpServers"]["agent-workbench"];
        assert_eq!(server["args"], json!(["mcp"]));
        assert_eq!(
            server["command"].as_str().unwrap(),
            daemon_path(&home).to_string_lossy()
        );
        let codex = std::fs::read_to_string(project.join(".codex/config.toml")).unwrap();
        assert!(codex.contains("model = \"o3\""));
        assert!(codex.contains("[mcp_servers.other]"));
        assert!(codex.contains("[mcp_servers.agent_workbench]"));
        assert!(codex.contains("args = [\"mcp\"]"));

        uninstall(&home, &project, &[]).unwrap();
        let state = read_settings(&claude_json_path(&home));
        assert!(state["projects"][&key]["mcpServers"]
            .get("agent-workbench")
            .is_none());
        let codex = std::fs::read_to_string(project.join(".codex/config.toml")).unwrap();
        assert!(codex.contains("[mcp_servers.other]"));
        assert!(!codex.contains("agent_workbench"));
    }

    #[test]
    fn a_codex_config_of_only_the_server_goes_with_it() {
        let (home, project) = fixture("server-only");
        with_daemon(&home);
        install(&home, &project, &[]).unwrap();
        assert!(project.join(".codex/config.toml").exists());
        uninstall(&home, &project, &[]).unwrap();
        assert!(!project.join(".codex/config.toml").exists());
    }

    #[test]
    fn without_a_daemon_here_only_the_hooks_go_in() {
        let (home, project) = fixture("no-daemon");
        install(&home, &project, &[]).unwrap();
        assert!(!claude_json_path(&home).exists());
        assert!(!project.join(".codex/config.toml").exists());
        assert!(status(&home, &project, &[]).installed);
    }

    // Hooks from before there was a server: once a daemon is here, they
    // read as not installed until the server is put in with them.
    #[test]
    fn a_daemon_arriving_later_asks_for_the_server() {
        let (home, project) = fixture("daemon-later");
        install(&home, &project, &[]).unwrap();
        with_daemon(&home);
        assert!(!status(&home, &project, &[]).installed);
        install(&home, &project, &[]).unwrap();
        assert!(status(&home, &project, &[]).installed);
    }

    #[test]
    fn installs_and_reports_itself() {
        let (home, project) = fixture("install");
        assert!(install(&home, &project, &[]).unwrap().installed);
        assert!(status(&home, &project, &[]).installed);
    }

    // The untracked settings file, so nobody finds this in a diff.
    #[test]
    fn writes_to_settings_local_not_the_shared_one() {
        let (home, project) = fixture("local");
        install(&home, &project, &[]).unwrap();

        assert!(project.join(".claude/settings.local.json").exists());
        assert!(!project.join(".claude/settings.json").exists());
    }

    #[test]
    fn only_reacts_to_tools_that_change_files() {
        let (home, project) = fixture("matcher");
        install(&home, &project, &[]).unwrap();

        let entry = &settings_of(&project)["hooks"]["PostToolUse"][0];
        assert_eq!(entry["matcher"], MATCHER);
        assert!(!MATCHER.contains("Read"));
    }

    #[test]
    fn writes_outside_the_project() {
        let (home, project) = fixture("outside");
        install(&home, &project, &[]).unwrap();

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
            assert_eq!(
                bash_path(r"C:\Users\ada\.agent-workbench"),
                "C:/Users/ada/.agent-workbench"
            );
        } else {
            assert_eq!(
                bash_path("/home/ada/.agent-workbench"),
                "/home/ada/.agent-workbench"
            );
        }
    }

    #[test]
    fn installing_twice_adds_one_entry() {
        let (home, project) = fixture("twice");
        install(&home, &project, &[]).unwrap();
        install(&home, &project, &[]).unwrap();

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

        install(&home, &project, &[]).unwrap();
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

        install(&home, &project, &[]).unwrap();
        let entries = settings_of(&project)["hooks"]["PostToolUse"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(entries.len(), 2);

        uninstall(&home, &project, &[]).unwrap();
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
        install(&home, &project, &[]).unwrap();
        assert!(!uninstall(&home, &project, &[]).unwrap().installed);
    }

    // Nothing left behind that was not there before.
    #[test]
    fn uninstalling_the_only_hook_leaves_no_empty_scaffolding() {
        let (home, project) = fixture("scaffolding");
        install(&home, &project, &[]).unwrap();
        uninstall(&home, &project, &[]).unwrap();

        let settings = settings_of(&project);
        assert!(settings.get("hooks").is_none(), "{settings}");
    }

    #[test]
    fn uninstalling_when_it_was_never_there_is_not_an_error() {
        let (home, project) = fixture("absent");
        assert!(!uninstall(&home, &project, &[]).unwrap().installed);
    }

    #[test]
    fn refuses_a_settings_file_that_is_not_json_rather_than_replace_it() {
        let (home, project) = fixture("broken");
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        std::fs::write(settings_path(&project), "{ not json").unwrap();

        // The file may be one being written, or one the user is mid-way
        // through: it is theirs, and not ours to start over.
        let error = install(&home, &project, &[]).unwrap_err();
        assert!(error.contains("leaving it alone"), "{error}");
        assert_eq!(
            std::fs::read_to_string(settings_path(&project)).unwrap(),
            "{ not json"
        );
        assert!(!status(&home, &project, &[]).installed);
    }

    #[test]
    fn quotes_a_path_with_a_space_in_it() {
        assert_eq!(shell_quote("/a b/c"), "'/a b/c'");
        assert_eq!(shell_quote("/it's"), r"'/it'\''s'");
    }

    #[test]
    fn the_events_file_lives_under_the_home_directory() {
        let path = events_path(Path::new("/home/ada"));
        assert_eq!(
            path,
            Path::new("/home/ada/.agent-workbench/last-tool-use.json")
        );
    }

    // The watcher can only attach to a file that exists.
    #[test]
    fn installing_creates_the_events_file() {
        let (home, project) = fixture("touch");
        install(&home, &project, &[]).unwrap();
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
        install(&home, &project, &[]).unwrap();

        let claude = settings_of(&project);
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
        assert!(status(&home, &project, &[]).installed);
    }

    #[test]
    fn uninstalling_takes_the_session_hooks_too_and_an_empty_codex_file_with_them() {
        let (home, project) = fixture("sessions-off");
        install(&home, &project, &[]).unwrap();
        uninstall(&home, &project, &[]).unwrap();
        assert!(settings_of(&project).get("hooks").is_none());
        assert!(!codex_hooks_path(&project).exists());
        assert!(!status(&home, &project, &[]).installed);
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
        install(&home, &project, &[]).unwrap();
        let hooks = codex_hooks_of(&project);
        assert_eq!(hooks["hooks"]["Stop"].as_array().unwrap().len(), 2);
        uninstall(&home, &project, &[]).unwrap();
        let hooks = codex_hooks_of(&project);
        assert_eq!(hooks["description"], "mine");
        assert_eq!(hooks["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(hooks["hooks"]["Stop"][0]["hooks"][0]["command"], "say done");
    }

    #[test]
    fn is_not_installed_until_every_hook_is_there() {
        let (home, project) = fixture("partial");
        install(&home, &project, &[]).unwrap();
        let mut settings = read_settings(&settings_path(&project));
        remove_entries(&mut settings, "Stop", &home);
        write_settings(&settings_path(&project), &settings).unwrap();
        assert!(!status(&home, &project, &[]).installed);
        install(&home, &project, &[]).unwrap();
        assert!(status(&home, &project, &[]).installed);
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
        install(&home, &project, &[]).unwrap();

        let tree = PathBuf::from(crate::git::worktree_add(&project, "fix").unwrap());
        assert!(share(&home, &project, &tree, &[]).unwrap());

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
        assert!(!share(&home, &project, &tree, &[]).unwrap());
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
        assert!(!share(&home, &project, &tree, &[]).unwrap());

        install(&home, &project, &[]).unwrap();
        assert!(has_hooks(&home, &tree));
        assert!(server_for(&home, &tree).is_some());
        assert_eq!(porcelain(&tree), "");

        uninstall(&home, &project, &[]).unwrap();
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
        install(&home, &project, &[]).unwrap();
        let tree = PathBuf::from(crate::git::worktree_add(&project, "fix").unwrap());
        share(&home, &project, &tree, &[]).unwrap();

        // The hooks' files are no work of the tree's: it still goes.
        crate::git::worktree_remove(&project, "fix").unwrap();
        assert!(!tree.exists());
        assert!(server_for(&home, &tree).is_some());
        forget(&home, &tree, &[]).unwrap();
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

        install(&home, &project, &[]).unwrap();
        assert!(!gone.exists(), "the deleted folder stays deleted");
        assert!(!hollow.join(".claude").exists());
        assert!(!hollow.join(".codex").exists());
        assert!(server_for(&home, &gone).is_none());
        assert!(server_for(&home, &hollow).is_none());
        assert!(!share(&home, &project, &gone, &[]).unwrap());
        assert!(!gone.exists());

        uninstall(&home, &project, &[]).unwrap();
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
        install(&home, &project, &[]).unwrap();
        let excluded = std::fs::read_to_string(&exclude).unwrap();

        let tree = PathBuf::from(crate::git::worktree_add(&project, "fix").unwrap());
        assert!(!share(&home, &project, &tree, &[]).unwrap());
        install(&home, &project, &[]).unwrap();
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

        uninstall(&home, &project, &[]).unwrap();
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
        install(&home, &project, &[]).unwrap();
        let kept = PathBuf::from(crate::git::worktree_add(&project, "kept").unwrap());
        let removed = PathBuf::from(crate::git::worktree_add(&project, "removed").unwrap());
        share(&home, &project, &kept, &[]).unwrap();
        share(&home, &project, &removed, &[]).unwrap();
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

        install(&home, &project, &[]).unwrap();
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
        uninstall(&home, &project, &[]).unwrap();
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
                install(&home, &project, &accounts).unwrap();
            }),
            2
        );
        for tree in &trees {
            assert!(has_hooks(&home, tree));
            assert!(status(&home, tree, &accounts).installed);
        }
        assert_eq!(
            changes_during(|| {
                uninstall(&home, &project, &accounts).unwrap();
            }),
            2
        );
        for tree in &trees {
            assert!(!has_hooks(&home, tree));
            assert!(server_for(&home, tree).is_none());
        }
    }

    fn many_projects(name: &str, count: usize) -> (PathBuf, Vec<PathBuf>) {
        let (home, first) = fixture(name);
        let base = first.parent().unwrap().to_path_buf();
        let mut projects = vec![first];
        for at in 1..count {
            let project = base.join(format!("project-{at}"));
            std::fs::create_dir_all(&project).unwrap();
            projects.push(project);
        }
        (home, projects)
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
        install(&home, &projects[0], &accounts).unwrap();
        // Hooks without the server, as a setup from before the server has.
        install(&home, &projects[1], &accounts).unwrap();
        let mut state = read_settings(&claude_json_path(&home));
        let key = dunce::canonicalize(&projects[1]).unwrap();
        state["projects"]
            .as_object_mut()
            .unwrap()
            .remove(key.to_string_lossy().as_ref());
        write_settings(&claude_json_path(&home), &state).unwrap();

        let batch = status_many(&home, &projects, &accounts);
        assert_eq!(batch.len(), projects.len());
        for (project, answer) in projects.iter().zip(&batch) {
            let alone = status(&home, project, &accounts);
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
        for project in &projects {
            install(&home, project, &accounts).unwrap();
        }

        let alone = reads_during(|| {
            for project in &projects {
                assert!(status(&home, project, &accounts).installed);
            }
        });
        let batch = reads_during(|| {
            let answers = status_many(&home, &projects, &accounts);
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
            let answers = status_many(&home, &projects, &[]);
            assert!(answers.iter().all(|answer| !answer.installed));
        });
        assert_eq!(reads, 0);
        assert!(!claude_json_path(&home).exists());
        for project in &projects {
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
            status_many(home, &projects, &[])
                .iter()
                .map(|answer| answer.installed)
                .collect()
        };
        assert_eq!(installed(&home), [false, false]);
        install(&home, &projects[0], &[]).unwrap();
        assert_eq!(installed(&home), [true, false]);
        install(&home, &projects[1], &[]).unwrap();
        assert_eq!(installed(&home), [true, true]);
        uninstall(&home, &projects[0], &[]).unwrap();
        assert_eq!(installed(&home), [false, true]);
    }

    #[test]
    fn a_batch_of_none_is_none() {
        let (home, _) = fixture("batch-empty");
        assert!(status_many(&home, &[], &[]).is_empty());
    }

    #[test]
    fn installs_removals_and_trust_at_the_same_moment_lose_no_entry() {
        let count = 24;
        let (home, projects) = many_projects("concurrent", count);
        with_daemon(&home);
        let accounts = work_account();
        let states = account::claude_jsons(&home, &accounts);
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
                            uninstall(home, project, accounts).unwrap();
                        } else {
                            install(home, project, accounts).unwrap();
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
            status_many(home, &projects, &accounts)
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
            .all(|project| status(&home, project, &accounts).installed));
        assert!(trusted(&folders), "a trust write was lost beside removals");
    }
}
