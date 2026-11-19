//! Moves an install made under the app's earlier name, Agent Workbench, to
//! Chord's names, once, the first time Chord runs on a machine. This is the
//! one place in the app that knows the earlier names.
//!
//! What moves:
//!
//! - **The folder.** `~/.agent-workbench` becomes `~/.chord`, and a link is
//!   left at the old path, so paths written into files the app does not
//!   own still lead somewhere. A folder that is itself a link, to dotfiles,
//!   moves as a link. When `~/.chord` is there already, what it lacks is
//!   moved into it, and whatever both hold is kept in its `kept-from-before`
//!   folder. When the folder cannot be moved, nothing is, and the app keeps
//!   to the old folder for that run and tries again on the next.
//! - **The orchestrator folder's identity.** It is inside the folder, and
//!   the agents know a folder by its resolved path. Claude Code's
//!   transcript folders for it, its entry in each Claude Code state file
//!   and its trust in each Codex config are carried to the new path.
//! - **The tool server's name.** Every entry the app wrote under the old
//!   name, in each Claude Code state file, each Codex config and each
//!   project's hook and server files, is renamed and pointed at the
//!   renamed daemon, and the user's permission rules and Codex tool
//!   approvals that name the old server name the new one, each kept as it
//!   was.
//! - **The daemon.** The forced commands pairing wrote into
//!   `~/.ssh/authorized_keys` run the renamed daemon, and the old build is
//!   removed.
//! - **The app's own files** that hold paths into the folder say the new
//!   path.
//!
//! Every file changed is listed in `migration.md` in the folder, which is
//! written last and says the migration is done. A run cut off before it is
//! done again: each step only changes what is still in its old form, so a
//! second run changes nothing. Projects are checked again whenever one is
//! opened, for files the first run could not find, and what that changes
//! is added to the note.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::account::{self, Dirs};
use crate::hook;

/// The folder's earlier name.
const OLD_DIR: &str = ".agent-workbench";
/// The tool server's earlier name, to Claude Code and as Codex's key.
const OLD_SERVER: &str = "agent-workbench";
const OLD_SERVER_KEY: &str = "agent_workbench";
/// The daemon's earlier file name.
const OLD_DAEMON: &str = "agent-workbench-remote";
/// The comment on the daemon's line in authorized_keys.
const OLD_KEY_COMMENT: &str = "agent-workbench";

/// The note the migration leaves, in the folder.
pub const NOTE: &str = "migration.md";
/// Where what both folders held is kept, in the folder.
const KEPT: &str = "kept-from-before";

/// What a migration changed, a line for each file.
#[derive(Default)]
struct Changes(Vec<String>);

impl Changes {
    fn add(&mut self, path: &Path, what: &str) {
        self.0.push(format!("- `{}`: {what}", path.display()));
    }
}

/// Whether there is an install under `home` to move over, or one whose
/// move was cut off. Cheap enough to ask at every start.
pub fn needed(home: &Path) -> bool {
    let (old, new) = (home.join(OLD_DIR), home.join(crate::home::DIR));
    std::fs::symlink_metadata(&old).is_ok_and(|meta| meta.is_dir() || meta.file_type().is_symlink())
        && !(points_at(&old, &new) && new.join(NOTE).exists())
}

/// Moves the install under `home` over, when there is one to move.
/// `daemon` is the daemon the pairings' forced commands should run. Says
/// where the note is when this run wrote one.
pub fn run(
    home: &Path,
    daemon: &Path,
    env: &HashMap<String, String>,
) -> Result<Option<PathBuf>, String> {
    let old = home.join(OLD_DIR);
    let new = home.join(crate::home::DIR);
    let mut changes = Changes::default();
    if !needed(home) {
        return Ok(None);
    }
    let Ok(meta) = std::fs::symlink_metadata(&old) else {
        return Ok(None);
    };
    // The resolved path the agents knew the orchestrator folder by: the old
    // folder's own, or, once it is a link to the new one, where it was.
    let old_orchestrator = if points_at(&old, &new) {
        canonical(home).join(OLD_DIR)
    } else {
        canonical(&old)
    }
    .join("orchestrator");
    if meta.file_type().is_symlink() {
        if !points_at(&old, &new) {
            move_link(&old, &new, &mut changes)?;
        }
    } else if std::fs::symlink_metadata(&new).is_err() {
        if let Err(error) = std::fs::rename(&old, &new) {
            crate::home::keep_using(home, Some(old.clone()));
            return Err(format!(
                "could not move {} to {}, so it is used as it is: {error}",
                old.display(),
                new.display()
            ));
        }
        changes.add(&new, &format!("moved here from `{}`", old.display()));
        link(&old, &mut changes);
    } else {
        merge_folders(&old, &new, &mut changes)?;
        link(&old, &mut changes);
    }
    crate::home::keep_using(home, None);

    let accounts = accounts(home);
    let new_orchestrator = canonical(&new).join("orchestrator");
    if old_orchestrator != new_orchestrator {
        carry_orchestrator(
            home,
            &accounts,
            env,
            &old_orchestrator,
            &new_orchestrator,
            &mut changes,
        );
    }
    let mut projects = vec![new_orchestrator];
    for state in account::claude_jsons(home, &accounts, env) {
        rename_in_json(home, &state, &mut changes);
        projects.extend(project_keys(&hook::read_settings(&state)));
    }
    for codex in account::codex_homes(home, &accounts, env) {
        let config = codex.join("config.toml");
        rename_in_codex(home, &config, &mut changes);
        projects.extend(codex_projects(&config));
    }
    for dir in claude_dirs(home, &accounts, env) {
        for file in ["settings.json", "settings.local.json"] {
            rename_in_json(home, &dir.join(file), &mut changes);
        }
    }
    projects.sort();
    projects.dedup();
    for folder in projects.iter().filter(|folder| folder.is_dir()) {
        project_files(home, folder, &mut changes);
    }
    own_files(&old, &new, &mut changes);
    authorized_keys(home, daemon, &mut changes)?;
    old_daemon(&new, &mut changes);

    let note = new.join(NOTE);
    hook::write_whole(&note, &note_text(&old, &new, &changes))?;
    Ok(Some(note))
}

/// Brings a project's own files over, when it is opened: the hooks, the
/// tool server's entries and the permission rules that still carry the
/// earlier names. Adds what it changed to the note.
pub fn project(home: &Path, folder: &Path) {
    let mut changes = Changes::default();
    project_files(home, folder, &mut changes);
    if changes.0.is_empty() {
        return;
    }
    let note = crate::home::dir(home).join(NOTE);
    let mut text = std::fs::read_to_string(&note).unwrap_or_default();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    for line in changes.0 {
        text.push_str(&line);
        text.push('\n');
    }
    let _ = hook::write_whole(&note, &text);
}

fn canonical(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Whether the link at `link` leads to `folder`.
fn points_at(link: &Path, folder: &Path) -> bool {
    std::fs::read_link(link).is_ok_and(|to| to == Path::new(crate::home::DIR) || to == folder)
        || (folder.exists() && canonical(link) == canonical(folder))
}

/// Moves a folder that is a link to elsewhere, as dotfiles make: the new
/// name becomes the same link, and the old one a link to the new.
fn move_link(old: &Path, new: &Path, changes: &mut Changes) -> Result<(), String> {
    if std::fs::symlink_metadata(new).is_ok() {
        return Err(format!(
            "{} is a link and {} is there too; move what you need by hand",
            old.display(),
            new.display()
        ));
    }
    let to =
        std::fs::read_link(old).map_err(|e| format!("could not read {}: {e}", old.display()))?;
    make_link(&to, new).map_err(|e| format!("could not link {}: {e}", new.display()))?;
    changes.add(
        new,
        &format!(
            "made a link to `{}`, as `{}` was",
            to.display(),
            old.display()
        ),
    );
    std::fs::remove_file(old).map_err(|e| format!("could not remove {}: {e}", old.display()))?;
    link(old, changes);
    Ok(())
}

/// Leaves a link at the old path to the new folder.
fn link(old: &Path, changes: &mut Changes) {
    match make_link(Path::new(crate::home::DIR), old) {
        Ok(()) => changes.add(old, "now a link to `.chord`"),
        Err(error) => changes.add(old, &format!("no link could be made here: {error}")),
    }
}

#[cfg(unix)]
fn make_link(to: &Path, at: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(to, at)
}

#[cfg(windows)]
fn make_link(to: &Path, at: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(to, at)
}

/// Moves into `new` what it lacks of `old`, folder by folder. What both
/// hold stays as `new` has it, and `old`'s copy goes, with whatever else
/// is left of `old`, to the kept folder.
fn merge_folders(old: &Path, new: &Path, changes: &mut Changes) -> Result<(), String> {
    let mut clashes = Vec::new();
    merge(old, new, &mut clashes, changes);
    if std::fs::remove_dir(old).is_ok() {
        return Ok(());
    }
    let mut kept = new.join(KEPT);
    let mut n = 1;
    while kept.exists() {
        n += 1;
        kept = new.join(format!("{KEPT}-{n}"));
    }
    std::fs::rename(old, &kept).map_err(|e| {
        format!(
            "could not move {} to {}: {e}",
            old.display(),
            kept.display()
        )
    })?;
    let clashes = clashes
        .iter()
        .map(|path| format!("`{path}`"))
        .collect::<Vec<_>>()
        .join(", ");
    changes.add(
        &kept,
        &format!("what `.chord` held already, as the old folder had it: {clashes}"),
    );
    Ok(())
}

fn merge(old: &Path, new: &Path, clashes: &mut Vec<String>, changes: &mut Changes) {
    let Ok(entries) = std::fs::read_dir(old) else {
        return;
    };
    for entry in entries.flatten() {
        let from = entry.path();
        let to = new.join(entry.file_name());
        let both_folders = entry.file_type().is_ok_and(|kind| kind.is_dir())
            && std::fs::symlink_metadata(&to).is_ok_and(|meta| meta.is_dir());
        if std::fs::symlink_metadata(&to).is_err() {
            if std::fs::rename(&from, &to).is_ok() {
                changes.add(&to, &format!("moved here from `{}`", from.display()));
            }
        } else if both_folders {
            merge(&from, &to, clashes, changes);
            let _ = std::fs::remove_dir(&from);
        } else {
            clashes.push(entry.file_name().to_string_lossy().to_string());
        }
    }
}

/// The accounts the settings name, read from the file as it is, since the
/// migration runs before anything else reads it.
fn accounts(home: &Path) -> Vec<Dirs> {
    let settings = hook::read_settings(&crate::home::dir(home).join("settings.json"));
    let Some(list) = settings
        .get("accounts")
        .and_then(|accounts| accounts.get("list"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    let text = |account: &Value, agent: &str| {
        account
            .get(agent)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    list.values()
        .map(|account| Dirs {
            claude: text(account, "claude"),
            codex: text(account, "codex"),
        })
        .collect()
}

/// Each account's Claude Code configuration folder, once each.
fn claude_dirs(home: &Path, accounts: &[Dirs], env: &HashMap<String, String>) -> Vec<PathBuf> {
    let mut dirs = vec![account::claude_dir(home, None, env)];
    for account in accounts {
        let dir = account::claude_dir(home, account.claude.as_deref(), env);
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// The keys Claude Code may file a folder under: as resolved, and with
/// forward slashes.
fn keys(folder: &Path) -> Vec<String> {
    let mut keys = vec![folder.to_string_lossy().to_string()];
    let forward = keys[0].replace('\\', "/");
    if forward != keys[0] {
        keys.push(forward);
    }
    keys
}

/// Carries the orchestrator folder's identity from `from` to `to`.
fn carry_orchestrator(
    home: &Path,
    accounts: &[Dirs],
    env: &HashMap<String, String>,
    from: &Path,
    to: &Path,
    changes: &mut Changes,
) {
    let (old_name, new_name) = (
        crate::transcripts::mangle(from),
        crate::transcripts::mangle(to),
    );
    for dir in claude_dirs(home, accounts, env) {
        let projects = dir.join("projects");
        let Ok(entries) = std::fs::read_dir(&projects) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(rest) = name.strip_prefix(&old_name) else {
                continue;
            };
            if !(rest.is_empty() || rest.starts_with('-')) {
                continue;
            }
            let target = projects.join(format!("{new_name}{rest}"));
            if std::fs::symlink_metadata(&target).is_err() {
                if std::fs::rename(entry.path(), &target).is_ok() {
                    changes.add(
                        &target,
                        &format!("Claude Code's transcripts, moved from `{name}`"),
                    );
                }
            } else {
                let mut clashes = Vec::new();
                let mut moved = Changes::default();
                merge(&entry.path(), &target, &mut clashes, &mut moved);
                let _ = std::fs::remove_dir(entry.path());
                changes.add(
                    &target,
                    &format!(
                        "Claude Code's transcripts from `{name}` added, {} of them",
                        moved.0.len()
                    ),
                );
            }
        }
    }
    let pairs: Vec<(String, String)> = keys(from).into_iter().zip(keys(to)).collect();
    for state in account::claude_jsons(home, accounts, env) {
        let mut moved = false;
        let result = hook::update_settings(&state, |state| {
            let Some(projects) = state.get_mut("projects").and_then(Value::as_object_mut) else {
                return Ok(false);
            };
            for (from, to) in &pairs {
                let Some(entry) = projects.remove(from) else {
                    continue;
                };
                match projects.get_mut(to).and_then(Value::as_object_mut) {
                    Some(there) => {
                        if let Value::Object(entry) = entry {
                            for (key, value) in entry {
                                there.entry(key).or_insert(value);
                            }
                        }
                    }
                    None => {
                        projects.insert(to.clone(), entry);
                    }
                }
                moved = true;
            }
            Ok(moved)
        });
        if moved && result.is_ok() {
            changes.add(
                &state,
                "the orchestrator folder's entry, its trust with it, moved to the new path",
            );
        }
    }
    for codex in account::codex_homes(home, accounts, env) {
        let config = codex.join("config.toml");
        edit_codex(
            &config,
            changes,
            "the orchestrator folder's trust moved to its new path",
            |document| {
                let Some(projects) = document
                    .get_mut("projects")
                    .and_then(|item| item.as_table_like_mut())
                else {
                    return false;
                };
                let mut changed = false;
                for (from, to) in &pairs {
                    if let Some(entry) = projects.remove(from) {
                        if projects.get(to).is_none() {
                            projects.insert(to, entry);
                        }
                        changed = true;
                    }
                }
                changed
            },
        );
    }
}

/// The folders a Claude Code state file has entries for.
fn project_keys(state: &Map<String, Value>) -> Vec<PathBuf> {
    state
        .get("projects")
        .and_then(Value::as_object)
        .map(|projects| projects.keys().map(PathBuf::from).collect())
        .unwrap_or_default()
}

/// The folders a Codex config has entries for.
fn codex_projects(config: &Path) -> Vec<PathBuf> {
    std::fs::read_to_string(config)
        .ok()
        .and_then(|text| hook::parse_codex(&text).ok())
        .and_then(|document| {
            document
                .get("projects")
                .and_then(|item| item.as_table_like())
                .map(|projects| projects.iter().map(|(key, _)| PathBuf::from(key)).collect())
        })
        .unwrap_or_default()
}

/// Whether a command is a daemon of this app's, under either name.
fn runs_daemon(command: &str) -> bool {
    let name = Path::new(command)
        .file_stem()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    name == OLD_DAEMON || name == "chord-remote"
}

/// Renames what carries the server's old name in a JSON settings value:
/// the server's entries whose command is the daemon, the names in lists of
/// servers, the permission rules, and the hooks' commands.
fn rename_value(value: &mut Value, commands: &[(String, String)], daemon: &str) -> bool {
    let mut changed = false;
    match value {
        Value::Object(map) => {
            if let Some(entry) = map.get(OLD_SERVER) {
                let ours = entry
                    .get("command")
                    .and_then(Value::as_str)
                    .is_some_and(runs_daemon);
                if ours {
                    let mut entry = map.remove(OLD_SERVER).unwrap_or(Value::Null);
                    entry["command"] = Value::from(daemon);
                    map.entry(crate::adapter::SERVER_NAME).or_insert(entry);
                    changed = true;
                }
            }
            if let Some(Value::String(command)) = map.get_mut("command") {
                if let Some((_, new)) = commands.iter().find(|(old, _)| old == command) {
                    *command = new.clone();
                    changed = true;
                }
            }
            for item in map.values_mut() {
                changed |= rename_value(item, commands, daemon);
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                if let Value::String(text) = item {
                    if text == OLD_SERVER {
                        *text = crate::adapter::SERVER_NAME.to_string();
                        changed = true;
                    } else if let Some(renamed) = renamed_rule(text) {
                        *text = renamed;
                        changed = true;
                    }
                } else {
                    changed |= rename_value(item, commands, daemon);
                }
            }
            if changed {
                let mut seen = Vec::new();
                items.retain(|item| {
                    let keep = !seen.contains(item);
                    if keep {
                        seen.push(item.clone());
                    }
                    keep
                });
            }
        }
        _ => {}
    }
    changed
}

/// A permission rule for the old server, for the new one: `mcp__` and the
/// server's name, alone or before `__` and a tool or a pattern.
fn renamed_rule(rule: &str) -> Option<String> {
    let rest = rule.strip_prefix(&format!("mcp__{OLD_SERVER}"))?;
    (rest.is_empty() || rest.starts_with("__") || rest.starts_with('('))
        .then(|| format!("mcp__{}{rest}", crate::adapter::SERVER_NAME))
}

/// The commands the hooks ran under the old names, each with the command
/// they run now. A run that kept to the old folder wrote the new daemon's
/// name under it, so that form is known too.
fn hook_commands(home: &Path) -> Vec<(String, String)> {
    let old = home.join(OLD_DIR);
    let new = hook::commands_at(&crate::home::dir(home), &hook::daemon_path(home));
    let daemon_file = |name: &str| {
        if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        }
    };
    let mut pairs = Vec::new();
    for daemon in [daemon_file(OLD_DAEMON), hook::DAEMON_FILE.to_string()] {
        let before = hook::commands_at(&old, &old.join("bin").join(&daemon));
        for (old, new) in before.into_iter().zip(new.iter()) {
            if &old != new {
                pairs.push((old, new.clone()));
            }
        }
    }
    let renamed_only = hook::commands_at(
        &crate::home::dir(home),
        &crate::home::dir(home)
            .join("bin")
            .join(daemon_file(OLD_DAEMON)),
    );
    for (old, new) in renamed_only.into_iter().zip(new.iter()) {
        if &old != new {
            pairs.push((old, new.clone()));
        }
    }
    pairs
}

/// Renames in a JSON file the app or the user keeps, when it names the old
/// server or folder.
fn rename_in_json(home: &Path, path: &Path, changes: &mut Changes) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    if !text.contains(OLD_SERVER) {
        return;
    }
    let commands = hook_commands(home);
    let daemon = hook::daemon_path(home).to_string_lossy().to_string();
    let mut did = false;
    let result = hook::update_settings(path, |settings| {
        let mut value = Value::Object(std::mem::take(settings));
        did = rename_value(&mut value, &commands, &daemon);
        if let Value::Object(map) = value {
            *settings = map;
        }
        if did {
            dedupe_hooks(settings);
        }
        Ok(did)
    });
    if did && result.is_ok() {
        changes.add(
            path,
            "the tool server's old name and the hooks' old paths changed to the new, rules kept as allow, ask or deny",
        );
    }
}

/// Removes a hook entry of the app's that an event holds twice, as it does
/// where the old entry, renamed, meets the one a newer install added.
fn dedupe_hooks(settings: &mut Map<String, Value>) {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };
    for entries in hooks.values_mut().filter_map(Value::as_array_mut) {
        let mut seen: Vec<Value> = Vec::new();
        entries.retain(|entry| {
            if seen.contains(entry) {
                return false;
            }
            seen.push(entry.clone());
            true
        });
    }
}

/// Edits a Codex config with `change`, written back as the file was, and
/// notes `what` when it changed.
fn edit_codex(
    config: &Path,
    changes: &mut Changes,
    what: &str,
    change: impl FnOnce(&mut toml_edit::DocumentMut) -> bool,
) {
    let Ok(text) = std::fs::read_to_string(config) else {
        return;
    };
    let Ok(mut document) = hook::parse_codex(&text) else {
        return;
    };
    if change(&mut document)
        && hook::write_whole(config, &hook::as_the_file_was(&text, document.to_string())).is_ok()
    {
        changes.add(config, what);
    }
}

/// Renames the server's table in a Codex config: its command, when it is
/// the daemon, and its tools' approvals with it.
fn rename_in_codex(home: &Path, config: &Path, changes: &mut Changes) {
    let daemon = hook::daemon_path(home).to_string_lossy().to_string();
    edit_codex(
        config,
        changes,
        "the tool server's table renamed, its tools' approvals as they were",
        |document| {
            let Some(servers) = document
                .get_mut("mcp_servers")
                .and_then(|item| item.as_table_like_mut())
            else {
                return false;
            };
            let Some(mut entry) = servers.remove(OLD_SERVER_KEY) else {
                return false;
            };
            if let Some(table) = entry.as_table_like_mut() {
                let ours = table
                    .get("command")
                    .and_then(|command| command.as_str())
                    .is_some_and(runs_daemon);
                if let Some(command) = table.get_mut("command").filter(|_| ours) {
                    let decor = command.as_value().map(|value| value.decor().clone());
                    *command = toml_edit::value(daemon.as_str());
                    if let (Some(decor), Some(value)) = (decor, command.as_value_mut()) {
                        *value.decor_mut() = decor;
                    }
                }
            }
            if servers.get(crate::adapter::CODEX_SERVER_KEY).is_none() {
                servers.insert(crate::adapter::CODEX_SERVER_KEY, entry);
            }
            true
        },
    );
}

/// A project's own files that carry the old names.
fn project_files(home: &Path, folder: &Path, changes: &mut Changes) {
    for path in [
        hook::settings_path(folder),
        folder.join(".claude").join("settings.json"),
        hook::codex_hooks_path(folder),
        folder.join(".mcp.json"),
    ] {
        rename_in_json(home, &path, changes);
    }
    let config = hook::codex_config_path(folder);
    if std::fs::read_to_string(&config).is_ok_and(|text| text.contains(OLD_SERVER_KEY)) {
        rename_in_codex(home, &config, changes);
    }
}

/// Paths into the old folder in the app's own JSON files say the new one.
fn own_files(old: &Path, new: &Path, changes: &mut Changes) {
    let as_json = |path: &Path| {
        let text = Value::from(path.to_string_lossy().to_string()).to_string();
        text[1..text.len() - 1].to_string()
    };
    let (from, to) = (as_json(old), as_json(new));
    let Ok(entries) = std::fs::read_dir(new) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if !text.contains(&from) {
            continue;
        }
        if hook::write_whole(&path, &text.replace(&from, &to)).is_ok() {
            changes.add(
                &path,
                &format!(
                    "paths under `{}` now under `{}`",
                    old.display(),
                    new.display()
                ),
            );
        }
    }
}

/// Pairings' lines in authorized_keys run `daemon`, under the new comment.
fn authorized_keys(home: &Path, daemon: &Path, changes: &mut Changes) -> Result<(), String> {
    let path = home.join(".ssh").join("authorized_keys");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(());
    };
    let mut changed = false;
    let lines: Vec<String> = text
        .lines()
        .map(|line| match paired_key(line) {
            Some(key) => {
                changed = true;
                crate::pair::authorized_line(daemon, &key)
            }
            None => line.to_string(),
        })
        .collect();
    if !changed {
        return Ok(());
    }
    let mut written = lines.join("\n");
    if text.ends_with('\n') {
        written.push('\n');
    }
    hook::write_whole(&path, &written)?;
    changes.add(
        &path,
        &format!("the pairings' lines run `{}`", daemon.display()),
    );
    Ok(())
}

/// The public key of a line pairing wrote under the old name, with its
/// comment renamed.
fn paired_key(line: &str) -> Option<String> {
    let rest = line.strip_prefix("command=\"")?;
    let (command, rest) = rest.split_once('"')?;
    if !command.ends_with(" serve") || !runs_daemon(command.trim_end_matches(" serve")) {
        return None;
    }
    let mut words: Vec<&str> = rest
        .strip_prefix(",restrict ")?
        .split_whitespace()
        .collect();
    if words.last() != Some(&OLD_KEY_COMMENT) {
        return None;
    }
    words.pop();
    Some(
        words
            .iter()
            .map(|word| {
                if *word == OLD_KEY_COMMENT {
                    "chord"
                } else {
                    word
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// Removes the old daemon's build from the folder, now nothing runs it.
fn old_daemon(new: &Path, changes: &mut Changes) {
    for name in [
        OLD_DAEMON,
        &format!("{OLD_DAEMON}.exe"),
        &format!("{OLD_DAEMON}.new"),
    ] {
        let path = new.join("bin").join(name);
        if std::fs::remove_file(&path).is_ok() {
            changes.add(&path, "removed; the daemon is `chord-remote` beside it");
        }
    }
}

fn note_text(old: &Path, new: &Path, changes: &Changes) -> String {
    let mut text = format!(
        "# Moved from Agent Workbench to Chord\n\nChord moved its folder from `{}` to `{}`, left a link at the old path, and changed each file below to the new names. A project opened later that still had the old names is added at the end.\n\n",
        old.display(),
        new.display()
    );
    if changes.0.is_empty() {
        text.push_str("No file needed changing.\n");
    }
    for line in &changes.0 {
        text.push_str(line);
        text.push('\n');
    }
    text
}

#[cfg(test)]
#[path = "migrate_tests.rs"]
mod tests;
