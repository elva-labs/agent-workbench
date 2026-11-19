//! Whether a conversation that is needed again goes on from its notes
//! rather than being read again whole, and the briefing it goes on with.
//!
//! A conversation whose prompt cache has lapsed is read again at the
//! price of writing it all to the cache, which for a long one is far more
//! than a fresh conversation costs. So a cold and large one goes on as a
//! fresh conversation, given its brief and the list of its notes, how it
//! began, its last exchanges word for word, and where its transcript is,
//! to be searched for a detail and never read whole. A warm or small one
//! is resumed whole, as is any the user asks to have whole.

use std::path::Path;

use serde::Serialize;

use crate::claude_history::{Quoted, Standing};

/// The context, in tokens, from which a cold conversation is large: read
/// again cold, it costs more than going on from its notes by far.
pub const LARGE: u64 = 100_000;

/// How long before its cache lapses a conversation is taken as cold
/// already, in milliseconds: the last request's time is when it ended, and
/// a resume takes a moment before its first request.
pub const MARGIN: u64 = 2 * 60 * 1000;
pub const HOUR: u64 = 60 * 60 * 1000;
pub const FIVE_MINUTES: u64 = 5 * 60 * 1000;

/// How many of the user's last messages go along, each with the agent's
/// words after it, and how long each may be in characters.
pub const EXCHANGES: usize = 3;
pub const SAID_MOST: usize = 2000;
pub const BEGAN_MOST: usize = 1500;

/// The first and last lines of the briefing. The window takes what lies
/// between them out of the message it is drawn in.
pub const HEAD: &str = "From the workbench, not the user: this conversation goes on from an earlier one of yours, which was not read again, since reading all of it with its cache lapsed would cost far more. What you need to go on is below.";
pub const END: &str = "End of the workbench's briefing.";

/// Whether a conversation that stands so is cold and large at `now`.
pub fn goes_on(standing: &Standing, now: u64) -> bool {
    let lifetime = if standing.hour { HOUR } else { FIVE_MINUTES };
    let cold = now.saturating_sub(standing.at) + MARGIN >= lifetime;
    cold && standing.context >= LARGE
}

/// Text cut to at most `most` characters, said so where it was cut.
fn cut(text: &str, most: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= most {
        return text.to_string();
    }
    let kept: String = text.chars().take(most).collect();
    format!("{kept} [cut]")
}

/// A message without an earlier briefing ahead of its words.
pub fn without_briefing(text: &str) -> &str {
    if !text.starts_with(HEAD) {
        return text;
    }
    match text.find(&format!("\n{END}")) {
        Some(at) => text[at + END.len() + 1..].trim_start(),
        None => text,
    }
}

/// The briefing a fresh conversation goes on with.
pub fn briefing(
    notes: Option<&str>,
    began: Option<&str>,
    said: &[Quoted],
    transcript: &Path,
) -> String {
    let mut text = String::from(HEAD);
    text.push_str("\n\n");
    match notes {
        Some(notes) => {
            text.push_str("Your brief and notes, each note read whole with the notes tool by its number or found by its words:\n");
            text.push_str(notes);
        }
        None => text.push_str("No notes were kept of the earlier conversation."),
    }
    if let Some(began) = began.map(without_briefing).filter(|t| !t.trim().is_empty()) {
        text.push_str("\n\nHow it began, the user's first message:\n");
        text.push_str(&cut(began, BEGAN_MOST));
    }
    if !said.is_empty() {
        text.push_str("\n\nIts last exchanges, word for word:");
        for one in said {
            let words = if one.user {
                without_briefing(&one.text)
            } else {
                &one.text
            };
            text.push_str(if one.user {
                "\n\nUser:\n"
            } else {
                "\n\nYou:\n"
            });
            text.push_str(&cut(words, SAID_MOST));
        }
    }
    text.push_str(&format!(
        "\n\nThe whole earlier conversation is at {}. When the user refers to something neither the notes nor the above cover, read the matching notes first, then search that file for the detail with your own tools; never read it whole. Keep notes from here on as before.\n{END}",
        transcript.display()
    ));
    text
}

/// What the window is told of a conversation it is about to take up
/// again: its context and how long it has rested, when its transcript
/// says, whether it goes on from its notes, and if so the briefing.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoingOn {
    pub context: Option<u64>,
    /// Seconds since its last request.
    pub idle: Option<u64>,
    pub goes_on: bool,
    pub briefing: Option<String>,
}

/// How a Claude Code conversation is taken up again: from its notes when
/// it is cold and large, and whole otherwise. `notes` is the session's
/// brief and list.
pub fn judge(transcript: &Path, notes: Option<&str>, now: u64) -> GoingOn {
    let standing = crate::claude_history::standing(transcript);
    let goes_on = standing.is_some_and(|standing| goes_on(&standing, now));
    let briefing = goes_on.then(|| {
        let began = crate::claude_history::first_said(transcript);
        let said = crate::claude_history::last_said(transcript, EXCHANGES);
        briefing(notes, began.as_deref(), &said, transcript)
    });
    GoingOn {
        context: standing.map(|standing| standing.context),
        idle: standing.map(|standing| now.saturating_sub(standing.at) / 1000),
        goes_on,
        briefing,
    }
}

#[cfg(test)]
#[path = "going_on_tests.rs"]
mod tests;
