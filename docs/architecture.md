# Architecture

## The rule

**Rust owns state, the webview owns pixels.** Every pty, git query,
filesystem watch, session index and hook lives in the Rust core. The Svelte
frontend renders and dispatches, and holds no truth of its own beyond what
it persists for the window: which projects are open, pane widths, names.

## The two halves

The frontend talks to Rust through one seam: a small interface of commands,
one output channel per pty, and a handful of events (a session ended, a
session got its id, the tree moved, a hook fired, a connection closed).
Tests install a fake behind that seam and drive the real frontend without
Tauri, which is how the browser tier works.

The Rust side is two crates. The **core** has no window attached: ptys, git,
the watcher, the transcript indexes, the hooks and the session log, with an
event sink and a per-pty output that whoever holds the core provides. The
**app** is the window: thin Tauri commands over one core object, the native
menu, the window chrome, and the routing that sends a command to the core
here or to the same core on another machine.

## The core elsewhere

The same core crate builds a daemon that speaks the core's commands as JSON
lines over stdio. The app runs it on a remote machine over ssh and drives it
exactly as it drives its own core, with a path's `ssh://host` prefix deciding
where a command goes. [Remote](remote.md) has the whole of it.

## Agents

An agent is a binary on the login shell's PATH, started in a pty with the
environment that shell would give it. The differences between agents, how
each is started and resumed, where its past sessions are, what it calls a
session, sit behind one seam. [Agents](adapters.md) lists them.

## What is persisted

The core keeps nothing across restarts but what the agents themselves write.
The window remembers the workspace, the layout, its chords, theme and
palette, which sessions were the app's own, and the names it knew sessions
by, all in the webview's local storage, keyed by the real project path. Hooks
the user turns on are written into the project's own agent configuration,
and only there.
