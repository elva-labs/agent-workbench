//! A tab's screenshot, taken whether or not its view is on show, without
//! the tab coming forward. What is done to the view, and in what order, is
//! [`workbench_core::browser::capture`]'s; this is the part that waits on
//! the native snapshot and makes sure the view is back in its place before
//! the browser's views are let go, on every way out.

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use workbench_core::browser::capture::{Pending, Plan};

/// How long each part of a capture may take before it is given up on.
#[derive(Debug, Clone, Copy)]
pub struct Waits {
    /// For a tab taken where it is. Nothing is out of place meanwhile, so
    /// nothing else waits on it.
    pub in_place: Duration,
    /// For a revealed tab, from the start of the capture to its image.
    /// Opening, switching, placing and closing tabs wait on it.
    pub revealed: Duration,
    /// For the view to be put back once the snapshot is given up on.
    pub put_back: Duration,
}

/// The waits a capture runs with. A capture takes tens of milliseconds and
/// the page's own wait to paint gives up after one second, so a revealed
/// tab that has not answered within three is stuck.
pub const WAITS: Waits = Waits {
    in_place: Duration::from_secs(10),
    revealed: Duration::from_secs(3),
    put_back: Duration::from_secs(1),
};

/// The native side of a capture: a tab's view, on the thread that may
/// touch it.
pub trait Native {
    /// Readies the view through [`workbench_core::browser::capture::begin`],
    /// recording what changed on `pending`, sends how the view is taken, or
    /// why it cannot be, to `began`, and starts its snapshot. Once the
    /// snapshot answers, the view is put back through `pending` and the
    /// image, or why there is none, goes to `answer`. A view that cannot be
    /// captured is left as it is.
    fn start(
        &self,
        pending: Arc<Pending>,
        size: Option<(f64, f64)>,
        began: Sender<Result<Plan, String>>,
        answer: Sender<Result<Vec<u8>, String>>,
    ) -> Result<(), String>;

    /// Puts the view back through `pending`, if the capture still holds it,
    /// and signals `done` once it has.
    fn end(&self, pending: Arc<Pending>, done: Sender<()>) -> Result<(), String>;
}

/// Takes `native`'s snapshot at `size` while `views` is held. A tab taken
/// where it is lets `views` go as soon as that is known; a revealed one
/// holds it until the view is back in its place, after the snapshot
/// answers or after `waits.revealed` runs out and the view has been put
/// back without it, waiting at most `waits.put_back` for that.
pub async fn take<G>(
    views: G,
    native: impl Native,
    size: Option<(f64, f64)>,
    waits: Waits,
) -> Result<Vec<u8>, String> {
    let started = Instant::now();
    let pending = Arc::new(Pending::default());
    let (began, planned) = mpsc::channel();
    let (answer, answered) = mpsc::channel();
    native.start(Arc::clone(&pending), size, began, answer)?;
    let left = |wait: Duration| wait.saturating_sub(started.elapsed());

    let result = match blocking_recv(planned, waits.revealed).await {
        Ok(Err(refusal)) => {
            drop(views);
            return Err(refusal);
        }
        Ok(Ok(Plan::InPlace)) => {
            drop(views);
            return outcome(blocking_recv(answered, left(waits.in_place)).await);
        }
        Ok(Ok(Plan::Reveal(_))) => outcome(blocking_recv(answered, left(waits.revealed)).await),
        Err(error) => outcome(Err(error)),
    };
    // A snapshot that answered has put the view back already; one that did
    // not is put back here, and waited for, before the views are let go.
    let (done, ended) = mpsc::channel();
    if native.end(pending, done).is_ok() {
        let _ = blocking_recv(ended, waits.put_back).await;
    }
    drop(views);
    result
}

/// What a wait on the snapshot comes to.
fn outcome(received: Result<Result<Vec<u8>, String>, RecvTimeoutError>) -> Result<Vec<u8>, String> {
    match received {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err("timed out taking the screenshot".to_string()),
        Err(RecvTimeoutError::Disconnected) => Err("the tab's view went away".to_string()),
    }
}

/// Waits on `rx` for up to `wait` off the async runtime's own threads.
async fn blocking_recv<T: Send + 'static>(
    rx: mpsc::Receiver<T>,
    wait: Duration,
) -> Result<T, RecvTimeoutError> {
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(wait))
        .await
        .unwrap_or(Err(RecvTimeoutError::Disconnected))
}

#[cfg(target_os = "macos")]
pub use native::{display_asleep, paint_while_covered, Tab};

#[cfg(target_os = "macos")]
mod native {
    use std::sync::mpsc::Sender;
    use std::sync::Arc;

    use objc2::rc::Retained;
    use objc2::{msg_send, sel, Message};
    use objc2_app_kit::NSWindow;
    use objc2_foundation::{NSNumber, NSPoint, NSRect, NSSize, NSString};
    use objc2_web_kit::{WKContentWorld, WKSnapshotConfiguration, WKWebView};
    use workbench_core::browser::capture::{
        begin, CaptureView, Frame, Pending, Plan, ViewState, WindowState,
    };

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGDisplayIsAsleep(display: u32) -> u32;
        fn CGMainDisplayID() -> u32;
    }

    /// The state of the window `view` is in, and of the display it is on.
    /// A view in no window counts as one in a window that is hidden.
    fn window_state(view: &WKWebView) -> WindowState {
        let Some(window) = view.window() else {
            return WindowState {
                visible: false,
                ..WindowState::ON_SHOW
            };
        };
        WindowState {
            visible: window.isVisible(),
            minimised: window.isMiniaturized(),
            display_asleep: display_asleep(&window),
        }
    }

    /// Whether the display `window` is on is asleep.
    pub fn display_asleep(window: &NSWindow) -> bool {
        unsafe { CGDisplayIsAsleep(display_of(window)) != 0 }
    }

    /// The display `window` is on, or the main display when the system
    /// places it on none.
    fn display_of(window: &NSWindow) -> u32 {
        window
            .screen()
            .and_then(|screen| {
                screen
                    .deviceDescription()
                    .objectForKey(&NSString::from_str("NSScreenNumber"))
            })
            .and_then(|number| number.downcast::<NSNumber>().ok())
            .map(|number| number.unsignedIntValue())
            .unwrap_or_else(|| unsafe { CGMainDisplayID() })
    }

    /// A tab's `WKWebView`, as a capture works on it.
    struct View<'a>(&'a WKWebView);

    impl View<'_> {
        /// Whether this WebKit has the switch for window occlusion
        /// detection. It is WebKit's own private API, reached by message
        /// send, so it is looked for every time rather than assumed.
        fn has_occlusion_switch(&self) -> bool {
            let view = self.0;
            unsafe {
                msg_send![view, respondsToSelector: sel!(_setWindowOcclusionDetectionEnabled:)]
            }
        }

        /// Turns the system's window occlusion detection on or off for the
        /// view, where this WebKit has the switch.
        fn set_occlusion_detection(&self, enabled: bool) {
            if self.has_occlusion_switch() {
                let view = self.0;
                let _: () =
                    unsafe { msg_send![view, _setWindowOcclusionDetectionEnabled: enabled] };
            }
        }
    }

    impl CaptureView for View<'_> {
        fn state(&self) -> ViewState {
            let frame = self.0.frame();
            ViewState {
                hidden: self.0.isHidden(),
                frame: Frame {
                    x: frame.origin.x,
                    y: frame.origin.y,
                    width: frame.size.width,
                    height: frame.size.height,
                },
                occlusion_switch: self.has_occlusion_switch(),
            }
        }

        fn set_frame(&self, frame: Frame) {
            self.0.setFrame(NSRect::new(
                NSPoint::new(frame.x, frame.y),
                NSSize::new(frame.width, frame.height),
            ));
        }

        fn set_hidden(&self, hidden: bool) {
            self.0.setHidden(hidden);
        }
    }

    /// Turns window occlusion detection off for `webview`, where this WebKit
    /// has the switch: the tab on show then keeps painting while another
    /// app's window covers the workbench's, so its screenshot is current.
    /// A hidden view paints nothing either way.
    pub fn paint_while_covered(webview: &tauri::Webview<tauri::Wry>) -> Result<(), String> {
        webview
            .with_webview(|platform| unsafe {
                let view: &WKWebView = &*(platform.inner() as *const WKWebView);
                View(view).set_occlusion_detection(false);
            })
            .map_err(|e| e.to_string())
    }

    /// A tab's webview, captured on the main thread.
    pub struct Tab(pub tauri::Webview<tauri::Wry>);

    impl super::Native for Tab {
        fn start(
            &self,
            pending: Arc<Pending>,
            size: Option<(f64, f64)>,
            began: Sender<Result<Plan, String>>,
            answer: Sender<Result<Vec<u8>, String>>,
        ) -> Result<(), String> {
            self.0
                .with_webview(move |platform| unsafe {
                    let view: &WKWebView = &*(platform.inner() as *const WKWebView);
                    match begin(&View(view), window_state(view), size) {
                        Ok(revealed) => {
                            pending.hold(revealed);
                            let _ = began.send(Ok(revealed.plan()));
                        }
                        Err(refusal) => {
                            let _ = began.send(Err(refusal));
                            return;
                        }
                    }
                    let mtm = objc2::MainThreadMarker::new()
                        .expect("with_webview always runs on the main thread");
                    // A view just unhidden, or let paint while its window is
                    // covered, has not drawn yet: the page is given two
                    // animation frames, in a script world of the app's own,
                    // before the snapshot, so it shows the page as it is now.
                    let retained = view.retain();
                    let painted = block2::RcBlock::new(
                        move |_: *mut objc2::runtime::AnyObject,
                              _: *mut objc2_foundation::NSError| {
                            snapshot(&retained, Arc::clone(&pending), answer.clone(), mtm);
                        },
                    );
                    let world = WKContentWorld::worldWithName(
                        &NSString::from_str(crate::browser_page::APP_WORLD),
                        mtm,
                    );
                    view.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                        &NSString::from_str(PAINTED),
                        None,
                        None,
                        &world,
                        Some(&painted),
                    );
                })
                .map_err(|e| e.to_string())
        }

        fn end(&self, pending: Arc<Pending>, done: Sender<()>) -> Result<(), String> {
            self.0
                .with_webview(move |platform| unsafe {
                    let view: &WKWebView = &*(platform.inner() as *const WKWebView);
                    pending.end(&View(view));
                    let _ = done.send(());
                })
                .map_err(|e| e.to_string())
        }
    }

    /// Settles once the page has drawn a frame since it was asked: two
    /// animation frames, the second of which starts after the first was
    /// painted. A page that draws nothing within a second is taken as it
    /// stands.
    const PAINTED: &str = "await new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); setTimeout(resolve, 1000); });";

    /// Takes `view`'s snapshot, unless the capture has already been given
    /// up on, and puts the view back once it has the image.
    unsafe fn snapshot(
        view: &Retained<WKWebView>,
        pending: Arc<Pending>,
        answer: Sender<Result<Vec<u8>, String>>,
        mtm: objc2::MainThreadMarker,
    ) {
        if !pending.is_held() {
            return;
        }
        let retained = view.clone();
        let block = block2::RcBlock::new(
            move |image: *mut objc2_app_kit::NSImage, error: *mut objc2_foundation::NSError| {
                // Back in its place before the image is encoded, so the view
                // is out for no longer than it takes to draw.
                pending.end(&View(&retained));
                let _ = answer.send(png(image, error));
            },
        );
        let configuration = WKSnapshotConfiguration::new(mtm);
        configuration.setAfterScreenUpdates(true);
        view.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &block);
    }

    /// The PNG bytes of a snapshot's image, or why there are none.
    unsafe fn png(
        image: *mut objc2_app_kit::NSImage,
        error: *mut objc2_foundation::NSError,
    ) -> Result<Vec<u8>, String> {
        if !error.is_null() {
            let error: &objc2_foundation::NSError = &*error;
            return Err(error.localizedDescription().to_string());
        }
        if image.is_null() {
            return Err("the webview returned no image".to_string());
        }
        let image: &objc2_app_kit::NSImage = &*image;
        let tiff = image
            .TIFFRepresentation()
            .ok_or("could not read the image's TIFF representation")?;
        let rep = objc2_app_kit::NSBitmapImageRep::imageRepWithData(&tiff)
            .ok_or("could not build a bitmap representation")?;
        let properties = objc2_foundation::NSDictionary::new();
        let png = rep
            .representationUsingType_properties(
                objc2_app_kit::NSBitmapImageFileType::PNG,
                &properties,
            )
            .ok_or("could not encode the image as PNG")?;
        Ok(png.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::thread;

    use workbench_core::browser::capture::{begin, CaptureView, Frame, ViewState, WindowState};

    const PLACE: Frame = Frame {
        x: 340.0,
        y: 40.0,
        width: 600.0,
        height: 700.0,
    };

    const HIDDEN: ViewState = ViewState {
        hidden: true,
        frame: PLACE,
        occlusion_switch: true,
    };

    const SHOWN: ViewState = ViewState {
        hidden: false,
        frame: PLACE,
        occlusion_switch: true,
    };

    /// Short waits, for the tests that do not measure the real ones.
    const QUICK: Waits = Waits {
        in_place: Duration::from_millis(50),
        revealed: Duration::from_millis(50),
        put_back: Duration::from_millis(50),
    };

    /// A view the fake native side works on, shared with the thread that
    /// stands in for the main thread.
    #[derive(Clone)]
    struct Shared(Arc<Mutex<ViewState>>);

    impl CaptureView for Shared {
        fn state(&self) -> ViewState {
            *self.0.lock().unwrap()
        }
        fn set_frame(&self, frame: Frame) {
            self.0.lock().unwrap().frame = frame;
        }
        fn set_hidden(&self, hidden: bool) {
            self.0.lock().unwrap().hidden = hidden;
        }
    }

    /// How the fake snapshot answers.
    #[derive(Clone, Copy)]
    enum Answer {
        Image,
        Error,
        /// Only after this long.
        Late(Duration),
        /// Not at all, as for a page stuck in a loop.
        Never,
    }

    struct Fake {
        view: Shared,
        answer: Answer,
        window: WindowState,
        /// Whether putting the view back never answers either.
        stuck: bool,
        /// The view's state as the snapshot saw it.
        seen: Arc<Mutex<Option<ViewState>>>,
    }

    impl Fake {
        fn new(answer: Answer) -> Self {
            Self::at(HIDDEN, answer)
        }

        fn at(state: ViewState, answer: Answer) -> Self {
            Self {
                view: Shared(Arc::new(Mutex::new(state))),
                answer,
                window: WindowState::ON_SHOW,
                stuck: false,
                seen: Arc::default(),
            }
        }
    }

    impl Native for Fake {
        fn start(
            &self,
            pending: Arc<Pending>,
            size: Option<(f64, f64)>,
            began: Sender<Result<Plan, String>>,
            answer: Sender<Result<Vec<u8>, String>>,
        ) -> Result<(), String> {
            let view = self.view.clone();
            let (kind, window, seen) = (self.answer, self.window, Arc::clone(&self.seen));
            thread::spawn(move || {
                match begin(&view, window, size) {
                    Ok(revealed) => {
                        pending.hold(revealed);
                        let _ = began.send(Ok(revealed.plan()));
                    }
                    Err(refusal) => {
                        let _ = began.send(Err(refusal));
                        return;
                    }
                }
                *seen.lock().unwrap() = Some(view.state());
                let result = match kind {
                    Answer::Image => Ok(vec![1, 2, 3]),
                    Answer::Error => Err("the snapshot failed".to_string()),
                    Answer::Late(after) => {
                        thread::sleep(after);
                        Ok(vec![1])
                    }
                    Answer::Never => {
                        // Holds the sender so the capture sees no answer
                        // rather than a dropped channel.
                        thread::sleep(Duration::from_secs(30));
                        drop(answer);
                        return;
                    }
                };
                pending.end(&view);
                let _ = answer.send(result);
            });
            Ok(())
        }

        fn end(&self, pending: Arc<Pending>, done: Sender<()>) -> Result<(), String> {
            let view = self.view.clone();
            let stuck = self.stuck;
            thread::spawn(move || {
                pending.end(&view);
                if stuck {
                    thread::sleep(Duration::from_secs(30));
                }
                let _ = done.send(());
            });
            Ok(())
        }
    }

    fn run(fake: Fake, waits: Waits) -> (Result<Vec<u8>, String>, ViewState, bool) {
        let views = tauri::async_runtime::Mutex::new(());
        let view = fake.view.clone();
        let result = tauri::async_runtime::block_on(async {
            let guard = views.lock().await;
            take(guard, fake, Some((600.0, 700.0)), waits).await
        });
        let free = views.try_lock().is_ok();
        let state = view.state();
        (result, state, free)
    }

    /// Starts a capture of `fake` holding `views` on a thread of its own.
    fn capture_on_a_thread(
        views: &Arc<tauri::async_runtime::Mutex<()>>,
        fake: Fake,
        waits: Waits,
    ) -> thread::JoinHandle<Result<Vec<u8>, String>> {
        let held = Arc::clone(views);
        let (locked, is_locked) = mpsc::channel();
        let capture = thread::spawn(move || {
            tauri::async_runtime::block_on(async {
                let guard = held.lock().await;
                let _ = locked.send(());
                take(guard, fake, None, waits).await
            })
        });
        is_locked.recv().unwrap();
        capture
    }

    /// How long until `views` can be taken, from now.
    fn time_to_lock(views: &tauri::async_runtime::Mutex<()>) -> Duration {
        let asked = Instant::now();
        tauri::async_runtime::block_on(async {
            let _guard = views.lock().await;
        });
        asked.elapsed()
    }

    #[test]
    fn a_snapshot_is_taken_revealed_and_the_view_put_back() {
        let fake = Fake::new(Answer::Image);
        let seen = Arc::clone(&fake.seen);
        let (result, after, free) = run(fake, WAITS);
        assert_eq!(result.unwrap(), vec![1, 2, 3]);
        let during = seen.lock().unwrap().unwrap();
        assert!(!during.hidden);
        assert!(during.frame.x + during.frame.width < 0.0);
        assert_eq!(after, HIDDEN);
        assert!(free);
    }

    #[test]
    fn a_failed_snapshot_still_puts_the_view_back() {
        let (result, after, free) = run(Fake::new(Answer::Error), WAITS);
        assert_eq!(result.unwrap_err(), "the snapshot failed");
        assert_eq!(after, HIDDEN);
        assert!(free);
    }

    #[test]
    fn a_snapshot_that_never_answers_is_given_up_on_with_the_view_put_back() {
        let fake = Fake::new(Answer::Late(Duration::from_millis(400)));
        let view = fake.view.clone();
        let (result, after, free) = run(fake, QUICK);
        assert_eq!(result.unwrap_err(), "timed out taking the screenshot");
        assert_eq!(after, HIDDEN);
        assert!(free);
        // The late answer finds nothing left to put back.
        thread::sleep(Duration::from_millis(500));
        assert_eq!(view.state(), HIDDEN);
    }

    #[test]
    fn a_refusal_leaves_the_view_alone() {
        let mut fake = Fake::new(Answer::Image);
        fake.window.visible = false;
        let (result, after, free) = run(fake, WAITS);
        assert!(result.unwrap_err().contains("minimised or hidden"));
        assert_eq!(after, HIDDEN);
        assert!(free);
    }

    #[test]
    fn the_views_stay_held_until_the_view_is_back() {
        let views = Arc::new(tauri::async_runtime::Mutex::new(()));
        let fake = Fake::new(Answer::Late(Duration::from_millis(300)));
        let view = fake.view.clone();
        let capture = capture_on_a_thread(&views, fake, WAITS);
        thread::sleep(Duration::from_millis(100));
        // An open, a switch or a close waits here meanwhile.
        assert!(views.try_lock().is_err());
        assert!(!view.state().hidden, "the view is out for its snapshot");
        let other = tauri::async_runtime::block_on(async {
            let _guard = views.lock().await;
            view.state()
        });
        assert_eq!(
            other, HIDDEN,
            "the next change finds the view back in place"
        );
        assert!(capture.join().unwrap().is_ok());
    }

    #[test]
    fn a_tab_taken_where_it_is_lets_the_views_go_at_once() {
        let views = Arc::new(tauri::async_runtime::Mutex::new(()));
        let fake = Fake::at(SHOWN, Answer::Late(Duration::from_millis(500)));
        let capture = capture_on_a_thread(&views, fake, WAITS);
        // A switch made while the snapshot is still being taken goes ahead.
        assert!(time_to_lock(&views) < Duration::from_millis(250));
        assert!(!capture.is_finished(), "the snapshot is still under way");
        assert_eq!(capture.join().unwrap().unwrap(), vec![1]);
    }

    #[test]
    fn a_revealed_tab_whose_snapshot_never_answers_lets_the_views_go_within_the_cap() {
        let views = Arc::new(tauri::async_runtime::Mutex::new(()));
        let fake = Fake::new(Answer::Never);
        let view = fake.view.clone();
        let capture = capture_on_a_thread(&views, fake, WAITS);
        let waited = time_to_lock(&views);
        assert!(
            waited <= WAITS.revealed + Duration::from_millis(500),
            "the views were held for {waited:?}"
        );
        assert!(WAITS.revealed <= Duration::from_secs(3));
        assert_eq!(view.state(), HIDDEN, "the view is back before they go");
        assert_eq!(
            capture.join().unwrap().unwrap_err(),
            "timed out taking the screenshot"
        );
    }

    #[test]
    fn a_put_back_that_never_answers_lets_the_views_go_after_its_own_wait() {
        let views = Arc::new(tauri::async_runtime::Mutex::new(()));
        let mut fake = Fake::new(Answer::Never);
        fake.stuck = true;
        let waits = Waits {
            put_back: Duration::from_millis(200),
            ..QUICK
        };
        let capture = capture_on_a_thread(&views, fake, waits);
        let waited = time_to_lock(&views);
        assert!(
            waited <= waits.revealed + waits.put_back + Duration::from_millis(300),
            "the views were held for {waited:?}"
        );
        assert!(WAITS.put_back <= Duration::from_secs(1));
        assert!(capture.join().unwrap().is_err());
    }
}
