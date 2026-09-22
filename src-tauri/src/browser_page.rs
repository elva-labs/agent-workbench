//! What a coding agent needs to see and drive a page inside a browser tab:
//! running script in it, reading its console, a text snapshot of what is on
//! it, and driving it by click and type.
//!
//! Every command names a tab by `id`, or `None` for whichever one is
//! active. macOS only, on WKWebView's content worlds:
//! [`browser_eval`] runs in the page's own world, since it is the agent's
//! escape hatch into the page's globals and needs to see what the page
//! itself put there. The console capture also runs in the page world,
//! since that is where a page's own `console` calls happen, but a
//! snapshot, a click and a type run in a content world of their own, so a
//! page can neither see nor tamper with the script driving it. On another
//! platform every command compiles and answers with a plain "not
//! supported" error.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::{State, Window};
#[cfg(target_os = "macos")]
use workbench_core::browser::TabId;

use crate::browser::Browser;

/// A console message a tab's page produced.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleEntry {
    pub level: String,
    pub text: String,
    pub time: i64,
    pub url: String,
}

/// The property `browser_console` reads a tab's console buffer through: a
/// long, unguessable name so a page is unlikely to stumble on it by
/// accident, defined non-enumerable in [`CONSOLE_CAPTURE_SCRIPT`] so
/// `for...in` and `Object.keys` do not turn it up either. Must match the
/// property [`CONSOLE_CAPTURE_SCRIPT`] defines.
#[cfg(target_os = "macos")]
const CONSOLE_ACCESSOR: &str = "__workbench_console_e6f2a9c4d8b14f6c9a2e7b3f1d5c8a90";

/// Wraps `console.log/info/warn/error/debug`, listens for `error` in the
/// capture phase (which catches a resource's load failure as well as a
/// script exception, since only the former fails to bubble) and for
/// `unhandledrejection`, keeping the last 500 entries in a closure rather
/// than on a guessable global. Added to every tab's webview in
/// `tab_webview`, so it is on the page's console from the first line.
pub const CONSOLE_CAPTURE_SCRIPT: &str = r#"(function () {
  var entries = [];
  function record(level, text) {
    try {
      entries.push({ level: level, text: text, time: Date.now(), url: String(location.href) });
      if (entries.length > 500) entries.shift();
    } catch (e) {}
  }
  function describe(args) {
    return Array.prototype.map
      .call(args, function (a) {
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch (e) {
          return String(a);
        }
      })
      .join(" ");
  }
  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var original = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      record(level, describe(arguments));
      return original.apply(console, arguments);
    };
  });
  window.addEventListener(
    "error",
    function (event) {
      var target = event.target;
      if (target && target !== window && target.tagName) {
        var src = target.src || target.href || "";
        record("error", "failed to load " + target.tagName.toLowerCase() + (src ? " " + src : ""));
        return;
      }
      record("error", event.message + " (" + event.filename + ":" + event.lineno + ":" + event.colno + ")");
    },
    true
  );
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    record("error", "Unhandled rejection: " + (reason && reason.message ? reason.message : String(reason)));
  });
  Object.defineProperty(window, "__workbench_console_e6f2a9c4d8b14f6c9a2e7b3f1d5c8a90", {
    value: function (clear) {
      var out = entries;
      if (clear) entries = [];
      return out;
    },
    enumerable: false,
    configurable: false,
  });
})();"#;

/// The text a snapshot builds runs in this named content world, apart from
/// the page's own, so a page can neither see nor tamper with the script
/// that builds it or the one a click or a type later runs.
#[cfg(target_os = "macos")]
const APP_WORLD: &str = "workbench-app";

/// The attribute [`SNAPSHOT_SCRIPT`] writes a ref onto its element as, for
/// [`click_script`] and [`type_script`] to find it by. A content world's
/// own JavaScript state does not survive from one call to the next, even
/// within the same call to `browser_snapshot` and the `browser_click` right
/// after it, so the ref map lives on the DOM itself, not a JS global: the
/// one thing that reliably carries over. Must match the attribute
/// [`SNAPSHOT_SCRIPT`] writes.
#[cfg(target_os = "macos")]
const REF_ATTR: &str = "data-workbench-ref";

/// [`browser_snapshot`]'s script: builds the tree and the ref map click and
/// type read from, run in [`APP_WORLD`].
#[cfg(target_os = "macos")]
const SNAPSHOT_SCRIPT: &str = include_str!("browser_page/snapshot.js");

/// The tab `id` names, or the active one for `None`, with its webview.
#[cfg(target_os = "macos")]
fn resolve_tab(
    window: &Window,
    browser: &Browser,
    id: Option<u32>,
) -> Result<(TabId, tauri::Webview<tauri::Wry>), String> {
    let tab_id = match id {
        Some(id) => TabId::new(id),
        None => browser.active().ok_or("no tab is open")?,
    };
    let webview = window.get_webview(&tab_id.label()).ok_or("no such tab")?;
    Ok((tab_id, webview))
}

/// Parses the JSON text an app-world script answers with: `null` for
/// success, or `{ "error": "..." }` for a failure the script saw itself,
/// a stale ref among them.
#[cfg(target_os = "macos")]
fn ok_or_message(json: &str) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    match value.get("error").and_then(serde_json::Value::as_str) {
        Some(message) => Err(message.to_string()),
        None => Ok(()),
    }
}

/// Runs `body` as the body of an async function in `webview`'s page world,
/// and waits up to ten seconds for the result. `body`'s value comes back as
/// JSON text (`"null"` for `undefined`), by wrapping it so it is always
/// `JSON.stringify`'d before it crosses back into Rust: the completion
/// handler otherwise hands back an arbitrary object, not a string. A script
/// that throws is reported by WebKit's own completion handler, which for a
/// script run this way typically means a bare "A JavaScript exception
/// occurred" with no further detail (the same as `evaluateJavaScript`'s),
/// so a script that wants a specific message returns one instead of
/// throwing.
///
/// `callAsyncJavaScript` wraps its function body in a fresh function scope
/// on every call: a `var` or a `window.x = ...` a call makes does not carry
/// over to a later call, even in the same named world, unlike a plain
/// top-level script. That rules it out for anything that needs to leave
/// state for a later call to find, so it is used for the page's own world
/// alone, where nothing here needs to; [`eval_in_app_world`] uses
/// `evaluateJavaScript` for that reason.
#[cfg(target_os = "macos")]
async fn call_in_page_world(
    webview: &tauri::Webview<tauri::Wry>,
    body: &str,
) -> Result<String, String> {
    let wrapped = format!(
        "const __v = await (async () => {{ {body} }})(); return JSON.stringify(__v === undefined ? null : __v);"
    );

    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    webview
        .with_webview(move |platform| unsafe {
            let view: &objc2_web_kit::WKWebView =
                &*(platform.inner() as *const objc2_web_kit::WKWebView);
            let mtm = objc2::MainThreadMarker::new()
                .expect("with_webview always runs on the main thread");
            let world = objc2_web_kit::WKContentWorld::pageWorld(mtm);
            let js = objc2_foundation::NSString::from_str(&wrapped);
            let block = block2::RcBlock::new(
                move |result: *mut objc2::runtime::AnyObject,
                      error: *mut objc2_foundation::NSError| {
                    let outcome = if !error.is_null() {
                        let error: &objc2_foundation::NSError = &*error;
                        Err(error.localizedDescription().to_string())
                    } else if result.is_null() {
                        Ok("null".to_string())
                    } else {
                        let text: &objc2_foundation::NSString =
                            &*(result as *const objc2_foundation::NSString);
                        Ok(text.to_string())
                    };
                    let _ = tx.send(outcome);
                },
            );
            view.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                &js,
                None,
                None,
                &world,
                Some(&block),
            );
        })
        .map_err(|e| e.to_string())?;

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(10))
    })
    .await
    .map_err(|e| format!("the task failed: {e}"))?;

    match outcome {
        Ok(result) => result,
        Err(_) => Err("timed out running the script".to_string()),
    }
}

/// Runs `body` as a top-level script in `webview`'s [`APP_WORLD`] and waits
/// up to ten seconds for the result. `body` is wrapped in a function so
/// `return` works, and the call is the script's last statement, so its
/// value is what the script evaluates to. Nothing a script leaves on the
/// world's globals is there for the next call, which is why refs live on
/// the DOM.
#[cfg(target_os = "macos")]
async fn eval_in_app_world(
    webview: &tauri::Webview<tauri::Wry>,
    body: &str,
) -> Result<String, String> {
    let wrapped = format!(
        "(function () {{ var __v = (function () {{ {body} }})(); return JSON.stringify(__v === undefined ? null : __v); }})()"
    );

    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    webview
        .with_webview(move |platform| unsafe {
            let view: &objc2_web_kit::WKWebView =
                &*(platform.inner() as *const objc2_web_kit::WKWebView);
            let mtm = objc2::MainThreadMarker::new()
                .expect("with_webview always runs on the main thread");
            let name = objc2_foundation::NSString::from_str(APP_WORLD);
            let world = objc2_web_kit::WKContentWorld::worldWithName(&name, mtm);
            let js = objc2_foundation::NSString::from_str(&wrapped);
            let block = block2::RcBlock::new(
                move |result: *mut objc2::runtime::AnyObject,
                      error: *mut objc2_foundation::NSError| {
                    let outcome = if !error.is_null() {
                        let error: &objc2_foundation::NSError = &*error;
                        Err(error.localizedDescription().to_string())
                    } else if result.is_null() {
                        Ok("null".to_string())
                    } else {
                        let text: &objc2_foundation::NSString =
                            &*(result as *const objc2_foundation::NSString);
                        Ok(text.to_string())
                    };
                    let _ = tx.send(outcome);
                },
            );
            view.evaluateJavaScript_inFrame_inContentWorld_completionHandler(
                &js,
                None,
                &world,
                Some(&block),
            );
        })
        .map_err(|e| e.to_string())?;

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(10))
    })
    .await
    .map_err(|e| format!("the task failed: {e}"))?;

    match outcome {
        Ok(result) => result,
        Err(_) => Err("timed out running the script".to_string()),
    }
}

/// `reference` as a JSON string literal, safe to splice into a script
/// verbatim; falls back to an empty literal on the JSON encoder's only
/// failure mode, a string that cannot occur here.
#[cfg(target_os = "macos")]
fn json_literal(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// The element a snapshot marked with `reference`, as a JS expression
/// evaluating to it or to `null`.
#[cfg(target_os = "macos")]
fn find_by_ref(reference: &str) -> String {
    let reference = json_literal(reference);
    format!(r#"document.querySelector("[{REF_ATTR}=" + JSON.stringify({reference}) + "]")"#)
}

/// [`browser_click`]'s script: looks `reference` up by [`REF_ATTR`], scrolls
/// it into view, and clicks it. The press and the release are dispatched at
/// the element's centre for whatever listens for them, and the click itself
/// is the element's own `.click()`: that runs the default action too,
/// following a link, submitting a form, a label passing to its control,
/// which a dispatched `click` event does not. One thing clicks the element.
#[cfg(target_os = "macos")]
fn click_script(reference: &str) -> String {
    let find = find_by_ref(reference);
    format!(
        r#"
        var el = {find};
        if (!el || !el.isConnected) return {{ error: "no such element; take a new snapshot" }};
        el.scrollIntoView({{ block: "center", inline: "center" }});
        var r = el.getBoundingClientRect();
        var cx = r.left + r.width / 2;
        var cy = r.top + r.height / 2;
        var opts = {{ bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }};
        ["pointerdown", "mousedown", "pointerup", "mouseup"].forEach(function (type) {{
          var Ctor = type.indexOf("pointer") === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
          el.dispatchEvent(new Ctor(type, opts));
        }});
        el.click();
        return null;
        "#
    )
}

/// [`browser_type`]'s script: looks `reference` up, focuses it, and sets
/// its text. A `contenteditable` element gets `textContent` plus an
/// `input` event; an `input` or a `textarea` gets its value set through
/// its own prototype's native setter, so a framework watching the property
/// notices, then `input` and `change`. With `submit`, an Enter key is
/// dispatched and the element's form, if it has one, is asked to submit.
#[cfg(target_os = "macos")]
fn type_script(reference: &str, text: &str, submit: bool) -> String {
    let find = find_by_ref(reference);
    let text = json_literal(text);
    format!(
        r#"
        var el = {find};
        if (!el || !el.isConnected) return {{ error: "no such element; take a new snapshot" }};
        var text = {text};
        el.focus();
        if (el.isContentEditable) {{
          el.textContent = text;
          el.dispatchEvent(new Event("input", {{ bubbles: true }}));
        }} else {{
          var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(el, text);
          el.dispatchEvent(new Event("input", {{ bubbles: true }}));
          el.dispatchEvent(new Event("change", {{ bubbles: true }}));
        }}
        if ({submit}) {{
          ["keydown", "keypress", "keyup"].forEach(function (type) {{
            el.dispatchEvent(
              new KeyboardEvent(type, {{ bubbles: true, cancelable: true, key: "Enter", code: "Enter" }})
            );
          }});
          if (el.form) el.form.requestSubmit();
        }}
        return null;
        "#
    )
}

/// The directory screenshots are written under, inside the system temp
/// directory.
#[cfg(target_os = "macos")]
fn screenshot_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("workbench-browser")
}

/// Deletes every file in `dir` older than a day, so screenshots do not pile
/// up across sessions.
#[cfg(target_os = "macos")]
fn prune_old_screenshots(dir: &std::path::Path) {
    let cutoff = match std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(24 * 60 * 60))
    {
        Some(cutoff) => cutoff,
        None => return,
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if modified < cutoff {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn browser_eval(
    window: Window,
    browser: State<'_, Arc<Browser>>,
    id: Option<u32>,
    script: String,
) -> Result<String, String> {
    let (_, webview) = resolve_tab(&window, browser.inner(), id)?;
    call_in_page_world(&webview, &script).await
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn browser_console(
    window: Window,
    browser: State<'_, Arc<Browser>>,
    id: Option<u32>,
    clear: Option<bool>,
) -> Result<Vec<ConsoleEntry>, String> {
    let (_, webview) = resolve_tab(&window, browser.inner(), id)?;
    let clear = clear.unwrap_or(true);
    let script = format!("return window.{CONSOLE_ACCESSOR}({clear});");
    let json = call_in_page_world(&webview, &script).await?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn browser_snapshot(
    window: Window,
    browser: State<'_, Arc<Browser>>,
    id: Option<u32>,
) -> Result<String, String> {
    let (_, webview) = resolve_tab(&window, browser.inner(), id)?;
    let json = eval_in_app_world(&webview, SNAPSHOT_SCRIPT).await?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn browser_click(
    window: Window,
    browser: State<'_, Arc<Browser>>,
    id: Option<u32>,
    r#ref: String,
) -> Result<(), String> {
    let (_, webview) = resolve_tab(&window, browser.inner(), id)?;
    let script = click_script(&r#ref);
    let json = eval_in_app_world(&webview, &script).await?;
    ok_or_message(&json)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn browser_type(
    window: Window,
    browser: State<'_, Arc<Browser>>,
    id: Option<u32>,
    r#ref: String,
    text: String,
    submit: Option<bool>,
) -> Result<(), String> {
    let (_, webview) = resolve_tab(&window, browser.inner(), id)?;
    let script = type_script(&r#ref, &text, submit.unwrap_or(false));
    let json = eval_in_app_world(&webview, &script).await?;
    ok_or_message(&json)
}

/// Takes a PNG snapshot of `id`'s tab, written under [`screenshot_dir`] as
/// `<tab id>-<uuid>.png`. A hidden webview cannot be snapshotted reliably,
/// so a tab that is not the one currently shown is refused outright rather
/// than answering with a blank image.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn browser_screenshot(
    window: Window,
    browser: State<'_, Arc<Browser>>,
    id: Option<u32>,
) -> Result<String, String> {
    let (tab_id, webview) = resolve_tab(&window, browser.inner(), id)?;
    if !browser.is_visible(tab_id) {
        return Err("the tab is not showing".to_string());
    }

    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<u8>, String>>();
    webview
        .with_webview(move |platform| unsafe {
            let view: &objc2_web_kit::WKWebView =
                &*(platform.inner() as *const objc2_web_kit::WKWebView);
            let block = block2::RcBlock::new(
                move |image: *mut objc2_app_kit::NSImage, error: *mut objc2_foundation::NSError| {
                    let outcome = (|| {
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
                    })();
                    let _ = tx.send(outcome);
                },
            );
            view.takeSnapshotWithConfiguration_completionHandler(None, &block);
        })
        .map_err(|e| e.to_string())?;

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(10))
    })
    .await
    .map_err(|e| format!("the task failed: {e}"))?;

    let bytes = match outcome {
        Ok(result) => result?,
        Err(_) => return Err("timed out taking the screenshot".to_string()),
    };

    let dir = screenshot_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    prune_old_screenshots(&dir);

    let path = dir.join(format!("{}-{}.png", tab_id.get(), uuid::Uuid::new_v4()));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn browser_eval(
    window: Window,
    browser: State<'_, Arc<Browser>>,
    id: Option<u32>,
    script: String,
) -> Result<String, String> {
    let _ = (window, browser, id, script);
    Err("not supported on this platform yet".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn browser_console(
    window: Window,
    browser: State<'_, Arc<Browser>>,
    id: Option<u32>,
    clear: Option<bool>,
) -> Result<Vec<ConsoleEntry>, String> {
    let _ = (window, browser, id, clear);
    Err("not supported on this platform yet".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn browser_snapshot(
    window: Window,
    browser: State<'_, Arc<Browser>>,
    id: Option<u32>,
) -> Result<String, String> {
    let _ = (window, browser, id);
    Err("not supported on this platform yet".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn browser_click(
    window: Window,
    browser: State<'_, Arc<Browser>>,
    id: Option<u32>,
    r#ref: String,
) -> Result<(), String> {
    let _ = (window, browser, id, r#ref);
    Err("not supported on this platform yet".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn browser_type(
    window: Window,
    browser: State<'_, Arc<Browser>>,
    id: Option<u32>,
    r#ref: String,
    text: String,
    submit: Option<bool>,
) -> Result<(), String> {
    let _ = (window, browser, id, r#ref, text, submit);
    Err("not supported on this platform yet".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn browser_screenshot(
    window: Window,
    browser: State<'_, Arc<Browser>>,
    id: Option<u32>,
) -> Result<String, String> {
    let _ = (window, browser, id);
    Err("not supported on this platform yet".to_string())
}
