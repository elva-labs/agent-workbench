//! Agent Workbench on another machine.
//!
//! `agent-workbench-remote serve` is the core with no window, spoken to over
//! stdin and stdout: one JSON object a line, requests in, answers and events
//! out. The desktop app starts it over SSH and drives it exactly as it
//! drives its own core; nothing on this side knows it is remote. Each
//! request gets a thread, so a slow `git status` never holds up a keystroke
//! bound for a pty. It ends when stdin does.

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use workbench_core::protocol::{dispatch, Message, Request};
use workbench_core::{Core, Output, Sink};

/// Everything going out shares one writer and goes out whole: a line at a
/// time, under a lock, flushed, so two threads never interleave.
struct Stdout(Mutex<std::io::Stdout>);

impl Stdout {
    fn send(&self, message: &Message) {
        let Ok(line) = serde_json::to_string(message) else {
            return;
        };
        let mut out = self.0.lock().expect("stdout lock");
        // A failed write means the other end is gone; the reader will see
        // EOF next and the process ends there.
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
}

/// The core's events, out on the same writer.
struct Events(Arc<Stdout>);

impl Sink for Events {
    fn emit(&self, event: &str, payload: Value) {
        self.0.send(&Message::event(event, payload));
    }
}

fn serve() {
    let out = Arc::new(Stdout(Mutex::new(std::io::stdout())));
    let core = Arc::new(Core::new(Arc::new(Events(Arc::clone(&out)))));
    if let Err(error) = core.start() {
        eprintln!("session log: {error}");
    }

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                eprintln!("not a request: {error}");
                continue;
            }
        };
        let core = Arc::clone(&core);
        let out = Arc::clone(&out);
        std::thread::spawn(move || {
            let for_output = Arc::clone(&out);
            let make_output = move |id: &str| -> Output {
                let id = id.to_string();
                Box::new(move |bytes: &[u8]| {
                    for_output.send(&Message::output(&id, bytes));
                    true
                })
            };
            let answer = match dispatch(&core, &request.method, request.params, make_output) {
                Ok(result) => Message::ok(request.id, result),
                Err(error) => Message::err(request.id, error),
            };
            out.send(&answer);
        });
    }
}

/// `connect [--host <address>] [--port <n>]`: pairs this machine with a
/// desktop by printing a token to paste there.
fn connect(args: impl Iterator<Item = String>) {
    let mut host = None;
    let mut port = 22u16;
    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--host" => host = args.next(),
            "--port" => {
                port = match args.next().and_then(|p| p.parse().ok()) {
                    Some(port) => port,
                    None => {
                        eprintln!("--port takes a number");
                        std::process::exit(2);
                    }
                }
            }
            other => {
                eprintln!("connect does not take {other}");
                std::process::exit(2);
            }
        }
    }
    let Some(home) = workbench_core::api::home_directory() else {
        eprintln!("no home directory");
        std::process::exit(1);
    };
    match workbench_core::pair::connect(&home, &workbench_core::pair::own_path(), host, port) {
        Ok(token) => {
            let addresses = workbench_core::pair::Pairing::decode(&token)
                .map(|pairing| pairing.addresses().join(", "))
                .unwrap_or_default();
            println!("Paste this into Agent Workbench, under Remote:");
            println!();
            println!("{token}");
            println!();
            println!("It reaches this machine at {addresses}, trying each in turn, on port {port}. It holds a key that can run this daemon here and nothing else. To take it back, remove the agent-workbench line from ~/.ssh/authorized_keys.");
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("serve") => serve(),
        Some("connect") => connect(args),
        Some("--version" | "version") => println!("{}", env!("CARGO_PKG_VERSION")),
        _ => {
            eprintln!("usage: agent-workbench-remote serve | connect [--host <address>] [--port <n>] | version");
            std::process::exit(2);
        }
    }
}
