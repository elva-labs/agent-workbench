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
