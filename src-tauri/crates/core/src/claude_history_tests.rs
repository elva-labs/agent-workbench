use super::*;
use crate::integrated::ChangeKind;
use crate::scratch::Scratch;
use crate::transcripts::directory_for;
use serde_json::json;
use std::io::Write;

const PROJECT: &str = "/projects/demo";
const SESSION: &str = "5f0c2b1e-7a4d-4c1b-9e3f-2a6b8c0d1e2f";

const CONVERSATION: &str = include_str!("../fixtures/claude-history/conversation.jsonl");
const REWOUND: &str = include_str!("../fixtures/claude-history/rewound.jsonl");
const SUBAGENT: &str = include_str!("../fixtures/claude-history/subagent.jsonl");
const SUBAGENT_OWN: &str = include_str!("../fixtures/claude-history/subagent-agent.jsonl");
const MID_TURN: &str = include_str!("../fixtures/claude-history/rewind-mid-turn.jsonl");
const COMPACTED: &str = include_str!("../fixtures/claude-history/rewind-compacted.jsonl");

/// A configuration directory holding one transcript of the session, filed
/// under `folder`.
fn transcript(name: &str, folder: &str, body: &str) -> (Scratch, PathBuf) {
    let home = Scratch::new(&format!("claude-history-{name}"));
    let dir = directory_for(&home, Path::new(folder));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{SESSION}.jsonl"));
    std::fs::write(&path, body).unwrap();
    (home, path)
}

/// One line for each event, enough to tell them apart.
fn said(history: &History) -> Vec<String> {
    history.items.iter().map(line).collect()
}

fn line(said: &Said) -> String {
    let under = |parent: &Option<String>| {
        parent
            .as_ref()
            .map(|parent| format!(" under {parent}"))
            .unwrap_or_default()
    };
    match &said.event {
        Event::Message {
            message,
            state,
            text,
            images,
            ..
        } => format!(
            "message {state:?} {message}: {}{}",
            text.as_deref().unwrap_or_default(),
            if images.is_empty() {
                String::new()
            } else {
                format!(" with {} image", images.len())
            }
        ),
        Event::TurnStarted { messages } => format!(
            "turn started for [{}] on {}",
            messages.join(", "),
            said.model.as_deref().unwrap_or("no model")
        ),
        Event::TurnEnded {
            outcome,
            duration_ms,
            ..
        } => format!("turn ended {outcome:?} after {duration_ms:?}"),
        Event::Text {
            block,
            parent,
            text,
            done,
        } => {
            assert!(done);
            format!("text {block}{}: {text}", under(parent))
        }
        Event::Thinking {
            block,
            parent,
            text,
            ..
        } => format!("thinking {block}{}: {text}", under(parent)),
        Event::ToolStarted {
            call,
            parent,
            name,
            kind,
        } => format!("call {call}{} {name} {kind:?}", under(parent)),
        Event::ToolInput { call, input, .. } => {
            format!("input {call}: {}", sorted(input.as_ref().unwrap()))
        }
        Event::ToolFinished {
            call,
            parent,
            output,
            error,
            changes,
            ..
        } => format!(
            "finished {call}{}{}: {output}{}",
            under(parent),
            if *error { " failed" } else { "" },
            if changes.is_empty() {
                String::new()
            } else {
                format!(" ({} changed)", changes.len())
            }
        ),
        Event::Plan { call, steps, .. } => format!("plan {call:?} {}", steps.len()),
        Event::Compacted {
            reason,
            tokens_before,
            tokens_after,
        } => format!("compacted {reason:?} {tokens_before:?} {tokens_after:?}"),
        Event::Command {
            command,
            state,
            text,
            exit_code,
            output,
            ..
        } => format!("command {command} {state:?} {text} exit {exit_code:?}: {output:?}"),
        other => format!("{other:?}"),
    }
}

/// A value as JSON with its keys in order, whatever order it holds them in.
fn sorted(value: &Value) -> String {
    match value {
        Value::Object(fields) => {
            let mut keys: Vec<&String> = fields.keys().collect();
            keys.sort();
            let inner: Vec<String> = keys
                .into_iter()
                .map(|key| format!("{}:{}", Value::String(key.clone()), sorted(&fields[key])))
                .collect();
            format!("{{{}}}", inner.join(","))
        }
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(sorted).collect::<Vec<_>>().join(",")
        ),
        other => other.to_string(),
    }
}

#[test]
fn reads_a_conversation_as_the_events_a_live_session_sends() {
    let (_home, path) = transcript("conversation", PROJECT, CONVERSATION);
    let history = read(&path);
    assert_eq!(
        said(&history),
        [
            "message Sent u-1: Count the files in src",
            "turn started for [u-1] on claude-sonnet-5-5",
            "thinking msg_1#0: Listing them is quickest.",
            "call toolu_1 Bash Command",
            r#"input toolu_1: {"command":"ls src | wc -l","description":"Count the files"}"#,
            "finished toolu_1: 12",
            "text msg_2#0: There are 12 files in src.",
            "turn ended Done after Some(6500)",
            "message Sent u-2: Rename the variable as in this picture with 1 image",
            "turn started for [u-2] on claude-sonnet-5-5",
            "call toolu_2 Edit Edit",
            r#"input toolu_2: {"file_path":"/projects/demo/src/index.ts","new_string":"let b = 1;","old_string":"let a = 1;"}"#,
            "finished toolu_2: The file has been updated. (1 changed)",
            "call toolu_3 Bash Command",
            r#"input toolu_3: {"command":"npm test"}"#,
            "finished toolu_3 failed: ",
            "turn ended Interrupted after None",
            "message Sent u-3: Go on, but skip the slow tests",
            "turn started for [u-3] on claude-sonnet-5-5",
            "message Taken q-1: Also check the docs",
            "text msg_5#0: Done, and the docs read well.",
            "turn ended Done after None",
            "compacted Some(Asked) Some(9000) Some(1200)",
            "turn started for [] on claude-sonnet-5-5",
            "text msg_6#0: The build finished.",
        ]
    );
    assert!(!history.cut);
}

#[test]
fn gives_each_event_the_time_its_entry_was_written() {
    let (_home, path) = transcript("times", PROJECT, CONVERSATION);
    let history = read(&path);
    // 2026-03-04T10:00:00Z, and the call's result four seconds on.
    assert_eq!(history.items[0].at, 1_772_618_400_000);
    let finished = history
        .items
        .iter()
        .find(|said| matches!(&said.event, Event::ToolFinished { call, .. } if call == "toolu_1"))
        .unwrap();
    assert_eq!(finished.at, 1_772_618_404_000);
}

#[test]
fn reads_what_a_call_changed_from_its_structured_result() {
    let (_home, path) = transcript("changes", PROJECT, CONVERSATION);
    let history = read(&path);
    let changes = history
        .items
        .iter()
        .find_map(|said| match &said.event {
            Event::ToolFinished { call, changes, .. } if call == "toolu_2" => Some(changes.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(changes[0].path, "/projects/demo/src/index.ts");
    assert_eq!(changes[0].kind, ChangeKind::Update);
    assert_eq!(changes[0].hunks[0].lines, ["-let a = 1;", "+let b = 1;"]);
}

#[test]
fn leaves_open_a_last_turn_the_record_gives_no_end() {
    let (_home, path) = transcript("open", PROJECT, CONVERSATION);
    let history = read(&path);
    assert!(matches!(
        history.items.last().unwrap().event,
        Event::Text { .. }
    ));
}

#[test]
fn ends_a_last_turn_the_agent_ended() {
    let (_home, path) = transcript("ended", PROJECT, REWOUND);
    let history = read(&path);
    assert_eq!(
        line(history.items.last().unwrap()),
        "turn ended Done after None"
    );
}

#[test]
fn leaves_out_turns_taken_back_and_keeps_calls_made_at_once() {
    let (_home, path) = transcript("rewound", PROJECT, REWOUND);
    let history = read(&path);
    assert_eq!(
        said(&history),
        [
            "message Sent u-1: First question",
            "turn started for [u-1] on claude-sonnet-5-5",
            "text msg_1#0: First answer",
            "turn ended Done after None",
            "message Sent u-3: Second question",
            "turn started for [u-3] on claude-sonnet-5-5",
            "call toolu_a Read Read",
            r#"input toolu_a: {"file_path":"/projects/demo/README.md"}"#,
            "call toolu_b Grep Search",
            r#"input toolu_b: {"pattern":"TODO"}"#,
            "finished toolu_a: # Demo",
            "finished toolu_b: No matches",
            "text msg_4#0: Second answer",
            "turn ended Done after None",
        ]
    );
}

#[test]
fn keeps_every_entry_in_order_when_the_line_back_breaks_off() {
    // The first entry names a parent the transcript does not hold, as a
    // transcript begun elsewhere can.
    let broken = REWOUND.replacen(
        r#""uuid":"u-1","parentUuid":null"#,
        r#""uuid":"u-1","parentUuid":"elsewhere""#,
        1,
    );
    let (_home, path) = transcript("broken", PROJECT, &broken);
    let texts: Vec<String> = said(&read(&path))
        .into_iter()
        .filter(|line| line.starts_with("text"))
        .collect();
    assert_eq!(
        texts,
        [
            "text msg_1#0: First answer",
            "text msg_2#0: An answer taken back",
            "text msg_4#0: Second answer",
        ]
    );
}

#[test]
fn keeps_every_entry_in_order_when_no_entry_names_its_parent() {
    let body = r#"{"type":"user","uuid":"u-1","message":{"role":"user","content":"One"}}
{"type":"assistant","uuid":"a-1","message":{"id":"m-1","content":[{"type":"text","text":"First"}],"stop_reason":"end_turn"}}
{"type":"user","uuid":"u-2","message":{"role":"user","content":"Two"}}
{"type":"assistant","uuid":"a-2","message":{"id":"m-2","content":[{"type":"text","text":"Second"}],"stop_reason":"end_turn"}}
"#;
    let (_home, path) = transcript("no-parents", PROJECT, body);
    let texts: Vec<String> = said(&read(&path))
        .into_iter()
        .filter(|line| line.starts_with("text"))
        .collect();
    assert_eq!(texts, ["text m-1#0: First", "text m-2#0: Second"]);
}

#[test]
fn draws_a_subagent_under_the_call_that_started_it() {
    let (_home, path) = transcript("subagent", PROJECT, SUBAGENT);
    let folder = path.with_extension("").join("subagents");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(
        folder.join("agent-a1b2c3.meta.json"),
        r#"{"agentType":"general-purpose","description":"Find the config reader","toolUseId":"toolu_s"}"#,
    )
    .unwrap();
    std::fs::write(folder.join("agent-a1b2c3.jsonl"), SUBAGENT_OWN).unwrap();
    let history = read(&path);
    assert_eq!(
        said(&history),
        [
            "message Sent u-1: Find where the config is read",
            "turn started for [u-1] on claude-sonnet-5-5",
            "call toolu_s Agent Agent",
            r#"input toolu_s: {"description":"Find the config reader","prompt":"Find where the config is read","subagent_type":"general-purpose"}"#,
            "text msg_s1#0 under toolu_s: Looking for it.",
            "call toolu_s1 under toolu_s Grep Search",
            r#"input toolu_s1: {"pattern":"readConfig"}"#,
            "finished toolu_s1 under toolu_s: src/config.ts",
            "call toolu_s2 under toolu_s Read Read",
            r#"input toolu_s2: {"file_path":"/projects/demo/src/config.ts"}"#,
            "finished toolu_s2 under toolu_s failed: ",
            "finished toolu_s: It is read in src/config.ts.",
            "text msg_2#0: The config is read in src/config.ts.",
            "turn ended Done after None",
        ]
    );
    // What follows the subagent has the main conversation's own time.
    let after = history
        .items
        .iter()
        .find(|said| matches!(&said.event, Event::ToolFinished { call, .. } if call == "toolu_s"))
        .unwrap();
    assert_eq!(after.at, millis("2026-03-04T12:00:30.000Z").unwrap());
}

#[test]
fn draws_the_call_alone_when_its_subagent_left_no_transcript() {
    let (_home, path) = transcript("no-subagent", PROJECT, SUBAGENT);
    let calls: Vec<String> = said(&read(&path))
        .into_iter()
        .filter(|line| line.starts_with("call"))
        .collect();
    assert_eq!(calls, ["call toolu_s Agent Agent"]);
}

#[test]
fn finds_the_session_under_its_project_or_a_folder_under_it() {
    let home = Scratch::new("claude-history-find");
    let project = Path::new(PROJECT);
    let worktree = Path::new("/projects/demo/.claude/worktrees/tidy");
    let older = directory_for(&home, project);
    let newer = directory_for(&home, worktree);
    for dir in [&older, &newer] {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(format!("{SESSION}.jsonl")), REWOUND).unwrap();
    }
    let earlier = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
    std::fs::File::options()
        .write(true)
        .open(older.join(format!("{SESSION}.jsonl")))
        .unwrap()
        .set_modified(earlier)
        .unwrap();
    assert_eq!(
        find(&home, project, None, SESSION),
        Some(newer.join(format!("{SESSION}.jsonl")))
    );
    // A sibling project with a longer name is not the project.
    assert_eq!(find(&home, Path::new("/projects/dem"), None, SESSION), None);
}

#[test]
fn skips_an_entry_whose_time_cannot_be_read_and_reads_the_rest() {
    let body = concat!(
        r#"{"type":"user","uuid":"u-1","parentUuid":null,"timestamp":"2026-03-04T10:00:00Z","message":{"role":"user","content":"One"}}"#,
        "\n",
        r#"{"type":"assistant","uuid":"a-1","parentUuid":"u-1","timestamp":"2026-03-04T10:00:01é1234","message":{"id":"m","content":[{"type":"text","text":"First"}],"stop_reason":"end_turn"}}"#,
        "\n",
    );
    let (_home, path) = transcript("odd-time", PROJECT, body);
    let history = read(&path);
    let text = history
        .items
        .iter()
        .find(|said| matches!(said.event, Event::Text { .. }))
        .unwrap();
    // The odd time is no time: the entry keeps the last one read.
    assert_eq!(text.at, millis("2026-03-04T10:00:00Z").unwrap());
}

#[test]
fn finds_nothing_for_a_project_with_no_path() {
    let (home, _) = transcript("no-project", PROJECT, REWOUND);
    assert_eq!(find(&home, Path::new(""), None, SESSION), None);
    assert!(read_session(&home, Path::new(""), None, SESSION).is_none());
}

#[test]
fn reads_the_same_lines_again_though_the_file_grew() {
    let (_home, path) = transcript("grew", PROJECT, "one\ntwo\n");
    let mut first = Vec::new();
    let span = lines(&path, None, |line| first.push(line.to_vec())).unwrap();
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"three\n")
        .unwrap();
    let mut again = Vec::new();
    assert_eq!(
        lines(&path, Some(span), |line| again.push(line.to_vec())),
        Some(span)
    );
    assert_eq!(first, again);
    assert_eq!(again, [b"one".to_vec(), b"two".to_vec()]);
}

#[test]
fn the_mode_a_transcript_last_ran_in_is_its_last_mode_entry() {
    let body = concat!(
        r#"{"type":"permission-mode","permissionMode":"auto","sessionId":"s"}"#,
        "\n",
        r#"{"type":"user","uuid":"u-1","parentUuid":null,"permissionMode":"plan","message":{"role":"user","content":"One"}}"#,
        "\n",
        r#"{"type":"permission-mode","permissionMode":"acceptEdits","sessionId":"s"}"#,
        "\n",
        r#"{"type":"assistant","uuid":"a-1","parentUuid":"u-1","message":{"id":"m","content":[{"type":"text","text":"Says permission-mode in passing"}]}}"#,
        "\n",
    );
    let (_home, path) = transcript("mode", PROJECT, body);
    // The mode a message went with is not the one the terminal resumes in.
    assert_eq!(last_mode(&path).as_deref(), Some("acceptEdits"));
}

#[test]
fn a_transcript_with_no_mode_entry_near_its_end_names_none() {
    let (_home, path) = transcript("no-mode", PROJECT, REWOUND);
    assert_eq!(last_mode(&path), None);
    // An entry further back than the end that is read is not found.
    let mut body = String::from(r#"{"type":"permission-mode","permissionMode":"plan"}"#);
    body.push('\n');
    let filler =
        r#"{"type":"user","uuid":"u","parentUuid":null,"message":{"role":"user","content":"x"}}"#;
    while body.len() <= 2 * MODE_KEEP as usize {
        body.push_str(filler);
        body.push('\n');
    }
    let (_far, far) = transcript("far-mode", PROJECT, &body);
    assert_eq!(last_mode(&far), None);
    assert_eq!(last_mode(Path::new("/nowhere/at/all.jsonl")), None);
}

#[test]
fn finds_nothing_for_an_id_that_is_not_one() {
    let (home, _) = transcript("bad-id", PROJECT, REWOUND);
    for id in ["", "../x", "a/b", "a b", "."] {
        assert_eq!(find(&home, Path::new(PROJECT), None, id), None, "{id}");
    }
}

#[test]
fn has_no_history_without_a_transcript() {
    let home = Scratch::new("claude-history-none");
    assert!(read_session(&home, Path::new(PROJECT), None, SESSION).is_none());
}

#[test]
fn reads_no_folder_named_like_a_transcript() {
    let home = Scratch::new("claude-history-folder");
    let dir = directory_for(&home, Path::new(PROJECT));
    std::fs::create_dir_all(dir.join(format!("{SESSION}.jsonl"))).unwrap();
    assert_eq!(find(&home, Path::new(PROJECT), None, SESSION), None);
    assert!(read(&dir.join(format!("{SESSION}.jsonl"))).items.is_empty());
}

#[test]
fn passes_over_a_line_too_long_to_hold() {
    let long = format!(
        r#"{{"type":"user","uuid":"x","parentUuid":"a-1","message":{{"role":"user","content":"{}"}}}}"#,
        "x".repeat(LINE_KEEP + 1)
    );
    let mut lines: Vec<&str> = REWOUND.lines().collect();
    lines.insert(2, &long);
    let (_home, path) = transcript("long-line", PROJECT, &(lines.join("\n") + "\n"));
    let history = read(&path);
    assert!(said(&history).contains(&"text msg_4#0: Second answer".to_string()));
    assert!(!said(&history).iter().any(|line| line.contains("xxx")));
}

#[test]
fn reads_only_the_end_of_a_very_long_transcript() {
    // Turns enough to pass the most read, each answered.
    let mut body = String::new();
    let mut turn = 0;
    while body.len() as u64 <= FILE_KEEP {
        turn += 1;
        body.push_str(&format!(
            r#"{{"type":"user","uuid":"u-{turn}","timestamp":"2026-03-04T10:00:00Z","message":{{"role":"user","content":"Question {turn} {pad}"}}}}
{{"type":"assistant","uuid":"a-{turn}","message":{{"id":"m-{turn}","content":[{{"type":"text","text":"Answer {turn}"}}],"stop_reason":"end_turn"}}}}
"#,
            pad = "p".repeat(200)
        ));
    }
    let (_home, path) = transcript("very-long", PROJECT, &body);
    let history = read(&path);
    assert!(history.cut);
    let lines = said(&history);
    assert_eq!(lines.last().unwrap(), "turn ended Done after None");
    assert!(lines.contains(&format!("text m-{turn}#0: Answer {turn}")));
    assert!(!lines.contains(&"text m-1#0: Answer 1".to_string()));
}

#[test]
fn leaves_out_the_first_turns_of_a_history_longer_than_it_holds() {
    let mut body = String::new();
    let answer = "a".repeat(4 * 1024);
    for turn in 1..=40 {
        body.push_str(&format!(
            r#"{{"type":"user","uuid":"u-{turn}","message":{{"role":"user","content":"Question {turn}"}}}}
{{"type":"assistant","uuid":"a-{turn}","message":{{"id":"m-{turn}","content":[{{"type":"text","text":"{answer}"}}],"stop_reason":"end_turn"}}}}
"#
        ));
    }
    let (_home, path) = transcript("too-much", PROJECT, &body);
    let history = read(&path);
    assert!(history.cut);
    let size: usize = history
        .items
        .iter()
        .map(|said| serde_json::to_vec(said).unwrap().len())
        .sum();
    assert!(size <= History::KEEP);
    // What is left begins with a message of the user's and its turn.
    assert!(line(&history.items[0]).starts_with("message Sent"));
    assert!(line(&history.items[1]).starts_with("turn started"));
    assert_eq!(
        line(history.items.last().unwrap()),
        "turn ended Done after None"
    );
}

#[test]
fn cuts_long_content_down_and_says_so() {
    let output = "o".repeat(History::OUTPUT_KEEP + 10);
    let body = format!(
        r#"{{"type":"user","uuid":"u-1","parentUuid":null,"message":{{"role":"user","content":"Read it"}}}}
{{"type":"assistant","uuid":"a-1","parentUuid":"u-1","message":{{"id":"m","content":[{{"type":"tool_use","id":"t","name":"Read","input":{{"file_path":"/projects/demo/big.txt"}}}}],"stop_reason":"tool_use"}}}}
{{"type":"user","uuid":"r-1","parentUuid":"a-1","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t","content":"{output}"}}]}}}}
"#
    );
    let (_home, path) = transcript("cut", PROJECT, &body);
    let history = read(&path);
    let (output, truncated) = history
        .items
        .iter()
        .find_map(|said| match &said.event {
            Event::ToolFinished {
                output, truncated, ..
            } => Some((output.clone(), *truncated)),
            _ => None,
        })
        .unwrap();
    assert!(truncated && output.len() <= History::OUTPUT_KEEP);
}

#[test]
fn reads_the_times_a_transcript_writes() {
    assert_eq!(millis("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(millis("1970-01-01T00:00:01.5Z"), Some(1_500));
    assert_eq!(millis("2026-03-04T10:00:00.000Z"), Some(1_772_618_400_000));
    assert_eq!(
        millis("2026-03-04T12:00:00.000+02:00"),
        Some(1_772_618_400_000)
    );
    assert_eq!(millis("2024-02-29T00:00:00Z"), Some(1_709_164_800_000));
    for bad in [
        "",
        "yesterday",
        "2026-13-01T00:00:00Z",
        "2026-03-04 10:00",
        "2026-03-04T10:00:00.Z",
        "2026-03-04T10:00:00+0200",
        "1969-12-31T23:59:59Z",
        // Characters of more than one byte after the seconds.
        "2026-03-04T10:00:01é1234",
        "2026-03-04T10:00:01+0é:00",
        "2026-03-04T10:00:01.5ü",
    ] {
        assert_eq!(millis(bad), None, "{bad}");
    }
}

fn mark(message: &str, at: Option<&str>, resumable: bool, files: bool) -> Mark {
    Mark {
        message: message.into(),
        at: at.map(str::to_string),
        resumable,
        files,
    }
}

/// The ids of the messages of the user's a history holds.
fn messages(history: &History) -> Vec<String> {
    history
        .items
        .iter()
        .filter_map(|said| match &said.event {
            Event::Message { message, .. } => Some(message.clone()),
            _ => None,
        })
        .collect()
}

/// Claude Code 2.1.326 files a message typed during a turn as an attachment
/// that hangs off the turn's last tool result, and a start from that
/// result gives the model the turn up to it with the new message beside
/// the result: the turn is cut where the message was taken in. It keeps no
/// files for such a message.
#[test]
fn a_message_typed_during_a_turn_goes_back_to_the_turn_s_result_before_it() {
    let (_home, path) = transcript("marks-mid-turn", PROJECT, MID_TURN);
    assert_eq!(
        marks(&path, None).unwrap(),
        [
            mark("m-1", None, true, true),
            mark("m-2", Some("a-2"), true, true),
            mark("m-3", Some("r-2"), true, false),
        ]
    );
    assert_eq!(leaf(&path).as_deref(), Some("a-4"));
    // Read as far as that result, the turn ends with the call it finished,
    // and neither the message nor what the agent said after it is there.
    let history = read_until(&path, Some("r-2"));
    assert_eq!(messages(&history), ["m-1", "m-2"]);
    let said = said(&history);
    assert!(
        said.iter().any(|line| line.contains("toolu_2")),
        "{said:#?}"
    );
    assert!(
        !said.iter().any(|line| line.contains("hello mid")),
        "{said:#?}"
    );
    assert_eq!(said.iter().filter(|line| line.contains("done")).count(), 1);
}

/// A start from an earlier entry loads the conversation from where it was
/// last compacted, so Claude Code 2.1.326 does not find an entry before
/// that, and refuses to start: such a message cannot be gone back to, but
/// its files can, the agent finding what it kept of them across the
/// compaction. The first message is gone back to by starting anew.
#[test]
fn a_message_before_the_last_compaction_cannot_be_gone_back_to() {
    let (_home, path) = transcript("marks-compacted", PROJECT, COMPACTED);
    assert_eq!(
        marks(&path, None).unwrap(),
        [
            mark("m-1", None, true, true),
            mark("m-2", Some("a-2"), false, true),
            mark("m-3", Some("r-2"), false, false),
            mark("m-4", Some("o-1"), true, true),
            mark("m-5", Some("a-5"), true, false),
        ]
    );
    assert_eq!(leaf(&path).as_deref(), Some("a-6"));
}

/// A conversation held at the point it went back to has as its messages
/// those before that point, and reads as far as it.
#[test]
fn a_conversation_held_at_an_entry_ends_there() {
    let (_home, path) = transcript("marks-held", PROJECT, COMPACTED);
    let held = marks(&path, Some("a-5")).unwrap();
    assert_eq!(
        held.iter()
            .map(|mark| mark.message.as_str())
            .collect::<Vec<_>>(),
        ["m-1", "m-2", "m-3", "m-4"]
    );
    let history = read_until(&path, Some("a-5"));
    assert_eq!(messages(&history), ["m-1", "m-2", "m-3", "m-4"]);
    assert!(!said(&history)
        .iter()
        .any(|line| line.contains("hello four")));
    // An entry the transcript does not hold reads it to its newest.
    assert_eq!(
        messages(&read_until(&path, Some("nowhere"))),
        messages(&read(&path))
    );
    assert_eq!(messages(&read(&path)), ["m-1", "m-2", "m-3", "m-4", "m-5"]);
}

#[test]
fn a_transcript_whose_line_breaks_off_has_no_marks() {
    let broken = MID_TURN.replace("\"parentUuid\": \"a-2\"", "\"parentUuid\": \"gone\"");
    assert_ne!(broken, MID_TURN);
    let (_home, path) = transcript("marks-broken", PROJECT, &broken);
    assert_eq!(marks(&path, None), None);
    let (_home, none) = transcript("marks-none", PROJECT, "");
    assert_eq!(marks(&none, None), Some(vec![]));
    assert_eq!(leaf(&none), None);
}

/// A transcript of entries given as JSON, each on a line of its own and
/// chained to the one before.
fn entries(entries: &[Value]) -> String {
    let mut parent = Value::Null;
    let mut body = String::new();
    for entry in entries {
        let mut entry = entry.clone();
        entry["parentUuid"] = parent;
        entry["isSidechain"] = json!(false);
        parent = entry["uuid"].clone();
        body.push_str(&entry.to_string());
        body.push('\n');
    }
    body
}

fn user(uuid: &str, content: &str) -> Value {
    json!({"type":"user","uuid":uuid,"message":{"role":"user","content":content}})
}

fn answer(uuid: &str, id: &str, text: &str) -> Value {
    json!({"type":"assistant","uuid":uuid,"message":{"id":id,"role":"assistant","model":"claude-sonnet-5-5","content":[{"type":"text","text":text}],"stop_reason":"end_turn"}})
}

#[test]
fn reads_a_command_the_user_ran_as_one_done_between_turns() {
    let record = format!(
        "{}\n<bash-input>ls nope</bash-input>\n<bash-stdout>a &lt;b&gt; &amp;amp; c\n</bash-stdout><bash-stderr>ls: nope: No such file</bash-stderr>\n<bash-exit-code>2</bash-exit-code>",
        crate::claude_stream::RAN_CAVEAT
    );
    let body = entries(&[
        user("u-1", "List it"),
        answer("a-1", "msg_1", "Listed."),
        user("c-1", &record),
        user("u-2", "Why did it fail?"),
    ]);
    let (_home, path) = transcript("command", PROJECT, &body);
    assert_eq!(
        said(&read(&path)),
        [
            "message Sent u-1: List it",
            "turn started for [u-1] on claude-sonnet-5-5",
            "text msg_1#0: Listed.",
            "turn ended Done after None",
            r#"command c-1 Done ls nope exit Some(2): Some("a <b> &amp; c\nls: nope: No such file")"#,
            "message Sent u-2: Why did it fail?",
            "turn started for [u-2] on no model",
        ]
    );
}

#[test]
fn reads_a_command_written_in_two_entries_or_taken_while_a_turn_ran() {
    let caveat = "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>";
    let queued = |uuid: &str, source: &str, prompt: &str| json!({"type":"attachment","uuid":uuid,"attachment":{"type":"queued_command","prompt":prompt,"source_uuid":source,"commandMode":"prompt"}});
    let mut meta = user("m-1", caveat);
    meta["isMeta"] = json!(true);
    let body = entries(&[
        meta,
        user("b-1", "<bash-input>git status</bash-input>"),
        user(
            "b-2",
            "<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>",
        ),
        user("u-1", "Go on"),
        queued("q-0", "s-0", caveat),
        queued("q-1", "s-1", "<bash-input>echo hi</bash-input>"),
        queued(
            "q-2",
            "s-2",
            "<bash-stdout>hi</bash-stdout><bash-stderr></bash-stderr>",
        ),
        answer("a-1", "msg_1", "Going on."),
    ]);
    let (_home, path) = transcript("command-split", PROJECT, &body);
    let history = read(&path);
    assert_eq!(
        said(&history),
        [
            r#"command b-1 Done git status exit Some(0): Some("")"#,
            "message Sent u-1: Go on",
            "turn started for [u-1] on claude-sonnet-5-5",
            r#"command s-1 Done echo hi exit Some(0): Some("hi")"#,
            "text msg_1#0: Going on.",
            "turn ended Done after None",
        ]
    );
    assert_eq!(first_said(&path).as_deref(), Some("Go on"));
}
