use super::*;
use crate::integrated::ChangeKind;
use crate::scratch::Scratch;
use crate::transcripts::directory_for;

const PROJECT: &str = "/projects/demo";
const SESSION: &str = "5f0c2b1e-7a4d-4c1b-9e3f-2a6b8c0d1e2f";

const CONVERSATION: &str = include_str!("../fixtures/claude-history/conversation.jsonl");
const REWOUND: &str = include_str!("../fixtures/claude-history/rewound.jsonl");
const SUBAGENT: &str = include_str!("../fixtures/claude-history/subagent.jsonl");
const SUBAGENT_OWN: &str = include_str!("../fixtures/claude-history/subagent-agent.jsonl");

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
fn finds_nothing_for_an_id_that_is_not_one() {
    let (home, _) = transcript("bad-id", PROJECT, REWOUND);
    for id in ["", "../x", "a/b", "a b", "."] {
        assert_eq!(find(&home, Path::new(PROJECT), None, id), None, "{id}");
    }
}

#[test]
fn has_no_history_without_a_transcript() {
    let home = Scratch::new("claude-history-none");
    let history = read_session(&home, Path::new(PROJECT), None, SESSION);
    assert!(history.items.is_empty() && !history.cut);
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
    assert!(size <= HISTORY_KEEP);
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
    let output = "o".repeat(OUTPUT_KEEP + 10);
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
    assert!(truncated && output.len() <= OUTPUT_KEEP);
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
    ] {
        assert_eq!(millis(bad), None, "{bad}");
    }
}
