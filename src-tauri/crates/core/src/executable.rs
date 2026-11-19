//! Executables put in place so that this process never holds one open for
//! writing.
//!
//! Linux refuses to start a program that any process holds open for writing
//! ("Text file busy"). A process that another thread of this one forks holds
//! a copy of every descriptor this process has open, until it starts its own
//! program, and forks happen at any moment in a process that starts agents,
//! shells and git. A file this process writes can therefore still be open
//! for writing, in a child it cannot see, at the moment it is started. So the
//! file is written by a child process of its own instead: this process holds
//! only a pipe to it, and once the child has exited nothing holds the file
//! open.

use std::io;
use std::path::Path;

/// Writes `contents` to `path` as an executable, replacing what is there.
pub fn write(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
    let (path, contents) = (path.as_ref(), contents.as_ref());
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut writer = Command::new("/bin/sh")
            .args(["-c", "cat > \"$1\"", "sh"])
            .arg(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()?;
        let fed = writer
            .stdin
            .take()
            .map_or(Ok(()), |mut pipe| pipe.write_all(contents));
        let status = writer.wait()?;
        if !status.success() {
            return Err(io::Error::other(format!(
                "could not write {}: the writer ended with {status}",
                path.display()
            )));
        }
        fed?;
        runnable(path)
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, contents)
    }
}

/// Copies the program at `source` to `destination` as an executable,
/// replacing what is there. The source is read here, since only the
/// writing has to happen in another process, and nothing but the shell is
/// needed for it.
pub fn copy(source: &Path, destination: &Path) -> io::Result<()> {
    write(destination, std::fs::read(source)?)
}

/// Lets everyone run the file and its owner alone change it. Setting the
/// mode goes by the path and opens nothing.
#[cfg(unix)]
fn runnable(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::scratch::Scratch;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn writes_a_program_that_runs_and_replaces_one_there() {
        let dir = Scratch::new("executable-write");
        let path = dir.join("say");
        write(&path, b"#!/bin/sh\necho first\n").unwrap();
        write(&path, b"#!/bin/sh\necho second\n").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
        let out = std::process::Command::new(&path).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "second\n");
    }

    #[test]
    fn copies_a_program_that_runs() {
        let dir = Scratch::new("executable-copy");
        let source = dir.join("source");
        std::fs::write(&source, b"#!/bin/sh\necho copied\n").unwrap();
        let path = dir.join("copy");
        copy(&source, &path).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o755
        );
        let out = std::process::Command::new(&path).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "copied\n");
    }

    #[test]
    fn says_why_when_it_cannot_write() {
        let dir = Scratch::new("executable-fails");
        let error = write(dir.join("missing").join("say"), b"x").unwrap_err();
        assert!(error.to_string().contains("could not write"), "{error}");
        assert!(copy(&dir.join("absent"), &dir.join("copy")).is_err());
    }
}
