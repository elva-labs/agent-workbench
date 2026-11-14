//! Scratch folders for tests: one under the system temp folder per call,
//! named so that no other test, test binary or run on the machine can share
//! it, and removed again when the value is dropped.

use std::ops::Deref;
use std::path::{Path, PathBuf};

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
