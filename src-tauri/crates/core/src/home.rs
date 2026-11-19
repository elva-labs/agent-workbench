//! The app's own folder in the user's home, `.chord`, which holds its
//! settings, logs, notes, plugins, the daemon and the orchestrator folder.
//!
//! Every path under it is made from [`dir`]. That is the `.chord` folder,
//! except while the folder of the app's earlier name holds the install and
//! has not been moved: before the move has run, or after a run that could
//! not make it. Then it is that folder, in every process, so nothing reads
//! or writes a folder that does not hold the user's files. See the migrate
//! module.

use std::path::{Path, PathBuf};

/// The folder's name under the home.
pub const DIR: &str = ".chord";

/// The app's folder under `home`.
pub fn dir(home: &Path) -> PathBuf {
    crate::migrate::unmoved(home).unwrap_or_else(|| home.join(DIR))
}
