//! Being driven by WebDriver on Windows.
//!
//! Edge WebDriver starts the app the way it would start a browser: with
//! `--remote-debugging-port` and `--user-data-dir` on the command line, and
//! then waits for the `DevToolsActivePort` file to appear in that directory.
//! The app itself reads neither. WebView2 does, when they come as the two
//! environment variables its runtime honours over whatever the app asked
//! for, which is what these are for. Outside a driver session there are no
//! such arguments and nothing happens.

/// The variables to set for the arguments given, in order.
pub fn forwarded(args: impl IntoIterator<Item = String>) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    for arg in args {
        if let Some(port) = arg.strip_prefix("--remote-debugging-port=") {
            out.push((
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                format!("--remote-debugging-port={port}"),
            ));
        } else if let Some(dir) = arg.strip_prefix("--user-data-dir=") {
            out.push(("WEBVIEW2_USER_DATA_FOLDER", dir.to_string()));
        }
    }
    out
}

/// Applies them, before any webview exists. A no-op everywhere but Windows,
/// where WebView2 is the one that reads them.
pub fn forward() {
    if !cfg!(windows) {
        return;
    }
    for (name, value) in forwarded(std::env::args().skip(1)) {
        // Process-wide and set before the runtime starts any thread that
        // would read it, which is what makes this sound.
        unsafe { std::env::set_var(name, value) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hands_the_driver_s_arguments_to_webview2() {
        let vars = forwarded(
            [
                "--remote-debugging-port=0",
                "--user-data-dir=C:\\tmp\\scoped_dir",
                "--enable-automation",
            ]
            .map(String::from),
        );
        assert_eq!(
            vars,
            [
                (
                    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                    "--remote-debugging-port=0".to_string()
                ),
                (
                    "WEBVIEW2_USER_DATA_FOLDER",
                    "C:\\tmp\\scoped_dir".to_string()
                ),
            ]
        );
    }

    #[test]
    fn a_plain_start_sets_nothing() {
        assert!(forwarded(Vec::<String>::new()).is_empty());
        assert!(forwarded(["--verbose".to_string()]).is_empty());
    }
}
