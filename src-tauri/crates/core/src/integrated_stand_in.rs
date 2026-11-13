//! Integrated sessions end to end, against a stand-in for `claude`.
//!
//! The stand-in is a shell script on a PATH of its own that plays a
//! scenario a step a line: `say` writes a line to its stdout, `expect`
//! reads its stdin until a line holds the given text, `reply` writes a line
//! with `@ID@` replaced by the request id of the line last expected,
//! `sleep`, `exit` and `die` do what they say, and `drain` reads until stdin
//! closes. It writes its arguments, its environment and every line it read
//! beside the scenario, for the tests to look at.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::*;
use crate::claude_stream::CLAUDE_STREAM;
use crate::events::testing::Recorder;

const STAND_IN: &str = r#"#!/bin/sh
dir=$(dirname "$FAKE_CLAUDE_SCENARIO")
printf '%s\n' "$@" > "$dir/args"
env > "$dir/env"
exec 3<&0
id=
while IFS= read -r step || [ -n "$step" ]; do
  case "$step" in
    "say "*) printf '%s\n' "${step#say }" ;;
    "reply "*) printf '%s\n' "${step#reply }" | sed "s/@ID@/$id/g" ;;
    "expect "*)
      want=${step#expect }
      got=
      while IFS= read -r got <&3; do
        printf '%s\n' "$got" >> "$dir/stdin"
        case "$got" in *"$want"*) break ;; esac
      done
      id=$(printf '%s' "$got" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p') ;;
    "sleep "*) sleep "${step#sleep }" ;;
    "exit "*) exit "${step#exit }" ;;
    "die") kill -9 $$ ;;
    "drain") while IFS= read -r got <&3; do printf '%s\n' "$got" >> "$dir/stdin"; done ;;
  esac
done < "$FAKE_CLAUDE_SCENARIO"
"#;

/// The opening every scenario starts with: the initialize request
/// answered with what the agent says about itself.
const READY: &str = r#"expect "subtype":"initialize"
reply {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"account":{"apiProvider":"firstParty","subscriptionType":"pro"},"current_permission_mode":"default","claude_code_version":"9.9.9","models":[{"value":"haiku","displayName":"Haiku"}],"commands":[]}}}"#;

const INIT: &str = r#"say {"type":"system","subtype":"init","model":"claude-haiku","permissionMode":"default","session_id":"s"}"#;

const DONE: &str = r#"say {"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.01,"duration_ms":5,"usage":{"input_tokens":3,"output_tokens":4}}"#;

struct Harness {
    dir: PathBuf,
    sessions: Arc<Sessions>,
    recorder: Arc<Recorder>,
    id: String,
    session: String,
}

fn start(name: &str, scenario: &str) -> Harness {
    start_with(name, scenario, |_| {})
}

fn start_with(name: &str, scenario: &str, adjust: impl FnOnce(&mut Launch)) -> Harness {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!(
        "workbench-integrated-{name}-{}",
        std::process::id()
    ));
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).unwrap();
    let claude = dir.join("claude");
    std::fs::write(&claude, STAND_IN).unwrap();
    std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(dir.join("scenario"), scenario).unwrap();

    let vars = HashMap::from([
        (
            "PATH".to_string(),
            format!("{}:/usr/bin:/bin", dir.display()),
        ),
        (
            "FAKE_CLAUDE_SCENARIO".to_string(),
            dir.join("scenario").to_string_lossy().to_string(),
        ),
        ("CLAUDECODE".to_string(), "1".to_string()),
        ("WORKBENCH_SESSION".to_string(), "the-parent".to_string()),
        ("KEEP_ME".to_string(), "yes".to_string()),
    ]);
    let recorder = Arc::new(Recorder::default());
    let sessions = Arc::new(Sessions::default());
    let session = format!("session-{name}");
    let mut launch = Launch {
        project: &dir,
        env: &vars,
        session: &session,
        resume: false,
        model: Some("haiku"),
        permission_mode: Some("default"),
        config_dir: None,
        tool_server: None,
        orchestrator: false,
    };
    adjust(&mut launch);
    let started = super::start(
        recorder.clone(),
        Arc::clone(&sessions),
        &CLAUDE_STREAM,
        &launch,
        Box::new(|_| {}),
    )
    .unwrap();
    assert_eq!(started.session_id, session);
    Harness {
        dir,
        sessions,
        recorder,
        id: started.id,
        session,
    }
}

impl Harness {
    fn events(&self) -> Vec<Value> {
        self.recorder
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, payload)| name == INTEGRATED_EVENT && payload["id"] == self.id)
            .map(|(_, payload)| payload.clone())
            .collect()
    }

    /// Waits for an event, and hands back every event up to and with it.
    fn until(&self, what: impl Fn(&Value) -> bool) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let events = self.events();
            if let Some(at) = events.iter().position(&what) {
                return events[..=at].to_vec();
            }
            assert!(
                Instant::now() < deadline,
                "never came; the session said {events:#?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Waits until the session has told `n` states, and hands them back.
    fn until_states(&self, n: usize) -> Vec<String> {
        self.until(|_| states(&self.events()).len() >= n);
        states(&self.events())
    }

    fn until_type(&self, kind: &str) -> Vec<Value> {
        self.until(|event| event["type"] == kind)
    }

    fn stdin(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.join("stdin"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    fn send(&self, text: &str) -> String {
        send(&self.sessions, &self.id, text, &[]).unwrap()
    }

    fn stop(&self) -> Value {
        stop(&self.sessions, &self.id).unwrap();
        self.until_type("ended").pop().unwrap()
    }
}

fn kinds(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .map(|event| event["type"].as_str().unwrap_or_default().to_string())
        .collect()
}

fn states(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter(|event| event["type"] == "state")
        .map(|event| event["state"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_text_turn_streams_and_ends_and_the_session_stops_cleanly() {
    let scenario = [
        READY,
        r#"expect "type":"user""#,
        INIT,
        r#"say {"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}},"parent_tool_use_id":null}"#,
        r#"say {"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"parent_tool_use_id":null}"#,
        r#"say {"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hel"}},"parent_tool_use_id":null}"#,
        r#"say {"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}},"parent_tool_use_id":null}"#,
        r#"say {"type":"stream_event","event":{"type":"content_block_stop","index":0},"parent_tool_use_id":null}"#,
        r#"say {"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"hello"}]},"parent_tool_use_id":null}"#,
        DONE,
        "drain",
    ]
    .join("\n");
    let h = start("text", &scenario);
    let ready = h.until_type("ready");
    assert_eq!(ready[0]["sessionId"], h.session);
    assert_eq!(ready[0]["version"], "9.9.9");
    assert_eq!(ready[0]["permissionMode"], "default");

    let message = h.send("say hello");
    let events = h.until_type("turnEnded");
    assert_eq!(
        kinds(&events),
        [
            "ready",
            "state",
            "state",
            "turnStarted",
            "configured",
            "text",
            "text",
            "text",
            "turnEnded"
        ]
    );
    assert_eq!(states(&events), ["idle", "working"]);
    assert_eq!(events[3]["message"], message.as_str());
    assert_eq!(events[4]["model"], "claude-haiku");
    assert_eq!(events[7]["text"], "hello");
    assert_eq!(events[7]["done"], true);
    assert_eq!(events[5]["block"], events[7]["block"]);
    let ended = &events[8];
    assert_eq!(ended["outcome"], "done");
    assert_eq!(ended["costUsd"], 0.01);
    assert_eq!(ended["usage"]["outputTokens"], 4);
    assert_eq!(h.until_states(3), ["idle", "working", "idle"]);

    let sent = h.stdin();
    assert_eq!(sent[1]["type"], "user");
    assert_eq!(sent[1]["message"]["content"], "say hello");

    let end = h.stop();
    assert_eq!(end["clean"], true);
    assert!(!kinds(&h.events()).contains(&"error".to_string()));
    assert!(!h.sessions.holds(&h.id));
}

#[test]
fn the_command_line_and_environment_are_the_stream_session_s() {
    let server = PathBuf::from("/opt/workbench/agent-workbench-remote");
    let config = PathBuf::from("/home/ada/.claude-work");
    let h = start_with("command", &format!("{READY}\ndrain"), |launch| {
        launch.resume = true;
        launch.tool_server = Some(Box::leak(server.clone().into_boxed_path()));
        launch.config_dir = Some(Box::leak(config.clone().into_boxed_path()));
        launch.orchestrator = true;
    });
    h.until_type("ready");
    let args: Vec<String> = std::fs::read_to_string(h.dir.join("args"))
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect();
    for flag in [
        "-p",
        "--verbose",
        "--include-partial-messages",
        "--forward-subagent-text",
        "--permission-prompt-tool",
    ] {
        assert!(args.contains(&flag.to_string()), "{flag} in {args:?}");
    }
    assert!(!args.contains(&"--bare".to_string()));
    let after = |flag: &str| {
        let at = args.iter().position(|arg| arg == flag).unwrap();
        args[at + 1].clone()
    };
    assert_eq!(after("--resume"), h.session);
    assert_eq!(after("--model"), "haiku");
    assert_eq!(after("--permission-mode"), "default");
    let mcp: Value = serde_json::from_str(&after("--mcp-config")).unwrap();
    assert_eq!(
        mcp["mcpServers"]["agent-workbench"],
        json!({"type": "stdio", "command": server.to_string_lossy(), "args": ["mcp"]})
    );

    let env = std::fs::read_to_string(h.dir.join("env")).unwrap();
    let has = |line: &str| env.lines().any(|l| l == line);
    assert!(!env.lines().any(|l| l.starts_with("CLAUDECODE=")), "{env}");
    assert!(has(&format!("WORKBENCH_SESSION={}", h.session)), "{env}");
    assert!(has("WORKBENCH_ROLE=orchestrator"), "{env}");
    assert!(
        has(&format!("CLAUDE_CONFIG_DIR={}", config.display())),
        "{env}"
    );
    assert!(has("KEEP_ME=yes"), "{env}");
    assert!(!env.lines().any(|l| l.starts_with("ANTHROPIC_API_KEY=")));
    h.stop();
}

#[test]
fn a_tool_call_finishes_with_its_file_change() {
    let scenario = [
        READY,
        r#"expect "type":"user""#,
        INIT,
        r#"say {"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"/p/notes.txt","content":"one\n"}}]},"parent_tool_use_id":null}"#,
        r#"say {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"File created"}]},"parent_tool_use_id":null,"tool_use_result":{"type":"create","filePath":"/p/notes.txt","content":"one\n","structuredPatch":[],"originalFile":null}}"#,
        DONE,
        "drain",
    ]
    .join("\n");
    let h = start("tool", &scenario);
    h.until_type("ready");
    h.send("write notes");
    let events = h.until_type("turnEnded");
    let started = events.iter().find(|e| e["type"] == "toolStarted").unwrap();
    assert_eq!(started["name"], "Write");
    let input = events.iter().find(|e| e["type"] == "toolInput").unwrap();
    assert_eq!(input["input"]["file_path"], "/p/notes.txt");
    let finished = events.iter().find(|e| e["type"] == "toolFinished").unwrap();
    assert_eq!(finished["call"], "t1");
    assert_eq!(finished["output"], "File created");
    assert_eq!(finished["change"]["kind"], "create");
    assert_eq!(finished["change"]["path"], "/p/notes.txt");
    assert_eq!(finished["change"]["content"], "one\n");
    h.stop();
}

#[test]
fn each_answer_to_a_permission_reaches_the_agent() {
    let ask = |id: &str| {
        format!(
            r#"say {{"type":"control_request","request_id":"{id}","request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{{"command":"touch {id}"}},"tool_use_id":"call-{id}","permission_suggestions":[{{"type":"addRules","rules":[{{"toolName":"Bash","ruleContent":"touch {id}"}}],"behavior":"allow","destination":"localSettings"}}]}}}}"#
        )
    };
    let mut scenario = vec![
        READY.to_string(),
        r#"expect "type":"user""#.into(),
        INIT.into(),
    ];
    for id in ["p1", "p2", "p3", "p4"] {
        scenario.push(ask(id));
        scenario.push(format!(r#"expect "request_id":"{id}""#));
    }
    scenario.push(DONE.into());
    scenario.push("drain".into());
    let h = start("permission", &scenario.join("\n"));
    h.until_type("ready");
    h.send("touch four files");
    let answers = [
        ("p1", Choice::Allow, None),
        ("p2", Choice::AllowSession, None),
        ("p3", Choice::AllowAlways, None),
        ("p4", Choice::Deny, Some("not that one")),
    ];
    for (request, choice, message) in answers {
        let asked = h.until(|e| e["type"] == "permissionAsked" && e["request"] == request);
        let asked = asked.last().unwrap();
        assert_eq!(asked["tool"], "Bash");
        assert_eq!(asked["call"], format!("call-{request}"));
        assert_eq!(
            asked["choices"][1],
            json!({
                "choice": "allowSession",
                "remembers": format!("Bash(touch {request}) for the rest of this session"),
                "message": false,
            })
        );
        assert_eq!(states(&h.events()).last().unwrap(), "asking");
        answer(&h.sessions, &h.id, request, choice, message).unwrap();
        assert_eq!(states(&h.events()).last().unwrap(), "working");
    }
    let events = h.until_type("turnEnded");
    assert_eq!(
        states(&events),
        [
            "idle", "working", "asking", "working", "asking", "working", "asking", "working",
            "asking", "working"
        ]
    );

    let answered: HashMap<String, Value> = h
        .stdin()
        .into_iter()
        .filter(|line| line["type"] == "control_response")
        .map(|line| {
            let id = line["response"]["request_id"].as_str().unwrap().to_string();
            (id, line["response"]["response"].clone())
        })
        .collect();
    assert_eq!(answered["p1"]["behavior"], "allow");
    assert_eq!(answered["p1"]["updatedInput"]["command"], "touch p1");
    assert!(answered["p1"].get("updatedPermissions").is_none());
    assert_eq!(
        answered["p2"]["updatedPermissions"][0]["destination"],
        "session"
    );
    assert_eq!(
        answered["p3"]["updatedPermissions"][0]["destination"],
        "localSettings"
    );
    assert_eq!(answered["p4"]["behavior"], "deny");
    assert_eq!(answered["p4"]["message"], "not that one");

    assert!(
        answer(&h.sessions, &h.id, "p1", Choice::Allow, None).is_err(),
        "a request is answered once"
    );
    h.stop();
}

#[test]
fn an_interrupt_withdraws_what_was_asked_and_ends_the_turn() {
    let scenario = [
        READY,
        r#"expect "type":"user""#,
        INIT,
        r#"say {"type":"control_request","request_id":"p1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"sleep 100"}}}"#,
        r#"expect "subtype":"interrupt""#,
        r#"say {"type":"control_cancel_request","request_id":"p1"}"#,
        r#"reply {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"still_queued":[]}}}"#,
        r#"say {"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"parent_tool_use_id":null}"#,
        r#"say {"type":"result","subtype":"error_during_execution","is_error":true,"result":""}"#,
        "drain",
    ]
    .join("\n");
    let h = start("interrupt", &scenario);
    h.until_type("ready");
    h.send("run something slow");
    h.until_type("permissionAsked");
    control(&h.sessions, &h.id, &Control::Interrupt).unwrap();
    let events = h.until_type("turnEnded");
    let withdrawn = events
        .iter()
        .find(|e| e["type"] == "permissionWithdrawn")
        .unwrap();
    assert_eq!(withdrawn["request"], "p1");
    assert_eq!(events.last().unwrap()["outcome"], "interrupted");
    assert_eq!(events.last().unwrap()["error"], Value::Null);
    assert_eq!(
        h.until_states(5),
        ["idle", "working", "asking", "working", "idle"]
    );
    h.stop();
}

#[test]
fn the_model_and_the_permission_mode_change_on_request() {
    let scenario = [
        READY,
        r#"expect "subtype":"set_model""#,
        r#"reply {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"model":"claude-sonnet"}}}"#,
        r#"expect "subtype":"set_model""#,
        r#"reply {"type":"control_response","response":{"subtype":"error","request_id":"@ID@","error":"Model 'no-such' not found"}}"#,
        r#"expect "subtype":"set_permission_mode""#,
        r#"reply {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"mode":"acceptEdits"}}}"#,
        "drain",
    ]
    .join("\n");
    let h = start("model", &scenario);
    h.until_type("ready");
    let api = |model: &str| control(&h.sessions, &h.id, &Control::SetModel(model.into()));
    assert_eq!(api("sonnet").unwrap()["model"], "claude-sonnet");
    assert_eq!(api("no-such").unwrap_err(), "Model 'no-such' not found");
    let mode = control(
        &h.sessions,
        &h.id,
        &Control::SetPermissionMode("acceptEdits".into()),
    )
    .unwrap();
    assert_eq!(mode["mode"], "acceptEdits");
    let configured: Vec<Value> = h
        .events()
        .into_iter()
        .filter(|e| e["type"] == "configured")
        .collect();
    assert_eq!(configured.len(), 2, "{configured:?}");
    assert_eq!(configured[0]["model"], "claude-sonnet");
    assert_eq!(configured[1]["model"], "claude-sonnet");
    assert_eq!(configured[1]["permissionMode"], "acceptEdits");
    h.stop();
}

#[test]
fn a_subagent_s_messages_and_the_turn_the_agent_starts_after_it() {
    let scenario = [
        READY,
        r#"expect "type":"user""#,
        INIT,
        r#"say {"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"agent-call","name":"Agent","input":{"prompt":"find it"}}]},"parent_tool_use_id":null}"#,
        r#"say {"type":"system","subtype":"task_started","task_id":"a1","tool_use_id":"agent-call","description":"find it","task_type":"local_agent","is_backgrounded":true,"prompt":"find it"}"#,
        r#"say {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"agent-call","content":"launched"}]},"parent_tool_use_id":null,"tool_use_result":{"isAsync":true,"status":"async_launched","agentId":"a1"}}"#,
        DONE,
        r#"say {"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","id":"grep-call","name":"Grep","input":{"pattern":"x"}}]},"parent_tool_use_id":"agent-call"}"#,
        r#"say {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"grep-call","content":"a.rs"}]},"parent_tool_use_id":"agent-call"}"#,
        r#"say {"type":"assistant","message":{"id":"m3","content":[{"type":"text","text":"found it in a.rs"}]},"parent_tool_use_id":"agent-call"}"#,
        r#"say {"type":"system","subtype":"task_progress","task_id":"a1","last_tool_name":"Grep"}"#,
        r#"say {"type":"system","subtype":"task_notification","task_id":"a1","status":"completed","summary":"found it"}"#,
        INIT,
        r#"say {"type":"assistant","message":{"id":"m4","content":[{"type":"text","text":"The subagent found it."}]},"parent_tool_use_id":null}"#,
        DONE,
        "drain",
    ]
    .join("\n");
    let h = start("subagent", &scenario);
    h.until_type("ready");
    let message = h.send("find it with a helper");
    let events = h.until(|e| e["type"] == "text" && e["text"] == "The subagent found it.");

    let turns: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "turnStarted")
        .collect();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0]["message"], message.as_str());
    assert_eq!(
        turns[1]["message"],
        Value::Null,
        "the agent began the second"
    );

    let of_subagent: Vec<&Value> = events
        .iter()
        .filter(|e| e["parent"] == "agent-call")
        .collect();
    assert_eq!(
        of_subagent
            .iter()
            .map(|e| e["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["toolStarted", "toolInput", "toolFinished", "text"]
    );
    let progress = events.iter().find(|e| e["type"] == "taskProgress").unwrap();
    assert_eq!(progress["call"], "agent-call");
    let finished = events.iter().find(|e| e["type"] == "taskFinished").unwrap();
    assert_eq!(finished["summary"], "found it");

    // Working from the message to the end of the agent's own turn, with no
    // idle while the subagent ran after the first turn ended.
    assert_eq!(h.until_states(3), ["idle", "working", "idle"]);
    h.stop();
}

#[test]
fn a_message_sent_during_a_turn_is_queued_and_gets_its_own_turn() {
    let scenario = [
        READY,
        r#"expect "first""#,
        INIT,
        r#"expect "second""#,
        DONE,
        INIT,
        DONE,
        "drain",
    ]
    .join("\n");
    let h = start("queued", &scenario);
    h.until_type("ready");
    let first = h.send("first");
    h.until_type("turnStarted");
    let second = h.send("second");
    let queued = h.until_type("messageQueued");
    assert_eq!(queued.last().unwrap()["message"], second.as_str());
    h.until(|_| {
        h.events()
            .iter()
            .filter(|e| e["type"] == "turnEnded")
            .count()
            == 2
    });
    let started: Vec<Value> = h
        .events()
        .into_iter()
        .filter(|e| e["type"] == "turnStarted")
        .map(|e| e["message"].clone())
        .collect();
    assert_eq!(started, [json!(first), json!(second)]);
    h.stop();
}

#[test]
fn unknown_lines_are_skipped_and_unhandled_requests_refused() {
    let scenario = [
        READY,
        r#"expect "type":"user""#,
        "say this is not json",
        r#"say {"type":"from_a_later_version","with":{"fields":[1,2]}}"#,
        r#"say {"type":"system","subtype":"something_new","x":1}"#,
        r#"say {"type":"assistant","message":"not an object"}"#,
        r#"say {"type":"control_request","request_id":"h1","request":{"subtype":"hook_callback","callback_id":"x"}}"#,
        r#"expect "request_id":"h1""#,
        INIT,
        r#"say {"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"still here","citations":[]}],"some_new_field":true},"parent_tool_use_id":null,"another":1}"#,
        DONE,
        "drain",
    ]
    .join("\n");
    let h = start("unknown", &scenario);
    h.until_type("ready");
    h.send("are you there");
    let events = h.until_type("turnEnded");
    assert!(events
        .iter()
        .any(|e| e["type"] == "text" && e["text"] == "still here"));
    assert!(!kinds(&events).contains(&"error".to_string()), "{events:?}");
    let refused = h
        .stdin()
        .into_iter()
        .find(|line| line["response"]["request_id"] == "h1")
        .unwrap();
    assert_eq!(refused["response"]["subtype"], "error");
    h.stop();
}

#[test]
fn a_process_that_dies_mid_turn_fails_the_turn_and_says_so() {
    let scenario = [
        READY,
        r#"expect "type":"user""#,
        INIT,
        r#"say {"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}},"parent_tool_use_id":null}"#,
        r#"say {"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"parent_tool_use_id":null}"#,
        r#"say {"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"half"}},"parent_tool_use_id":null}"#,
        "die",
    ]
    .join("\n");
    let h = start("dies", &scenario);
    h.until_type("ready");
    h.send("go");
    let events = h.until_type("ended");
    let tail = &kinds(&events)[kinds(&events).len() - 3..];
    assert_eq!(tail, ["turnEnded", "error", "ended"]);
    let n = events.len();
    assert_eq!(events[n - 3]["outcome"], "failed");
    assert_eq!(events[n - 2]["kind"], "process");
    assert_eq!(events[n - 1]["clean"], false);
    assert!(!h.sessions.holds(&h.id));
    assert!(send(&h.sessions, &h.id, "anyone?", &[]).is_err());
}

#[test]
fn a_session_that_will_not_end_is_killed_without_an_error() {
    let h = start("stubborn", &format!("{READY}\nsleep 60"));
    h.until_type("ready");
    let started = Instant::now();
    let end = h.stop();
    assert!(started.elapsed() < Duration::from_secs(12));
    assert_eq!(end["clean"], false);
    assert!(!kinds(&h.events()).contains(&"error".to_string()));
}

#[test]
fn a_missing_agent_explains_itself() {
    let vars = HashMap::from([("PATH".to_string(), "/nowhere".to_string())]);
    let launch = Launch {
        project: std::path::Path::new("/tmp"),
        env: &vars,
        session: "s",
        resume: false,
        model: None,
        permission_mode: None,
        config_dir: None,
        tool_server: None,
        orchestrator: false,
    };
    let error = super::start(
        Arc::new(Recorder::default()),
        Arc::new(Sessions::default()),
        &CLAUDE_STREAM,
        &launch,
        Box::new(|_| {}),
    )
    .unwrap_err();
    assert!(error.contains("PATH"), "{error}");
}

/// One short turn against the real `claude` on PATH, on a cheap model, in
/// a scratch directory. Run by hand:
/// `cargo test -p workbench-core real_claude -- --ignored`.
#[test]
#[ignore = "runs the real claude, signed in, and spends a little of its usage"]
fn real_claude_holds_a_short_turn() {
    let dir =
        std::env::temp_dir().join(format!("workbench-integrated-real-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let environment = crate::env::environment();
    let recorder = Arc::new(Recorder::default());
    let sessions = Arc::new(Sessions::default());
    let session = uuid::Uuid::new_v4().to_string();
    let launch = Launch {
        project: &dir,
        env: &environment.vars,
        session: &session,
        resume: false,
        model: Some("haiku"),
        permission_mode: Some("default"),
        config_dir: None,
        tool_server: None,
        orchestrator: false,
    };
    let started = super::start(
        recorder.clone(),
        Arc::clone(&sessions),
        &CLAUDE_STREAM,
        &launch,
        Box::new(|_| {}),
    )
    .unwrap();
    let h = Harness {
        dir,
        sessions,
        recorder,
        id: started.id,
        session,
    };
    let ready = h.until_type("ready");
    assert!(ready.last().unwrap()["version"].is_string());
    h.send("Reply with exactly the word: pelican");
    let events = h.until(|e| e["type"] == "turnEnded" || e["type"] == "ended");
    let end = events.last().unwrap();
    assert_eq!(end["outcome"], "done", "{events:#?}");
    let said: String = events
        .iter()
        .filter(|e| e["type"] == "text" && e["done"] == true)
        .map(|e| e["text"].as_str().unwrap().to_lowercase())
        .collect();
    assert!(said.contains("pelican"), "{said}");
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "text" && e["done"] == false),
        "it streamed"
    );
    assert_eq!(h.stop()["clean"], true);
}
