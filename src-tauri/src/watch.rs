//! Noticing that the working tree moved.
//!
//! The agent edits files; the pane has to react without being asked. A
//! filesystem watcher on the worktree, debounced, that emits one event the
//! frontend answers by asking for the status again. The core does not diff the
//! two states, because re-running `git status` is cheap and being right is
//! worth more than being clever.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher as _};
use tauri::{AppHandle, Emitter};

/// A save is several syscalls, and an agent editing a file is several saves.
/// Waiting for the noise to stop turns a burst into one refresh.
const DEBOUNCE: Duration = Duration::from_millis(150);

pub const GIT_CHANGED: &str = "git_changed";

pub struct Watchers {
    current: Mutex<Option<(PathBuf, RecommendedWatcher, Arc<Stop>)>>,
}

impl Default for Watchers {
    fn default() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }
}

/// Tells the debounce thread to give up when its watcher is replaced.
#[derive(Default)]
pub struct Stop(std::sync::atomic::AtomicBool);

impl Stop {
    fn stopped(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Relaxed)
    }
    fn stop(&self) {
        self.0.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Whether a changed path is worth a refresh.
///
/// Everything in the worktree is. Inside `.git` almost nothing is: the
/// directory churns constantly during any git operation, and watching it whole
/// is how a watcher feeds itself. The exceptions are the few files that mean
/// the status genuinely changed without a worktree file moving, which is what
/// a commit or a `git add` looks like from out here.
pub fn is_interesting(path: &Path) -> bool {
    let mut segments = path.components().map(|c| c.as_os_str().to_string_lossy());
    if !segments.any(|segment| segment == ".git") {
        return true;
    }

    let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
        return false;
    };
    if name.ends_with(".lock") {
        return false;
    }
    matches!(name.as_str(), "index" | "HEAD" | "MERGE_HEAD" | "ORIG_HEAD")
}

pub fn watch(app: AppHandle, watchers: &Watchers, root: PathBuf) -> Result<(), String> {
    let mut current = watchers.current.lock().expect("watchers lock");

    if let Some((existing, _, _)) = current.as_ref() {
        if *existing == root {
            return Ok(());
        }
    }
    // Dropping the old watcher stops the notifications; the flag stops the
    // thread that was debouncing them.
    if let Some((_, _, stop)) = current.take() {
        stop.stop();
    }

    let (sender, receiver) = channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(move |event| {
        // A closed receiver means this watcher has been replaced.
        let _ = sender.send(event);
    })
    .map_err(|e| format!("could not start watching: {e}"))?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("could not watch {}: {e}", root.display()))?;

    let stop = Arc::new(Stop::default());
    std::thread::spawn({
        let stop = Arc::clone(&stop);
        let root = root.clone();
        move || debounce(app, receiver, root, stop)
    });

    *current = Some((root, watcher, stop));
    Ok(())
}

pub fn unwatch(watchers: &Watchers) {
    let mut current = watchers.current.lock().expect("watchers lock");
    if let Some((_, _, stop)) = current.take() {
        stop.stop();
    }
}

fn debounce(app: AppHandle, receiver: Receiver<notify::Result<Event>>, root: PathBuf, stop: Arc<Stop>) {
    loop {
        // Block until something happens, then wait for the burst to finish.
        let Ok(first) = receiver.recv() else { return };
        if stop.stopped() {
            return;
        }

        let mut worth_it = interesting(&first);
        loop {
            match receiver.recv_timeout(DEBOUNCE) {
                Ok(event) => worth_it |= interesting(&event),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }

        if stop.stopped() {
            return;
        }
        if worth_it {
            let _ = app.emit(GIT_CHANGED, root.to_string_lossy().to_string());
        }
    }
}

fn interesting(event: &notify::Result<Event>) -> bool {
    match event {
        Ok(event) => event.paths.iter().any(|path| is_interesting(path)),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_changes_are_interesting() {
        assert!(is_interesting(Path::new("/repo/src/main.rs")));
        assert!(is_interesting(Path::new("/repo/README.md")));
    }

    // Watching .git whole is how a watcher feeds itself.
    #[test]
    fn most_of_the_git_directory_is_not() {
        assert!(!is_interesting(Path::new("/repo/.git/objects/ab/cdef")));
        assert!(!is_interesting(Path::new("/repo/.git/logs/HEAD.lock")));
        assert!(!is_interesting(Path::new("/repo/.git/refs/heads/main")));
    }

    // A commit or a `git add` moves no worktree file, so these have to pass.
    #[test]
    fn the_files_that_mean_the_status_changed_are() {
        assert!(is_interesting(Path::new("/repo/.git/index")));
        assert!(is_interesting(Path::new("/repo/.git/HEAD")));
        assert!(is_interesting(Path::new("/repo/.git/MERGE_HEAD")));
    }

    #[test]
    fn lock_files_never_are() {
        assert!(!is_interesting(Path::new("/repo/.git/index.lock")));
        assert!(!is_interesting(Path::new("/repo/.git/HEAD.lock")));
    }

    #[test]
    fn a_directory_merely_named_git_is_still_worktree() {
        // ".gitignore" is not ".git", and neither is "src/git".
        assert!(is_interesting(Path::new("/repo/.gitignore")));
        assert!(is_interesting(Path::new("/repo/src/git/status.rs")));
    }

    #[test]
    fn a_fresh_registry_holds_nothing() {
        let watchers = Watchers::default();
        assert!(watchers.current.lock().unwrap().is_none());
    }

    #[test]
    fn unwatching_nothing_is_not_an_error() {
        let watchers = Watchers::default();
        unwatch(&watchers);
        assert!(watchers.current.lock().unwrap().is_none());
    }
}
