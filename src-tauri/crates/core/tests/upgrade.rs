//! An upgrade from the last release under the earlier name, run as one: a
//! home in the shape 1.0.0-beta.6 leaves it, and the daemon's own migration
//! run over it as a process, with nothing of the environment it runs in but
//! the home, so nothing outside the scratch folder can be reached.
#![cfg(unix)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use chord_core::scratch::Scratch;
use serde_json::{json, Value};

const TOKEN: &str = "session-token-1";
const TRANSCRIPT: &str = "{\"cwd\":\"orchestrator\",\"type\":\"user\"}\n";
const OTHER_KEY: &str = "ssh-ed25519 AAAAOther someone@laptop";

fn mangle(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn json_at(path: &Path) -> Value {
    serde_json::from_str(&read(path)).unwrap()
}

/// The commands beta 6 wrote into a project's hooks, for an app folder.
fn hook_commands(dir: &Path, daemon: &str) -> [String; 3] {
    let d = dir.display();
    [
        format!("mkdir -p '{d}' && cat > '{d}/last-tool-use.json'"),
        format!("mkdir -p '{d}' && cat >> '{d}/sessions.jsonl'"),
        format!("'{d}/bin/{daemon}' reports 2>/dev/null || true"),
    ]
}

fn hooks(commands: &[String; 3], own: bool) -> Value {
    let entry = |command: &String| json!({ "hooks": [{ "type": "command", "command": command }] });
    let mut stop = vec![entry(&commands[1])];
    if own {
        stop.push(json!({ "hooks": [{ "type": "command", "command": "say done" }] }));
    }
    json!({
        "PostToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": commands[0] }] }],
        "Stop": stop,
        "UserPromptSubmit": [entry(&commands[1]), entry(&commands[2])],
    })
}

struct Fixture {
    _scratch: Scratch,
    home: PathBuf,
    project: PathBuf,
}

impl Fixture {
    fn old_dir(&self) -> PathBuf {
        self.home.join(".agent-workbench")
    }
    fn new_dir(&self) -> PathBuf {
        self.home.join(".chord")
    }
}

/// A home as beta 6 leaves it after a while of use, with a project hooked,
/// an orchestrator session, rules the user saved, two accounts, and the
/// files of a remote paired with a desktop.
fn beta_6_home() -> Fixture {
    let scratch = Scratch::new("upgrade");
    let home = dunce::canonicalize(&*scratch).unwrap();
    let old = home.join(".agent-workbench");
    let orchestrator = old.join("orchestrator");
    let daemon = old.join("bin/agent-workbench-remote");
    let server = json!({ "type": "stdio", "command": daemon, "args": ["mcp"] });
    let project = home.join("dev/demo");

    write(
        &old.join("settings.json"),
        &serde_json::to_string_pretty(&json!({
            "appearance": "dark",
            "accounts": { "list": { "work": { "claude": "~/.claude-work", "codex": "~/.codex-work" } } },
            "workflows": { "projects": { orchestrator.to_string_lossy(): "conduct" } },
        }))
        .unwrap(),
    );
    write(&old.join("sessions.jsonl"), "{\"session_id\":\"s1\"}\n");
    write(&old.join("last-tool-use.json"), "{}");
    write(&old.join("user.css"), "body { color: red; }\n");
    write(&old.join("remotes.json"), "[{\"name\":\"lab\",\"host\":\"10.0.0.2\",\"user\":\"ada\",\"hostKey\":\"ssh-ed25519 AAAA\"}]");
    write(&old.join("known_hosts"), "lab ssh-ed25519 AAAA\n");
    write(
        &old.join("keys/ada_lab"),
        "-----BEGIN OPENSSH PRIVATE KEY-----\n",
    );
    write(&daemon, "#!/bin/sh\necho 1.0.0-beta.6\n");
    write(&orchestrator.join("CLAUDE.md"), "orchestrate\n");

    // The notes store, made by the store itself, then put where beta 6
    // kept it.
    let maker = Scratch::new("upgrade-notes");
    let notes = chord_core::notes::Notes::open(&maker).unwrap();
    notes.set_brief(TOKEN, "the brief", 1).unwrap();
    let note = chord_core::notes::NewNote {
        title: "A note",
        summary: "kept",
        body: "body",
        replaces: None,
    };
    notes.add(TOKEN, &note, 2).unwrap();
    drop(notes);
    std::fs::rename(maker.join(".chord/notes"), old.join("notes")).unwrap();

    let canonical_orchestrator = orchestrator.to_string_lossy().to_string();
    for (claude, state) in [
        (home.join(".claude"), home.join(".claude.json")),
        (
            home.join(".claude-work"),
            home.join(".claude-work/.claude.json"),
        ),
    ] {
        write(
            &claude
                .join("projects")
                .join(mangle(&orchestrator))
                .join("abc.jsonl"),
            TRANSCRIPT,
        );
        write(
            &state,
            &serde_json::to_string_pretty(&json!({
                "numStartups": 3,
                "projects": {
                    canonical_orchestrator.clone(): { "hasTrustDialogAccepted": true, "mcpServers": { "agent-workbench": server } },
                    project.to_string_lossy(): {
                        "hasTrustDialogAccepted": true,
                        "mcpServers": { "agent-workbench": server, "other": { "command": "other" } },
                        "disabledMcpServers": ["agent-workbench"],
                    },
                },
            }))
            .unwrap(),
        );
    }
    write(
        &home.join(".claude-work/settings.json"),
        &serde_json::to_string_pretty(&json!({ "permissions": {
            "allow": ["mcp__agent-workbench__start", "Read"],
            "ask": ["mcp__agent-workbench__stop"],
            "deny": ["mcp__agent-workbench__terminal"],
        } }))
        .unwrap(),
    );
    write(
        &home.join(".claude/settings.json"),
        &serde_json::to_string_pretty(
            &json!({ "permissions": { "allow": ["mcp__agent-workbench", "Bash(ls)"] } }),
        )
        .unwrap(),
    );
    for codex in [home.join(".codex"), home.join(".codex-work")] {
        write(
            &codex.join("config.toml"),
            &format!(
                "model = \"gpt-5\"\n\n[projects.\"{canonical_orchestrator}\"]\ntrust_level = \"trusted\"\n\n[projects.\"{}\"]\ntrust_level = \"trusted\"\n\n[mcp_servers.agent_workbench.tools.start]\napproval_mode = \"approve\"\n",
                project.display()
            ),
        );
    }

    // The project, hooked by beta 6, with a hook and rules of the user's
    // own, and an entry a later install added beside the old one.
    let old_commands = hook_commands(&old, "agent-workbench-remote");
    let new_commands = hook_commands(&home.join(".chord"), "chord-remote");
    let mut local_hooks = hooks(&old_commands, true);
    local_hooks["Stop"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "hooks": [{ "type": "command", "command": new_commands[1] }] }));
    write(
        &project.join(".claude/settings.local.json"),
        &serde_json::to_string_pretty(&json!({
            "hooks": local_hooks,
            "permissions": { "allow": ["mcp__agent-workbench__show", "Read"] },
        }))
        .unwrap(),
    );
    write(
        &project.join(".claude/settings.json"),
        &serde_json::to_string_pretty(
            &json!({ "permissions": { "ask": ["mcp__agent-workbench__start"] } }),
        )
        .unwrap(),
    );
    write(
        &project.join(".codex/hooks.json"),
        &serde_json::to_string_pretty(&json!({ "hooks": hooks(&old_commands, false) })).unwrap(),
    );
    write(
        &project.join(".codex/config.toml"),
        &format!(
            "[mcp_servers.agent_workbench]\ncommand = \"{}\"\nargs = [\"mcp\"]\n\n[mcp_servers.agent_workbench.tools.notify]\napproval_mode = \"approve\"\n",
            daemon.display()
        ),
    );

    // The machine's side of a pairing.
    write(
        &home.join(".ssh/authorized_keys"),
        &format!(
            "{OTHER_KEY}\ncommand=\"{} serve\",restrict ssh-ed25519 AAAAPaired agent-workbench agent-workbench\n",
            daemon.display()
        ),
    );
    Fixture {
        _scratch: scratch,
        home,
        project,
    }
}

/// The daemon's migration, with nothing of this process's environment.
fn migrate(home: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_chord-remote"))
        .arg("migrate")
        .env_clear()
        .env("HOME", home)
        .env("PATH", "/usr/bin:/bin")
        .env("SHELL", "/bin/sh")
        .output()
        .expect("the daemon runs")
}

/// Every file and link under the home, by path, with what it holds.
fn snapshot(home: &Path) -> BTreeMap<PathBuf, String> {
    let mut all = BTreeMap::new();
    let mut stack = vec![home.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            let kind = entry.file_type().unwrap();
            if kind.is_symlink() {
                all.insert(
                    path.clone(),
                    format!("-> {}", std::fs::read_link(&path).unwrap().display()),
                );
            } else if kind.is_dir() {
                stack.push(path);
            } else {
                let bytes = std::fs::read(&path).unwrap();
                all.insert(path, String::from_utf8_lossy(&bytes).to_string());
            }
        }
    }
    all
}

fn assert_moved_over(fixture: &Fixture, before: &BTreeMap<PathBuf, String>) {
    let (home, old, new) = (&fixture.home, fixture.old_dir(), fixture.new_dir());
    let daemon = new.join("bin/chord-remote").to_string_lossy().to_string();

    // The folder, with a link left behind, and everything in it kept.
    assert_eq!(std::fs::read_link(&old).unwrap(), Path::new(".chord"));
    for (path, text) in before {
        let Ok(rest) = path.strip_prefix(&old) else {
            continue;
        };
        let moved = new.join(rest);
        if rest == Path::new("bin/agent-workbench-remote") {
            assert!(!moved.exists(), "the old daemon is gone");
        } else if rest == Path::new("settings.json") {
            assert_eq!(read(&moved), text.replace("/.agent-workbench/", "/.chord/"));
        } else {
            let bytes = std::fs::read(&moved).unwrap();
            assert_eq!(
                &String::from_utf8_lossy(&bytes),
                text,
                "{} kept",
                rest.display()
            );
        }
    }
    let notes = chord_core::notes::Notes::open(home).unwrap();
    assert_eq!(notes.brief(TOKEN).unwrap().unwrap().text, "the brief");
    assert_eq!(notes.all(TOKEN).unwrap()[0].title, "A note");

    // The orchestrator folder's identity, in both accounts.
    let orchestrator = new.join("orchestrator");
    let key = orchestrator.to_string_lossy().to_string();
    for claude in [".claude", ".claude-work"] {
        let projects = home.join(claude).join("projects");
        assert_eq!(
            read(&projects.join(mangle(&orchestrator)).join("abc.jsonl")),
            TRANSCRIPT
        );
        assert!(!projects.join(mangle(&old.join("orchestrator"))).exists());
    }
    for state in [
        home.join(".claude.json"),
        home.join(".claude-work/.claude.json"),
    ] {
        let state_json = json_at(&state);
        let projects = &state_json["projects"];
        assert_eq!(projects[&key]["hasTrustDialogAccepted"], true);
        assert_eq!(
            projects[&key]["mcpServers"],
            json!({ "chord": { "type": "stdio", "command": daemon, "args": ["mcp"] } })
        );
        let project = &projects[fixture.project.to_string_lossy().as_ref()];
        assert_eq!(project["mcpServers"]["chord"]["command"], daemon.as_str());
        assert_eq!(
            project["mcpServers"]["other"],
            json!({ "command": "other" })
        );
        assert_eq!(project["disabledMcpServers"], json!(["chord"]));
        assert_eq!(state_json["numStartups"], 3);
        assert!(!read(&state).contains("agent-workbench"));
    }
    for codex in [".codex", ".codex-work"] {
        let text = read(&home.join(codex).join("config.toml"));
        assert!(
            text.contains(&format!("[projects.\"{key}\"]\ntrust_level = \"trusted\"")),
            "{text}"
        );
        assert!(
            text.contains("[mcp_servers.chord.tools.start]\napproval_mode = \"approve\""),
            "{text}"
        );
        assert!(text.starts_with("model = \"gpt-5\""));
        assert!(!text.contains("agent"), "{text}");
    }

    // The rules the user saved, each kept where it was.
    assert_eq!(
        json_at(&home.join(".claude-work/settings.json"))["permissions"],
        json!({ "allow": ["mcp__chord__start", "Read"], "ask": ["mcp__chord__stop"], "deny": ["mcp__chord__terminal"] })
    );
    assert_eq!(
        json_at(&home.join(".claude/settings.json"))["permissions"]["allow"],
        json!(["mcp__chord", "Bash(ls)"])
    );

    // The project's hooks, each once, the user's own kept.
    let new_commands = hook_commands(&new, "chord-remote");
    let local = json_at(&fixture.project.join(".claude/settings.local.json"));
    assert_eq!(local["hooks"], hooks(&new_commands, true));
    assert_eq!(
        local["permissions"]["allow"],
        json!(["mcp__chord__show", "Read"])
    );
    assert_eq!(
        json_at(&fixture.project.join(".claude/settings.json"))["permissions"]["ask"],
        json!(["mcp__chord__start"])
    );
    assert_eq!(
        json_at(&fixture.project.join(".codex/hooks.json"))["hooks"],
        hooks(&new_commands, false)
    );
    assert_eq!(
        read(&fixture.project.join(".codex/config.toml")),
        format!("[mcp_servers.chord]\ncommand = \"{daemon}\"\nargs = [\"mcp\"]\n\n[mcp_servers.chord.tools.notify]\napproval_mode = \"approve\"\n")
    );

    // The pairing runs the daemon that migrated.
    assert_eq!(
        read(&home.join(".ssh/authorized_keys")),
        format!(
            "{OTHER_KEY}\ncommand=\"{} serve\",restrict ssh-ed25519 AAAAPaired chord chord\n",
            env!("CARGO_BIN_EXE_chord-remote")
        )
    );

    // The note names every file changed.
    let note = read(&new.join("migration.md"));
    for file in [
        home.join(".claude.json"),
        home.join(".claude-work/.claude.json"),
        home.join(".claude-work/settings.json"),
        home.join(".claude/settings.json"),
        home.join(".codex/config.toml"),
        home.join(".codex-work/config.toml"),
        fixture.project.join(".claude/settings.local.json"),
        fixture.project.join(".claude/settings.json"),
        fixture.project.join(".codex/hooks.json"),
        fixture.project.join(".codex/config.toml"),
        home.join(".ssh/authorized_keys"),
        new.join("settings.json"),
        home.join(".claude/projects").join(mangle(&orchestrator)),
    ] {
        assert!(
            note.contains(&format!("`{}`", file.display())),
            "{} in {note}",
            file.display()
        );
    }
}

#[test]
fn an_upgrade_from_beta_6_keeps_everything_under_the_new_names() {
    let fixture = beta_6_home();
    let before = snapshot(&fixture.home);
    let first = migrate(&fixture.home);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert!(String::from_utf8_lossy(&first.stdout).contains("migration.md"));
    assert_moved_over(&fixture, &before);

    // A second run changes nothing.
    let after = snapshot(&fixture.home);
    let second = migrate(&fixture.home);
    assert_eq!(
        String::from_utf8_lossy(&second.stdout).trim(),
        "nothing to move"
    );
    assert_eq!(snapshot(&fixture.home), after);
}

#[test]
fn a_move_cut_off_after_the_folder_is_finished_by_the_next_run() {
    let fixture = beta_6_home();
    let before = snapshot(&fixture.home);
    std::fs::rename(fixture.old_dir(), fixture.new_dir()).unwrap();
    std::os::unix::fs::symlink(".chord", fixture.old_dir()).unwrap();
    let run = migrate(&fixture.home);
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    assert_moved_over(&fixture, &before);
}

#[test]
fn a_move_that_fails_changes_nothing_and_the_next_run_makes_it() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = beta_6_home();
    let before = snapshot(&fixture.home);
    let locked = std::fs::Permissions::from_mode(0o555);
    std::fs::set_permissions(&fixture.home, locked).unwrap();
    let failed = migrate(&fixture.home);
    std::fs::set_permissions(&fixture.home, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(String::from_utf8_lossy(&failed.stderr).contains("could not move"));
    assert_eq!(snapshot(&fixture.home), before);

    let run = migrate(&fixture.home);
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    assert_moved_over(&fixture, &before);
}

#[test]
fn an_install_that_made_the_new_folder_first_is_merged_into() {
    let fixture = beta_6_home();
    let before = snapshot(&fixture.home);
    // What the install over ssh does before the daemon runs.
    write(&fixture.new_dir().join("bin/chord-remote"), "new daemon\n");
    write(&fixture.new_dir().join("user.css"), "a newer style\n");
    let run = migrate(&fixture.home);
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    assert_eq!(
        read(&fixture.new_dir().join("bin/chord-remote")),
        "new daemon\n"
    );
    assert_eq!(read(&fixture.new_dir().join("user.css")), "a newer style\n");
    assert_eq!(
        read(&fixture.new_dir().join("kept-from-before/user.css")),
        "body { color: red; }\n"
    );
    let mut expected = before;
    expected.insert(fixture.old_dir().join("user.css"), "a newer style\n".into());
    assert_moved_over(&fixture, &expected);
}

#[test]
fn a_project_opened_later_is_brought_over_then() {
    let fixture = beta_6_home();
    let run = migrate(&fixture.home);
    assert!(run.status.success());
    let later = fixture.home.join("dev/later");
    let commands = hook_commands(&fixture.old_dir(), "agent-workbench-remote");
    write(
        &later.join(".claude/settings.local.json"),
        &serde_json::to_string_pretty(&json!({ "hooks": hooks(&commands, false) })).unwrap(),
    );
    chord_core::hook::status(&fixture.home, &later, &[], &Default::default());
    let local = json_at(&later.join(".claude/settings.local.json"));
    assert_eq!(
        local["hooks"],
        hooks(&hook_commands(&fixture.new_dir(), "chord-remote"), false)
    );
    assert!(
        read(&fixture.new_dir().join("migration.md")).contains(&format!(
            "`{}`",
            later.join(".claude/settings.local.json").display()
        ))
    );
}

#[test]
fn a_fresh_install_has_nothing_to_move() {
    let scratch = Scratch::new("upgrade-fresh");
    let run = migrate(&scratch);
    assert_eq!(
        String::from_utf8_lossy(&run.stdout).trim(),
        "nothing to move"
    );
    assert!(!scratch.join(".chord").exists());
}
