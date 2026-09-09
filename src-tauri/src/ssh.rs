//! Getting onto another machine without the user handling a key.
//!
//! Two doors. A host the user already reaches with their own ssh setup needs
//! nothing: the user's ssh client, the user's login environment, and the
//! daemon put there over the same connection when it is missing. Any other
//! machine pairs by a token from `agent-workbench-remote connect` run there,
//! which brings its own key, address, user and host key; the app keeps the
//! key and reaches the machine with it from then on.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use workbench_core::env;
use workbench_core::pair::Pairing;

/// Where the daemon goes on a machine the app installs it on, relative to
/// the home there.
pub const DAEMON_DIR: &str = ".agent-workbench/bin";
pub const DAEMON_NAME: &str = "agent-workbench-remote";

/// A machine paired by token. It is its host key: the name is what paths
/// carry and never changes, the address is where it is reached today, and
/// a new token from the same machine updates the address and the key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub name: String,
    /// The address that reached it last, tried first.
    pub host: String,
    /// Every address the token carried, in the token's order.
    #[serde(default)]
    pub hosts: Vec<String>,
    pub user: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub host_key: String,
}

fn default_port() -> u16 {
    22
}

impl Saved {
    /// What goes in the path: `user@name`.
    pub fn target(&self) -> String {
        format!("{}@{}", self.user, self.name)
    }

    /// The addresses to try, in order: the one that reached it last, then
    /// the rest as the token had them.
    pub fn addresses(&self) -> Vec<String> {
        let mut all = vec![self.host.clone()];
        for host in &self.hosts {
            if !all.contains(host) {
                all.push(host.clone());
            }
        }
        all
    }

    /// The line for the app's known hosts, under the name, which is what
    /// ssh is told to check the machine against whatever its address.
    fn known_host(&self) -> String {
        format!("{} {}", self.name, self.host_key)
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

    pub fn known_hosts(&self) -> PathBuf {
        self.dir.join("known_hosts")
    }

    /// The key a paired target is reached with, one file per target.
    pub fn key_for(&self, target: &str) -> PathBuf {
        let name: String = target
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        self.dir.join("keys").join(name)
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

    /// Remembers a machine, replacing an entry for the same target.
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

    /// Forgets a machine: its entry and its key here. The machine keeps
    /// the authorised key until the user removes it there.
    pub fn forget(&self, target: &str) -> Result<(), String> {
        let rest: Vec<Saved> = self
            .saved()
            .into_iter()
            .filter(|known| known.target() != target)
            .collect();
        let text = serde_json::to_string_pretty(&rest).map_err(|e| e.to_string())?;
        std::fs::write(self.remotes(), text).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(self.key_for(target));
        Ok(())
    }

    pub fn is_saved(&self, target: &str) -> bool {
        self.saved().iter().any(|known| known.target() == target)
    }

    /// The options that reach a paired target: its address and port, the
    /// token's key, and the app's own host list checked under the machine's
    /// name. Nothing for any other target: those are the user's own ssh
    /// configuration's business.
    pub fn options(&self, target: &str) -> Vec<String> {
        let Some(saved) = self.saved_target(target) else {
            return Vec::new();
        };
        self.options_at(&saved, &saved.host)
    }

    /// The paired machine behind a target, if it is one.
    pub fn saved_target(&self, target: &str) -> Option<Saved> {
        self.saved()
            .into_iter()
            .find(|known| known.target() == target)
    }

    /// The address that reached a paired machine goes first from now on.
    pub fn remember_address(&self, target: &str, address: &str) -> Result<(), String> {
        let Some(mut saved) = self.saved_target(target) else {
            return Ok(());
        };
        if saved.host == address {
            return Ok(());
        }
        saved.host = address.to_string();
        self.save(saved)
    }

    /// The options that reach a paired machine at one of its addresses.
    pub fn options_at(&self, saved: &Saved, address: &str) -> Vec<String> {
        let target = saved.target();
        vec![
            "-o".into(),
            format!("HostName={address}"),
            "-p".into(),
            saved.port.to_string(),
            "-o".into(),
            format!("HostKeyAlias={}", saved.name),
            "-i".into(),
            self.key_for(&target).to_string_lossy().into(),
            "-o".into(),
            "IdentitiesOnly=yes".into(),
            "-o".into(),
            format!(
                "UserKnownHostsFile={}",
                self.known_hosts().to_string_lossy()
            ),
        ]
    }

    /// Takes a token in: the key to its file, readable by this user alone,
    /// the host key to the app's known hosts, the machine to the list. A
    /// machine already known by its host key keeps its name, so the paths
    /// that carry it stay good, and takes the new address, user and key.
    pub fn pair(&self, token: &str) -> Result<Saved, String> {
        let pairing = Pairing::decode(token)?;
        check_name(&pairing.name, "name")?;
        let addresses = pairing.addresses();
        for address in &addresses {
            check_name(address, "host")?;
        }
        check_name(&pairing.user, "user")?;
        if pairing.user.contains(['@', ':']) || pairing.name.contains(['@', ':']) {
            return Err("the token's names are not ones".into());
        }
        let known = self.saved();
        let same = known
            .iter()
            .find(|saved| saved.host_key == pairing.host_key);
        let name = match same {
            Some(saved) => saved.name.clone(),
            None => {
                // Another machine with this name would share its paths; a
                // suffix keeps them apart.
                let mut name = pairing.name.clone();
                let mut n = 2;
                while known.iter().any(|saved| saved.name == name) {
                    name = format!("{}-{n}", pairing.name);
                    n += 1;
                }
                name
            }
        };
        let saved = Saved {
            name,
            host: addresses[0].clone(),
            hosts: addresses,
            user: pairing.user.clone(),
            port: pairing.port,
            host_key: pairing.host_key.clone(),
        };
        let target = saved.target();

        let key = self.key_for(&target);
        std::fs::create_dir_all(key.parent().expect("keys dir")).map_err(|e| e.to_string())?;
        restrict(key.parent().expect("keys dir"), 0o700);
        let mut text = pairing.key.clone();
        if !text.ends_with('\n') {
            text.push('\n');
        }
        std::fs::write(&key, text).map_err(|e| format!("could not keep the key: {e}"))?;
        restrict(&key, 0o600);

        let hosts = self.known_hosts();
        let lines = std::fs::read_to_string(&hosts).unwrap_or_default();
        let line = saved.known_host();
        let prefix = format!("{} ", saved.name);
        let mut kept: Vec<&str> = lines
            .lines()
            .filter(|known| !known.starts_with(&prefix))
            .collect();
        kept.push(&line);
        std::fs::write(&hosts, format!("{}\n", kept.join("\n"))).map_err(|e| e.to_string())?;

        let mut all: Vec<Saved> = known
            .into_iter()
            .filter(|known| known.host_key != saved.host_key && known.name != saved.name)
            .collect();
        all.push(saved.clone());
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let text = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
        std::fs::write(self.remotes(), text).map_err(|e| e.to_string())?;
        Ok(saved)
    }
}

#[cfg(unix)]
fn restrict(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn restrict(_path: &Path, _mode: u32) {}

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

/// `host:port` apart, for the arguments that take a port of their own.
fn split_port(host: &str) -> (&str, Option<&str>) {
    match host.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            (name, Some(port))
        }
        _ => (host, None),
    }
}

/// The ssh arguments for a target: `-p` for a port, and the target without
/// it.
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

/// ssh's stderr as a reason the user can act on.
fn explain(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    text.lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("Warning: Permanently added"))
        .unwrap_or("ssh failed")
        .to_string()
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
    let bundled = resources.map(|dir| dir.join("remote").join(target).join(DAEMON_NAME));
    if let Some(bundled) = bundled.filter(|path| path.is_file()) {
        return Some(bundled);
    }
    // A development run carries no bundle; the daemon built beside the app
    // is this machine's own build.
    if Some(target) == local_daemon_target() {
        let beside = std::env::current_exe().ok()?.parent()?.join(DAEMON_NAME);
        if beside.is_file() {
            return Some(beside);
        }
    }
    None
}

/// The daemon build for this machine, by the names the bundle uses.
pub fn local_daemon_target() -> Option<&'static str> {
    daemon_target(&format!(
        "{} {}",
        match std::env::consts::OS {
            "linux" => "Linux",
            "macos" => "Darwin",
            _ => return None,
        },
        std::env::consts::ARCH
    ))
}

/// Puts this app's own daemon build where the hooks and the agents look
/// for it on this machine, when it is missing or another version. A
/// machine kind with no build, Windows today, gets nothing and the hooks
/// go in without the server.
pub fn ensure_local_daemon(home: &Path, resources: Option<&Path>) -> Result<(), String> {
    let Some(target) = local_daemon_target() else {
        return Ok(());
    };
    let Some(source) = daemon_build(target, resources) else {
        return Ok(());
    };
    let destination = workbench_core::hook::daemon_path(home);
    let current = Command::new(&destination)
        .arg("version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
    if current.as_deref() == Some(env!("CARGO_PKG_VERSION")) {
        return Ok(());
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create {parent:?}: {e}"))?;
    }
    let staged = destination.with_extension("new");
    std::fs::copy(&source, &staged)
        .map_err(|e| format!("could not copy the daemon to {}: {e}", staged.display()))?;
    restrict(&staged, 0o755);
    std::fs::rename(&staged, &destination)
        .map_err(|e| format!("could not put the daemon at {}: {e}", destination.display()))?;
    Ok(())
}

/// Runs a command on a host the user's own ssh reaches, and gives back what
/// it printed.
pub fn run(target: &str, script: &str, stdin: Option<&[u8]>) -> Result<String, String> {
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
        return Err(explain(&output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Makes sure a host the user's own ssh reaches has the daemon, at the
/// version of this app, putting it there over the connection if it does
/// not. Says which build the machine needs when there is none to send.
pub fn ensure_daemon(target: &str, resources: Option<&Path>) -> Result<(), String> {
    let probe = format!(
        "if [ -x \"$HOME/{DAEMON_DIR}/{DAEMON_NAME}\" ]; then \"$HOME/{DAEMON_DIR}/{DAEMON_NAME}\" version; else echo missing; fi; uname -sm"
    );
    let said = run(target, &probe, None)?;
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
    run(target, &install, Some(&bytes))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(host: &str, port: u16, host_key: &str) -> String {
        Pairing {
            name: "lab".into(),
            host: host.into(),
            hosts: vec![host.into(), "10.0.0.5".into()],
            port,
            user: "ada".into(),
            key: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"
                .into(),
            host_key: host_key.into(),
        }
        .encode()
    }

    #[test]
    fn reads_the_hosts_out_of_an_ssh_config() {
        let config =
            "Host lab\n  HostName lab.example\nHost *\n  User ada\nHost work home\nHost lab\nHost dev-?\n";
        assert_eq!(config_hosts(config), ["lab", "work", "home"]);
        assert!(config_hosts("").is_empty());
    }

    #[test]
    fn a_destination_is_a_name_and_never_a_flag() {
        assert!(check_name("ada@lab", "target").is_ok());
        assert!(check_name("lab.example.com:2222", "host").is_ok());
        assert!(check_name("-oProxyCommand=evil", "host").is_err());
        assert!(check_name("ada@-lab", "target").is_err());
        assert!(check_name("lab;rm", "host").is_err());
        assert!(check_name("a b", "host").is_err());
        assert!(check_name("", "host").is_err());
        assert!(check_name("a@b@c", "target").is_err());
    }

    #[test]
    fn a_port_rides_on_the_target() {
        assert_eq!(target_args("ada@lab"), ["ada@lab"]);
        assert_eq!(target_args("ada@lab:2222"), ["-p", "2222", "ada@lab"]);
        assert_eq!(split_port("lab:abc"), ("lab:abc", None));
    }

    #[test]
    fn pairing_keeps_every_address_and_puts_the_one_that_answered_first() {
        let files = Files::new(&std::env::temp_dir().join("workbench-ssh-addresses"));
        let _ = std::fs::remove_dir_all(&files.dir);
        let saved = files
            .pair(&token("lab.example", 22, "ssh-ed25519 AAAA"))
            .unwrap();
        assert_eq!(saved.addresses(), ["lab.example", "10.0.0.5"]);
        files.remember_address(&saved.target(), "10.0.0.5").unwrap();
        let again = files.saved_target(&saved.target()).unwrap();
        assert_eq!(again.addresses(), ["10.0.0.5", "lab.example"]);
        let options = files.options(&saved.target());
        assert!(options.contains(&"HostName=10.0.0.5".to_string()));
    }

    #[test]
    fn pairing_keeps_the_key_the_host_key_and_the_machine_under_its_name() {
        let home = std::env::temp_dir().join("workbench-ssh-pair");
        std::fs::remove_dir_all(&home).ok();
        std::fs::create_dir_all(&home).unwrap();
        let files = Files::new(&home);
        assert!(files.options("ada@lab").is_empty());

        let saved = files
            .pair(&token("10.0.0.5", 22, "ssh-ed25519 AAAAC3"))
            .unwrap();
        assert_eq!(saved.target(), "ada@lab");
        assert!(files.is_saved("ada@lab"));
        let key = files.key_for("ada@lab");
        assert!(std::fs::read_to_string(&key)
            .unwrap()
            .contains("OPENSSH PRIVATE KEY"));
        assert_eq!(
            std::fs::read_to_string(files.known_hosts()).unwrap(),
            "lab ssh-ed25519 AAAAC3\n"
        );
        let options = files.options("ada@lab");
        assert!(options.windows(2).any(|w| w == ["-o", "HostName=10.0.0.5"]));
        assert!(options.windows(2).any(|w| w == ["-p", "22"]));
        assert!(options.windows(2).any(|w| w == ["-o", "HostKeyAlias=lab"]));
        assert!(options
            .windows(2)
            .any(|w| w[0] == "-i" && w[1] == key.to_string_lossy()));

        // The same machine at a new address: the name and the paths stay,
        // the address follows, and there is still one entry and one line.
        let moved = files
            .pair(&token("10.0.0.9", 2222, "ssh-ed25519 AAAAC3"))
            .unwrap();
        assert_eq!(moved.target(), "ada@lab");
        assert_eq!(files.saved().len(), 1);
        assert_eq!(
            std::fs::read_to_string(files.known_hosts())
                .unwrap()
                .lines()
                .count(),
            1
        );
        let options = files.options("ada@lab");
        assert!(options.windows(2).any(|w| w == ["-o", "HostName=10.0.0.9"]));
        assert!(options.windows(2).any(|w| w == ["-p", "2222"]));

        // Another machine with the same name gets a name of its own.
        let other = files
            .pair(&token("10.0.0.7", 22, "ssh-ed25519 OTHER"))
            .unwrap();
        assert_eq!(other.target(), "ada@lab-2");
        assert_eq!(files.saved().len(), 2);
        assert!(std::fs::read_to_string(files.known_hosts())
            .unwrap()
            .contains("lab-2 ssh-ed25519 OTHER"));

        files.forget("ada@lab").unwrap();
        assert!(!files.is_saved("ada@lab"));
        assert!(!key.exists());
    }

    #[test]
    fn a_token_naming_a_flag_is_refused() {
        let home = std::env::temp_dir().join("workbench-ssh-pair-bad");
        std::fs::create_dir_all(&home).unwrap();
        let bad = Pairing {
            name: "lab".into(),
            host: "-oProxyCommand=x".into(),
            hosts: Vec::new(),
            port: 22,
            user: "ada".into(),
            key: "k".into(),
            host_key: "ssh-ed25519 A".into(),
        }
        .encode();
        assert!(Files::new(&home).pair(&bad).is_err());
        assert!(Files::new(&home).pair("nonsense").is_err());
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
            explain(b"Warning: Permanently added 'lab' (ED25519) to the list of known hosts.\r\nada@lab: Permission denied (publickey).\r\n"),
            "ada@lab: Permission denied (publickey)."
        );
        assert_eq!(explain(b""), "ssh failed");
    }
}
