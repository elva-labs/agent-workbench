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

use std::sync::{Arc, Mutex};

use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, State, Url,
    WebviewUrl, Window, Wry,
};
use workbench_core::browser::{normalize_url, Opener, Snapshot, TabId, Tabs};

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
        // A frame inside the page asks here too, so the tab's own address
        // is taken from the page load below, which is the top frame's alone.
        .on_navigation(navigation_allowed)
        .on_page_load(move |_webview, payload| {
            let browser = load_app.state::<Arc<Browser>>();
            let url = payload.url().to_string();
            let snapshot = {
                let mut tabs = browser.tabs.lock().unwrap();
                match payload.event() {
                    PageLoadEvent::Started => tabs.navigation_started(id, url),
                    PageLoadEvent::Finished => tabs.navigation_finished(id, url),
                };
                tabs.snapshot()
            };
            emit_snapshot(&load_app, &snapshot);
        })
        .on_document_title_changed(move |_webview, title| {
            let browser = title_app.state::<Arc<Browser>>();
            let snapshot = {
                let mut tabs = browser.tabs.lock().unwrap();
                tabs.titled(id, title);
                tabs.snapshot()
            };
            emit_snapshot(&title_app, &snapshot);
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

    let (position, size, visible) = match (showing, rect) {
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
pub async fn browser_navigate(window: Window, id: u32, address: String) -> Result<(), String> {
    let id = TabId::new(id);
    let address = normalize_url(&address)?;
    let webview = window.get_webview(&id.label()).ok_or("no such tab")?;
    let url = address.parse::<Url>().map_err(|e| e.to_string())?;
    webview.navigate(url).map_err(|e| e.to_string())
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
