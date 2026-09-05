//! The native menu bar.
//!
//! One item of the app's own, Settings, under the app menu on macOS and
//! under File elsewhere, with the standard accelerator. The rest is what a
//! desktop app is expected to carry: an Edit menu, without which copy and
//! paste have no key equivalents in the webview on macOS, and a Window menu.
//! Choosing Settings tells the window, which opens its settings view.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{App, Emitter, Wry};

pub const OPEN_SETTINGS: &str = "open_settings";
const SETTINGS_ID: &str = "settings";

pub fn install(app: &App) -> tauri::Result<()> {
    let handle = app.handle();
    let settings = MenuItem::with_id(handle, SETTINGS_ID, "Settings…", true, Some("CmdOrCtrl+,"))?;

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

    let menu: Menu<Wry> = if cfg!(target_os = "macos") {
        let application = Submenu::with_items(
            handle,
            "Agent Workbench",
            true,
            &[
                &PredefinedMenuItem::about(handle, None, None)?,
                &PredefinedMenuItem::separator(handle)?,
                &settings,
                &PredefinedMenuItem::separator(handle)?,
                &PredefinedMenuItem::services(handle, None)?,
                &PredefinedMenuItem::separator(handle)?,
                &PredefinedMenuItem::hide(handle, None)?,
                &PredefinedMenuItem::hide_others(handle, None)?,
                &PredefinedMenuItem::show_all(handle, None)?,
                &PredefinedMenuItem::separator(handle)?,
                &PredefinedMenuItem::quit(handle, None)?,
            ],
        )?;
        Menu::with_items(handle, &[&application, &edit, &window])?
    } else {
        let file = Submenu::with_items(
            handle,
            "File",
            true,
            &[
                &settings,
                &PredefinedMenuItem::separator(handle)?,
                &PredefinedMenuItem::quit(handle, None)?,
            ],
        )?;
        Menu::with_items(handle, &[&file, &edit, &window])?
    };

    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == SETTINGS_ID {
            let _ = app.emit(OPEN_SETTINGS, ());
        }
    });
    Ok(())
}
