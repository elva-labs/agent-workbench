//! The window's own chrome.
//!
//! The window has no title bar anywhere. On macOS the traffic lights sit over
//! the header of the leftmost pane; on Windows and Linux the window is
//! undecorated and the app draws minimize, maximize and close at the end of
//! the rightmost pane's header, where the platform puts them.
//!
//! On macOS the traffic lights sit over the header of the leftmost pane. Where they sit is macOS's decision, and the setting
//! for moving them is applied once and undone by the next title bar layout.
//! What does hold is a toolbar: a window with a unified toolbar gets a taller
//! title bar, and AppKit centres the buttons in it on every layout. An empty,
//! transparent toolbar is therefore the way to lower the buttons for good.

#[cfg(target_os = "macos")]
pub fn inset_window_controls(window: &tauri::WebviewWindow) {
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSToolbar, NSWindow, NSWindowToolbarStyle};
    use objc2_foundation::NSString;

    // The setup hook runs on the main thread, which AppKit insists on.
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Ok(ptr) = window.ns_window() else { return };
    // The pointer is the window's NSWindow, alive for as long as the window.
    let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    let toolbar = NSToolbar::initWithIdentifier(
        NSToolbar::alloc(mtm),
        &NSString::from_str("workbench-chrome"),
    );
    // WORKBENCH_CHROME picks the toolbar for a side-by-side look on a Mac:
    // `none` leaves the buttons where AppKit puts them, `compact` is the
    // shorter unified toolbar, anything else the full one. macOS rounds a
    // window's corners by its toolbar style, so this is where that is set.
    let style = std::env::var("WORKBENCH_CHROME").unwrap_or_default();
    if style == "none" {
        return;
    }
    // No separator to hide: the title bar is transparent and draws nothing.
    ns_window.setToolbar(Some(&toolbar));
    ns_window.setToolbarStyle(if style == "compact" {
        NSWindowToolbarStyle::UnifiedCompact
    } else {
        NSWindowToolbarStyle::Unified
    });
}

/// Windows and Linux: no decorations, so the top row is the app's. The
/// window keeps its resize borders and its shadow; only the bar goes.
#[cfg(not(target_os = "macos"))]
pub fn inset_window_controls(window: &tauri::WebviewWindow) {
    let _ = window.set_decorations(false);
}
