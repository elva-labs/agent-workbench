//! Taking a screenshot of a tab whose view may not be on show.
//!
//! A hidden web view stops painting, so its snapshot is the last frame it
//! drew. To capture one, its view is moved past the window's left edge at
//! the size it shows at, unhidden with the system's occlusion detection off
//! for it, snapshotted, then hidden and put back. The view is never inside
//! the window's visible area, so nothing shows, and it never takes the
//! pointer or the keyboard. A view already on show is taken where it is,
//! untouched.
//!
//! Nothing here touches a window: the native layer implements
//! [`CaptureView`] over a tab's view and calls [`begin`] before the
//! snapshot and [`Pending::end`] after it.

use std::sync::Mutex;

/// A rectangle in points, in the coordinates of the view's superview.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What a capture may change on a tab's view, read before it changes
/// anything.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ViewState {
    pub hidden: bool,
    pub frame: Frame,
    /// Whether the system's window occlusion detection is on for the view,
    /// or `None` where the system has no switch for it.
    pub occlusion_detection: Option<bool>,
}

/// A tab's native view, as a capture works on it.
pub trait CaptureView {
    fn state(&self) -> ViewState;
    fn set_frame(&self, frame: Frame);
    fn set_hidden(&self, hidden: bool);
    fn set_occlusion_detection(&self, enabled: bool);
}

/// The answer while the window is minimised: nothing in it paints then.
pub const MINIMISED: &str = "the workbench's window is minimised, and a tab cannot be captured while it is; ask the user to bring the window back, or read the page with browser_snapshot";

/// The answer for a tab not on show where the system has no switch for
/// occlusion detection.
pub const NOT_SHOWING: &str = "the tab is not showing, and this system cannot capture a tab that is not on show; read the page with browser_snapshot";

/// The size a view is revealed at when neither the viewer nor the view
/// itself gives one.
pub const DEFAULT_SIZE: (f64, f64) = (1280.0, 800.0);

/// How far past the window's left edge a revealed view sits.
const EDGE_GAP: f64 = 100.0;

/// A view smaller than this in either direction has never been placed: a
/// tab opened behind is built at one point square.
const PLACED: f64 = 2.0;

/// How a capture takes its view.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Plan {
    /// On show already: taken where it is.
    InPlace,
    /// Hidden: unhidden at this frame, past the window's left edge, for the
    /// length of the snapshot.
    Reveal(Frame),
}

/// How a view in `state` is captured, in a window that is `minimised` or
/// not, at the viewer's last size `size` if it has one; or why it cannot
/// be.
pub fn plan(state: &ViewState, minimised: bool, size: Option<(f64, f64)>) -> Result<Plan, String> {
    if minimised {
        return Err(MINIMISED.to_string());
    }
    if !state.hidden {
        return Ok(Plan::InPlace);
    }
    if state.occlusion_detection.is_none() {
        return Err(NOT_SHOWING.to_string());
    }
    let own = (state.frame.width, state.frame.height);
    let (width, height) = size
        .filter(|&(w, h)| w >= PLACED && h >= PLACED)
        .or(Some(own).filter(|&(w, h)| w >= PLACED && h >= PLACED))
        .unwrap_or(DEFAULT_SIZE);
    Ok(Plan::Reveal(Frame {
        x: -(width + EDGE_GAP),
        y: state.frame.y,
        width,
        height,
    }))
}

/// What [`begin`] changed, for [`Pending::end`] to put back.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Revealed {
    before: ViewState,
    plan: Plan,
}

impl Revealed {
    pub fn plan(&self) -> Plan {
        self.plan
    }
}

/// Readies `view` for its snapshot. A hidden view is moved past the
/// window's edge, has occlusion detection turned off, and only then is
/// unhidden, so the first frame it paints is already out of sight. A view
/// on show, and one that cannot be captured, is left as it is.
pub fn begin(
    view: &impl CaptureView,
    minimised: bool,
    size: Option<(f64, f64)>,
) -> Result<Revealed, String> {
    let before = view.state();
    let plan = plan(&before, minimised, size)?;
    if let Plan::Reveal(frame) = plan {
        view.set_frame(frame);
        if before.occlusion_detection == Some(true) {
            view.set_occlusion_detection(false);
        }
        view.set_hidden(false);
    }
    Ok(Revealed { before, plan })
}

/// Puts back what [`begin`] changed: hidden again first, then occlusion
/// detection and the frame, so nothing moves while it is on show.
fn restore(view: &impl CaptureView, revealed: &Revealed) {
    if let Plan::Reveal(_) = revealed.plan {
        view.set_hidden(true);
        if revealed.before.occlusion_detection == Some(true) {
            view.set_occlusion_detection(true);
        }
        view.set_frame(revealed.before.frame);
    }
}

/// A capture under way. The snapshot answering and the wait for it running
/// out can both end it; whichever comes first puts the view back, and the
/// other finds nothing left to do.
#[derive(Debug, Default)]
pub struct Pending(Mutex<Option<Revealed>>);

impl Pending {
    /// Records what a capture changed, for [`Pending::end`].
    pub fn hold(&self, revealed: Revealed) {
        *self.0.lock().unwrap() = Some(revealed);
    }

    /// Whether this capture still has a view out of its place.
    pub fn is_held(&self) -> bool {
        self.0.lock().unwrap().is_some()
    }

    /// Puts `view` back as it was, if this capture still holds it. Answers
    /// whether it did.
    pub fn end(&self, view: &impl CaptureView) -> bool {
        let Some(revealed) = self.0.lock().unwrap().take() else {
            return false;
        };
        restore(view, &revealed);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Debug, Clone, Copy, PartialEq)]
    enum Op {
        Frame(Frame),
        Hidden(bool),
        Occlusion(bool),
    }

    /// A view that records what is done to it and keeps its state as a
    /// native view would.
    struct FakeView {
        state: RefCell<ViewState>,
        ops: RefCell<Vec<Op>>,
    }

    impl FakeView {
        fn new(state: ViewState) -> Self {
            Self {
                state: RefCell::new(state),
                ops: RefCell::new(Vec::new()),
            }
        }

        fn ops(&self) -> Vec<Op> {
            self.ops.borrow().clone()
        }
    }

    impl CaptureView for FakeView {
        fn state(&self) -> ViewState {
            *self.state.borrow()
        }
        fn set_frame(&self, frame: Frame) {
            self.state.borrow_mut().frame = frame;
            self.ops.borrow_mut().push(Op::Frame(frame));
        }
        fn set_hidden(&self, hidden: bool) {
            self.state.borrow_mut().hidden = hidden;
            self.ops.borrow_mut().push(Op::Hidden(hidden));
        }
        fn set_occlusion_detection(&self, enabled: bool) {
            assert!(
                self.state.borrow().occlusion_detection.is_some(),
                "the switch is missing on this system"
            );
            self.state.borrow_mut().occlusion_detection = Some(enabled);
            self.ops.borrow_mut().push(Op::Occlusion(enabled));
        }
    }

    const PLACE: Frame = Frame {
        x: 340.0,
        y: 40.0,
        width: 600.0,
        height: 700.0,
    };

    fn hidden_at(frame: Frame) -> ViewState {
        ViewState {
            hidden: true,
            frame,
            occlusion_detection: Some(true),
        }
    }

    fn shown() -> ViewState {
        ViewState {
            hidden: false,
            frame: PLACE,
            occlusion_detection: Some(true),
        }
    }

    /// Runs a whole capture against `view` and answers with the state it
    /// was in while the snapshot was taken.
    fn capture(view: &FakeView, size: Option<(f64, f64)>) -> ViewState {
        let pending = Pending::default();
        pending.hold(begin(view, false, size).unwrap());
        let during = view.state();
        assert!(pending.end(view));
        during
    }

    #[test]
    fn a_hidden_view_is_revealed_past_the_left_edge_and_put_back() {
        let before = hidden_at(PLACE);
        let view = FakeView::new(before);
        let during = capture(&view, Some((600.0, 700.0)));

        assert!(!during.hidden);
        assert_eq!(during.occlusion_detection, Some(false));
        assert_eq!(during.frame.width, 600.0);
        assert_eq!(during.frame.height, 700.0);
        assert!(
            during.frame.x + during.frame.width < 0.0,
            "wholly outside the window"
        );
        assert_eq!(view.state(), before);
    }

    #[test]
    fn it_is_moved_before_it_is_shown_and_hidden_before_it_moves_back() {
        let view = FakeView::new(hidden_at(PLACE));
        capture(&view, Some((600.0, 700.0)));
        let ops = view.ops();
        let out = Frame {
            x: -700.0,
            y: 40.0,
            width: 600.0,
            height: 700.0,
        };
        assert_eq!(
            ops,
            vec![
                Op::Frame(out),
                Op::Occlusion(false),
                Op::Hidden(false),
                Op::Hidden(true),
                Op::Occlusion(true),
                Op::Frame(PLACE),
            ]
        );
    }

    #[test]
    fn a_view_on_show_is_taken_where_it_is_untouched() {
        let view = FakeView::new(shown());
        let during = capture(&view, Some((600.0, 700.0)));
        assert_eq!(during, shown());
        assert!(view.ops().is_empty());
        assert_eq!(view.state(), shown());
    }

    #[test]
    fn occlusion_detection_already_off_is_left_alone() {
        let mut state = hidden_at(PLACE);
        state.occlusion_detection = Some(false);
        let view = FakeView::new(state);
        capture(&view, None);
        assert!(!view.ops().iter().any(|op| matches!(op, Op::Occlusion(_))));
        assert_eq!(view.state(), state);
    }

    #[test]
    fn the_size_is_the_viewers_then_the_views_own_then_a_default() {
        let tiny = Frame {
            x: 0.0,
            y: 899.0,
            width: 1.0,
            height: 1.0,
        };
        let size = |state: ViewState, viewer| match plan(&state, false, viewer).unwrap() {
            Plan::Reveal(frame) => (frame.width, frame.height),
            Plan::InPlace => panic!("a hidden view is revealed"),
        };
        assert_eq!(size(hidden_at(tiny), Some((500.0, 400.0))), (500.0, 400.0));
        assert_eq!(size(hidden_at(PLACE), None), (600.0, 700.0));
        assert_eq!(size(hidden_at(tiny), None), DEFAULT_SIZE);
        assert_eq!(size(hidden_at(tiny), Some((0.0, 0.0))), DEFAULT_SIZE);
    }

    #[test]
    fn a_minimised_window_is_refused_and_nothing_is_touched() {
        for state in [hidden_at(PLACE), shown()] {
            let view = FakeView::new(state);
            assert_eq!(begin(&view, true, None).unwrap_err(), MINIMISED);
            assert!(view.ops().is_empty());
        }
    }

    #[test]
    fn without_the_occlusion_switch_a_hidden_tab_is_refused() {
        let mut state = hidden_at(PLACE);
        state.occlusion_detection = None;
        let view = FakeView::new(state);
        assert_eq!(begin(&view, false, None).unwrap_err(), NOT_SHOWING);
        assert!(view.ops().is_empty());
    }

    #[test]
    fn without_the_occlusion_switch_a_tab_on_show_is_taken_as_it_is() {
        let mut state = shown();
        state.occlusion_detection = None;
        let view = FakeView::new(state);
        let during = capture(&view, None);
        assert_eq!(during, state);
        assert!(view.ops().is_empty());
    }

    #[test]
    fn a_capture_is_put_back_once_whichever_ends_it_first() {
        let before = hidden_at(PLACE);
        let view = FakeView::new(before);
        let pending = Pending::default();
        pending.hold(begin(&view, false, None).unwrap());
        // The wait runs out, then the snapshot answers late.
        assert!(pending.is_held());
        assert!(pending.end(&view));
        assert!(!pending.is_held());
        let after_timeout = view.ops().len();
        assert!(!pending.end(&view));
        assert_eq!(view.ops().len(), after_timeout);
        assert_eq!(view.state(), before);
    }

    #[test]
    fn a_capture_that_never_began_has_nothing_to_put_back() {
        let view = FakeView::new(hidden_at(PLACE));
        let pending = Pending::default();
        assert!(!pending.end(&view));
        assert!(view.ops().is_empty());
    }
}
