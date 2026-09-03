# Testing

Three tiers, cheapest first. `npm run verify` runs all of them.

| Tier | Command | Covers |
| --- | --- | --- |
| Unit and component | `npm run test:unit` | Everything in `src/lib` — layout arithmetic, keymap, theme, and the components, mounted in jsdom |
| Rust | `npm run test:rust` | The core crate: login-shell environment parsing, PATH lookup, the adapter seam, and the session registry |
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

A fourth tier is still worth adding: WebdriverIO on `tauri-driver`, driving the
packaged binary with a real Rust core behind it. Two things to know before that
lands:

- `tauri-driver` supports **Linux and Windows only**. There is no WebDriver for
  macOS WKWebView, so the target platform is the one platform that tier cannot
  run on. It runs in CI on Linux and is a regression net, not a substitute for
  opening the app on a Mac.
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
