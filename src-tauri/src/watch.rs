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

use git2::Repository;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher as _};
use tauri::{AppHandle, Emitter};

/// A save is several syscalls, and an agent editing a file is several saves.
/// Waiting for the noise to stop turns a burst into one refresh.
const DEBOUNCE: Duration = Duration::from_millis(150);

/// A burst that never stops (a build writing into an unignored target
/// directory, say) still has to reach the pane. After this long the refresh
/// goes out whether or not the tree has gone quiet.
const MAX_WAIT: Duration = Duration::from_secs(1);

pub const GIT_CHANGED: &str = "git_changed";

pub struct Watchers {
    current: Mutex<Option<Active>>,
}

struct Active {
    root: PathBuf,
    /// The hook's file, once it has joined the watch.
    extra: Option<PathBuf>,
    watcher: RecommendedWatcher,
    stop: Arc<Stop>,
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

/// Watches a worktree, and optionally one more path: the file the PostToolUse
/// hook writes. Both mean the same thing to the pane, which is that the tree
/// may have moved.
pub fn watch(
    app: AppHandle,
    watchers: &Watchers,
    root: PathBuf,
    also: Option<PathBuf>,
) -> Result<(), String> {
    let mut current = watchers.current.lock().expect("watchers lock");

    if let Some(active) = current.as_mut() {
        if active.root == root {
            // Same tree, so keep the watcher; the only thing that can be new
            // is the hook's file, which exists now if it was just installed.
            attach_extra(active, also);
            return Ok(());
        }
    }
    // Dropping the old watcher stops the notifications; the flag stops the
    // thread that was debouncing them.
    if let Some(active) = current.take() {
        active.stop.stop();
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

    let mut active = Active {
        root,
        extra: None,
        watcher,
        stop,
    };
    attach_extra(&mut active, also);
    *current = Some(active);
    Ok(())
}

/// Absent until the hook has been installed, which is not an error: the
/// filesystem watch already covers everything on its own.
fn attach_extra(active: &mut Active, also: Option<PathBuf>) {
    let Some(extra) = also else { return };
    if active.extra.as_ref() == Some(&extra) || !extra.exists() {
        return;
    }
    if active.watcher.watch(&extra, RecursiveMode::NonRecursive).is_ok() {
        active.extra = Some(extra);
    }
}

pub fn unwatch(watchers: &Watchers) {
    let mut current = watchers.current.lock().expect("watchers lock");
    if let Some(active) = current.take() {
        active.stop.stop();
    }
}

fn debounce(app: AppHandle, receiver: Receiver<notify::Result<Event>>, root: PathBuf, stop: Arc<Stop>) {
    let ignored = Ignored::for_root(&root);
    loop {
        // Block until something happens, then wait for the burst to finish.
        let Ok(first) = receiver.recv() else { return };
        if stop.stopped() {
            return;
        }

        let started = std::time::Instant::now();
        let mut worth_it = interesting(&first) && !ignored.covers(&first);
        loop {
            if started.elapsed() >= MAX_WAIT {
                break;
            }
            match receiver.recv_timeout(DEBOUNCE) {
                Ok(event) => worth_it |= interesting(&event) && !ignored.covers(&event),
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

/// Asks git whether a path is ignored, so a build writing into `target/` does
/// not refresh a pane that would show nothing new. Opening the repository
/// once per watch rather than per event, because the answer for a path does
/// not change often and the events come in bursts.
struct Ignored {
    root: PathBuf,
    repo: Option<Repository>,
}

impl Ignored {
    fn for_root(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            repo: Repository::open(root).ok(),
        }
    }

    /// True only when every path in the event is ignored. Unsure means not
    /// ignored: a spurious refresh is cheap and a missed one is not.
    fn covers(&self, event: &notify::Result<Event>) -> bool {
        let Ok(event) = event else { return false };
        let Some(repo) = self.repo.as_ref() else { return false };
        !event.paths.is_empty()
            && event.paths.iter().all(|path| {
                path.strip_prefix(&self.root)
                    .ok()
                    .and_then(|relative| repo.status_should_ignore(relative).ok())
                    .unwrap_or(false)
            })
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

    fn event(paths: &[PathBuf]) -> notify::Result<Event> {
        let mut event = Event::new(notify::EventKind::Any);
        for path in paths {
            event = event.add_path(path.clone());
        }
        Ok(event)
    }

    fn repo_with_ignore(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("workbench-watch-{name}"));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        Repository::init(&dir).unwrap();
        std::fs::write(dir.join(".gitignore"), "target/\n").unwrap();
        dir
    }

    // A build writing into target/ must not refresh a pane that would show
    // nothing new.
    #[test]
    fn a_burst_entirely_inside_ignored_paths_is_covered() {
        let dir = repo_with_ignore("ignored");
        let ignored = Ignored::for_root(&dir);
        assert!(ignored.covers(&event(&[dir.join("target/debug/app")])));
        assert!(!ignored.covers(&event(&[dir.join("src/main.rs")])));
        assert!(!ignored.covers(&event(&[dir.join("target/x"), dir.join("src/main.rs")])));
    }

    // Unsure means not ignored: a spurious refresh is cheap, a missed one is not.
    #[test]
    fn without_a_repository_nothing_is_covered() {
        let dir = std::env::temp_dir().join("workbench-watch-norepo");
        std::fs::create_dir_all(&dir).unwrap();
        let ignored = Ignored {
            root: dir.clone(),
            repo: None,
        };
        assert!(!ignored.covers(&event(&[dir.join("target/debug/app")])));
        assert!(!ignored.covers(&event(&[])));
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
