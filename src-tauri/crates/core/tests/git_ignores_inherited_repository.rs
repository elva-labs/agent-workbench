//! The core's git acts on the project it is asked about when the environment
//! names some other repository. Its own binary, so that setting the
//! variables here reaches no other test.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use workbench_core::plugins::{Plugins, MANIFEST};
use workbench_core::scratch::Scratch;
use workbench_core::Sink;

const VARIABLES: &[&str] = &[
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_GRAFT_FILE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_QUARANTINE_PATH",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE",
];

fn git(dir: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    command.args(args).current_dir(dir);
    for name in VARIABLES {
        command.env_remove(name);
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn repository(dir: &Path, file: &str, text: &str) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    git(dir, &["config", "user.name", "Test"]);
    std::fs::write(dir.join(file), text).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-qm", "start"]);
}

/// Everything about a repository that a stray `git` could change.
fn fingerprint(dir: &Path) -> String {
    let dot = dir.join(".git");
    let read = |name: &str| std::fs::read_to_string(dot.join(name)).unwrap_or_default();
    format!(
        "{}\n--\n{}\n--\n{}\n--\n{}\n--\n{}\n--\n{}",
        read("config"),
        read("HEAD"),
        git(dir, &["for-each-ref"]),
        git(dir, &["worktree", "list", "--porcelain"]),
        git(dir, &["status", "--porcelain"]),
        git(dir, &["ls-files", "-s"]),
    )
}

struct Quiet;

impl Sink for Quiet {
    fn emit(&self, _event: &str, _payload: serde_json::Value) {}
}

#[test]
fn variables_naming_another_repository_do_not_misdirect_the_core() {
    // The first scratch folder isolates this process from the caller's git
    // variables, so it is made before the variables are set.
    let decoy = Scratch::new("inherited-decoy");
    let project = Scratch::new("inherited-project");
    let upstream = Scratch::new("inherited-upstream");
    let home = Scratch::new("inherited-home");

    repository(&decoy, "decoy.txt", "decoy needle\n");
    repository(&project, "project.txt", "project needle\n");
    std::fs::create_dir_all(upstream.join("tool")).unwrap();
    std::fs::write(upstream.join("tool/main.sh"), "#!/bin/sh\n").unwrap();
    std::fs::write(
        upstream.join(MANIFEST),
        "[[plugin]]\nname = \"tool\"\npath = \"tool\"\ndescription = \"A tool.\"\nversion = \"0.1.0\"\nrun = [\"sh\", \"main.sh\"]\n",
    )
    .unwrap();
    git(&upstream, &["init", "-q", "-b", "main"]);
    git(&upstream, &["config", "user.email", "test@example.com"]);
    git(&upstream, &["config", "user.name", "Test"]);
    git(&upstream, &["add", "-A"]);
    git(&upstream, &["commit", "-qm", "start"]);

    let before = fingerprint(&decoy);

    let dot = decoy.join(".git");
    std::env::set_var("GIT_DIR", &dot);
    std::env::set_var("GIT_WORK_TREE", decoy.path());
    std::env::set_var("GIT_INDEX_FILE", dot.join("index"));
    std::env::set_var("GIT_COMMON_DIR", &dot);
    std::env::set_var("GIT_OBJECT_DIRECTORY", dot.join("objects"));
    std::env::set_var("GIT_NAMESPACE", "decoy");

    // An uncommitted change that only the project has.
    std::fs::write(project.join("project.txt"), "project needle\nmore\n").unwrap();

    let changed = workbench_core::git::status(&project).unwrap();
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].path, "project.txt");
    assert!(!workbench_core::git::diff(&project, "project.txt")
        .unwrap()
        .lines
        .is_empty());

    let found = workbench_core::git::grep(&project, "needle", None).unwrap();
    let paths: Vec<_> = found.hits.iter().map(|hit| hit.path.as_str()).collect();
    assert_eq!(paths, ["project.txt"]);

    let tree = workbench_core::git::worktree_add(&project, "review").unwrap();
    assert!(Path::new(&tree).join("project.txt").exists());
    let listed = workbench_core::git::worktrees(&project).unwrap();
    assert!(listed.iter().any(|worktree| worktree.name == "review"));
    workbench_core::git::worktree_remove(&project, "review").unwrap();

    let plugins = Plugins::new(&home, Arc::new(Quiet));
    let added = plugins
        .add(&format!("file://{}", upstream.display()), Some("main"))
        .unwrap();
    assert!(added.commit.is_some());
    assert_eq!(added.plugins[0].declared.name, "tool");

    assert_eq!(fingerprint(&decoy), before);
    assert!(git(&project, &["worktree", "list", "--porcelain"]).contains("worktree"));
}
