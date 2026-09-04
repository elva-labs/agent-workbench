//! The window's own chrome on macOS.
//!
//! The window has no title bar, and the traffic lights sit over the header
//! of the leftmost pane. Where they sit is macOS's decision, and the setting
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
    let Some(mtm) = MainThreadMarker::new() else { return };
    let Ok(ptr) = window.ns_window() else { return };
    // The pointer is the window's NSWindow, alive for as long as the window.
    let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    let toolbar = NSToolbar::initWithIdentifier(
        NSToolbar::alloc(mtm),
        &NSString::from_str("workbench-chrome"),
    );
    toolbar.setShowsBaselineSeparator(false);
    ns_window.setToolbar(Some(&toolbar));
    ns_window.setToolbarStyle(NSWindowToolbarStyle::Unified);
}

#[cfg(not(target_os = "macos"))]
pub fn inset_window_controls(_window: &tauri::WebviewWindow) {}
