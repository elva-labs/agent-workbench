//! The files a presented HTML page loads from its own folder, served to
//! the window under a scheme of the app's own.
//!
//! The window asks for a base address each time it draws a page, and the
//! page's relative references resolve against it. The address names the
//! page by a token drawn at random, never by a path, so nothing that runs
//! in the window can name a folder of its choosing, and a token reaches the
//! one page's folder and nothing else. Only the main window's webview is
//! answered: a browser tab is a webview of its own and gets nothing. Which
//! files a page may load is the core's rule, applied where the files are, a
//! remote machine included.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, State, UriSchemeContext, UriSchemeResponder, Wry};
use tokio::sync::{Semaphore, SemaphorePermit};
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

/// How many of one drawing's files are read at once. The rest wait their
/// turn, so a page that asks for files over and over holds no more than
/// this many reads, and their bytes, in the app or on the wire, and keeps
/// no other page waiting.
const READS_AT_ONCE: usize = 4;

/// How many of one drawing's requests may wait for a turn; one more is
/// refused at once. A page asks for every picture it holds as it loads, so
/// the line holds a gallery of screenshots, while a page asking for files
/// over and over is turned away rather than queued without end.
const READS_WAITING: usize = 2048;

/// How long the webview may reuse an answer. A page is drawn under a fresh
/// token each time, so an answer is never reused past the drawing it was
/// for, and a file changed on disk shows when the page is drawn again.
const KEPT: &str = "private, max-age=3600";

/// One drawing of a page: the page, and its reads under way and waiting.
struct Drawing {
    page: String,
    reads: Semaphore,
    waiting: AtomicUsize,
    waiting_at_most: usize,
}

impl Drawing {
    fn new(page: &str, at_once: usize, waiting_at_most: usize) -> Self {
        Drawing {
            page: page.to_string(),
            reads: Semaphore::new(at_once),
            waiting: AtomicUsize::new(0),
            waiting_at_most,
        }
    }

    /// A turn to read, at once or after those ahead in line; None when the
    /// line is full.
    async fn turn(&self) -> Option<SemaphorePermit<'_>> {
        if let Ok(turn) = self.reads.try_acquire() {
            return Some(turn);
        }
        if self.waiting.fetch_add(1, Ordering::SeqCst) >= self.waiting_at_most {
            self.waiting.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        let turn = self.reads.acquire().await.ok();
        self.waiting.fetch_sub(1, Ordering::SeqCst);
        turn
    }
}

/// The drawings of pages, by token.
#[derive(Default)]
pub struct Pages {
    known: Mutex<HashMap<String, Arc<Drawing>>>,
}

impl Pages {
    /// A token for one drawing of a page.
    fn give(&self, page: &str) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        let drawing = Drawing::new(page, READS_AT_ONCE, READS_WAITING);
        self.known
            .lock()
            .expect("pages lock")
            .insert(token.clone(), Arc::new(drawing));
        token
    }

    fn drawing(&self, token: &str) -> Option<Arc<Drawing>> {
        self.known.lock().expect("pages lock").get(token).cloned()
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

/// The base address for a drawing of a page, `page` as the window names
/// it, a remote one with its host.
#[tauri::command]
pub async fn page_files_base(pages: State<'_, Arc<Pages>>, page: String) -> Result<String, String> {
    Ok(base(&pages.give(&page)))
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
        .header(header::CACHE_CONTROL, KEPT)
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
    let Some(drawing) = app.state::<Arc<Pages>>().drawing(token) else {
        return refused(StatusCode::NOT_FOUND, "is outside the page's folder");
    };
    let Some(file) = decoded(rest) else {
        return refused(StatusCode::NOT_FOUND, "is not a plain relative path");
    };
    let range = range(&request);
    let Some(_turn) = drawing.turn().await else {
        return refused(
            StatusCode::SERVICE_UNAVAILABLE,
            "was not read: the page asked for too many files at once",
        );
    };
    match read(app, drawing.page.clone(), file, range).await {
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
    fn gives_each_drawing_its_own_token_and_answers_none_it_did_not_give() {
        let pages = Pages::default();
        let first = pages.give("/p/site/page.html");
        let again = pages.give("/p/site/page.html");
        assert_ne!(again, first);
        let page = |token: &str| pages.drawing(token).map(|drawing| drawing.page.clone());
        assert_eq!(page(&first).as_deref(), Some("/p/site/page.html"));
        assert_eq!(page(&again).as_deref(), Some("/p/site/page.html"));
        assert_eq!(page("up.png"), None);
        assert!(base(&first).ends_with(&format!("/{first}/")));
    }

    #[test]
    fn reads_a_drawing_a_few_at_a_time_and_turns_away_past_a_short_line() {
        use std::future::Future;
        use std::task::{Context, Poll, Waker};
        use tauri::async_runtime::block_on;

        let drawing = Drawing::new("/p/site/page.html", 1, 1);
        let other = Drawing::new("/p/other/page.html", 1, 1);

        let first = block_on(drawing.turn());
        assert!(first.is_some());
        // The next waits in line.
        let mut second = Box::pin(drawing.turn());
        let mut cx = Context::from_waker(Waker::noop());
        assert!(matches!(second.as_mut().poll(&mut cx), Poll::Pending));
        // One past the line is turned away at once, and another drawing
        // reads as if this one were idle.
        assert!(block_on(drawing.turn()).is_none());
        assert!(block_on(other.turn()).is_some());
        // When the first is done, the one in line reads.
        drop(first);
        assert!(block_on(second).is_some());
        assert_eq!(drawing.waiting.load(Ordering::SeqCst), 0);
    }
}
