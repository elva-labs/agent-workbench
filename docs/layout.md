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

The window's `minWidth` is 646, which is the 626 above plus the frame's padding.
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

## The terminal panel

Under either shape sits a strip for plain shells, the way an editor keeps a
terminal below the editors. <kbd>Cmd</kbd><kbd>J</kbd> shows and hides it;
<kbd>Cmd</kbd><kbd>4</kbd> focuses it. Opening it is asking for it, so focus
goes there. It is independent of the shape: review mode neither opens nor
closes it, and it keeps its height across both.

The panel takes its height from the three panes above it, which is one PTY
resize for the agent when it opens and one when it closes. Between those it
follows the same rules as the side panes:

- **Chosen is remembered, forced is not.** Below 366px of content height it
  folds away and comes back, at the same height, when there is room again.
- **Hidden, not unmounted.** The shells in it keep running with the panel
  closed. Showing it again is a fit, not a spawn.
- **It never squeezes the panes below 240px**, and never drops below 120px
  itself. The bar between takes the rest.

Each shell belongs to the project it was opened in and starts there, with the
same environment the agent gets. A list down the right of the panel names the
active project's shells, so switching project switches the list and kills
nothing, and opening the panel on a project with no shell starts one. Typing
`exit` closes the shell, and the last shell of the project you are looking at
takes the panel with it. A shell that dies any other way keeps its place, with
the exit code, because a shell that vanishes on a crash hides the crash.

Shells come in groups, and the panel shows one group at a time. A new shell is
a group of its own; `split` opens one beside the current shell, in its group,
taking half of that shell's width and none of its neighbours'. The list shows
a group as its first shell with the rest indented under it. The bar between
two halves moves the boundary, never below 200px on either side, and Home
makes the group even again. Closing one half leaves you in the one beside it.
Split widths are not persisted: shells do not survive a restart, so neither
does how they were arranged.

The list itself has a bar too, and its width is remembered with the other
widths. It gives way before the shells do: below 140px it stops, and the
shells keep 320px between them.

## The window's own chrome

On macOS the window has no title bar. The frame extends to the top edge
(`titleBarStyle: Overlay`, `hiddenTitle`), and the traffic lights sit over the
header row of whichever pane is at the left edge: sessions normally, the agent
once that pane is closed or folded, the viewer when reviewing hides the agent
too. That pane's header takes a left inset (`CONTROLS_INSET`) so its title
clears them. The pane headers, and the top of the terminal list, are
`data-tauri-drag-region`: grab one to move the window, double-click to zoom.

The lights are lowered to the header's centre by giving the window an empty,
transparent unified toolbar (`chrome.rs`). Tauri's `trafficLightPosition` is
applied once, at creation, and macOS lays the title bar out again on its own
schedule, so a moved position does not hold; a toolbar makes the title bar
taller and AppKit centres the buttons in it on every layout, which is the
same device Electron's inset title bar style uses.

On Windows and Linux the window is undecorated instead, and the app draws
minimize, maximize and close at the end of the rightmost pane's header, where
the platform has them: the changes pane, or the agent once that is closed. The
pane headers are drag regions there too, so the window moves by its top row
and zooms on a double-click, and the platform keeps the resize borders. There
is no menu bar on those platforms, since one would sit in the row the app
took; a menu button at the start of the leftmost header, where macOS has its
lights, pops the native menu with Settings and Quit in it.

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

The process is told one column fewer than the grid has. A glyph can overhang
its cell to the right, an italic *d* most of all, and the renderer clips at the
last column; with that column never written to, the overhang always has room.

## The field above the tree

The pane's toolbar is a search field. What is typed narrows the tree to the
paths holding every word of it, in any order, with every folder on the way
open; or, in **lines** mode, is searched for inside the files and the hits
stand in for the tree, a row per file and a row per hit, the match marked.
A hit opens the file as a whole, scrolled to the line and marked there.
Search follows the scope: the changed files, or every file the tree lists.
It runs through `git grep`, fixed string and case-folded, tracked and
untracked files alike, and is cut at a few hundred hits with a note saying
so. Escape clears the field, then leaves it; Enter searches at once, or
opens the first match in files mode; Down steps into what was found.

Scope, view and reload moved into the menu at the field's end, each with its
chord beside it. The viewer closes from its own bar. <kbd>Cmd</kbd><kbd>F</kbd>
puts the keyboard in the field in files mode when the changes pane has focus,
and <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>F</kbd> in lines mode from anywhere,
opening the pane if it was closed.

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

Nothing starts by itself. Opening a project, or the app, shows what the
project has: live sessions if any, past ones to resume, and a new-session row.
What runs is what you asked for. Starting one on every open would pile up
fresh sessions on every restart, when the one you wanted was in the list.

Which agent a session runs is the row's business: see
[docs/adapters.md](adapters.md) for the two and how they differ.

## Working, and waiting for you

A row says what its agent is doing, read off the pty rather than asked. An
agent at work streams, its spinner and its text keep bytes flowing, and an
agent waiting shows a still screen give or take a redraw; so more than a
redraw's worth of bytes in a second is **working** (the dot breathes) and two
seconds of quiet after that is waiting. A session that goes quiet, ends, or
rings for attention while nobody is looking at it is **unread**: the accent
dot, the name in ink, `waiting for you` in its row and in the agent pane, a
count in the status bar, and the same count on the app's icon. Looking at it,
which is having it on screen in a focused window, reads it; a session on
screen in a focused window never goes unread.

Attention comes through the pty for both agents: Claude Code rings the bell,
Codex sends a terminal notification, and the terminal view hears BEL, OSC 9
and OSC 777 alike. This needs nothing installed.

With the project's hooks installed (the `live updates` toggle, see below),
the transitions are exact instead. Both agents' `UserPromptSubmit`, `Stop`
and permission hooks append their stdin to `~/.agent-workbench/sessions.jsonl`,
the core tails it (`activity.rs`) and tells the window, and from the first
such line a session's row follows the hooks: `working` from the prompt,
`needs permission` while the agent asks, with a hollow ring on the dot,
`waiting for you` from the stop. The pty heuristic stands down for that
session, except for one thing the hooks do not say: output after a permission
prompt means it was granted and the agent went on.

## What a session is called, and where it works

A row is `session N` until the agent says otherwise. Claude Code writes the
session's name into the terminal title, with a status glyph in front and its
own name around it; the title handler strips both and a title that was only
ever "Claude Code" is no title. Naming a session inside Claude Code renames
the row at once. The name is kept by session id in `localStorage` under
`workbench.names`, so the past-session list shows the name you knew a session
by, ahead of any title read from the transcript, and resuming it starts the
row under that name.

Picking a session that belongs to another project brings that project
forward: the panes show the project the session is working in.

The changes pane follows the session, not just the project. Every couple of
seconds the core is asked where the active session's process is working
(procfs on Linux, `proc_pidinfo` on macOS), and a directory it has not seen
before is resolved to its repository root. When that is not the project's own
worktree, the pane watches it instead and says so in its header: the agent
has moved into a worktree, and the changes there are the ones to review.
Switching to another session switches back. This leans on the agent changing
its process directory when it enters a worktree; an agent that only tracks
the directory internally would not be followed.

## Dropping files

A file dropped on the window is its path, typed into the terminal under the
pointer, spaces and shell characters escaped the way a terminal app does it.
Dropped anywhere else on the window, it goes to the terminal the keyboard is
in. Claude Code reads a pasted path and shows an image file as an attachment,
so a screenshot dragged in arrives the same way it would in a plain terminal.

The webview never sees the drag: Tauri takes it at the window and reports the
paths with a position, and `src/lib/drops.svelte.ts` finds the terminal at
that point. The paste is xterm's own, bracketed when the program asked for
that mode. The terminal under a drag shows an accent inset while it lasts.

## Past sessions

Under the live sessions sit the ones Claude Code has already had in this
project, read from `~/.claude/projects/<mangled path>/<session id>.jsonl`.
Clicking one opens it as another live session through `claude --resume`, so a
past conversation becomes a row like any other and the one you were in keeps
running.

**Ours first, the rest behind a fold.** That directory holds every session run
in the project, including Claude Code started from a plain terminal, and a
project with months of those would bury the workbench's own history. The
sessions this app has run are remembered by id in `localStorage` under
`workbench.mine` and listed outright; the others sit behind a single row that
counts them, and unfold on click. Resuming one from there adopts it: it is a
session of this workbench from then on. Nothing is deleted or moved, and the
split does not survive a wiped `localStorage`, which only means everything
shows as from outside until it is resumed again.

**Done reading is done choosing.** Escape, the Esc button, or a click on the
empty part of the tree closes the viewer and clears the selection together.
A highlighted file with no viewer open would be a question the pane cannot
answer.

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
