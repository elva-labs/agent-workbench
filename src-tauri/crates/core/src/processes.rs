//! What runs under a session: the processes the agent, or a shell, has
//! started, listed for the changes pane and stopped from there.
//!
//! The pty's child is the root; everything descended from it is what the
//! user is shown, the root itself left out since the row it belongs to
//! already stands for it. One system view is kept, since a process's CPU
//! share is the change between two readings.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub pid: u32,
    pub parent: u32,
    /// The program's name, as the OS has it.
    pub name: String,
    /// The command line, arguments included, cut to what a row can show.
    pub command: String,
    /// Share of one CPU, in percent, since the reading before.
    pub cpu: f32,
    /// Resident memory, in bytes.
    pub memory: u64,
    /// When it started, in seconds since the epoch.
    pub started: u64,
}

/// How much of a command line is kept.
const COMMAND_CAP: usize = 160;

pub struct Processes {
    system: Mutex<System>,
}

impl Default for Processes {
    fn default() -> Self {
        Self {
            system: Mutex::new(System::new()),
        }
    }
}

impl Processes {
    fn refresh(system: &mut System) {
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .with_cmd(UpdateKind::OnlyIfNotSet),
        );
    }

    /// Every process running under `root`, parents before children, the
    /// root itself left out.
    pub fn under(&self, root: u32) -> Vec<Process> {
        let mut system = self.system.lock().expect("processes lock");
        Self::refresh(&mut system);
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for (pid, process) in system.processes() {
            if let Some(parent) = process.parent() {
                children
                    .entry(parent.as_u32())
                    .or_default()
                    .push(pid.as_u32());
            }
        }
        for list in children.values_mut() {
            list.sort_unstable();
        }
        let mut out = Vec::new();
        let mut queue = std::collections::VecDeque::from([root]);
        while let Some(parent) = queue.pop_front() {
            let Some(kids) = children.get(&parent) else {
                continue;
            };
            for &pid in kids {
                if let Some(process) = system.process(Pid::from_u32(pid)) {
                    let command: String = process
                        .cmd()
                        .iter()
                        .map(|part| part.to_string_lossy())
                        .collect::<Vec<_>>()
                        .join(" ");
                    out.push(Process {
                        pid,
                        parent,
                        name: process.name().to_string_lossy().to_string(),
                        command: command.chars().take(COMMAND_CAP).collect(),
                        cpu: process.cpu_usage(),
                        memory: process.memory(),
                        started: process.start_time(),
                    });
                }
                queue.push_back(pid);
            }
        }
        out
    }

    /// Stops a process, provided it runs under `root`: nothing outside a
    /// session's own tree can be reached from here.
    pub fn stop(&self, root: u32, pid: u32) -> Result<(), String> {
        if !self.under(root).iter().any(|process| process.pid == pid) {
            return Err(format!("{pid} is not running under this session"));
        }
        let system = self.system.lock().expect("processes lock");
        let process = system
            .process(Pid::from_u32(pid))
            .ok_or_else(|| format!("{pid} is gone"))?;
        if process.kill() {
            Ok(())
        } else {
            Err(format!("could not stop {pid}"))
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn lists_what_runs_under_a_process_and_stops_it() {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let processes = Processes::default();
        let me = std::process::id();
        let under = processes.under(me);
        let shell = under
            .iter()
            .find(|process| process.pid == child.id())
            .expect("the shell is under the test");
        assert_eq!(shell.parent, me);
        assert!(shell.command.contains("sleep 30"), "{:?}", shell.command);
        // The shell's own child, the sleep, comes after its parent.
        let sleep = under
            .iter()
            .find(|process| process.parent == child.id())
            .expect("the sleep is under the shell");
        assert!(sleep.name.contains("sleep"), "{:?}", sleep.name);
        assert!(
            under.iter().position(|p| p.pid == shell.pid)
                < under.iter().position(|p| p.pid == sleep.pid)
        );

        // Not under this tree: refused, whatever it is.
        assert!(processes.stop(me, 1).is_err());
        processes.stop(me, sleep.pid).unwrap();
        let _ = child.wait();
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!processes
            .under(me)
            .iter()
            .any(|process| process.pid == sleep.pid));
    }
}
