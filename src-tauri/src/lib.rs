//! Agent Workbench core.
//!
//! Rust owns state, the webview owns pixels. Every PTY, git query, filesystem
//! watch and session index lives here; the frontend renders and dispatches.
//! Phase 0 is the window and nothing else.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
