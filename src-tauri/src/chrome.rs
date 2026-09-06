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
/// left edge: the frame's padding, the pane's border and the pane's own
/// padding, so the buttons start where the header's content does. The
/// other two follow at AppKit's spacing.
#[cfg(target_os = "macos")]
const CONTROLS_X: f64 = 23.0;

/// Points from the window's top edge to the middle of the buttons: the
/// frame's 10px padding, the pane's border and half a 32px header, so they
/// sit on the header's text.
#[cfg(target_os = "macos")]
const CONTROLS_CENTRE: f64 = 27.0;

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

/// Puts the three standard buttons where the header's text is. The title
/// bar views are made tall enough to hold them there first, and each button
/// is then placed by window coordinates, so how AppKit lays the title bar
/// out inside does not matter.
#[cfg(target_os = "macos")]
fn place_window_controls(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowButton};
    use objc2_foundation::NSPoint;

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
    // The buttons sit in the title bar view, which sits in its container, in
    // every AppKit so far.
    let Some(bar) = (unsafe { close.superview() }) else {
        return;
    };
    let Some(container) = (unsafe { bar.superview() }) else {
        return;
    };

    let window_height = ns_window.frame().size.height;
    let height = CONTROLS_CENTRE * 2.0;
    let mut outer = container.frame();
    outer.size.height = height;
    outer.origin.y = window_height - height;
    container.setFrame(outer);
    let mut inner = bar.frame();
    inner.origin.y = 0.0;
    inner.size.height = height;
    bar.setFrame(inner);

    let spacing = miniaturize.frame().origin.x - close.frame().origin.x;
    for (index, button) in [close, miniaturize, zoom].iter().enumerate() {
        let size = button.frame().size;
        let centre = bar.convertPoint_fromView(
            NSPoint::new(
                CONTROLS_X + size.width / 2.0 + index as f64 * spacing,
                window_height - CONTROLS_CENTRE,
            ),
            None,
        );
        button.setFrameOrigin(NSPoint::new(
            centre.x - size.width / 2.0,
            centre.y - size.height / 2.0,
        ));
    }
}

/// Windows and Linux: no decorations, so the top row is the app's. The
/// window keeps its resize borders and its shadow; only the bar goes.
#[cfg(not(target_os = "macos"))]
pub fn inset_window_controls(window: &tauri::WebviewWindow) {
    let _ = window.set_decorations(false);
}
