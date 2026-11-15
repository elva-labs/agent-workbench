//! Leaving with unsaved edits.
//!
//! While the editor holds edits not yet written, the window's close (its
//! button, Close Window, the controls the app draws) and the app's quit
//! (Quit in the menus, Cmd+Q) are held back, and the window is asked to put
//! the question over the editor. The window answers at once that the
//! question is up; without that answer soon after asking, the close or the
//! quit goes through, so a page that cannot answer never keeps the window
//! open. The user's answer then closes the window or quits the app, or
//! leaves both as they are.
//!
//! The system's own ways of ending the app, logging out or Quit in the
//! Dock's menu, end it without asking: the app hears of those only once it
//! is already going.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, Window, WindowEvent};

pub const LEAVE_REQUESTED: &str = "leave_requested";

/// How long the window has to say the question is up before the close or
/// the quit goes through without it.
const HEARD_WITHIN: Duration = Duration::from_secs(3);

/// What the window last said about unsaved edits, and where the questions
/// stand.
#[derive(Default)]
pub struct Leaving {
    unsaved: AtomicBool,
    /// Set once the user said to go anyway, or the window did not answer:
    /// the close or the quit that follows goes through.
    allowed: AtomicBool,
    /// Counts the questions asked.
    asked: AtomicU64,
    /// The last question the window said is up.
    heard: AtomicU64,
}

impl Leaving {
    /// Whether a close or a quit is held back to ask first.
    fn holds(&self) -> bool {
        self.unsaved.load(Ordering::SeqCst) && !self.allowed.load(Ordering::SeqCst)
    }

    /// A new question: its number.
    fn ask(&self) -> u64 {
        self.asked.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Whether the window said question `generation`, or a later one, is up.
    fn heard(&self, generation: u64) -> bool {
        self.heard.load(Ordering::SeqCst) >= generation
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Window,
    Quit,
}

#[derive(Debug, Clone, Serialize)]
struct Ask {
    kind: Kind,
    generation: u64,
}

/// The main window's close, held back while anything is unsaved.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.label() != "main" {
        return;
    }
    let app = window.app_handle();
    let Some(leaving) = app.try_state::<Arc<Leaving>>() else {
        return;
    };
    if leaving.holds() {
        api.prevent_close();
        ask(app, &leaving, Kind::Window);
    }
}

/// Quit, from a menu: asks first while anything is unsaved.
pub fn quit<R: Runtime>(app: &AppHandle<R>) {
    let leaving = Arc::clone(&app.state::<Arc<Leaving>>());
    if leaving.holds() {
        ask(app, &leaving, Kind::Quit);
    } else {
        app.exit(0);
    }
}

/// Asks the window, and goes anyway if it does not say the question is up
/// in time.
fn ask<R: Runtime>(app: &AppHandle<R>, leaving: &Arc<Leaving>, kind: Kind) {
    let generation = leaving.ask();
    if app.emit(LEAVE_REQUESTED, Ask { kind, generation }).is_err() {
        go(app, leaving, kind);
        return;
    }
    let app = app.clone();
    let leaving = Arc::clone(leaving);
    std::thread::spawn(move || {
        std::thread::sleep(HEARD_WITHIN);
        if !leaving.heard(generation) {
            go(&app, &leaving, kind);
        }
    });
}

/// Closes the window or quits the app, past the question.
fn go<R: Runtime>(app: &AppHandle<R>, leaving: &Leaving, kind: Kind) {
    leaving.allowed.store(true, Ordering::SeqCst);
    match kind {
        Kind::Window => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
        }
        Kind::Quit => app.exit(0),
    }
}

/// Whether the editor holds unsaved edits, as the window says each time it
/// changes.
#[tauri::command]
pub fn leave_unsaved(leaving: State<'_, Arc<Leaving>>, unsaved: bool) {
    leaving.unsaved.store(unsaved, Ordering::SeqCst);
}

/// The question is up.
#[tauri::command]
pub fn leave_heard(leaving: State<'_, Arc<Leaving>>, generation: u64) {
    leaving.heard.fetch_max(generation, Ordering::SeqCst);
}

/// The user's answer: close the window, or quit, after all.
#[tauri::command]
pub fn leave_confirmed(app: AppHandle, leaving: State<'_, Arc<Leaving>>, kind: Kind) {
    go(&app, &leaving, kind);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_only_while_something_is_unsaved_and_nothing_allowed_it() {
        let leaving = Leaving::default();
        assert!(!leaving.holds());
        leaving.unsaved.store(true, Ordering::SeqCst);
        assert!(leaving.holds());
        leaving.allowed.store(true, Ordering::SeqCst);
        assert!(!leaving.holds());
    }

    #[test]
    fn hears_a_question_and_every_one_before_it() {
        let leaving = Leaving::default();
        let first = leaving.ask();
        let second = leaving.ask();
        assert!(!leaving.heard(first));
        leaving.heard.fetch_max(second, Ordering::SeqCst);
        assert!(leaving.heard(first));
        assert!(leaving.heard(second));
        assert!(!leaving.heard(leaving.ask()));
    }

    #[test]
    fn names_the_kinds_as_the_window_does() {
        assert_eq!(serde_json::to_string(&Kind::Window).unwrap(), "\"window\"");
        assert_eq!(
            serde_json::from_str::<Kind>("\"quit\"").unwrap(),
            Kind::Quit
        );
    }
}
