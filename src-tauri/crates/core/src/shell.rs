//! The user's own shell, for the terminal panel.
//!
//! Not an agent: nothing is detected, resumed or indexed. It is the shell the
//! login environment names, started interactively in the project directory
//! with the same environment the agent gets, so `claude` typed into it behaves
//! like `claude` typed into Terminal.

use std::collections::HashMap;
use std::path::Path;

use portable_pty::CommandBuilder;

use crate::adapter::prepare;

pub fn command(project: &Path, vars: &HashMap<String, String>) -> CommandBuilder {
    let mut command = CommandBuilder::new(program(vars));
    prepare(&mut command, project, vars);
    command
}

/// What to run. The captured environment's SHELL is the user's choice; this
/// process's own is the same variable seen from a different angle, and the
/// system shell is what is left when neither says.
#[cfg(unix)]
fn program(vars: &HashMap<String, String>) -> String {
    vars.get("SHELL")
        .filter(|shell| !shell.is_empty())
        .cloned()
        .or_else(|| {
            std::env::var("SHELL")
                .ok()
                .filter(|shell| !shell.is_empty())
        })
        .unwrap_or_else(|| "/bin/sh".to_string())
}

#[cfg(windows)]
fn program(vars: &HashMap<String, String>) -> String {
    vars.get("COMSPEC")
        .filter(|shell| !shell.is_empty())
        .cloned()
        .or_else(|| {
            std::env::var("COMSPEC")
                .ok()
                .filter(|shell| !shell.is_empty())
        })
        .unwrap_or_else(|| "cmd.exe".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg_attr(not(unix), allow(dead_code))]
    fn argv(command: &CommandBuilder) -> Vec<String> {
        command
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect()
    }

    #[cfg(unix)]
    #[test]
    fn runs_the_shell_the_environment_names() {
        let vars = HashMap::from([("SHELL".to_string(), "/usr/bin/fish".to_string())]);
        let command = command(Path::new("/tmp"), &vars);
        assert_eq!(argv(&command), ["/usr/bin/fish"]);
    }

    #[cfg(unix)]
    #[test]
    fn an_empty_shell_variable_is_no_shell() {
        let vars = HashMap::from([("SHELL".to_string(), String::new())]);
        let shell = program(&vars);
        assert!(!shell.is_empty());
        assert_ne!(shell, "");
    }

    #[test]
    fn starts_in_the_project_with_the_captured_environment() {
        let vars = HashMap::from([
            ("SHELL".to_string(), "/bin/sh".to_string()),
            ("COMSPEC".to_string(), "cmd.exe".to_string()),
            ("NVM_BIN".to_string(), "/home/ada/.nvm/bin".to_string()),
            ("CLAUDE_CODE_SESSION_ID".to_string(), "parent".to_string()),
        ]);
        let command = command(Path::new("/tmp"), &vars);
        assert_eq!(
            command
                .get_cwd()
                .map(|cwd| cwd.to_string_lossy().to_string()),
            Some("/tmp".to_string())
        );
        assert_eq!(
            command.get_env("NVM_BIN"),
            Some("/home/ada/.nvm/bin".as_ref())
        );
        assert_eq!(command.get_env("TERM"), Some("xterm-256color".as_ref()));
        assert_eq!(
            command.get_env("CLAUDE_CODE_SESSION_ID"),
            None,
            "a shell is not a nested session either"
        );
    }
}
