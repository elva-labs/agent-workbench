//! Moves an install made under the app's earlier name, Agent Workbench, to
//! Chord's names, once, the first time Chord runs on a machine. This is the
//! one place in the app that knows the earlier names.
//!
//! What moves:
//!
//! - **The folder.** `~/.agent-workbench` becomes `~/.chord`, and a link is
//!   left at the old path, so paths written into files the app does not
//!   own still lead somewhere. A folder that is itself a link, to dotfiles,
//!   moves as a link. A `~/.chord` that is there before the move was made
//!   by something that ran first, so the old folder holds the user's files:
//!   what `~/.chord` holds is added to the old folder before it moves, and
//!   where both hold a file the old folder's is kept in place and
//!   `~/.chord`'s goes to the `kept-from-before` folder. Until the folder
//!   has moved it is the app's folder, in every process (see `unmoved`),
//!   so a move that fails leaves the app on the folder that holds its
//!   files, and the next start tries again.
//! - **The orchestrator folder's identity.** It is inside the folder, and
//!   the agents know a folder by its resolved path. Claude Code's
//!   transcript folders for it, its entry in each Claude Code state file
//!   and its trust in each Codex config are carried to the new path.
//! - **The tool server's name.** Every entry the app wrote under the old
//!   name, in each Claude Code state file, each Codex config and each
//!   project's hook and server files, is renamed, and the user's
//!   permission rules and Codex tool approvals that name the old server
//!   name the new one, each kept as it was. An entry that ran this home's
//!   daemon runs it under its new name; one that ran a daemon from a
//!   folder of the user's choosing keeps that folder, with the daemon's
//!   file name changed. In a project, a file git tracks is not written but
//!   named in the note, and the two files a project shares with its team,
//!   `.claude/settings.json` and `.mcp.json`, have the old server's name
//!   changed as text in place, with nothing else in them touched.
//! - **The daemon.** The forced commands pairing wrote into
//!   `~/.ssh/authorized_keys` run the renamed daemon, with the line's other
//!   options kept, and the old build is removed once no line runs it.
//! - **The app's own files** that hold paths into the folder say the new
//!   path.
//!
//! A marker in the folder, written before the folder moves and moving with
//! it, says a move is under way. A run cut off at any point is done again
//! by the next, and each step only changes what is still in its old form,
//! so doing it again changes nothing. Every file a run changed is added to
//! `migration.md` in the folder, under the time it ran, and every file it
//! could not change under a heading of its own. The marker goes once a run
//! has changed every file outside a project that it had to; while one is
//! left, each start tries again. A project's files are checked again when
//! the project is opened, which also finds projects the first run could
//! not, and what that changes is added to the note.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Map, Value};

use crate::account::{self, Dirs};
use crate::adapter::{CODEX_SERVER_KEY, SERVER_NAME};
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
/// The marker that a move is under way, in the folder.
pub const MOVING: &str = ".moving";
/// Where a file both folders held is kept, in the folder, when the copy in
/// use is the other one.
const KEPT: &str = "kept-from-before";

/// The lists in Claude Code's settings and state that hold servers' names.
const SERVER_LISTS: [&str; 3] = [
    "disabledMcpServers",
    "enabledMcpjsonServers",
    "disabledMcpjsonServers",
];
/// The files a project shares with its team, which the app never writes
/// otherwise, as paths inside it.
const CLAUDE_SHARED: &str = ".claude/settings.json";
const MCP_SHARED: &str = ".mcp.json";
/// The files in a project that can carry the old names.
const PROJECT_FILES: [&str; 5] = [
    hook::CLAUDE_LOCAL,
    CLAUDE_SHARED,
    hook::CODEX_HOOKS,
    MCP_SHARED,
    hook::CODEX_CONFIG,
];

/// The folders [`project`] has checked in this process.
static CHECKED: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());

/// What a migration changed, a line for each file, and what it could not
/// change.
#[derive(Default)]
struct Changes {
    done: Vec<String>,
    failed: Vec<String>,
    /// Whether a file outside a project could not be changed, so the next
    /// start tries again.
    retry: bool,
}

impl Changes {
    fn add(&mut self, path: &Path, what: &str) {
        self.done.push(entry(path, what));
    }

    fn fail(&mut self, path: &Path, error: &str) {
        self.failed.push(entry(path, error));
        self.retry = true;
    }
}

fn entry(path: &Path, what: &str) -> String {
    format!("- `{}`: {what}", path.display())
}

/// Whether there is an install under `home` to move over, or a move that
/// was cut off. Cheap enough to ask at every start.
pub fn needed(home: &Path) -> bool {
    home.join(crate::home::DIR).join(MOVING).exists() || unmoved_folder(home)
}

/// Whether the app or the daemon moves an install over by itself as it
/// starts. A release build does. A debug build runs against the
/// developer's own home, so it does only when `CHORD_MIGRATE` is set, and
/// otherwise uses the install where it is. `chord-remote migrate` moves
/// one whenever it is run.
pub fn on_start() -> bool {
    !cfg!(debug_assertions) || std::env::var_os("CHORD_MIGRATE").is_some()
}

/// The folder of the earlier name while it holds the install: it has not
/// been moved, and `.chord` has no move made into it, so whatever `.chord`
/// holds was made by something that ran first.
pub(crate) fn unmoved(home: &Path) -> Option<PathBuf> {
    let new = home.join(crate::home::DIR);
    (unmoved_folder(home) && !moved_into(&new)).then(|| home.join(OLD_DIR))
}

/// Whether the folder of the earlier name is a folder of its own, or a
/// link to one that is not `.chord`.
fn unmoved_folder(home: &Path) -> bool {
    let (old, new) = (home.join(OLD_DIR), home.join(crate::home::DIR));
    std::fs::symlink_metadata(&old).is_ok_and(|meta| {
        meta.is_dir() || (meta.file_type().is_symlink() && !points_at(&old, &new))
    })
}

/// Whether a move has been made into `new`: one is under way, or a run of
/// it has written the note.
fn moved_into(new: &Path) -> bool {
    new.join(MOVING).exists() || new.join(NOTE).exists()
}

/// Moves the install under `home` over, when there is one to move.
/// `daemon` is the daemon the pairings' forced commands should run, the
/// home's own when None. Says where the note is when this run wrote one.
/// An error says the folder could not be moved, and the app goes on using
/// the old one, or that files could not be changed, and the note lists
/// them; either way the next start tries again.
pub fn run(
    home: &Path,
    daemon: Option<&Path>,
    env: &HashMap<String, String>,
) -> Result<Option<PathBuf>, String> {
    if !needed(home) {
        return Ok(None);
    }
    let (old, new) = (home.join(OLD_DIR), home.join(crate::home::DIR));
    let mut changes = Changes::default();
    // The resolved path the agents knew the orchestrator folder by: the old
    // folder's own, or, once it has moved, where it was.
    let old_orchestrator = if unmoved_folder(home) {
        canonical(&old)
    } else {
        canonical(home).join(OLD_DIR)
    }
    .join("orchestrator");
    move_folder(home, &mut changes)?;

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
    let renames = Renames::of(home);
    let mut projects = vec![new_orchestrator];
    for state in account::claude_jsons(home, &accounts, env) {
        rename_in_json(&state, &renames, &mut changes);
        projects.extend(project_keys(&hook::read_settings(&state)));
    }
    for codex in account::codex_homes(home, &accounts, env) {
        let config = codex.join("config.toml");
        rename_in_codex(&config, &renames, &mut changes);
        projects.extend(codex_projects(&config));
    }
    for dir in claude_dirs(home, &accounts, env) {
        for file in ["settings.json", "settings.local.json"] {
            rename_in_json(&dir.join(file), &renames, &mut changes);
        }
    }
    projects.sort();
    projects.dedup();
    for folder in projects.iter().filter(|folder| folder.is_dir()) {
        project_files(home, folder, &mut changes);
    }
    own_files(home, &new, &mut changes);
    let daemon = daemon
        .map(Path::to_path_buf)
        .unwrap_or_else(|| hook::daemon_path(home));
    let still_run = authorized_keys(home, &daemon, &mut changes);
    old_daemon(&new, still_run, &mut changes);

    let note = new.join(NOTE);
    write_note(&note, home, &changes)
        .map_err(|error| format!("{error}; the move is tried again at the next start"))?;
    if changes.retry {
        return Err(format!(
            "some files could not be changed to Chord's names; {} lists them, and they are tried again at the next start",
            note.display()
        ));
    }
    let _ = std::fs::remove_file(new.join(MOVING));
    Ok(Some(note))
}

/// Brings a project's own files over, when it is opened: the hooks, the
/// tool server's entries and the permission rules that still carry the
/// earlier names. Each project once in a process, and only once an
/// install has been moved here. Adds what it changed to the note.
pub fn project(home: &Path, folder: &Path) {
    let note = crate::home::dir(home).join(NOTE);
    if !note.exists() {
        return;
    }
    {
        let mut checked = CHECKED
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !checked.insert(folder.to_path_buf()) {
            return;
        }
    }
    let mut changes = Changes::default();
    project_files(home, folder, &mut changes);
    let _ = write_note(&note, home, &changes);
}

fn canonical(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Whether the link at `link` leads to `folder`.
fn points_at(link: &Path, folder: &Path) -> bool {
    std::fs::read_link(link).is_ok_and(|to| to == Path::new(crate::home::DIR) || to == folder)
        || (folder.exists() && canonical(link) == canonical(folder))
}

const MARKER_TEXT: &str =
    "Chord is moving its folder from its earlier name. This file goes once the move is done.\n";

/// Moves the folder of the earlier name to `.chord`, and leaves a link at
/// the old path. On an error the folder that held the install still holds
/// every file the user had, and is the app's folder until a later run
/// moves it.
fn move_folder(home: &Path, changes: &mut Changes) -> Result<(), String> {
    let (old, new) = (home.join(OLD_DIR), home.join(crate::home::DIR));
    let Ok(meta) = std::fs::symlink_metadata(&old) else {
        // Moved by a run cut off before it left the link.
        link(&old, changes);
        return Ok(());
    };
    if !unmoved_folder(home) {
        return Ok(());
    }
    if moved_into(&new) {
        return add_made_again(&old, &new, meta.file_type().is_symlink(), changes).map_err(
            |error| {
                format!(
                    "{error}; Chord goes on using {}, and tries again at the next start",
                    new.display()
                )
            },
        );
    }
    let folder = canonical(&old);
    let marker = folder.join(MOVING);
    let moved = std::fs::write(&marker, MARKER_TEXT)
        .map_err(|e| format!("could not write {}: {e}", marker.display()))
        .and_then(|()| {
            if meta.file_type().is_symlink() {
                move_link(&old, &new, &folder, changes)
            } else {
                move_whole(&old, &new, changes)
            }
        });
    if let Err(error) = moved {
        if unmoved_folder(home) {
            let _ = std::fs::remove_file(&marker);
        }
        return Err(format!(
            "{error}; Chord goes on using {} as it is, and tries again at the next start",
            old.display()
        ));
    }
    link(&old, changes);
    Ok(())
}

/// Moves a folder of its own, after taking in what a `.chord` made before
/// the move holds.
fn move_whole(old: &Path, new: &Path, changes: &mut Changes) -> Result<(), String> {
    take_in_early(new, old, changes)?;
    std::fs::rename(old, new)
        .map_err(|e| format!("could not move {} to {}: {e}", old.display(), new.display()))?;
    changes.add(new, &format!("moved here from `{}`", old.display()));
    Ok(())
}

/// Moves a folder that is a link to elsewhere, as dotfiles make: the new
/// name becomes the same link, after the folder it leads to takes in what
/// a `.chord` made before the move holds.
fn move_link(old: &Path, new: &Path, folder: &Path, changes: &mut Changes) -> Result<(), String> {
    let to =
        std::fs::read_link(old).map_err(|e| format!("could not read {}: {e}", old.display()))?;
    take_in_early(new, folder, changes)?;
    make_link(&to, new).map_err(|e| format!("could not link {}: {e}", new.display()))?;
    changes.add(
        new,
        &format!(
            "made a link to `{}`, as `{}` was",
            to.display(),
            old.display()
        ),
    );
    std::fs::remove_file(old).map_err(|e| format!("could not remove {}: {e}", old.display()))
}

/// Takes into `folder`, the install, what a `.chord` made before the move
/// holds, and removes it. Where both hold a file, the install's stays.
fn take_in_early(new: &Path, folder: &Path, changes: &mut Changes) -> Result<(), String> {
    let Ok(meta) = std::fs::symlink_metadata(new) else {
        return Ok(());
    };
    if !meta.is_dir() {
        return Err(format!(
            "{} is there and is not a folder of its own; move what you need from it by hand",
            new.display()
        ));
    }
    let (kept, parked) = take_in(new, folder)?;
    std::fs::remove_dir(new).map_err(|e| format!("could not remove {}: {e}", new.display()))?;
    if !parked.is_empty() {
        changes.add(
            &new.join(kept),
            &format!(
                "`{}` held these before the move, and so did the old folder, whose copies are the ones in use: {}",
                new.display(),
                listed(&parked)
            ),
        );
    }
    Ok(())
}

/// Takes into `.chord`, after a move, what the folder of the earlier name
/// holds when it has been made again, by something run from before the
/// move. Where both hold a file, `.chord`'s stays.
fn add_made_again(
    old: &Path,
    new: &Path,
    is_link: bool,
    changes: &mut Changes,
) -> Result<(), String> {
    if is_link {
        return Err(format!(
            "{} is a link and {} holds the moved install; move what you need by hand",
            old.display(),
            new.display()
        ));
    }
    let marker = new.join(MOVING);
    std::fs::write(&marker, MARKER_TEXT)
        .map_err(|e| format!("could not write {}: {e}", marker.display()))?;
    let (kept, parked) = take_in(old, new)?;
    std::fs::remove_dir(old).map_err(|e| format!("could not remove {}: {e}", old.display()))?;
    changes.add(
        new,
        &format!(
            "took in what `{}` held after the move, as it was made again",
            old.display()
        ),
    );
    if !parked.is_empty() {
        changes.add(
            &new.join(kept),
            &format!(
                "`{}` held these after the move, and so did `{}`, whose copies are the ones in use: {}",
                old.display(),
                new.display(),
                listed(&parked)
            ),
        );
    }
    link(old, changes);
    Ok(())
}

fn listed(paths: &[String]) -> String {
    paths
        .iter()
        .map(|path| format!("`{path}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Moves into `into` what `from` holds, folder by folder. Where both hold
/// a file, `into`'s stays and `from`'s goes to a kept folder in `into`,
/// under the same path. Says the kept folder's name and the paths that
/// went there, and stops at the first entry that cannot be moved.
fn take_in(from: &Path, into: &Path) -> Result<(String, Vec<String>), String> {
    let mut name = KEPT.to_string();
    let mut n = 1;
    while std::fs::symlink_metadata(into.join(&name)).is_ok()
        || std::fs::symlink_metadata(from.join(&name)).is_ok()
    {
        n += 1;
        name = format!("{KEPT}-{n}");
    }
    let mut parked = Vec::new();
    take_in_folder(from, into, &into.join(&name), Path::new(""), &mut parked)?;
    Ok((name, parked))
}

fn take_in_folder(
    from: &Path,
    into: &Path,
    kept: &Path,
    at: &Path,
    parked: &mut Vec<String>,
) -> Result<(), String> {
    let entries =
        std::fs::read_dir(from).map_err(|e| format!("could not read {}: {e}", from.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("could not read {}: {e}", from.display()))?;
        let (source, target) = (entry.path(), into.join(entry.file_name()));
        let at = at.join(entry.file_name());
        match std::fs::symlink_metadata(&target) {
            Err(_) => move_entry(&source, &target)?,
            Ok(meta) if meta.is_dir() && entry.file_type().is_ok_and(|kind| kind.is_dir()) => {
                take_in_folder(&source, &target, kept, &at, parked)?;
                std::fs::remove_dir(&source)
                    .map_err(|e| format!("could not remove {}: {e}", source.display()))?;
            }
            Ok(_) => {
                let to = kept.join(&at);
                if let Some(parent) = to.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
                }
                move_entry(&source, &to)?;
                parked.push(at.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    Ok(())
}

fn move_entry(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::rename(from, to)
        .map_err(|e| format!("could not move {} to {}: {e}", from.display(), to.display()))
}

/// Moves into `into` what it lacks of `from`, folder by folder, and says
/// how many it moved. What both hold stays where it is in each.
fn move_missing(from: &Path, into: &Path) -> Result<usize, String> {
    let entries =
        std::fs::read_dir(from).map_err(|e| format!("could not read {}: {e}", from.display()))?;
    let mut moved = 0;
    for entry in entries {
        let entry = entry.map_err(|e| format!("could not read {}: {e}", from.display()))?;
        let target = into.join(entry.file_name());
        match std::fs::symlink_metadata(&target) {
            Err(_) => {
                move_entry(&entry.path(), &target)?;
                moved += 1;
            }
            Ok(meta) if meta.is_dir() && entry.file_type().is_ok_and(|kind| kind.is_dir()) => {
                moved += move_missing(&entry.path(), &target)?;
                let _ = std::fs::remove_dir(entry.path());
            }
            Ok(_) => {}
        }
    }
    Ok(moved)
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

/// A file's text when it names the old server, daemon or folder. A file
/// that is there and cannot be read is noted as not changed.
fn read_named(path: &Path, changes: &mut Changes) -> Option<String> {
    match std::fs::read_to_string(path) {
        Ok(text) => (text.contains(OLD_SERVER) || text.contains(OLD_SERVER_KEY)).then_some(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            changes.fail(path, &format!("could not be read: {error}"));
            None
        }
    }
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
            let (source, target) = (entry.path(), projects.join(format!("{new_name}{rest}")));
            if std::fs::symlink_metadata(&target).is_err() {
                match move_entry(&source, &target) {
                    Ok(()) => changes.add(
                        &target,
                        &format!("Claude Code's transcripts, moved from `{name}`"),
                    ),
                    Err(error) => changes.fail(&source, &error),
                }
                continue;
            }
            match move_missing(&source, &target) {
                Ok(moved) => {
                    let _ = std::fs::remove_dir(&source);
                    if moved > 0 {
                        changes.add(
                            &target,
                            &format!(
                                "Claude Code's transcripts from `{name}` added, {moved} of them"
                            ),
                        );
                    }
                }
                Err(error) => changes.fail(&source, &error),
            }
        }
    }
    let pairs: Vec<(String, String)> = keys(from).into_iter().zip(keys(to)).collect();
    for state in account::claude_jsons(home, accounts, env) {
        if read_named(&state, changes).is_none() {
            continue;
        }
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
        match result {
            Err(error) => changes.fail(&state, &error),
            Ok(()) if moved => changes.add(
                &state,
                "the orchestrator folder's entry, its trust with it, moved to the new path",
            ),
            Ok(()) => {}
        }
    }
    for codex in account::codex_homes(home, accounts, env) {
        edit_codex(
            &codex.join("config.toml"),
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

/// The daemon's file name on this kind of machine, under `stem`.
fn daemon_file(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

/// The daemon's name today, without the extension it has on Windows.
fn daemon_stem() -> &'static str {
    hook::DAEMON_FILE.trim_end_matches(".exe")
}

/// The file name of a command, and where in it the file name starts.
fn command_file(command: &str) -> (usize, &str) {
    let at = command.rfind(['/', '\\']).map_or(0, |at| at + 1);
    (at, &command[at..])
}

/// Whether a command is a daemon of this app's, under either name.
fn runs_daemon(command: &str) -> bool {
    let (_, file) = command_file(command);
    let stem = file.strip_suffix(".exe").unwrap_or(file);
    stem == OLD_DAEMON || stem == daemon_stem()
}

/// How a command that ran the daemon runs it now.
struct Daemons {
    /// The paths this home's daemon had before: under the old name, in the
    /// old folder, or both, as the home is given and as it resolves.
    before: Vec<String>,
    /// The daemon such a command runs now.
    now: String,
}

impl Daemons {
    fn of(home: &Path, now: &Path) -> Daemons {
        let mut homes = vec![home.to_path_buf()];
        let resolved = canonical(home);
        if resolved != home {
            homes.push(resolved);
        }
        let mut before = Vec::new();
        for home in &homes {
            for (dir, stem) in [
                (OLD_DIR, OLD_DAEMON),
                (OLD_DIR, daemon_stem()),
                (crate::home::DIR, OLD_DAEMON),
            ] {
                let path = home.join(dir).join("bin").join(daemon_file(stem));
                let text = path.to_string_lossy().to_string();
                let forward = text.replace('\\', "/");
                for spelling in [text, forward] {
                    if !before.contains(&spelling) {
                        before.push(spelling);
                    }
                }
            }
        }
        Daemons {
            before,
            now: now.to_string_lossy().to_string(),
        }
    }

    /// The command for one that ran the daemon under an earlier name or
    /// path: this home's runs [`Daemons::now`], and one in a folder of the
    /// user's own runs the daemon's new name from the same folder. None
    /// when it is not one of those.
    fn renamed(&self, command: &str) -> Option<String> {
        if self.before.iter().any(|path| path == command) {
            return (command != self.now).then(|| self.now.clone());
        }
        let (at, file) = command_file(command);
        let stem = file.strip_suffix(".exe").unwrap_or(file);
        (stem == OLD_DAEMON)
            .then(|| format!("{}{}{}", &command[..at], daemon_stem(), &file[stem.len()..]))
    }

    /// The command for one that ran this home's daemon from an earlier
    /// path, under the server's new name.
    fn repointed(&self, command: &str) -> Option<String> {
        self.before
            .iter()
            .any(|path| path == command)
            .then(|| self.renamed(command))
            .flatten()
    }
}

/// What a file of the app's has renamed: the hooks' commands, by their old
/// forms, and the daemon's.
struct Renames {
    commands: Vec<(String, String)>,
    daemons: Daemons,
}

impl Renames {
    fn of(home: &Path) -> Renames {
        Renames {
            commands: hook_commands(home),
            daemons: Daemons::of(home, &hook::daemon_path(home)),
        }
    }
}

/// Renames what carries the server's old name in a JSON settings value:
/// the server's entries that run the daemon, the names in lists of
/// servers, the permission rules, and the hooks' commands.
fn rename_value(value: &mut Value, renames: &Renames) -> bool {
    let mut changed = false;
    match value {
        Value::Object(map) => {
            changed |= rename_server(map, renames);
            if let Some(Value::String(command)) = map.get_mut("command") {
                if let Some((_, new)) = renames.commands.iter().find(|(old, _)| old == command) {
                    *command = new.clone();
                    changed = true;
                }
            }
            for (key, item) in map.iter_mut() {
                changed |= match item {
                    Value::Array(items) => {
                        rename_list(items, SERVER_LISTS.contains(&key.as_str()), renames)
                    }
                    item => rename_value(item, renames),
                };
            }
        }
        Value::Array(items) => changed |= rename_list(items, false, renames),
        _ => {}
    }
    changed
}

/// Renames the server's entry under the old name when it runs the daemon,
/// and points the entry under the new name at the daemon when it ran it
/// from an earlier path. Where both names have an entry, the new one's is
/// kept.
fn rename_server(map: &mut Map<String, Value>, renames: &Renames) -> bool {
    let command_of = |entry: &Value| {
        entry
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let mut changed = false;
    if let Some(command) = map
        .get(OLD_SERVER)
        .and_then(command_of)
        .filter(|command| runs_daemon(command))
    {
        let mut entry = map.remove(OLD_SERVER).unwrap_or(Value::Null);
        if let Some(renamed) = renames.daemons.renamed(&command) {
            entry["command"] = Value::from(renamed);
        }
        map.entry(SERVER_NAME).or_insert(entry);
        changed = true;
    }
    if let Some(entry) = map.get_mut(SERVER_NAME) {
        if let Some(renamed) = command_of(entry).and_then(|c| renames.daemons.repointed(&c)) {
            entry["command"] = Value::from(renamed);
            changed = true;
        }
    }
    changed
}

/// Renames in a list: the permission rules for the old server and the
/// paths into the old folder, and, in a list of servers' names, the old
/// server's name. A list that changed keeps each entry once.
fn rename_list(items: &mut Vec<Value>, names: bool, renames: &Renames) -> bool {
    let mut changed = false;
    for item in items.iter_mut() {
        match item {
            Value::String(text) => {
                let renamed = if names && text == OLD_SERVER {
                    Some(SERVER_NAME.to_string())
                } else {
                    renamed_rule(text)
                };
                if let Some(renamed) = renamed {
                    *text = renamed;
                    changed = true;
                }
            }
            item => changed |= rename_value(item, renames),
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
    changed
}

/// A permission rule for the old server, for the new one: `mcp__` and the
/// server's name, alone or before `__` and a tool or a pattern. A rule
/// with a path into the old folder, as `Read(~/.agent-workbench/**)`,
/// names the new folder.
fn renamed_rule(rule: &str) -> Option<String> {
    if let Some(rest) = rule.strip_prefix(&format!("mcp__{OLD_SERVER}")) {
        if rest.is_empty() || rest.starts_with("__") || rest.starts_with('(') {
            return Some(format!("mcp__{SERVER_NAME}{rest}"));
        }
    }
    let moved = replace_segment(
        &replace_segment(
            rule,
            &format!("/{OLD_DIR}"),
            &format!("/{}", crate::home::DIR),
        ),
        &format!("\\{OLD_DIR}"),
        &format!("\\{}", crate::home::DIR),
    );
    (moved != rule).then_some(moved)
}

/// `text` with each `from` that ends where a path segment does, before a
/// separator, a quote, a closing bracket or the end, replaced by `to`.
fn replace_segment(text: &str, from: &str, to: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(from) {
        let after = &rest[at + from.len()..];
        let whole = after.is_empty() || after.starts_with(['/', '\\', '"', ')']);
        out.push_str(&rest[..at]);
        out.push_str(if whole { to } else { from });
        rest = after;
    }
    out.push_str(rest);
    out
}

/// The commands the hooks ran under the old names, each with the command
/// they run now. A run on the old folder wrote the new daemon's name under
/// it, so that form is known too.
fn hook_commands(home: &Path) -> Vec<(String, String)> {
    let old = home.join(OLD_DIR);
    let new = hook::commands_at(&crate::home::dir(home), &hook::daemon_path(home));
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

/// Renames in a JSON file the app writes, or an agent keeps, when it names
/// the old server, daemon or folder.
fn rename_in_json(path: &Path, renames: &Renames, changes: &mut Changes) {
    if read_named(path, changes).is_none() {
        return;
    }
    let mut did = false;
    let result = hook::update_settings(path, |settings| {
        let mut value = Value::Object(std::mem::take(settings));
        did = rename_value(&mut value, renames);
        if let Value::Object(map) = value {
            *settings = map;
        }
        if did {
            dedupe_hooks(settings);
        }
        Ok(did)
    });
    match result {
        Err(error) => changes.fail(path, &error),
        Ok(()) if did => changes.add(
            path,
            "the tool server's old name and the hooks' old paths changed to the new, rules kept as allow, ask or deny",
        ),
        Ok(()) => {}
    }
}

/// Renames the old server in a file a project shares with its team, as
/// text in place: each JSON string that is its name or a permission rule
/// for it. Nothing else in the file changes, and a command is left as it
/// is; one that still names the old daemon or folder is noted for the
/// user to change.
fn rename_shared(path: &Path, changes: &mut Changes) {
    let Some(text) = read_named(path, changes) else {
        return;
    };
    let renamed = renamed_strings(&text);
    if renamed != text {
        match hook::write_whole(path, &renamed) {
            Ok(()) => changes.add(
                path,
                "the tool server's old name changed to the new where it stood, nothing else in the file touched",
            ),
            Err(error) => {
                changes.fail(path, &error);
                return;
            }
        }
    }
    if renamed.contains(OLD_SERVER) {
        changes.add(
            path,
            "still names the earlier daemon or folder, in a command or a path; left for you to change",
        );
    }
}

/// `text` with each JSON string that is the old server's name, or a
/// permission rule for it, renamed.
fn renamed_strings(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('"') {
        out.push_str(&rest[..=open]);
        rest = &rest[open + 1..];
        let mut end = rest.len();
        let mut chars = rest.char_indices();
        while let Some((at, c)) = chars.next() {
            match c {
                '\\' => {
                    chars.next();
                }
                '"' => {
                    end = at;
                    break;
                }
                _ => {}
            }
        }
        let content = &rest[..end];
        let rule = content
            .strip_prefix(&format!("mcp__{OLD_SERVER}"))
            .filter(|rest| rest.is_empty() || rest.starts_with("__") || rest.starts_with('('))
            .map(|rest| format!("mcp__{SERVER_NAME}{rest}"));
        match rule {
            Some(rule) => out.push_str(&rule),
            None if content == OLD_SERVER => out.push_str(SERVER_NAME),
            None => out.push_str(content),
        }
        rest = &rest[end..];
        if let Some(after) = rest.strip_prefix('"') {
            out.push('"');
            rest = after;
        }
    }
    out.push_str(rest);
    out
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

/// Edits a Codex config that names the old server, daemon or folder with
/// `change`, written back as the file was, and notes `what` when it
/// changed.
fn edit_codex(
    config: &Path,
    changes: &mut Changes,
    what: &str,
    change: impl FnOnce(&mut toml_edit::DocumentMut) -> bool,
) {
    let Some(text) = read_named(config, changes) else {
        return;
    };
    let mut document = match hook::parse_codex(&text) {
        Ok(document) => document,
        Err(error) => {
            changes.fail(config, &format!("could not be read as TOML: {error}"));
            return;
        }
    };
    if change(&mut document) {
        match hook::write_whole(config, &hook::as_the_file_was(&text, document.to_string())) {
            Ok(()) => changes.add(config, what),
            Err(error) => changes.fail(config, &error),
        }
    }
}

fn table_command(table: &dyn toml_edit::TableLike) -> Option<String> {
    table
        .get("command")
        .and_then(|command| command.as_str())
        .map(str::to_string)
}

/// Sets a server table's command, keeping how the line was laid out.
fn set_command(table: &mut dyn toml_edit::TableLike, command: &str) {
    if let Some(item) = table.get_mut("command") {
        let decor = item.as_value().map(|value| value.decor().clone());
        *item = toml_edit::value(command);
        if let (Some(decor), Some(value)) = (decor, item.as_value_mut()) {
            *value.decor_mut() = decor;
        }
    }
}

/// Renames the server's table in a Codex config, with its tools'
/// approvals, and points its command at the daemon as [`rename_server`]
/// does. Where both names have a table, the new one keeps its own and
/// takes the approvals it lacks from the old.
fn rename_in_codex(config: &Path, renames: &Renames, changes: &mut Changes) {
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
            let mut changed = false;
            if let Some(mut entry) = servers.remove(OLD_SERVER_KEY) {
                if let Some(table) = entry.as_table_like_mut() {
                    let renamed = table_command(table)
                        .filter(|command| runs_daemon(command))
                        .and_then(|command| renames.daemons.renamed(&command));
                    if let Some(renamed) = renamed {
                        set_command(table, &renamed);
                    }
                }
                match servers
                    .get_mut(CODEX_SERVER_KEY)
                    .and_then(|item| item.as_table_like_mut())
                {
                    Some(there) => take_approvals(&entry, there),
                    None => {
                        servers.insert(CODEX_SERVER_KEY, entry);
                    }
                }
                changed = true;
            }
            if let Some(table) = servers
                .get_mut(CODEX_SERVER_KEY)
                .and_then(|item| item.as_table_like_mut())
            {
                if let Some(renamed) =
                    table_command(table).and_then(|c| renames.daemons.repointed(&c))
                {
                    set_command(table, &renamed);
                    changed = true;
                }
            }
            changed
        },
    );
}

/// Gives a server's table the tool approvals of `from` it lacks.
fn take_approvals(from: &toml_edit::Item, into: &mut dyn toml_edit::TableLike) {
    let Some(tools) = from
        .as_table_like()
        .and_then(|table| table.get("tools"))
        .and_then(|tools| tools.as_table_like())
    else {
        return;
    };
    if into.get("tools").is_none() {
        let mut table = toml_edit::Table::new();
        table.set_implicit(true);
        into.insert("tools", toml_edit::Item::Table(table));
    }
    let Some(theirs) = into
        .get_mut("tools")
        .and_then(|tools| tools.as_table_like_mut())
    else {
        return;
    };
    for (tool, setting) in tools.iter() {
        if theirs.get(tool).is_none() {
            theirs.insert(tool, setting.clone());
        }
    }
}

/// A project's own files that carry the old names. A file git tracks is
/// named in the note and left as it is. What fails is noted and not tried
/// again until the project is opened again.
fn project_files(home: &Path, folder: &Path, changes: &mut Changes) {
    let mut here = Changes::default();
    let named: Vec<&str> = PROJECT_FILES
        .into_iter()
        .filter(|file| read_named(&folder.join(file), &mut here).is_some())
        .collect();
    if !named.is_empty() {
        let tracked = hook::tracked_of(folder, &named);
        let renames = Renames::of(home);
        for file in named {
            let path = folder.join(file);
            if tracked.contains(&file) {
                here.add(
                    &path,
                    "names the earlier tool server, daemon or folder, and git tracks it, so it is left for you to change",
                );
            } else if file == CLAUDE_SHARED || file == MCP_SHARED {
                rename_shared(&path, &mut here);
            } else if file == hook::CODEX_CONFIG {
                rename_in_codex(&path, &renames, &mut here);
            } else {
                rename_in_json(&path, &renames, &mut here);
            }
        }
    }
    changes.done.append(&mut here.done);
    changes.failed.append(&mut here.failed);
}

/// Paths into the old folder in the app's own JSON files say the new one.
fn own_files(home: &Path, new: &Path, changes: &mut Changes) {
    let as_json = |path: &Path| {
        let text = Value::from(path.to_string_lossy().to_string()).to_string();
        text[1..text.len() - 1].to_string()
    };
    let mut pairs = Vec::new();
    for home in [home.to_path_buf(), canonical(home)] {
        let pair = (
            as_json(&home.join(OLD_DIR)),
            as_json(&home.join(crate::home::DIR)),
        );
        if !pairs.contains(&pair) {
            pairs.push(pair);
        }
    }
    let Ok(entries) = std::fs::read_dir(new) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let Some(text) = read_named(&path, changes) else {
            continue;
        };
        let moved = pairs.iter().fold(text.clone(), |text, (from, to)| {
            replace_segment(&text, from, to)
        });
        if moved == text {
            continue;
        }
        match hook::write_whole(&path, &moved) {
            Ok(()) => changes.add(
                &path,
                &format!(
                    "paths under `{}` now under `{}`",
                    home.join(OLD_DIR).display(),
                    new.display()
                ),
            ),
            Err(error) => changes.fail(&path, &error),
        }
    }
}

/// Pairings' lines in authorized_keys run the renamed daemon. Says whether
/// a line still runs the old one, or the file could not be read.
fn authorized_keys(home: &Path, daemon: &Path, changes: &mut Changes) -> bool {
    let path = home.join(".ssh").join("authorized_keys");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
        Err(error) => {
            changes.fail(&path, &format!("could not be read: {error}"));
            return true;
        }
    };
    let daemons = Daemons::of(home, daemon);
    let mut changed = false;
    let lines: Vec<String> = text
        .lines()
        .map(|line| match paired_line(line, &daemons) {
            Some(renamed) => {
                changed = true;
                renamed
            }
            None => line.to_string(),
        })
        .collect();
    if changed {
        let mut written = lines.join("\n");
        if text.ends_with('\n') {
            written.push('\n');
        }
        match hook::write_whole(&path, &written) {
            Ok(()) => changes.add(&path, "the pairings' lines run the renamed daemon"),
            Err(error) => {
                changes.fail(&path, &error);
                return true;
            }
        }
    }
    lines.iter().any(|line| line.contains(OLD_DAEMON))
}

/// A line whose forced command serves the daemon under an earlier name or
/// path, running it as [`Daemons::renamed`] says, with the old comment
/// renamed. The line's other options are kept as they are.
fn paired_line(line: &str, daemons: &Daemons) -> Option<String> {
    let (options, key) = split_options(line)?;
    let (start, end) = command_option(options)?;
    let program = options[start..end].strip_suffix(" serve")?;
    if !runs_daemon(program) {
        return None;
    }
    let renamed = daemons.renamed(program);
    let words: Vec<&str> = key.split_whitespace().collect();
    if renamed.is_none() && !words.contains(&OLD_KEY_COMMENT) {
        return None;
    }
    let program = renamed.unwrap_or_else(|| program.to_string());
    let key = words
        .iter()
        .map(|word| {
            if *word == OLD_KEY_COMMENT {
                "chord"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    Some(format!(
        "{}{program} serve{} {key}",
        &options[..start],
        &options[end..]
    ))
}

/// A line of authorized_keys split into its options and the key after
/// them, at the first space outside quotes. None for a line without
/// options.
fn split_options(line: &str) -> Option<(&str, &str)> {
    let (mut quoted, mut escaped) = (false, false);
    for (at, c) in line.char_indices() {
        match c {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            '"' => quoted = !quoted,
            ' ' | '\t' if !quoted => {
                let options = &line[..at];
                return options
                    .contains('=')
                    .then(|| (options, line[at..].trim_start()));
            }
            _ => {}
        }
    }
    None
}

/// Where the value of the `command="…"` option is in a line's options,
/// whichever place it has among them.
fn command_option(options: &str) -> Option<(usize, usize)> {
    let (mut quoted, mut escaped) = (false, false);
    let mut starts = vec![0];
    for (at, c) in options.char_indices() {
        match c {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            '"' => quoted = !quoted,
            ',' if !quoted => starts.push(at + 1),
            _ => {}
        }
    }
    const NAME: &str = "command=\"";
    let start = starts.into_iter().find(|start| {
        options
            .get(*start..*start + NAME.len())
            .is_some_and(|name| name.eq_ignore_ascii_case(NAME))
    })? + NAME.len();
    let mut escaped = false;
    for (at, c) in options[start..].char_indices() {
        match c {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            '"' => return Some((start, start + at)),
            _ => {}
        }
    }
    None
}

/// Removes the old daemon's build from the folder once nothing it knows of
/// runs it: while a line of authorized_keys still does, it stays, and the
/// note says so.
fn old_daemon(new: &Path, still_run: bool, changes: &mut Changes) {
    for name in [
        OLD_DAEMON.to_string(),
        format!("{OLD_DAEMON}.exe"),
        format!("{OLD_DAEMON}.new"),
    ] {
        let path = new.join("bin").join(&name);
        if std::fs::symlink_metadata(&path).is_err() {
            continue;
        }
        if still_run && !name.ends_with(".new") {
            changes.add(
                &path,
                "kept, since a line in `~/.ssh/authorized_keys` still runs it; once that line runs `chord-remote` beside it, this file can go",
            );
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => changes.add(&path, "removed; the daemon is `chord-remote` beside it"),
            Err(error) => changes.fail(&path, &format!("could not be removed: {error}")),
        }
    }
}

/// The time now, as the note's headings say it.
fn now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| i64::try_from(since.as_secs()).unwrap_or(0))
        .unwrap_or(0);
    format!(
        "{} {:02}:{:02} UTC",
        crate::notes::day(secs),
        secs.rem_euclid(86_400) / 3600,
        secs.rem_euclid(3600) / 60
    )
}

/// Adds what a run changed and could not change to the note, under the
/// time it ran, leaving out lines the note has already.
fn write_note(note: &Path, home: &Path, changes: &Changes) -> Result<(), String> {
    let mut text = match std::fs::read_to_string(note) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("could not read {}: {error}", note.display())),
    };
    let fresh = |lines: &[String]| -> Vec<String> {
        let mut kept: Vec<String> = Vec::new();
        for line in lines {
            if !text.lines().any(|had| had == line) && !kept.contains(line) {
                kept.push(line.clone());
            }
        }
        kept
    };
    let (done, failed) = (fresh(&changes.done), fresh(&changes.failed));
    if text.is_empty() {
        text = format!(
            "# Moved from Agent Workbench to Chord\n\nChord moved its folder from `{}` to `{}` and left a link at the old path. Each file it changed to the new names is listed below, under the time it was changed, and each file it could not change under its own heading. A project opened later that still had the old names is added when it is opened.\n",
            home.join(OLD_DIR).display(),
            home.join(crate::home::DIR).display()
        );
    } else if done.is_empty() && failed.is_empty() {
        return Ok(());
    }
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&format!("\n## {}\n\n", now()));
    if done.is_empty() && failed.is_empty() {
        text.push_str("No file needed changing.\n");
    }
    for line in &done {
        text.push_str(line);
        text.push('\n');
    }
    if !failed.is_empty() {
        if !done.is_empty() {
            text.push('\n');
        }
        text.push_str("### Not changed\n\nEach is tried again at the next start, or, in a project, when the project is next opened.\n\n");
        for line in &failed {
            text.push_str(line);
            text.push('\n');
        }
    }
    hook::write_whole(note, &text)
}

#[cfg(test)]
#[path = "migrate_tests.rs"]
mod tests;
