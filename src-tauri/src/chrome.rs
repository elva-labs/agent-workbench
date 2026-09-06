//! The window's own chrome.
//!
//! The window has no title bar anywhere. On macOS the traffic lights sit over
//! the header of the leftmost pane, lowered to its middle; on Windows and
//! Linux the window is undecorated and the app draws minimize, maximize and
//! close at the end of the rightmost pane's header, where the platform puts
//! them.
//!
//! macOS lays the traffic lights out again on every resize, focus change and
//! theme change, at its own height, so where they sit is set at start and
//! set again after each of those, once AppKit has had its turn. The window
//! keeps its plain title bar: a toolbar would hold the buttons lower by
//! itself, but macOS 26 rounds a toolbar window's corners far more than
//! every other window's.

/// Where the close button's left edge goes, in points from the window's
/// left edge; the other two follow at AppKit's spacing.
#[cfg(target_os = "macos")]
const CONTROLS_X: f64 = 13.0;

/// Points between the window's top edge and the top of the buttons. With the
/// frame's 10px padding, the pane's border and a 32px header, this centres
/// them on the header's text.
#[cfg(target_os = "macos")]
const CONTROLS_Y: f64 = 21.0;

#[cfg(target_os = "macos")]
pub fn inset_window_controls(window: &tauri::WebviewWindow) {
    use tauri::WindowEvent;

    place_window_controls(window);
    let handle = window.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Resized(_)
                | WindowEvent::Focused(_)
                | WindowEvent::ScaleFactorChanged { .. }
                | WindowEvent::ThemeChanged(_)
        ) {
            // Queued rather than done here: AppKit's own layout for the same
            // event has to have run first, or it wins.
            let again = handle.clone();
            let _ = handle.run_on_main_thread(move || place_window_controls(&again));
        }
    });
}

/// Moves the three standard buttons, and grows the title bar view down to
/// hold them, the way tao's own inset does at creation.
#[cfg(target_os = "macos")]
fn place_window_controls(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    let Ok(ptr) = window.ns_window() else { return };
    // The pointer is the window's NSWindow, alive for as long as the window,
    // and this runs on the main thread, which AppKit insists on.
    let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    let Some(close) = ns_window.standardWindowButton(NSWindowButton::CloseButton) else {
        return;
    };
    let Some(miniaturize) = ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton)
    else {
        return;
    };
    let Some(zoom) = ns_window.standardWindowButton(NSWindowButton::ZoomButton) else {
        return;
    };
    // Two views up from a button is the title bar view, in every AppKit so
    // far; the buttons are its grandchildren.
    let Some(title_bar) = (unsafe { close.superview().and_then(|view| view.superview()) }) else {
        return;
    };

    let close_frame = close.frame();
    let bar_height = close_frame.size.height + CONTROLS_Y;
    let mut bar = title_bar.frame();
    bar.size.height = bar_height;
    bar.origin.y = ns_window.frame().size.height - bar_height;
    title_bar.setFrame(bar);

    let spacing = miniaturize.frame().origin.x - close_frame.origin.x;
    for (index, button) in [close, miniaturize, zoom].iter().enumerate() {
        let mut frame = button.frame();
        frame.origin.x = CONTROLS_X + index as f64 * spacing;
        button.setFrameOrigin(frame.origin);
    }
}

/// Windows and Linux: no decorations, so the top row is the app's. The
/// window keeps its resize borders and its shadow; only the bar goes.
#[cfg(not(target_os = "macos"))]
pub fn inset_window_controls(window: &tauri::WebviewWindow) {
    let _ = window.set_decorations(false);
}
