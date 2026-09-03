# Agent Workbench

A desktop workbench for coding agent CLIs. Three panes: projects and sessions on
the left, the agent's own TUI fullscreen in the middle, live git changes on the
right. Claude Code first, with an adapter seam defined from the start.

Rust and Tauri v2, Svelte frontend. macOS is the target; Windows and Linux come
later, so nothing in the core is allowed to be macOS-only.

**Status: phase 0.** The window opens, the panes resize, and the file viewer
works against sample data. Nothing is wired to a real agent or a real repository
yet, which is the whole point of the phase.

## The rule that keeps it coherent

**Rust owns state, the webview owns pixels.** Every PTY, git query, filesystem
watch and session index lives in the Rust core. Svelte renders and dispatches,
and holds no truth of its own.

## Running it

```
npm install
npm run tauri dev
```

Linux also needs `libwebkit2gtk-4.1-dev`, `libxdo-dev`, `libayatana-appindicator3-dev`
and `librsvg2-dev`.

## Verifying it

```
npm run verify        # types, unit, Rust, end-to-end
npm run test:unit     # vitest, jsdom
npm run test:e2e      # playwright, real browser
npm run test:coverage # fails under 80% lines on src/lib
scripts/smoke.sh      # boots the real Tauri binary and photographs the window
```

See [docs/testing.md](docs/testing.md) for what each tier is for and why the
end-to-end tier asserts on geometry rather than state.

## Layout

```
src/lib/layout.svelte.ts   the two shapes, responsive collapse, persistence
src/lib/files.svelte.ts    file list, scope, and what the viewer shows
src/lib/keymap.ts          the focus model as a pure function
src/lib/theme.svelte.ts    light / dark / system
src/lib/styles/tokens.css  semantic tokens, and the 16 ANSI slots beside them
src/lib/components/        Pane shell, Splitter, FileViewer
src/lib/panes/             the three panes
src-tauri/src/lib.rs       the core; empty until phase 1
```

## Reading

- [docs/layout.md](docs/layout.md) — the two shapes, what gives way when the
  window shrinks, and why the file viewer is a pane rather than a sheet.
- [docs/focus-model.md](docs/focus-model.md) — who owns the keyboard, and why the
  answer is "the agent, nearly always".
- [docs/testing.md](docs/testing.md) — the three test tiers.

## Phases

0. **Skeleton and tokens** — layout, splitters, two themes, focus model. Done.
1. **The agent pane** — login-shell PATH, portable-pty, xterm.js over a Tauri Channel.
2. **Changes and diffs** — git2 status, a debounced notify watcher, CodeMirror merge view.
3. **Projects and sessions** — the transcript index, built on filenames and stat data.
4. **Making it feel like one app** — ANSI theming from the tokens, keyboard resolution.
