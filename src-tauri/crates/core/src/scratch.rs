//! Scratch folders for tests: one under the system temp folder per call,
//! named so that no other test, test binary or run on the machine can share
//! it, and removed again when the value is dropped.

use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::Once;

/// Variables git reads to find a repository, an index, objects, config or an
/// identity. A test run from inside a git command (a rebase `--exec`, a hook,
/// a bisect) inherits them, and git would then act on the caller's repository.
const GIT_VARIABLES: &[&str] = &[
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
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
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
];

static ISOLATE: Once = Once::new();

/// Cuts every git this process starts off from the caller's repository and
/// config, and every shell off from the developer's own. It runs once, before
/// the first scratch folder or test core is made, so any test that runs git,
/// reads the environment or starts a shell has had it done. Discovery cannot
/// climb out of the temp folder, where every scratch folder lives.
///
/// With no `SHELL`, the core asks no login shell for the environment and
/// takes this process's own, and on Unix the shell it starts for a terminal
/// is the system's `sh`, which reads no startup file while `ENV` names none.
///
/// The environment is read once for the whole process, so this has to come
/// before the first core: a test makes its core after a scratch folder or
/// through a helper that calls this, never bare.
pub fn isolate() {
    ISOLATE.call_once(|| {
        for (name, _) in std::env::vars_os() {
            let name = name.to_string_lossy();
            if GIT_VARIABLES.contains(&name.as_ref())
                || name.starts_with("GIT_CONFIG_KEY_")
                || name.starts_with("GIT_CONFIG_VALUE_")
            {
                std::env::remove_var(&*name);
            }
        }
        let nothing = if cfg!(windows) { "NUL" } else { "/dev/null" };
        std::env::set_var("GIT_CONFIG_GLOBAL", nothing);
        std::env::set_var("GIT_CONFIG_SYSTEM", nothing);
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        std::env::set_var("GIT_CEILING_DIRECTORIES", std::env::temp_dir());
        std::env::remove_var("SHELL");
        std::env::remove_var("ENV");
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
        isolate();
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
