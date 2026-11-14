//! Scratch folders for tests: one under the system temp folder per call,
//! named so that no other test, test binary or run on the machine can share
//! it, and removed again when the value is dropped.

use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::Once;

/// What a test isolates beyond the variables that name a repository, which
/// the core's own list holds: the config an identity and a caller's settings
/// come from. A test run from inside a git command (a rebase `--exec`, a hook,
/// a bisect) inherits them, and git would then act on the caller's repository.
const ALSO_ISOLATED: &[&str] = &[
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
];

fn is_isolated(name: &str) -> bool {
    crate::git::REPOSITORY_VARIABLES.contains(&name)
        || ALSO_ISOLATED.contains(&name)
        || name.starts_with("GIT_CONFIG_KEY_")
        || name.starts_with("GIT_CONFIG_VALUE_")
}

static ISOLATE: Once = Once::new();

/// Cuts every git this process starts off from the caller's repository and
/// config. It runs once, before the first scratch folder is made, so any test
/// that runs git has had it done. Discovery cannot climb out of the temp
/// folder, where every scratch folder lives.
pub fn isolate_git() {
    ISOLATE.call_once(|| {
        for (name, _) in std::env::vars_os() {
            let name = name.to_string_lossy();
            if is_isolated(&name) {
                std::env::remove_var(&*name);
            }
        }
        let nothing = if cfg!(windows) { "NUL" } else { "/dev/null" };
        std::env::set_var("GIT_CONFIG_GLOBAL", nothing);
        std::env::set_var("GIT_CONFIG_SYSTEM", nothing);
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        std::env::set_var("GIT_CEILING_DIRECTORIES", std::env::temp_dir());
    });
}

/// A folder of the caller's own. Dropping it removes the folder and whatever
/// is in it.
#[derive(Debug)]
pub struct Scratch(PathBuf);

impl Scratch {
    /// A new, empty folder. `label` says what it is for and shows up in its
    /// name.
    pub fn new(label: &str) -> Scratch {
        let scratch = Scratch::absent(label);
        std::fs::create_dir_all(&scratch.0).unwrap();
        scratch
    }

    /// A name under the temp folder where nothing exists yet, for tests that
    /// look at a path that is not there or make it themselves.
    pub fn absent(label: &str) -> Scratch {
        isolate_git();
        let label: String = label
            .trim_start_matches("workbench-")
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        Scratch(std::env::temp_dir().join(format!(
            "workbench-{label}-{}",
            uuid::Uuid::new_v4().simple()
        )))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Deref for Scratch {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for Scratch {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_variable_the_core_clears_is_isolated_in_tests() {
        for name in crate::git::REPOSITORY_VARIABLES {
            assert!(is_isolated(name), "{name}");
        }
        for name in ["GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_3", "GIT_AUTHOR_NAME"] {
            assert!(is_isolated(name), "{name}");
        }
        assert!(!is_isolated("GIT_SSH_COMMAND"));
        assert!(!is_isolated("PATH"));
    }
}
