//! Plugins: where they come from, what their manifest says, and the
//! processes that run them.
//!
//! A source is a git repository cloned under the app's directory, or a
//! directory on the machine for a plugin being written. Its manifest,
//! `workbench-plugins.toml`, names any number of plugins, each with the
//! command that runs it and a summary of what it declares. The core keeps
//! the list of sources and which plugins are on, runs one process per
//! plugin that is, and tells the window as each changes state.

use crate::events::Sink;
use crate::known::KnownSource;
use crate::show::{
    Answer, DiffRequest, NotifyRequest, PresentRequest, ShowRequest, ToolRequest, DIFF_REQUEST,
    NOTIFY_REQUEST, PRESENT_REQUEST, SHOW_REQUEST,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The event a plugin's state change is told by.
pub const PLUGIN_STATE: &str = "plugin_state";

/// The event a section's rows are told by, one section of one project at
/// a time.
pub const PLUGIN_SECTION: &str = "plugin_section";

/// The event an action's error is told by.
pub const PLUGIN_NOTICE: &str = "plugin_notice";

/// The event a plugin's page is told by, one project at a time.
pub const PLUGIN_VIEW: &str = "plugin_view";

/// The event a message for an open page is told by.
pub const PLUGIN_VIEW_DATA: &str = "plugin_view_data";

/// The event a plugin's mark on a session's row is told by.
pub const PLUGIN_MARK: &str = "plugin_mark";

/// The event a web address a plugin opens is told by.
pub const PLUGIN_OPEN_URL: &str = "plugin_open_url";

/// The event told when an enabled plugin comes to listen for commands, or
/// the last one stops, so the hooks are brought up to date at once.
pub const PLUGIN_HEARS: &str = "plugin_hears";

/// The manifest at a source's root.
pub const MANIFEST: &str = "workbench-plugins.toml";

/// A plugin as its manifest declares it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Declared {
    pub name: String,
    /// The plugin's directory, relative to the source.
    pub path: String,
    pub description: String,
    pub version: String,
    /// The program and its arguments, run in the plugin's directory.
    pub run: Vec<String>,
    /// The command that produces what `run` needs, run where `run` is.
    /// Empty for a plugin whose script is in its directory already.
    pub build: Vec<String>,
    pub tools: Vec<String>,
    pub sections: Vec<String>,
    /// "wide" or "full", when the plugin has a view.
    pub view: Option<String>,
    /// The beginnings of the shell commands the plugin is told a session
    /// ran, each as words separated by one space.
    #[serde(default)]
    pub commands: Vec<String>,
}

impl Declared {
    /// A plugin the app's own list names and no manifest has been read
    /// for yet: the name and the line the list carries, and nothing else
    /// until the source is fetched.
    fn listed(name: &str, description: &str) -> Self {
        Self {
            name: name.to_string(),
            path: String::new(),
            description: description.to_string(),
            version: String::new(),
            run: Vec::new(),
            build: Vec::new(),
            tools: Vec::new(),
            sections: Vec::new(),
            view: None,
            commands: Vec::new(),
        }
    }
}

/// Where a plugin process is, as the window shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Off,
    /// The build the manifest declares is running; the process comes after
    /// it.
    Building,
    Starting,
    Running,
    /// Went, and will be started again after a pause.
    Stopped,
    /// Could not be started at all.
    Failed,
}

/// What the plugin said of itself as it came up.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Hello {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub tools: Vec<serde_json::Value>,
    #[serde(default)]
    pub sections: Vec<serde_json::Value>,
    #[serde(default)]
    pub view: Option<serde_json::Value>,
}

/// A running plugin's tool, as the tool server offers it to the agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedTool {
    /// The plugin's name, an underscore and the tool's, so nothing
    /// collides with the app's tools or another plugin's.
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    /// Where a call goes: the source, the plugin, and the tool as the
    /// plugin calls it.
    pub source: String,
    pub plugin: String,
    pub tool: String,
}

/// The file the running plugins' tools are listed in, which the tool
/// server reads as the agent asks.
pub fn tools_path(home: &Path) -> PathBuf {
    crate::home::dir(home).join("plugin-tools.json")
}

/// A schema for a tool that declared none: arguments of any shape.
fn any_object() -> serde_json::Value {
    serde_json::json!({ "type": "object", "properties": {} })
}

/// A plugin as the window lists it: the manifest's word plus what is on
/// and running.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    #[serde(flatten)]
    pub declared: Declared,
    pub enabled: bool,
    pub state: State,
    /// Why the state is what it is, when there is something to say.
    pub detail: Option<String>,
    pub hello: Option<Hello>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub id: String,
    /// "git" for a clone, "dir" for a directory on the machine.
    pub kind: String,
    /// The URL or the path, as given.
    pub location: String,
    /// The ref asked for, when one was.
    pub reference: Option<String>,
    /// The commit the clone is at.
    pub commit: Option<String>,
    /// A newer commit on the ref, once a check found one.
    pub newer: Option<String>,
    /// Why the source is unusable, when it is.
    pub error: Option<String>,
    /// Whether the app's own list names this source.
    pub known: bool,
    pub plugins: Vec<PluginInfo>,
}

/// The state change of one plugin, as told to the window.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateEvent {
    pub source: String,
    pub name: String,
    pub state: State,
    pub detail: Option<String>,
    pub hello: Option<Hello>,
}

/// One of the named options a choice offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Choice {
    pub id: String,
    pub label: String,
}

/// What an action asks for before it runs: a line of text, or a choice
/// among named options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Field {
    pub id: String,
    pub label: String,
    /// "text" or "choice".
    pub kind: String,
    #[serde(default)]
    pub options: Option<Vec<Choice>>,
    #[serde(default)]
    pub placeholder: Option<String>,
}

/// Something the user can have a plugin do, on a row or on a section's
/// header. An action with fields is asked about first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Action {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub input: Option<Vec<Field>>,
}

/// A line of a section, as the tree draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Row {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub detail: Option<String>,
    /// "ok", "busy", "waiting" or "failed", drawn as a session's dot is.
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub actions: Option<Vec<Action>>,
    /// Which of the row's actions Enter runs.
    #[serde(default)]
    pub default: Option<String>,
    /// What the row says once it is opened, in the order given.
    #[serde(default, deserialize_with = "lenient_facts")]
    pub facts: Vec<Fact>,
}

/// One line an opened row shows: a label, what it says, and how it is
/// doing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fact {
    pub label: String,
    #[serde(default)]
    pub text: Option<String>,
    /// One of the four a row's state may be.
    #[serde(default)]
    pub state: Option<String>,
}

/// How many facts a row keeps.
const FACTS: usize = 8;

/// A row's facts, each one that is a fact kept and the rest dropped, so a
/// bad fact costs itself and not its row.
fn lenient_facts<'de, D>(deserializer: D) -> Result<Vec<Fact>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value
        .as_array()
        .map(|facts| {
            facts
                .iter()
                .filter_map(|fact| serde_json::from_value::<Fact>(fact.clone()).ok())
                .filter(|fact| !fact.label.is_empty())
                .filter(|fact| {
                    fact.state
                        .as_deref()
                        .is_none_or(|state| STATES.contains(&state))
                })
                .map(|fact| Fact {
                    text: fact.text.filter(|text| !text.is_empty()),
                    ..fact
                })
                .take(FACTS)
                .collect()
        })
        .unwrap_or_default())
}

/// A section's rows for one project, as told to the window. Empty rows,
/// no actions and no detail is the section gone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SectionEvent {
    pub source: String,
    pub plugin: String,
    pub section: String,
    pub title: String,
    /// A short line beside the title, the branch and its standing say.
    pub detail: Option<String>,
    pub project: String,
    /// The token of the session the rows are for, or None for rows that
    /// are the whole project's.
    pub session: Option<String>,
    pub rows: Vec<Row>,
    pub actions: Vec<Action>,
    /// Whether the section starts folded where it is drawn as a group
    /// inside its plugin's fold.
    pub folded: bool,
    /// Where the section stands among the ones the greeting declared,
    /// `u32::MAX` for one the greeting does not name. A `u32`, so the
    /// window reads the number exactly.
    pub order: u32,
}

/// A plugin's page for one project, as told to the window. No html and
/// not open is the page gone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ViewEvent {
    pub source: String,
    pub plugin: String,
    pub project: String,
    /// "wide" or "full", the room the manifest's view asks for.
    pub width: String,
    pub html: String,
    /// Whether the window shows the page now.
    pub open: bool,
}

/// A message from a plugin to its page, which is of use while the page is
/// open and is kept nowhere.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ViewData {
    pub source: String,
    pub plugin: String,
    pub project: String,
    pub data: serde_json::Value,
}

/// A plugin's mark on one session's row, as told to the window. No icon
/// is the mark gone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MarkEvent {
    pub source: String,
    pub plugin: String,
    pub project: String,
    /// The token of the session the mark is on.
    pub session: String,
    /// One of [`ICONS`].
    pub icon: Option<String>,
    pub count: Option<u32>,
    /// One of the four a row's state may be.
    pub state: Option<String>,
    /// What the mark stands for, in words.
    pub label: Option<String>,
}

/// The icons a mark may carry. The window draws each; a plugin naming
/// another gets the last, a plain dot.
pub const ICONS: [&str; 6] = ["pull-request", "branch", "issue", "check", "comment", "dot"];

/// A web address a plugin opens in the user's browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpenUrl {
    pub source: String,
    pub plugin: String,
    pub project: String,
    pub url: String,
}

/// What a plugin said went wrong with an action, for the window to show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Notice {
    pub source: String,
    pub plugin: String,
    pub text: String,
}

/// The states a row may be in.
const STATES: [&str; 4] = ["ok", "busy", "waiting", "failed"];

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSource {
    id: String,
    kind: String,
    location: String,
    reference: Option<String>,
    #[serde(default)]
    enabled: Vec<String>,
    /// The commit each plugin's build last ran at, by plugin name, so a
    /// plugin is built once per commit of its source.
    #[serde(default)]
    built: HashMap<String, String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    sources: Vec<StoredSource>,
}

struct Running {
    child: Child,
    /// Which start of a plugin this process is. A reader that gets to the
    /// end of its process late can find the next one under the same key,
    /// and this is how it tells the two apart.
    launch: u64,
    stdin: Arc<Mutex<ChildStdin>>,
    state: State,
    detail: Option<String>,
    hello: Option<Hello>,
    /// How many starts in a row went wrong, for the pause before the next.
    failures: u32,
    /// The last lines the plugin wrote to its error output, for the row
    /// to say why it went.
    complaints: Arc<Mutex<VecDeque<String>>>,
    /// Disconnects once the error output has been read to its end.
    complained: std::sync::mpsc::Receiver<()>,
    /// The beginnings of the commands its manifest listens for.
    commands: Vec<String>,
}

/// How many lines of a plugin's error output are kept for its row.
const COMPLAINTS: usize = 5;

/// How long a plugin that has gone is given for the last of its error
/// output to be read: the process is reaped by then, so the pipe ends
/// unless something the plugin started still holds it.
const LAST_WORDS: Duration = Duration::from_millis(500);

/// How many starts in a row may go wrong before the plugin is left alone:
/// one that dies before it greets is broken, not unlucky, and is not
/// started every half minute until the app closes.
const TRIES: u32 = 5;

/// Ends a process that was replaced while still going, after the time stop
/// gives one, and collects it.
fn reap(mut child: Child) {
    std::thread::spawn(move || {
        for _ in 0..20 {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
    });
}

/// Numbers every start of a plugin's process, for [`Running::launch`].
static LAUNCHES: AtomicU64 = AtomicU64::new(0);

type Key = (String, String);

/// How long after an action is sent its plugin may open a web address for
/// it.
const OPEN_WINDOW: Duration = Duration::from_secs(30);

/// An action waiting for an answer: the plugin it went to, when, and
/// whether that plugin has opened its one web address for it.
struct Waiting {
    plugin: Key,
    sent: Instant,
    opened: bool,
}

impl Waiting {
    /// Whether `plugin` may open a web address for this action at `now`:
    /// the action went to it less than `OPEN_WINDOW` ago and it has opened
    /// none for it yet.
    fn may_open(&self, plugin: &Key, now: Instant) -> bool {
        &self.plugin == plugin && !self.opened && now.duration_since(self.sent) < OPEN_WINDOW
    }
}

/// An agent's pty as the runtime follows it: the session it runs, known at
/// the spawn or found afterwards, the token the workbench gave it, the
/// project it belongs to, the folder it runs in, and the agent's id of the
/// session that started it.
struct Pty {
    session: Option<String>,
    token: Option<String>,
    project: String,
    cwd: String,
    starter: Option<String>,
    /// Whether the app made `cwd` as a worktree for this session.
    worktree: bool,
    /// The branch that worktree was made on, when the app knows it.
    branch: Option<String>,
}

/// A session as it starts, for [`Plugins::session_started`].
pub struct Started<'a> {
    /// The agent's id for the session, None for an agent that mints its
    /// own and says it later.
    pub session: Option<&'a str>,
    /// What the session's tools name it by.
    pub token: Option<&'a str>,
    /// The project the session belongs to.
    pub project: &'a str,
    /// The folder it runs in: a worktree under the project, or the project.
    pub cwd: &'a str,
    /// The agent's id of the session that started this one, if one did.
    pub starter: Option<&'a str>,
    /// Whether `cwd` is a worktree the app made for this session, and not
    /// one it merely runs in.
    pub worktree: bool,
    /// The branch that worktree was made on, when the app knows it.
    pub branch: Option<&'a str>,
}

/// A shell command a session ran, for [`Plugins::command_ran`].
pub struct Ran<'a> {
    /// The pty or integrated run it ran in, where the source knows it.
    pub pty: Option<&'a str>,
    /// The agent's id for the session, where the source knows it and not
    /// the pty.
    pub session: Option<&'a str>,
    /// The agent's id for the tool call, which tells one command heard
    /// twice from two commands.
    pub call: &'a str,
    pub command: &'a str,
    /// The folder it ran in, where the source says.
    pub cwd: Option<&'a str>,
    pub ok: bool,
    pub output: &'a str,
    /// Whether the source cut the output short already.
    pub truncated: bool,
}

/// A source, a plugin, a section of that plugin, the project the rows are
/// for, and the agent's id of the session they are for, empty for rows of
/// the whole project: what one set of rows is kept under.
type SectionKey = (String, String, String, String, String);

/// A source, a plugin, the project, and the agent's id of the session a
/// mark is on.
type MarkKey = (String, String, String, String);

/// A source, a plugin, and the project a page is for: what one page is
/// kept under.
type ViewKey = (String, String, String);

struct Inner {
    home: PathBuf,
    root: PathBuf,
    sink: Arc<dyn Sink>,
    /// The sources the app offers out of the box.
    known: Vec<KnownSource>,
    stored: Mutex<Stored>,
    running: Mutex<HashMap<Key, Running>>,
    /// Newer commits found by a check, by source id.
    newer: Mutex<HashMap<String, String>>,
    /// The rows each section last sent, so what a plugin leaves behind can
    /// be taken off the tree when it goes.
    sections: Mutex<HashMap<SectionKey, SectionEvent>>,
    /// The page each plugin last sent for a project, so what a plugin
    /// leaves in the viewer can be taken out of it when it goes.
    views: Mutex<HashMap<ViewKey, ViewEvent>>,
    /// The actions waiting for an answer, which tells an action's result
    /// from a tool call's, until it comes or the plugin goes.
    pending: Mutex<HashMap<String, Waiting>>,
    /// The mark each plugin last put on a session's row.
    marks: Mutex<HashMap<MarkKey, MarkEvent>>,
    /// Where the build of a plugin with no process has got to: building,
    /// or the build that failed. What a row says until a process is there.
    building: Mutex<HashMap<Key, (State, Option<String>)>>,
    /// Held for the whole of a start, from the look at what is running or
    /// building to the claim on the build or the process, so two starts
    /// of one plugin, a restart after a crash and the user's own, cannot
    /// both find nothing there and both go ahead.
    starting: Mutex<()>,
    /// The projects open on this machine, as the window last said.
    projects: Mutex<Vec<String>>,
    /// The agents' ptys, by pty id, so a session that ends is named by the
    /// session it ran. A shell has no entry.
    ptys: Mutex<HashMap<String, Pty>>,
    /// The session and call of the commands plugins were told of last.
    told: Mutex<VecDeque<(String, String)>>,
}

/// The sources and their processes. Shared with the threads that read a
/// process's output, which outlive any one call.
#[derive(Clone)]
pub struct Plugins {
    inner: Arc<Inner>,
}

fn source_id(location: &str) -> String {
    let digest = crc32(location.as_bytes());
    let stem = location
        .trim_end_matches('/')
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("source")
        .trim_end_matches(".git");
    let stem: String = stem
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(24)
        .collect();
    format!(
        "{}-{digest:08x}",
        if stem.is_empty() { "source" } else { &stem }
    )
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in bytes {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

/// A plugin's name: what the manifest calls it, and what its tools are
/// prefixed with, so it is a plain identifier.
pub(crate) fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        && name.len() <= 40
}

/// A ref names a branch or a tag: letters, digits and the few marks a
/// name holds, so it is never read as an option.
fn plain_reference(reference: &str) -> bool {
    !reference.is_empty()
        && !reference.starts_with('-')
        && reference
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
}

/// Reads and checks a source's manifest: every path under the source,
/// every runtime and every build's program on the login shell's PATH,
/// every name a plain identifier.
pub fn read_manifest(
    source: &Path,
    vars: &HashMap<String, String>,
) -> Result<Vec<Declared>, String> {
    let path = source.join(MANIFEST);
    let text = std::fs::read_to_string(&path)
        .map_err(|_| format!("no {MANIFEST} at the source's root"))?;
    let document = text.parse::<toml_edit::DocumentMut>().map_err(|e| {
        format!(
            "manifest invalid: {}",
            e.to_string().lines().next().unwrap_or("")
        )
    })?;
    let entries = document
        .get("plugin")
        .and_then(|item| item.as_array_of_tables())
        .ok_or("manifest has no [[plugin]] entries")?;
    let mut declared = Vec::new();
    for (index, table) in entries.iter().enumerate() {
        let at = index + 1;
        let string = |key: &str| -> Result<String, String> {
            table
                .get(key)
                .and_then(|item| item.as_str())
                .map(str::to_string)
                .ok_or_else(|| format!("plugin {at}: {key} is missing or not a string"))
        };
        let strings = |key: &str| -> Result<Vec<String>, String> {
            match table.get(key) {
                None => Ok(Vec::new()),
                Some(item) => item
                    .as_array()
                    .map(|array| {
                        array
                            .iter()
                            .map(|value| {
                                value.as_str().map(str::to_string).ok_or_else(|| {
                                    format!(
                                        "plugin {at}: {key} holds something that is not a string"
                                    )
                                })
                            })
                            .collect::<Result<Vec<_>, _>>()
                    })
                    .ok_or_else(|| format!("plugin {at}: {key} is not a list"))?,
            }
        };
        let name = string("name")?;
        if !valid_name(&name) {
            return Err(format!(
                "plugin {at}: the name {name:?} must be lowercase letters, digits, - and _"
            ));
        }
        if declared.iter().any(|d: &Declared| d.name == name) {
            return Err(format!("plugin {at}: the name {name:?} is used twice"));
        }
        let relative = string("path")?;
        let relative_path = Path::new(&relative);
        if relative_path.is_absolute()
            || relative_path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!(
                "plugin {name}: the path must stay under the source"
            ));
        }
        let dir = source.join(relative_path);
        if !dir.is_dir() {
            return Err(format!("plugin {name}: no directory at {relative}"));
        }
        let run = strings("run")?;
        let Some(program) = run.first() else {
            return Err(format!("plugin {name}: run names no program"));
        };
        if !Path::new(program).is_absolute() && crate::env::find_on_path(vars, program).is_none() {
            return Err(format!(
                "plugin {name}: needs {program}, which is not on the PATH"
            ));
        }
        let build = strings("build")?;
        if let Some(program) = build.first() {
            if !Path::new(program).is_absolute()
                && crate::env::find_on_path(vars, program).is_none()
            {
                return Err(format!(
                    "plugin {name}: the build needs {program}, which is not on the PATH"
                ));
            }
        }
        // A plugin that declares a build is not asked for its script here:
        // the build is what writes it, and it runs before the process does.
        if run.len() > 1 && build.is_empty() {
            let script = &run[1];
            let script_path = Path::new(script);
            if !script.starts_with('-')
                && !script_path.is_absolute()
                && !dir.join(script_path).exists()
            {
                return Err(format!("plugin {name}: {script} is not in its directory"));
            }
        }
        let tools = strings("tools")?;
        for tool in &tools {
            if !valid_name(tool) {
                return Err(format!(
                    "plugin {name}: the tool {tool:?} must be a plain identifier"
                ));
            }
        }
        let view = table
            .get("view")
            .and_then(|item| item.as_str())
            .map(str::to_string);
        if let Some(view) = &view {
            if view != "wide" && view != "full" {
                return Err(format!("plugin {name}: view must be wide or full"));
            }
        }
        let mut commands = Vec::new();
        for command in strings("commands")? {
            let words = command.split_whitespace().collect::<Vec<_>>().join(" ");
            if words.is_empty()
                || words.len() > COMMAND_BEGINNING
                || words.chars().any(char::is_control)
            {
                return Err(format!(
                    "plugin {name}: the command {command:?} must be words of at most {COMMAND_BEGINNING} characters"
                ));
            }
            if !commands.contains(&words) {
                commands.push(words);
            }
        }
        if commands.len() > COMMAND_BEGINNINGS {
            return Err(format!(
                "plugin {name}: at most {COMMAND_BEGINNINGS} commands are listened for"
            ));
        }
        declared.push(Declared {
            name,
            path: relative,
            description: string("description").unwrap_or_default(),
            version: string("version").unwrap_or_else(|_| "0.0.0".to_string()),
            run,
            build,
            tools,
            sections: strings("sections")?,
            view,
            commands,
        });
    }
    if declared.is_empty() {
        return Err("manifest names no plugins".to_string());
    }
    Ok(declared)
}

/// Every git call the plugins make. What the caller passes is arguments
/// alone.
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = crate::git::command(dir)
        .args(args)
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr
            .lines()
            .last()
            .unwrap_or("git failed")
            .trim()
            .to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// The commit a revision names. `--end-of-options` keeps the revision a
/// revision, and `--verify` has git print the one object name and nothing
/// else.
fn commit_at(dir: &Path, revision: &str) -> Result<String, String> {
    git(
        dir,
        &["rev-parse", "--verify", "--end-of-options", revision],
    )
}

/// What a location is: a directory here, or a repository to clone.
fn kind_of(location: &str) -> &'static str {
    if Path::new(location).is_dir() {
        "dir"
    } else {
        "git"
    }
}

/// A source the app offers and nothing has been fetched for: the
/// repository and ref the list gives, and its plugins as the list names
/// them, every one of them off.
fn offered(source: &KnownSource) -> SourceInfo {
    SourceInfo {
        id: crate::known::stored_id(&source.id),
        kind: "git".to_string(),
        location: source.repository.clone(),
        reference: source.reference.clone(),
        commit: None,
        newer: None,
        error: None,
        known: true,
        plugins: source
            .plugins
            .iter()
            .map(|plugin| PluginInfo {
                declared: Declared::listed(&plugin.name, &plugin.description),
                enabled: false,
                state: State::Off,
                detail: None,
                hello: None,
            })
            .collect(),
    }
}

/// An address with what does not tell repositories apart taken off: case,
/// a trailing slash and a trailing `.git`.
fn same_address(address: &str) -> String {
    let trimmed = address.trim().trim_end_matches('/');
    trimmed
        .strip_suffix(".git")
        .unwrap_or(trimmed)
        .to_lowercase()
}

/// Carries a fetched known source that was stored under one of its former
/// addresses to the current one: the checkout's remote first, then the
/// stored location. The source keeps its id, so its enabled plugins and
/// remembered builds stay with it. A step that fails leaves the source
/// on the address it had, and the next start tries again.
fn move_to_current_addresses(root: &Path, stored: &mut Stored, known: &[KnownSource]) {
    for at in 0..stored.sources.len() {
        let source = &stored.sources[at];
        if source.kind != "git" {
            continue;
        }
        let Some(listed) =
            crate::known::suffix(&source.id).and_then(|name| known.iter().find(|k| k.id == name))
        else {
            continue;
        };
        let here = same_address(&source.location);
        if here == same_address(&listed.repository)
            || !listed.former.iter().any(|f| same_address(f) == here)
        {
            continue;
        }
        let checkout = root.join(&source.id).join("repo");
        let Ok(remote) = git(&checkout, &["remote", "get-url", "origin"]) else {
            continue;
        };
        let set = |url: &str| git(&checkout, &["remote", "set-url", "origin", "--", url]);
        if set(&listed.repository).is_err() {
            continue;
        }
        let before = std::mem::replace(&mut stored.sources[at].location, listed.repository.clone());
        if write_state(root, stored).is_err() {
            stored.sources[at].location = before;
            let _ = set(&remote);
        }
    }
}

fn write_state(root: &Path, stored: &Stored) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| format!("could not create {root:?}: {e}"))?;
    let text = serde_json::to_string_pretty(stored).map_err(|e| e.to_string())?;
    std::fs::write(root.join("state.json"), text)
        .map_err(|e| format!("could not write the plugin state: {e}"))
}

impl Plugins {
    /// The sources' directory is under the app's own in the home.
    pub fn new(home: &Path, sink: Arc<dyn Sink>) -> Self {
        Self::with_known(home, sink, crate::known::known())
    }

    /// The same, with the sources offered out of the box given rather
    /// than read from the app's own list.
    fn with_known(home: &Path, sink: Arc<dyn Sink>, known: Vec<KnownSource>) -> Self {
        let root = crate::home::dir(home).join("plugins");
        let mut stored: Stored = std::fs::read_to_string(root.join("state.json"))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        move_to_current_addresses(&root, &mut stored, &known);
        Self {
            inner: Arc::new(Inner {
                home: home.to_path_buf(),
                root,
                sink,
                known,
                stored: Mutex::new(stored),
                running: Mutex::new(HashMap::new()),
                newer: Mutex::new(HashMap::new()),
                sections: Mutex::new(HashMap::new()),
                views: Mutex::new(HashMap::new()),
                pending: Mutex::new(HashMap::new()),
                marks: Mutex::new(HashMap::new()),
                building: Mutex::new(HashMap::new()),
                starting: Mutex::new(()),
                projects: Mutex::new(Vec::new()),
                ptys: Mutex::new(HashMap::new()),
                told: Mutex::new(VecDeque::new()),
            }),
        }
    }

    /// Every source, as the window lists them, manifests read afresh.
    pub fn list(&self) -> Vec<SourceInfo> {
        self.inner.list()
    }

    /// Adds a source: clones a repository, or takes a directory as it is,
    /// and reads its manifest. A source whose manifest fails adds nothing.
    pub fn add(&self, location: &str, reference: Option<&str>) -> Result<SourceInfo, String> {
        self.inner.add(location, reference)
    }

    /// Clones a source the app's own list names, under the id that list
    /// gives it. The source's plugins are off, as any other source's are.
    pub fn fetch(&self, id: &str) -> Result<SourceInfo, String> {
        self.inner.fetch(id)
    }

    /// Stops the source's plugins and removes it, clone included.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        self.inner.remove(id)
    }

    /// Whether the source's ref has moved on from the clone.
    pub fn check(&self, id: &str) -> Result<Option<String>, String> {
        self.inner.check(id)
    }

    /// Moves the clone to the ref's latest commit, reads the manifest
    /// again, and starts the plugins that are on afresh.
    pub fn update(&self, id: &str) -> Result<SourceInfo, String> {
        self.inner.update(id)
    }

    /// Turns a plugin on or off: on starts its process, off stops it.
    pub fn enable(&self, id: &str, name: &str, on: bool) -> Result<SourceInfo, String> {
        self.inner.enable(id, name, on)
    }

    /// Starts every plugin that is on: what a core does as it comes up.
    pub fn start_enabled(&self) {
        self.inner.start_enabled();
    }

    /// The projects open on this machine, replacing what was known. Every
    /// running plugin hears about the ones opened and the ones closed.
    pub fn set_projects(&self, paths: Vec<String>) {
        self.inner.set_projects(paths);
    }

    /// The tree moved under a watched root: every open project the root is
    /// in hears about it.
    pub fn tree_moved(&self, root: &str) {
        self.inner.tree_moved(root);
    }

    /// An agent's pty started in a project. The session is None for an
    /// agent that mints its own id, which `session_identified` brings. The
    /// token is what the session's tools name it by, which a plugin is
    /// never shown: a call from those tools reaches it under the session.
    pub fn session_started(&self, pty_id: &str, started: Started) {
        self.inner.session_started(pty_id, started);
    }

    /// The id an agent minted for a session of its own, once it is known.
    pub fn session_identified(&self, pty_id: &str, session: &str) {
        self.inner.session_identified(pty_id, session);
    }

    /// A pty ended. One with no session on it, a shell's, says nothing.
    pub fn session_ended(&self, pty_id: &str) {
        self.inner.session_ended(pty_id);
    }

    /// A session ran a shell command. Each plugin whose manifest listens
    /// for one of the simple commands in it is told that command alone, and
    /// no other; a command of no session this core started, or one told
    /// already, is told to none.
    pub fn command_ran(&self, ran: Ran) {
        self.inner.command_ran(ran);
    }

    /// Writes a line to a running plugin.
    pub fn send(
        &self,
        source_id: &str,
        name: &str,
        message: &serde_json::Value,
    ) -> Result<(), String> {
        self.inner.send(source_id, name, message)
    }

    /// Hands a tool call to the plugin that owns the tool. The answer
    /// comes back on the plugin's output, and is written where the tool
    /// server waits for it; a plugin that is not running is answered here
    /// and now.
    pub fn call(&self, request: ToolRequest) {
        self.inner.call(request);
    }

    /// The tools of every plugin that is running, as the tool server
    /// offers them.
    pub fn tools(&self) -> Vec<PublishedTool> {
        self.inner.tools()
    }

    /// Runs an action of a section, on a row or on the header, and comes
    /// back at once: what it does shows up as rows, a place, a diff, media
    /// or a line, and what went wrong as a notice.
    #[allow(clippy::too_many_arguments)]
    pub fn action(
        &self,
        source_id: &str,
        name: &str,
        section: &str,
        action: &str,
        row: Option<&str>,
        input: &serde_json::Value,
        project: &str,
        session: Option<&str>,
    ) -> Result<(), String> {
        self.inner.action(
            source_id, name, section, action, row, input, project, session,
        )
    }

    /// Hands a plugin's page's message to the plugin and comes back at
    /// once: whatever the plugin makes of it arrives as its own line.
    pub fn view_message(
        &self,
        source_id: &str,
        name: &str,
        project: &str,
        payload: &serde_json::Value,
    ) -> Result<(), String> {
        self.inner.send(
            source_id,
            name,
            &serde_json::json!({
                "type": "view_message",
                "project": project,
                "payload": payload,
            }),
        )
    }
}

/// The line plugins hear a session by, or None for a pty whose session is
/// not known yet. The starter is there only for a session another started,
/// and the branch only for a session in a worktree the app made for it.
fn session_line(event: &str, pty: &Pty) -> Option<serde_json::Value> {
    let session = pty.session.as_deref()?;
    let mut line = serde_json::json!({
        "type": "session",
        "event": event,
        "id": session,
        "project": pty.project,
        "cwd": pty.cwd,
        "worktree": pty.worktree,
    });
    if let Some(starter) = &pty.starter {
        line["startedBy"] = serde_json::json!(starter);
    }
    if let Some(branch) = &pty.branch {
        line["branch"] = serde_json::json!(branch);
    }
    Some(line)
}

/// Whether a plugin's address is one for a web browser: http or https,
/// with a host, and nothing a shell or the system's opener could take
/// for something else.
fn web_address(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"));
    rest.is_some_and(|rest| !rest.is_empty() && !rest.starts_with('/'))
        && url.len() <= 2048
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// How long a command beginning in a manifest may be, and how many one
/// plugin may list.
const COMMAND_BEGINNING: usize = 200;
const COMMAND_BEGINNINGS: usize = 16;

/// How much of a command's output a plugin is told: the end of it, where
/// a command says what it made.
const COMMAND_OUTPUT: usize = 16 * 1024;

/// How many commands are remembered as told, so one heard both from a
/// conversation's stream and from a hook is told once.
const COMMANDS_TOLD: usize = 256;

/// How deep the scripts of `sh -c` and its like are looked into.
const SHELL_DEPTH: usize = 3;

/// Words a simple command can open with before the program it runs, and
/// the words that close a compound one: the shell's own words, which run
/// nothing, and the programs that run the command after them.
const LEADING_WORDS: &[&str] = &[
    "!", "{", "}", "if", "then", "elif", "else", "fi", "while", "until", "do", "done",
];
const RUNNERS: &[&str] = &["time", "exec", "command", "nohup", "env"];

/// The options to `set` that change how the shell runs and print nothing,
/// by their letters and by the names `-o` takes.
const QUIET_SET_FLAGS: &[char] = &['e', 'u', 'E', 'C', 'f'];
const QUIET_SET_OPTIONS: &[&str] = &[
    "errexit",
    "nounset",
    "pipefail",
    "errtrace",
    "noclobber",
    "noglob",
];

/// One simple command in a line: its words from the program on, with the
/// quotes taken off, and its text as written from the program to its last
/// word.
#[derive(Debug, Clone, PartialEq)]
struct Part {
    /// The words from the program on, with quotes taken off; none for a
    /// part that only sets variables or closes a compound command.
    words: Vec<String>,
    /// The line from the program to the last word.
    text: String,
    /// The line from the part's first word, the words before the program
    /// among them.
    whole: String,
    /// Whether a program such as `env` or `time` stands before the program.
    runner: bool,
}

impl Part {
    /// Whether the command surely prints nothing of its own: `NAME=value`
    /// words alone, `cd` to anywhere but `-`, `export` with only
    /// `NAME=value` words, and `set` with only those and options that print
    /// nothing. A part that expands anything, with `$`, a backquote or a
    /// process substitution, may print what it expands in an error, and a
    /// part a runner such as `env` or `time` opens prints of its own, so
    /// neither is ever quiet.
    fn quiet(&self) -> bool {
        if self.runner
            || ["$", "`", "<(", ">("]
                .iter()
                .any(|expands| self.whole.contains(expands))
        {
            return false;
        }
        let Some((program, words)) = self.words.split_first() else {
            return true;
        };
        match program.as_str() {
            "cd" => words.iter().all(|word| word != "-"),
            "export" => !words.is_empty() && words.iter().all(|word| assignment(word)),
            "set" => !words.is_empty() && quiet_set(words),
            _ => false,
        }
    }
}

/// Whether `set` given these words prints nothing: each is `NAME=value`,
/// or options from [`QUIET_SET_FLAGS`], `-o` naming one of
/// [`QUIET_SET_OPTIONS`].
fn quiet_set(words: &[String]) -> bool {
    let mut words = words.iter();
    while let Some(word) = words.next() {
        if assignment(word) {
            continue;
        }
        let Some(flags) = word
            .strip_prefix(['-', '+'])
            .filter(|flags| !flags.is_empty())
        else {
            return false;
        };
        for flag in flags.chars() {
            let quiet = if flag == 'o' {
                words
                    .next()
                    .is_some_and(|name| QUIET_SET_OPTIONS.contains(&name.as_str()))
            } else {
                QUIET_SET_FLAGS.contains(&flag)
            };
            if !quiet {
                return false;
            }
        }
    }
    true
}

/// The simple commands a shell command line runs: the line is split where
/// `;`, `&`, `|`, a newline, a parenthesis or a backquote stands outside
/// quotes, and the words a command opens with before its program,
/// `NAME=value` among them, are dropped, as is a command of nothing else.
/// A heredoc's body is text and not commands. The script a shell is given
/// with `-c` stands in for that shell, so a command an agent wraps in
/// `zsh -lc '...'` is found inside and the wrapper is not a command of its
/// own.
fn command_parts(line: &str) -> Vec<Part> {
    let mut parts = Vec::new();
    split_command(line, 0, &mut parts);
    parts
}

type Chars<'a> = std::iter::Peekable<std::str::CharIndices<'a>>;

/// A word being read: its text, with quotes taken off, and where it
/// starts in the line.
struct Word {
    text: String,
    start: Option<usize>,
}

impl Word {
    fn push(&mut self, at: usize, c: char) {
        self.start.get_or_insert(at);
        self.text.push(c);
    }

    fn end(&mut self, at: usize, words: &mut Vec<(String, usize, usize)>) {
        if let Some(start) = self.start.take() {
            words.push((std::mem::take(&mut self.text), start, at));
        }
    }
}

fn split_command(line: &str, depth: usize, parts: &mut Vec<Part>) {
    let mut words = Vec::new();
    let mut word = Word {
        text: String::new(),
        start: None,
    };
    let mut heredocs = Vec::new();
    let mut chars = line.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        match c {
            '\'' => {
                word.start.get_or_insert(at);
                for (_, c) in chars.by_ref() {
                    if c == '\'' {
                        break;
                    }
                    word.text.push(c);
                }
            }
            '"' => {
                word.start.get_or_insert(at);
                double_quoted(&mut chars, &mut word.text);
            }
            '\\' => {
                if let Some((next_at, next)) = chars.next() {
                    if next != '\n' {
                        word.start.get_or_insert(at);
                        word.push(next_at, next);
                    }
                }
            }
            '#' if word.start.is_none() => while chars.next_if(|(_, c)| *c != '\n').is_some() {},
            '<' if chars.peek().is_some_and(|(_, c)| *c == '<') => {
                chars.next();
                if chars.next_if(|(_, c)| *c == '<').is_some() {
                    word.push(at, '<');
                    word.text.push_str("<<");
                } else {
                    word.end(at, &mut words);
                    heredocs.extend(heredoc(&mut chars));
                }
            }
            '&' if word.text.ends_with(['>', '<'])
                || chars.peek().is_some_and(|(_, c)| *c == '>') =>
            {
                word.push(at, c);
            }
            '\n' => {
                word.end(at, &mut words);
                end_part(line, &mut words, depth, parts);
                skip_heredocs(&mut chars, &mut heredocs);
            }
            ';' | '&' | '|' | '(' | ')' | '`' => {
                word.end(at, &mut words);
                end_part(line, &mut words, depth, parts);
            }
            c if c.is_whitespace() => word.end(at, &mut words),
            c => word.push(at, c),
        }
    }
    word.end(line.len(), &mut words);
    end_part(line, &mut words, depth, parts);
}

/// Reads a double-quoted string after its opening quote, into `word`. A
/// heredoc opened inside a `$(...)` in it has its body read as the
/// string's text, quotes and all, as the shell reads it.
fn double_quoted(chars: &mut Chars, word: &mut String) {
    let mut substitutions = 0usize;
    let mut heredocs = Vec::new();
    while let Some((_, c)) = chars.next() {
        match c {
            '"' => break,
            '\\' => match chars.peek().map(|(_, c)| *c) {
                Some(next @ ('"' | '\\' | '$' | '`')) => {
                    word.push(next);
                    chars.next();
                }
                Some('\n') => {
                    chars.next();
                }
                _ => word.push('\\'),
            },
            '$' if chars.peek().is_some_and(|(_, c)| *c == '(') => {
                substitutions += 1;
                word.push(c);
            }
            ')' if substitutions > 0 => {
                substitutions -= 1;
                word.push(c);
            }
            '<' if substitutions > 0 && chars.peek().is_some_and(|(_, c)| *c == '<') => {
                chars.next();
                if chars.next_if(|(_, c)| *c == '<').is_some() {
                    word.push_str("<<<");
                } else {
                    heredocs.extend(heredoc(chars));
                }
            }
            '\n' => {
                word.push(c);
                skip_heredocs(chars, &mut heredocs);
            }
            c => word.push(c),
        }
    }
}

/// The word a heredoc ends at, read after its `<<`, quotes taken off, and
/// whether its body's lines may be indented with tabs, as `<<-` allows.
fn heredoc(chars: &mut Chars) -> Option<(String, bool)> {
    let tabs = chars.next_if(|(_, c)| *c == '-').is_some();
    while chars.next_if(|(_, c)| *c == ' ' || *c == '\t').is_some() {}
    let mut end = String::new();
    while let Some((_, c)) = chars.next_if(|(_, c)| {
        !c.is_whitespace() && !matches!(c, ';' | '&' | '|' | '(' | ')' | '<' | '>' | '`')
    }) {
        if !matches!(c, '\'' | '"' | '\\') {
            end.push(c);
        }
    }
    (!end.is_empty()).then_some((end, tabs))
}

/// Passes over the bodies of the heredocs a line opened, each up to the
/// line that ends it, or to the end of the text when none does.
fn skip_heredocs(chars: &mut Chars, heredocs: &mut Vec<(String, bool)>) {
    for (end, tabs) in heredocs.drain(..) {
        loop {
            let mut body_line = String::new();
            let mut more = false;
            for (_, c) in chars.by_ref() {
                if c == '\n' {
                    more = true;
                    break;
                }
                body_line.push(c);
            }
            let body_line = if tabs {
                body_line.trim_start_matches('\t')
            } else {
                &body_line
            };
            if body_line == end || !more {
                break;
            }
        }
    }
}

fn end_part(
    line: &str,
    words: &mut Vec<(String, usize, usize)>,
    depth: usize,
    parts: &mut Vec<Part>,
) {
    let mut words = std::mem::take(words);
    let (Some((_, first, _)), Some((_, _, end))) = (words.first(), words.last()) else {
        return;
    };
    let (first, end) = (*first, *end);
    let program = words
        .iter()
        .position(|(word, _, _)| {
            let word = word.as_str();
            !LEADING_WORDS.contains(&word) && !RUNNERS.contains(&word) && !assignment(word)
        })
        .unwrap_or(words.len());
    let runner = words[..program]
        .iter()
        .any(|(word, _, _)| RUNNERS.contains(&word.as_str()));
    let text = words
        .get(program)
        .map_or(String::new(), |(_, start, _)| line[*start..end].to_string());
    let words: Vec<String> = words.drain(program..).map(|(word, _, _)| word).collect();
    if depth < SHELL_DEPTH {
        if let Some(script) = shell_script(&words) {
            split_command(script, depth + 1, parts);
            return;
        }
    }
    parts.push(Part {
        words,
        text,
        whole: line[first..end].to_string(),
        runner,
    });
}

/// Whether a word sets a variable for the command after it.
fn assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        let mut chars = name.chars();
        chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

/// The script a shell is given to run with `-c`, as in `zsh -lc '...'`.
fn shell_script(words: &[String]) -> Option<&str> {
    let shell = words.first()?.rsplit('/').next()?;
    if !matches!(shell, "sh" | "bash" | "zsh" | "dash" | "ksh") {
        return None;
    }
    let mut rest = words[1..].iter();
    while let Some(word) = rest.next() {
        if !word.starts_with('-') || word.starts_with("--") {
            return None;
        }
        if word.contains('c') {
            return rest.next().map(String::as_str);
        }
    }
    None
}

/// Whether a simple command runs what one of the beginnings names: its
/// words begin with the beginning's words, word for word, its program
/// known by its name wherever it lives.
fn runs(part: &Part, beginnings: &[String]) -> bool {
    beginnings.iter().any(|beginning| {
        let wanted: Vec<&str> = beginning.split(' ').collect();
        part.words.len() >= wanted.len()
            && part
                .words
                .iter()
                .zip(&wanted)
                .enumerate()
                .all(|(at, (word, want))| {
                    word == want
                        || (at == 0 && !want.contains('/') && word.rsplit('/').next() == Some(want))
                })
    })
}

/// The output a plugin may be told for the simple command at `heard` in a
/// line: all of it when every other command in the line prints nothing,
/// and none otherwise, since it is not that command's alone.
fn output_of<'a>(parts: &[Part], heard: usize, output: &'a str) -> Option<&'a str> {
    parts
        .iter()
        .enumerate()
        .all(|(at, part)| at == heard || part.quiet())
        .then_some(output)
}

/// The end of a command's output a plugin is told, and whether it was cut
/// to that.
fn output_end(output: &str) -> (&str, bool) {
    if output.len() <= COMMAND_OUTPUT {
        return (output, false);
    }
    let mut start = output.len() - COMMAND_OUTPUT;
    while !output.is_char_boundary(start) {
        start += 1;
    }
    (&output[start..], true)
}

/// Whether a watched root is in a project, or is the project itself.
fn inside(root: &str, project: &str) -> bool {
    let root = root.trim_end_matches(['/', '\\']);
    let project = project.trim_end_matches(['/', '\\']);
    root == project
        || root
            .strip_prefix(project)
            .is_some_and(|rest| rest.starts_with('/') || rest.starts_with('\\'))
}

/// A field of an action's input, as far as the window needs it to be one.
fn sound_field(field: &Field) -> bool {
    !field.id.is_empty() && matches!(field.kind.as_str(), "text" | "choice")
}

/// An action with an id and a label, its fields kept where they are whole.
fn checked_action(mut action: Action) -> Option<Action> {
    if action.id.is_empty() || action.label.is_empty() {
        return None;
    }
    action.input = action
        .input
        .map(|fields| fields.into_iter().filter(sound_field).collect());
    Some(action)
}

fn checked_actions(value: Option<&serde_json::Value>) -> Vec<Action> {
    value
        .and_then(|value| value.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|item| serde_json::from_value::<Action>(item.clone()).ok())
                .filter_map(checked_action)
                .collect()
        })
        .unwrap_or_default()
}

/// A row with an id, a label and a state that is one of the four. Its
/// default names one of its own actions or nothing at all.
fn checked_row(mut row: Row) -> Option<Row> {
    if row.id.is_empty() || row.label.is_empty() {
        return None;
    }
    if let Some(state) = &row.state {
        if !STATES.contains(&state.as_str()) {
            return None;
        }
    }
    row.actions = row
        .actions
        .map(|actions| actions.into_iter().filter_map(checked_action).collect());
    let named = |id: &String| {
        row.actions
            .as_ref()
            .is_some_and(|actions| actions.iter().any(|action| &action.id == id))
    };
    if !row.default.as_ref().is_some_and(named) {
        row.default = None;
    }
    Some(row)
}

/// One `section` line from a plugin: the section's rows for one project,
/// or None when the line names no section of a project. A row that is not
/// a row is dropped and the rest stand.
fn checked_section(
    source_id: &str,
    name: &str,
    message: &serde_json::Value,
    hello: Option<&Hello>,
    session: Option<String>,
) -> Option<SectionEvent> {
    let text = |key: &str| message.get(key).and_then(|value| value.as_str());
    let section = text("id").unwrap_or_default();
    if !valid_name(section) {
        return None;
    }
    let project = text("project").unwrap_or_default();
    if project.is_empty() {
        return None;
    }
    let rows = message
        .get("rows")
        .and_then(|rows| rows.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| serde_json::from_value::<Row>(row.clone()).ok())
                .filter_map(checked_row)
                .collect()
        })
        .unwrap_or_default();
    Some(SectionEvent {
        source: source_id.to_string(),
        plugin: name.to_string(),
        section: section.to_string(),
        title: text("title")
            .filter(|title| !title.is_empty())
            .unwrap_or(section)
            .to_string(),
        detail: text("detail")
            .filter(|detail| !detail.is_empty())
            .map(str::to_string),
        project: project.to_string(),
        session,
        rows,
        actions: checked_actions(message.get("actions")),
        folded: message
            .get("folded")
            .and_then(|folded| folded.as_bool())
            .unwrap_or(false),
        order: declared_order(hello, section),
    })
}

/// Where a section stands among the ones the greeting declared, by the id
/// each declared section carries. One the greeting does not name comes
/// after every one it does.
fn declared_order(hello: Option<&Hello>, section: &str) -> u32 {
    hello
        .and_then(|hello| {
            hello
                .sections
                .iter()
                .position(|declared| declared.get("id").and_then(|id| id.as_str()) == Some(section))
        })
        .and_then(|at| u32::try_from(at).ok())
        .unwrap_or(u32::MAX)
}

/// A page of the plugin's own directory: the path stays under it, as a
/// manifest's paths do, and a link out of it is no page of the plugin's
/// either. None for anything else.
fn page_path(dir: &Path, path: &str) -> Option<PathBuf> {
    let relative = Path::new(path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    let file = dunce::canonicalize(dir.join(relative)).ok()?;
    let root = dunce::canonicalize(dir).ok()?;
    file.starts_with(&root).then_some(file)
}

impl Inner {
    fn save(&self, stored: &Stored) -> Result<(), String> {
        write_state(&self.root, stored)
    }

    /// Where a source's files are: its clone, or the directory itself.
    fn dir_of(&self, source: &StoredSource) -> PathBuf {
        if source.kind == "dir" {
            PathBuf::from(&source.location)
        } else {
            self.root.join(&source.id).join("repo")
        }
    }

    fn vars() -> HashMap<String, String> {
        crate::env::environment().vars.clone()
    }

    fn describe(&self, source: &StoredSource) -> SourceInfo {
        let dir = self.dir_of(source);
        let commit = if source.kind == "git" {
            commit_at(&dir, "HEAD").ok()
        } else {
            None
        };
        let (plugins, error) = match read_manifest(&dir, &Self::vars()) {
            Ok(declared) => (declared, None),
            Err(error) => (Vec::new(), Some(error)),
        };
        let building = self.building.lock().expect("plugins lock").clone();
        let running = self.running.lock().expect("plugins lock");
        let plugins = plugins
            .into_iter()
            .map(|declared| {
                let enabled = source.enabled.contains(&declared.name);
                let key: Key = (source.id.clone(), declared.name.clone());
                let live = running.get(&key);
                // A plugin being built, or one whose build failed, has no
                // process to say where it is.
                let waiting = live.is_none().then(|| building.get(&key)).flatten();
                PluginInfo {
                    enabled,
                    state: live
                        .map(|r| r.state.clone())
                        .or_else(|| waiting.map(|(state, _)| state.clone()))
                        .unwrap_or(State::Off),
                    detail: live
                        .and_then(|r| r.detail.clone())
                        .or_else(|| waiting.and_then(|(_, detail)| detail.clone())),
                    hello: live.and_then(|r| r.hello.clone()),
                    declared,
                }
            })
            .collect();
        SourceInfo {
            id: source.id.clone(),
            kind: source.kind.clone(),
            location: source.location.clone(),
            reference: source.reference.clone(),
            commit,
            newer: self
                .newer
                .lock()
                .expect("plugins lock")
                .get(&source.id)
                .cloned(),
            error,
            known: self.known_source(&source.id).is_some(),
            plugins,
        }
    }

    /// The app's own list's word on a source, by stored id.
    fn known_source(&self, id: &str) -> Option<&KnownSource> {
        let name = crate::known::suffix(id)?;
        self.known.iter().find(|source| source.id == name)
    }

    /// Every source stored, and then every source the app offers that has
    /// not been fetched, as the list the window draws.
    fn list(&self) -> Vec<SourceInfo> {
        let sources = self.stored.lock().expect("plugins lock").sources.clone();
        let mut listed: Vec<SourceInfo> =
            sources.iter().map(|source| self.describe(source)).collect();
        for source in &self.known {
            let id = crate::known::stored_id(&source.id);
            if listed.iter().any(|listed| listed.id == id) {
                continue;
            }
            listed.push(offered(source));
        }
        listed
    }

    fn add(
        self: &Arc<Self>,
        location: &str,
        reference: Option<&str>,
    ) -> Result<SourceInfo, String> {
        self.add_as(None, location, reference)
    }

    /// Adds a source under the id given, or under the one its location
    /// makes when none is: a source of the user's is known by where it
    /// came from, one the app offers by the name the list gives it.
    fn add_as(
        self: &Arc<Self>,
        id: Option<&str>,
        location: &str,
        reference: Option<&str>,
    ) -> Result<SourceInfo, String> {
        let location = location.trim();
        if location.is_empty() {
            return Err("a repository URL or a directory is needed".to_string());
        }
        // The location and the ref reach git as arguments, so neither may
        // be one of git's own options.
        if location.starts_with('-') {
            return Err("a repository URL or a directory may not start with a dash".to_string());
        }
        let reference = reference
            .map(str::trim)
            .filter(|reference| !reference.is_empty());
        if let Some(reference) = reference {
            if !plain_reference(reference) {
                return Err(
                    "the ref may hold letters, digits, dot, slash, dash and underscore".to_string(),
                );
            }
        }
        let kind = kind_of(location);
        let location = if kind == "dir" {
            dunce::canonicalize(location)
                .map_err(|e| format!("could not read {location}: {e}"))?
                .to_string_lossy()
                .to_string()
        } else {
            location.to_string()
        };
        let id = id
            .map(str::to_string)
            .unwrap_or_else(|| source_id(&location));
        {
            let stored = self.stored.lock().expect("plugins lock");
            if stored.sources.iter().any(|s| s.id == id) {
                return Err("that source is already added".to_string());
            }
        }
        let source = StoredSource {
            id: id.clone(),
            kind: kind.to_string(),
            location: location.clone(),
            reference: reference.map(str::to_string),
            enabled: Vec::new(),
            built: HashMap::new(),
        };
        let dir = self.dir_of(&source);
        if kind == "git" {
            let parent = self.root.join(&id);
            let _ = std::fs::remove_dir_all(&parent);
            std::fs::create_dir_all(&parent)
                .map_err(|e| format!("could not create {parent:?}: {e}"))?;
            let mut args = vec!["clone", "--quiet", "--depth", "1"];
            if let Some(reference) = source.reference.as_deref() {
                args.extend(["--branch", reference]);
            }
            args.push("--");
            let target = dir.to_string_lossy().to_string();
            args.extend([location.as_str(), target.as_str()]);
            if let Err(error) = git(&self.root, &args) {
                let _ = std::fs::remove_dir_all(&parent);
                return Err(format!("could not clone: {error}"));
            }
        }
        if let Err(error) = read_manifest(&dir, &Self::vars()) {
            if kind == "git" {
                let _ = std::fs::remove_dir_all(self.root.join(&id));
            }
            return Err(error);
        }
        let mut stored = self.stored.lock().expect("plugins lock");
        stored.sources.push(source.clone());
        self.save(&stored)?;
        drop(stored);
        Ok(self.describe(&source))
    }

    /// Clones a source the app's own list names. The list says where the
    /// source is; its manifest says what the source holds, and is what
    /// the answer carries.
    fn fetch(self: &Arc<Self>, id: &str) -> Result<SourceInfo, String> {
        let source = self
            .known_source(id)
            .ok_or("that source is not one the app offers")?
            .clone();
        {
            let stored = self.stored.lock().expect("plugins lock");
            if stored.sources.iter().any(|s| s.id == id) {
                return Err("that source is fetched already".to_string());
            }
        }
        self.add_as(Some(id), &source.repository, source.reference.as_deref())
    }

    fn remove(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let source = {
            let mut stored = self.stored.lock().expect("plugins lock");
            let at = stored
                .sources
                .iter()
                .position(|s| s.id == id)
                .ok_or("no such source")?;
            let source = stored.sources.remove(at);
            self.save(&stored)?;
            source
        };
        for name in &source.enabled {
            self.stop(&source.id, name);
        }
        if source.kind == "git" {
            let _ = std::fs::remove_dir_all(self.root.join(&source.id));
        }
        self.newer.lock().expect("plugins lock").remove(id);
        Ok(())
    }

    fn stored_source(&self, id: &str) -> Result<StoredSource, String> {
        let stored = self.stored.lock().expect("plugins lock");
        stored
            .sources
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| "no such source".to_string())
    }

    fn check(&self, id: &str) -> Result<Option<String>, String> {
        let source = self.stored_source(id)?;
        if source.kind != "git" {
            return Ok(None);
        }
        let dir = self.dir_of(&source);
        git(&dir, &["fetch", "--quiet", "--depth", "1", "origin"])?;
        let head = commit_at(&dir, "HEAD")?;
        let upstream = match source.reference.as_deref() {
            Some(reference) => commit_at(&dir, &format!("origin/{reference}"))?,
            None => commit_at(&dir, "FETCH_HEAD")?,
        };
        let newer = if upstream != head {
            Some(upstream)
        } else {
            None
        };
        let mut found = self.newer.lock().expect("plugins lock");
        match &newer {
            Some(commit) => {
                found.insert(id.to_string(), commit.clone());
            }
            None => {
                found.remove(id);
            }
        }
        Ok(newer)
    }

    fn update(self: &Arc<Self>, id: &str) -> Result<SourceInfo, String> {
        let source = self.stored_source(id)?;
        if source.kind == "git" {
            let dir = self.dir_of(&source);
            git(&dir, &["fetch", "--quiet", "--depth", "1", "origin"])?;
            let target = match source.reference.as_deref() {
                Some(reference) => format!("origin/{reference}"),
                None => "FETCH_HEAD".to_string(),
            };
            git(&dir, &["reset", "--quiet", "--hard", &target, "--"])?;
        }
        self.newer.lock().expect("plugins lock").remove(id);
        for name in &source.enabled {
            self.stop(&source.id, name);
            self.start(&source, name);
        }
        Ok(self.describe(&source))
    }

    fn enable(self: &Arc<Self>, id: &str, name: &str, on: bool) -> Result<SourceInfo, String> {
        let source = {
            let mut stored = self.stored.lock().expect("plugins lock");
            let Some(source) = stored.sources.iter_mut().find(|s| s.id == id) else {
                return Err(if self.known_source(id).is_some() {
                    "fetch the source first".to_string()
                } else {
                    "no such source".to_string()
                });
            };
            if on && !source.enabled.iter().any(|n| n == name) {
                source.enabled.push(name.to_string());
            }
            if !on {
                source.enabled.retain(|n| n != name);
            }
            let source = source.clone();
            self.save(&stored)?;
            source
        };
        if on {
            self.start(&source, name);
        } else {
            self.stop(id, name);
        }
        Ok(self.describe(&source))
    }

    fn start_enabled(self: &Arc<Self>) {
        let sources: Vec<StoredSource> = self.stored.lock().expect("plugins lock").sources.clone();
        for source in sources {
            for name in &source.enabled {
                self.start(&source, name);
            }
        }
    }

    fn tell(
        &self,
        source: &str,
        name: &str,
        state: State,
        detail: Option<String>,
        hello: Option<Hello>,
    ) {
        let event = StateEvent {
            source: source.to_string(),
            name: name.to_string(),
            state,
            detail,
            hello,
        };
        if let Ok(value) = serde_json::to_value(event) {
            self.sink.emit(PLUGIN_STATE, value);
        }
    }

    /// The commit a source is at. A directory has none, so a plugin in one
    /// is built every time it starts, which is what writing one wants.
    fn source_commit(&self, source: &StoredSource) -> Option<String> {
        if source.kind != "git" {
            return None;
        }
        commit_at(&self.dir_of(source), "HEAD").ok()
    }

    /// Whether the build has to run: a plugin is built once per commit of
    /// its source.
    fn needs_build(&self, source: &StoredSource, name: &str) -> bool {
        let Some(commit) = self.source_commit(source) else {
            return true;
        };
        self.stored_source(&source.id)
            .map(|stored| stored.built.get(name) != Some(&commit))
            .unwrap_or(true)
    }

    fn remember_built(&self, source_id: &str, name: &str, commit: &str) {
        let mut stored = self.stored.lock().expect("plugins lock");
        if let Some(source) = stored.sources.iter_mut().find(|s| s.id == source_id) {
            source.built.insert(name.to_string(), commit.to_string());
        }
        let _ = self.save(&stored);
    }

    /// Runs a plugin's build where the plugin is, with the user's
    /// environment. What it wrote is the reason it failed.
    fn build(
        &self,
        dir: &Path,
        declared: &Declared,
        vars: &HashMap<String, String>,
    ) -> Result<(), String> {
        let program = &declared.build[0];
        let resolved = if Path::new(program).is_absolute() {
            PathBuf::from(program)
        } else {
            crate::env::find_on_path(vars, program)
                .ok_or_else(|| format!("build failed: needs {program}"))?
        };
        let output = Command::new(&resolved)
            .args(&declared.build[1..])
            .current_dir(dir.join(&declared.path))
            .env_clear()
            .envs(vars)
            .env("CHORD_PLUGIN", &declared.name)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("build failed: could not run {program}: {e}"))?;
        if output.status.success() {
            return Ok(());
        }
        let last = |bytes: &[u8]| {
            String::from_utf8_lossy(bytes)
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim().to_string())
        };
        Err(
            match last(&output.stderr).or_else(|| last(&output.stdout)) {
                Some(line) => format!("build failed: {line}"),
                None => match output.status.code() {
                    Some(code) => format!("build failed with code {code}"),
                    None => "build failed".to_string(),
                },
            },
        )
    }

    /// The build, and the process after it. On a thread of its own: a build
    /// takes as long as it takes, and the window asked for none of it.
    fn built_then_launched(
        self: &Arc<Self>,
        source: StoredSource,
        name: String,
        declared: Declared,
        failures: u32,
    ) {
        let key: Key = (source.id.clone(), name.clone());
        let dir = self.dir_of(&source);
        let vars = Self::vars();
        let mut trouble = self.build(&dir, &declared, &vars).err();
        if trouble.is_none() {
            if let Some(commit) = self.source_commit(&source) {
                self.remember_built(&source.id, &name, &commit);
            }
            // What the build was for: the script the plugin runs.
            if let Some(script) = declared.run.get(1) {
                let path = Path::new(script);
                if !script.starts_with('-')
                    && !path.is_absolute()
                    && !dir.join(&declared.path).join(path).exists()
                {
                    trouble = Some(format!("{script} is not in its directory"));
                }
            }
        }
        if let Some(why) = trouble {
            self.building
                .lock()
                .expect("plugins lock")
                .insert(key, (State::Failed, Some(why.clone())));
            self.tell(&source.id, &name, State::Failed, Some(why), None);
            return;
        }
        // A build is long enough for the plugin to have been turned off
        // while it ran.
        let still_on = self
            .stored_source(&source.id)
            .map(|stored| stored.enabled.contains(&name))
            .unwrap_or(false);
        if !still_on {
            self.building.lock().expect("plugins lock").remove(&key);
            return;
        }
        self.launch(&source, &declared, failures);
    }

    fn start(self: &Arc<Self>, source: &StoredSource, name: &str) {
        let _one_at_a_time = self.starting.lock().expect("plugins lock");
        let key: Key = (source.id.clone(), name.to_string());
        let failures = {
            let running = self.running.lock().expect("plugins lock");
            if let Some(live) = running.get(&key) {
                if matches!(live.state, State::Running | State::Starting) {
                    return;
                }
            }
            running.get(&key).map(|r| r.failures).unwrap_or(0)
        };
        if matches!(
            self.building.lock().expect("plugins lock").get(&key),
            Some((State::Building, _))
        ) {
            return;
        }
        let dir = self.dir_of(source);
        let vars = Self::vars();
        let declared = match read_manifest(&dir, &vars) {
            Ok(list) => list.into_iter().find(|d| d.name == name),
            Err(error) => {
                self.tell(&source.id, name, State::Failed, Some(error), None);
                return;
            }
        };
        let Some(declared) = declared else {
            self.tell(
                &source.id,
                name,
                State::Failed,
                Some("not in the manifest any more".to_string()),
                None,
            );
            return;
        };
        if !declared.build.is_empty() && self.needs_build(source, name) {
            self.building
                .lock()
                .expect("plugins lock")
                .insert(key, (State::Building, None));
            self.tell(&source.id, name, State::Building, None, None);
            let plugins = Arc::clone(self);
            let source = source.clone();
            let name = name.to_string();
            std::thread::spawn(move || {
                plugins.built_then_launched(source, name, declared, failures)
            });
            return;
        }
        self.launch(source, &declared, failures);
    }

    /// Starts the process and reads it until its output ends.
    fn launch(self: &Arc<Self>, source: &StoredSource, declared: &Declared, failures: u32) {
        let name = declared.name.as_str();
        let key: Key = (source.id.clone(), name.to_string());
        self.building.lock().expect("plugins lock").remove(&key);
        let dir = self.dir_of(source);
        let vars = Self::vars();
        let program = declared.run[0].clone();
        let resolved = if Path::new(&program).is_absolute() {
            PathBuf::from(&program)
        } else {
            match crate::env::find_on_path(&vars, &program) {
                Some(found) => found,
                None => {
                    self.tell(
                        &source.id,
                        name,
                        State::Failed,
                        Some(format!("needs {program}")),
                        None,
                    );
                    return;
                }
            }
        };
        let mut command = Command::new(&resolved);
        command
            .args(&declared.run[1..])
            .current_dir(dir.join(&declared.path))
            .env_clear()
            .envs(&vars)
            .env("CHORD_PLUGIN", name)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.tell(
                    &source.id,
                    name,
                    State::Failed,
                    Some(format!("could not start: {error}")),
                    None,
                );
                return;
            }
        };
        let launch = LAUNCHES.fetch_add(1, Ordering::Relaxed);
        let stdin = Arc::new(Mutex::new(child.stdin.take().expect("piped stdin")));
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        // What the plugin complains of is kept, the last few lines of it,
        // so a plugin that dies can say why on its row.
        let complaints = Arc::new(Mutex::new(VecDeque::new()));
        let (read_to_end, complained) = std::sync::mpsc::channel::<()>();
        {
            let complaints = Arc::clone(&complaints);
            std::thread::spawn(move || {
                let _read_to_end = read_to_end;
                for line in BufReader::new(stderr).lines() {
                    let Ok(line) = line else { break };
                    if line.trim().is_empty() {
                        continue;
                    }
                    if let Ok(mut kept) = complaints.lock() {
                        if kept.len() == COMPLAINTS {
                            kept.pop_front();
                        }
                        kept.push_back(line);
                    }
                }
            });
        }
        // The greeting comes before anything else the plugin is told: the
        // app's version and the projects open on this machine. The sessions
        // running already follow it, each as it would have started. The
        // sessions stay locked until the process is listed, so one starting
        // meanwhile is told in the list or by the broadcast that follows.
        let projects = self.projects.lock().expect("plugins lock").clone();
        let hello = serde_json::json!({
            "type": "hello",
            "app": env!("CARGO_PKG_VERSION"),
            "projects": projects,
        });
        let ptys = self.ptys.lock().expect("plugins lock");
        if let Ok(mut pipe) = stdin.lock() {
            let _ = writeln!(pipe, "{hello}");
            for line in ptys.values().filter_map(|pty| session_line("started", pty)) {
                let _ = writeln!(pipe, "{line}");
            }
            let _ = pipe.flush();
        }
        {
            let mut running = self.running.lock().expect("plugins lock");
            let displaced = running.insert(
                key.clone(),
                Running {
                    child,
                    launch,
                    stdin,
                    state: State::Starting,
                    detail: None,
                    hello: None,
                    failures,
                    complaints,
                    complained,
                    commands: declared.commands.clone(),
                },
            );
            // A process that is still going when the next one takes its
            // place is asked to stop already; it is ended and collected
            // here, since the stop waiting on it only follows its own launch.
            if let Some(old) = displaced {
                reap(old.child);
            }
        }
        drop(ptys);
        self.tell(&source.id, name, State::Starting, None, None);

        // The reader: the greeting first, then whatever the plugin says,
        // until its output ends, which is the process going.
        let plugins = Arc::clone(self);
        let source_id = source.id.clone();
        let plugin = name.to_string();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut greeted = false;
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if !plugins.heard(&source_id, &plugin, launch, &mut greeted, &line) {
                    break;
                }
            }
            plugins.exited(&source_id, &plugin, launch, greeted);
        });
    }

    /// One line a plugin's process wrote, as its reader takes it: the
    /// greeting, an answer, or something the plugin says of its own accord.
    /// A reader speaks only for the process it reads. Once another process
    /// is under the key, what the earlier one wrote is nobody's news, and
    /// false tells its reader to stop. An answer is the exception: it goes
    /// to whoever asked, whichever process was asked, but only while the
    /// reader is reading: a stale line ahead of it ends the reader, and an
    /// answer behind that line is not taken.
    ///
    /// While stop waits for the process to go, its state is off and its
    /// lines are not kept: the sections and views it was asked to forget stay
    /// forgotten. The reader keeps reading so the process can finish.
    fn heard(
        self: &Arc<Self>,
        source_id: &str,
        name: &str,
        launch: u64,
        greeted: &mut bool,
        line: &str,
    ) -> bool {
        let Ok(message) = serde_json::from_str::<serde_json::Value>(line) else {
            return true;
        };
        let key: Key = (source_id.to_string(), name.to_string());
        let kind = message.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if kind == "result" {
            self.answered(source_id, name, &message);
            return true;
        }
        if kind == "hello" && !*greeted {
            *greeted = true;
            let hello: Option<Hello> = serde_json::from_value(message.clone()).ok();
            {
                let mut running = self.running.lock().expect("plugins lock");
                let Some(live) = running.get_mut(&key).filter(|live| live.launch == launch) else {
                    return false;
                };
                if live.state == State::Off {
                    return true;
                }
                live.state = State::Running;
                live.failures = 0;
                live.hello = hello.clone();
                live.detail = None;
            }
            self.publish();
            self.tell(source_id, name, State::Running, None, hello);
            return true;
        }
        let mine = self
            .running
            .lock()
            .expect("plugins lock")
            .get(&key)
            .map(|live| (live.launch == launch, live.state != State::Off));
        match mine {
            Some((true, true)) => {
                self.said(source_id, name, kind, &message);
                true
            }
            Some((true, false)) => true,
            _ => false,
        }
    }

    /// The process is gone: said so, and started again after a pause when
    /// it is still on and nothing here asked it to go. A process stop ended
    /// is marked off before it is told, and whoever stopped it starts the
    /// next one, so the reader does not start one of its own as well.
    ///
    /// Stop can see the process end, and the next one start, before the
    /// reader gets here. The reader then finds that next process under the
    /// key, which is not the one it read, and leaves it alone.
    fn exited(self: &Arc<Self>, source_id: &str, name: &str, launch: u64, greeted: bool) {
        let key: Key = (source_id.to_string(), name.to_string());
        let enabled = {
            let stored = self.stored.lock().expect("plugins lock");
            stored
                .sources
                .iter()
                .any(|s| s.id == source_id && s.enabled.iter().any(|n| n == name))
        };
        let (still_on, failures, detail) = {
            let mut running = self.running.lock().expect("plugins lock");
            let Some(live) = running.get_mut(&key).filter(|live| live.launch == launch) else {
                return;
            };
            let still_on = enabled && live.state != State::Off;
            // Its output has ended, which is as gone as a plugin gets: a
            // process that closed its output and stayed is ended here, or
            // the wait would hold the lock for as long as it lived.
            let _ = live.child.kill();
            let code = live.child.wait().ok().and_then(|status| status.code());
            // Its output ending says nothing of whether its last complaint
            // has been read yet.
            let _ = live.complained.recv_timeout(LAST_WORDS);
            live.failures = if greeted { 0 } else { live.failures + 1 };
            let complaint = live
                .complaints
                .lock()
                .ok()
                .and_then(|kept| kept.back().cloned());
            live.detail = match (code, complaint) {
                (Some(0) | None, _) => None,
                (Some(code), None) => Some(format!("exited with code {code}")),
                (Some(code), Some(line)) => Some(format!("exited with code {code}: {line}")),
            };
            live.hello = None;
            let gave_up = !greeted && live.failures >= TRIES;
            if gave_up {
                live.state = State::Failed;
                live.detail = Some(match live.detail.take() {
                    Some(why) => format!("stopped after {TRIES} tries: {why}"),
                    None => format!("stopped after {TRIES} tries"),
                });
            } else {
                live.state = if still_on { State::Stopped } else { State::Off };
            }
            let out = (still_on, live.failures, live.detail.clone());
            if !still_on {
                running.remove(&key);
            }
            out
        };
        // Its actions are answered by no one now, and the next process
        // under its name opens nothing for them.
        self.pending
            .lock()
            .expect("plugins lock")
            .retain(|_, waiting| waiting.plugin != key);
        self.publish();
        self.forget_sections(source_id, name);
        self.forget_views(source_id, name);
        if !still_on {
            self.tell(source_id, name, State::Off, None, None);
            return;
        }
        if !greeted && failures >= TRIES {
            self.tell(source_id, name, State::Failed, detail, None);
            return;
        }
        self.tell(source_id, name, State::Stopped, detail, None);
        // A growing pause between tries, capped: a plugin that dies at once
        // is not started a hundred times a second.
        let pause = Duration::from_millis(500 * 2u64.pow(failures.min(6)));
        let plugins = Arc::clone(self);
        let source_id = source_id.to_string();
        let name = name.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(pause);
            if let Ok(source) = plugins.stored_source(&source_id) {
                if source.enabled.contains(&name) {
                    plugins.start(&source, &name);
                }
            }
        });
    }

    /// Asks the process to stop, and ends it when it has not gone in time.
    ///
    /// Only the process that was running when this began is waited for and
    /// ended. When it is slow to go and the plugin is turned on again, the
    /// next process is under the key and is left alone.
    fn stop(&self, source_id: &str, name: &str) {
        let key: Key = (source_id.to_string(), name.to_string());
        self.building.lock().expect("plugins lock").remove(&key);
        let (launch, stdin) = {
            let mut running = self.running.lock().expect("plugins lock");
            let Some(live) = running.get_mut(&key) else {
                return;
            };
            live.state = State::Off;
            (live.launch, Arc::clone(&live.stdin))
        };
        self.publish();
        self.forget_sections(source_id, name);
        self.forget_views(source_id, name);
        if let Ok(mut stdin) = stdin.lock() {
            let _ = writeln!(stdin, r#"{{"type":"stop"}}"#);
            let _ = stdin.flush();
        }
        for tries in 0..20 {
            if tries > 0 {
                std::thread::sleep(Duration::from_millis(100));
            }
            let mut running = self.running.lock().expect("plugins lock");
            match running.get_mut(&key).filter(|live| live.launch == launch) {
                Some(live) => {
                    if let Ok(Some(_)) = live.child.try_wait() {
                        running.remove(&key);
                        return;
                    }
                }
                None => return,
            }
        }
        let mut running = self.running.lock().expect("plugins lock");
        if running.get(&key).is_some_and(|live| live.launch == launch) {
            if let Some(mut live) = running.remove(&key) {
                let _ = live.child.kill();
                let _ = live.child.wait();
            }
        }
    }

    /// The tools of the plugins that are running, in a fixed order so the
    /// agent sees the same list twice running.
    fn tools(&self) -> Vec<PublishedTool> {
        let running = self.running.lock().expect("plugins lock");
        let mut tools = Vec::new();
        for ((source, plugin), live) in running.iter() {
            if live.state != State::Running {
                continue;
            }
            let Some(hello) = &live.hello else {
                continue;
            };
            for declared in &hello.tools {
                let Some(tool) = declared.get("name").and_then(|name| name.as_str()) else {
                    continue;
                };
                if tool.is_empty() {
                    continue;
                }
                tools.push(PublishedTool {
                    name: format!("{plugin}_{tool}"),
                    description: declared
                        .get("description")
                        .and_then(|text| text.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    input_schema: declared
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(any_object),
                    source: source.clone(),
                    plugin: plugin.clone(),
                    tool: tool.to_string(),
                });
            }
        }
        tools.sort_by(|a, b| a.name.cmp(&b.name));
        tools
    }

    /// Writes the tools out for the tool server, which reads the file as
    /// the agent asks. Written whole and moved into place, so a reader
    /// sees one list or the other and never half of one. Says too whether
    /// an enabled plugin listens for commands, for the hooks.
    fn publish(&self) {
        let hears = self
            .running
            .lock()
            .expect("plugins lock")
            .values()
            .any(|live| live.state != State::Off && !live.commands.is_empty());
        if crate::hook::set_hears_commands(&self.home, hears) {
            crate::events::emit(
                &self.sink,
                PLUGIN_HEARS,
                &serde_json::json!({ "hears": hears }),
            );
        }
        let Ok(text) = serde_json::to_string(&self.tools()) else {
            return;
        };
        let path = tools_path(&self.home);
        let Some(parent) = path.parent() else {
            return;
        };
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
        let temporary = path.with_extension("json.tmp");
        if std::fs::write(&temporary, text).is_err() {
            return;
        }
        if std::fs::rename(&temporary, &path).is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
    }

    fn call(&self, request: ToolRequest) {
        // A call for a source this core has never heard of belongs to
        // another core reading the same log, an app and a daemon sharing a
        // home above all: theirs to answer, and nothing to say here.
        if !self.knows(&request.source) {
            return;
        }
        // The tool server names the calling session by its token. A plugin
        // knows sessions by the agent's own id, which the session events
        // carry, so the call names that, or none where it is not known.
        let session = request
            .session
            .as_deref()
            .and_then(|token| self.session_of(token));
        let message = serde_json::json!({
            "type": "tool",
            "id": request.id,
            "name": request.tool,
            "arguments": request.arguments,
            "project": request.cwd,
            "session": session,
        });
        if let Err(error) = self.send(&request.source, &request.plugin, &message) {
            let _ = crate::show::write_answer(
                &self.home,
                &request.id,
                &Answer {
                    content: None,
                    error: Some(error),
                },
            );
        }
    }

    /// Whether a source is one of this core's own.
    fn knows(&self, source_id: &str) -> bool {
        self.stored
            .lock()
            .expect("plugins lock")
            .sources
            .iter()
            .any(|source| source.id == source_id)
    }

    /// A plugin's answer to a call, written where the tool server waits.
    /// An action's answer is not a tool's: the window hears what went
    /// wrong and nothing else, since an action that has something to show
    /// shows it as rows, a place, a diff, media or a line.
    fn answered(&self, source_id: &str, name: &str, message: &serde_json::Value) {
        let Some(id) = message.get("id").and_then(|id| id.as_str()) else {
            return;
        };
        // Content of any shape reaches the agent as text: a string as it
        // is, anything else as the JSON the plugin wrote.
        let text = |value: &serde_json::Value| match value.as_str() {
            Some(text) => text.to_string(),
            None => serde_json::to_string(value).unwrap_or_default(),
        };
        if self
            .pending
            .lock()
            .expect("plugins lock")
            .remove(id)
            .is_some()
        {
            if let Some(error) = message.get("error").filter(|error| !error.is_null()) {
                crate::events::emit(
                    &self.sink,
                    PLUGIN_NOTICE,
                    &Notice {
                        source: source_id.to_string(),
                        plugin: name.to_string(),
                        text: text(error),
                    },
                );
            }
            return;
        }
        let content = match message.get("content") {
            Some(content) if !content.is_null() => text(content),
            _ => String::new(),
        };
        let answer = match message.get("error") {
            Some(error) if !error.is_null() => Answer {
                content: None,
                error: Some(text(error)),
            },
            _ => Answer {
                content: Some(content),
                error: None,
            },
        };
        let _ = crate::show::write_answer(&self.home, id, &answer);
    }

    /// A line from a plugin that is neither its greeting nor an answer:
    /// rows for a section, or one of the asks the agent's own tools make.
    /// A kind nobody knows is left alone.
    fn said(&self, source_id: &str, name: &str, kind: &str, message: &serde_json::Value) {
        match kind {
            "section" => {
                // Rows for a session name it by the agent's id; the window
                // knows it by its token, and rows for a session not running
                // here are for no row the window has.
                let agent_id = message
                    .get("session")
                    .and_then(|session| session.as_str())
                    .map(str::trim)
                    .filter(|session| !session.is_empty());
                let token = match agent_id {
                    Some(id) => match self.token_of(id) {
                        Some(token) => Some(token),
                        None => return,
                    },
                    None => None,
                };
                let hello = self.greeting(source_id, name);
                let Some(section) =
                    checked_section(source_id, name, message, hello.as_ref(), token)
                else {
                    return;
                };
                let key: SectionKey = (
                    source_id.to_string(),
                    name.to_string(),
                    section.section.clone(),
                    section.project.clone(),
                    agent_id.unwrap_or_default().to_string(),
                );
                self.sections
                    .lock()
                    .expect("plugins lock")
                    .insert(key, section.clone());
                self.tell_section(&section);
            }
            "view" => self.viewed(source_id, name, message),
            "view_data" => self.view_data(source_id, name, message),
            "open" | "diff" | "present" | "notify" => self.requested(kind, message),
            "mark" => self.marked(source_id, name, message),
            "open_url" => self.open_url(source_id, name, message),
            _ => {}
        }
    }

    /// One `mark` line from a plugin: its mark on a session's row, or the
    /// mark gone when the line has no icon. A mark on a session not running
    /// here is for no row and is dropped.
    fn marked(&self, source_id: &str, name: &str, message: &serde_json::Value) {
        let text = |key: &str| {
            message
                .get(key)
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        // The session's own project, whatever the message names, so a
        // session carries one mark of a plugin's.
        let Some(session) = text("session") else {
            return;
        };
        let Some((token, project)) = self.place_of(&session) else {
            return;
        };
        let icon = text("icon").map(|icon| {
            if ICONS.contains(&icon.as_str()) {
                icon
            } else {
                "dot".to_string()
            }
        });
        let key: MarkKey = (
            source_id.to_string(),
            name.to_string(),
            project.clone(),
            session,
        );
        let mark = MarkEvent {
            source: source_id.to_string(),
            plugin: name.to_string(),
            project,
            session: token,
            count: icon.as_ref().and_then(|_| {
                message
                    .get("count")
                    .and_then(|count| count.as_u64())
                    .filter(|count| *count > 0)
                    .map(|count| u32::try_from(count).unwrap_or(u32::MAX))
            }),
            state: icon
                .as_ref()
                .and_then(|_| text("state").filter(|state| STATES.contains(&state.as_str()))),
            label: icon
                .as_ref()
                .and_then(|_| text("label"))
                .map(|label| crate::show::one_line(&label)),
            icon,
        };
        {
            let mut marks = self.marks.lock().expect("plugins lock");
            if mark.icon.is_some() {
                marks.insert(key, mark.clone());
            } else if marks.remove(&key).is_none() {
                return;
            }
        }
        crate::events::emit(&self.sink, PLUGIN_MARK, &mark);
    }

    /// The marks a plugin left go with it, or the marks on a session that
    /// ended: each is told gone and forgotten.
    fn forget_marks(&self, gone: impl Fn(&MarkKey) -> bool) {
        let cleared: Vec<MarkEvent> = {
            let mut marks = self.marks.lock().expect("plugins lock");
            let keys: Vec<MarkKey> = marks.keys().filter(|key| gone(key)).cloned().collect();
            keys.iter().filter_map(|key| marks.remove(key)).collect()
        };
        for mark in cleared {
            crate::events::emit(
                &self.sink,
                PLUGIN_MARK,
                &MarkEvent {
                    icon: None,
                    count: None,
                    state: None,
                    label: None,
                    ..mark
                },
            );
        }
    }

    /// One `open_url` line from a plugin: a web address for the user's
    /// browser, for the action it names. Only http and https open, one for
    /// each action, while that action waits for its result and for 30
    /// seconds at most after it was sent, so the browser opens when the
    /// user asked something of the plugin and at no other time.
    fn open_url(&self, source_id: &str, name: &str, message: &serde_json::Value) {
        let text = |key: &str| {
            message
                .get(key)
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
        };
        let (Some(project), Some(url), Some(action)) =
            (text("project"), text("url"), text("action"))
        else {
            return;
        };
        if !web_address(url) {
            return;
        }
        let key: Key = (source_id.to_string(), name.to_string());
        {
            let mut pending = self.pending.lock().expect("plugins lock");
            match pending.get_mut(action) {
                Some(waiting) if waiting.may_open(&key, Instant::now()) => waiting.opened = true,
                _ => return,
            }
        }
        crate::events::emit(
            &self.sink,
            PLUGIN_OPEN_URL,
            &OpenUrl {
                source: source_id.to_string(),
                plugin: name.to_string(),
                project: project.to_string(),
                url: url.to_string(),
            },
        );
    }

    /// The room a plugin's view asks for and the directory its pages come
    /// from, or None when the manifest declares no view.
    fn declared_view(&self, source_id: &str, name: &str) -> Option<(PathBuf, String)> {
        let source = self.stored_source(source_id).ok()?;
        let dir = self.dir_of(&source);
        let declared = read_manifest(&dir, &Self::vars())
            .ok()?
            .into_iter()
            .find(|declared| declared.name == name)?;
        let width = match declared.view.as_deref() {
            Some("full") => "full",
            Some(_) => "wide",
            None => return None,
        };
        Some((dir.join(&declared.path), width.to_string()))
    }

    /// One `view` line from a plugin: the page for one project, inline or
    /// from a file of the plugin's own directory. The latest page per
    /// project is kept, so what the plugin leaves in the viewer goes with
    /// it.
    fn viewed(&self, source_id: &str, name: &str, message: &serde_json::Value) {
        let text = |key: &str| {
            message
                .get(key)
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
        };
        let Some(project) = text("project") else {
            return;
        };
        let Some((dir, width)) = self.declared_view(source_id, name) else {
            return;
        };
        let html = match message.get("html").and_then(|value| value.as_str()) {
            Some(html) => html.to_string(),
            None => {
                let Some(path) = text("path").and_then(|path| page_path(&dir, path)) else {
                    return;
                };
                let Ok(html) = std::fs::read_to_string(path) else {
                    return;
                };
                html
            }
        };
        let view = ViewEvent {
            source: source_id.to_string(),
            plugin: name.to_string(),
            project: project.to_string(),
            width,
            html,
            open: message
                .get("open")
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
        };
        let key: ViewKey = (
            source_id.to_string(),
            name.to_string(),
            view.project.clone(),
        );
        self.views
            .lock()
            .expect("plugins lock")
            .insert(key, view.clone());
        crate::events::emit(&self.sink, PLUGIN_VIEW, &view);
    }

    /// One `view_data` line from a plugin: a message for the page it has
    /// for a project, which is of use while the page is open and is kept
    /// nowhere.
    fn view_data(&self, source_id: &str, name: &str, message: &serde_json::Value) {
        let project = message
            .get("project")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .unwrap_or_default();
        if project.is_empty() {
            return;
        }
        crate::events::emit(
            &self.sink,
            PLUGIN_VIEW_DATA,
            &ViewData {
                source: source_id.to_string(),
                plugin: name.to_string(),
                project: project.to_string(),
                data: message
                    .get("data")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            },
        );
    }

    /// The page a plugin left in the viewer goes with it: every project it
    /// had one for is told of an empty page and forgotten.
    fn forget_views(&self, source_id: &str, name: &str) {
        let gone: Vec<ViewEvent> = {
            let mut views = self.views.lock().expect("plugins lock");
            let keys: Vec<ViewKey> = views
                .keys()
                .filter(|(source, plugin, _)| source == source_id && plugin == name)
                .cloned()
                .collect();
            keys.iter().filter_map(|key| views.remove(key)).collect()
        };
        for view in gone {
            crate::events::emit(
                &self.sink,
                PLUGIN_VIEW,
                &ViewEvent {
                    html: String::new(),
                    open: false,
                    ..view
                },
            );
        }
    }

    /// What a running plugin said of itself as it came up, which is where
    /// the order of its sections is written down.
    fn greeting(&self, source_id: &str, name: &str) -> Option<Hello> {
        self.running
            .lock()
            .expect("plugins lock")
            .get(&(source_id.to_string(), name.to_string()))
            .and_then(|live| live.hello.clone())
    }

    fn tell_section(&self, section: &SectionEvent) {
        crate::events::emit(&self.sink, PLUGIN_SECTION, section);
    }

    /// The rows a plugin left on the tree go with it: every section it had
    /// is told empty and forgotten.
    fn forget_sections(&self, source_id: &str, name: &str) {
        self.forget_marks(|(source, plugin, _, _)| source == source_id && plugin == name);
        self.drop_sections(|(source, plugin, _, _, _)| source == source_id && plugin == name);
    }

    /// Tells each kept section the test picks empty, and forgets it.
    fn drop_sections(&self, gone: impl Fn(&SectionKey) -> bool) {
        let gone: Vec<SectionEvent> = {
            let mut sections = self.sections.lock().expect("plugins lock");
            let keys: Vec<SectionKey> = sections.keys().filter(|key| gone(key)).cloned().collect();
            keys.iter().filter_map(|key| sections.remove(key)).collect()
        };
        for section in gone {
            self.tell_section(&SectionEvent {
                rows: Vec::new(),
                actions: Vec::new(),
                detail: None,
                ..section
            });
        }
    }

    /// What the agent's own tools ask for, asked for by a plugin: a place
    /// to open, a file's diff, media, or a line for a session's row. A
    /// path is taken from the project, which is where the plugin looks.
    fn requested(&self, kind: &str, message: &serde_json::Value) {
        let text = |key: &str| {
            message
                .get(key)
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        let Some(project) = text("project") else {
            return;
        };
        let root = PathBuf::from(&project);
        let absolute = |path: &str| {
            crate::show::resolve(&root, path)
                .to_string_lossy()
                .to_string()
        };
        match kind {
            "open" => {
                let Some(path) = text("path") else {
                    return;
                };
                let line = |key: &str, fallback: u64| {
                    message
                        .get(key)
                        .and_then(|value| value.as_u64())
                        .unwrap_or(fallback)
                        .clamp(1, u32::MAX as u64) as u32
                };
                let from = line("from", 1);
                crate::events::emit(
                    &self.sink,
                    SHOW_REQUEST,
                    &ShowRequest {
                        path: absolute(&path),
                        from,
                        to: line("to", from as u64).max(from),
                        note: text("note"),
                        cwd: project,
                        session: None,
                    },
                );
            }
            "diff" => {
                let Some(path) = text("path") else {
                    return;
                };
                crate::events::emit(
                    &self.sink,
                    DIFF_REQUEST,
                    &DiffRequest {
                        path: absolute(&path),
                        note: text("note"),
                        cwd: project,
                        session: None,
                    },
                );
            }
            "present" => {
                let files: Vec<String> = message
                    .get("files")
                    .and_then(|files| files.as_array())
                    .map(|files| {
                        files
                            .iter()
                            .filter_map(|file| file.as_str())
                            .map(str::trim)
                            .filter(|file| !file.is_empty())
                            .map(absolute)
                            .collect()
                    })
                    .unwrap_or_default();
                if files.is_empty() {
                    return;
                }
                crate::events::emit(
                    &self.sink,
                    PRESENT_REQUEST,
                    &PresentRequest {
                        files,
                        caption: text("caption"),
                        cwd: project,
                        session: None,
                    },
                );
            }
            "notify" => {
                let Some(said) = text("text") else {
                    return;
                };
                let line = crate::show::one_line(&said);
                if line.is_empty() {
                    return;
                }
                // The plugin names the session by the agent's own id, as
                // the session events give it; the window knows a session
                // only by its token, so the line names that, or none.
                crate::events::emit(
                    &self.sink,
                    NOTIFY_REQUEST,
                    &NotifyRequest {
                        text: line,
                        cwd: project,
                        session: text("session").and_then(|id| self.token_of(&id)),
                    },
                );
            }
            _ => {}
        }
    }

    /// Hands an action to the plugin and comes back: the answer, if it is
    /// an error, reaches the window as a notice.
    #[allow(clippy::too_many_arguments)]
    fn action(
        &self,
        source_id: &str,
        name: &str,
        section: &str,
        action: &str,
        row: Option<&str>,
        input: &serde_json::Value,
        project: &str,
        session: Option<&str>,
    ) -> Result<(), String> {
        let id = uuid::Uuid::new_v4().to_string();
        let mut message = serde_json::json!({
            "type": "action",
            "id": id,
            "section": section,
            "action": action,
            "row": row,
            "input": input,
            "project": project,
        });
        // The window names a session by its token; the plugin hears the
        // agent's id, as its session lines give it.
        if let Some(session) = session.and_then(|token| self.session_of(token)) {
            message["session"] = serde_json::Value::String(session);
        }
        self.pending.lock().expect("plugins lock").insert(
            id.clone(),
            Waiting {
                plugin: (source_id.to_string(), name.to_string()),
                sent: Instant::now(),
                opened: false,
            },
        );
        if let Err(error) = self.send(source_id, name, &message) {
            self.pending.lock().expect("plugins lock").remove(&id);
            return Err(error);
        }
        Ok(())
    }

    fn set_projects(&self, paths: Vec<String>) {
        let changes: Vec<(&str, String)> = {
            let mut projects = self.projects.lock().expect("plugins lock");
            let mut changes = Vec::new();
            for path in &paths {
                if !projects.contains(path) {
                    changes.push(("opened", path.clone()));
                }
            }
            for path in projects.iter() {
                if !paths.contains(path) {
                    changes.push(("closed", path.clone()));
                }
            }
            *projects = paths;
            changes
        };
        for (event, path) in changes {
            self.broadcast(&serde_json::json!({
                "type": "project",
                "event": event,
                "path": path,
            }));
        }
    }

    fn tree_moved(&self, root: &str) {
        let projects = self.projects.lock().expect("plugins lock").clone();
        for project in projects.into_iter().filter(|project| inside(root, project)) {
            self.broadcast(&serde_json::json!({ "type": "tree", "project": project }));
        }
    }

    /// The agent's own id for the session the tools name by this token,
    /// when a session this core started has both.
    fn session_of(&self, token: &str) -> Option<String> {
        self.ptys
            .lock()
            .expect("plugins lock")
            .values()
            .find(|pty| pty.token.as_deref() == Some(token))
            .and_then(|pty| pty.session.clone())
    }

    /// The token the tools of the session with this agent id name it by,
    /// when a session this core started has both. An id two running
    /// sessions were given different tokens under names neither.
    fn token_of(&self, session: &str) -> Option<String> {
        let ptys = self.ptys.lock().expect("plugins lock");
        let mut tokens = ptys
            .values()
            .filter(|pty| pty.session.as_deref() == Some(session))
            .filter_map(|pty| pty.token.clone());
        let token = tokens.next()?;
        tokens.all(|other| other == token).then_some(token)
    }

    /// The token and the project of the session with this agent id, by the
    /// same rule as `token_of`.
    fn place_of(&self, session: &str) -> Option<(String, String)> {
        let ptys = self.ptys.lock().expect("plugins lock");
        let mut places = ptys
            .values()
            .filter(|pty| pty.session.as_deref() == Some(session))
            .filter_map(|pty| Some((pty.token.clone()?, pty.project.clone())));
        let place = places.next()?;
        places.all(|other| other == place).then_some(place)
    }

    fn session_started(&self, pty_id: &str, started: Started) {
        let pty = Pty {
            session: started.session.map(str::to_string),
            token: started.token.map(str::to_string),
            project: started.project.to_string(),
            cwd: started.cwd.to_string(),
            starter: started.starter.map(str::to_string),
            worktree: started.worktree,
            branch: started
                .branch
                .filter(|branch| started.worktree && !branch.is_empty())
                .map(str::to_string),
        };
        let line = session_line("started", &pty);
        self.ptys
            .lock()
            .expect("plugins lock")
            .insert(pty_id.to_string(), pty);
        if let Some(line) = line {
            self.broadcast(&line);
        }
    }

    fn session_identified(&self, pty_id: &str, session: &str) {
        let line = {
            let mut ptys = self.ptys.lock().expect("plugins lock");
            let Some(pty) = ptys.get_mut(pty_id) else {
                return;
            };
            if pty.session.is_some() {
                return;
            }
            pty.session = Some(session.to_string());
            session_line("started", pty)
        };
        if let Some(line) = line {
            self.broadcast(&line);
        }
    }

    /// A pty ended: the plugins hear the session ended, and what they put
    /// on it, its sections and its marks, goes with it unless another pty
    /// still runs the session.
    fn session_ended(&self, pty_id: &str) {
        let (gone, still) = {
            let mut ptys = self.ptys.lock().expect("plugins lock");
            let gone = ptys.remove(pty_id);
            let still = gone
                .as_ref()
                .and_then(|pty| pty.session.as_ref())
                .is_some_and(|id| {
                    ptys.values()
                        .any(|other| other.session.as_ref() == Some(id))
                });
            (gone, still)
        };
        let Some(pty) = gone else {
            return;
        };
        let Some(line) = session_line("ended", &pty) else {
            return;
        };
        self.broadcast(&line);
        if still {
            return;
        }
        let Some(id) = pty.session.filter(|id| !id.is_empty()) else {
            return;
        };
        self.drop_sections(|(_, _, _, _, session)| session == &id);
        self.forget_marks(|(_, _, _, session)| session == &id);
    }

    fn command_ran(&self, ran: Ran) {
        let (session, project, cwd) = {
            let ptys = self.ptys.lock().expect("plugins lock");
            let pty = match ran.pty {
                Some(id) => ptys.get(id),
                None => ran.session.and_then(|session| {
                    ptys.values()
                        .find(|pty| pty.session.as_deref() == Some(session))
                }),
            };
            let Some(pty) = pty else {
                return;
            };
            let Some(session) = pty.session.clone().filter(|id| !id.is_empty()) else {
                return;
            };
            let cwd = ran
                .cwd
                .filter(|cwd| !cwd.is_empty())
                .map_or_else(|| pty.cwd.clone(), str::to_string);
            (session, pty.project.clone(), cwd)
        };
        let parts = command_parts(ran.command);
        let listening: Vec<(Arc<Mutex<ChildStdin>>, Vec<usize>)> = {
            let running = self.running.lock().expect("plugins lock");
            running
                .values()
                .filter(|live| matches!(live.state, State::Starting | State::Running))
                .filter_map(|live| {
                    let heard: Vec<usize> = (0..parts.len())
                        .filter(|at| runs(&parts[*at], &live.commands))
                        .collect();
                    (!heard.is_empty()).then(|| (Arc::clone(&live.stdin), heard))
                })
                .collect()
        };
        if listening.is_empty() {
            return;
        }
        if !ran.call.is_empty() {
            let mut told = self.told.lock().expect("plugins lock");
            let key = (session.clone(), ran.call.to_string());
            if told.contains(&key) {
                return;
            }
            if told.len() == COMMANDS_TOLD {
                told.pop_front();
            }
            told.push_back(key);
        }
        for (stdin, heard) in listening {
            for at in heard {
                let output = output_of(&parts, at, ran.output).map(output_end);
                let message = serde_json::json!({
                    "type": "command",
                    "project": project,
                    "session": session,
                    "cwd": cwd,
                    "command": parts[at].text,
                    "ok": ran.ok,
                    "output": output.map(|(output, _)| output),
                    "truncated": output.is_some_and(|(_, cut)| cut || ran.truncated),
                    "withheld": output.is_none(),
                });
                if let Ok(mut stdin) = stdin.lock() {
                    let _ = writeln!(stdin, "{message}");
                    let _ = stdin.flush();
                }
            }
        }
    }

    /// Writes a line to every plugin whose process is up.
    fn broadcast(&self, message: &serde_json::Value) {
        let stdins: Vec<Arc<Mutex<ChildStdin>>> = {
            let running = self.running.lock().expect("plugins lock");
            running
                .values()
                .filter(|live| matches!(live.state, State::Starting | State::Running))
                .map(|live| Arc::clone(&live.stdin))
                .collect()
        };
        for stdin in stdins {
            if let Ok(mut stdin) = stdin.lock() {
                let _ = writeln!(stdin, "{message}");
                let _ = stdin.flush();
            }
        }
    }

    fn send(&self, source_id: &str, name: &str, message: &serde_json::Value) -> Result<(), String> {
        let stdin = {
            let running = self.running.lock().expect("plugins lock");
            let live = running
                .get(&(source_id.to_string(), name.to_string()))
                .ok_or("the plugin is not running")?;
            Arc::clone(&live.stdin)
        };
        let mut stdin = stdin.lock().map_err(|_| "the plugin's input is poisoned")?;
        writeln!(stdin, "{message}").map_err(|e| format!("could not write to the plugin: {e}"))?;
        stdin.flush().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    // The fixtures that run a shell script are unix only, and so are the
    // tests that use them; what only they use is unused on Windows.
    #![allow(dead_code)]
    use super::*;
    use crate::events::testing::Recorder;
    use crate::scratch::Scratch;

    /// A session starting in its project's own folder, started by no one.
    fn started<'a>(
        session: Option<&'a str>,
        token: Option<&'a str>,
        project: &'a str,
    ) -> Started<'a> {
        Started {
            session,
            token,
            project,
            cwd: project,
            starter: None,
            worktree: false,
            branch: None,
        }
    }

    fn vars() -> HashMap<String, String> {
        HashMap::from([(
            "PATH".to_string(),
            std::env::var("PATH").unwrap_or_default(),
        )])
    }

    /// A core with no source offered out of the box, so a test sees the
    /// sources it adds and nothing else.
    fn plugins_at(home: &Path, sink: Arc<dyn Sink>) -> Plugins {
        Plugins::with_known(home, sink, Vec::new())
    }

    fn source_with(manifest: &str, name: &str) -> Scratch {
        let dir = Scratch::new(&format!("plugins-{name}"));
        std::fs::create_dir_all(dir.join("github")).unwrap();
        std::fs::write(dir.join("github/main.sh"), "#!/bin/sh\n").unwrap();
        std::fs::write(dir.join(MANIFEST), manifest).unwrap();
        dir
    }

    /// A plugin that says its rows, points at a place, leaves a line, and
    /// answers an action with what went wrong.
    #[cfg(unix)]
    const SECTIONS: &str = r#"#!/bin/sh
echo '{"type":"hello","name":"board","version":"1.0.0","sections":[{"id":"checks"},{"id":"pull-request"}]}'
echo '{"type":"section","id":"pull-request","title":"Pull request","detail":"main, 2 ahead","folded":true,"project":"PROJECT","rows":[{"id":"lint","label":"lint","detail":"3 of 4","state":"ok","actions":[{"id":"open","label":"Open"}],"default":"open"},{"id":"","label":"nothing"}],"actions":[{"id":"refresh","label":"Refresh","input":[{"id":"branch","label":"Branch","kind":"text"}]}]}'
echo '{"type":"open","project":"PROJECT","path":"github/main.sh","from":3,"to":5,"note":"here"}'
echo '{"type":"notify","project":"PROJECT","session":"s-1","text":"   needs   a   key   "}'
echo '{"type":"whatever","project":"PROJECT"}'
while IFS= read -r line; do
  case "$line" in
    *'"type":"stop"'*) exit 0;;
    *'"type":"action"'*)
      id=$(printf '%s' "$line" | sed 's/.*"id":"\([^"]*\)".*/\1/')
      printf '{"type":"result","id":"%s","error":"gh is not logged in"}\n' "$id"
      ;;
  esac
done
"#;

    /// A plugin with a view: a page of its own, inline and from a file,
    /// one from outside its directory, data for the page, and whatever the
    /// page sends back.
    #[cfg(unix)]
    const PAGES: &str = r#"#!/bin/sh
echo '{"type":"hello","name":"pages","version":"1.0.0"}'
echo '{"type":"view","project":"PROJECT","html":"<h1>Board</h1>","open":true}'
echo '{"type":"view_data","project":"PROJECT","data":{"rows":2}}'
echo '{"type":"view","project":"PROJECT","path":"view.html"}'
echo '{"type":"view","project":"PROJECT","path":"../escape.html"}'
echo '{"type":"view","project":"PROJECT","html":"<p>last</p>"}'
while IFS= read -r line; do
  case "$line" in
    *'"type":"stop"'*) exit 0;;
    *'"type":"view_message"'*)
      echo '{"type":"view_data","project":"PROJECT","data":{"got":"pong"}}'
      ;;
  esac
done
"#;

    /// A plugin whose manifest declares no view, and which sends a page
    /// anyway before saying something that is heard.
    #[cfg(unix)]
    const UNSEEN: &str = r#"#!/bin/sh
echo '{"type":"hello","name":"quiet","version":"1.0.0"}'
echo '{"type":"view","project":"PROJECT","html":"<h1>Nothing</h1>","open":true}'
echo '{"type":"notify","project":"PROJECT","text":"no view here"}'
while IFS= read -r line; do
  case "$line" in
    *'"type":"stop"'*) exit 0;;
  esac
done
"#;

    /// A plugin that writes down every line it is told, and answers `stop`.
    #[cfg(unix)]
    const RECORDS: &str = r#"#!/bin/sh
echo '{"type":"hello","name":"ears","version":"1.0.0"}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> received.txt
  case "$line" in
    *'"type":"stop"'*) exit 0;;
  esac
done
"#;

    /// A plugin that puts rows and a mark on the session it is told of,
    /// writes down every line it hears, and asks to open web addresses for
    /// an action, for none, and for one it was sent before it restarted.
    #[cfg(unix)]
    const SESSIONS: &str = r#"#!/bin/sh
echo '{"type":"hello","name":"board","version":"1.0.0","sections":[{"id":"checks"}]}'
echo '{"type":"open_url","project":"PROJECT","url":"https://example.com/early"}'
if [ -f held.txt ]; then
  printf '{"type":"open_url","project":"PROJECT","action":"%s","url":"https://example.com/after-restart"}\n' "$(cat held.txt)"
fi
echo '{"type":"section","id":"checks","project":"PROJECT","session":"s-9","rows":[{"id":"stray","label":"Stray"}]}'
echo '{"type":"mark","project":"PROJECT","session":"s-9","icon":"branch"}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> received.txt
  case "$line" in
    *'"type":"stop"'*) exit 0;;
    *'"event":"started"'*'"id":"s-1"'*)
      echo '{"type":"section","id":"checks","project":"PROJECT","session":"s-1","rows":[{"id":"ci","label":"CI","state":"failed","facts":[{"label":"lint","text":"2 errors","state":"failed"},{"label":"test","state":"ok"}]}]}'
      echo '{"type":"mark","project":"PROJECT","session":"s-1","icon":"pull-request","count":2,"state":"failed","label":"  2   failing  ","extra":true}'
      ;;
    *'"event":"started"'*'"id":"s-2"'*)
      echo '{"type":"mark","project":"/elsewhere","session":"s-2","icon":"rocket","count":0,"state":"odd"}'
      ;;
    *'"action":"hold"'*)
      printf '%s' "$line" | sed 's/.*"id":"\([^"]*\)".*/\1/' > held.txt
      exit 1
      ;;
    *'"type":"action"'*)
      id=$(printf '%s' "$line" | sed 's/.*"id":"\([^"]*\)".*/\1/')
      echo '{"type":"open_url","project":"PROJECT","url":"https://example.com/unnamed"}'
      echo '{"type":"open_url","project":"PROJECT","action":"not-sent","url":"https://example.com/wrong"}'
      printf '{"type":"open_url","project":"PROJECT","action":"%s","url":"file:///etc/passwd"}\n' "$id"
      printf '{"type":"open_url","project":"PROJECT","action":"%s","url":"https://example.com/pull/1"}\n' "$id"
      printf '{"type":"open_url","project":"PROJECT","action":"%s","url":"https://example.com/pull/2"}\n' "$id"
      printf '{"type":"result","id":"%s"}\n' "$id"
      ;;
  esac
done
"#;

    const GOOD: &str = r#"
[[plugin]]
name = "github"
path = "github"
description = "Pull requests."
version = "0.2.0"
run = ["sh", "main.sh"]
tools = ["pr", "checks"]
sections = ["Pull request"]
view = "wide"
"#;

    #[test]
    fn reads_a_manifest_and_refuses_what_is_wrong_with_one() {
        let dir = source_with(GOOD, "good");
        let declared = read_manifest(&dir, &vars()).unwrap();
        assert_eq!(declared.len(), 1);
        assert_eq!(declared[0].name, "github");
        assert_eq!(declared[0].run, ["sh", "main.sh"]);
        assert_eq!(declared[0].tools, ["pr", "checks"]);
        assert_eq!(declared[0].view.as_deref(), Some("wide"));
        assert!(declared[0].build.is_empty());

        // The script a build writes is not in the source yet, and the
        // manifest stands all the same.
        let built = source_with(
            "[[plugin]]\nname = \"github\"\npath = \"github\"\nrun = [\"sh\", \"dist/main.sh\"]\nbuild = [\"sh\", \"build.sh\"]\n",
            "declares-a-build",
        );
        let declared = read_manifest(&built, &vars()).unwrap();
        assert_eq!(declared[0].run, ["sh", "dist/main.sh"]);
        assert_eq!(declared[0].build, ["sh", "build.sh"]);

        let wrong = [
            ("", "no [[plugin]] entries"),
            ("[[plugin]]\nname = \"GitHub\"\npath = \"github\"\nrun = [\"sh\"]\n", "must be lowercase"),
            ("[[plugin]]\nname = \"github\"\npath = \"../x\"\nrun = [\"sh\"]\n", "stay under the source"),
            ("[[plugin]]\nname = \"github\"\npath = \"nowhere\"\nrun = [\"sh\"]\n", "no directory"),
            ("[[plugin]]\nname = \"github\"\npath = \"github\"\nrun = [\"no-such-runtime-xyz\"]\n", "not on the PATH"),
            ("[[plugin]]\nname = \"github\"\npath = \"github\"\nrun = [\"sh\", \"missing.sh\"]\n", "not in its directory"),
            ("[[plugin]]\nname = \"github\"\npath = \"github\"\nrun = [\"sh\", \"dist/main.sh\"]\nbuild = [\"no-such-builder-xyz\", \"run\"]\n", "the build needs no-such-builder-xyz"),
            ("[[plugin]]\nname = \"github\"\npath = \"github\"\nrun = [\"sh\"]\ntools = [\"Bad Tool\"]\n", "plain identifier"),
            ("[[plugin]]\nname = \"github\"\npath = \"github\"\nrun = [\"sh\"]\nview = \"huge\"\n", "wide or full"),
            ("[[plugin]]\nname = \"github\"\npath = \"github\"\nrun = [\"sh\"]\n[[plugin]]\nname = \"github\"\npath = \"github\"\nrun = [\"sh\"]\n", "used twice"),
            ("this is not toml =", "manifest invalid"),
        ];
        for (manifest, expected) in wrong {
            let dir = source_with(manifest, "wrong");
            let error = read_manifest(&dir, &vars()).unwrap_err();
            assert!(error.contains(expected), "{manifest:?} gave {error:?}");
        }
        let nothing = Scratch::absent("plugins-nothing");
        let error = read_manifest(&nothing, &vars()).unwrap_err();
        assert!(error.contains("no workbench-plugins.toml"));
    }

    #[test]
    fn a_source_id_is_readable_and_stable() {
        let a = source_id("https://github.com/elva-labs/workbench-plugins.git");
        assert!(a.starts_with("workbench-plugins-"), "{a}");
        assert_eq!(
            a,
            source_id("https://github.com/elva-labs/workbench-plugins.git")
        );
        assert_ne!(
            a,
            source_id("https://github.com/other/workbench-plugins.git")
        );
    }

    #[cfg(unix)]
    #[test]
    fn adds_a_directory_runs_a_plugin_and_stops_it() {
        let home = Scratch::absent("plugins-home");
        let dir = source_with(
            r#"
[[plugin]]
name = "echo"
path = "github"
description = "Says hello."
version = "1.0.0"
run = ["sh", "main.sh"]
tools = ["ping"]
"#,
            "runs",
        );
        std::fs::write(
            dir.join("github/main.sh"),
            "#!/bin/sh\necho '{\"type\":\"hello\",\"name\":\"echo\",\"version\":\"1.0.0\",\"tools\":[{\"name\":\"ping\"}]}'\nwhile IFS= read -r line; do case \"$line\" in *stop*) exit 0;; esac; done\n",
        )
        .unwrap();
        let recorder = Arc::new(Recorder::default());
        let plugins = plugins_at(&home, recorder.clone());
        let added = plugins.add(dir.to_string_lossy().as_ref(), None).unwrap();
        assert_eq!(added.kind, "dir");
        assert_eq!(added.plugins.len(), 1);
        assert!(!added.plugins[0].enabled);
        assert_eq!(added.plugins[0].state, State::Off);
        assert!(plugins.add(dir.to_string_lossy().as_ref(), None).is_err());

        let on = plugins.enable(&added.id, "echo", true).unwrap();
        assert!(on.plugins[0].enabled);
        // The greeting arrives on the reader thread.
        let mut running = false;
        for _ in 0..600 {
            std::thread::sleep(Duration::from_millis(100));
            let listed = plugins.list();
            if listed[0].plugins[0].state == State::Running {
                running = true;
                assert_eq!(listed[0].plugins[0].hello.as_ref().unwrap().tools.len(), 1);
                break;
            }
        }
        assert!(running, "{:?}", plugins.list());
        // The listing turns to running before the event goes out, so the
        // event is waited for too.
        let announced = || {
            recorder
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|(event, payload)| event == PLUGIN_STATE && payload["state"] == "running")
        };
        for _ in 0..600 {
            if announced() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(announced());

        let off = plugins.enable(&added.id, "echo", false).unwrap();
        assert!(!off.plugins[0].enabled);
        assert_eq!(off.plugins[0].state, State::Off);

        // The state survives a new core, and a removed source is gone.
        let again = plugins_at(&home, recorder.clone());
        assert_eq!(again.list().len(), 1);
        again.remove(&added.id).unwrap();
        assert!(again.list().is_empty());
        assert!(plugins_at(&home, recorder).list().is_empty());
    }

    // Off and on again can end one process and start the next before the
    // first one's reader has read to the end of it. What that reader does
    // then must not touch the process that took its place.
    #[cfg(unix)]
    #[test]
    fn the_reader_of_a_process_that_was_replaced_leaves_the_next_one_alone() {
        let home = Scratch::absent("plugins-replaced-home");
        let dir = source_with(
            "[[plugin]]\nname = \"echo\"\npath = \"github\"\nrun = [\"sh\", \"main.sh\"]\n",
            "replaced",
        );
        std::fs::write(
            dir.join("github/main.sh"),
            "#!/bin/sh\necho '{\"type\":\"hello\",\"name\":\"echo\",\"version\":\"1.0.0\"}'\nwhile IFS= read -r line; do case \"$line\" in *stop*) exit 0;; esac; done\n",
        )
        .unwrap();
        let recorder = Arc::new(Recorder::default());
        let plugins = plugins_at(&home, recorder.clone());
        let added = plugins.add(dir.to_string_lossy().as_ref(), None).unwrap();
        let key: Key = (added.id.clone(), "echo".to_string());
        let launch = || {
            let running = plugins.inner.running.lock().unwrap();
            running.get(&key).map(|live| live.launch)
        };
        let came_up = || {
            for _ in 0..600 {
                if plugins.list()[0].plugins[0].state == State::Running {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            false
        };

        plugins.enable(&added.id, "echo", true).unwrap();
        assert!(came_up(), "{:?}", plugins.list());
        let first = launch().unwrap();
        plugins.enable(&added.id, "echo", false).unwrap();
        plugins.enable(&added.id, "echo", true).unwrap();
        assert!(came_up(), "{:?}", plugins.list());
        let second = launch().unwrap();
        assert_ne!(first, second);

        // The first process's reader, getting to what it wrote only now: a
        // greeting and a section are not the second process's, and tell the
        // reader to stop.
        let mut greeted = false;
        assert!(!plugins.inner.heard(
            &added.id,
            "echo",
            first,
            &mut greeted,
            r#"{"type":"hello","name":"echo","version":"0.0.1"}"#,
        ));
        assert!(!plugins.inner.heard(
            &added.id,
            "echo",
            first,
            &mut greeted,
            r#"{"type":"section","id":"checks","title":"Checks","project":"/tmp","rows":[]}"#,
        ));
        let hello = plugins.inner.greeting(&added.id, "echo").unwrap();
        assert_eq!(hello.version, "1.0.0");
        assert!(plugins.inner.sections.lock().unwrap().is_empty());

        // And getting to its end.
        plugins.inner.exited(&added.id, "echo", first, true);
        assert_eq!(launch(), Some(second));
        assert_eq!(plugins.list()[0].plugins[0].state, State::Running);
        assert!(!recorder
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(event, payload)| event == PLUGIN_STATE && payload["state"] == "stopped"));
        plugins.enable(&added.id, "echo", false).unwrap();
    }

    /// A plugin that greets, and on `stop` waits for the gate file before it
    /// exits, so a test decides when the process goes. Each process writes
    /// its pid to `pids`.
    #[cfg(unix)]
    struct Gated {
        plugins: Plugins,
        source: String,
        key: Key,
        gate: PathBuf,
        pids: PathBuf,
        _home: Scratch,
        _dir: Scratch,
        _gates: Scratch,
    }

    #[cfg(unix)]
    impl Gated {
        fn new(label: &str) -> Gated {
            let home = Scratch::absent(&format!("{label}-home"));
            let gates = Scratch::new(&format!("{label}-gates"));
            let gate = gates.join("gate");
            let pids = gates.join("pids");
            let dir = source_with(
                "[[plugin]]\nname = \"echo\"\npath = \"github\"\nrun = [\"sh\", \"main.sh\"]\n",
                label,
            );
            std::fs::write(
                dir.join("github/main.sh"),
                format!(
                    "#!/bin/sh\necho $$ >> '{pids}'\necho '{{\"type\":\"hello\",\"name\":\"echo\",\"version\":\"1.0.0\"}}'\nwhile IFS= read -r line; do case \"$line\" in *stop*) while [ ! -e '{gate}' ]; do sleep 0.05; done; exit 0;; esac; done\n",
                    pids = pids.display(),
                    gate = gate.display(),
                ),
            )
            .unwrap();
            let plugins = plugins_at(&home, Arc::new(Recorder::default()));
            let added = plugins.add(dir.to_string_lossy().as_ref(), None).unwrap();
            Gated {
                key: (added.id.clone(), "echo".to_string()),
                source: added.id,
                plugins,
                gate,
                pids,
                _home: home,
                _dir: dir,
                _gates: gates,
            }
        }

        fn state(&self) -> Option<(u64, State)> {
            let running = self.plugins.inner.running.lock().unwrap();
            running
                .get(&self.key)
                .map(|live| (live.launch, live.state.clone()))
        }

        fn wait_for(&self, wanted: State) -> u64 {
            for _ in 0..600 {
                if let Some((launch, state)) = self.state() {
                    if state == wanted {
                        return launch;
                    }
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            panic!("never {wanted:?}: {:?}", self.plugins.list());
        }

        fn pids(&self) -> Vec<String> {
            std::fs::read_to_string(&self.pids)
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        }
    }

    #[cfg(unix)]
    fn alive(pid: &str) -> bool {
        Command::new("kill")
            .args(["-0", pid])
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    // Off, then on again before the process has gone: the stop that is still
    // waiting must not end the process that was started after it.
    #[cfg(unix)]
    #[test]
    fn a_stop_that_is_still_waiting_leaves_the_next_process_alone() {
        let plugin = Gated::new("plugins-stop-replaced");
        plugin.plugins.enable(&plugin.source, "echo", true).unwrap();
        let first = plugin.wait_for(State::Running);

        let stopping = {
            let plugins = plugin.plugins.clone();
            let source = plugin.source.clone();
            std::thread::spawn(move || plugins.enable(&source, "echo", false).unwrap())
        };
        plugin.wait_for(State::Off);
        plugin.plugins.enable(&plugin.source, "echo", true).unwrap();
        let second = plugin.wait_for(State::Running);
        assert_ne!(first, second);

        // The stop, which kept polling for a process that has been replaced,
        // is over without having touched the next one, which is still the
        // one running.
        stopping.join().unwrap();
        assert_eq!(plugin.state(), Some((second, State::Running)));
        assert_eq!(plugin.plugins.list()[0].plugins[0].state, State::Running);

        // The first process is ended and collected all the same.
        let pids = plugin.pids();
        assert_eq!(pids.len(), 2);
        for _ in 0..200 {
            if !alive(&pids[0]) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(!alive(&pids[0]), "the first process is still there");
        assert_eq!(plugin.state(), Some((second, State::Running)));

        std::fs::write(&plugin.gate, "").unwrap();
        plugin
            .plugins
            .enable(&plugin.source, "echo", false)
            .unwrap();
    }

    // While stop waits for a process to go, what it says is not kept, and its
    // reader goes on reading.
    #[cfg(unix)]
    #[test]
    fn what_a_plugin_says_while_it_is_being_stopped_is_not_kept() {
        let plugin = Gated::new("plugins-said-while-stopping");
        plugin.plugins.enable(&plugin.source, "echo", true).unwrap();
        let launch = plugin.wait_for(State::Running);

        let stopping = {
            let plugins = plugin.plugins.clone();
            let source = plugin.source.clone();
            std::thread::spawn(move || plugins.enable(&source, "echo", false).unwrap())
        };
        plugin.wait_for(State::Off);

        let mut greeted = false;
        assert!(plugin.plugins.inner.heard(
            &plugin.source,
            "echo",
            launch,
            &mut greeted,
            r#"{"type":"section","id":"checks","title":"Checks","project":"/tmp","rows":[]}"#,
        ));
        assert!(plugin.plugins.inner.heard(
            &plugin.source,
            "echo",
            launch,
            &mut greeted,
            r#"{"type":"hello","name":"echo","version":"9.9.9"}"#,
        ));
        assert!(plugin.plugins.inner.sections.lock().unwrap().is_empty());
        assert_eq!(plugin.state(), Some((launch, State::Off)));

        std::fs::write(&plugin.gate, "").unwrap();
        stopping.join().unwrap();
        assert_eq!(plugin.state(), None);
    }

    #[test]
    #[cfg(unix)]
    fn a_plugin_that_dies_before_greeting_says_why_and_is_left_alone_in_time() {
        let home = Scratch::absent("plugins-home-dies");
        let dir = source_with(
            r#"
[[plugin]]
name = "brief"
path = "github"
description = "Dies at once."
version = "1.0.0"
run = ["sh", "main.sh"]
"#,
            "dies",
        );
        std::fs::write(
            dir.join("github/main.sh"),
            "#!/bin/sh\necho 'Error: cannot find module ./board' >&2\nexit 3\n",
        )
        .unwrap();
        let recorder = Arc::new(Recorder::default());
        let plugins = plugins_at(&home, recorder.clone());
        let added = plugins.add(dir.to_string_lossy().as_ref(), None).unwrap();
        plugins.enable(&added.id, "brief", true).unwrap();

        // Each death is told with the code and the last line it wrote, and
        // after the fifth the row reads failed and nothing starts it again.
        let mut failed = None;
        for _ in 0..600 {
            std::thread::sleep(Duration::from_millis(100));
            let listed = plugins.list();
            if listed[0].plugins[0].state == State::Failed {
                failed = listed[0].plugins[0].detail.clone();
                break;
            }
        }
        let failed = failed.expect("gave up");
        assert!(
            failed.starts_with(
                "stopped after 5 tries: exited with code 3: Error: cannot find module ./board"
            ),
            "{failed}"
        );
        let events = recorder.events.lock().unwrap();
        let stopped = events
            .iter()
            .filter(|(event, payload)| event == PLUGIN_STATE && payload["state"] == "stopped")
            .count();
        assert_eq!(stopped, 4, "four stops, then failed");
        assert!(events.iter().any(|(event, payload)| event == PLUGIN_STATE
            && payload["state"] == "stopped"
            && payload["detail"] == "exited with code 3: Error: cannot find module ./board"));
        drop(events);

        // Off and on again is a fresh start.
        plugins.enable(&added.id, "brief", false).unwrap();
        let on = plugins.enable(&added.id, "brief", true).unwrap();
        assert!(matches!(
            on.plugins[0].state,
            State::Starting | State::Stopped | State::Running
        ));
        plugins.enable(&added.id, "brief", false).unwrap();
    }

    #[test]
    fn leaves_a_call_for_a_source_it_has_never_heard_of_alone() {
        // An app and a daemon can share a home, and both tail the log. A
        // core answers only for the sources it holds, so the one that has
        // the plugin is the one that answers.
        let home = Scratch::absent("plugins-other-home");
        let plugins = plugins_at(&home, Arc::new(Recorder::default()));
        let request = crate::show::ToolRequest {
            id: "call-1".into(),
            source: "someone-elses-source".into(),
            plugin: "echo".into(),
            tool: "ping".into(),
            arguments: serde_json::json!({}),
            cwd: "/p".into(),
            session: None,
        };
        plugins.call(request);
        assert!(!crate::show::answer_path(&home, "call-1").exists());
    }

    #[cfg(unix)]
    #[test]
    fn publishes_a_running_plugin_s_tools_and_carries_a_call_to_it() {
        let home = Scratch::absent("plugins-tools-home");
        let dir = source_with(
            r#"
[[plugin]]
name = "echo"
path = "github"
description = "Says hello."
version = "1.0.0"
run = ["sh", "main.sh"]
tools = ["ping"]
"#,
            "tools",
        );
        std::fs::write(
            dir.join("github/main.sh"),
            r#"#!/bin/sh
echo '{"type":"hello","name":"echo","version":"1.0.0","tools":[{"name":"ping","description":"Answers.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}}]}'
while IFS= read -r line; do
  case "$line" in
    *'"type":"stop"'*) exit 0;;
    *'"type":"tool"'*)
      id=$(printf '%s' "$line" | sed 's/.*"id":"\([^"]*\)".*/\1/')
      session=$(printf '%s' "$line" | sed -n 's/.*"session":"\([^"]*\)".*/\1/p')
      printf '{"type":"result","id":"%s","content":"pong%s"}\n' "$id" "${session:+ $session}"
      ;;
  esac
done
"#,
        )
        .unwrap();
        let plugins = plugins_at(&home, Arc::new(Recorder::default()));
        let added = plugins.add(dir.to_string_lossy().as_ref(), None).unwrap();
        plugins.enable(&added.id, "echo", true).unwrap();

        let published = || -> Vec<PublishedTool> {
            let text = std::fs::read_to_string(tools_path(&home)).unwrap_or_default();
            serde_json::from_str(&text).unwrap_or_default()
        };
        let mut listed = Vec::new();
        for _ in 0..50 {
            std::thread::sleep(Duration::from_millis(100));
            listed = published();
            if !listed.is_empty() {
                break;
            }
        }
        assert_eq!(listed.len(), 1, "{:?}", plugins.list());
        assert_eq!(listed[0].name, "echo_ping");
        assert_eq!(listed[0].description, "Answers.");
        assert_eq!(
            listed[0].input_schema["properties"]["text"]["type"],
            "string"
        );
        assert_eq!(listed[0].source, added.id);
        assert_eq!(listed[0].plugin, "echo");
        assert_eq!(listed[0].tool, "ping");
        assert_eq!(plugins.tools(), listed);

        // The calling session's tools name it by its token; the plugin
        // hears the agent's own id, as the session events give it.
        plugins.session_started("pty-1", started(Some("s-1"), Some("t-1"), "/p"));
        let call_from = |id: &str, plugin: &str, token: &str| ToolRequest {
            id: id.to_string(),
            source: added.id.clone(),
            plugin: plugin.to_string(),
            tool: "ping".to_string(),
            arguments: serde_json::json!({ "text": "hi" }),
            cwd: "/p".to_string(),
            session: Some(token.to_string()),
        };
        let call = |id: &str, plugin: &str| call_from(id, plugin, "t-1");
        plugins.call(call("call-1", "echo"));
        let answer = |id: &str| -> Option<Answer> {
            for _ in 0..50 {
                if let Ok(text) = std::fs::read_to_string(crate::show::answer_path(&home, id)) {
                    return serde_json::from_str(&text).ok();
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            None
        };
        let answered = answer("call-1").expect("the plugin answered");
        assert_eq!(answered.content.as_deref(), Some("pong s-1"));
        assert_eq!(answered.error, None);
        // A token no session here was given names no session at all.
        plugins.call(call_from("call-3", "echo", "t-unknown"));
        let unnamed = answer("call-3").expect("the plugin answered");
        assert_eq!(unnamed.content.as_deref(), Some("pong"));

        // A plugin that is not running is answered at once.
        plugins.call(call("call-2", "missing"));
        let refused = answer("call-2").expect("an answer either way");
        assert_eq!(refused.error.as_deref(), Some("the plugin is not running"));

        // Off, and the tools go with it.
        plugins.enable(&added.id, "echo", false).unwrap();
        assert!(published().is_empty());
        assert!(plugins.tools().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn carries_a_plugin_s_rows_places_and_lines_and_takes_an_action_back() {
        let home = Scratch::absent("plugins-rows-home");
        let dir = source_with(
            r#"
[[plugin]]
name = "board"
path = "github"
description = "Rows."
version = "1.0.0"
run = ["sh", "main.sh"]
sections = ["Pull request"]
"#,
            "rows",
        );
        let project = dunce::canonicalize(&dir).unwrap();
        let here = project.to_string_lossy().to_string();
        std::fs::write(
            dir.join("github/main.sh"),
            SECTIONS.replace("PROJECT", &here),
        )
        .unwrap();
        let recorder = Arc::new(Recorder::default());
        let plugins = plugins_at(&home, recorder.clone());
        // The session the plugin names in its line, by the agent's id.
        plugins.session_started("pty-1", started(Some("s-1"), Some("t-1"), &here));
        let added = plugins.add(&here, None).unwrap();
        plugins.enable(&added.id, "board", true).unwrap();

        // Everything the plugin says arrives on its reader thread.
        let wait = |event: &'static str, ok: &dyn Fn(&serde_json::Value) -> bool| {
            for _ in 0..50 {
                let found = recorder
                    .events
                    .lock()
                    .unwrap()
                    .iter()
                    .rev()
                    .find(|(name, payload)| name == event && ok(payload))
                    .map(|(_, payload)| payload.clone());
                if let Some(payload) = found {
                    return payload;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            panic!("nothing said {event}");
        };
        let any = |_: &serde_json::Value| true;

        let section = wait(PLUGIN_SECTION, &|payload| {
            payload["rows"]
                .as_array()
                .is_some_and(|rows| !rows.is_empty())
        });
        assert_eq!(section["source"], added.id);
        assert_eq!(section["plugin"], "board");
        assert_eq!(section["section"], "pull-request");
        assert_eq!(section["title"], "Pull request");
        assert_eq!(section["detail"], "main, 2 ahead");
        assert_eq!(section["folded"], true);
        // Second of the two the greeting declared.
        assert_eq!(section["order"], 1);
        assert_eq!(section["project"], here);
        let rows = section["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 1, "the row without an id is dropped: {section}");
        assert_eq!(rows[0]["id"], "lint");
        assert_eq!(rows[0]["detail"], "3 of 4");
        assert_eq!(rows[0]["state"], "ok");
        assert_eq!(rows[0]["default"], "open");
        assert_eq!(rows[0]["actions"][0]["label"], "Open");
        // A plugin that names no session and no facts has rows that are the
        // whole project's and open on nothing.
        assert!(section["session"].is_null());
        assert_eq!(rows[0]["facts"], serde_json::json!([]));
        assert_eq!(section["actions"][0]["id"], "refresh");
        assert_eq!(section["actions"][0]["input"][0]["kind"], "text");

        let show = wait(SHOW_REQUEST, &any);
        assert_eq!(
            show["path"],
            project
                .join("github")
                .join("main.sh")
                .to_string_lossy()
                .as_ref()
        );
        assert_eq!(show["cwd"], here);
        assert_eq!(show["from"], 3);
        assert_eq!(show["to"], 5);
        assert_eq!(show["note"], "here");
        assert_eq!(show["session"], serde_json::Value::Null);

        // The window is given the session's token, never the agent's id.
        let notify = wait(NOTIFY_REQUEST, &any);
        assert_eq!(notify["text"], "needs a key");
        assert_eq!(notify["cwd"], here);
        assert_eq!(notify["session"], "t-1");

        plugins
            .action(
                &added.id,
                "board",
                "pull-request",
                "open",
                Some("lint"),
                &serde_json::json!({}),
                &here,
                None,
            )
            .unwrap();
        let notice = wait(PLUGIN_NOTICE, &any);
        assert_eq!(notice["source"], added.id);
        assert_eq!(notice["plugin"], "board");
        assert_eq!(notice["text"], "gh is not logged in");
        // The action's answer is the window's alone: nothing was left for
        // the tool server.
        assert!(!crate::show::answers_path(&home).exists());

        let refused = plugins
            .action(
                &added.id,
                "missing",
                "pull-request",
                "open",
                None,
                &serde_json::json!({}),
                &here,
                None,
            )
            .unwrap_err();
        assert_eq!(refused, "the plugin is not running");

        // Off, and the rows it left go with it.
        plugins.enable(&added.id, "board", false).unwrap();
        let gone = wait(PLUGIN_SECTION, &|payload| {
            payload["rows"]
                .as_array()
                .is_some_and(|rows| rows.is_empty())
        });
        assert_eq!(gone["section"], "pull-request");
        assert_eq!(gone["project"], here);
        assert!(gone["actions"].as_array().unwrap().is_empty());
        assert!(gone["detail"].is_null());
    }

    #[cfg(unix)]
    #[test]
    fn shows_a_plugin_s_page_and_carries_what_goes_either_way() {
        let home = Scratch::absent("plugins-view-home");
        let dir = source_with(
            r#"
[[plugin]]
name = "pages"
path = "github"
description = "A page."
version = "1.0.0"
run = ["sh", "main.sh"]
view = "full"

[[plugin]]
name = "quiet"
path = "quiet"
description = "No page."
version = "1.0.0"
run = ["sh", "main.sh"]
"#,
            "view",
        );
        std::fs::create_dir_all(dir.join("quiet")).unwrap();
        let project = dunce::canonicalize(&dir).unwrap();
        let here = project.to_string_lossy().to_string();
        std::fs::write(dir.join("github/main.sh"), PAGES.replace("PROJECT", &here)).unwrap();
        std::fs::write(dir.join("quiet/main.sh"), UNSEEN.replace("PROJECT", &here)).unwrap();
        std::fs::write(dir.join("github/view.html"), "<p>from disk</p>").unwrap();
        std::fs::write(dir.join("escape.html"), "<p>escaped</p>").unwrap();

        let recorder = Arc::new(Recorder::default());
        let plugins = plugins_at(&home, recorder.clone());
        let added = plugins.add(&here, None).unwrap();
        plugins.enable(&added.id, "pages", true).unwrap();
        plugins.enable(&added.id, "quiet", true).unwrap();

        let wait = |event: &'static str, ok: &dyn Fn(&serde_json::Value) -> bool| {
            for _ in 0..50 {
                let found = recorder
                    .events
                    .lock()
                    .unwrap()
                    .iter()
                    .rev()
                    .find(|(name, payload)| name == event && ok(payload))
                    .map(|(_, payload)| payload.clone());
                if let Some(payload) = found {
                    return payload;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            panic!("nothing said {event}");
        };
        let pages = || -> Vec<serde_json::Value> {
            recorder
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|(name, payload)| name == PLUGIN_VIEW && payload["plugin"] == "pages")
                .map(|(_, payload)| payload.clone())
                .collect()
        };

        // The page it sent as it came up, in the room its manifest asks
        // for, and shown at once.
        let first = wait(PLUGIN_VIEW, &|payload| payload["open"] == true);
        assert_eq!(first["source"], added.id);
        assert_eq!(first["plugin"], "pages");
        assert_eq!(first["project"], here);
        assert_eq!(first["width"], "full");
        assert_eq!(first["html"], "<h1>Board</h1>");

        // Data for the page, which is kept nowhere.
        let data = wait(PLUGIN_VIEW_DATA, &|payload| {
            !payload["data"]["rows"].is_null()
        });
        assert_eq!(data["source"], added.id);
        assert_eq!(data["plugin"], "pages");
        assert_eq!(data["project"], here);
        assert_eq!(data["data"]["rows"], 2);

        // The last page it sent, once the one from a file and the one from
        // outside its directory have both been through.
        let last = wait(PLUGIN_VIEW, &|payload| payload["html"] == "<p>last</p>");
        assert_eq!(last["open"], false);
        let sent = pages();
        assert_eq!(
            sent.len(),
            3,
            "the page outside the directory is no page: {sent:?}"
        );
        assert_eq!(sent[1]["html"], "<p>from disk</p>");
        assert_eq!(sent[1]["width"], "full");
        assert!(
            !sent.iter().any(|page| page["html"] == "<p>escaped</p>"),
            "{sent:?}"
        );

        // A plugin whose manifest declares no view has no page, whatever
        // it sends; what it says otherwise is heard.
        let notify = wait(NOTIFY_REQUEST, &|payload| payload["text"] == "no view here");
        assert_eq!(notify["cwd"], here);
        assert!(
            !recorder
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|(name, payload)| name == PLUGIN_VIEW && payload["plugin"] == "quiet"),
            "a plugin with no view in its manifest shows no page"
        );

        // A message from the page reaches the plugin, which answers the
        // page.
        plugins
            .view_message(
                &added.id,
                "pages",
                &here,
                &serde_json::json!({ "want": "rows" }),
            )
            .unwrap();
        let answer = wait(PLUGIN_VIEW_DATA, &|payload| {
            payload["data"]["got"] == "pong"
        });
        assert_eq!(answer["plugin"], "pages");
        let refused = plugins
            .view_message(&added.id, "missing", &here, &serde_json::json!({}))
            .unwrap_err();
        assert_eq!(refused, "the plugin is not running");

        // Off, and the page it left goes with it.
        plugins.enable(&added.id, "pages", false).unwrap();
        let gone = wait(PLUGIN_VIEW, &|payload| payload["html"] == "");
        assert_eq!(gone["plugin"], "pages");
        assert_eq!(gone["project"], here);
        assert_eq!(gone["width"], "full");
        assert_eq!(gone["open"], false);
        // Nothing is left to say a second time.
        let count = pages().len();
        plugins.enable(&added.id, "pages", false).unwrap();
        assert_eq!(pages().len(), count);

        plugins.enable(&added.id, "quiet", false).unwrap();
    }

    #[test]
    fn takes_a_section_apart_and_drops_what_is_not_a_row() {
        let message = serde_json::json!({
            "type": "section",
            "id": "pull-request",
            "title": "Pull request",
            "detail": "main, 2 ahead",
            "folded": true,
            "project": "/p",
            "rows": [
                {
                    "id": "a",
                    "label": "A",
                    "state": "waiting",
                    "actions": [{ "id": "open", "label": "Open" }, { "id": "", "label": "No" }],
                    "default": "nowhere"
                },
                { "id": "b", "label": "B", "state": "unsure" },
                { "id": "c" },
                "not a row",
                {
                    "id": "d",
                    "label": "D",
                    "actions": [{
                        "id": "run",
                        "label": "Run",
                        "input": [
                            { "id": "m", "label": "M", "kind": "choice", "options": [{ "id": "x", "label": "X" }] },
                            { "id": "n", "label": "N", "kind": "odd" }
                        ]
                    }],
                    "default": "run",
                    "facts": [
                        { "label": "CI", "text": "3 of 4 passed", "state": "busy" },
                        { "label": "Review", "text": "" },
                        { "label": "", "text": "nameless" },
                        { "label": "Odd", "state": "unsure" },
                        "not a fact",
                        { "label": 4 }
                    ]
                }
            ],
            "actions": [{ "id": "refresh", "label": "Refresh" }, { "id": "nameless" }]
        });
        let greeting = Hello {
            name: "board".to_string(),
            version: "1.0.0".to_string(),
            tools: Vec::new(),
            sections: vec![
                serde_json::json!({ "id": "checks" }),
                serde_json::json!({ "id": "pull-request" }),
            ],
            view: None,
        };
        let section = checked_section("src-1", "board", &message, Some(&greeting), None).unwrap();
        assert_eq!(section.source, "src-1");
        assert_eq!(section.plugin, "board");
        assert_eq!(section.section, "pull-request");
        assert_eq!(
            section
                .rows
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "d"]
        );
        assert_eq!(section.rows[0].state.as_deref(), Some("waiting"));
        assert_eq!(section.rows[0].actions.as_ref().unwrap().len(), 1);
        assert_eq!(section.rows[0].default, None);
        assert_eq!(section.rows[1].default.as_deref(), Some("run"));
        // A row says nothing when opened unless it names facts, and a fact
        // that is not one is dropped without its row.
        assert!(section.rows[0].facts.is_empty());
        assert_eq!(
            section.rows[1].facts,
            [
                Fact {
                    label: "CI".to_string(),
                    text: Some("3 of 4 passed".to_string()),
                    state: Some("busy".to_string()),
                },
                Fact {
                    label: "Review".to_string(),
                    text: None,
                    state: None,
                },
            ]
        );
        let many = serde_json::json!({
            "id": "checks",
            "project": "/p",
            "rows": [{
                "id": "a",
                "label": "A",
                "facts": (0..12).map(|n| serde_json::json!({ "label": format!("f{n}") })).collect::<Vec<_>>()
            }, { "id": "b", "label": "B", "facts": "not a list" }]
        });
        let many = checked_section("src-1", "board", &many, None, None).unwrap();
        assert_eq!(many.rows[0].facts.len(), FACTS);
        assert!(many.rows[1].facts.is_empty());
        // Rows with no session are the whole project's.
        assert_eq!(many.session, None);
        let fields = section.rows[1].actions.as_ref().unwrap()[0]
            .input
            .as_ref()
            .unwrap();
        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0].options.as_ref().unwrap()[0].id, "x");
        assert_eq!(section.actions.len(), 1);
        assert_eq!(section.actions[0].id, "refresh");
        assert_eq!(section.detail.as_deref(), Some("main, 2 ahead"));
        assert!(section.folded);
        // Second of the two the greeting declared.
        assert_eq!(section.order, 1);
        // Without the greeting it stands after every section that is named
        // in one.
        assert_eq!(
            checked_section("src-1", "board", &message, None, None)
                .unwrap()
                .order,
            u32::MAX
        );

        // A section is named as a tool is, and is for one project.
        let named = |id: &str| serde_json::json!({ "id": id, "project": "/p", "rows": [] });
        assert!(checked_section("src-1", "board", &named("Pull request"), None, None).is_none());
        assert!(checked_section("src-1", "board", &named(""), None, None).is_none());
        assert!(checked_section("src-1", "board", &named("pull-request"), None, None).is_some());
        assert!(checked_section(
            "src-1",
            "board",
            &serde_json::json!({ "id": "checks" }),
            None,
            None
        )
        .is_none());

        // A section that says nothing else is itself, empty, open, and last.
        let untitled = checked_section(
            "src-1",
            "board",
            &serde_json::json!({ "id": "checks", "project": "/p", "detail": "" }),
            Some(&greeting),
            None,
        )
        .unwrap();
        assert_eq!(untitled.title, "checks");
        assert!(untitled.rows.is_empty());
        assert!(untitled.actions.is_empty());
        assert_eq!(untitled.detail, None);
        assert!(!untitled.folded);
        assert_eq!(untitled.order, 0);
    }

    #[test]
    fn refuses_a_location_or_a_ref_that_git_would_read_as_an_option() {
        let home = Scratch::absent("plugins-arguments-home");
        let plugins = plugins_at(&home, Arc::new(Recorder::default()));
        let root = home.join(".chord").join("plugins");

        let smuggled = "--upload-pack=touch /tmp/workbench-never-written";
        let refused = plugins.add(smuggled, None).unwrap_err();
        assert!(refused.contains("may not start with a dash"), "{refused}");
        assert!(!root.join(source_id(smuggled)).exists(), "nothing was run");

        let url = "file:///srv/plugins.git";
        assert_eq!(
            plugins.add(url, Some("-x")).unwrap_err(),
            "the ref may hold letters, digits, dot, slash, dash and underscore"
        );
        let refused = plugins.add(url, Some("main;touch x")).unwrap_err();
        assert!(refused.contains("the ref may hold"), "{refused}");
        assert!(!root.join(source_id(url)).exists(), "nothing was cloned");
        assert!(plugins.list().is_empty());

        assert!(plain_reference("release/1.2.x"));
        assert!(!plain_reference("--upload-pack=x"));
        assert!(!plain_reference(""));
    }

    /// A repository with the manifest given in it, committed on main, for
    /// a source to be cloned from.
    fn upstream_with(manifest: &str, name: &str) -> Scratch {
        let dir = source_with(manifest, name);
        let g = |args: &[&str]| git(&dir, args).unwrap();
        g(&["init", "-q", "-b", "main"]);
        g(&["config", "user.email", "t@example.com"]);
        g(&["config", "user.name", "T"]);
        g(&["add", "."]);
        g(&["commit", "-q", "-m", "start"]);
        dir
    }

    #[test]
    #[cfg(unix)]
    fn offers_the_sources_it_knows_and_fetches_one_when_asked() {
        let home = Scratch::absent("plugins-known-home");
        let upstream = upstream_with(GOOD, "known-upstream");
        let list = format!(
            "[[source]]\nid = \"labs\"\nrepository = \"file://{}\"\nref = \"main\"\n\n\
             [[source.plugin]]\nname = \"github\"\ndescription = \"Pull requests.\"\n",
            upstream.display()
        );
        let known = crate::known::known_from(&list).unwrap();
        let plugins = Plugins::with_known(&home, Arc::new(Recorder::default()), known);

        // Offered before anything is fetched: the list's word, every
        // plugin off, and nothing to check or update.
        let listed = plugins.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "known-labs");
        assert!(listed[0].known);
        assert_eq!(listed[0].commit, None);
        assert_eq!(listed[0].reference.as_deref(), Some("main"));
        assert_eq!(listed[0].plugins.len(), 1);
        assert_eq!(listed[0].plugins[0].declared.name, "github");
        assert_eq!(listed[0].plugins[0].declared.description, "Pull requests.");
        assert!(listed[0].plugins[0].declared.run.is_empty());
        assert!(!listed[0].plugins[0].enabled);
        assert_eq!(listed[0].plugins[0].state, State::Off);

        // Nothing runs from a source that is not there.
        assert_eq!(
            plugins.enable("known-labs", "github", true).unwrap_err(),
            "fetch the source first"
        );
        assert_eq!(
            plugins.fetch("src-1").unwrap_err(),
            "that source is not one the app offers"
        );

        // Fetched: the manifest's word, under the id the list gives.
        let fetched = plugins.fetch("known-labs").unwrap();
        assert_eq!(fetched.id, "known-labs");
        assert!(fetched.known);
        assert!(fetched.commit.is_some());
        assert_eq!(fetched.plugins[0].declared.run, ["sh", "main.sh"]);
        assert_eq!(fetched.plugins[0].declared.tools, ["pr", "checks"]);
        let listed = plugins.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "known-labs");
        assert!(listed[0].known);
        assert!(listed[0].commit.is_some());
        assert_eq!(
            plugins.fetch("known-labs").unwrap_err(),
            "that source is fetched already"
        );

        // Removed, it is offered again, and unfetched.
        plugins.remove("known-labs").unwrap();
        let listed = plugins.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "known-labs");
        assert!(listed[0].known);
        assert_eq!(listed[0].commit, None);
        assert_eq!(listed[0].plugins[0].declared.description, "Pull requests.");
    }

    /// A list naming one source, `labs`, at `repository`, with `former`
    /// addresses.
    fn labs_list(repository: &str, former: &[&str]) -> Vec<KnownSource> {
        let former: Vec<String> = former.iter().map(|f| format!("\"{f}\"")).collect();
        let list = format!(
            "[[source]]\nid = \"labs\"\nrepository = \"{repository}\"\nformer = [{}]\nref = \"main\"\n\n\
             [[source.plugin]]\nname = \"github\"\ndescription = \"Pull requests.\"\n",
            former.join(", ")
        );
        crate::known::known_from(&list).unwrap()
    }

    /// The state file of a home, read back.
    fn state_of(home: &Path) -> serde_json::Value {
        let text =
            std::fs::read_to_string(crate::home::dir(home).join("plugins/state.json")).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    /// A home with `known-labs` fetched from `old`, with a plugin enabled
    /// and a build remembered, and the commit it was built at.
    #[cfg(unix)]
    fn home_fetched_from(old: &str, name: &str) -> (Scratch, String) {
        let home = Scratch::absent(name);
        let plugins =
            Plugins::with_known(&home, Arc::new(Recorder::default()), labs_list(old, &[]));
        let fetched = plugins.fetch("known-labs").unwrap();
        let commit = fetched.commit.unwrap();
        let path = crate::home::dir(&home).join("plugins/state.json");
        let mut state = state_of(&home);
        state["sources"][0]["enabled"] = serde_json::json!(["github"]);
        state["sources"][0]["built"] = serde_json::json!({ "github": commit });
        std::fs::write(&path, state.to_string()).unwrap();
        (home, commit)
    }

    #[cfg(unix)]
    fn remote_of(home: &Path) -> String {
        let repo = crate::home::dir(home).join("plugins/known-labs/repo");
        git(&repo, &["remote", "get-url", "origin"]).unwrap()
    }

    #[test]
    #[cfg(unix)]
    fn a_source_stored_under_a_former_address_moves_to_the_current_one() {
        let old_upstream = upstream_with(GOOD, "moves-old");
        let new_upstream = upstream_with(GOOD, "moves-new");
        let old = format!("file://{}", old_upstream.display());
        let new = format!("file://{}", new_upstream.display());
        let (home, commit) = home_fetched_from(&old, "plugins-moves-home");
        assert_eq!(remote_of(&home), old);

        let plugins = Plugins::with_known(
            &home,
            Arc::new(Recorder::default()),
            labs_list(&new, &[&old]),
        );
        let state = state_of(&home);
        assert_eq!(state["sources"].as_array().unwrap().len(), 1);
        assert_eq!(state["sources"][0]["id"], "known-labs");
        assert_eq!(state["sources"][0]["location"], new);
        assert_eq!(
            state["sources"][0]["enabled"],
            serde_json::json!(["github"])
        );
        assert_eq!(state["sources"][0]["built"]["github"], commit);
        assert_eq!(remote_of(&home), new);
        let listed = plugins.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].location, new);
        assert!(listed[0].plugins[0].enabled);
    }

    #[test]
    #[cfg(unix)]
    fn a_source_already_on_the_current_address_is_left_alone() {
        let old_upstream = upstream_with(GOOD, "stays-old");
        let new_upstream = upstream_with(GOOD, "stays-new");
        let old = format!("file://{}", old_upstream.display());
        let new = format!("file://{}", new_upstream.display());
        let (home, _) = home_fetched_from(&new, "plugins-stays-home");
        let path = crate::home::dir(&home).join("plugins/state.json");
        let before = std::fs::read_to_string(&path).unwrap();
        Plugins::with_known(
            &home,
            Arc::new(Recorder::default()),
            labs_list(&new, &[&old]),
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        assert_eq!(remote_of(&home), new);
        // An address the list does not name as a former one is left too.
        let other = format!("{new}-other");
        let (home, _) = home_fetched_from(&old, "plugins-stays-other-home");
        Plugins::with_known(&home, Arc::new(Recorder::default()), labs_list(&other, &[]));
        assert_eq!(state_of(&home)["sources"][0]["location"], old);
        assert_eq!(remote_of(&home), old);
    }

    #[test]
    #[cfg(unix)]
    fn a_move_that_fails_leaves_the_source_on_its_old_address() {
        let old_upstream = upstream_with(GOOD, "fails-old");
        let old = format!("file://{}", old_upstream.display());
        let new = "file:///nowhere/new".to_string();

        // The checkout is gone, so its remote cannot be changed.
        let (home, commit) = home_fetched_from(&old, "plugins-fails-home");
        std::fs::remove_dir_all(crate::home::dir(&home).join("plugins/known-labs/repo")).unwrap();
        Plugins::with_known(
            &home,
            Arc::new(Recorder::default()),
            labs_list(&new, &[&old]),
        );
        let state = state_of(&home);
        assert_eq!(state["sources"][0]["location"], old);
        assert_eq!(
            state["sources"][0]["enabled"],
            serde_json::json!(["github"])
        );
        assert_eq!(state["sources"][0]["built"]["github"], commit);

        // The state cannot be written, so the remote goes back.
        let (home, _) = home_fetched_from(&old, "plugins-fails-write-home");
        let path = crate::home::dir(&home).join("plugins/state.json");
        let mut mode = std::fs::metadata(&path).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut mode, 0o444);
        std::fs::set_permissions(&path, mode).unwrap();
        let readonly = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .is_err();
        Plugins::with_known(
            &home,
            Arc::new(Recorder::default()),
            labs_list(&new, &[&old]),
        );
        if readonly {
            assert_eq!(state_of(&home)["sources"][0]["location"], old);
            assert_eq!(remote_of(&home), old);
        }
    }

    #[test]
    #[cfg(unix)]
    fn a_source_of_the_user_s_own_is_listed_beside_the_ones_offered() {
        let home = Scratch::absent("plugins-known-own-home");
        let upstream = upstream_with(GOOD, "known-own-upstream");
        let list = "[[source]]\nid = \"labs\"\nrepository = \"https://example.com/labs.git\"\n\
                    ref = \"main\"\n[[source.plugin]]\nname = \"github\"\ndescription = \"Pull requests.\"\n";
        let known = crate::known::known_from(list).unwrap();
        let plugins = Plugins::with_known(&home, Arc::new(Recorder::default()), known);
        let added = plugins
            .add(&format!("file://{}", upstream.display()), Some("main"))
            .unwrap();
        assert!(!added.known);
        let listed = plugins.list();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, added.id);
        assert!(!listed[0].known);
        assert_eq!(listed[1].id, "known-labs");
        assert!(listed[1].known);
    }

    #[test]
    #[cfg(unix)]
    fn adds_a_repository_by_cloning_it_and_checks_for_a_newer_commit() {
        let home = Scratch::absent("plugins-clone-home");
        let upstream = source_with(GOOD, "upstream");
        let g = |args: &[&str]| git(&upstream, args).unwrap();
        g(&["init", "-q", "-b", "main"]);
        g(&["config", "user.email", "t@example.com"]);
        g(&["config", "user.name", "T"]);
        g(&["add", "."]);
        g(&["commit", "-q", "-m", "start"]);
        let first = g(&["rev-parse", "HEAD"]);
        let plugins = plugins_at(&home, Arc::new(Recorder::default()));
        let added = plugins
            .add(&format!("file://{}", upstream.display()), Some("main"))
            .unwrap();
        assert_eq!(added.kind, "git");
        assert_eq!(added.commit.as_deref(), Some(first.as_str()));
        assert_eq!(added.plugins[0].declared.name, "github");
        assert_eq!(plugins.check(&added.id).unwrap(), None);

        std::fs::write(upstream.join("github/extra.txt"), "x").unwrap();
        g(&["add", "."]);
        g(&["commit", "-q", "-m", "more"]);
        let second = g(&["rev-parse", "HEAD"]);
        assert_eq!(
            plugins.check(&added.id).unwrap().as_deref(),
            Some(second.as_str())
        );
        assert_eq!(plugins.list()[0].newer.as_deref(), Some(second.as_str()));
        let updated = plugins.update(&added.id).unwrap();
        assert_eq!(updated.commit.as_deref(), Some(second.as_str()));
        assert_eq!(updated.newer, None);

        // A repository whose manifest is wrong adds nothing.
        let bad = source_with(
            "[[plugin]]\nname = \"x\"\npath = \"nowhere\"\nrun = [\"sh\"]\n",
            "bad-upstream",
        );
        let b = |args: &[&str]| git(&bad, args).unwrap();
        b(&["init", "-q", "-b", "main"]);
        b(&["config", "user.email", "t@example.com"]);
        b(&["config", "user.name", "T"]);
        b(&["add", "."]);
        b(&["commit", "-q", "-m", "start"]);
        let error = plugins
            .add(&format!("file://{}", bad.display()), None)
            .unwrap_err();
        assert!(error.contains("no directory"), "{error}");
        assert_eq!(plugins.list().len(), 1);
    }

    /// A plugin whose script its build writes, and which greets once it is
    /// run.
    #[cfg(unix)]
    const GREETER: &str = r#"#!/bin/sh
echo '{"type":"hello","name":"made","version":"1.0.0"}'
while IFS= read -r line; do
  case "$line" in
    *'"type":"stop"'*) exit 0;;
  esac
done
"#;

    #[cfg(unix)]
    const BUILDS: &str = r#"
[[plugin]]
name = "made"
path = "github"
description = "Built before it runs."
version = "1.0.0"
run = ["sh", "made.sh"]
build = ["sh", "build.sh"]
"#;

    #[cfg(unix)]
    #[test]
    fn builds_a_plugin_before_it_runs_and_builds_it_again_when_the_source_moves() {
        let home = Scratch::absent("plugins-build-home");
        let counter_dir = Scratch::new("plugins-builds");
        let counter = counter_dir.join("builds.txt");
        let upstream = source_with(BUILDS, "builds");
        std::fs::write(upstream.join("github/greeter"), GREETER).unwrap();
        std::fs::write(
            upstream.join("github/build.sh"),
            format!(
                "#!/bin/sh\necho built >> {}\ncp greeter made.sh\n",
                counter.display()
            ),
        )
        .unwrap();
        let g = |args: &[&str]| git(&upstream, args).unwrap();
        g(&["init", "-q", "-b", "main"]);
        g(&["config", "user.email", "t@example.com"]);
        g(&["config", "user.name", "T"]);
        g(&["add", "."]);
        g(&["commit", "-q", "-m", "start"]);

        // The script the plugin runs is not in the source: the manifest
        // stands because a build is what writes it.
        let recorder = Arc::new(Recorder::default());
        let plugins = plugins_at(&home, recorder.clone());
        let added = plugins
            .add(&format!("file://{}", upstream.display()), Some("main"))
            .unwrap();
        assert_eq!(added.plugins[0].declared.build, ["sh", "build.sh"]);

        let builds = || -> usize {
            std::fs::read_to_string(&counter)
                .unwrap_or_default()
                .lines()
                .count()
        };
        let came_up = || {
            for _ in 0..600 {
                std::thread::sleep(Duration::from_millis(100));
                if plugins.list()[0].plugins[0].state == State::Running {
                    return true;
                }
            }
            false
        };
        plugins.enable(&added.id, "made", true).unwrap();
        assert!(came_up(), "{:?}", plugins.list());
        assert_eq!(builds(), 1);
        assert!(recorder
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(event, payload)| event == PLUGIN_STATE && payload["state"] == "building"));

        // Off and on again is the same commit, so the build is not run a
        // second time.
        plugins.enable(&added.id, "made", false).unwrap();
        plugins.enable(&added.id, "made", true).unwrap();
        assert!(came_up(), "{:?}", plugins.list());
        assert_eq!(builds(), 1);

        // A newer commit is a build of its own.
        std::fs::write(upstream.join("github/extra.txt"), "x").unwrap();
        g(&["add", "."]);
        g(&["commit", "-q", "-m", "more"]);
        plugins.update(&added.id).unwrap();
        assert!(came_up(), "{:?}", plugins.list());
        assert_eq!(builds(), 2);
        plugins.enable(&added.id, "made", false).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_build_that_fails_says_so_on_the_row_and_starts_nothing() {
        let home = Scratch::absent("plugins-build-fails-home");
        let dir = source_with(BUILDS, "build-fails");
        std::fs::write(
            dir.join("github/build.sh"),
            "#!/bin/sh\necho 'src/main.ts(3,1): error TS1005' >&2\nexit 2\n",
        )
        .unwrap();
        let plugins = plugins_at(&home, Arc::new(Recorder::default()));
        let added = plugins.add(dir.to_string_lossy().as_ref(), None).unwrap();

        let settled = || -> PluginInfo {
            for _ in 0..100 {
                std::thread::sleep(Duration::from_millis(100));
                let plugin = plugins.list().swap_remove(0).plugins.swap_remove(0);
                if plugin.state == State::Failed {
                    return plugin;
                }
            }
            plugins.list().swap_remove(0).plugins.swap_remove(0)
        };
        plugins.enable(&added.id, "made", true).unwrap();
        let failed = settled();
        assert_eq!(failed.state, State::Failed);
        assert_eq!(
            failed.detail.as_deref(),
            Some("build failed: src/main.ts(3,1): error TS1005")
        );
        assert!(plugins.tools().is_empty());

        // A build that goes through and writes nothing is no better: the
        // script it was for is still not there.
        plugins.enable(&added.id, "made", false).unwrap();
        std::fs::write(dir.join("github/build.sh"), "#!/bin/sh\nexit 0\n").unwrap();
        plugins.enable(&added.id, "made", true).unwrap();
        let failed = settled();
        assert_eq!(
            failed.detail.as_deref(),
            Some("made.sh is not in its directory")
        );
        plugins.enable(&added.id, "made", false).unwrap();
    }

    #[test]
    fn a_root_is_in_a_project_when_it_is_the_project_or_under_it() {
        assert!(inside("/srv/orbit", "/srv/orbit"));
        assert!(inside("/srv/orbit/", "/srv/orbit"));
        assert!(inside("/srv/orbit/src/cache", "/srv/orbit"));
        assert!(inside(r"C:\work\app\src", r"C:\work\app"));
        assert!(!inside("/srv/orbit-api", "/srv/orbit"));
        assert!(!inside("/srv", "/srv/orbit"));
    }

    #[cfg(unix)]
    #[test]
    fn tells_a_plugin_the_app_the_projects_the_sessions_and_the_tree() {
        let home = Scratch::absent("plugins-told-home");
        let dir = source_with(
            r#"
[[plugin]]
name = "ears"
path = "github"
description = "Listens."
version = "1.0.0"
run = ["sh", "main.sh"]
"#,
            "told",
        );
        std::fs::write(dir.join("github/main.sh"), RECORDS).unwrap();
        let received = dir.join("github/received.txt");

        let plugins = plugins_at(&home, Arc::new(Recorder::default()));
        plugins.set_projects(vec!["/one".to_string(), "/two".to_string()]);
        let added = plugins.add(dir.to_string_lossy().as_ref(), None).unwrap();
        plugins.enable(&added.id, "ears", true).unwrap();

        let told = || -> Vec<serde_json::Value> {
            std::fs::read_to_string(&received)
                .unwrap_or_default()
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect()
        };
        // The plugin writes each line down on its own time.
        let wait = |count: usize| -> Vec<serde_json::Value> {
            for _ in 0..50 {
                let lines = told();
                if lines.len() >= count {
                    return lines;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            told()
        };

        // The greeting comes first, with the app and the projects open.
        let greeting = wait(1);
        assert_eq!(greeting.len(), 1, "{greeting:?}");
        assert_eq!(greeting[0]["type"], "hello");
        assert_eq!(greeting[0]["app"], env!("CARGO_PKG_VERSION"));
        assert_eq!(greeting[0]["projects"][0], "/one");
        assert_eq!(greeting[0]["projects"][1], "/two");

        // One project opened, one closed, and nothing of the one that
        // stayed open.
        plugins.set_projects(vec!["/two".to_string(), "/three".to_string()]);
        let projects = wait(3);
        assert_eq!(projects.len(), 3, "{projects:?}");
        assert_eq!(projects[1]["type"], "project");
        assert_eq!(projects[1]["event"], "opened");
        assert_eq!(projects[1]["path"], "/three");
        assert_eq!(projects[2]["event"], "closed");
        assert_eq!(projects[2]["path"], "/one");

        // The tree moved under an open project, and then somewhere no
        // project is.
        plugins.tree_moved("/two/src");
        plugins.tree_moved("/elsewhere");
        let tree = wait(4);
        assert_eq!(tree[3]["type"], "tree");
        assert_eq!(tree[3]["project"], "/two");

        // A session whose id is known at the spawn, one whose agent minted
        // its own, and a shell, which is no session at all.
        plugins.session_started("pty-1", started(Some("s-1"), Some("t-1"), "/two"));
        plugins.session_ended("pty-1");
        plugins.session_started("pty-2", started(None, Some("t-2"), "/three"));
        plugins.session_identified("pty-2", "s-2");
        plugins.session_ended("pty-3");
        let sessions = wait(7);
        // Seven lines in all: nothing was said of the tree outside the
        // projects, of the pty that had no session, or of the project that
        // stayed open.
        assert_eq!(sessions.len(), 7, "{sessions:?}");
        assert_eq!(sessions[4]["type"], "session");
        assert_eq!(sessions[4]["event"], "started");
        assert_eq!(sessions[4]["id"], "s-1");
        assert_eq!(sessions[4]["project"], "/two");
        assert_eq!(sessions[4]["cwd"], "/two");
        assert!(sessions[4].get("startedBy").is_none());
        assert_eq!(sessions[4]["worktree"], false);
        assert!(sessions[4].get("branch").is_none());
        assert_eq!(sessions[5]["event"], "ended");
        assert_eq!(sessions[5]["id"], "s-1");
        assert_eq!(sessions[5]["project"], "/two");
        assert_eq!(sessions[6]["event"], "started");
        assert_eq!(sessions[6]["id"], "s-2");
        assert_eq!(sessions[6]["project"], "/three");

        plugins.enable(&added.id, "ears", false).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn puts_a_plugin_s_rows_and_mark_on_a_session_and_opens_what_an_action_asks() {
        let home = Scratch::absent("plugins-session-home");
        let dir = source_with(
            r#"
[[plugin]]
name = "board"
path = "github"
description = "Session rows."
version = "1.0.0"
run = ["sh", "main.sh"]
"#,
            "session-rows",
        );
        let here = dunce::canonicalize(&dir)
            .unwrap()
            .to_string_lossy()
            .to_string();
        std::fs::write(
            dir.join("github/main.sh"),
            SESSIONS.replace("PROJECT", &here),
        )
        .unwrap();
        let received = dir.join("github/received.txt");
        let recorder = Arc::new(Recorder::default());
        let plugins = plugins_at(&home, recorder.clone());
        // Two sessions run before the plugin starts: one in a worktree of
        // the project, and one the first started.
        let worktree = format!("{here}/.worktrees/fix");
        plugins.session_started(
            "pty-1",
            Started {
                session: Some("s-1"),
                token: Some("t-1"),
                project: &here,
                cwd: &worktree,
                starter: None,
                worktree: true,
                branch: Some("fix"),
            },
        );
        plugins.session_started(
            "pty-2",
            Started {
                session: Some("s-2"),
                token: Some("t-2"),
                project: &here,
                cwd: &here,
                starter: Some("s-1"),
                worktree: false,
                branch: Some("ignored without a worktree"),
            },
        );
        let added = plugins.add(&here, None).unwrap();
        plugins.enable(&added.id, "board", true).unwrap();

        let events = |event: &str| -> Vec<serde_json::Value> {
            recorder
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|(name, _)| name == event)
                .map(|(_, payload)| payload.clone())
                .collect()
        };
        let wait = |event: &'static str, ok: &dyn Fn(&serde_json::Value) -> bool| {
            for _ in 0..50 {
                if let Some(payload) = events(event).into_iter().rev().find(|payload| ok(payload)) {
                    return payload;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            panic!("nothing said {event}");
        };

        // The sessions already running are told after the greeting, with
        // where each runs and who started it.
        let section = wait(PLUGIN_SECTION, &|payload| payload["session"] == "t-1");
        let mark = wait(PLUGIN_MARK, &|payload| payload["session"] == "t-1");
        let dot = wait(PLUGIN_MARK, &|payload| payload["session"] == "t-2");
        let told: Vec<serde_json::Value> = std::fs::read_to_string(&received)
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        assert_eq!(told[0]["type"], "hello");
        let s1 = told.iter().find(|line| line["id"] == "s-1").unwrap();
        assert_eq!(s1["type"], "session");
        assert_eq!(s1["event"], "started");
        assert_eq!(s1["project"], here);
        assert_eq!(s1["cwd"], worktree);
        assert!(s1.get("startedBy").is_none());
        // Made for s-1: a worktree on the branch it was made on. s-2 runs in
        // a folder the app did not make for it, and no branch is said.
        assert_eq!(s1["worktree"], true);
        assert_eq!(s1["branch"], "fix");
        let s2 = told.iter().find(|line| line["id"] == "s-2").unwrap();
        assert_eq!(s2["startedBy"], "s-1");
        assert_eq!(s2["cwd"], here);
        assert_eq!(s2["worktree"], false);
        assert!(s2.get("branch").is_none());

        // The session's rows reach the window under its token, facts and
        // all.
        assert_eq!(section["project"], here);
        assert_eq!(section["rows"][0]["id"], "ci");
        assert_eq!(section["rows"][0]["facts"][0]["label"], "lint");
        assert_eq!(section["rows"][0]["facts"][0]["text"], "2 errors");
        assert_eq!(section["rows"][0]["facts"][0]["state"], "failed");
        assert!(section["rows"][0]["facts"][1]["text"].is_null());

        // So does its mark, on one line; an icon the app has not got is a
        // dot, and a count of none or a state it does not know says nothing.
        assert_eq!(mark["source"], added.id);
        assert_eq!(mark["plugin"], "board");
        assert_eq!(mark["project"], here);
        assert_eq!(mark["icon"], "pull-request");
        assert_eq!(mark["count"], 2);
        assert_eq!(mark["state"], "failed");
        assert_eq!(mark["label"], "2 failing");
        assert!(mark.get("extra").is_none());
        // Marked under another project, it lands on the session's own.
        assert_eq!(dot["project"], here);
        assert_eq!(dot["icon"], "dot");
        assert!(dot["count"].is_null());
        assert!(dot["state"].is_null());

        // Rows and a mark for a session not running here are for nothing,
        // and a web address with no action waiting opens nothing.
        assert!(events(PLUGIN_SECTION)
            .iter()
            .all(|payload| payload["rows"][0]["id"] != "stray"));
        assert!(events(PLUGIN_MARK)
            .iter()
            .all(|payload| payload["icon"] != "branch"));
        assert!(events(PLUGIN_OPEN_URL).is_empty());

        // While an action waits, one web address that names it opens. One
        // that names no action, or one not sent, or that is not for a
        // browser, or a second for the same action, does not.
        plugins
            .action(
                &added.id,
                "board",
                "checks",
                "open",
                Some("ci"),
                &serde_json::json!({}),
                &here,
                Some("t-1"),
            )
            .unwrap();
        let opened = wait(PLUGIN_OPEN_URL, &|_| true);
        assert_eq!(opened["url"], "https://example.com/pull/1");
        assert_eq!(opened["project"], here);
        assert_eq!(opened["plugin"], "board");
        assert_eq!(events(PLUGIN_OPEN_URL).len(), 1);
        // The action on a session's row names that session by the agent's
        // id, as the session lines do.
        let action = std::fs::read_to_string(&received)
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .find(|line| line["type"] == "action")
            .unwrap();
        assert_eq!(action["session"], "s-1");
        assert_eq!(action["row"], "ci");

        // The session ends, and its rows and mark go with it; the other
        // session's mark stays.
        plugins.session_ended("pty-1");
        let gone = wait(PLUGIN_SECTION, &|payload| {
            payload["session"] == "t-1" && payload["rows"] == serde_json::json!([])
        });
        assert_eq!(gone["section"], "checks");
        let cleared = wait(PLUGIN_MARK, &|payload| {
            payload["session"] == "t-1" && payload["icon"].is_null()
        });
        assert!(cleared["count"].is_null());
        assert!(events(PLUGIN_MARK)
            .iter()
            .all(|payload| payload["session"] != "t-2" || !payload["icon"].is_null()));

        // An action the plugin holds unanswered when it dies opens nothing
        // for the process that starts in its place.
        let hellos = || {
            std::fs::read_to_string(&received)
                .unwrap()
                .matches(r#""type":"hello""#)
                .count()
        };
        plugins
            .action(
                &added.id,
                "board",
                "checks",
                "hold",
                None,
                &serde_json::json!({}),
                &here,
                None,
            )
            .unwrap();
        for _ in 0..50 {
            if hellos() == 2 {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(hellos(), 2, "the plugin was not started again");
        plugins
            .action(
                &added.id,
                "board",
                "checks",
                "open",
                Some("ci"),
                &serde_json::json!({}),
                &here,
                None,
            )
            .unwrap();
        wait(PLUGIN_OPEN_URL, &|payload| {
            payload["url"] == "https://example.com/pull/1" && events(PLUGIN_OPEN_URL).len() == 2
        });
        let opened: Vec<serde_json::Value> = events(PLUGIN_OPEN_URL)
            .iter()
            .map(|payload| payload["url"].clone())
            .collect();
        assert_eq!(
            opened,
            ["https://example.com/pull/1", "https://example.com/pull/1"]
        );

        // The plugin stops, and its mark on the other session goes too.
        let cleared = || {
            events(PLUGIN_MARK)
                .iter()
                .filter(|payload| payload["session"] == "t-2" && payload["icon"].is_null())
                .count()
        };
        let before = cleared();
        plugins.enable(&added.id, "board", false).unwrap();
        for _ in 0..50 {
            if cleared() > before {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(cleared() > before, "the mark stayed");
    }

    #[test]
    fn an_action_lets_its_own_plugin_open_one_web_address_for_30_seconds() {
        let board: Key = ("source".into(), "board".into());
        let other: Key = ("source".into(), "other".into());
        let sent = Instant::now();
        let mut waiting = Waiting {
            plugin: board.clone(),
            sent,
            opened: false,
        };
        assert!(waiting.may_open(&board, sent + Duration::from_secs(29)));
        assert!(!waiting.may_open(&other, sent));
        assert!(!waiting.may_open(&board, sent + OPEN_WINDOW));
        waiting.opened = true;
        assert!(!waiting.may_open(&board, sent));
    }

    #[test]
    fn a_web_address_is_http_or_https_with_a_host_and_nothing_else() {
        assert!(web_address("https://github.com/elva-labs/chord/pull/1"));
        assert!(web_address("http://localhost:3000/x?y=1#z"));
        assert!(web_address("HTTPS://example.com"));
        assert!(!web_address("https://"));
        assert!(!web_address("https:///etc/passwd"));
        assert!(!web_address("file:///etc/passwd"));
        assert!(!web_address("javascript:alert(1)"));
        assert!(!web_address("ftp://example.com"));
        assert!(!web_address("https://example.com/a b"));
        assert!(!web_address("https://example.com/\n"));
        assert!(!web_address(&format!(
            "https://example.com/{}",
            "a".repeat(2048)
        )));
    }

    #[test]
    fn names_a_session_to_the_window_by_its_token_never_its_id() {
        let home = Scratch::absent("plugins-token-of-home");
        let plugins = plugins_at(&home, Arc::new(Recorder::default()));
        plugins.session_started("pty-1", started(Some("s-1"), Some("t-1"), "/p"));
        plugins.session_started("pty-2", started(None, Some("t-2"), "/p"));
        assert_eq!(plugins.inner.token_of("s-1").as_deref(), Some("t-1"));
        // An id the core has not learned yet, or never ran, names none,
        // and neither does a token passed off as an id.
        assert_eq!(plugins.inner.token_of("s-2"), None);
        assert_eq!(plugins.inner.token_of("t-1"), None);
        plugins.session_identified("pty-2", "s-2");
        assert_eq!(plugins.inner.token_of("s-2").as_deref(), Some("t-2"));
        // Two running sessions found to have one id name neither.
        plugins.session_started("pty-3", started(Some("s-1"), Some("t-3"), "/p"));
        assert_eq!(plugins.inner.token_of("s-1"), None);
        plugins.session_ended("pty-3");
        assert_eq!(plugins.inner.token_of("s-1").as_deref(), Some("t-1"));
        // A session that has ended names none.
        plugins.session_ended("pty-1");
        assert_eq!(plugins.inner.token_of("s-1"), None);
    }

    /// Whether a command line runs one of the beginnings.
    fn line_runs(line: &str, beginnings: &[&str]) -> bool {
        let beginnings: Vec<String> = beginnings.iter().map(|b| b.to_string()).collect();
        command_parts(line)
            .iter()
            .any(|part| runs(part, &beginnings))
    }

    #[test]
    fn hears_a_command_wherever_it_stands_in_a_line_and_nothing_else() {
        let create = ["gh pr create"];
        for line in [
            "gh pr create",
            "gh pr create --fill --base main",
            "cd ../x && gh pr create --fill",
            "git push -u origin HEAD; gh pr create",
            "gh pr create --fill | tee out.txt",
            "git push || gh pr create",
            "(cd x && gh pr create)",
            "echo $(gh pr create --fill)",
            "echo `gh pr create`",
            "FOO=1 GH_HOST=github.com gh pr create",
            "env GH_TOKEN=x gh pr create",
            "time gh pr create",
            "/usr/local/bin/gh pr create",
            "gh   pr\tcreate",
            "gh 'pr' \"create\" --title 'A title; with | stuff'",
            "gh pr \\\n  create --fill",
            "git add -A\ngh pr create",
            "if true; then gh pr create; fi",
            "/bin/zsh -lc 'gh pr create --fill'",
            "bash -c \"cd x && gh pr create --title \\\"x\\\"\"",
            "sh -c 'sh -c \"gh pr create\"'",
        ] {
            assert!(line_runs(line, &create), "{line:?} was not heard");
        }
        for line in [
            "",
            "gh pr createx",
            "gh pr list",
            "gh pr",
            "gh issue create",
            "echo gh pr create",
            "echo \"gh pr create\"",
            "echo 'cd x && gh pr create'",
            "git commit -m 'then gh pr create'",
            "# gh pr create",
            "ls # ; gh pr create",
            "ghx pr create",
            "/usr/local/bin/ghx pr create",
            "zsh -lc",
            "grep 'gh pr create' notes.txt",
            "cat > notes.md <<EOF\ngh pr create --fill\nEOF",
            "cat > notes.md <<-'EOF'\n\tgh pr create\n\tEOF",
            "cat <<A <<\"B\"\ngh pr create\nA\ngh pr create\nB",
            "git commit -m \"$(cat <<'EOF'\nSay \"hi\"\ngh pr create\nEOF\n)\"",
            "cat <<EOF\ngh pr create, never ended",
        ] {
            assert!(!line_runs(line, &create), "{line:?} was heard");
        }
        // After a heredoc's body, the line goes on as commands.
        assert!(line_runs(
            "cat > notes.md <<EOF\nx\nEOF\ngh pr create",
            &create
        ));
        assert!(line_runs("cat <<< 'x'; gh pr create", &create));
        assert!(line_runs(
            "gh pr create --title \"x\" --body \"$(cat <<'EOF'\nSays \"hi\" twice \"\nEOF\n)\" && gh pr view",
            &create
        ));
        // A beginning that names a path matches that path only.
        assert!(line_runs("/opt/gh pr create", &["/opt/gh pr create"]));
        assert!(!line_runs("gh pr create", &["/opt/gh pr create"]));
        // Any of several beginnings will do, and none is none.
        assert!(line_runs(
            "gh pr merge 7 --squash",
            &["gh pr create", "gh pr merge"]
        ));
        assert!(!line_runs("gh pr create", &[]));
    }

    #[test]
    fn tells_a_command_s_own_words_and_its_output_only_when_no_other_command_prints() {
        let heard = |line: &str| -> Vec<(String, bool)> {
            let parts = command_parts(line);
            let create = ["gh pr create".to_string()];
            (0..parts.len())
                .filter(|at| runs(&parts[*at], &create))
                .map(|at| {
                    (
                        parts[at].text.clone(),
                        output_of(&parts, at, "out").is_some(),
                    )
                })
                .collect()
        };
        let own = |text: &str| vec![(text.to_string(), true)];
        let withheld = |text: &str| vec![(text.to_string(), false)];
        assert_eq!(heard("gh pr create --fill"), own("gh pr create --fill"));
        assert_eq!(
            heard("GH_TOKEN=x FOO=\"a b\" gh pr create --title 'A; b'"),
            own("gh pr create --title 'A; b'")
        );
        assert_eq!(heard("env GH_TOKEN=x gh pr create"), own("gh pr create"));
        assert_eq!(
            heard("bash -lc 'cd api && gh pr create --fill'"),
            own("gh pr create --fill")
        );
        assert_eq!(
            heard("cd x; export A=1 B='b c'; X=2; set -e; set -euo pipefail; set +e; gh pr create"),
            own("gh pr create")
        );
        assert_eq!(heard("gh pr create 2>&1"), own("gh pr create 2>&1"));
        assert_eq!(
            heard("gh pr create --body-file - <<'EOF'\nbody; rm -rf x\nEOF"),
            own("gh pr create --body-file -")
        );
        assert_eq!(heard("if gh pr create; then cd x; fi"), own("gh pr create"));
        for (line, text) in [
            ("git push && gh pr create", "gh pr create"),
            ("gh pr create | tail -1", "gh pr create"),
            ("export; gh pr create", "gh pr create"),
            ("set; gh pr create", "gh pr create"),
            ("export -p; gh pr create", "gh pr create"),
            ("export A=1 -p; gh pr create", "gh pr create"),
            ("export A=\"$(cat .env)\"; gh pr create", "gh pr create"),
            ("export A=$'x'; gh pr create", "gh pr create"),
            ("set -x; T=secret gh pr create", "gh pr create"),
            ("set -v; gh pr create", "gh pr create"),
            ("set -o; gh pr create", "gh pr create"),
            ("set +o; gh pr create", "gh pr create"),
            ("set -o xtrace; gh pr create", "gh pr create"),
            ("set -ex; gh pr create", "gh pr create"),
            ("pushd y; gh pr create", "gh pr create"),
            ("popd; gh pr create", "gh pr create"),
            ("cd -; gh pr create", "gh pr create"),
            ("cd \"`cat .env`\"; gh pr create", "gh pr create"),
            ("X=${B:?$TOKEN}; gh pr create", "gh pr create"),
            ("A=${B:?$TOKEN} cd x; gh pr create", "gh pr create"),
            ("export A=${B:?$TOKEN}; gh pr create", "gh pr create"),
            ("cd \"$DIR\"; gh pr create", "gh pr create"),
            ("cd <(cat .env); gh pr create", "gh pr create"),
            ("env; gh pr create", "gh pr create"),
            ("env A=1; gh pr create", "gh pr create"),
            ("time cd x; gh pr create", "gh pr create"),
            ("echo $(gh pr create)", "gh pr create"),
            ("zsh -lc 'cat .env; gh pr create'", "gh pr create"),
        ] {
            assert_eq!(heard(line), withheld(text), "{line:?}");
        }
        // Two heard in one line print beside each other.
        assert_eq!(
            heard("gh pr create -t a; gh pr create -t b"),
            vec![
                ("gh pr create -t a".to_string(), false),
                ("gh pr create -t b".to_string(), false)
            ]
        );
    }

    #[test]
    fn tells_the_end_of_a_long_output_and_never_splits_a_character() {
        let short = "https://github.com/o/r/pull/7\n";
        assert_eq!(output_end(short), (short, false));
        let exact = "a".repeat(COMMAND_OUTPUT);
        assert_eq!(output_end(&exact), (exact.as_str(), false));

        let long = format!("{}{short}", "é".repeat(COMMAND_OUTPUT));
        let (end, cut) = output_end(&long);
        assert!(cut);
        assert!(end.len() <= COMMAND_OUTPUT);
        assert!(end.len() >= COMMAND_OUTPUT - 1);
        assert!(end.ends_with(short));
        assert!(end.starts_with('é'));
    }

    #[test]
    fn reads_the_commands_a_manifest_listens_for() {
        let dir = source_with(
            "[[plugin]]\nname = \"github\"\npath = \"github\"\nrun = [\"sh\", \"main.sh\"]\ncommands = [\"gh pr create\", \"  gh   pr\\tmerge \", \"gh pr create\"]\n",
            "listens",
        );
        let declared = read_manifest(&dir, &vars()).unwrap();
        assert_eq!(declared[0].commands, ["gh pr create", "gh pr merge"]);

        let none = source_with(GOOD, "listens-for-nothing");
        assert!(read_manifest(&none, &vars()).unwrap()[0]
            .commands
            .is_empty());

        let many = (0..=COMMAND_BEGINNINGS)
            .map(|at| format!("\"tool {at}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let wrong = [
            ("[\"   \"]".to_string(), "must be words"),
            (
                format!("[\"{}\"]", "a".repeat(COMMAND_BEGINNING + 1)),
                "must be words",
            ),
            ("[\"gh\\u0007 pr\"]".to_string(), "must be words"),
            (format!("[{many}]"), "at most 16 commands"),
            ("\"gh pr create\"".to_string(), "commands"),
        ];
        for (commands, expected) in wrong {
            let manifest = format!(
                "[[plugin]]\nname = \"github\"\npath = \"github\"\nrun = [\"sh\", \"main.sh\"]\ncommands = {commands}\n"
            );
            let dir = source_with(&manifest, "listens-wrong");
            let error = read_manifest(&dir, &vars()).unwrap_err();
            assert!(error.contains(expected), "{commands} gave {error:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn tells_a_plugin_only_the_commands_it_listens_for_once_each() {
        let home = Scratch::absent("plugins-commands-home");
        let dir = source_with(
            r#"
[[plugin]]
name = "ears"
path = "github"
run = ["sh", "main.sh"]
commands = ["gh pr create", "gh pr merge"]

[[plugin]]
name = "old"
path = "old"
run = ["sh", "main.sh"]
"#,
            "commands",
        );
        std::fs::create_dir_all(dir.join("old")).unwrap();
        std::fs::write(dir.join("github/main.sh"), RECORDS).unwrap();
        std::fs::write(dir.join("old/main.sh"), RECORDS).unwrap();
        let heard = |plugin: &str| -> Vec<serde_json::Value> {
            std::fs::read_to_string(dir.join(plugin).join("received.txt"))
                .unwrap_or_default()
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect()
        };
        let wait = |plugin: &str, ok: &dyn Fn(&[serde_json::Value]) -> bool| {
            for _ in 0..50 {
                if ok(&heard(plugin)) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            panic!("{plugin} heard {:?}", heard(plugin));
        };
        let commands = |plugin: &str| -> Vec<serde_json::Value> {
            heard(plugin)
                .into_iter()
                .filter(|line| line["type"] == "command")
                .collect()
        };

        let recorder = Arc::new(Recorder::default());
        let plugins = plugins_at(&home, recorder.clone());
        let hears = || -> Vec<serde_json::Value> {
            recorder
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|(event, _)| event == PLUGIN_HEARS)
                .map(|(_, payload)| payload["hears"].clone())
                .collect()
        };
        plugins.set_projects(vec!["/p".to_string()]);
        plugins.session_started(
            "pty-1",
            Started {
                session: Some("s-1"),
                token: Some("t-1"),
                project: "/p",
                cwd: "/p/.claude/worktrees/fix",
                starter: None,
                worktree: true,
                branch: Some("fix"),
            },
        );
        let added = plugins.add(dir.to_string_lossy().as_ref(), None).unwrap();
        plugins.enable(&added.id, "ears", true).unwrap();
        plugins.enable(&added.id, "old", true).unwrap();
        for plugin in ["github", "old"] {
            wait(plugin, &|lines| {
                lines.iter().any(|line| line["type"] == "hello")
            });
        }
        assert!(crate::hook::hears_commands(&home));
        // Told once, when the first comes to listen.
        assert_eq!(hears(), vec![serde_json::json!(true)]);

        let address = "https://github.com/o/r/pull/7\n";
        let long = format!("{}{address}", "é".repeat(COMMAND_OUTPUT));
        let ran = |pty, session, call, command, cwd, ok, output| Ran {
            pty,
            session,
            call,
            command,
            cwd,
            ok,
            output,
            truncated: false,
        };
        // Heard from a conversation's stream, in a folder of its own, beside
        // a command that prints nothing.
        plugins.command_ran(ran(
            Some("pty-1"),
            None,
            "call-1",
            "cd x && GH_TOKEN=secret gh pr create --fill",
            Some("/p/x"),
            true,
            &long,
        ));
        // The same call heard again from a hook, by the session's id.
        plugins.command_ran(ran(
            None,
            Some("s-1"),
            "call-1",
            "cd x && GH_TOKEN=secret gh pr create --fill",
            Some("/p/x"),
            true,
            address,
        ));
        // Commands no plugin listens for, one of them only the body of a
        // heredoc.
        for (call, command) in [
            ("call-2", "gh pr list"),
            ("call-3", "echo gh pr create"),
            ("call-4", "gh pr createx"),
            (
                "call-8",
                "cat > notes.md <<'EOF'\ngh pr create --fill\nEOF\ngit status",
            ),
        ] {
            plugins.command_ran(ran(Some("pty-1"), None, call, command, None, true, ""));
        }
        // A session, and a pty, the core does not know.
        plugins.command_ran(ran(
            None,
            Some("s-x"),
            "call-5",
            "gh pr create",
            None,
            true,
            "",
        ));
        plugins.command_ran(ran(
            Some("pty-x"),
            None,
            "call-6",
            "gh pr create",
            None,
            true,
            "",
        ));
        // One that failed, wrapped in a shell, with no folder of its own.
        plugins.command_ran(ran(
            None,
            Some("s-1"),
            "call-7",
            "/bin/zsh -lc 'gh pr merge 7 --squash'",
            None,
            false,
            "not mergeable\n",
        ));
        // One beside commands that print, whose output is not its own.
        plugins.command_ran(ran(
            Some("pty-1"),
            None,
            "call-9",
            "export GH_TOKEN=secret; curl -H \"Authorization: secret\" api && gh pr create --fill",
            None,
            true,
            "{\"token\": \"secret\"}\nhttps://github.com/o/r/pull/8\n",
        ));

        wait("github", &|_| commands("github").len() >= 3);
        // Both stop, and what each heard before the stop is all it heard.
        plugins.enable(&added.id, "ears", false).unwrap();
        plugins.enable(&added.id, "old", false).unwrap();
        for plugin in ["github", "old"] {
            wait(plugin, &|lines| {
                lines.iter().any(|line| line["type"] == "stop")
            });
        }
        assert!(commands("old").is_empty(), "{:?}", commands("old"));
        assert!(!crate::hook::hears_commands(&home));
        assert_eq!(
            hears(),
            vec![serde_json::json!(true), serde_json::json!(false)]
        );
        let told = commands("github");
        assert_eq!(told.len(), 3, "{told:?}");
        assert_eq!(told[0]["project"], "/p");
        assert_eq!(told[0]["session"], "s-1");
        assert_eq!(told[0]["cwd"], "/p/x");
        assert_eq!(told[0]["command"], "gh pr create --fill");
        assert_eq!(told[0]["ok"], true);
        assert_eq!(told[0]["truncated"], true);
        assert_eq!(told[0]["withheld"], false);
        let output = told[0]["output"].as_str().unwrap();
        assert!(output.len() <= COMMAND_OUTPUT);
        assert!(output.ends_with(address));
        assert_eq!(told[1]["session"], "s-1");
        assert_eq!(told[1]["cwd"], "/p/.claude/worktrees/fix");
        assert_eq!(told[1]["command"], "gh pr merge 7 --squash");
        assert_eq!(told[1]["ok"], false);
        assert_eq!(told[1]["output"], "not mergeable\n");
        assert_eq!(told[1]["truncated"], false);
        assert_eq!(told[1]["withheld"], false);
        assert_eq!(told[2]["command"], "gh pr create --fill");
        assert_eq!(told[2]["output"], serde_json::Value::Null);
        assert_eq!(told[2]["truncated"], false);
        assert_eq!(told[2]["withheld"], true);
        // Nothing of the rest of a line reaches the plugin.
        for line in &told {
            assert!(!line.to_string().contains("secret"), "{line}");
        }
    }
}
