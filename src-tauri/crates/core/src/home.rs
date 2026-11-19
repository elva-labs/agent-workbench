//! The app's own folder in the user's home, `.chord`, which holds its
//! settings, logs, notes, plugins, the daemon and the orchestrator folder.
//!
//! Every path under it is made from [`dir`]. That is the `.chord` folder,
//! except on a run where the migration found the folder of the earlier name
//! and could not move it: that run keeps to the folder it found, so nothing
//! it writes points at a folder that is not there. See the migrate module.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The folder's name under the home.
pub const DIR: &str = ".chord";

/// Homes whose folder could not be moved this run, with the folder in use.
static IN_USE: Mutex<Vec<(PathBuf, PathBuf)>> = Mutex::new(Vec::new());

/// The app's folder under `home`.
pub fn dir(home: &Path) -> PathBuf {
    let in_use = IN_USE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    in_use
        .iter()
        .find(|(of, _)| of == home)
        .map(|(_, folder)| folder.clone())
        .unwrap_or_else(|| home.join(DIR))
}

/// Keeps `folder` as the app's folder under `home` for the rest of this
/// run, or goes back to `.chord` when `folder` is None.
pub(crate) fn keep_using(home: &Path, folder: Option<PathBuf>) {
    let mut in_use = IN_USE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    in_use.retain(|(of, _)| of != home);
    if let Some(folder) = folder {
        in_use.push((home.to_path_buf(), folder));
    }
}
