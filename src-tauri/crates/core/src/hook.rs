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

use serde::Serialize;
use serde_json::{json, Map, Value};

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
pub fn status(home: &Path, project: &Path) -> HookStatus {
    let settings = settings_path(project);
    let read = read_settings(&settings);
    let installed = has_ours(&read, "PostToolUse", home)
        && CLAUDE_SESSION_EVENTS
            .iter()
            .all(|event| has_ours(&read, event, home));
    HookStatus {
        installed,
        settings: settings.to_string_lossy().to_string(),
        events: events_path(home).to_string_lossy().to_string(),
    }
}

/// Adds the hooks, leaving every other setting and every other hook alone.
pub fn install(home: &Path, project: &Path) -> Result<HookStatus, String> {
    let path = settings_path(project);
    let mut settings = read_settings(&path);
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

    let codex = codex_hooks_path(project);
    let mut hooks = read_settings(&codex);
    let mut changed = false;
    for event in CODEX_SESSION_EVENTS {
        changed |= add_entry(&mut hooks, event, session_entry(home), home)?;
    }
    if changed {
        write_settings(&codex, &hooks)?;
    }

    touch_events(home)?;
    Ok(status(home, project))
}

/// Removes only our entries. Anything else in the files stays, and a Codex
/// file that held nothing but ours goes with them.
pub fn uninstall(home: &Path, project: &Path) -> Result<HookStatus, String> {
    let path = settings_path(project);
    if path.exists() {
        let mut settings = read_settings(&path);
        for event in ["PostToolUse"].iter().chain(CLAUDE_SESSION_EVENTS) {
            remove_entries(&mut settings, event, home);
        }
        write_settings(&path, &settings)?;
    }

    let codex = codex_hooks_path(project);
    if codex.exists() {
        let mut hooks = read_settings(&codex);
        for event in CODEX_SESSION_EVENTS {
            remove_entries(&mut hooks, event, home);
        }
        if hooks.is_empty() {
            std::fs::remove_file(&codex).map_err(|e| format!("could not remove {codex:?}: {e}"))?;
        } else {
            write_settings(&codex, &hooks)?;
        }
    }

    Ok(status(home, project))
}

fn write_settings(path: &Path, settings: &Map<String, Value>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create {parent:?}: {e}"))?;
    }
    let text = serde_json::to_string_pretty(&Value::Object(settings.clone()))
        .map_err(|e| format!("could not write settings: {e}"))?;
    std::fs::write(path, format!("{text}\n")).map_err(|e| format!("could not write settings: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("workbench-hook-{name}"));
        std::fs::remove_dir_all(&base).ok();
        let home = base.join("home");
        let project = base.join("project");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        (home, project)
    }

    fn settings_of(project: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(settings_path(project)).unwrap()).unwrap()
    }

    #[test]
    fn reports_not_installed_when_there_are_no_settings() {
        let (home, project) = fixture("none");
        assert!(!status(&home, &project).installed);
    }

    #[test]
    fn installs_and_reports_itself() {
        let (home, project) = fixture("install");
        assert!(install(&home, &project).unwrap().installed);
        assert!(status(&home, &project).installed);
    }

    // The untracked settings file, so nobody finds this in a diff.
    #[test]
    fn writes_to_settings_local_not_the_shared_one() {
        let (home, project) = fixture("local");
        install(&home, &project).unwrap();

        assert!(project.join(".claude/settings.local.json").exists());
        assert!(!project.join(".claude/settings.json").exists());
    }

    #[test]
    fn only_reacts_to_tools_that_change_files() {
        let (home, project) = fixture("matcher");
        install(&home, &project).unwrap();

        let entry = &settings_of(&project)["hooks"]["PostToolUse"][0];
        assert_eq!(entry["matcher"], MATCHER);
        assert!(!MATCHER.contains("Read"));
    }

    #[test]
    fn writes_outside_the_project() {
        let (home, project) = fixture("outside");
        install(&home, &project).unwrap();

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
        install(&home, &project).unwrap();
        install(&home, &project).unwrap();

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

        install(&home, &project).unwrap();
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

        install(&home, &project).unwrap();
        let entries = settings_of(&project)["hooks"]["PostToolUse"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(entries.len(), 2);

        uninstall(&home, &project).unwrap();
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
        install(&home, &project).unwrap();
        assert!(!uninstall(&home, &project).unwrap().installed);
    }

    // Nothing left behind that was not there before.
    #[test]
    fn uninstalling_the_only_hook_leaves_no_empty_scaffolding() {
        let (home, project) = fixture("scaffolding");
        install(&home, &project).unwrap();
        uninstall(&home, &project).unwrap();

        let settings = settings_of(&project);
        assert!(settings.get("hooks").is_none(), "{settings}");
    }

    #[test]
    fn uninstalling_when_it_was_never_there_is_not_an_error() {
        let (home, project) = fixture("absent");
        assert!(!uninstall(&home, &project).unwrap().installed);
    }

    #[test]
    fn survives_a_settings_file_that_is_not_json() {
        let (home, project) = fixture("broken");
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        std::fs::write(settings_path(&project), "{ not json").unwrap();

        // Better to start fresh than to refuse: the file was already unusable.
        assert!(install(&home, &project).unwrap().installed);
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
        install(&home, &project).unwrap();
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
        install(&home, &project).unwrap();

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
        assert!(status(&home, &project).installed);
    }

    #[test]
    fn uninstalling_takes_the_session_hooks_too_and_an_empty_codex_file_with_them() {
        let (home, project) = fixture("sessions-off");
        install(&home, &project).unwrap();
        uninstall(&home, &project).unwrap();
        assert!(settings_of(&project).get("hooks").is_none());
        assert!(!codex_hooks_path(&project).exists());
        assert!(!status(&home, &project).installed);
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
        install(&home, &project).unwrap();
        let hooks = codex_hooks_of(&project);
        assert_eq!(hooks["hooks"]["Stop"].as_array().unwrap().len(), 2);
        uninstall(&home, &project).unwrap();
        let hooks = codex_hooks_of(&project);
        assert_eq!(hooks["description"], "mine");
        assert_eq!(hooks["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(hooks["hooks"]["Stop"][0]["hooks"][0]["command"], "say done");
    }

    #[test]
    fn is_not_installed_until_every_hook_is_there() {
        let (home, project) = fixture("partial");
        install(&home, &project).unwrap();
        let mut settings = read_settings(&settings_path(&project));
        remove_entries(&mut settings, "Stop", &home);
        write_settings(&settings_path(&project), &settings).unwrap();
        assert!(!status(&home, &project).installed);
        install(&home, &project).unwrap();
        assert!(status(&home, &project).installed);
    }
}
