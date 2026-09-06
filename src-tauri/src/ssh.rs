//! Getting onto another machine without the user handling a key.
//!
//! Three doors, tried in this order by the window: a host the user already
//! reaches with their own ssh setup needs nothing; a host with only a
//! password gets the app's key installed over that password, once; and the
//! daemon is put on the machine over the same connection the first time it
//! is missing. The user's own ssh client does the talking, with the app
//! standing in for the password prompt through `SSH_ASKPASS`.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use workbench_core::env;

/// The variable the app reads in askpass mode: the file holding the one
/// password ssh is about to ask for.
pub const ASKPASS_FILE: &str = "WORKBENCH_ASKPASS_FILE";

/// The argument that makes the app print that file and exit, which is all
/// ssh wants of an askpass program.
pub const ASKPASS_FLAG: &str = "--askpass";

/// Where the daemon goes on the remote, relative to the home there.
pub const DAEMON_DIR: &str = ".agent-workbench/bin";
pub const DAEMON_NAME: &str = "agent-workbench-remote";

/// A host the app set up itself: its key, its known_hosts entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub host: String,
    pub user: String,
}

impl Saved {
    /// A remote from what the user typed, or why it cannot be one.
    pub fn new(host: &str, user: &str) -> Result<Self, String> {
        check_name(host, "host")?;
        check_name(user, "user")?;
        if user.contains(['@', ':']) {
            return Err("the user name cannot contain @ or :".into());
        }
        Ok(Self {
            host: host.to_string(),
            user: user.to_string(),
        })
    }

    /// What goes in the path: `user@host`.
    pub fn target(&self) -> String {
        format!("{}@{}", self.user, self.host)
    }
}

/// Whether a target, host or user is one thing ssh can be handed as its
/// destination: a name, never a flag. Anything starting with `-` would be
/// read by ssh as an option, and an option can name a command to run.
pub fn check_name(name: &str, what: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(format!("no {what} given"));
    }
    if name.starts_with('-') {
        return Err(format!("a {what} cannot start with -"));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@' | ':'))
    {
        return Err(format!(
            "a {what} can only have letters, digits, . _ - @ and :"
        ));
    }
    if name.matches('@').count() > 1 {
        return Err(format!("a {what} can have one @ at most"));
    }
    if name
        .split('@')
        .any(|part| part.is_empty() || part.starts_with('-'))
    {
        return Err(format!(
            "a {what} cannot have an empty part or one starting with -"
        ));
    }
    Ok(())
}

/// The app's own files for remotes, under the user's home.
pub struct Files {
    dir: PathBuf,
}

impl Files {
    pub fn new(home: &Path) -> Self {
        Self {
            dir: home.join(".agent-workbench"),
        }
    }

    pub fn key(&self) -> PathBuf {
        self.dir.join("id_ed25519")
    }

    pub fn public_key(&self) -> PathBuf {
        self.dir.join("id_ed25519.pub")
    }

    pub fn known_hosts(&self) -> PathBuf {
        self.dir.join("known_hosts")
    }

    fn remotes(&self) -> PathBuf {
        self.dir.join("remotes.json")
    }

    pub fn saved(&self) -> Vec<Saved> {
        std::fs::read_to_string(self.remotes())
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// Remembers a host, replacing an entry for the same target.
    pub fn save(&self, remote: Saved) -> Result<(), String> {
        let mut all: Vec<Saved> = self
            .saved()
            .into_iter()
            .filter(|known| known.target() != remote.target())
            .collect();
        all.push(remote);
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let text = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
        std::fs::write(self.remotes(), text).map_err(|e| e.to_string())
    }

    pub fn forget(&self, target: &str) -> Result<(), String> {
        let rest: Vec<Saved> = self
            .saved()
            .into_iter()
            .filter(|known| known.target() != target)
            .collect();
        let text = serde_json::to_string_pretty(&rest).map_err(|e| e.to_string())?;
        std::fs::write(self.remotes(), text).map_err(|e| e.to_string())
    }

    /// Whether a target is one the app set up, which decides which key and
    /// which known_hosts ssh is told to use.
    pub fn is_saved(&self, target: &str) -> bool {
        self.saved().iter().any(|known| known.target() == target)
    }

    /// The options that make ssh use the app's own key and host list, for a
    /// target the app set up. Nothing for any other target: those are the
    /// user's own ssh configuration's business.
    pub fn options(&self, target: &str) -> Vec<String> {
        if !self.is_saved(target) {
            return Vec::new();
        }
        vec![
            "-i".into(),
            self.key().to_string_lossy().into(),
            "-o".into(),
            "IdentitiesOnly=yes".into(),
            "-o".into(),
            format!(
                "UserKnownHostsFile={}",
                self.known_hosts().to_string_lossy()
            ),
        ]
    }
}

/// The hosts named in the user's ssh configuration, in the order written,
/// patterns left out: those are not machines.
pub fn config_hosts(config: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    for line in config.lines() {
        let line = line.trim();
        let Some(rest) = line
            .strip_prefix("Host ")
            .or_else(|| line.strip_prefix("Host\t"))
        else {
            continue;
        };
        for name in rest.split_whitespace() {
            if name.contains(['*', '?', '!']) || hosts.iter().any(|known| known == name) {
                continue;
            }
            hosts.push(name.to_string());
        }
    }
    hosts
}

pub fn ssh_config(home: &Path) -> String {
    std::fs::read_to_string(home.join(".ssh").join("config")).unwrap_or_default()
}

/// The user's ssh client, or where it is missing.
fn ssh() -> Result<PathBuf, String> {
    env::find_on_path(&env::environment().vars, "ssh")
        .ok_or_else(|| "ssh is not installed, or not on the login shell's PATH".to_string())
}

fn tool(name: &str) -> Result<PathBuf, String> {
    env::find_on_path(&env::environment().vars, name)
        .ok_or_else(|| format!("{name} is not installed, or not on the login shell's PATH"))
}

/// The app's key pair, made the first time it is needed. ssh-keygen ships
/// with every ssh client, so nothing else is needed to make one.
pub fn ensure_key(files: &Files) -> Result<String, String> {
    let key = files.key();
    if !key.exists() {
        std::fs::create_dir_all(key.parent().expect("key has a parent"))
            .map_err(|e| e.to_string())?;
        let output = Command::new(tool("ssh-keygen")?)
            .args([
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-C",
                "agent-workbench",
                "-f",
            ])
            .arg(&key)
            .envs(&env::environment().vars)
            .output()
            .map_err(|e| format!("could not run ssh-keygen: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "ssh-keygen failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }
    std::fs::read_to_string(files.public_key())
        .map(|text| text.trim().to_string())
        .map_err(|e| format!("could not read the public key: {e}"))
}

/// What the machine at `host` identifies itself as, for the user to trust
/// or not before anything is sent to it. The lines ssh-keygen prints, one
/// per key type.
pub fn fingerprint(host: &str) -> Result<String, String> {
    check_name(host, "host")?;
    let (name, port) = split_port(host);
    let mut keyscan = Command::new(tool("ssh-keyscan")?);
    keyscan.args(["-T", "5"]);
    if let Some(port) = port {
        keyscan.args(["-p", port]);
    }
    let scanned = keyscan
        .arg(name)
        .envs(&env::environment().vars)
        .output()
        .map_err(|e| format!("could not run ssh-keyscan: {e}"))?;
    if scanned.stdout.is_empty() {
        return Err(format!(
            "no answer from {host}: {}",
            String::from_utf8_lossy(&scanned.stderr).trim()
        ));
    }
    let mut keygen = Command::new(tool("ssh-keygen")?)
        .args(["-l", "-f", "-"])
        .envs(&env::environment().vars)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run ssh-keygen: {e}"))?;
    keygen
        .stdin
        .take()
        .expect("piped")
        .write_all(&scanned.stdout)
        .map_err(|e| e.to_string())?;
    let output = keygen.wait_with_output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Err("could not read the host's keys".into());
    }
    Ok(text)
}

/// `host:port` apart, for the tools that take a port of their own.
fn split_port(host: &str) -> (&str, Option<&str>) {
    match host.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            (name, Some(port))
        }
        _ => (host, None),
    }
}

/// The ssh arguments for a saved target: `-p` for a port, and the target
/// without it.
pub fn target_args(target: &str) -> Vec<String> {
    let (name, port) = split_port(target);
    let mut args = Vec::new();
    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(name.to_string());
    args
}

/// Puts the app's public key on the machine, over a password given once.
/// The password reaches ssh through the app itself in askpass mode and a
/// file only this user can read, gone again before this returns.
pub fn install_key(files: &Files, remote: &Saved, password: &str) -> Result<(), String> {
    let public = ensure_key(files)?;
    let script = "umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys";
    let mut args = vec![
        "-o".to_string(),
        "PreferredAuthentications=password,keyboard-interactive".to_string(),
        "-o".to_string(),
        "PubkeyAuthentication=no".to_string(),
        "-o".to_string(),
        "NumberOfPasswordPrompts=1".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
        "-o".to_string(),
        format!(
            "UserKnownHostsFile={}",
            files.known_hosts().to_string_lossy()
        ),
    ];
    args.extend(target_args(&remote.target()));
    args.push(script.to_string());
    let output = with_password(
        password,
        |command| command.args(&args),
        &format!("{public}\n"),
    )?;
    if !output.status.success() {
        return Err(auth_error(&output.stderr));
    }
    Ok(())
}

/// Runs ssh with a password on hand for its one prompt.
fn with_password(
    password: &str,
    configure: impl FnOnce(&mut Command) -> &mut Command,
    stdin: &str,
) -> Result<std::process::Output, String> {
    let secret = Secret::new(password)?;
    let me = std::env::current_exe().map_err(|e| format!("who am I: {e}"))?;
    let mut command = Command::new(ssh()?);
    command
        .envs(&env::environment().vars)
        .env("SSH_ASKPASS", &me)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env(ASKPASS_FILE, &secret.path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Older clients only ask through askpass when a display is set and
    // there is no terminal; the value itself is never used.
    if std::env::var_os("DISPLAY").is_none() {
        command.env("DISPLAY", ":0");
    }
    configure(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("could not run ssh: {e}"))?;
    child
        .stdin
        .take()
        .expect("piped")
        .write_all(stdin.as_bytes())
        .map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    drop(secret);
    Ok(output)
}

/// A password on disk for as long as ssh needs it, readable by this user
/// alone, removed on drop.
struct Secret {
    path: PathBuf,
}

impl Secret {
    fn new(password: &str) -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!(
            "agent-workbench-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .map_err(|e| format!("could not keep the password for ssh: {e}"))?;
        file.write_all(password.as_bytes())
            .map_err(|e| e.to_string())?;
        Ok(Self { path })
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// What the app prints in askpass mode: the password, once, from the file
/// named in its environment. Anything else is nothing.
pub fn askpass() -> String {
    std::env::var_os(ASKPASS_FILE)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default()
}

/// ssh's stderr as a reason the user can act on.
fn auth_error(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let said = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("Warning: Permanently added"))
        .unwrap_or("ssh failed")
        .to_string();
    if said.contains("Permission denied") {
        "the password was not accepted".to_string()
    } else {
        said
    }
}

/// The daemon build a machine needs, from what `uname -sm` says of it.
pub fn daemon_target(uname: &str) -> Option<&'static str> {
    let mut parts = uname.split_whitespace();
    let os = parts.next()?;
    let arch = parts.next()?;
    let os = match os {
        "Linux" => "linux",
        "Darwin" => "darwin",
        _ => return None,
    };
    let arch = match arch {
        "x86_64" | "amd64" => "x86_64",
        "aarch64" | "arm64" => "aarch64",
        _ => return None,
    };
    Some(match (os, arch) {
        ("linux", "x86_64") => "linux-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        ("darwin", "x86_64") => "darwin-x86_64",
        ("darwin", "aarch64") => "darwin-aarch64",
        _ => return None,
    })
}

/// Where a daemon build for a target is on this machine, when one is:
/// named outright for a developer, or bundled with the app.
pub fn daemon_build(target: &str, resources: Option<&Path>) -> Option<PathBuf> {
    if let Some(named) = std::env::var_os("WORKBENCH_REMOTE_BIN") {
        let named = PathBuf::from(named);
        if named.is_file() {
            return Some(named);
        }
    }
    let bundled = resources?.join("remote").join(target).join(DAEMON_NAME);
    bundled.is_file().then_some(bundled)
}

/// Runs a command on the remote through ssh, with the options for the
/// target, and gives back what it printed.
pub fn run(
    files: &Files,
    target: &str,
    script: &str,
    stdin: Option<&[u8]>,
) -> Result<String, String> {
    check_name(target, "target")?;
    let mut command = Command::new(ssh()?);
    command
        .envs(&env::environment().vars)
        .args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=15",
            "-o",
            "StrictHostKeyChecking=accept-new",
        ])
        .args(files.options(target))
        .args(target_args(target))
        .arg(script)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("could not run ssh: {e}"))?;
    if let Some(bytes) = stdin {
        child
            .stdin
            .take()
            .expect("piped")
            .write_all(bytes)
            .map_err(|e| e.to_string())?;
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(auth_error(&output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Makes sure the daemon is on the machine, at the version of this app,
/// putting it there over the connection if it is not. Says which build the
/// machine needs when there is none to send.
pub fn ensure_daemon(files: &Files, target: &str, resources: Option<&Path>) -> Result<(), String> {
    let probe = format!(
        "if [ -x \"$HOME/{DAEMON_DIR}/{DAEMON_NAME}\" ]; then \"$HOME/{DAEMON_DIR}/{DAEMON_NAME}\" version; else echo missing; fi; uname -sm"
    );
    let said = run(files, target, &probe, None)?;
    let mut lines = said.lines();
    let version = lines.next().unwrap_or("missing");
    let uname = lines.next().unwrap_or("");
    if version == env!("CARGO_PKG_VERSION") {
        return Ok(());
    }
    let build = daemon_target(uname)
        .ok_or_else(|| format!("no daemon build for a machine reporting {uname:?}"))?;
    let source = daemon_build(build, resources).ok_or_else(|| {
        format!("this app has no daemon build for {build}; set WORKBENCH_REMOTE_BIN to one")
    })?;
    let bytes =
        std::fs::read(&source).map_err(|e| format!("could not read {}: {e}", source.display()))?;
    let install = format!(
        "umask 077; mkdir -p \"$HOME/{DAEMON_DIR}\" && cat > \"$HOME/{DAEMON_DIR}/{DAEMON_NAME}.new\" && chmod +x \"$HOME/{DAEMON_DIR}/{DAEMON_NAME}.new\" && mv \"$HOME/{DAEMON_DIR}/{DAEMON_NAME}.new\" \"$HOME/{DAEMON_DIR}/{DAEMON_NAME}\""
    );
    run(files, target, &install, Some(&bytes))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_hosts_out_of_an_ssh_config() {
        let config = "Host box\n  HostName box.example\nHost *\n  User ada\nHost work lab\nHost box\nHost dev-?\n";
        assert_eq!(config_hosts(config), ["box", "work", "lab"]);
        assert!(config_hosts("").is_empty());
    }

    #[test]
    fn a_saved_remote_is_reached_as_user_at_host() {
        let saved = Saved {
            host: "box".into(),
            user: "ada".into(),
        };
        assert_eq!(saved.target(), "ada@box");
    }

    #[test]
    fn remembers_and_forgets_remotes_in_its_own_file() {
        let home = std::env::temp_dir().join("workbench-ssh-files");
        std::fs::remove_dir_all(&home).ok();
        std::fs::create_dir_all(&home).unwrap();
        let files = Files::new(&home);
        assert!(files.saved().is_empty());
        assert!(files.options("ada@box").is_empty());

        files
            .save(Saved {
                host: "box".into(),
                user: "ada".into(),
            })
            .unwrap();
        files
            .save(Saved {
                host: "box".into(),
                user: "ada".into(),
            })
            .unwrap();
        assert_eq!(files.saved().len(), 1, "saving twice keeps one");
        assert!(files.is_saved("ada@box"));
        let options = files.options("ada@box");
        assert_eq!(options[0], "-i");
        assert!(options[1].ends_with("id_ed25519"));
        assert!(options.iter().any(|o| o.starts_with("UserKnownHostsFile=")));

        files.forget("ada@box").unwrap();
        assert!(files.saved().is_empty());
    }

    #[test]
    fn a_destination_is_a_name_and_never_a_flag() {
        assert!(check_name("ada@box", "target").is_ok());
        assert!(check_name("box.example.com:2222", "host").is_ok());
        assert!(check_name("-oProxyCommand=evil", "host").is_err());
        assert!(check_name("ada@-box", "target").is_err());
        assert!(check_name("box;rm", "host").is_err());
        assert!(check_name("a b", "host").is_err());
        assert!(check_name("", "host").is_err());
        assert!(check_name("a@b@c", "target").is_err());
        assert!(Saved::new("box", "ada").is_ok());
        assert!(Saved::new("box", "ada@x").is_err());
        assert!(Saved::new("-box", "ada").is_err());
    }

    #[test]
    fn a_port_rides_on_the_target() {
        assert_eq!(target_args("ada@box"), ["ada@box"]);
        assert_eq!(target_args("ada@box:2222"), ["-p", "2222", "ada@box"]);
        assert_eq!(split_port("box:abc"), ("box:abc", None));
    }

    #[test]
    fn names_the_build_a_machine_needs() {
        assert_eq!(daemon_target("Linux x86_64"), Some("linux-x86_64"));
        assert_eq!(daemon_target("Linux aarch64"), Some("linux-aarch64"));
        assert_eq!(daemon_target("Darwin arm64"), Some("darwin-aarch64"));
        assert_eq!(daemon_target("FreeBSD amd64"), None);
        assert_eq!(daemon_target(""), None);
    }

    #[test]
    fn a_build_named_outright_wins_over_the_bundle() {
        let dir = std::env::temp_dir().join("workbench-ssh-build");
        std::fs::create_dir_all(dir.join("remote/linux-x86_64")).unwrap();
        let bundled = dir.join("remote/linux-x86_64").join(DAEMON_NAME);
        std::fs::write(&bundled, "").unwrap();
        std::env::remove_var("WORKBENCH_REMOTE_BIN");
        assert_eq!(daemon_build("linux-x86_64", Some(&dir)), Some(bundled));
        assert_eq!(daemon_build("linux-aarch64", Some(&dir)), None);
        assert_eq!(daemon_build("linux-x86_64", None), None);
    }

    #[test]
    fn turns_ssh_s_complaint_into_a_reason() {
        assert_eq!(
            auth_error(b"Warning: Permanently added 'box' (ED25519) to the list of known hosts.\r\nada@box: Permission denied (publickey,password).\r\n"),
            "the password was not accepted"
        );
        assert_eq!(
            auth_error(b"ssh: Could not resolve hostname box: nodename nor servname provided\n"),
            "ssh: Could not resolve hostname box: nodename nor servname provided"
        );
        assert_eq!(auth_error(b""), "ssh failed");
    }

    #[test]
    fn the_secret_is_gone_once_dropped() {
        let secret = Secret::new("hunter2").unwrap();
        let path = secret.path.clone();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hunter2");
        drop(secret);
        assert!(!path.exists());
    }

    #[test]
    fn askpass_prints_the_file_and_nothing_without_one() {
        std::env::remove_var(ASKPASS_FILE);
        assert_eq!(askpass(), "");
        let secret = Secret::new("s3cret").unwrap();
        std::env::set_var(ASKPASS_FILE, &secret.path);
        assert_eq!(askpass(), "s3cret");
        std::env::remove_var(ASKPASS_FILE);
    }
}
