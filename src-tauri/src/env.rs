//! The environment an agent is spawned with.
//!
//! This is the first thing phase 1 has to get right. Spawning a program
//! directly means no `.zshrc`, so no nvm, mise, asdf or Homebrew paths, and
//! `claude` is simply not found on a machine where it works perfectly in a
//! terminal. The fix is to ask the user's own shell what its environment looks
//! like, once, and spawn everything with that.
//!
//! Known sharp edge: a `.zshrc` that blocks forever blocks this call. It runs
//! lazily on the first spawn rather than at startup, so a hang shows up as an
//! agent that will not start rather than as a window that never opens.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

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
    let output = Command::new(&shell)
        .args(["-lic", "env -0"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let vars = parse_env0(&output.stdout);
    // A capture with no PATH is a capture that went wrong, whatever the exit
    // status said.
    vars.contains_key("PATH").then_some(vars)
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
    path.split(PATH_SEPARATOR)
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join(program))
        .find(|candidate| is_executable(candidate))
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

    #[test]
    fn ignores_a_non_executable_file() {
        let dir = std::env::temp_dir().join("workbench-path-test-plain");
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("not-executable");
        std::fs::write(&bin, b"text").unwrap();

        let vars = HashMap::from([("PATH".to_string(), dir.to_string_lossy().to_string())]);
        #[cfg(unix)]
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
}
