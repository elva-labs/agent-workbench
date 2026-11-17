//! The files an HTML page the agent presented may load from its own
//! folder: images, stylesheets, fonts, audio and video it names by a
//! relative path, in that folder or a folder under it.
//!
//! The page is the agent's, and what it says may have come from anywhere,
//! so the rule is narrow. A file is served only when every one of these
//! holds, checked where the files are, after `..` and symlinks resolve:
//!
//! - the path is relative, in plain `/`-separated names, with no `..`, no
//!   empty or `.` name, no `\`, no `:` and no NUL, so it names no drive,
//!   no other scheme and no stream of a file;
//! - no name in it, nor in where it resolves to, starts with a dot: a
//!   hidden file or folder is where a secret is kept (`.env`, `.git`,
//!   `.ssh`), and no page needs one to draw;
//! - it resolves to a regular file under the page's folder;
//! - that file is of a kind a page loads, by its extension: one with none,
//!   a key or a config file, is never served;
//! - the page's folder is not the root of a disk, nor the home directory or
//!   a folder above it, which would put the whole of a user's files in
//!   reach of a page left there;
//! - a whole read is at most [`PAGE_FILE_CAP`]; a ranged one, which is how
//!   audio and video are read, at most [`PAGE_FILE_CHUNK`] at a time.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The most a file is read at once in whole: the cap a presented file has.
pub const PAGE_FILE_CAP: u64 = crate::show::MEDIA_CAP;

/// The most one ranged read returns, whatever range was asked for.
pub const PAGE_FILE_CHUNK: u64 = 1024 * 1024;

/// The type a file is served to a page as, by extension, for the kinds a
/// page may load from its folder; None for any other.
pub fn page_file_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "css" => "text/css",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        _ => return None,
    })
}

/// Whether a type is read a range at a time, and so may be larger than
/// [`PAGE_FILE_CAP`].
fn streamed(mime: &str) -> bool {
    mime.starts_with("video/") || mime.starts_with("audio/")
}

/// A file the page may load: what it is and how big.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageFileInfo {
    pub mime: String,
    pub size: u64,
}

/// Part or all of a file the page loads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageFile {
    pub mime: String,
    pub bytes: Vec<u8>,
    /// The whole file's size, which a ranged answer names.
    pub total: u64,
    /// Where `bytes` starts in the file.
    pub start: u64,
}

/// [`PageFile`] as the wire carries it, the bytes encoded.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageFileWire {
    pub mime: String,
    pub data: String,
    pub total: u64,
    pub start: u64,
}

impl TryFrom<PageFileWire> for PageFile {
    type Error = String;

    fn try_from(wire: PageFileWire) -> Result<Self, String> {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(wire.data)
            .map_err(|e| format!("came back unreadable: {e}"))?;
        Ok(PageFile {
            mime: wire.mime,
            bytes,
            total: wire.total,
            start: wire.start,
        })
    }
}

impl From<PageFile> for PageFileWire {
    fn from(file: PageFile) -> Self {
        use base64::Engine;
        PageFileWire {
            mime: file.mime,
            data: base64::engine::general_purpose::STANDARD.encode(file.bytes),
            total: file.total,
            start: file.start,
        }
    }
}

fn hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// The names of a path the page gave, or why it is refused. The path comes
/// decoded, as the page meant it.
fn names(file: &str) -> Result<Vec<&str>, String> {
    if file.is_empty() || file.starts_with('/') {
        return Err("is not a path inside the page's folder".into());
    }
    if file.contains(['\\', ':', '\0']) {
        return Err("is not a plain relative path".into());
    }
    let names: Vec<&str> = file.split('/').collect();
    for name in &names {
        match *name {
            "" | "." | ".." => return Err("is outside the page's folder".into()),
            name if hidden(name) => return Err("is hidden, and hidden files are not loaded".into()),
            _ => {}
        }
    }
    Ok(names)
}

/// The folder a page may load from: the page's own, as it resolves, unless
/// it is a root or holds the home directory.
fn folder(page: &Path, home: Option<&Path>) -> Result<PathBuf, String> {
    let parent = page
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or("has no folder the page is in")?;
    let folder = std::fs::canonicalize(parent).map_err(|e| {
        format!("could not be looked for: the page's folder could not be read ({e})")
    })?;
    let root = folder.parent().is_none();
    let holds_home = home
        .and_then(|home| std::fs::canonicalize(home).ok())
        .is_some_and(|home| home.starts_with(&folder));
    if root || holds_home {
        return Err(
            "is not loaded: the page's folder holds the home directory or is a root, so a page there loads nothing from it"
                .into(),
        );
    }
    Ok(folder)
}

/// Where a file a page names resolves to, when the page may load it.
/// `file` is the path relative to the page's folder, decoded.
pub fn resolve(page: &Path, file: &str, home: Option<&Path>) -> Result<PathBuf, String> {
    let names = names(file)?;
    let folder = folder(page, home)?;
    let joined = names
        .iter()
        .fold(folder.clone(), |path, name| path.join(name));
    let target = std::fs::canonicalize(&joined).map_err(|_| "is not there".to_string())?;
    let inside = target
        .strip_prefix(&folder)
        .map_err(|_| "is outside the page's folder".to_string())?;
    for part in inside.components() {
        match part {
            Component::Normal(name) if name.to_str().is_some_and(|name| !hidden(name)) => {}
            Component::Normal(_) => {
                return Err("is hidden, and hidden files are not loaded".into());
            }
            _ => return Err("is outside the page's folder".into()),
        }
    }
    if page_file_type(&target).is_none() {
        return Err(
            "is not a kind a page loads: images, stylesheets, fonts, audio and video".into(),
        );
    }
    if !target.is_file() {
        return Err("is not a file".into());
    }
    Ok(target)
}

/// What a file the page names is, or why the page may not load it.
pub fn check(page: &Path, file: &str, home: Option<&Path>) -> Result<PageFileInfo, String> {
    let target = resolve(page, file, home)?;
    let mime = page_file_type(&target).unwrap_or("application/octet-stream");
    let size = std::fs::metadata(&target)
        .map_err(|e| format!("could not be read: {e}"))?
        .len();
    if size > PAGE_FILE_CAP && !streamed(mime) {
        return Err(format!(
            "is {} MB, more than the {} MB a page loads",
            size.div_ceil(1024 * 1024),
            PAGE_FILE_CAP / (1024 * 1024)
        ));
    }
    Ok(PageFileInfo {
        mime: mime.to_string(),
        size,
    })
}

/// A file the page names, whole, or from `from` to `to` inclusive when a
/// range is asked for, cut to [`PAGE_FILE_CHUNK`].
pub fn read(
    page: &Path,
    file: &str,
    home: Option<&Path>,
    range: Option<(u64, Option<u64>)>,
) -> Result<PageFile, String> {
    let target = resolve(page, file, home)?;
    let mime = page_file_type(&target)
        .unwrap_or("application/octet-stream")
        .to_string();
    let mut handle = std::fs::File::open(&target).map_err(|e| format!("could not be read: {e}"))?;
    let total = handle
        .metadata()
        .map_err(|e| format!("could not be read: {e}"))?
        .len();
    let Some((from, to)) = range else {
        if total > PAGE_FILE_CAP {
            return Err(format!(
                "is {} MB, more than the {} MB a page loads",
                total.div_ceil(1024 * 1024),
                PAGE_FILE_CAP / (1024 * 1024)
            ));
        }
        let mut bytes = Vec::with_capacity(total as usize);
        handle
            .read_to_end(&mut bytes)
            .map_err(|e| format!("could not be read: {e}"))?;
        return Ok(PageFile {
            mime,
            bytes,
            total,
            start: 0,
        });
    };
    if from >= total {
        return Err(format!("has no byte {from}: it is {total} bytes"));
    }
    let last = to
        .unwrap_or(total - 1)
        .min(total - 1)
        .min(from + PAGE_FILE_CHUNK - 1);
    if last < from {
        return Err(format!("has no bytes from {from} to {last}"));
    }
    handle
        .seek(SeekFrom::Start(from))
        .map_err(|e| format!("could not be read: {e}"))?;
    let mut bytes = vec![0; (last - from + 1) as usize];
    handle
        .read_exact(&mut bytes)
        .map_err(|e| format!("could not be read: {e}"))?;
    Ok(PageFile {
        mime,
        bytes,
        total,
        start: from,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratch::Scratch;

    /// A page in `site/` with a picture beside it, one in a folder under
    /// it, and a secret above it.
    fn site() -> (Scratch, PathBuf) {
        let dir = Scratch::new("page-files");
        let site = dir.join("site");
        std::fs::create_dir_all(site.join("shots")).unwrap();
        std::fs::write(site.join("page.html"), "<img src=a.png>").unwrap();
        std::fs::write(site.join("a.png"), [137, 80, 78, 71]).unwrap();
        std::fs::write(site.join("shots/b c.jpg"), [255, 216, 255]).unwrap();
        std::fs::write(dir.join("secret.png"), [1, 2, 3]).unwrap();
        let page = site.join("page.html");
        (dir, page)
    }

    #[test]
    fn serves_a_file_beside_the_page_and_in_a_folder_under_it() {
        let (_dir, page) = site();
        let a = read(&page, "a.png", None, None).unwrap();
        assert_eq!(a.mime, "image/png");
        assert_eq!(a.bytes, [137, 80, 78, 71]);
        assert_eq!((a.total, a.start), (4, 0));
        let b = check(&page, "shots/b c.jpg", None).unwrap();
        assert_eq!(
            b,
            PageFileInfo {
                mime: "image/jpeg".into(),
                size: 3
            }
        );
    }

    #[test]
    fn refuses_a_path_that_climbs_out_or_names_another_place() {
        let (dir, page) = site();
        for file in [
            "../secret.png",
            "shots/../../secret.png",
            "..",
            "./a.png",
            "shots//b c.jpg",
        ] {
            let why = check(&page, file, None).unwrap_err();
            assert!(why.contains("outside"), "{file}: {why}");
        }
        let absolute = dir.join("secret.png").to_string_lossy().to_string();
        assert!(check(&page, &absolute, None).is_err(), "{absolute}");
        assert!(check(&page, "/etc/hosts", None)
            .unwrap_err()
            .contains("not a path inside"));
        for file in [
            "file:///etc/hosts",
            "https://example.com/a.png",
            "C:/Windows/win.ini",
            "..\\secret.png",
            "a.png:stream",
            "a.png\0",
        ] {
            let why = check(&page, file, None).unwrap_err();
            assert!(why.contains("not a plain relative path"), "{file}: {why}");
        }
        assert!(check(&page, "", None).is_err());
        assert!(check(&page, "~/secret.png", None)
            .unwrap_err()
            .contains("not there"));
    }

    #[test]
    fn refuses_hidden_files_and_folders() {
        let (_dir, page) = site();
        let site = page.parent().unwrap();
        std::fs::create_dir_all(site.join(".git")).unwrap();
        std::fs::write(site.join(".git/logo.png"), [1]).unwrap();
        std::fs::write(site.join(".env.png"), [1]).unwrap();
        for file in [".git/logo.png", ".env.png", "shots/.hidden.png"] {
            let why = check(&page, file, None).unwrap_err();
            assert!(why.contains("hidden"), "{file}: {why}");
        }
    }

    #[test]
    fn refuses_what_is_not_a_kind_a_page_loads_or_is_not_there() {
        let (_dir, page) = site();
        let site = page.parent().unwrap();
        std::fs::write(site.join("id_rsa"), "key").unwrap();
        std::fs::write(site.join("notes.txt"), "text").unwrap();
        std::fs::create_dir_all(site.join("dir.png")).unwrap();
        assert!(check(&page, "id_rsa", None)
            .unwrap_err()
            .contains("not a kind"));
        assert!(check(&page, "notes.txt", None)
            .unwrap_err()
            .contains("not a kind"));
        assert!(check(&page, "page.html", None)
            .unwrap_err()
            .contains("not a kind"));
        assert!(check(&page, "dir.png", None)
            .unwrap_err()
            .contains("not a file"));
        assert!(check(&page, "gone.png", None)
            .unwrap_err()
            .contains("not there"));
        assert_eq!(page_file_type(Path::new("x.WOFF2")), Some("font/woff2"));
        assert_eq!(page_file_type(Path::new("x.css")), Some("text/css"));
        assert_eq!(page_file_type(Path::new("x.mp4")), Some("video/mp4"));
        assert_eq!(page_file_type(Path::new("x.js")), None);
        assert_eq!(page_file_type(Path::new("x.json")), None);
    }

    #[cfg(unix)]
    #[test]
    fn follows_a_symlink_only_while_it_stays_in_the_folder() {
        let (dir, page) = site();
        let site = page.parent().unwrap();
        std::os::unix::fs::symlink(dir.join("secret.png"), site.join("out.png")).unwrap();
        std::os::unix::fs::symlink(dir.path(), site.join("up")).unwrap();
        std::os::unix::fs::symlink(site.join("a.png"), site.join("same.png")).unwrap();
        std::fs::create_dir_all(site.join(".cache")).unwrap();
        std::fs::write(site.join(".cache/k.png"), [9]).unwrap();
        std::os::unix::fs::symlink(site.join(".cache/k.png"), site.join("k.png")).unwrap();
        std::os::unix::fs::symlink(site.join("missing.png"), site.join("dangling.png")).unwrap();
        assert!(check(&page, "out.png", None)
            .unwrap_err()
            .contains("outside"));
        assert!(check(&page, "up/secret.png", None)
            .unwrap_err()
            .contains("outside"));
        assert!(check(&page, "k.png", None).unwrap_err().contains("hidden"));
        assert!(check(&page, "dangling.png", None)
            .unwrap_err()
            .contains("not there"));
        assert_eq!(
            read(&page, "same.png", None, None).unwrap().bytes,
            [137, 80, 78, 71]
        );
    }

    #[test]
    fn loads_nothing_for_a_page_in_the_home_directory_or_above_it() {
        let (dir, page) = site();
        let site = page.parent().unwrap();
        let home = site.join("user");
        std::fs::create_dir_all(&home).unwrap();
        assert!(check(&page, "a.png", Some(&home))
            .unwrap_err()
            .contains("home directory"));
        assert!(check(&page, "a.png", Some(site))
            .unwrap_err()
            .contains("home directory"));
        assert!(check(&page, "a.png", Some(&dir.join("elsewhere"))).is_ok());
        let in_home = home.join("report.html");
        std::fs::write(home.join("shot.png"), [1]).unwrap();
        std::fs::create_dir_all(home.join("out")).unwrap();
        assert!(check(&home.join("out/page.html"), "../shot.png", Some(&home)).is_err());
        assert!(check(&in_home, "shot.png", Some(&home))
            .unwrap_err()
            .contains("home directory"));
    }

    #[test]
    fn reads_a_range_at_a_time_and_caps_a_whole_read() {
        let (_dir, page) = site();
        let site = page.parent().unwrap();
        let film: Vec<u8> = (0..=255)
            .cycle()
            .take(3 * PAGE_FILE_CHUNK as usize)
            .collect();
        std::fs::write(site.join("film.mp4"), &film).unwrap();
        let part = read(&page, "film.mp4", None, Some((10, Some(19)))).unwrap();
        assert_eq!(
            (part.start, part.total, part.bytes.len()),
            (10, film.len() as u64, 10)
        );
        assert_eq!(part.bytes, film[10..20]);
        let open = read(&page, "film.mp4", None, Some((5, None))).unwrap();
        assert_eq!(open.bytes.len() as u64, PAGE_FILE_CHUNK);
        let tail = read(&page, "film.mp4", None, Some((film.len() as u64 - 3, None))).unwrap();
        assert_eq!(tail.bytes, film[film.len() - 3..]);
        assert!(read(&page, "film.mp4", None, Some((film.len() as u64, None))).is_err());

        let big = std::fs::File::create(site.join("big.png")).unwrap();
        big.set_len(PAGE_FILE_CAP + 1).unwrap();
        assert!(check(&page, "big.png", None)
            .unwrap_err()
            .contains("more than the 8 MB"));
        assert!(read(&page, "big.png", None, None)
            .unwrap_err()
            .contains("more than"));
        let reel = std::fs::File::create(site.join("reel.webm")).unwrap();
        reel.set_len(PAGE_FILE_CAP + 1).unwrap();
        assert!(check(&page, "reel.webm", None).is_ok());
    }
}
