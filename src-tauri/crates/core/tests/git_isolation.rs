//! A test run with `GIT_DIR` and `GIT_WORK_TREE` naming some other repository
//! leaves that repository alone. Its own binary, so that setting the
//! variables here reaches no other test.

use std::path::Path;
use std::process::Command;

use workbench_core::scratch::Scratch;

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_AUTHOR_NAME")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

struct Decoy(std::path::PathBuf);

impl Drop for Decoy {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Everything about a repository that a stray `git` could change.
fn fingerprint(dir: &Path) -> String {
    let dot = dir.join(".git");
    let read = |name: &str| std::fs::read_to_string(dot.join(name)).unwrap_or_default();
    format!(
        "{}\n--\n{}\n--\n{}\n--\n{}\n--\n{}",
        read("config"),
        read("HEAD"),
        git(dir, &["for-each-ref"]),
        git(dir, &["worktree", "list", "--porcelain"]),
        git(dir, &["status", "--porcelain"]),
    )
}

#[test]
fn git_variables_naming_another_repository_are_not_followed() {
    // Made by hand: the first scratch folder is what cuts git off, and the
    // variables have to be set before it.
    let decoy = std::env::temp_dir().join(format!(
        "workbench-git-isolation-decoy-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&decoy).unwrap();
    let decoy = Decoy(decoy);
    git(&decoy.0, &["init", "-q", "-b", "main"]);
    git(&decoy.0, &["config", "user.email", "decoy@example.com"]);
    git(&decoy.0, &["config", "user.name", "Decoy"]);
    std::fs::write(decoy.0.join("a.txt"), "one\n").unwrap();
    git(&decoy.0, &["add", "-A"]);
    git(&decoy.0, &["commit", "-qm", "one"]);
    let before = fingerprint(&decoy.0);

    std::env::set_var("GIT_DIR", decoy.0.join(".git"));
    std::env::set_var("GIT_WORK_TREE", &decoy.0);
    std::env::set_var("GIT_AUTHOR_NAME", "Intruder");

    let work = Scratch::new("git-isolation-work");
    assert!(std::env::var_os("GIT_DIR").is_none());
    git(&work, &["init", "-q", "-b", "main"]);
    git(&work, &["config", "user.name", "Test"]);
    git(&work, &["config", "user.email", "test@example.com"]);
    std::fs::write(work.join("b.txt"), "two\n").unwrap();
    git(&work, &["add", "-A"]);
    git(&work, &["commit", "-qm", "two"]);
    git(&work, &["branch", "feature"]);
    assert!(work.join(".git").exists());

    // The core's own git calls stay in the scratch repository too.
    workbench_core::git::worktree_add(&work, "review").ok();

    assert_eq!(fingerprint(&decoy.0), before);
}
