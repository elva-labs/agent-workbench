//! The usage limits of each account on this machine, read with no session
//! running and kept between runs.
//!
//! An integrated session asks its agent for the account's limits as it
//! goes. An account whose sessions run in terminals, or whose integrated
//! session sits between turns, has nobody asking, so its figures are read
//! here: the agent's own binary is started for the one question, in a
//! folder of the workbench's own that only the user can write and under the
//! account's directory, asked for the limits with no turn, and ended.
//! Claude Code is asked through its stream's usage control request and
//! Codex through its app-server's rate limits request. Neither question
//! reaches a model.
//!
//! A read is asked for by the window, for an account it has a session of,
//! and is made only when it is due: when the newest full read of the
//! account's limits, whoever made it, is five minutes old where the window
//! saw a session of the account work since, or half an hour old where it
//! did not, and when no read of the account is under way already. A read
//! that fails holds back the
//! next for a minute, then for twice as long each time it fails again, up
//! to an hour. One read runs at a time on the machine, so a window that
//! asks for many accounts at once starts their processes one after
//! another.
//!
//! What an integrated session's agent reports reaches the same figures on
//! the way to the window, so the figures of an account a session reads as
//! it goes are fresh and none is read for it here while the session's
//! reports keep coming. The figures of the last full read of each account
//! are kept in a file of the workbench's own on the machine, so a restart
//! shows them, with their age, until new ones come.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::adapter::{prepare_process, process, CLAUDE_CONFIG_VAR};
use crate::claude_stream::usage_limits;
use crate::codex_app_server::{limit_windows, merge};
use crate::codex_history::{Answer, AppServer, Ask};
use crate::env::find_on_path;
use crate::events::Sink;
use crate::integrated::{
    kept_windows, now_seconds, Event, LimitWindow, INTEGRATED_EVENT, LIMITS_AGE,
};
use crate::short_lived::{Gone, Line, ShortLived};

/// How long a whole read may take, from the start of the agent's process
/// to its answer.
pub const READ_WAIT: Duration = Duration::from_secs(20);
/// How long the figures of a full read stand, in seconds, before a read of
/// the account is due again where a session of it worked since: as long as
/// an integrated session's own.
const FRESH_FOR: u64 = LIMITS_AGE.as_secs();
/// How long they stand where none did, so that only the account's use
/// elsewhere can have moved them.
const QUIET_FOR: u64 = 30 * 60;
/// How long the first failed read holds back the next, in seconds, and the
/// longest any does.
const RETRY_FIRST: u64 = 60;
const RETRY_MOST: u64 = 60 * 60;
/// The most accounts the file keeps, the most recently read first.
const KEEP_ACCOUNTS: usize = 32;
/// The file, in the workbench's own directory in the home.
const LIMITS_FILE: &str = "limits.json";
/// The folder the agents are started in, beside the file.
const READ_FOLDER: &str = "limits";

/// What makes `claude` a stream that answers control requests. No
/// conversation is kept of it, and it starts none of the servers the
/// user's configuration names. Safe mode leaves the user's hooks, plugins
/// and instructions unloaded, and only the user's own settings are read,
/// never a project's or a folder's, whose helpers would run. Both are
/// flags, so a version without them refuses to start rather than start
/// with everything loaded.
const CLAUDE_ARGS: &[&str] = &[
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--safe-mode",
    "--setting-sources",
    "user",
];
/// Safe mode as Claude Code's environment has it, set to agree with the
/// flag whatever the shell set it to.
const CLAUDE_SAFE_MODE_VAR: &str = "CLAUDE_CODE_SAFE_MODE";

/// The account's limits, read by the agent's binary on the PATH of `env`
/// under the account's directory where one is given, or the agent's own,
/// started in `folder`. An error for an agent whose limits are not read,
/// one that cannot be started, and one that answers with no limits or none
/// in time.
pub fn read(
    agent: &str,
    env: &HashMap<String, String>,
    config_dir: Option<&Path>,
    folder: &Path,
    wait: Duration,
) -> Result<Event, String> {
    let deadline = Instant::now() + wait;
    match agent {
        crate::claude_stream::AGENT => {
            let mut control = ClaudeControl::start(env, config_dir, folder, deadline)?;
            claude_limits(&mut control)
        }
        crate::codex_app_server::AGENT => {
            let mut server = AppServer::start(env, config_dir, folder, deadline)?;
            server.introduce()?;
            codex_limits(&mut server)
        }
        _ => Err(format!("no limits are read for {agent}")),
    }
}

/// Claude Code's limits, from its answer to a usage control request. The
/// behaviours a full answer adds come from a scan of the past week's
/// transcripts, which the limits do not need.
pub(crate) fn claude_limits(control: &mut dyn Ask) -> Result<Event, String> {
    match control.ask("get_usage", json!({ "skip_behaviors": true })) {
        Answer::Result(body) => {
            let (plan, windows) =
                usage_limits(&body).ok_or("Claude Code answered with no limits")?;
            Ok(taken_now(crate::claude_stream::AGENT, plan, windows))
        }
        Answer::Refused(error) | Answer::Gone(error) => Err(error),
        Answer::TooLong => Err("Claude Code's answer was too long to read".into()),
    }
}

/// Codex's limits, from its answer to a rate limits request. The details
/// of the credits that reset a limit are a read of their own, which the
/// limits do not need.
pub(crate) fn codex_limits(server: &mut dyn Ask) -> Result<Event, String> {
    match server.ask(
        "account/rateLimits/read",
        json!({ "excludeResetCreditDetails": true }),
    ) {
        Answer::Result(result) if result["rateLimits"].is_object() => {
            let mut limits = json!({});
            merge(&mut limits, &result["rateLimits"]);
            let (plan, windows) = limit_windows(&limits);
            Ok(taken_now(crate::codex_app_server::AGENT, plan, windows))
        }
        Answer::Result(_) => Err("Codex answered with no limits".into()),
        Answer::Refused(error) | Answer::Gone(error) => Err(error),
        Answer::TooLong => Err("Codex's answer was too long to read".into()),
    }
}

/// The figures of a full read taken now.
fn taken_now(agent: &str, plan: Option<String>, windows: Vec<LimitWindow>) -> Event {
    let now = now_seconds();
    Event::Limits {
        agent: agent.to_string(),
        plan,
        windows,
        read_at: Some(now),
        taken_at: now,
    }
}

/// Claude Code's stream, started to answer control requests and nothing
/// else.
struct ClaudeControl {
    process: ShortLived,
    next: u64,
}

impl ClaudeControl {
    fn start(
        env: &HashMap<String, String>,
        config_dir: Option<&Path>,
        folder: &Path,
        deadline: Instant,
    ) -> Result<Self, String> {
        let binary =
            find_on_path(env, "claude").ok_or_else(|| "claude is not on your PATH".to_string())?;
        let mut command = process(&binary, env);
        command.args(CLAUDE_ARGS);
        prepare_process(&mut command, folder, env);
        command.env(CLAUDE_SAFE_MODE_VAR, "1");
        if let Some(dir) = config_dir {
            command.env(CLAUDE_CONFIG_VAR, dir);
        }
        // Claude Code's lines do not begin with the request they answer.
        let process = ShortLived::start(command, deadline, |_| None)
            .map_err(|e| format!("claude could not be started: {e}"))?;
        Ok(Self { process, next: 0 })
    }
}

impl Ask for ClaudeControl {
    /// A control request of the kind `subtype` names, with `params` beside
    /// it, and the body of its answer. Whatever else Claude Code says in the
    /// meantime is passed over.
    fn ask(&mut self, subtype: &str, params: Value) -> Answer {
        self.next += 1;
        let id = format!("limits-{}", self.next);
        let mut request = if params.is_object() {
            params
        } else {
            json!({})
        };
        request["subtype"] = json!(subtype);
        let line = json!({ "type": "control_request", "request_id": id, "request": request });
        if let Err(error) = self.process.write(&line.to_string()) {
            return Answer::Gone(format!("could not write to claude: {error}"));
        }
        loop {
            let text = match self.process.next() {
                Ok(Line::Whole(text)) => text,
                Ok(Line::Long(_)) => continue,
                Err(Gone::Late) => {
                    return Answer::Gone("Claude Code did not answer in time".into())
                }
                Err(Gone::Ended) => {
                    return Answer::Gone("Claude Code ended before it answered".into())
                }
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let response = &value["response"];
            if value["type"] != "control_response" || response["request_id"] != id.as_str() {
                continue;
            }
            return if response["subtype"] == "success" {
                Answer::Result(response["response"].clone())
            } else {
                Answer::Refused(
                    response["error"]
                        .as_str()
                        .unwrap_or("Claude Code refused")
                        .to_string(),
                )
            };
        }
    }
}

// ---- the figures of each account ----

/// What is known of one account's limits: the agent's, in the directory
/// the agent keeps the account in.
type Key = (String, PathBuf);

/// The figures of one account: the plan, the windows, when the last full
/// read was taken and when a figure last moved, as a limits event has them.
#[derive(Debug, Clone, PartialEq)]
struct Figures {
    plan: Option<String>,
    windows: Vec<LimitWindow>,
    read_at: Option<u64>,
    taken_at: u64,
}

impl Figures {
    /// The figures of a limits event as JSON gives them, from the file or on
    /// the way to the window. A window of a shape not known here is left
    /// out; figures with no time they were taken are none.
    fn of(value: &Value) -> Option<Self> {
        let windows = value["windows"]
            .as_array()?
            .iter()
            .filter_map(|window| serde_json::from_value::<LimitWindow>(window.clone()).ok());
        Some(Self {
            plan: value["plan"].as_str().map(str::to_string),
            windows: kept_windows(windows),
            read_at: value["readAt"].as_u64(),
            taken_at: value["takenAt"].as_u64()?,
        })
    }

    fn of_event(event: &Event) -> Option<Self> {
        match event {
            Event::Limits {
                plan,
                windows,
                read_at,
                taken_at,
                ..
            } => Some(Self {
                plan: plan.clone(),
                windows: windows.clone(),
                read_at: *read_at,
                taken_at: *taken_at,
            }),
            _ => None,
        }
    }

    fn event(&self, agent: &str) -> Event {
        Event::Limits {
            agent: agent.to_string(),
            plan: self.plan.clone(),
            windows: self.windows.clone(),
            read_at: self.read_at,
            taken_at: self.taken_at,
        }
    }

    /// Whether these figures stand over `other`: a figure of theirs moved
    /// later, or at the same second after a later read.
    fn over(&self, other: &Self) -> bool {
        self.taken_at > other.taken_at
            || (self.taken_at == other.taken_at && self.read_at > other.read_at)
    }
}

/// What is known of one account.
#[derive(Debug, Default)]
struct Account {
    /// The figures shown: those whose figures moved last.
    figures: Option<Figures>,
    /// When the newest full read of the account was taken, whichever
    /// figures it came with, in seconds since the epoch.
    last_read: Option<u64>,
    /// A read of the account is under way, or waits for its turn.
    reading: bool,
    /// How many reads have failed since the last that did not, and when
    /// the last of them ended, in seconds since the epoch.
    failures: u32,
    failed_at: u64,
}

impl Account {
    /// Whether a read is due at `now`: the newest full read is `fresh_for`
    /// seconds old, or there is none, and no failed read holds the next
    /// back. A read under way is not considered.
    fn due(&self, now: u64, fresh_for: u64) -> bool {
        if self.failures > 0 && now < self.failed_at.saturating_add(retry_after(self.failures)) {
            return false;
        }
        self.last_read
            .is_none_or(|read_at| now.saturating_sub(read_at) >= fresh_for)
    }

    /// Takes figures over those held where they stand over them, and their
    /// read where it is newer than any before. Says whether it was, which
    /// is when the file is written.
    fn take(&mut self, figures: Figures) -> bool {
        let read_newer = figures.read_at > self.last_read;
        if read_newer {
            self.last_read = figures.read_at;
        }
        if self.figures.as_ref().is_none_or(|held| figures.over(held)) {
            self.figures = Some(figures);
        }
        read_newer
    }
}

/// How long `failures` failed reads in a row hold back the next, in
/// seconds: a minute after the first, twice as long after each since, and
/// never more than an hour.
fn retry_after(failures: u32) -> u64 {
    let doublings = failures.saturating_sub(1).min(16);
    RETRY_FIRST.saturating_mul(1 << doublings).min(RETRY_MOST)
}

#[derive(Default)]
struct State {
    /// Whether the file was read.
    loaded: bool,
    accounts: HashMap<Key, Account>,
}

/// The time now in seconds since the epoch, from the system's clock or a
/// test's.
type Clock = Box<dyn Fn() -> u64 + Send + Sync>;

/// The limits of every account on the machine, and the reads of them.
pub struct Limits {
    state: Mutex<State>,
    /// Held by the read under way, so one runs at a time on the machine.
    turn: Mutex<()>,
    /// Held while the file is written, so a later write is of later
    /// figures.
    writing: Mutex<()>,
    file: Option<PathBuf>,
    clock: Clock,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Limits {
    /// The limits kept in the workbench's directory in `home`, or kept
    /// nowhere without a home.
    pub fn new(home: Option<&Path>) -> Self {
        Self::with(
            home.map(|home| home.join(".agent-workbench").join(LIMITS_FILE)),
            Box::new(now_seconds),
        )
    }

    fn with(file: Option<PathBuf>, clock: Clock) -> Self {
        Self {
            state: Mutex::default(),
            turn: Mutex::default(),
            writing: Mutex::default(),
            file,
            clock,
        }
    }

    /// The state, with the file read into it the first time.
    fn state(&self) -> MutexGuard<'_, State> {
        let mut state = lock(&self.state);
        if !state.loaded {
            state.loaded = true;
            if let Some(file) = &self.file {
                load(file, &mut state);
            }
        }
        state
    }

    /// The folder the agents are started in to read, beside the file: the
    /// workbench's own, made where it is not there, and kept to the user
    /// alone, so no settings of anyone else's are found in it. An error
    /// with nowhere to keep it.
    pub fn folder(&self) -> Result<PathBuf, String> {
        let folder = self
            .file
            .as_deref()
            .and_then(Path::parent)
            .ok_or("there is no folder to read in")?
            .join(READ_FOLDER);
        own_folder(&folder).map_err(|e| format!("{} could not be made: {e}", folder.display()))?;
        Ok(folder)
    }

    /// The figures held for the agent's account in `dir`, without reading.
    pub fn held(&self, agent: &str, dir: &Path) -> Option<Event> {
        let state = self.state();
        let figures = state.accounts.get(&key(agent, dir))?.figures.as_ref()?;
        Some(figures.event(agent))
    }

    /// Reads the account's limits with `read` where a read is due, and
    /// answers with the figures then held. `worked` says a session of the
    /// account worked since the figures were read, which makes them due
    /// sooner. A read of the account under way is not doubled: the figures
    /// held are the answer, and the read under way brings its own. A read
    /// waits for the one under way on the machine to end, and is not made
    /// where figures that landed in the meantime made it needless.
    pub fn poll(
        &self,
        agent: &str,
        dir: &Path,
        worked: bool,
        read: impl FnOnce() -> Result<Event, String>,
    ) -> Option<Event> {
        let key = key(agent, dir);
        let fresh_for = if worked { FRESH_FOR } else { QUIET_FOR };
        {
            let mut state = self.state();
            let now = (self.clock)();
            let account = state.accounts.entry(key.clone()).or_default();
            if account.reading || !account.due(now, fresh_for) {
                return account.figures.as_ref().map(|figures| figures.event(agent));
            }
            account.reading = true;
        }
        let read = {
            let _turn = lock(&self.turn);
            let due = {
                let state = self.state();
                let now = (self.clock)();
                state
                    .accounts
                    .get(&key)
                    .is_none_or(|account| account.due(now, fresh_for))
            };
            // A read that panics fails like any other, so the account is
            // not left marked as being read.
            due.then(|| {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(read))
                    .unwrap_or_else(|_| Err("the read of the limits panicked".into()))
            })
        };
        let saved = {
            let mut state = self.state();
            let now = (self.clock)();
            let account = state.accounts.entry(key.clone()).or_default();
            account.reading = false;
            match read.map(|read| read.map(|event| Figures::of_event(&event))) {
                Some(Ok(Some(figures))) => {
                    account.failures = 0;
                    account.take(figures)
                }
                Some(Ok(None) | Err(_)) => {
                    account.failures = account.failures.saturating_add(1);
                    account.failed_at = now;
                    false
                }
                None => false,
            }
        };
        if saved {
            self.save();
        }
        self.held(agent, dir)
    }

    /// Takes the figures of a limits event an integrated session of the
    /// agent's account in `dir` sent, as JSON. Figures that came from a
    /// newer full read are kept in the file.
    pub fn heard(&self, agent: &str, dir: &Path, event: &Value) {
        let Some(figures) = Figures::of(event) else {
            return;
        };
        let saved = self
            .state()
            .accounts
            .entry(key(agent, dir))
            .or_default()
            .take(figures);
        if saved {
            self.save();
        }
    }

    /// A sink for an integrated session of the agent's account in `dir`:
    /// every event goes on to `sink`, and the limits reach this account's
    /// figures on the way.
    pub fn tap(self: &Arc<Self>, sink: Arc<dyn Sink>, agent: &str, dir: PathBuf) -> Arc<dyn Sink> {
        Arc::new(Tap {
            sink,
            limits: Arc::clone(self),
            agent: agent.to_string(),
            dir,
        })
    }

    /// Writes the figures of every account's last full read to the file,
    /// whole, through a file beside it, so a reader finds the old figures
    /// or the new. A file that cannot be written is left as it was.
    fn save(&self) {
        let Some(file) = &self.file else {
            return;
        };
        let _writing = lock(&self.writing);
        let text = kept(&self.state()).to_string();
        let Some(folder) = file.parent() else {
            return;
        };
        let temporary = folder.join(format!(".{LIMITS_FILE}.{}", std::process::id()));
        let written = std::fs::create_dir_all(folder)
            .and_then(|()| std::fs::write(&temporary, text))
            .and_then(|()| std::fs::rename(&temporary, file));
        if written.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
    }
}

fn key(agent: &str, dir: &Path) -> Key {
    (agent.to_string(), dir.to_path_buf())
}

/// Makes `folder` where it is not there, and leaves it to the user alone.
#[cfg(unix)]
fn own_folder(folder: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    if let Some(parent) = folder.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::DirBuilder::new().mode(0o700).create(folder) {
        Err(error) if error.kind() != std::io::ErrorKind::AlreadyExists => return Err(error),
        _ => {}
    }
    std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o700))
}

/// Makes `folder` where it is not there. A folder in the user's profile is
/// the user's alone.
#[cfg(not(unix))]
fn own_folder(folder: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(folder)
}

/// The file's contents: every account with a full read, the most recently
/// read first, and no more than [`KEEP_ACCOUNTS`] of them.
fn kept(state: &State) -> Value {
    let mut accounts: Vec<(&Key, &Figures)> = state
        .accounts
        .iter()
        .filter_map(|(key, account)| Some((key, account.figures.as_ref()?)))
        .filter(|(_, figures)| figures.read_at.is_some())
        .collect();
    accounts.sort_by(|a, b| b.1.read_at.cmp(&a.1.read_at).then_with(|| a.0.cmp(b.0)));
    accounts.truncate(KEEP_ACCOUNTS);
    let accounts: Vec<Value> = accounts
        .into_iter()
        .map(|((agent, dir), figures)| {
            json!({
                "agent": agent,
                "dir": dir,
                "plan": figures.plan,
                "windows": figures.windows,
                "readAt": figures.read_at,
                "takenAt": figures.taken_at,
            })
        })
        .collect();
    json!({ "accounts": accounts })
}

/// Reads the file into `state`. A file that is not there or does not read
/// is none, and an account of a shape not known here is left out.
fn load(file: &Path, state: &mut State) {
    let Ok(text) = std::fs::read_to_string(file) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    for entry in value["accounts"].as_array().into_iter().flatten() {
        let (Some(agent), Some(dir)) = (entry["agent"].as_str(), entry["dir"].as_str()) else {
            continue;
        };
        let Some(figures) = Figures::of(entry) else {
            continue;
        };
        state
            .accounts
            .entry(key(agent, Path::new(dir)))
            .or_default()
            .take(figures);
    }
}

/// An integrated session's sink with the account's limits on the way.
struct Tap {
    sink: Arc<dyn Sink>,
    limits: Arc<Limits>,
    agent: String,
    dir: PathBuf,
}

impl Sink for Tap {
    fn emit(&self, event: &str, payload: Value) {
        if event == INTEGRATED_EVENT && payload["type"] == "limits" {
            self.limits.heard(&self.agent, &self.dir, &payload);
        }
        self.sink.emit(event, payload);
    }
}

#[cfg(test)]
#[path = "limits_tests.rs"]
mod tests;
