//! An optional `PostToolUse` hook, so the changes pane hears from the agent
//! rather than only from the filesystem.
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

pub fn events_path(home: &Path) -> PathBuf {
    home.join(".agent-workbench").join("last-tool-use.json")
}

fn settings_path(project: &Path) -> PathBuf {
    project.join(".claude").join("settings.local.json")
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
    let events = events_path(home);
    if let Some(parent) = events.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create {parent:?}: {e}"))?;
    }
    if !events.exists() {
        std::fs::write(&events, "").map_err(|e| format!("could not create {events:?}: {e}"))?;
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
    let ours = command(home);
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| {
            hooks
                .iter()
                .any(|hook| hook.get("command").and_then(Value::as_str) == Some(ours.as_str()))
        })
}

pub fn status(home: &Path, project: &Path) -> HookStatus {
    let settings = settings_path(project);
    let installed = read_settings(&settings)
        .get("hooks")
        .and_then(|hooks| hooks.get("PostToolUse"))
        .and_then(Value::as_array)
        .is_some_and(|entries| entries.iter().any(|entry| is_ours(entry, home)));

    HookStatus {
        installed,
        settings: settings.to_string_lossy().to_string(),
        events: events_path(home).to_string_lossy().to_string(),
    }
}

/// Adds the hook, leaving every other setting and every other hook alone.
pub fn install(home: &Path, project: &Path) -> Result<HookStatus, String> {
    let path = settings_path(project);
    let mut settings = read_settings(&path);

    let hooks = settings
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("the hooks setting is not an object")?;

    let entries = hooks
        .entry("PostToolUse")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or("the PostToolUse setting is not a list")?;

    if !entries.iter().any(|entry| is_ours(entry, home)) {
        entries.push(json!({
            "matcher": MATCHER,
            "hooks": [{ "type": "command", "command": command(home) }],
        }));
        write_settings(&path, &settings)?;
    }

    touch_events(home)?;
    Ok(status(home, project))
}

/// Removes only our entry. Anything else in PostToolUse stays.
pub fn uninstall(home: &Path, project: &Path) -> Result<HookStatus, String> {
    let path = settings_path(project);
    let mut settings = read_settings(&path);

    if let Some(entries) = settings
        .get_mut("hooks")
        .and_then(|hooks| hooks.get_mut("PostToolUse"))
        .and_then(Value::as_array_mut)
    {
        entries.retain(|entry| !is_ours(entry, home));
        let empty = entries.is_empty();

        // Leave no empty scaffolding behind that was not there before.
        if empty {
            if let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) {
                hooks.remove("PostToolUse");
                if hooks.is_empty() {
                    settings.remove("hooks");
                }
            }
        }
        write_settings(&path, &settings)?;
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
        assert!(command.contains(&home.to_string_lossy().to_string()));
        assert!(!command.contains(&project.to_string_lossy().to_string()));
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
}
