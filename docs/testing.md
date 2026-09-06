# Testing

Three tiers, cheapest first. `npm run verify` runs all of them.

| Tier | Command | Covers |
| --- | --- | --- |
| Unit and component | `npm run test:unit` | Everything in `src/lib` — layout arithmetic, keymap, theme, and the components, mounted in jsdom |
| Rust | `npm run test:rust` | The core crate: environment parsing, PATH lookup, the adapter seam, the session registry, and git status/diff against real repositories built on the fly |
| End-to-end | `npm run test:e2e` | The real app in a real browser: drag, collapse, focus, theme, persistence across reload |

`npm run test:coverage` reports on `src/lib` and fails below 80% lines.

## What each tier is for

**Unit tests take the load.** Anything expressible as a function is one:
`clampWidths` and `resolveAction` are pure by design precisely so the hard cases
(a window too narrow for its panes, a chord that belongs to the agent) are cheap
to state and instant to run.

**E2E tests are the ones that catch the lies.** They found the first real bug in
this repo: `clampWidths` was being handed `window.innerWidth` while the panes
actually divided a box 16px narrower, so the agent pane fell to 344px at the
smallest window and every unit test still passed. A test that measures the
rendered box catches that; a test that measures the model cannot.

So the rule for the E2E tier: **assert on geometry and on what the user sees**,
not on state. `boundingBox().width`, computed styles, visibility. If a test
could pass while the window looked wrong, it belongs in the unit tier instead.

## Cross-file invariants

`tests/unit/window-minimum.test.ts` reads `tauri.conf.json` and checks the window
cannot be made narrower than the panes need. One constraint lives in two files,
and this is what keeps them honest.

## The Tauri boundary

The end-to-end tier drives the SvelteKit frontend against a **fake core**.
`src/lib/core.ts` is the one module that talks to Rust, and it checks
`window.__WORKBENCH_CORE__` before reaching for Tauri. The tests install a fake
there in `addInitScript`, which means they exercise the real terminal, the real
write queue and the real exit policy without emulating Tauri's IPC internals.

That seam also exposes the live `Terminal` to the page, but only when a fake
core is already installed. The WebGL renderer draws glyphs to a canvas rather
than to the DOM, so reading the buffer is the only way to assert that bytes
arriving on the channel actually land on screen.

What this tier does not cover is Rust itself. The two halves meeting is checked
by `cargo test --workspace` on one side, the fake on the other, and by running the app.

That is what the fourth tier is for, below: the real binary on `tauri-driver`.
Two things about it:

- The tier runs on **Linux and Windows only**. There is no WebDriver for
  macOS WKWebView, so the target platform is the one platform that tier cannot
  run on. It is a regression net for the core, not a substitute for opening
  the app on a Mac.
- Frontend end-to-end stays on Playwright. It is faster, it runs everywhere, and
  the fake core covers pane behaviour without a binary.

## What is not unit tested, and why

`AgentPane` mounts xterm.js, which needs real layout to measure a character
cell. jsdom has none, so the component is covered end to end in a real browser
and the logic behind it is unit tested on its own: the status machine in
`agent.svelte.ts`, the theme and write queue in `terminal.ts`, and the channel
payload normalisation in `core.ts`.

## Running one thing

```
npx vitest run tests/unit/layout.test.ts     # one unit file
npm run test:unit:watch                      # watch mode
npx playwright test --headed                 # watch the browser do it
npx playwright test -g "splitter"            # one e2e test
npx playwright show-report                   # after a failure
```

## The real app: the driver tier

`npm run test:driver` runs `tests/driver` against the actual binary, over
WebDriver. `tauri-driver` bridges the W3C protocol to the platform's own
WebView driver, WebKitWebDriver on Linux, so this is the tier that exercises
the core end to end: the environment capture, the pty, git2, the watcher and
both transcript readers, under the renderer the app ships with rather than
under Chromium. It needs `cargo install tauri-driver` and the
`webkit2gtk-driver` package; on a headless machine `scripts/driver.sh` brings
up Xvfb and a window manager first.

The agent under test is a shell script called `claude` (and one called
`codex`) that prints its arguments and echoes what it is told. It sits in a
directory that a fake login shell puts first on PATH, because the core asks
the login shell for its environment rather than trusting its own. Each run
gets a HOME of its own, so nothing the app persists leaks between runs.

The binary loads the frontend from the dev URL, and what answers there is the
built frontend served static by `vite preview`, not the dev server. The dev
server compiles on demand, and a first request that races the compile of a
component gets that component's raw source served as its stylesheet, which
WebKit hits reliably on a fresh server. `scripts/smoke.sh`, which photographs
the window, serves it the same way.

### Windows attaches instead of launching

The same tests run on Windows under WebView2 through Edge WebDriver, with the
fake agents installed as batch files, which is how npm installs a command
there. Getting there took a different route than Linux, and the reason is
worth keeping.

Edge WebDriver starts the app the way it starts a browser: it passes
`--remote-debugging-port` and `--user-data-dir`, then waits for a
`DevToolsActivePort` file to appear in that directory. **WebView2 never
writes that file.** It is a Chrome-browser courtesy, not a WebView2 one, so
forwarding the flags cannot help: not as flags, and not as the two
environment variables the runtime honours over them. Remote debugging really
does come up, and `/json/version` answers on the port; the file the driver is
waiting for simply never arrives, so it kills the app and reports a crash.

So on Windows the harness starts the binary itself with the debugger open and
hands Edge WebDriver `debuggerAddress` to attach to what is already running.
That skips `tauri-driver`, whose only job there was the launch that cannot
work. Linux is unchanged: `tauri-driver` still bridges to WebKitWebDriver and
still starts the binary.

Two things follow from attaching rather than launching, both in
`tests/driver/harness.ts`:

- Quitting the session detaches instead of closing the app, so the harness
  kills the process tree itself. The tree, because the app is the parent of
  WebView2's own processes.
- The run's scoped `HOME` is set, but **not** `USERPROFILE`. `home_directory()`
  reads `HOME` first, so the core is satisfied either way, and moving
  `USERPROFILE` off the real profile stops WebView2 opening its debugging port
  at all. That one fails silently.
- The webview gets a profile of its own per run, so the tests never touch
  the real app's and nothing persists between runs. It lives under the real
  `%LOCALAPPDATA%`, next to where the app would put its own, rather than
  under the run's temp `HOME`: WebView2 is particular about where its
  profile goes, and on the CI runner the temp directory is on another drive.

- **Elevated, WebView2 ignores every `WEBVIEW2_*` variable**, and Microsoft's
  security guidance names `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` first; the
  machine policy under `HKLM\SOFTWARE\Policies\Microsoft\Edge\WebView2` is
  what an elevated host reads. A GitHub runner runs its job elevated, which
  is how the switch went missing from the browser process's command line
  there while the same environment worked on a developer's machine. So when
  the harness finds itself at high integrity it writes the switch to that
  policy, keyed by the executable's name, and removes it after. At standard
  integrity it never touches the registry.

When the debugger does not come up, the harness says whether the app died,
with its exit code and everything it printed, or is still running with no
port open; then whether the port accepts a connection at all, and every
`msedgewebview2.exe` with its type and the debugging and profile switches
on its command line, and what is listening per `netstat`. Those are
different problems, and the log is all a runner leaves.

CI runs the browser tier, the core's own tests and the driver tier on Linux
for every push and pull request, with the Linux smoke screenshot as an
artifact. The core's tests on Windows and macOS and the driver tier on
Windows run nightly, only on a day main moved, or on request from the
Actions tab: those runners cost two and ten Linux minutes a minute. There is no driver for macOS, so the macOS window
is checked by hand. See [release.md](release.md).

The driver tier also opens its repository as `ssh://test/<repo>`, with
`WORKBENCH_REMOTE_COMMAND` pointing the app at the daemon itself where it
would run ssh, so a project on another machine is exercised end to end
without one. The real road, through `sshd` on this machine with the app's
own key and the daemon installed over ssh, is `src-tauri/tests/localhost.rs`,
which runs only with `WORKBENCH_SSH_LOCALHOST=1`. See [remote.md](remote.md).
