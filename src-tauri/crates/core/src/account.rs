//! The account a session runs under.
//!
//! An account is a login kept apart from the others: Claude Code's in a
//! configuration directory of its own, named to it as `CLAUDE_CONFIG_DIR`,
//! and Codex's in a home of its own, named as `CODEX_HOME`. Each directory
//! holds that agent's login, its settings and its record of past sessions,
//! so the sessions an account has had are read from the same place the
//! agent is pointed at.
//!
//! The window keeps the accounts, by name, in the settings of the machine
//! it runs on, and gives the core directories rather than names: a session
//! on a remote machine runs under directories on that machine, spelled with
//! `~` for its home. A directory left out is the agent's own, `.claude`
//! and `.codex` under the home.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The directories of one account, as the window gives them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dirs {
    #[serde(default)]
    pub claude: Option<String>,
    #[serde(default)]
    pub codex: Option<String>,
}

/// A directory as the user wrote it, with `~` standing for the home.
pub fn expand(home: &Path, text: &str) -> PathBuf {
    let text = text.trim();
    if text == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = text.strip_prefix("~/").or_else(|| text.strip_prefix("~\\")) {
        return home.join(rest);
    }
    PathBuf::from(text)
}

/// Where Claude Code keeps its configuration: the directory given, or
/// `.claude` under the home.
pub fn claude_dir(home: &Path, dir: Option<&str>) -> PathBuf {
    match dir.filter(|dir| !dir.trim().is_empty()) {
        Some(dir) => expand(home, dir),
        None => home.join(".claude"),
    }
}

/// Claude Code's file of per-project state, where the trust it was given
/// and the servers it was pointed at are kept: `.claude.json` inside a
/// configuration directory of the user's own, and beside `.claude` under
/// the home for the agent's own.
pub fn claude_json(home: &Path, dir: Option<&str>) -> PathBuf {
    match dir.filter(|dir| !dir.trim().is_empty()) {
        Some(dir) => expand(home, dir).join(".claude.json"),
        None => home.join(".claude.json"),
    }
}

/// Where Codex keeps its state: the home given, or its own.
pub fn codex_home(home: &Path, dir: Option<&str>) -> PathBuf {
    match dir.filter(|dir| !dir.trim().is_empty()) {
        Some(dir) => expand(home, dir),
        None => crate::codex::home(home),
    }
}

/// Claude Code's state file for the agent's own account and for each
/// account given, each once. What is written for a project goes into every
/// one, so a session under any account finds it.
pub fn claude_jsons(home: &Path, accounts: &[Dirs]) -> Vec<PathBuf> {
    let mut paths = vec![claude_json(home, None)];
    for account in accounts {
        let path = claude_json(home, account.claude.as_deref());
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths
}

/// Codex's home for the agent's own account and for each account given,
/// each once.
pub fn codex_homes(home: &Path, accounts: &[Dirs]) -> Vec<PathBuf> {
    let mut paths = vec![codex_home(home, None)];
    for account in accounts {
        let path = codex_home(home, account.codex.as_deref());
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tilde_stands_for_the_home() {
        let home = Path::new("/home/ada");
        assert_eq!(expand(home, "~"), PathBuf::from("/home/ada"));
        assert_eq!(expand(home, "~/.claude-work"), home.join(".claude-work"));
        assert_eq!(expand(home, " ~/.claude-work "), home.join(".claude-work"));
        assert_eq!(expand(home, "/srv/claude"), PathBuf::from("/srv/claude"));
        assert_eq!(expand(home, "~ada/x"), PathBuf::from("~ada/x"));
    }

    #[test]
    fn the_agents_own_directories_stand_in_for_a_missing_one() {
        let home = Path::new("/home/ada");
        assert_eq!(claude_dir(home, None), home.join(".claude"));
        assert_eq!(claude_dir(home, Some("")), home.join(".claude"));
        assert_eq!(
            claude_dir(home, Some("~/.claude-work")),
            home.join(".claude-work")
        );
        assert_eq!(claude_json(home, None), home.join(".claude.json"));
        assert_eq!(
            claude_json(home, Some("~/.claude-work")),
            home.join(".claude-work").join(".claude.json")
        );
        assert_eq!(
            codex_home(home, Some("~/.codex-work")),
            home.join(".codex-work")
        );
    }

    #[test]
    fn lists_each_state_file_once_with_the_agents_own_first() {
        let home = Path::new("/home/ada");
        let accounts = [
            Dirs {
                claude: Some("~/.claude-work".into()),
                codex: None,
            },
            Dirs {
                claude: Some("~/.claude-work".into()),
                codex: Some("~/.codex-work".into()),
            },
            Dirs::default(),
        ];
        assert_eq!(
            claude_jsons(home, &accounts),
            vec![
                home.join(".claude.json"),
                home.join(".claude-work").join(".claude.json")
            ]
        );
        let homes = codex_homes(home, &accounts);
        assert_eq!(homes.len(), 2);
        assert_eq!(homes[1], home.join(".codex-work"));
    }
}
