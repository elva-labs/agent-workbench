//! What the user is looking at, for the agent to ask.
//!
//! The window writes it to a file under the home directory whenever it
//! changes, and the tool server reads the file when the agent asks: the
//! file open in the viewer, the lines highlighted, or what was presented.
//! The window writes it on the machine the project is on, so an agent on
//! a remote asks its own home too.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    /// The project the viewer is in, absolute.
    pub project: String,
    /// The file open in the viewer, absolute, if one is.
    #[serde(default)]
    pub file: Option<String>,
    /// Whether the viewer shows the file's diff or the file itself.
    #[serde(default)]
    pub view: Option<String>,
    /// The lines highlighted, 1-based, inclusive, if any.
    #[serde(default)]
    pub from: Option<u32>,
    #[serde(default)]
    pub to: Option<u32>,
    /// What was presented, when the viewer shows that rather than a file.
    #[serde(default)]
    pub media: Option<Presented>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presented {
    pub files: Vec<String>,
    #[serde(default)]
    pub caption: Option<String>,
}

pub fn selection_path(home: &Path) -> PathBuf {
    home.join(".agent-workbench").join("selection.json")
}

/// Records the selection, or that there is none.
pub fn write(home: &Path, selection: Option<&Selection>) -> Result<(), String> {
    let path = selection_path(home);
    let Some(selection) = selection else {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("could not clear {}: {e}", path.display())),
        };
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create {parent:?}: {e}"))?;
    }
    let text = serde_json::to_string(selection).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// The selection on record, none when there is none or it cannot be read.
pub fn read(home: &Path) -> Option<Selection> {
    let text = std::fs::read_to_string(selection_path(home)).ok()?;
    serde_json::from_str(&text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_selection_written_is_read_back_and_cleared() {
        let home = std::env::temp_dir().join("workbench-selection");
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(read(&home), None);
        let selection = Selection {
            project: "/p".into(),
            file: Some("/p/src/a.rs".into()),
            view: Some("diff".into()),
            from: Some(3),
            to: Some(5),
            media: None,
        };
        write(&home, Some(&selection)).unwrap();
        assert_eq!(read(&home), Some(selection));
        write(&home, None).unwrap();
        assert_eq!(read(&home), None);
        write(&home, None).unwrap();
    }
}
