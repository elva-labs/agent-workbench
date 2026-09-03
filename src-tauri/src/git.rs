//! What the working tree looks like right now.
//!
//! libgit2 rather than gix: its status and diff are boring and complete, which
//! is exactly what you want underneath a UI. Everything here is a plain query
//! against a path, with no state of its own, so the watcher can call it again
//! whenever the tree moves and the pane simply re-renders.

use std::path::{Path, PathBuf};

use git2::{DiffFormat, DiffOptions, Repository, Status, StatusOptions};
use serde::Serialize;

/// Above this a diff stops being something you read and starts being something
/// that makes the pane crawl. The viewer says so rather than rendering it.
const MAX_DIFF_LINES: usize = 4000;
const MAX_CONTENT_LINES: usize = 8000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// M, A, D, R or C, matching what git itself calls them.
    pub status: String,
    pub add: u32,
    pub del: u32,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// hunk, add, del or ctx.
    pub kind: String,
    pub text: String,
    pub old: Option<u32>,
    pub new: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub lines: Vec<DiffLine>,
    pub binary: bool,
    /// True when the diff was cut short at the line cap.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub lines: Vec<String>,
    pub binary: bool,
    pub truncated: bool,
}

fn open(path: &Path) -> Result<Repository, String> {
    Repository::discover(path).map_err(|e| format!("not a git repository: {}", e.message()))
}

/// Letters chosen to match `git status --short`, and the order of the checks
/// matters: a file can be both staged and modified, and the more interesting
/// of the two is what the pane should show.
fn letter(status: Status) -> &'static str {
    if status.is_index_new() || status.is_wt_new() {
        "A"
    } else if status.is_index_deleted() || status.is_wt_deleted() {
        "D"
    } else if status.is_index_renamed() || status.is_wt_renamed() {
        "R"
    } else if status.is_conflicted() {
        "C"
    } else {
        "M"
    }
}

pub fn status(root: &Path) -> Result<Vec<ChangedFile>, String> {
    let repo = open(root)?;

    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .include_ignored(false);

    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(|e| format!("could not read status: {}", e.message()))?;

    let mut files = Vec::new();
    for entry in statuses.iter() {
        let Some(path) = entry.path() else { continue };
        if entry.status() == Status::CURRENT {
            continue;
        }

        let (add, del, binary) = line_counts(&repo, Path::new(path));
        files.push(ChangedFile {
            path: path.to_string(),
            status: letter(entry.status()).to_string(),
            add,
            del,
            binary,
        });
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// Additions and deletions for one path, and whether git considers it binary.
fn line_counts(repo: &Repository, path: &Path) -> (u32, u32, bool) {
    let mut options = DiffOptions::new();
    // include_untracked lists a new file; show_untracked_content is what makes
    // its lines appear. Without the second, a file the agent just created shows
    // up with an empty diff, which is the common case rather than an edge one.
    options
        .pathspec(path)
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);

    let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let Ok(diff) = repo.diff_tree_to_workdir_with_index(head.as_ref(), Some(&mut options)) else {
        return (0, 0, false);
    };

    let mut add = 0;
    let mut del = 0;
    let mut binary = false;
    let _ = diff.print(DiffFormat::Patch, |delta, _, line| {
        if delta.flags().is_binary() {
            binary = true;
        }
        match line.origin() {
            '+' => add += 1,
            '-' => del += 1,
            _ => {}
        }
        true
    });

    (add, del, binary)
}

pub fn diff(root: &Path, file: &str) -> Result<FileDiff, String> {
    let repo = open(root)?;

    let mut options = DiffOptions::new();
    options
        .pathspec(file)
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .context_lines(3);

    let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let diff = repo
        .diff_tree_to_workdir_with_index(head.as_ref(), Some(&mut options))
        .map_err(|e| format!("could not diff {file}: {}", e.message()))?;

    let mut lines = Vec::new();
    let mut binary = false;
    let mut truncated = false;

    let _ = diff.print(DiffFormat::Patch, |delta, hunk, line| {
        if delta.flags().is_binary() {
            binary = true;
            return true;
        }
        if lines.len() >= MAX_DIFF_LINES {
            truncated = true;
            return false;
        }

        // The file header lines carry no hunk and are noise in a pane that
        // already names the file.
        let kind = match line.origin() {
            '+' => "add",
            '-' => "del",
            ' ' => "ctx",
            'H' => "hunk",
            _ => return true,
        };
        if kind == "hunk" && hunk.is_none() {
            return true;
        }

        lines.push(DiffLine {
            kind: kind.to_string(),
            text: String::from_utf8_lossy(line.content()).trim_end_matches('\n').to_string(),
            old: line.old_lineno(),
            new: line.new_lineno(),
        });
        true
    });

    Ok(FileDiff {
        lines,
        binary,
        truncated,
    })
}

pub fn content(root: &Path, file: &str) -> Result<FileContent, String> {
    let repo = open(root)?;
    let workdir = repo
        .workdir()
        .ok_or("a bare repository has no working tree")?;
    let path = workdir.join(file);

    let bytes = std::fs::read(&path).map_err(|e| format!("could not read {file}: {e}"))?;

    // The same rule git uses: a NUL byte in the first few kilobytes means this
    // is not text, and rendering it would fill the pane with noise.
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Ok(FileContent {
            lines: Vec::new(),
            binary: true,
            truncated: false,
        });
    }

    let text = String::from_utf8_lossy(&bytes);
    let all: Vec<&str> = text.lines().collect();
    let truncated = all.len() > MAX_CONTENT_LINES;

    Ok(FileContent {
        lines: all
            .into_iter()
            .take(MAX_CONTENT_LINES)
            .map(str::to_string)
            .collect(),
        binary: false,
        truncated,
    })
}

/// Everything in the working tree that git would track, plus what it does not
/// yet, honouring .gitignore. A second data source, not a filter over status.
pub fn list_files(root: &Path) -> Result<Vec<String>, String> {
    let repo = open(root)?;

    let mut paths: Vec<String> = repo
        .index()
        .map_err(|e| format!("could not read the index: {}", e.message()))?
        .iter()
        .filter_map(|entry| String::from_utf8(entry.path).ok())
        .collect();

    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);

    if let Ok(statuses) = repo.statuses(Some(&mut options)) {
        for entry in statuses.iter() {
            if entry.status().is_wt_new() {
                if let Some(path) = entry.path() {
                    paths.push(path.to_string());
                }
            }
        }
    }

    paths.sort();
    paths.dedup();
    Ok(paths)
}

/// The worktree root, which is what the watcher should watch and what paths
/// are relative to.
pub fn workdir(root: &Path) -> Result<PathBuf, String> {
    let repo = open(root)?;
    repo.workdir()
        .map(Path::to_path_buf)
        .ok_or_else(|| "a bare repository has no working tree".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// A throwaway repository. Shelling out to git rather than building one
    /// through the API keeps the fixtures readable and matches what a user's
    /// tree actually looks like.
    fn repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("workbench-git-{name}"));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();

        let run = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .expect("git should be installed");
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        dir
    }

    fn write(dir: &Path, name: &str, body: &str) {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn commit(dir: &Path) {
        for args in [vec!["add", "-A"], vec!["commit", "-qm", "commit"]] {
            Command::new("git")
                .args(&args)
                .current_dir(dir)
                .output()
                .unwrap();
        }
    }

    #[test]
    fn a_clean_tree_has_nothing_to_show() {
        let dir = repo("clean");
        write(&dir, "a.txt", "one\n");
        commit(&dir);

        assert!(status(&dir).unwrap().is_empty());
    }

    #[test]
    fn reports_a_modified_file_with_its_line_counts() {
        let dir = repo("modified");
        write(&dir, "a.txt", "one\ntwo\nthree\n");
        commit(&dir);
        write(&dir, "a.txt", "one\nTWO\nthree\nfour\n");

        let files = status(&dir).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "a.txt");
        assert_eq!(files[0].status, "M");
        assert_eq!(files[0].add, 2, "the changed line and the new one");
        assert_eq!(files[0].del, 1);
    }

    #[test]
    fn reports_an_untracked_file_as_added() {
        let dir = repo("untracked");
        write(&dir, "a.txt", "one\n");
        commit(&dir);
        write(&dir, "new.txt", "fresh\n");

        let files = status(&dir).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "new.txt");
        assert_eq!(files[0].status, "A");
    }

    #[test]
    fn reports_a_deleted_file() {
        let dir = repo("deleted");
        write(&dir, "gone.txt", "bye\n");
        commit(&dir);
        std::fs::remove_file(dir.join("gone.txt")).unwrap();

        let files = status(&dir).unwrap();
        assert_eq!(files[0].status, "D");
    }

    #[test]
    fn respects_gitignore() {
        let dir = repo("ignored");
        write(&dir, ".gitignore", "secret.txt\n");
        commit(&dir);
        write(&dir, "secret.txt", "shh\n");

        assert!(status(&dir).unwrap().iter().all(|f| f.path != "secret.txt"));
        assert!(list_files(&dir).unwrap().iter().all(|p| p != "secret.txt"));
    }

    #[test]
    fn sorts_by_path_so_the_tree_is_stable() {
        let dir = repo("sorted");
        write(&dir, "a.txt", "x\n");
        commit(&dir);
        write(&dir, "z.txt", "z\n");
        write(&dir, "b.txt", "b\n");

        let paths: Vec<String> = status(&dir).unwrap().into_iter().map(|f| f.path).collect();
        assert_eq!(paths, vec!["b.txt", "z.txt"]);
    }

    #[test]
    fn produces_a_readable_diff() {
        let dir = repo("diff");
        write(&dir, "a.txt", "one\ntwo\n");
        commit(&dir);
        write(&dir, "a.txt", "one\nTWO\n");

        let result = diff(&dir, "a.txt").unwrap();
        assert!(!result.binary);
        assert!(result.lines.iter().any(|l| l.kind == "hunk"));

        let added: Vec<&DiffLine> = result.lines.iter().filter(|l| l.kind == "add").collect();
        let removed: Vec<&DiffLine> = result.lines.iter().filter(|l| l.kind == "del").collect();
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].text, "TWO");
        assert_eq!(removed[0].text, "two");
    }

    #[test]
    fn diff_lines_carry_both_line_numbers() {
        let dir = repo("linenos");
        write(&dir, "a.txt", "one\ntwo\n");
        commit(&dir);
        write(&dir, "a.txt", "one\nTWO\n");

        let result = diff(&dir, "a.txt").unwrap();
        let context = result.lines.iter().find(|l| l.kind == "ctx").unwrap();
        assert_eq!(context.old, Some(1));
        assert_eq!(context.new, Some(1));

        let added = result.lines.iter().find(|l| l.kind == "add").unwrap();
        assert_eq!(added.old, None, "an addition has no old line");
        assert_eq!(added.new, Some(2));
    }

    #[test]
    fn diffs_an_untracked_file_as_all_additions() {
        let dir = repo("newdiff");
        write(&dir, "a.txt", "x\n");
        commit(&dir);
        write(&dir, "new.txt", "alpha\nbeta\n");

        let result = diff(&dir, "new.txt").unwrap();
        assert!(result.lines.iter().filter(|l| l.kind == "add").count() >= 2);
        assert!(result.lines.iter().all(|l| l.kind != "del"));
    }

    #[test]
    fn calls_a_binary_file_binary_rather_than_rendering_it() {
        let dir = repo("binary");
        write(&dir, "a.txt", "x\n");
        commit(&dir);
        std::fs::write(dir.join("blob.bin"), [0u8, 1, 2, 0, 3]).unwrap();

        assert!(content(&dir, "blob.bin").unwrap().binary);
    }

    #[test]
    fn reads_file_content() {
        let dir = repo("content");
        write(&dir, "a.txt", "one\ntwo\nthree\n");
        commit(&dir);

        let result = content(&dir, "a.txt").unwrap();
        assert_eq!(result.lines, vec!["one", "two", "three"]);
        assert!(!result.truncated);
    }

    #[test]
    fn truncates_a_very_long_file_rather_than_crawling() {
        let dir = repo("long");
        let body: String = (0..MAX_CONTENT_LINES + 500)
            .map(|i| format!("line {i}\n"))
            .collect();
        write(&dir, "long.txt", &body);
        commit(&dir);

        let result = content(&dir, "long.txt").unwrap();
        assert_eq!(result.lines.len(), MAX_CONTENT_LINES);
        assert!(result.truncated);
    }

    #[test]
    fn lists_tracked_and_untracked_files_together() {
        let dir = repo("listing");
        write(&dir, "src/a.rs", "x\n");
        commit(&dir);
        write(&dir, "src/b.rs", "y\n");

        let files = list_files(&dir).unwrap();
        assert!(files.contains(&"src/a.rs".to_string()));
        assert!(files.contains(&"src/b.rs".to_string()));
    }

    #[test]
    fn works_from_a_subdirectory_of_the_repository() {
        let dir = repo("subdir");
        write(&dir, "src/deep/a.txt", "one\n");
        commit(&dir);
        write(&dir, "src/deep/a.txt", "two\n");

        // Paths stay relative to the worktree root, not to where you looked.
        let files = status(&dir.join("src/deep")).unwrap();
        assert_eq!(files[0].path, "src/deep/a.txt");
    }

    #[test]
    fn says_plainly_when_there_is_no_repository() {
        let dir = std::env::temp_dir().join("workbench-git-none");
        std::fs::create_dir_all(&dir).unwrap();
        // A temp directory can sit inside someone's repository, so only assert
        // on the error when discovery genuinely finds nothing.
        if let Err(message) = status(&dir) {
            assert!(message.contains("not a git repository"), "{message}");
        }
    }
}
