//! Integrated sessions of Codex end to end, against a stand-in for
//! `codex app-server`.
//!
//! The stand-in is a shell script on a PATH of its own that plays a
//! scenario a step a line, as the one for Claude Code does: `say` writes a
//! line to its stdout, `expect` reads its stdin until a line holds the
//! given text, `reply` writes a line with `@ID@` replaced by the id of the
//! request last expected, `sleep`, `exit` and `die` do what they say,
//! `drain` reads until stdin closes and `err` writes a line to stderr. It
//! writes its arguments, its environment and every line it read beside the
//! scenario, for the tests to look at.
//!
//! The real `codex app-server` is run once, by hand, against a scripted
//! model server: see the ignored test at the end.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::*;
use crate::codex_app_server::CODEX_APP_SERVER;
use crate::events::testing::Recorder;
use crate::scratch::Scratch;

const STAND_IN: &str = r#"#!/bin/sh
dir=$(dirname "$FAKE_CODEX_SCENARIO")
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
      id=$(printf '%s' "$got" | sed -n 's/^{"id":\([0-9]*\),.*/\1/p') ;;
    "sleep "*) sleep "${step#sleep }" ;;
    "exit "*) exit "${step#exit }" ;;
    "die") kill -9 $$ ;;
    "err "*) printf '%s\n' "${step#err }" >&2 ;;
    "drain") while IFS= read -r got <&3; do printf '%s\n' "$got" >> "$dir/stdin"; done ;;
  esac
done < "$FAKE_CODEX_SCENARIO"
"#;

const THREAD: &str = "019a0000-0000-7000-8000-000000000001";

/// The handshake every scenario starts with, the account given.
fn opening(account: &str) -> String {
    [
        r#"expect "method":"initialize","#,
        r#"reply {"id":@ID@,"result":{"userAgent":"agent-workbench/0.169.0 (stand-in)","codexHome":"/h","platformFamily":"unix","platformOs":"macos"}}"#,
        r#"expect "method":"initialized""#,
        r#"expect "method":"account/read""#,
        &format!(r#"reply {{"id":@ID@,"result":{account}}}"#),
        r#"expect "method":"model/list""#,
        r#"reply {"id":@ID@,"result":{"data":[{"id":"gpt-a","model":"gpt-a","displayName":"GPT A","hidden":false,"defaultReasoningEffort":"medium","supportedReasoningEfforts":[{"reasoningEffort":"low","description":""},{"reasoningEffort":"medium","description":""}]},{"id":"gpt-b","model":"gpt-b","displayName":"GPT B","hidden":false,"defaultReasoningEffort":"high","supportedReasoningEfforts":[{"reasoningEffort":"high","description":""}]}]}}"#,
        r#"expect "method":"config/read""#,
        r#"reply {"id":@ID@,"result":{"config":{},"origins":{}}}"#,
        r#"expect "method":"thread/"#,
        &format!(
            r#"reply {{"id":@ID@,"result":{{"thread":{{"id":"{THREAD}","preview":"","turns":[]}},"model":"gpt-a","modelProvider":"openai","reasoningEffort":"medium","approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{{"type":"workspaceWrite"}},"cwd":"/w"}}}}"#
        ),
    ]
    .join("\n")
}

fn ready_scenario() -> String {
    opening(
        r#"{"account":{"type":"chatgpt","email":null,"planType":"plus"},"requiresOpenaiAuth":true}"#,
    )
}

/// The agent taking the message last read as the turn given.
fn take(turn: &str) -> String {
    [
        r#"expect "method":"turn/start""#.to_string(),
        format!(r#"reply {{"id":@ID@,"result":{{"turn":{{"id":"{turn}","status":"inProgress","items":[]}}}}}}"#),
        notify("turn/started", &format!(r#"{{"threadId":"{THREAD}","turn":{{"id":"{turn}","status":"inProgress","items":[]}}}}"#)),
    ]
    .join("\n")
}

fn notify(method: &str, params: &str) -> String {
    format!(r#"say {{"method":"{method}","params":{params}}}"#)
}

fn item(method: &str, turn: &str, item: &str) -> String {
    notify(
        method,
        &format!(r#"{{"threadId":"{THREAD}","turnId":"{turn}","item":{item}}}"#),
    )
}

fn done(turn: &str, status: &str) -> String {
    notify(
        "turn/completed",
        &format!(
            r#"{{"threadId":"{THREAD}","turn":{{"id":"{turn}","status":"{status}","items":[],"durationMs":5,"error":null}}}}"#
        ),
    )
}

struct Harness {
    dir: Arc<Scratch>,
    sessions: Arc<Sessions>,
    recorder: Arc<Recorder>,
    id: String,
}

fn start(name: &str, scenario: &str) -> Harness {
    start_with(name, scenario, |_| {})
}

fn start_with(name: &str, scenario: &str, adjust: impl FnOnce(&mut Launch)) -> Harness {
    use std::os::unix::fs::PermissionsExt;
    let dir = Arc::new(Scratch::new(&format!("codex-{name}")));
    let codex = dir.join("codex");
    std::fs::write(&codex, STAND_IN).unwrap();
    std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(dir.join("scenario"), scenario).unwrap();
    let vars = HashMap::from([
        (
            "PATH".to_string(),
            format!("{}:/usr/bin:/bin", dir.display()),
        ),
        (
            "FAKE_CODEX_SCENARIO".to_string(),
            dir.join("scenario").to_string_lossy().to_string(),
        ),
        ("WORKBENCH_SESSION".to_string(), "the-parent".to_string()),
    ]);
    let recorder = Arc::new(Recorder::default());
    let sessions = Arc::new(Sessions::default());
    let mut launch = Launch {
        project: &dir,
        env: &vars,
        session: None,
        resume: false,
        model: None,
        mode: None,
        effort: None,
        config_dir: None,
        tool_server: None,
        orchestrator: false,
    };
    adjust(&mut launch);
    let started = super::start(
        recorder.clone(),
        Arc::clone(&sessions),
        &CODEX_APP_SERVER,
        &launch,
        Box::new(|_| {}),
        Box::new(|_| {}),
    )
    .unwrap();
    Harness {
        dir,
        sessions,
        recorder,
        id: started.id,
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

    fn until_type(&self, kind: &str) -> Vec<Value> {
        self.until(|event| event["type"] == kind)
    }

    /// Waits for the `n`th event of a kind, and hands back every event up
    /// to and with it.
    fn until_nth(&self, kind: &str, n: usize) -> Vec<Value> {
        self.until(|_| self.events().iter().filter(|e| e["type"] == kind).count() >= n);
        let mut seen = 0;
        let events = self.events();
        let at = events
            .iter()
            .position(|event| {
                seen += usize::from(event["type"] == kind);
                seen == n
            })
            .expect("waited for above");
        events[..=at].to_vec()
    }

    fn stdin(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.join("stdin"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    fn sent(&self, method: &str) -> Vec<Value> {
        self.stdin()
            .into_iter()
            .filter(|line| line["method"] == method)
            .collect()
    }

    /// The lines that answered the server's requests, by request id.
    fn answers(&self) -> HashMap<i64, Value> {
        self.stdin()
            .into_iter()
            .filter(|line| line.get("method").is_none())
            .filter_map(|line| Some((line["id"].as_i64()?, line)))
            .collect()
    }

    fn send(&self, text: &str) -> String {
        let message = uuid::Uuid::new_v4().to_string();
        send(&self.sessions, &self.id, &message, text, &[]).unwrap();
        message
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
fn a_session_starts_a_thread_streams_a_turn_and_stops_cleanly() {
    let scenario = [
        ready_scenario(),
        take("turn-1"),
        item("item/started", "turn-1", r#"{"type":"userMessage","id":"u1","content":[]}"#),
        item("item/started", "turn-1", r#"{"type":"reasoning","id":"rs","summary":[]}"#),
        notify("item/reasoning/summaryTextDelta", r#"{"itemId":"rs","summaryIndex":0,"delta":"Hmm."}"#),
        item("item/completed", "turn-1", r#"{"type":"reasoning","id":"rs","summary":["Hmm."]}"#),
        item("item/started", "turn-1", r#"{"type":"agentMessage","id":"msg","text":""}"#),
        notify("item/agentMessage/delta", r#"{"itemId":"msg","delta":"po"}"#),
        notify("item/agentMessage/delta", r#"{"itemId":"msg","delta":"ng"}"#),
        item("item/completed", "turn-1", r#"{"type":"agentMessage","id":"msg","text":"pong"}"#),
        notify("thread/tokenUsage/updated", &format!(r#"{{"threadId":"{THREAD}","turnId":"turn-1","tokenUsage":{{"total":{{"inputTokens":10,"cachedInputTokens":4,"outputTokens":5,"reasoningOutputTokens":1,"totalTokens":15}},"last":{{"inputTokens":10,"cachedInputTokens":4,"outputTokens":5,"reasoningOutputTokens":1,"totalTokens":15}},"modelContextWindow":258400}}}}"#)),
        notify("account/rateLimits/updated", "{}"),
        done("turn-1", "completed"),
        "drain".to_string(),
    ]
    .join("\n");
    let h = start("text", &scenario);
    let ready = h.until_type("ready");
    let ready = ready.last().unwrap();
    assert_eq!(ready["sessionId"], THREAD, "the thread's own id");
    assert_eq!(ready["version"], "0.169.0");
    assert_eq!(ready["mode"], "auto");
    assert_eq!(ready["effort"], "medium");
    assert_eq!(ready["models"][1]["value"], "gpt-b");

    let message = h.send("say pong");
    let events = h.until_type("turnEnded");
    assert_eq!(
        kinds(&events),
        [
            "ready",
            "state",
            "message",
            "state",
            "turnStarted",
            "thinking",
            "thinking",
            "text",
            "text",
            "text",
            "context",
            "turnEnded"
        ]
    );
    assert_eq!(events[4]["messages"], json!([message]));
    assert_eq!(events[9]["text"], "pong");
    assert_eq!(events[9]["done"], true);
    assert_eq!(events[10]["size"], 258400);
    let ended = &events[11];
    assert_eq!(ended["outcome"], "done");
    assert_eq!(ended["usage"]["cachedTokens"], 4);
    assert_eq!(ended["usage"]["reasoningTokens"], 1);
    assert_eq!(
        states(&h.until_nth("state", 3)),
        ["idle", "working", "idle"]
    );

    let started = &h.sent("thread/start")[0]["params"];
    assert_eq!(started["approvalsReviewer"], "user");
    assert_eq!(started["cwd"], h.dir.to_string_lossy().as_ref());
    let turn = &h.sent("turn/start")[0]["params"];
    assert_eq!(turn["threadId"], THREAD);
    assert_eq!(turn["clientUserMessageId"], message.as_str());
    let args = std::fs::read_to_string(h.dir.join("args")).unwrap();
    assert_eq!(args.trim(), "app-server");

    let end = h.stop();
    assert_eq!(end["clean"], true);
    assert!(!kinds(&h.events()).contains(&"error".to_string()));
    assert!(!h.sessions.holds(&h.id));
}

#[test]
fn the_account_s_home_and_the_tool_server_go_with_the_session() {
    let server = PathBuf::from("/opt/workbench/agent-workbench-remote");
    let home = PathBuf::from("/home/ada/.codex-work");
    let h = start_with(
        "command",
        &format!("{}\ndrain", ready_scenario()),
        |launch| {
            launch.session = Some("019a-old");
            launch.resume = true;
            launch.mode = Some("read-only");
            launch.model = Some("gpt-b");
            launch.tool_server = Some(Box::leak(server.clone().into_boxed_path()));
            launch.config_dir = Some(Box::leak(home.clone().into_boxed_path()));
            launch.orchestrator = true;
        },
    );
    h.until_type("ready");
    let env = std::fs::read_to_string(h.dir.join("env")).unwrap();
    let has = |line: &str| env.lines().any(|l| l == line);
    assert!(has(&format!("CODEX_HOME={}", home.display())), "{env}");
    assert!(has("WORKBENCH_SESSION=019a-old"), "{env}");
    assert!(has("WORKBENCH_ROLE=orchestrator"), "{env}");
    let resume = &h.sent("thread/resume")[0]["params"];
    assert_eq!(resume["threadId"], "019a-old");
    assert_eq!(resume["model"], "gpt-b");
    assert_eq!(resume["sandbox"], "read-only");
    assert_eq!(
        resume["config"]["mcp_servers"]["agent_workbench"],
        json!({
            "command": server.to_string_lossy(),
            "args": ["mcp"],
            "env": {"WORKBENCH_SESSION": "019a-old", "WORKBENCH_ROLE": "orchestrator"},
            "default_tools_approval_mode": "approve",
        })
    );
    h.stop();
}

#[test]
fn an_account_that_is_not_signed_in_is_told_after_ready() {
    let scenario = format!(
        "{}\ndrain",
        opening(r#"{"account":null,"requiresOpenaiAuth":true}"#)
    );
    let h = start("signed-out", &scenario);
    let events = h.until_type("error");
    assert_eq!(kinds(&events), ["ready", "state", "error"]);
    assert_eq!(events[2]["kind"], "notLoggedIn");
    assert!(h.sessions.holds(&h.id), "the session goes on");
    h.stop();
}

#[test]
fn a_message_sent_before_ready_or_during_a_turn_waits_for_its_own() {
    // The handshake is slow to finish, so the first message waits for the
    // thread; the second waits for the first turn to end.
    let scenario = [
        r#"sleep 0.5"#.to_string(),
        ready_scenario(),
        take("turn-1"),
        r#"sleep 0.5"#.into(),
        done("turn-1", "completed"),
        take("turn-2"),
        done("turn-2", "completed"),
        "drain".into(),
    ]
    .join("\n");
    let h = start("held", &scenario);
    let first = h.send("first");
    let events = h.until_type("turnStarted");
    assert_eq!(events.last().unwrap()["messages"], json!([first]));
    let second = h.send("second");
    let queued = h.until(|e| e["type"] == "message" && e["state"] == "queued");
    assert_eq!(queued.last().unwrap()["message"], second.as_str());
    assert_eq!(h.sent("turn/start").len(), 1, "held while the turn runs");
    let events = h.until_nth("turnEnded", 2);
    let started: Vec<Value> = events
        .iter()
        .filter(|e| e["type"] == "turnStarted")
        .map(|e| e["messages"].clone())
        .collect();
    assert_eq!(started, [json!([first]), json!([second])]);
    let turns = h.sent("turn/start");
    assert_eq!(turns[1]["params"]["input"][0]["text"], "second");
    h.stop();
}

#[test]
fn a_command_a_file_change_an_mcp_call_a_plan_and_the_diff() {
    let scenario = [
        ready_scenario(),
        take("turn-1"),
        item("item/started", "turn-1", r#"{"type":"commandExecution","id":"cmd","command":"/bin/zsh -lc 'ls'","cwd":"/w","commandActions":[],"status":"inProgress"}"#),
        notify("item/commandExecution/outputDelta", r#"{"itemId":"cmd","delta":"a.txt\n"}"#),
        item("item/completed", "turn-1", r#"{"type":"commandExecution","id":"cmd","command":"/bin/zsh -lc 'ls'","status":"completed","aggregatedOutput":"a.txt\nb.txt\n","exitCode":0}"#),
        notify("turn/plan/updated", r#"{"turnId":"turn-1","plan":[{"step":"List","status":"completed"},{"step":"Edit","status":"inProgress"}]}"#),
        item("item/started", "turn-1", r#"{"type":"fileChange","id":"fc","changes":[],"status":"inProgress"}"#),
        item("item/completed", "turn-1", r#"{"type":"fileChange","id":"fc","status":"completed","changes":[{"path":"/w/new.txt","kind":{"type":"add"},"diff":"hi\n"},{"path":"/w/a.txt","kind":{"type":"update","move_path":null},"diff":"@@ -1 +1 @@\n-a\n+A\n"},{"path":"/w/b.txt","kind":{"type":"delete"},"diff":"b\n"},{"path":"/w/c.txt","kind":{"type":"update","move_path":"/w/d.txt"},"diff":""}]}"#),
        notify("turn/diff/updated", r#"{"turnId":"turn-1","diff":"diff --git a/a.txt b/a.txt\n"}"#),
        item("item/started", "turn-1", r#"{"type":"mcpToolCall","id":"mcp","server":"agent_workbench","tool":"notify","arguments":{"text":"done"},"status":"inProgress"}"#),
        item("item/completed", "turn-1", r#"{"type":"mcpToolCall","id":"mcp","server":"agent_workbench","tool":"notify","status":"completed","result":{"content":[{"type":"text","text":"told"}]}}"#),
        done("turn-1", "completed"),
        "drain".into(),
    ]
    .join("\n");
    let h = start("tools", &scenario);
    h.until_type("ready");
    h.send("work");
    let events = h.until_type("turnEnded");
    let finished = |call: &str| {
        events
            .iter()
            .find(|e| e["type"] == "toolFinished" && e["call"] == call)
            .unwrap()
            .clone()
    };
    let output = events.iter().find(|e| e["type"] == "toolOutput").unwrap();
    assert_eq!(output["delta"], "a.txt\n");
    assert_eq!(finished("cmd")["output"], "a.txt\nb.txt\n");
    assert_eq!(finished("cmd")["error"], false);
    let changes = finished("fc")["changes"].clone();
    let kinds: Vec<&str> = changes
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["create", "update", "delete", "move"]);
    assert_eq!(changes[0]["content"], "hi\n");
    assert_eq!(changes[1]["hunks"][0]["lines"], json!(["-a", "+A"]));
    assert_eq!(changes[3]["to"], "/w/d.txt");
    let mcp = events
        .iter()
        .find(|e| e["type"] == "toolStarted" && e["call"] == "mcp")
        .unwrap();
    assert_eq!(mcp["kind"], "mcp");
    assert_eq!(mcp["name"], "mcp__agent_workbench__notify");
    assert_eq!(finished("mcp")["output"], "told");
    let plan = events.iter().find(|e| e["type"] == "plan").unwrap();
    assert_eq!(
        plan["steps"][1],
        json!({"text": "Edit", "status": "active"})
    );
    let diff = events.iter().find(|e| e["type"] == "turnDiff").unwrap();
    assert_eq!(diff["diff"], "diff --git a/a.txt b/a.txt\n");
    h.stop();
}

#[test]
fn each_answer_to_an_approval_reaches_the_agent_as_its_decision() {
    let ask = |id: u32, method: &str, params: &str| {
        format!(r#"say {{"id":{id},"method":"{method}","params":{params}}}"#)
    };
    let command = |id: u32| {
        ask(
            id,
            "item/commandExecution/requestApproval",
            &format!(
                r#"{{"threadId":"{THREAD}","turnId":"turn-1","itemId":"c{id}","command":"touch {id}","cwd":"/w","proposedExecpolicyAmendment":["touch"],"startedAtMs":1}}"#
            ),
        )
    };
    let scenario = [
        ready_scenario(),
        take("turn-1"),
        command(0),
        r#"expect "id":0"#.into(),
        notify("serverRequest/resolved", r#"{"requestId":0}"#),
        command(1),
        r#"expect "id":1"#.into(),
        command(2),
        r#"expect "id":2"#.into(),
        command(3),
        r#"expect "id":3"#.into(),
        ask(4, "item/fileChange/requestApproval", r#"{"turnId":"turn-1","itemId":"f","grantRoot":null,"startedAtMs":1}"#),
        r#"expect "id":4"#.into(),
        ask(5, "mcpServer/elicitation/request", r#"{"turnId":"turn-1","serverName":"docs","mode":"form","message":"Allow?","requestedSchema":{"type":"object","properties":{}},"_meta":{"codex_approval_kind":"mcp_tool_call","persist":["session","always"],"tool_name":"search","tool_params":{"q":"x"}}}"#),
        r#"expect "id":5"#.into(),
        done("turn-1", "completed"),
        "drain".into(),
    ]
    .join("\n");
    let h = start("approvals", &scenario);
    h.until_type("ready");
    h.send("touch things");
    let answers = [
        ("0", Choice::Allow),
        ("1", Choice::AllowSession),
        ("2", Choice::AllowAlways),
        ("3", Choice::Deny),
        ("4", Choice::Cancel),
        ("5", Choice::AllowAlways),
    ];
    for (request, choice) in answers {
        h.until(|e| e["type"] == "permissionAsked" && e["request"] == request);
        h.until(|_| states(&h.events()).last().map(String::as_str) == Some("asking"));
        answer(&h.sessions, &h.id, request, choice, Some("why not")).unwrap();
        h.until(|_| states(&h.events()).last().map(String::as_str) == Some("working"));
    }
    let events = h.until_type("turnEnded");
    let asked = events
        .iter()
        .find(|e| e["type"] == "permissionAsked" && e["request"] == "2")
        .unwrap();
    assert_eq!(asked["call"], "c2");
    assert_eq!(
        asked["choices"][2],
        json!({"choice": "allowAlways", "remembers": "commands that start with touch in Codex's rules, from now on", "message": false})
    );
    let answers = h.answers();
    assert_eq!(answers[&0]["result"]["decision"], "accept");
    assert_eq!(answers[&1]["result"]["decision"], "acceptForSession");
    assert_eq!(
        answers[&2]["result"]["decision"],
        json!({"acceptWithExecpolicyAmendment": {"execpolicy_amendment": ["touch"]}})
    );
    assert_eq!(answers[&3]["result"]["decision"], "decline");
    assert_eq!(answers[&4]["result"]["decision"], "cancel");
    assert_eq!(answers[&5]["result"]["_meta"]["persist"], "always");
    // A request the agent says is settled after it was answered is not
    // withdrawn: it was answered.
    assert!(!kinds(&events).contains(&"withdrawn".to_string()));
    assert!(answer(&h.sessions, &h.id, "0", Choice::Allow, None).is_err());
    h.stop();
}

#[test]
fn a_question_with_a_secret_and_options_alone_is_answered_by_reply() {
    let scenario = [
        ready_scenario(),
        take("turn-1"),
        r#"say {"id":9,"method":"item/tool/requestUserInput","params":{"turnId":"turn-1","itemId":"q","isBlocking":true,"questions":[{"id":"pw","header":"Password","question":"The password?","isSecret":true,"options":null},{"id":"go","header":"Go","question":"Go on?","options":[{"label":"Yes","description":""},{"label":"No","description":""}]}]}}"#.to_string(),
        r#"expect "id":9"#.into(),
        done("turn-1", "completed"),
        "drain".into(),
    ]
    .join("\n");
    let h = start("question", &scenario);
    h.until_type("ready");
    h.send("ask me");
    let asked = h.until_type("questionAsked");
    let asked = asked.last().unwrap();
    assert_eq!(asked["questions"][0]["secret"], true);
    assert_eq!(asked["questions"][0]["other"], true);
    assert_eq!(asked["questions"][1]["other"], false);
    assert!(
        reply(
            &h.sessions,
            &h.id,
            "9",
            Some(&[vec!["x".into()], vec!["Maybe".into()]])
        )
        .is_err(),
        "an options-only question takes one of its options"
    );
    reply(
        &h.sessions,
        &h.id,
        "9",
        Some(&[vec!["hunter2".into()], vec!["Yes".into()]]),
    )
    .unwrap();
    let events = h.until_type("turnEnded");
    let answered = events.iter().find(|e| e["type"] == "answered").unwrap();
    assert_eq!(answered["answers"], json!([null, ["Yes"]]));
    assert!(!serde_json::to_string(&h.events())
        .unwrap()
        .contains("hunter2"));
    let line = &h.answers()[&9];
    assert_eq!(
        line["result"]["answers"],
        json!({"pw": {"answers": ["hunter2"]}, "go": {"answers": ["Yes"]}})
    );
    h.stop();
}

#[test]
fn an_interrupt_ends_the_turn_and_the_core_closes_what_was_open() {
    let scenario = [
        ready_scenario(),
        take("turn-1"),
        item("item/started", "turn-1", r#"{"type":"commandExecution","id":"sleep","command":"sleep 40","status":"inProgress"}"#),
        r#"say {"id":3,"method":"item/fileChange/requestApproval","params":{"turnId":"turn-1","itemId":"fc"}}"#.into(),
        r#"expect "method":"turn/interrupt""#.into(),
        r#"reply {"id":@ID@,"result":{}}"#.into(),
        done("turn-1", "interrupted"),
        "drain".into(),
    ]
    .join("\n");
    let h = start("interrupt", &scenario);
    h.until_type("ready");
    h.send("sleep a while");
    h.until_type("permissionAsked");
    control(&h.sessions, &h.id, &Control::Interrupt).unwrap();
    let events = h.until_type("turnEnded");
    let interrupt = &h.sent("turn/interrupt")[0]["params"];
    assert_eq!(interrupt, &json!({"threadId": THREAD, "turnId": "turn-1"}));
    let events: Vec<Value> = events
        .into_iter()
        .filter(|e| e["type"] != "state")
        .collect();
    let n = events.len();
    assert_eq!(
        kinds(&events[n - 3..]),
        ["withdrawn", "toolFinished", "turnEnded"]
    );
    assert_eq!(events[n - 3]["request"], "3");
    assert_eq!(events[n - 2]["call"], "sleep");
    assert_eq!(events[n - 2]["error"], true);
    assert_eq!(events[n - 1]["outcome"], "interrupted");
    // The approval nobody answered is answered no, so the agent is not
    // left holding it.
    h.until(|_| h.answers().contains_key(&3));
    assert_eq!(h.answers()[&3]["result"]["decision"], "decline");
    assert_eq!(states(&h.until_nth("state", 5)).last().unwrap(), "idle");
    h.stop();
}

#[test]
fn model_and_effort_change_between_turns_and_go_with_the_next() {
    let scenario = [
        ready_scenario(),
        take("turn-1"),
        done("turn-1", "completed"),
        "drain".into(),
    ]
    .join("\n");
    let h = start("model", &scenario);
    h.until_type("ready");
    let settings = configure(&h.sessions, &h.id, Some("gpt-b"), Some("full-access"), None).unwrap();
    assert_eq!(
        settings,
        Settings {
            model: Some("gpt-b".into()),
            mode: Some("full-access".into()),
            effort: Some("high".into()),
        }
    );
    assert!(configure(&h.sessions, &h.id, None, None, Some("low")).is_err());
    assert!(configure(&h.sessions, &h.id, Some("no-such"), None, None).is_err());
    h.send("go");
    h.until_type("turnEnded");
    let turn = &h.sent("turn/start")[0]["params"];
    assert_eq!(turn["model"], "gpt-b");
    assert_eq!(turn["effort"], "high");
    assert_eq!(turn["approvalPolicy"], "never");
    assert_eq!(turn["sandboxPolicy"]["type"], "dangerFullAccess");
    let configured: Vec<Value> = h
        .events()
        .into_iter()
        .filter(|e| e["type"] == "configured")
        .collect();
    assert_eq!(configured.len(), 2, "{configured:?}");
    assert_eq!(configured[0]["efforts"], json!(["high"]));
    h.stop();
}

#[test]
fn compaction_notices_and_a_retry() {
    let scenario = [
        ready_scenario(),
        r#"expect "method":"thread/compact/start""#.into(),
        r#"reply {"id":@ID@,"result":{}}"#.into(),
        notify("turn/started", r#"{"turn":{"id":"turn-c","status":"inProgress"}}"#),
        item("item/started", "turn-c", r#"{"type":"contextCompaction","id":"cc"}"#),
        notify("error", r#"{"turnId":"turn-c","willRetry":true,"error":{"message":"Reconnecting... 1/5","codexErrorInfo":"serverOverloaded"}}"#),
        item("item/completed", "turn-c", r#"{"type":"contextCompaction","id":"cc"}"#),
        done("turn-c", "completed"),
        notify("warning", r#"{"message":"Model metadata missing"}"#),
        notify("deprecationNotice", r#"{"summary":"Old thing","details":"use the new one"}"#),
        "drain".into(),
    ]
    .join("\n");
    let h = start("compact", &scenario);
    h.until_type("ready");
    integrated_compact(&h);
    let events = h.until_nth("notice", 2);
    let tail: Vec<String> = kinds(&events)
        .into_iter()
        .filter(|k| k != "state")
        .skip(1)
        .collect();
    assert_eq!(
        tail,
        [
            "turnStarted",
            "compacting",
            "retrying",
            "compacted",
            "turnEnded",
            "notice",
            "notice"
        ]
    );
    let retrying = events.iter().find(|e| e["type"] == "retrying").unwrap();
    assert_eq!(retrying["attempt"], 1);
    assert_eq!(retrying["attempts"], 5);
    let compacted = events.iter().find(|e| e["type"] == "compacted").unwrap();
    assert_eq!(compacted["reason"], "asked");
    let started = events.iter().find(|e| e["type"] == "turnStarted").unwrap();
    assert_eq!(started["messages"], json!([]));
    assert_eq!(
        events.last().unwrap()["message"],
        "Old thing: use the new one"
    );
    h.stop();
}

fn integrated_compact(h: &Harness) {
    control(&h.sessions, &h.id, &Control::Compact).unwrap();
}

#[test]
fn a_turn_that_fails_says_why() {
    let scenario = [
        ready_scenario(),
        take("turn-1"),
        notify("error", r#"{"turnId":"turn-1","willRetry":false,"error":{"message":"You've hit your usage limit.","codexErrorInfo":"usageLimitExceeded"}}"#),
        notify("turn/completed", r#"{"turn":{"id":"turn-1","status":"failed","error":null}}"#),
        "drain".into(),
    ]
    .join("\n");
    let h = start("fails", &scenario);
    h.until_type("ready");
    h.send("go");
    let events = h.until_type("turnEnded");
    let ended = events.last().unwrap();
    assert_eq!(ended["outcome"], "failed");
    assert_eq!(ended["error"], "You've hit your usage limit.");
    assert!(!kinds(&events).contains(&"error".to_string()));
    h.stop();
}

#[test]
fn unknown_lines_are_skipped_and_unhandled_requests_refused() {
    let scenario = [
        ready_scenario(),
        take("turn-1"),
        "say this is not json".into(),
        r#"say {"method":"thread/somethingNew","params":{"with":{"fields":[1,2]}}}"#.into(),
        item("item/started", "turn-1", r#"{"type":"hologram","id":"h1"}"#),
        r#"say {"method":"item/completed","params":{"item":"not an object"}}"#.into(),
        r#"say {"id":40,"method":"item/tool/call","params":{"tool":"x"}}"#.into(),
        r#"expect "id":40"#.into(),
        r#"say {"id":41,"method":"something/fromALaterVersion","params":{}}"#.into(),
        r#"expect "id":41"#.into(),
        item(
            "item/completed",
            "turn-1",
            r#"{"type":"agentMessage","id":"m","text":"still here","brandNewField":{"a":1}}"#,
        ),
        done("turn-1", "completed"),
        "drain".into(),
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
    assert!(!kinds(&events).contains(&"toolStarted".to_string()));
    let answers = h.answers();
    assert_eq!(answers[&40]["error"]["code"], -32601);
    assert_eq!(answers[&41]["error"]["code"], -32601);
    h.stop();
}

#[test]
fn a_process_that_dies_mid_turn_fails_the_turn_and_says_so() {
    let scenario = [
        ready_scenario(),
        take("turn-1"),
        item(
            "item/started",
            "turn-1",
            r#"{"type":"commandExecution","id":"cmd","command":"make","status":"inProgress"}"#,
        ),
        notify(
            "item/agentMessage/delta",
            r#"{"itemId":"m","delta":"half"}"#,
        ),
        "err thread 'main' panicked".into(),
        "die".into(),
    ]
    .join("\n");
    let h = start("dies", &scenario);
    h.until_type("ready");
    h.send("go");
    let events = h.until_type("ended");
    let n = events.len();
    assert_eq!(
        kinds(&events[n - 4..]),
        ["toolFinished", "turnEnded", "error", "ended"]
    );
    assert_eq!(events[n - 3]["outcome"], "failed");
    assert_eq!(events[n - 2]["kind"], "process");
    assert!(events[n - 2]["message"]
        .as_str()
        .unwrap()
        .starts_with("codex was ended by a signal"));
    assert_eq!(events[n - 1]["clean"], false);
    assert!(!h.sessions.holds(&h.id));
}

#[test]
fn a_handshake_that_fails_ends_the_session_with_a_plain_error() {
    let scenario = [
        r#"expect "method":"initialize","#,
        r#"reply {"id":@ID@,"error":{"code":-32600,"message":"Not initialized"}}"#,
        "drain",
    ]
    .join("\n");
    let h = start("refused", &scenario);
    let events = h.until_type("ended");
    assert_eq!(kinds(&events), ["error", "ended"]);
    assert_eq!(events[0]["kind"], "protocol");
    assert!(events[0]["message"]
        .as_str()
        .unwrap()
        .contains("Not initialized"));
    assert_eq!(events[1]["clean"], true, "it ended when told");

    let scenario = [
        r#"expect "method":"initialize","#,
        r#"reply {"id":@ID@,"result":{"userAgent":"agent-workbench/0.100.0 (old)"}}"#,
        "drain",
    ]
    .join("\n");
    let h = start("old", &scenario);
    let events = h.until_type("ended");
    assert_eq!(kinds(&events), ["error", "ended"]);
    assert!(events[0]["message"].as_str().unwrap().contains("0.100.0"));
    assert!(
        h.stdin()
            .iter()
            .all(|line| line["method"] != "thread/start"),
        "no thread is started"
    );

    // A message sent before the end is dropped, not lost without a word.
    let scenario = [
        r#"expect "method":"initialize","#,
        "sleep 0.3",
        r#"reply {"id":@ID@,"result":{"userAgent":"agent-workbench/0.169.0"}}"#,
        r#"expect "method":"thread/start""#,
        r#"reply {"id":@ID@,"error":{"code":-32600,"message":"bad model"}}"#,
        "drain",
    ]
    .join("\n");
    let h = start("no-thread", &scenario);
    let message = h.send("hello");
    let events = h.until_type("ended");
    assert!(events.iter().any(|e| e["type"] == "message"
        && e["message"] == message.as_str()
        && e["state"] == "dropped"));
    let error = events.iter().find(|e| e["type"] == "error").unwrap();
    assert_eq!(error["kind"], "agent");
    assert!(error["message"].as_str().unwrap().contains("bad model"));
}

/// A stand-in for the model behind Codex: a Responses API that streams a
/// scripted answer, chosen by a word in the user's last message, over
/// server-sent events.
mod model {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};

    use serde_json::{json, Value};

    pub fn serve() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                std::thread::spawn(move || answer(stream));
            }
        });
        port
    }

    fn answer(stream: TcpStream) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut length = 0usize;
        let mut first = String::new();
        if reader.read_line(&mut first).is_err() {
            return;
        }
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                return;
            }
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    length = value.trim().parse().unwrap_or(0);
                }
            }
        }
        let mut body = vec![0u8; length];
        if reader.read_exact(&mut body).is_err() {
            return;
        }
        let mut stream = stream;
        if !first.contains("/responses") {
            let _ = stream.write_all(
                b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
            );
            return;
        }
        let body: Value = serde_json::from_slice(&body).unwrap_or_default();
        let _ = stream.write_all(
            b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
        );
        for event in script(&body) {
            let kind = event["type"].as_str().unwrap_or_default().to_string();
            let _ = write!(stream, "event: {kind}\ndata: {event}\n\n");
            let _ = stream.flush();
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    fn last_user_text(input: &[Value]) -> String {
        input
            .iter()
            .rev()
            .find(|item| item["type"] == "message" && item["role"] == "user")
            .map(|item| {
                item["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|part| part["text"].as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default()
    }

    /// Outputs of tool calls since the user's last message.
    fn outputs(input: &[Value]) -> usize {
        input
            .iter()
            .rev()
            .take_while(|item| !(item["type"] == "message" && item["role"] == "user"))
            .filter(|item| {
                item["type"]
                    .as_str()
                    .is_some_and(|kind| kind.ends_with("call_output"))
            })
            .count()
    }

    /// Every function tool offered, with its namespace.
    fn tools(body: &Value) -> Vec<(Option<String>, String)> {
        let mut found = Vec::new();
        for tool in body["tools"].as_array().into_iter().flatten() {
            if tool["type"] == "namespace" {
                for inner in tool["tools"].as_array().into_iter().flatten() {
                    if let Some(name) = inner["name"].as_str() {
                        found.push((tool["name"].as_str().map(str::to_string), name.to_string()));
                    }
                }
            } else if let Some(name) = tool["name"].as_str() {
                found.push((None, name.to_string()));
            }
        }
        found
    }

    fn said(text: &str) -> Vec<Value> {
        let id = format!("msg_{}", uuid::Uuid::new_v4().simple());
        let mut events = vec![
            json!({"type": "response.output_item.added", "output_index": 0,
            "item": {"type": "message", "role": "assistant", "id": id, "content": []}}),
        ];
        for piece in text.as_bytes().chunks(4) {
            events.push(json!({"type": "response.output_text.delta", "item_id": id,
                "output_index": 0, "content_index": 0, "delta": String::from_utf8_lossy(piece)}));
        }
        events.push(
            json!({"type": "response.output_item.done", "output_index": 0,
            "item": {"type": "message", "role": "assistant", "id": id,
                     "content": [{"type": "output_text", "text": text}]}}),
        );
        events
    }

    fn called(name: &str, namespace: Option<&str>, arguments: Value) -> Vec<Value> {
        let mut item = json!({"type": "function_call", "id": format!("fc_{}", uuid::Uuid::new_v4().simple()),
            "call_id": format!("call_{}", uuid::Uuid::new_v4().simple()),
            "name": name, "arguments": arguments.to_string()});
        if let Some(namespace) = namespace {
            item["namespace"] = json!(namespace);
        }
        vec![
            json!({"type": "response.output_item.added", "output_index": 0, "item": item}),
            json!({"type": "response.output_item.done", "output_index": 0, "item": item}),
        ]
    }

    fn script(body: &Value) -> Vec<Value> {
        let input = body["input"].as_array().cloned().unwrap_or_default();
        let prompt = last_user_text(&input);
        let tools = tools(body);
        let shell = tools
            .iter()
            .find(|(_, name)| name == "exec_command" || name == "shell_command")
            .map(|(_, name)| name.clone());
        let run = |command: &str, escalate: bool| -> Vec<Value> {
            let Some(shell) = &shell else {
                return said("no shell tool");
            };
            let mut arguments = if shell == "exec_command" {
                json!({"cmd": command})
            } else {
                json!({"command": command})
            };
            if escalate {
                arguments["sandbox_permissions"] = json!("require_escalated");
                arguments["justification"] = json!("the test asks for it");
            }
            called(shell, None, arguments)
        };
        let id = format!("resp_{}", uuid::Uuid::new_v4().simple());
        let mut events = vec![json!({"type": "response.created", "response": {"id": id}})];
        events.extend(if outputs(&input) > 0 {
            said("Done.")
        } else if prompt.contains("PATCH") {
            run(
                "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: notes.txt\n+hello\n*** End Patch\nEOF\n",
                false,
            )
        } else if prompt.contains("ESCALATE") {
            run("touch made.txt", true)
        } else if let Some(seconds) = prompt.split("SLEEP ").nth(1) {
            run(&format!("sleep {}", seconds.trim()), false)
        } else if prompt.contains("MCP") {
            match tools.iter().find(|(_, name)| name.contains("echo")) {
                Some((namespace, name)) => {
                    called(name, namespace.as_deref(), json!({"text": "hi"}))
                }
                None => said("no echo tool"),
            }
        } else {
            said("pong")
        });
        events.push(json!({"type": "response.completed", "response": {"id": id,
            "usage": {"input_tokens": 10, "input_tokens_details": {"cached_tokens": 2},
                      "output_tokens": 5, "output_tokens_details": {"reasoning_tokens": 1},
                      "total_tokens": 15}}}));
        events
    }
}

/// An MCP server with one tool, `echo`, in shell, standing in for the
/// workbench's own: it writes its environment beside itself.
const ECHO_SERVER: &str = r#"#!/bin/sh
env > "$(dirname "$0")/server-env"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -z "$id" ] && continue
  case "$line" in
    *'"method":"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"echo","version":"0"}}}\n' "$id" ;;
    *'"method":"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","description":"Echo.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}}]}}\n' "$id" ;;
    *'"method":"tools/call"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"echoed"}]}}\n' "$id" ;;
    *) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
  esac
done
"#;

/// The real `codex app-server` on PATH, under a home of its own, against
/// the stand-in for the model above: no login and no network. Run by hand:
/// `cargo test -p workbench-core real_codex -- --ignored --nocapture`.
#[test]
#[ignore = "runs the real codex app-server on PATH"]
fn real_codex_holds_turns_approvals_an_interrupt_and_a_resume() {
    use std::os::unix::fs::PermissionsExt;
    let port = model::serve();
    let base = Arc::new(Scratch::new("real-codex"));
    let home = base.join("home");
    let work = base.join("work");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(
        home.join("config.toml"),
        format!(
            "model = \"mock-1\"\nmodel_provider = \"mock\"\n\n[model_providers.mock]\nname = \"mock\"\nbase_url = \"http://127.0.0.1:{port}/v1\"\nwire_api = \"responses\"\n"
        ),
    )
    .unwrap();
    let server = base.join("echo-server");
    std::fs::write(&server, ECHO_SERVER).unwrap();
    std::fs::set_permissions(&server, std::fs::Permissions::from_mode(0o755)).unwrap();

    let environment = crate::env::environment();
    let sessions = Arc::new(Sessions::default());
    let begin = |session: Option<&str>| {
        let recorder = Arc::new(Recorder::default());
        let launch = Launch {
            project: &work,
            env: &environment.vars,
            session,
            resume: session.is_some(),
            model: None,
            mode: Some("read-only"),
            effort: None,
            config_dir: Some(&home),
            tool_server: Some(&server),
            orchestrator: false,
        };
        let started = super::start(
            recorder.clone(),
            Arc::clone(&sessions),
            &CODEX_APP_SERVER,
            &launch,
            Box::new(|_| {}),
            Box::new(|_| {}),
        )
        .unwrap();
        Harness {
            dir: Arc::clone(&base),
            sessions: Arc::clone(&sessions),
            recorder,
            id: started.id,
        }
    };
    let turn = |h: &Harness, text: &str| -> Vec<Value> {
        let before = h
            .events()
            .iter()
            .filter(|e| e["type"] == "turnEnded")
            .count();
        let message = h.send(text);
        let events = h.until_nth("turnEnded", before + 1);
        let at = events
            .iter()
            .rposition(|e| e["type"] == "turnStarted")
            .unwrap();
        assert_eq!(events[at]["messages"], json!([message]), "{events:#?}");
        // The turn's own events alone.
        events[at..].to_vec()
    };

    let h = begin(None);
    let ready = h.until(|e| e["type"] == "ready" || e["type"] == "ended");
    let ready = ready.last().unwrap();
    assert_eq!(ready["type"], "ready", "{:#?}", h.events());
    let thread = ready["sessionId"].as_str().unwrap().to_string();
    println!("codex {} thread {thread}", ready["version"]);
    assert_eq!(ready["mode"], "read-only");

    // Text, streamed and whole.
    let events = turn(&h, "PONG");
    let text: Vec<&Value> = events.iter().filter(|e| e["type"] == "text").collect();
    assert!(text.iter().any(|e| e["done"] == false), "{events:#?}");
    assert!(text
        .iter()
        .any(|e| e["done"] == true && e["text"] == "pong"));
    assert_eq!(events.last().unwrap()["outcome"], "done");

    // A file change, asked for and allowed.
    let message = h.send("PATCH");
    let asked = h.until(|e| e["type"] == "permissionAsked" && e["tool"] == "fileChange");
    let asked = asked.last().unwrap().clone();
    assert!(asked["input"]["changes"].is_array(), "{asked:#?}");
    answer(
        &sessions,
        &h.id,
        asked["request"].as_str().unwrap(),
        Choice::Allow,
        None,
    )
    .unwrap();
    let events = h.until_nth("turnEnded", 2);
    let finished = events
        .iter()
        .find(|e| {
            e["type"] == "toolFinished" && e["changes"].as_array().is_some_and(|c| !c.is_empty())
        })
        .unwrap_or_else(|| panic!("{events:#?}"));
    assert_eq!(finished["changes"][0]["kind"], "create");
    assert_eq!(finished["changes"][0]["content"], "hello\n");
    assert_eq!(
        std::fs::read_to_string(work.join("notes.txt")).unwrap(),
        "hello\n"
    );
    assert!(events.iter().any(|e| e["type"] == "turnDiff"));
    let _ = message;

    // A command that asks to leave the sandbox, declined: the turn goes on.
    h.send("ESCALATE");
    let asked = h.until(|e| e["type"] == "permissionAsked" && e["tool"] == "commandExecution");
    let asked = asked.last().unwrap().clone();
    println!("command offers {}", asked["choices"]);
    answer(
        &sessions,
        &h.id,
        asked["request"].as_str().unwrap(),
        Choice::Deny,
        None,
    )
    .unwrap();
    let events = h.until_nth("turnEnded", 3);
    assert_eq!(events.last().unwrap()["outcome"], "done", "{events:#?}");
    assert!(!work.join("made.txt").exists());

    // The workbench's tool server runs its tools without asking.
    let events = turn(&h, "MCP");
    let call = events
        .iter()
        .find(|e| e["type"] == "toolFinished" && e["output"] == "echoed")
        .unwrap_or_else(|| panic!("{events:#?}"));
    assert_eq!(call["error"], false);
    assert!(!events.iter().any(|e| e["type"] == "permissionAsked"));

    // An interrupt while a command runs. The command sleeps for a time no
    // other process asks for, so that it alone is found by it.
    let command = format!(
        "sleep 37.{:09}",
        uuid::Uuid::new_v4().as_u128() % 1_000_000_000
    );
    let sleeping = || {
        std::process::Command::new("pgrep")
            .args(["-f", &command])
            .output()
            .is_ok_and(|out| out.status.success())
    };
    let processes = || {
        let ps = std::process::Command::new("ps")
            .args(["-o", "pid,pgid,ppid,command", "-ax"])
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).to_string())
            .unwrap_or_default();
        ps.lines()
            .filter(|l| l.contains(&command))
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    // Until it holds, or panics with the processes there are.
    let wait_for = |what: &str, holds: &dyn Fn() -> bool| {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !holds() {
            assert!(Instant::now() < deadline, "{what}: {:#?}", processes());
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    let before = h.events().len();
    h.send(&format!("SLEEP {}", &command["sleep ".len()..]));
    // The interrupt waits for both Codex's word that the call started and
    // the command itself, which come in no fixed order.
    h.until(|_| {
        h.events()[before..]
            .iter()
            .any(|e| e["type"] == "toolStarted" && e["kind"] == "command")
    });
    wait_for("the command never ran", &sleeping);
    control(&sessions, &h.id, &Control::Interrupt).unwrap();
    let events = h.until_nth("turnEnded", 5);
    assert_eq!(
        events.last().unwrap()["outcome"],
        "interrupted",
        "{events:#?}"
    );
    // The interrupt ends the turn and leaves the command running; the end
    // of the session takes it.
    assert!(
        sleeping(),
        "the command outlives the interrupt: {:#?}",
        processes()
    );
    assert_eq!(h.stop()["clean"], true);
    wait_for("the command outlived the session", &|| !sleeping());

    // The thread resumes, and the tool server is told whose it is.
    let h = begin(Some(&thread));
    let ready = h.until(|e| e["type"] == "ready" || e["type"] == "ended");
    assert_eq!(
        ready.last().unwrap()["sessionId"],
        thread.as_str(),
        "{ready:#?}"
    );
    let events = turn(&h, "PONG");
    assert_eq!(events.last().unwrap()["outcome"], "done");
    let env = std::fs::read_to_string(base.join("server-env")).unwrap_or_default();
    println!(
        "the tool server had WORKBENCH_SESSION: {}",
        env.lines()
            .any(|l| l == format!("WORKBENCH_SESSION={thread}"))
    );
    assert_eq!(h.stop()["clean"], true);
}
