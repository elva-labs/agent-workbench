//! Listing past sessions for many projects at once, over a generated
//! directory: two accounts, each with a projects directory holding fifty
//! transcripts per project, and a Codex index with fifty threads per project.
//! Run with `--nocapture` to see the timings. `WORKBENCH_LISTING_BYTES` sets
//! the size of a transcript, `WORKBENCH_LISTING_PROJECTS` how many projects.

use std::path::{Path, PathBuf};
use std::time::Instant;

use workbench_core::{codex, transcripts};

const ACCOUNTS: usize = 2;
const PER_PROJECT: usize = 50;

fn env_number(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(default)
}

fn project(n: usize) -> PathBuf {
    PathBuf::from(format!("/home/ada/dev/project-{n:02}"))
}

fn write_claude(root: &Path, projects: usize, bytes: usize) {
    let filler = format!(
        "{{\"type\":\"assistant\",\"pad\":\"{}\"}}\n",
        "x".repeat(900)
    );
    for n in 0..projects {
        let dir = transcripts::directory_for(root, &project(n));
        std::fs::create_dir_all(&dir).unwrap();
        for t in 0..PER_PROJECT {
            let head = format!(
                "{{\"type\":\"user\",\"cwd\":\"{}\",\"message\":{{\"content\":\"task {t}\"}}}}\n",
                project(n).display()
            );
            let tail = format!("{{\"type\":\"ai-title\",\"aiTitle\":\"title {t}\"}}\n");
            let padding = bytes.saturating_sub(head.len() + tail.len()) / filler.len();
            let body = format!("{head}{}{tail}", filler.repeat(padding));
            std::fs::write(dir.join(format!("session-{t:03}.jsonl")), body).unwrap();
        }
    }
}

fn write_codex(home: &Path, projects: usize) {
    std::fs::create_dir_all(home).unwrap();
    let connection = rusqlite::Connection::open(home.join("state_5.sqlite")).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, name TEXT, \
             title TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '', \
             created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, \
             archived INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, \
             tokens_used INTEGER NOT NULL DEFAULT 0); BEGIN",
        )
        .unwrap();
    for n in 0..projects {
        for t in 0..PER_PROJECT {
            connection
                .execute(
                    "INSERT INTO threads (id, cwd, title, created_at, updated_at, source) \
                     VALUES (?1, ?2, ?3, 1, ?4, 'cli')",
                    rusqlite::params![
                        format!("thread-{n}-{t}"),
                        project(n).to_string_lossy(),
                        format!("title {t}"),
                        t as i64
                    ],
                )
                .unwrap();
        }
    }
    connection.execute_batch("COMMIT").unwrap();
}

#[test]
fn listing_every_open_project() {
    let projects = env_number("WORKBENCH_LISTING_PROJECTS", 40);
    let bytes = env_number("WORKBENCH_LISTING_BYTES", 4 * 1024);
    let root = std::env::temp_dir().join(format!(
        "workbench-listing-bench-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos())
    ));
    std::fs::remove_dir_all(&root).ok();
    let claude: Vec<PathBuf> = (0..ACCOUNTS)
        .map(|a| root.join(format!("claude-{a}")))
        .collect();
    let codex_homes: Vec<PathBuf> = (0..ACCOUNTS)
        .map(|a| root.join(format!("codex-{a}")))
        .collect();
    for dir in &claude {
        write_claude(dir, projects, bytes);
    }
    for home in &codex_homes {
        write_codex(home, projects);
    }

    let all: Vec<PathBuf> = (0..projects).map(project).collect();
    let mut total = 0;
    for pass in ["first", "second"] {
        let opened = transcripts::opened();
        let started = Instant::now();
        for dir in &claude {
            for found in transcripts::list_many(dir, &all) {
                assert_eq!(found.len(), PER_PROJECT);
                assert!(found[0]
                    .title
                    .as_deref()
                    .is_some_and(|t| t.starts_with("title")));
                total += found.len();
            }
        }
        let batched = started.elapsed();
        if pass == "second" {
            // Nothing changed between the passes, so nothing is opened again.
            assert_eq!(
                transcripts::opened(),
                opened,
                "the second pass missed the cache"
            );
        }

        let started = Instant::now();
        for path in &all {
            for dir in &claude {
                total += transcripts::list(dir, path).len();
            }
        }
        let one_by_one = started.elapsed();

        let started = Instant::now();
        for home in &codex_homes {
            for found in codex::list_many(home, &all) {
                assert_eq!(found.len(), PER_PROJECT);
                total += found.len();
            }
        }
        let codex_batched = started.elapsed();

        let started = Instant::now();
        for path in &all {
            for home in &codex_homes {
                total += codex::list(home, path).len();
            }
        }
        println!(
            "{pass} pass, {projects} projects, {ACCOUNTS} accounts, {bytes} bytes a transcript: \
             claude batched {batched:?}, claude one by one {one_by_one:?}, \
             codex batched {codex_batched:?}, codex one by one {:?}",
            started.elapsed()
        );
    }
    assert_eq!(total, 2 * 4 * projects * PER_PROJECT * ACCOUNTS);
    std::fs::remove_dir_all(&root).ok();
}
