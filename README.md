# Agent Workbench

A desktop app for working with coding agents that run as terminal programs,
Claude Code and Codex CLI today. It puts the agent's own interface in the
middle, the project's live git changes beside it, and every project and
session you have going down the left, so you can run several agents at once,
see what each one changed as it happens, and come back to a session later.

The agents are not wrapped or replaced. Each runs in a real pty, full screen,
with the keyboard almost entirely its own. The app adds what a terminal
window lacks: the changes as they land, past sessions to resume, a session's
state at a glance, and projects on other machines over ssh.

![A session started in a project and given a task; the files it changes land in the changes pane as it works, with the git plugin's fold under the tree, and one of them is opened as a diff.](docs/demo.gif)

## What it does

- **Sessions.** Open a folder and start a session in it, or resume one the
  agent had there before. Several projects and sessions run side by side;
  switching between them stops nothing. A session's row says whether the
  agent is working, waiting for you, or asking for permission.
- **Changes.** The changed files and their diffs, refreshed as the agent
  edits, with a file viewer and search over the tree. Under the tree sit what
  the agent has presented and what runs under the project's sessions. A
  session that moves into a git worktree takes the pane with it.
- **Tools for the agent.** With hooks on, the agent can point at a place in
  a file or at a file's changes, put images, PDFs, documents, pages and
  diagrams in front of you, ask what you are looking at, type a command
  into a terminal for you to run, and leave a line on its session's row.
  See [hooks](docs/hooks.md).
- **Orchestrator.** A session that starts and steers other sessions: it
  opens one per piece of work, in any open project and on a worktree of its
  own, waits on them and answers for them. The sessions it starts fold away
  under their projects until one needs you. See
  [orchestrator](docs/orchestrator.md).
- **Plugins.** A plugin adds to the workbench from outside it: tools for the
  agent, a section under the file tree with rows and actions, and a page of
  its own in the changes pane. The settings offer the sources the workbench
  knows and take one of your own. See [plugins](docs/plugins.md).
- **Browser.** A tab beside the agent for looking at what it is building,
  its docs or a pull request, with a fold under the tree and tools an agent
  can read and drive it with. See [browser](docs/browser.md).
- **Terminal.** Plain shells under the panes, per project, split if you like.
- **Remote projects.** Pair a machine with one pasted token, or name a host
  your ssh already reaches, and work in a folder there. The agent, the
  changes and the shells run on that machine; the window does not know the
  difference. See [remote](docs/remote.md).
- **The look.** Modern to begin with, the panes flush on one surface;
  terminal for mono chrome and panes drawn as boxes. Light, dark or whatever
  the desktop is set to, five palettes, and the terminal's font and the
  interface's chosen apart. See [settings](docs/settings.md).
- **Keyboard first.** The agent owns the keyboard. The app claims a few
  modifier chords, all of them yours to change. See
  [focus](docs/focus-model.md).

## Platforms

macOS, Linux and Windows. The window is the app's own on all three: the
traffic lights over the leftmost pane on macOS, app-drawn controls on the
others. [Platforms](docs/platforms.md) has what differs.

## Installing it

Every [release](https://github.com/elva-labs/agent-workbench/releases) carries
installers: `.dmg` for macOS on either chip, `.AppImage`, `.deb` and `.rpm`
for Linux, `.msi` and a setup `.exe` for Windows. The macOS builds are signed
and notarized. On macOS there is also a tap:

```
brew tap elva-labs/elva
brew install --cask agent-workbench
```

## Running it from source

```
npm install
npm run tauri dev
```

A development build wears an icon of its own, the figure on the accent
rather than on black, so it is told from the installed app in the dock.

Linux needs the WebKitGTK development packages Tauri asks for, plus
`libxdo-dev`, `libayatana-appindicator3-dev` and `librsvg2-dev`.

## Verifying it

```
npm run verify        # types, unit, Rust, end-to-end
npm run test:driver   # the real binary, driven over WebDriver
```

[Testing](docs/testing.md) says what each tier covers.

## Reading

- [Architecture](docs/architecture.md): the one rule, the two halves, and
  the core that runs without a window.
- [Layout](docs/layout.md): the two shapes, what gives way when the window
  shrinks, what moves when a pane goes, the tree and what sits under it, the
  terminal panel, the window's chrome.
- [Sessions](docs/sessions.md): what a session is, what its row says, past
  sessions, and how the changes pane keeps up.
- [Focus](docs/focus-model.md): who owns the keyboard.
- [Settings](docs/settings.md): the four tabs, the appearance and the look,
  fonts and colours, live updates, plugins, keys.
- [Hooks](docs/hooks.md): what the app installs in a project when asked, and
  what it gives, the agent's tools among it.
- [Browser](docs/browser.md): the tab beside the agent, how it is built, and
  what an agent can do with it.
- [Orchestrator](docs/orchestrator.md): a session that starts and steers
  other sessions.
- [Plugins](docs/plugins.md): where they come from, the sources offered out
  of the box, what one may add to the workbench, and how one is written.
- [Agents](docs/adapters.md): Claude Code and Codex CLI, and how they differ.
- [Remote](docs/remote.md): projects on other machines.
- [Platforms](docs/platforms.md): what differs on each.
- [Testing](docs/testing.md) and [CI and releases](docs/release.md).
