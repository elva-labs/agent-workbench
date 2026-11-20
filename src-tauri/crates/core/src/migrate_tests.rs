use super::*;
use crate::scratch::Scratch;

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// A home with an install under the earlier name, holding `settings.json`.
fn old_home(label: &str) -> (Scratch, PathBuf) {
    let scratch = Scratch::new(label);
    let home = dunce::canonicalize(&*scratch).unwrap();
    write(
        &home.join(OLD_DIR).join("settings.json"),
        "{\"theme\":\"mine\"}",
    );
    (scratch, home)
}

#[test]
fn a_rule_for_the_old_server_names_the_new_one() {
    assert_eq!(
        renamed_rule("mcp__agent-workbench").as_deref(),
        Some("mcp__chord")
    );
    assert_eq!(
        renamed_rule("mcp__agent-workbench__start").as_deref(),
        Some("mcp__chord__start")
    );
    assert_eq!(
        renamed_rule("mcp__agent-workbench__*").as_deref(),
        Some("mcp__chord__*")
    );
    assert_eq!(renamed_rule("mcp__agent-workbench-plugins__x"), None);
    assert_eq!(renamed_rule("Bash(agent-workbench)"), None);
}

/// A rule that names a path into the old folder, a deny most of all, has
/// to name the new one to go on matching what it did.
#[test]
fn a_rule_with_a_path_into_the_old_folder_names_the_new_one() {
    assert_eq!(
        renamed_rule("Read(~/.agent-workbench/keys/**)").as_deref(),
        Some("Read(~/.chord/keys/**)")
    );
    assert_eq!(
        renamed_rule("Edit(//home/ada/.agent-workbench)").as_deref(),
        Some("Edit(//home/ada/.chord)")
    );
    assert_eq!(renamed_rule("Read(~/.agent-workbench-old/**)"), None);
}

#[test]
fn a_path_is_renamed_only_where_the_old_folder_is_a_whole_segment() {
    let from = "/home/ada/.agent-workbench";
    let to = "/home/ada/.chord";
    assert_eq!(
        replace_segment(
            "{\"a\":\"/home/ada/.agent-workbench/orchestrator\",\"b\":\"/home/ada/.agent-workbench\",\"other\":\"/home/ada/.agent-workbench-old/x\"}",
            from,
            to
        ),
        "{\"a\":\"/home/ada/.chord/orchestrator\",\"b\":\"/home/ada/.chord\",\"other\":\"/home/ada/.agent-workbench-old/x\"}"
    );
}

#[cfg(unix)]
fn renames(home: &Path) -> Renames {
    Renames {
        commands: Vec::new(),
        daemons: Daemons::of(home, &home.join(".chord/bin/chord-remote")),
    }
}

/// The server's entry keeps a folder the user chose, and a list that only
/// happens to hold the old name is left alone.
#[cfg(unix)]
#[test]
fn a_server_of_the_users_own_keeps_its_folder_and_other_lists_are_left() {
    let home = Path::new("/home/ada");
    let mut state = serde_json::json!({
        "projects": {
            "/home/ada/a": {
                "mcpServers": { "agent-workbench": { "command": "/opt/homebrew/bin/agent-workbench-remote", "args": ["mcp"] } },
                "disabledMcpServers": ["agent-workbench"],
                "exampleFiles": ["agent-workbench", "main.rs"],
            },
            "/home/ada/b": { "mcpServers": { "agent-workbench": { "command": "agent-workbench-remote" } } },
            "/home/ada/c": { "mcpServers": { "agent-workbench": { "command": "/home/ada/.agent-workbench/bin/agent-workbench-remote" } } },
            "/home/ada/d": { "mcpServers": { "chord": { "command": "/home/ada/.agent-workbench/bin/chord-remote" } } },
        },
    });
    assert!(rename_value(&mut state, &renames(home)));
    let projects = &state["projects"];
    assert_eq!(
        projects["/home/ada/a"]["mcpServers"],
        serde_json::json!({ "chord": { "command": "/opt/homebrew/bin/chord-remote", "args": ["mcp"] } })
    );
    assert_eq!(
        projects["/home/ada/a"]["disabledMcpServers"],
        serde_json::json!(["chord"])
    );
    assert_eq!(
        projects["/home/ada/a"]["exampleFiles"],
        serde_json::json!(["agent-workbench", "main.rs"])
    );
    assert_eq!(
        projects["/home/ada/b"]["mcpServers"]["chord"]["command"],
        "chord-remote"
    );
    for project in ["/home/ada/c", "/home/ada/d"] {
        assert_eq!(
            projects[project]["mcpServers"]["chord"]["command"],
            "/home/ada/.chord/bin/chord-remote"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_pairing_line_runs_the_renamed_daemon_with_its_other_options_kept() {
    let home = Path::new("/h");
    let daemons = Daemons::of(home, Path::new("/h/.chord/bin/chord-remote"));
    assert_eq!(
        paired_line("command=\"/h/.agent-workbench/bin/agent-workbench-remote serve\",restrict ssh-ed25519 AAAA agent-workbench agent-workbench", &daemons)
            .as_deref(),
        Some("command=\"/h/.chord/bin/chord-remote serve\",restrict ssh-ed25519 AAAA chord chord")
    );
    assert_eq!(
        paired_line("from=\"10.0.0.1,10.0.0.2\",command=\"/h/.agent-workbench/bin/agent-workbench-remote serve\",restrict,no-pty ssh-ed25519 AAAA agent-workbench", &daemons)
            .as_deref(),
        Some("from=\"10.0.0.1,10.0.0.2\",command=\"/h/.chord/bin/chord-remote serve\",restrict,no-pty ssh-ed25519 AAAA chord")
    );
    assert_eq!(
        paired_line(
            "command=\"/opt/homebrew/bin/agent-workbench-remote serve\",restrict ssh-ed25519 AAAA me@laptop",
            &daemons
        )
        .as_deref(),
        Some("command=\"/opt/homebrew/bin/chord-remote serve\",restrict ssh-ed25519 AAAA me@laptop")
    );
    assert_eq!(
        paired_line("ssh-ed25519 AAAA agent-workbench", &daemons),
        None
    );
    assert_eq!(
        paired_line(
            "command=\"/usr/bin/other serve\",restrict ssh-ed25519 AAAA agent-workbench",
            &daemons
        ),
        None
    );
    assert_eq!(
        paired_line(
            "command=\"/h/.chord/bin/chord-remote serve\",restrict ssh-ed25519 AAAA chord chord",
            &daemons
        ),
        None
    );
}

/// A line the migration cannot read as a pairing still runs the old
/// daemon, so the daemon stays and the note says why.
#[cfg(unix)]
#[test]
fn the_old_daemon_stays_while_a_line_still_runs_it() {
    let (_scratch, home) = old_home("migrate-daemon-kept");
    write(
        &home.join(OLD_DIR).join("bin").join(OLD_DAEMON),
        "old daemon\n",
    );
    write(
        &home.join(".ssh/authorized_keys"),
        "command=\"agent-workbench-remote serve --weird\" ssh-ed25519 AAAA agent-workbench\n",
    );
    let note = run(&home, Some(&home.join("daemon")), &HashMap::new())
        .unwrap()
        .unwrap();
    assert_eq!(
        read(&home.join(".chord/bin").join(OLD_DAEMON)),
        "old daemon\n"
    );
    assert!(read(&note).contains("still runs it"));
}

#[test]
fn a_shared_file_has_only_the_old_names_changed_in_place() {
    let text = "{\n  \"mcpServers\": {\"agent-workbench\":   {\"command\": \"/home/ada/.agent-workbench/bin/agent-workbench-remote\"}},\n  \"zz\": [\"mcp__agent-workbench__start\", \"say \\\"agent-workbench\\\"\", \"mcp__agent-workbench-plugins__x\"]\n}\n";
    assert_eq!(
        renamed_strings(text),
        "{\n  \"mcpServers\": {\"chord\":   {\"command\": \"/home/ada/.agent-workbench/bin/agent-workbench-remote\"}},\n  \"zz\": [\"mcp__chord__start\", \"say \\\"agent-workbench\\\"\", \"mcp__agent-workbench-plugins__x\"]\n}\n"
    );
}

/// A folder that is a link, as dotfiles make it, moves as a link, and the
/// orchestrator folder keeps its resolved path, so nothing is carried.
#[cfg(unix)]
#[test]
fn a_folder_that_is_a_link_moves_as_a_link() {
    let scratch = Scratch::new("migrate-dotfiles");
    let home = dunce::canonicalize(&*scratch).unwrap();
    let target = home.join("dotfiles/workbench");
    std::fs::create_dir_all(target.join("orchestrator")).unwrap();
    std::fs::write(target.join("settings.json"), "{}").unwrap();
    std::os::unix::fs::symlink(&target, home.join(OLD_DIR)).unwrap();
    let transcripts = home
        .join(".claude/projects")
        .join(crate::transcripts::mangle(&target.join("orchestrator")));
    std::fs::create_dir_all(&transcripts).unwrap();

    let note = run(&home, Some(&home.join("daemon")), &HashMap::new()).unwrap();
    assert!(note.is_some());
    assert_eq!(std::fs::read_link(home.join(".chord")).unwrap(), target);
    assert_eq!(
        std::fs::read_link(home.join(OLD_DIR)).unwrap(),
        Path::new(".chord")
    );
    assert!(transcripts.is_dir());
    assert!(!needed(&home));
    assert!(!target.join(MOVING).exists());
}

/// A dotfiles link and a `.chord` made by something that ran first: what
/// `.chord` holds goes into the folder the link leads to, whose own files
/// win, and `.chord` becomes the link.
#[cfg(unix)]
#[test]
fn a_folder_that_is_a_link_takes_in_a_chord_folder_made_first() {
    let scratch = Scratch::new("migrate-dotfiles-early");
    let home = dunce::canonicalize(&*scratch).unwrap();
    let target = home.join("dotfiles/workbench");
    write(&target.join("settings.json"), "mine");
    std::os::unix::fs::symlink(&target, home.join(OLD_DIR)).unwrap();
    std::fs::create_dir_all(home.join(".chord/answers")).unwrap();
    write(&home.join(".chord/settings.json"), "stand-in");
    assert_eq!(crate::home::dir(&home), home.join(OLD_DIR));

    run(&home, Some(&home.join("daemon")), &HashMap::new()).unwrap();
    assert_eq!(std::fs::read_link(home.join(".chord")).unwrap(), target);
    assert_eq!(read(&target.join("settings.json")), "mine");
    assert_eq!(read(&target.join(KEPT).join("settings.json")), "stand-in");
    assert!(target.join("answers").is_dir());
    assert_eq!(crate::home::dir(&home), home.join(".chord"));
}

/// Until the move is made, every process uses the old folder, even with a
/// `.chord` that something made first.
#[test]
fn the_old_folder_is_in_use_until_it_is_moved() {
    let (_scratch, home) = old_home("migrate-unmoved");
    std::fs::create_dir_all(home.join(".chord/answers")).unwrap();
    assert_eq!(crate::home::dir(&home), home.join(OLD_DIR));
    assert_eq!(
        crate::settings::settings_path(&home),
        home.join(OLD_DIR).join("settings.json")
    );
}

#[cfg(unix)]
#[test]
fn a_move_that_fails_leaves_the_old_folder_in_use() {
    use std::os::unix::fs::PermissionsExt;
    let (_scratch, home) = old_home("migrate-in-use");
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o555)).unwrap();
    let failed = run(&home, Some(&home.join("daemon")), &HashMap::new());
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(failed.unwrap_err().contains("goes on using"));
    assert_eq!(crate::home::dir(&home), home.join(OLD_DIR));
    assert_eq!(
        crate::hook::daemon_path(&home).parent().unwrap(),
        home.join(OLD_DIR).join("bin")
    );
    assert!(!home.join(OLD_DIR).join(MOVING).exists());

    run(&home, Some(&home.join("daemon")), &HashMap::new()).unwrap();
    assert_eq!(crate::home::dir(&home), home.join(".chord"));
}

/// A `.chord` that is not a folder of its own stops the move, and the app
/// stays on the old folder with nothing lost.
#[test]
fn a_chord_that_is_not_a_folder_leaves_the_old_one_in_use() {
    let (_scratch, home) = old_home("migrate-not-a-folder");
    write(&home.join(".chord"), "a file");
    let error = run(&home, Some(&home.join("daemon")), &HashMap::new()).unwrap_err();
    assert!(error.contains("not a folder"), "{error}");
    assert_eq!(crate::home::dir(&home), home.join(OLD_DIR));
    assert_eq!(
        read(&home.join(OLD_DIR).join("settings.json")),
        "{\"theme\":\"mine\"}"
    );
    assert!(needed(&home));
}

/// The folder of the earlier name made again after the move, by a hook
/// from before it: `.chord` stays the install, and takes in the rest.
#[cfg(unix)]
#[test]
fn an_old_folder_made_again_after_the_move_is_taken_in() {
    let (_scratch, home) = old_home("migrate-made-again");
    write(&home.join(OLD_DIR).join("sessions.jsonl"), "real\n");
    run(&home, Some(&home.join("daemon")), &HashMap::new()).unwrap();
    std::fs::remove_file(home.join(OLD_DIR)).unwrap();
    write(&home.join(OLD_DIR).join("sessions.jsonl"), "stray\n");
    write(&home.join(OLD_DIR).join("last-tool-use.json"), "{}");
    assert_eq!(crate::home::dir(&home), home.join(".chord"));
    assert!(needed(&home));

    run(&home, Some(&home.join("daemon")), &HashMap::new()).unwrap();
    assert_eq!(read(&home.join(".chord/sessions.jsonl")), "real\n");
    assert_eq!(
        read(&home.join(".chord").join(KEPT).join("sessions.jsonl")),
        "stray\n"
    );
    assert_eq!(read(&home.join(".chord/last-tool-use.json")), "{}");
    assert_eq!(
        std::fs::read_link(home.join(OLD_DIR)).unwrap(),
        Path::new(".chord")
    );
    assert!(!needed(&home));
}

/// A file outside a project that cannot be changed is noted, keeps the
/// move under way, and is changed by the next run. The note keeps both
/// runs' lines.
#[cfg(unix)]
#[test]
fn a_file_that_cannot_be_changed_is_tried_again() {
    let (_scratch, home) = old_home("migrate-retry");
    let state = home.join(".claude.json");
    write(&state, "[\"mcp__agent-workbench__start\"]");
    let error = run(&home, Some(&home.join("daemon")), &HashMap::new()).unwrap_err();
    assert!(error.contains("migration.md"), "{error}");
    let note = read(&home.join(".chord").join(NOTE));
    assert!(note.contains("### Not changed"), "{note}");
    assert!(note.contains(&format!("`{}`", state.display())), "{note}");
    assert!(home.join(".chord").join(MOVING).exists());
    assert!(needed(&home));

    write(
        &state,
        "{\"allowedTools\":[\"mcp__agent-workbench__start\"]}",
    );
    run(&home, Some(&home.join("daemon")), &HashMap::new()).unwrap();
    assert!(read(&state).contains("mcp__chord__start"));
    assert!(!needed(&home));
    let note = read(&home.join(".chord").join(NOTE));
    assert!(note.contains("moved here from"), "{note}");
    assert_eq!(note.matches("\n## ").count(), 2, "{note}");
    assert_eq!(note.matches("# Moved from").count(), 1, "{note}");
}

/// A project's files that git tracks are not written; the note names them.
#[test]
fn a_project_keeps_the_files_git_tracks() {
    let (_scratch, home) = old_home("migrate-tracked");
    run(&home, Some(&home.join("daemon")), &HashMap::new()).unwrap();
    let project = Scratch::new("migrate-tracked-project");
    let project = dunce::canonicalize(&*project).unwrap();
    let repo = git2::Repository::init(&project).unwrap();
    let shared = "{ \"mcpServers\": { \"agent-workbench\": { \"command\": \"agent-workbench-remote\" } } }\n";
    let local = "{ \"permissions\": { \"allow\": [\"mcp__agent-workbench__show\"] } }\n";
    write(&project.join(".mcp.json"), shared);
    write(&project.join(".claude/settings.local.json"), local);
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(".mcp.json")).unwrap();
    index.write().unwrap();

    project_files_now(&home, &project);
    assert_eq!(read(&project.join(".mcp.json")), shared);
    assert!(read(&project.join(".claude/settings.local.json")).contains("mcp__chord__show"));
    let note = read(&home.join(".chord").join(NOTE));
    assert!(note.contains(&format!(
        "`{}`: names the earlier tool server, daemon or folder, and git tracks it",
        project.join(".mcp.json").display()
    )));
}

/// What [`project`] does on opening, without its memory of the folders it
/// has checked in this process.
fn project_files_now(home: &Path, folder: &Path) {
    let mut changes = Changes::default();
    project_files(home, folder, &mut changes);
    write_note(&crate::home::dir(home).join(NOTE), home, &changes).unwrap();
}
