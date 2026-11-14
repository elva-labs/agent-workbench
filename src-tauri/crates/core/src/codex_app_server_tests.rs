//! The Codex driver line by line: what each line of the app-server becomes,
//! and what each command writes.

use super::*;

const M1: &str = "11111111-1111-4111-8111-111111111111";
const M2: &str = "22222222-2222-4222-8222-222222222222";
const THREAD: &str = "thread-1";

fn launch_with<'a>(
    vars: &'a HashMap<String, String>,
    adjust: impl FnOnce(&mut Launch<'a>),
) -> AppServer {
    let mut launch = Launch {
        project: Path::new("/work/demo"),
        env: vars,
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
    AppServer::new(&launch)
}

fn fresh() -> AppServer {
    launch_with(&HashMap::new(), |_| {})
}

fn read(driver: &mut AppServer, line: Value) -> Reading {
    driver.read(&line.to_string())
}

fn events(driver: &mut AppServer, lines: &[Value]) -> Vec<Event> {
    lines
        .iter()
        .flat_map(|line| read(driver, line.clone()).events)
        .collect()
}

fn written(lines: &[String]) -> Vec<Value> {
    lines
        .iter()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn models() -> Value {
    json!({"data": [
        {"id": "gpt-a", "model": "gpt-a", "displayName": "GPT A", "description": "The big one",
         "hidden": false, "isDefault": true, "defaultReasoningEffort": "medium",
         "supportedReasoningEfforts": [
            {"reasoningEffort": "low", "description": ""},
            {"reasoningEffort": "medium", "description": ""},
            {"reasoningEffort": "high", "description": ""}]},
        {"id": "gpt-b", "model": "gpt-b", "displayName": "GPT B", "hidden": false,
         "defaultReasoningEffort": "minimal",
         "supportedReasoningEfforts": [{"reasoningEffort": "minimal", "description": ""}]},
        {"id": "secret", "model": "secret", "hidden": true, "supportedReasoningEfforts": []},
        {"something": "from a later version"}
    ]})
}

fn thread_started() -> Value {
    json!({
        "thread": {"id": THREAD, "cwd": "/work/demo", "preview": "", "turns": []},
        "model": "gpt-a",
        "modelProvider": "openai",
        "reasoningEffort": "medium",
        "approvalPolicy": "on-request",
        "approvalsReviewer": "user",
        "sandbox": {"type": "workspaceWrite", "writableRoots": [], "networkAccess": false},
        "cwd": "/work/demo"
    })
}

/// What `config/read` answers: the user's own workspace sandbox settings
/// among the rest.
fn config() -> Value {
    json!({"config": {"model": "gpt-a", "sandbox_mode": null,
        "sandbox_workspace_write": {"writable_roots": ["/work/shared"], "network_access": true,
                                    "exclude_tmpdir_env_var": false, "exclude_slash_tmp": false}},
        "origins": {}})
}

/// Plays the handshake, answering the opening requests in the order given,
/// and hands back what was written and the events.
fn handshake(driver: &mut AppServer, account: Value) -> (Vec<Value>, Vec<Event>) {
    handshake_with(driver, account, thread_started())
}

/// The handshake, with the thread started as given.
fn handshake_with(
    driver: &mut AppServer,
    account: Value,
    started: Value,
) -> (Vec<Value>, Vec<Event>) {
    let opening = written(&driver.opening());
    assert_eq!(opening[0]["method"], "initialize");
    let mut lines = opening.clone();
    let reading = read(
        driver,
        json!({"id": opening[0]["id"], "result": {
            "userAgent": "agent-workbench/0.169.0 (Mac OS 27.2.0; arm64) xterm-256color (agent-workbench; 0.8.0)",
            "codexHome": "/h/.codex", "platformFamily": "unix", "platformOs": "macos"}}),
    );
    assert!(reading.fatal.is_none());
    let writes = written(&reading.writes);
    lines.extend(writes.clone());
    let id =
        |method: &str| writes.iter().find(|line| line["method"] == method).unwrap()["id"].clone();
    let thread = writes
        .iter()
        .find(|line| {
            line["method"]
                .as_str()
                .is_some_and(|m| m.starts_with("thread/"))
        })
        .unwrap()["id"]
        .clone();
    let mut out = Vec::new();
    // Out of order: the server answers as each is done.
    out.extend(read(driver, json!({"id": thread, "result": started})).events);
    out.extend(read(driver, json!({"id": id("model/list"), "result": models()})).events);
    out.extend(read(driver, json!({"id": id("account/read"), "result": account})).events);
    out.extend(read(driver, json!({"id": id("config/read"), "result": config()})).events);
    (lines, out)
}

fn ready() -> AppServer {
    let mut driver = fresh();
    handshake(
        &mut driver,
        json!({"account": {"type": "chatgpt", "email": null, "planType": "plus"},
               "requiresOpenaiAuth": true}),
    );
    driver
}

fn notification(method: &str, params: Value) -> Value {
    json!({"method": method, "params": params})
}

fn item(method: &str, item: Value) -> Value {
    notification(
        method,
        json!({"threadId": THREAD, "turnId": "turn-1", "item": item}),
    )
}

/// Sends a message, and plays its answer and the turn's start, in the
/// order Codex sends them.
fn turn(driver: &mut AppServer, message: &str) -> Vec<Event> {
    let line: Value = serde_json::from_str(&driver.message(message, "go", &[]).unwrap()).unwrap();
    events(
        driver,
        &[
            json!({"id": line["id"], "result": {"turn": {"id": "turn-1", "status": "inProgress", "items": []}}}),
            notification(
                "turn/started",
                json!({"threadId": THREAD, "turn": {"id": "turn-1", "status": "inProgress", "items": []}}),
            ),
        ],
    )
}

fn completed(status: &str) -> Value {
    notification(
        "turn/completed",
        json!({"threadId": THREAD, "turn": {"id": "turn-1", "status": status, "items": [],
               "durationMs": 547, "error": null}}),
    )
}

#[test]
fn the_handshake_starts_a_thread_with_the_workbench_s_settings() {
    let vars = HashMap::new();
    let server = PathBuf::from("/opt/workbench/agent-workbench-remote");
    let mut driver = launch_with(&vars, |launch| {
        launch.model = Some("gpt-b");
        launch.mode = Some("read-only");
        launch.effort = Some("minimal");
        launch.tool_server = Some(Box::leak(server.clone().into_boxed_path()));
        launch.orchestrator = true;
    });
    let (lines, out) = handshake(
        &mut driver,
        json!({"account": null, "requiresOpenaiAuth": false}),
    );
    let methods: Vec<&str> = lines.iter().filter_map(|l| l["method"].as_str()).collect();
    assert_eq!(
        methods,
        [
            "initialize",
            "initialized",
            "account/read",
            "model/list",
            "config/read",
            "thread/start"
        ]
    );
    assert_eq!(lines[0]["params"]["clientInfo"]["name"], "agent-workbench");
    assert_eq!(lines[0]["params"]["capabilities"]["experimentalApi"], false);
    assert!(lines[1].get("id").is_none(), "a notification");
    assert_eq!(
        lines[4]["params"],
        json!({"cwd": "/work/demo", "includeLayers": false})
    );
    let start = &lines[5]["params"];
    assert_eq!(start["cwd"], "/work/demo");
    assert_eq!(start["model"], "gpt-b");
    assert_eq!(start["approvalsReviewer"], "user");
    assert_eq!(start["approvalPolicy"], "on-request");
    assert_eq!(start["sandbox"], "read-only");
    assert_eq!(start["config"]["model_reasoning_effort"], "minimal");
    let tool = &start["config"]["mcp_servers"]["agent_workbench"];
    assert_eq!(tool["command"], server.to_string_lossy().as_ref());
    assert_eq!(tool["args"], json!(["mcp"]));
    assert_eq!(tool["default_tools_approval_mode"], "approve");
    assert_eq!(tool["env"], json!({"WORKBENCH_ROLE": "orchestrator"}));
    assert!(start.get("threadId").is_none());

    // Ready waits for all four answers, and says the thread's id.
    assert_eq!(out.len(), 1, "{out:?}");
    let Event::Ready {
        session_id,
        model,
        mode,
        effort,
        version,
        models,
        modes,
        efforts,
        commands,
    } = &out[0]
    else {
        panic!("{out:?}");
    };
    assert_eq!(session_id, THREAD);
    assert_eq!(model.as_deref(), Some("gpt-a"));
    assert_eq!(effort.as_deref(), Some("medium"));
    assert_eq!(mode.as_deref(), Some("auto"));
    assert_eq!(version.as_deref(), Some("0.169.0"));
    let values: Vec<&str> = models.iter().map(|m| m.value.as_str()).collect();
    assert_eq!(values, ["gpt-a", "gpt-b"], "hidden ones left out");
    assert_eq!(models[0].name.as_deref(), Some("GPT A"));
    assert_eq!(efforts, &["low", "medium", "high"]);
    let modes: Vec<&str> = modes.iter().map(|m| m.value.as_str()).collect();
    assert_eq!(modes, ["read-only", "auto", "full-access"]);
    assert!(commands.is_empty());
}

#[test]
fn a_resume_names_the_thread_and_gives_the_tool_server_the_session() {
    let vars = HashMap::new();
    let server = PathBuf::from("/opt/workbench/agent-workbench-remote");
    let mut driver = launch_with(&vars, |launch| {
        launch.session = Some("thread-old");
        launch.resume = true;
        launch.tool_server = Some(Box::leak(server.into_boxed_path()));
    });
    let opening = written(&driver.opening());
    let reading = read(
        &mut driver,
        json!({"id": opening[0]["id"], "result": {"userAgent": "agent-workbench/0.169.0"}}),
    );
    let resume = written(&reading.writes)
        .into_iter()
        .find(|line| line["method"] == "thread/resume")
        .unwrap();
    assert_eq!(resume["params"]["threadId"], "thread-old");
    assert_eq!(resume["params"]["excludeTurns"], true);
    assert_eq!(resume["params"]["approvalsReviewer"], "user");
    assert_eq!(
        resume["params"]["config"]["mcp_servers"]["agent_workbench"]["env"],
        json!({"WORKBENCH_SESSION": "thread-old"})
    );
}

#[test]
fn signed_out_is_told_after_ready_with_the_claude_driver_s_kind() {
    let mut driver = fresh();
    let (_, out) = handshake(
        &mut driver,
        json!({"account": null, "requiresOpenaiAuth": true}),
    );
    assert!(matches!(out[0], Event::Ready { .. }));
    assert!(
        matches!(&out[1], Event::Error { kind: ErrorKind::NotLoggedIn, message } if message.contains("codex login")),
        "{out:?}"
    );

    // An account that needs no OpenAI login, such as a provider of the
    // user's own, is signed in.
    let mut driver = fresh();
    let (_, out) = handshake(
        &mut driver,
        json!({"account": null, "requiresOpenaiAuth": false}),
    );
    assert_eq!(out.len(), 1);
}

#[test]
fn an_old_version_or_a_refused_handshake_ends_the_session() {
    let mut driver = fresh();
    let opening = written(&driver.opening());
    let reading = read(
        &mut driver,
        json!({"id": opening[0]["id"], "result": {"userAgent": "agent-workbench/0.150.2 (Linux)"}}),
    );
    assert!(reading.writes.is_empty(), "nothing more is asked");
    let (kind, message) = reading.fatal.unwrap();
    assert_eq!(kind, ErrorKind::Protocol);
    assert!(message.contains("0.150.2"), "{message}");

    let mut driver = fresh();
    let opening = written(&driver.opening());
    let reading = read(
        &mut driver,
        json!({"id": opening[0]["id"], "error": {"code": -32600, "message": "Already initialized"}}),
    );
    assert!(reading.fatal.unwrap().1.contains("Already initialized"));

    // A thread that cannot start ends it too.
    let mut driver = fresh();
    let opening = written(&driver.opening());
    let writes = written(
        &read(
            &mut driver,
            json!({"id": opening[0]["id"], "result": {"userAgent": "agent-workbench/0.169.0"}}),
        )
        .writes,
    );
    let thread = writes
        .iter()
        .find(|l| l["method"] == "thread/start")
        .unwrap();
    let reading = read(
        &mut driver,
        json!({"id": thread["id"], "error": {"code": -32600, "message": "no such model"}}),
    );
    let (kind, message) = reading.fatal.unwrap();
    assert_eq!(kind, ErrorKind::Agent);
    assert!(message.contains("no such model"), "{message}");

    // A version it cannot read is spoken to.
    assert_eq!(numbers("0.169.0-alpha.2"), Some((0, 169, 0)));
    assert_eq!(version_of("garbage"), None);
}

#[test]
fn a_message_is_a_turn_named_by_the_message_whichever_comes_first() {
    let mut driver = ready();
    let line: Value = serde_json::from_str(&driver.message(M1, "hello", &[]).unwrap()).unwrap();
    assert_eq!(line["method"], "turn/start");
    assert_eq!(line["params"]["threadId"], THREAD);
    assert_eq!(line["params"]["clientUserMessageId"], M1);
    assert_eq!(line["params"]["input"][0]["text"], "hello");
    assert!(
        line["params"].get("model").is_none(),
        "nothing settled to carry"
    );

    // The answer first, then the notification.
    let out = events(
        &mut driver,
        &[
            json!({"id": line["id"], "result": {"turn": {"id": "turn-1", "status": "inProgress"}}}),
            notification(
                "turn/started",
                json!({"threadId": THREAD, "turn": {"id": "turn-1"}}),
            ),
        ],
    );
    assert_eq!(
        out,
        [Event::TurnStarted {
            messages: vec![M1.into()]
        }]
    );
    events(&mut driver, &[completed("completed")]);

    // The notification first, then the answer: the turn names nothing
    // until the answer says it is the message's, and then names it again,
    // which the core takes as the message taken into the running turn.
    let line: Value = serde_json::from_str(&driver.message(M2, "go", &[]).unwrap()).unwrap();
    let out = events(
        &mut driver,
        &[
            notification(
                "turn/started",
                json!({"threadId": THREAD, "turn": {"id": "turn-2"}}),
            ),
            json!({"id": line["id"], "result": {"turn": {"id": "turn-2"}}}),
        ],
    );
    assert_eq!(
        out,
        [
            Event::TurnStarted { messages: vec![] },
            Event::TurnStarted {
                messages: vec![M2.into()]
            }
        ]
    );

    // A turn the agent began itself names nothing.
    events(&mut driver, &[completed("completed")]);
    let out = events(
        &mut driver,
        &[notification(
            "turn/started",
            json!({"threadId": THREAD, "turn": {"id": "turn-3"}}),
        )],
    );
    assert_eq!(out, [Event::TurnStarted { messages: vec![] }]);
}

#[test]
fn an_answer_that_comes_after_its_turn_has_ended_names_the_message_taken() {
    let mut driver = ready();
    let line: Value = serde_json::from_str(&driver.message(M1, "go", &[]).unwrap()).unwrap();
    let out = events(
        &mut driver,
        &[
            notification(
                "turn/started",
                json!({"threadId": THREAD, "turn": {"id": "turn-1"}}),
            ),
            completed("failed"),
            json!({"id": line["id"], "result": {"turn": {"id": "turn-1"}}}),
        ],
    );
    assert!(
        matches!(out.as_slice(), [
            Event::TurnStarted { messages },
            Event::TurnEnded { .. },
            last,
        ] if messages.is_empty() && *last == Event::message(M1, MessageState::Taken, None)),
        "no turn is begun again: {out:?}"
    );
}

#[test]
fn a_message_s_turn_is_the_one_its_answer_names_not_the_next_to_start() {
    let mut driver = ready();
    let line: Value = serde_json::from_str(&driver.message(M1, "go", &[]).unwrap()).unwrap();
    let compaction = |status: &str| {
        notification(
            &format!("turn/{status}"),
            json!({"threadId": THREAD, "turn": {"id": "turn-c", "status": "completed"}}),
        )
    };
    // A compaction turn starts just as the message goes; its answer names
    // another turn, which starts once the compaction is over.
    let out = events(
        &mut driver,
        &[
            compaction("started"),
            json!({"id": line["id"], "result": {"turn": {"id": "turn-m"}}}),
            compaction("completed"),
            notification(
                "turn/started",
                json!({"threadId": THREAD, "turn": {"id": "turn-m"}}),
            ),
        ],
    );
    let started: Vec<&Event> = out
        .iter()
        .filter(|e| matches!(e, Event::TurnStarted { .. }))
        .collect();
    assert_eq!(
        started,
        [
            &Event::TurnStarted { messages: vec![] },
            &Event::TurnStarted {
                messages: vec![M1.into()]
            }
        ],
        "{out:?}"
    );
}

#[test]
fn a_message_the_agent_refuses_is_dropped() {
    let mut driver = ready();
    let line: Value = serde_json::from_str(&driver.message(M1, "hello", &[]).unwrap()).unwrap();
    let out = events(
        &mut driver,
        &[json!({"id": line["id"], "error": {"code": -32600, "message": "thread is busy"}})],
    );
    assert_eq!(
        out,
        [Event::message(
            M1,
            MessageState::Dropped,
            Some("thread is busy".into())
        )]
    );
}

#[test]
fn images_go_as_data_urls_beside_the_text() {
    let mut driver = ready();
    let image = Image {
        media_type: "image/png".into(),
        data: "aGk=".into(),
    };
    let line: Value = serde_json::from_str(&driver.message(M1, "look", &[image]).unwrap()).unwrap();
    assert_eq!(
        line["params"]["input"][1],
        json!({"type": "image", "url": "data:image/png;base64,aGk="})
    );
    let pdf = Image {
        media_type: "application/pdf".into(),
        data: "x".into(),
    };
    assert!(driver.message(M2, "", &[pdf]).is_err());
}

#[test]
fn text_and_reasoning_stream_by_block_and_end_whole() {
    let mut driver = ready();
    turn(&mut driver, M1);
    let out = events(
        &mut driver,
        &[
            item(
                "item/started",
                json!({"type": "reasoning", "id": "rs_1", "summary": []}),
            ),
            notification(
                "item/reasoning/summaryPartAdded",
                json!({"itemId": "rs_1", "summaryIndex": 0}),
            ),
            notification(
                "item/reasoning/summaryTextDelta",
                json!({"itemId": "rs_1", "summaryIndex": 0, "delta": "Thinking "}),
            ),
            notification(
                "item/reasoning/summaryTextDelta",
                json!({"itemId": "rs_1", "summaryIndex": 0, "delta": "hard."}),
            ),
            item(
                "item/completed",
                json!({"type": "reasoning", "id": "rs_1", "summary": ["Thinking hard."], "content": []}),
            ),
            item(
                "item/started",
                json!({"type": "agentMessage", "id": "msg_1", "text": ""}),
            ),
            notification(
                "item/agentMessage/delta",
                json!({"itemId": "msg_1", "delta": "po"}),
            ),
            notification(
                "item/agentMessage/delta",
                json!({"itemId": "msg_1", "delta": "ng"}),
            ),
            item(
                "item/completed",
                json!({"type": "agentMessage", "id": "msg_1", "text": "pong", "phase": "final"}),
            ),
        ],
    );
    let thinking = |text: &str, done| Event::Thinking {
        block: "rs_1:0".into(),
        parent: None,
        text: text.into(),
        done,
    };
    let said = |text: &str, done| Event::Text {
        block: "msg_1".into(),
        parent: None,
        text: text.into(),
        done,
    };
    assert_eq!(
        out,
        [
            thinking("Thinking ", false),
            thinking("hard.", false),
            thinking("Thinking hard.", true),
            said("po", false),
            said("ng", false),
            said("pong", true),
        ]
    );
}

#[test]
fn a_command_streams_its_output_and_finishes_with_its_result() {
    let mut driver = ready();
    turn(&mut driver, M1);
    let command = json!({"type": "commandExecution", "id": "call_1",
        "command": "/bin/zsh -lc 'ls -la'", "cwd": "/work/demo",
        "commandActions": [{"type": "listFiles", "command": "ls -la"}],
        "status": "inProgress", "source": "agent"});
    let mut done = command.clone();
    done["status"] = json!("completed");
    done["aggregatedOutput"] = json!("total 0\n");
    done["exitCode"] = json!(0);
    let mut failed = command.clone();
    failed["id"] = json!("call_2");
    failed["status"] = json!("failed");
    failed["exitCode"] = json!(2);
    failed["aggregatedOutput"] = json!("no such file\n");
    let out = events(
        &mut driver,
        &[
            item("item/started", command),
            notification(
                "item/commandExecution/outputDelta",
                json!({"itemId": "call_1", "delta": "total"}),
            ),
            notification(
                "item/commandExecution/outputDelta",
                json!({"itemId": "nobody", "delta": "x"}),
            ),
            item("item/completed", done),
            item("item/completed", failed),
        ],
    );
    assert_eq!(
        out[0],
        Event::ToolStarted {
            call: "call_1".into(),
            parent: None,
            name: "commandExecution".into(),
            kind: ToolKind::Command,
        }
    );
    let Event::ToolInput {
        input: Some(input), ..
    } = &out[1]
    else {
        panic!("{out:?}");
    };
    assert_eq!(input["command"], "/bin/zsh -lc 'ls -la'");
    assert_eq!(
        out[2],
        Event::ToolOutput {
            call: "call_1".into(),
            parent: None,
            delta: "total".into()
        }
    );
    assert!(
        matches!(&out[3], Event::ToolFinished { call, output, error: false, .. }
        if call == "call_1" && output == "total 0\n")
    );
    // A command never seen to start is started when it completes.
    assert!(matches!(&out[4], Event::ToolStarted { call, .. } if call == "call_2"));
    assert!(
        matches!(&out[6], Event::ToolFinished { call, output, error: true, .. }
        if call == "call_2" && output == "no such file\n")
    );
    assert_eq!(out.len(), 7);
}

#[test]
fn a_file_change_finishes_with_each_file_created_updated_deleted_or_moved() {
    let mut driver = ready();
    turn(&mut driver, M1);
    let changes = json!([
        {"path": "/work/demo/new.txt", "kind": {"type": "add"}, "diff": "hello\n"},
        {"path": "/work/demo/old.txt", "kind": {"type": "delete"}, "diff": "bye\n"},
        {"path": "/work/demo/src/a.rs", "kind": {"type": "update", "move_path": null},
         "diff": "--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,3 +1,3 @@\n fn a() {\n-    1\n+    2\n }\n@@ -10 +10,2 @@\n-x\n+y\n+z\n\\ No newline at end of file\n"},
        {"path": "src/b.rs", "kind": {"type": "update", "move_path": "src/c.rs"},
         "diff": "@@ -1 +1 @@\n-b\n+c\n"},
        {"path": "/work/demo/later.txt", "kind": {"type": "symlink"}, "diff": ""}
    ]);
    let started =
        json!({"type": "fileChange", "id": "call_p", "changes": [], "status": "inProgress"});
    let mut done = started.clone();
    done["changes"] = changes.clone();
    done["status"] = json!("completed");
    let out = events(
        &mut driver,
        &[
            item("item/started", started),
            notification(
                "item/fileChange/patchUpdated",
                json!({"itemId": "call_p", "changes": changes}),
            ),
            item("item/completed", done),
        ],
    );
    assert!(
        matches!(&out[0], Event::ToolStarted { kind: ToolKind::Edit, name, .. } if name == "fileChange")
    );
    // The input grows with the patch, whole each time.
    assert!(
        matches!(&out[2], Event::ToolInput { input: Some(input), delta: None, .. }
        if input["changes"].as_array().unwrap().len() == 5)
    );
    let Event::ToolFinished {
        changes,
        error: false,
        ..
    } = &out[3]
    else {
        panic!("{out:?}");
    };
    assert_eq!(changes.len(), 4, "a kind it does not know is left out");
    assert_eq!(changes[0].kind, ChangeKind::Create);
    assert_eq!(changes[0].content.as_deref(), Some("hello\n"));
    assert_eq!(changes[1].kind, ChangeKind::Delete);
    assert_eq!(changes[1].content, None);
    assert_eq!(changes[2].kind, ChangeKind::Update);
    assert_eq!(
        changes[2].hunks,
        [
            Hunk {
                old_start: 1,
                old_lines: 3,
                new_start: 1,
                new_lines: 3,
                lines: vec![
                    " fn a() {".into(),
                    "-    1".into(),
                    "+    2".into(),
                    " }".into()
                ],
            },
            Hunk {
                old_start: 10,
                old_lines: 1,
                new_start: 10,
                new_lines: 2,
                lines: vec!["-x".into(), "+y".into(), "+z".into()],
            }
        ]
    );
    assert_eq!(changes[3].kind, ChangeKind::Move);
    let project = Path::new("/work/demo");
    let absolute = |path: &str| project.join(path).to_string_lossy().to_string();
    assert_eq!(changes[3].path, absolute("src/b.rs"), "made absolute");
    assert_eq!(
        changes[3].to.as_deref(),
        Some(absolute("src/c.rs").as_str())
    );
    assert_eq!(changes[3].hunks[0].lines, ["-b", "+c"]);

    // A change the user declined changes nothing.
    turn(&mut driver, M2);
    let out = events(
        &mut driver,
        &[item(
            "item/completed",
            json!({"type": "fileChange", "id": "call_q", "status": "declined",
                   "changes": [{"path": "/x", "kind": {"type": "add"}, "diff": "x"}]}),
        )],
    );
    assert!(
        matches!(&out[2], Event::ToolFinished { error: true, changes, .. } if changes.is_empty())
    );
}

#[test]
fn an_mcp_call_and_the_other_tools_are_sorted_by_what_they_do() {
    let mut driver = ready();
    turn(&mut driver, M1);
    let out = events(
        &mut driver,
        &[
            item(
                "item/started",
                json!({"type": "mcpToolCall", "id": "call_m", "server": "docs", "tool": "search",
                       "arguments": {"q": "x"}, "status": "inProgress"}),
            ),
            notification(
                "item/mcpToolCall/progress",
                json!({"itemId": "call_m", "message": "half way"}),
            ),
            item(
                "item/completed",
                json!({"type": "mcpToolCall", "id": "call_m", "server": "docs", "tool": "search",
                       "status": "completed", "result": {"content": [
                           {"type": "text", "text": "found"}, {"type": "image", "data": "..."}]}}),
            ),
            item(
                "item/completed",
                json!({"type": "mcpToolCall", "id": "call_n", "server": "docs", "tool": "search",
                       "status": "failed", "error": {"message": "server gone"}}),
            ),
            item(
                "item/started",
                json!({"type": "webSearch", "id": "ws", "query": "rust"}),
            ),
            item(
                "item/started",
                json!({"type": "imageView", "id": "iv", "path": "/a.png"}),
            ),
            item(
                "item/started",
                json!({"type": "collabAgentToolCall", "id": "co", "tool": "spawnAgent", "prompt": "help"}),
            ),
            item("item/started", json!({"type": "somethingNew", "id": "sn"})),
            item(
                "item/started",
                json!({"type": "userMessage", "id": "um", "content": []}),
            ),
        ],
    );
    assert!(
        matches!(&out[0], Event::ToolStarted { kind: ToolKind::Mcp, name, .. } if name == "mcp__docs__search")
    );
    assert!(matches!(&out[1], Event::ToolInput { input: Some(input), .. } if input["q"] == "x"));
    assert!(
        matches!(&out[2], Event::ToolFinished { output, error: false, .. } if output == "found\n[image]")
    );
    assert!(
        matches!(&out[5], Event::ToolFinished { output, error: true, .. } if output == "server gone")
    );
    let kinds: Vec<ToolKind> = out
        .iter()
        .skip(6)
        .filter_map(|e| match e {
            Event::ToolStarted { kind, .. } => Some(*kind),
            _ => None,
        })
        .collect();
    assert_eq!(kinds, [ToolKind::Web, ToolKind::Read, ToolKind::Agent]);
    assert_eq!(out.len(), 12, "nothing for what is no tool: {out:?}");
}

#[test]
fn a_plan_the_turn_s_diff_and_its_steps() {
    let mut driver = ready();
    turn(&mut driver, M1);
    let out = events(
        &mut driver,
        &[
            notification(
                "turn/plan/updated",
                json!({"turnId": "turn-1", "explanation": null, "plan": [
                    {"step": "Read", "status": "completed"},
                    {"step": "Write", "status": "inProgress"},
                    {"step": "Test", "status": "pending"},
                    {"step": "Ship", "status": "somethingNew"}]}),
            ),
            notification("item/plan/delta", json!({"itemId": "p", "delta": "- one"})),
            item(
                "item/completed",
                json!({"type": "plan", "id": "p", "text": "- one\n- two"}),
            ),
            notification(
                "turn/diff/updated",
                json!({"turnId": "turn-1", "diff": "diff --git a/x b/x\n"}),
            ),
        ],
    );
    let Event::Plan {
        steps, text: None, ..
    } = &out[0]
    else {
        panic!("{out:?}");
    };
    let statuses: Vec<StepStatus> = steps.iter().map(|s| s.status).collect();
    assert_eq!(
        statuses,
        [
            StepStatus::Done,
            StepStatus::Active,
            StepStatus::Pending,
            StepStatus::Pending
        ]
    );
    assert!(matches!(&out[1], Event::Plan { text: Some(text), .. } if text == "- one\n- two"));
    assert_eq!(
        out[2],
        Event::TurnDiff {
            diff: "diff --git a/x b/x\n".into(),
            truncated: false
        }
    );
    assert_eq!(out.len(), 3);
}

fn offered(event: &Event) -> Vec<(Choice, Option<String>)> {
    match event {
        Event::PermissionAsked { choices, .. } => choices
            .iter()
            .map(|offer| (offer.choice, offer.remembers.clone()))
            .collect(),
        _ => panic!("{event:?}"),
    }
}

fn server_request(id: i64, method: &str, params: Value) -> Value {
    json!({"id": id, "method": method, "params": params})
}

#[test]
fn approvals_offer_the_neutral_choices_and_say_what_each_remembers() {
    let mut driver = ready();
    turn(&mut driver, M1);
    events(
        &mut driver,
        &[item(
            "item/started",
            json!({"type": "commandExecution", "id": "call_1", "command": "touch a", "cwd": "/work/demo", "status": "inProgress"}),
        )],
    );
    let out = events(
        &mut driver,
        &[
            server_request(
                0,
                "item/commandExecution/requestApproval",
                json!({"threadId": THREAD, "turnId": "turn-1", "itemId": "call_1",
                       "command": "touch a", "cwd": "/work/demo", "reason": "to write a file",
                       "proposedExecpolicyAmendment": ["touch"]}),
            ),
            server_request(
                1,
                "item/commandExecution/requestApproval",
                json!({"threadId": THREAD, "turnId": "turn-1", "itemId": "call_2",
                       "command": "curl x", "networkApprovalContext": {"host": "x.dev", "protocol": "https"},
                       "proposedNetworkPolicyAmendments": [{"action": "allow", "host": "x.dev"}]}),
            ),
            server_request(
                2,
                "item/fileChange/requestApproval",
                json!({"threadId": THREAD, "turnId": "turn-1", "itemId": "call_1", "grantRoot": "/work/demo/src"}),
            ),
            server_request(
                3,
                "item/permissions/requestApproval",
                json!({"threadId": THREAD, "turnId": "turn-1", "itemId": "call_1", "cwd": "/work/demo",
                       "permissions": {"network": {"enabled": true}, "fileSystem": {"write": ["/tmp/out"]}}}),
            ),
            server_request(
                4,
                "mcpServer/elicitation/request",
                json!({"threadId": THREAD, "turnId": "turn-1", "serverName": "docs", "mode": "form",
                       "message": "Allow the docs MCP server to run tool \"search\"?",
                       "requestedSchema": {"type": "object", "properties": {}},
                       "_meta": {"codex_approval_kind": "mcp_tool_call", "persist": ["session", "always"],
                                 "tool_name": "search", "tool_params": {"q": "x"}}}),
            ),
        ],
    );
    let command = &out[0];
    let Event::PermissionAsked {
        request,
        call,
        tool,
        input,
        description,
        ..
    } = command
    else {
        panic!("{out:?}");
    };
    assert_eq!(request, "0");
    assert_eq!(call.as_deref(), Some("call_1"));
    assert_eq!(tool, "commandExecution");
    assert_eq!(input["command"], "touch a", "the call's input");
    assert_eq!(description.as_deref(), Some("to write a file"));
    assert_eq!(
        offered(command),
        [
            (Choice::Allow, None),
            (
                Choice::AllowSession,
                Some("touch a for the rest of this session".into())
            ),
            (
                Choice::AllowAlways,
                Some("commands that start with touch in Codex's rules, from now on".into())
            ),
            (Choice::Deny, None),
            (Choice::Cancel, None),
        ]
    );
    assert!(matches!(&out[1], Event::PermissionAsked { path: Some(host), .. } if host == "x.dev"));
    assert_eq!(
        offered(&out[1])[2].1.as_deref(),
        Some("network access to x.dev in Codex's network policy, from now on")
    );
    let file: Vec<Choice> = offered(&out[2]).into_iter().map(|(c, _)| c).collect();
    assert_eq!(
        file,
        [
            Choice::Allow,
            Choice::AllowSession,
            Choice::Deny,
            Choice::Cancel
        ]
    );
    assert_eq!(
        offered(&out[2])[1].1.as_deref(),
        Some("changes under /work/demo/src for the rest of this session")
    );
    assert_eq!(
        offered(&out[3]),
        [
            (
                Choice::Allow,
                Some("network access, writing to /tmp/out for the rest of this turn".into())
            ),
            (
                Choice::AllowSession,
                Some("network access, writing to /tmp/out for the rest of this session".into())
            ),
            (Choice::Deny, None),
        ]
    );
    assert!(matches!(&out[4], Event::PermissionAsked { tool, input, .. }
        if tool == "mcp__docs__search" && input["q"] == "x"));
    assert_eq!(offered(&out[4]).len(), 5);

    // Each answer is the decision the choice means, under the server's id.
    let answer = |driver: &mut AppServer, request: &str, choice| -> Value {
        serde_json::from_str(&driver.answer(request, choice, Some("ignored")).unwrap()).unwrap()
    };
    let line = answer(&mut driver, "0", Choice::AllowAlways);
    assert_eq!(line["id"], 0);
    assert_eq!(
        line["result"]["decision"],
        json!({"acceptWithExecpolicyAmendment": {"execpolicy_amendment": ["touch"]}})
    );
    assert!(
        driver.answer("0", Choice::Allow, None).is_err(),
        "answered once"
    );
    let line = answer(&mut driver, "1", Choice::AllowAlways);
    assert_eq!(
        line["result"]["decision"]["applyNetworkPolicyAmendment"]["network_policy_amendment"]
            ["host"],
        "x.dev"
    );
    assert!(
        driver.answer("2", Choice::AllowAlways, None).is_err(),
        "not offered"
    );
    assert_eq!(
        answer(&mut driver, "2", Choice::Cancel)["result"]["decision"],
        "cancel"
    );
    let line = answer(&mut driver, "3", Choice::AllowSession);
    assert_eq!(line["result"]["scope"], "session");
    assert_eq!(line["result"]["permissions"]["network"]["enabled"], true);
    let line = answer(&mut driver, "4", Choice::AllowSession);
    assert_eq!(
        line["result"],
        json!({"action": "accept", "content": null, "_meta": {"persist": "session"}})
    );
}

#[test]
fn a_command_with_nothing_proposed_offers_nothing_to_keep_from_now_on() {
    let mut driver = ready();
    turn(&mut driver, M1);
    let out = events(
        &mut driver,
        &[server_request(
            7,
            "item/commandExecution/requestApproval",
            json!({"threadId": THREAD, "turnId": "turn-1", "itemId": "c", "command": "rm -rf build",
                   "availableDecisions": ["accept", "cancel"]}),
        )],
    );
    let choices: Vec<Choice> = offered(&out[0]).into_iter().map(|(c, _)| c).collect();
    assert_eq!(
        choices,
        [
            Choice::Allow,
            Choice::AllowSession,
            Choice::Deny,
            Choice::Cancel
        ]
    );
    let line: Value =
        serde_json::from_str(&driver.answer("7", Choice::Deny, None).unwrap()).unwrap();
    assert_eq!(line["result"]["decision"], "decline");
}

#[test]
fn a_question_takes_options_words_and_secrets_and_a_reply_by_id() {
    let mut driver = ready();
    turn(&mut driver, M1);
    let out = events(
        &mut driver,
        &[server_request(
            5,
            "item/tool/requestUserInput",
            json!({"threadId": THREAD, "turnId": "turn-1", "itemId": "call_q", "isBlocking": true,
            "questions": [
              {"id": "colour", "header": "Colour", "question": "Which colour?",
               "options": [{"label": "Red", "description": "warm"}, {"label": "Blue", "description": ""}]},
              {"id": "token", "header": "", "question": "Your token?", "isSecret": true, "options": null},
              {"id": "name", "header": "Name", "question": "Name it?", "isOther": true,
               "options": [{"label": "Default", "description": ""}]}
            ]}),
        )],
    );
    let Event::QuestionAsked {
        request,
        call,
        questions,
        ..
    } = &out[0]
    else {
        panic!("{out:?}");
    };
    assert_eq!(request, "5");
    assert_eq!(call.as_deref(), Some("call_q"));
    assert_eq!(questions[0].options[0].description.as_deref(), Some("warm"));
    assert_eq!(questions[0].options[1].description, None);
    assert!(!questions[0].other, "options only");
    assert!(!questions[0].secret);
    assert!(questions[1].secret);
    assert!(questions[1].other, "no options: the user's own words");
    assert_eq!(questions[1].header, None);
    assert!(questions[2].other);
    assert!(
        driver.answer("5", Choice::Allow, None).is_err(),
        "a reply, not a permission"
    );
    assert!(driver.reply("5", Some(&[vec!["Red".into()]])).is_err());
    let error = driver
        .reply(
            "5",
            Some(&[vec!["Green".into()], vec!["x".into()], vec!["y".into()]]),
        )
        .unwrap_err();
    assert!(error.contains("not one of the options"), "{error}");
    let line: Value = serde_json::from_str(
        &driver
            .reply(
                "5",
                Some(&[
                    vec!["Red".into()],
                    vec!["hunter2".into()],
                    vec!["Mine".into()],
                ]),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(line["id"], 5);
    assert_eq!(
        line["result"]["answers"],
        json!({"colour": {"answers": ["Red"]}, "token": {"answers": ["hunter2"]},
               "name": {"answers": ["Mine"]}})
    );

    // Declining answers nothing.
    events(
        &mut driver,
        &[server_request(
            6,
            "item/tool/requestUserInput",
            json!({"turnId": "turn-1", "itemId": "q", "questions": [{"id": "a", "header": "", "question": "?"}]}),
        )],
    );
    let line: Value = serde_json::from_str(&driver.reply("6", None).unwrap()).unwrap();
    assert_eq!(line["result"], json!({"answers": {}}));
}

#[test]
fn requests_it_does_not_handle_are_refused_and_forms_declined() {
    let mut driver = ready();
    for (id, method) in [
        (10, "item/tool/call"),
        (11, "account/chatgptAuthTokens/refresh"),
        (12, "attestation/generate"),
        (13, "execCommandApproval"),
        (14, "somethingFromALaterVersion"),
    ] {
        let reading = read(&mut driver, server_request(id, method, json!({})));
        assert!(reading.events.is_empty(), "{method}");
        let line: Value = serde_json::from_str(&reading.writes[0]).unwrap();
        assert_eq!(line["id"], id);
        assert_eq!(line["error"]["code"], -32601, "{method}");
    }
    // A string id goes back as it came.
    let reading = read(
        &mut driver,
        json!({"id": "req-a", "method": "item/tool/call", "params": {}}),
    );
    assert_eq!(
        serde_json::from_str::<Value>(&reading.writes[0]).unwrap()["id"],
        "req-a"
    );

    let reading = read(
        &mut driver,
        server_request(
            15,
            "mcpServer/elicitation/request",
            json!({"serverName": "forms", "mode": "form", "message": "Fill this in",
                   "requestedSchema": {"type": "object", "properties": {"name": {"type": "string"}}}}),
        ),
    );
    let line: Value = serde_json::from_str(&reading.writes[0]).unwrap();
    assert_eq!(line["result"]["action"], "decline");
    assert!(
        matches!(&reading.events[0], Event::Notice { level: NoticeLevel::Warning, message }
        if message.contains("forms"))
    );
}

#[test]
fn a_request_settled_elsewhere_is_withdrawn_and_one_left_at_the_end_answered_no() {
    let mut driver = ready();
    turn(&mut driver, M1);
    events(
        &mut driver,
        &[
            server_request(
                0,
                "item/fileChange/requestApproval",
                json!({"turnId": "turn-1", "itemId": "a"}),
            ),
            server_request(
                1,
                "item/tool/requestUserInput",
                json!({"turnId": "turn-1", "itemId": "b", "questions": []}),
            ),
        ],
    );
    let out = events(
        &mut driver,
        &[notification(
            "serverRequest/resolved",
            json!({"threadId": THREAD, "requestId": 0}),
        )],
    );
    assert_eq!(
        out,
        [Event::Withdrawn {
            request: "0".into()
        }]
    );
    let reading = read(&mut driver, completed("interrupted"));
    assert_eq!(
        reading.events[0],
        Event::Withdrawn {
            request: "1".into()
        }
    );
    let line: Value = serde_json::from_str(&reading.writes[0]).unwrap();
    assert_eq!(line, json!({"id": 1, "result": {"answers": {}}}));
    assert!(matches!(
        reading.events[1],
        Event::TurnEnded {
            outcome: Outcome::Interrupted,
            error: None,
            ..
        }
    ));
}

#[test]
fn a_turn_ends_with_how_why_and_its_own_usage() {
    let mut driver = ready();
    let usage = |total: u64, last: u64| {
        notification(
            "thread/tokenUsage/updated",
            json!({"threadId": THREAD, "turnId": "turn-1", "tokenUsage": {
                "total": {"inputTokens": total, "cachedInputTokens": total / 2, "outputTokens": 5,
                          "reasoningOutputTokens": 2, "totalTokens": total + 5},
                "last": {"inputTokens": last, "cachedInputTokens": 0, "outputTokens": 5,
                         "reasoningOutputTokens": 2, "totalTokens": last + 5},
                "modelContextWindow": 258400}}),
        )
    };
    turn(&mut driver, M1);
    let out = events(&mut driver, &[usage(100, 100), completed("completed")]);
    assert_eq!(
        out[0],
        Event::Context {
            used: Some(105),
            size: Some(258400)
        }
    );
    let Event::TurnEnded {
        outcome: Outcome::Done,
        usage: Some(first),
        duration_ms: Some(547),
        total_cost_usd: None,
        ..
    } = &out[1]
    else {
        panic!("{out:?}");
    };
    assert_eq!(first.input_tokens, 100, "a fresh thread: the turn's lasts");

    // The next turn's own usage is what the total grew by.
    turn(&mut driver, M2);
    let out = events(
        &mut driver,
        &[
            usage(300, 200),
            usage(300, 200),
            notification(
                "error",
                json!({"threadId": THREAD, "turnId": "turn-1", "willRetry": false,
                       "error": {"message": "stream ended", "codexErrorInfo": "other"}}),
            ),
            completed("failed"),
        ],
    );
    assert_eq!(out.len(), 2, "the same context is told once: {out:?}");
    let Event::TurnEnded {
        outcome: Outcome::Failed,
        error: Some(error),
        usage: Some(usage),
        ..
    } = &out[1]
    else {
        panic!("{out:?}");
    };
    assert_eq!(error, "stream ended", "what the agent said before the end");
    assert_eq!(
        usage,
        &Usage {
            input_tokens: 200,
            cached_tokens: 100,
            output_tokens: 0,
            reasoning_tokens: 0
        }
    );

    // The turn's own error is its reason when it has one.
    let mut driver = ready();
    turn(&mut driver, M1);
    let out = events(
        &mut driver,
        &[notification(
            "turn/completed",
            json!({"turn": {"id": "turn-1", "status": "failed",
                   "error": {"message": "Usage limit", "additionalDetails": "try later"}}}),
        )],
    );
    assert!(
        matches!(&out[0], Event::TurnEnded { error: Some(e), .. } if e == "Usage limit: try later")
    );
}

#[test]
fn a_retry_is_told_and_an_unauthorized_one_says_signed_out_once() {
    let mut driver = ready();
    turn(&mut driver, M1);
    let retry = |n: u64| {
        notification(
            "error",
            json!({"threadId": THREAD, "turnId": "turn-1", "willRetry": true,
                   "error": {"message": format!("Reconnecting... {n}/5"),
                             "codexErrorInfo": {"responseStreamDisconnected": {"httpStatusCode": 401}}}}),
        )
    };
    let out = events(&mut driver, &[retry(2), retry(3)]);
    assert!(matches!(
        &out[0],
        Event::Error {
            kind: ErrorKind::NotLoggedIn,
            ..
        }
    ));
    assert_eq!(
        out[1],
        Event::Retrying {
            message: "Reconnecting... 2/5".into(),
            attempt: Some(2),
            attempts: Some(5)
        }
    );
    assert!(matches!(
        &out[2],
        Event::Retrying {
            attempt: Some(3),
            ..
        }
    ));
    assert_eq!(out.len(), 3);
    assert_eq!(attempts("try again"), (None, None));
}

#[test]
fn an_interrupt_names_the_turn_or_waits_for_it() {
    let mut driver = ready();
    // No turn: nothing to stop.
    assert!(matches!(
        driver.control(&Control::Interrupt).unwrap(),
        Sending::Local { .. }
    ));
    turn(&mut driver, M1);
    let Sending::Request { line, key } = driver.control(&Control::Interrupt).unwrap() else {
        panic!("a request");
    };
    let line: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(line["method"], "turn/interrupt");
    assert_eq!(
        line["params"],
        json!({"threadId": THREAD, "turnId": "turn-1"})
    );
    let reading = read(&mut driver, json!({"id": line["id"], "result": {}}));
    assert_eq!(reading.replies, [(key, Ok(json!({})))]);
    events(&mut driver, &[completed("interrupted")]);

    // A turn on its way is stopped as soon as it has an id.
    let sent: Value = serde_json::from_str(&driver.message(M2, "go", &[]).unwrap()).unwrap();
    assert!(matches!(
        driver.control(&Control::Interrupt).unwrap(),
        Sending::Local { .. }
    ));
    let reading = read(
        &mut driver,
        json!({"id": sent["id"], "result": {"turn": {"id": "turn-2"}}}),
    );
    let writes = written(&reading.writes);
    assert_eq!(writes[0]["method"], "turn/interrupt");
    assert_eq!(writes[0]["params"]["turnId"], "turn-2");
}

#[test]
fn model_effort_and_mode_are_settled_here_and_go_with_the_next_turn() {
    let mut driver = ready();
    let configured = |sending: Sending| match sending {
        Sending::Local { events, .. } => events,
        other => panic!("{other:?}"),
    };
    let out = configured(driver.control(&Control::SetModel("gpt-b".into())).unwrap());
    // The effort the new model takes in place of one it does not.
    assert_eq!(
        out,
        [Event::Configured {
            model: Some("gpt-b".into()),
            mode: Some("auto".into()),
            effort: Some("minimal".into()),
            efforts: vec!["minimal".into()],
        }]
    );
    assert!(driver
        .control(&Control::SetModel("no-such".into()))
        .is_err());
    assert!(driver.control(&Control::SetEffort("high".into())).is_err());
    assert!(driver.control(&Control::SetMode("default".into())).is_err());
    configured(
        driver
            .control(&Control::SetMode("full-access".into()))
            .unwrap(),
    );

    let line: Value = serde_json::from_str(&driver.message(M1, "go", &[]).unwrap()).unwrap();
    let params = &line["params"];
    assert_eq!(params["model"], "gpt-b");
    assert_eq!(params["effort"], "minimal");
    assert_eq!(params["approvalPolicy"], "never");
    assert_eq!(params["sandboxPolicy"], json!({"type": "dangerFullAccess"}));
    events(
        &mut driver,
        &[json!({"id": line["id"], "result": {"turn": {"id": "turn-1"}}})],
    );
    events(&mut driver, &[completed("completed")]);
    // Taken: the next turn carries nothing.
    let line: Value = serde_json::from_str(&driver.message(M2, "go", &[]).unwrap()).unwrap();
    assert!(line["params"].get("model").is_none());
    assert!(line["params"].get("sandboxPolicy").is_none());

    // What the agent says it runs on is told as it changes.
    let out = events(
        &mut driver,
        &[notification(
            "thread/settings/updated",
            json!({"threadId": THREAD, "threadSettings": {"model": "gpt-a", "effort": "high",
                   "approvalPolicy": {"granular": {"rules": true}}, "sandboxPolicy": {"type": "readOnly"}}}),
        )],
    );
    assert_eq!(
        out,
        [Event::Configured {
            model: Some("gpt-a".into()),
            mode: Some("granular, read-only".into()),
            effort: Some("high".into()),
            efforts: vec!["low".into(), "medium".into(), "high".into()],
        }]
    );
}

#[test]
fn compaction_asked_for_is_a_turn_of_the_agent_s_own() {
    let mut driver = ready();
    let Sending::Request { line, key } = driver.control(&Control::Compact).unwrap() else {
        panic!("a request");
    };
    let line: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(line["method"], "thread/compact/start");
    assert_eq!(line["params"], json!({"threadId": THREAD}));
    let reading = read(&mut driver, json!({"id": line["id"], "result": {}}));
    assert_eq!(reading.replies, [(key, Ok(json!({})))]);
    let out = events(
        &mut driver,
        &[
            notification("turn/started", json!({"turn": {"id": "turn-c"}})),
            item(
                "item/started",
                json!({"type": "contextCompaction", "id": "cc"}),
            ),
            item(
                "item/completed",
                json!({"type": "contextCompaction", "id": "cc"}),
            ),
            notification(
                "turn/completed",
                json!({"turn": {"id": "turn-c", "status": "completed"}}),
            ),
        ],
    );
    assert_eq!(out[0], Event::TurnStarted { messages: vec![] });
    assert_eq!(out[1], Event::Compacting);
    assert_eq!(
        out[2],
        Event::Compacted {
            reason: Some(CompactReason::Asked),
            tokens_before: None,
            tokens_after: None
        }
    );
    // One the agent does by itself is for a full window.
    let out = events(
        &mut driver,
        &[
            item(
                "item/started",
                json!({"type": "contextCompaction", "id": "c2"}),
            ),
            item(
                "item/completed",
                json!({"type": "contextCompaction", "id": "c2"}),
            ),
        ],
    );
    assert!(matches!(
        out[1],
        Event::Compacted {
            reason: Some(CompactReason::Full),
            ..
        }
    ));
}

#[test]
fn notices_are_told_apart_from_errors_and_turns() {
    let mut driver = ready();
    let out = events(
        &mut driver,
        &[
            notification("warning", json!({"message": "Model metadata missing"})),
            notification(
                "deprecationNotice",
                json!({"summary": "Full-history hydration is deprecated", "details": "use excludeTurns"}),
            ),
            notification(
                "configWarning",
                json!({"summary": "Unknown key", "details": null}),
            ),
            notification(
                "model/rerouted",
                json!({"fromModel": "gpt-a", "toModel": "gpt-b", "reason": "highRiskCyberActivity"}),
            ),
            notification(
                "mcpServer/startupStatus/updated",
                json!({"name": "docs", "status": "failed", "error": "no such command"}),
            ),
            notification(
                "mcpServer/startupStatus/updated",
                json!({"name": "docs", "status": "ready"}),
            ),
            notification("account/rateLimits/updated", json!({})),
            notification("warning", json!({"message": "  "})),
        ],
    );
    let said: Vec<&str> = out
        .iter()
        .map(|event| match event {
            Event::Notice {
                level: NoticeLevel::Warning,
                message,
            } => message.as_str(),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(
        said,
        [
            "Model metadata missing",
            "Full-history hydration is deprecated: use excludeTurns",
            "Unknown key",
            "Codex moved this turn from gpt-a to gpt-b",
            "The docs MCP server could not start: no such command",
        ]
    );
}

#[test]
fn what_it_cannot_read_means_nothing() {
    let mut driver = ready();
    for line in [
        "not json",
        "[1,2,3]",
        r#"{"method":"something/new","params":{"x":1}}"#,
        r#"{"method":"item/started","params":{"item":"not an object"}}"#,
        r#"{"method":"item/completed","params":{}}"#,
        r#"{"method":"turn/started","params":{"turn":{}}}"#,
        r#"{"id":999,"result":{}}"#,
        r#"{"id":"str","result":{}}"#,
    ] {
        let reading = driver.read(line);
        assert!(reading.events.is_empty(), "{line}: {:?}", reading.events);
        assert!(reading.writes.is_empty(), "{line}");
    }
}

#[test]
fn a_completed_item_too_long_to_read_finishes_its_call_as_cut_short() {
    let mut driver = ready();
    turn(&mut driver, M1);
    events(
        &mut driver,
        &[item(
            "item/started",
            json!({"type": "commandExecution", "id": "call_big", "command": "cat big"}),
        )],
    );
    let line = r#"{"method":"item/completed","params":{"item":{"type":"commandExecution","id":"call_big","aggregatedOutput":"xxxxxxxx"#;
    driver.skipping(&line.as_bytes()[..30]);
    driver.skipping(&line.as_bytes()[30..]);
    driver.skipping(&[b'x'; 10_000]);
    let out = driver.skipped().events;
    assert_eq!(
        out,
        [Event::ToolFinished {
            call: "call_big".into(),
            parent: None,
            output: String::new(),
            error: true,
            truncated: true,
            changes: vec![],
        }]
    );
    // Any other line too long means nothing.
    driver.skipping(br#"{"method":"item/agentMessage/delta","params":{"itemId":"m","delta":"xxx"#);
    assert!(driver.skipped().events.is_empty());
}

#[test]
fn the_command_runs_the_app_server_under_the_account_s_home() {
    let dir = std::env::temp_dir().join(format!("workbench-codex-command-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let codex = dir.join(if cfg!(windows) { "codex.exe" } else { "codex" });
    std::fs::write(&codex, b"#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let vars = HashMap::from([
        ("PATH".to_string(), dir.to_string_lossy().to_string()),
        ("WORKBENCH_SESSION".to_string(), "the-parent".to_string()),
    ]);
    let home = PathBuf::from("/home/ada/.codex-work");
    let launch = Launch {
        project: &dir,
        env: &vars,
        session: Some("thread-old"),
        resume: true,
        model: None,
        mode: Some("auto"),
        effort: None,
        config_dir: Some(&home),
        tool_server: None,
        orchestrator: false,
    };
    let prepared = CODEX_APP_SERVER.command(&launch).unwrap();
    assert!(prepared.files.is_empty());
    let args: Vec<String> = prepared
        .command
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect();
    assert_eq!(args, ["app-server"]);
    let env: HashMap<String, String> = prepared
        .command
        .get_envs()
        .filter_map(|(key, value)| {
            Some((
                key.to_string_lossy().to_string(),
                value?.to_string_lossy().to_string(),
            ))
        })
        .collect();
    assert_eq!(env["CODEX_HOME"], home.to_string_lossy());
    assert_eq!(
        env["WORKBENCH_SESSION"], "thread-old",
        "its own, not the parent's"
    );

    let bad = Launch {
        mode: Some("default"),
        ..launch
    };
    let error = CODEX_APP_SERVER.command(&bad).err().unwrap();
    assert!(error.contains("not a mode"), "{error}");
    let missing = HashMap::from([("PATH".to_string(), "/nowhere".to_string())]);
    let gone = Launch {
        env: &missing,
        ..launch
    };
    assert!(CODEX_APP_SERVER
        .command(&gone)
        .err()
        .unwrap()
        .contains("PATH"));
}

/// What the driver reads from Codex's protocol and writes to it, each
/// checked against the schema the installed Codex generates. A use is
/// where it starts, a path of fields from there, and the values the driver
/// reads or writes at the end of it.
///
/// It starts at a method: `request` and `response` for one this side
/// calls, `client` for a notification this side sends, `notification` for
/// one Codex sends, `server` and `answer` for a request Codex makes; or at
/// an `item` of a turn by its type. A path is fields joined by dots, with
/// `{name}` for the variant of a union whose `type` is the name, `[]` for
/// the items of a list and `*` for the values of a map. A value is a
/// member of an enumeration, or the one field of an object a union holds,
/// as Codex spells its decisions.
const USES: &[(&str, &str, &[&str])] = &[
    ("request initialize", "clientInfo.name", &[]),
    ("request initialize", "clientInfo.title", &[]),
    ("request initialize", "clientInfo.version", &[]),
    ("request initialize", "capabilities.experimentalApi", &[]),
    ("response initialize", "userAgent", &[]),
    ("client initialized", "", &[]),
    ("request account/read", "refreshToken", &[]),
    ("response account/read", "account", &[]),
    ("response account/read", "requiresOpenaiAuth", &[]),
    ("request model/list", "", &[]),
    ("response model/list", "data.[].id", &[]),
    ("response model/list", "data.[].model", &[]),
    ("response model/list", "data.[].displayName", &[]),
    ("response model/list", "data.[].description", &[]),
    ("response model/list", "data.[].hidden", &[]),
    ("response model/list", "data.[].defaultReasoningEffort", &[]),
    (
        "response model/list",
        "data.[].supportedReasoningEfforts.[].reasoningEffort",
        &[],
    ),
    ("request config/read", "cwd", &[]),
    ("request config/read", "includeLayers", &[]),
    (
        "response config/read",
        "config.sandbox_workspace_write.writable_roots",
        &[],
    ),
    (
        "response config/read",
        "config.sandbox_workspace_write.network_access",
        &[],
    ),
    (
        "response config/read",
        "config.sandbox_workspace_write.exclude_tmpdir_env_var",
        &[],
    ),
    (
        "response config/read",
        "config.sandbox_workspace_write.exclude_slash_tmp",
        &[],
    ),
    ("request thread/start", "cwd", &[]),
    ("request thread/start", "model", &[]),
    ("request thread/start", "approvalsReviewer", &["user"]),
    (
        "request thread/start",
        "approvalPolicy",
        &["on-request", "never"],
    ),
    (
        "request thread/start",
        "sandbox",
        &["read-only", "workspace-write", "danger-full-access"],
    ),
    ("request thread/start", "config", &[]),
    ("request thread/resume", "threadId", &[]),
    ("request thread/resume", "excludeTurns", &[]),
    ("request thread/resume", "cwd", &[]),
    ("request thread/resume", "model", &[]),
    ("request thread/resume", "approvalsReviewer", &["user"]),
    (
        "request thread/resume",
        "approvalPolicy",
        &["on-request", "never"],
    ),
    (
        "request thread/resume",
        "sandbox",
        &["read-only", "workspace-write", "danger-full-access"],
    ),
    ("request thread/resume", "config", &[]),
    ("response thread/start", "thread.id", &[]),
    ("response thread/start", "model", &[]),
    ("response thread/start", "reasoningEffort", &[]),
    (
        "response thread/start",
        "approvalPolicy",
        &["on-request", "never"],
    ),
    (
        "response thread/start",
        "sandbox.type",
        &[
            "readOnly",
            "workspaceWrite",
            "dangerFullAccess",
            "externalSandbox",
        ],
    ),
    ("response thread/resume", "thread.id", &[]),
    ("response thread/resume", "model", &[]),
    ("response thread/resume", "reasoningEffort", &[]),
    (
        "response thread/resume",
        "approvalPolicy",
        &["on-request", "never"],
    ),
    (
        "response thread/resume",
        "sandbox.type",
        &[
            "readOnly",
            "workspaceWrite",
            "dangerFullAccess",
            "externalSandbox",
        ],
    ),
    ("request turn/start", "threadId", &[]),
    ("request turn/start", "clientUserMessageId", &[]),
    ("request turn/start", "input.[].{text}.text", &[]),
    ("request turn/start", "input.[].{text}.text_elements", &[]),
    ("request turn/start", "input.[].{image}.url", &[]),
    ("request turn/start", "model", &[]),
    ("request turn/start", "effort", &[]),
    (
        "request turn/start",
        "approvalPolicy",
        &["on-request", "never"],
    ),
    ("request turn/start", "sandboxPolicy.{readOnly}", &[]),
    (
        "request turn/start",
        "sandboxPolicy.{dangerFullAccess}",
        &[],
    ),
    (
        "request turn/start",
        "sandboxPolicy.{workspaceWrite}.writableRoots",
        &[],
    ),
    (
        "request turn/start",
        "sandboxPolicy.{workspaceWrite}.networkAccess",
        &[],
    ),
    (
        "request turn/start",
        "sandboxPolicy.{workspaceWrite}.excludeTmpdirEnvVar",
        &[],
    ),
    (
        "request turn/start",
        "sandboxPolicy.{workspaceWrite}.excludeSlashTmp",
        &[],
    ),
    ("response turn/start", "turn.id", &[]),
    ("request turn/interrupt", "threadId", &[]),
    ("request turn/interrupt", "turnId", &[]),
    ("request thread/compact/start", "threadId", &[]),
    ("notification turn/started", "threadId", &[]),
    ("notification turn/started", "turn.id", &[]),
    ("notification turn/completed", "threadId", &[]),
    ("notification turn/completed", "turn.id", &[]),
    (
        "notification turn/completed",
        "turn.status",
        &["completed", "interrupted", "failed"],
    ),
    ("notification turn/completed", "turn.error.message", &[]),
    (
        "notification turn/completed",
        "turn.error.additionalDetails",
        &[],
    ),
    ("notification turn/completed", "turn.durationMs", &[]),
    ("notification item/started", "threadId", &[]),
    ("notification item/started", "turnId", &[]),
    ("notification item/started", "item", &[]),
    ("notification item/completed", "threadId", &[]),
    ("notification item/completed", "item", &[]),
    ("notification item/agentMessage/delta", "threadId", &[]),
    ("notification item/agentMessage/delta", "itemId", &[]),
    ("notification item/agentMessage/delta", "delta", &[]),
    (
        "notification item/reasoning/summaryTextDelta",
        "itemId",
        &[],
    ),
    ("notification item/reasoning/summaryTextDelta", "delta", &[]),
    (
        "notification item/reasoning/summaryTextDelta",
        "summaryIndex",
        &[],
    ),
    ("notification item/reasoning/textDelta", "itemId", &[]),
    ("notification item/reasoning/textDelta", "delta", &[]),
    ("notification item/reasoning/textDelta", "contentIndex", &[]),
    (
        "notification item/commandExecution/outputDelta",
        "itemId",
        &[],
    ),
    (
        "notification item/commandExecution/outputDelta",
        "delta",
        &[],
    ),
    ("notification item/fileChange/outputDelta", "itemId", &[]),
    ("notification item/fileChange/outputDelta", "delta", &[]),
    ("notification item/fileChange/patchUpdated", "itemId", &[]),
    ("notification item/fileChange/patchUpdated", "changes", &[]),
    ("notification turn/plan/updated", "plan.[].step", &[]),
    (
        "notification turn/plan/updated",
        "plan.[].status",
        &["pending", "inProgress", "completed"],
    ),
    ("notification turn/diff/updated", "diff", &[]),
    ("notification thread/tokenUsage/updated", "threadId", &[]),
    (
        "notification thread/tokenUsage/updated",
        "tokenUsage.modelContextWindow",
        &[],
    ),
    (
        "notification thread/tokenUsage/updated",
        "tokenUsage.total.inputTokens",
        &[],
    ),
    (
        "notification thread/tokenUsage/updated",
        "tokenUsage.total.cachedInputTokens",
        &[],
    ),
    (
        "notification thread/tokenUsage/updated",
        "tokenUsage.total.outputTokens",
        &[],
    ),
    (
        "notification thread/tokenUsage/updated",
        "tokenUsage.total.reasoningOutputTokens",
        &[],
    ),
    (
        "notification thread/tokenUsage/updated",
        "tokenUsage.total.totalTokens",
        &[],
    ),
    (
        "notification thread/tokenUsage/updated",
        "tokenUsage.last.totalTokens",
        &[],
    ),
    ("notification thread/settings/updated", "threadId", &[]),
    (
        "notification thread/settings/updated",
        "threadSettings.model",
        &[],
    ),
    (
        "notification thread/settings/updated",
        "threadSettings.effort",
        &[],
    ),
    (
        "notification thread/settings/updated",
        "threadSettings.approvalPolicy",
        &["on-request", "never"],
    ),
    (
        "notification thread/settings/updated",
        "threadSettings.sandboxPolicy.type",
        &["readOnly", "workspaceWrite", "dangerFullAccess"],
    ),
    ("notification thread/compacted", "", &[]),
    ("notification error", "threadId", &[]),
    ("notification error", "error.message", &[]),
    (
        "notification error",
        "error.codexErrorInfo",
        &["unauthorized"],
    ),
    (
        "notification error",
        "error.codexErrorInfo.responseStreamDisconnected.httpStatusCode",
        &[],
    ),
    ("notification error", "willRetry", &[]),
    (
        "notification thread/status/changed",
        "status.type",
        &["systemError"],
    ),
    ("notification serverRequest/resolved", "requestId", &[]),
    ("notification warning", "message", &[]),
    ("notification guardianWarning", "message", &[]),
    ("notification configWarning", "summary", &[]),
    ("notification configWarning", "details", &[]),
    ("notification deprecationNotice", "summary", &[]),
    ("notification deprecationNotice", "details", &[]),
    ("notification model/rerouted", "fromModel", &[]),
    ("notification model/rerouted", "toModel", &[]),
    ("notification mcpServer/startupStatus/updated", "name", &[]),
    (
        "notification mcpServer/startupStatus/updated",
        "status",
        &["failed"],
    ),
    ("notification mcpServer/startupStatus/updated", "error", &[]),
    ("item agentMessage", "id", &[]),
    ("item agentMessage", "text", &[]),
    ("item reasoning", "summary", &[]),
    ("item reasoning", "content", &[]),
    ("item plan", "text", &[]),
    ("item contextCompaction", "id", &[]),
    ("item commandExecution", "command", &[]),
    ("item commandExecution", "cwd", &[]),
    ("item commandExecution", "commandActions", &[]),
    ("item commandExecution", "aggregatedOutput", &[]),
    ("item commandExecution", "exitCode", &[]),
    ("item commandExecution", "status", &["completed"]),
    ("item fileChange", "changes.[].path", &[]),
    ("item fileChange", "changes.[].diff", &[]),
    (
        "item fileChange",
        "changes.[].kind.type",
        &["add", "delete", "update"],
    ),
    ("item fileChange", "changes.[].kind.{update}.move_path", &[]),
    ("item fileChange", "status", &["completed"]),
    ("item mcpToolCall", "server", &[]),
    ("item mcpToolCall", "tool", &[]),
    ("item mcpToolCall", "arguments", &[]),
    ("item mcpToolCall", "result.content", &[]),
    ("item mcpToolCall", "error.message", &[]),
    ("item mcpToolCall", "status", &["failed"]),
    ("item dynamicToolCall", "tool", &[]),
    ("item dynamicToolCall", "arguments", &[]),
    ("item dynamicToolCall", "contentItems", &[]),
    ("item dynamicToolCall", "success", &[]),
    ("item dynamicToolCall", "status", &["failed"]),
    ("item collabAgentToolCall", "tool", &[]),
    ("item collabAgentToolCall", "prompt", &[]),
    ("item collabAgentToolCall", "model", &[]),
    ("item webSearch", "query", &[]),
    ("item webSearch", "action", &[]),
    ("item imageView", "path", &[]),
    (
        "server item/commandExecution/requestApproval",
        "threadId",
        &[],
    ),
    (
        "server item/commandExecution/requestApproval",
        "turnId",
        &[],
    ),
    (
        "server item/commandExecution/requestApproval",
        "itemId",
        &[],
    ),
    (
        "server item/commandExecution/requestApproval",
        "command",
        &[],
    ),
    ("server item/commandExecution/requestApproval", "cwd", &[]),
    (
        "server item/commandExecution/requestApproval",
        "commandActions",
        &[],
    ),
    (
        "server item/commandExecution/requestApproval",
        "reason",
        &[],
    ),
    (
        "server item/commandExecution/requestApproval",
        "proposedExecpolicyAmendment",
        &[],
    ),
    (
        "server item/commandExecution/requestApproval",
        "proposedNetworkPolicyAmendments.[].action",
        &["allow"],
    ),
    (
        "server item/commandExecution/requestApproval",
        "proposedNetworkPolicyAmendments.[].host",
        &[],
    ),
    (
        "server item/commandExecution/requestApproval",
        "networkApprovalContext.host",
        &[],
    ),
    (
        "answer item/commandExecution/requestApproval",
        "decision",
        &[
            "accept",
            "acceptForSession",
            "acceptWithExecpolicyAmendment",
            "applyNetworkPolicyAmendment",
            "decline",
            "cancel",
        ],
    ),
    (
        "answer item/commandExecution/requestApproval",
        "decision.acceptWithExecpolicyAmendment.execpolicy_amendment",
        &[],
    ),
    (
        "answer item/commandExecution/requestApproval",
        "decision.applyNetworkPolicyAmendment.network_policy_amendment",
        &[],
    ),
    ("server item/fileChange/requestApproval", "threadId", &[]),
    ("server item/fileChange/requestApproval", "turnId", &[]),
    ("server item/fileChange/requestApproval", "itemId", &[]),
    ("server item/fileChange/requestApproval", "grantRoot", &[]),
    ("server item/fileChange/requestApproval", "reason", &[]),
    (
        "answer item/fileChange/requestApproval",
        "decision",
        &["accept", "acceptForSession", "decline", "cancel"],
    ),
    ("server item/permissions/requestApproval", "threadId", &[]),
    ("server item/permissions/requestApproval", "turnId", &[]),
    ("server item/permissions/requestApproval", "itemId", &[]),
    ("server item/permissions/requestApproval", "cwd", &[]),
    ("server item/permissions/requestApproval", "reason", &[]),
    (
        "server item/permissions/requestApproval",
        "permissions.network.enabled",
        &[],
    ),
    (
        "server item/permissions/requestApproval",
        "permissions.fileSystem.read",
        &[],
    ),
    (
        "server item/permissions/requestApproval",
        "permissions.fileSystem.write",
        &[],
    ),
    (
        "server item/permissions/requestApproval",
        "permissions.fileSystem.entries.[].access",
        &[],
    ),
    (
        "server item/permissions/requestApproval",
        "permissions.fileSystem.entries.[].path",
        &[],
    ),
    (
        "answer item/permissions/requestApproval",
        "permissions",
        &[],
    ),
    (
        "answer item/permissions/requestApproval",
        "scope",
        &["turn", "session"],
    ),
    ("server item/tool/requestUserInput", "threadId", &[]),
    ("server item/tool/requestUserInput", "turnId", &[]),
    ("server item/tool/requestUserInput", "itemId", &[]),
    ("server item/tool/requestUserInput", "questions.[].id", &[]),
    (
        "server item/tool/requestUserInput",
        "questions.[].header",
        &[],
    ),
    (
        "server item/tool/requestUserInput",
        "questions.[].question",
        &[],
    ),
    (
        "server item/tool/requestUserInput",
        "questions.[].isOther",
        &[],
    ),
    (
        "server item/tool/requestUserInput",
        "questions.[].isSecret",
        &[],
    ),
    (
        "server item/tool/requestUserInput",
        "questions.[].options.[].label",
        &[],
    ),
    (
        "server item/tool/requestUserInput",
        "questions.[].options.[].description",
        &[],
    ),
    (
        "answer item/tool/requestUserInput",
        "answers.*.answers",
        &[],
    ),
    ("server mcpServer/elicitation/request", "threadId", &[]),
    ("server mcpServer/elicitation/request", "turnId", &[]),
    ("server mcpServer/elicitation/request", "serverName", &[]),
    ("server mcpServer/elicitation/request", "message", &[]),
    ("server mcpServer/elicitation/request", "_meta", &[]),
    (
        "answer mcpServer/elicitation/request",
        "action",
        &["accept", "decline", "cancel"],
    ),
    ("answer mcpServer/elicitation/request", "content", &[]),
    ("answer mcpServer/elicitation/request", "_meta", &[]),
];

/// The schema the installed Codex generates, as definitions by name. Where
/// two files define a name, the bundle of the protocol's second version
/// wins, then a type's own file, then the rest.
struct Schema {
    definitions: HashMap<String, Value>,
}

impl Schema {
    fn generate(codex: &Path) -> Self {
        let out = std::env::temp_dir().join(format!(
            "workbench-codex-schema-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let status = crate::adapter::process(codex, &std::env::vars().collect())
            .args(["app-server", "generate-json-schema", "--out"])
            .arg(&out)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "codex could not generate its schema");
        let mut files = Vec::new();
        let mut folders = vec![out.clone()];
        while let Some(folder) = folders.pop() {
            for entry in std::fs::read_dir(&folder).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    folders.push(path);
                } else if path.extension().is_some_and(|e| e == "json") {
                    files.push(path);
                }
            }
        }
        let rank = |path: &PathBuf| {
            let name = path.file_name().unwrap().to_string_lossy();
            let tier = if name.ends_with(".v2.schemas.json") {
                0
            } else if path.parent() == Some(out.as_path()) {
                1
            } else {
                2
            };
            (tier, path.clone())
        };
        files.sort_by_key(rank);
        let mut definitions = HashMap::new();
        for file in files {
            let schema: Value =
                serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
            let stem = file.file_stem().unwrap().to_string_lossy().to_string();
            for (name, definition) in schema["definitions"].as_object().into_iter().flatten() {
                definitions
                    .entry(name.clone())
                    .or_insert_with(|| definition.clone());
            }
            definitions.entry(stem).or_insert(schema);
        }
        std::fs::remove_dir_all(&out).ok();
        Self { definitions }
    }

    /// The schemas a node stands for: itself, what it refers to, and each
    /// branch of a union or an intersection, followed through.
    fn alternatives<'a>(&'a self, node: &'a Value, out: &mut Vec<&'a Value>, depth: usize) {
        if depth > 40 {
            return;
        }
        if let Some(reference) = node["$ref"].as_str() {
            let name = reference.rsplit('/').next().unwrap_or_default();
            if let Some(definition) = self.definitions.get(name) {
                self.alternatives(definition, out, depth + 1);
            }
        }
        for key in ["allOf", "anyOf", "oneOf"] {
            for branch in node[key].as_array().into_iter().flatten() {
                self.alternatives(branch, out, depth + 1);
            }
        }
        out.push(node);
    }

    fn resolve<'a>(&'a self, node: &'a Value) -> Vec<&'a Value> {
        let mut out = Vec::new();
        self.alternatives(node, &mut out, 0);
        out
    }

    /// The method given in one of the lists of methods, by its params.
    fn method(&self, list: &str, method: &str) -> Result<Option<String>, String> {
        self.definitions[list]["oneOf"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|variant| variant["properties"]["method"]["enum"][0] == method)
            .map(|variant| {
                variant["properties"]["params"]["$ref"]
                    .as_str()
                    .map(|reference| reference.rsplit('/').next().unwrap().to_string())
            })
            .ok_or_else(|| format!("{list} has no {method}"))
    }

    /// Where a use starts.
    fn start(&self, at: &str) -> Result<Vec<&Value>, String> {
        let (kind, name) = at.split_once(' ').unwrap();
        let params = |list: &str| -> Result<String, String> {
            self.method(list, name)?
                .ok_or_else(|| format!("{name} has no params"))
        };
        let definition = match kind {
            "request" => params("ClientRequest")?,
            "notification" => params("ServerNotification")?,
            "server" => params("ServerRequest")?,
            "response" => params("ClientRequest")?.replace("Params", "Response"),
            "answer" => params("ServerRequest")?.replace("Params", "Response"),
            "client" => {
                self.method("ClientNotification", name)?;
                return Ok(vec![]);
            }
            "item" => {
                return self.step(
                    self.resolve(&self.definitions["ThreadItem"]),
                    &format!("{{{name}}}"),
                )
            }
            other => panic!("no such start as {other}"),
        };
        let schema = self
            .definitions
            .get(&definition)
            .ok_or_else(|| format!("{definition} is not in the schema"))?;
        Ok(self.resolve(schema))
    }

    /// One step along a path. A schema that allows anything allows any
    /// step.
    fn step<'a>(&'a self, nodes: Vec<&'a Value>, step: &str) -> Result<Vec<&'a Value>, String> {
        let any = nodes.iter().any(|node| {
            **node == Value::Bool(true)
                || node.as_object().is_some_and(|node| {
                    ![
                        "type",
                        "properties",
                        "items",
                        "additionalProperties",
                        "enum",
                        "$ref",
                        "allOf",
                        "anyOf",
                        "oneOf",
                    ]
                    .iter()
                    .any(|key| node.contains_key(*key))
                })
        });
        let mut next = Vec::new();
        if let Some(tag) = step.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
            for node in &nodes {
                let tagged = node["properties"]["type"]
                    .get("enum")
                    .or_else(|| {
                        self.resolve(&node["properties"]["type"])
                            .into_iter()
                            .find_map(|t| t.get("enum"))
                    })
                    .and_then(Value::as_array)
                    .is_some_and(|values| values.iter().any(|v| v == tag));
                if tagged {
                    // With the branches of a union the variant holds.
                    next.extend(self.resolve(node));
                }
            }
        } else {
            for node in &nodes {
                let child = match step {
                    "[]" => node.get("items"),
                    "*" => node.get("additionalProperties"),
                    field => node["properties"].get(field),
                };
                if let Some(child) = child {
                    next.extend(self.resolve(child));
                }
            }
        }
        if next.is_empty() && !any {
            return Err(format!("no {step}"));
        }
        Ok(next)
    }

    /// The values a node can take: the members of its enumerations, and the
    /// one field of each object it may be.
    fn values(&self, nodes: &[&Value]) -> Vec<String> {
        let mut values = Vec::new();
        for node in nodes {
            for value in node["enum"].as_array().into_iter().flatten() {
                values.extend(text(value));
            }
            values.extend(text(&node["const"]));
            if let [only] = node["required"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
            {
                if node["properties"].as_object().is_some_and(|p| p.len() == 1) {
                    values.extend(text(only));
                }
            }
        }
        values
    }

    /// What is wrong with a use, if anything.
    fn check(&self, at: &str, path: &str, values: &[&str]) -> Option<String> {
        let mut nodes = match self.start(at) {
            Ok(nodes) => nodes,
            Err(error) => return Some(format!("{at}: {error}")),
        };
        for step in path.split('.').filter(|step| !step.is_empty()) {
            nodes = match self.step(nodes, step) {
                Ok(nodes) => nodes,
                Err(error) => return Some(format!("{at} {path}: {error}")),
            };
        }
        let known = self.values(&nodes);
        let missing: Vec<&&str> = values
            .iter()
            .filter(|value| !known.iter().any(|known| known == **value))
            .collect();
        (!missing.is_empty()).then(|| format!("{at} {path}: no {missing:?} among {known:?}"))
    }
}

/// The installed Codex against what the driver reads and writes, when
/// there is a Codex on the PATH: a method, a field or a value the driver
/// uses that the installed Codex no longer has fails it, so a developer
/// who upgrades Codex sees what moved. What the driver does not use may
/// come and go.
#[test]
fn what_the_driver_uses_is_in_the_installed_codex_s_protocol() {
    let vars: HashMap<String, String> = std::env::vars().collect();
    let Some(codex) = find_on_path(&vars, "codex") else {
        eprintln!("no codex on the PATH: the protocol is not compared");
        return;
    };
    let schema = Schema::generate(&codex);
    let moved: Vec<String> = USES
        .iter()
        .filter_map(|(at, path, values)| schema.check(at, path, values))
        .collect();
    assert!(
        moved.is_empty(),
        "the installed Codex does not have what the driver uses:\n{}",
        moved.join("\n")
    );
    // The check itself tells a field, a value and a method that are not
    // there from those that are.
    assert!(schema
        .check("request turn/start", "noSuchField", &[])
        .is_some());
    assert!(schema
        .check(
            "notification turn/completed",
            "turn.status",
            &["noSuchStatus"]
        )
        .is_some());
    assert!(schema
        .check("notification no/such/method", "", &[])
        .is_some());
}

#[test]
fn another_thread_s_notifications_and_requests_are_not_this_session_s() {
    let mut driver = ready();
    turn(&mut driver, M1);
    let sub = |method: &str, params: Value| {
        let mut params = params;
        params["threadId"] = json!("thread-sub");
        notification(method, params)
    };
    let reading = |driver: &mut AppServer, lines: &[Value]| -> (Vec<Event>, Vec<String>) {
        let mut out = (vec![], vec![]);
        for line in lines {
            let reading = read(driver, line.clone());
            out.0.extend(reading.events);
            out.1.extend(reading.writes);
        }
        out
    };
    let (out, writes) = reading(
        &mut driver,
        &[
            sub("turn/started", json!({"turn": {"id": "sub-1"}})),
            sub(
                "item/started",
                json!({"turnId": "sub-1", "item": {"type": "commandExecution", "id": "c-sub", "command": "ls"}}),
            ),
            sub(
                "item/agentMessage/delta",
                json!({"itemId": "m-sub", "delta": "hi"}),
            ),
            sub(
                "error",
                json!({"error": {"message": "boom"}, "willRetry": false}),
            ),
            sub(
                "turn/completed",
                json!({"turn": {"id": "sub-1", "status": "completed"}}),
            ),
            json!({"id": 40, "method": "item/commandExecution/requestApproval",
                   "params": {"threadId": "thread-sub", "turnId": "sub-1", "itemId": "c-sub", "command": "ls"}}),
        ],
    );
    assert_eq!(
        out,
        [],
        "nothing of the sub-agent's thread is this session's"
    );
    assert_eq!(
        written(&writes),
        [json!({"id": 40, "result": {"decision": "decline"}})],
        "its request is told no rather than left waiting"
    );
    // The session's own turn still runs, and is the one that ends.
    let out = events(&mut driver, &[completed("completed")]);
    assert!(
        matches!(
            out.as_slice(),
            [Event::TurnEnded {
                outcome: Outcome::Done,
                ..
            }]
        ),
        "{out:?}"
    );
}

#[test]
fn an_interrupt_for_a_turn_that_never_began_stops_no_later_one() {
    let mut driver = ready();
    // The message's turn/start fails after an interrupt asked for its turn.
    let line: Value = serde_json::from_str(&driver.message(M1, "go", &[]).unwrap()).unwrap();
    driver.control(&Control::Interrupt).unwrap();
    read(
        &mut driver,
        json!({"id": line["id"], "error": {"code": -32600, "message": "busy"}}),
    );
    // A turn the agent begins by itself is not interrupted for it.
    let reading = read(
        &mut driver,
        notification(
            "turn/started",
            json!({"threadId": THREAD, "turn": {"id": "turn-own"}}),
        ),
    );
    assert!(reading.writes.is_empty(), "{:?}", reading.writes);
    read(
        &mut driver,
        notification(
            "turn/completed",
            json!({"threadId": THREAD, "turn": {"id": "turn-own", "status": "completed"}}),
        ),
    );

    // A message whose turn/start is never answered, and is given up on:
    // the next message's turn is not interrupted either.
    driver.message(M1, "go", &[]).unwrap();
    driver.control(&Control::Interrupt).unwrap();
    let line: Value = serde_json::from_str(&driver.message(M2, "go", &[]).unwrap()).unwrap();
    let reading = read(
        &mut driver,
        json!({"id": line["id"], "result": {"turn": {"id": "turn-2"}}}),
    );
    assert!(reading.writes.is_empty(), "{:?}", reading.writes);
}

#[test]
fn a_change_made_while_a_turn_start_is_on_its_way_is_kept() {
    let mut driver = ready();
    let settings = |line: &str| -> Value {
        let line: Value = serde_json::from_str(line).unwrap();
        line
    };
    // Changed while the request is out: it goes with the next one.
    let line = settings(&driver.message(M1, "go", &[]).unwrap());
    assert!(line["params"].get("model").is_none());
    driver.control(&Control::SetModel("gpt-b".into())).unwrap();
    events(
        &mut driver,
        &[
            json!({"id": line["id"], "result": {"turn": {"id": "turn-1"}}}),
            completed("completed"),
        ],
    );
    let line = settings(&driver.message(M2, "go", &[]).unwrap());
    assert_eq!(line["params"]["model"], "gpt-b");
    events(
        &mut driver,
        &[
            json!({"id": line["id"], "result": {"turn": {"id": "turn-1"}}}),
            completed("completed"),
        ],
    );

    // Carried by a request that fails: it goes again with the next, unless
    // changed again since.
    driver
        .control(&Control::SetMode("full-access".into()))
        .unwrap();
    driver
        .control(&Control::SetEffort("minimal".into()))
        .unwrap();
    let line = settings(&driver.message(M1, "go", &[]).unwrap());
    assert_eq!(line["params"]["approvalPolicy"], "never");
    assert_eq!(line["params"]["effort"], "minimal");
    driver
        .control(&Control::SetMode("read-only".into()))
        .unwrap();
    read(
        &mut driver,
        json!({"id": line["id"], "error": {"code": -32600, "message": "busy"}}),
    );
    let line = settings(&driver.message(M2, "go", &[]).unwrap());
    assert_eq!(line["params"]["effort"], "minimal", "brought back");
    assert_eq!(line["params"]["sandboxPolicy"], json!({"type": "readOnly"}));
    assert_eq!(
        line["params"]["approvalPolicy"], "on-request",
        "the newer one"
    );
}

#[test]
fn a_mode_change_keeps_the_user_s_own_sandbox_settings() {
    // Started read only: the workspace settings come from the
    // configuration.
    let mut driver = fresh();
    let mut started = thread_started();
    started["sandbox"] = json!({"type": "readOnly", "networkAccess": false});
    handshake_with(
        &mut driver,
        json!({"account": null, "requiresOpenaiAuth": false}),
        started,
    );
    driver.control(&Control::SetMode("auto".into())).unwrap();
    let line: Value = serde_json::from_str(&driver.message(M1, "go", &[]).unwrap()).unwrap();
    assert_eq!(
        line["params"]["sandboxPolicy"],
        json!({"type": "workspaceWrite", "writableRoots": ["/work/shared"], "networkAccess": true,
               "excludeTmpdirEnvVar": false, "excludeSlashTmp": false})
    );

    // Started in the workspace: Codex's own account of it is kept.
    let mut driver = fresh();
    let mut started = thread_started();
    let own = json!({"type": "workspaceWrite", "writableRoots": ["/work/demo/out"],
                     "networkAccess": true, "excludeTmpdirEnvVar": true, "excludeSlashTmp": false});
    started["sandbox"] = own.clone();
    handshake_with(
        &mut driver,
        json!({"account": null, "requiresOpenaiAuth": false}),
        started,
    );
    driver
        .control(&Control::SetMode("read-only".into()))
        .unwrap();
    driver.control(&Control::SetMode("auto".into())).unwrap();
    let line: Value = serde_json::from_str(&driver.message(M1, "go", &[]).unwrap()).unwrap();
    assert_eq!(line["params"]["sandboxPolicy"], own);

    // Nothing known: Codex's defaults; and a name not known is read only.
    assert_eq!(
        sandbox_policy("workspace-write", None),
        json!({"type": "workspaceWrite"})
    );
    assert_eq!(
        sandbox_policy("something-new", None),
        json!({"type": "readOnly"})
    );
    assert_eq!(
        configured_workspace(&json!({"sandbox_workspace_write": null})),
        None
    );
}

#[test]
fn a_request_too_long_to_read_is_told_no() {
    let mut driver = ready();
    turn(&mut driver, M1);
    let refused = |driver: &mut AppServer, head: &str| -> Vec<Value> {
        driver.skipping(head.as_bytes());
        driver.skipping(&[b'x'; 10_000]);
        written(&driver.skipped().writes)
    };
    assert_eq!(
        refused(
            &mut driver,
            r#"{"id":7,"method":"mcpServer/elicitation/request","params":{"threadId":"thread-1","_meta":{"tool_params":{"text":"xxx"#,
        ),
        [json!({"id": 7, "result": {"action": "decline", "content": null}})]
    );
    assert_eq!(
        refused(
            &mut driver,
            r#"{"method": "item/permissions/requestApproval", "id": "s-2", "params": {"permissions": {"x": "xx"#,
        ),
        [json!({"id": "s-2", "result": {"permissions": {}, "scope": "turn"}})]
    );
    assert_eq!(
        refused(
            &mut driver,
            r#"{"id":8,"method":"item/tool/call","params":{"arguments":"xx"#
        ),
        [json!({"id": 8, "error": {"code": -32601, "message": "not handled by Agent Workbench"}})]
    );
    // An id inside the params is not the request's.
    assert_eq!(
        refused(
            &mut driver,
            r#"{"method":"item/commandExecution/requestApproval","params":{"id":3,"command":"xx"#
        ),
        Vec::<Value>::new()
    );
}

#[test]
fn an_mcp_approval_names_its_own_call_or_none() {
    let mut driver = ready();
    turn(&mut driver, M1);
    let call = |id: &str, tool: &str, arguments: Value| {
        item(
            "item/started",
            json!({"type": "mcpToolCall", "id": id, "server": "docs", "tool": tool,
                   "arguments": arguments, "status": "inProgress"}),
        )
    };
    events(
        &mut driver,
        &[
            call("call_a", "search", json!({"q": "a"})),
            call("call_b", "search", json!({"q": "b"})),
            call("call_c", "fetch", json!({"url": "x"})),
        ],
    );
    let asked = |driver: &mut AppServer, id: i64, tool: &str, params: Value| -> Option<String> {
        let out = events(
            driver,
            &[server_request(
                id,
                "mcpServer/elicitation/request",
                json!({"threadId": THREAD, "turnId": "turn-1", "serverName": "docs", "mode": "form",
                       "message": "?", "requestedSchema": {"type": "object", "properties": {}},
                       "_meta": {"codex_approval_kind": "mcp_tool_call", "tool_name": tool,
                                 "tool_params": params}}),
            )],
        );
        match &out[..] {
            [Event::PermissionAsked { call, .. }] => call.clone(),
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(
        asked(&mut driver, 1, "fetch", json!({"url": "x"})).as_deref(),
        Some("call_c"),
        "the one call of that tool"
    );
    assert_eq!(
        asked(&mut driver, 2, "search", json!({"q": "b"})).as_deref(),
        Some("call_b"),
        "of two, the one with these arguments"
    );
    assert_eq!(
        asked(&mut driver, 3, "search", json!({"q": "z"})),
        None,
        "nothing tells them apart"
    );
}

#[test]
fn trust_is_read_and_written_in_the_home_the_codex_process_runs_with() {
    let base = std::env::temp_dir().join(format!(
        "workbench-codex-trust-home-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let home = base.join("home");
    let shell = base.join("shell-codex");
    let folder = base.join("work");
    std::fs::create_dir_all(home.join(".codex")).unwrap();
    std::fs::create_dir_all(&shell).unwrap();
    std::fs::create_dir_all(folder.join("relative-codex")).unwrap();
    let key = dunce::canonicalize(&folder).unwrap();
    let trusting = format!(
        "[projects.'{}']\ntrust_level = \"trusted\"\n",
        key.to_string_lossy()
    );
    // The home the user's own folder holds trusts the folder; the one the
    // launch environment names does not.
    std::fs::write(home.join(".codex").join("config.toml"), &trusting).unwrap();
    let named =
        |dir: &Path| HashMap::from([("CODEX_HOME".to_string(), dir.to_string_lossy().to_string())]);
    let env = named(&shell);
    assert!(!CODEX_APP_SERVER.trusted(&home, None, &env, &folder));
    CODEX_APP_SERVER.trust(&home, None, &env, &folder).unwrap();
    assert!(std::fs::read_to_string(shell.join("config.toml"))
        .unwrap()
        .contains("trusted"));
    assert!(CODEX_APP_SERVER.trusted(&home, None, &env, &folder));

    // With no CODEX_HOME, or an empty one, the user's `.codex`.
    assert!(CODEX_APP_SERVER.trusted(&home, None, &HashMap::new(), &folder));
    let empty = HashMap::from([("CODEX_HOME".to_string(), String::new())]);
    assert!(CODEX_APP_SERVER.trusted(&home, None, &empty, &folder));

    // A relative one is taken from the folder the process starts in.
    let relative = named(Path::new("relative-codex"));
    assert!(!CODEX_APP_SERVER.trusted(&home, None, &relative, &folder));
    std::fs::write(folder.join("relative-codex").join("config.toml"), &trusting).unwrap();
    assert!(CODEX_APP_SERVER.trusted(&home, None, &relative, &folder));

    // An account's home wins over the environment.
    let account = base.join("account");
    std::fs::create_dir_all(&account).unwrap();
    assert!(!CODEX_APP_SERVER.trusted(&home, Some(&account), &HashMap::new(), &folder));
    std::fs::remove_dir_all(&base).ok();
}
