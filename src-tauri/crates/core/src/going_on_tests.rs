use super::*;
use crate::scratch::Scratch;
use serde_json::json;

/// 2026-11-19T08:00:00Z in milliseconds.
const AT: u64 = 1_795_075_200_000;
const STAMP: &str = "2026-11-19T08:00:00.000Z";

fn user(text: &str) -> String {
    json!({ "type": "user", "timestamp": STAMP, "message": { "role": "user", "content": text } })
        .to_string()
}

fn assistant(text: &str, context: u64, hour: bool) -> String {
    let written = if hour {
        json!({ "ephemeral_1h_input_tokens": 1000, "ephemeral_5m_input_tokens": 0 })
    } else {
        json!({ "ephemeral_1h_input_tokens": 0, "ephemeral_5m_input_tokens": 1000 })
    };
    json!({
        "type": "assistant",
        "timestamp": STAMP,
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": text }],
            "usage": {
                "input_tokens": 10,
                "cache_creation_input_tokens": 1000,
                "cache_read_input_tokens": context - 1010 - 50,
                "output_tokens": 50,
                "cache_creation": written
            }
        }
    })
    .to_string()
}

fn transcript(home: &Scratch, lines: &[String]) -> std::path::PathBuf {
    let path = home.path().join("session.jsonl");
    std::fs::write(&path, lines.join("\n") + "\n").unwrap();
    path
}

#[test]
fn a_conversation_goes_on_only_when_cold_and_large() {
    let large = Standing {
        context: 400_000,
        at: AT,
        hour: true,
    };
    let small = Standing {
        context: 40_000,
        ..large
    };
    let short = Standing {
        hour: false,
        ..large
    };
    assert!(!goes_on(&large, AT + 30 * 60 * 1000));
    assert!(goes_on(&large, AT + HOUR - MARGIN));
    assert!(goes_on(&large, AT + 3 * HOUR));
    assert!(!goes_on(&small, AT + 3 * HOUR));
    assert!(!goes_on(&short, AT + 60 * 1000));
    assert!(goes_on(&short, AT + FIVE_MINUTES));
}

#[test]
fn the_standing_is_read_from_the_last_request_and_its_cache() {
    let home = Scratch::new("going-on-standing");
    let path = transcript(
        &home,
        &[
            user("Build it."),
            assistant("On it.", 120_000, true),
            user("And the tests."),
            assistant("Done.", 150_000, false),
        ],
    );
    let standing = crate::claude_history::standing(&path).unwrap();
    assert_eq!(
        standing,
        Standing {
            context: 150_000,
            at: AT,
            hour: false
        }
    );
}

/// The owner's case: a conversation of close to a million tokens, opened
/// after a pause, goes on from a briefing of a few thousand tokens however
/// long it is.
#[test]
fn a_cold_conversation_of_a_million_tokens_goes_on_from_a_small_fixed_briefing() {
    let home = Scratch::new("going-on-million");
    let long = "word ".repeat(2000);
    let mut lines = vec![user(
        "We are building Chord, a desktop app for coding agents.",
    )];
    for turn in 0..400 {
        lines.push(user(&format!("Question {turn}: {long}")));
        lines.push(assistant(&format!("Answer {turn}: {long}"), 967_000, true));
    }
    let path = transcript(&home, &lines);
    let notes = "Brief (2026-11-19):\nChord.\n\nNotes, newest first, by number, day, title and summary:\n#1 2026-11-19 Cap: 150k.";
    let judged = judge(&path, Some(notes), AT + 3 * HOUR);
    assert!(judged.goes_on);
    assert_eq!(judged.context, Some(967_000));
    assert_eq!(judged.idle, Some(3 * 60 * 60));
    let briefing = judged.briefing.unwrap();
    // A few thousand tokens at about four characters a token, whatever the
    // size of what came before.
    assert!(briefing.len() < 20_000, "{}", briefing.len());
    assert!(briefing.starts_with(HEAD));
    assert!(briefing.ends_with(END));
    assert!(briefing.contains("#1 2026-11-19 Cap: 150k."));
    assert!(briefing.contains("How it began, the user's first message:\nWe are building Chord"));
    assert!(briefing.contains("User:\nQuestion 397:"));
    assert!(briefing.contains("You:\nAnswer 399:"));
    assert!(!briefing.contains("Question 396:"));
    assert!(briefing.contains(&path.display().to_string()));
    // Warm, it is resumed whole and nothing is built.
    let warm = judge(&path, Some(notes), AT + 60 * 1000);
    assert!(!warm.goes_on);
    assert_eq!(warm.briefing, None);
}

#[test]
fn an_earlier_briefing_is_not_quoted_again() {
    let home = Scratch::new("going-on-again");
    let earlier = briefing(None, None, &[], Path::new("/t/old.jsonl"));
    let path = transcript(
        &home,
        &[
            user(&format!("{earlier}\n\nWhere were we?")),
            assistant("At the cap.", 200_000, true),
        ],
    );
    let again = judge(&path, None, AT + 2 * HOUR).briefing.unwrap();
    assert_eq!(again.matches(HEAD).count(), 1);
    assert!(again.contains("How it began, the user's first message:\nWhere were we?"));
    assert!(again.contains("No notes were kept of the earlier conversation."));
    assert_eq!(without_briefing("plain words"), "plain words");
}
