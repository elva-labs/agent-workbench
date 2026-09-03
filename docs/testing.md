# Testing

Three tiers, cheapest first. `npm run verify` runs all of them.

| Tier | Command | Covers |
| --- | --- | --- |
| Unit and component | `npm run test:unit` | Everything in `src/lib` — layout arithmetic, keymap, theme, and the components, mounted in jsdom |
| Rust | `npm run test:rust` | The core crate. Empty of logic in phase 0; grows with the PTY, git and session modules |
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

The E2E tier drives the SvelteKit frontend and stops at the IPC boundary, which
has nothing behind it in phase 0.

When phase 1 adds the PTY, the interesting failures move to that boundary, and a
fourth tier joins: WebdriverIO on `tauri-driver`, driving the packaged binary
with a real Rust core behind it. Two things to know before that lands:

- `tauri-driver` supports **Linux and Windows only**. There is no WebDriver for
  macOS WKWebView, so the target platform is the one platform that tier cannot
  run on. It runs in CI on Linux and is a regression net, not a substitute for
  opening the app on a Mac.
- Frontend E2E stays on Playwright. It is faster, it runs everywhere, and mocking
  IPC with `@tauri-apps/api/mocks` covers most pane behaviour without a binary.

## Running one thing

```
npx vitest run tests/unit/layout.test.ts     # one unit file
npm run test:unit:watch                      # watch mode
npx playwright test --headed                 # watch the browser do it
npx playwright test -g "splitter"            # one e2e test
npx playwright show-report                   # after a failure
```
