use std::collections::VecDeque;

use super::*;
use crate::integrated::{ChangeKind, ToolKind};

const THREAD: &str = "019a0000-0000-7000-8000-000000000001";

/// Codex as a test plays it: each request is checked against the method
/// expected next and answered as scripted, and every request is kept.
struct Scripted {
    answers: VecDeque<(&'static str, Answer)>,
    asked: Vec<(String, Value)>,
}

impl Scripted {
    fn new(answers: Vec<(&'static str, Answer)>) -> Self {
        Self {
            answers: answers.into(),
            asked: Vec::new(),
        }
    }
}

impl Ask for Scripted {
    fn ask(&mut self, method: &str, params: Value) -> Answer {
        self.asked.push((method.to_string(), params));
        match self.answers.pop_front() {
            Some((expected, answer)) => {
                assert_eq!(method, expected, "asked {method} out of turn");
                answer
            }
            None => Answer::Gone("nothing more was scripted".into()),
        }
    }
}

fn page(turns: Vec<Value>, next: Option<&str>) -> Answer {
    Answer::Result(json!({ "data": turns, "nextCursor": next, "backwardsCursor": null }))
}

fn turn(id: &str, status: &str, started: u64, items: Vec<Value>) -> Value {
    json!({
        "id": id,
        "status": status,
        "startedAt": started,
        "completedAt": if status == "inProgress" { Value::Null } else { json!(started + 2) },
        "durationMs": if status == "inProgress" { Value::Null } else { json!(1500) },
        "error": null,
        "itemsView": "full",
        "items": items,
    })
}

fn user(id: &str, client: Option<&str>, text: &str, at: u64) -> Value {
    json!({
        "type": "userMessage", "id": id, "clientId": client,
        "content": [{ "type": "text", "text": text, "text_elements": [] }],
        "startedAtMs": at, "completedAtMs": at,
    })
}

fn agent(id: &str, text: &str, at: u64) -> Value {
    json!({ "type": "agentMessage", "id": id, "text": text, "phase": null, "startedAtMs": at - 10, "completedAtMs": at })
}

fn command(id: &str, status: &str, at: u64) -> Value {
    json!({
        "type": "commandExecution", "id": id, "command": "/bin/sh -lc 'cargo test'",
        "cwd": "/work/demo", "commandActions": [], "status": status,
        "aggregatedOutput": if status == "inProgress" { Value::Null } else { json!("3 passed\n") },
        "exitCode": if status == "inProgress" { Value::Null } else { json!(0) },
        "durationMs": 40, "startedAtMs": at, "completedAtMs": if status == "inProgress" { Value::Null } else { json!(at + 40) },
    })
}

fn read_all(answers: Vec<(&'static str, Answer)>) -> (History, Scripted) {
    let mut codex = Scripted::new(answers);
    let history = read(&mut codex, THREAD, Path::new("/work/demo")).unwrap();
    (history, codex)
}

/// Each event as its kind and the id it goes by, with when it happened.
fn outline(history: &History) -> Vec<String> {
    history
        .items
        .iter()
        .map(|said| {
            let value = serde_json::to_value(&said.event).unwrap();
            let kind = value["type"].as_str().unwrap().to_string();
            let id = ["message", "block", "call"]
                .iter()
                .find_map(|key| value[key].as_str())
                .map(|id| format!(" {id}"))
                .unwrap_or_default();
            format!("{} {kind}{id}", said.at)
        })
        .collect()
}

#[test]
fn every_item_comes_back_as_the_event_a_live_session_sends_under_its_id() {
    let png = "iVBORw0KGgo=";
    let items = vec![
        json!({
            "type": "userMessage", "id": "item-u1", "clientId": "m-1",
            "content": [
                { "type": "text", "text": "Fix the build", "text_elements": [] },
                { "type": "image", "url": format!("data:image/png;base64,{png}"), "detail": null },
                { "type": "localImage", "path": "/work/demo/shot.png" },
                { "type": "image", "url": "https://example.com/remote.png" },
            ],
            "startedAtMs": 1_000_000, "completedAtMs": 1_000_000,
        }),
        json!({ "type": "hookPrompt", "id": "hook", "fragments": [] }),
        json!({ "type": "reasoning", "id": "rs", "summary": ["Looking.", "Found it."], "content": ["raw"], "startedAtMs": 1_000_100, "completedAtMs": 1_000_200 }),
        command("cmd", "completed", 1_000_300),
        json!({
            "type": "fileChange", "id": "edit", "status": "completed",
            "changes": [
                { "path": "/work/demo/notes.txt", "kind": { "type": "add" }, "diff": "hello\n" },
                { "path": "src/a.rs", "kind": { "type": "update", "move_path": null }, "diff": "@@ -1 +1 @@\n-a\n+b\n" },
            ],
            "startedAtMs": 1_000_400, "completedAtMs": 1_000_450,
        }),
        json!({
            "type": "mcpToolCall", "id": "mcp", "server": "agent_workbench", "tool": "show",
            "arguments": { "path": "a.rs" }, "status": "completed", "error": null,
            "result": { "content": [{ "type": "text", "text": "shown" }] },
            "startedAtMs": 1_000_500, "completedAtMs": 1_000_510,
        }),
        json!({ "type": "webSearch", "id": "web", "query": "rust", "action": null, "startedAtMs": 1_000_520, "completedAtMs": 1_000_530 }),
        json!({ "type": "plan", "id": "plan", "text": "1. Fix it", "startedAtMs": 1_000_540, "completedAtMs": 1_000_550 }),
        json!({ "type": "somethingNew", "id": "new", "startedAtMs": 1_000_560 }),
        json!({ "type": "subAgentActivity", "id": "sub", "agentPath": "x", "agentThreadId": "t", "kind": "started" }),
        agent("msg", "Fixed.", 1_000_600),
    ];
    let (history, codex) = read_all(vec![(
        "thread/turns/list",
        page(vec![turn("turn-1", "completed", 1_000, items)], None),
    )]);
    assert_eq!(
        outline(&history),
        [
            "1000000 message m-1",
            "1000000 turnStarted",
            "1000200 thinking rs:0",
            "1000200 thinking rs:1",
            "1000300 toolStarted cmd",
            "1000300 toolInput cmd",
            "1000340 toolFinished cmd",
            "1000400 toolStarted edit",
            "1000400 toolInput edit",
            "1000450 toolFinished edit",
            "1000500 toolStarted mcp",
            "1000500 toolInput mcp",
            "1000510 toolFinished mcp",
            "1000520 toolStarted web",
            "1000520 toolInput web",
            "1000530 toolFinished web",
            "1000550 plan",
            "1000600 text msg",
            "1002000 turnEnded",
        ]
    );
    let (method, params) = &codex.asked[0];
    assert_eq!(method, "thread/turns/list");
    assert_eq!(params["threadId"], THREAD);
    assert_eq!(params["sortDirection"], "desc");
    assert_eq!(params["itemsView"], "full");
    assert_eq!(params["cursor"], Value::Null);

    let events: Vec<&Event> = history.items.iter().map(|said| &said.event).collect();
    match events[0] {
        Event::Message {
            state,
            text,
            images,
            ..
        } => {
            assert_eq!(*state, MessageState::Sent);
            assert_eq!(text.as_deref(), Some("Fix the build"));
            assert_eq!(images.len(), 1, "the data URL alone is an image here");
            assert_eq!(images[0].media_type, "image/png");
            assert_eq!(images[0].data, png);
        }
        other => panic!("{other:?}"),
    }
    assert!(matches!(events[1], Event::TurnStarted { messages } if messages == &["m-1"]));
    assert!(
        matches!(events[4], Event::ToolStarted { name, kind: ToolKind::Command, .. } if name == "commandExecution")
    );
    assert!(
        matches!(events[6], Event::ToolFinished { output, error: false, .. } if output == "3 passed\n")
    );
    match events[9] {
        Event::ToolFinished { changes, error, .. } => {
            assert!(!error);
            assert_eq!(changes.len(), 2);
            assert_eq!(changes[0].kind, ChangeKind::Create);
            assert_eq!(changes[0].content.as_deref(), Some("hello\n"));
            assert_eq!(changes[1].kind, ChangeKind::Update);
            assert_eq!(
                Path::new(&changes[1].path),
                Path::new("/work/demo").join("src/a.rs"),
                "a relative path is the session's folder's"
            );
            assert_eq!(changes[1].hunks[0].lines, ["-a", "+b"]);
        }
        other => panic!("{other:?}"),
    }
    assert!(
        matches!(events[10], Event::ToolStarted { name, kind: ToolKind::Mcp, .. } if name == "mcp__agent_workbench__show")
    );
    assert!(matches!(events[12], Event::ToolFinished { output, .. } if output == "shown"));
    assert!(matches!(
        events[13],
        Event::ToolStarted {
            kind: ToolKind::Web,
            ..
        }
    ));
    assert!(matches!(events[16], Event::Plan { text: Some(text), .. } if text == "1. Fix it"));
    assert!(matches!(events[17], Event::Text { text, done: true, .. } if text == "Fixed."));
    assert!(matches!(
        events[18],
        Event::TurnEnded {
            outcome: Outcome::Done,
            error: None,
            duration_ms: Some(1500),
            ..
        }
    ));
    assert!(history.items.iter().all(|said| said.model.is_none()));
    assert!(!history.cut);
}

#[test]
fn turns_are_paged_newest_first_and_laid_oldest_first() {
    let (history, codex) = read_all(vec![
        (
            "thread/turns/list",
            page(
                vec![
                    turn(
                        "t3",
                        "completed",
                        3_000,
                        vec![
                            user("u3", Some("m-3"), "three", 3_000_000),
                            agent("a3", "3", 3_000_500),
                        ],
                    ),
                    turn(
                        "t2",
                        "completed",
                        2_000,
                        vec![
                            user("u2", Some("m-2"), "two", 2_000_000),
                            agent("a2", "2", 2_000_500),
                        ],
                    ),
                ],
                Some("after-t2"),
            ),
        ),
        (
            "thread/turns/list",
            page(
                vec![turn(
                    "t1",
                    "completed",
                    1_000,
                    vec![
                        user("u1", None, "one", 1_000_000),
                        agent("a1", "1", 1_000_500),
                    ],
                )],
                None,
            ),
        ),
    ]);
    assert_eq!(codex.asked[1].1["cursor"], "after-t2");
    let messages: Vec<String> = history
        .items
        .iter()
        .filter_map(|said| match &said.event {
            Event::Message { message, .. } => Some(message.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        messages,
        ["u1", "m-2", "m-3"],
        "a message the window did not send goes by Codex's own id"
    );
    let times: Vec<u64> = history.items.iter().map(|said| said.at).collect();
    assert!(times.windows(2).all(|pair| pair[0] <= pair[1]), "{times:?}");
}

#[test]
fn how_each_turn_ended_and_one_still_running() {
    let mut failed = turn(
        "t3",
        "failed",
        3_000,
        vec![
            user("u3", Some("m-3"), "three", 3_000_000),
            command("c3", "inProgress", 3_000_100),
        ],
    );
    failed["error"] =
        json!({ "message": "stream disconnected", "additionalDetails": "retry later" });
    let (history, _) = read_all(vec![(
        "thread/turns/list",
        page(
            vec![
                turn(
                    "t5",
                    "inProgress",
                    5_000,
                    vec![
                        user("u5", Some("m-5"), "five", 5_000_000),
                        command("c5", "inProgress", 5_000_100),
                    ],
                ),
                turn(
                    "t4",
                    "inProgress",
                    4_000,
                    vec![user("u4", Some("m-4"), "four", 4_000_000)],
                ),
                failed,
                turn(
                    "t2",
                    "interrupted",
                    2_000,
                    vec![user("u2", Some("m-2"), "two", 2_000_000)],
                ),
            ],
            None,
        ),
    )]);
    let ended: Vec<(Outcome, Option<String>)> = history
        .items
        .iter()
        .filter_map(|said| match &said.event {
            Event::TurnEnded { outcome, error, .. } => Some((*outcome, error.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        ended,
        [
            (Outcome::Interrupted, None),
            (
                Outcome::Failed,
                Some("stream disconnected: retry later".into())
            ),
            (Outcome::Interrupted, None),
        ],
        "an older turn Codex never ended is interrupted, the newest left open"
    );
    let finished = |call: &str| {
        history.items.iter().find_map(|said| match &said.event {
            Event::ToolFinished { call: c, error, .. } if c == call => Some(*error),
            _ => None,
        })
    };
    assert_eq!(
        finished("c3"),
        Some(true),
        "a call its ended turn left failed"
    );
    assert_eq!(finished("c5"), None, "the running turn's call is left open");
    assert!(matches!(
        history.items.last().unwrap().event,
        Event::ToolInput { ref call, .. } if call == "c5"
    ));
}

#[test]
fn a_turn_answers_the_message_before_the_agent_s_first_word_and_takes_the_rest() {
    let (history, _) = read_all(vec![(
        "thread/turns/list",
        page(
            vec![
                turn(
                    "t2",
                    "completed",
                    2_000,
                    vec![
                        json!({ "type": "contextCompaction", "id": "auto", "startedAtMs": 1_999_000, "completedAtMs": 1_999_500 }),
                        user("u2", Some("m-2"), "go on", 2_000_000),
                        agent("a2", "On it.", 2_000_200),
                        user("u3", Some("m-3"), "and this", 2_000_300),
                        agent("a3", "Both done.", 2_000_400),
                    ],
                ),
                turn(
                    "t1",
                    "completed",
                    1_000,
                    vec![
                        json!({ "type": "contextCompaction", "id": "asked", "startedAtMs": 1_000_000, "completedAtMs": 1_000_300 }),
                    ],
                ),
            ],
            None,
        ),
    )]);
    let kinds: Vec<String> = outline(&history)
        .into_iter()
        .map(|line| line.split_once(' ').unwrap().1.to_string())
        .collect();
    assert_eq!(
        kinds,
        [
            "turnStarted",
            "compacted",
            "turnEnded",
            "message m-2",
            "turnStarted",
            "compacted",
            "text a2",
            "message m-3",
            "text a3",
            "turnEnded",
        ]
    );
    let reasons: Vec<Option<CompactReason>> = history
        .items
        .iter()
        .filter_map(|said| match &said.event {
            Event::Compacted { reason, .. } => Some(*reason),
            _ => None,
        })
        .collect();
    assert_eq!(
        reasons,
        [Some(CompactReason::Asked), Some(CompactReason::Full)],
        "a turn of its own was asked for; one in the user's turn was the context being full"
    );
    assert!(
        matches!(&history.items[0].event, Event::TurnStarted { messages } if messages.is_empty())
    );
    assert!(matches!(
        &history.items[7].event,
        Event::Message { state: MessageState::Taken, text: Some(text), .. } if text == "and this"
    ));
}

#[test]
fn a_turn_too_long_comes_again_without_its_items_which_are_read_a_page_at_a_time() {
    let entry = |item: Value, at: u64| json!({ "turnId": "t1", "item": item, "startedAtMs": at, "completedAtMs": at + 5 });
    let mut bare = user("u1", Some("m-1"), "one", 0);
    bare["startedAtMs"] = Value::Null;
    bare["completedAtMs"] = Value::Null;
    let mut listed = turn("t1", "completed", 1_000, vec![]);
    listed["itemsView"] = json!("notLoaded");
    let (history, codex) = read_all(vec![
        ("thread/turns/list", Answer::TooLong),
        ("thread/turns/list", Answer::TooLong),
        ("thread/turns/list", page(vec![listed], None)),
        (
            "thread/items/list",
            Answer::Result(json!({
                "data": [entry(bare, 1_000_000), entry(agent("a1", "first", 1_000_100), 1_000_090)],
                "nextCursor": "after-a1",
            })),
        ),
        ("thread/items/list", Answer::TooLong),
        (
            "thread/items/list",
            Answer::Result(json!({
                "data": [entry(command("c1", "completed", 1_000_200), 1_000_200)],
                "nextCursor": "after-c1",
            })),
        ),
        ("thread/items/list", Answer::TooLong),
        ("thread/items/list", Answer::TooLong),
    ]);
    let asked = |at: usize| &codex.asked[at].1;
    let page_of = |at: usize| (asked(at)["limit"].clone(), asked(at)["itemsView"].clone());
    assert_eq!(page_of(0), (json!(TURNS_PAGE), json!("full")));
    assert_eq!(page_of(1), (json!(1), json!("full")));
    assert_eq!(page_of(2), (json!(1), json!("notLoaded")));
    assert_eq!(asked(2)["cursor"], Value::Null);
    let items = asked(3);
    assert_eq!(items["turnId"], "t1");
    assert_eq!(items["sortDirection"], "asc");
    assert_eq!(items["limit"], ITEMS_PAGE);
    assert_eq!(asked(4)["cursor"], "after-a1");
    assert_eq!(
        asked(5)["limit"],
        1,
        "a page too long is asked an item at a time"
    );
    assert_eq!(asked(6)["limit"], ITEMS_PAGE);
    assert_eq!(asked(7)["limit"], 1);
    assert_eq!(
        outline(&history),
        [
            "1000000 message m-1",
            "1000000 turnStarted",
            "1000100 text a1",
            "1000200 toolStarted c1",
            "1000200 toolInput c1",
            "1000240 toolFinished c1",
            "1002000 turnEnded",
        ],
        "the entry's times stand for an item with none; an item too long to read ends what is read"
    );
    assert!(!history.cut);
}

#[test]
fn a_page_too_long_comes_again_a_turn_at_a_time_with_its_items() {
    let (history, codex) = read_all(vec![
        ("thread/turns/list", Answer::TooLong),
        (
            "thread/turns/list",
            page(
                vec![turn(
                    "t2",
                    "completed",
                    2_000,
                    vec![user("u2", Some("m-2"), "two", 2_000_000)],
                )],
                Some("after-t2"),
            ),
        ),
        (
            "thread/turns/list",
            page(
                vec![turn(
                    "t1",
                    "completed",
                    1_000,
                    vec![user("u1", Some("m-1"), "one", 1_000_000)],
                )],
                None,
            ),
        ),
    ]);
    let asked: Vec<(Value, Value, Value)> = codex
        .asked
        .iter()
        .map(|(_, params)| {
            (
                params["limit"].clone(),
                params["itemsView"].clone(),
                params["cursor"].clone(),
            )
        })
        .collect();
    assert_eq!(
        asked,
        [
            (json!(TURNS_PAGE), json!("full"), Value::Null),
            (json!(1), json!("full"), Value::Null),
            (json!(TURNS_PAGE), json!("full"), json!("after-t2")),
        ],
        "a thread kept the older way, which has no items of a turn alone, is read this way"
    );
    assert!(!history.cut);
    assert_eq!(history.items.len(), 6);
}

#[test]
fn the_newest_turn_is_left_open_while_codex_gives_it_no_end() {
    // A turn that still runs, read from a process of Codex's own, comes
    // back as interrupted with no time it completed and none it took.
    let unended = |id: &str, at: u64, message: &str| {
        let mut turn = turn(
            id,
            "interrupted",
            at,
            vec![user(
                &format!("u-{message}"),
                Some(message),
                "go",
                at * 1000,
            )],
        );
        turn["completedAt"] = Value::Null;
        turn["durationMs"] = Value::Null;
        turn
    };
    let (history, _) = read_all(vec![(
        "thread/turns/list",
        page(
            vec![unended("t2", 2_000, "m-2"), unended("t1", 1_000, "m-1")],
            None,
        ),
    )]);
    let kinds: Vec<String> = outline(&history)
        .into_iter()
        .map(|line| line.split_once(' ').unwrap().1.to_string())
        .collect();
    assert_eq!(
        kinds,
        [
            "message m-1",
            "turnStarted",
            "turnEnded",
            "message m-2",
            "turnStarted"
        ],
        "an older turn with no end was interrupted; the newest is left to the session"
    );
    assert!(matches!(
        history.items[2].event,
        Event::TurnEnded {
            outcome: Outcome::Interrupted,
            ..
        }
    ));

    // One that was interrupted has an end, and ends so.
    let (history, _) = read_all(vec![(
        "thread/turns/list",
        page(
            vec![turn(
                "t3",
                "interrupted",
                3_000,
                vec![user("u3", Some("m-3"), "three", 3_000_000)],
            )],
            None,
        ),
    )]);
    assert!(matches!(
        history.items.last().unwrap().event,
        Event::TurnEnded {
            outcome: Outcome::Interrupted,
            ..
        }
    ));
}

#[test]
fn a_turn_that_cannot_be_read_ends_the_reading_with_what_was_read() {
    let mut listed = turn("t1", "completed", 1_000, vec![]);
    listed["itemsView"] = json!("notLoaded");
    let (history, _) = read_all(vec![
        (
            "thread/turns/list",
            page(
                vec![turn(
                    "t2",
                    "completed",
                    2_000,
                    vec![user("u2", Some("m-2"), "two", 2_000_000)],
                )],
                Some("after-t2"),
            ),
        ),
        ("thread/turns/list", Answer::TooLong),
        ("thread/turns/list", Answer::TooLong),
        ("thread/turns/list", page(vec![listed], None)),
        (
            "thread/items/list",
            Answer::Refused("thread/items/list is not supported yet".into()),
        ),
    ]);
    assert!(history.cut, "what is left out is the start");
    assert_eq!(
        outline(&history),
        [
            "2000000 message m-2",
            "2000000 turnStarted",
            "2002000 turnEnded"
        ]
    );
}

#[test]
fn a_thread_codex_cannot_read_is_an_error_and_a_later_failure_keeps_what_was_read() {
    let mut codex = Scripted::new(vec![(
        "thread/turns/list",
        Answer::Refused(format!("thread not loaded: {THREAD}")),
    )]);
    let error = read(&mut codex, THREAD, Path::new("/work/demo")).unwrap_err();
    assert_eq!(error, "Codex does not have this conversation");
    // A Codex too old to page through a thread names every method it has.
    let older = format!(
        "Invalid request: unknown variant `thread/turns/list`, expected one of {}",
        "`a`, ".repeat(2000)
    );
    let mut codex = Scripted::new(vec![("thread/turns/list", Answer::Refused(older))]);
    let error = read(&mut codex, THREAD, Path::new("/work/demo")).unwrap_err();
    assert_eq!(error, "this version of Codex cannot give them back");
    // Anything else is said on one short line.
    let long = format!("{}.\nand more", "x".repeat(500));
    let mut codex = Scripted::new(vec![("thread/turns/list", Answer::Refused(long))]);
    let error = read(&mut codex, THREAD, Path::new("/work/demo")).unwrap_err();
    assert_eq!(error, format!("{}…", "x".repeat(WHY_KEEP)));

    let mut codex = Scripted::new(vec![(
        "thread/turns/list",
        Answer::Result(json!({ "nothing": [] })),
    )]);
    assert!(read(&mut codex, THREAD, Path::new("/work/demo")).is_err());

    let (history, _) = read_all(vec![
        (
            "thread/turns/list",
            page(
                vec![turn(
                    "t2",
                    "completed",
                    2_000,
                    vec![user("u2", Some("m-2"), "two", 2_000_000)],
                )],
                Some("after-t2"),
            ),
        ),
        (
            "thread/turns/list",
            Answer::Gone("Codex did not answer in time".into()),
        ),
    ]);
    assert!(history.cut);
    assert_eq!(history.items.len(), 3);

    let (empty, _) = read_all(vec![("thread/turns/list", page(vec![], None))]);
    assert!(
        empty.items.is_empty() && !empty.cut,
        "a thread with no turns has nothing to say"
    );
}

#[test]
fn a_history_longer_than_it_may_hold_leaves_out_its_oldest_turns() {
    let long = "x".repeat(History::KEEP / 3);
    let turns: Vec<Value> = (1..=6u64)
        .rev()
        .map(|n| {
            turn(
                &format!("t{n}"),
                "completed",
                n * 1_000,
                vec![
                    user(
                        &format!("u{n}"),
                        Some(&format!("m-{n}")),
                        "go",
                        n * 1_000_000,
                    ),
                    agent(&format!("a{n}"), &long, n * 1_000_000 + 500),
                ],
            )
        })
        .collect();
    let (history, codex) = read_all(vec![("thread/turns/list", page(turns, Some("more")))]);
    assert!(history.cut);
    assert_eq!(codex.asked.len(), 1, "no more is asked once it is full");
    let size: usize = history.items.iter().map(Said::size).sum();
    assert!(size <= History::KEEP, "{size}");
    assert!(matches!(&history.items[0].event, Event::Message { message, .. } if message == "m-5"));
    assert!(
        matches!(&history.items[history.items.len() - 4].event, Event::Message { message, .. } if message == "m-6")
    );

    // The newest turn is kept whatever its size, each of its items cut down.
    let huge = "y".repeat(History::TEXT_KEEP * 2);
    let (history, _) = read_all(vec![(
        "thread/turns/list",
        page(
            vec![
                turn(
                    "t2",
                    "completed",
                    2_000,
                    vec![agent("a2", &huge, 2_000_500), agent("b2", &huge, 2_000_600)],
                ),
                turn(
                    "t1",
                    "completed",
                    1_000,
                    vec![agent("a1", "one", 1_000_500)],
                ),
            ],
            None,
        ),
    )]);
    assert!(history.cut);
    let texts: Vec<usize> = history
        .items
        .iter()
        .filter_map(|said| match &said.event {
            Event::Text { text, .. } => Some(text.len()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, [History::TEXT_KEEP, History::TEXT_KEEP]);
}

#[test]
fn what_has_no_time_takes_its_turn_s_or_the_first_known() {
    let mut first = user("item-1", Some("m-1"), "one", 0);
    first["startedAtMs"] = Value::Null;
    first["completedAtMs"] = Value::Null;
    let mut said = agent("item-2", "pong", 100);
    said["startedAtMs"] = Value::Null;
    said["completedAtMs"] = Value::Null;
    let mut legacy = turn("t1", "completed", 1_000, vec![first, said]);
    legacy["startedAt"] = json!(1_000);
    let mut untimed = turn("t0", "completed", 0, vec![agent("item-0", "older", 100)]);
    untimed["startedAt"] = Value::Null;
    untimed["completedAt"] = Value::Null;
    untimed["items"][0]["startedAtMs"] = Value::Null;
    untimed["items"][0]["completedAtMs"] = Value::Null;
    let (history, _) = read_all(vec![(
        "thread/turns/list",
        page(vec![legacy, untimed], None),
    )]);
    let times: Vec<u64> = history.items.iter().map(|said| said.at).collect();
    assert!(
        times.iter().all(|at| *at == 1_000_000 || *at == 1_002_000),
        "{times:?}"
    );
}

#[test]
fn a_request_that_names_no_project_or_thread_reads_nothing() {
    let nowhere = HashMap::from([("PATH".to_string(), "/nowhere".to_string())]);
    let wait = Duration::from_secs(5);
    for (project, thread) in [
        ("", THREAD),
        ("/work/demo", ""),
        ("/work/demo", "../x"),
        ("/work/demo", "s1"),
    ] {
        let history = read_within(&nowhere, None, Path::new(project), None, thread, wait).unwrap();
        assert!(history.items.is_empty() && !history.cut);
    }
    let error =
        read_within(&nowhere, None, Path::new("/work/demo"), None, THREAD, wait).unwrap_err();
    assert_eq!(error, "codex is not on your PATH");
}

#[test]
fn an_answer_too_long_to_read_is_named_by_the_start_of_its_line() {
    assert_eq!(answered(br#"{"id":12,"result":{"data":[{"#), Some(12));
    assert_eq!(answered(br#"{"method":"item/completed","params""#), None);
    assert_eq!(answered(br#"{"id":12"#), None, "a start cut inside the id");
    assert_eq!(answered(br#"{"id":"text","result""#), None);
}

#[test]
fn only_a_data_url_is_an_image_here() {
    let image = data_image("data:image/webp;base64,AAAA").unwrap();
    assert_eq!(
        (image.media_type.as_str(), image.data.as_str()),
        ("image/webp", "AAAA")
    );
    assert!(data_image("data:text/plain;base64,AAAA").is_none());
    assert!(data_image("https://example.com/a.png").is_none());
}
