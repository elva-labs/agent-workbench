//! The embedded browser's native layer: one child webview per tab, laid
//! over a rectangle the frontend measures on the same window as the app's
//! own page.
//!
//! The tabs themselves live in [`workbench_core::browser::Tabs`], kept here
//! behind a mutex; a tab's webview is labelled with its
//! [`workbench_core::browser::TabId::label`] and built, moved and closed by
//! the commands below. Every command takes a [`tauri::Window`], never a
//! [`tauri::WebviewWindow`]: once a window holds a second webview, Tauri no
//! longer hands it out as the latter.

use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, State, Url,
    Webview, WebviewUrl, Window, Wry,
};
use workbench_core::browser::{
    connect_failure_message, navigation_target, normalize_url, ConnectFailure, Opener, Snapshot,
    TabId, Tabs,
};

/// How long a load-failure check waits for a host to answer before it
/// reports the tab as unreachable.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);

/// Safari's user agent on macOS. WKWebView's own stops at `AppleWebKit`,
/// which a site reads as an embedded view rather than a browser.
#[cfg(target_os = "macos")]
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

/// Keeps the browser's cookies and storage apart from the app's own page.
/// Sixteen bytes with no meaning beyond naming this app.
#[cfg(target_os = "macos")]
const DATA_STORE: [u8; 16] = *b"agent-workbench1";

/// A rectangle in logical points, relative to the window's content area.
type Rectangle = (f64, f64, f64, f64);

/// Where the active tab is placed, and whether it is shown at all.
#[derive(Default)]
struct Place {
    rect: Option<Rectangle>,
    showing: bool,
}

/// The embedded browser's state: its tabs, and where the active one sits.
pub struct Browser {
    tabs: Mutex<Tabs>,
    place: Mutex<Place>,
    /// Serialises opening a tab: two opens racing must not interleave
    /// building webviews.
    opening: tauri::async_runtime::Mutex<()>,
}

impl Default for Browser {
    fn default() -> Self {
        Self {
            tabs: Mutex::new(Tabs::default()),
            place: Mutex::new(Place::default()),
            opening: tauri::async_runtime::Mutex::new(()),
        }
    }
}

impl Browser {
    /// The tab currently active, if one is open at all.
    pub fn active(&self) -> Option<TabId> {
        self.tabs.lock().unwrap().active()
    }

    /// Whether `id` is the tab actually shown right now: the active tab,
    /// with the browser's place showing it at all. Only the active tab's
    /// webview is ever visible, so this is enough to tell.
    pub fn is_visible(&self, id: TabId) -> bool {
        self.tabs.lock().unwrap().active() == Some(id) && self.place.lock().unwrap().showing
    }
}

/// Sends the tabs as they now stand to the main webview alone: a tab's own
/// page never gets a look at another tab's state.
fn emit_snapshot(app: &AppHandle, snapshot: &Snapshot) {
    let _ = app.emit_to("main", "browser_tabs", snapshot);
}

/// Whether a frame may load `url`. The question is asked for every frame of
/// a page, not the top one alone, so what a page builds its own frames from
/// is let through beside the web: `about:srcdoc`, `blob:` and `data:`. A
/// local file, the app's own schemes and another program's are not.
fn navigation_allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "about" | "blob" | "data")
}

/// A webview builder for `id` starting at `start`, wired to keep
/// [`Browser`]'s tabs in step with what the webview is actually doing and
/// to emit the snapshot as that happens.
fn tab_webview(id: TabId, start: &Url, app: &AppHandle) -> WebviewBuilder<Wry> {
    let load_app = app.clone();
    let title_app = app.clone();
    let window_app = app.clone();

    let builder = WebviewBuilder::new(id.label(), WebviewUrl::External(start.clone()))
        // Runs before the page's own scripts, so a tab's console capture is
        // in place from the first line.
        .initialization_script(crate::browser_page::CONSOLE_CAPTURE_SCRIPT)
        // A frame inside the page asks here too, so the tab's own address
        // is taken from the page load below, which is the top frame's alone.
        .on_navigation(navigation_allowed)
        .on_page_load(move |webview, payload| {
            let browser = load_app.state::<Arc<Browser>>();
            let url = payload.url().to_string();
            let event = payload.event();
            let snapshot = {
                let mut tabs = browser.tabs.lock().unwrap();
                // A cross-origin destination can make WebKit swap the tab to
                // a new process, which commits a transient `about:blank`
                // before the real destination is known to have answered at
                // all; applying that here would erase the target a
                // load-failure check kicked off against this tab is still
                // watching for.
                if !tabs.is_interstitial(id, &url) {
                    match event {
                        PageLoadEvent::Started => tabs.navigation_started(id, url),
                        PageLoadEvent::Finished => tabs.navigation_finished(id, url),
                    };
                }
                tabs.snapshot()
            };
            emit_snapshot(&load_app, &snapshot);
            // A single-page app's own navigation changes history without a
            // page load, but a real page load always ends one, so this is
            // also where the buttons catch up on those.
            if let PageLoadEvent::Finished = event {
                refresh_history(id, webview, load_app.clone());
            }
        })
        .on_document_title_changed(move |webview, title| {
            let browser = title_app.state::<Arc<Browser>>();
            let snapshot = {
                let mut tabs = browser.tabs.lock().unwrap();
                tabs.titled(id, title);
                tabs.snapshot()
            };
            emit_snapshot(&title_app, &snapshot);
            // A single-page app changes its title on the same pushState
            // navigation that changes its history, so this is the other
            // place the back/forward buttons need to catch up.
            refresh_history(id, webview, title_app.clone());
        })
        .on_new_window(move |url, _features| {
            let app = window_app.clone();
            tauri::async_runtime::spawn(async move {
                let Some(window) = app.get_window("main") else {
                    return;
                };
                let browser = Arc::clone(&app.state::<Arc<Browser>>());
                let _ = open_tab(
                    window,
                    app.clone(),
                    browser,
                    Some(url.to_string()),
                    Opener::User,
                )
                .await;
            });
            NewWindowResponse::Deny
        });

    apply_platform(builder)
}

/// Safari's user agent, and a data store of the app's own, so the browser's
/// cookies and storage are kept apart from the app's own page.
#[cfg(target_os = "macos")]
fn apply_platform(builder: WebviewBuilder<Wry>) -> WebviewBuilder<Wry> {
    builder
        .user_agent(USER_AGENT)
        .data_store_identifier(DATA_STORE)
}

/// WebKitGTK and WebView2 name themselves as the browsers they are, and
/// keep a child webview's storage where Tauri puts it.
#[cfg(not(target_os = "macos"))]
fn apply_platform(builder: WebviewBuilder<Wry>) -> WebviewBuilder<Wry> {
    builder
}

/// Marks `id` as now under way to `target`: the tab's url becomes the
/// address right away, ahead of any page load event a doomed connection
/// would never reach, and a load-failure check is kicked off against it.
fn settle_on(browser: &Browser, app: &AppHandle, id: TabId, target: String) {
    let snapshot = {
        let mut tabs = browser.tabs.lock().unwrap();
        tabs.navigate_to(id, target.clone());
        tabs.snapshot()
    };
    emit_snapshot(app, &snapshot);
    check_reachable(id, target, app.clone());
}

/// Checks in the background whether `url`'s host answers, and records a
/// load failure on `id` if it is still there and still on `url` by the time
/// the answer comes back. Called with the address a navigation was actually
/// sent to, from [`settle_on`] and from `open_tab`: wry reports neither a
/// start nor an end for a navigation that never gets a response (and a
/// commit that swaps the tab to a different origin can even settle on
/// `about:blank` first), so a tab's own page-load event is not a fire point
/// this can wait on. Skipped for a target with no host to check against,
/// `about:` among them.
fn check_reachable(id: TabId, url: String, app: AppHandle) {
    let Some((host, port)) = navigation_target(&url) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let probe_host = host.clone();
        let outcome =
            tauri::async_runtime::spawn_blocking(move || probe(&probe_host, port, CONNECT_TIMEOUT))
                .await;
        let Ok(Err(failure)) = outcome else {
            return;
        };

        let message = connect_failure_message(&host, port, failure);
        let browser = app.state::<Arc<Browser>>();
        let (changed, snapshot) = {
            let mut tabs = browser.tabs.lock().unwrap();
            let changed = tabs.navigation_failed(id, &url, message);
            (changed, tabs.snapshot())
        };
        if changed {
            emit_snapshot(&app, &snapshot);
        }
    });
}

/// Whether `host:port` answers within `timeout`. Resolving the name and
/// connecting to it share the one deadline, so a slow resolver eats into
/// the time left to connect rather than escaping the timeout altogether.
fn probe(host: &str, port: u16, timeout: Duration) -> Result<(), ConnectFailure> {
    let deadline = Instant::now() + timeout;
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|_| ConnectFailure::Resolution)?
        .collect();
    if addrs.is_empty() {
        return Err(ConnectFailure::Resolution);
    }
    for addr in addrs {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ConnectFailure::Connection);
        }
        if TcpStream::connect_timeout(&addr, remaining).is_ok() {
            return Ok(());
        }
    }
    Err(ConnectFailure::Connection)
}

/// Refreshes `id`'s back/forward state from `webview` and emits the
/// snapshot. Runs as its own task so a slow read never holds up the page
/// load or title-change event it was asked from.
fn refresh_history(id: TabId, webview: Webview<Wry>, app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let (can_go_back, can_go_forward) = read_history(&webview).await;
        let browser = app.state::<Arc<Browser>>();
        let snapshot = {
            let mut tabs = browser.tabs.lock().unwrap();
            tabs.history(id, can_go_back, can_go_forward);
            tabs.snapshot()
        };
        emit_snapshot(&app, &snapshot);
    });
}

/// `canGoBack` and `canGoForward`, read from the `WKWebView` directly: wry
/// exposes no history query of its own on any platform.
#[cfg(target_os = "macos")]
async fn read_history(webview: &Webview<Wry>) -> (bool, bool) {
    let (tx, rx) = std::sync::mpsc::channel();
    if with_native_webview(webview, move |view| {
        let _ = tx.send(unsafe { (view.canGoBack(), view.canGoForward()) });
    })
    .is_err()
    {
        return (true, true);
    }
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(2)))
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or((true, true))
}

/// Wry exposes no history query outside macOS, so the buttons just stay
/// usable; a click that turns out to have nowhere to go is a no-op.
#[cfg(not(target_os = "macos"))]
async fn read_history(_webview: &Webview<Wry>) -> (bool, bool) {
    (true, true)
}

/// Runs `action` against `webview`'s `WKWebView`, reaching it the same way
/// the placement probe does to read from a child webview.
#[cfg(target_os = "macos")]
fn with_native_webview<F>(webview: &Webview<Wry>, action: F) -> Result<(), String>
where
    F: FnOnce(&objc2_web_kit::WKWebView) + Send + 'static,
{
    webview
        .with_webview(move |platform| unsafe {
            let view: &objc2_web_kit::WKWebView =
                &*(platform.inner() as *const objc2_web_kit::WKWebView);
            action(view);
        })
        .map_err(|e| e.to_string())
}

/// Opens a tab on `window`, builds its webview at the browser's last
/// placement if it is showing, and hides the tab that was active. Shared by
/// the `browser_open` command and by a tab's own `window.open`.
async fn open_tab(
    window: Window,
    app: AppHandle,
    browser: Arc<Browser>,
    url: Option<String>,
    opener: Opener,
) -> Result<Snapshot, String> {
    let start = match url {
        Some(raw) => Some(normalize_url(&raw)?),
        None => None,
    };

    // Two opens racing must not interleave building webviews.
    let _guard = browser.opening.lock().await;

    let (previous, id) = {
        let mut tabs = browser.tabs.lock().unwrap();
        let previous = tabs.active();
        let id = tabs.open(start.clone(), opener);
        (previous, id)
    };

    let (rect, showing) = {
        let place = browser.place.lock().unwrap();
        (place.rect, place.showing)
    };

    let page = start.unwrap_or_else(|| "about:blank".to_string());
    let page_url = page.parse::<Url>().map_err(|e| e.to_string())?;
    let builder = tab_webview(id, &page_url, &app);

    // A tab opened empty is a new tab, which the window's page draws
    // itself: its blank webview stays out of sight until it has an address.
    let (position, size, visible) = match (showing && page != "about:blank", rect) {
        (true, Some((x, y, w, h))) => (
            Position::Logical(LogicalPosition::new(x, y)),
            Size::Logical(LogicalSize::new(w, h)),
            true,
        ),
        _ => (
            Position::Logical(LogicalPosition::new(0.0, 0.0)),
            Size::Logical(LogicalSize::new(1.0, 1.0)),
            false,
        ),
    };

    let webview = match window.add_child(builder, position, size) {
        Ok(webview) => webview,
        Err(error) => {
            // A tab with no webview is nothing to show: it goes, and the
            // tab that was active is active again.
            let mut tabs = browser.tabs.lock().unwrap();
            tabs.close(id);
            if let Some(previous) = previous {
                tabs.activate(previous);
            }
            return Err(error.to_string());
        }
    };
    if !visible {
        webview.hide().map_err(|e| e.to_string())?;
    }

    if let Some(previous) = previous {
        if let Some(previous_webview) = window.get_webview(&previous.label()) {
            previous_webview.hide().map_err(|e| e.to_string())?;
        }
    }

    check_reachable(id, page, app.clone());

    let snapshot = browser.tabs.lock().unwrap().snapshot();
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

/// Places and shows `id`'s webview at the browser's last rectangle, if the
/// browser is currently showing one at all.
fn place_and_show(window: &Window, browser: &Browser, id: TabId) -> Result<(), String> {
    let (rect, showing) = {
        let place = browser.place.lock().unwrap();
        (place.rect, place.showing)
    };
    if !showing {
        return Ok(());
    }
    let (Some((x, y, w, h)), Some(webview)) = (rect, window.get_webview(&id.label())) else {
        return Ok(());
    };
    webview
        .set_bounds(Rect {
            position: Position::Logical(LogicalPosition::new(x, y)),
            size: Size::Logical(LogicalSize::new(w, h)),
        })
        .map_err(|e| e.to_string())?;
    webview.show().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_open(
    window: Window,
    app: AppHandle,
    browser: State<'_, Arc<Browser>>,
    url: Option<String>,
    session: Option<String>,
) -> Result<Snapshot, String> {
    let browser = Arc::clone(&browser);
    let opener = match session {
        Some(session) => Opener::Agent { session },
        None => Opener::User,
    };
    open_tab(window, app, browser, url, opener).await
}

#[tauri::command]
pub async fn browser_close(
    window: Window,
    app: AppHandle,
    browser: State<'_, Arc<Browser>>,
    id: u32,
) -> Result<Snapshot, String> {
    let browser = Arc::clone(&browser);
    let id = TabId::new(id);

    if let Some(webview) = window.get_webview(&id.label()) {
        webview.close().map_err(|e| e.to_string())?;
    }

    let active = {
        let mut tabs = browser.tabs.lock().unwrap();
        tabs.close(id);
        tabs.active()
    };
    if let Some(active) = active {
        place_and_show(&window, &browser, active)?;
    }

    let snapshot = browser.tabs.lock().unwrap().snapshot();
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub async fn browser_activate(
    window: Window,
    app: AppHandle,
    browser: State<'_, Arc<Browser>>,
    id: u32,
) -> Result<Snapshot, String> {
    let browser = Arc::clone(&browser);
    let id = TabId::new(id);

    let previous = {
        let mut tabs = browser.tabs.lock().unwrap();
        let previous = tabs.active();
        tabs.activate(id);
        previous
    };
    if previous != Some(id) {
        if let Some(previous) = previous {
            if let Some(webview) = window.get_webview(&previous.label()) {
                webview.hide().map_err(|e| e.to_string())?;
            }
        }
    }
    place_and_show(&window, &browser, id)?;

    let snapshot = browser.tabs.lock().unwrap().snapshot();
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub async fn browser_navigate(
    window: Window,
    app: AppHandle,
    browser: State<'_, Arc<Browser>>,
    id: u32,
    address: String,
) -> Result<(), String> {
    let id = TabId::new(id);
    let address = normalize_url(&address)?;
    let webview = window.get_webview(&id.label()).ok_or("no such tab")?;
    let url = address.parse::<Url>().map_err(|e| e.to_string())?;
    webview.navigate(url).map_err(|e| e.to_string())?;
    settle_on(&browser, &app, id, address);
    Ok(())
}

#[tauri::command]
pub async fn browser_back(window: Window, id: u32) -> Result<(), String> {
    let id = TabId::new(id);
    let webview = window.get_webview(&id.label()).ok_or("no such tab")?;
    step_back(&webview)
}

#[cfg(target_os = "macos")]
fn step_back(webview: &Webview<Wry>) -> Result<(), String> {
    with_native_webview(webview, |view| unsafe {
        view.goBack();
    })
}

#[cfg(not(target_os = "macos"))]
fn step_back(webview: &Webview<Wry>) -> Result<(), String> {
    webview.eval("history.back()").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_forward(window: Window, id: u32) -> Result<(), String> {
    let id = TabId::new(id);
    let webview = window.get_webview(&id.label()).ok_or("no such tab")?;
    step_forward(&webview)
}

#[cfg(target_os = "macos")]
fn step_forward(webview: &Webview<Wry>) -> Result<(), String> {
    with_native_webview(webview, |view| unsafe {
        view.goForward();
    })
}

#[cfg(not(target_os = "macos"))]
fn step_forward(webview: &Webview<Wry>) -> Result<(), String> {
    webview.eval("history.forward()").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_reload(window: Window, id: u32) -> Result<(), String> {
    let id = TabId::new(id);
    let webview = window.get_webview(&id.label()).ok_or("no such tab")?;
    webview.reload().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_home(
    window: Window,
    app: AppHandle,
    browser: State<'_, Arc<Browser>>,
    id: u32,
) -> Result<(), String> {
    let tab_id = TabId::new(id);
    let target = {
        let tabs = browser.tabs.lock().unwrap();
        let tab = tabs.get(tab_id).ok_or("no such tab")?;
        tab.home
            .clone()
            .unwrap_or_else(|| "about:blank".to_string())
    };
    let webview = window.get_webview(&tab_id.label()).ok_or("no such tab")?;
    let url = target.parse::<Url>().map_err(|e| e.to_string())?;
    webview.navigate(url).map_err(|e| e.to_string())?;
    settle_on(&browser, &app, tab_id, target);
    Ok(())
}

#[tauri::command]
pub async fn browser_place(
    window: Window,
    browser: State<'_, Arc<Browser>>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let browser = Arc::clone(&browser);
    {
        let mut place = browser.place.lock().unwrap();
        place.rect = Some((x, y, width, height));
        place.showing = true;
    }

    let active = browser.tabs.lock().unwrap().active();
    match active {
        Some(active) => place_and_show(&window, &browser, active),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn browser_hide(window: Window, browser: State<'_, Arc<Browser>>) -> Result<(), String> {
    let browser = Arc::clone(&browser);
    {
        let mut place = browser.place.lock().unwrap();
        place.showing = false;
    }

    let active = browser.tabs.lock().unwrap().active();
    if let Some(active) = active {
        if let Some(webview) = window.get_webview(&active.label()) {
            webview.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_tabs(browser: State<'_, Arc<Browser>>) -> Result<Snapshot, String> {
    Ok(browser.tabs.lock().unwrap().snapshot())
}
