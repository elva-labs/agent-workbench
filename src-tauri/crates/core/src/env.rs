//! The environment an agent is spawned with.
//!
//! This is the first thing phase 1 has to get right. Spawning a program
//! directly means no `.zshrc`, so no nvm, mise, asdf or Homebrew paths, and
//! `claude` is simply not found on a machine where it works perfectly in a
//! terminal. The fix is to ask the user's own shell what its environment looks
//! like, once, and spawn everything with that.
//!
//! Known sharp edge: a `.zshrc` that blocks forever. The capture is given a
//! deadline, after which the shell is killed and this process's own
//! environment stands in, and the report says so. It runs off the main thread,
//! so even a slow shell costs a late detection rather than a frozen window.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
#[cfg(unix)]
use std::time::{Duration, Instant};

/// Generous, because nvm and friends take a second or two on a cold cache, and
/// a shell that takes longer than this is not going to finish.
#[cfg(unix)]
const CAPTURE_DEADLINE: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub struct Environment {
    pub vars: HashMap<String, String>,
    /// False when the login shell could not be read and this process's own
    /// environment was used instead. Worth surfacing: it is the difference
    /// between "you have not installed Claude Code" and "we could not find it".
    pub from_login_shell: bool,
}

static ENVIRONMENT: OnceLock<Environment> = OnceLock::new();

/// Resolved once and reused. The shell is not consulted again.
pub fn environment() -> &'static Environment {
    ENVIRONMENT.get_or_init(resolve)
}

fn resolve() -> Environment {
    match from_login_shell() {
        Some(vars) => Environment {
            vars,
            from_login_shell: true,
        },
        None => Environment {
            vars: std::env::vars().collect(),
            from_login_shell: false,
        },
    }
}

/// `-l` reads the login files, `-i` the interactive ones, and `env -0` writes
/// the result NUL-separated so values containing newlines survive.
#[cfg(unix)]
fn from_login_shell() -> Option<HashMap<String, String>> {
    use std::process::{Command, Stdio};

    let shell = std::env::var("SHELL").ok()?;
    let child = Command::new(&shell)
        .args(["-lic", "env -0"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let stdout = wait_with_deadline(child, CAPTURE_DEADLINE)?;
    let vars = parse_env0(&stdout);
    // A capture with no PATH is a capture that went wrong, whatever the exit
    // status said.
    vars.contains_key("PATH").then_some(vars)
}

/// Reads the child's stdout to the end, but gives up on a child that does not
/// exit in time. The pipe is drained on its own thread so a chatty shell can
/// never fill it and deadlock against the wait, and the same deadline covers
/// the drain: a background job the shell left behind can keep the pipe open
/// after the shell itself is gone.
#[cfg(unix)]
fn wait_with_deadline(mut child: std::process::Child, deadline: Duration) -> Option<Vec<u8>> {
    use std::io::Read;
    use std::sync::mpsc::channel;

    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        let _ = sender.send(bytes);
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }

    let remaining = deadline.saturating_sub(started.elapsed());
    receiver.recv_timeout(remaining).ok()
}

#[cfg(not(unix))]
fn from_login_shell() -> Option<HashMap<String, String>> {
    // Windows has no login shell to consult; the process environment already
    // carries what the user's session has.
    None
}

/// Parses the NUL-separated output of `env -0`.
///
/// Deliberately tolerant. An interactive shell may print its own noise to
/// stdout before `env` runs, so anything that is not a plausible assignment is
/// skipped rather than treated as a variable.
#[cfg_attr(not(unix), allow(dead_code))]
pub fn parse_env0(bytes: &[u8]) -> HashMap<String, String> {
    let mut vars = HashMap::new();

    for entry in bytes.split(|byte| *byte == 0) {
        if entry.is_empty() {
            continue;
        }
        let Ok(text) = std::str::from_utf8(entry) else {
            continue;
        };
        let Some((key, value)) = text.split_once('=') else {
            continue;
        };
        if !is_plausible_key(key) {
            continue;
        }
        vars.insert(key.to_string(), value.to_string());
    }

    vars
}

#[cfg_attr(not(unix), allow(dead_code))]
fn is_plausible_key(key: &str) -> bool {
    !key.is_empty()
        && !key.starts_with(|c: char| c.is_ascii_digit())
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

/// Looks a program up on the captured PATH rather than on this process's own.
/// Using `std::env::var("PATH")` here would defeat the whole module.
pub fn find_on_path(vars: &HashMap<String, String>, program: &str) -> Option<PathBuf> {
    let path = vars.get("PATH")?;
    let names = candidates(program, pathext(vars));
    path.split(PATH_SEPARATOR)
        .filter(|dir| !dir.is_empty())
        .flat_map(|dir| names.iter().map(move |name| Path::new(dir).join(name)))
        .find(|candidate| is_executable(candidate))
}

/// The names a program may go by in a PATH directory. On Windows a program
/// installed by npm is `claude.cmd`, and what PATHEXT lists is what the shell
/// would try; elsewhere the name is the name.
fn candidates(program: &str, pathext: Option<&str>) -> Vec<String> {
    let mut names = vec![program.to_string()];
    if let Some(pathext) = pathext {
        for ext in pathext.split(';').filter(|ext| !ext.is_empty()) {
            names.push(format!("{program}{}", ext.to_ascii_lowercase()));
        }
    }
    names
}

#[cfg(windows)]
fn pathext(vars: &HashMap<String, String>) -> Option<&str> {
    Some(
        vars.get("PATHEXT")
            .map(String::as_str)
            .unwrap_or(".COM;.EXE;.BAT;.CMD"),
    )
}

#[cfg(not(windows))]
fn pathext(_vars: &HashMap<String, String>) -> Option<&str> {
    None
}

#[cfg(unix)]
const PATH_SEPARATOR: char = ':';
#[cfg(not(unix))]
const PATH_SEPARATOR: char = ';';

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Whether a found program is a script the shell has to run rather than a
/// binary the OS can start: `.cmd` and `.bat`, which is how npm installs a
/// command on Windows.
pub fn is_shell_script(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env0(entries: &[&str]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for entry in entries {
            bytes.extend_from_slice(entry.as_bytes());
            bytes.push(0);
        }
        bytes
    }

    #[test]
    fn reads_plain_assignments() {
        let vars = parse_env0(&env0(&["PATH=/usr/bin", "HOME=/home/ada"]));
        assert_eq!(vars.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(vars.get("HOME").map(String::as_str), Some("/home/ada"));
    }

    #[test]
    fn keeps_equals_signs_inside_values() {
        let vars = parse_env0(&env0(&["OPTS=--flag=1 --other=2"]));
        assert_eq!(
            vars.get("OPTS").map(String::as_str),
            Some("--flag=1 --other=2")
        );
    }

    #[test]
    fn keeps_newlines_inside_values() {
        // The reason for NUL separation rather than line separation.
        let vars = parse_env0(&env0(&["SCRIPT=line one\nline two"]));
        assert_eq!(
            vars.get("SCRIPT").map(String::as_str),
            Some("line one\nline two")
        );
    }

    #[test]
    fn accepts_an_empty_value() {
        let vars = parse_env0(&env0(&["EMPTY="]));
        assert_eq!(vars.get("EMPTY").map(String::as_str), Some(""));
    }

    #[test]
    fn skips_entries_with_no_equals_sign() {
        // An interactive shell announcing itself before env runs.
        let vars = parse_env0(&env0(&["welcome to zsh", "PATH=/usr/bin"]));
        assert_eq!(vars.len(), 1);
        assert!(vars.contains_key("PATH"));
    }

    #[test]
    fn skips_implausible_keys() {
        let vars = parse_env0(&env0(&["not a key=value", "2START=x", "=novalue"]));
        assert!(vars.is_empty());
    }

    #[test]
    fn skips_entries_that_are_not_utf8() {
        let mut bytes = vec![b'B', b'A', b'D', b'=', 0xff, 0xfe, 0];
        bytes.extend_from_slice(b"PATH=/usr/bin\0");
        let vars = parse_env0(&bytes);
        assert_eq!(vars.len(), 1);
        assert!(vars.contains_key("PATH"));
    }

    #[test]
    fn copes_with_no_trailing_separator() {
        let vars = parse_env0(b"PATH=/usr/bin");
        assert!(vars.contains_key("PATH"));
    }

    #[test]
    fn copes_with_empty_input() {
        assert!(parse_env0(b"").is_empty());
        assert!(parse_env0(b"\0\0\0").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_shell_that_finishes_in_time_is_read() {
        let child = std::process::Command::new("sh")
            .args(["-c", "printf 'A=1\\0B=2\\0'"])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let bytes = wait_with_deadline(child, Duration::from_secs(5)).unwrap();
        let vars = parse_env0(&bytes);
        assert_eq!(vars.get("A").map(String::as_str), Some("1"));
        assert_eq!(vars.get("B").map(String::as_str), Some("2"));
    }

    // A .zshrc that never returns must not take the app with it.
    #[cfg(unix)]
    #[test]
    fn a_shell_that_hangs_is_given_up_on() {
        let child = std::process::Command::new("sh")
            .args(["-c", "sleep 30"])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        assert!(wait_with_deadline(child, Duration::from_millis(200)).is_none());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    fn a_shell_that_fails_is_not_trusted() {
        let child = std::process::Command::new("sh")
            .args(["-c", "printf 'PATH=/x\\0'; exit 3"])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        assert!(wait_with_deadline(child, Duration::from_secs(5)).is_none());
    }

    #[test]
    fn finds_a_program_on_the_given_path() {
        let dir = std::env::temp_dir().join("workbench-path-test");
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("pretend-agent");
        std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let vars = HashMap::from([("PATH".to_string(), dir.to_string_lossy().to_string())]);
        assert_eq!(find_on_path(&vars, "pretend-agent"), Some(bin.clone()));
        assert_eq!(find_on_path(&vars, "no-such-agent"), None);

        std::fs::remove_file(&bin).ok();
    }

    // Only a Unix file system says what is executable; on Windows a file is.
    #[cfg(unix)]
    #[test]
    fn ignores_a_non_executable_file() {
        let dir = std::env::temp_dir().join("workbench-path-test-plain");
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("not-executable");
        std::fs::write(&bin, b"text").unwrap();

        let vars = HashMap::from([("PATH".to_string(), dir.to_string_lossy().to_string())]);
        assert_eq!(find_on_path(&vars, "not-executable"), None);

        std::fs::remove_file(&bin).ok();
    }

    #[test]
    fn returns_nothing_without_a_path() {
        assert_eq!(find_on_path(&HashMap::new(), "claude"), None);
    }

    #[test]
    fn skips_empty_path_segments() {
        let vars = HashMap::from([("PATH".to_string(), "::".to_string())]);
        assert_eq!(find_on_path(&vars, "claude"), None);
    }

    #[test]
    fn tries_the_extensions_the_shell_would_on_windows() {
        assert_eq!(candidates("claude", None), ["claude"]);
        assert_eq!(
            candidates("claude", Some(".COM;.EXE;.BAT;.CMD")),
            [
                "claude",
                "claude.com",
                "claude.exe",
                "claude.bat",
                "claude.cmd"
            ]
        );
    }

    #[test]
    fn knows_a_script_from_a_binary() {
        assert!(is_shell_script(Path::new(
            r"C:\Users\ada\AppData\Roaming\npm\claude.cmd"
        )));
        assert!(is_shell_script(Path::new("thing.BAT")));
        assert!(!is_shell_script(Path::new("/usr/local/bin/claude")));
        assert!(!is_shell_script(Path::new(
            r"C:\Program Files\claude\claude.exe"
        )));
    }
}
