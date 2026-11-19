use super::*;
use crate::scratch::Scratch;

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

#[test]
fn only_a_line_pairing_wrote_is_taken_for_one() {
    assert_eq!(
        paired_key("command=\"/h/.agent-workbench/bin/agent-workbench-remote serve\",restrict ssh-ed25519 AAAA agent-workbench agent-workbench")
            .as_deref(),
        Some("ssh-ed25519 AAAA chord")
    );
    assert_eq!(paired_key("ssh-ed25519 AAAA agent-workbench"), None);
    assert_eq!(
        paired_key("command=\"/usr/bin/other serve\",restrict ssh-ed25519 AAAA agent-workbench"),
        None
    );
    assert_eq!(
        paired_key(
            "command=\"/h/.chord/bin/chord-remote serve\",restrict ssh-ed25519 AAAA chord chord"
        ),
        None
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

    let note = run(&home, &home.join("daemon"), &HashMap::new()).unwrap();
    assert!(note.is_some());
    assert_eq!(std::fs::read_link(home.join(".chord")).unwrap(), target);
    assert_eq!(
        std::fs::read_link(home.join(OLD_DIR)).unwrap(),
        Path::new(".chord")
    );
    assert!(transcripts.is_dir());
    assert!(!needed(&home));
}

#[cfg(unix)]
#[test]
fn a_move_that_fails_leaves_the_old_folder_in_use_for_the_run() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::new("migrate-in-use");
    let home = dunce::canonicalize(&*scratch).unwrap();
    std::fs::create_dir_all(home.join(OLD_DIR)).unwrap();
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o555)).unwrap();
    let failed = run(&home, &home.join("daemon"), &HashMap::new());
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(failed.is_err());
    assert_eq!(crate::home::dir(&home), home.join(OLD_DIR));
    assert_eq!(
        crate::hook::daemon_path(&home).parent().unwrap(),
        home.join(OLD_DIR).join("bin")
    );

    run(&home, &home.join("daemon"), &HashMap::new()).unwrap();
    assert_eq!(crate::home::dir(&home), home.join(".chord"));
}
