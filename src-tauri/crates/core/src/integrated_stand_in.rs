//! Integrated sessions end to end, against a stand-in for `claude`.
//!
//! The stand-in is a shell script on a PATH of its own that plays a
//! scenario a step a line: `say` writes a line to its stdout, `expect`
//! reads its stdin until a line holds the given text, `reply` writes a line
//! with `@ID@` replaced by the request id of the line last expected and
//! `@UUID@` by its uuid, `sleep`, `exit` and `die` do what they say,
//! `drain` reads until stdin closes, `err` writes a line to stderr, `big`
//! writes a line of that many bytes, `bigresult` the result of a tool call
//! with that much content, `spawn` leaves a command running
//! in the background with its pid in a file beside the scenario, `deaf`
//! does the same with a command that ignores the signal asking it to end,
//! and
//! `linger` ignores the end of its stdin and, asked to end, writes a file
//! beside the scenario and ends cleanly, and `await` waits until a file of
//! that name is beside the scenario. It writes
//! its arguments, its environment and every line it read beside the
//! scenario, for the tests to look at.
//!
//! Started again in the same folder, as a session that goes back is, the
//! stand-in plays the scenario numbered for that start where there is one,
//! `scenario.2` for the second, and keeps that start's arguments numbered
//! the same way. As the real one does, it checks the entry a conversation
//! is resumed at, `--resume-session-at`, before anything else: one that is
//! not in the `transcript` beside the scenario is said not to be found, on
//! stderr and as a result, and the stand-in ends with code 1.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::*;
use crate::claude_stream::CLAUDE_STREAM;
use crate::events::testing::{Recorder, Waits};
use crate::scratch::Scratch;

const STAND_IN: &str = r#"#!/bin/sh
dir=$(dirname "$FAKE_CLAUDE_SCENARIO")
run=$(( $(cat "$dir/runs" 2>/dev/null || echo 0) + 1 ))
printf '%s\n' "$run" > "$dir/runs"
scenario=$FAKE_CLAUDE_SCENARIO
[ -f "$scenario.$run" ] && scenario=$scenario.$run
printf '%s\n' "$@" > "$dir/args"
printf '%s\n' "$@" > "$dir/args.$run"
env > "$dir/env"
at=
prev=
for arg in "$@"; do
  [ "$prev" = "--resume-session-at" ] && at=$arg
  prev=$arg
done
if [ -n "$at" ] && ! grep -q "\"uuid\":\"$at\"" "$dir/transcript" 2>/dev/null; then
  printf 'No message found with message.uuid of: %s\n' "$at" >&2
  printf '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"session_id":"s","errors":["No message found with message.uuid of: %s"]}\n' "$at"
  exit 1
fi
exec 3<&0
id=
while IFS= read -r step || [ -n "$step" ]; do
  case "$step" in
    "say "*) printf '%s\n' "${step#say }" ;;
    "reply "*) printf '%s\n' "${step#reply }" | sed "s/@ID@/$id/g; s/@UUID@/$uuid/g" ;;
    "expect "*)
      want=${step#expect }
      got=
      while IFS= read -r got <&3; do
        printf '%s\n' "$got" >> "$dir/stdin"
        case "$got" in *"$want"*) break ;; esac
      done
      id=$(printf '%s' "$got" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
      uuid=$(printf '%s' "$got" | sed -n 's/.*"uuid":"\([^"]*\)".*/\1/p') ;;
    "sleep "*) sleep "${step#sleep }" ;;
    "exit "*) exit "${step#exit }" ;;
    "die") kill -9 $$ ;;
    "err "*) printf '%s\n' "${step#err }" >&2 ;;
    "big "*) head -c "${step#big }" /dev/zero | tr '\0' x; printf '\n' ;;
    "bigresult "*)
      set -- ${step#bigresult }
      printf '%s' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"'
      head -c "$2" /dev/zero | tr '\0' x
      printf '","tool_use_id":"%s"}]},"parent_tool_use_id":null}\n' "$1" ;;
    "spawn") sleep 300 & echo $! > "$dir/child" ;;
    "deaf") (trap '' TERM; exec sleep 300) & echo $! > "$dir/child" ;;
    "await "*) while [ ! -e "$dir/${step#await }" ]; do sleep 0.05; done ;;
    "drain") while IFS= read -r got <&3; do printf '%s\n' "$got" >> "$dir/stdin"; done ;;
    "linger")
      trap 'echo yes > "$dir/termed"; exit 0' TERM
      while :; do sleep 1 & wait $!; done ;;
  esac
done < "$scenario"
"#;

/// The opening every scenario starts with: the initialize request
/// answered with what the agent says about itself, and the settings it
/// runs on.
const READY: &str = r#"expect "subtype":"initialize"
reply {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"account":{"apiProvider":"firstParty","subscriptionType":"pro"},"current_permission_mode":"default","claude_code_version":"9.9.9","models":[{"value":"haiku","displayName":"Haiku"},{"value":"sonnet","resolvedModel":"claude-sonnet","supportedEffortLevels":["low","high"]}],"commands":[]}}}
expect "subtype":"get_settings"
reply {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"applied":{"effort":"high"}}}}"#;

/// The agent saying it took the message last read.
const TAKE: &str =
    r#"reply {"type":"command_lifecycle","command_uuid":"@UUID@","state":"started"}"#;

const INIT: &str = r#"say {"type":"system","subtype":"init","model":"claude-haiku","permissionMode":"default","session_id":"s"}"#;

const DONE: &str = r#"say {"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.01,"duration_ms":5,"usage":{"input_tokens":3,"output_tokens":4}}"#;

struct Harness {
    dir: Scratch,
    sessions: Arc<Sessions>,
    recorder: Arc<Recorder>,
    id: String,
    session: String,
    waits: Waits,
    vars: HashMap<String, String>,
}

fn start(name: &str, scenario: &str) -> Harness {
    start_with(name, scenario, |_| {})
}

/// A session that keeps `deadlines`, for a test of one of them.
fn start_keeping(name: &str, scenario: &str, deadlines: Deadlines) -> Harness {
    start_in(
        name,
        scenario,
        Arc::new(Sessions::with_deadlines(deadlines)),
        |_| {},
    )
}

/// The graces after a stop, short, for a test that ends an agent that will
/// not end by itself.
fn short_graces() -> Deadlines {
    Deadlines {
        stop_grace: Duration::from_secs(1),
        term_grace: Duration::from_secs(1),
        group_grace: Duration::from_millis(500),
        ..Deadlines::default()
    }
}

fn start_with(name: &str, scenario: &str, adjust: impl FnOnce(&mut Launch)) -> Harness {
    start_in(name, scenario, Arc::new(Sessions::default()), adjust)
}

fn start_in(
    name: &str,
    scenario: &str,
    sessions: Arc<Sessions>,
    adjust: impl FnOnce(&mut Launch),
) -> Harness {
    let dir = Scratch::new(&format!("integrated-{name}"));
    let claude = dir.join("claude");
    crate::executable::write(&claude, STAND_IN).unwrap();
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
        ("CHORD_SESSION".to_string(), "the-parent".to_string()),
        ("KEEP_ME".to_string(), "yes".to_string()),
    ]);
    let recorder = Arc::new(Recorder::default());
    let session = format!("session-{name}");
    let mut launch = Launch {
        project: &dir,
        env: &vars,
        session: Some(&session),
        token: None,
        resume: false,
        model: Some("haiku"),
        mode: Some("default"),
        effort: None,
        config_dir: None,
        tool_server: None,
        orchestrator: false,
        instructions: None,
        start_only: false,
        afresh: false,
        compact_at: None,
        resume_at: None,
    };
    adjust(&mut launch);
    let started = super::start(
        recorder.clone(),
        Arc::clone(&sessions),
        &CLAUDE_STREAM,
        &launch,
        Box::new(|_| {}),
        Box::new(|_| {}),
    )
    .unwrap();
    assert_eq!(started.session_id.as_deref(), Some(session.as_str()));
    Harness {
        dir,
        sessions,
        recorder,
        id: started.id,
        session,
        waits: Waits::default(),
        vars,
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

    /// Waits for an event past the last match, and hands back every event
    /// from the start up to and with it.
    fn until(&self, what: impl Fn(&Value) -> bool) -> Vec<Value> {
        self.waits.until(|| self.events(), what)
    }

    /// Waits for the session to go into `state`, and hands back every state
    /// it has told up to and with it.
    fn until_state(&self, state: &str) -> Vec<String> {
        states(&self.until(|event| event["type"] == "state" && event["state"] == state))
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

    /// Sends a message under a fresh id, and hands back the id.
    fn send(&self, text: &str) -> String {
        let message = uuid::Uuid::new_v4().to_string();
        send(&self.sessions, &self.id, &message, text, &[]).unwrap();
        message
    }

    fn stop(&self) -> Value {
        stop(&self.sessions, &self.id).unwrap();
        self.until_type("ended").pop().unwrap()
    }

    /// Everything the session `id` said, in order.
    fn events_of(&self, id: &str) -> Vec<Value> {
        self.recorder
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, payload)| name == INTEGRATED_EVENT && payload["id"] == id)
            .map(|(_, payload)| payload.clone())
            .collect()
    }

    /// The arguments the stand-in was started with the `run`th time.
    fn args(&self, run: usize) -> Vec<String> {
        std::fs::read_to_string(self.dir.join(format!("args.{run}")))
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// Starts the stand-in again in the session's folder as `again` says,
    /// the way the core starts a session again: on the conversation named,
    /// or a new one, from the entry named, on the settings given.
    fn again(&self, again: &Again) -> Result<Started, String> {
        let fresh = format!("{}-anew", self.session);
        let session = again.session.clone().unwrap_or(fresh);
        let launch = Launch {
            project: &self.dir,
            env: &self.vars,
            session: Some(&session),
            token: Some("token-kept"),
            resume: again.session.is_some(),
            model: again.settings.model.as_deref(),
            mode: again.settings.mode.as_deref(),
            effort: again.settings.effort.as_deref(),
            config_dir: None,
            tool_server: None,
            orchestrator: false,
            instructions: None,
            start_only: false,
            afresh: false,
            compact_at: None,
            resume_at: again.at.as_deref(),
        };
        super::start(
            self.recorder.clone(),
            Arc::clone(&self.sessions),
            &CLAUDE_STREAM,
            &launch,
            Box::new(|_| {}),
            Box::new(|_| {}),
        )
    }

    /// Writes the transcript the stand-in finds an entry to resume at in.
    fn transcript(&self, entries: &[&str]) {
        let lines: Vec<String> = entries
            .iter()
            .map(|uuid| json!({ "type": "assistant", "uuid": uuid }).to_string())
            .collect();
        std::fs::write(self.dir.join("transcript"), lines.join("\n")).unwrap();
    }

    /// Writes the scenario the stand-in plays the `run`th time it starts.
    fn then(&self, run: usize, scenario: &str) {
        std::fs::write(self.dir.join(format!("scenario.{run}")), scenario).unwrap();
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
        TAKE,
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
    assert_eq!(ready[0]["mode"], "default");
    assert_eq!(ready[0]["effort"], "high");
    // A conversation it began has no run before this one.
    assert_eq!(snapshot(&h.sessions, &h.id).unwrap().resumed_at, None);

    let message = h.send("say hello");
    let events = h.until_type("turnEnded");
    assert_eq!(
        kinds(&events),
        [
            "ready",
            "state",
            "message",
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
    // The message as it was sent, for any window to draw.
    assert_eq!(
        events[2],
        json!({"id": h.id, "type": "message", "message": message, "state": "sent",
               "error": null, "text": "say hello", "images": []})
    );
    assert_eq!(events[4]["messages"], json!([message]));
    assert_eq!(events[5]["model"], "claude-haiku");
    assert_eq!(events[8]["text"], "hello");
    assert_eq!(events[8]["done"], true);
    assert_eq!(events[6]["block"], events[8]["block"]);
    let ended = &events[9];
    assert_eq!(ended["outcome"], "done");
    assert_eq!(ended["totalCostUsd"], 0.01);
    assert_eq!(ended["usage"]["outputTokens"], 4);
    assert_eq!(h.until_state("idle"), ["idle", "working", "idle"]);

    let sent: Vec<Value> = h
        .stdin()
        .into_iter()
        .filter(|line| line["type"] == "user")
        .collect();
    assert_eq!(sent[0]["message"]["content"], "say hello");
    assert_eq!(sent[0]["uuid"], message.as_str());

    let end = h.stop();
    assert_eq!(end["clean"], true);
    assert!(!kinds(&h.events()).contains(&"error".to_string()));
    assert!(!h.sessions.holds(&h.id));
}

#[test]
fn the_command_line_and_environment_are_the_stream_session_s() {
    let server = PathBuf::from("/opt/workbench/chord-remote");
    let config = PathBuf::from("/home/ada/.claude-work");
    let before = now_millis();
    let h = start_with("command", &format!("{READY}\ndrain"), |launch| {
        launch.resume = true;
        launch.token = Some("token-command");
        launch.tool_server = Some(Box::leak(server.clone().into_boxed_path()));
        launch.config_dir = Some(Box::leak(config.clone().into_boxed_path()));
        launch.orchestrator = true;
    });
    h.until_type("ready");
    // A resumed conversation says when this run of it began.
    let began = snapshot(&h.sessions, &h.id).unwrap().resumed_at.unwrap();
    assert!((before..=now_millis()).contains(&began), "{began}");
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
        "--replay-user-messages",
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
    // The tool server's configuration is a file of the session's own, with
    // a name that cannot be guessed, that its owner alone can read.
    let file = PathBuf::from(after("--mcp-config"));
    assert!(!file.to_string_lossy().contains(&h.session), "{file:?}");
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let mcp: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(
        mcp["mcpServers"]["chord"],
        json!({"type": "stdio", "command": server.to_string_lossy(), "args": ["mcp"]})
    );

    let env = std::fs::read_to_string(h.dir.join("env")).unwrap();
    let has = |line: &str| env.lines().any(|l| l == line);
    assert!(!env.lines().any(|l| l.starts_with("CLAUDECODE=")), "{env}");
    // The tools are told the session by the workbench's token for it,
    // never by the agent's own id, and never by the parent's.
    assert!(has("CHORD_SESSION=token-command"), "{env}");
    assert!(!has(&format!("CHORD_SESSION={}", h.session)), "{env}");
    assert!(has("CHORD_ROLE=orchestrator"), "{env}");
    // And that it is drawn as a conversation, which says how its turns end.
    assert!(has("CHORD_VIEW=conversation"), "{env}");
    assert!(
        has(&format!("CLAUDE_CONFIG_DIR={}", config.display())),
        "{env}"
    );
    assert!(has("KEEP_ME=yes"), "{env}");
    assert!(has("CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1"), "{env}");
    // The files are kept as they were before each message, as the
    // terminal keeps them, so that they can go back.
    assert!(
        has("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true"),
        "{env}"
    );
    // A conversation resumed from its newest entry names no other.
    assert!(!args.contains(&"--resume-session-at".to_string()));
    assert!(!env.lines().any(|l| l.starts_with("ANTHROPIC_API_KEY=")));
    h.stop();
    let deadline = Instant::now() + Duration::from_secs(5);
    while file.exists() {
        assert!(Instant::now() < deadline, "{file:?} outlived the session");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The arguments the stand-in was started with, one a line.
fn arguments(h: &Harness) -> Vec<String> {
    std::fs::read_to_string(h.dir.join("args"))
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect()
}

#[test]
fn a_session_under_a_workflow_is_told_it_and_delegates_only_through_start() {
    let server = PathBuf::from("/opt/workbench/chord-remote");
    let told = "1. Direct the work.\n2. Say \"done\" when it is.";
    let h = start_with("workflow", &format!("{READY}\ndrain"), |launch| {
        launch.resume = true;
        launch.token = Some("token-flow");
        launch.tool_server = Some(Box::leak(server.clone().into_boxed_path()));
        launch.orchestrator = true;
        launch.instructions = Some(told);
        launch.start_only = true;
        launch.afresh = true;
    });
    h.until_type("ready");
    let args = arguments(&h);
    let at = |flag: &str| {
        args.iter()
            .position(|arg| arg == flag)
            .unwrap_or_else(|| panic!("{flag} in {args:?}"))
    };
    // Its own ways to hand work out are taken away, as in a terminal, and
    // a flag of its own ends the list.
    let listed = at("--disallowedTools");
    assert_eq!(
        args[listed + 1..listed + 6],
        [
            "Agent",
            "Workflow",
            "SendMessage",
            "ListAgents",
            "RemoteTrigger"
        ]
    );
    assert!(args[listed + 6].starts_with("--"), "{args:?}");
    // The instructions are read from a file of the session's own, which
    // only its owner can read, so nothing on the command line has a line
    // break or a quote for a command interpreter to cut at.
    let file = PathBuf::from(&args[at("--append-system-prompt-file") + 1]);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), told);
    assert!(!file.to_string_lossy().contains(&h.session), "{file:?}");
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    assert!(
        args.iter().all(|arg| !arg.contains(['\n', '"'])),
        "{args:?}"
    );
    // Resumed with other instructions than it was first given, it reads
    // these rather than the record it keeps.
    assert_eq!(args[at("--system-prompt-snapshot") + 1], "off");
    // The tool server is last, since its flag takes what follows it.
    assert_eq!(args[args.len() - 2], "--mcp-config");
    let env = std::fs::read_to_string(h.dir.join("env")).unwrap();
    let has = |line: &str| env.lines().any(|l| l == line);
    assert!(has("CHORD_SESSION=token-flow"), "{env}");
    assert!(has("CHORD_ROLE=orchestrator"), "{env}");
    h.stop();
    let deadline = Instant::now() + Duration::from_secs(5);
    while file.exists() {
        assert!(Instant::now() < deadline, "{file:?} outlived the session");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_session_given_a_context_to_compact_at_passes_it_to_the_agent() {
    let h = start_with("compact-at", &format!("{READY}\ndrain"), |launch| {
        launch.compact_at = Some(150_000);
        launch.tool_server = Some(Box::leak(
            PathBuf::from("/opt/workbench/chord-remote").into_boxed_path(),
        ));
    });
    h.until_type("ready");
    let args = arguments(&h);
    let at = args
        .iter()
        .position(|arg| arg == "--autocompact")
        .unwrap_or_else(|| panic!("--autocompact in {args:?}"));
    assert_eq!(args[at + 1], "150000");
    assert_eq!(args[args.len() - 2], "--mcp-config");
    h.stop();

    let h = start_with("no-compact-at", &format!("{READY}\ndrain"), |_| {});
    h.until_type("ready");
    let args = arguments(&h);
    assert!(!args.contains(&"--autocompact".to_string()), "{args:?}");
    h.stop();
}

#[test]
fn a_session_under_no_workflow_keeps_its_own_tools_and_is_told_nothing() {
    // A fresh session has no record to let go of, whatever it is told.
    let h = start_with("no-workflow", &format!("{READY}\ndrain"), |launch| {
        launch.afresh = true;
    });
    h.until_type("ready");
    let args = arguments(&h);
    for flag in [
        "--disallowedTools",
        "--append-system-prompt-file",
        "--system-prompt-snapshot",
    ] {
        assert!(!args.contains(&flag.to_string()), "{flag} in {args:?}");
    }
    let env = std::fs::read_to_string(h.dir.join("env")).unwrap();
    assert!(!env.lines().any(|l| l.starts_with("CHORD_ROLE=")), "{env}");
    h.stop();

    // Resumed without the workflow it was given, it lets go of the record
    // and is given nothing in its place.
    let h = start_with("left-workflow", &format!("{READY}\ndrain"), |launch| {
        launch.resume = true;
        launch.afresh = true;
    });
    h.until_type("ready");
    let args = arguments(&h);
    let at = args
        .iter()
        .position(|arg| arg == "--system-prompt-snapshot")
        .unwrap();
    assert_eq!(args[at + 1], "off");
    assert!(!args.contains(&"--append-system-prompt-file".to_string()));
    assert!(!args.contains(&"--disallowedTools".to_string()));
    h.stop();
}

#[test]
fn a_tool_call_finishes_with_its_file_change() {
    let scenario = [
        READY,
        r#"expect "type":"user""#,
        TAKE,
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
    assert_eq!(started["kind"], "edit");
    let input = events.iter().find(|e| e["type"] == "toolInput").unwrap();
    assert_eq!(input["input"]["file_path"], "/p/notes.txt");
    let finished = events.iter().find(|e| e["type"] == "toolFinished").unwrap();
    assert_eq!(finished["call"], "t1");
    assert_eq!(finished["output"], "File created");
    assert_eq!(finished["changes"][0]["kind"], "create");
    assert_eq!(finished["changes"][0]["path"], "/p/notes.txt");
    assert_eq!(finished["changes"][0]["content"], "one\n");
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
        TAKE.into(),
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
        h.until_state("asking");
        answer(&h.sessions, &h.id, request, choice, message).unwrap();
        h.until_state("working");
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

    // Every window hears what each request was answered with.
    let told: Vec<Value> = events
        .iter()
        .filter(|e| e["type"] == "answered")
        .map(|e| json!([e["request"], e["choice"], e["message"]]))
        .collect();
    assert_eq!(
        told,
        [
            json!(["p1", "allow", null]),
            json!(["p2", "allowSession", null]),
            json!(["p3", "allowAlways", null]),
            json!(["p4", "deny", "not that one"]),
        ]
    );

    assert!(
        answer(&h.sessions, &h.id, "p1", Choice::Allow, None).is_err(),
        "a request is answered once"
    );
    h.stop();
}

#[test]
fn a_question_is_answered_with_a_reply_of_its_own() {
    let scenario = [
        READY,
        r#"expect "type":"user""#,
        TAKE,
        INIT,
        r#"say {"type":"control_request","request_id":"q1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","tool_use_id":"t1","input":{"questions":[{"question":"Which colour?","header":"Colour","options":[{"label":"Red"},{"label":"Blue"}],"multiSelect":false}]}}}"#,
        r#"expect "request_id":"q1""#,
        DONE,
        "drain",
    ]
    .join("\n");
    let h = start("question", &scenario);
    h.until_type("ready");
    h.send("ask me");
    let asked = h.until_type("questionAsked");
    let asked = asked.last().unwrap();
    assert_eq!(asked["questions"][0]["options"][1]["label"], "Blue");
    assert_eq!(h.until_state("asking"), ["idle", "working", "asking"]);
    assert!(answer(&h.sessions, &h.id, "q1", Choice::Allow, None).is_err());
    reply(&h.sessions, &h.id, "q1", Some(&[vec!["Green".into()]])).unwrap();
    let events = h.until_type("turnEnded");
    let answered = events.iter().find(|e| e["type"] == "answered").unwrap();
    assert_eq!(answered["request"], "q1");
    assert_eq!(answered["choice"], "allow");
    assert_eq!(answered["answers"], json!([["Green"]]));
    let replied = h
        .stdin()
        .into_iter()
        .find(|line| line["response"]["request_id"] == "q1")
        .unwrap();
    assert_eq!(
        replied["response"]["response"]["updatedInput"]["answers"]["Which colour?"],
        "Green"
    );
    assert_eq!(
        h.until_state("idle"),
        ["idle", "working", "asking", "working", "idle"]
    );
    h.stop();
}

#[test]
fn an_interrupt_withdraws_what_was_asked_and_ends_the_turn() {
    let scenario = [
        READY,
        r#"expect "type":"user""#,
        TAKE,
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
    let withdrawn = events.iter().find(|e| e["type"] == "withdrawn").unwrap();
    assert_eq!(withdrawn["request"], "p1");
    assert_eq!(events.last().unwrap()["outcome"], "interrupted");
    assert_eq!(events.last().unwrap()["error"], Value::Null);
    assert_eq!(
        h.until_state("idle"),
        ["idle", "working", "asking", "working", "idle"]
    );
    h.stop();
}

#[test]
fn the_model_the_mode_and_the_effort_change_on_request() {
    let scenario = [
        READY,
        r#"expect "subtype":"set_model""#,
        r#"reply {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"model":"claude-sonnet"}}}"#,
        r#"expect "subtype":"set_model""#,
        r#"reply {"type":"control_response","response":{"subtype":"error","request_id":"@ID@","error":"Model 'no-such' not found"}}"#,
        r#"expect "subtype":"set_permission_mode""#,
        r#"reply {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"mode":"acceptEdits"}}}"#,
        r#"expect "effortLevel":"low""#,
        r#"reply {"type":"control_response","response":{"subtype":"success","request_id":"@ID@"}}"#,
        "drain",
    ]
    .join("\n");
    let h = start("model", &scenario);
    h.until_type("ready");
    let settings = configure(&h.sessions, &h.id, Some("sonnet"), None, None).unwrap();
    assert_eq!(settings.model.as_deref(), Some("claude-sonnet"));
    assert_eq!(
        configure(&h.sessions, &h.id, Some("no-such"), None, None).unwrap_err(),
        "Model 'no-such' not found"
    );
    let settings = configure(&h.sessions, &h.id, None, Some("acceptEdits"), Some("low")).unwrap();
    assert_eq!(
        settings,
        Settings {
            model: Some("claude-sonnet".into()),
            mode: Some("acceptEdits".into()),
            effort: Some("low".into()),
        }
    );
    let configured: Vec<Value> = h
        .events()
        .into_iter()
        .filter(|e| e["type"] == "configured")
        .collect();
    assert_eq!(configured.len(), 3, "{configured:?}");
    assert_eq!(configured[0]["model"], "claude-sonnet");
    assert_eq!(configured[0]["efforts"], json!(["low", "high"]));
    assert_eq!(configured[1]["mode"], "acceptEdits");
    assert_eq!(configured[2]["effort"], "low");
    h.stop();
}

#[test]
fn a_subagent_s_messages_and_the_turn_the_agent_starts_after_it() {
    let scenario = [
        READY,
        r#"expect "type":"user""#,
        TAKE,
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
    assert_eq!(turns[0]["messages"], json!([message]));
    assert_eq!(
        turns[1]["messages"],
        json!([]),
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
    assert_eq!(h.until_state("idle"), ["idle", "working", "idle"]);
    h.stop();
}

#[test]
fn a_message_sent_during_a_turn_is_queued_and_gets_its_own_turn() {
    let scenario = [
        READY,
        r#"expect "first""#,
        TAKE,
        INIT,
        r#"expect "second""#,
        DONE,
        TAKE,
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
    let queued = h.until(|e| e["type"] == "message" && e["state"] == "queued");
    assert_eq!(queued.last().unwrap()["message"], second.as_str());
    assert_eq!(queued.last().unwrap()["text"], "second");
    h.until_type("turnEnded");
    h.until_type("turnEnded");
    let started: Vec<Value> = h
        .events()
        .into_iter()
        .filter(|e| e["type"] == "turnStarted")
        .map(|e| e["messages"].clone())
        .collect();
    assert_eq!(started, [json!([first]), json!([second])]);
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
fn the_account_s_limits_are_read_when_ready_and_move_with_its_responses() {
    let scenario = [
        READY,
        r#"expect "subtype":"get_usage""#,
        r#"reply {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"subscription_type":"max","rate_limits_available":true,"rate_limits":{"seven_day_opus":null,"limits":[{"kind":"session","group":"session","percent":20,"severity":"normal","resets_at":"2030-01-01T05:00:00+00:00","scope":null,"is_active":false},{"kind":"weekly_all","group":"weekly","percent":40,"severity":"normal","resets_at":"2030-01-05T00:00:00+00:00","scope":null,"is_active":true}]}}}}"#,
        r#"expect "type":"user""#,
        TAKE,
        INIT,
        r#"say {"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","rateLimitType":"five_hour","utilization":0.5,"resetsAt":1893474000},"uuid":"r1","session_id":"s"}"#,
        DONE,
        // A turn that ends soon after the read asks for none of its own.
        r#"expect "type":"user""#,
        TAKE,
        INIT,
        DONE,
        "drain",
    ]
    .join("\n");
    let h = start("limits", &scenario);
    let read = h.until_type("limits");
    let read = read.last().unwrap();
    assert_eq!(read["agent"], "claude-code");
    assert_eq!(read["plan"], "max");
    assert_eq!(
        read["windows"],
        json!([
            {"kind": "session", "model": null, "percent": 20.0, "resetsAt": 1_893_474_000_u64,
             "severity": "normal"},
            {"kind": "weekly", "model": null, "percent": 40.0, "resetsAt": 1_893_801_600_u64,
             "severity": "normal"}
        ])
    );
    let taken_at = read["takenAt"].as_u64().unwrap();
    assert!(taken_at.abs_diff(now_seconds()) < 60);
    assert_eq!(read["readAt"], taken_at, "a read gives every figure");
    // A window that comes late has them too, as the event told them.
    let late = serde_json::to_value(snapshot(&h.sessions, &h.id).unwrap()).unwrap();
    let mut told = read.clone();
    told.as_object_mut().unwrap().remove("id");
    assert_eq!(late["limits"], told);

    h.send("how much is left");
    let events = h.until_type("turnEnded");
    let moved = events.iter().rfind(|e| e["type"] == "limits").unwrap();
    assert_eq!(moved["windows"][0]["percent"], 50.0);
    assert_eq!(moved["windows"][0]["severity"], "warning");
    assert_eq!(moved["windows"][1]["percent"], 40.0, "the week as read");
    assert_eq!(moved["plan"], "max");
    assert_eq!(moved["readAt"], taken_at, "the read is as old as it was");

    h.send("and now");
    h.until_type("turnEnded");
    let late = serde_json::to_value(snapshot(&h.sessions, &h.id).unwrap()).unwrap();
    assert_eq!(late["limits"]["windows"][0]["percent"], 50.0);
    let reads = h
        .stdin()
        .into_iter()
        .filter(|line| line["request"]["subtype"] == "get_usage")
        .inspect(|line| assert_eq!(line["request"]["skip_behaviors"], true))
        .count();
    assert_eq!(reads, 1, "read when ready, and not again so soon");
    h.stop();
}

#[test]
fn a_read_of_the_limits_that_fails_says_nothing_and_the_session_goes_on() {
    let scenario = [
        READY,
        r#"expect "subtype":"get_usage""#,
        r#"reply {"type":"control_response","response":{"subtype":"error","request_id":"@ID@","error":"get_usage is not supported in this context"}}"#,
        r#"expect "type":"user""#,
        TAKE,
        INIT,
        r#"say {"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"still here"}]},"parent_tool_use_id":null}"#,
        DONE,
        "drain",
    ]
    .join("\n");
    let h = start("limits-refused", &scenario);
    h.until_type("ready");
    h.send("are you there");
    let events = h.until(|e| e["type"] == "text" && e["text"] == "still here");
    h.until_type("turnEnded");
    assert!(!kinds(&events).contains(&"error".to_string()), "{events:?}");
    assert!(!kinds(&h.events()).contains(&"limits".to_string()));
    let late = serde_json::to_value(snapshot(&h.sessions, &h.id).unwrap()).unwrap();
    assert_eq!(late["limits"], Value::Null);
    h.stop();
}

#[test]
fn a_process_that_dies_mid_turn_fails_the_turn_and_says_so() {
    let scenario = [
        READY,
        r#"expect "type":"user""#,
        TAKE,
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
    assert!(send(
        &h.sessions,
        &h.id,
        &uuid::Uuid::new_v4().to_string(),
        "anyone?",
        &[]
    )
    .is_err());
}

#[test]
fn a_session_that_will_not_end_is_killed_without_an_error() {
    let h = start_keeping("stubborn", &format!("{READY}\nsleep 60"), short_graces());
    h.until_type("ready");
    let started = Instant::now();
    let end = h.stop();
    assert!(started.elapsed() < Duration::from_secs(50));
    assert_eq!(end["clean"], false);
    assert!(!kinds(&h.events()).contains(&"error".to_string()));
}

#[test]
fn stopping_twice_or_before_ready_ends_the_session_once() {
    let h = start("early-stop", "sleep 60");
    stop(&h.sessions, &h.id).unwrap();
    stop(&h.sessions, &h.id).unwrap();
    let events = h.until_type("ended");
    assert_eq!(kinds(&events), ["ended"], "no ready and no error");
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        kinds(&h.events())
            .iter()
            .filter(|kind| *kind == "ended")
            .count(),
        1
    );
    assert!(stop(&h.sessions, &h.id).is_err(), "gone");
}

#[test]
fn stopping_with_a_permission_asked_withdraws_it_and_a_late_answer_fails() {
    let scenario = [
        READY,
        r#"expect "type":"user""#,
        TAKE,
        INIT,
        r#"say {"type":"control_request","request_id":"p1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}"#,
        "drain",
    ]
    .join("\n");
    let h = start("stop-asking", &scenario);
    h.until_type("ready");
    h.send("go");
    h.until_type("permissionAsked");
    stop(&h.sessions, &h.id).unwrap();
    stop(&h.sessions, &h.id).unwrap();
    let late = answer(&h.sessions, &h.id, "p1", Choice::Allow, None);
    let events = h.until_type("ended");
    let tail: Vec<String> = kinds(&events).into_iter().rev().take(3).rev().collect();
    assert_eq!(tail, ["turnEnded", "withdrawn", "ended"]);
    assert_eq!(events.last().unwrap()["clean"], true);
    let answered = events.iter().filter(|e| e["type"] == "answered").count();
    assert_eq!(
        (late.is_err(), answered),
        (true, 0),
        "an answer after the stop does not reach the agent: {late:?}"
    );
}

#[test]
fn an_agent_that_never_says_it_is_ready_is_ended_with_one_error() {
    let h = start_keeping(
        "never-ready",
        "sleep 60",
        Deadlines {
            ready: Duration::from_secs(1),
            ..Deadlines::default()
        },
    );
    let events = h.until_type("ended");
    assert_eq!(kinds(&events), ["error", "ended"]);
    assert_eq!(events[0]["kind"], "protocol");
    assert!(events[0]["message"]
        .as_str()
        .unwrap()
        .contains("ready in time"));
}

#[test]
fn an_agent_that_stops_reading_is_ended_and_nothing_is_written_late() {
    let h = start_keeping(
        "deaf",
        &format!("{READY}\nsleep 60"),
        Deadlines {
            write: Duration::from_secs(1),
            ..short_graces()
        },
    );
    h.until_type("ready");
    // More than any pipe holds, so the line waits on an agent that does
    // not read.
    let text = "x".repeat(4 * 1024 * 1024);
    let message = uuid::Uuid::new_v4().to_string();
    let error = send(&h.sessions, &h.id, &message, &text, &[]).unwrap_err();
    assert!(error.contains("stopped reading"), "{error}");
    let events = h.until_type("ended");
    let errors: Vec<&Value> = events.iter().filter(|e| e["type"] == "error").collect();
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert_eq!(errors[0]["kind"], "process");
    assert!(events.iter().any(|e| e["type"] == "message"
        && e["message"] == message.as_str()
        && e["state"] == "dropped"));
}

#[test]
fn a_line_too_long_is_skipped_and_the_session_goes_on() {
    let scenario = [
        READY.to_string(),
        r#"expect "type":"user""#.into(),
        TAKE.into(),
        format!("big {}", LINE_KEEP + 10),
        INIT.into(),
        r#"say {"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}]},"parent_tool_use_id":null}"#.into(),
        format!("bigresult toolu_1 {}", LINE_KEEP + 10),
        r#"say {"type":"system","subtype":"status","status":"requesting"}"#.into(),
        DONE.into(),
        "drain".into(),
    ]
    .join("\n");
    let h = start("long-line", &scenario);
    h.until_type("ready");
    h.send("go");
    let events = h.until_type("turnEnded");
    let error = events.iter().find(|e| e["type"] == "error").unwrap();
    assert_eq!(error["kind"], "protocol");
    assert_eq!(events.last().unwrap()["outcome"], "done");
    // The call whose result was too long finishes as cut short when its
    // result goes by, not when the turn ends.
    let finished: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "toolFinished")
        .collect();
    assert_eq!(finished.len(), 1, "{events:#?}");
    assert_eq!(finished[0]["call"], "toolu_1");
    assert_eq!(finished[0]["truncated"], true);
    assert_eq!(finished[0]["error"], true);
    h.stop();
}

#[test]
fn dying_with_a_permission_asked_withdraws_it_and_says_what_stderr_said() {
    let scenario = [
        READY,
        r#"expect "type":"user""#,
        TAKE,
        INIT,
        r#"say {"type":"control_request","request_id":"p1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}"#,
        "err something broke inside",
        "exit 3",
    ]
    .join("\n");
    let h = start("dies-asking", &scenario);
    h.until_type("ready");
    h.send("go");
    let events = h.until_type("ended");
    let tail: Vec<String> = kinds(&events).into_iter().rev().take(4).rev().collect();
    assert_eq!(tail, ["turnEnded", "withdrawn", "error", "ended"]);
    let n = events.len();
    assert!(events[n - 2]["message"]
        .as_str()
        .unwrap()
        .contains("code 3: something broke inside"));
    assert_eq!(events[n - 1]["code"], 3);
}

#[test]
fn a_turn_the_agent_starts_by_itself_names_no_message() {
    // As after a background shell finishes while the session is idle.
    let scenario = [READY, INIT, DONE, "drain"].join("\n");
    let h = start("own-turn", &scenario);
    let events = h.until_type("turnEnded");
    let started = events.iter().find(|e| e["type"] == "turnStarted").unwrap();
    assert_eq!(started["messages"], json!([]));
    assert_eq!(h.until_state("idle"), ["idle", "working", "idle"]);
    h.stop();
}

/// The pid of what the stand-in left running, once it has.
fn spawned(h: &Harness) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(pid) = std::fs::read_to_string(h.dir.join("child")) {
            if !pid.trim().is_empty() {
                return pid.trim().to_string();
            }
        }
        assert!(Instant::now() < deadline, "the stand-in never spawned");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn alive(pid: &str) -> bool {
    std::process::Command::new("kill")
        .args(["-0", pid])
        .status()
        .is_ok_and(|status| status.success())
}

#[test]
fn what_the_agent_left_running_goes_with_it() {
    for (name, step) in [("group", "spawn"), ("group-deaf", "deaf")] {
        let h = start_keeping(name, &format!("{READY}\n{step}\ndrain"), short_graces());
        h.until_type("ready");
        let child = spawned(&h);
        assert!(alive(&child));
        assert_eq!(h.stop()["clean"], true);
        // One that ignores being asked to end is killed a little later.
        let deadline = Instant::now() + Duration::from_secs(60);
        while alive(&child) {
            assert!(
                Instant::now() < deadline,
                "{step}: {child} outlived the session"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[test]
fn a_session_that_lingers_is_asked_to_end_before_it_is_killed() {
    // The agent ends what it left running in the background when it is
    // asked to end; killed outright, it cannot.
    let h = start_keeping("linger", &format!("{READY}\nlinger"), short_graces());
    h.until_type("ready");
    let end = h.stop();
    assert!(h.dir.join("termed").exists(), "asked to end first");
    assert_eq!(end["clean"], true);
    assert!(!kinds(&h.events()).contains(&"error".to_string()));
}

#[test]
fn stop_all_ends_every_session() {
    let sessions = Arc::new(Sessions::with_deadlines(short_graces()));
    let a = start_in(
        "all-a",
        &format!("{READY}\ndrain"),
        Arc::clone(&sessions),
        |_| {},
    );
    let b = start_in(
        "all-b",
        &format!("{READY}\nsleep 60"),
        Arc::clone(&sessions),
        |_| {},
    );
    a.until_type("ready");
    b.until_type("ready");
    let started = Instant::now();
    stop_all(&sessions);
    assert!(started.elapsed() < Duration::from_secs(50));
    assert!(sessions.ids().is_empty(), "both gone when it returns");
    a.until_type("ended");
    b.until_type("ended");
}

const BACK_TO: &str = "11111111-1111-4111-8111-111111111111";

/// The dry run of putting the files back, and putting them back.
const FILES_BACK: &str = r#"expect "subtype":"rewind_files"
reply {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"canRewind":true,"filesChanged":["/w/a.txt","/w/b.txt"],"insertions":1,"deletions":4}}}
expect "subtype":"rewind_files"
reply {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"canRewind":true,"skippedLinks":0}}}"#;

/// The files a preview showed, which going back puts back.
fn shown() -> Vec<String> {
    vec!["/w/a.txt".to_string(), "/w/b.txt".to_string()]
}

fn value_after(args: &[String], flag: &str) -> Option<String> {
    let at = args.iter().position(|arg| arg == flag)?;
    args.get(at + 1).cloned()
}

fn rewound(events: &[Value]) -> Vec<Value> {
    events
        .iter()
        .filter(|event| event["type"] == "rewound")
        .cloned()
        .collect()
}

#[test]
fn going_back_starts_the_conversation_again_from_the_entry_before_the_message() {
    let h = start("rewind", &format!("{READY}\ndrain"));
    h.transcript(&["entry-before"]);
    h.then(2, &format!("{READY}\ndrain"));
    h.until_type("ready");
    let went = rewind(
        &h.sessions,
        &h.id,
        BACK_TO,
        Back::Entry(Some("entry-before".into())),
        None,
        &|again| h.again(again),
    )
    .unwrap();
    let next = went.id.clone().unwrap();
    assert_ne!(next, h.id);
    assert_eq!(went.session_id.as_deref(), Some(h.session.as_str()));
    assert_eq!((went.fallback, went.error), (None, None));
    assert!(went.files.is_empty());
    // The session it went back from ended cleanly before the answer came.
    let ended = h.events();
    assert_eq!(ended.last().unwrap()["type"], "ended");
    assert_eq!(ended.last().unwrap()["clean"], true);
    assert!(!h.sessions.holds(&h.id));
    // Started again on the same conversation, from the entry, on the
    // settings it ran on.
    let args = h.args(2);
    assert_eq!(value_after(&args, "--resume"), Some(h.session.clone()));
    assert_eq!(
        value_after(&args, "--resume-session-at").as_deref(),
        Some("entry-before")
    );
    assert_eq!(value_after(&args, "--model").as_deref(), Some("haiku"));
    assert_eq!(value_after(&args, "--effort").as_deref(), Some("high"));
    assert_eq!(
        value_after(&args, "--permission-mode").as_deref(),
        Some("default")
    );
    // It says so once it is ready, before the answer, and goes on.
    let events = h.events_of(&next);
    assert_eq!(events[0]["type"], "ready");
    assert_eq!(
        rewound(&events),
        [
            json!({"id": next, "type": "rewound", "message": BACK_TO, "conversation": true, "files": []})
        ]
    );
    rest(&h.sessions, &next).unwrap();
    stop(&h.sessions, &next).unwrap();
}

#[test]
fn the_files_go_back_first_while_the_message_is_still_in_the_conversation() {
    let h = start("rewind-files", &format!("{READY}\n{FILES_BACK}\ndrain"));
    h.transcript(&["entry-before"]);
    h.then(2, &format!("{READY}\ndrain"));
    h.until_type("ready");
    let went = rewind(
        &h.sessions,
        &h.id,
        BACK_TO,
        Back::Entry(Some("entry-before".into())),
        Some(&shown()),
        &|again| h.again(again),
    )
    .unwrap();
    assert_eq!(went.files, ["/w/a.txt", "/w/b.txt"]);
    // Asked of the session being left, a dry run for the list and then the
    // real one, both before it was stopped.
    let asked: Vec<Value> = h
        .stdin()
        .into_iter()
        .filter(|line| line["request"]["subtype"] == "rewind_files")
        .map(|line| line["request"].clone())
        .collect();
    assert_eq!(
        asked,
        [
            json!({"subtype": "rewind_files", "user_message_id": BACK_TO, "dry_run": true}),
            json!({"subtype": "rewind_files", "user_message_id": BACK_TO, "dry_run": false}),
        ]
    );
    let next = went.id.unwrap();
    assert_eq!(
        rewound(&h.events_of(&next))[0]["files"],
        json!(["/w/a.txt", "/w/b.txt"])
    );
    stop(&h.sessions, &next).unwrap();
}

#[test]
fn only_the_files_go_back_in_the_same_session() {
    let h = start(
        "rewind-only-files",
        &format!("{READY}\n{FILES_BACK}\ndrain"),
    );
    h.until_type("ready");
    let refused = rewind(&h.sessions, &h.id, BACK_TO, Back::Files, None, &|again| {
        h.again(again)
    });
    assert!(refused.is_err());
    let went = rewind(
        &h.sessions,
        &h.id,
        BACK_TO,
        Back::Files,
        Some(&shown()),
        &|again| h.again(again),
    )
    .unwrap();
    assert_eq!(went.id.as_deref(), Some(h.id.as_str()));
    assert_eq!(went.session_id.as_deref(), Some(h.session.as_str()));
    assert_eq!(went.files, ["/w/a.txt", "/w/b.txt"]);
    // Told before the answer.
    let told = rewound(&h.events());
    assert_eq!(told[0]["conversation"], false);
    assert!(h.sessions.holds(&h.id));
    assert!(!h.dir.join("args.2").exists(), "nothing started again");
    h.stop();
}

#[test]
fn files_the_agent_cannot_put_back_change_nothing_and_say_why() {
    let h = start(
        "rewind-no-files",
        &format!(
            "{READY}\n{}\ndrain",
            r#"expect "subtype":"rewind_files"
reply {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"canRewind":false,"error":"No file checkpoint found for this message."}}}"#
        ),
    );
    h.until_type("ready");
    let error = rewind(
        &h.sessions,
        &h.id,
        BACK_TO,
        Back::Entry(Some("entry-before".into())),
        Some(&shown()),
        &|again| h.again(again),
    )
    .unwrap_err();
    assert_eq!(error, "No file checkpoint found for this message.");
    // Nothing was put back, and the conversation goes on as it was.
    assert_eq!(
        h.stdin()
            .iter()
            .filter(|line| line["request"]["subtype"] == "rewind_files")
            .count(),
        1
    );
    assert!(h.sessions.holds(&h.id));
    assert!(rewound(&h.events()).is_empty());
    h.stop();
}

#[test]
fn a_preview_says_what_putting_the_files_back_would_change() {
    let h = start(
        "rewind-preview",
        &format!(
            "{READY}\n{}\ndrain",
            r#"expect "subtype":"rewind_files"
reply {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"canRewind":true,"filesChanged":["/w/a.txt"],"insertions":3,"deletions":1}}}
expect "subtype":"rewind_files"
reply {"type":"control_response","response":{"subtype":"error","request_id":"@ID@","error":"File rewinding is not enabled."}}"#
        ),
    );
    h.until_type("ready");
    assert_eq!(
        preview(&h.sessions, &h.id, BACK_TO).unwrap(),
        Preview {
            files: vec!["/w/a.txt".into()],
            insertions: 3,
            deletions: 1
        }
    );
    assert_eq!(
        preview(&h.sessions, &h.id, BACK_TO).unwrap_err(),
        "File rewinding is not enabled."
    );
    h.stop();
}

#[test]
fn an_entry_the_agent_cannot_find_starts_the_conversation_again_whole() {
    let h = start("rewind-fallback", &format!("{READY}\ndrain"));
    h.transcript(&["entry-kept"]);
    // The second start refuses the entry and ends; the third is a plain
    // resume.
    h.then(3, &format!("{READY}\ndrain"));
    h.until_type("ready");
    let went = rewind(
        &h.sessions,
        &h.id,
        BACK_TO,
        Back::Entry(Some("entry-gone".into())),
        None,
        &|again| h.again(again),
    )
    .unwrap();
    let fallback = went.fallback.clone().unwrap();
    assert!(
        fallback.contains("No message found with message.uuid of: entry-gone"),
        "{fallback}"
    );
    assert_eq!(went.error, None);
    let next = went.id.unwrap();
    assert_eq!(went.session_id.as_deref(), Some(h.session.as_str()));
    assert_eq!(
        value_after(&h.args(2), "--resume-session-at").as_deref(),
        Some("entry-gone")
    );
    let whole = h.args(3);
    assert_eq!(value_after(&whole, "--resume"), Some(h.session.clone()));
    assert!(!whole.contains(&"--resume-session-at".to_string()));
    // The conversation did not go back, so nothing says it did.
    assert!(rewound(&h.events_of(&next)).is_empty());
    stop(&h.sessions, &next).unwrap();
}

#[test]
fn going_back_before_the_first_message_starts_a_new_conversation() {
    let h = start("rewind-first", &format!("{READY}\ndrain"));
    h.then(2, &format!("{READY}\ndrain"));
    h.until_type("ready");
    let went = rewind(
        &h.sessions,
        &h.id,
        BACK_TO,
        Back::Entry(None),
        None,
        &|again| h.again(again),
    )
    .unwrap();
    let fresh = format!("{}-anew", h.session);
    assert_eq!(went.session_id.as_deref(), Some(fresh.as_str()));
    let args = h.args(2);
    assert_eq!(value_after(&args, "--session-id"), Some(fresh));
    assert!(!args.contains(&"--resume".to_string()));
    stop(&h.sessions, &went.id.unwrap()).unwrap();
}

#[test]
fn a_session_at_work_does_not_go_back_and_is_left_as_it_was() {
    let h = start(
        "rewind-busy",
        &format!("{READY}\nexpect \"type\":\"user\"\n{TAKE}\n{INIT}\ndrain"),
    );
    h.until_type("ready");
    h.send("work on");
    h.until_type("turnStarted");
    for back in [Back::Files, Back::Entry(None)] {
        let error = rewind(
            &h.sessions,
            &h.id,
            BACK_TO,
            back,
            Some(&shown()),
            &|again| h.again(again),
        )
        .unwrap_err();
        assert_eq!(error, "a turn runs");
    }
    assert_eq!(rest(&h.sessions, &h.id).unwrap_err(), "a turn runs");
    assert!(h.sessions.holds(&h.id));
    assert!(!h
        .stdin()
        .iter()
        .any(|line| line["request"]["subtype"] == "rewind_files"));
    h.stop();
}

/// Between the preview and the choice a file can change, the user's own
/// save among them: putting back what the user was not shown is refused,
/// before anything is put back.
#[test]
fn files_that_were_not_shown_are_not_put_back() {
    let h = start(
        "rewind-unshown",
        &format!(
            "{READY}\n{}\ndrain",
            r#"expect "subtype":"rewind_files"
reply {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"canRewind":true,"filesChanged":["/w/a.txt"],"insertions":0,"deletions":2}}}
expect "subtype":"rewind_files"
reply {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"canRewind":true,"filesChanged":["/w/a.txt","/w/notes.md"],"insertions":0,"deletions":9}}}"#
        ),
    );
    h.transcript(&["entry-before"]);
    h.until_type("ready");
    let shown = preview(&h.sessions, &h.id, BACK_TO).unwrap().files;
    assert_eq!(shown, ["/w/a.txt"]);
    let error = rewind(
        &h.sessions,
        &h.id,
        BACK_TO,
        Back::Entry(Some("entry-before".into())),
        Some(&shown),
        &|again| h.again(again),
    )
    .unwrap_err();
    assert_eq!(error, UNSHOWN);
    // Only the two dry runs went; nothing was put back, nothing restarted.
    let asked: Vec<bool> = h
        .stdin()
        .iter()
        .filter(|line| line["request"]["subtype"] == "rewind_files")
        .map(|line| line["request"]["dry_run"] == true)
        .collect();
    assert_eq!(asked, [true, true]);
    assert!(h.sessions.holds(&h.id));
    assert!(!h.dir.join("args.2").exists());
    rest(&h.sessions, &h.id).unwrap();
    h.stop();
}

/// A message sent while the session goes back, by the window or by the
/// workbench for a session this one started, would go to the process the
/// restart ends: it is refused until the going back is over.
#[test]
fn nothing_is_sent_while_the_session_goes_back() {
    let h = start(
        "rewind-sending",
        &format!(
            "{READY}\n{}\ndrain",
            r#"expect "subtype":"rewind_files"
await go
reply {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"canRewind":true,"filesChanged":["/w/a.txt"],"insertions":0,"deletions":2}}}
expect "subtype":"rewind_files"
reply {"type":"control_response","response":{"subtype":"success","request_id":"@ID@","response":{"canRewind":true,"skippedLinks":0}}}"#
        ),
    );
    h.until_type("ready");
    std::thread::scope(|scope| {
        let going = scope.spawn(|| {
            rewind(
                &h.sessions,
                &h.id,
                BACK_TO,
                Back::Files,
                Some(&["/w/a.txt".to_string()]),
                &|_: &Again| -> Result<Started, String> { unreachable!("only the files go back") },
            )
        });
        let deadline = Instant::now() + Duration::from_secs(60);
        while !h
            .stdin()
            .iter()
            .any(|line| line["request"]["subtype"] == "rewind_files")
        {
            assert!(Instant::now() < deadline, "the dry run never went");
            std::thread::sleep(Duration::from_millis(20));
        }
        let message = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            send(&h.sessions, &h.id, &message, "meanwhile", &[]).unwrap_err(),
            GOING_BACK
        );
        assert_eq!(
            control(&h.sessions, &h.id, &Control::Compact { instructions: None }).unwrap_err(),
            GOING_BACK
        );
        std::fs::write(h.dir.join("go"), "").unwrap();
        going.join().unwrap().unwrap();
    });
    // Over once it answered: the session takes messages again.
    assert!(!h.events().iter().any(|event| event["type"] == "message"));
    let message = uuid::Uuid::new_v4().to_string();
    send(&h.sessions, &h.id, &message, "now", &[]).unwrap();
    h.stop();
}

/// A start that fails before its process runs is started again whole, as
/// one that ends before it is ready is.
#[test]
fn a_start_that_fails_goes_on_with_the_conversation_whole() {
    let h = start("rewind-failed", &format!("{READY}\ndrain"));
    h.then(2, &format!("{READY}\ndrain"));
    h.until_type("ready");
    let went = rewind(
        &h.sessions,
        &h.id,
        BACK_TO,
        Back::Entry(Some("entry-before".into())),
        None,
        &|again| match again.at {
            Some(_) => Err("the transcript is not there".into()),
            None => h.again(again),
        },
    )
    .unwrap();
    assert_eq!(
        went.fallback.as_deref(),
        Some("the transcript is not there")
    );
    assert_eq!(went.error, None);
    assert_eq!(went.session_id.as_deref(), Some(h.session.as_str()));
    let whole = h.args(2);
    assert_eq!(value_after(&whole, "--resume"), Some(h.session.clone()));
    assert!(!whole.contains(&"--resume-session-at".to_string()));
    stop(&h.sessions, &went.id.unwrap()).unwrap();
}

#[test]
fn going_back_is_undone_until_the_conversation_goes_on() {
    let h = start("rewind-undo", &format!("{READY}\ndrain"));
    h.transcript(&["entry-before"]);
    h.then(2, &format!("{READY}\ndrain"));
    h.then(3, &format!("{READY}\ndrain"));
    h.then(
        4,
        &format!("{READY}\nexpect \"type\":\"user\"\n{TAKE}\n{INIT}\n{DONE}\ndrain"),
    );
    h.until_type("ready");
    let back = |id: &str| {
        rewind(
            &h.sessions,
            id,
            BACK_TO,
            Back::Entry(Some("entry-before".into())),
            None,
            &|again| h.again(again),
        )
        .unwrap()
        .id
        .unwrap()
    };
    let went = back(&h.id);
    // Undone: the conversation as it was, from its newest entry.
    let undone = undo(&h.sessions, &went, &h.session, &|again| h.again(again)).unwrap();
    assert_eq!(undone.session_id.as_deref(), Some(h.session.as_str()));
    let args = h.args(3);
    assert_eq!(value_after(&args, "--resume"), Some(h.session.clone()));
    assert!(!args.contains(&"--resume-session-at".to_string()));
    // Gone back again and gone on: it cannot be undone any more.
    let again = back(&undone.id.unwrap());
    let message = uuid::Uuid::new_v4().to_string();
    send(&h.sessions, &again, &message, "go on", &[]).unwrap();
    let waits = Waits::default();
    waits.until(|| h.events_of(&again), |event| event["type"] == "turnEnded");
    waits.until(
        || h.events_of(&again),
        |event| event["type"] == "state" && event["state"] == "idle",
    );
    assert_eq!(
        undo(&h.sessions, &again, &h.session, &|again| h.again(again)).unwrap_err(),
        "the conversation has gone on since it went back"
    );
    assert!(h.sessions.holds(&again));
    assert!(!h.dir.join("args.5").exists(), "nothing started again");
    stop(&h.sessions, &again).unwrap();
}

#[test]
fn a_missing_agent_explains_itself() {
    let vars = HashMap::from([("PATH".to_string(), "/nowhere".to_string())]);
    let launch = Launch {
        project: std::path::Path::new("/tmp"),
        env: &vars,
        session: Some("s"),
        token: None,
        resume: false,
        model: None,
        mode: None,
        effort: None,
        config_dir: None,
        tool_server: None,
        orchestrator: false,
        instructions: None,
        start_only: false,
        afresh: false,
        compact_at: None,
        resume_at: None,
    };
    let error = super::start(
        Arc::new(Recorder::default()),
        Arc::new(Sessions::default()),
        &CLAUDE_STREAM,
        &launch,
        Box::new(|_| {}),
        Box::new(|_| {}),
    )
    .unwrap_err();
    assert!(error.contains("PATH"), "{error}");
}

/// One short turn against the real `claude` on PATH, on a cheap model, in
/// a scratch directory. Run by hand:
/// `cargo test -p chord-core real_claude -- --ignored`.
#[test]
#[ignore = "runs the real claude, signed in, and spends a little of its usage"]
fn real_claude_holds_a_short_turn() {
    let dir = Scratch::new("integrated-real");
    let environment = crate::env::environment();
    let recorder = Arc::new(Recorder::default());
    let sessions = Arc::new(Sessions::default());
    let session = uuid::Uuid::new_v4().to_string();
    let launch = Launch {
        project: &dir,
        env: &environment.vars,
        session: Some(&session),
        token: None,
        resume: false,
        model: Some("haiku"),
        mode: Some("default"),
        effort: None,
        config_dir: None,
        tool_server: None,
        orchestrator: false,
        instructions: None,
        start_only: false,
        afresh: false,
        compact_at: None,
        resume_at: None,
    };
    let started = super::start(
        recorder.clone(),
        Arc::clone(&sessions),
        &CLAUDE_STREAM,
        &launch,
        Box::new(|_| {}),
        Box::new(|_| {}),
    )
    .unwrap();
    let h = Harness {
        dir,
        sessions,
        recorder,
        id: started.id,
        session,
        waits: Waits::default(),
        vars: environment.vars.clone(),
    };
    let ready = h.until_type("ready");
    assert!(ready.last().unwrap()["version"].is_string());
    assert!(ready.last().unwrap()["models"]
        .as_array()
        .is_some_and(|m| !m.is_empty()));
    let message = h.send("Reply with exactly the word: pelican");
    let events = h.until(|e| e["type"] == "turnEnded" || e["type"] == "ended");
    let end = events.last().unwrap();
    assert_eq!(end["outcome"], "done", "{events:#?}");
    let started = events.iter().find(|e| e["type"] == "turnStarted").unwrap();
    assert_eq!(started["messages"], json!([message]), "matched by its id");
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

/// The agent taking the record of a command the user ran while no turn
/// runs: a turn that asks no model.
const RECORDED: &str = r#"expect "shouldQuery":false
reply {"type":"command_lifecycle","command_uuid":"@UUID@","state":"started"}
say {"type":"system","subtype":"init","model":"claude-haiku","permissionMode":"default","session_id":"s"}
say {"type":"result","subtype":"success","is_error":false,"num_turns":0,"total_cost_usd":0,"session_id":"s"}
reply {"type":"command_lifecycle","command_uuid":"@UUID@","state":"completed"}"#;

const C1: &str = "44444444-4444-4444-8444-444444444444";

fn commands(events: &[Value]) -> Vec<&Value> {
    events
        .iter()
        .filter(|event| event["type"] == "command")
        .collect()
}

#[test]
fn a_command_the_user_runs_streams_to_the_window_and_goes_to_the_agent_before_the_next_message() {
    let scenario = [
        READY,
        RECORDED,
        r#"expect "type":"user""#,
        TAKE,
        INIT,
        DONE,
        "drain",
    ]
    .join("\n");
    let h = start("run", &scenario);
    h.until_type("ready");
    run(
        &h.sessions,
        &h.id,
        C1,
        "printf 'out <1>\\n'; printf 'err\\n' >&2; exit 3",
    )
    .unwrap();
    // Sent while the command runs, the message waits for its record.
    let message = h.send("why did it fail?");
    let events = h.until_type("turnEnded");

    let ran = commands(&events);
    let states: Vec<&str> = ran.iter().map(|e| e["state"].as_str().unwrap()).collect();
    assert_eq!(states, ["running", "done"]);
    assert_eq!(ran[1]["exitCode"], 3);
    assert_eq!(
        ran[1]["text"],
        "printf 'out <1>\\n'; printf 'err\\n' >&2; exit 3"
    );
    let printed: String = events
        .iter()
        .filter(|event| event["type"] == "commandOutput")
        .map(|event| event["delta"].as_str().unwrap())
        .collect();
    assert!(
        printed.contains("out <1>\n") && printed.contains("err\n"),
        "{printed:?}"
    );
    // The record opened no turn: the one turn is the message's.
    let turns: Vec<&Value> = events
        .iter()
        .filter(|event| event["type"] == "turnStarted")
        .collect();
    assert_eq!(turns.len(), 1, "{events:?}");
    assert_eq!(turns[0]["messages"], json!([message]));

    let sent: Vec<Value> = h
        .stdin()
        .into_iter()
        .filter(|line| line["type"] == "user")
        .collect();
    assert_eq!(sent[0]["uuid"], C1);
    assert_eq!(sent[0]["shouldQuery"], false);
    assert_eq!(
        sent[0]["message"]["content"],
        format!(
            "{}\n<bash-input>printf 'out <1>\\n'; printf 'err\\n' >&2; exit 3</bash-input>\n<bash-stdout>out &lt;1&gt;\n</bash-stdout><bash-stderr>err\n</bash-stderr>\n<bash-exit-code>3</bash-exit-code>",
            crate::claude_stream::RAN_CAVEAT
        )
    );
    assert_eq!(sent[1]["uuid"], message.as_str());
    assert_eq!(h.stop()["clean"], true);
}

#[test]
fn a_command_the_user_stops_ends_with_everything_it_started_and_says_so_to_the_agent() {
    let scenario = [READY, RECORDED, "drain"].join("\n");
    let h = start_keeping("run-stop", &scenario, short_graces());
    h.until_type("ready");
    let child = h.dir.join("command-child");
    run(
        &h.sessions,
        &h.id,
        C1,
        &format!(
            "echo before; sleep 300 & echo $! > '{}'; wait",
            child.display()
        ),
    )
    .unwrap();
    h.until(|event| event["type"] == "commandOutput");
    stop_command(&h.sessions, &h.id, C1).unwrap();
    let events = h.until(|event| event["type"] == "command" && event["state"] != "running");
    let ended = commands(&events).pop().unwrap().clone();
    assert_eq!(ended["state"], "stopped");
    assert_eq!(
        stop_command(&h.sessions, &h.id, C1).unwrap_err(),
        "the command does not run"
    );

    // The sleep it left running in the background ended with it.
    let pid = std::fs::read_to_string(&child).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid.trim()) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!alive(pid.trim()), "the sleep is still there");

    let deadline = Instant::now() + Duration::from_secs(5);
    let record = loop {
        if let Some(line) = h.stdin().into_iter().find(|line| line["uuid"] == C1) {
            break line;
        }
        assert!(
            Instant::now() < deadline,
            "the agent was never given the command"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    let content = record["message"]["content"].as_str().unwrap();
    assert!(
        content.contains("<bash-stdout>before\n</bash-stdout>"),
        "{content}"
    );
    assert!(
        content.contains("The user stopped the command."),
        "{content}"
    );
    assert_eq!(h.stop()["clean"], true);
}
