//! Takes the app's own key chords back from a browser tab's page.
//!
//! wry's child webview never offers a Cmd chord to the main webview:
//! `performKeyEquivalent:` is asked of the front webview first, a WKWebView
//! answers NO without forwarding it further, and the chord falls straight
//! through to the page's own JavaScript. A local `NSEvent` monitor on the
//! main window sees every key before that happens. When the keyboard sits
//! in a tab's webview and the key is one the app claims, Escape or a Cmd
//! chord from the list the frontend last handed over, the same keydown is
//! fired on the main page's `window`, the keyboard is handed back to the
//! app, and the native event is swallowed so the page never sees it. Every
//! other key, Cmd+C and Cmd+V among them, passes through untouched.
//!
//! A click landing in a tab's webview cannot be told apart from any other
//! click until after AppKit has already changed first responder, so the
//! monitor also watches for a `leftMouseDown` there and tells the frontend
//! a browser tab was focused; that event passes through unharmed either way.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::State;

/// A key chord the frontend has bound to an app action. The platform
/// modifier, Cmd, is implied; only Shift and Alt can join it.
#[derive(Debug, Clone, Deserialize)]
pub struct Chord {
    pub key: String,
    pub shift: bool,
    pub alt: bool,
}

/// The chords the app currently claims, sent over from the frontend's
/// keymap on load and whenever it changes.
#[derive(Default)]
pub struct Keys(Mutex<Vec<Chord>>);

impl Keys {
    fn matches(&self, key: &str, shift: bool, alt: bool) -> bool {
        self.0
            .lock()
            .unwrap()
            .iter()
            .any(|chord| chord.key == key && chord.shift == shift && chord.alt == alt)
    }
}

#[tauri::command]
pub fn browser_keys(keys: State<'_, std::sync::Arc<Keys>>, chords: Vec<Chord>) {
    *keys.0.lock().unwrap() = chords;
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use objc2::rc::Retained;
    use objc2_app_kit::{
        NSEvent, NSEventMask, NSEventModifierFlags, NSEventType, NSView, NSWindow,
    };
    use tauri::{App, AppHandle, Emitter, Manager, Webview, Window, Wry};

    use super::Keys;

    /// Installs the monitor once the main window exists. A window or webview
    /// missing at startup, or no managed [`Keys`], leaves the app exactly as
    /// it would run with no monitor at all: every key reaches the page.
    pub fn install(app: &App) {
        let Some(window) = app.get_window("main") else {
            return;
        };
        let Some(main_webview) = app.get_webview("main") else {
            return;
        };
        let Some(keys) = app.try_state::<Arc<Keys>>() else {
            return;
        };
        let keys = Arc::clone(&keys);

        let main_ptr = main_webview_ptr(&main_webview);
        let app_handle = app.handle().clone();

        let block = block2::RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            let raw = event.as_ptr();
            let event: &NSEvent = unsafe { event.as_ref() };
            let kind = event.r#type();
            if kind == NSEventType::KeyDown {
                handle_key(&window, &main_webview, &keys, event, main_ptr, raw)
            } else if kind == NSEventType::LeftMouseDown {
                handle_click(&window, &app_handle, event, main_ptr);
                raw
            } else {
                raw
            }
        });

        let mask = NSEventMask::KeyDown | NSEventMask::LeftMouseDown;
        let monitor =
            unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &block) };
        // AppKit runs the handler only while this token lives, and the
        // monitor is meant to outlive the app, so it is never dropped.
        std::mem::forget(monitor);
    }

    /// The main webview's own platform view, read once so a tab's webview,
    /// the same kind of object, can be told apart from it later. Runs
    /// synchronously: `with_webview` dispatches inline when called, as here,
    /// from the main thread already.
    fn main_webview_ptr(main_webview: &Webview<Wry>) -> usize {
        let store = Arc::new(AtomicUsize::new(0));
        let write = Arc::clone(&store);
        let _ = main_webview.with_webview(move |platform| {
            write.store(platform.inner() as usize, Ordering::SeqCst);
        });
        store.load(Ordering::SeqCst)
    }

    /// Forwards `event` to the main page and swallows it when the keyboard
    /// sits in a tab's webview and the key is one the app claims; passes it
    /// through untouched otherwise.
    fn handle_key(
        window: &Window,
        main_webview: &Webview<Wry>,
        keys: &Keys,
        event: &NSEvent,
        main_ptr: usize,
        raw: *mut NSEvent,
    ) -> *mut NSEvent {
        let Ok(ns_window) = native_window(window) else {
            return raw;
        };
        if !first_responder_in_tab(ns_window, main_ptr) {
            return raw;
        }

        let flags = relevant_flags(event.modifierFlags());
        let is_escape = event.keyCode() == 53 && flags.is_empty();
        let cmd = flags.contains(NSEventModifierFlags::Command)
            && !flags.contains(NSEventModifierFlags::Control);

        let claimed = if is_escape {
            Some("Escape".to_string())
        } else if cmd {
            key_name(event).filter(|name| {
                keys.matches(
                    name,
                    flags.contains(NSEventModifierFlags::Shift),
                    flags.contains(NSEventModifierFlags::Option),
                )
            })
        } else {
            None
        };

        let Some(key) = claimed else {
            return raw;
        };

        let script = format!(
            "window.dispatchEvent(new KeyboardEvent('keydown', {{ key: {key}, metaKey: {meta}, shiftKey: {shift}, altKey: {alt}, bubbles: true, cancelable: true }}))",
            key = serde_json::to_string(&key).unwrap_or_else(|_| "\"\"".to_string()),
            meta = cmd,
            shift = flags.contains(NSEventModifierFlags::Shift),
            alt = flags.contains(NSEventModifierFlags::Option),
        );
        let _ = main_webview.eval(&script);
        let _ = main_webview.set_focus();
        std::ptr::null_mut()
    }

    /// Tells the frontend a browser tab took the keyboard by pointer down,
    /// so the changes pane can be marked focused while the page holds it.
    fn handle_click(window: &Window, app: &AppHandle, event: &NSEvent, main_ptr: usize) {
        let Ok(ns_window) = native_window(window) else {
            return;
        };
        let Some(content) = ns_window.contentView() else {
            return;
        };
        let Some(hit) = content.hitTest(event.locationInWindow()) else {
            return;
        };
        if is_tab_webview(hit, main_ptr) {
            let _ = app.emit_to("main", "browser_focused", ());
        }
    }

    fn native_window(window: &Window) -> Result<&NSWindow, String> {
        let ptr = window.ns_window().map_err(|e| e.to_string())?;
        Ok(unsafe { &*(ptr as *const NSWindow) })
    }

    /// Whether the window's first responder sits inside a tab's webview: a
    /// view whose ancestor, the first responder itself included, is a
    /// `WKWebView` other than the main one.
    fn first_responder_in_tab(window: &NSWindow, main_ptr: usize) -> bool {
        let Some(responder) = window.firstResponder() else {
            return false;
        };
        let Ok(view) = responder.downcast::<NSView>() else {
            return false;
        };
        is_tab_webview(view, main_ptr)
    }

    /// Whether `view`, or an ancestor of it, is a `WKWebView` that is not the
    /// main webview's own: the class name reads the same way the placement
    /// probe reads a window's native views.
    fn is_tab_webview(mut view: Retained<NSView>, main_ptr: usize) -> bool {
        loop {
            let name = view.class().name().to_string_lossy().into_owned();
            if name.contains("WebView") {
                return Retained::as_ptr(&view) as usize != main_ptr;
            }
            match unsafe { view.superview() } {
                Some(next) => view = next,
                None => return false,
            }
        }
    }

    /// The modifier flags that decide a chord, with the rest, caps lock and
    /// function keys among them, masked away.
    fn relevant_flags(flags: NSEventModifierFlags) -> NSEventModifierFlags {
        flags.intersection(
            NSEventModifierFlags::Shift
                | NSEventModifierFlags::Control
                | NSEventModifierFlags::Option
                | NSEventModifierFlags::Command,
        )
    }

    /// The name a chord in the frontend's table would carry for this event:
    /// the arrows, Escape, Enter, Tab and Space by key code, since their
    /// characters are not meaningful text, and a single character otherwise,
    /// lower-cased so Shift does not spell a second chord. None for a key,
    /// a function key among them, with no name a chord could hold.
    fn key_name(event: &NSEvent) -> Option<String> {
        if let Some(name) = special_key(event.keyCode()) {
            return Some(name.to_string());
        }
        let text = event.charactersIgnoringModifiers()?.to_string();
        let mut chars = text.chars();
        let first = chars.next()?;
        if chars.next().is_some() {
            return None;
        }
        Some(first.to_lowercase().to_string())
    }

    fn special_key(code: u16) -> Option<&'static str> {
        match code {
            123 => Some("ArrowLeft"),
            124 => Some("ArrowRight"),
            125 => Some("ArrowDown"),
            126 => Some("ArrowUp"),
            53 => Some("Escape"),
            36 => Some("Enter"),
            48 => Some("Tab"),
            49 => Some(" "),
            _ => None,
        }
    }
}

#[cfg(target_os = "macos")]
pub fn install(app: &tauri::App) {
    mac::install(app);
}

/// The local event monitor is AppKit's own; elsewhere there is nothing to
/// install.
#[cfg(not(target_os = "macos"))]
pub fn install(_app: &tauri::App) {}
