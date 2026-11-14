//! The environment handed to the processes a session starts carries none of
//! the variables that name a repository, whatever the app was started with.
//! Its own binary, so that setting variables here reaches no other test.

#![cfg(unix)]

use std::io::Read;
use std::path::Path;

use portable_pty::{native_pty_system, PtySize};
use workbench_core::adapter::{prepare_process, process};
use workbench_core::env::environment;
use workbench_core::scratch::Scratch;
use workbench_core::shell;

const SCRIPT: &str =
    "for name in GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_NAMESPACE \
GIT_COMMON_DIR WORKBENCH_UNRELATED GIT_AUTHOR_NAME GIT_CONFIG_COUNT; do \
eval \"value=\\${$name+set}\"; echo \"$name=${value:-unset}\"; done";

/// What the child printed, one `NAME=set` or `NAME=unset` per variable.
fn seen(output: &str) -> std::collections::HashMap<String, String> {
    output
        .lines()
        .filter_map(|line| line.trim().split_once('='))
        .map(|(name, state)| (name.to_string(), state.to_string()))
        .collect()
}

fn assert_only_the_repository_is_dropped(output: &str) {
    let seen = seen(output);
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_NAMESPACE",
        "GIT_COMMON_DIR",
    ] {
        assert_eq!(seen[name], "unset", "{name} reached the child: {output}");
    }
    assert_eq!(seen["WORKBENCH_UNRELATED"], "set", "{output}");
    assert_eq!(seen["GIT_AUTHOR_NAME"], "set", "{output}");
    assert_eq!(seen["GIT_CONFIG_COUNT"], "set", "{output}");
}

fn in_a_pty(project: &Path) -> String {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 200,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    // The same builder the terminal panel starts, running the script.
    let mut command = shell::command(project, &environment().vars);
    command.args(["-c", SCRIPT]);
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut bytes = Vec::new();
    // The read ends with an error once the child is gone, on some systems.
    let _ = reader.read_to_end(&mut bytes);
    child.wait().unwrap();
    String::from_utf8_lossy(&bytes).to_string()
}

fn as_a_process(project: &Path) -> String {
    let vars = &environment().vars;
    let mut command = process(Path::new("/bin/sh"), vars);
    command.args(["-c", SCRIPT]);
    prepare_process(&mut command, project, vars);
    let output = command.output().unwrap();
    String::from_utf8_lossy(&output.stdout).to_string()
}

#[test]
fn processes_a_session_starts_do_not_see_the_callers_repository() {
    // The first scratch folder isolates this process from the caller's git
    // variables, so it is made before the variables are set.
    let project = Scratch::new("session-env-project");
    // The system's `sh` as the login shell: the capture reads the system
    // profile and the user's `.profile` and little else, and inherits this
    // process's environment, as the user's own shell does.
    std::env::set_var("SHELL", "/bin/sh");
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_NAMESPACE",
        "GIT_COMMON_DIR",
    ] {
        std::env::set_var(name, "/somewhere/else");
    }
    std::env::set_var("WORKBENCH_UNRELATED", "kept");
    std::env::set_var("GIT_AUTHOR_NAME", "Ada");
    std::env::set_var("GIT_CONFIG_COUNT", "0");

    let in_a_pty = in_a_pty(&project);
    assert_only_the_repository_is_dropped(&in_a_pty);
    let as_a_process = as_a_process(&project);
    assert_only_the_repository_is_dropped(&as_a_process);
}
