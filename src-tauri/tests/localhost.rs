//! The whole road to a machine, with this machine standing in: the app's
//! key made and authorized, the daemon put there over ssh, the connection
//! opened through the real client. Needs an sshd on localhost that takes
//! this user's keys, so it runs only when asked.

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_workbench_lib::ssh::{ensure_daemon, ensure_key, Files, Saved};
use serde_json::Value;
use workbench_core::Connection;

fn asked() -> bool {
    std::env::var_os("WORKBENCH_SSH_LOCALHOST").is_some()
}

/// The app's public key in this user's authorized_keys for the test, and
/// out again after, whatever happens in between.
struct Authorized {
    file: PathBuf,
    line: String,
}

impl Authorized {
    fn add(public: &str) -> Self {
        let file = PathBuf::from(std::env::var("HOME").unwrap()).join(".ssh/authorized_keys");
        let line = format!("{public} workbench-localhost-test");
        let mut handle = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file)
            .unwrap();
        writeln!(handle, "{line}").unwrap();
        Self { file, line }
    }
}

impl Drop for Authorized {
    fn drop(&mut self) {
        let text = std::fs::read_to_string(&self.file).unwrap_or_default();
        let kept: Vec<&str> = text.lines().filter(|l| *l != self.line).collect();
        std::fs::write(&self.file, format!("{}\n", kept.join("\n"))).unwrap();
    }
}

#[test]
fn reaches_this_machine_over_ssh_and_runs_the_daemon_there() {
    if !asked() {
        eprintln!("set WORKBENCH_SSH_LOCALHOST=1 to run this against sshd on localhost");
        return;
    }
    let home = std::env::temp_dir().join("workbench-localhost-home");
    std::fs::remove_dir_all(&home).ok();
    std::fs::create_dir_all(&home).unwrap();
    let files = Files::new(&home);
    let public = ensure_key(&files).unwrap();
    assert!(public.starts_with("ssh-ed25519 "), "{public}");
    let _authorized = Authorized::add(&public);

    let user = std::env::var("USER").unwrap();
    let saved = Saved::new("localhost", &user).unwrap();
    files.save(saved.clone()).unwrap();
    let target = saved.target();

    // The daemon from this build, installed under the real home there,
    // which is this home; a marker directory keeps that visible.
    let daemon =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug/agent-workbench-remote");
    assert!(
        daemon.is_file(),
        "build the workspace first: {}",
        daemon.display()
    );
    std::env::set_var("WORKBENCH_REMOTE_BIN", &daemon);
    ensure_daemon(&files, &target, None).unwrap();
    let installed = PathBuf::from(std::env::var("HOME").unwrap())
        .join(".agent-workbench/bin/agent-workbench-remote");
    assert!(installed.is_file());

    let mut command = agent_workbench_lib::remote::transport_for_test(&target, &files);
    let events = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
    let connection = Connection::open(
        &mut command,
        Box::new({
            let events = Arc::clone(&events);
            move |event, payload| events.lock().unwrap().push((event.to_string(), payload))
        }),
    )
    .unwrap();
    let hello = connection
        .call_within("ping", Value::Null, std::time::Duration::from_secs(30))
        .unwrap();
    assert_eq!(hello["version"], env!("CARGO_PKG_VERSION"));
    let home_there = connection.call("home", Value::Null).unwrap();
    assert_eq!(home_there, Value::String(std::env::var("HOME").unwrap()));
    connection.close();
}
