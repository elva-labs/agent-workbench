//! The user's preferences for the workbench, kept in one file per machine.
//!
//! The appearance, the look, the palette, the two fonts, the chords the app
//! claims, the answer on agent hooks, the workflows and the user's own
//! themes are the user's, not a window's, so
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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::events::{self, Sink};
use crate::styles::{self, Styles, USER_STYLES_CHANGED};
use crate::workflow::{self, Workflows};

pub const SETTINGS_CHANGED: &str = "settings_changed";
/// The settings file was there and is gone. A window hands over the
/// settings it holds, so the next change is laid over them and not over the
/// defaults.
pub const SETTINGS_MISSING: &str = "settings_missing";

pub const APPEARANCES: &[&str] = &["system", "light", "dark"];
pub const LOOKS: &[&str] = &["modern", "terminal"];
pub const PALETTES: &[&str] = &["teal", "indigo", "amber", "rose", "mono"];
pub const TERMINAL_FONTS: &[&str] = &["system", "plex", "jetbrains"];
pub const INTERFACE_FONTS: &[&str] = &["system", "plex", "inter"];
/// How long a past session stays listed under its project before it goes
/// behind the fold with the rest of the history.
pub const PAST_SESSIONS: &[&str] = &["forever", "month", "week", "day"];

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

/// An entry of the keys, the hooks or the accounts that the file holds and
/// the app does not use, with the rule it breaks. It is written back where
/// it stood by every save, until a change names the entry again or replaces
/// the field it belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnreadEntry {
    /// `keys`, `hooks` or `accounts`.
    pub field: String,
    /// The part of the field it sits in: empty for the field's own entries.
    #[serde(default)]
    pub section: String,
    /// The entry's name: an action, a project path, an account. Empty when
    /// the whole field is not the shape it should be.
    pub name: String,
    pub reason: String,
    /// The entry as the file holds it.
    pub entry: Value,
}

/// A login kept apart from the others: Claude Code's in a configuration
/// directory of its own, Codex's in a home of its own. Either left out
/// means that agent runs on its own directory under the home.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Account {
    #[serde(default)]
    pub claude: Option<String>,
    #[serde(default)]
    pub codex: Option<String>,
}

/// The user's own accounts by name, the one every project uses, and the
/// projects that say otherwise, by path. No name is the agents' own
/// directories, which every setup has without naming them.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Accounts {
    #[serde(default)]
    pub list: BTreeMap<String, Account>,
    #[serde(default)]
    pub everywhere: Option<String>,
    #[serde(default)]
    pub overrides: BTreeMap<String, Option<String>>,
}

/// How many accounts the file may hold, and how long a name may be.
const MOST_ACCOUNTS: usize = 16;
const LONGEST_ACCOUNT: usize = 40;

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
    /// The agents' logins kept apart, and which project runs under which.
    pub accounts: Accounts,
    /// The workflows sessions can follow, the one new sessions start with,
    /// and which project chooses another.
    pub workflows: Workflows,
    /// How long a past session stays listed under its project.
    pub past_sessions: String,
    /// The user's own themes, by name. A palette may name one.
    pub themes: BTreeMap<String, Theme>,
    /// Whether the user's own stylesheet is laid over the app's.
    pub user_styles: bool,
    /// Whether a session that starts waiting for the user while the window
    /// is in the background says so with a system notification.
    pub notifications: bool,
    /// Whether it says so with a chime as well.
    pub chime: bool,
    /// What the file holds in the keys, hooks and accounts that is not
    /// used. Not a setting: it is read from the file and written back to it.
    #[serde(default)]
    pub unread_entries: Vec<UnreadEntry>,
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
            accounts: Accounts::default(),
            workflows: Workflows::default(),
            past_sessions: "forever".into(),
            themes: BTreeMap::new(),
            user_styles: false,
            notifications: true,
            chime: false,
            unread_entries: Vec::new(),
        }
    }
}

/// What the settings file holds, as one look at it found it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Found {
    /// There is no file.
    Missing,
    /// The file is whole: a JSON object, read leniently.
    Whole(Box<Settings>),
    /// There is a file and it is not a JSON object: empty, cut short, or
    /// not settings at all. The defaults are not what it holds.
    Unreadable,
}

/// The settings, and what the file held. `stored` is false when there is
/// no file, which means the window has not handed over what it kept before
/// there was a file. `unreadable` is true when there is a file that does
/// not parse; `settings` is then the defaults and says nothing about the
/// file, and a window keeps what it has.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    pub stored: bool,
    pub unreadable: bool,
    pub settings: Settings,
}

/// How many times a save looks at a file that does not parse before it
/// refuses, and how long it waits between looks. A writer that empties the
/// file first is usually done within a few milliseconds.
const MOST_LOOKS: usize = 5;
const BETWEEN_LOOKS: Duration = Duration::from_millis(40);

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

/// What one entry of the file is not: kept with the rule it breaks.
fn unused(
    unread: &mut Vec<UnreadEntry>,
    field: &str,
    section: &str,
    name: &str,
    reason: String,
    entry: &Value,
) {
    unread.push(UnreadEntry {
        field: field.into(),
        section: section.into(),
        name: name.into(),
        reason,
        entry: entry.clone(),
    });
}

/// The chords that read, each entry on its own; the rest are unread.
fn keys_lenient(value: &Value, unread: &mut Vec<UnreadEntry>) -> BTreeMap<String, Chord> {
    let mut keys = BTreeMap::new();
    let Some(table) = value.as_object() else {
        let reason = "keys is a table of chords by action".to_string();
        unused(unread, "keys", "", "", reason, value);
        return keys;
    };
    for (action, value) in table {
        let read = if keys.len() >= MOST_CHORDS {
            Err(format!("keys holds {MOST_CHORDS} chords at most"))
        } else if action.is_empty() || action.chars().count() > LONGEST_NAME {
            Err(format!("{action:?} is not an action"))
        } else {
            chord(action, value)
        };
        match read {
            Ok(chord) => {
                keys.insert(action.clone(), chord);
            }
            Err(reason) => unused(unread, "keys", "", action, reason, value),
        }
    }
    keys
}

/// The hooks that read, each entry on its own.
fn hooks_lenient(value: &Value, unread: &mut Vec<UnreadEntry>) -> Hooks {
    let mut hooks = Settings::default().hooks;
    let Some(table) = value.as_object() else {
        let reason = "hooks is everywhere, on or off, and the projects that say otherwise".into();
        unused(unread, "hooks", "", "", reason, value);
        return hooks;
    };
    for (name, value) in table {
        match (name.as_str(), value) {
            ("everywhere", Value::Bool(on)) => hooks.everywhere = *on,
            ("everywhere", _) => {
                let reason = "everywhere is on or off".into();
                unused(unread, "hooks", "", name, reason, value);
            }
            ("overrides", Value::Object(projects)) => {
                for (project, value) in projects {
                    match value {
                        Value::Bool(on) => {
                            hooks.overrides.insert(project.clone(), *on);
                        }
                        _ => {
                            let reason = format!("the choice for {project} is on or off");
                            unused(unread, "hooks", "overrides", project, reason, value);
                        }
                    }
                }
            }
            ("overrides", _) => {
                let reason = "overrides is the projects that say otherwise, by path".into();
                unused(unread, "hooks", "", name, reason, value);
            }
            _ => {}
        }
    }
    hooks
}

/// The accounts that read, each entry on its own. A choice that names an
/// account that is not used is unread with it.
fn accounts_lenient(value: &Value, unread: &mut Vec<UnreadEntry>) -> Accounts {
    let mut accounts = Accounts::default();
    let Some(table) = value.as_object() else {
        let reason = "accounts is a table of accounts by name, the one every project uses, and the projects that say otherwise".into();
        unused(unread, "accounts", "", "", reason, value);
        return accounts;
    };
    if let Some(list) = table.get("list") {
        match list.as_object() {
            Some(list) => {
                for (name, value) in list {
                    let read = if accounts.list.len() >= MOST_ACCOUNTS {
                        Err(format!(
                            "the settings hold {MOST_ACCOUNTS} accounts at most"
                        ))
                    } else {
                        account(name, value)
                    };
                    match read {
                        Ok(account) => {
                            accounts.list.insert(name.clone(), account);
                        }
                        Err(reason) => unused(unread, "accounts", "list", name, reason, value),
                    }
                }
            }
            None => {
                let reason = "list is the accounts by name".into();
                unused(unread, "accounts", "", "list", reason, list);
            }
        }
    }
    let choice = |value: &Value, accounts: &Accounts| -> Result<Option<String>, String> {
        match value {
            Value::Null => Ok(None),
            Value::String(name) if accounts.list.contains_key(name) => Ok(Some(name.clone())),
            Value::String(name) => Err(format!("there is no account called {name} in use")),
            _ => Err("a choice is an account's name or none".into()),
        }
    };
    if let Some(value) = table.get("everywhere") {
        match choice(value, &accounts) {
            Ok(choice) => accounts.everywhere = choice,
            Err(reason) => unused(unread, "accounts", "", "everywhere", reason, value),
        }
    }
    if let Some(overrides) = table.get("overrides") {
        match overrides.as_object() {
            Some(projects) => {
                for (project, value) in projects {
                    match choice(value, &accounts) {
                        Ok(choice) => {
                            accounts.overrides.insert(project.clone(), choice);
                        }
                        Err(reason) => {
                            unused(unread, "accounts", "overrides", project, reason, value)
                        }
                    }
                }
            }
            None => {
                let reason = "overrides is the projects that say otherwise, by path".into();
                unused(unread, "accounts", "", "overrides", reason, overrides);
            }
        }
    }
    accounts
}

/// One account of the file: a name that will do, and directories that will.
fn account(name: &str, value: &Value) -> Result<Account, String> {
    if name.trim().is_empty() || name.chars().count() > LONGEST_ACCOUNT {
        return Err(format!(
            "an account's name is a few words, {LONGEST_ACCOUNT} characters at most"
        ));
    }
    let account: Account = serde_json::from_value(value.clone())
        .map_err(|_| format!("{name} is a directory for Claude Code and one for Codex"))?;
    for dir in [&account.claude, &account.codex].into_iter().flatten() {
        if !is_directory(dir) {
            return Err(format!("a directory of {name} is a path, not {dir:?}"));
        }
    }
    Ok(account)
}

/// Drops the unread entries a change to `field` has mended: the field's own
/// shape when it is replaced whole, and an entry the change names again.
fn mend(settings: &mut Settings, field: &str) {
    let keys = settings.keys.clone();
    let hooks = settings.hooks.overrides.clone();
    let accounts = settings.accounts.clone();
    settings.unread_entries.retain(|entry| {
        if entry.field != field {
            return true;
        }
        match (field, entry.section.as_str()) {
            ("keys", _) => !entry.name.is_empty() && !keys.contains_key(&entry.name),
            ("hooks", "overrides") => !hooks.contains_key(&entry.name),
            ("accounts", "list") => !accounts.list.contains_key(&entry.name),
            ("accounts", "overrides") => !accounts.overrides.contains_key(&entry.name),
            _ => false,
        }
    });
}

fn hooks(value: &Value) -> Result<Hooks, String> {
    serde_json::from_value(value.clone())
        .map_err(|_| "hooks is everywhere, on or off, and the projects that say otherwise".into())
}

/// A directory as an account gives it: a few words of path, not empty.
fn is_directory(text: &str) -> bool {
    let text = text.trim();
    !text.is_empty() && text.len() <= 512 && !text.contains('\0')
}

/// The accounts a value holds, each with a name that will do and
/// directories that will, and every project and the default naming one of
/// them or none.
fn accounts(value: &Value) -> Result<Accounts, String> {
    let shape = "accounts is a table of accounts by name, the one every project uses, and the projects that say otherwise";
    if !value.is_object() {
        return Err(shape.to_string());
    }
    let accounts: Accounts =
        serde_json::from_value(value.clone()).map_err(|_| shape.to_string())?;
    if accounts.list.len() > MOST_ACCOUNTS {
        return Err(format!(
            "the settings hold {MOST_ACCOUNTS} accounts at most"
        ));
    }
    for (name, account) in &accounts.list {
        if name.trim().is_empty() || name.chars().count() > LONGEST_ACCOUNT {
            return Err(format!(
                "an account's name is a few words, {LONGEST_ACCOUNT} characters at most"
            ));
        }
        for dir in [&account.claude, &account.codex].into_iter().flatten() {
            if !is_directory(dir) {
                return Err(format!("a directory of {name} is a path, not {dir:?}"));
            }
        }
    }
    let named = |choice: &Option<String>| match choice {
        Some(name) if !accounts.list.contains_key(name) => Err(format!(
            "there is no account called {name}; the accounts are {}",
            accounts
                .list
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        )),
        _ => Ok(()),
    };
    named(&accounts.everywhere)?;
    for choice in accounts.overrides.values() {
        named(choice)?;
    }
    Ok(accounts)
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
        "notifications" => {
            settings.notifications = value.as_bool().ok_or("notifications is true or false")?;
        }
        "chime" => settings.chime = value.as_bool().ok_or("chime is true or false")?,
        "terminalFont" => settings.terminal_font = one_of(field, value, TERMINAL_FONTS)?,
        "interfaceFont" => settings.interface_font = one_of(field, value, INTERFACE_FONTS)?,
        "keys" => {
            settings.keys = keys(value)?;
            mend(settings, "keys");
        }
        "hooks" => {
            settings.hooks = hooks(value)?;
            mend(settings, "hooks");
        }
        "accounts" => {
            settings.accounts = accounts(value)?;
            mend(settings, "accounts");
        }
        "workflows" => settings.workflows = workflow::read(value)?,
        "pastSessions" => settings.past_sessions = one_of(field, value, PAST_SESSIONS)?,
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
/// its default, each theme or workflow that does not read left out, and each
/// key, hook or account entry that does not read set aside. None when the
/// text is not a JSON object at all.
pub fn parse(text: &str) -> Option<Settings> {
    let fields: Map<String, Value> = serde_json::from_str(text).ok()?;
    let mut settings = Settings::default();
    let mut unread = Vec::new();
    for (field, value) in in_order(&fields) {
        if field == "keys" {
            settings.keys = keys_lenient(value, &mut unread);
        } else if field == "hooks" {
            settings.hooks = hooks_lenient(value, &mut unread);
        } else if field == "accounts" {
            settings.accounts = accounts_lenient(value, &mut unread);
        } else if field == "themes" {
            settings.themes = themes(value, true).unwrap_or_default();
        } else if field == "workflows" {
            settings.workflows = workflow::read_lenient(value);
        } else {
            let _ = set_field(&mut settings, field, value);
        }
    }
    settings.unread_entries = unread;
    Some(settings)
}

/// The settings with a change laid over them. The change names only the
/// fields it changes; keys, hooks, accounts, workflows and themes are replaced
/// whole.
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

/// Writes an unread entry back where the file had it.
fn put_back(fields: &mut Map<String, Value>, entry: &UnreadEntry) {
    if entry.section.is_empty() && entry.name.is_empty() {
        fields.insert(entry.field.clone(), entry.entry.clone());
        return;
    }
    let field = fields
        .entry(entry.field.clone())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(table) = field.as_object_mut() else {
        return;
    };
    let table = if entry.section.is_empty() {
        table
    } else {
        let part = table
            .entry(entry.section.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        match part.as_object_mut() {
            Some(part) => part,
            None => return,
        }
    };
    table.insert(entry.name.clone(), entry.entry.clone());
}

/// The settings as the file holds them, with the workflows that are not
/// used written back where they stood.
fn render(settings: &Settings) -> String {
    let mut value = serde_json::to_value(settings).unwrap_or(Value::Null);
    if let Some(fields) = value.as_object_mut() {
        fields.insert("workflows".into(), workflow::for_file(&settings.workflows));
        fields.remove("unreadEntries");
        for entry in &settings.unread_entries {
            put_back(fields, entry);
        }
    }
    let text = serde_json::to_string_pretty(&value).unwrap_or_default();
    format!("{text}\n")
}

/// Where a write to the settings file lands: the file itself, or what a
/// link at its place points at, so a settings file that is a link stays one.
fn target_of(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Writes the text to a temporary file beside the file it is for, and on to
/// disk. Answers with where it is.
fn stage(path: &Path, text: &str) -> Result<PathBuf, String> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let temporary = path.with_extension("json.tmp");
    let written = std::fs::File::create(&temporary).and_then(|mut file| {
        file.write_all(text.as_bytes())?;
        file.sync_all()
    });
    written.map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        format!("could not write {}: {e}", temporary.display())
    })?;
    Ok(temporary)
}

fn commit(temporary: &Path, path: &Path) -> Result<(), String> {
    std::fs::rename(temporary, path).map_err(|e| {
        let _ = std::fs::remove_file(temporary);
        format!("could not write {}: {e}", path.display())
    })
}

/// Writes the file whole and moves it into place, so a reader finds the
/// old settings or the new, never half of either. The text goes to a
/// temporary file beside the settings file and is on disk before the move.
#[cfg(test)]
fn write(path: &Path, text: &str) -> Result<(), String> {
    let path = target_of(path);
    let temporary = stage(&path, text)?;
    commit(&temporary, &path)
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
    /// Whether the file was there when last looked at, so its going missing
    /// is told to the windows once.
    existed: AtomicBool,
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
            existed: AtomicBool::new(false),
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

    /// One look at the file, and the text it held when there was one.
    fn look_at(&self) -> (Found, Option<String>) {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => {
                self.existed.store(true, Ordering::SeqCst);
                let found = parse(&text).map_or(Found::Unreadable, |s| Found::Whole(Box::new(s)));
                (found, Some(text))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Found::Missing, None),
            Err(_) => {
                self.existed.store(true, Ordering::SeqCst);
                (Found::Unreadable, None)
            }
        }
    }

    fn look(&self) -> Found {
        self.look_at().0
    }

    /// Looks until the file is whole or missing, up to `MOST_LOOKS` times, and
    /// calls `between` before each look after the first.
    fn look_settled(&self, between: &mut dyn FnMut()) -> (Found, Option<String>) {
        let mut found = self.look_at();
        for _ in 1..MOST_LOOKS {
            if found.0 != Found::Unreadable {
                break;
            }
            between();
            found = self.look_at();
        }
        found
    }

    /// The settings as they are, and what the file held. A file that does
    /// not parse is answered as unreadable, not as the defaults, and the
    /// next look the watcher takes at a whole file is announced even when
    /// it matches what was announced before. The look and the forgetting
    /// happen under the write lock, so a look of the watcher's cannot fall
    /// between them.
    pub fn load(&self) -> Stored {
        let _writing = self.writing.lock();
        match self.look() {
            Found::Whole(settings) => Stored {
                stored: true,
                unreadable: false,
                settings: *settings,
            },
            Found::Missing => Stored {
                stored: false,
                unreadable: false,
                settings: Settings::default(),
            },
            Found::Unreadable => {
                self.forget_announced();
                Stored {
                    stored: true,
                    unreadable: true,
                    settings: Settings::default(),
                }
            }
        }
    }

    /// Forgets what was last announced, so the next whole file is news.
    fn forget_announced(&self) {
        if let Ok(mut announced) = self.announced.lock() {
            *announced = None;
        }
    }

    /// Tells the windows the file that was there is gone, once.
    fn note_missing(&self) {
        if self.existed.swap(false, Ordering::SeqCst) {
            self.forget_announced();
            events::emit(&self.sink, SETTINGS_MISSING, &Value::Null);
        }
    }

    /// Lays a change over the settings, writes them and announces them.
    /// Answers with the settings as they now are. A file that does not
    /// parse is looked at again a few times; if it still does not, nothing
    /// is written and the answer says so.
    pub fn set(&self, change: &Value) -> Result<Settings, String> {
        self.set_between(
            change,
            &mut || std::thread::sleep(BETWEEN_LOOKS),
            &mut || {},
        )
    }

    /// `between` runs before each further look at a file that does not
    /// parse, and `before_move` once the new text is staged and before it
    /// is moved into place.
    fn set_between(
        &self,
        change: &Value,
        between: &mut dyn FnMut(),
        before_move: &mut dyn FnMut(),
    ) -> Result<Settings, String> {
        let _writing = self.writing.lock().map_err(|_| "the settings are stuck")?;
        // A file that changed between the read and the move was edited
        // meanwhile: the change is laid over what is there now instead.
        for _ in 0..MOST_LOOKS {
            let (found, seen) = self.look_settled(between);
            let current = match found {
                Found::Whole(settings) => *settings,
                Found::Missing if self.existed.load(Ordering::SeqCst) => {
                    self.note_missing();
                    return Err("the settings file is gone, so nothing was saved: the window is putting its settings back, and the change can be made again".into());
                }
                Found::Missing => Settings::default(),
                Found::Unreadable => {
                    self.forget_announced();
                    return Err(format!(
                        "the settings file could not be read, so nothing was saved: it is empty or not valid settings, perhaps because something is writing it. Try again in a moment, or mend {}",
                        self.path.display()
                    ));
                }
            };
            let next = apply(&current, change)?;
            let path = target_of(&self.path);
            let staged = stage(&path, &render(&next))?;
            before_move();
            let now = std::fs::read_to_string(&self.path).ok();
            if now != seen {
                let _ = std::fs::remove_file(&staged);
                continue;
            }
            commit(&staged, &path)?;
            self.existed.store(true, Ordering::SeqCst);
            self.announce(&next);
            return Ok(next);
        }
        Err("the settings file keeps changing, so nothing was saved: try again in a moment".into())
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
    /// it holds if that is news. A file that does not parse is left alone:
    /// the windows keep what they have, and the next whole file is
    /// announced even when it matches what was last announced. A file that
    /// is gone is told to the windows, which hand over what they hold. The read and the announcement happen under the write
    /// lock, so what is announced is never older than a change the store
    /// has already announced.
    fn reread(&self) {
        let Ok(_writing) = self.writing.lock() else {
            return;
        };
        match self.look() {
            Found::Whole(settings) => self.announce(&settings),
            Found::Unreadable => self.forget_announced(),
            Found::Missing => self.note_missing(),
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
            *announced = match self.look() {
                Found::Whole(settings) => Some(*settings),
                Found::Missing => Some(Settings::default()),
                Found::Unreadable => None,
            };
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
    fn accounts_name_directories_and_every_choice_names_an_account() {
        let settings = Settings::default();
        let next = apply(
            &settings,
            &json!({ "accounts": {
                "list": { "work": { "claude": "~/.claude-work", "codex": "~/.codex-work" }, "lab": { "claude": "/srv/claude" } },
                "everywhere": "work",
                "overrides": { "/home/ada/toy": null, "/home/ada/lab": "lab" }
            } }),
        )
        .unwrap();
        assert_eq!(
            next.accounts.list["work"].claude.as_deref(),
            Some("~/.claude-work")
        );
        assert_eq!(next.accounts.list["lab"].codex, None);
        assert_eq!(next.accounts.everywhere.as_deref(), Some("work"));
        assert_eq!(next.accounts.overrides["/home/ada/toy"], None);
        assert_eq!(
            next.accounts.overrides["/home/ada/lab"].as_deref(),
            Some("lab")
        );

        // A choice has to name an account the list holds.
        let error = apply(
            &settings,
            &json!({ "accounts": { "list": {}, "everywhere": "work" } }),
        )
        .unwrap_err();
        assert!(error.contains("no account called work"), "{error}");
        assert!(apply(
            &settings,
            &json!({ "accounts": { "list": { "work": {} }, "overrides": { "/p": "home" } } }),
        )
        .is_err());
        // A directory is a path, and a name is a few words.
        assert!(apply(
            &settings,
            &json!({ "accounts": { "list": { "work": { "claude": "" } } } }),
        )
        .is_err());
        assert!(apply(
            &settings,
            &json!({ "accounts": { "list": { "": { "claude": "~/.c" } } } }),
        )
        .is_err());
        assert!(apply(&settings, &json!({ "accounts": [] })).is_err());

        // Read leniently, a bad value leaves the default, which is no
        // accounts at all.
        let parsed = parse(r#"{ "accounts": { "list": {}, "everywhere": "gone" } }"#).unwrap();
        assert!(parsed.accounts.list.is_empty());
        assert_eq!(parsed.accounts.everywhere, None);
        let parsed =
            parse(r#"{ "accounts": { "list": { "work": { "claude": "~/.claude-work" } } } }"#)
                .unwrap();
        assert_eq!(parsed.accounts.list.len(), 1);
    }

    #[test]
    fn a_fresh_machine_has_the_default_workflow_and_marks_it_for_new_sessions() {
        let home = home("workflows-fresh");
        let store = Store::new(&home, Arc::new(Recorder::default()));
        let loaded = store.load();
        assert!(!loaded.stored);
        let workflows = &loaded.settings.workflows;
        assert_eq!(workflows.list.len(), 1);
        assert_eq!(workflows.default.as_deref(), Some(workflow::DEFAULT_NAME));
        assert!(workflows.overrides.is_empty());
    }

    #[test]
    fn a_file_from_before_workflows_loads_and_gets_the_default() {
        let parsed = parse(r#"{ "palette": "rose", "accounts": { "list": {} } }"#).unwrap();
        assert_eq!(parsed.palette, "rose");
        assert_eq!(parsed.workflows, Workflows::default());
        let home = home("workflows-old");
        std::fs::create_dir_all(settings_path(&home).parent().unwrap()).unwrap();
        std::fs::write(settings_path(&home), r#"{ "look": "terminal" }"#).unwrap();
        let store = Store::new(&home, Arc::new(Recorder::default()));
        let loaded = store.load();
        assert!(loaded.stored);
        assert_eq!(loaded.settings.workflows, Workflows::default());
        // The next write puts them in the file.
        store.set(&json!({ "palette": "mono" })).unwrap();
        let text = std::fs::read_to_string(settings_path(&home)).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["workflows"]["default"], workflow::DEFAULT_NAME);
        assert_eq!(value["workflows"]["list"][0]["steps"][1]["kind"], "review");
    }

    #[test]
    fn workflows_are_replaced_whole_and_checked_before_anything_is_written() {
        let home = home("workflows-change");
        let recorder = Arc::new(Recorder::default());
        let store = Store::new(&home, recorder.clone());
        let next = store
            .set(&json!({ "workflows": {
                "list": [{
                    "name": "Quick",
                    "orchestrator": { "agent": "claude-code", "model": "opus" },
                    "steps": [{ "kind": "work", "name": "Do", "models": [], "parallel": 2 }]
                }],
                "default": null,
                "overrides": { "/p": "Quick" }
            } }))
            .unwrap();
        assert_eq!(next.workflows.list[0].name, "Quick");
        assert_eq!(next.workflows.default, None);
        assert_eq!(store.load().settings, next);

        let error = store
            .set(&json!({ "workflows": { "list": [], "default": "Gone" } }))
            .unwrap_err();
        assert!(error.contains("no workflow called Gone"), "{error}");
        assert!(store.set(&json!({ "workflows": "none" })).is_err());
        assert_eq!(store.load().settings, next, "nothing was written");
        assert_eq!(changes(&recorder).len(), 1);
    }

    #[test]
    fn a_workflow_in_the_file_that_does_not_read_is_set_aside_and_survives_every_write() {
        let home = home("workflows-partly");
        std::fs::create_dir_all(settings_path(&home).parent().unwrap()).unwrap();
        let mut good = serde_json::to_value(&Workflows::default().list[0]).unwrap();
        good["name"] = json!("Mine");
        let mut bad = good.clone();
        bad["name"] = json!("Hand edited");
        bad["steps"][1]["limit"] = json!(11);
        let file = json!({ "workflows": {
            "list": [bad, good],
            "default": "Hand edited",
            "overrides": { "/p": "Mine", "/q": "Hand edited" }
        } });
        std::fs::write(settings_path(&home), file.to_string()).unwrap();
        let store = Store::new(&home, Arc::new(Recorder::default()));
        let loaded = store.load().settings.workflows;
        assert_eq!(loaded.list.len(), 1);
        assert_eq!(loaded.list[0].name, "Mine");
        assert_eq!(loaded.default, None);
        assert_eq!(loaded.unread.len(), 1);
        assert_eq!(loaded.unread[0].name.as_deref(), Some("Hand edited"));

        // An unrelated change writes the file with the entry as it was.
        store.set(&json!({ "palette": "mono" })).unwrap();
        let text = std::fs::read_to_string(settings_path(&home)).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["workflows"], file["workflows"]);

        // So does a change to the workflows that carries it.
        let mut carried = serde_json::to_value(&loaded).unwrap();
        carried["list"][0]["orchestrator"]["model"] = json!("opus");
        store.set(&json!({ "workflows": carried })).unwrap();
        let text = std::fs::read_to_string(settings_path(&home)).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["workflows"]["list"][0], bad);
        assert_eq!(
            value["workflows"]["list"][1]["orchestrator"]["model"],
            "opus"
        );
        assert_eq!(value["workflows"]["default"], "Hand edited");

        // Removing it removes it, with the choices that named it.
        carried["unread"] = json!([]);
        store.set(&json!({ "workflows": carried })).unwrap();
        let text = std::fs::read_to_string(settings_path(&home)).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["workflows"]["list"].as_array().unwrap().len(), 1);
        assert_eq!(value["workflows"]["default"], Value::Null);
        assert_eq!(value["workflows"]["overrides"], json!({ "/p": "Mine" }));

        let parsed = parse(r#"{ "workflows": "none" }"#).unwrap();
        assert_eq!(parsed.workflows, Workflows::default());
        let parsed = parse(r#"{ "workflows": { "list": [], "default": null } }"#).unwrap();
        assert!(parsed.workflows.list.is_empty());
        assert_eq!(parsed.workflows.default, None);
    }

    #[test]
    fn how_long_a_past_session_stays_listed_is_one_of_a_few_spans() {
        let settings = Settings::default();
        assert_eq!(settings.past_sessions, "forever");
        let next = apply(&settings, &json!({ "pastSessions": "week" })).unwrap();
        assert_eq!(next.past_sessions, "week");
        let error = apply(&settings, &json!({ "pastSessions": "fortnight" })).unwrap_err();
        assert!(error.contains("forever, month, week, day"), "{error}");
        assert_eq!(
            parse(r#"{ "pastSessions": 7 }"#).unwrap().past_sessions,
            "forever"
        );
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

    fn put(home: &Path, text: &str) {
        std::fs::create_dir_all(settings_path(home).parent().unwrap()).unwrap();
        std::fs::write(settings_path(home), text).unwrap();
    }

    fn whole_text() -> String {
        render(&Settings {
            palette: "rose".into(),
            look: "terminal".into(),
            ..Settings::default()
        })
    }

    #[test]
    fn the_file_is_missing_whole_or_unreadable_and_a_read_says_which() {
        let home = home("three-states");
        let store = Store::new(&home, Arc::new(Recorder::default()));
        assert_eq!(store.look(), Found::Missing);
        let loaded = store.load();
        assert!(!loaded.stored && !loaded.unreadable);

        put(&home, &whole_text());
        assert!(matches!(store.look(), Found::Whole(s) if s.palette == "rose"));
        let loaded = store.load();
        assert!(loaded.stored && !loaded.unreadable);
        assert_eq!(loaded.settings.palette, "rose");

        for broken in ["", "   \n", "{ half", "[]", "null"] {
            put(&home, broken);
            assert_eq!(store.look(), Found::Unreadable, "{broken:?}");
            let loaded = store.load();
            assert!(loaded.stored && loaded.unreadable, "{broken:?}");
        }
    }

    #[test]
    fn an_empty_object_is_whole_and_a_file_with_one_bad_workflow_still_loads() {
        let home = home("lenient-whole");
        let store = Store::new(&home, Arc::new(Recorder::default()));
        put(&home, "{}");
        assert!(matches!(store.look(), Found::Whole(_)));
        put(
            &home,
            r#"{ "palette": "mono", "workflows": { "list": [ { "name": "" } ], "default": null, "overrides": {} } }"#,
        );
        let loaded = store.load();
        assert!(!loaded.unreadable);
        assert_eq!(loaded.settings.palette, "mono");
    }

    #[test]
    fn a_save_against_an_empty_or_cut_short_file_is_refused_and_leaves_it_alone() {
        for (name, broken) in [("empty", ""), ("cut", "{ \"palette\": \"ro")] {
            let home = home(&format!("refused-{name}"));
            put(&home, broken);
            let recorder = Arc::new(Recorder::default());
            let store = Store::new(&home, recorder.clone());
            let mut looks = 0;
            let error = store
                .set_between(
                    &json!({ "appearance": "dark" }),
                    &mut || looks += 1,
                    &mut || {},
                )
                .unwrap_err();
            assert!(error.contains("could not be read"), "{error}");
            assert!(error.contains("nothing was saved"), "{error}");
            assert_eq!(looks, MOST_LOOKS - 1, "it looked again before refusing");
            assert_eq!(
                std::fs::read_to_string(settings_path(&home)).unwrap(),
                broken,
                "the file is untouched"
            );
            assert!(changes(&recorder).is_empty());
        }
    }

    #[test]
    fn a_save_that_finds_the_file_whole_on_the_second_look_builds_on_it() {
        let home = home("second-look");
        put(&home, "");
        let store = Store::new(&home, Arc::new(Recorder::default()));
        let whole = whole_text();
        let mut looks = 0;
        let next = store
            .set_between(
                &json!({ "appearance": "dark" }),
                &mut || {
                    looks += 1;
                    put(&home, &whole);
                },
                &mut || {},
            )
            .unwrap();
        assert_eq!(looks, 1);
        assert_eq!(next.appearance, "dark");
        assert_eq!(next.palette, "rose", "the other settings are kept");
        assert_eq!(next.look, "terminal");
        let loaded = store.load().settings;
        assert_eq!(loaded.palette, "rose");
        assert_eq!(loaded.appearance, "dark");
    }

    #[test]
    fn a_missing_file_is_built_on_as_the_defaults() {
        let home = home("save-missing");
        let store = Store::new(&home, Arc::new(Recorder::default()));
        let next = store.set(&json!({ "appearance": "dark" })).unwrap();
        assert_eq!(next.palette, Settings::default().palette);
        assert!(store.load().stored);
    }

    #[test]
    fn a_reader_never_sees_the_cores_own_write_half_done() {
        let home = home("whole-writes");
        let path = settings_path(&home);
        let short = format!("{{ \"padding\": \"{}\" }}\n", "x".repeat(10));
        let long = format!("{{ \"padding\": \"{}\" }}\n", "x".repeat(8_000_000));
        write(&path, &short).unwrap();
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader = {
            let done = Arc::clone(&done);
            let path = path.clone();
            std::thread::spawn(move || {
                let mut reads = 0;
                while !done.load(std::sync::atomic::Ordering::SeqCst) {
                    let text = std::fs::read_to_string(&path).expect("the file is always there");
                    assert!(
                        parse(&text).is_some(),
                        "half a file of {} bytes",
                        text.len()
                    );
                    reads += 1;
                }
                reads
            })
        };
        for n in 0..40 {
            write(&path, if n % 2 == 0 { &long } else { &short }).unwrap();
        }
        done.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(reader.join().unwrap() > 0);
    }

    #[test]
    fn a_whole_file_after_an_unreadable_look_is_announced_even_when_it_matches_what_was() {
        let home = home("read-unreadable");
        let recorder = Arc::new(Recorder::default());
        let store = Store::new(&home, recorder.clone());
        put(&home, &whole_text());
        let settings = match store.look() {
            Found::Whole(s) => s,
            other => panic!("{other:?}"),
        };
        store.announce(&settings);
        let before = changes(&recorder).len();
        put(&home, "");
        assert!(store.load().unreadable);
        put(&home, &whole_text());
        store.reread();
        assert_eq!(changes(&recorder).len(), before + 1);
    }

    #[test]
    fn the_user_s_styles_are_off_until_turned_on() {
        assert!(!Settings::default().user_styles);
        let next = apply(&Settings::default(), &json!({ "userStyles": true })).unwrap();
        assert!(next.user_styles);
        assert!(apply(&next, &json!({ "userStyles": "yes" })).is_err());
    }

    #[test]
    fn notifications_are_on_and_the_chime_off_until_changed() {
        let defaults = Settings::default();
        assert!(defaults.notifications);
        assert!(!defaults.chime);
        let next = apply(&defaults, &json!({ "notifications": false, "chime": true })).unwrap();
        assert!(!next.notifications);
        assert!(next.chime);
        assert!(apply(&next, &json!({ "chime": "loud" })).is_err());
        assert!(apply(&next, &json!({ "notifications": 1 })).is_err());
        let read = parse(r#"{ "chime": true }"#).unwrap();
        assert!(read.notifications && read.chime);
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

    fn keyed(extra: &str) -> String {
        format!(r#"{{ "palette": "rose", {extra} }}"#)
    }

    #[test]
    fn one_bad_key_costs_that_key_and_is_carried_through_writes() {
        let home = home("bad-key");
        put(
            &home,
            &keyed(
                r#""keys": { "review": { "key": "g", "shift": false, "alt": false }, "find": { "key": 3 } }"#,
            ),
        );
        let store = Store::new(&home, Arc::new(Recorder::default()));
        let loaded = store.load().settings;
        assert_eq!(loaded.palette, "rose");
        assert!(loaded.keys.contains_key("review"));
        assert!(!loaded.keys.contains_key("find"));
        assert_eq!(loaded.unread_entries.len(), 1);
        assert_eq!(loaded.unread_entries[0].name, "find");
        assert!(loaded.unread_entries[0].reason.contains("find"));

        store.set(&json!({ "appearance": "dark" })).unwrap();
        let text = std::fs::read_to_string(settings_path(&home)).unwrap();
        let file: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(file["keys"]["find"], json!({ "key": 3 }), "carried: {text}");
        assert_eq!(file["keys"]["review"]["key"], "g");
        assert!(file.get("unreadEntries").is_none());

        // Naming the entry again mends it.
        store
            .set(&json!({ "keys": {
                "review": { "key": "g", "shift": false, "alt": false },
                "find": { "key": "f", "shift": true, "alt": false }
            } }))
            .unwrap();
        let loaded = store.load().settings;
        assert!(loaded.unread_entries.is_empty());
        assert_eq!(loaded.keys["find"].key, "f");
    }

    #[test]
    fn one_bad_hook_choice_or_account_costs_that_entry_only() {
        let home = home("bad-hooks-accounts");
        put(
            &home,
            &keyed(
                r#""hooks": { "everywhere": false, "overrides": { "/a": true, "/b": "yes" } },
                   "accounts": {
                     "list": { "Work": { "claude": "~/.claude-work" }, "": {}, "Bad": { "claude": 4 } },
                     "everywhere": "Work",
                     "overrides": { "/a": "Work", "/b": "Bad", "/c": "Nobody" }
                   }"#,
            ),
        );
        let store = Store::new(&home, Arc::new(Recorder::default()));
        let loaded = store.load().settings;
        assert!(!loaded.hooks.everywhere);
        assert_eq!(loaded.hooks.overrides.len(), 1);
        assert_eq!(loaded.accounts.list.len(), 1);
        assert_eq!(loaded.accounts.everywhere.as_deref(), Some("Work"));
        assert_eq!(loaded.accounts.overrides.len(), 1);
        let names: Vec<_> = loaded
            .unread_entries
            .iter()
            .map(|u| format!("{}/{}/{}", u.field, u.section, u.name))
            .collect();
        assert_eq!(names.len(), 5, "{names:?}");
        assert!(
            names.contains(&"hooks/overrides//b".to_string()),
            "{names:?}"
        );

        store.set(&json!({ "chime": true })).unwrap();
        let file: Value =
            serde_json::from_str(&std::fs::read_to_string(settings_path(&home)).unwrap()).unwrap();
        assert_eq!(file["hooks"]["overrides"]["/b"], "yes");
        assert_eq!(file["accounts"]["list"]["Bad"], json!({ "claude": 4 }));
        assert_eq!(file["accounts"]["overrides"]["/c"], "Nobody");
        assert_eq!(file["accounts"]["overrides"]["/a"], "Work");
    }

    #[test]
    fn a_field_that_is_not_the_shape_at_all_is_unread_whole_and_replaced_by_a_change() {
        let home = home("bad-field");
        put(&home, &keyed(r#""keys": [1, 2], "hooks": 7"#));
        let store = Store::new(&home, Arc::new(Recorder::default()));
        let loaded = store.load().settings;
        assert_eq!(loaded.unread_entries.len(), 2);
        assert!(loaded.keys.is_empty());
        store.set(&json!({ "chime": true })).unwrap();
        let file: Value =
            serde_json::from_str(&std::fs::read_to_string(settings_path(&home)).unwrap()).unwrap();
        assert_eq!(file["keys"], json!([1, 2]));
        assert_eq!(file["hooks"], json!(7));
        store
            .set(&json!({ "hooks": { "everywhere": false, "overrides": {} } }))
            .unwrap();
        let loaded = store.load().settings;
        assert_eq!(loaded.unread_entries.len(), 1);
        assert_eq!(loaded.unread_entries[0].field, "keys");
    }

    #[test]
    fn a_file_going_missing_is_told_once_and_a_save_before_that_is_refused() {
        let home = home("goes-missing");
        let recorder = Arc::new(Recorder::default());
        let store = Store::new(&home, recorder.clone());
        let count = |recorder: &Recorder| {
            recorder
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|(name, _)| name == SETTINGS_MISSING)
                .count()
        };
        store.set(&json!({ "palette": "rose" })).unwrap();
        std::fs::remove_file(settings_path(&home)).unwrap();
        store.reread();
        store.reread();
        assert_eq!(count(&recorder), 1);

        // A save that finds it gone before the watcher did refuses, and tells.
        store.set(&json!({ "palette": "rose" })).unwrap();
        std::fs::remove_file(settings_path(&home)).unwrap();
        let error = store.set(&json!({ "look": "terminal" })).unwrap_err();
        assert!(error.contains("is gone"), "{error}");
        assert_eq!(count(&recorder), 2);
        assert!(!settings_path(&home).exists(), "nothing was written");

        // A machine that never had a file does not say it went missing.
        let fresh = home_of("never-had");
        let recorder = Arc::new(Recorder::default());
        let store = Store::new(&fresh, recorder.clone());
        store.reread();
        assert_eq!(count(&recorder), 0);
        store.set(&json!({ "palette": "rose" })).unwrap();
    }

    fn home_of(name: &str) -> PathBuf {
        home(name)
    }

    #[test]
    fn the_refusal_to_save_over_an_unreadable_file_says_to_mend_it_not_to_remove_it() {
        let home = home("mend-message");
        put(&home, "{ half");
        let store = Store::new(&home, Arc::new(Recorder::default()));
        let error = store
            .set_between(&json!({ "chime": true }), &mut || {}, &mut || {})
            .unwrap_err();
        assert!(error.contains("mend"), "{error}");
        assert!(!error.contains("remove"), "{error}");
        assert!(error.contains(&settings_path(&home).display().to_string()));
    }

    #[test]
    fn a_hand_edit_saved_while_a_change_is_being_written_is_not_lost() {
        let home = home("edit-during-write");
        put(&home, &whole_text());
        let store = Store::new(&home, Arc::new(Recorder::default()));
        let mut edits = 0;
        let edited = render(&Settings {
            palette: "mono".into(),
            look: "terminal".into(),
            ..Settings::default()
        });
        let next = store
            .set_between(&json!({ "appearance": "dark" }), &mut || {}, &mut || {
                edits += 1;
                if edits == 1 {
                    put(&home, &edited);
                }
            })
            .unwrap();
        assert_eq!(edits, 2, "the change was laid over the edited file");
        assert_eq!(next.palette, "mono");
        assert_eq!(next.appearance, "dark");
        assert_eq!(store.load().settings.palette, "mono");
    }

    #[cfg(unix)]
    #[test]
    fn a_settings_file_that_is_a_link_stays_a_link() {
        let home = home("link");
        let elsewhere = home.join("elsewhere.json");
        std::fs::write(&elsewhere, whole_text()).unwrap();
        std::fs::create_dir_all(settings_path(&home).parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&elsewhere, settings_path(&home)).unwrap();
        let store = Store::new(&home, Arc::new(Recorder::default()));
        store.set(&json!({ "appearance": "dark" })).unwrap();
        assert!(std::fs::symlink_metadata(settings_path(&home))
            .unwrap()
            .file_type()
            .is_symlink());
        let text = std::fs::read_to_string(&elsewhere).unwrap();
        assert!(text.contains("\"appearance\": \"dark\""), "{text}");
        assert!(text.contains("\"rose\""));
    }

    #[test]
    fn a_load_waits_for_a_change_in_progress() {
        let home = home("load-lock");
        put(&home, &whole_text());
        let store = Arc::new(Store::new(&home, Arc::new(Recorder::default())));
        let held = store.writing.lock().unwrap();
        let reader = {
            let store = Arc::clone(&store);
            std::thread::spawn(move || store.load())
        };
        std::thread::sleep(Duration::from_millis(100));
        assert!(!reader.is_finished(), "the load holds the write lock");
        drop(held);
        assert!(reader.join().unwrap().stored);
    }
}
