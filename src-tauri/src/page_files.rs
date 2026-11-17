//! The files a presented HTML page loads from its own folder, served to
//! the window under a scheme of the app's own.
//!
//! The window asks for a page's base address when it shows the page, and
//! the page's relative references resolve against it. The address names
//! the page by a token drawn at random, never by a path, so nothing that
//! runs in the window can name a folder of its choosing, and a token
//! reaches the one page's folder and nothing else. Only the main window's
//! webview is answered: a browser tab is a webview of its own and gets
//! nothing. Which files a page may load is the core's rule, applied where
//! the files are, a remote machine included.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::json;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, State, UriSchemeContext, UriSchemeResponder, Wry};
use workbench_core::page_files::{PageFile, PageFileWire};
use workbench_core::Core;

use crate::remote::{route, Remotes, Route};

/// The scheme the files are served under.
pub const SCHEME: &str = "awb-page";

/// What a document served under the scheme may do, should one ever be
/// opened as a page of its own, an SVG above all: run nothing and load
/// nothing, in a sandbox with no origin.
const DOCUMENT_POLICY: &str =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

/// The pages shown, by token, and each page's token, so a page shown again
/// keeps its address.
#[derive(Default)]
pub struct Pages {
    known: Mutex<Known>,
}

#[derive(Default)]
struct Known {
    pages: HashMap<String, String>,
    tokens: HashMap<String, String>,
}

impl Pages {
    fn token(&self, page: &str) -> String {
        let mut known = self.known.lock().expect("pages lock");
        if let Some(token) = known.tokens.get(page) {
            return token.clone();
        }
        let token = uuid::Uuid::new_v4().simple().to_string();
        known.tokens.insert(page.to_string(), token.clone());
        known.pages.insert(token.clone(), page.to_string());
        token
    }

    fn page(&self, token: &str) -> Option<String> {
        self.known
            .lock()
            .expect("pages lock")
            .pages
            .get(token)
            .cloned()
    }
}

/// The address a page's relative references resolve against: the scheme
/// as each platform's webview takes a custom one, and the page's token.
fn base(token: &str) -> String {
    if cfg!(any(windows, target_os = "android")) {
        format!("http://{SCHEME}.localhost/{token}/")
    } else {
        format!("{SCHEME}://localhost/{token}/")
    }
}

/// The base address for a page the window shows, `page` as the window
/// names it, a remote one with its host.
#[tauri::command]
pub async fn page_files_base(pages: State<'_, Arc<Pages>>, page: String) -> Result<String, String> {
    Ok(base(&pages.token(&page)))
}

/// `%XX` escapes decoded, the result read as UTF-8. A `%` with no two hex
/// digits after it is refused rather than guessed at.
fn decoded(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A `Range` header's one range, `bytes=a-b` or `bytes=a-`; anything else
/// is read as no range, and the whole file is answered.
fn range(request: &Request<Vec<u8>>) -> Option<(u64, Option<u64>)> {
    let value = request.headers().get(header::RANGE)?.to_str().ok()?;
    let (from, to) = value.strip_prefix("bytes=")?.split_once('-')?;
    if to.contains(',') {
        return None;
    }
    let from = from.trim().parse().ok()?;
    let to = match to.trim() {
        "" => None,
        to => Some(to.parse().ok()?),
    };
    Some((from, to))
}

fn refused(status: StatusCode, why: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(why.as_bytes().to_vec())
        .expect("a plain response")
}

fn answered(file: PageFile, ranged: bool) -> Response<Vec<u8>> {
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, &file.mime)
        .header(header::CONTENT_SECURITY_POLICY, DOCUMENT_POLICY)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCEPT_RANGES, "bytes");
    // A font is fetched with CORS, from a frame with no origin; nothing
    // else is, so the bytes of an image or a stylesheet stay unreadable to
    // a page's script.
    if file.mime.starts_with("font/") {
        response = response.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    }
    if ranged {
        let last = file.start + (file.bytes.len() as u64).saturating_sub(1);
        response = response.status(StatusCode::PARTIAL_CONTENT).header(
            header::CONTENT_RANGE,
            format!("bytes {}-{last}/{}", file.start, file.total),
        );
    }
    response.body(file.bytes).expect("a file response")
}

/// The file a request names, read where the page is.
async fn read(
    app: AppHandle,
    page: String,
    file: String,
    range: Option<(u64, Option<u64>)>,
) -> Result<PageFile, String> {
    let core = Arc::clone(&app.state::<Arc<Core>>());
    let remotes = Arc::clone(&app.state::<Arc<Remotes>>());
    crate::blocking(move || match route(&page) {
        Route::Local(page) => core.read_page_file(Path::new(&page), &file, range),
        Route::Remote { host, rest } => {
            let answer = remotes.connection(&host)?.call(
                "read_page_file",
                json!({ "page": rest, "file": file, "from": range.map(|r| r.0), "to": range.and_then(|r| r.1) }),
            )?;
            let wire: PageFileWire = serde_json::from_value(answer)
                .map_err(|e| format!("came back unreadable: {e}"))?;
            PageFile::try_from(wire)
        }
    })
    .await
}

async fn answer(app: AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != "GET" {
        return refused(StatusCode::METHOD_NOT_ALLOWED, "only read");
    }
    let path = request.uri().path().trim_start_matches('/');
    let (token, rest) = path.split_once('/').unwrap_or((path, ""));
    let Some(page) = app.state::<Arc<Pages>>().page(token) else {
        return refused(StatusCode::NOT_FOUND, "is outside the page's folder");
    };
    let Some(file) = decoded(rest) else {
        return refused(StatusCode::NOT_FOUND, "is not a plain relative path");
    };
    let range = range(&request);
    match read(app, page, file, range).await {
        Ok(file) => answered(file, range.is_some()),
        Err(why) => refused(StatusCode::NOT_FOUND, &why),
    }
}

/// Answers a request under the scheme, off the main thread.
pub fn handle(
    ctx: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if ctx.webview_label() != "main" {
        responder.respond(refused(StatusCode::FORBIDDEN, "not for this webview"));
        return;
    }
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        responder.respond(answer(app, request).await);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_escapes_and_refuses_a_broken_one() {
        assert_eq!(decoded("shots/b%20c.jpg").as_deref(), Some("shots/b c.jpg"));
        assert_eq!(
            decoded("%2e%2e%2fsecret.png").as_deref(),
            Some("../secret.png")
        );
        assert_eq!(decoded("caf%C3%A9.png").as_deref(), Some("café.png"));
        assert_eq!(decoded("a%2"), None);
        assert_eq!(decoded("a%zz"), None);
        assert_eq!(decoded("%ff"), None);
    }

    #[test]
    fn reads_one_range_and_no_other_kind() {
        let with = |value: &str| {
            Request::builder()
                .header(header::RANGE, value)
                .body(Vec::new())
                .unwrap()
        };
        assert_eq!(range(&with("bytes=0-1")), Some((0, Some(1))));
        assert_eq!(range(&with("bytes=100-")), Some((100, None)));
        assert_eq!(range(&with("bytes=-100")), None);
        assert_eq!(range(&with("bytes=0-1,4-5")), None);
        assert_eq!(range(&with("items=0-1")), None);
        assert_eq!(range(&Request::builder().body(Vec::new()).unwrap()), None);
    }

    #[test]
    fn keeps_a_page_on_one_token_and_answers_none_it_did_not_give() {
        let pages = Pages::default();
        let first = pages.token("/p/site/page.html");
        assert_eq!(pages.token("/p/site/page.html"), first);
        assert_ne!(pages.token("/p/other/page.html"), first);
        assert_eq!(pages.page(&first).as_deref(), Some("/p/site/page.html"));
        assert_eq!(pages.page("up.png"), None);
        assert!(base(&first).ends_with(&format!("/{first}/")));
    }
}
