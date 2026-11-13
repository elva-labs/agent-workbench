//! A tab's screenshot, taken whether or not its view is on show, without
//! the tab coming forward. What is done to the view, and in what order, is
//! [`workbench_core::browser::capture`]'s; this is the part that waits on
//! the native snapshot and makes sure the view is back in its place before
//! the browser's views are let go, on every way out.

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::Duration;

use workbench_core::browser::capture::Pending;

/// How long a snapshot has to answer before the capture gives up on it.
pub const WAIT: Duration = Duration::from_secs(10);

/// The native side of a capture: a tab's view, on the thread that may
/// touch it.
pub trait Native {
    /// Readies the view through [`workbench_core::browser::capture::begin`],
    /// recording what changed on `pending`, and starts its snapshot. Once
    /// the snapshot answers, the view is put back through `pending` and the
    /// image, or why there is none, goes to `answer`. A view that cannot be
    /// captured answers at once with the reason and is left as it is.
    fn start(
        &self,
        pending: Arc<Pending>,
        size: Option<(f64, f64)>,
        answer: Sender<Result<Vec<u8>, String>>,
    ) -> Result<(), String>;

    /// Puts the view back through `pending`, if the capture still holds it,
    /// and signals `done` once it has.
    fn end(&self, pending: Arc<Pending>, done: Sender<()>) -> Result<(), String>;
}

/// Takes `native`'s snapshot at `size` while `views` is held, and lets
/// `views` go only once the view is back in its place: after the snapshot
/// answers, or after `wait` runs out and the view has been put back
/// without it.
pub async fn take<G>(
    views: G,
    native: impl Native,
    size: Option<(f64, f64)>,
    wait: Duration,
) -> Result<Vec<u8>, String> {
    let pending = Arc::new(Pending::default());
    let (answer, answered) = mpsc::channel();
    native.start(Arc::clone(&pending), size, answer)?;
    let outcome = blocking_recv(answered, wait).await;

    let result = match outcome {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err("timed out taking the screenshot".to_string()),
        Err(RecvTimeoutError::Disconnected) => Err("the tab's view went away".to_string()),
    };
    // A snapshot that answered has put the view back already; one that did
    // not is put back here, and waited for, before the views are let go.
    let (done, ended) = mpsc::channel();
    if native.end(pending, done).is_ok() {
        let _ = blocking_recv(ended, wait).await;
    }
    drop(views);
    result
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
pub use native::{paint_while_covered, Tab};

#[cfg(target_os = "macos")]
mod native {
    use std::sync::mpsc::Sender;
    use std::sync::Arc;

    use objc2::rc::Retained;
    use objc2::{msg_send, sel, Message};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
    use objc2_web_kit::{WKContentWorld, WKSnapshotConfiguration, WKWebView};
    use workbench_core::browser::capture::{begin, CaptureView, Frame, Pending, ViewState};

    /// A tab's `WKWebView`, as a capture works on it.
    struct View<'a>(&'a WKWebView);

    impl View<'_> {
        /// Whether this WebKit has the switch for window occlusion
        /// detection. It is WebKit's own private API, reached by message
        /// send, so it is looked for every time rather than assumed.
        fn has_occlusion_switch(&self) -> bool {
            let view = self.0;
            unsafe {
                let get: bool =
                    msg_send![view, respondsToSelector: sel!(_windowOcclusionDetectionEnabled)];
                let set: bool =
                    msg_send![view, respondsToSelector: sel!(_setWindowOcclusionDetectionEnabled:)];
                get && set
            }
        }
    }

    impl CaptureView for View<'_> {
        fn state(&self) -> ViewState {
            let frame = self.0.frame();
            let occlusion_detection = self.has_occlusion_switch().then(|| {
                let view = self.0;
                let enabled: bool = unsafe { msg_send![view, _windowOcclusionDetectionEnabled] };
                enabled
            });
            ViewState {
                hidden: self.0.isHidden(),
                frame: Frame {
                    x: frame.origin.x,
                    y: frame.origin.y,
                    width: frame.size.width,
                    height: frame.size.height,
                },
                occlusion_detection,
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

        fn set_occlusion_detection(&self, enabled: bool) {
            if self.has_occlusion_switch() {
                let view = self.0;
                let _: () =
                    unsafe { msg_send![view, _setWindowOcclusionDetectionEnabled: enabled] };
            }
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
            answer: Sender<Result<Vec<u8>, String>>,
        ) -> Result<(), String> {
            self.0
                .with_webview(move |platform| unsafe {
                    let view: &WKWebView = &*(platform.inner() as *const WKWebView);
                    let minimised = view.window().is_some_and(|window| window.isMiniaturized());
                    match begin(&View(view), minimised, size) {
                        Ok(revealed) => pending.hold(revealed),
                        Err(refusal) => {
                            let _ = answer.send(Err(refusal));
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

    use workbench_core::browser::capture::{begin, CaptureView, Frame, ViewState};

    const PLACE: Frame = Frame {
        x: 340.0,
        y: 40.0,
        width: 600.0,
        height: 700.0,
    };

    const HIDDEN: ViewState = ViewState {
        hidden: true,
        frame: PLACE,
        occlusion_detection: Some(true),
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
        fn set_occlusion_detection(&self, enabled: bool) {
            self.0.lock().unwrap().occlusion_detection = Some(enabled);
        }
    }

    /// How the fake snapshot answers.
    #[derive(Clone, Copy)]
    enum Answer {
        Image,
        Error,
        /// Only after this long, past the capture's wait.
        Late(Duration),
    }

    struct Fake {
        view: Shared,
        answer: Answer,
        minimised: bool,
        /// The view's state as the snapshot saw it.
        seen: Arc<Mutex<Option<ViewState>>>,
    }

    impl Fake {
        fn new(answer: Answer) -> Self {
            Self {
                view: Shared(Arc::new(Mutex::new(HIDDEN))),
                answer,
                minimised: false,
                seen: Arc::default(),
            }
        }
    }

    impl Native for Fake {
        fn start(
            &self,
            pending: Arc<Pending>,
            size: Option<(f64, f64)>,
            answer: Sender<Result<Vec<u8>, String>>,
        ) -> Result<(), String> {
            let view = self.view.clone();
            let (kind, minimised, seen) = (self.answer, self.minimised, Arc::clone(&self.seen));
            thread::spawn(move || {
                match begin(&view, minimised, size) {
                    Ok(revealed) => pending.hold(revealed),
                    Err(refusal) => {
                        let _ = answer.send(Err(refusal));
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
                };
                pending.end(&view);
                let _ = answer.send(result);
            });
            Ok(())
        }

        fn end(&self, pending: Arc<Pending>, done: Sender<()>) -> Result<(), String> {
            let view = self.view.clone();
            thread::spawn(move || {
                pending.end(&view);
                let _ = done.send(());
            });
            Ok(())
        }
    }

    fn run(fake: Fake, wait: Duration) -> (Result<Vec<u8>, String>, ViewState, bool) {
        let views = tauri::async_runtime::Mutex::new(());
        let view = fake.view.clone();
        let result = tauri::async_runtime::block_on(async {
            let guard = views.lock().await;
            take(guard, fake, Some((600.0, 700.0)), wait).await
        });
        let free = views.try_lock().is_ok();
        let state = view.state();
        (result, state, free)
    }

    #[test]
    fn a_snapshot_is_taken_revealed_and_the_view_put_back() {
        let fake = Fake::new(Answer::Image);
        let seen = Arc::clone(&fake.seen);
        let (result, after, free) = run(fake, WAIT);
        assert_eq!(result.unwrap(), vec![1, 2, 3]);
        let during = seen.lock().unwrap().unwrap();
        assert!(!during.hidden);
        assert!(during.frame.x + during.frame.width < 0.0);
        assert_eq!(after, HIDDEN);
        assert!(free);
    }

    #[test]
    fn a_failed_snapshot_still_puts_the_view_back() {
        let (result, after, free) = run(Fake::new(Answer::Error), WAIT);
        assert_eq!(result.unwrap_err(), "the snapshot failed");
        assert_eq!(after, HIDDEN);
        assert!(free);
    }

    #[test]
    fn a_snapshot_that_never_answers_is_given_up_on_with_the_view_put_back() {
        let fake = Fake::new(Answer::Late(Duration::from_millis(400)));
        let view = fake.view.clone();
        let (result, after, free) = run(fake, Duration::from_millis(50));
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
        fake.minimised = true;
        let (result, after, free) = run(fake, WAIT);
        assert!(result.unwrap_err().contains("minimised"));
        assert_eq!(after, HIDDEN);
        assert!(free);
    }

    #[test]
    fn the_views_stay_held_until_the_view_is_back() {
        let views = Arc::new(tauri::async_runtime::Mutex::new(()));
        let fake = Fake::new(Answer::Late(Duration::from_millis(300)));
        let view = fake.view.clone();
        let held = Arc::clone(&views);
        let capture = thread::spawn(move || {
            tauri::async_runtime::block_on(async {
                let guard = held.lock().await;
                take(guard, fake, None, WAIT).await
            })
        });
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
}
