# Testing

Four tiers, cheapest first. `npm run verify` runs the first three.

| Tier | Command | Covers |
| --- | --- | --- |
| Unit and component | `npm run test:unit` | The frontend's stores and components, in jsdom |
| Rust | `npm run test:rust` | The core crate and the app: environment capture, PATH lookup, the agent seam, ptys, git against repositories built on the fly, the wire protocol, the daemon over stdio |
| Browser | `npm run test:e2e` | The real frontend in a real browser against a fake core: layout, focus, theme, persistence, the dialogs |
| Real app | `npm run test:driver` | The actual binary, driven over WebDriver, with fake agents on PATH |

`npm run test:coverage` reports on the frontend and fails below 80% lines.

## What each tier is for

Unit tests take the load. Anything expressible as a function is one: the
layout arithmetic and the keyboard resolution are pure by design so the hard
cases are cheap to state and instant to run.

The browser tier catches what the model cannot: a pane that the numbers say
is wide enough and the rendered box says is not. Its tests assert on geometry
and on what the user sees, bounding boxes, computed styles, visibility,
rather than on state. A test that could pass while the window looked wrong
belongs in the unit tier.

One unit test reads the window configuration and checks the window cannot be
made narrower than the panes need, since that constraint lives in two files.

## The seam

The browser tier drives the real frontend against a fake core installed at
the one module that talks to Rust, which checks for a fake before reaching
for Tauri. The tests exercise the real terminal, the real write queue and
the real exit policy without emulating Tauri's IPC. The same seam exposes the
live terminal to the page when a fake is installed, because the renderer
draws to a canvas and reading the buffer is the only way to assert that
bytes landed on screen.

The terminal component itself is not unit tested: it needs real layout to
measure a character cell, and jsdom has none. It is covered in the browser,
and the logic behind it is unit tested on its own.

## Running one thing

```
npx vitest run tests/unit/<name>.test.ts     # one unit file
npm run test:unit:watch                      # watch mode
npx playwright test --headed                 # watch the browser do it
npx playwright test -g "splitter"            # one browser test
npx playwright show-report                   # after a failure
```

## The real app

The driver tier runs against the actual binary over WebDriver, under the
renderer the app ships with rather than under Chromium, so it exercises the
core end to end: the environment capture, the pty, git, the watcher, both
transcript readers, and a project on a remote through the daemon. It runs on
Linux and Windows; there is no WebDriver for macOS WKWebView, so the macOS
window is checked by hand.

The agent under test is a script called `claude`, and one called `codex`,
that prints its arguments and echoes what it is told, on a PATH that a fake
login shell puts first, because the core asks the login shell for its
environment rather than trusting its own. Each run gets a home of its own.
On Linux the tier needs `tauri-driver` and the `webkit2gtk-driver` package,
and brings up Xvfb and a window manager on a headless machine. The binary
loads the built frontend served static rather than from the dev server,
whose on-demand compile can hand the first request a component's source as
its stylesheet, and asks the terminals for the DOM renderer, since the
software GL behind a headless X server paints a third WebGL terminal late
or never and WebKit names every GPU the same.

On Windows the harness starts the binary itself with the debugger open and
attaches Edge WebDriver to it, because WebView2 never writes the file Edge
WebDriver waits for when it launches a browser. Two things follow: quitting
the session detaches rather than closing the app, so the harness kills the
process tree itself; and on an elevated runner, where WebView2 ignores its
environment variables, the debugging switch goes into the machine policy for
the run and out again after. When the debugger does not come up, the harness
reports what the app did and what WebView2 is doing, since the log is all a
runner leaves.

The remote road is covered twice: the driver tier opens its repository as
`ssh://test/…` with the daemon standing in for ssh, and a test that runs only
when asked walks the real road against `sshd` on the local machine. See
[remote](remote.md). What runs on which machines in CI is in
[CI and releases](release.md).
