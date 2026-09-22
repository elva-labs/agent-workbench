//! Folders the app is asked to open from outside its window.
//!
//! They come three ways: named on the command line the app starts with;
//! handed over on Linux and Windows by a second launch, which then exits;
//! and on macOS sent by the system, which is what `open -a` and the `awb`
//! command do, to a running app and a starting one alike. Each lands on one
//! list and the window is told. The window takes the list when told, and
//! once when it has loaded, since the first ones arrive before it has.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

pub const OPEN_REQUESTED: &str = "open_requested";

/// The folders asked for and not yet taken by the window.
#[derive(Default)]
pub struct Launches(Mutex<Vec<String>>);

/// The folders a command line names, a relative one taken from where the
/// command ran. The first argument is the program itself; flags, files and
/// paths that are not there are passed over.
pub fn folders(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(|arg| cwd.join(arg).components().collect::<PathBuf>())
        .filter(|path| path.is_dir())
        .collect()
}

/// Puts folders on the list and tells the window.
pub fn request(app: &AppHandle, folders: Vec<PathBuf>) {
    let paths: Vec<String> = folders
        .into_iter()
        .filter_map(|path| path.into_os_string().into_string().ok())
        .collect();
    if paths.is_empty() {
        return;
    }
    app.state::<Launches>().0.lock().unwrap().extend(paths);
    let _ = app.emit(OPEN_REQUESTED, ());
}

/// The folders asked for since the window last took them, in order.
#[tauri::command]
pub fn take_opened(launches: State<'_, Launches>) -> Vec<String> {
    std::mem::take(&mut *launches.0.lock().unwrap())
}

/// The app's run loop events. On macOS the folders `open` names arrive as
/// one, whether the app was running or is starting for them.
pub fn on_event(app: &AppHandle, event: RunEvent) {
    #[cfg(target_os = "macos")]
    if let RunEvent::Opened { urls } = event {
        let folders = urls
            .iter()
            .filter_map(|url| url.to_file_path().ok())
            .filter(|path| path.is_dir())
            .collect();
        request(app, folders);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

/// Makes a second launch on Linux and Windows hand its folders to the
/// running app, which comes to the front, and exit.
#[cfg(any(target_os = "linux", windows))]
pub fn single_instance() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_single_instance::init(|app, args, cwd| {
        request(app, folders(args, Path::new(&cwd)));
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(name);
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn takes_the_folders_a_command_line_names() {
        let dir = temp("workbench-launch-folders");
        std::fs::create_dir(dir.join("project")).unwrap();
        std::fs::write(dir.join("notes.txt"), "").unwrap();
        let elsewhere = temp("workbench-launch-elsewhere");
        let named = args(&[
            "agent-workbench",
            "project",
            "notes.txt",
            "--verbose",
            "missing",
            elsewhere.to_str().unwrap(),
        ]);
        assert_eq!(folders(named, &dir), vec![dir.join("project"), elsewhere]);
    }

    #[test]
    fn a_dot_is_where_the_command_ran() {
        let dir = temp("workbench-launch-dot");
        assert_eq!(folders(args(&["agent-workbench", "."]), &dir), vec![dir]);
    }

    #[test]
    fn the_program_is_not_a_folder_to_open() {
        let dir = temp("workbench-launch-program");
        assert!(folders(args(&[dir.to_str().unwrap()]), &dir).is_empty());
    }
}
