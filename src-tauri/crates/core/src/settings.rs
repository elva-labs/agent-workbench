//! The user's preferences for the workbench, kept in one file per machine.
//!
//! The appearance, the look, the palette, the two fonts, the chords the app
//! claims and the answer on agent hooks are the user's, not a window's, so
//! they live here under the app's home and every window on the machine
//! reads the same ones. A change is written whole and moved into place, and
//! announced as an event carrying the settings as they now are. The file is
//! watched as well, so an edit made by hand, or by anything else that
//! writes it, reaches the windows the same way.
//!
//! The file is read leniently: a value that is not one the app knows is
//! left out, and the default stands for it. A change is checked strictly:
//! one bad value refuses the whole change, and says which.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};

use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::events::{self, Sink};

pub const SETTINGS_CHANGED: &str = "settings_changed";

pub const APPEARANCES: &[&str] = &["system", "light", "dark"];
pub const LOOKS: &[&str] = &["modern", "terminal"];
pub const PALETTES: &[&str] = &["teal", "indigo", "amber", "rose", "mono"];
pub const TERMINAL_FONTS: &[&str] = &["system", "plex", "jetbrains"];
pub const INTERFACE_FONTS: &[&str] = &["system", "plex", "inter"];

/// How many chords the table may hold, and how long a key or an action's
/// name may be: far past what the app has, and short of what a file can
/// make the window chew on.
const MOST_CHORDS: usize = 64;
const LONGEST_NAME: usize = 64;

pub fn settings_path(home: &Path) -> PathBuf {
    home.join(".agent-workbench").join("settings.json")
}

/// A chord the app claims: the platform modifier is implied, and Shift and
/// Alt may join it. The key is spelled as a browser's key event spells it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Chord {
    pub key: String,
    pub shift: bool,
    pub alt: bool,
}

/// Whether the agents' hooks go into every project, and the projects that
/// say otherwise, by path.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Hooks {
    pub everywhere: bool,
    pub overrides: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub appearance: String,
    pub look: String,
    pub palette: String,
    pub terminal_font: String,
    pub interface_font: String,
    /// The whole chord table, by action. Empty is the default preset: the
    /// window fills in whatever an action has no chord for.
    pub keys: BTreeMap<String, Chord>,
    pub hooks: Hooks,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            appearance: "system".into(),
            look: "modern".into(),
            palette: "teal".into(),
            terminal_font: "system".into(),
            interface_font: "system".into(),
            keys: BTreeMap::new(),
            hooks: Hooks {
                everywhere: true,
                overrides: BTreeMap::new(),
            },
        }
    }
}

/// The settings, and whether a file held them. None held means the window
/// has not handed over what it kept before there was a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    pub stored: bool,
    pub settings: Settings,
}

fn one_of(field: &str, value: &Value, allowed: &[&str]) -> Result<String, String> {
    match value.as_str() {
        Some(text) if allowed.contains(&text) => Ok(text.to_string()),
        _ => Err(format!(
            "{field} is one of {}, not {value}",
            allowed.join(", ")
        )),
    }
}

fn chord(action: &str, value: &Value) -> Result<Chord, String> {
    let chord: Chord = serde_json::from_value(value.clone())
        .map_err(|_| format!("the chord for {action} is not a key with shift and alt"))?;
    if chord.key.is_empty() || chord.key.chars().count() > LONGEST_NAME {
        return Err(format!("the chord for {action} has no key"));
    }
    Ok(chord)
}

fn keys(value: &Value) -> Result<BTreeMap<String, Chord>, String> {
    let table = value
        .as_object()
        .ok_or("keys is a table of chords by action")?;
    if table.len() > MOST_CHORDS {
        return Err(format!("keys holds {MOST_CHORDS} chords at most"));
    }
    let mut keys = BTreeMap::new();
    for (action, value) in table {
        if action.is_empty() || action.chars().count() > LONGEST_NAME {
            return Err(format!("{action:?} is not an action"));
        }
        keys.insert(action.clone(), chord(action, value)?);
    }
    Ok(keys)
}

fn hooks(value: &Value) -> Result<Hooks, String> {
    serde_json::from_value(value.clone())
        .map_err(|_| "hooks is everywhere, on or off, and the projects that say otherwise".into())
}

/// Sets one field from a value, or says why the value will not do. A name
/// the settings do not have is refused too, so a misspelling is not lost.
fn set_field(settings: &mut Settings, field: &str, value: &Value) -> Result<(), String> {
    match field {
        "appearance" => settings.appearance = one_of(field, value, APPEARANCES)?,
        "look" => settings.look = one_of(field, value, LOOKS)?,
        "palette" => settings.palette = one_of(field, value, PALETTES)?,
        "terminalFont" => settings.terminal_font = one_of(field, value, TERMINAL_FONTS)?,
        "interfaceFont" => settings.interface_font = one_of(field, value, INTERFACE_FONTS)?,
        "keys" => settings.keys = keys(value)?,
        "hooks" => settings.hooks = hooks(value)?,
        other => return Err(format!("there is no setting called {other}")),
    }
    Ok(())
}

/// The settings a file's text holds, each field that does not read left at
/// its default. None when the text is not a JSON object at all.
pub fn parse(text: &str) -> Option<Settings> {
    let fields: Map<String, Value> = serde_json::from_str(text).ok()?;
    let mut settings = Settings::default();
    for (field, value) in &fields {
        let _ = set_field(&mut settings, field, value);
    }
    Some(settings)
}

/// The settings with a change laid over them. The change names only the
/// fields it changes; keys and hooks are replaced whole.
pub fn apply(settings: &Settings, change: &Value) -> Result<Settings, String> {
    let fields = change
        .as_object()
        .ok_or("a change is an object of settings by name")?;
    let mut next = settings.clone();
    for (field, value) in fields {
        set_field(&mut next, field, value)?;
    }
    Ok(next)
}

fn render(settings: &Settings) -> String {
    let text = serde_json::to_string_pretty(settings).unwrap_or_default();
    format!("{text}\n")
}

/// Writes the file whole and moves it into place, so a reader finds the
/// old settings or the new, never half of either.
fn write(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, text)
        .map_err(|e| format!("could not write {}: {e}", temporary.display()))?;
    std::fs::rename(&temporary, path).map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        format!("could not write {}: {e}", path.display())
    })
}

/// The settings file of one machine, and the windows' news of it.
pub struct Store {
    path: PathBuf,
    sink: Arc<dyn Sink>,
    /// The settings last announced, so a change is announced once whether
    /// the store made it or the watcher saw it, and a write that changes
    /// nothing is not announced at all.
    announced: Mutex<Option<Settings>>,
    /// Held while a change is read, laid over and written, so two changes
    /// at once both land.
    writing: Mutex<()>,
}

impl Store {
    pub fn new(home: &Path, sink: Arc<dyn Sink>) -> Self {
        Self {
            path: settings_path(home),
            sink,
            announced: Mutex::new(None),
            writing: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The settings as they are, and whether a file held them.
    pub fn load(&self) -> Stored {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => Stored {
                stored: true,
                settings: parse(&text).unwrap_or_default(),
            },
            Err(_) => Stored {
                stored: false,
                settings: Settings::default(),
            },
        }
    }

    /// Lays a change over the settings, writes them and announces them.
    /// Answers with the settings as they now are.
    pub fn set(&self, change: &Value) -> Result<Settings, String> {
        let _writing = self.writing.lock().map_err(|_| "the settings are stuck")?;
        let next = apply(&self.load().settings, change)?;
        write(&self.path, &render(&next))?;
        self.announce(&next);
        Ok(next)
    }

    fn announce(&self, settings: &Settings) {
        let Ok(mut announced) = self.announced.lock() else {
            return;
        };
        if announced.as_ref() == Some(settings) {
            return;
        }
        *announced = Some(settings.clone());
        events::emit(&self.sink, SETTINGS_CHANGED, settings);
    }

    /// Reads the file again after something touched it, and announces what
    /// it holds if that is news. A file that is gone or not an object is
    /// left alone: the windows keep what they have.
    fn reread(&self) {
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return;
        };
        if let Some(settings) = parse(&text) {
            self.announce(&settings);
        }
    }

    /// Watches the file for the life of the core. The directory is what is
    /// watched, since a write moves a new file into place and a watch on
    /// the old one would end with it.
    pub fn watch(self: &Arc<Self>) -> Result<(), String> {
        let Some(directory) = self.path.parent() else {
            return Ok(());
        };
        std::fs::create_dir_all(directory)
            .map_err(|e| format!("could not create {}: {e}", directory.display()))?;
        if let Ok(mut announced) = self.announced.lock() {
            *announced = Some(self.load().settings);
        }
        let (sender, receiver) = channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
        .map_err(|e| format!("could not watch the settings: {e}"))?;
        watcher
            .watch(directory, RecursiveMode::NonRecursive)
            .map_err(|e| format!("could not watch {}: {e}", directory.display()))?;
        let store = Arc::clone(self);
        std::thread::spawn(move || {
            // The watcher lives on this thread; dropping it would end the watch.
            let _watcher = watcher;
            while let Ok(event) = receiver.recv() {
                let mut touched = concerns(&event, &store.path);
                // Coalesce a burst: whatever arrived is read in one go.
                while let Ok(event) = receiver.try_recv() {
                    touched |= concerns(&event, &store.path);
                }
                if touched {
                    store.reread();
                }
            }
        });
        Ok(())
    }
}

/// Whether an event in the directory is about the settings file.
fn concerns(event: &notify::Result<notify::Event>, path: &Path) -> bool {
    let Ok(event) = event else {
        return false;
    };
    let name = path.file_name();
    event
        .paths
        .iter()
        .any(|touched| touched.file_name() == name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::testing::Recorder;
    use serde_json::json;
    use std::time::{Duration, Instant};

    fn home(name: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("workbench-settings-{name}"));
        std::fs::remove_dir_all(&home).ok();
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    fn changes(recorder: &Recorder) -> Vec<Value> {
        recorder
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == SETTINGS_CHANGED)
            .map(|(_, payload)| payload.clone())
            .collect()
    }

    #[test]
    fn a_machine_without_a_file_has_the_defaults_and_says_none_was_stored() {
        let home = home("fresh");
        let store = Store::new(&home, Arc::new(Recorder::default()));
        let loaded = store.load();
        assert!(!loaded.stored);
        assert_eq!(loaded.settings, Settings::default());
        assert!(loaded.settings.hooks.everywhere);
    }

    #[test]
    fn a_change_is_written_announced_and_read_back() {
        let home = home("change");
        let recorder = Arc::new(Recorder::default());
        let store = Store::new(&home, recorder.clone());
        let next = store
            .set(&json!({ "palette": "amber", "look": "terminal" }))
            .unwrap();
        assert_eq!(next.palette, "amber");
        assert_eq!(next.look, "terminal");
        assert_eq!(
            next.appearance, "system",
            "untouched fields keep their value"
        );

        let loaded = store.load();
        assert!(loaded.stored);
        assert_eq!(loaded.settings, next);

        let announced = changes(&recorder);
        assert_eq!(announced.len(), 1);
        assert_eq!(announced[0]["palette"], "amber");
        assert_eq!(announced[0]["terminalFont"], "system");
    }

    #[test]
    fn the_file_is_camel_cased_json_a_person_can_read() {
        let home = home("shape");
        let store = Store::new(&home, Arc::new(Recorder::default()));
        store
            .set(&json!({
                "terminalFont": "jetbrains",
                "keys": { "review": { "key": "g", "shift": false, "alt": false } },
                "hooks": { "everywhere": false, "overrides": { "/p": true } }
            }))
            .unwrap();
        let text = std::fs::read_to_string(settings_path(&home)).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["terminalFont"], "jetbrains");
        assert_eq!(value["keys"]["review"]["key"], "g");
        assert_eq!(value["hooks"]["overrides"]["/p"], true);
        assert!(text.contains("\n  \""), "indented for reading: {text}");
    }

    #[test]
    fn one_bad_value_refuses_the_whole_change_and_says_which() {
        let home = home("refused");
        let recorder = Arc::new(Recorder::default());
        let store = Store::new(&home, recorder.clone());
        let error = store
            .set(&json!({ "palette": "amber", "look": "baroque" }))
            .unwrap_err();
        assert!(error.contains("look"), "{error}");
        assert!(error.contains("modern"), "names what it takes: {error}");
        assert!(!store.load().stored, "nothing was written");
        assert!(changes(&recorder).is_empty());

        let error = store.set(&json!({ "colour": "red" })).unwrap_err();
        assert!(error.contains("colour"), "{error}");
        assert!(store.set(&json!("amber")).is_err());
    }

    #[test]
    fn chords_and_hooks_are_checked_for_shape() {
        let settings = Settings::default();
        assert!(apply(
            &settings,
            &json!({ "keys": { "review": { "key": "", "shift": false, "alt": false } } })
        )
        .is_err());
        assert!(apply(&settings, &json!({ "keys": { "review": { "key": "g" } } })).is_err());
        assert!(apply(&settings, &json!({ "keys": [1, 2] })).is_err());
        assert!(apply(&settings, &json!({ "hooks": { "everywhere": "yes" } })).is_err());
        let many: Map<String, Value> = (0..=MOST_CHORDS)
            .map(|n| {
                (
                    format!("a{n}"),
                    json!({ "key": "x", "shift": false, "alt": false }),
                )
            })
            .collect();
        assert!(apply(&settings, &json!({ "keys": many })).is_err());
    }

    #[test]
    fn a_file_is_read_leniently_field_by_field() {
        let settings = parse(
            r#"{ "palette": "rose", "look": "baroque", "appearance": 7, "keys": "none", "extra": true }"#,
        )
        .unwrap();
        assert_eq!(settings.palette, "rose");
        assert_eq!(settings.look, "modern");
        assert_eq!(settings.appearance, "system");
        assert!(settings.keys.is_empty());
        assert!(parse("not json").is_none());
        assert!(parse("[1]").is_none());
    }

    #[test]
    fn a_broken_file_reads_as_the_defaults_and_is_mended_by_the_next_change() {
        let home = home("broken");
        std::fs::create_dir_all(settings_path(&home).parent().unwrap()).unwrap();
        std::fs::write(settings_path(&home), "{ half").unwrap();
        let store = Store::new(&home, Arc::new(Recorder::default()));
        let loaded = store.load();
        assert!(loaded.stored);
        assert_eq!(loaded.settings, Settings::default());
        store.set(&json!({ "appearance": "dark" })).unwrap();
        assert_eq!(store.load().settings.appearance, "dark");
    }

    #[test]
    fn a_change_that_changes_nothing_is_not_announced_twice() {
        let home = home("same");
        let recorder = Arc::new(Recorder::default());
        let store = Store::new(&home, recorder.clone());
        store.set(&json!({ "palette": "mono" })).unwrap();
        store.set(&json!({ "palette": "mono" })).unwrap();
        assert_eq!(changes(&recorder).len(), 1);
    }

    #[test]
    fn an_edit_to_the_file_reaches_the_windows_once() {
        let home = home("watched");
        let recorder = Arc::new(Recorder::default());
        let store = Arc::new(Store::new(&home, recorder.clone()));
        store.watch().unwrap();
        // The watcher's first word: give it a moment to be listening.
        std::thread::sleep(Duration::from_millis(200));

        let edited = Settings {
            palette: "indigo".into(),
            ..Settings::default()
        };
        write(&settings_path(&home), &render(&edited)).unwrap();

        let until = Instant::now() + Duration::from_secs(10);
        while changes(&recorder).is_empty() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        let announced = changes(&recorder);
        assert_eq!(announced.len(), 1, "{announced:?}");
        assert_eq!(announced[0]["palette"], "indigo");

        // The store's own write is announced by the store, and the watcher
        // seeing it after does not announce it again.
        store.set(&json!({ "palette": "rose" })).unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let announced = changes(&recorder);
        assert_eq!(announced.len(), 2, "{announced:?}");
        assert_eq!(announced[1]["palette"], "rose");
    }
}
