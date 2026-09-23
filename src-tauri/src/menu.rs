//! The native menus.
//!
//! On macOS a menu bar: Settings under the app menu with the standard
//! accelerator, an Edit menu, without which copy and paste have no key
//! equivalents in the webview, and a Window menu. On Windows and Linux the
//! window is undecorated and a bar would sit in the row the app took, so
//! there is a native popup instead, opened from a button at the top left of
//! the window: Settings, and Quit. Choosing Settings either way tells the
//! window, which opens its settings view.
//!
//! Both also carry Turn Off Custom Styles, which turns the user's own
//! stylesheet off in the settings file itself. It works whatever that
//! stylesheet has done to the page, since neither the menu nor the file is
//! the page's to hide.

use std::sync::Arc;

use tauri::menu::{ContextMenu, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{App, AppHandle, Emitter, Manager, State, Window, Wry};
use workbench_core::Core;

pub const OPEN_SETTINGS: &str = "open_settings";
const SETTINGS_ID: &str = "settings";
const STYLES_OFF_ID: &str = "styles-off";

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
    std::thread::spawn(move || {
        if let Err(error) = core.settings_set(&serde_json::json!({ "userStyles": false })) {
            eprintln!("custom styles: {error}");
        }
    });
}

pub fn install(app: &App) -> tauri::Result<()> {
    let handle = app.handle();

    let popup = Menu::with_items(
        handle,
        &[
            &settings_item(handle)?,
            &styles_off_item(handle)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;
    app.manage(AppMenu(popup));

    app.on_menu_event(|app, event| match event.id().as_ref() {
        SETTINGS_ID => {
            let _ = app.emit(OPEN_SETTINGS, ());
        }
        STYLES_OFF_ID => styles_off(app),
        _ => {}
    });

    if cfg!(target_os = "macos") {
        app.set_menu(menu_bar(handle)?)?;
    }
    Ok(())
}

/// Shows the popup at the pointer, for the button that stands in for a
/// menu bar.
#[tauri::command]
pub fn app_menu(window: Window, menu: State<'_, AppMenu>) -> Result<(), String> {
    menu.0.popup(window).map_err(|e| e.to_string())
}

fn menu_bar(handle: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let settings = settings_item(handle)?;

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
            &PredefinedMenuItem::close_window(handle, None)?,
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
            &PredefinedMenuItem::quit(handle, Some(&format!("Quit {name}")))?,
        ],
    )?;
    Menu::with_items(handle, &[&application, &edit, &window])
}
