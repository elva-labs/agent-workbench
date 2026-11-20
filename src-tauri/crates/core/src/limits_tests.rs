use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;

use super::*;
use crate::events::testing::Recorder;
use crate::integrated::{LimitKind, LimitSeverity};
use crate::scratch::Scratch;

// ---- the readers, against recorded answers ----

/// Answers each request with the next of the answers given, and keeps
/// what it was asked.
struct Recorded {
    asked: Vec<(String, Value)>,
    answers: VecDeque<Answer>,
}

impl Recorded {
    fn new(answers: impl IntoIterator<Item = Answer>) -> Self {
        Self {
            asked: Vec::new(),
            answers: answers.into_iter().collect(),
        }
    }
}

impl Ask for Recorded {
    fn ask(&mut self, method: &str, params: Value) -> Answer {
        self.asked.push((method.to_string(), params));
        self.answers
            .pop_front()
            .unwrap_or_else(|| Answer::Gone("no more answers".into()))
    }
}

/// The body of Claude Code 2.1.325's answer to a usage request with no
/// turn, its rows as the server gives them, the rest cut down.
fn claude_usage() -> Value {
    json!({
        "behaviors": null,
        "rate_limits_available": true,
        "session": {"total_cost_usd": 0, "total_api_duration_ms": 0, "model_usage": {}},
        "subscription_type": "team",
        "rate_limits": {
            "five_hour": {"utilization": 49, "resets_at": "2030-01-01T05:00:00.5+00:00"},
            "seven_day": {"utilization": 22, "resets_at": "2030-01-05T00:00:00+00:00"},
            "something_new": {"a": 1},
            "limits": [
                {"kind": "session", "group": "session", "percent": 49, "severity": "normal",
                 "resets_at": "2030-01-01T05:00:00.5+00:00", "scope": null, "is_active": false},
                {"kind": "weekly_all", "group": "weekly", "percent": 22, "severity": "normal",
                 "resets_at": "2030-01-05T00:00:00+00:00", "scope": null, "is_active": false},
                {"kind": "weekly_scoped", "group": "weekly", "percent": 8, "severity": "normal",
                 "resets_at": "2030-01-05T00:00:00Z",
                 "scope": {"model": {"id": null, "display_name": "Fable"}, "surface": null},
                 "is_active": false}
            ]
        }
    })
}

/// Codex 0.169.0's answer to a rate limits request with no thread.
fn codex_rate_limits() -> Value {
    json!({
        "accountId": "a",
        "ordinaryUsageAllowed": true,
        "rateLimitResetCredits": null,
        "rateLimitUpsell": null,
        "rateLimits": {
            "credits": {"balance": null, "hasCredits": false, "unlimited": false},
            "individualLimit": null,
            "limitId": "codex",
            "limitName": null,
            "normalModelSlug": null,
            "planType": "team",
            "primary": {"usedPercent": 3, "windowDurationMins": 300, "resetsAt": 1_900_000_000},
            "rateLimitReachedType": null,
            "secondary": {"usedPercent": 41, "windowDurationMins": 10_080, "resetsAt": 1_900_500_000},
            "spendControlReached": null
        },
        "rateLimitsByLimitId": {"codex": {"limitId": "codex"}}
    })
}

fn told(event: &Event) -> (&str, Option<&str>, &[LimitWindow], Option<u64>, u64) {
    match event {
        Event::Limits {
            agent,
            plan,
            windows,
            read_at,
            taken_at,
        } => (agent, plan.as_deref(), windows, *read_at, *taken_at),
        other => panic!("not limits: {other:?}"),
    }
}

#[test]
fn claude_code_is_asked_for_its_usage_without_the_transcript_scan() {
    let mut control = Recorded::new([Answer::Result(claude_usage())]);
    let event = claude_limits(&mut control).unwrap();
    assert_eq!(
        control.asked,
        [("get_usage".to_string(), json!({"skip_behaviors": true}))]
    );
    let (agent, plan, windows, read_at, taken_at) = told(&event);
    assert_eq!(agent, "claude-code");
    assert_eq!(plan, Some("team"));
    assert_eq!(read_at, Some(taken_at), "a full read");
    let kinds: Vec<_> = windows
        .iter()
        .map(|window| (window.kind, window.model.as_deref(), window.percent))
        .collect();
    assert_eq!(
        kinds,
        [
            (LimitKind::Session, None, 49.0),
            (LimitKind::Weekly, None, 22.0),
            (LimitKind::WeeklyScoped, Some("Fable"), 8.0),
        ]
    );
    assert_eq!(windows[0].severity, Some(LimitSeverity::Normal));
    assert_eq!(windows[0].resets_at, Some(1_893_474_000));
}

#[test]
fn claude_code_signed_out_or_refusing_gives_no_figures() {
    // A configuration directory nobody signed in to answers with no rows.
    let signed_out = json!({
        "behaviors": null, "rate_limits": null, "rate_limits_available": false,
        "session": {"total_cost_usd": 0, "model_usage": {}}, "subscription_type": null,
    });
    for answer in [
        Answer::Result(signed_out),
        Answer::Result(json!({"rate_limits": {"limits": "soon"}})),
        Answer::Refused("get_usage is not supported".into()),
        Answer::Gone("Claude Code did not answer in time".into()),
        Answer::TooLong,
    ] {
        let mut control = Recorded::new([answer]);
        assert!(claude_limits(&mut control).is_err());
    }
}

#[test]
fn codex_is_asked_for_its_rate_limits_without_the_credit_details() {
    let mut server = Recorded::new([Answer::Result(codex_rate_limits())]);
    let event = codex_limits(&mut server).unwrap();
    assert_eq!(
        server.asked,
        [(
            "account/rateLimits/read".to_string(),
            json!({"excludeResetCreditDetails": true})
        )]
    );
    let (agent, plan, windows, read_at, taken_at) = told(&event);
    assert_eq!(agent, "codex");
    assert_eq!(plan, Some("team"));
    assert_eq!(read_at, Some(taken_at));
    let kinds: Vec<_> = windows
        .iter()
        .map(|window| (window.kind, window.percent, window.resets_at))
        .collect();
    assert_eq!(
        kinds,
        [
            (LimitKind::Session, 3.0, Some(1_900_000_000)),
            (LimitKind::Weekly, 41.0, Some(1_900_500_000)),
        ]
    );
}

#[test]
fn codex_signed_out_or_answering_otherwise_gives_no_figures() {
    for answer in [
        Answer::Refused("codex account authentication required to read rate limits".into()),
        Answer::Result(json!({"rateLimits": null})),
        Answer::Gone("Codex ended before it answered".into()),
        Answer::TooLong,
    ] {
        let mut server = Recorded::new([answer]);
        assert!(codex_limits(&mut server).is_err());
    }
}

#[test]
fn an_agent_with_no_limits_is_not_read() {
    let none = HashMap::new();
    let folder = Scratch::new("limits-nobody");
    assert!(read("nobody", &none, None, &folder, Duration::from_secs(1)).is_err());
}

// ---- the readers, against stand-ins for the agents' binaries ----

/// A stand-in for `claude` that writes down how it was started and what it
/// read, answers the first control request with the body in `answer`, or
/// with nothing where there is no such file, and holds on until its input
/// closes.
#[cfg(unix)]
const CLAUDE_STAND_IN: &str = r#"#!/bin/sh
dir=$(dirname "$0")
printf '%s\n' "$@" > "$dir/args"
printf '%s\n' "$CLAUDE_CONFIG_DIR" > "$dir/config"
printf '%s\n' "$CLAUDE_CODE_SAFE_MODE" > "$dir/safe"
pwd > "$dir/cwd"
echo $$ > "$dir/pid"
IFS= read -r line
printf '%s\n' "$line" > "$dir/asked"
id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"system","subtype":"status"}\n'
printf 'not json\n'
printf '{"type":"control_response","response":{"subtype":"success","request_id":"other","response":{}}}\n'
if [ -f "$dir/answer" ]; then
  printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":%s}}\n' "$id" "$(cat "$dir/answer")"
fi
cat > /dev/null
"#;

/// A stand-in for `codex` that answers the handshake and a rate limits
/// request with the result in `answer`, writing down how it was started
/// and every line it read.
#[cfg(unix)]
const CODEX_STAND_IN: &str = r#"#!/bin/sh
dir=$(dirname "$0")
printf '%s\n' "$@" > "$dir/args"
printf '%s\n' "$CODEX_HOME" > "$dir/config"
pwd > "$dir/cwd"
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$dir/asked"
  id=$(printf '%s' "$line" | sed -n 's/^{"id":\([0-9]*\),.*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{"userAgent":"stand-in/0.169.0"}}\n' "$id" ;;
    *'"method":"account/rateLimits/read"'*)
      printf '{"method":"account/updated","params":{}}\n'
      printf '{"id":%s,"result":%s}\n' "$id" "$(cat "$dir/answer")" ;;
  esac
done
"#;

#[cfg(unix)]
fn stand_in(
    name: &str,
    script: &str,
    answer: Option<&Value>,
) -> (Scratch, HashMap<String, String>) {
    let dir = Scratch::new(&format!("limits-{name}"));
    let binary = dir.join(name);
    crate::executable::write(&binary, script).unwrap();
    if let Some(answer) = answer {
        std::fs::write(dir.join("answer"), answer.to_string()).unwrap();
    }
    std::fs::create_dir(dir.join("work")).unwrap();
    let vars = HashMap::from([
        (
            "PATH".to_string(),
            format!("{}:/usr/bin:/bin", dir.display()),
        ),
        (
            "CLAUDE_CODE_SAFE_MODE".to_string(),
            "from the shell".to_string(),
        ),
    ]);
    (dir, vars)
}

/// The folder a stand-in is started in.
#[cfg(unix)]
fn work(dir: &Path) -> PathBuf {
    dir.join("work")
}

/// Whether the stand-in ran in its folder.
#[cfg(unix)]
fn ran_in_work(dir: &Path) -> bool {
    Path::new(&written(dir, "cwd")).canonicalize().unwrap() == work(dir).canonicalize().unwrap()
}

#[cfg(unix)]
fn written(dir: &Path, file: &str) -> String {
    std::fs::read_to_string(dir.join(file))
        .unwrap_or_default()
        .trim_end()
        .to_string()
}

#[cfg(unix)]
#[test]
fn claude_code_is_started_as_a_quiet_stream_under_the_account_and_asked_once() {
    let (dir, vars) = stand_in("claude", CLAUDE_STAND_IN, Some(&claude_usage()));
    let account = dir.join("account");
    let event = read("claude-code", &vars, Some(&account), &work(&dir), READ_WAIT).unwrap();
    assert_eq!(told(&event).2.len(), 3);
    let args = written(&dir, "args");
    let args: Vec<_> = args.lines().collect();
    assert_eq!(args, CLAUDE_ARGS);
    // Safe mode and the user's settings alone, as flags a version without
    // them refuses.
    assert!(args.contains(&"--safe-mode"), "{args:?}");
    assert!(
        args.windows(2)
            .any(|pair| pair == ["--setting-sources", "user"]),
        "{args:?}"
    );
    assert_eq!(written(&dir, "config"), account.to_string_lossy());
    assert_eq!(written(&dir, "safe"), "1");
    assert!(ran_in_work(&dir), "ran in {}", written(&dir, "cwd"));
    let asked: Value = serde_json::from_str(&written(&dir, "asked")).unwrap();
    assert_eq!(asked["type"], "control_request");
    assert_eq!(
        asked["request"],
        json!({"subtype": "get_usage", "skip_behaviors": true})
    );
}

#[cfg(unix)]
#[test]
fn claude_code_under_its_own_directory_is_left_to_find_it() {
    let (dir, vars) = stand_in("claude", CLAUDE_STAND_IN, Some(&claude_usage()));
    read("claude-code", &vars, None, &work(&dir), READ_WAIT).unwrap();
    assert_eq!(written(&dir, "config"), "");
}

#[cfg(unix)]
#[test]
fn a_read_that_is_not_answered_ends_at_its_deadline_and_the_process_with_it() {
    let (dir, vars) = stand_in("claude", CLAUDE_STAND_IN, None);
    let started = Instant::now();
    let error = read(
        "claude-code",
        &vars,
        None,
        &work(&dir),
        Duration::from_millis(1500),
    )
    .unwrap_err();
    assert!(error.contains("did not answer in time"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(10));
    let pid: i32 = written(&dir, "pid").parse().unwrap();
    // Its input closed, the stand-in ends; whatever is left is killed.
    let until = Instant::now() + Duration::from_secs(10);
    while unsafe { libc::kill(pid, 0) } == 0 {
        assert!(Instant::now() < until, "the stand-in is still running");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(unix)]
#[test]
fn a_missing_binary_is_an_error() {
    let vars = HashMap::from([("PATH".to_string(), "/nowhere".to_string())]);
    let folder = Scratch::new("limits-missing");
    for agent in ["claude-code", "codex"] {
        let error = read(agent, &vars, None, &folder, READ_WAIT).unwrap_err();
        assert!(error.contains("not on your PATH"), "{error}");
    }
}

#[cfg(unix)]
#[test]
fn the_agents_are_read_in_a_folder_of_the_workbenchs_own_kept_to_the_user() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |folder: &Path| std::fs::metadata(folder).unwrap().permissions().mode() & 0o777;
    let home = Scratch::new("limits-folder");
    let limits = Limits::new(Some(&home));
    let folder = limits.folder().unwrap();
    assert_eq!(folder, home.join(".chord").join("limits"));
    assert_eq!(mode(&folder), 0o700);
    // One that is there already is kept to the user again.
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o777)).unwrap();
    assert_eq!(limits.folder().unwrap(), folder);
    assert_eq!(mode(&folder), 0o700);
    // With no home there is nowhere to read.
    assert!(Limits::new(None).folder().is_err());
}

#[cfg(unix)]
#[test]
fn codex_is_started_with_its_plugins_off_under_the_account_and_asked_after_the_handshake() {
    let (dir, vars) = stand_in("codex", CODEX_STAND_IN, Some(&codex_rate_limits()));
    let account = dir.join("account");
    let event = read("codex", &vars, Some(&account), &work(&dir), READ_WAIT).unwrap();
    assert_eq!(told(&event).1, Some("team"));
    assert_eq!(
        written(&dir, "args").lines().collect::<Vec<_>>(),
        ["app-server", "-c", "features.plugins=false"]
    );
    assert_eq!(written(&dir, "config"), account.to_string_lossy());
    assert!(ran_in_work(&dir), "ran in {}", written(&dir, "cwd"));
    let asked: Vec<Value> = written(&dir, "asked")
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let methods: Vec<_> = asked
        .iter()
        .map(|line| line["method"].as_str().unwrap())
        .collect();
    assert_eq!(
        methods,
        ["initialize", "initialized", "account/rateLimits/read"]
    );
}

/// The real agents on the PATH, under the accounts of whoever runs it, each
/// asked for its limits with no turn. Run by hand after an agent is updated:
/// it says only how many windows came and how long each read took.
#[test]
#[ignore = "runs the real claude and codex on PATH under your own accounts"]
fn the_real_agents_answer_with_no_turn() {
    let vars: HashMap<String, String> = std::env::vars().collect();
    let folder = Scratch::new("limits-real");
    for agent in ["claude-code", "codex"] {
        let started = Instant::now();
        let event =
            read(agent, &vars, None, &folder, READ_WAIT).unwrap_or_else(|e| panic!("{agent}: {e}"));
        let (_, _, windows, read_at, _) = told(&event);
        eprintln!(
            "{agent}: {} windows in {:?}",
            windows.len(),
            started.elapsed()
        );
        assert!(!windows.is_empty() && read_at.is_some(), "{agent}");
    }
}

// ---- the schedule, with a clock the test turns ----

const T0: u64 = 2_000_000_000;
const MINUTE: u64 = 60;

/// A clock the test sets.
#[derive(Clone)]
struct Clock(Arc<AtomicU64>);

impl Clock {
    fn new() -> Self {
        Self(Arc::new(AtomicU64::new(T0)))
    }
    fn now(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
    fn on(&self, seconds: u64) {
        self.0.fetch_add(seconds, Ordering::SeqCst);
    }
}

fn limits(clock: &Clock, file: Option<PathBuf>) -> Limits {
    let clock = clock.clone();
    Limits::with(file, Box::new(move || clock.now()))
}

/// Figures read at `at`, the session window `percent` used.
fn read_at(at: u64, percent: f64) -> Event {
    Event::Limits {
        agent: "claude-code".into(),
        plan: Some("max".into()),
        windows: vec![LimitWindow {
            kind: LimitKind::Session,
            model: None,
            percent,
            resets_at: Some(at + 3600),
            severity: None,
        }],
        read_at: Some(at),
        taken_at: at,
    }
}

fn percent(event: Option<Event>) -> Option<f64> {
    match event? {
        Event::Limits { windows, .. } => windows.first().map(|window| window.percent),
        _ => None,
    }
}

const DIR: &str = "/home/ada/.claude-work";

/// Polls the account at the clock's time, counting the reads made.
fn poll(limits: &Limits, clock: &Clock, reads: &AtomicUsize, percent: f64) -> Option<Event> {
    let at = clock.now();
    limits.poll("claude-code", Path::new(DIR), true, || {
        reads.fetch_add(1, Ordering::SeqCst);
        Ok(read_at(at, percent))
    })
}

#[test]
fn an_account_is_read_once_its_last_read_is_five_minutes_old() {
    let clock = Clock::new();
    let limits = limits(&clock, None);
    let reads = AtomicUsize::new(0);
    assert_eq!(limits.held("claude-code", Path::new(DIR)), None);
    assert_eq!(percent(poll(&limits, &clock, &reads, 10.0)), Some(10.0));
    assert_eq!(reads.load(Ordering::SeqCst), 1, "none held: read at once");
    for _ in 0..4 {
        clock.on(MINUTE);
        assert_eq!(percent(poll(&limits, &clock, &reads, 20.0)), Some(10.0));
    }
    assert_eq!(reads.load(Ordering::SeqCst), 1, "still fresh");
    clock.on(MINUTE);
    assert_eq!(percent(poll(&limits, &clock, &reads, 20.0)), Some(20.0));
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    // Each agent's account is its own, and so is each directory.
    limits.poll("codex", Path::new(DIR), true, || {
        reads.fetch_add(1, Ordering::SeqCst);
        Err("signed out".into())
    });
    limits.poll("claude-code", Path::new("/home/ada/.claude"), true, || {
        reads.fetch_add(1, Ordering::SeqCst);
        Err("signed out".into())
    });
    assert_eq!(reads.load(Ordering::SeqCst), 4);
}

#[test]
fn a_read_that_panics_fails_and_the_account_is_read_again_later() {
    let clock = Clock::new();
    let limits = limits(&clock, None);
    let held = limits.poll(
        "claude-code",
        Path::new(DIR),
        true,
        || -> Result<Event, String> { panic!("a reader's own fault") },
    );
    assert_eq!(held, None);
    clock.on(MINUTE);
    let reads = AtomicUsize::new(0);
    assert_eq!(percent(poll(&limits, &clock, &reads, 10.0)), Some(10.0));
    assert_eq!(reads.load(Ordering::SeqCst), 1);
}

#[test]
fn an_account_no_session_worked_on_since_is_read_every_half_hour() {
    let clock = Clock::new();
    let limits = limits(&clock, None);
    let reads = AtomicUsize::new(0);
    let quiet = |limits: &Limits| {
        let at = clock.now();
        limits.poll("claude-code", Path::new(DIR), false, || {
            reads.fetch_add(1, Ordering::SeqCst);
            Ok(read_at(at, 10.0))
        })
    };
    // None held is read at once, worked on or not.
    quiet(&limits);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    for _ in 0..29 {
        clock.on(MINUTE);
        quiet(&limits);
    }
    assert_eq!(
        reads.load(Ordering::SeqCst),
        1,
        "nothing worked: still fresh"
    );
    clock.on(MINUTE);
    quiet(&limits);
    assert_eq!(reads.load(Ordering::SeqCst), 2, "half an hour");
    // A session worked: five minutes are enough.
    clock.on(4 * MINUTE);
    poll(&limits, &clock, &reads, 20.0);
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    clock.on(MINUTE);
    assert_eq!(percent(poll(&limits, &clock, &reads, 20.0)), Some(20.0));
    assert_eq!(reads.load(Ordering::SeqCst), 3);
}

#[test]
fn figures_read_before_a_time_asked_about_are_read_again_at_once() {
    let clock = Clock::new();
    let failing = limits(&clock, None);
    let limits = limits(&clock, None);
    let reads = AtomicUsize::new(0);
    let since = |limits: &Limits, since: u64| {
        let at = clock.now();
        limits.poll_since("claude-code", Path::new(DIR), true, Some(since), || {
            reads.fetch_add(1, Ordering::SeqCst);
            Ok(read_at(at, 10.0))
        })
    };
    poll(&limits, &clock, &reads, 100.0);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    // A window started over a minute on: the fresh figures say nothing
    // of it, and are read again.
    clock.on(2 * MINUTE);
    assert_eq!(percent(since(&limits, T0 + MINUTE)), Some(10.0));
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    // Read since, they stand as any fresh figures do.
    clock.on(MINUTE);
    since(&limits, T0 + MINUTE);
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    // A read that failed holds the next back, asked about a time or not.
    failing.poll("claude-code", Path::new(DIR), true, || Err("no".into()));
    let again = AtomicUsize::new(0);
    failing.poll_since("claude-code", Path::new(DIR), true, Some(T0), || {
        again.fetch_add(1, Ordering::SeqCst);
        Err("no".into())
    });
    assert_eq!(again.load(Ordering::SeqCst), 0);
}

#[test]
fn a_failed_read_is_quiet_and_tried_again_later_and_later() {
    let clock = Clock::new();
    let limits = limits(&clock, None);
    let attempts = AtomicUsize::new(0);
    let failing = |limits: &Limits| {
        limits.poll("claude-code", Path::new(DIR), true, || {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err("Claude Code did not answer in time".into())
        })
    };
    // The figures held stay as they were.
    let reads = AtomicUsize::new(0);
    poll(&limits, &clock, &reads, 10.0);
    clock.on(5 * MINUTE);
    assert_eq!(percent(failing(&limits)), Some(10.0));
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    // A minute after the first failure, then two, four, and so on.
    let mut waited = Vec::new();
    for _ in 0..8 {
        let before = attempts.load(Ordering::SeqCst);
        let mut minutes = 0;
        while attempts.load(Ordering::SeqCst) == before {
            clock.on(MINUTE);
            minutes += 1;
            failing(&limits);
        }
        waited.push(minutes);
    }
    assert_eq!(
        waited,
        [1, 2, 4, 8, 16, 32, 60, 60],
        "never more than an hour"
    );
    // One that works ends the backing off.
    clock.on(60 * MINUTE);
    assert_eq!(percent(poll(&limits, &clock, &reads, 30.0)), Some(30.0));
    clock.on(5 * MINUTE);
    failing(&limits);
    let before = attempts.load(Ordering::SeqCst);
    clock.on(MINUTE);
    failing(&limits);
    assert_eq!(attempts.load(Ordering::SeqCst), before + 1);
}

#[test]
fn a_read_under_way_is_not_doubled_and_one_runs_at_a_time() {
    let clock = Clock::new();
    let limits = Arc::new(limits(&clock, None));
    let (entered, entered_seen) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    let running = Arc::new(AtomicBool::new(false));
    let overlapped = Arc::new(AtomicBool::new(false));
    let first = {
        let (limits, running, overlapped) = (limits.clone(), running.clone(), overlapped.clone());
        let at = clock.now();
        std::thread::spawn(move || {
            limits.poll("claude-code", Path::new(DIR), true, || {
                overlapped.fetch_or(running.swap(true, Ordering::SeqCst), Ordering::SeqCst);
                entered.send(()).unwrap();
                released.recv().unwrap();
                running.store(false, Ordering::SeqCst);
                Ok(read_at(at, 10.0))
            })
        })
    };
    entered_seen.recv().unwrap();
    // The same account again: the read under way brings its figures.
    let doubled = AtomicUsize::new(0);
    assert_eq!(poll(&limits, &clock, &doubled, 99.0), None);
    assert_eq!(doubled.load(Ordering::SeqCst), 0);
    // Another account waits for the read under way to end.
    let second = {
        let (limits, running, overlapped) = (limits.clone(), running.clone(), overlapped.clone());
        let at = clock.now();
        std::thread::spawn(move || {
            limits.poll("codex", Path::new(DIR), true, || {
                overlapped.fetch_or(running.swap(true, Ordering::SeqCst), Ordering::SeqCst);
                running.store(false, Ordering::SeqCst);
                Ok(read_at(at, 20.0))
            })
        })
    };
    release.send(()).unwrap();
    assert_eq!(percent(first.join().unwrap()), Some(10.0));
    assert_eq!(percent(second.join().unwrap()), Some(20.0));
    assert!(!overlapped.load(Ordering::SeqCst), "two reads ran at once");
}

#[test]
fn a_read_that_waited_its_turn_is_not_made_where_figures_came_meanwhile() {
    let clock = Clock::new();
    let limits = Arc::new(limits(&clock, None));
    let (entered, entered_seen) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    let blocker = {
        let limits = limits.clone();
        let at = clock.now();
        std::thread::spawn(move || {
            limits.poll("codex", Path::new(DIR), true, || {
                entered.send(()).unwrap();
                released.recv().unwrap();
                Ok(read_at(at, 1.0))
            })
        })
    };
    entered_seen.recv().unwrap();
    let reads = Arc::new(AtomicUsize::new(0));
    let waiting = {
        let (limits, reads, clock) = (limits.clone(), reads.clone(), clock.clone());
        std::thread::spawn(move || poll(&limits, &clock, &reads, 50.0))
    };
    // Wait until the poll is under way, then let a session report.
    let until = Instant::now() + Duration::from_secs(10);
    while !lock(&limits.state)
        .accounts
        .get(&key("claude-code", Path::new(DIR)))
        .is_some_and(|account| account.reading)
    {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(5));
    }
    let heard = serde_json::to_value(read_at(clock.now(), 7.0)).unwrap();
    limits.heard("claude-code", Path::new(DIR), &heard);
    release.send(()).unwrap();
    blocker.join().unwrap();
    assert_eq!(percent(waiting.join().unwrap()), Some(7.0));
    assert_eq!(reads.load(Ordering::SeqCst), 0);
}

#[test]
fn a_sessions_own_reads_keep_the_poll_off_while_they_keep_coming() {
    let clock = Clock::new();
    let limits = Arc::new(limits(&clock, None));
    let recorder = Arc::new(Recorder::default());
    let sink = limits.tap(recorder.clone(), "claude-code", PathBuf::from(DIR));
    let reads = AtomicUsize::new(0);
    // The session reads every five minutes while turns end.
    for _ in 0..4 {
        let mut said = serde_json::to_value(read_at(clock.now(), 40.0)).unwrap();
        said["id"] = json!("int-1");
        sink.emit(INTEGRATED_EVENT, said);
        clock.on(4 * MINUTE);
        assert_eq!(percent(poll(&limits, &clock, &reads, 1.0)), Some(40.0));
        clock.on(MINUTE);
    }
    assert_eq!(reads.load(Ordering::SeqCst), 0);
    // A push during a turn moves figures but is not a read.
    let read = clock.now() - 5 * MINUTE;
    sink.emit(
        INTEGRATED_EVENT,
        json!({"id": "int-1", "type": "limits", "agent": "claude-code", "plan": null,
               "windows": [{"kind": "session", "model": null, "percent": 45.0,
                            "resetsAt": null, "severity": null}],
               "readAt": read, "takenAt": clock.now()}),
    );
    assert_eq!(percent(poll(&limits, &clock, &reads, 50.0)), Some(50.0));
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    // Every event went on to the window as it was.
    let events = recorder.events.lock().unwrap();
    assert_eq!(events.len(), 5);
    assert!(events
        .iter()
        .all(|(name, payload)| name == INTEGRATED_EVENT && payload["id"] == "int-1"));
}

#[test]
fn the_figures_that_moved_last_are_shown_whichever_came_first() {
    let clock = Clock::new();
    let limits = limits(&clock, None);
    let later = serde_json::to_value(read_at(T0 + 10, 60.0)).unwrap();
    limits.heard("claude-code", Path::new(DIR), &later);
    // A read that was taken before what the session said.
    limits.poll("claude-code", Path::new(DIR), true, || Ok(read_at(T0, 5.0)));
    assert_eq!(
        percent(limits.held("claude-code", Path::new(DIR))),
        Some(60.0)
    );
    // Figures of a shape not known here are passed over.
    limits.heard(
        "claude-code",
        Path::new(DIR),
        &json!({"type": "limits", "windows": "many", "takenAt": T0 + 20}),
    );
    limits.heard("claude-code", Path::new(DIR), &json!({"type": "limits"}));
    assert_eq!(
        percent(limits.held("claude-code", Path::new(DIR))),
        Some(60.0)
    );
}

/// A window of `kind`, of `model` where one is named.
fn window(kind: LimitKind, model: Option<&str>, percent: f64) -> LimitWindow {
    LimitWindow {
        kind,
        model: model.map(str::to_string),
        percent,
        resets_at: Some(T0 + 3600),
        severity: None,
    }
}

/// A window as the tests compare it: its kind, model and percent.
type Shown = (LimitKind, Option<String>, f64);

fn shown(limits: &Limits) -> (Vec<Shown>, Option<u64>) {
    match limits.held("claude-code", Path::new(DIR)).unwrap() {
        Event::Limits {
            windows, read_at, ..
        } => (
            windows
                .into_iter()
                .map(|w| (w.kind, w.model, w.percent))
                .collect(),
            read_at,
        ),
        _ => unreachable!(),
    }
}

#[test]
fn a_window_the_account_has_stays_when_a_newer_report_names_fewer() {
    let clock = Clock::new();
    let limits = limits(&clock, None);
    let full = Event::Limits {
        agent: "claude-code".into(),
        plan: Some("max".into()),
        windows: vec![
            window(LimitKind::Session, None, 4.0),
            window(LimitKind::Weekly, None, 69.0),
            window(LimitKind::WeeklyScoped, Some("Fable"), 45.0),
        ],
        read_at: Some(T0),
        taken_at: T0,
    };
    limits.poll("claude-code", Path::new(DIR), true, || Ok(full));
    // What a session's agent pushes between reads names two windows and no read.
    let push = json!({
        "type": "limits", "agent": "claude-code", "plan": null, "readAt": null,
        "takenAt": T0 + 60,
        "windows": [
            {"kind": "session", "model": null, "percent": 5.0, "resetsAt": null, "severity": null},
            {"kind": "weekly", "model": null, "percent": 70.0, "resetsAt": null, "severity": null},
        ],
    });
    limits.heard("claude-code", Path::new(DIR), &push);
    let (windows, read_at) = shown(&limits);
    assert_eq!(
        windows,
        [
            (LimitKind::Session, None, 5.0),
            (LimitKind::Weekly, None, 70.0),
            (LimitKind::WeeklyScoped, Some("Fable".into()), 45.0),
        ]
    );
    assert_eq!(read_at, Some(T0), "the read the figures came after stays");
    // A full read that leaves the row out leaves it as it was.
    clock.on(10 * MINUTE);
    let at = clock.now();
    limits.poll("claude-code", Path::new(DIR), true, || {
        Ok(Event::Limits {
            agent: "claude-code".into(),
            plan: Some("max".into()),
            windows: vec![
                window(LimitKind::Session, None, 6.0),
                window(LimitKind::Weekly, None, 71.0),
            ],
            read_at: Some(at),
            taken_at: at,
        })
    });
    let (windows, read_at) = shown(&limits);
    assert_eq!(windows.len(), 3);
    assert_eq!(
        windows[2],
        (LimitKind::WeeklyScoped, Some("Fable".into()), 45.0)
    );
    assert_eq!(read_at, Some(at));
}

#[test]
fn a_late_report_adds_the_windows_the_held_one_lacks_and_moves_none() {
    let clock = Clock::new();
    let limits = limits(&clock, None);
    let held = serde_json::to_value(read_at(T0 + 10, 60.0)).unwrap();
    limits.heard("claude-code", Path::new(DIR), &held);
    let mut older = read_at(T0, 5.0);
    if let Event::Limits { windows, .. } = &mut older {
        windows.push(window(LimitKind::WeeklyScoped, Some("Fable"), 45.0));
    }
    limits.heard(
        "claude-code",
        Path::new(DIR),
        &serde_json::to_value(older).unwrap(),
    );
    let (windows, _) = shown(&limits);
    assert_eq!(
        windows,
        [
            (LimitKind::Session, None, 60.0),
            (LimitKind::WeeklyScoped, Some("Fable".into()), 45.0),
        ]
    );
}

#[test]
fn the_last_full_read_of_each_account_is_kept_across_a_restart() {
    let clock = Clock::new();
    let home = Scratch::new("limits-kept");
    let file = home.join(".chord").join(LIMITS_FILE);
    let reads = AtomicUsize::new(0);
    {
        let limits = limits(&clock, Some(file.clone()));
        poll(&limits, &clock, &reads, 12.0);
        limits.poll("codex", Path::new("/home/ada/.codex"), true, || {
            Err("signed out".into())
        });
    }
    let kept: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(kept["accounts"].as_array().unwrap().len(), 1, "{kept}");
    assert_eq!(kept["accounts"][0]["agent"], "claude-code");
    assert_eq!(kept["accounts"][0]["dir"], DIR);
    // After a restart the figures are there, with their age, and read again
    // once they are old.
    clock.on(3 * 60 * MINUTE);
    let limits = limits(&clock, Some(file.clone()));
    let held = limits.held("claude-code", Path::new(DIR)).unwrap();
    assert_eq!(told(&held).3, Some(T0));
    assert_eq!(percent(poll(&limits, &clock, &reads, 13.0)), Some(13.0));
    assert_eq!(reads.load(Ordering::SeqCst), 2);
}

#[test]
fn a_kept_file_of_another_shape_is_read_for_what_it_holds() {
    let clock = Clock::new();
    let home = Scratch::new("limits-shapes");
    let file = home.join(LIMITS_FILE);
    std::fs::write(
        &file,
        json!({
            "accounts": [
                {"agent": "claude-code", "dir": DIR, "plan": "max", "readAt": T0, "takenAt": T0,
                 "windows": [
                    {"kind": "monthly", "model": null, "percent": 5.0, "resetsAt": null, "severity": null},
                    {"kind": "weekly", "model": null, "percent": 33.0, "resetsAt": null, "severity": "soon"},
                    {"kind": "session", "model": null, "percent": 11.0, "resetsAt": null, "severity": null}
                 ],
                 "somethingNew": true},
                {"dir": "/home/ada/.codex", "windows": [], "takenAt": T0},
                {"agent": "codex", "dir": "/home/ada/.codex", "windows": []},
                "not an account"
            ],
            "version": 7
        })
        .to_string(),
    )
    .unwrap();
    let limits = limits(&clock, Some(file.clone()));
    let held = limits.held("claude-code", Path::new(DIR)).unwrap();
    let windows = told(&held).2;
    assert_eq!(windows.len(), 1, "{windows:?}");
    assert_eq!(windows[0].kind, LimitKind::Session);
    assert_eq!(limits.held("codex", Path::new("/home/ada/.codex")), None);
    // A file that is not JSON holds nothing, and is written over.
    std::fs::write(&file, "{ half").unwrap();
    let limits = limits_with_file(&clock, file.clone());
    assert_eq!(limits.held("claude-code", Path::new(DIR)), None);
    let reads = AtomicUsize::new(0);
    poll(&limits, &clock, &reads, 1.0);
    let kept: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(kept["accounts"].as_array().unwrap().len(), 1);
}

fn limits_with_file(clock: &Clock, file: PathBuf) -> Limits {
    limits(clock, Some(file))
}

#[test]
fn the_file_keeps_the_most_recently_read_accounts() {
    let clock = Clock::new();
    let home = Scratch::new("limits-many");
    let file = home.join(LIMITS_FILE);
    let limits = limits(&clock, Some(file.clone()));
    for at in 0..(KEEP_ACCOUNTS as u64 + 4) {
        clock.on(1);
        let now = clock.now();
        limits.poll(
            "claude-code",
            &PathBuf::from(format!("/home/ada/{at}")),
            true,
            || Ok(read_at(now, 1.0)),
        );
    }
    let kept: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    let dirs: Vec<_> = kept["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|account| account["dir"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(dirs.len(), KEEP_ACCOUNTS);
    assert_eq!(dirs[0], format!("/home/ada/{}", KEEP_ACCOUNTS + 3));
    assert!(!dirs.contains(&"/home/ada/0".to_string()));
}
