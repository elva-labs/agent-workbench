//! The system's notifications.
//!
//! The window names each notification it sends. On macOS, run from the
//! app's bundle, the name goes with the notification: one sent again under
//! the same name takes the place of the one before, a click on one brings
//! the window forward and tells the window its name, and the window takes
//! one away by its name once what it said is over. A notification never
//! shows as a banner while the window is the one in front, and those an
//! earlier run left are taken away at launch, since no question of that
//! run is still open. The app connects to the notification centre at
//! launch only then, and otherwise with its first notification, which is
//! when macOS asks a new user whether to allow them. Elsewhere, and in a
//! build run outside a bundle, a notification goes through the
//! notification plugin and is left as the system leaves it.

use tauri::AppHandle;

/// Readies the notifications at launch: on macOS, run from the bundle,
/// those an earlier run left in the system's list are taken away, and the
/// app hears a click on one from then on.
pub fn install(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if mac::bundled() {
        mac::install(app);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Shows a notification under the window's name for it.
#[tauri::command]
pub fn notice_show(app: AppHandle, id: String, title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if mac::bundled() {
        let handle = app.clone();
        return app
            .run_on_main_thread(move || mac::show(&handle, &id, &title, &body))
            .map_err(|error| error.to_string());
    }
    let _ = id;
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())
}

/// Takes the notification of that name away from the system's list, where
/// the system lets the app do so.
#[tauri::command]
pub fn notice_clear(app: AppHandle, id: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if mac::bundled() {
        return app
            .run_on_main_thread(move || mac::clear(&id))
            .map_err(|error| error.to_string());
    }
    let _ = (app, id);
    Ok(())
}

/// The notification centre of AppKit, which takes a notification's name as
/// its identifier and tells a delegate of a click. It needs the app's own
/// bundle; a build run outside one has none.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
mod mac {
    use std::cell::OnceCell;
    use std::sync::OnceLock;

    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::NSWindow;
    use objc2_foundation::{
        NSBundle, NSObject, NSObjectProtocol, NSString, NSUserDefaults, NSUserNotification,
        NSUserNotificationCenter, NSUserNotificationCenterDelegate,
    };
    use tauri::{AppHandle, Emitter, Manager};

    /// The event that tells the window which notification was clicked.
    const CLICKED: &str = "notice_clicked";

    define_class!(
        /// Hears a click on one of the app's notifications, and says
        /// whether one is shown as a banner.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "WorkbenchNoticeDelegate"]
        #[ivars = AppHandle]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl NSUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:didActivateNotification:))]
            fn did_activate(
                &self,
                centre: &NSUserNotificationCenter,
                notification: &NSUserNotification,
            ) {
                centre.removeDeliveredNotification(notification);
                let app = self.ivars();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                if let Some(id) = notification.identifier() {
                    let _ = app.emit_to("main", CLICKED, id.to_string());
                }
            }

            /// A banner only while the window is not the one in front: not
            /// key, or put away in the Dock or hidden. In front, the
            /// window already says what the notification would.
            #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
            fn should_present(
                &self,
                _centre: &NSUserNotificationCenter,
                _notification: &NSUserNotification,
            ) -> bool {
                !in_front(self.ivars())
            }
        }
    );

    thread_local! {
        /// The delegate, kept for as long as the app runs: the centre holds
        /// it unretained.
        static DELEGATE: OnceCell<Retained<Delegate>> = const { OnceCell::new() };
    }

    /// Whether the app runs from its bundle, decided once: the notification
    /// plugin, used outside one, makes the bundle seem to be another app's.
    pub fn bundled() -> bool {
        static BUNDLED: OnceLock<bool> = OnceLock::new();
        *BUNDLED
            .get_or_init(|| !tauri::is_dev() && NSBundle::mainBundle().bundleIdentifier().is_some())
    }

    /// Whether the main window is the one the user is in: key, shown and
    /// not in the Dock.
    fn in_front(app: &AppHandle) -> bool {
        let Some(window) = app.get_webview_window("main") else {
            return false;
        };
        let Ok(ptr) = window.ns_window() else {
            return false;
        };
        let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        ns_window.isKeyWindow() && ns_window.isVisible() && !ns_window.isMiniaturized()
    }

    /// The app's own default that says a run of it delivered a
    /// notification the system may still list.
    const DELIVERED: &str = "WorkbenchNoticesDelivered";

    fn delivered() -> bool {
        NSUserDefaults::standardUserDefaults().boolForKey(&NSString::from_str(DELIVERED))
    }

    fn mark_delivered(delivered: bool) {
        let defaults = NSUserDefaults::standardUserDefaults();
        let key = NSString::from_str(DELIVERED);
        if delivered {
            defaults.setBool_forKey(true, &key);
        } else {
            defaults.removeObjectForKey(&key);
        }
    }

    /// Only a run after one that delivered connects at launch: connecting
    /// is what has macOS ask a new user, which belongs with the first
    /// notification.
    pub fn install(app: &AppHandle) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        if !delivered() {
            return;
        }
        centre(app, mtm).removeAllDeliveredNotifications();
        mark_delivered(false);
    }

    fn centre(app: &AppHandle, mtm: MainThreadMarker) -> Retained<NSUserNotificationCenter> {
        let centre = NSUserNotificationCenter::defaultUserNotificationCenter();
        DELEGATE.with(|kept| {
            kept.get_or_init(|| {
                let delegate: Retained<Delegate> =
                    unsafe { msg_send![super(Delegate::alloc(mtm).set_ivars(app.clone())), init] };
                unsafe { centre.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
                delegate
            });
        });
        centre
    }

    fn remove(centre: &NSUserNotificationCenter, id: &str) {
        for delivered in centre.deliveredNotifications().to_vec() {
            if delivered
                .identifier()
                .is_some_and(|named| named.to_string() == id)
            {
                centre.removeDeliveredNotification(&delivered);
            }
        }
    }

    pub fn show(app: &AppHandle, id: &str, title: &str, body: &str) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let centre = centre(app, mtm);
        remove(&centre, id);
        let notification = NSUserNotification::new();
        notification.setIdentifier(Some(&NSString::from_str(id)));
        notification.setTitle(Some(&NSString::from_str(title)));
        notification.setInformativeText(Some(&NSString::from_str(body)));
        centre.deliverNotification(&notification);
        mark_delivered(true);
    }

    pub fn clear(id: &str) {
        remove(
            &NSUserNotificationCenter::defaultUserNotificationCenter(),
            id,
        );
    }
}
