//! The whole road to a machine, with this machine standing in: the token
//! made on the machine, taken in by the app, the connection opened through
//! the real client with the key it brought, and the daemon answering.
//! Needs an sshd on localhost that takes this user's keys, so it runs only
//! when asked.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_workbench_lib::ssh::Files;
use serde_json::Value;
use workbench_core::Connection;

fn asked() -> bool {
    std::env::var_os("WORKBENCH_SSH_LOCALHOST").is_some()
}

/// Takes the authorised line the test made out of this user's
/// authorized_keys again, whatever happens in between.
struct Authorized {
    file: PathBuf,
    mark: String,
}

impl Drop for Authorized {
    fn drop(&mut self) {
        let text = std::fs::read_to_string(&self.file).unwrap_or_default();
        let kept: Vec<&str> = text.lines().filter(|l| !l.contains(&self.mark)).collect();
        std::fs::write(&self.file, format!("{}\n", kept.join("\n"))).unwrap();
    }
}

#[test]
fn pairs_with_this_machine_by_token_and_runs_the_daemon_there() {
    if !asked() {
        eprintln!("set WORKBENCH_SSH_LOCALHOST=1 to run this against sshd on localhost");
        return;
    }
    let real_home = PathBuf::from(std::env::var("HOME").unwrap());
    let daemon =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug/agent-workbench-remote");
    assert!(
        daemon.is_file(),
        "build the workspace first: {}",
        daemon.display()
    );
    let _authorized = Authorized {
        file: real_home.join(".ssh/authorized_keys"),
        mark: daemon.to_string_lossy().to_string(),
    };

    // The machine's side: what `agent-workbench-remote connect` does.
    let token =
        workbench_core::pair::connect(&real_home, &daemon, Some("localhost".into()), 22).unwrap();

    // The desktop's side, with files of its own.
    let home = std::env::temp_dir().join("workbench-localhost-home");
    std::fs::remove_dir_all(&home).ok();
    std::fs::create_dir_all(&home).unwrap();
    let files = Files::new(&home);
    let saved = files.pair(&token).unwrap();
    assert_eq!(saved.host, "localhost");
    let target = saved.target();

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
