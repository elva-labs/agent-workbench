# Working in this repository

Agent Workbench is a desktop app for coding agents that run as terminal
programs. The README says what it is; the docs under `docs/` say how it is
built and why. Read the doc for the area you are changing before changing it.

## The rules

- **Rust owns state, the webview owns pixels.** Ptys, git, watching, indexes
  and hooks live in the Rust core. The frontend renders and dispatches.
  Anything that needs no window goes in the core crate, not the app.
- **The agent owns the keyboard.** The app claims only modifier chords, and
  never Ctrl+C, Ctrl+R, Tab or Esc from a terminal. See the focus doc.
- **Comments describe the present state.** What is true now, never what
  changed or why the diff exists. That belongs in the commit message.
- **Every change is verified before it is pushed.** Run the tiers that cover
  it; for anything touching the core or the panes, that includes the real app
  through the driver tier.

## Commits

- A short subject, ideally under 72 characters, saying what changed and why.
- No hard-wrapped body: one line per paragraph, blank lines between.
- No AI attribution of any kind, no `Co-Authored-By` trailers.

## Docs

The docs are read by people who know nothing of how the project came to be.
When writing or changing one:

- Write plainly. No punchlines, no rhetorical "if x, then y", no dashes
  standing in for a sentence break, no lines added to sell a point.
- Nothing that needs context the reader does not have: no plans, phases,
  earlier attempts, or answers to questions nobody in the doc asked.
- Do not reference source files or folder structure; they do not stay
  current. Describe the mechanism instead.
- The README says what the project is and what it solves. Architecture and
  behaviour go in their own docs, summarised in the README in a line each.
- Say a thing once and reference it from elsewhere.

## Verifying

```
npm run check         # types
npm run test:unit     # frontend units and components
npm run test:rust     # the core and the app
npm run test:e2e      # the frontend in a browser against a fake core
npm run test:driver   # the real binary over WebDriver, Linux and Windows
```

The Rust workspace is under `src-tauri`; `cargo fmt --all --check`,
`cargo clippy --workspace --all-targets -- -D warnings` and
`cargo test --workspace` are what CI runs there. The driver tier needs
`tauri-driver` and the WebKitGTK driver package on Linux, and runs the
built frontend, not the dev server.

## Conventions

- Frontend state lives in Svelte 5 rune stores; components render them. New
  behaviour gets a unit test for the store and a browser test for what the
  user sees, asserting on geometry and visibility rather than on state.
- Elements the tests reach for carry a `data-testid`. Browser tests run
  against the fake core; when the seam grows, the fake grows with it.
- A new Rust capability goes into the core crate with its own tests, is
  exposed through the wire protocol's dispatcher, and is routed in the app
  by path, so it works on a remote machine as well as here.
