//! Pairing a machine with a desktop by one token.
//!
//! `agent-workbench-remote connect`, run on the machine, makes a key pair,
//! authorises the public half for the daemon and nothing else, and prints
//! a token holding the private half, the machine's address, the user and
//! the machine's own host key. Pasted into the desktop, that is everything
//! the desktop needs to reach the machine: no password, no host to type,
//! and nothing the key can do there but run the daemon.

use std::path::{Path, PathBuf};
use std::process::Command;

use base64::Engine;
use serde::{Deserialize, Serialize};

/// What the token carries.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    /// The machine's own name, which is what paths on the desktop carry.
    /// Its address may change; the name and the host key stay.
    pub name: String,
    /// Where the desktop reaches it: an address or a name it can resolve.
    pub host: String,
    pub port: u16,
    pub user: String,
    /// The private key, in OpenSSH's own format, for the desktop to keep.
    pub key: String,
    /// The machine's host key line, so the desktop can check it is talking
    /// to the machine that made the token.
    pub host_key: String,
}

const PREFIX: &str = "awb1.";

impl Pairing {
    /// The token: a prefix that says what it is, then the pairing as JSON in
    /// URL-safe base64, one line, safe to copy from a terminal.
    pub fn encode(&self) -> String {
        let json = serde_json::to_vec(self).expect("a pairing serializes");
        format!(
            "{PREFIX}{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
        )
    }

    pub fn decode(token: &str) -> Result<Self, String> {
        let body = token
            .trim()
            .strip_prefix(PREFIX)
            .ok_or("that is not a token from agent-workbench-remote connect")?;
        let json = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(body.trim())
            .map_err(|_| "the token is not whole; copy all of it")?;
        let pairing: Pairing =
            serde_json::from_slice(&json).map_err(|_| "the token is not whole; copy all of it")?;
        if pairing.name.is_empty()
            || pairing.host.is_empty()
            || pairing.user.is_empty()
            || pairing.key.is_empty()
            || pairing.host_key.is_empty()
        {
            return Err("the token is missing something".into());
        }
        Ok(pairing)
    }
}

/// The line for the machine's authorized_keys: the key may run the daemon,
/// and nothing else, with no forwarding and no terminal.
pub fn authorized_line(daemon: &Path, public_key: &str) -> String {
    format!(
        "command=\"{} serve\",restrict {} agent-workbench",
        daemon.display(),
        public_key.trim()
    )
}

/// The machine's host key, from where sshd keeps the public half. The
/// first kind found, in the order the desktop's ssh prefers them.
pub fn host_key(etc: &Path) -> Option<String> {
    ["ed25519", "ecdsa", "rsa"].iter().find_map(|kind| {
        let text = std::fs::read_to_string(etc.join(format!("ssh_host_{kind}_key.pub"))).ok()?;
        let mut parts = text.split_whitespace();
        let kind = parts.next()?;
        let key = parts.next()?;
        Some(format!("{kind} {key}"))
    })
}

/// Makes and authorises a key for the daemon at `daemon`, and gives back
/// the token to paste. `host` is how the desktop reaches this machine; the
/// machine's own name when not said.
pub fn connect(
    home: &Path,
    daemon: &Path,
    host: Option<String>,
    port: u16,
) -> Result<String, String> {
    let ssh_dir = home.join(".ssh");
    std::fs::create_dir_all(&ssh_dir)
        .map_err(|e| format!("could not make {}: {e}", ssh_dir.display()))?;
    restrict(&ssh_dir, 0o700);

    let scratch = std::env::temp_dir().join(format!("agent-workbench-pair-{}", std::process::id()));
    std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    let key_path = scratch.join("key");
    let output = Command::new("ssh-keygen")
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
        .arg(&key_path)
        .output()
        .map_err(|e| format!("could not run ssh-keygen: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ssh-keygen failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let private = std::fs::read_to_string(&key_path).map_err(|e| e.to_string())?;
    let public = std::fs::read_to_string(scratch.join("key.pub")).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&scratch);

    let authorized = ssh_dir.join("authorized_keys");
    let mut text = std::fs::read_to_string(&authorized).unwrap_or_default();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&authorized_line(daemon, &public));
    text.push('\n');
    std::fs::write(&authorized, text)
        .map_err(|e| format!("could not write {}: {e}", authorized.display()))?;
    restrict(&authorized, 0o600);

    let name = hostname();
    let pairing = Pairing {
        host: host.unwrap_or_else(|| name.clone()),
        name,
        port,
        user: std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .map_err(|_| "could not tell which user this is")?,
        key: private,
        host_key: host_key(Path::new("/etc/ssh"))
            .ok_or("could not read this machine's host key under /etc/ssh")?,
    };
    Ok(pairing.encode())
}

fn hostname() -> String {
    Command::new("hostname")
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "localhost".to_string())
}

#[cfg(unix)]
fn restrict(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn restrict(_path: &Path, _mode: u32) {}

/// Where the daemon this process is lives, for the authorised command.
pub fn own_path() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("agent-workbench-remote"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairing() -> Pairing {
        Pairing {
            name: "lab".into(),
            host: "lab.example".into(),
            port: 22,
            user: "ada".into(),
            key: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n"
                .into(),
            host_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample".into(),
        }
    }

    #[test]
    fn a_token_round_trips_and_says_what_it_is() {
        let token = pairing().encode();
        assert!(token.starts_with("awb1."));
        assert!(!token.contains('\n'));
        assert_eq!(Pairing::decode(&token).unwrap(), pairing());
        assert_eq!(Pairing::decode(&format!("  {token}\n")).unwrap(), pairing());
    }

    #[test]
    fn anything_else_is_refused_with_a_reason() {
        assert!(Pairing::decode("hello")
            .unwrap_err()
            .contains("not a token"));
        assert!(Pairing::decode("awb1.@@@")
            .unwrap_err()
            .contains("not whole"));
        let short = pairing().encode();
        assert!(Pairing::decode(&short[..short.len() - 20])
            .unwrap_err()
            .contains("not whole"));
        let empty = Pairing {
            host: String::new(),
            ..pairing()
        }
        .encode();
        assert!(Pairing::decode(&empty).unwrap_err().contains("missing"));
    }

    #[test]
    fn the_key_may_run_the_daemon_and_nothing_else() {
        let line = authorized_line(
            Path::new("/home/ada/.agent-workbench/bin/agent-workbench-remote"),
            "ssh-ed25519 AAAA agent-workbench\n",
        );
        assert_eq!(line, "command=\"/home/ada/.agent-workbench/bin/agent-workbench-remote serve\",restrict ssh-ed25519 AAAA agent-workbench agent-workbench");
    }

    #[test]
    fn reads_the_host_key_sshd_keeps_preferring_ed25519() {
        let etc = std::env::temp_dir().join("workbench-pair-etc");
        std::fs::remove_dir_all(&etc).ok();
        std::fs::create_dir_all(&etc).unwrap();
        assert_eq!(host_key(&etc), None);
        std::fs::write(
            etc.join("ssh_host_rsa_key.pub"),
            "ssh-rsa AAAAB3 root@lab\n",
        )
        .unwrap();
        assert_eq!(host_key(&etc).as_deref(), Some("ssh-rsa AAAAB3"));
        std::fs::write(
            etc.join("ssh_host_ed25519_key.pub"),
            "ssh-ed25519 AAAAC3 root@lab\n",
        )
        .unwrap();
        assert_eq!(host_key(&etc).as_deref(), Some("ssh-ed25519 AAAAC3"));
    }

    #[cfg(unix)]
    #[test]
    fn connect_authorises_a_fresh_key_for_the_daemon_and_hands_it_over_in_the_token() {
        let home = std::env::temp_dir().join("workbench-pair-home");
        std::fs::remove_dir_all(&home).ok();
        std::fs::create_dir_all(&home).unwrap();
        let etc = std::env::temp_dir().join("workbench-pair-etc2");
        std::fs::create_dir_all(&etc).unwrap();
        std::fs::write(
            etc.join("ssh_host_ed25519_key.pub"),
            "ssh-ed25519 AAAAC3 root@lab\n",
        )
        .unwrap();
        // The host key comes from /etc/ssh on a real machine; here the test
        // asks for the token's parts through the pieces connect is made of.
        let daemon = Path::new("/opt/agent-workbench-remote");
        let token = match connect(&home, daemon, Some("lab.example".into()), 22) {
            Ok(token) => token,
            Err(error) if error.contains("/etc/ssh") => {
                // No sshd on this machine: the key was still made and authorised.
                let authorized =
                    std::fs::read_to_string(home.join(".ssh/authorized_keys")).unwrap();
                assert!(authorized.contains(
                    "command=\"/opt/agent-workbench-remote serve\",restrict ssh-ed25519 "
                ));
                return;
            }
            Err(error) => panic!("{error}"),
        };
        let pairing = Pairing::decode(&token).unwrap();
        assert_eq!(pairing.host, "lab.example");
        assert!(!pairing.name.is_empty());
        assert!(pairing.key.contains("OPENSSH PRIVATE KEY"));
        let authorized = std::fs::read_to_string(home.join(".ssh/authorized_keys")).unwrap();
        assert!(authorized
            .contains("command=\"/opt/agent-workbench-remote serve\",restrict ssh-ed25519 "));
        assert_eq!(authorized.matches("agent-workbench\n").count(), 1);
    }
}
