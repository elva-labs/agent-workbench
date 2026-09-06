//! The daemon as the desktop app meets it: a process, lines in, lines out.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::{json, Value};

fn daemon() -> std::process::Child {
    Command::new(env!("CARGO_BIN_EXE_agent-workbench-remote"))
        .arg("serve")
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
    let mut child = daemon();
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
    let mut child = daemon();
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
            let id = value["result"].as_str().unwrap().to_string();
            let write = json!({"id": 2, "method": "pty_write", "params": {"id": id, "data": "echo marker-$((40+2))\nexit 4\n"}});
            writeln!(stdin, "{write}").unwrap();
            pty = Some(id);
        } else if value["event"] == "pty_output" {
            assert_eq!(value["payload"]["id"], pty.as_deref().unwrap());
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
    use std::process::Command;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use serde_json::{json, Value};
    use workbench_core::client::CLOSED;
    use workbench_core::{Connection, Output};

    fn connect(events: Arc<Mutex<Vec<(String, Value)>>>) -> Arc<Connection> {
        Connection::open(
            Command::new(env!("CARGO_BIN_EXE_agent-workbench-remote")).arg("serve"),
            Box::new(move |event, payload| {
                events.lock().unwrap().push((event.to_string(), payload))
            }),
        )
        .unwrap()
    }

    #[test]
    fn calls_come_back_answered_in_any_order() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let connection = connect(events);
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
        let connection = connect(Arc::clone(&events));
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

    #[test]
    fn the_far_end_going_away_fails_the_waiting_and_says_so() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let connection = connect(Arc::clone(&events));
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
