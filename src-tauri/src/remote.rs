//! Projects on other machines.
//!
//! A path that starts with `ssh://host` belongs to a core on `host`, reached
//! over ssh running the daemon there; so does a pty id that starts the same
//! way. The window never learns the difference: every command routes by its
//! path or id, results and events come back with the host put back on, and
//! a connection opens the first time a host is named.

use std::collections::HashMap;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use workbench_core::client::{Connection, CLOSED};
use workbench_core::env;

use crate::ssh;

pub const SCHEME: &str = "ssh://";

/// A connection went away: `{ host, reason }`.
pub const REMOTE_CLOSED: &str = "remote_closed";

/// How long the first exchange may take: ssh connecting, the daemon
/// starting, one answer. Past this the machine or the daemon is not there.
const HELLO: Duration = Duration::from_secs(30);

/// Where a path or a pty id points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Local(String),
    /// `rest` is the path on the host, or the pty id there.
    Remote {
        host: String,
        rest: String,
    },
}

pub fn route(value: &str) -> Route {
    let Some(after) = value.strip_prefix(SCHEME) else {
        return Route::Local(value.to_string());
    };
    let end = after.find(['/', '#']).unwrap_or(after.len());
    let host = after[..end].to_string();
    let tail = &after[end..];
    let rest = tail.strip_prefix('#').unwrap_or(tail).to_string();
    Route::Remote { host, rest }
}

/// A path on the host, as the window sees it.
pub fn with_host(host: &str, path: &str) -> String {
    format!("{SCHEME}{host}{path}")
}

/// A pty id on the host, as the window sees it.
pub fn with_host_id(host: &str, id: &str) -> String {
    format!("{SCHEME}{host}#{id}")
}

fn put_back(payload: &mut Value, key: &str, qualify: impl Fn(&str) -> String) {
    if let Some(text) = payload.get(key).and_then(Value::as_str) {
        let qualified = qualify(text);
        payload[key] = Value::String(qualified);
    }
}

/// An event from a remote core, with the host put back on whatever names
/// a pty or a path.
pub fn homeward(host: &str, event: &str, mut payload: Value) -> Value {
    match event {
        workbench_core::pty::SESSION_ENDED => {
            put_back(&mut payload, "id", |id| with_host_id(host, id))
        }
        workbench_core::SESSION_IDENTIFIED => {
            put_back(&mut payload, "ptyId", |id| with_host_id(host, id))
        }
        workbench_core::watch::GIT_CHANGED => {
            if let Some(root) = payload.as_str() {
                return Value::String(with_host(host, root));
            }
        }
        _ => {}
    }
    payload
}

/// A project described by a remote core, with the host put back on its paths.
pub fn project_homeward(host: &str, mut project: Value) -> Value {
    put_back(&mut project, "path", |path| with_host(host, path));
    put_back(&mut project, "repository", |path| with_host(host, path));
    project
}

pub struct Remotes {
    app: AppHandle,
    connections: Mutex<HashMap<String, Arc<Connection>>>,
}

impl Remotes {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            connections: Mutex::new(HashMap::new()),
        }
    }

    /// The app's own files for remotes, under the user's home.
    pub fn files(&self) -> Result<ssh::Files, String> {
        let home = workbench_core::api::home_directory().ok_or("no home directory")?;
        Ok(ssh::Files::new(&home))
    }

    /// The connection to a host, opened if there is none alive. Opening
    /// puts the daemon on the machine first when it is missing or old.
    pub fn connection(&self, host: &str) -> Result<Arc<Connection>, String> {
        // The host came out of a path the window keeps, and a path is not
        // trusted to be a name rather than a flag for ssh.
        ssh::check_name(host, "host")?;
        let mut connections = self.connections.lock().expect("connections lock");
        if let Some(connection) = connections.get(host) {
            if connection.is_alive() {
                return Ok(Arc::clone(connection));
            }
        }
        if std::env::var_os("WORKBENCH_REMOTE_COMMAND").is_none() {
            let resources = self.app.path().resource_dir().ok();
            ssh::ensure_daemon(&self.files()?, host, resources.as_deref())?;
        }
        let connection = open(&self.app, host, &self.files()?)?;
        connections.insert(host.to_string(), Arc::clone(&connection));
        Ok(connection)
    }

    /// Opens the connection, or says why it cannot, and what the daemon
    /// there calls itself.
    pub fn connect(&self, host: &str) -> Result<Value, String> {
        let connection = self.connection(host)?;
        let hello = connection.call_within("ping", Value::Null, HELLO)?;
        Ok(json!({ "host": host, "version": hello["version"] }))
    }

    pub fn disconnect(&self, host: &str) {
        let connection = self
            .connections
            .lock()
            .expect("connections lock")
            .remove(host);
        if let Some(connection) = connection {
            connection.close();
        }
    }

    /// Every live connection, for what has no path to route by.
    pub fn all(&self) -> Vec<Arc<Connection>> {
        self.connections
            .lock()
            .expect("connections lock")
            .values()
            .filter(|connection| connection.is_alive())
            .cloned()
            .collect()
    }
}

fn open(app: &AppHandle, host: &str, files: &ssh::Files) -> Result<Arc<Connection>, String> {
    let mut command = transport(host, files)?;
    let app = app.clone();
    let name = host.to_string();
    let connection = Connection::open(
        &mut command,
        Box::new(move |event, payload| {
            if event == CLOSED {
                let _ = app.emit(REMOTE_CLOSED, json!({ "host": name, "reason": payload }));
            } else {
                let _ = app.emit(event, homeward(&name, event, payload));
            }
        }),
    )?;
    // The first exchange proves the daemon is there and speaks the
    // protocol. An ssh that could not get in has said why on stderr, and
    // that is the error.
    if let Err(error) = connection.call_within("ping", Value::Null, HELLO) {
        connection.close();
        return Err(error);
    }
    Ok(connection)
}

/// `transport`, for a test outside this crate.
pub fn transport_for_test(host: &str, files: &ssh::Files) -> Command {
    transport(host, files).expect("a transport")
}

/// The process that carries the conversation. ssh, with the user's login
/// environment so the agent and its keys are the user's own, and the app's
/// own key for a host the app set up; or, for a test, whatever
/// `WORKBENCH_REMOTE_COMMAND` names, `{host}` replaced.
fn transport(host: &str, files: &ssh::Files) -> Result<Command, String> {
    let vars = &env::environment().vars;
    if let Ok(template) = std::env::var("WORKBENCH_REMOTE_COMMAND") {
        let parts: Vec<String> = template
            .split_whitespace()
            .map(|part| part.replace("{host}", host))
            .collect();
        let (program, args) = parts
            .split_first()
            .ok_or("WORKBENCH_REMOTE_COMMAND names no program")?;
        let mut command = Command::new(program);
        command.args(args).envs(vars);
        return Ok(command);
    }
    let ssh = env::find_on_path(vars, "ssh").ok_or("ssh is not on the PATH")?;
    let mut command = Command::new(ssh);
    command
        .args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=15",
            "-o",
            "ServerAliveInterval=30",
            "-o",
            "StrictHostKeyChecking=accept-new",
        ])
        .args(files.options(host))
        .args(ssh::target_args(host))
        // Through the login shell there, so `$HOME` is the user's.
        .arg(format!(
            "\"$HOME/{}/{}\" serve",
            ssh::DAEMON_DIR,
            ssh::DAEMON_NAME
        ))
        .envs(vars);
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_path_is_local() {
        assert_eq!(
            route("/home/ada/repo"),
            Route::Local("/home/ada/repo".into())
        );
        assert_eq!(route("pty-3"), Route::Local("pty-3".into()));
        assert_eq!(route(r"C:\Users\ada"), Route::Local(r"C:\Users\ada".into()));
    }

    #[test]
    fn a_path_with_a_scheme_names_its_host() {
        assert_eq!(
            route("ssh://ada@box/home/ada/repo"),
            Route::Remote {
                host: "ada@box".into(),
                rest: "/home/ada/repo".into()
            }
        );
        assert_eq!(
            route("ssh://box#pty-3"),
            Route::Remote {
                host: "box".into(),
                rest: "pty-3".into()
            }
        );
        assert_eq!(
            route("ssh://box"),
            Route::Remote {
                host: "box".into(),
                rest: String::new()
            }
        );
    }

    #[test]
    fn puts_the_host_back_where_it_came_off() {
        assert_eq!(with_host("box", "/repo"), "ssh://box/repo");
        assert_eq!(with_host_id("box", "pty-1"), "ssh://box#pty-1");
        assert_eq!(route(&with_host("ada@box", "/r")), route("ssh://ada@box/r"));
    }

    #[test]
    fn events_come_home_with_their_host_on() {
        let ended = homeward("box", "session_ended", json!({"id": "pty-1", "code": 0}));
        assert_eq!(ended["id"], "ssh://box#pty-1");
        assert_eq!(ended["code"], 0);
        let named = homeward(
            "box",
            "session_identified",
            json!({"ptyId": "pty-2", "sessionId": "s"}),
        );
        assert_eq!(named["ptyId"], "ssh://box#pty-2");
        assert_eq!(
            homeward("box", "git_changed", json!("/repo")),
            json!("ssh://box/repo")
        );
        let other = homeward(
            "box",
            "session_event",
            json!({"sessionId": "s", "kind": "stop"}),
        );
        assert_eq!(other["sessionId"], "s");
    }

    #[test]
    fn a_remote_project_s_paths_do_too() {
        let project = project_homeward(
            "box",
            json!({"name": "repo", "path": "/r", "repository": "/r", "isGit": true}),
        );
        assert_eq!(project["path"], "ssh://box/r");
        assert_eq!(project["repository"], "ssh://box/r");
        let plain = project_homeward(
            "box",
            json!({"name": "x", "path": "/x", "repository": null}),
        );
        assert_eq!(plain["repository"], Value::Null);
    }

    #[test]
    fn the_test_transport_is_whatever_the_variable_names() {
        let files = ssh::Files::new(&std::env::temp_dir().join("workbench-remote-none"));
        std::env::set_var("WORKBENCH_REMOTE_COMMAND", "/bin/echo hello {host}");
        let command = transport("box", &files).unwrap();
        std::env::remove_var("WORKBENCH_REMOTE_COMMAND");
        assert_eq!(command.get_program(), "/bin/echo");
        let args: Vec<_> = command.get_args().map(|a| a.to_string_lossy()).collect();
        assert_eq!(args, ["hello", "box"]);
    }
}
