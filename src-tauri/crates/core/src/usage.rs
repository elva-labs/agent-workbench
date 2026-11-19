//! A local log of what each session spends, for tuning the thresholds the
//! workbench saves tokens by: each turn's tokens and the context's size,
//! and the account's five-hour figure at each resume, wake and start. It
//! is kept in the workbench's directory, one file per session token, one
//! JSON object per line, and nothing shows it. The window says what
//! happened; for a turn of a Claude Code session in a terminal the core
//! reads the turn's tokens from its transcript.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// The log's folder in the workbench's directory in the user's home.
pub fn folder(home: &Path) -> PathBuf {
    home.join(".agent-workbench").join("usage")
}

/// The size from which a session's log is moved aside to one older file,
/// which it replaces, so a log never holds more than twice this.
pub const MOST: u64 = 2 * 1024 * 1024;

/// How much of a transcript's end is read for its last turn.
const TAIL: u64 = 4 * 1024 * 1024;

/// A session's log file, or None for a token that could name anything
/// but a file of the folder.
fn file(home: &Path, token: &str) -> Option<PathBuf> {
    let fits = !token.is_empty()
        && token.len() <= 128
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    fits.then(|| folder(home).join(format!("{token}.jsonl")))
}

/// Adds one entry to a session's log, with the time it was written in
/// milliseconds since the epoch. The folder and the files are the user's
/// alone.
pub fn append(home: &Path, token: &str, entry: Map<String, Value>, now: u64) -> Result<(), String> {
    let path = file(home, token).ok_or("a session's token names its log")?;
    let dir = folder(home);
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(&dir)
        .map_err(|e| format!("the usage log could not be kept in {}: {e}", dir.display()))?;
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() >= MOST) {
        let _ = std::fs::rename(&path, path.with_extension("1.jsonl"));
    }
    let mut line = Map::new();
    line.insert("at".into(), json!(now));
    line.extend(entry);
    let mut text = Value::Object(line).to_string();
    text.push('\n');
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(&path)
        .and_then(|mut out| out.write_all(text.as_bytes()))
        .map_err(|e| format!("the usage log could not be written: {e}"))
}

/// The tokens of a Claude Code conversation's last turn, from its
/// transcript: summed over the requests since the last message of the
/// user's, with the cache writes split by their lifetime, the context as
/// the last request left it, and how many requests the turn made. None
/// when the transcript's end holds no request.
pub fn last_turn(transcript: &Path) -> Option<Value> {
    let length = std::fs::metadata(transcript).ok()?.len();
    let mut file = std::fs::File::open(transcript).ok()?;
    std::io::Seek::seek(
        &mut file,
        std::io::SeekFrom::Start(length.saturating_sub(TAIL)),
    )
    .ok()?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut file, &mut bytes).ok()?;
    let mut turn: Option<[u64; 6]> = None;
    let mut context = 0;
    let mut seen = std::collections::HashSet::new();
    for line in bytes.split(|byte| *byte == b'\n') {
        let Ok(entry) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if entry["isSidechain"].as_bool() == Some(true) {
            continue;
        }
        let said = entry["type"] == "user"
            && entry["message"]["content"]
                .as_array()
                .is_none_or(|parts| parts.iter().all(|part| part["type"] != "tool_result"));
        if said && entry["isMeta"].as_bool() != Some(true) {
            turn = Some([0; 6]);
            continue;
        }
        let usage = &entry["message"]["usage"];
        if entry["type"] != "assistant" || !usage.is_object() {
            continue;
        }
        // A request's parts are written as entries of their own, each with
        // the request's usage.
        let request = entry["requestId"]
            .as_str()
            .or(entry["message"]["id"].as_str())
            .unwrap_or_default()
            .to_string();
        if !seen.insert(request) {
            continue;
        }
        let read = |key: &str| usage[key].as_u64().unwrap_or(0);
        let written = &usage["cache_creation"];
        let hour = written["ephemeral_1h_input_tokens"].as_u64().unwrap_or(0);
        let short = written["ephemeral_5m_input_tokens"].as_u64();
        let short = short.unwrap_or(read("cache_creation_input_tokens").saturating_sub(hour));
        let sums = turn.get_or_insert([0; 6]);
        for (at, value) in [
            read("input_tokens"),
            read("cache_read_input_tokens"),
            hour,
            short,
            read("output_tokens"),
            1,
        ]
        .into_iter()
        .enumerate()
        {
            sums[at] += value;
        }
        context = read("input_tokens")
            + read("cache_read_input_tokens")
            + read("cache_creation_input_tokens")
            + read("output_tokens");
    }
    let [input, cache_read, written_hour, written_short, output, requests] = turn?;
    (requests > 0).then(|| {
        json!({
            "tokens": {
                "input": input,
                "cacheRead": cache_read,
                "cacheWrite1h": written_hour,
                "cacheWrite5m": written_short,
                "output": output,
            },
            "requests": requests,
            "context": context,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn appends_a_line_per_entry_with_its_time() {
        let home = home();
        append(&home, "tok-1", entry(json!({"kind": "wake"})), 5).unwrap();
        append(&home, "tok-1", entry(json!({"kind": "turn"})), 6).unwrap();
        let text = std::fs::read_to_string(folder(&home).join("tok-1.jsonl")).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            lines,
            [
                json!({"at": 5, "kind": "wake"}),
                json!({"at": 6, "kind": "turn"})
            ]
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&folder(&home)), 0o700);
            assert_eq!(mode(&folder(&home).join("tok-1.jsonl")), 0o600);
        }
    }

    #[test]
    fn refuses_a_token_that_names_another_file() {
        let home = home();
        for token in ["", "../x", "a/b", "a.b", "a\\b"] {
            assert!(append(&home, token, Map::new(), 1).is_err(), "{token}");
        }
        assert!(!folder(&home).exists());
    }

    #[test]
    fn moves_a_full_log_aside_once() {
        let home = home();
        std::fs::create_dir_all(folder(&home)).unwrap();
        let path = folder(&home).join("tok.jsonl");
        std::fs::write(&path, vec![b'x'; MOST as usize]).unwrap();
        append(&home, "tok", entry(json!({"kind": "turn"})), 1).unwrap();
        assert_eq!(
            std::fs::metadata(folder(&home).join("tok.1.jsonl"))
                .unwrap()
                .len(),
            MOST
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"at\":1,\"kind\":\"turn\"}\n"
        );
    }

    #[test]
    fn sums_the_last_turns_requests_from_a_transcript() {
        let home = home();
        let path = home.join("t.jsonl");
        let usage = |input: u64, read: u64, hour: u64, short: u64, out: u64| {
            json!({"input_tokens": input, "cache_read_input_tokens": read,
                "cache_creation_input_tokens": hour + short, "output_tokens": out,
                "cache_creation": {"ephemeral_1h_input_tokens": hour, "ephemeral_5m_input_tokens": short}})
        };
        let lines = [
            json!({"type": "user", "message": {"content": "first"}}),
            json!({"type": "assistant", "requestId": "r0", "message": {"usage": usage(9, 9, 9, 9, 9)}}),
            json!({"type": "user", "message": {"content": "second"}}),
            json!({"type": "assistant", "requestId": "r1", "message": {"usage": usage(2, 100, 50, 0, 10)}}),
            // The same request's next part, and a subagent's request.
            json!({"type": "assistant", "requestId": "r1", "message": {"usage": usage(2, 100, 50, 0, 10)}}),
            json!({"type": "assistant", "isSidechain": true, "requestId": "s", "message": {"usage": usage(7, 7, 7, 7, 7)}}),
            json!({"type": "user", "message": {"content": [{"type": "tool_result"}]}}),
            json!({"type": "assistant", "requestId": "r2", "message": {"usage": usage(1, 150, 0, 5, 20)}}),
        ];
        let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
        std::fs::write(&path, text).unwrap();
        assert_eq!(
            last_turn(&path).unwrap(),
            json!({
                "tokens": {"input": 3, "cacheRead": 250, "cacheWrite1h": 50, "cacheWrite5m": 5, "output": 30},
                "requests": 2,
                "context": 176,
            })
        );
        std::fs::write(
            &path,
            "{\"type\":\"user\",\"message\":{\"content\":\"hi\"}}\n",
        )
        .unwrap();
        assert_eq!(last_turn(&path), None);
    }
}
