//! Sessions Codex CLI has already had in a project.
//!
//! Codex keeps an index of its threads in a SQLite database under its home,
//! `state_<n>.sqlite`, with the rollout files beside it. The index is what its
//! own picker reads, and it carries what the pane needs: id, directory, the
//! name the user gave a thread, the title Codex gave it, and when it moved.
//!
//! The schema is Codex's own and moves with its versions, which is why every
//! query lives here and every failure is an empty answer rather than an
//! error: a picker with nothing to show beats a pane that will not open.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

use crate::transcripts::{tidy, Transcript};

/// Where Codex keeps its state: `CODEX_HOME`, or `.codex` under the home.
pub fn home(user_home: &Path) -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home.join(".codex"))
}

/// The newest state database by schema number: Codex bumps the number when
/// the schema moves, and leaves the old file behind.
fn state_db(codex_home: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(codex_home).ok()?;
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let number = name
                .strip_prefix("state_")?
                .strip_suffix(".sqlite")?
                .parse::<u32>()
                .ok()?;
            Some((number, entry.path()))
        })
        .max_by_key(|(number, _)| *number)
        .map(|(_, path)| path)
}

fn open(codex_home: &Path) -> Option<Connection> {
    let path = state_db(codex_home)?;
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

/// A thread as listed. Sessions run non-interactively (`codex exec`) are left
/// out, as Codex's own picker leaves them out; so are archived ones.
const LIST: &str = "SELECT id, name, title, first_user_message, updated_at, tokens_used \
                    FROM threads WHERE cwd = ?1 AND archived = 0 AND source <> 'exec' \
                    ORDER BY updated_at DESC";

/// Newest first. A project Codex has never been used in has none.
pub fn list(codex_home: &Path, project: &Path) -> Vec<Transcript> {
    let Some(connection) = open(codex_home) else {
        return Vec::new();
    };
    let Ok(mut statement) = connection.prepare(LIST) else {
        return Vec::new();
    };
    let cwd = project.to_string_lossy().to_string();
    let rows = statement.query_map([cwd], |row| {
        Ok(Transcript {
            id: row.get(0)?,
            title: name_of(row.get(1)?, row.get(2)?, row.get(3)?),
            modified: row.get::<_, i64>(4).map(|s| s.max(0) as u64)?,
            size: row.get::<_, i64>(5).map(|s| s.max(0) as u64)?,
        })
    });
    match rows {
        Ok(rows) => rows.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

/// What a thread is called: the name the user gave it, else the title Codex
/// gave it, else what the user first said. Empty is what a fresh thread has.
fn name_of(name: Option<String>, title: Option<String>, first: Option<String>) -> Option<String> {
    [name, title, first]
        .into_iter()
        .flatten()
        .map(|text| text.trim().to_string())
        .find(|text| !text.is_empty())
        .map(|text| tidy(&text))
}

/// A thread that started in the project at or after a moment, newest first:
/// the one a `codex` just spawned there is about to create. Codex mints its
/// own ids, so this is how the workbench learns the id of what it started.
pub fn started_since(codex_home: &Path, project: &Path, since: u64) -> Option<(String, Option<String>)> {
    let connection = open(codex_home)?;
    let cwd = project.to_string_lossy().to_string();
    connection
        .query_row(
            "SELECT id, name, title, first_user_message FROM threads \
             WHERE cwd = ?1 AND created_at >= ?2 ORDER BY created_at DESC LIMIT 1",
            rusqlite::params![cwd, since as i64],
            |row| Ok((row.get(0)?, name_of(row.get(1)?, row.get(2)?, row.get(3)?))),
        )
        .ok()
}

/// What a thread is called now. None for a thread that is not there.
pub fn title_of(codex_home: &Path, id: &str) -> Option<String> {
    let connection = open(codex_home)?;
    connection
        .query_row(
            "SELECT name, title, first_user_message FROM threads WHERE id = ?1",
            [id],
            |row| Ok(name_of(row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codex_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("workbench-codex-{name}"));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The columns the queries touch, with Codex's own names and types.
    fn seed(dir: &Path, version: u32, rows: &[(&str, &str, &str, &str, &str, i64, i64, i64, &str)]) {
        let connection = Connection::open(dir.join(format!("state_{version}.sqlite"))).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, name TEXT, \
                 title TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '', \
                 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, \
                 archived INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, \
                 tokens_used INTEGER NOT NULL DEFAULT 0)",
            )
            .unwrap();
        for (id, cwd, name, title, first, created, updated, archived, source) in rows {
            connection
                .execute(
                    "INSERT INTO threads (id, cwd, name, title, first_user_message, created_at, \
                     updated_at, archived, source, tokens_used) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 42)",
                    rusqlite::params![id, cwd, (!name.is_empty()).then_some(*name), title, first, created, updated, archived, source],
                )
                .unwrap();
        }
    }

    const P: &str = "/home/ada/dev/demo";

    #[test]
    fn a_home_with_no_state_has_no_sessions() {
        let dir = codex_home("empty");
        assert!(list(&dir, Path::new(P)).is_empty());
        assert_eq!(title_of(&dir, "x"), None);
    }

    #[test]
    fn lists_the_project_threads_newest_first_under_their_names() {
        let dir = codex_home("list");
        seed(
            &dir,
            5,
            &[
                ("a", P, "", "Refactor billing", "refactor the billing module", 10, 20, 0, "cli"),
                ("b", P, "given name", "Something", "hello", 11, 30, 0, "cli"),
                ("c", P, "", "", "just a prompt", 12, 25, 0, "cli"),
                ("d", "/elsewhere", "", "other project", "x", 13, 40, 0, "cli"),
                ("e", P, "", "archived", "x", 14, 50, 1, "cli"),
                ("f", P, "", "exec run", "x", 15, 60, 0, "exec"),
                ("g", P, "", "", "", 16, 70, 0, "cli"),
            ],
        );
        let found = list(&dir, Path::new(P));
        let ids: Vec<&str> = found.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["g", "b", "c", "a"]);
        assert_eq!(found[1].title.as_deref(), Some("given name"));
        assert_eq!(found[2].title.as_deref(), Some("just a prompt"));
        assert_eq!(found[3].title.as_deref(), Some("Refactor billing"));
        assert_eq!(found[0].title, None, "a fresh thread has no name yet");
        assert_eq!(found[3].modified, 20);
        assert_eq!(found[3].size, 42);
    }

    #[test]
    fn reads_the_newest_schema_when_several_are_left_behind() {
        let dir = codex_home("versions");
        seed(&dir, 4, &[("old", P, "", "old", "x", 1, 1, 0, "cli")]);
        seed(&dir, 12, &[("new", P, "", "new", "x", 1, 1, 0, "cli")]);
        let ids: Vec<String> = list(&dir, Path::new(P)).into_iter().map(|t| t.id).collect();
        assert_eq!(ids, ["new"]);
    }

    #[test]
    fn finds_the_thread_a_spawn_just_created() {
        let dir = codex_home("since");
        seed(
            &dir,
            5,
            &[
                ("before", P, "", "earlier", "x", 100, 100, 0, "cli"),
                ("after", P, "", "", "", 205, 205, 0, "cli"),
            ],
        );
        assert_eq!(started_since(&dir, Path::new(P), 200), Some(("after".to_string(), None)));
        assert_eq!(started_since(&dir, Path::new(P), 300), None);
        assert_eq!(started_since(&dir, Path::new("/nope"), 0), None);
    }

    #[test]
    fn reports_what_a_thread_is_called_now() {
        let dir = codex_home("title");
        seed(&dir, 5, &[("a", P, "", "", "first words", 1, 1, 0, "cli")]);
        assert_eq!(title_of(&dir, "a").as_deref(), Some("first words"));
        assert_eq!(title_of(&dir, "missing"), None);
    }

    // The schema is Codex's to change. A table that is not there is no
    // history, never a broken pane.
    #[test]
    fn a_schema_it_does_not_recognise_is_no_history() {
        let dir = codex_home("schema");
        let connection = Connection::open(dir.join("state_5.sqlite")).unwrap();
        connection.execute_batch("CREATE TABLE sessions (id TEXT)").unwrap();
        assert!(list(&dir, Path::new(P)).is_empty());
        assert_eq!(started_since(&dir, Path::new(P), 0), None);
    }
}
