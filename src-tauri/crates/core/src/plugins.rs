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
use crate::show::{Answer, ToolRequest};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The event a plugin's state change is told by.
pub const PLUGIN_STATE: &str = "plugin_state";

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
}

type Key = (String, String);

struct Inner {
    home: PathBuf,
    root: PathBuf,
    sink: Arc<dyn Sink>,
    stored: Mutex<Stored>,
    running: Mutex<HashMap<Key, Running>>,
    /// Newer commits found by a check, by source id.
    newer: Mutex<HashMap<String, String>>,
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

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
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
            git(&dir, &["rev-parse", "HEAD"]).ok()
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
            reference: reference
                .map(str::to_string)
                .filter(|r| !r.trim().is_empty()),
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
        let head = git(&dir, &["rev-parse", "HEAD"])?;
        let upstream = match source.reference.as_deref() {
            Some(reference) => git(&dir, &["rev-parse", &format!("origin/{reference}")])?,
            None => git(&dir, &["rev-parse", "FETCH_HEAD"])?,
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
            git(&dir, &["reset", "--quiet", "--hard", &target])?;
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
            .stderr(Stdio::null());
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
                    plugins.answered(&message);
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
            let code = live.child.wait().ok().and_then(|status| status.code());
            live.failures = if greeted { 0 } else { live.failures + 1 };
            live.state = if still_on { State::Stopped } else { State::Off };
            live.detail = match code {
                Some(0) | None => None,
                Some(code) => Some(format!("exited with code {code}")),
            };
            live.hello = None;
            let out = (live.failures, live.detail.clone());
            if !still_on {
                running.remove(&key);
            }
            out
        };
        self.publish();
        if !still_on {
            self.tell(source_id, name, State::Off, None, None);
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
        if let Ok(mut stdin) = stdin.lock() {
            let _ = writeln!(stdin, r#"{{"type":"stop"}}"#);
            let _ = stdin.flush();
        }
        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(100));
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

    /// A plugin's answer to a call, written where the tool server waits.
    fn answered(&self, message: &serde_json::Value) {
        let Some(id) = message.get("id").and_then(|id| id.as_str()) else {
            return;
        };
        // Content of any shape reaches the agent as text: a string as it
        // is, anything else as the JSON the plugin wrote.
        let text = |value: &serde_json::Value| match value.as_str() {
            Some(text) => text.to_string(),
            None => serde_json::to_string(value).unwrap_or_default(),
        };
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
}
