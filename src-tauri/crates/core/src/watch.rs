//! Noticing that the working tree moved, and that a file on screen did.
//!
//! The agent edits files; the pane has to react without being asked. A
//! filesystem watcher on the worktree, debounced, that emits one event the
//! frontend answers by asking for the status again. The core does not diff the
//! two states, because re-running `git status` is cheap and being right is
//! worth more than being clever.
//!
//! The files the viewer shows as they are on disk are watched too, wherever
//! they are: a document presented from a scratchpad, a picture in an ignored
//! directory. A change to one of them is news of its own, since the tree
//! watcher ignores or never sees it, and the viewer reads the file again.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use git2::Repository;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};

use crate::events::Sink;

/// A save is several syscalls, and an agent editing a file is several saves.
/// Waiting for the noise to stop turns a burst into one refresh.
const DEBOUNCE: Duration = Duration::from_millis(150);

/// A burst that never stops (a build writing into an unignored target
/// directory, say) still has to reach the pane. After this long the refresh
/// goes out whether or not the tree has gone quiet.
const MAX_WAIT: Duration = Duration::from_secs(1);

pub const GIT_CHANGED: &str = "git_changed";
/// A file the viewer shows changed on disk. The payload is the paths that
/// did, as the window gave them.
pub const SHOWN_CHANGED: &str = "shown_changed";

pub struct Watchers {
    current: Mutex<Option<Active>>,
    /// The files the viewer shows, kept apart from the watcher so they
    /// outlive it: a new watcher on another tree takes them up again.
    shown: Arc<Shown>,
}

struct Active {
    root: PathBuf,
    /// The hook's file, once it has joined the watch.
    extra: Option<PathBuf>,
    /// The directories of the shown files outside the tree, watched flat.
    dirs: HashSet<PathBuf>,
    watcher: RecommendedWatcher,
    stop: Arc<Stop>,
}

impl Default for Watchers {
    fn default() -> Self {
        Self {
            current: Mutex::new(None),
            shown: Arc::new(Shown::default()),
        }
    }
}

/// The files the viewer shows, as the window gave them and resolved, since
/// a watcher reports a file by its real path and the window may know it
/// through a symlink.
#[derive(Default)]
struct Shown {
    given: Mutex<Vec<PathBuf>>,
    known: Mutex<HashSet<PathBuf>>,
    /// The directories watched for them outside the tree, as given and
    /// resolved: a change in one of those is not the tree moving.
    outside: Mutex<HashSet<PathBuf>>,
}

impl Shown {
    fn set(&self, files: &[PathBuf]) {
        let mut known = HashSet::new();
        for file in files {
            known.insert(file.clone());
            known.insert(real(file));
        }
        *self.known.lock().expect("shown lock") = known;
        *self.given.lock().expect("shown lock") = files.to_vec();
    }

    fn set_outside(&self, dirs: &HashSet<PathBuf>) {
        let mut outside = HashSet::new();
        for dir in dirs {
            outside.insert(dir.clone());
            outside.insert(real(dir));
        }
        *self.outside.lock().expect("shown lock") = outside;
    }

    /// Whether every path of an event is in a directory watched only for
    /// a shown file, outside the tree.
    fn only_outside(&self, event: &notify::Result<Event>) -> bool {
        let Ok(event) = event else { return false };
        let outside = self.outside.lock().expect("shown lock");
        if outside.is_empty() || event.paths.is_empty() {
            return false;
        }
        event.paths.iter().all(|path| {
            path.parent()
                .map(|dir| outside.contains(dir) || outside.contains(&real(dir)))
                .unwrap_or(false)
        })
    }

    /// The paths of an event that are shown files, as the window gave
    /// them. Empty when none is, and for a file merely opened, which is
    /// what the viewer itself does to read it.
    fn hits(&self, event: &notify::Result<Event>) -> Vec<PathBuf> {
        let Ok(event) = event else { return Vec::new() };
        if accessed(event) {
            return Vec::new();
        }
        let known = self.known.lock().expect("shown lock");
        if known.is_empty() {
            return Vec::new();
        }
        let given = self.given.lock().expect("shown lock");
        event
            .paths
            .iter()
            .filter(|path| known.contains(*path) || known.contains(&real(path)))
            .filter_map(|path| {
                let resolved = real(path);
                given
                    .iter()
                    .find(|file| *file == path || real(file) == resolved)
                    .cloned()
            })
            .collect()
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
    if !inside_git(path) {
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

fn inside_git(path: &Path) -> bool {
    path.components().any(|c| c.as_os_str() == ".git")
}

/// The directory git keeps a worktree's index and HEAD in, when it is not
/// inside the worktree itself.
///
/// A linked worktree holds a file where a repository holds a directory, and
/// its index lives under the main repository as `.git/worktrees/<name>`. A
/// commit or a `git add` made in the worktree writes there and nowhere in the
/// tree, so without watching it too those never reach the pane.
fn admin_dir(root: &Path) -> Option<PathBuf> {
    let git = Repository::open(root).ok()?.path().to_path_buf();
    // Both sides resolved, because one of them comes from git and the other
    // from the caller, and a temporary directory or a home behind a symlink
    // would otherwise look like somewhere else entirely.
    if real(&git).starts_with(real(root)) {
        return None;
    }
    Some(git)
}

fn real(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Watches a worktree, and optionally one more path: the file the PostToolUse
/// hook writes. Both mean the same thing to the pane, which is that the tree
/// may have moved. The shown files, when there are any, join the new watcher.
pub fn watch(
    sink: Arc<dyn Sink>,
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

    // Best effort: a tree whose index cannot be watched still follows every
    // edit, and only a commit made inside it waits for the next one.
    if let Some(admin) = admin_dir(&root) {
        let _ = watcher.watch(&admin, RecursiveMode::Recursive);
    }

    let stop = Arc::new(Stop::default());
    std::thread::spawn({
        let stop = Arc::clone(&stop);
        let root = root.clone();
        let shown = Arc::clone(&watchers.shown);
        move || debounce(sink, receiver, root, stop, shown)
    });

    let mut active = Active {
        root,
        extra: None,
        dirs: HashSet::new(),
        watcher,
        stop,
    };
    attach_extra(&mut active, also);
    let shown = watchers.shown.given.lock().expect("shown lock").clone();
    attach_shown(&mut active, &watchers.shown, &shown);
    *current = Some(active);
    Ok(())
}

/// Watches the files the viewer shows, replacing the set each time; an
/// empty set, which is a viewer showing none, stops it. A file under the
/// tree is already seen by the watcher on it; one outside is watched
/// through its directory, flat, so an editor that saves by writing a new
/// file and renaming it over the old is seen too. A change to any of them
/// is `SHOWN_CHANGED`, whatever the tree watcher makes of it.
pub fn watch_shown(watchers: &Watchers, files: &[PathBuf]) {
    watchers.shown.set(files);
    let mut current = watchers.current.lock().expect("watchers lock");
    if let Some(active) = current.as_mut() {
        attach_shown(active, &watchers.shown, files);
    }
}

/// The directories to watch for the shown files: each file's, when it is
/// outside the tree and there to be watched.
fn shown_dirs(root: &Path, files: &[PathBuf]) -> HashSet<PathBuf> {
    let root = real(root);
    files
        .iter()
        .filter_map(|file| file.parent())
        .filter(|dir| dir.is_dir() && !real(dir).starts_with(&root))
        .map(Path::to_path_buf)
        .collect()
}

fn attach_shown(active: &mut Active, shown: &Shown, files: &[PathBuf]) {
    let wanted = shown_dirs(&active.root, files);
    for gone in active.dirs.difference(&wanted) {
        let _ = active.watcher.unwatch(gone);
    }
    for new in wanted.difference(&active.dirs) {
        let _ = active.watcher.watch(new, RecursiveMode::NonRecursive);
    }
    shown.set_outside(&wanted);
    active.dirs = wanted;
}

/// Absent until the hook has been installed, which is not an error: the
/// filesystem watch already covers everything on its own.
fn attach_extra(active: &mut Active, also: Option<PathBuf>) {
    let Some(extra) = also else { return };
    if active.extra.as_ref() == Some(&extra) || !extra.exists() {
        return;
    }
    if active
        .watcher
        .watch(&extra, RecursiveMode::NonRecursive)
        .is_ok()
    {
        active.extra = Some(extra);
    }
}

pub fn unwatch(watchers: &Watchers) {
    let mut current = watchers.current.lock().expect("watchers lock");
    if let Some(active) = current.take() {
        active.stop.stop();
    }
}

/// One event per burst to the pane, and one more naming the shown files
/// a burst touched, when it touched any. The shown files come down the
/// same channel as the tree and are told apart by path.
fn debounce(
    sink: Arc<dyn Sink>,
    receiver: Receiver<notify::Result<Event>>,
    root: PathBuf,
    stop: Arc<Stop>,
    shown: Arc<Shown>,
) {
    let ignored = Ignored::for_root(&root);
    loop {
        // Block until something happens, then wait for the burst to finish.
        let Ok(first) = receiver.recv() else { return };
        if stop.stopped() {
            return;
        }

        let started = std::time::Instant::now();
        let tree = |event: &notify::Result<Event>| {
            interesting(event) && !ignored.covers(event) && !shown.only_outside(event)
        };
        let mut worth_it = tree(&first);
        let mut hits: Vec<PathBuf> = shown.hits(&first);
        loop {
            if started.elapsed() >= MAX_WAIT {
                break;
            }
            match receiver.recv_timeout(DEBOUNCE) {
                Ok(event) => {
                    worth_it |= tree(&event);
                    for hit in shown.hits(&event) {
                        if !hits.contains(&hit) {
                            hits.push(hit);
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }

        if stop.stopped() {
            return;
        }
        if worth_it {
            sink.emit(
                GIT_CHANGED,
                serde_json::Value::String(root.to_string_lossy().to_string()),
            );
        }
        if !hits.is_empty() {
            sink.emit(
                SHOWN_CHANGED,
                serde_json::Value::Array(
                    hits.iter()
                        .map(|path| serde_json::Value::String(path.to_string_lossy().to_string()))
                        .collect(),
                ),
            );
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
    ///
    /// Git counts everything under `.git` as ignored, but `is_interesting`
    /// has already chosen which of those matter, so they are never covered.
    fn covers(&self, event: &notify::Result<Event>) -> bool {
        let Ok(event) = event else { return false };
        let Some(repo) = self.repo.as_ref() else {
            return false;
        };
        !event.paths.is_empty()
            && event.paths.iter().all(|path| {
                path.strip_prefix(&self.root)
                    .ok()
                    .filter(|relative| !inside_git(relative))
                    .and_then(|relative| repo.status_should_ignore(relative).ok())
                    .unwrap_or(false)
            })
    }
}

fn interesting(event: &notify::Result<Event>) -> bool {
    match event {
        Ok(event) => !accessed(event) && event.paths.iter().any(|path| is_interesting(path)),
        Err(_) => false,
    }
}

/// A file opened or closed, which Linux reports and nothing else does:
/// reading the index to answer a status, or a shown file to draw it, moved
/// nothing, and counting it would have every read ask for the next.
fn accessed(event: &Event) -> bool {
    matches!(event.kind, EventKind::Access(_))
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

    // Linux reports every open; reading HEAD to answer a status is not a
    // change, and neither is the viewer reading the file it shows.
    #[test]
    fn opening_a_file_is_not_a_change() {
        use notify::event::{AccessKind, AccessMode};
        let opened = Ok(
            Event::new(EventKind::Access(AccessKind::Open(AccessMode::Any)))
                .add_path(PathBuf::from("/repo/.git/HEAD")),
        );
        assert!(!interesting(&opened));
        let shown = Shown::default();
        shown.set(&[PathBuf::from("/elsewhere/draft.md")]);
        let read = Ok(
            Event::new(EventKind::Access(AccessKind::Close(AccessMode::Read)))
                .add_path(PathBuf::from("/elsewhere/draft.md")),
        );
        assert!(shown.hits(&read).is_empty());
        let written = Ok(
            Event::new(EventKind::Modify(notify::event::ModifyKind::Any))
                .add_path(PathBuf::from("/elsewhere/draft.md")),
        );
        assert_eq!(
            shown.hits(&written),
            vec![PathBuf::from("/elsewhere/draft.md")]
        );
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

    // A commit in a plain repository writes only under .git, which git itself
    // reports as ignored.
    #[test]
    fn a_commit_is_never_covered() {
        let dir = repo_with_ignore("commit");
        let ignored = Ignored::for_root(&dir);
        assert!(!ignored.covers(&event(&[dir.join(".git/index")])));
        assert!(!ignored.covers(&event(&[dir.join(".git/HEAD"), dir.join("target/x")])));
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

    /// A repository with a linked worktree under it, and the worktree's path.
    fn repo_with_worktree(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("workbench-watch-{name}"));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str], at: &Path| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(at)
                .output()
                .expect("git should be installed");
        };
        git(&["init", "-q", "-b", "main"], &dir);
        git(&["config", "user.email", "test@example.com"], &dir);
        git(&["config", "user.name", "Test"], &dir);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&["add", "-A"], &dir);
        git(&["commit", "-qm", "one"], &dir);
        let tree = dir.join(".claude/worktrees/feature");
        git(
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature",
                "--",
                &tree.to_string_lossy(),
            ],
            &dir,
        );
        (dir, tree)
    }

    // A commit made in a worktree writes under the main repository, which is
    // outside the tree the watcher is on.
    #[test]
    fn a_worktree_index_is_watched_where_git_keeps_it() {
        let (dir, tree) = repo_with_worktree("admin");
        let admin = admin_dir(&tree).expect("a linked worktree keeps its index elsewhere");
        assert!(
            real(&admin).starts_with(real(&dir).join(".git")),
            "{}",
            admin.display()
        );
        assert!(is_interesting(&admin.join("index")));
    }

    // A repository's own index is already inside what is being watched.
    #[test]
    fn a_plain_repository_has_nothing_else_to_watch() {
        let (dir, _) = repo_with_worktree("admin-own");
        assert_eq!(admin_dir(&dir), None);
    }

    // A shown file under the tree is already seen by the watcher on it; one
    // outside is watched through its directory, when the directory exists.
    #[test]
    fn shown_files_are_watched_by_directory_outside_the_tree_only() {
        let dir = repo_with_ignore("shown-dirs");
        let elsewhere = std::env::temp_dir().join("workbench-watch-shown-elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let dirs = shown_dirs(
            &dir,
            &[
                dir.join("docs/a.md"),
                dir.join("target/b.md"),
                elsewhere.join("c.md"),
                PathBuf::from("/nowhere/at/all/d.md"),
            ],
        );
        assert_eq!(dirs, HashSet::from([elsewhere]));
    }

    /// What the sink saw of an event, waiting for it to arrive.
    fn wait_for(recorder: &crate::events::testing::Recorder, event: &str) -> Option<Value> {
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(5) {
            let seen = recorder
                .events
                .lock()
                .unwrap()
                .iter()
                .find(|(name, _)| name == event)
                .map(|(_, payload)| payload.clone());
            if seen.is_some() {
                return seen;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        None
    }

    use serde_json::Value;

    // A document presented from outside the tree, or a file the tree
    // watcher would ignore, is still news when it changes.
    #[test]
    fn a_change_to_a_shown_file_is_emitted_wherever_it_is() {
        let dir = repo_with_ignore("shown-change");
        let elsewhere = std::env::temp_dir().join("workbench-watch-shown-change-elsewhere");
        std::fs::remove_dir_all(&elsewhere).ok();
        std::fs::create_dir_all(&elsewhere).unwrap();
        let outside = elsewhere.join("draft.md");
        std::fs::write(&outside, "one\n").unwrap();
        std::fs::create_dir_all(dir.join("target")).unwrap();
        let ignored = dir.join("target/shot.png");
        std::fs::write(&ignored, "x").unwrap();

        let recorder = Arc::new(crate::events::testing::Recorder::default());
        let sink: Arc<dyn Sink> = Arc::clone(&recorder) as Arc<dyn Sink>;
        let watchers = Watchers::default();
        watch(sink, &watchers, dir.clone(), None).unwrap();
        watch_shown(&watchers, &[outside.clone(), ignored.clone()]);
        // The watcher takes a moment to be looking.
        std::thread::sleep(Duration::from_millis(300));
        let before = recorder.events.lock().unwrap().clone();
        assert!(
            before.is_empty(),
            "nothing changed yet, but the sink saw {before:?}"
        );

        std::fs::write(&outside, "two\n").unwrap();
        let shown = wait_for(&recorder, SHOWN_CHANGED).expect("the shown file's change");
        assert_eq!(
            shown,
            Value::Array(vec![Value::String(outside.to_string_lossy().to_string())])
        );
        let seen = recorder.events.lock().unwrap().clone();
        assert!(
            !seen.iter().any(|(name, _)| name == GIT_CHANGED),
            "a file outside the tree is not the tree moving, but the sink saw {seen:?}"
        );

        recorder.events.lock().unwrap().clear();
        std::fs::write(&ignored, "y").unwrap();
        let shown = wait_for(&recorder, SHOWN_CHANGED).expect("the ignored file's change");
        assert_eq!(
            shown,
            Value::Array(vec![Value::String(ignored.to_string_lossy().to_string())])
        );

        // Shown no more: a change is nobody's news.
        watch_shown(&watchers, &[]);
        recorder.events.lock().unwrap().clear();
        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(&outside, "three\n").unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        assert!(recorder.events.lock().unwrap().is_empty());
        unwatch(&watchers);
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
