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
use crate::show::{
    Answer, DiffRequest, NotifyRequest, PresentRequest, ShowRequest, ToolRequest, DIFF_REQUEST,
    NOTIFY_REQUEST, PRESENT_REQUEST, SHOW_REQUEST,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
    pub tools: Vec<String>,
    pub sections: Vec<String>,
    /// "wide" or "full", when the plugin has a view.
    pub view: Option<String>,
}

/// Where a plugin process is, as the window shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Off,
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
    home.join(".agent-workbench").join("plugin-tools.json")
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
}

/// A section's rows for one project, as told to the window. Empty rows
/// and no actions is the section gone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SectionEvent {
    pub source: String,
    pub plugin: String,
    pub section: String,
    pub title: String,
    pub project: String,
    pub rows: Vec<Row>,
    pub actions: Vec<Action>,
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
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    sources: Vec<StoredSource>,
}

struct Running {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    state: State,
    detail: Option<String>,
    hello: Option<Hello>,
    /// How many starts in a row went wrong, for the pause before the next.
    failures: u32,
    /// The last lines the plugin wrote to its error output, for the row
    /// to say why it went.
    complaints: Arc<Mutex<VecDeque<String>>>,
}

/// How many lines of a plugin's error output are kept for its row.
const COMPLAINTS: usize = 5;

/// How many starts in a row may go wrong before the plugin is left alone:
/// one that dies before it greets is broken, not unlucky, and is not
/// started every half minute until the app closes.
const TRIES: u32 = 5;

type Key = (String, String);

/// An agent's pty as the runtime follows it: the session it runs, known at
/// the spawn or found afterwards, and the project it belongs to.
struct Pty {
    session: Option<String>,
    project: String,
}

/// A source, a plugin, a section of that plugin, and the project the rows
/// are for: what one set of rows is kept under.
type SectionKey = (String, String, String, String);

/// A source, a plugin, and the project a page is for: what one page is
/// kept under.
type ViewKey = (String, String, String);

struct Inner {
    home: PathBuf,
    root: PathBuf,
    sink: Arc<dyn Sink>,
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
    /// from a tool call's.
    pending: Mutex<HashSet<String>>,
    /// The projects open on this machine, as the window last said.
    projects: Mutex<Vec<String>>,
    /// The agents' ptys, by pty id, so a session that ends is named by the
    /// session it ran. A shell has no entry.
    ptys: Mutex<HashMap<String, Pty>>,
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
fn valid_name(name: &str) -> bool {
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
/// every runtime on the login shell's PATH, every name a plain identifier.
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
        if run.len() > 1 {
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
        declared.push(Declared {
            name,
            path: relative,
            description: string("description").unwrap_or_default(),
            version: string("version").unwrap_or_else(|_| "0.0.0".to_string()),
            run,
            tools,
            sections: strings("sections")?,
            view,
        });
    }
    if declared.is_empty() {
        return Err("manifest names no plugins".to_string());
    }
    Ok(declared)
}

/// Every git call the plugins make. The ext transport runs whatever a
/// URL names, so it is off; what the caller passes is arguments alone.
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(["-c", "protocol.ext.allow=never"])
        .args(args)
        .current_dir(dir)
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

impl Plugins {
    /// The sources' directory is under the app's own in the home.
    pub fn new(home: &Path, sink: Arc<dyn Sink>) -> Self {
        let root = home.join(".agent-workbench").join("plugins");
        let stored = std::fs::read_to_string(root.join("state.json"))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Self {
            inner: Arc::new(Inner {
                home: home.to_path_buf(),
                root,
                sink,
                stored: Mutex::new(stored),
                running: Mutex::new(HashMap::new()),
                newer: Mutex::new(HashMap::new()),
                sections: Mutex::new(HashMap::new()),
                views: Mutex::new(HashMap::new()),
                pending: Mutex::new(HashSet::new()),
                projects: Mutex::new(Vec::new()),
                ptys: Mutex::new(HashMap::new()),
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
    /// agent that mints its own id, which `session_identified` brings.
    pub fn session_started(&self, pty_id: &str, session: Option<&str>, project: &str) {
        self.inner.session_started(pty_id, session, project);
    }

    /// The id an agent minted for a session of its own, once it is known.
    pub fn session_identified(&self, pty_id: &str, session: &str) {
        self.inner.session_identified(pty_id, session);
    }

    /// A pty ended. One with no session on it, a shell's, says nothing.
    pub fn session_ended(&self, pty_id: &str) {
        self.inner.session_ended(pty_id);
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
    ) -> Result<(), String> {
        self.inner
            .action(source_id, name, section, action, row, input, project)
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
        project: project.to_string(),
        rows,
        actions: checked_actions(message.get("actions")),
    })
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
        std::fs::create_dir_all(&self.root)
            .map_err(|e| format!("could not create {:?}: {e}", self.root))?;
        let text = serde_json::to_string_pretty(stored).map_err(|e| e.to_string())?;
        std::fs::write(self.root.join("state.json"), text)
            .map_err(|e| format!("could not write the plugin state: {e}"))
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
        let running = self.running.lock().expect("plugins lock");
        let plugins = plugins
            .into_iter()
            .map(|declared| {
                let enabled = source.enabled.contains(&declared.name);
                let live = running.get(&(source.id.clone(), declared.name.clone()));
                PluginInfo {
                    enabled,
                    state: live.map(|r| r.state.clone()).unwrap_or(State::Off),
                    detail: live.and_then(|r| r.detail.clone()),
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
            plugins,
        }
    }

    fn list(&self) -> Vec<SourceInfo> {
        let stored = self.stored.lock().expect("plugins lock");
        stored
            .sources
            .iter()
            .map(|source| self.describe(source))
            .collect()
    }

    fn add(
        self: &Arc<Self>,
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
        let id = source_id(&location);
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
            let source = stored
                .sources
                .iter_mut()
                .find(|s| s.id == id)
                .ok_or("no such source")?;
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

    fn start(self: &Arc<Self>, source: &StoredSource, name: &str) {
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
            .env("WORKBENCH_PLUGIN", name)
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
        let stdin = Arc::new(Mutex::new(child.stdin.take().expect("piped stdin")));
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        // What the plugin complains of is kept, the last few lines of it,
        // so a plugin that dies can say why on its row.
        let complaints = Arc::new(Mutex::new(VecDeque::new()));
        {
            let complaints = Arc::clone(&complaints);
            std::thread::spawn(move || {
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
        // app's version and the projects open on this machine.
        let projects = self.projects.lock().expect("plugins lock").clone();
        let hello = serde_json::json!({
            "type": "hello",
            "app": env!("CARGO_PKG_VERSION"),
            "projects": projects,
        });
        if let Ok(mut pipe) = stdin.lock() {
            let _ = writeln!(pipe, "{hello}");
            let _ = pipe.flush();
        }
        {
            let mut running = self.running.lock().expect("plugins lock");
            running.insert(
                key.clone(),
                Running {
                    child,
                    stdin,
                    state: State::Starting,
                    detail: None,
                    hello: None,
                    failures,
                    complaints,
                },
            );
        }
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
                let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                let kind = message.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if kind == "hello" && !greeted {
                    greeted = true;
                    let hello: Option<Hello> = serde_json::from_value(message.clone()).ok();
                    {
                        let mut running = plugins.running.lock().expect("plugins lock");
                        if let Some(live) = running.get_mut(&(source_id.clone(), plugin.clone())) {
                            live.state = State::Running;
                            live.failures = 0;
                            live.hello = hello.clone();
                            live.detail = None;
                        }
                    }
                    plugins.publish();
                    plugins.tell(&source_id, &plugin, State::Running, None, hello);
                } else if kind == "result" {
                    plugins.answered(&source_id, &plugin, &message);
                } else {
                    plugins.said(&source_id, &plugin, kind, &message);
                }
            }
            plugins.exited(&source_id, &plugin, greeted);
        });
    }

    /// The process is gone: said so, and started again after a pause when
    /// it is still on.
    fn exited(self: &Arc<Self>, source_id: &str, name: &str, greeted: bool) {
        let key: Key = (source_id.to_string(), name.to_string());
        let still_on = {
            let stored = self.stored.lock().expect("plugins lock");
            stored
                .sources
                .iter()
                .any(|s| s.id == source_id && s.enabled.iter().any(|n| n == name))
        };
        let (failures, detail) = {
            let mut running = self.running.lock().expect("plugins lock");
            let Some(live) = running.get_mut(&key) else {
                return;
            };
            // Its output has ended, which is as gone as a plugin gets: a
            // process that closed its output and stayed is ended here, or
            // the wait would hold the lock for as long as it lived.
            let _ = live.child.kill();
            let code = live.child.wait().ok().and_then(|status| status.code());
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
            let out = (live.failures, live.detail.clone());
            if !still_on {
                running.remove(&key);
            }
            out
        };
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
    fn stop(&self, source_id: &str, name: &str) {
        let key: Key = (source_id.to_string(), name.to_string());
        let stdin = {
            let mut running = self.running.lock().expect("plugins lock");
            let Some(live) = running.get_mut(&key) else {
                return;
            };
            live.state = State::Off;
            Arc::clone(&live.stdin)
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
            match running.get_mut(&key) {
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
        if let Some(mut live) = running.remove(&key) {
            let _ = live.child.kill();
            let _ = live.child.wait();
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
    /// sees one list or the other and never half of one.
    fn publish(&self) {
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
        let message = serde_json::json!({
            "type": "tool",
            "id": request.id,
            "name": request.tool,
            "arguments": request.arguments,
            "project": request.cwd,
            "session": request.session,
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
        if self.pending.lock().expect("plugins lock").remove(id) {
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
                let Some(section) = checked_section(source_id, name, message) else {
                    return;
                };
                let key: SectionKey = (
                    source_id.to_string(),
                    name.to_string(),
                    section.section.clone(),
                    section.project.clone(),
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
            _ => {}
        }
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

    fn tell_section(&self, section: &SectionEvent) {
        crate::events::emit(&self.sink, PLUGIN_SECTION, section);
    }

    /// The rows a plugin left on the tree go with it: every section it had
    /// is told empty and forgotten.
    fn forget_sections(&self, source_id: &str, name: &str) {
        let gone: Vec<SectionEvent> = {
            let mut sections = self.sections.lock().expect("plugins lock");
            let keys: Vec<SectionKey> = sections
                .keys()
                .filter(|(source, plugin, _, _)| source == source_id && plugin == name)
                .cloned()
                .collect();
            keys.iter().filter_map(|key| sections.remove(key)).collect()
        };
        for section in gone {
            self.tell_section(&SectionEvent {
                rows: Vec::new(),
                actions: Vec::new(),
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
                crate::events::emit(
                    &self.sink,
                    NOTIFY_REQUEST,
                    &NotifyRequest {
                        text: line,
                        cwd: project,
                        session: text("session"),
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
    ) -> Result<(), String> {
        let id = uuid::Uuid::new_v4().to_string();
        let message = serde_json::json!({
            "type": "action",
            "id": id,
            "section": section,
            "action": action,
            "row": row,
            "input": input,
            "project": project,
        });
        self.pending
            .lock()
            .expect("plugins lock")
            .insert(id.clone());
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

    fn session_started(&self, pty_id: &str, session: Option<&str>, project: &str) {
        self.ptys.lock().expect("plugins lock").insert(
            pty_id.to_string(),
            Pty {
                session: session.map(str::to_string),
                project: project.to_string(),
            },
        );
        if let Some(session) = session {
            self.session_line("started", session, project);
        }
    }

    fn session_identified(&self, pty_id: &str, session: &str) {
        let project = {
            let mut ptys = self.ptys.lock().expect("plugins lock");
            let Some(pty) = ptys.get_mut(pty_id) else {
                return;
            };
            if pty.session.is_some() {
                return;
            }
            pty.session = Some(session.to_string());
            pty.project.clone()
        };
        self.session_line("started", session, &project);
    }

    fn session_ended(&self, pty_id: &str) {
        let gone = self.ptys.lock().expect("plugins lock").remove(pty_id);
        let Some(Pty {
            session: Some(session),
            project,
        }) = gone
        else {
            return;
        };
        self.session_line("ended", &session, &project);
    }

    fn session_line(&self, event: &str, session: &str, project: &str) {
        self.broadcast(&serde_json::json!({
            "type": "session",
            "event": event,
            "id": session,
            "project": project,
        }));
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
    use super::*;
    use crate::events::testing::Recorder;

    fn vars() -> HashMap<String, String> {
        HashMap::from([(
            "PATH".to_string(),
            std::env::var("PATH").unwrap_or_default(),
        )])
    }

    fn source_with(manifest: &str, name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("workbench-plugins-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("github")).unwrap();
        std::fs::write(dir.join("github/main.sh"), "#!/bin/sh\n").unwrap();
        std::fs::write(dir.join(MANIFEST), manifest).unwrap();
        dir
    }

    /// A plugin that says its rows, points at a place, leaves a line, and
    /// answers an action with what went wrong.
    const SECTIONS: &str = r#"#!/bin/sh
echo '{"type":"hello","name":"board","version":"1.0.0"}'
echo '{"type":"section","id":"pull-request","title":"Pull request","project":"PROJECT","rows":[{"id":"lint","label":"lint","detail":"3 of 4","state":"ok","actions":[{"id":"open","label":"Open"}],"default":"open"},{"id":"","label":"nothing"}],"actions":[{"id":"refresh","label":"Refresh","input":[{"id":"branch","label":"Branch","kind":"text"}]}]}'
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
    const RECORDS: &str = r#"#!/bin/sh
echo '{"type":"hello","name":"ears","version":"1.0.0"}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> received.txt
  case "$line" in
    *'"type":"stop"'*) exit 0;;
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

        let wrong = [
            ("", "no [[plugin]] entries"),
            ("[[plugin]]\nname = \"GitHub\"\npath = \"github\"\nrun = [\"sh\"]\n", "must be lowercase"),
            ("[[plugin]]\nname = \"github\"\npath = \"../x\"\nrun = [\"sh\"]\n", "stay under the source"),
            ("[[plugin]]\nname = \"github\"\npath = \"nowhere\"\nrun = [\"sh\"]\n", "no directory"),
            ("[[plugin]]\nname = \"github\"\npath = \"github\"\nrun = [\"no-such-runtime-xyz\"]\n", "not on the PATH"),
            ("[[plugin]]\nname = \"github\"\npath = \"github\"\nrun = [\"sh\", \"missing.sh\"]\n", "not in its directory"),
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
        let nothing = std::env::temp_dir().join("workbench-plugins-nothing");
        let _ = std::fs::remove_dir_all(&nothing);
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
        let home = std::env::temp_dir().join("workbench-plugins-home");
        let _ = std::fs::remove_dir_all(&home);
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
        let plugins = Plugins::new(&home, recorder.clone());
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
        for _ in 0..50 {
            std::thread::sleep(Duration::from_millis(100));
            let listed = plugins.list();
            if listed[0].plugins[0].state == State::Running {
                running = true;
                assert_eq!(listed[0].plugins[0].hello.as_ref().unwrap().tools.len(), 1);
                break;
            }
        }
        assert!(running, "{:?}", plugins.list());
        assert!(recorder
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(event, payload)| event == PLUGIN_STATE && payload["state"] == "running"));

        let off = plugins.enable(&added.id, "echo", false).unwrap();
        assert!(!off.plugins[0].enabled);
        assert_eq!(off.plugins[0].state, State::Off);

        // The state survives a new core, and a removed source is gone.
        let again = Plugins::new(&home, recorder.clone());
        assert_eq!(again.list().len(), 1);
        again.remove(&added.id).unwrap();
        assert!(again.list().is_empty());
        assert!(Plugins::new(&home, recorder).list().is_empty());
    }

    #[test]
    fn a_plugin_that_dies_before_greeting_says_why_and_is_left_alone_in_time() {
        let home = std::env::temp_dir().join("workbench-plugins-home-dies");
        let _ = std::fs::remove_dir_all(&home);
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
        let plugins = Plugins::new(&home, recorder.clone());
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
        assert!(failed.starts_with("stopped after 5 tries: exited with code 3: Error: cannot find module ./board"), "{failed}");
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
        assert!(matches!(on.plugins[0].state, State::Starting | State::Stopped | State::Running));
        plugins.enable(&added.id, "brief", false).unwrap();
    }

    #[test]
    fn leaves_a_call_for_a_source_it_has_never_heard_of_alone() {
        // An app and a daemon can share a home, and both tail the log. A
        // core answers only for the sources it holds, so the one that has
        // the plugin is the one that answers.
        let home = std::env::temp_dir().join("workbench-plugins-other-home");
        let _ = std::fs::remove_dir_all(&home);
        let plugins = Plugins::new(&home, Arc::new(Recorder::default()));
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
        let home = std::env::temp_dir().join("workbench-plugins-tools-home");
        let _ = std::fs::remove_dir_all(&home);
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
      printf '{"type":"result","id":"%s","content":"pong"}\n' "$id"
      ;;
  esac
done
"#,
        )
        .unwrap();
        let plugins = Plugins::new(&home, Arc::new(Recorder::default()));
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

        let call = |id: &str, plugin: &str| ToolRequest {
            id: id.to_string(),
            source: added.id.clone(),
            plugin: plugin.to_string(),
            tool: "ping".to_string(),
            arguments: serde_json::json!({ "text": "hi" }),
            cwd: "/p".to_string(),
            session: Some("s-1".to_string()),
        };
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
        assert_eq!(answered.content.as_deref(), Some("pong"));
        assert_eq!(answered.error, None);

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
        let home = std::env::temp_dir().join("workbench-plugins-rows-home");
        let _ = std::fs::remove_dir_all(&home);
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
        let plugins = Plugins::new(&home, recorder.clone());
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
        assert_eq!(section["project"], here);
        let rows = section["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 1, "the row without an id is dropped: {section}");
        assert_eq!(rows[0]["id"], "lint");
        assert_eq!(rows[0]["detail"], "3 of 4");
        assert_eq!(rows[0]["state"], "ok");
        assert_eq!(rows[0]["default"], "open");
        assert_eq!(rows[0]["actions"][0]["label"], "Open");
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

        let notify = wait(NOTIFY_REQUEST, &any);
        assert_eq!(notify["text"], "needs a key");
        assert_eq!(notify["cwd"], here);
        assert_eq!(notify["session"], "s-1");

        plugins
            .action(
                &added.id,
                "board",
                "pull-request",
                "open",
                Some("lint"),
                &serde_json::json!({}),
                &here,
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
    }

    #[cfg(unix)]
    #[test]
    fn shows_a_plugin_s_page_and_carries_what_goes_either_way() {
        let home = std::env::temp_dir().join("workbench-plugins-view-home");
        let _ = std::fs::remove_dir_all(&home);
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
        let plugins = Plugins::new(&home, recorder.clone());
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
                    "default": "run"
                }
            ],
            "actions": [{ "id": "refresh", "label": "Refresh" }, { "id": "nameless" }]
        });
        let section = checked_section("src-1", "board", &message).unwrap();
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
        let fields = section.rows[1].actions.as_ref().unwrap()[0]
            .input
            .as_ref()
            .unwrap();
        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0].options.as_ref().unwrap()[0].id, "x");
        assert_eq!(section.actions.len(), 1);
        assert_eq!(section.actions[0].id, "refresh");

        // A section is named as a tool is, and is for one project.
        let named = |id: &str| serde_json::json!({ "id": id, "project": "/p", "rows": [] });
        assert!(checked_section("src-1", "board", &named("Pull request")).is_none());
        assert!(checked_section("src-1", "board", &named("")).is_none());
        assert!(checked_section("src-1", "board", &named("pull-request")).is_some());
        assert!(
            checked_section("src-1", "board", &serde_json::json!({ "id": "checks" })).is_none()
        );

        // A section that says nothing else is itself, and empty.
        let untitled = checked_section(
            "src-1",
            "board",
            &serde_json::json!({ "id": "checks", "project": "/p" }),
        )
        .unwrap();
        assert_eq!(untitled.title, "checks");
        assert!(untitled.rows.is_empty());
        assert!(untitled.actions.is_empty());
    }

    #[test]
    fn refuses_a_location_or_a_ref_that_git_would_read_as_an_option() {
        let home = std::env::temp_dir().join("workbench-plugins-arguments-home");
        let _ = std::fs::remove_dir_all(&home);
        let plugins = Plugins::new(&home, Arc::new(Recorder::default()));
        let root = home.join(".agent-workbench").join("plugins");

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

    #[test]
    fn adds_a_repository_by_cloning_it_and_checks_for_a_newer_commit() {
        let home = std::env::temp_dir().join("workbench-plugins-clone-home");
        let _ = std::fs::remove_dir_all(&home);
        let upstream = source_with(GOOD, "upstream");
        let g = |args: &[&str]| git(&upstream, args).unwrap();
        g(&["init", "-q", "-b", "main"]);
        g(&["config", "user.email", "t@example.com"]);
        g(&["config", "user.name", "T"]);
        g(&["add", "."]);
        g(&["commit", "-q", "-m", "start"]);
        let first = g(&["rev-parse", "HEAD"]);
        let plugins = Plugins::new(&home, Arc::new(Recorder::default()));
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
        let home = std::env::temp_dir().join("workbench-plugins-told-home");
        let _ = std::fs::remove_dir_all(&home);
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

        let plugins = Plugins::new(&home, Arc::new(Recorder::default()));
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
        plugins.session_started("pty-1", Some("s-1"), "/two");
        plugins.session_ended("pty-1");
        plugins.session_started("pty-2", None, "/three");
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
        assert_eq!(sessions[5]["event"], "ended");
        assert_eq!(sessions[5]["id"], "s-1");
        assert_eq!(sessions[5]["project"], "/two");
        assert_eq!(sessions[6]["event"], "started");
        assert_eq!(sessions[6]["id"], "s-2");
        assert_eq!(sessions[6]["project"], "/three");

        plugins.enable(&added.id, "ears", false).unwrap();
    }
}
