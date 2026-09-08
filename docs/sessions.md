# Sessions

A session is one agent process in one project, in a pty of its own with its
own terminal and scrollback. A project holds as many as you start, several
projects can be open at once, and switching between any of them stops
nothing. The sessions you are not looking at are hidden rather than
unmounted, and hidden in a way that keeps their box in layout, so a
background session's pty is never resized and never reflows.

Nothing starts by itself. Opening a project, or the app, shows what the
project has: live sessions if any, past ones to resume, and a new-session
row. With more than one agent installed the row opens in place into a row
per agent; see [agents](adapters.md).

A row's own button appears over its end on hover, so a name is never
squeezed to make room for it. On a live row it is ×, which stops the session
and leaves it under the project's own past; on a past row it is archive,
which files the session with the ones to resume, behind the fold. Two steps,
so nothing running is archived by accident. On the keyboard, Delete does
either for the row under the cursor.

The kill lives in one place: closing a session stops its pty and clears the
id, and the terminal's own teardown does not, so a second signal never lands
on an id that may since have been reused. On shutdown the pty master closes
with the process and the agent sees SIGHUP. Picking a session that belongs
to another project brings that project forward.

## What a row says

A row says what its agent is doing. Read off the pty, an agent at work
streams for seconds on end and an agent waiting shows a still screen, give
or take a redraw, so more than a redraw's worth of bytes in each of three
seconds running is **working**, with the dot breathing, and two seconds of
quiet after that is waiting. A single burst, a clock ticking over in the
footer, is not work, and nothing the agent draws while starting counts
until you have sent it a line or a minute has passed. The dot is the whole of it on the
row, with the words on hover and for a screen reader; the agent pane's
header spells the state out. A session that goes quiet, ends, or rings for
attention while nobody is looking at it is **unread**: the accent dot, the
name in ink, `waiting for you` in the agent pane, a count in the status bar,
and the same count on the app's icon. Having it on
screen in a focused window reads it. Attention comes through the pty for
both agents, as the bell or a terminal notification, with nothing installed.

With the project's hooks on (Live updates, in the settings) the transitions
are exact instead. Both agents' prompt, stop and permission hooks append to
a log the core tails, and from the first line a session's row follows the
hooks: working from the prompt, needs permission while the agent asks,
with a hollow ring on the dot, waiting for you from the stop. The pty
heuristic stands down for that session, except that output after a
permission prompt means it was granted and the agent went on.

## Names

A project is its folder's name. Two open projects with the same name each
take as much of the path above them as tells them apart, so two checkouts
of `main-truck` read `work/main-truck` and `spike/main-truck`.

A row is `session N` until the agent says otherwise. Claude Code writes the
session's name into the terminal title, with a status glyph in front and its
own name around it; both are stripped, and a title that was only ever the
agent's name is no title. Codex keeps names in its own index, which is
polled. A name is kept by session id, so the past-session list shows the
name you knew a session by, and resuming it starts the row under that name.

## Following the session

The changes pane follows the session, not just the project. Every couple of
seconds the core is asked where the active session's process is working, and
a directory it has not seen before is resolved to its repository root. When
that is not the project's own worktree, the pane watches it instead and says
so in its header: the agent has moved into a worktree, and the changes there
are the ones to review. Switching to another session switches back. This
relies on the agent changing its process directory when it enters a
worktree.

## Dropping files

A file dropped on a terminal is its path, typed there with spaces and shell
characters escaped the way a terminal app does it. Dropped anywhere else on
the window, it goes to the terminal the keyboard is in. Claude Code reads a
pasted path and shows an image file as an attachment, so a screenshot
dragged in arrives the way it would in a plain terminal. The webview never
sees the drag: the window takes it and reports paths with a position, and
the terminal under a drag shows an accent inset while it lasts.

## Past sessions

Under the live sessions sit the ones the agent has already had in this
project, read from the agent's own transcripts or index. Clicking one opens
it as another live session through the agent's resume command, so a past
conversation becomes a row like any other and the one you were in keeps
running.

Ours first, the rest behind a row. The agent's history holds every session
run in the project, including ones started from a plain terminal, and months
of those would bury the app's own. The sessions this app has run are
remembered by id and listed outright; the others sit behind a single row per
agent that counts them and opens a dialog over them, with a filter that
takes every word you type against a session's name, its id and the worktree
it ran in, and Enter or a click on one to resume it. Resuming one adopts it.
Nothing is deleted or moved, and the split does not survive a wiped local
storage, which only means everything shows as from outside until it is
resumed again.

A session run in a directory under the project, a worktree the agent made
most of all, is filed by the agent under that directory rather than the
project. Both lists take those in as the project's own, marked with the
worktree's name, and resuming one starts the agent in that worktree again.

The lists are built on filenames and stat data, not contents: the filename
is the session id, mtime is recency, size a rough length. Titles are the
exception, and every line that parses an agent's own format is quarantined
so that a title that cannot be read is a missing title, never an error.

## Live updates

The changes pane learns that the tree moved in one of two ways, chosen per
open project in the settings.

**Watcher only**, the default: a filesystem watcher on the worktree,
debounced. It costs nothing, needs no permission, and catches every writer:
the agent, your editor, a script, a rebase.

**Agent hooks**, opt-in: hooks written into the project's own agent
configuration, which report each edit the moment a tool finishes and give
the row its exact state, as above. They are off until asked for, because
they write into your configuration, and nothing should edit that because you
opened a folder. They go where the agent keeps local, uncommitted settings,
so they never turn up in a diff, and turning them off removes only what was
added.
