//! Where a process is working right now.
//!
//! Claude Code can move into a git worktree mid-session, and the changes pane
//! should follow it there. The process's own working directory is the one
//! signal that does not depend on the transcript format: Linux publishes it
//! in procfs, macOS through `proc_pidinfo`.

use std::path::PathBuf;

#[cfg(target_os = "linux")]
pub fn of_process(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(target_os = "macos")]
pub fn of_process(pid: u32) -> Option<PathBuf> {
    use std::ffi::CStr;

    // MAXPATHLEN bytes, NUL-terminated by the kernel. libc spells the array
    // as 32 rows of 32 to suit an old compiler; it is one contiguous buffer.
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let got = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            &mut info as *mut libc::proc_vnodepathinfo as *mut libc::c_void,
            size,
        )
    };
    if got <= 0 {
        return None;
    }
    let bytes = unsafe {
        std::slice::from_raw_parts(info.pvi_cdir.vip_path.as_ptr() as *const u8, 32 * 32)
    };
    let path = CStr::from_bytes_until_nul(bytes).ok()?.to_str().ok()?;
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn of_process(_pid: u32) -> Option<PathBuf> {
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    fn reports_where_a_process_has_moved_to() {
        let dir = std::env::temp_dir().canonicalize().unwrap();
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(format!("cd '{}' && sleep 5", dir.display()))
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        // The shell needs a moment to run the cd.
        let mut seen = None;
        for _ in 0..50 {
            seen = of_process(child.id());
            if seen.as_deref() == Some(dir.as_path()) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        child.kill().ok();
        child.wait().ok();
        assert_eq!(seen, Some(dir));
    }

    #[test]
    fn a_process_that_is_gone_has_no_directory() {
        assert_eq!(of_process(u32::MAX - 1), None);
    }
}
