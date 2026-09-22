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

/// The host and port a load-failure check asks after for `url`, with the
/// scheme's default port filled in when the address does not name one, or
/// `None` for a target with no host to check against, `about:` among them.
pub fn navigation_target(url: &str) -> Option<(String, u16)> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_string();
    let port = parsed.port_or_known_default()?;
    Some((host, port))
}

/// Why a load-failure check found a host unreachable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectFailure {
    /// The host name did not resolve to an address.
    Resolution,
    /// The name resolved, but nothing answered: the connection was refused
    /// or timed out.
    Connection,
}

/// The short plain message a load failure is reported to a tab as.
pub fn connect_failure_message(host: &str, port: u16, failure: ConnectFailure) -> String {
    match failure {
        ConnectFailure::Resolution => format!("{host} could not be found"),
        ConnectFailure::Connection => format!("{host}:{port} is not answering"),
    }
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
    /// The last load failure, cleared when the tab is sent somewhere on
    /// purpose or a page load starts for another address.
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
    /// The address each tab was last sent to on purpose, by `open` or
    /// [`Tabs::navigate_to`], never by a page load. WebKit commits an
    /// `about:blank` of its own while it swaps processes for another origin
    /// and when a connection fails, and [`Tabs::is_interstitial`] tells
    /// that one from a page of the tab's own by this.
    targets: std::collections::HashMap<TabId, String>,
    /// The tabs sent somewhere on purpose whose load the webview has not
    /// yet reported as under way. WebKitGTK ends a load that never got
    /// under way by reporting it finished at the address the tab was on
    /// before, and [`Tabs::navigation_finished`] tells that from a page of
    /// the tab's own by this.
    uncommitted: std::collections::HashSet<TabId>,
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
            targets: std::collections::HashMap::new(),
            uncommitted: std::collections::HashSet::new(),
        }
    }

    /// Opens a new tab, which becomes active. Its url starts as `home`, or
    /// `about:blank` for a tab opened empty.
    pub fn open(&mut self, home: Option<String>, opener: Opener) -> TabId {
        let id = TabId(self.next_id);
        self.next_id += 1;
        let url = home.clone().unwrap_or_else(|| "about:blank".to_string());
        self.targets.insert(id, url.clone());
        if home.is_some() {
            self.uncommitted.insert(id);
        }
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
        self.targets.remove(&id);
        self.uncommitted.remove(&id);
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

    /// Whether a page load reporting `url` for `id` is WebKit's own
    /// `about:blank` and not a page of the tab's: it names `about:blank`
    /// while the tab was last sent somewhere else. Applying it would wipe
    /// the address a load-failure check is still watching.
    pub fn is_interstitial(&self, id: TabId, url: &str) -> bool {
        url == "about:blank"
            && self
                .targets
                .get(&id)
                .is_some_and(|target| target != "about:blank")
    }

    /// Marks `id` as deliberately sent to `url`: its url becomes the
    /// address right away, ahead of any page-load event a doomed
    /// connection might never produce, any failure it showed is cleared,
    /// even one for this same address, and `url` is remembered as the
    /// target a later `about:blank` process-swap commit is checked
    /// against.
    pub fn navigate_to(&mut self, id: TabId, url: String) -> bool {
        self.targets.insert(id, url.clone());
        self.uncommitted.insert(id);
        let Some(tab) = self.get_mut(id) else {
            return false;
        };
        tab.url = url;
        tab.loading = true;
        tab.error = None;
        true
    }

    /// A page load the webview reports as under way. One for the address
    /// the tab has already failed to reach is that same navigation being
    /// reported late, and leaves the failure standing: WebKitGTK reports
    /// the start of a load whose host does not resolve only after a
    /// load-failure check has found as much.
    pub fn navigation_started(&mut self, id: TabId, url: String) -> bool {
        self.uncommitted.remove(&id);
        let Some(tab) = self.get_mut(id) else {
            return false;
        };
        if tab.error.is_some() && tab.url == url {
            return false;
        }
        tab.url = url;
        tab.loading = true;
        tab.error = None;
        true
    }

    /// A page load the webview reports as over. One that ends a load sent
    /// on purpose before it was ever reported under way, at an address
    /// other than the one it was sent to, is that load failing: the tab
    /// keeps the address it was sent to, so a load-failure check against
    /// it still lands.
    pub fn navigation_finished(&mut self, id: TabId, url: String) -> bool {
        let never_started = self.uncommitted.remove(&id);
        let Some(tab) = self.get_mut(id) else {
            return false;
        };
        if !(never_started && tab.url != url) {
            tab.url = url;
        }
        tab.loading = false;
        true
    }

    /// Records a load failure for `id`, but only while it is still on
    /// `for_url`: a check started against an address the tab has since
    /// navigated away from must not clobber what replaced it.
    pub fn navigation_failed(&mut self, id: TabId, for_url: &str, message: String) -> bool {
        let Some(tab) = self.get_mut(id) else {
            return false;
        };
        if tab.url != for_url {
            return false;
        }
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
        assert!(!tabs.navigation_failed(missing, "https://x", "boom".to_string()));
        assert!(!tabs.titled(missing, "title".to_string()));
        assert!(!tabs.history(missing, true, true));
    }

    #[test]
    fn setters_update_the_tab_and_navigation_clears_the_error() {
        let mut tabs = Tabs::new();
        let id = tabs.open(Some("https://a.example/".to_string()), Opener::User);

        tabs.navigation_failed(id, "https://a.example/", "could not connect".to_string());
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
    fn a_start_reported_after_the_failure_for_the_same_address_leaves_it_standing() {
        let mut tabs = Tabs::new();
        let id = tabs.open(None, Opener::User);
        tabs.navigate_to(id, "https://nowhere.invalid/".to_string());
        tabs.navigation_failed(
            id,
            "https://nowhere.invalid/",
            "nowhere.invalid could not be found".to_string(),
        );

        assert!(!tabs.navigation_started(id, "https://nowhere.invalid/".to_string()));
        let tab = tabs.get(id).unwrap();
        assert_eq!(
            tab.error.as_deref(),
            Some("nowhere.invalid could not be found")
        );
        assert!(!tab.loading);

        tabs.navigation_finished(id, "https://nowhere.invalid/".to_string());
        assert_eq!(
            tabs.get(id).unwrap().error.as_deref(),
            Some("nowhere.invalid could not be found")
        );
    }

    #[test]
    fn a_load_that_ends_before_it_got_under_way_keeps_the_address_it_was_sent_to() {
        let mut tabs = Tabs::new();
        let id = tabs.open(Some("https://a.example/".to_string()), Opener::User);
        tabs.navigation_started(id, "https://a.example/".to_string());
        tabs.navigation_finished(id, "https://a.example/".to_string());

        // WebKitGTK ends a load whose host refused it by reporting it
        // finished at the page the tab was on before.
        tabs.navigate_to(id, "http://localhost:9/".to_string());
        tabs.navigation_finished(id, "https://a.example/".to_string());
        let tab = tabs.get(id).unwrap();
        assert_eq!(tab.url, "http://localhost:9/");
        assert!(!tab.loading);

        assert!(tabs.navigation_failed(
            id,
            "http://localhost:9/",
            "localhost:9 is not answering".to_string()
        ));
        // The error page WebKitGTK then commits for the address leaves the
        // failure standing.
        tabs.navigation_started(id, "http://localhost:9/".to_string());
        tabs.navigation_finished(id, "http://localhost:9/".to_string());
        assert_eq!(
            tabs.get(id).unwrap().error.as_deref(),
            Some("localhost:9 is not answering")
        );
    }

    #[test]
    fn a_load_that_got_under_way_follows_where_it_finished() {
        let mut tabs = Tabs::new();
        let id = tabs.open(Some("http://a.example/".to_string()), Opener::User);
        tabs.navigation_started(id, "https://a.example/".to_string());
        tabs.navigation_finished(id, "https://a.example/landing".to_string());
        assert_eq!(tabs.get(id).unwrap().url, "https://a.example/landing");

        // A page's own navigation, never sent on purpose, is followed too.
        tabs.navigation_finished(id, "https://a.example/next".to_string());
        assert_eq!(tabs.get(id).unwrap().url, "https://a.example/next");
    }

    #[test]
    fn sending_a_tab_to_the_address_it_failed_on_clears_the_failure() {
        let mut tabs = Tabs::new();
        let id = tabs.open(Some("http://localhost:9/".to_string()), Opener::User);
        tabs.navigation_failed(id, "http://localhost:9/", "not answering".to_string());

        assert!(tabs.navigate_to(id, "http://localhost:9/".to_string()));
        let tab = tabs.get(id).unwrap();
        assert_eq!(tab.error, None);
        assert!(tab.loading);

        // The start the webview reports for that attempt is not held back.
        assert!(tabs.navigation_started(id, "http://localhost:9/".to_string()));
    }

    #[test]
    fn an_about_blank_commit_that_does_not_match_the_deliberate_target_is_an_interstitial() {
        let mut tabs = Tabs::new();
        let id = tabs.open(Some("https://a.example/".to_string()), Opener::User);
        tabs.navigate_to(id, "http://localhost:9/".to_string());

        assert!(tabs.is_interstitial(id, "about:blank"));
        assert!(
            !tabs.is_interstitial(id, "http://localhost:9/"),
            "a commit that names the real target is never an interstitial"
        );

        // It stays an interstitial even once the tab has stopped loading,
        // since WebKit's own about:blank fallback for a failed connection
        // can arrive after a load-failure check has already recorded it.
        tabs.navigation_failed(id, "http://localhost:9/", "not answering".to_string());
        assert!(tabs.is_interstitial(id, "about:blank"));
    }

    #[test]
    fn an_about_blank_commit_matching_the_deliberate_target_is_not_an_interstitial() {
        let mut tabs = Tabs::new();
        let id = tabs.open(None, Opener::User);
        // A tab opened empty was deliberately sent to about:blank, and a
        // commit that confirms as much is not noise.
        assert!(!tabs.is_interstitial(id, "about:blank"));

        tabs.navigate_to(id, "https://a.example/".to_string());
        tabs.navigate_to(id, "about:blank".to_string());
        assert!(!tabs.is_interstitial(id, "about:blank"));

        assert!(!tabs.is_interstitial(TabId::new(99), "about:blank"));
    }

    #[test]
    fn a_late_failure_is_dropped_once_the_tab_has_moved_on() {
        let mut tabs = Tabs::new();
        let id = tabs.open(Some("https://a.example/".to_string()), Opener::User);
        tabs.navigation_started(id, "https://b.example/".to_string());

        assert!(!tabs.navigation_failed(
            id,
            "https://a.example/",
            "a.example could not be found".to_string()
        ));
        assert_eq!(tabs.get(id).unwrap().error, None);

        assert!(tabs.navigation_failed(
            id,
            "https://b.example/",
            "b.example is not answering".to_string()
        ));
        assert_eq!(
            tabs.get(id).unwrap().error.as_deref(),
            Some("b.example is not answering")
        );
    }

    #[test]
    fn navigation_target_reads_the_host_and_fills_in_the_default_port() {
        assert_eq!(
            navigation_target("https://example.com/path"),
            Some(("example.com".to_string(), 443))
        );
        assert_eq!(
            navigation_target("http://example.com/path"),
            Some(("example.com".to_string(), 80))
        );
        assert_eq!(
            navigation_target("http://localhost:5173/app"),
            Some(("localhost".to_string(), 5173))
        );
        assert_eq!(
            navigation_target("https://example.com:8443/x"),
            Some(("example.com".to_string(), 8443))
        );
    }

    #[test]
    fn navigation_target_is_none_for_about_and_unparsable_urls() {
        assert_eq!(navigation_target("about:blank"), None);
        assert_eq!(navigation_target("not a url"), None);
    }

    #[test]
    fn connect_failure_message_names_the_kind_of_failure() {
        assert_eq!(
            connect_failure_message("example.com", 443, ConnectFailure::Resolution),
            "example.com could not be found"
        );
        assert_eq!(
            connect_failure_message("example.com", 8080, ConnectFailure::Connection),
            "example.com:8080 is not answering"
        );
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
