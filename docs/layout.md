# Layout

Two shapes, one transition, and a set of rules for what gives way when the
window is too small. Implemented in `src/lib/layout.svelte.ts`.

## The two shapes

**Working** is three panes. The agent takes whatever the side panes do not.

**Reviewing** is the changes pane grown into a file viewer, with the sessions
pane folded away, because a session list is no use while reading a diff. Inside
the pane the tree keeps the left column and the content takes the rest.

You enter review by clicking a file, or with <kbd>Cmd</kbd><kbd>D</kbd>. You
leave it with <kbd>Esc</kbd>, the same chord, or the control in the head.

## Why the viewer is not a sheet

A panel that floats over the terminal is a modal wearing a different name: it
traps focus, it hides what you were watching, and it has to be dismissed before
the app is usable again. So the viewer is a pane like any other, and the room
for it comes from somewhere real.

**The tree is the same component in both shapes.** Working, it has the pane to
itself. Reviewing, it becomes the left column and keeps its scroll position, its
open folders and its selection. Nothing is rebuilt and nothing jumps.

A horizontal strip of filenames was the first attempt, and it only worked
because the sample had three files with short names. Real repositories have
folders, so the tree is the shape that survives contact with them.

**Opening a file costs the agent one resize.** The pane holds a tree beside the
content now, and what the sessions pane vacates is 578px at default widths,
which would leave the tree at its minimum. So the pane opens at 700px instead
and the agent gives up the difference, once, on a deliberate mode change. It
gets the width straight back on exit.

**The layout moves once, on entry, not once per file.** Click through twenty
files in the tree and nothing reflows. This is the property that makes the
whole design work: a terminal that reflows every time you glance at a file would
be intolerable, and a terminal that reflows once when you deliberately change
what you are doing is what every IDE does with a file tree.

Drag the viewer's splitter and the app stops sizing it for you. Working and
reviewing remember their widths separately, and so does the tree column, so all
three are yours.

## What gives way, in order

The agent pane is a character grid. Below a certain width a TUI stops being
usable rather than merely looking cramped, so it is the last thing to lose room
and the only pane that can never be closed.

| Content width | Layout |
| --- | --- |
| ≥ 812 | All three panes |
| 626 to 812 | Sessions folds away |
| < 626 | Changes folds away too, agent alone |

The window's `minWidth` is 642, which is the 626 above plus the frame's padding.
That number is not arbitrary: half of a 1440-wide laptop display is 720, and a
minimum above that would make macOS split-screen simply refuse. A unit test
reads `tauri.conf.json` and fails if the two ever drift apart.

Within a shape, the changes pane gives width up before the sessions pane. While
you are working, the file list is the thing you can most afford to have narrow.

## Forced is not chosen

Two different reasons a pane can be missing, and conflating them is a bug:

- **chosen** — you pressed the toggle. Persisted.
- **forced** — the window cannot hold it. Transient, never persisted.

Without the distinction, one stint in split-screen would permanently forget that
you like the sessions pane open. Both states are covered by tests, because the
failure is invisible until a week later.

## Hiding is free, resizing is not

Below 932px of content, review mode **hides** the agent rather than squeezing it.
The pane keeps its width while hidden, so no PTY resize is sent and the terminal
comes back exactly as it was, with no redraw and no rewrapped scrollback.

For the same reason the agent pane is hidden with `display: none` rather than
unmounted. Unmounting would destroy the terminal; hiding costs nothing.

## On window resize

Resizing the window does resize the PTY, and that is fine: you did it, and the
redraw is the obvious consequence of your own action. Two things keep it cheap:

- **Cols and rows are integers.** A few pixels of drag usually does not cross a
  character boundary, so most resize events send nothing at all.
- **The frame's content box is what gets measured**, not `window.innerWidth`.
  Counting the frame's padding as usable width is how the agent pane ends up
  below its minimum, which is a bug the end-to-end tests caught once already.

What cannot be avoided is that scrollback wrapped at the old width stays wrapped
that way. Every terminal has this.

## Inside the tree

Folders come before files, then alphabetical. A chain of folders that holds
nothing but one more folder collapses into a single row, so `src/lib/components`
reads as one line rather than three that each carry no information.

**A folder is open by default when something beneath it changed.** That is what
makes the all-files scope usable: widening the scope on a real repository adds
hundreds of paths, and without this you would have to hunt for the handful the
agent touched. Opening and closing a folder yourself records an override, and
only where it differs from the default, so the stored state stays proportional
to what you changed rather than to what you clicked.

The tree is one tab stop, not one per row. Arrow keys move a cursor within it
(<kbd>Left</kbd> and <kbd>Right</kbd> close and open folders, or step to the
parent and the first child), and <kbd>Enter</kbd> opens the file under the
cursor. The cursor is drawn separately from the open file, so you can walk the
tree without changing what the viewer is showing.

## Sessions

A project holds as many sessions as you start, and switching between them kills
nothing. Each keeps its own PTY, its own terminal and its own scrollback, and
the ones you are not looking at are hidden rather than unmounted.

Hidden here means `visibility: hidden`, not `display: none`. A display-none
element measures zero, and xterm would compute a nonsense grid from it; keeping
the box in layout means a background session's PTY is never resized and never
reflows. The same reasoning as the agent pane hiding rather than unmounting,
one level down.

Several projects can be open at once, each with its own sessions, and all of
them stay alive. Switching project is a change of view, not a teardown, so
there is nothing to confirm. The left pane is where the projects you are not
looking at live; closing one there is what stops its sessions.

**The kill lives in exactly one place.** `close()` stops the PTY and clears the
id; the terminal's own teardown deliberately does not, because a row only
unmounts when it was closed and a second signal would land on an id that may
since have been reused. On shutdown the PTY master closes with the process and
the child sees SIGHUP.

Auto-start is narrowed to match: opening a project starts a session when it has
**none**. A project you return to keeps what it had, and a session that stopped
stays stopped until you ask for another.

## Past sessions

Under the live sessions sit the ones Claude Code has already had in this
project, read from `~/.claude/projects/<mangled path>/<session id>.jsonl`.
Clicking one opens it as another live session through `claude --resume`, so a
past conversation becomes a row like any other and the one you were in keeps
running.

**Built on filenames and stat data, not contents.** The filename is the session
id, mtime is recency, size is a rough length: all stable, all cheap. Titles are
the exception, and every line that parses a transcript is quarantined in
`transcripts.rs` for one reason: the entry format is documented as internal to
Claude Code and changing between versions. A title that cannot be read is a
missing title, never an error, and the row falls back to when it last moved.

The directory name is the project path with every non-alphanumeric character
replaced by a dash, which is lossy: `/a/b-c` and `/a/b_c` mangle the same. So
the workbench keys its own state by the real path and only ever mangles
forwards, never back.

## Live updates

The changes pane learns that the tree moved in one of two ways, and the toggle
under each project says which.

**Filesystem**, the default. A `notify` watcher on the worktree, debounced at
150ms. It costs nothing, needs no permission, and catches every writer: the
agent, your editor, a script, a rebase.

**Hook**, opt-in. A `PostToolUse` hook appended to the project's
`.claude/settings.local.json`, which writes what the agent just did to
`~/.agent-workbench/last-tool-use.json`, a file the same watcher also watches.
It holds the latest event only, so it never grows. What it buys is immediacy
and provenance: the pane hears the moment a tool finishes, and it hears what
the agent actually did rather than inferring it from mtimes.

It is off by default and stays off until asked, because it writes into your
configuration, and nothing should edit that because you opened a folder. It
goes in `settings.local.json` rather than `settings.json` so it never turns up
in a diff. Turning it off removes only that entry and leaves no empty
scaffolding behind.
