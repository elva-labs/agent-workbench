//! The native menus.
//!
//! On macOS a menu bar: Settings under the app menu with the standard
//! accelerator, a File menu for the editor, an Edit menu, without which copy
//! and paste have no key equivalents in the webview, and a Window menu. On
//! Windows and Linux the window is undecorated and a bar would sit in the row
//! the app took, so there is a native popup instead, opened from a button at
//! the top left of the window: the editor's items, Settings, and Quit.
//! Choosing Settings either way tells the window, which opens its settings
//! view.
//!
//! The editor's items, New File, Save and Close Tab, do what an action of
//! the window's chord table does, so the window does it: the item says which
//! action. On the menu bar each carries the chord the table gives its action,
//! sent over whenever the table changes, so a chord the user moves moves the
//! item's with it and the bar never claims a chord the table gives elsewhere.
//! The popup's items carry none: a menu attached to no window answers no
//! keys, and the window answers the chords itself.
//!
//! Quit and Close Window are the app's own items rather than the system's,
//! so they can ask first while the editor holds unsaved edits; see
//! [`crate::leaving`]. Close Window is on Shift+Cmd+W, since Cmd+W closes
//! the editor's tab in front.
//!
//! Both also carry Turn Off Custom Styles, which turns the user's own
//! stylesheet off in the settings file itself. It works whatever that
//! stylesheet has done to the page, since neither the menu nor the file is
//! the page's to hide.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::menu::{ContextMenu, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{App, AppHandle, Emitter, Manager, State, Window, Wry};

use crate::browser_keys::Chord;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use workbench_core::Core;

pub const OPEN_SETTINGS: &str = "open_settings";
pub const MENU_ACTION: &str = "menu_action";
const SETTINGS_ID: &str = "settings";
const STYLES_OFF_ID: &str = "styles-off";
const QUIT_ID: &str = "quit";
const CLOSE_WINDOW_ID: &str = "close-window";

/// The editor's items: the action of the chord table each does, and its
/// name in the menu. The id of each item is its action.
const FILE_ITEMS: [(&str, &str); 3] = [
    ("file.new", "New File"),
    ("file.save", "Save"),
    ("file.close", "Close Tab"),
];

/// The chords the table starts with for the editor's items, until the
/// window sends its own.
const FILE_DEFAULTS: [(&str, &str); 3] = [
    ("file.new", "Alt+CmdOrCtrl+N"),
    ("file.save", "CmdOrCtrl+S"),
    ("file.close", "CmdOrCtrl+W"),
];

/// The menu bar's editor items, kept to set the chord each shows and
/// answers, and whether each can act.
#[derive(Default)]
pub struct FileItems(Mutex<Vec<(String, MenuItem<Wry>)>>);

/// The menu bar's items with chords of their own rather than an action's:
/// Settings, which shows the chord the table gives settings, and Close
/// Window, whose chord gives way when the table gives it to an action.
#[derive(Default)]
pub struct FixedItems(Mutex<Option<(MenuItem<Wry>, MenuItem<Wry>)>>);

/// Close Window's chord.
const CLOSE_WINDOW_CHORD: &str = "CmdOrCtrl+Shift+W";

/// Close Window's chord, unless the table gives Shift+W to an action: the
/// page answers that chord first, and the menu does not claim it.
fn close_window_accelerator(table: &HashMap<String, Chord>) -> Option<&'static str> {
    let taken = table
        .values()
        .any(|chord| chord.key == "w" && chord.shift && !chord.alt);
    (!taken).then_some(CLOSE_WINDOW_CHORD)
}

/// The popup for the platforms without a menu bar, kept so a click can show
/// the same one each time.
pub struct AppMenu(Menu<Wry>);

fn settings_item(handle: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(handle, SETTINGS_ID, "Settings…", true, Some("CmdOrCtrl+,"))
}

fn styles_off_item(handle: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(
        handle,
        STYLES_OFF_ID,
        "Turn Off Custom Styles",
        true,
        None::<&str>,
    )
}

/// Turns the user's stylesheet off in the settings, which every window
/// follows.
fn styles_off(app: &AppHandle) {
    let core = Arc::clone(&app.state::<Arc<Core>>());
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = core.settings_set(&serde_json::json!({ "userStyles": false })) {
            app.dialog()
                .message(format!("Custom styles could not be turned off: {error}"))
                .title("Custom styles")
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
    });
}

/// Quit, with its chord on the menu bar and none on the popup, which
/// answers no keys.
fn quit_item(handle: &AppHandle, text: &str, chord: bool) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(handle, QUIT_ID, text, true, chord.then_some("CmdOrCtrl+Q"))
}

/// The editor's items, with the chords the table starts with or none.
fn file_items(handle: &AppHandle, chords: bool) -> tauri::Result<Vec<MenuItem<Wry>>> {
    FILE_ITEMS
        .iter()
        .map(|(id, text)| {
            let chord = FILE_DEFAULTS
                .iter()
                .find(|(action, _)| action == id)
                .map(|(_, chord)| *chord)
                .filter(|_| chords);
            MenuItem::with_id(handle, *id, *text, true, chord)
        })
        .collect()
}

pub fn install(app: &App) -> tauri::Result<()> {
    let handle = app.handle();

    let editing = file_items(handle, false)?;
    let popup = Menu::with_items(
        handle,
        &[
            &editing[0],
            &editing[1],
            &editing[2],
            &PredefinedMenuItem::separator(handle)?,
            &settings_item(handle)?,
            &styles_off_item(handle)?,
            &PredefinedMenuItem::separator(handle)?,
            &quit_item(handle, "Quit", false)?,
        ],
    )?;
    app.manage(AppMenu(popup));
    app.manage(FileItems::default());
    app.manage(FixedItems::default());

    app.on_menu_event(|app, event| match event.id().as_ref() {
        SETTINGS_ID => {
            let _ = app.emit(OPEN_SETTINGS, ());
        }
        STYLES_OFF_ID => styles_off(app),
        QUIT_ID => crate::leaving::quit(app),
        CLOSE_WINDOW_ID => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
        }
        id if FILE_ITEMS.iter().any(|(action, _)| *action == id) => {
            let _ = app.emit(MENU_ACTION, id);
        }
        _ => {}
    });

    if cfg!(target_os = "macos") {
        app.set_menu(menu_bar(app)?)?;
    }
    Ok(())
}

/// A chord of the window's table as a menu accelerator: the platform
/// modifier, then Shift and Alt when they join it, then the key. None for a
/// key the menus cannot show.
pub fn accelerator(chord: &Chord) -> Option<String> {
    let key = match chord.key.as_str() {
        " " => "Space".to_string(),
        "+" => return None,
        key if key.chars().count() == 1 => key.to_uppercase(),
        key if key.starts_with("Arrow") || key.starts_with('F') => key.to_string(),
        _ => return None,
    };
    let mut parts = vec!["CmdOrCtrl"];
    if chord.shift {
        parts.push("Shift");
    }
    if chord.alt {
        parts.push("Alt");
    }
    Some(format!("{}+{key}", parts.join("+")))
}

/// The chord table, for the menu bar's editor items and Settings to show
/// and answer the chords their actions have, and for Close Window to give
/// its own up when the table uses it.
#[tauri::command]
pub fn menu_keys(
    items: State<'_, FileItems>,
    fixed: State<'_, FixedItems>,
    table: HashMap<String, Chord>,
) -> Result<(), String> {
    for (action, item) in items.0.lock().unwrap().iter() {
        set_chord(item, table.get(action).and_then(accelerator).as_deref())?;
    }
    if let Some((settings, close_window)) = fixed.0.lock().unwrap().as_ref() {
        set_chord(
            settings,
            table.get("settings").and_then(accelerator).as_deref(),
        )?;
        set_chord(close_window, close_window_accelerator(&table))?;
    }
    Ok(())
}

/// Sets an item's chord, or none when the menus cannot take it.
fn set_chord(item: &MenuItem<Wry>, chord: Option<&str>) -> Result<(), String> {
    if item.set_accelerator(chord).is_err() {
        item.set_accelerator(None::<&str>)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Which of the editor's items can act, by action, as the window says
/// each time that changes: an item that cannot is greyed out.
#[tauri::command]
pub fn menu_enabled(
    items: State<'_, FileItems>,
    state: HashMap<String, bool>,
) -> Result<(), String> {
    for (action, item) in items.0.lock().unwrap().iter() {
        let enabled = state.get(action).copied().unwrap_or(true);
        item.set_enabled(enabled).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Shows the popup at the pointer, for the button that stands in for a
/// menu bar.
#[tauri::command]
pub fn app_menu(window: Window, menu: State<'_, AppMenu>) -> Result<(), String> {
    menu.0.popup(window).map_err(|e| e.to_string())
}

fn menu_bar(app: &App) -> tauri::Result<Menu<Wry>> {
    let handle = app.handle();
    let settings = settings_item(handle)?;
    let close_window = MenuItem::with_id(
        handle,
        CLOSE_WINDOW_ID,
        "Close Window",
        true,
        Some(CLOSE_WINDOW_CHORD),
    )?;
    *app.state::<FixedItems>().0.lock().unwrap() = Some((settings.clone(), close_window.clone()));

    let editing = file_items(handle, true)?;
    let file = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &editing[0],
            &PredefinedMenuItem::separator(handle)?,
            &editing[1],
            &PredefinedMenuItem::separator(handle)?,
            &editing[2],
        ],
    )?;
    *app.state::<FileItems>().0.lock().unwrap() = FILE_ITEMS
        .iter()
        .map(|(id, _)| id.to_string())
        .zip(editing)
        .collect();

    let edit = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        handle,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &close_window,
        ],
    )?;

    // The items name the product outright: left to the system they name the
    // process, which in a dev build is the crate.
    let name = handle.package_info().name.clone();
    let application = Submenu::with_items(
        handle,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(handle, Some(&format!("About {name}")), None)?,
            &PredefinedMenuItem::separator(handle)?,
            &settings,
            &styles_off_item(handle)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, Some(&format!("Hide {name}")))?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::show_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &quit_item(handle, &format!("Quit {name}"), true)?,
        ],
    )?;
    Menu::with_items(handle, &[&application, &file, &edit, &window])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chord(key: &str, shift: bool, alt: bool) -> Chord {
        Chord {
            key: key.to_string(),
            shift,
            alt,
        }
    }

    #[test]
    fn spells_a_chord_as_an_accelerator() {
        assert_eq!(
            accelerator(&chord("s", false, false)).unwrap(),
            "CmdOrCtrl+S"
        );
        assert_eq!(
            accelerator(&chord("n", false, true)).unwrap(),
            "CmdOrCtrl+Alt+N"
        );
        assert_eq!(
            accelerator(&chord("w", true, false)).unwrap(),
            "CmdOrCtrl+Shift+W"
        );
        assert_eq!(
            accelerator(&chord("\\", false, false)).unwrap(),
            "CmdOrCtrl+\\"
        );
        assert_eq!(
            accelerator(&chord("ArrowDown", true, false)).unwrap(),
            "CmdOrCtrl+Shift+ArrowDown"
        );
        assert_eq!(
            accelerator(&chord(" ", false, false)).unwrap(),
            "CmdOrCtrl+Space"
        );
    }

    #[test]
    fn leaves_out_a_key_the_menus_cannot_show() {
        assert_eq!(accelerator(&chord("+", false, false)), None);
        assert_eq!(accelerator(&chord("Escape", false, false)), None);
    }

    #[test]
    fn close_window_gives_its_chord_up_to_an_action() {
        let mut table = HashMap::new();
        table.insert("file.close".to_string(), chord("w", false, false));
        assert_eq!(close_window_accelerator(&table), Some(CLOSE_WINDOW_CHORD));
        table.insert("theme".to_string(), chord("w", true, false));
        assert_eq!(close_window_accelerator(&table), None);
    }

    #[test]
    fn every_editor_item_starts_on_its_chord() {
        for (action, _) in FILE_ITEMS {
            assert!(
                FILE_DEFAULTS.iter().any(|(id, _)| *id == action),
                "{action}"
            );
        }
    }
}
