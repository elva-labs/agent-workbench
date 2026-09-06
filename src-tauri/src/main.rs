// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ssh runs the app again as its askpass program while a remote is
    // being set up: print the password it was given and stop.
    if std::env::args().any(|arg| arg == agent_workbench_lib::ASKPASS_FLAG) {
        print!("{}", agent_workbench_lib::askpass());
        return;
    }
    agent_workbench_lib::run()
}
