//! The embedded browser's tabs, and what a person types into one turns into.
//!
//! Nothing here touches a window: a tab is a row of state, kept here and
//! mirrored to the frontend, and the address a person types is turned into
//! a URL to load or a short reason it cannot be. The native webview each tab
//! draws into lives in the app crate, which keeps a [`Tabs`] behind a mutex
//! and pushes a [`Tabs::snapshot`] to the frontend after every change.

use serde::{Deserialize, Serialize};

/// What a typed address becomes, or why it does not become anything.
///
/// `about:blank` passes through untouched. A scheme other than `http` or
/// `https` is refused outright, there is no search-engine fallback for a
/// bare word, and `word:digits` is read as a host and port rather than as a
/// scheme, so `localhost:3000` and `example.com:8080` behave the way a
/// person typing them expects.
pub fn normalize_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("enter an address".to_string());
    }
    if trimmed.eq_ignore_ascii_case("about:blank") {
        return Ok("about:blank".to_string());
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err("not an address".to_string());
    }

    let scheme = match explicit_scheme(trimmed) {
        Some(scheme) => scheme,
        None => classify_host(trimmed)?,
    };
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err("only http and https addresses open here".to_string());
    }

    let candidate = if explicit_scheme(trimmed).is_some() {
        trimmed.to_string()
    } else {
        format!("{scheme}://{trimmed}")
    };
    url::Url::parse(&candidate)
        .map(|url| url.to_string())
        .map_err(|_| "not an address".to_string())
}

/// The scheme `input` names, if it names one at all. A colon followed by
/// digits and then the end of the string, a path, a query or a fragment is
/// a port, not a scheme, which is what tells `localhost:3000` apart from
/// `javascript:alert(1)`. A bracketed address, `[::1]:3000` among them, is
/// never read as a scheme: the first colon inside the brackets is part of
/// the address.
fn explicit_scheme(input: &str) -> Option<&str> {
    if let Some(index) = input.find("://") {
        return Some(&input[..index]);
    }
    if input.starts_with('[') {
        return None;
    }
    let index = input.find(':')?;
    let after = &input[index + 1..];
    let digits = after.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 {
        let rest = &after[digits..];
        if rest.is_empty() || rest.starts_with(['/', '?', '#']) {
            return None;
        }
    }
    Some(&input[..index])
}

/// `http` or `https` for a scheme-less address, by what its host looks
/// like; an error when it looks like neither a host nor a search term,
/// since there is no search fallback.
fn classify_host(input: &str) -> Result<&'static str, String> {
    let authority_end = input.find(['/', '?', '#']).unwrap_or(input.len());
    let authority = &input[..authority_end];
    if authority.is_empty() {
        return Err("not an address".to_string());
    }

    if let Some(rest) = authority.strip_prefix('[') {
        return if rest.contains(']') {
            Ok("http")
        } else {
            Err("not an address".to_string())
        };
    }

    let (host, has_port) = match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            (host, true)
        }
        _ => (authority, false),
    };
    if host.is_empty() {
        return Err("not an address".to_string());
    }

    let lower = host.to_ascii_lowercase();
    let local = lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".test")
        || lower.ends_with(".internal")
        || host.parse::<std::net::Ipv4Addr>().is_ok();
    // A single name with a port is a machine on the network, a compose
    // service or a box on the desk, and those speak plain http.
    if local || (has_port && !host.contains('.')) {
        return Ok("http");
    }
    if host.contains('.') {
        return Ok("https");
    }
    Err("not an address".to_string())
}

/// A browser tab's id, handed out from 1 upwards and never reused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TabId(u32);

impl TabId {
    pub fn new(id: u32) -> Self {
        Self(id)
    }

    pub fn get(self) -> u32 {
        self.0
    }

    /// The label the native webview a tab draws into is created under.
    pub fn label(self) -> String {
        format!("browser-{}", self.0)
    }
}

/// The tab id `label` names, if it names one at all.
pub fn tab_id_from_label(label: &str) -> Option<TabId> {
    label.strip_prefix("browser-")?.parse().ok().map(TabId)
}

/// Who opened a tab.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Opener {
    User,
    Agent { session: String },
}

/// A tab as the frontend draws it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub id: TabId,
    /// The current URL, updated as navigation happens.
    pub url: String,
    pub title: String,
    /// The URL the tab was opened with; `None` for a tab opened empty, as
    /// a new tab.
    pub home: Option<String>,
    pub opener: Opener,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    /// The last load failure, cleared as soon as a navigation starts.
    pub error: Option<String>,
}

/// What gets emitted to the frontend after a change to the tabs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub tabs: Vec<Tab>,
    pub active: Option<TabId>,
}

/// Pure state for the browser's tabs. The native layer keeps one of these
/// behind a mutex and calls the setters as navigation happens.
#[derive(Debug)]
pub struct Tabs {
    next_id: u32,
    tabs: Vec<Tab>,
    active: Option<TabId>,
}

impl Default for Tabs {
    fn default() -> Self {
        Self::new()
    }
}

impl Tabs {
    pub fn new() -> Self {
        Self {
            next_id: 1,
            tabs: Vec::new(),
            active: None,
        }
    }

    /// Opens a new tab, which becomes active. Its url starts as `home`, or
    /// `about:blank` for a tab opened empty.
    pub fn open(&mut self, home: Option<String>, opener: Opener) -> TabId {
        let id = TabId(self.next_id);
        self.next_id += 1;
        let url = home.clone().unwrap_or_else(|| "about:blank".to_string());
        self.tabs.push(Tab {
            id,
            url,
            title: String::new(),
            home,
            opener,
            loading: false,
            can_go_back: false,
            can_go_forward: false,
            error: None,
        });
        self.active = Some(id);
        id
    }

    /// Closes a tab. If it was active, the tab to its right becomes active,
    /// else the one to its left, else none.
    pub fn close(&mut self, id: TabId) -> bool {
        let Some(index) = self.tabs.iter().position(|tab| tab.id == id) else {
            return false;
        };
        self.tabs.remove(index);
        if self.active == Some(id) {
            self.active = self
                .tabs
                .get(index)
                .or_else(|| index.checked_sub(1).and_then(|i| self.tabs.get(i)))
                .map(|tab| tab.id);
        }
        true
    }

    pub fn activate(&mut self, id: TabId) -> bool {
        if !self.tabs.iter().any(|tab| tab.id == id) {
            return false;
        }
        self.active = Some(id);
        true
    }

    pub fn active(&self) -> Option<TabId> {
        self.active
    }

    pub fn get(&self, id: TabId) -> Option<&Tab> {
        self.tabs.iter().find(|tab| tab.id == id)
    }

    fn get_mut(&mut self, id: TabId) -> Option<&mut Tab> {
        self.tabs.iter_mut().find(|tab| tab.id == id)
    }

    /// The tabs, in opening order.
    pub fn tabs(&self) -> &[Tab] {
        &self.tabs
    }

    pub fn navigation_started(&mut self, id: TabId, url: String) -> bool {
        let Some(tab) = self.get_mut(id) else {
            return false;
        };
        tab.url = url;
        tab.loading = true;
        tab.error = None;
        true
    }

    pub fn navigation_finished(&mut self, id: TabId, url: String) -> bool {
        let Some(tab) = self.get_mut(id) else {
            return false;
        };
        tab.url = url;
        tab.loading = false;
        true
    }

    pub fn navigation_failed(&mut self, id: TabId, message: String) -> bool {
        let Some(tab) = self.get_mut(id) else {
            return false;
        };
        tab.loading = false;
        tab.error = Some(message);
        true
    }

    pub fn titled(&mut self, id: TabId, title: String) -> bool {
        let Some(tab) = self.get_mut(id) else {
            return false;
        };
        tab.title = title;
        true
    }

    pub fn history(&mut self, id: TabId, can_go_back: bool, can_go_forward: bool) -> bool {
        let Some(tab) = self.get_mut(id) else {
            return false;
        };
        tab.can_go_back = can_go_back;
        tab.can_go_forward = can_go_forward;
        true
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            tabs: self.tabs.clone(),
            active: self.active,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_and_empty() {
        assert_eq!(normalize_url("about:blank").unwrap(), "about:blank");
        assert_eq!(normalize_url("ABOUT:BLANK").unwrap(), "about:blank");
        assert_eq!(normalize_url("").unwrap_err(), "enter an address");
        assert_eq!(normalize_url("   ").unwrap_err(), "enter an address");
    }

    #[test]
    fn explicit_http_and_https_are_normalised() {
        assert_eq!(
            normalize_url("https://example.com").unwrap(),
            "https://example.com/"
        );
        assert_eq!(
            normalize_url("http://example.com/path").unwrap(),
            "http://example.com/path"
        );
        assert_eq!(
            normalize_url("HTTPS://Example.com").unwrap(),
            "https://example.com/"
        );
    }

    #[test]
    fn other_schemes_are_refused() {
        assert_eq!(
            normalize_url("javascript:alert(1)").unwrap_err(),
            "only http and https addresses open here"
        );
        assert_eq!(
            normalize_url("file:///etc/passwd").unwrap_err(),
            "only http and https addresses open here"
        );
        assert_eq!(
            normalize_url("data:text/plain,hi").unwrap_err(),
            "only http and https addresses open here"
        );
        assert_eq!(
            normalize_url("ftp://example.com").unwrap_err(),
            "only http and https addresses open here"
        );
    }

    #[test]
    fn host_and_port_is_told_apart_from_a_scheme() {
        assert_eq!(
            normalize_url("localhost:3000").unwrap(),
            "http://localhost:3000/"
        );
        assert_eq!(
            normalize_url("localhost:5173/app").unwrap(),
            "http://localhost:5173/app"
        );
        assert_eq!(
            normalize_url("example.com:8080").unwrap(),
            "https://example.com:8080/"
        );
        assert_eq!(
            normalize_url("example.com:8443/x?y=1#z").unwrap(),
            "https://example.com:8443/x?y=1#z"
        );
    }

    #[test]
    fn schemeless_hosts_get_the_right_scheme() {
        assert_eq!(normalize_url("google.com").unwrap(), "https://google.com/");
        assert_eq!(
            normalize_url("  google.com  ").unwrap(),
            "https://google.com/"
        );
        assert_eq!(normalize_url("localhost").unwrap(), "http://localhost/");
        assert_eq!(normalize_url("LOCALHOST").unwrap(), "http://localhost/");
        assert_eq!(
            normalize_url("127.0.0.1:8080").unwrap(),
            "http://127.0.0.1:8080/"
        );
        assert_eq!(normalize_url("[::1]:3000").unwrap(), "http://[::1]:3000/");
        assert_eq!(
            normalize_url("thing.internal").unwrap(),
            "http://thing.internal/"
        );
        assert_eq!(
            normalize_url("box.test/app").unwrap(),
            "http://box.test/app"
        );
    }

    #[test]
    fn unparsable_input_is_refused_with_no_search_fallback() {
        assert_eq!(normalize_url("foo bar").unwrap_err(), "not an address");
        assert_eq!(normalize_url("foo").unwrap_err(), "not an address");
    }

    #[test]
    fn a_single_name_with_a_port_is_a_machine_nearby() {
        assert_eq!(normalize_url("api:8080").unwrap(), "http://api:8080/");
        assert_eq!(
            normalize_url("devbox:3000/health").unwrap(),
            "http://devbox:3000/health"
        );
    }

    #[test]
    fn tab_label_round_trips() {
        let id = TabId::new(7);
        assert_eq!(id.label(), "browser-7");
        assert_eq!(tab_id_from_label("browser-7"), Some(id));
        assert_eq!(tab_id_from_label("browser-"), None);
        assert_eq!(tab_id_from_label("browser-x"), None);
        assert_eq!(tab_id_from_label("other-7"), None);
    }

    #[test]
    fn opening_hands_out_ids_from_one_and_never_reuses_them() {
        let mut tabs = Tabs::new();
        let a = tabs.open(Some("https://a.example/".to_string()), Opener::User);
        let b = tabs.open(
            None,
            Opener::Agent {
                session: "s-1".to_string(),
            },
        );
        assert_eq!(a.get(), 1);
        assert_eq!(b.get(), 2);
        assert_eq!(tabs.active(), Some(b));
        assert_eq!(tabs.get(b).unwrap().url, "about:blank");
        assert_eq!(tabs.get(b).unwrap().home, None);
        assert_eq!(
            tabs.get(a).unwrap().home.as_deref(),
            Some("https://a.example/")
        );

        assert!(tabs.close(a));
        let c = tabs.open(None, Opener::User);
        assert_eq!(c.get(), 3, "closed ids are never handed out again");
    }

    #[test]
    fn closing_the_active_tab_activates_its_right_neighbour_then_its_left() {
        let mut tabs = Tabs::new();
        let a = tabs.open(None, Opener::User);
        let b = tabs.open(None, Opener::User);
        let c = tabs.open(None, Opener::User);
        tabs.activate(b);

        assert!(tabs.close(b));
        assert_eq!(
            tabs.active(),
            Some(c),
            "the tab to the right becomes active"
        );

        assert!(tabs.close(c));
        assert_eq!(
            tabs.active(),
            Some(a),
            "with nothing to the right, the left tab does"
        );

        assert!(tabs.close(a));
        assert_eq!(tabs.active(), None, "with no tabs left, none is active");

        assert!(!tabs.close(a), "closing an id that is gone does nothing");
    }

    #[test]
    fn closing_an_inactive_tab_leaves_the_active_one_alone() {
        let mut tabs = Tabs::new();
        let a = tabs.open(None, Opener::User);
        let b = tabs.open(None, Opener::User);
        tabs.activate(a);
        assert!(tabs.close(b));
        assert_eq!(tabs.active(), Some(a));
    }

    #[test]
    fn setters_on_an_unknown_id_do_nothing() {
        let mut tabs = Tabs::new();
        let missing = TabId::new(99);
        assert!(!tabs.activate(missing));
        assert!(!tabs.navigation_started(missing, "https://x".to_string()));
        assert!(!tabs.navigation_finished(missing, "https://x".to_string()));
        assert!(!tabs.navigation_failed(missing, "boom".to_string()));
        assert!(!tabs.titled(missing, "title".to_string()));
        assert!(!tabs.history(missing, true, true));
    }

    #[test]
    fn setters_update_the_tab_and_navigation_clears_the_error() {
        let mut tabs = Tabs::new();
        let id = tabs.open(Some("https://a.example/".to_string()), Opener::User);

        tabs.navigation_failed(id, "could not connect".to_string());
        assert_eq!(
            tabs.get(id).unwrap().error.as_deref(),
            Some("could not connect")
        );
        assert!(!tabs.get(id).unwrap().loading);

        tabs.navigation_started(id, "https://b.example/".to_string());
        let tab = tabs.get(id).unwrap();
        assert!(tab.loading);
        assert_eq!(tab.error, None);
        assert_eq!(tab.url, "https://b.example/");

        tabs.navigation_finished(id, "https://b.example/after-redirect".to_string());
        let tab = tabs.get(id).unwrap();
        assert!(!tab.loading);
        assert_eq!(tab.url, "https://b.example/after-redirect");

        tabs.titled(id, "B Example".to_string());
        tabs.history(id, true, false);
        let tab = tabs.get(id).unwrap();
        assert_eq!(tab.title, "B Example");
        assert!(tab.can_go_back);
        assert!(!tab.can_go_forward);
    }

    #[test]
    fn snapshot_carries_the_tabs_in_opening_order_and_the_active_id() {
        let mut tabs = Tabs::new();
        let a = tabs.open(None, Opener::User);
        let b = tabs.open(None, Opener::User);
        tabs.activate(a);
        let snapshot = tabs.snapshot();
        assert_eq!(
            snapshot.tabs.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![a, b]
        );
        assert_eq!(snapshot.active, Some(a));
    }
}
