//! The window's own chrome.
//!
//! The window has no title bar anywhere. On macOS the traffic lights sit over
//! the header of the leftmost pane, lowered to its middle; on Windows and
//! Linux the window is undecorated and the app draws minimize, maximize and
//! close at the end of the rightmost pane's header, where the platform puts
//! them.
//!
//! macOS lays the traffic lights out again whenever it likes, at its own
//! height, so the app listens for the buttons' frames changing and puts
//! them back within the same layout pass. The window keeps its plain title
//! bar: a toolbar would hold the buttons lower by itself, but macOS 26
//! rounds a toolbar window's corners far more than every other window's.

/// Where the close button's left edge goes, in points from the window's
/// left edge: past the frame's padding and the pane's border, with the same
/// gap to the border as the buttons have to the header's top and bottom.
/// The other two follow at AppKit's spacing.
#[cfg(target_os = "macos")]
const CONTROLS_X: f64 = 18.0;

/// Points from the window's top edge to the middle of the buttons: the
/// frame's 10px padding, the pane's border and half a 32px header, so they
/// sit on the header's text.
#[cfg(target_os = "macos")]
const CONTROLS_CENTRE: f64 = 27.0;

/// Points between one button and the next, which is AppKit's own spacing.
#[cfg(target_os = "macos")]
const CONTROLS_GAP: f64 = 8.0;

#[cfg(target_os = "macos")]
pub fn inset_window_controls(window: &tauri::WebviewWindow) {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSViewFrameDidChangeNotification, NSWindow, NSWindowButton};
    use objc2_foundation::{NSNotification, NSNotificationCenter};
    use std::ptr::NonNull;

    place_window_controls(window);

    // AppKit lays the title bar out again on its own schedule: when the
    // window shows, on a resize, on a focus change. Each time it moves a
    // button, the button's frame change is heard here and all three are put
    // back, so they never stay anywhere else.
    let Ok(ptr) = window.ns_window() else { return };
    let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    let centre = NSNotificationCenter::defaultCenter();
    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        let Some(button) = ns_window.standardWindowButton(kind) else {
            continue;
        };
        button.setPostsFrameChangedNotifications(true);
        let again = window.clone();
        let block = block2::RcBlock::new(move |_: NonNull<NSNotification>| {
            // The button whose move this is cannot be moved from inside it;
            // the other two can. It is placed on the next turn of the main
            // loop, once its own move has finished.
            place_window_controls(&again);
            let later = again.clone();
            let _ = again.run_on_main_thread(move || place_window_controls(&later));
        });
        let object: &AnyObject = &button;
        // Delivered on the main thread, where the frames change. The
        // observation lasts as long as the window, which is the app.
        let token = unsafe {
            centre.addObserverForName_object_queue_usingBlock(
                Some(NSViewFrameDidChangeNotification),
                Some(object),
                None,
                &block,
            )
        };
        std::mem::forget(token);
    }
}

/// Puts the three standard buttons where the header's text is. The title
/// bar views are made tall enough to hold them there first, and each button
/// is then placed by window coordinates, so how AppKit lays the title bar
/// out inside does not matter.
#[cfg(target_os = "macos")]
fn place_window_controls(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowButton};
    use objc2_foundation::NSPoint;
    use std::sync::atomic::{AtomicBool, Ordering};

    // Placing the buttons changes their frames, which is heard as a change
    // to put back: once through is enough.
    static PLACING: AtomicBool = AtomicBool::new(false);
    if PLACING.swap(true, Ordering::SeqCst) {
        return;
    }
    let _done = Reset(&PLACING);
    struct Reset<'a>(&'a AtomicBool);
    impl Drop for Reset<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }

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
    if outer.size.height != height || outer.origin.y != window_height - height {
        outer.size.height = height;
        outer.origin.y = window_height - height;
        container.setFrame(outer);
    }
    let mut inner = bar.frame();
    if inner.size.height != height || inner.origin.y != 0.0 {
        inner.origin.y = 0.0;
        inner.size.height = height;
        bar.setFrame(inner);
    }

    // The buttons are placed from constants alone, never from where the
    // others are: AppKit moves them one at a time, and this runs as each
    // one moves. Their frames differ in size, and what lines up their
    // circles is a shared origin row, the way AppKit lays them out itself,
    // so the close button's size sets the row and the pitch for all three.
    // Each button converts the point into its own superview: the three do
    // not all sit in the same view.
    let size = close.frame().size;
    for (index, button) in [close, miniaturize, zoom].iter().enumerate() {
        let Some(parent) = (unsafe { button.superview() }) else {
            continue;
        };
        let centre = parent.convertPoint_fromView(
            NSPoint::new(
                CONTROLS_X + size.width / 2.0 + index as f64 * (size.width + CONTROLS_GAP),
                window_height - CONTROLS_CENTRE,
            ),
            None,
        );
        let origin = NSPoint::new(centre.x - size.width / 2.0, centre.y - size.height / 2.0);
        let now = button.frame().origin;
        if (now.x - origin.x).abs() > 0.5 || (now.y - origin.y).abs() > 0.5 {
            button.setFrameOrigin(origin);
        }
        if std::env::var_os("WORKBENCH_CHROME_DEBUG").is_some() {
            let frame = button.frame();
            let back = parent.convertPoint_toView(frame.origin, None);
            eprintln!(
                "button {index}: parent {} flipped={} frame=({:.1},{:.1} {:.1}x{:.1}) wanted=({:.1},{:.1}) in window=({:.1},{:.1}) height={window_height:.1}",
                parent.class().name().to_string_lossy(),
                parent.isFlipped(),
                frame.origin.x,
                frame.origin.y,
                frame.size.width,
                frame.size.height,
                origin.x,
                origin.y,
                back.x,
                back.y
            );
        }
    }
}

/// Windows and Linux: no decorations, so the top row is the app's. The
/// window keeps its resize borders and its shadow; only the bar goes.
#[cfg(not(target_os = "macos"))]
pub fn inset_window_controls(window: &tauri::WebviewWindow) {
    let _ = window.set_decorations(false);
}
