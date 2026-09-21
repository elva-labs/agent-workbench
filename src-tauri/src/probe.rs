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
//! The report is written as pretty JSON to `WORKBENCH_PROBE_REPORT`
//! (default: `workbench-probe.json` in the system temp directory) and to
//! stderr.

use std::sync::mpsc;
use std::time::Duration;

use objc2_app_kit::{NSView, NSWindow};
use objc2_foundation::{NSError, NSString};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

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

/// Runs the steps named by `steps_path` against the main window and webview,
/// recording what changed after each one. A step is `resize:<W>x<H>`,
/// `evalin:<label>:<script>` to run `script` as a function body (an explicit
/// `return` captures a value) in the webview `label` names, without going
/// by way of `eval`, or otherwise `script` run in the main webview.
async fn run_steps(window: tauri::Window, main: tauri::Webview, steps_path: &str) -> Value {
    let text = std::fs::read_to_string(steps_path).unwrap_or_default();
    let mut steps = Vec::new();

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

    json!({ "steps": steps })
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

    let _ = window.set_focus();
    std::thread::sleep(Duration::from_secs(1));

    let report = run_steps(window, main, &steps_path).await;
    write_report(&report);
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

/// If `WORKBENCH_PROBE_STEPS` names a file, runs it against the app a few
/// seconds after startup and writes a report of what happened.
pub fn maybe_run_probe(app: &AppHandle) {
    let Ok(steps_path) = std::env::var("WORKBENCH_PROBE_STEPS") else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move { run_probe(app, steps_path).await });
}
