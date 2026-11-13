//! The embedded browser's placement probe.
//!
//! Debug builds on macOS only: it drives the main webview's own commands the
//! way a person would, then reaches into AppKit directly to report what is
//! really on screen, whatever Tauri believes. There is no UI for this; it
//! exists so the placement math can be checked without a person at the
//! keyboard.
//!
//! `WORKBENCH_PROBE_STEPS` names a file of steps, one per line, run in
//! order a few seconds after startup. A line is `resize:<width>x<height>`,
//! which resizes the window, or otherwise a script evaluated in the main
//! webview, as a JSON string literal or as raw text;
//! `evalin:<label>:<script>` evaluates in the child webview of that label
//! instead, as a page's own script would run. A script may stash a
//! value on `window.__probe` for a later step to read, which is how a
//! promise's result crosses from one step to the next: evaluating a script
//! never waits for the promise it returns.
//!
//! Three more forms drive the keyboard and the pointer the way a person at
//! the machine would, rather than through a webview's own script: `focus:
//! <label>` makes that webview's platform view the window's first
//! responder (`main` for the main one); `key:<spec>` posts a key event to
//! the app as AppKit would deliver one typed at the keyboard, a spec like
//! `cmd+3`, `cmd+shift+ArrowDown`, `Escape` or `a`; `click:<label>` posts a
//! left mouse click at the centre of that webview's own frame. All three
//! reach the running app exactly as a real key press or click would, ahead
//! of whichever view currently holds the keyboard or sits under the
//! pointer.
//!
//! `window:<action>` acts on the main window the way the system or another
//! app would, without the app taking the keyboard unless asked: `focus`
//! activates the app and makes the window key; `float` raises the window
//! above other apps' windows without activating it; `at:<x>,<y>` moves its
//! top left corner to that point on screen; `cover` lays a plain window of
//! the app's own over it, which never takes the pointer or the keyboard,
//! and `uncover` takes that away; `minimise` and `restore` minimise it to
//! the Dock and bring it back; `state` reports whether the app is active,
//! whether the window is key, visible, covered or minimised, and which
//! view holds the keyboard.
//!
//! `shot:<tab id>` takes the tab's screenshot the way the agent's
//! `browser_screenshot` tool does, and reports the file, its size in
//! pixels, a digest of its bytes, how long it took and the time it was
//! done, or why it was refused. `quit` quits the app once the report is written.
//!
//! The probe never brings the app forward on its own; a step file that
//! needs the keyboard starts with `window:focus`.
//!
//! The report is written as pretty JSON to `WORKBENCH_PROBE_REPORT`
//! (default: `workbench-probe.json` in the system temp directory) and to
//! stderr.

use std::cell::RefCell;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSApplication, NSBackingStoreType, NSColor, NSEvent, NSEventModifierFlags, NSEventType,
    NSResponder, NSView, NSWindow, NSWindowStyleMask,
};
use objc2_foundation::{NSError, NSPoint, NSString};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Window};

/// Runs `wrapped` in `webview` as a top-level script and hands back its
/// result as JSON text, by reaching the `WKWebView` under Tauri's webview
/// handle to call `evaluateJavaScript:completionHandler:` directly, since
/// Tauri's own `eval` fires a script but never returns what it evaluated to.
async fn run_script(webview: &tauri::Webview, wrapped: String) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    webview
        .with_webview(move |platform| unsafe {
            let view: &objc2_web_kit::WKWebView =
                &*(platform.inner() as *const objc2_web_kit::WKWebView);
            let js = NSString::from_str(&wrapped);
            let block = block2::RcBlock::new(
                move |result: *mut objc2::runtime::AnyObject, error: *mut NSError| {
                    let outcome = if !error.is_null() {
                        let error: &NSError = &*error;
                        Err(error.localizedDescription().to_string())
                    } else if result.is_null() {
                        Ok("null".to_string())
                    } else {
                        let text: &NSString = &*(result as *const NSString);
                        Ok(text.to_string())
                    };
                    let _ = tx.send(outcome);
                },
            );
            view.evaluateJavaScript_completionHandler(&js, Some(&block));
        })
        .map_err(|e| e.to_string())?;

    let outcome =
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(10)))
            .await
            .map_err(|e| format!("the task failed: {e}"))?;

    match outcome {
        Ok(result) => result,
        Err(_) => Err("timed out waiting for the webview".to_string()),
    }
}

/// Runs `script` in `webview` and hands back its result as JSON text. The
/// script is wrapped so its value comes back through `JSON.stringify`,
/// reaching it by way of an indirect `eval` of a JSON-encoded string so
/// arbitrary text round-trips without hand-escaping. A page whose Content
/// Security Policy withholds `unsafe-eval` refuses this indirection outright
/// (WebKit reports it as a bare "A JavaScript exception occurred", with no
/// further detail); [`eval_in_page`] runs the script directly instead, for
/// exactly that case.
async fn eval_in(webview: &tauri::Webview, script: &str) -> Result<String, String> {
    let literal = serde_json::to_string(script).map_err(|e| e.to_string())?;
    let wrapped = format!("JSON.stringify((0,eval)({literal}))");
    run_script(webview, wrapped).await
}

/// Runs `script` in `webview` the way the page's own script would: as a
/// function body, with no indirection through `eval`, so a page whose
/// Content Security Policy withholds `unsafe-eval` still runs it. `script`
/// is trusted source text, not user input, so it is embedded as written
/// rather than JSON-encoded.
async fn eval_in_page(webview: &tauri::Webview, script: &str) -> Result<String, String> {
    let wrapped = format!(
        "(function(){{ try {{ return JSON.stringify((function(){{ {script} }})()); }} catch (e) {{ return JSON.stringify({{ error: String(e) }}); }} }})()"
    );
    run_script(webview, wrapped).await
}

/// Every webview AppKit holds in `window`, with its frame in points from
/// the content view's top left, whether it is hidden, and its url when
/// cheaply available.
async fn native_webviews(window: &tauri::Window) -> Value {
    fn walk(view: &NSView, top: f64, found: &mut Vec<Value>) {
        let name = view.class().name().to_string_lossy().to_string();
        if name.contains("WebView") {
            let frame = view.convertRect_toView(view.bounds(), None);
            // `view` is dynamically a `WKWebView`, named as much above; the
            // cast reaches its `URL` property the same way `eval_in` reaches
            // `evaluateJavaScript:`.
            let url = unsafe {
                let webview = &*(view as *const NSView as *const objc2_web_kit::WKWebView);
                webview.URL()
            }
            .and_then(|url| url.absoluteString())
            .map(|s| s.to_string());
            found.push(json!({
                "class": name,
                "x": frame.origin.x,
                "y": top - frame.origin.y - frame.size.height,
                "width": frame.size.width,
                "height": frame.size.height,
                "hidden": view.isHiddenOrHasHiddenAncestor(),
                "url": url,
            }));
            return;
        }
        for child in view.subviews().iter() {
            walk(&child, top, found);
        }
    }

    let (tx, rx) = mpsc::channel();
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let mut found = Vec::new();
        if let Ok(ptr) = target.ns_window() {
            let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
            if let Some(content) = ns_window.contentView() {
                let top = content.frame().size.height;
                if let Some(root) = unsafe { content.superview() } {
                    walk(&root, top, &mut found);
                } else {
                    walk(&content, top, &mut found);
                }
            }
        }
        let _ = tx.send(found);
    });
    let found =
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(5))).await;
    match found {
        Ok(Ok(found)) => json!(found),
        _ => json!("could not read the window's views"),
    }
}

/// Makes the webview labelled `label` the window's first responder, the way
/// a click into it would, without a click. `main` names the main webview.
async fn focus_webview(window: &Window, label: &str) -> Result<String, String> {
    let webview = window
        .get_webview(label)
        .ok_or_else(|| format!("no webview labelled {label}"))?;
    let window_ptr = window.ns_window().map_err(|e| e.to_string())? as usize;

    let (tx, rx) = mpsc::channel::<bool>();
    webview
        .with_webview(move |platform| unsafe {
            let view: &NSView = &*(platform.inner() as *const NSView);
            let ns_window: &NSWindow = &*(window_ptr as *const NSWindow);
            let responder: &NSResponder = view;
            let _ = tx.send(ns_window.makeFirstResponder(Some(responder)));
        })
        .map_err(|e| e.to_string())?;

    let outcome =
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(5)))
            .await
            .map_err(|e| format!("the task failed: {e}"))?;
    match outcome {
        Ok(true) => Ok("focused".to_string()),
        Ok(false) => Err("first responder refused".to_string()),
        Err(_) => Err("timed out waiting for the webview".to_string()),
    }
}

/// AppKit's virtual key codes for the letters, digits and punctuation a US
/// keyboard's main rows carry, the ones [`key_spec`] cannot name from the
/// key itself.
const LETTER_KEY_CODES: &[(char, u16)] = &[
    ('a', 0),
    ('s', 1),
    ('d', 2),
    ('f', 3),
    ('h', 4),
    ('g', 5),
    ('z', 6),
    ('x', 7),
    ('c', 8),
    ('v', 9),
    ('b', 11),
    ('q', 12),
    ('w', 13),
    ('e', 14),
    ('r', 15),
    ('y', 16),
    ('t', 17),
    ('1', 18),
    ('2', 19),
    ('3', 20),
    ('4', 21),
    ('6', 22),
    ('5', 23),
    ('=', 24),
    ('9', 25),
    ('7', 26),
    ('-', 27),
    ('8', 28),
    ('0', 29),
    (']', 30),
    ('o', 31),
    ('u', 32),
    ('[', 33),
    ('i', 34),
    ('p', 35),
    ('l', 37),
    ('j', 38),
    ('\'', 39),
    ('k', 40),
    (';', 41),
    ('\\', 42),
    (',', 43),
    ('/', 44),
    ('n', 45),
    ('m', 46),
    ('.', 47),
    ('`', 50),
];

/// The characters and key code a synthetic `NSEvent` needs for the key
/// `name` names: the arrows and the named keys by their own constant, a
/// single character from [`LETTER_KEY_CODES`] otherwise.
fn key_spec(name: &str) -> Option<(String, u16)> {
    Some(match name {
        "Escape" => ("\u{1b}".to_string(), 53),
        "Enter" | "Return" => ("\r".to_string(), 36),
        "Tab" => ("\t".to_string(), 48),
        "Space" | " " => (" ".to_string(), 49),
        "ArrowLeft" => ("\u{f702}".to_string(), 123),
        "ArrowRight" => ("\u{f703}".to_string(), 124),
        "ArrowDown" => ("\u{f701}".to_string(), 125),
        "ArrowUp" => ("\u{f700}".to_string(), 126),
        _ => {
            let mut chars = name.chars();
            let c = chars.next()?;
            if chars.next().is_some() {
                return None;
            }
            let lower = c.to_ascii_lowercase();
            let code = LETTER_KEY_CODES.iter().find(|(k, _)| *k == lower)?.1;
            (c.to_string(), code)
        }
    })
}

/// Parses a `key:` step's spec, `cmd+shift+ArrowDown` and the like: every
/// part but the last names a modifier, and the last names the key.
fn parse_key_spec(spec: &str) -> Result<(NSEventModifierFlags, String, u16), String> {
    let mut parts: Vec<&str> = spec.split('+').collect();
    let name = parts
        .pop()
        .filter(|s| !s.is_empty())
        .ok_or("empty key spec")?;
    let mut flags = NSEventModifierFlags::empty();
    for part in parts {
        flags |= match part {
            "cmd" => NSEventModifierFlags::Command,
            "shift" => NSEventModifierFlags::Shift,
            "alt" | "option" => NSEventModifierFlags::Option,
            "ctrl" | "control" => NSEventModifierFlags::Control,
            other => return Err(format!("unknown modifier {other}")),
        };
    }
    let (chars, code) = key_spec(name).ok_or_else(|| format!("unknown key {name}"))?;
    Ok((flags, chars, code))
}

/// Posts a key down and a key up for `spec` to the app, the way AppKit
/// would deliver one actually typed: ahead of whichever view holds the
/// keyboard, ordinary key handling included.
async fn post_key(window: &Window, spec: &str) -> Result<String, String> {
    let (flags, chars, code) = parse_key_spec(spec)?;
    let target = window.clone();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(post_key_events(&target, flags, &chars, code));
        })
        .map_err(|e| e.to_string())?;

    let outcome =
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(5)))
            .await
            .map_err(|e| format!("the task failed: {e}"))?;
    match outcome {
        Ok(result) => result.map(|()| "posted".to_string()),
        Err(_) => Err("timed out waiting to post the event".to_string()),
    }
}

/// Runs on the main thread: builds the key down and key up `NSEvent`s and
/// posts them ahead of the queue, the way a real key press arrives.
fn post_key_events(
    window: &Window,
    flags: NSEventModifierFlags,
    chars: &str,
    code: u16,
) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
    let ptr = window.ns_window().map_err(|e| e.to_string())?;
    let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    let window_number = ns_window.windowNumber();
    let app = NSApplication::sharedApplication(mtm);
    let characters = NSString::from_str(chars);

    for event_type in [NSEventType::KeyDown, NSEventType::KeyUp] {
        let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            event_type,
            NSPoint::ZERO,
            flags,
            0.0,
            window_number,
            None,
            &characters,
            &characters,
            false,
            code,
        )
        .ok_or("could not build the key event")?;
        app.postEvent_atStart(&event, false);
    }
    Ok(())
}

/// Posts a left mouse click, down then up, at the centre of the webview
/// labelled `label`'s own frame: the closest a script can come to a person
/// clicking into a tab with the pointer.
async fn post_click(window: &Window, label: &str) -> Result<String, String> {
    let webview = window
        .get_webview(label)
        .ok_or_else(|| format!("no webview labelled {label}"))?;
    let target = window.clone();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(post_click_events(&target, &webview));
        })
        .map_err(|e| e.to_string())?;

    let outcome =
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(5)))
            .await
            .map_err(|e| format!("the task failed: {e}"))?;
    match outcome {
        Ok(result) => result.map(|()| "clicked".to_string()),
        Err(_) => Err("timed out waiting to post the event".to_string()),
    }
}

/// Runs on the main thread: reads `webview`'s own frame directly from
/// AppKit, then builds and posts the click at its centre.
fn post_click_events(window: &Window, webview: &tauri::Webview) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
    let ptr = window.ns_window().map_err(|e| e.to_string())?;
    let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    let window_number = ns_window.windowNumber();

    let (tx, rx) = mpsc::channel::<NSPoint>();
    webview
        .with_webview(move |platform| unsafe {
            let view: &NSView = &*(platform.inner() as *const NSView);
            let frame = view.convertRect_toView(view.bounds(), None);
            let point = NSPoint::new(
                frame.origin.x + frame.size.width / 2.0,
                frame.origin.y + frame.size.height / 2.0,
            );
            let _ = tx.send(point);
        })
        .map_err(|e| e.to_string())?;
    let point = rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "could not read the webview's frame".to_string())?;

    let app = NSApplication::sharedApplication(mtm);
    for event_type in [NSEventType::LeftMouseDown, NSEventType::LeftMouseUp] {
        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            event_type,
            point,
            NSEventModifierFlags::empty(),
            0.0,
            window_number,
            None,
            0,
            1,
            1.0,
        )
        .ok_or("could not build the click event")?;
        app.postEvent_atStart(&event, false);
    }
    Ok(())
}

thread_local! {
    /// The window `window:cover` lays over the main one. Only the main
    /// thread touches it.
    static COVER: RefCell<Option<Retained<NSWindow>>> = const { RefCell::new(None) };
}

/// Runs `action` on the main thread and hands back what it answered.
async fn on_main<T: Send + 'static>(
    window: &Window,
    action: impl FnOnce(MainThreadMarker, &NSWindow) -> T + Send + 'static,
) -> Result<T, String> {
    let ptr = window.ns_window().map_err(|e| e.to_string())? as usize;
    let (tx, rx) = mpsc::channel();
    window
        .run_on_main_thread(move || {
            let mtm = MainThreadMarker::new().expect("run on the main thread");
            let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
            let _ = tx.send(action(mtm, ns_window));
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(5)))
        .await
        .map_err(|e| format!("the task failed: {e}"))?
        .map_err(|_| "timed out on the main thread".to_string())
}

/// A `window:` step: see the module's own documentation for each action.
async fn window_step(window: &Window, action: &str) -> Result<Value, String> {
    if let Some(point) = action.strip_prefix("at:") {
        let mut parts = point.split(',').filter_map(|part| part.parse::<f64>().ok());
        let (Some(x), Some(y)) = (parts.next(), parts.next()) else {
            return Err("at: needs <x>,<y>".to_string());
        };
        window
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        return Ok(json!("moved"));
    }
    match action {
        "focus" => {
            window.set_focus().map_err(|e| e.to_string())?;
            Ok(json!("focused"))
        }
        "minimise" => {
            window.minimize().map_err(|e| e.to_string())?;
            Ok(json!("minimised"))
        }
        "restore" => {
            window.unminimize().map_err(|e| e.to_string())?;
            Ok(json!("restored"))
        }
        "float" => {
            on_main(window, |_, ns_window| {
                ns_window.setLevel(objc2_app_kit::NSFloatingWindowLevel);
                ns_window.orderFrontRegardless();
                json!("floating")
            })
            .await
        }
        "cover" => {
            on_main(window, |mtm, ns_window| {
                let cover = COVER.with_borrow_mut(|cover| {
                    cover
                        .get_or_insert_with(|| unsafe {
                            let cover = NSWindow::initWithContentRect_styleMask_backing_defer(
                                mtm.alloc::<NSWindow>(),
                                ns_window.frame(),
                                NSWindowStyleMask::Borderless,
                                NSBackingStoreType::Buffered,
                                false,
                            );
                            cover.setReleasedWhenClosed(false);
                            cover.setIgnoresMouseEvents(true);
                            cover.setBackgroundColor(Some(&NSColor::grayColor()));
                            cover
                        })
                        .clone()
                });
                cover.setFrame_display(ns_window.frame(), true);
                cover.setLevel(ns_window.level() + 1);
                cover.orderFrontRegardless();
                json!("covered")
            })
            .await
        }
        "uncover" => {
            on_main(window, |_, _| {
                COVER.with_borrow(|cover| {
                    if let Some(cover) = cover {
                        cover.orderOut(None);
                    }
                });
                json!("uncovered")
            })
            .await
        }
        "state" => {
            let views: Vec<(String, usize)> = {
                let mut views = Vec::new();
                for webview in window.webviews() {
                    let (tx, rx) = mpsc::channel();
                    let label = webview.label().to_string();
                    let _ = webview.with_webview(move |platform| {
                        let _ = tx.send(platform.inner() as usize);
                    });
                    let ptr = tauri::async_runtime::spawn_blocking(move || {
                        rx.recv_timeout(Duration::from_secs(5))
                    })
                    .await;
                    if let Ok(Ok(ptr)) = ptr {
                        views.push((label, ptr));
                    }
                }
                views
            };
            on_main(window, move |mtm, ns_window| {
                let app = NSApplication::sharedApplication(mtm);
                let responder = ns_window.firstResponder();
                let holder = responder.as_ref().map(|responder| {
                    let ptr = Retained::as_ptr(responder) as usize;
                    views
                        .iter()
                        .find(|(_, view)| *view == ptr)
                        .map(|(label, _)| label.clone())
                        .unwrap_or_else(|| responder.class().name().to_string_lossy().to_string())
                });
                json!({
                    "appActive": app.isActive(),
                    "key": ns_window.isKeyWindow(),
                    "visible": ns_window.isVisible(),
                    "unoccluded": ns_window.occlusionState().contains(
                        objc2_app_kit::NSWindowOcclusionState::Visible
                    ),
                    "minimised": ns_window.isMiniaturized(),
                    "keyboard": holder,
                })
            })
            .await
        }
        other => Err(format!("unknown window action {other}")),
    }
}

/// The width and height a PNG's header gives.
fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let header = bytes.get(16..24)?;
    let width = u32::from_be_bytes(header[0..4].try_into().ok()?);
    let height = u32::from_be_bytes(header[4..8].try_into().ok()?);
    Some((width, height))
}

/// A 64-bit FNV-1a digest of `bytes`: enough to tell two images apart.
fn digest(bytes: &[u8]) -> String {
    let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
    });
    format!("{hash:016x}")
}

/// A `shot:` step: the tab's screenshot, as `browser_screenshot` takes it.
async fn shot(window: &Window, id: &str) -> Result<Value, String> {
    let id: u32 = id
        .trim()
        .parse()
        .map_err(|_| "shot: needs a tab id".to_string())?;
    let browser = Arc::clone(&window.app_handle().state::<Arc<crate::browser::Browser>>());
    let started = Instant::now();
    let path = crate::browser_page::screenshot(window, &browser, Some(id)).await?;
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or(0);
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(json!({
        "path": path,
        "pixels": png_size(&bytes),
        "digest": digest(&bytes),
        "ms": (elapsed * 10.0).round() / 10.0,
        "at": at,
    }))
}

/// Runs the steps named by `steps_path` against the main window and webview,
/// recording what changed after each one. A step is `resize:<W>x<H>`,
/// `focus:<label>`, `key:<spec>`, `click:<label>`, `window:<action>`,
/// `shot:<tab id>`, `quit`, `evalin:<label>:<script>` to run `script` as a
/// function body (an explicit `return` captures a value) in the webview
/// `label` names, without going by way of `eval`, or otherwise `script` run
/// in the main webview. Answers with the report and whether a `quit` step
/// asked for the app to quit.
async fn run_steps(window: tauri::Window, main: tauri::Webview, steps_path: &str) -> (Value, bool) {
    let text = std::fs::read_to_string(steps_path).unwrap_or_default();
    let mut steps = Vec::new();
    let mut quit = false;

    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let script: String = serde_json::from_str(line).unwrap_or_else(|_| line.to_string());

        let result = if let Some(size) = script.strip_prefix("resize:") {
            let mut parts = size.split('x').filter_map(|part| part.parse::<f64>().ok());
            let width = parts.next().unwrap_or(1200.0);
            let height = parts.next().unwrap_or(800.0);
            format!(
                "{:?}",
                window.set_size(tauri::LogicalSize::new(width, height))
            )
        } else if let Some(rest) = script.strip_prefix("evalin:") {
            match rest.split_once(':') {
                Some((label, script)) => match window.get_webview(label) {
                    Some(webview) => format!("{:?}", eval_in_page(&webview, script).await),
                    None => format!("no webview labelled {label}"),
                },
                None => "evalin: needs a label and a script, separated by a colon".to_string(),
            }
        } else if let Some(label) = script.strip_prefix("focus:") {
            format!("{:?}", focus_webview(&window, label).await)
        } else if let Some(spec) = script.strip_prefix("key:") {
            format!("{:?}", post_key(&window, spec).await)
        } else if let Some(label) = script.strip_prefix("click:") {
            format!("{:?}", post_click(&window, label).await)
        } else if let Some(action) = script.strip_prefix("window:") {
            format!("{:?}", window_step(&window, action).await)
        } else if let Some(id) = script.strip_prefix("shot:") {
            format!("{:?}", shot(&window, id).await)
        } else if script.trim() == "quit" {
            quit = true;
            "the app quits once the report is written".to_string()
        } else {
            format!("{:?}", eval_in(&main, &script).await)
        };

        std::thread::sleep(Duration::from_millis(1500));

        steps.push(json!({
            "step": script,
            "result": result,
            "native": native_webviews(&window).await,
            "tauri": window
                .webviews()
                .iter()
                .map(|webview| webview.label().to_string())
                .collect::<Vec<_>>(),
        }));
    }

    (json!({ "steps": steps }), quit)
}

async fn run_probe(app: AppHandle, steps_path: String) {
    // WebKit defers resize events in a background window.
    std::thread::sleep(Duration::from_secs(3));

    let Some(window) = app.get_window("main") else {
        write_report(&json!({ "error": "no main window" }));
        return;
    };
    let Some(main) = app.get_webview("main") else {
        write_report(&json!({ "error": "no main webview" }));
        return;
    };

    let (report, quit) = run_steps(window, main, &steps_path).await;
    write_report(&report);
    if quit {
        app.exit(0);
    }
}

fn write_report(value: &Value) {
    let path = std::env::var("WORKBENCH_PROBE_REPORT").unwrap_or_else(|_| {
        std::env::temp_dir()
            .join("workbench-probe.json")
            .to_string_lossy()
            .to_string()
    });
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string());
    let _ = std::fs::write(&path, &text);
    eprintln!("{text}");
}

/// Whether the probe is to run: the app then starts without taking the
/// keyboard from whatever app the user is in.
pub fn wanted() -> bool {
    std::env::var_os("WORKBENCH_PROBE_STEPS").is_some()
}

/// If `WORKBENCH_PROBE_STEPS` names a file, runs it against the app a few
/// seconds after startup and writes a report of what happened.
pub fn maybe_run_probe(app: &AppHandle) {
    let Ok(steps_path) = std::env::var("WORKBENCH_PROBE_STEPS") else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move { run_probe(app, steps_path).await });
}
