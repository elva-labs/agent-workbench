//! The user's preferences for the workbench, kept in one file per machine.
//!
//! The appearance, the look, the palette, the two fonts, the chords the app
//! claims, the answer on agent hooks and the user's own themes are the
//! user's, not a window's, so
//! they live here under the app's home and every window on the machine
//! reads the same ones. A change is written whole and moved into place, and
//! announced as an event carrying the settings as they now are. The file is
//! watched as well, so an edit made by hand, or by anything else that
//! writes it, reaches the windows the same way.
//!
//! The file is read leniently: a value that is not one the app knows is
//! left out, and the default stands for it. A change is checked strictly:
//! one bad value refuses the whole change, and says which.
//!
//! The user's own stylesheet sits beside the file, and is watched with it;
//! what it may hold is in [`crate::styles`], and whether it is laid over
//! the app's is a setting like the rest.
//!
//! A theme of the user's own is a palette by another name: colours for the
//! light appearance and the dark, and a few measures of the chrome's shape,
//! each a token the stylesheets are written in. Only those tokens are taken,
//! colours only as hex and measures only as pixels, so what a theme can do
//! to the window is recolour and reshape it and nothing else.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};

use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::events::{self, Sink};
use crate::styles::{self, Styles, USER_STYLES_CHANGED};

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

/// The colour tokens a theme may set, for each appearance.
pub const COLOUR_TOKENS: &[&str] = &[
    "bg",
    "surface",
    "surface-2",
    "ink",
    "ink-2",
    "ink-3",
    "rule",
    "rule-strong",
    "accent",
    "accent-soft",
    "add",
    "del",
    "ansi-black",
    "ansi-red",
    "ansi-green",
    "ansi-yellow",
    "ansi-blue",
    "ansi-magenta",
    "ansi-cyan",
    "ansi-white",
    "ansi-bright-black",
    "ansi-bright-red",
    "ansi-bright-green",
    "ansi-bright-yellow",
    "ansi-bright-blue",
    "ansi-bright-magenta",
    "ansi-bright-cyan",
    "ansi-bright-white",
];

/// The measures of the chrome's shape a theme may set, the same in either
/// appearance, with the most each may be, in pixels.
pub const SHAPE_TOKENS: &[(&str, u32)] = &[
    ("radius", 16),
    ("radius-sm", 12),
    ("radius-tag", 12),
    ("pane-pad", 24),
];

/// How many themes the file may hold, and how long a theme's label may be.
const MOST_THEMES: usize = 32;
const LONGEST_LABEL: usize = 40;

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

/// A theme of the user's own: what it is called, its colours for each
/// appearance and its shape, each by token.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Theme {
    pub label: String,
    #[serde(default)]
    pub light: BTreeMap<String, String>,
    #[serde(default)]
    pub dark: BTreeMap<String, String>,
    #[serde(default)]
    pub shape: BTreeMap<String, String>,
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
    /// The user's own themes, by name. A palette may name one.
    pub themes: BTreeMap<String, Theme>,
    /// Whether the user's own stylesheet is laid over the app's.
    pub user_styles: bool,
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
            themes: BTreeMap::new(),
            user_styles: false,
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

/// A colour as a theme gives it: `#` and three or six hex digits.
pub fn is_colour(text: &str) -> bool {
    let Some(digits) = text.strip_prefix('#') else {
        return false;
    };
    (digits.len() == 3 || digits.len() == 6) && digits.chars().all(|c| c.is_ascii_hexdigit())
}

/// A measure as a theme gives it: whole pixels, `6px`, no more than `most`.
fn is_pixels(text: &str, most: u32) -> bool {
    text.strip_suffix("px")
        .filter(|digits| !digits.is_empty() && digits.len() <= 3)
        .and_then(|digits| digits.parse::<u32>().ok())
        .is_some_and(|pixels| pixels <= most)
}

/// A theme's name: what the palette names it by, and what the window marks
/// the page with, so lower-case letters, digits and dashes, and never one of
/// the palettes the app has.
pub fn is_theme_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !PALETTES.contains(&name)
}

fn colours(
    name: &str,
    appearance: &str,
    value: Option<&Value>,
) -> Result<BTreeMap<String, String>, String> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let table = value.as_object().ok_or(format!(
        "the {appearance} colours of {name} are a table of tokens"
    ))?;
    let mut colours = BTreeMap::new();
    for (token, colour) in table {
        if !COLOUR_TOKENS.contains(&token.as_str()) {
            return Err(format!(
                "{token} is not a colour a theme sets; it sets {}",
                COLOUR_TOKENS.join(", ")
            ));
        }
        match colour.as_str() {
            Some(text) if is_colour(text) => {
                colours.insert(token.clone(), text.to_ascii_lowercase());
            }
            _ => {
                return Err(format!(
                    "{token} in the {appearance} colours of {name} is a hex colour such as #1a2b3c, not {colour}"
                ))
            }
        }
    }
    Ok(colours)
}

fn shape(name: &str, value: Option<&Value>) -> Result<BTreeMap<String, String>, String> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let table = value
        .as_object()
        .ok_or(format!("the shape of {name} is a table of tokens"))?;
    let mut shape = BTreeMap::new();
    for (token, measure) in table {
        let Some((_, most)) = SHAPE_TOKENS.iter().find(|(known, _)| known == token) else {
            let known: Vec<&str> = SHAPE_TOKENS.iter().map(|(token, _)| *token).collect();
            return Err(format!(
                "{token} is not a measure a theme sets; it sets {}",
                known.join(", ")
            ));
        };
        match measure.as_str() {
            Some(text) if is_pixels(text, *most) => {
                shape.insert(token.clone(), text.to_string());
            }
            _ => {
                return Err(format!(
                    "{token} in the shape of {name} is whole pixels up to {most}px, such as 6px, not {measure}"
                ))
            }
        }
    }
    Ok(shape)
}

fn theme(name: &str, value: &Value) -> Result<Theme, String> {
    if !is_theme_name(name) {
        return Err(format!(
            "{name:?} is not a theme's name: lower-case letters, digits and dashes, starting with a letter, and none of {}",
            PALETTES.join(", ")
        ));
    }
    let fields = value.as_object().ok_or(format!(
        "the theme {name} is a table of a label, colours and a shape"
    ))?;
    if let Some(other) = fields
        .keys()
        .find(|field| !["label", "light", "dark", "shape"].contains(&field.as_str()))
    {
        return Err(format!(
            "a theme has a label, light, dark and shape, not {other}"
        ));
    }
    let label = match fields.get("label") {
        None => name.to_string(),
        Some(Value::String(label))
            if !label.trim().is_empty() && label.chars().count() <= LONGEST_LABEL =>
        {
            label.trim().to_string()
        }
        Some(_) => {
            return Err(format!(
                "the label of {name} is a few words, {LONGEST_LABEL} characters at most"
            ))
        }
    };
    Ok(Theme {
        label,
        light: colours(name, "light", fields.get("light"))?,
        dark: colours(name, "dark", fields.get("dark"))?,
        shape: shape(name, fields.get("shape"))?,
    })
}

/// The themes a value holds: all of them, or the reason one will not do.
/// Read leniently, the ones that will not do are left out instead.
fn themes(value: &Value, lenient: bool) -> Result<BTreeMap<String, Theme>, String> {
    let table = value
        .as_object()
        .ok_or("themes is a table of themes by name")?;
    if table.len() > MOST_THEMES {
        return Err(format!("the settings hold {MOST_THEMES} themes at most"));
    }
    let mut themes = BTreeMap::new();
    for (name, value) in table {
        match theme(name, value) {
            Ok(theme) => {
                themes.insert(name.clone(), theme);
            }
            Err(_) if lenient => {}
            Err(error) => return Err(error),
        }
    }
    Ok(themes)
}

/// Sets one field from a value, or says why the value will not do. A name
/// the settings do not have is refused too, so a misspelling is not lost.
/// A palette is checked against the themes the settings hold, so it is set
/// after them.
fn set_field(settings: &mut Settings, field: &str, value: &Value) -> Result<(), String> {
    match field {
        "appearance" => settings.appearance = one_of(field, value, APPEARANCES)?,
        "look" => settings.look = one_of(field, value, LOOKS)?,
        "palette" => {
            let named = value.as_str().unwrap_or_default();
            if !settings.themes.contains_key(named) {
                let mut known: Vec<&str> = PALETTES.to_vec();
                known.extend(settings.themes.keys().map(String::as_str));
                settings.palette = one_of(field, value, &known)?;
            } else {
                settings.palette = named.to_string();
            }
        }
        "themes" => settings.themes = themes(value, false)?,
        "userStyles" => {
            settings.user_styles = value.as_bool().ok_or("userStyles is true or false")?;
        }
        "terminalFont" => settings.terminal_font = one_of(field, value, TERMINAL_FONTS)?,
        "interfaceFont" => settings.interface_font = one_of(field, value, INTERFACE_FONTS)?,
        "keys" => settings.keys = keys(value)?,
        "hooks" => settings.hooks = hooks(value)?,
        other => return Err(format!("there is no setting called {other}")),
    }
    Ok(())
}

/// A change's fields in the order they are set: the palette last, since
/// it may name a theme the same change brings.
fn in_order(fields: &Map<String, Value>) -> impl Iterator<Item = (&String, &Value)> {
    let palette = fields.iter().filter(|(field, _)| *field == "palette");
    fields
        .iter()
        .filter(|(field, _)| *field != "palette")
        .chain(palette)
}

/// A palette that names a theme the settings no longer hold is the default.
fn settle_palette(settings: &mut Settings) {
    if !PALETTES.contains(&settings.palette.as_str())
        && !settings.themes.contains_key(&settings.palette)
    {
        settings.palette = Settings::default().palette;
    }
}

/// The settings a file's text holds, each field that does not read left at
/// its default, and each theme that does not read left out. None when the
/// text is not a JSON object at all.
pub fn parse(text: &str) -> Option<Settings> {
    let fields: Map<String, Value> = serde_json::from_str(text).ok()?;
    let mut settings = Settings::default();
    for (field, value) in in_order(&fields) {
        if field == "themes" {
            settings.themes = themes(value, true).unwrap_or_default();
        } else {
            let _ = set_field(&mut settings, field, value);
        }
    }
    Some(settings)
}

/// The settings with a change laid over them. The change names only the
/// fields it changes; keys, hooks and themes are replaced whole.
pub fn apply(settings: &Settings, change: &Value) -> Result<Settings, String> {
    let fields = change
        .as_object()
        .ok_or("a change is an object of settings by name")?;
    let mut next = settings.clone();
    for (field, value) in in_order(fields) {
        set_field(&mut next, field, value)?;
    }
    settle_palette(&mut next);
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

/// The settings file of one machine, the stylesheet beside it, and the
/// windows' news of both.
pub struct Store {
    home: PathBuf,
    path: PathBuf,
    sink: Arc<dyn Sink>,
    /// The settings last announced, so a change is announced once whether
    /// the store made it or the watcher saw it, and a write that changes
    /// nothing is not announced at all.
    announced: Mutex<Option<Settings>>,
    /// The same, for the stylesheet.
    styles_announced: Mutex<Option<Styles>>,
    /// Held while a change is read, laid over and written, so two changes
    /// at once both land.
    writing: Mutex<()>,
}

impl Store {
    pub fn new(home: &Path, sink: Arc<dyn Sink>) -> Self {
        Self {
            home: home.to_path_buf(),
            path: settings_path(home),
            sink,
            announced: Mutex::new(None),
            styles_announced: Mutex::new(None),
            writing: Mutex::new(()),
        }
    }

    /// The user's stylesheet, or none and why.
    pub fn styles(&self) -> Styles {
        styles::read(&self.home)
    }

    /// Writes the user's stylesheet once it passes, and announces it.
    pub fn set_styles(&self, css: &str) -> Result<Styles, String> {
        let _writing = self.writing.lock().map_err(|_| "the settings are stuck")?;
        let written = styles::write(&self.home, css)?;
        self.announce_styles(&written);
        Ok(written)
    }

    /// Reads the stylesheet again after something touched it, under the
    /// write lock for the same reason as the settings file.
    fn restyle(&self) {
        let Ok(_writing) = self.writing.lock() else {
            return;
        };
        self.announce_styles(&self.styles());
    }

    fn announce_styles(&self, styles: &Styles) {
        let Ok(mut announced) = self.styles_announced.lock() else {
            return;
        };
        if announced.as_ref() == Some(styles) {
            return;
        }
        *announced = Some(styles.clone());
        events::emit(&self.sink, USER_STYLES_CHANGED, styles);
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
    /// left alone: the windows keep what they have. The read and the
    /// announcement happen under the write lock, so what is announced is
    /// never older than a change the store has already announced.
    fn reread(&self) {
        let Ok(_writing) = self.writing.lock() else {
            return;
        };
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
        if let Ok(mut announced) = self.styles_announced.lock() {
            *announced = Some(self.styles());
        }
        let sheet = styles::styles_path(&self.home);
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
                let mut restyled = concerns(&event, &sheet);
                // Coalesce a burst: whatever arrived is read in one go.
                while let Ok(event) = receiver.try_recv() {
                    touched |= concerns(&event, &store.path);
                    restyled |= concerns(&event, &sheet);
                }
                if touched {
                    store.reread();
                }
                if restyled {
                    store.restyle();
                }
            }
        });
        Ok(())
    }
}

/// Whether an event in the directory is about this file.
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

    fn dusk() -> Value {
        json!({
            "label": "Dusk",
            "light": { "accent": "#7A4A8C", "surface": "#fff" },
            "dark": { "accent": "#c39ad4", "bg": "#101014" },
            "shape": { "radius": "10px", "pane-pad": "16px" }
        })
    }

    #[test]
    fn a_theme_and_the_palette_naming_it_arrive_in_one_change() {
        let next = apply(
            &Settings::default(),
            &json!({ "palette": "dusk", "themes": { "dusk": dusk() } }),
        )
        .unwrap();
        assert_eq!(next.palette, "dusk");
        let theme = &next.themes["dusk"];
        assert_eq!(theme.label, "Dusk");
        assert_eq!(
            theme.light["accent"], "#7a4a8c",
            "colours are kept in lower case"
        );
        assert_eq!(theme.dark["bg"], "#101014");
        assert_eq!(theme.shape["radius"], "10px");
    }

    #[test]
    fn a_palette_names_a_theme_the_settings_hold_or_one_the_app_has() {
        let error = apply(&Settings::default(), &json!({ "palette": "dusk" })).unwrap_err();
        assert!(error.contains("palette is one of teal"), "{error}");
        let with = apply(
            &Settings::default(),
            &json!({ "themes": { "dusk": dusk() } }),
        )
        .unwrap();
        assert!(apply(&with, &json!({ "palette": "dusk" })).is_ok());
        let error = apply(&with, &json!({ "palette": "night" })).unwrap_err();
        assert!(error.contains("dusk"), "names the themes too: {error}");
    }

    #[test]
    fn taking_away_the_theme_in_use_goes_back_to_the_default_palette() {
        let with = apply(
            &Settings::default(),
            &json!({ "palette": "dusk", "themes": { "dusk": dusk() } }),
        )
        .unwrap();
        let without = apply(&with, &json!({ "themes": {} })).unwrap();
        assert!(without.themes.is_empty());
        assert_eq!(without.palette, "teal");
    }

    #[test]
    fn a_theme_sets_only_the_tokens_it_may_and_only_in_their_form() {
        let bad = |theme: Value| {
            apply(
                &Settings::default(),
                &json!({ "themes": { "dusk": theme } }),
            )
            .unwrap_err()
        };
        assert!(bad(json!({ "light": { "font": "#fff" } })).contains("not a colour a theme sets"));
        assert!(bad(json!({ "light": { "accent": "red" } })).contains("hex colour"));
        assert!(bad(json!({ "light": { "accent": "#12345" } })).contains("hex colour"));
        assert!(bad(json!({ "dark": { "accent": "#fff; }" } })).contains("hex colour"));
        assert!(bad(json!({ "light": { "accent": "url(x)" } })).contains("hex colour"));
        assert!(bad(json!({ "shape": { "radius": "100px" } })).contains("up to 16px"));
        assert!(bad(json!({ "shape": { "radius": "4em" } })).contains("whole pixels"));
        assert!(bad(json!({ "shape": { "margin": "4px" } })).contains("not a measure"));
        assert!(bad(json!({ "label": "" })).contains("label"));
        assert!(bad(json!({ "css": "body{}" })).contains("not css"));
        assert!(bad(json!("#fff")).contains("table"));
    }

    #[test]
    fn a_theme_s_name_is_one_the_page_can_carry() {
        assert!(is_theme_name("dusk"));
        assert!(is_theme_name("solar-2"));
        for name in [
            "",
            "Dusk",
            "2dusk",
            "dusk night",
            "dusk\"]",
            "teal",
            "a".repeat(33).as_str(),
        ] {
            assert!(!is_theme_name(name), "{name:?}");
        }
        let error = apply(
            &Settings::default(),
            &json!({ "themes": { "teal": dusk() } }),
        )
        .unwrap_err();
        assert!(error.contains("not a theme's name"), "{error}");
    }

    #[test]
    fn a_theme_without_a_label_is_called_by_its_name() {
        let next = apply(
            &Settings::default(),
            &json!({ "themes": { "dusk": { "light": { "accent": "#123456" } } } }),
        )
        .unwrap();
        assert_eq!(next.themes["dusk"].label, "dusk");
        assert!(next.themes["dusk"].dark.is_empty());
    }

    #[test]
    fn a_file_keeps_the_themes_that_read_and_leaves_out_the_rest() {
        let settings = parse(
            r##"{
                "palette": "dusk",
                "themes": {
                    "dusk": { "label": "Dusk", "light": { "accent": "#7a4a8c" } },
                    "broken": { "light": { "accent": "red" } },
                    "Bad Name": {}
                }
            }"##,
        )
        .unwrap();
        assert_eq!(settings.themes.keys().collect::<Vec<_>>(), ["dusk"]);
        assert_eq!(
            settings.palette, "dusk",
            "the palette is read after the themes"
        );
        let settings = parse(
            r#"{ "palette": "broken", "themes": { "broken": { "light": { "accent": "red" } } } }"#,
        )
        .unwrap();
        assert_eq!(settings.palette, "teal");
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
    fn the_user_s_styles_are_off_until_turned_on() {
        assert!(!Settings::default().user_styles);
        let next = apply(&Settings::default(), &json!({ "userStyles": true })).unwrap();
        assert!(next.user_styles);
        assert!(apply(&next, &json!({ "userStyles": "yes" })).is_err());
    }

    #[test]
    fn a_stylesheet_is_written_and_announced_once() {
        let home = home("styles");
        let recorder = Arc::new(Recorder::default());
        let store = Store::new(&home, recorder.clone());
        assert!(store.set_styles("@import 'x';").is_err());
        store.set_styles("header { color: red; }").unwrap();
        store.set_styles("header { color: red; }").unwrap();
        let events = recorder.events.lock().unwrap().clone();
        let styled: Vec<_> = events
            .iter()
            .filter(|(name, _)| name == USER_STYLES_CHANGED)
            .collect();
        assert_eq!(styled.len(), 1);
        assert_eq!(styled[0].1["css"], "header { color: red; }");
        assert!(styled[0].1["problem"].is_null());
        assert_eq!(store.styles().css, "header { color: red; }");
    }

    #[test]
    fn an_edit_to_the_stylesheet_reaches_the_windows_with_its_problem() {
        let home = home("styles-watched");
        let recorder = Arc::new(Recorder::default());
        let store = Arc::new(Store::new(&home, recorder.clone()));
        store.watch().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(
            styles::styles_path(&home),
            "body { background: url(https://x.example/p.png); }",
        )
        .unwrap();
        let until = Instant::now() + Duration::from_secs(10);
        let styled = || {
            recorder
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|(name, _)| name == USER_STYLES_CHANGED)
                .map(|(_, payload)| payload.clone())
                .collect::<Vec<_>>()
        };
        while styled().is_empty() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        let announced = styled();
        assert_eq!(announced.len(), 1, "{announced:?}");
        assert_eq!(announced[0]["css"], "");
        assert!(announced[0]["problem"].as_str().unwrap().contains("url()"));
        assert!(changes(&recorder).is_empty(), "the settings did not change");
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
