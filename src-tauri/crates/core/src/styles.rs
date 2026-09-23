//! The user's own stylesheet, laid over the app's when the settings say so.
//!
//! One file, `user.css`, beside the settings. The window writes it into the
//! page last, so it can restyle anything. What it may not do is reach past
//! the page: a sheet that would load anything, from anywhere, is refused,
//! and one on disk that would is not handed to the window at all, with the
//! reason instead. So the file can change how the window looks and cannot
//! make it fetch.
//!
//! What loads is found by reading the text: an `@import`, a `url()` that is
//! not a `data:` url, and the image functions that take a bare address.
//! CSS lets a name be spelt with escapes, which would hide any of those
//! from the reading, so a sheet with a backslash in it is refused too; a
//! character an escape would write can be written as itself.

use std::path::{Path, PathBuf};

use serde::Serialize;

pub const USER_STYLES_CHANGED: &str = "user_styles_changed";

/// The most a sheet may weigh: far past a sheet of taste, short of what
/// would slow the page.
pub const MOST_BYTES: usize = 256 * 1024;

pub fn styles_path(home: &Path) -> PathBuf {
    home.join(".agent-workbench").join("user.css")
}

/// The sheet as the window is handed it: the text, or none and the reason.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Styles {
    pub css: String,
    /// Why the sheet on disk is not handed over, when it is not.
    pub problem: Option<String>,
}

/// The text with its comments taken out, so what is read is what the
/// browser would read.
fn uncommented(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        out.push(' ');
        match rest[start + 2..].find("*/") {
            Some(end) => rest = &rest[start + 2 + end + 2..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// Why a sheet may not be used, or None when it may.
pub fn problem(css: &str) -> Option<String> {
    if css.len() > MOST_BYTES {
        return Some(format!(
            "the stylesheet is {} KB; it may be {} KB at most",
            css.len() / 1024,
            MOST_BYTES / 1024
        ));
    }
    if css.contains('\\') {
        return Some(
            "the stylesheet has a backslash in it. Escapes are not taken, since they can spell a url where none can be seen; write the character itself".into(),
        );
    }
    let text = uncommented(css).to_ascii_lowercase();
    if text.contains("@import") {
        return Some("the stylesheet imports another. It may load nothing from anywhere".into());
    }
    for function in ["image-set(", "src(", "image("] {
        if calls(&text, function).next().is_some() {
            return Some(format!(
                "the stylesheet uses {}), which loads an address. It may load nothing from anywhere",
                &function[..function.len() - 1]
            ));
        }
    }
    for at in calls(&text, "url(") {
        let after = text[at + 4..].trim_start().trim_start_matches(['"', '\'']);
        if !after.starts_with("data:") && !after.starts_with('#') {
            return Some(
                "the stylesheet has a url() that is not a data: url. It may load nothing from anywhere".into(),
            );
        }
    }
    None
}

/// Where a function of this name is called: the name standing on its own,
/// or behind a vendor's prefix, and not the tail of a longer name.
fn calls<'a>(text: &'a str, function: &'a str) -> impl Iterator<Item = usize> + 'a {
    text.match_indices(function).filter_map(move |(at, _)| {
        let head = &text[..at];
        let own = !head
            .chars()
            .last()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        let prefixed = ["-webkit-", "-moz-", "-o-", "-ms-"]
            .iter()
            .any(|prefix| head.ends_with(prefix));
        (own || prefixed).then_some(at)
    })
}

/// The sheet on disk, handed over whole or not at all.
pub fn read(home: &Path) -> Styles {
    let Ok(css) = std::fs::read_to_string(styles_path(home)) else {
        return Styles::default();
    };
    match problem(&css) {
        None => Styles { css, problem: None },
        Some(problem) => Styles {
            css: String::new(),
            problem: Some(problem),
        },
    }
}

/// Writes a sheet, whole and moved into place, once it passes. An empty
/// sheet takes the file away.
pub fn write(home: &Path, css: &str) -> Result<Styles, String> {
    if let Some(problem) = problem(css) {
        return Err(problem);
    }
    let path = styles_path(home);
    if css.trim().is_empty() {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("could not remove {}: {error}", path.display())),
        }
        return Ok(Styles::default());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let temporary = path.with_extension("css.tmp");
    std::fs::write(&temporary, css)
        .map_err(|e| format!("could not write {}: {e}", temporary.display()))?;
    std::fs::rename(&temporary, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        format!("could not write {}: {e}", path.display())
    })?;
    Ok(Styles {
        css: css.to_string(),
        problem: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("workbench-styles-{name}"));
        std::fs::remove_dir_all(&home).ok();
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    #[test]
    fn a_sheet_that_restyles_and_loads_nothing_passes() {
        for css in [
            "header { letter-spacing: 0.2em; }",
            "section[data-pane=\"agent\"] { --pane-pad: 20px; }",
            "body { background: url(data:image/png;base64,AAAA); }",
            "body { background-image: url( 'data:image/svg+xml;utf8,<svg/>' ); }",
            "svg { filter: url(#blur); }",
            ".curl-thing { color: red; } /* url(https://x) is only a comment */",
            ".x { --my-image-set: 1; background: curl(1); }",
            "p::after { content: \"→\"; }",
        ] {
            assert_eq!(problem(css), None, "{css}");
        }
    }

    #[test]
    fn a_sheet_that_would_load_anything_is_refused() {
        for css in [
            "@import 'https://evil.example/x.css';",
            "@IMPORT url(x.css);",
            "body { background: url(https://evil.example/p.png); }",
            "body { background: URL( \"//evil.example/p.png\" ); }",
            "body { background: url(p.png); }",
            "@font-face { font-family: x; src: url(https://evil.example/f.woff); }",
            "body { background: image-set(\"https://evil.example/p.png\" 1x); }",
            "body { background: -webkit-image-set(\"p.png\" 1x); }",
            "body { --x: url(https://evil.example); }",
            "body { background: ur/**/l(https://evil.example); } body { background: url(http://x) }",
        ] {
            assert!(problem(css).is_some(), "{css}");
        }
    }

    #[test]
    fn escapes_are_refused_since_they_can_spell_a_url() {
        let error = problem("body { background: \\75 rl(https://evil.example); }").unwrap();
        assert!(error.contains("backslash"), "{error}");
        assert!(problem("p::after { content: \"\\2192\"; }").is_some());
    }

    #[test]
    fn a_sheet_too_big_is_refused() {
        let css = "a{}".repeat(MOST_BYTES / 3 + 1);
        assert!(problem(&css).unwrap().contains("KB"));
    }

    #[test]
    fn a_sheet_is_written_read_back_and_taken_away_empty() {
        let home = home("write");
        assert_eq!(read(&home), Styles::default());
        let written = write(&home, "header { color: red; }").unwrap();
        assert_eq!(written.css, "header { color: red; }");
        assert_eq!(read(&home).css, "header { color: red; }");
        assert!(write(&home, "@import 'x';").is_err());
        assert_eq!(
            read(&home).css,
            "header { color: red; }",
            "a refused sheet writes nothing"
        );
        write(&home, "  ").unwrap();
        assert!(!styles_path(&home).exists());
        write(&home, "").unwrap();
    }

    #[test]
    fn a_sheet_on_disk_that_would_load_is_not_handed_over() {
        let home = home("disk");
        std::fs::create_dir_all(styles_path(&home).parent().unwrap()).unwrap();
        std::fs::write(
            styles_path(&home),
            "body { background: url(https://x/y.png); }",
        )
        .unwrap();
        let styles = read(&home);
        assert_eq!(styles.css, "");
        assert!(styles.problem.unwrap().contains("url()"));
    }
}
