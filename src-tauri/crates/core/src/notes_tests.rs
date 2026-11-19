use super::*;
use crate::scratch::Scratch;

fn note<'a>(title: &'a str, summary: &'a str) -> NewNote<'a> {
    NewNote {
        title,
        summary,
        body: "",
        replaces: None,
    }
}

#[test]
fn reading_never_makes_a_store() {
    let home = Scratch::new("notes-none");
    assert_eq!(briefing(home.path(), "token"), None);
    let kept = kept(home.path(), "token", true).unwrap();
    assert_eq!(kept.standing, 0);
    assert_eq!(kept.page, None);
    assert!(!folder(home.path()).exists());
}

#[test]
fn the_store_is_in_the_workbench_directory_and_the_users_alone() {
    let home = Scratch::new("notes-own");
    let notes = Notes::open(home.path()).unwrap();
    notes.add("a", &note("One", "First."), 0).unwrap();
    let page = kept(home.path(), "a", true).unwrap().page.unwrap();
    let dir = home.path().join(".agent-workbench").join("notes");
    assert!(dir.join(FILE).is_file());
    assert!(Path::new(&page).starts_with(&dir));
    assert!(!home.path().join(FILE).exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join(FILE)), 0o600);
        assert_eq!(mode(Path::new(&page)), 0o600);
        assert_eq!(mode(Path::new(&page).parent().unwrap()), 0o700);
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_file() {
                assert_eq!(mode(&path) & 0o077, 0, "{}", path.display());
            }
        }
    }
}

#[test]
fn a_note_kept_after_the_point_gone_back_to_is_said_to_be_so() {
    let home = Scratch::new("notes-since");
    let notes = Notes::open(home.path()).unwrap();
    notes.add("a", &note("Before", "Stands."), 100).unwrap();
    notes
        .add("a", &note("After", "Went back on."), 200)
        .unwrap();
    let all = briefing_since(home.path(), "a", Some(150)).unwrap();
    let line = |title: &str| {
        all.lines()
            .find(|line| line.contains(title))
            .unwrap()
            .to_string()
    };
    assert!(!line("Before").contains("went back on"));
    assert!(line("After").contains("kept on a turn the conversation went back on"));
    assert!(!briefing(home.path(), "a")
        .unwrap()
        .contains("went back on:"));
}

#[test]
fn a_brief_and_notes_are_kept_per_session() {
    let home = Scratch::new("notes-kept");
    let notes = Notes::open(home.path()).unwrap();
    notes
        .set_brief("a", "A desktop app for agents.", 0)
        .unwrap();
    notes
        .set_brief("a", "Chord, a desktop app for agents.", 86_400)
        .unwrap();
    let first = notes
        .add(
            "a",
            &note("Default model", "One tier below the starter."),
            86_400,
        )
        .unwrap();
    notes
        .add("b", &note("Other", "Another session's."), 0)
        .unwrap();

    let listed = notes.listed("a").unwrap();
    assert_eq!(
        listed.brief.as_ref().unwrap().text,
        "Chord, a desktop app for agents."
    );
    assert_eq!(listed.notes.len(), 1);
    assert_eq!(listed.notes[0].id, first);
    let text = briefing(home.path(), "a").unwrap();
    assert!(text.starts_with("Brief (1970-01-02):\nChord, a desktop app for agents."));
    assert!(text.contains(&format!(
        "#{first} 1970-01-02 Default model: One tier below the starter."
    )));
    assert!(!text.contains("Another session's"));
}

#[test]
fn a_later_note_replaces_an_earlier_one() {
    let home = Scratch::new("notes-replace");
    let notes = Notes::open(home.path()).unwrap();
    let old = notes
        .add("a", &note("Threshold", "100k tokens."), 0)
        .unwrap();
    let new = notes
        .add(
            "a",
            &NewNote {
                replaces: Some(old),
                ..note("Threshold", "150k tokens.")
            },
            1,
        )
        .unwrap();
    let listed = notes.listed("a").unwrap();
    assert_eq!(
        listed.notes.iter().map(|n| n.id).collect::<Vec<_>>(),
        vec![new]
    );
    let read = notes.read("a", old).unwrap().unwrap();
    assert_eq!(read.replaced_by, Some(new));
    assert!(whole(&read).starts_with(&format!("Replaced by #{new}.")));
    // A note already replaced, or another session's, cannot be replaced.
    let again = NewNote {
        replaces: Some(old),
        ..note("x", "y")
    };
    assert!(notes
        .add("a", &again, 2)
        .unwrap_err()
        .contains(&format!("#{new}")));
    assert!(notes.add("b", &again, 2).unwrap_err().contains("no note"));
}

#[test]
fn the_list_is_bounded_to_the_newest_and_the_most_read() {
    let home = Scratch::new("notes-bounded");
    let notes = Notes::open(home.path()).unwrap();
    let ids: Vec<i64> = (0..60)
        .map(|n| {
            notes
                .add("a", &note(&format!("Note {n}"), "Said."), n)
                .unwrap()
        })
        .collect();
    // The oldest is read often, so it stays on the list.
    for _ in 0..3 {
        notes.read("a", ids[0]).unwrap();
    }
    let listed = notes.listed("a").unwrap();
    assert_eq!(listed.notes.len(), NEWEST + 1);
    assert_eq!(listed.more, 60 - NEWEST - 1);
    assert_eq!(listed.notes[0].id, ids[59]);
    assert_eq!(listed.notes.last().unwrap().id, ids[0]);
    let text = briefing_of(&listed).unwrap();
    assert!(text.ends_with(&format!(
        "And {} more, found by their words with the notes tool.",
        60 - NEWEST - 1
    )));
}

#[test]
fn find_takes_every_word_and_ranks_the_head_first() {
    let home = Scratch::new("notes-find");
    let notes = Notes::open(home.path()).unwrap();
    let in_body = notes
        .add(
            "a",
            &NewNote {
                body: "The cache lifetime is an hour.",
                ..note("Prices", "What a turn costs.")
            },
            0,
        )
        .unwrap();
    let in_title = notes
        .add("a", &note("Cache lifetime", "Read from the transcript."), 1)
        .unwrap();
    notes
        .add("a", &note("Unrelated", "Nothing here."), 2)
        .unwrap();
    let found: Vec<i64> = notes
        .find("a", "CACHE lifetime")
        .unwrap()
        .iter()
        .map(|n| n.id)
        .collect();
    assert_eq!(found, vec![in_title, in_body]);
    assert!(notes.find("a", "cache missing").unwrap().is_empty());
    assert!(notes.find("b", "cache").unwrap().is_empty());
}

#[test]
fn a_note_needs_a_title_and_a_summary_of_a_bounded_length() {
    let home = Scratch::new("notes-limits");
    let notes = Notes::open(home.path()).unwrap();
    assert!(notes.add("a", &note("", "x"), 0).is_err());
    assert!(notes.add("a", &note("x", " "), 0).is_err());
    let long = "x".repeat(TITLE_MOST + 1);
    assert!(notes
        .add("a", &note(&long, "x"), 0)
        .unwrap_err()
        .contains("120"));
    assert!(notes.set_brief("a", "  ", 0).is_err());
    // A title or summary is one line, its spaces folded.
    let id = notes.add("a", &note("Two\nlines", "a  b"), 0).unwrap();
    let kept = notes.note("a", id).unwrap().unwrap();
    assert_eq!(
        (kept.title.as_str(), kept.summary.as_str()),
        ("Two lines", "a b")
    );
}

#[test]
fn forgetting_lets_go_of_the_notes_and_their_page() {
    let home = Scratch::new("notes-forget");
    let notes = Notes::open(home.path()).unwrap();
    notes.set_brief("a", "Brief.", 0).unwrap();
    notes.add("a", &note("One", "First."), 0).unwrap();
    notes.add("b", &note("Two", "Second."), 0).unwrap();
    let page = kept(home.path(), "a", true).unwrap().page.unwrap();
    let written = std::fs::read_to_string(&page).unwrap();
    assert!(written.contains("## Brief\n\nBrief."));
    assert!(written.contains("### One"));
    forget(home.path(), &["a".to_string()]).unwrap();
    assert!(!Path::new(&page).exists());
    assert!(!Path::new(&page).parent().unwrap().exists());
    assert_eq!(briefing(home.path(), "a"), None);
    assert_eq!(kept(home.path(), "b", false).unwrap().standing, 1);
}

#[test]
fn days_are_civil_dates() {
    assert_eq!(day(0), "1970-01-01");
    assert_eq!(day(951_782_400), "2000-02-29");
    assert_eq!(day(1_795_046_400), "2026-11-19");
}

#[test]
fn a_page_path_keeps_to_the_folder() {
    let home = Path::new("/home");
    assert_eq!(
        page_path(home, "../x"),
        Path::new("/home")
            .join(".agent-workbench")
            .join("notes")
            .join("___x")
            .join(PAGE_NAME)
    );
}
