//! The notes a session keeps of its own conversation, so it can go on
//! later from them rather than from the whole conversation read again.
//!
//! A session has one brief, what is being built, kept current, and notes,
//! each with a title, a one-line summary, a body and the time it was kept.
//! A later note can replace an earlier one, which then no longer stands.
//! They are kept in a small database in the core's home, under the
//! session's token, written by the tool server the agent starts and read
//! by the window. Nothing of them is in the project.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// The database's file in the core's home.
pub const FILE: &str = "notes.db";

/// The folder in the core's home the readable copy of a session's notes is
/// written to, for the viewer.
pub const PAGES: &str = "notes";

/// The most notes the list names: the newest, then the most read of the
/// rest. The others are counted, and found by their words.
pub const LISTED: usize = 30;
pub const NEWEST: usize = 20;

/// The most notes a search gives whole; the rest it names by title.
pub const FOUND_WHOLE: usize = 5;
pub const FOUND_MOST: usize = 20;

/// How long each part may be, in characters. A note is short; the reason
/// for the limits is that every note is read again in every briefing.
pub const TITLE_MOST: usize = 120;
pub const SUMMARY_MOST: usize = 300;
pub const BODY_MOST: usize = 6000;
pub const BRIEF_MOST: usize = 4000;

/// How long a write waits for another session's write to finish.
const BUSY: Duration = Duration::from_secs(5);

/// One note as it is kept.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Note {
    pub id: i64,
    pub title: String,
    pub summary: String,
    pub body: String,
    /// Seconds since the epoch.
    pub at: i64,
    pub replaces: Option<i64>,
    pub replaced_by: Option<i64>,
    pub reads: i64,
}

/// The brief as it is kept.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Brief {
    pub text: String,
    pub at: i64,
}

/// What the list given at a restart holds: the brief, the notes it names,
/// newest first, and how many standing notes it leaves out.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Listed {
    pub brief: Option<Brief>,
    pub notes: Vec<Note>,
    pub more: usize,
}

/// A note to keep.
#[derive(Debug, Clone, Default)]
pub struct NewNote<'a> {
    pub title: &'a str,
    pub summary: &'a str,
    pub body: &'a str,
    pub replaces: Option<i64>,
}

/// The store, opened for one call.
pub struct Notes {
    conn: Connection,
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

fn failed(error: rusqlite::Error) -> String {
    format!("the notes could not be read or written: {error}")
}

const NOTE_COLUMNS: &str = "id, title, summary, body, at, replaces, replaced_by, reads";

fn note_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        title: row.get(1)?,
        summary: row.get(2)?,
        body: row.get(3)?,
        at: row.get(4)?,
        replaces: row.get(5)?,
        replaced_by: row.get(6)?,
        reads: row.get(7)?,
    })
}

/// Text cut to its first line and trimmed, for a title or a summary.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn too_long(what: &str, text: &str, most: usize) -> Result<(), String> {
    let length = text.chars().count();
    if length > most {
        return Err(format!(
            "The {what} is {length} characters; keep it to {most} at most."
        ));
    }
    Ok(())
}

impl Notes {
    /// Opens the store in the core's home, made the first time.
    pub fn open(home: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(home)
            .map_err(|e| format!("the notes could not be kept in {}: {e}", home.display()))?;
        let conn = Connection::open(home.join(FILE)).map_err(failed)?;
        conn.busy_timeout(BUSY).map_err(failed)?;
        // Several sessions' tool servers write at once, each a moment.
        let _ = conn.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()));
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS briefs (
                owner TEXT PRIMARY KEY,
                text TEXT NOT NULL,
                at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner TEXT NOT NULL,
                title TEXT NOT NULL,
                summary TEXT NOT NULL,
                body TEXT NOT NULL,
                at INTEGER NOT NULL,
                replaces INTEGER,
                replaced_by INTEGER,
                reads INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS notes_by_owner ON notes (owner, id);",
        )
        .map_err(failed)?;
        Ok(Self { conn })
    }

    /// Opens the store only when it is there: reading notes never makes one.
    pub fn existing(home: &Path) -> Result<Option<Self>, String> {
        if !home.join(FILE).is_file() {
            return Ok(None);
        }
        Self::open(home).map(Some)
    }

    /// Keeps the brief, in place of the one before.
    pub fn set_brief(&self, owner: &str, text: &str, at: i64) -> Result<(), String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("The brief is empty.".to_string());
        }
        too_long("brief", text, BRIEF_MOST)?;
        self.conn
            .execute(
                "INSERT INTO briefs (owner, text, at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (owner) DO UPDATE SET text = excluded.text, at = excluded.at",
                params![owner, text, at],
            )
            .map_err(failed)?;
        Ok(())
    }

    pub fn brief(&self, owner: &str) -> Result<Option<Brief>, String> {
        self.conn
            .query_row(
                "SELECT text, at FROM briefs WHERE owner = ?1",
                params![owner],
                |row| {
                    Ok(Brief {
                        text: row.get(0)?,
                        at: row.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(failed)
    }

    /// Keeps a note and answers with its number. A note that replaces
    /// another names one of the owner's that still stands.
    pub fn add(&self, owner: &str, note: &NewNote<'_>, at: i64) -> Result<i64, String> {
        let title = one_line(note.title);
        let summary = one_line(note.summary);
        let body = note.body.trim();
        if title.is_empty() || summary.is_empty() {
            return Err("A note needs a title and a one-line summary.".to_string());
        }
        too_long("title", &title, TITLE_MOST)?;
        too_long("summary", &summary, SUMMARY_MOST)?;
        too_long("body", body, BODY_MOST)?;
        if let Some(old) = note.replaces {
            match self.note(owner, old)? {
                None => return Err(format!("There is no note #{old} of yours to replace.")),
                Some(found) if found.replaced_by.is_some() => {
                    return Err(format!(
                        "Note #{old} was already replaced by #{}; replace that one instead.",
                        found.replaced_by.unwrap_or_default()
                    ))
                }
                Some(_) => {}
            }
        }
        self.conn
            .execute(
                "INSERT INTO notes (owner, title, summary, body, at, replaces)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![owner, title, summary, body, at, note.replaces],
            )
            .map_err(failed)?;
        let id = self.conn.last_insert_rowid();
        if let Some(old) = note.replaces {
            self.conn
                .execute(
                    "UPDATE notes SET replaced_by = ?1 WHERE owner = ?2 AND id = ?3",
                    params![id, owner, old],
                )
                .map_err(failed)?;
        }
        Ok(id)
    }

    /// One of the owner's notes, as it is, without counting it as read.
    pub fn note(&self, owner: &str, id: i64) -> Result<Option<Note>, String> {
        self.conn
            .query_row(
                &format!("SELECT {NOTE_COLUMNS} FROM notes WHERE owner = ?1 AND id = ?2"),
                params![owner, id],
                note_from,
            )
            .optional()
            .map_err(failed)
    }

    /// One of the owner's notes, counted as read.
    pub fn read(&self, owner: &str, id: i64) -> Result<Option<Note>, String> {
        let found = self.note(owner, id)?;
        if found.is_some() {
            self.count_read(owner, &[id])?;
        }
        Ok(found)
    }

    fn count_read(&self, owner: &str, ids: &[i64]) -> Result<(), String> {
        for id in ids {
            self.conn
                .execute(
                    "UPDATE notes SET reads = reads + 1 WHERE owner = ?1 AND id = ?2",
                    params![owner, id],
                )
                .map_err(failed)?;
        }
        Ok(())
    }

    /// Every note of the owner's, newest first, replaced ones included.
    pub fn all(&self, owner: &str) -> Result<Vec<Note>, String> {
        let mut statement = self
            .conn
            .prepare(&format!(
                "SELECT {NOTE_COLUMNS} FROM notes WHERE owner = ?1 ORDER BY id DESC"
            ))
            .map_err(failed)?;
        let rows = statement
            .query_map(params![owner], note_from)
            .map_err(failed)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(failed)
    }

    /// How many notes the owner has standing.
    pub fn standing(&self, owner: &str) -> Result<usize, String> {
        self.conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE owner = ?1 AND replaced_by IS NULL",
                params![owner],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| count as usize)
            .map_err(failed)
    }

    /// The brief and the list a restart is given: the newest standing
    /// notes, then the most read of the rest, newest first, and a count of
    /// the others.
    pub fn listed(&self, owner: &str) -> Result<Listed, String> {
        let standing: Vec<Note> = self
            .all(owner)?
            .into_iter()
            .filter(|note| note.replaced_by.is_none())
            .collect();
        let mut chosen: Vec<Note> = standing.iter().take(NEWEST).cloned().collect();
        let mut rest: Vec<&Note> = standing
            .iter()
            .skip(NEWEST)
            .filter(|note| note.reads > 0)
            .collect();
        rest.sort_by(|a, b| b.reads.cmp(&a.reads).then(b.id.cmp(&a.id)));
        chosen.extend(rest.into_iter().take(LISTED - NEWEST).cloned());
        chosen.sort_by_key(|note| std::cmp::Reverse(note.id));
        let more = standing.len() - chosen.len();
        Ok(Listed {
            brief: self.brief(owner)?,
            notes: chosen,
            more,
        })
    }

    /// The owner's notes whose title, summary or body hold every one of
    /// the words, those that hold them in the title or summary first, then
    /// the newest. Standing notes come before replaced ones.
    pub fn find(&self, owner: &str, words: &str) -> Result<Vec<Note>, String> {
        let words: Vec<String> = words
            .split_whitespace()
            .map(str::to_lowercase)
            .filter(|word| !word.is_empty())
            .collect();
        if words.is_empty() {
            return Ok(Vec::new());
        }
        let mut found: Vec<(usize, Note)> = self
            .all(owner)?
            .into_iter()
            .filter_map(|note| {
                let head = format!("{} {}", note.title, note.summary).to_lowercase();
                let whole = format!("{head} {}", note.body.to_lowercase());
                if !words.iter().all(|word| whole.contains(word.as_str())) {
                    return None;
                }
                let in_head = words
                    .iter()
                    .filter(|word| head.contains(word.as_str()))
                    .count();
                Some((in_head, note))
            })
            .collect();
        found.sort_by(|(a_head, a), (b_head, b)| {
            a.replaced_by
                .is_some()
                .cmp(&b.replaced_by.is_some())
                .then(b_head.cmp(a_head))
                .then(b.id.cmp(&a.id))
        });
        Ok(found
            .into_iter()
            .take(FOUND_MOST)
            .map(|(_, note)| note)
            .collect())
    }

    /// Lets go of everything kept for these owners.
    pub fn forget(&self, owners: &[String]) -> Result<(), String> {
        for owner in owners {
            self.conn
                .execute("DELETE FROM notes WHERE owner = ?1", params![owner])
                .map_err(failed)?;
            self.conn
                .execute("DELETE FROM briefs WHERE owner = ?1", params![owner])
                .map_err(failed)?;
        }
        Ok(())
    }
}

/// A day as the notes say it, from seconds since the epoch, in UTC.
pub fn day(at: i64) -> String {
    let days = at.div_euclid(86_400);
    // Howard Hinnant's days-to-civil.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// One note's line in a list: its number, day, title and summary.
fn listed_line(note: &Note) -> String {
    format!(
        "#{} {} {}: {}",
        note.id,
        day(note.at),
        note.title,
        note.summary
    )
}

/// The brief and the list of notes as the agent reads them, the same at a
/// restart as from the notes tool. None when nothing is kept.
pub fn briefing_of(listed: &Listed) -> Option<String> {
    if listed.brief.is_none() && listed.notes.is_empty() {
        return None;
    }
    let mut text = String::new();
    match &listed.brief {
        Some(brief) => {
            text.push_str(&format!("Brief ({}):\n{}\n", day(brief.at), brief.text));
        }
        None => text.push_str("No brief is kept yet.\n"),
    }
    if listed.notes.is_empty() {
        text.push_str("\nNo notes are kept yet.");
        return Some(text);
    }
    text.push_str("\nNotes, newest first, by number, day, title and summary:\n");
    for note in &listed.notes {
        text.push_str(&listed_line(note));
        text.push('\n');
    }
    if listed.more > 0 {
        text.push_str(&format!(
            "And {} more, found by their words with the notes tool.\n",
            listed.more
        ));
    }
    Some(text.trim_end().to_string())
}

/// The brief and list for a session, or None when nothing is kept or the
/// store cannot be read.
pub fn briefing(home: &Path, owner: &str) -> Option<String> {
    let notes = Notes::existing(home).ok()??;
    briefing_of(&notes.listed(owner).ok()?)
}

/// One note whole, as the agent reads it.
pub fn whole(note: &Note) -> String {
    let mut text = format!(
        "#{} {} {}\n{}",
        note.id,
        day(note.at),
        note.title,
        note.summary
    );
    if let Some(by) = note.replaced_by {
        text = format!("Replaced by #{by}.\n{text}");
    }
    if let Some(old) = note.replaces {
        text.push_str(&format!("\nIn place of #{old}."));
    }
    if !note.body.is_empty() {
        text.push_str("\n\n");
        text.push_str(&note.body);
    }
    text
}

/// The notes as the user reads them in the viewer: the brief, then the
/// standing notes newest first, then those a later one replaced.
pub fn page_of(brief: Option<&Brief>, notes: &[Note]) -> String {
    let mut text = String::from("# Notes\n\nKept by the session as it worked, for going on later without reading the whole conversation again.\n");
    if let Some(brief) = brief {
        text.push_str(&format!(
            "\n## Brief\n\n{}\n\n*{}*\n",
            brief.text,
            day(brief.at)
        ));
    }
    let (standing, replaced): (Vec<&Note>, Vec<&Note>) =
        notes.iter().partition(|note| note.replaced_by.is_none());
    for (heading, list) in [("Notes", standing), ("Replaced", replaced)] {
        if list.is_empty() {
            continue;
        }
        text.push_str(&format!("\n## {heading}\n"));
        for note in list {
            let mut said = format!("{} · #{}", day(note.at), note.id);
            if let Some(old) = note.replaces {
                said.push_str(&format!(" · in place of #{old}"));
            }
            if let Some(by) = note.replaced_by {
                said.push_str(&format!(" · replaced by #{by}"));
            }
            text.push_str(&format!(
                "\n### {}\n\n*{said}*\n\n{}\n",
                note.title, note.summary
            ));
            if !note.body.is_empty() {
                text.push_str(&format!("\n{}\n", note.body));
            }
        }
    }
    text
}

/// The name the readable copy goes by, which the viewer shows over it.
pub const PAGE_NAME: &str = "Notes.md";

/// The folder of a session's readable copy, one per session.
fn page_folder(home: &Path, owner: &str) -> PathBuf {
    let safe: String = owner
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    home.join(PAGES).join(safe)
}

/// Where the readable copy of a session's notes is written.
pub fn page_path(home: &Path, owner: &str) -> PathBuf {
    page_folder(home, owner).join(PAGE_NAME)
}

/// What the window is told of a session's notes: how many stand, and,
/// when asked for the page, where its readable copy was written.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Kept {
    pub standing: usize,
    pub brief: bool,
    pub page: Option<String>,
}

/// How much is kept for a session, and with `page`, its readable copy
/// written afresh for the viewer.
pub fn kept(home: &Path, owner: &str, page: bool) -> Result<Kept, String> {
    let Some(notes) = Notes::existing(home)? else {
        return Ok(Kept {
            standing: 0,
            brief: false,
            page: None,
        });
    };
    let brief = notes.brief(owner)?;
    let all = notes.all(owner)?;
    let standing = all.iter().filter(|note| note.replaced_by.is_none()).count();
    let mut written = None;
    if page && (brief.is_some() || !all.is_empty()) {
        let path = page_path(home, owner);
        if let Some(folder) = path.parent() {
            std::fs::create_dir_all(folder)
                .map_err(|e| format!("the notes could not be written out: {e}"))?;
        }
        std::fs::write(&path, page_of(brief.as_ref(), &all))
            .map_err(|e| format!("the notes could not be written out: {e}"))?;
        written = Some(path.to_string_lossy().to_string());
    }
    Ok(Kept {
        standing,
        brief: brief.is_some(),
        page: written,
    })
}

/// Lets go of the notes of these sessions, and of their readable copies.
pub fn forget(home: &Path, owners: &[String]) -> Result<(), String> {
    if let Some(notes) = Notes::existing(home)? {
        notes.forget(owners)?;
    }
    for owner in owners {
        let _ = std::fs::remove_file(page_path(home, owner));
        let _ = std::fs::remove_dir(page_folder(home, owner));
    }
    Ok(())
}

#[cfg(test)]
#[path = "notes_tests.rs"]
mod tests;
