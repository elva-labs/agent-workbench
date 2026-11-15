//! The daemon as the desktop app meets it: a process, lines in, lines out.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use workbench_core::scratch::Scratch;

#[cfg(unix)]
use serde_json::json;
use serde_json::Value;

/// The daemon under test, told to use the system shell. A login shell with a
/// framework on it can greet an interactive session with a question, and a
/// question reads the keys meant for the command. It runs in a home of its
/// own, so nothing it keeps, its heartbeat among it, lands in the real one.
fn daemon(home: &Path) -> std::process::Child {
    Command::new(env!("CARGO_BIN_EXE_agent-workbench-remote"))
        .arg("serve")
        .env("SHELL", "/bin/sh")
        .env("HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("the daemon starts")
}

#[test]
fn prints_its_version() {
    let output = Command::new(env!("CARGO_BIN_EXE_agent-workbench-remote"))
        .arg("version")
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        env!("CARGO_PKG_VERSION")
    );
}

#[test]
fn answers_requests_by_id_and_ends_with_its_stdin() {
    let home = Scratch::new("serve-home");
    let mut child = daemon(&home);
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();

    writeln!(stdin, r#"{{"id":1,"method":"ping"}}"#).unwrap();
    writeln!(stdin, r#"{{"id":2,"method":"no_such_thing"}}"#).unwrap();
    writeln!(stdin, "not json at all").unwrap();
    writeln!(stdin, r#"{{"id":3,"method":"home"}}"#).unwrap();

    let mut answers = std::collections::HashMap::new();
    while answers.len() < 3 {
        let line = lines.next().expect("an answer").unwrap();
        let value: Value = serde_json::from_str(&line).unwrap();
        answers.insert(value["id"].as_u64().unwrap(), value);
    }
    assert_eq!(answers[&1]["result"]["version"], env!("CARGO_PKG_VERSION"));
    assert!(answers[&2]["error"]
        .as_str()
        .unwrap()
        .contains("no_such_thing"));
    assert!(answers[&3]["result"].is_string());

    drop(stdin);
    let status = child.wait().unwrap();
    assert!(status.success());
}

#[cfg(unix)]
#[test]
fn streams_a_shell_s_output_and_its_end() {
    let home = Scratch::new("serve-home");
    let mut child = daemon(&home);
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();

    let spawn = json!({"id": 1, "method": "pty_shell", "params": {"project": "/tmp", "cols": 80, "rows": 24}});
    writeln!(stdin, "{spawn}").unwrap();
    let mut pty = None;
    let mut seen = String::new();
    let mut ended = None;
    for line in lines.by_ref() {
        let value: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if value["id"] == 1 {
            let id = value["result"]
                .as_str()
                .unwrap_or_else(|| panic!("pty_shell answered {value}"));
            pty = Some(id.to_string());
        } else if value["event"] == "pty_output" {
            let id = pty.as_deref().unwrap();
            assert_eq!(value["payload"]["id"], id);
            // The shell's first bytes mean it is up and reading; typed at it
            // any earlier, the lines would be for the tty the shell has not
            // yet set up, as they would be in any terminal.
            if seen.is_empty() {
                let write = json!({"id": 2, "method": "pty_write", "params": {"id": id, "data": "echo marker-$((40+2))\nexit 4\n"}});
                writeln!(stdin, "{write}").unwrap();
            }
            let bytes = workbench_core::protocol::output_bytes("pty_output", &value["payload"])
                .unwrap()
                .1;
            seen.push_str(&String::from_utf8_lossy(&bytes));
        } else if value["event"] == "session_ended" {
            ended = Some(value["payload"].clone());
            break;
        }
    }
    assert!(seen.contains("marker-42"), "{seen}");
    let ended = ended.unwrap();
    assert_eq!(ended["id"], pty.unwrap());
    assert_eq!(ended["code"], 4);
    drop(stdin);
    child.wait().unwrap();
}

mod client {
    use std::path::Path;
    use std::process::Command;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[cfg(unix)]
    use serde_json::json;
    use serde_json::Value;
    use workbench_core::client::CLOSED;
    use workbench_core::Connection;
    #[cfg(unix)]
    use workbench_core::Output;

    /// The daemon behind a connection, in a home of its own, as above.
    fn connect(home: &Path, events: Arc<Mutex<Vec<(String, Value)>>>) -> Arc<Connection> {
        Connection::open(
            Command::new(env!("CARGO_BIN_EXE_agent-workbench-remote"))
                .arg("serve")
                .env("SHELL", "/bin/sh")
                .env("HOME", home),
            Box::new(move |event, payload| {
                events.lock().unwrap().push((event.to_string(), payload))
            }),
        )
        .unwrap()
    }

    #[test]
    fn calls_come_back_answered_in_any_order() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let home = workbench_core::scratch::Scratch::new("serve-home");
        let connection = connect(&home, events);
        let ping = connection.call("ping", Value::Null).unwrap();
        assert_eq!(ping["version"], env!("CARGO_PKG_VERSION"));
        let error = connection.call("no_such", Value::Null).unwrap_err();
        assert!(error.contains("no_such"));
        let home = connection.call("home", Value::Null).unwrap();
        assert!(home.is_string());
        connection.close();
        assert!(!connection.is_alive());
    }

    #[cfg(unix)]
    #[test]
    fn a_remote_shell_s_bytes_reach_the_attached_output_and_its_end_is_an_event() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let home = workbench_core::scratch::Scratch::new("serve-home");
        let connection = connect(&home, Arc::clone(&events));
        let id = connection
            .call(
                "pty_shell",
                json!({"project": "/tmp", "cols": 80, "rows": 24}),
            )
            .unwrap();
        let id = id.as_str().unwrap().to_string();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let output: Output = Box::new({
            let seen = Arc::clone(&seen);
            move |bytes| {
                seen.lock().unwrap().extend_from_slice(bytes);
                true
            }
        });
        connection.attach_output(&id, output);
        connection
            .call(
                "pty_write",
                json!({"id": id, "data": "echo marker-$((40+2))\nexit 5\n"}),
            )
            .unwrap();
        for _ in 0..100 {
            if events
                .lock()
                .unwrap()
                .iter()
                .any(|(event, _)| event == "session_ended")
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let text = String::from_utf8_lossy(&seen.lock().unwrap()).to_string();
        assert!(text.contains("marker-42"), "{text}");
        let events = events.lock().unwrap();
        let (_, ended) = events
            .iter()
            .find(|(event, _)| event == "session_ended")
            .expect("the end");
        assert_eq!(ended["id"], id);
        assert_eq!(ended["code"], 5);
        drop(events);
        connection.close();
    }

    /// An integrated session on the far side, against a stand-in for
    /// `claude` that answers the opening and the read of the account's
    /// limits, holds one turn and waits for its stdin to close.
    #[cfg(unix)]
    #[test]
    fn an_integrated_session_runs_through_the_daemon() {
        use std::os::unix::fs::PermissionsExt;
        let dir = workbench_core::scratch::Scratch::new("serve-integrated");
        let claude = dir.join("claude");
        std::fs::write(
            &claude,
            r#"#!/bin/sh
for request in initialize get_settings get_usage; do
  read -r line
  id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
  case "$request" in
    get_usage) body='{"subscription_type":"pro","rate_limits":{"limits":[{"kind":"session","percent":20,"severity":"normal","resets_at":"2030-01-01T05:00:00+00:00"}]}}' ;;
    *) body='{}' ;;
  esac
  printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":%s}}\n' "$id" "$body"
done
read -r line
printf '%s\n' '{"type":"system","subtype":"init","model":"m"}'
printf '%s\n' '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"from afar"}]},"parent_tool_use_id":null}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false}'
while read -r line; do :; done
"#,
        )
        .unwrap();
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();

        let events = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        // No login shell to ask, so the daemon's own PATH, with the
        // stand-in first, is the one the agent is looked up on.
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let connection = Connection::open(
            Command::new(env!("CARGO_BIN_EXE_agent-workbench-remote"))
                .arg("serve")
                .env_remove("SHELL")
                .env("HOME", &home)
                .env("PATH", format!("{}:/usr/bin:/bin", dir.display())),
            Box::new({
                let events = Arc::clone(&events);
                move |event, payload| events.lock().unwrap().push((event.to_string(), payload))
            }),
        )
        .unwrap();
        // A folder the agent has not been told to trust is refused, until
        // the user's yes is recorded where the agent keeps it.
        let start = json!({ "agent": "claude-code", "project": dir.path(), "model": "haiku" });
        let refused = connection
            .call("integrated_start", start.clone())
            .unwrap_err();
        assert!(refused.starts_with("untrusted:"), "{refused}");
        // Nothing is made for an account before the folder is trusted.
        let account = home.join(".claude-elsewhere");
        let refused = connection
            .call(
                "integrated_start",
                json!({ "agent": "claude-code", "project": dir.path(), "configDir": account }),
            )
            .unwrap_err();
        assert!(refused.starts_with("untrusted:"), "{refused}");
        assert!(!account.exists(), "made before the trust check");
        connection
            .call(
                "integrated_trust",
                json!({ "agent": "claude-code", "project": dir.path() }),
            )
            .unwrap();
        let state = std::fs::read_to_string(home.join(".claude.json")).unwrap();
        assert!(state.contains("hasTrustDialogAccepted"), "{state}");
        let started = connection.call("integrated_start", start).unwrap();
        let id = started["id"].as_str().unwrap().to_string();
        assert!(started["sessionId"].is_string());

        let seen = |kind: &str| {
            for _ in 0..200 {
                let found = events.lock().unwrap().iter().any(|(event, payload)| {
                    event == "integrated_event" && payload["id"] == id && payload["type"] == kind
                });
                if found {
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            panic!("no {kind}: {:?}", events.lock().unwrap());
        };
        seen("ready");
        seen("limits");
        assert!(events.lock().unwrap().iter().any(|(_, payload)| {
            payload["type"] == "limits"
                && payload["agent"] == "claude-code"
                && payload["windows"][0]["percent"] == 20.0
        }));
        connection
            .call(
                "integrated_send",
                json!({ "id": id, "message": "11111111-1111-4111-8111-111111111111", "text": "hello" }),
            )
            .unwrap();
        seen("turnEnded");
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, payload)| { payload["type"] == "text" && payload["text"] == "from afar" }));
        // A window that comes late catches up on what no transcript holds:
        // this stand-in never says it took the message, so it still waits.
        let snapshot = connection
            .call("integrated_snapshot", json!({ "id": id }))
            .unwrap();
        assert_eq!(snapshot["state"], "working", "{snapshot}");
        assert_eq!(snapshot["turn"], false);
        assert_eq!(snapshot["ready"]["type"], "ready");
        assert_eq!(snapshot["messages"][0]["text"], "hello");
        assert_eq!(snapshot["limits"]["plan"], "pro");
        assert_eq!(
            snapshot["limits"]["windows"][0]["resetsAt"],
            1_893_474_000_u64
        );
        connection
            .call("integrated_stop", json!({ "id": id }))
            .unwrap();
        seen("ended");
        connection.close();
    }

    #[test]
    fn the_far_end_going_away_fails_the_waiting_and_says_so() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let home = workbench_core::scratch::Scratch::new("serve-home");
        let connection = connect(&home, Arc::clone(&events));
        assert!(connection.call("ping", Value::Null).is_ok());
        connection.close();
        for _ in 0..100 {
            if !events.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let events = events.lock().unwrap();
        assert_eq!(events.last().map(|(event, _)| event.as_str()), Some(CLOSED));
        drop(events);
        assert!(connection.call("ping", Value::Null).is_err());
    }
}
