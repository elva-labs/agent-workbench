//! The project the workbench is pointed at.
//!
//! One window, one project, one agent, one worktree. Everything else reads
//! from here: the agent spawns in this directory, the changes pane watches it,
//! and the session index is keyed by it. Before this existed the three each
//! answered "which directory" separately, and the answer was `"."`.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    /// The directory that was opened, absolute.
    pub path: String,
    /// The last segment, for the window title and the pane header.
    pub name: String,
    /// The worktree root, when the directory is inside a repository. Opening a
    /// subdirectory of a repository should still show the whole repository's
    /// changes, so this is what the changes pane watches.
    pub repository: Option<String>,
    /// False for a folder that is not in a repository at all. The changes pane
    /// says so rather than sitting there empty.
    pub is_git: bool,
    /// The branch the repository has checked out, short; None outside a
    /// repository and on a detached HEAD.
    pub branch: Option<String>,
}

pub fn describe(path: &Path) -> Result<ProjectInfo, String> {
    if !path.is_dir() {
        return Err(format!("{} is not a directory", path.display()));
    }

    // The plain form of the path. Windows' own canonical form carries the
    // verbatim \\?\ prefix, which cmd.exe does not accept as a directory:
    // an agent started there lands in the Windows directory instead.
    let path = dunce::canonicalize(path)
        .map_err(|e| format!("could not resolve {}: {e}", path.display()))?;

    let repository = find_repository(&path);

    Ok(ProjectInfo {
        name: project_name(&path),
        path: path.to_string_lossy().to_string(),
        is_git: repository.is_some(),
        branch: repository.as_deref().and_then(branch),
        repository: repository.map(|p| p.to_string_lossy().to_string()),
    })
}

/// The branch a repository has checked out, read from its HEAD: in `.git`
/// for a clone, and in the directory a `.git` file names for a worktree.
/// None for a detached HEAD or one that cannot be read.
fn branch(repository: &Path) -> Option<String> {
    let dot = repository.join(".git");
    let git = if dot.is_file() {
        let pointer = std::fs::read_to_string(&dot).ok()?;
        let named = pointer.trim().strip_prefix("gitdir:")?.trim();
        repository.join(named)
    } else {
        dot
    };
    let head = std::fs::read_to_string(git.join("HEAD")).ok()?;
    let name = head.trim().strip_prefix("ref: refs/heads/")?;
    (!name.is_empty()).then(|| name.to_string())
}

/// Walks up looking for `.git`. It is a directory in a normal clone and a file
/// in a worktree or a submodule, so the check is existence rather than kind.
///
/// Phase 2 hands this to `Repository::discover`, which knows about ceiling
/// directories and bare repositories. This is the part that has to work now.
fn find_repository(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|dir| dir.join(".git").exists())
        .map(Path::to_path_buf)
}

/// The last segment, falling back to the whole path for a root directory.
fn project_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratch::Scratch;

    fn temp(name: &str) -> Scratch {
        Scratch::new(name)
    }

    #[test]
    fn names_a_plain_directory() {
        let scratch = temp("workbench-project-plain");
        let dir = scratch.join("plain-project");
        std::fs::create_dir_all(&dir).unwrap();
        let info = describe(&dir).unwrap();
        assert_eq!(info.name, "plain-project");
        assert!(!info.is_git);
        assert_eq!(info.repository, None);
    }

    #[test]
    fn refuses_something_that_is_not_a_directory() {
        let dir = temp("workbench-project-file");
        let file = dir.join("a-file");
        std::fs::write(&file, b"x").unwrap();
        assert!(describe(&file).is_err());
    }

    #[test]
    fn refuses_a_directory_that_is_not_there() {
        assert!(describe(Path::new("/no/such/directory/anywhere")).is_err());
    }

    #[test]
    fn finds_a_repository_at_the_directory_itself() {
        let dir = temp("workbench-project-repo");
        std::fs::create_dir_all(dir.join(".git")).unwrap();

        let info = describe(&dir).unwrap();
        assert!(info.is_git);
        assert_eq!(info.repository, Some(info.path.clone()));
    }

    // Opening a subdirectory should still show the whole repository's changes.
    #[test]
    fn finds_a_repository_above_the_directory() {
        let dir = temp("workbench-project-nested");
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        let inner = dir.join("src/deep");
        std::fs::create_dir_all(&inner).unwrap();

        let info = describe(&inner).unwrap();
        assert!(info.is_git);
        assert_eq!(info.name, "deep");
        assert_eq!(
            info.repository,
            Some(
                dunce::canonicalize(&dir)
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            )
        );
    }

    // What the agent is started in has to be a path every program takes.
    #[test]
    fn gives_a_path_without_the_verbatim_prefix() {
        let dir = temp("workbench-project-verbatim");
        let info = describe(&dir).unwrap();
        assert!(!info.path.starts_with(r"\\?\"), "{}", info.path);
        assert!(Path::new(&info.path).is_dir());
    }

    // A worktree and a submodule both carry .git as a file, not a directory.
    #[test]
    fn accepts_a_git_file_as_well_as_a_directory() {
        let dir = temp("workbench-project-worktree");
        std::fs::write(dir.join(".git"), b"gitdir: /elsewhere/.git/worktrees/x").unwrap();

        assert!(describe(&dir).unwrap().is_git);
    }

    #[test]
    fn names_the_branch_checked_out() {
        let dir = temp("workbench-project-branch");
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git/HEAD"), b"ref: refs/heads/feature/x\n").unwrap();
        assert_eq!(describe(&dir).unwrap().branch.as_deref(), Some("feature/x"));

        std::fs::write(
            dir.join(".git/HEAD"),
            b"0123456789abcdef0123456789abcdef01234567\n",
        )
        .unwrap();
        assert_eq!(describe(&dir).unwrap().branch, None);

        let plain = temp("workbench-project-branch-plain");
        assert_eq!(describe(&plain).unwrap().branch, None);
    }

    #[test]
    fn names_a_worktree_s_branch_from_the_directory_its_git_file_names() {
        let dir = temp("workbench-project-branch-worktree");
        let gitdir = dir.join("main/.git/worktrees/wt");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::write(gitdir.join("HEAD"), b"ref: refs/heads/wt\n").unwrap();
        let tree = dir.join("wt");
        std::fs::create_dir_all(&tree).unwrap();
        std::fs::write(tree.join(".git"), b"gitdir: ../main/.git/worktrees/wt\n").unwrap();
        assert_eq!(describe(&tree).unwrap().branch.as_deref(), Some("wt"));
    }

    #[test]
    fn returns_an_absolute_path() {
        let dir = temp("workbench-project-absolute");
        let info = describe(&dir).unwrap();
        assert!(Path::new(&info.path).is_absolute());
    }
}
