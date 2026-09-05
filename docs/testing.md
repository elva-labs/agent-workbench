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
by `cargo test` on one side, the fake on the other, and by running the app.

That is what the fourth tier is for, below: the real binary on `tauri-driver`.
Two things about it:

- `tauri-driver` supports **Linux and Windows only**. There is no WebDriver for
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

On Windows the same tests are meant to run under WebView2 through Edge
WebDriver, with the fake agents installed as batch files, which is how npm
installs a command there. That job is not green yet: Edge WebDriver starts the
app in its WebView2 mode and reports that the `DevToolsActivePort` file never
appears, with or without the app handing the driver's flags on to WebView2
(`src-tauri/src/webdriver.rs`). The job reports rather than blocks, and
starts the binary on its own first so the log says whether the app came up at
all. The next thing to try is attach mode: start the app with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` and give
the driver `debuggerAddress`, which tauri-driver does not pass through today.

CI runs the browser tier on Linux, the core's own tests on Linux, Windows and
macOS, and the driver tier on Linux, with the Linux smoke screenshot as an
artifact. There is no driver for macOS, so the macOS window is checked by
hand. See [release.md](release.md).
