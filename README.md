# Agent Workbench

A desktop workbench for coding agent CLIs. Three panes: projects and sessions on
the left, the agent's own TUI fullscreen in the middle, live git changes on the
right. Claude Code first, with an adapter seam defined from the start.

Rust and Tauri v2, Svelte frontend. macOS first, with Linux and Windows kept
working: nothing in the core is macOS-only, CI runs the core on all three, and
the real binary is driven end to end on Linux and Windows.

Per platform:

- **macOS**: the title bar is the app's own, with the window controls over the
  leftmost pane's header. Elsewhere the window is undecorated and the app
  draws the controls at the end of the rightmost pane's header.
- **Linux**: WebKitGTK. Building needs `libwebkit2gtk-4.1-dev`,
  `libayatana-appindicator3-dev`, `librsvg2-dev` and `patchelf`; the driver
  tier needs `webkit2gtk-driver` and `tauri-driver`.
- **Windows**: WebView2. Agents installed by npm are `claude.cmd` and
  `codex.cmd`, which the core runs through `cmd /c`. The optional hook runs
  under Git Bash, which Claude Code needs there anyway. What is not there
  yet: following a session into a worktree, which reads the process's working
  directory and has no Windows implementation.

**Status: the plan is done.** Open a folder, a session starts in it, the right
pane shows the real changed files and diffs as the agent edits them, past
sessions are listed from Claude Code's own transcripts and can be resumed, and
several projects and sessions run side by side.

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
end-to-end tier asserts on geometry rather than state, and
[docs/release.md](docs/release.md) for what CI runs and how a release is cut.

## Layout

```
src/lib/layout.svelte.ts   the two shapes, responsive collapse, persistence
src/lib/files.svelte.ts    file list, scope, and what the viewer shows
src/lib/keymap.ts          the focus model as a pure function
src/lib/keys.svelte.ts     the chords: presets, the user's own, persistence
src/lib/settings.svelte.ts whether the settings are open
src/lib/platform.ts        which desktop this is
src/lib/theme.svelte.ts    light / dark / system
src/lib/styles/tokens.css  semantic tokens, and the 16 ANSI slots beside them
src/lib/styles/palettes.css the other colour palettes, restating the accent
src/lib/core.ts            the one seam to Rust: commands, channel, events
src/lib/workspace.svelte.ts the open projects, the recent list, the picker
src/lib/sessions.svelte.ts every session this window has, live or finished
src/lib/terminals.svelte.ts the shells in the terminal panel, per project
src/lib/exits.ts           exits that arrived before the spawn that owns them
src/lib/drops.svelte.ts    files dropped on the window, typed into a terminal
src/lib/agent.svelte.ts    what the agent pane is doing, and the exit policy
src/lib/terminal.ts        xterm theme from the tokens, and the write queue
src/lib/tree.ts            paths to a folder tree: nesting, sorting, compression
src/lib/components/        Pane shell, Splitter, FileTree, FileViewer, TerminalView, Settings
src/lib/panes/             the three panes and the terminal panel
src/lib/remote.svelte.ts   projects on other machines, and the dialog that reaches them
src-tauri/crates/core/     the core with no window attached, and the remote daemon
  src/api.rs               the core as one object: what a window or a daemon calls
  src/events.rs            the Sink for events and the Output for a pty's bytes
  src/protocol.rs          the wire: JSON lines, and the one dispatcher
  src/client.rs            the near end of the wire: a core elsewhere as an object here
  src/bin/agent-workbench-remote.rs  the daemon: the dispatcher on stdio
  src/project.rs           what a folder is: name, repository root, is it git
  src/git.rs               status, diffs, content and the file listing
  src/transcripts.rs       Claude Code's past sessions, from its transcripts
  src/codex.rs             Codex's past sessions, from its SQLite index
  src/watch.rs             noticing the worktree moved, debounced
  src/hook.rs              the optional hooks, off by default
  src/activity.rs          the session log the hooks append to, tailed
  src/env.rs               the login shell environment, and PATH lookup
  src/adapter.rs           the agent seam: Surface, Caps, ClaudeCode, Codex
  src/shell.rs             the user's shell, started the way the agent is
  src/pty.rs               sessions, their output, and the exit event
  src/cwd.rs               where a process is working, per platform
src-tauri/src/lib.rs       the commands the webview can call, routed by path
src-tauri/src/remote.rs    ssh://host paths to the connection for that host
src-tauri/src/ssh.rs       keys, passwords once, fingerprints, the daemon's install
src-tauri/src/menu.rs      the native menu, with Settings in it
src-tauri/src/chrome.rs    the window's own chrome, per platform
```

## Reading

- [docs/layout.md](docs/layout.md) — the two shapes, what gives way when the
  window shrinks, and why the file viewer is a pane rather than a sheet.
- [docs/focus-model.md](docs/focus-model.md) — who owns the keyboard, and why the
  answer is "the agent, nearly always".
- [docs/testing.md](docs/testing.md) — the three test tiers.
- [docs/remote.md](docs/remote.md) — projects on other machines: the daemon,
  the wire, and getting onto a machine without handling a key.

## Phases

0. **Skeleton and tokens** — layout, splitters, two themes, focus model. Done.
1. **The agent pane** — login-shell PATH, portable-pty, xterm.js over a Tauri Channel. Done.
2. **Changes and diffs** — git2 status, a debounced notify watcher, real diffs. Done.
3. **Projects and sessions** — the transcript index, built on filenames and stat data. Done.
4. **Making it feel like one app** — ANSI theming from the tokens, keyboard resolution. Done.
