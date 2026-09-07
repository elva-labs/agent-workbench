//! The window's own chrome.
//!
//! The window has no title bar anywhere. On macOS the traffic lights sit over
//! the header of the leftmost pane, lowered to its middle; on Windows and
//! Linux the window is undecorated and the app draws minimize, maximize and
//! close at the end of the rightmost pane's header, where the platform puts
//! them.
//!
//! macOS lays the traffic lights out again whenever it likes, at its own
//! height: when the window shows, on every frame of a resize, on a focus
//! change. The app puts them back before any of that is drawn. A view of
//! its own sits last in the window's view tree, so its layout runs after
//! the title bar's in the same pass, and that is where the buttons are
//! placed; the buttons' own frame changes ask for that pass. The window
//! keeps its plain title bar: a toolbar would hold the buttons lower by
//! itself, but macOS 26 rounds a toolbar window's corners far more than
//! every other window's.

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
objc2::define_class!(
    /// A view that draws nothing and places the traffic lights when it is
    /// laid out. It is the last subview of the window's outermost view, so
    /// every layout pass reaches it after the title bar, once AppKit has
    /// moved the buttons and before anything is drawn.
    #[unsafe(super(objc2_app_kit::NSView))]
    #[thread_kind = objc2::MainThreadOnly]
    #[name = "WorkbenchControlsPlacer"]
    struct Placer;

    impl Placer {
        #[unsafe(method(layout))]
        fn layout(&self) {
            unsafe {
                let _: () = objc2::msg_send![super(self), layout];
            }
            if let Some(window) = self.window() {
                place_controls(&window);
            }
        }
    }
);

#[cfg(target_os = "macos")]
pub fn inset_window_controls(window: &tauri::WebviewWindow) {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSView, NSViewFrameDidChangeNotification, NSWindow, NSWindowButton};
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSOperationQueue, NSRect};
    use std::ptr::NonNull;

    let Ok(ptr) = window.ns_window() else { return };
    let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    place_controls(ns_window);

    // The placer goes at the end of the outermost view, the one the title
    // bar and the content both sit in. Setup runs on the main thread, which
    // is the only one a view may be made on.
    let placer = MainThreadMarker::new().and_then(|mtm| {
        let root = ns_window.contentView()?;
        let root = unsafe { root.superview() }?;
        let placer: Retained<Placer> = unsafe {
            objc2::msg_send![super(Placer::alloc(mtm).set_ivars(())), initWithFrame: NSRect::ZERO]
        };
        let view: &NSView = &placer;
        root.addSubview(view);
        placer.setNeedsLayout(true);
        Some(placer)
    });

    // Each time AppKit moves a button, the button's frame change is heard
    // here: the other two are put back at once, the placer is asked for a
    // layout, and the moved one is placed again on the next turn of the
    // main loop in case no layout pass follows.
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
        let placer = placer.clone();
        let block = block2::RcBlock::new(move |_: NonNull<NSNotification>| {
            // The button whose move this is cannot be moved from inside it;
            // the other two can.
            place_window_controls(&again);
            if let Some(placer) = &placer {
                placer.setNeedsLayout(true);
            }
            let later = again.clone();
            let then = block2::RcBlock::new(move || place_window_controls(&later));
            // Queued on the main queue: a task handed to Tauri from the main
            // thread runs at once, which would be inside the move again.
            unsafe { NSOperationQueue::mainQueue().addOperationWithBlock(&then) };
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
    let Ok(ptr) = window.ns_window() else { return };
    // The pointer is the window's NSWindow, alive for as long as the window,
    // and this runs on the main thread, which AppKit insists on.
    let ns_window: &objc2_app_kit::NSWindow = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
    place_controls(ns_window);
}

#[cfg(target_os = "macos")]
fn place_controls(ns_window: &objc2_app_kit::NSWindow) {
    use objc2_app_kit::NSWindowButton;
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
    }
}

/// Windows and Linux: no decorations, so the top row is the app's. The
/// window keeps its resize borders and its shadow; only the bar goes.
#[cfg(not(target_os = "macos"))]
pub fn inset_window_controls(window: &tauri::WebviewWindow) {
    let _ = window.set_decorations(false);
}
