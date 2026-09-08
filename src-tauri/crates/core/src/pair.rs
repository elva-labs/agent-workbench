//! Pairing a machine with a desktop by one token.
//!
//! `agent-workbench-remote connect`, run on the machine, makes a key pair,
//! authorises the public half for the daemon and nothing else, and prints
//! a token holding the private half, the machine's address, the user and
//! the machine's own host key. Pasted into the desktop, that is everything
//! the desktop needs to reach the machine: no password, no host to type,
//! and nothing the key can do there but run the daemon.
//!
//! A machine has several addresses, and which one reaches it depends on
//! where the desktop is: its own network, a VPN both are on, or the open
//! internet. The token carries every address the machine can find for
//! itself, best first, and the desktop tries them in turn; the host key
//! says it is the same machine whichever answered.

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
    /// The first of `hosts`, kept on its own for a desktop that reads no
    /// further.
    pub host: String,
    /// Every address the machine found for itself, best first: a VPN's,
    /// its own network's, the internet's, its name.
    #[serde(default)]
    pub hosts: Vec<String>,
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

    /// The addresses to try, in order. A token from before addresses were
    /// several has the one.
    pub fn addresses(&self) -> Vec<String> {
        let mut all: Vec<String> = Vec::new();
        for host in std::iter::once(&self.host).chain(self.hosts.iter()) {
            if !host.is_empty() && !all.contains(host) {
                all.push(host.clone());
            }
        }
        all
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
    let hosts = candidates(host, &name);
    let pairing = Pairing {
        host: hosts[0].clone(),
        hosts,
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

/// Every way the machine might be reached, best first: an address given
/// outright, a VPN's address, the machine's own network's, the internet's,
/// and its name for whatever resolves it. Each is found from the machine's
/// own view; none is checked from anywhere else, which is the desktop's
/// part.
pub fn candidates(given: Option<String>, name: &str) -> Vec<String> {
    let mut all: Vec<String> = Vec::new();
    let mut add = |candidate: Option<String>| {
        if let Some(candidate) = candidate {
            let candidate = candidate.trim().to_string();
            if !candidate.is_empty() && !all.contains(&candidate) {
                all.push(candidate);
            }
        }
    };
    add(given);
    add(tailnet_address());
    let (lan, vpn) = interface_addresses();
    for address in vpn {
        add(Some(address));
    }
    for address in lan {
        add(Some(address));
    }
    add(public_address());
    add(Some(name.to_string()));
    all
}

/// Tailscale's address for this machine, when Tailscale is here and up.
fn tailnet_address() -> Option<String> {
    let output = Command::new("tailscale").args(["ip", "-4"]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

/// The machine's IPv4 addresses on its interfaces: the private ones, and
/// separately the ones in the range VPNs such as Tailscale hand out, which
/// reach further and go first.
fn interface_addresses() -> (Vec<String>, Vec<String>) {
    let mut lan = Vec::new();
    let mut vpn = Vec::new();
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return (lan, vpn);
    };
    for interface in interfaces {
        let std::net::IpAddr::V4(ip) = interface.ip() else {
            continue;
        };
        if interface.is_loopback() || ip.is_link_local() || ip.is_unspecified() {
            continue;
        }
        let octets = ip.octets();
        let carrier_grade = octets[0] == 100 && (64..128).contains(&octets[1]);
        if carrier_grade {
            vpn.push(ip.to_string());
        } else if ip.is_private() {
            lan.push(ip.to_string());
        } else {
            // A public address on an interface reaches the machine from
            // anywhere; it belongs with the network's own.
            lan.push(ip.to_string());
        }
    }
    (lan, vpn)
}

/// The address the internet sees this machine as, asked of a service that
/// says so, when curl is here and answers within a few seconds. Nothing
/// when it is not: a machine behind a router is not reached this way
/// unless the router forwards the port, and that is for the desktop to
/// find out.
fn public_address() -> Option<String> {
    let output = Command::new("curl")
        .args(["-fsS", "--max-time", "4", "https://api.ipify.org"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    text.parse::<std::net::Ipv4Addr>()
        .ok()
        .map(|ip| ip.to_string())
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
            hosts: vec!["lab.example".into(), "192.168.1.20".into()],
            key: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n"
                .into(),
            host_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample".into(),
        }
    }

    #[test]
    fn the_addresses_are_the_host_then_the_rest_once_each() {
        assert_eq!(pairing().addresses(), ["lab.example", "192.168.1.20"]);
        let mut old = pairing();
        old.hosts = Vec::new();
        assert_eq!(old.addresses(), ["lab.example"]);
    }

    // A token from before addresses were several still reads.
    #[test]
    fn a_token_without_the_list_still_reads() {
        let json = serde_json::json!({
            "name": "lab", "host": "lab.example", "port": 22, "user": "ada",
            "key": "k", "hostKey": "ssh-ed25519 AAAA"
        });
        let token = format!(
            "awb1.{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json.to_string())
        );
        let pairing = Pairing::decode(&token).unwrap();
        assert_eq!(pairing.addresses(), ["lab.example"]);
    }

    #[test]
    fn an_address_given_outright_goes_first_and_the_name_last() {
        let all = candidates(Some("lab.example".into()), "lab");
        assert_eq!(all.first().map(String::as_str), Some("lab.example"));
        assert_eq!(all.last().map(String::as_str), Some("lab"));
        let mut seen = std::collections::HashSet::new();
        assert!(all.iter().all(|address| seen.insert(address.clone())));
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
