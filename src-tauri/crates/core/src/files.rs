//! Reading and writing the files of a working tree for the editor.
//!
//! Every path is relative to the root it is asked against and stays inside
//! it: no `..`, no absolute path, and no symbolic link on the way that leads
//! out. That holds when a path is resolved, not while it is used: a folder on
//! the way swapped for a link between the check and the operation is not
//! noticed. A file's `stamp` names its exact bytes, so a write can tell
//! whether the file is still the one the editor read. Nothing in `.git` is
//! changed from here.

use std::ffi::OsStr;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// The largest file the editor opens.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileText {
    pub text: String,
    pub stamp: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileWritten {
    pub written: bool,
    /// The stamp of what is on disk after the call, or `None` when nothing is
    /// there.
    pub stamp: Option<String>,
}

/// The git blob id of the bytes: the same bytes always give the same stamp,
/// whatever the file's modification time.
fn stamp_of(bytes: &[u8]) -> Result<String, String> {
    git2::Oid::hash_object(git2::ObjectType::Blob, bytes)
        .map(|oid| oid.to_string())
        .map_err(|e| format!("could not stamp the file: {}", e.message()))
}

fn outside(file: &str) -> String {
    format!("{file} is not a path inside the working tree")
}

fn in_git(file: &str) -> String {
    format!("{file} is in .git, which is not changed from here")
}

/// The folder the paths are relative to, with every link in it resolved.
fn tree(root: &Path) -> Result<PathBuf, String> {
    dunce::canonicalize(root).map_err(|e| format!("could not open {}: {e}", root.display()))
}

/// A path without the `\\?\` form Windows gives long or unusual names, so
/// two spellings of one place compare equal. Elsewhere it is the path.
fn comparable(path: &Path) -> PathBuf {
    if !cfg!(windows) {
        return path.to_path_buf();
    }
    let text = path.as_os_str().to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

/// A name Windows would read as something other than what was typed: one
/// with a stream suffix (`.git::$INDEX_ALLOCATION`) or only dots and spaces,
/// which it drops to name the folder itself.
fn odd_name(name: &OsStr) -> bool {
    if !cfg!(windows) {
        return false;
    }
    let text = name.to_string_lossy();
    text.contains(':') || text.trim_end_matches(['.', ' ']).is_empty()
}

/// Whether a name is `.git`, in any case, and on Windows with the trailing
/// dots and spaces it ignores.
fn is_git_name(name: &OsStr) -> bool {
    let text = name.to_string_lossy();
    let text: &str = if cfg!(windows) {
        text.trim_end_matches(['.', ' '])
    } else {
        &text
    };
    text.eq_ignore_ascii_case(".git")
}

/// A path that names something below the root: not the root itself, not
/// empty, not climbing or absolute.
fn below_root(file: &str) -> Result<&Path, String> {
    let path = crate::git::inside_worktree(file)?;
    let named = path.components().any(|c| matches!(c, Component::Normal(_)));
    let odd = path
        .components()
        .any(|c| matches!(c, Component::Normal(name) if odd_name(name)));
    if named && !odd {
        Ok(path)
    } else {
        Err(outside(file))
    }
}

/// Where `rel` really is, following every link, as long as that is inside the
/// tree. A path that does not exist yet resolves through its nearest folder
/// that does.
fn resolve(tree: &Path, rel: &Path, file: &str) -> Result<PathBuf, String> {
    let mut existing = tree.join(rel);
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    let real = loop {
        match dunce::canonicalize(&existing) {
            Ok(real) => break real,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if std::fs::symlink_metadata(&existing).is_ok() {
                    return Err(format!("{file} is a link to something that is not there"));
                }
                let name = existing.file_name().map(|n| n.to_owned());
                match name {
                    Some(name) if existing.pop() => rest.push(name),
                    _ => return Err(outside(file)),
                }
            }
            Err(e) => return Err(format!("could not reach {file}: {e}")),
        }
    };
    if !comparable(&real).starts_with(comparable(tree)) {
        return Err(outside(file));
    }
    Ok(rest.iter().rev().fold(real, |path, name| path.join(name)))
}

/// Where `rel` is, with the links on the way resolved but a link at the end
/// left as it is, for the operations that act on the link itself.
fn resolve_entry(tree: &Path, rel: &Path, file: &str) -> Result<PathBuf, String> {
    let name = rel.file_name().ok_or_else(|| outside(file))?;
    let parent = rel.parent().unwrap_or_else(|| Path::new(""));
    Ok(resolve(tree, parent, file)?.join(name))
}

/// Whether a path is `.git` or inside it, judged by the name as typed and by
/// what the system says the entry is when it exists, so spellings the system
/// rewrites (short names, case) and links to `.git` are caught too.
fn touches_git(tree: &Path, rel: &Path, entry: &Path) -> bool {
    let base = comparable(tree);
    let below_git = |path: &Path| {
        let path = comparable(path);
        path.strip_prefix(&base)
            .is_ok_and(|under| under.components().any(|c| is_git_name(c.as_os_str())))
    };
    rel.components().any(|c| is_git_name(c.as_os_str()))
        || below_git(entry)
        || dunce::canonicalize(entry).is_ok_and(|real| below_git(&real))
}

/// Whether the entry is the working tree itself, by what the system says it
/// is and not by how it was typed.
fn is_tree(tree: &Path, entry: &Path) -> bool {
    let base = comparable(tree);
    comparable(entry) == base
        || dunce::canonicalize(entry).is_ok_and(|real| comparable(&real) == base)
}

pub fn read(root: &Path, file: &str) -> Result<FileText, String> {
    let tree = tree(root)?;
    let path = resolve(&tree, below_root(file)?, file)?;
    let meta = std::fs::metadata(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("{file} does not exist"),
        _ => format!("could not read {file}: {e}"),
    })?;
    if !meta.is_file() {
        return Err(format!("{file} is not a file"));
    }
    if meta.len() > MAX_BYTES {
        return Err(format!("{file} is larger than 4 MB"));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("could not read {file}: {e}"))?;
    // The rule git uses: a NUL byte in the first few kilobytes means binary.
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Err(format!("{file} is a binary file"));
    }
    let stamp = stamp_of(&bytes)?;
    let text = String::from_utf8(bytes).map_err(|_| format!("{file} is not valid UTF-8"))?;
    Ok(FileText { text, stamp })
}

/// The stamp of the file at `path`, `None` when nothing is there.
fn current_stamp(path: &Path, file: &str) -> Result<Option<String>, String> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => Err(format!("{file} is a folder")),
        Ok(meta) if !meta.is_file() => Err(format!("{file} is not a file")),
        Ok(_) => {
            let bytes = std::fs::read(path).map_err(|e| format!("could not read {file}: {e}"))?;
            stamp_of(&bytes).map(Some)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not reach {file}: {e}")),
    }
}

/// Refuses a file that is there and cannot be written. Replacing by rename
/// needs write permission on the folder only, so the file's own is checked.
fn writable(path: &Path, file: &str) -> Result<(), String> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => Err(format!("{file} is a folder")),
        Ok(meta) if !meta.is_file() => Err(format!("{file} is not a file")),
        Ok(meta) => {
            let denied = match std::fs::OpenOptions::new().write(true).open(path) {
                Ok(_) => false,
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => true,
                Err(e) => return Err(format!("could not write {file}: {e}")),
            };
            if meta.permissions().readonly() || denied {
                Err(format!("{file} is read-only"))
            } else {
                Ok(())
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not reach {file}: {e}")),
    }
}

/// Writes `text` to a new file beside `path` and returns its name. For a file
/// that exists, the new one is private while it is written and takes the
/// permissions of the old before any text goes in. Replacing by rename gives
/// the file a new inode, so other hard links to it keep the old content and
/// the owner, ACLs and extended attributes are not carried over.
fn stage(path: &Path, text: &str, file: &str) -> Result<PathBuf, String> {
    let name = path.file_name().ok_or_else(|| outside(file))?;
    let mut temp_name = std::ffi::OsString::from(".");
    temp_name.push(name);
    temp_name.push(format!(".{}.tmp", uuid::Uuid::new_v4().simple()));
    let temp = path.with_file_name(temp_name);

    #[cfg(unix)]
    let existing = std::fs::metadata(path).ok();

    let result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if existing.is_some() {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut out = options.open(&temp)?;
        #[cfg(unix)]
        if let Some(meta) = &existing {
            out.set_permissions(meta.permissions())?;
        }
        out.write_all(text.as_bytes())?;
        out.sync_all()
    })();
    match result {
        Ok(()) => Ok(temp),
        Err(e) => {
            std::fs::remove_file(&temp).ok();
            Err(format!("could not write {file}: {e}"))
        }
    }
}

pub fn write(
    root: &Path,
    file: &str,
    text: &str,
    stamp: Option<&str>,
    overwrite: bool,
) -> Result<FileWritten, String> {
    let tree = tree(root)?;
    let rel = below_root(file)?;
    let path = resolve(&tree, rel, file)?;
    if touches_git(&tree, rel, &path) {
        return Err(in_git(file));
    }
    // Creating never replaces anything, so only a write that may replace the
    // file asks whether it can be written.
    if stamp.is_some() || overwrite {
        writable(&path, file)?;
    }

    // A save against a stamp does not make folders: if the file's folder is
    // gone, so is the file.
    let parent = path.parent();
    if stamp.is_some() && !overwrite && !parent.is_some_and(Path::is_dir) {
        return Ok(FileWritten {
            written: false,
            stamp: None,
        });
    }
    if let Some(parent) = parent {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not make the folders for {file}: {e}"))?;
    }

    // The new content is complete beside the target before anything is
    // compared, so the check and the rename are the only steps left between
    // reading the disk and replacing it.
    let temp = stage(&path, text, file)?;
    let outcome = replace(&temp, &path, file, stamp, overwrite);
    if !matches!(outcome, Ok(true)) {
        std::fs::remove_file(&temp).ok();
    }
    match outcome? {
        true => Ok(FileWritten {
            written: true,
            stamp: Some(stamp_of(text.as_bytes())?),
        }),
        false => Ok(FileWritten {
            written: false,
            stamp: current_stamp(&path, file)?,
        }),
    }
}

/// Puts the staged file at `path` if the stamp allows it. The disk is read
/// and the file replaced as separate steps, so something that writes to the
/// file between them is overwritten without being noticed; that window is
/// the time to hash one file. A new file is linked into place, which fails if
/// anything has appeared there, so creating never replaces.
fn replace(
    temp: &Path,
    path: &Path,
    file: &str,
    stamp: Option<&str>,
    overwrite: bool,
) -> Result<bool, String> {
    let failed = |e: std::io::Error| format!("could not write {file}: {e}");
    if overwrite {
        std::fs::rename(temp, path).map_err(failed)?;
        return Ok(true);
    }
    match stamp {
        Some(wanted) => {
            if current_stamp(path, file)?.as_deref() != Some(wanted) {
                return Ok(false);
            }
            std::fs::rename(temp, path).map_err(failed)?;
            Ok(true)
        }
        None => {
            match std::fs::hard_link(temp, path) {
                Ok(()) => {
                    std::fs::remove_file(temp).ok();
                    Ok(true)
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
                // A filesystem without links: check, then rename.
                Err(_) => {
                    if std::fs::symlink_metadata(path).is_ok() {
                        return Ok(false);
                    }
                    std::fs::rename(temp, path).map_err(failed)?;
                    Ok(true)
                }
            }
        }
    }
}

/// Whether two paths are one entry, as `readme.md` and `README.md` are on a
/// volume that ignores case. Links are never taken for the same entry, and
/// two hard links to one file are two entries: each has its own real name.
fn same_entry(a: &Path, b: &Path) -> bool {
    let plain = |path: &Path| {
        std::fs::symlink_metadata(path).is_ok_and(|meta| !meta.file_type().is_symlink())
    };
    plain(a)
        && plain(b)
        && matches!(
            (dunce::canonicalize(a), dunce::canonicalize(b)),
            (Ok(x), Ok(y)) if x == y
        )
}

pub fn rename(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let tree = tree(root)?;
    let (from_rel, to_rel) = (below_root(from)?, below_root(to)?);
    let source = resolve_entry(&tree, from_rel, from)?;
    let target = resolve_entry(&tree, to_rel, to)?;
    if touches_git(&tree, from_rel, &source) {
        return Err(in_git(from));
    }
    if touches_git(&tree, to_rel, &target) {
        return Err(in_git(to));
    }
    if std::fs::symlink_metadata(&source).is_err() {
        return Err(format!("{from} does not exist"));
    }
    if std::fs::symlink_metadata(&target).is_ok() && !same_entry(&source, &target) {
        return Err(format!("{to} already exists"));
    }
    if std::fs::symlink_metadata(&source).is_ok_and(|meta| meta.is_dir())
        && holds_git(&source, from)?
    {
        return Err(format!(
            "{from} holds another repository or a worktree, with a .git inside, and is not moved from here"
        ));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not make the folders for {to}: {e}"))?;
    }
    // The target was free (or was the source itself) when it was checked. The
    // rename replaces whatever has appeared there since, and the window is
    // the time to make the folders on the way.
    std::fs::rename(&source, &target).map_err(|e| format!("could not move {from} to {to}: {e}"))
}

/// Whether anything inside the folder is named `.git`, looking in every
/// folder below it and following no link.
fn holds_git(folder: &Path, path: &str) -> Result<bool, String> {
    let looking = |e: std::io::Error| format!("could not look inside {path}: {e}");
    let mut folders = vec![folder.to_path_buf()];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(&folder).map_err(looking)? {
            let entry = entry.map_err(looking)?;
            if is_git_name(&entry.file_name()) {
                return Ok(true);
            }
            if entry.file_type().map_err(looking)?.is_dir() {
                folders.push(entry.path());
            }
        }
    }
    Ok(false)
}

pub fn delete(root: &Path, path: &str) -> Result<(), String> {
    let tree = tree(root)?;
    let rel = below_root(path)?;
    let target = resolve_entry(&tree, rel, path)?;
    if is_tree(&tree, &target) {
        return Err(format!("{path} is the working tree itself"));
    }
    if touches_git(&tree, rel, &target) {
        return Err(in_git(path));
    }
    let meta = std::fs::symlink_metadata(&target).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("{path} does not exist"),
        _ => format!("could not reach {path}: {e}"),
    })?;
    let done = if meta.is_dir() {
        if holds_git(&target, path)? {
            return Err(format!(
                "{path} holds another repository or a worktree, with a .git inside, and is not deleted from here"
            ));
        }
        std::fs::remove_dir_all(&target)
    } else {
        // A link goes, never what it points at. A link to a folder is a
        // folder entry on Windows.
        std::fs::remove_file(&target).or_else(|e| std::fs::remove_dir(&target).map_err(|_| e))
    };
    done.map_err(|e| format!("could not delete {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratch::Scratch;

    fn tree_with(files: &[(&str, &str)]) -> Scratch {
        let dir = Scratch::new("files");
        for (name, text) in files {
            let path = dir.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        dir
    }

    fn read_disk(dir: &Scratch, name: &str) -> String {
        std::fs::read_to_string(dir.path().join(name)).unwrap()
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn a_read_gives_the_exact_text() {
        let dir = tree_with(&[("a.txt", "one\r\ntwo\n\n")]);
        let read = read(dir.path(), "a.txt").unwrap();
        assert_eq!(read.text, "one\r\ntwo\n\n");
        assert!(!read.stamp.is_empty());
    }

    #[test]
    fn the_stamp_follows_the_bytes_not_the_modification_time() {
        let dir = tree_with(&[("a.txt", "same")]);
        let first = read(dir.path(), "a.txt").unwrap().stamp;
        std::fs::write(dir.path().join("a.txt"), "same").unwrap();
        assert_eq!(read(dir.path(), "a.txt").unwrap().stamp, first);
        std::fs::write(dir.path().join("a.txt"), "other").unwrap();
        assert_ne!(read(dir.path(), "a.txt").unwrap().stamp, first);
    }

    #[test]
    fn a_read_refuses_what_the_editor_cannot_show() {
        let dir = tree_with(&[("dir/x", "x")]);
        std::fs::write(dir.path().join("bin"), b"ab\0cd").unwrap();
        std::fs::write(dir.path().join("latin"), [0x66, 0xe9, 0x6c]).unwrap();
        std::fs::write(dir.path().join("big"), vec![b'a'; MAX_BYTES as usize + 1]).unwrap();
        assert_eq!(read(dir.path(), "bin").unwrap_err(), "bin is a binary file");
        assert_eq!(
            read(dir.path(), "latin").unwrap_err(),
            "latin is not valid UTF-8"
        );
        assert_eq!(
            read(dir.path(), "big").unwrap_err(),
            "big is larger than 4 MB"
        );
        assert_eq!(read(dir.path(), "gone").unwrap_err(), "gone does not exist");
        assert_eq!(read(dir.path(), "dir").unwrap_err(), "dir is not a file");
    }

    #[test]
    fn a_file_of_exactly_the_limit_reads() {
        let dir = tree_with(&[]);
        std::fs::write(dir.path().join("edge"), vec![b'a'; MAX_BYTES as usize]).unwrap();
        assert!(read(dir.path(), "edge").is_ok());
    }

    #[test]
    fn a_write_with_the_current_stamp_replaces_the_file() {
        let dir = tree_with(&[("a.txt", "old")]);
        let stamp = read(dir.path(), "a.txt").unwrap().stamp;
        let done = write(dir.path(), "a.txt", "new\r\n", Some(&stamp), false).unwrap();
        assert!(done.written);
        assert_eq!(read_disk(&dir, "a.txt"), "new\r\n");
        assert_eq!(
            done.stamp.unwrap(),
            read(dir.path(), "a.txt").unwrap().stamp
        );
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn a_write_with_a_stale_stamp_leaves_the_file_and_names_what_is_there() {
        let dir = tree_with(&[("a.txt", "old")]);
        let stamp = read(dir.path(), "a.txt").unwrap().stamp;
        std::fs::write(dir.path().join("a.txt"), "someone else").unwrap();
        let done = write(dir.path(), "a.txt", "mine", Some(&stamp), false).unwrap();
        assert!(!done.written);
        assert_eq!(read_disk(&dir, "a.txt"), "someone else");
        assert_eq!(
            done.stamp.unwrap(),
            read(dir.path(), "a.txt").unwrap().stamp
        );
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn a_write_against_a_file_that_is_gone_says_so() {
        let dir = tree_with(&[("a.txt", "old"), ("f/g/b.txt", "old")]);
        let stamp = read(dir.path(), "a.txt").unwrap().stamp;
        std::fs::remove_file(dir.path().join("a.txt")).unwrap();
        let gone = FileWritten {
            written: false,
            stamp: None,
        };
        assert_eq!(
            write(dir.path(), "a.txt", "mine", Some(&stamp), false).unwrap(),
            gone
        );
        assert!(!dir.path().join("a.txt").exists());
        assert!(leftovers(dir.path()).is_empty());

        let stamp = read(dir.path(), "f/g/b.txt").unwrap().stamp;
        std::fs::remove_dir_all(dir.path().join("f")).unwrap();
        assert_eq!(
            write(dir.path(), "f/g/b.txt", "mine", Some(&stamp), false).unwrap(),
            gone
        );
        assert!(!dir.path().join("f").exists());
    }

    #[test]
    fn no_stamp_creates_a_file_and_the_folders_on_the_way() {
        let dir = tree_with(&[]);
        let done = write(dir.path(), "new/deep/a.txt", "", None, false).unwrap();
        assert!(done.written);
        assert_eq!(read_disk(&dir, "new/deep/a.txt"), "");
        assert!(leftovers(&dir.path().join("new/deep")).is_empty());
    }

    #[test]
    fn no_stamp_never_replaces_what_is_there() {
        let dir = tree_with(&[("a.txt", "mine already")]);
        let done = write(dir.path(), "a.txt", "", None, false).unwrap();
        assert!(!done.written);
        assert_eq!(read_disk(&dir, "a.txt"), "mine already");
        assert_eq!(
            done.stamp.unwrap(),
            read(dir.path(), "a.txt").unwrap().stamp
        );
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn overwrite_writes_whatever_is_there_and_ignores_the_stamp() {
        let dir = tree_with(&[("a.txt", "old")]);
        let done = write(dir.path(), "a.txt", "forced", Some("not a stamp"), true).unwrap();
        assert!(done.written);
        assert_eq!(read_disk(&dir, "a.txt"), "forced");
        let created = write(dir.path(), "b.txt", "made", Some("not a stamp"), true).unwrap();
        assert!(created.written);
        assert_eq!(read_disk(&dir, "b.txt"), "made");
    }

    #[test]
    fn a_folder_at_the_path_is_an_error() {
        let dir = tree_with(&[("d/x", "x")]);
        assert_eq!(
            write(dir.path(), "d", "t", None, false).unwrap_err(),
            "d is a folder"
        );
        assert_eq!(
            write(dir.path(), "d", "t", None, true).unwrap_err(),
            "d is a folder"
        );
    }

    #[test]
    fn a_file_where_a_folder_is_needed_is_an_error() {
        let dir = tree_with(&[("a.txt", "x")]);
        assert!(write(dir.path(), "a.txt/b.txt", "t", None, false).is_err());
        assert_eq!(read_disk(&dir, "a.txt"), "x");
    }

    #[cfg(unix)]
    #[test]
    fn a_write_keeps_the_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tree_with(&[("run.sh", "#!/bin/sh\n")]);
        let path = dir.path().join("run.sh");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o750)).unwrap();
        let stamp = read(dir.path(), "run.sh").unwrap().stamp;
        write(
            dir.path(),
            "run.sh",
            "#!/bin/sh\necho\n",
            Some(&stamp),
            false,
        )
        .unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o750);
        write(dir.path(), "run.sh", "x", None, true).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o750);
    }

    #[cfg(unix)]
    #[test]
    fn a_write_goes_through_a_link_to_a_target_inside_the_tree() {
        let dir = tree_with(&[("real/a.txt", "old")]);
        std::os::unix::fs::symlink("real/a.txt", dir.path().join("link")).unwrap();
        let stamp = read(dir.path(), "link").unwrap().stamp;
        let done = write(dir.path(), "link", "new", Some(&stamp), false).unwrap();
        assert!(done.written);
        assert!(std::fs::symlink_metadata(dir.path().join("link"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(read_disk(&dir, "real/a.txt"), "new");
        assert!(leftovers(&dir.path().join("real")).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_a_target_outside_the_tree_is_not_followed() {
        let dir = tree_with(&[]);
        let outside = tree_with(&[("secret.txt", "secret")]);
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), dir.path().join("l"))
            .unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("d")).unwrap();
        for file in ["l", "d/secret.txt", "d/new.txt"] {
            assert!(read(dir.path(), file).is_err(), "read {file}");
            assert!(
                write(dir.path(), file, "x", None, true).is_err(),
                "write {file}"
            );
        }
        assert_eq!(read_disk(&outside, "secret.txt"), "secret");
        assert!(!outside.path().join("new.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_nothing_is_an_error_not_a_new_file() {
        let dir = tree_with(&[]);
        std::os::unix::fs::symlink("nowhere", dir.path().join("l")).unwrap();
        assert!(write(dir.path(), "l", "x", None, false).is_err());
        assert!(!dir.path().join("nowhere").exists());
    }

    #[test]
    fn no_path_leaves_the_working_tree() {
        // The tree is one level inside the folder, so `../b.txt` is a real
        // file that every call would reach without its guard.
        let outer = tree_with(&[("tree/a.txt", "x"), ("b.txt", "y")]);
        let root = outer.path().join("tree");
        let elsewhere = tree_with(&[("c.txt", "z")]);
        let absolute = elsewhere
            .path()
            .join("c.txt")
            .to_string_lossy()
            .into_owned();
        for bad in ["../b.txt", "a/../../b.txt", absolute.as_str(), "", "."] {
            assert!(read(&root, bad).is_err(), "read {bad:?}");
            assert!(write(&root, bad, "q", None, true).is_err(), "write {bad:?}");
            assert!(rename(&root, "a.txt", bad).is_err(), "rename to {bad:?}");
            assert!(
                rename(&root, bad, "moved.txt").is_err(),
                "rename from {bad:?}"
            );
            assert!(delete(&root, bad).is_err(), "delete {bad:?}");
        }
        assert_eq!(read_disk(&outer, "b.txt"), "y");
        assert_eq!(read_disk(&elsewhere, "c.txt"), "z");
        assert_eq!(read_disk(&outer, "tree/a.txt"), "x");
        assert!(!root.join("moved.txt").exists());
        assert!(!outer.path().join("moved.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rename_and_delete_do_not_pass_through_a_link_out() {
        let dir = tree_with(&[("a.txt", "x")]);
        let outside = tree_with(&[("b.txt", "y")]);
        std::os::unix::fs::symlink(outside.path(), dir.path().join("d")).unwrap();
        assert!(rename(dir.path(), "a.txt", "d/a.txt").is_err());
        assert!(rename(dir.path(), "d/b.txt", "b.txt").is_err());
        assert!(delete(dir.path(), "d/b.txt").is_err());
        assert_eq!(read_disk(&outside, "b.txt"), "y");
        assert!(!outside.path().join("a.txt").exists());
        assert!(dir.path().join("a.txt").exists());
    }

    #[test]
    fn rename_moves_a_file_and_a_folder_and_makes_the_folders() {
        let dir = tree_with(&[("a.txt", "x"), ("src/m/n.txt", "n")]);
        rename(dir.path(), "a.txt", "deep/er/b.txt").unwrap();
        assert!(!dir.path().join("a.txt").exists());
        assert_eq!(read_disk(&dir, "deep/er/b.txt"), "x");
        rename(dir.path(), "src", "lib").unwrap();
        assert_eq!(read_disk(&dir, "lib/m/n.txt"), "n");
    }

    #[test]
    fn rename_fails_for_a_missing_source_or_an_occupied_target() {
        let dir = tree_with(&[("a.txt", "a"), ("b.txt", "b")]);
        assert_eq!(
            rename(dir.path(), "gone", "c").unwrap_err(),
            "gone does not exist"
        );
        assert_eq!(
            rename(dir.path(), "a.txt", "b.txt").unwrap_err(),
            "b.txt already exists"
        );
        assert_eq!(read_disk(&dir, "a.txt"), "a");
        assert_eq!(read_disk(&dir, "b.txt"), "b");
    }

    #[test]
    fn delete_removes_a_file_and_a_folder_with_everything_in_it() {
        let dir = tree_with(&[("a.txt", "x"), ("d/e/f.txt", "f"), ("keep", "k")]);
        delete(dir.path(), "a.txt").unwrap();
        delete(dir.path(), "d").unwrap();
        assert!(!dir.path().join("a.txt").exists());
        assert!(!dir.path().join("d").exists());
        assert!(dir.path().join("keep").exists());
        assert_eq!(delete(dir.path(), "d").unwrap_err(), "d does not exist");
    }

    #[test]
    fn delete_refuses_the_working_tree_itself() {
        let dir = tree_with(&[("a.txt", "x")]);
        for bad in [".", "", "./", "d/.."] {
            assert!(delete(dir.path(), bad).is_err(), "{bad:?}");
        }
        assert!(dir.path().join("a.txt").exists());
    }

    #[test]
    fn delete_refuses_git_and_what_is_in_it() {
        let dir = tree_with(&[
            (".git/HEAD", "ref"),
            (".git/objects/x", "o"),
            ("sub/.git", "g"),
        ]);
        for bad in [".git", ".git/HEAD", ".git/objects", "sub/.git"] {
            assert!(
                delete(dir.path(), bad).unwrap_err().contains(".git"),
                "{bad}"
            );
        }
        assert!(dir.path().join(".git/HEAD").exists());
        assert!(dir.path().join(".git/objects/x").exists());
        assert!(dir.path().join("sub/.git").exists());
    }

    #[cfg(unix)]
    #[test]
    fn delete_refuses_git_reached_through_a_link() {
        let dir = tree_with(&[(".git/HEAD", "ref")]);
        std::os::unix::fs::symlink(".git", dir.path().join("g")).unwrap();
        assert!(delete(dir.path(), "g/HEAD").is_err());
        assert!(dir.path().join(".git/HEAD").exists());
    }

    #[cfg(unix)]
    #[test]
    fn deleting_a_link_leaves_its_target() {
        let dir = tree_with(&[("real/a.txt", "x")]);
        std::os::unix::fs::symlink("real", dir.path().join("l")).unwrap();
        delete(dir.path(), "l").unwrap();
        assert!(std::fs::symlink_metadata(dir.path().join("l")).is_err());
        assert_eq!(read_disk(&dir, "real/a.txt"), "x");
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_file_is_not_written_with_or_without_overwrite() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tree_with(&[("ro.txt", "mine")]);
        let path = dir.path().join("ro.txt");
        let stamp = read(dir.path(), "ro.txt").unwrap().stamp;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
        for overwrite in [false, true] {
            assert_eq!(
                write(dir.path(), "ro.txt", "new", Some(&stamp), overwrite).unwrap_err(),
                "ro.txt is read-only"
            );
        }
        assert_eq!(read_disk(&dir, "ro.txt"), "mine");
        assert!(leftovers(dir.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn creating_over_a_read_only_file_is_an_answer_not_an_error() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tree_with(&[("ro.txt", "mine")]);
        let path = dir.path().join("ro.txt");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
        let done = write(dir.path(), "ro.txt", "", None, false).unwrap();
        assert!(!done.written);
        assert_eq!(
            done.stamp.unwrap(),
            read(dir.path(), "ro.txt").unwrap().stamp
        );
        assert_eq!(read_disk(&dir, "ro.txt"), "mine");
    }

    #[test]
    fn a_leading_current_folder_is_not_an_odd_name() {
        let dir = tree_with(&[("a.txt", "a")]);
        assert_eq!(read(dir.path(), "./a.txt").unwrap().text, "a");
    }

    #[cfg(unix)]
    #[test]
    fn a_write_keeps_a_private_file_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tree_with(&[(".env", "secret")]);
        let path = dir.path().join(".env");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let stamp = read(dir.path(), ".env").unwrap().stamp;
        write(dir.path(), ".env", "other", Some(&stamp), false).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn something_that_is_not_a_file_is_an_error_not_a_hang() {
        let dir = tree_with(&[]);
        let fifo = std::ffi::CString::new(dir.path().join("pipe").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        for overwrite in [false, true] {
            for stamp in [None, Some("x")] {
                let error = write(dir.path(), "pipe", "t", stamp, overwrite).unwrap_err();
                assert_eq!(error, "pipe is not a file");
            }
        }
    }

    #[test]
    fn nothing_in_git_is_written_or_moved_from_the_editor() {
        let dir = tree_with(&[(".git/HEAD", "ref"), (".git/config", "c"), ("evil", "e")]);
        assert!(write(dir.path(), ".git/config", "x", None, true)
            .unwrap_err()
            .contains(".git"));
        assert!(write(dir.path(), ".git/hooks/pre-commit", "x", None, false)
            .unwrap_err()
            .contains(".git"));
        assert!(write(dir.path(), ".GIT/config", "x", None, true)
            .unwrap_err()
            .contains(".git"));
        assert!(rename(dir.path(), "evil", ".git/hooks/pre-commit")
            .unwrap_err()
            .contains(".git"));
        assert!(rename(dir.path(), ".git/HEAD", "head")
            .unwrap_err()
            .contains(".git"));
        assert!(rename(dir.path(), ".git", "moved")
            .unwrap_err()
            .contains(".git"));
        assert_eq!(read_disk(&dir, ".git/config"), "c");
        assert_eq!(read_disk(&dir, ".git/HEAD"), "ref");
        assert_eq!(read_disk(&dir, "evil"), "e");
        assert!(!dir.path().join(".git/hooks").exists());
        assert!(!dir.path().join("moved").exists());
    }

    #[cfg(unix)]
    #[test]
    fn git_reached_through_a_link_is_refused_too() {
        let dir = tree_with(&[(".git/config", "c"), ("evil", "e")]);
        std::os::unix::fs::symlink(".git", dir.path().join("g")).unwrap();
        assert!(write(dir.path(), "g/config", "x", None, true).is_err());
        assert!(rename(dir.path(), "evil", "g/hook").is_err());
        assert!(rename(dir.path(), "g", "moved").is_err());
        assert_eq!(read_disk(&dir, ".git/config"), "c");
    }

    #[test]
    fn a_rename_that_only_changes_case_works() {
        let dir = tree_with(&[("readme.md", "r")]);
        rename(dir.path(), "readme.md", "README.md").unwrap();
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["README.md"]);
        assert_eq!(read_disk(&dir, "README.md"), "r");
    }

    #[cfg(unix)]
    #[test]
    fn a_rename_onto_another_hard_link_of_the_file_is_refused() {
        let dir = tree_with(&[("a", "x")]);
        std::fs::hard_link(dir.path().join("a"), dir.path().join("b")).unwrap();
        assert_eq!(
            rename(dir.path(), "a", "b").unwrap_err(),
            "b already exists"
        );
        assert!(dir.path().join("a").exists());
    }

    #[test]
    fn delete_refuses_a_folder_that_holds_a_repository_or_a_worktree() {
        let dir = tree_with(&[
            ("worktrees/one/.git", "gitdir: elsewhere"),
            ("worktrees/one/work.txt", "uncommitted"),
            ("nested/deep/repo/.git/HEAD", "ref"),
            ("plain/a/b.txt", "b"),
        ]);
        for bad in ["worktrees", "worktrees/one", "nested"] {
            let error = delete(dir.path(), bad).unwrap_err();
            assert!(
                error.contains("another repository or a worktree"),
                "{bad}: {error}"
            );
        }
        assert_eq!(read_disk(&dir, "worktrees/one/work.txt"), "uncommitted");
        assert!(dir.path().join("nested/deep/repo/.git/HEAD").exists());
        delete(dir.path(), "plain").unwrap();
        assert!(!dir.path().join("plain").exists());
    }

    #[test]
    fn rename_refuses_a_folder_that_holds_a_repository_or_a_worktree() {
        let dir = tree_with(&[
            ("worktrees/one/.git", "gitdir: elsewhere"),
            ("nested/deep/repo/.git/HEAD", "ref"),
            ("plain/a/b.txt", "b"),
        ]);
        for bad in ["worktrees", "worktrees/one", "nested"] {
            let error = rename(dir.path(), bad, "moved").unwrap_err();
            assert!(
                error.contains("another repository or a worktree"),
                "{bad}: {error}"
            );
        }
        assert!(dir.path().join("worktrees/one/.git").exists());
        assert!(dir.path().join("nested/deep/repo/.git/HEAD").exists());
        assert!(!dir.path().join("moved").exists());
        rename(dir.path(), "plain", "moved").unwrap();
        assert_eq!(read_disk(&dir, "moved/a/b.txt"), "b");
    }

    #[cfg(unix)]
    #[test]
    fn the_look_for_a_repository_follows_no_link() {
        let dir = tree_with(&[("plain/a.txt", "a")]);
        let other = tree_with(&[("repo/.git/HEAD", "ref")]);
        std::os::unix::fs::symlink(other.path(), dir.path().join("plain/out")).unwrap();
        delete(dir.path(), "plain").unwrap();
        assert!(other.path().join("repo/.git/HEAD").exists());
    }

    #[cfg(windows)]
    #[test]
    fn names_windows_rewrites_do_not_reach_git_or_the_tree() {
        let dir = tree_with(&[(".git/HEAD", "ref"), ("keep.txt", "k")]);
        for bad in [
            ".git.",
            ".git ",
            ".git::$INDEX_ALLOCATION",
            " ",
            "...",
            ".git./HEAD",
        ] {
            assert!(delete(dir.path(), bad).is_err(), "delete {bad:?}");
            assert!(
                write(dir.path(), bad, "x", None, true).is_err(),
                "write {bad:?}"
            );
            assert!(
                rename(dir.path(), bad, "moved").is_err(),
                "rename from {bad:?}"
            );
            assert!(
                rename(dir.path(), "keep.txt", bad).is_err(),
                "rename to {bad:?}"
            );
        }
        assert_eq!(read_disk(&dir, ".git/HEAD"), "ref");
        assert_eq!(read_disk(&dir, "keep.txt"), "k");
        assert!(!dir.path().join("moved").exists());
    }

    #[cfg(windows)]
    #[test]
    fn the_long_and_the_short_spelling_of_a_path_compare_equal() {
        assert_eq!(
            comparable(Path::new(r"\\?\C:\a\b")),
            PathBuf::from(r"C:\a\b")
        );
        assert_eq!(
            comparable(Path::new(r"\\?\UNC\host\share\a")),
            PathBuf::from(r"\\host\share\a")
        );
        assert_eq!(comparable(Path::new(r"C:\a")), PathBuf::from(r"C:\a"));
    }
}
