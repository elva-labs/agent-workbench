//! The points conversations are held at after going back.
//!
//! Claude Code goes back by starting again from an earlier entry of its
//! transcript, and writes nothing of it until the next message: the
//! transcript stays as it was, and a plain resume, or a reading of it, goes
//! on from its newest entry, with the turns that were gone back on. So once
//! a conversation went back, the entry it went on from is held here, with
//! the newest entry the transcript had then, and every start and every
//! reading of the conversation goes on from the entry held. A message sent
//! from there hangs off the entry held, which makes the transcript hold the
//! cut itself, and anything else that moves the transcript on, such as a
//! terminal that resumed the conversation and went on with the turns gone
//! back on, makes what is held stale. Either way the transcript's newest
//! entry is no longer the one held with it, and the point is let go.
//!
//! What is held is kept in a file of its own in the workbench's directory,
//! for the most recent conversations, so that it holds when the app starts
//! again.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

/// The file what is held is kept in, in the workbench's directory.
const FILE: &str = "rewound.json";

/// The most conversations held at once: the most recent.
const KEEP: usize = 512;

/// A conversation held at an entry: `at` is the entry it goes on from, and
/// `leaf` the newest entry its transcript had when it went back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Cut {
    session: String,
    at: String,
    leaf: String,
}

#[derive(Default, Serialize, Deserialize)]
struct Kept {
    #[serde(default)]
    cuts: Vec<Cut>,
}

/// The conversations held at a point, by their ids.
pub struct Held {
    file: Option<PathBuf>,
    /// Read from the file the first time it is wanted, the most recent
    /// last.
    cuts: Mutex<Option<Vec<Cut>>>,
}

impl Held {
    /// What is kept in the workbench's directory in `home`, or nowhere
    /// without a home.
    pub fn new(home: Option<&Path>) -> Self {
        Self {
            file: home.map(|home| crate::home::dir(home).join(FILE)),
            cuts: Mutex::new(None),
        }
    }

    fn cuts(&self) -> MutexGuard<'_, Option<Vec<Cut>>> {
        let mut cuts = self
            .cuts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if cuts.is_none() {
            let read = self
                .file
                .as_ref()
                .and_then(|file| std::fs::read(file).ok())
                .and_then(|bytes| serde_json::from_slice::<Kept>(&bytes).ok())
                .unwrap_or_default();
            *cuts = Some(read.cuts);
        }
        cuts
    }

    /// Holds a conversation at the entry `at`, its transcript's newest entry
    /// being `leaf`.
    pub fn hold(&self, session: &str, at: &str, leaf: &str) {
        let mut guard = self.cuts();
        let cuts = guard.get_or_insert_with(Vec::new);
        cuts.retain(|cut| cut.session != session);
        cuts.push(Cut {
            session: session.to_string(),
            at: at.to_string(),
            leaf: leaf.to_string(),
        });
        let over = cuts.len().saturating_sub(KEEP);
        cuts.drain(..over);
        self.save(cuts);
    }

    /// Lets a conversation go on from its newest entry again.
    pub fn release(&self, session: &str) {
        let mut guard = self.cuts();
        let cuts = guard.get_or_insert_with(Vec::new);
        let before = cuts.len();
        cuts.retain(|cut| cut.session != session);
        if cuts.len() != before {
            self.save(cuts);
        }
    }

    /// The entry a conversation goes on from, while its transcript's newest
    /// entry is the one it had when it went back, or cannot be read now,
    /// `leaf` being None. Another newest entry lets it go, and answers None.
    pub fn at(&self, session: &str, leaf: Option<&str>) -> Option<String> {
        let at = {
            let guard = self.cuts();
            let cut = guard.as_ref()?.iter().find(|cut| cut.session == session)?;
            leaf.is_none_or(|leaf| leaf == cut.leaf)
                .then(|| cut.at.clone())
        };
        if at.is_none() {
            self.release(session);
        }
        at
    }

    /// Writes what is held to the file, whole, through a file beside it, so
    /// a reader finds the old or the new. A file that cannot be written is
    /// left as it was.
    fn save(&self, cuts: &[Cut]) {
        let Some(file) = &self.file else {
            return;
        };
        let Some(folder) = file.parent() else {
            return;
        };
        let Ok(text) = serde_json::to_vec(&Kept {
            cuts: cuts.to_vec(),
        }) else {
            return;
        };
        let temporary = folder.join(format!(".{FILE}.{}", std::process::id()));
        let written = std::fs::create_dir_all(folder)
            .and_then(|()| std::fs::write(&temporary, text))
            .and_then(|()| std::fs::rename(&temporary, file));
        if written.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratch::Scratch;

    #[test]
    fn a_point_holds_while_the_transcript_has_not_moved_on_and_across_a_start() {
        let home = Scratch::new("rewind-held");
        let held = Held::new(Some(&home));
        assert_eq!(held.at("s-1", Some("leaf-1")), None);
        held.hold("s-1", "entry-4", "leaf-1");
        held.hold("s-2", "entry-9", "leaf-2");
        assert_eq!(held.at("s-1", Some("leaf-1")).as_deref(), Some("entry-4"));
        // Kept for a core that starts again.
        let again = Held::new(Some(&home));
        assert_eq!(again.at("s-1", Some("leaf-1")).as_deref(), Some("entry-4"));
        // A transcript that cannot be read now holds it still.
        assert_eq!(again.at("s-1", None).as_deref(), Some("entry-4"));
        // A transcript that moved on lets it go, for good.
        assert_eq!(again.at("s-1", Some("leaf-7")), None);
        assert_eq!(again.at("s-1", Some("leaf-1")), None);
        assert_eq!(Held::new(Some(&home)).at("s-1", Some("leaf-1")), None);
        // The other conversation is held still, until it is let go.
        assert_eq!(again.at("s-2", Some("leaf-2")).as_deref(), Some("entry-9"));
        again.release("s-2");
        assert_eq!(again.at("s-2", Some("leaf-2")), None);
    }

    #[test]
    fn only_the_most_recent_are_kept_and_a_file_not_understood_holds_none() {
        let home = Scratch::new("rewind-held-keep");
        let held = Held::new(Some(&home));
        for n in 0..=KEEP {
            held.hold(&format!("s-{n}"), "at", "leaf");
        }
        let again = Held::new(Some(&home));
        assert_eq!(again.at("s-0", Some("leaf")), None);
        assert_eq!(
            again.at(&format!("s-{KEEP}"), Some("leaf")).as_deref(),
            Some("at")
        );
        std::fs::write(home.join(".chord").join(FILE), "not json").unwrap();
        assert_eq!(Held::new(Some(&home)).at("s-1", Some("leaf")), None);
        assert_eq!(Held::new(None).at("s-1", Some("leaf")), None);
    }
}
