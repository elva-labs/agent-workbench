# Sessions

A session is one agent process in one project, in a pty of its own with its
own terminal and scrollback. A project holds as many as you start, several
projects can be open at once, and switching between any of them stops
nothing. The sessions you are not looking at are hidden rather than
unmounted, and hidden in a way that keeps their box in layout, so a
background session's pty is never resized and never reflows. Each
terminal takes in what its agent draws as it arrives: on the next frame
the window paints, or a moment later when the window paints none, as when
it is minimised or behind other windows. A session that has never been on
screen still has its screen to read, its title and its bell.

Nothing new starts by itself. Opening a project shows what the project has:
live sessions if any and past ones to resume. Opening the app brings back
the sessions that were open when it quit, as described under
[after a restart](#after-a-restart).
The past ones of every open project are read again, in one request per
agent directory and per machine, each time the window comes back into view
and once a minute while it is looked at, so a session run in a terminal
outside the app is there to resume without a restart. A list that has not
changed is left as it is, and a machine that does not answer holds up only
its own projects. A project under [Inactive](#active-and-inactive) is read
on a slower clock, every five minutes while the window is looked at, and
each time the window comes back into view, so a session run in it from a
terminal wakes it; it is read again as it leaves Inactive.

The pane's title row carries two small buttons at its end: the order the
projects are listed in, and a menu with Open project, Open remote project,
for a folder on another machine, New orchestrator session and Settings; see
[remote](remote.md) and [orchestrator](orchestrator.md). Under it sits a
field, `Go to session or project` with the chord of go to, which opens
[go to](focus-model.md#the-palettes), and beside it a button in the accent
that asks for a new session in the palette, which project first when more
than one is open, as the palette's New session does. With no project open,
the pane says so and offers Open project there as well.

Each project starts with a header: its name, the account it runs under as
a tag when that is not the agents' own, and a button that starts a session
in it, bringing it forward first. Beside that button, while the pointer is
on the header, a ⋯ opens the project's own menu, New session and, set apart
below a separator and in the colour of a removal, Close project; a right
click on the header opens it too. Closing a project stops everything
running in it. The header stays in view while the project's rows
scroll under it, until the next project's pushes it out, and a hairline
separates one project from the next. With more than one agent installed, a
new session from a project's own button or menu opens the choice in place
under the project's name, a row per agent; see [agents](adapters.md).

Once there are accounts to tell apart, the foot of the pane names the one
the session on screen runs under, with a button that opens the settings
beside it. Without accounts there is no foot.

A row's own button takes the place of its time while the pointer is on the
row, so it never covers a word of the name. On a live row it is ×, which
stops the session and leaves it under the project's own past; on a past
row it is archive, which files the session with the earlier ones, behind
their row. Two steps, so nothing running is archived by accident. On the
keyboard, Delete does either for the row under the cursor.

Closing a session also closes the browser tabs it owns; see
[browser](browser.md#whose-tabs-they-are). Closing a session or a project
whose editor tabs hold the only copy of unsaved edits asks first, at the
top of the pane; see [the editor](editor.md#nothing-unsaved-goes-unasked).

The kill lives in one place: closing a session stops its pty and clears the
id, and the terminal's own teardown does not, so a second signal never lands
on an id that may since have been reused. On shutdown the pty master closes
with the process and the agent sees SIGHUP. Picking a session that belongs
to another project brings that project forward. A session that hangs under
the session that started it, in another project, is drawn there: picking it
uses the starter's project, and while it is on screen the starter's project
is the one on screen, for the pane and the [palette](focus-model.md#the-palettes)
alike. The project it runs in stays where it was in the list, and the
changes pane, the terminal and the window's title still follow it, since
that is the repository the session works in.

Bringing a project forward, by a click on its header, a pick in go to or
opening it again, shows a session drawn under it: the one on screen when it
is one, else its newest. A project whose only sessions hang under a starter
in another project has none drawn under it, so it is shown with no session
and the keyboard in the pane, and is itself the project on screen, with its
past sessions and its row of earlier ones.

## Active and inactive

The projects split by themselves into two. A project is active while a
session drawn under it is running or waiting for you, while it is the one
on screen, and for a span after anything last happened in it; the span is a
[setting](settings.md#sessions), a week to begin with, and Never keeps
every project active. The active projects are the list. The rest fold
under one row at the foot of the pane, Inactive with how many there are,
closed until it is opened and closed again on the next start. Open, it
lists each with when it was last used, the latest first: `now`, `4m`, `1h`,
a weekday within the week, then `3w`, `2mo`. Past seven of them the rest
stand behind a row that says how many more. Picking one brings it forward,
which is using it, and it is active again, and the pane scrolls to where it
lands among the others. Its ⋯, in the place of its time while the pointer is
on it, opens the same menu as a header's. Nothing is filed by hand.

What happens in a project is the user using it, a row drawn under it
changing what it says, and one of its own transcripts being written, which
counts a session run in a terminal outside the app as well. A row left from
the last quit counts through its transcript, not through being drawn again
at the start. A session that hangs under the session that started it, in
another project, counts toward the project it is drawn under. A project
whose transcripts have not been read yet, and that nothing else keeps
active, is drawn once they have been, in whichever half they put it.

The order of the projects is the user's own: the order button on the title
row is a menu of two, Last used, the latest first, which is where every
setup starts, or Name. Last used is when the user last opened the project
or brought it forward, or started or picked a session in it, from the pane,
the palette or the chord that goes to the next session needing them; for a
project with no such record, when one of its own transcripts was last
written. The window putting a project in front as it opens, and an agent
asking to show something in one, is not the user using it. What the agents
do keeps a project out of Inactive but never moves it. When each project
was last used is kept in the window's own storage, and a project's record
goes when it is closed. The choice of order is kept there too, and Inactive
is listed in the same order. The sessions inside a project are in the order they last
changed, the latest first.

While the pointer is over the pane, or the keyboard is walking its rows,
the order holds still: what is under the pointer or the cursor stays where
it is, rows still come and go, and the order settles once both have
stopped. The keyboard holds it once it moves the cursor or arrives by the
pane's chord, and until it leaves the pane; a click that only leaves the
keyboard in the pane does not, so the order settles as the pointer leaves.
A change of sort applies at once.

On the keyboard the order button and the menu are the first stops on the
cursor path, before the field and the new-session button: Enter opens a
menu, Up and Down walk its items while it is open, and Enter picks. The
Inactive row and what it lets out are on the path like any other row,
Delete on a project closes it, and Up and Down walk the rows in the order
drawn.

<kbd>Cmd</kbd><kbd>.</kbd> goes to the next session that needs you and
puts the keyboard in it. A session needs you when it is asking for a
permission, or when it stopped, ended or rang while nobody was looking.
They are taken in order: those asking for a permission first, and within
each kind the one that has waited longest first. The chord goes to the one
after the session on screen, or to the first when the session on screen is
not among them, and round to the first again after the last. A project
with a session waiting is active by then, so the chord never has to look
under the fold. When no other session needs you, the status bar says so.
While a dialog or a question over the agent pane is up, the chord does
nothing.

## After a restart

The open projects are described all at once. Those on this machine appear
together, in the order they had, with their sessions. A project on another
machine appears when its machine answers, at its place among the others,
and its sessions come back with it, so a machine that is slow or gone does
not hold up the rest, nor a folder opened from outside the app. Until it
answers it keeps its place, and its sessions theirs, in what is remembered
for the next start; a project that cannot be reached is left out from then
on. When the project that was in front is one of those still waiting, the
first project open is put in front meanwhile, with no session selected, and
the one that was in front takes its place when it appears, with the session
that was on screen, unless another project or session has been chosen by
then. If its machine cannot be reached and no session has been chosen, the
project in front selects its most recent session.

The sessions that were open when the app quit come back as rows in their
projects, in the order they had and under the names they had, with nothing
running behind them. Their dot is yellow. The session that was on screen
starts at once, through the agent's resume command, and each of the others
starts when it is selected. Bringing a project forward selects its most
recent session, so that one starts too. A session closed by hand before the
quit stays closed, a session whose project did not open again is left out,
and a session an orchestrator started stays with the orchestrator; see
[orchestrator](orchestrator.md).

The yellow is the terminal's, so a theme that sets its yellow sets this dot
too. In the amber palette, whose accent is a yellow, it is a lemon instead,
so it is never taken for an unread session.

## What a row says

A row's dot is green while a process runs behind it, the yellow below for
a row left from the last quit, the accent while it waits for you, and a
quiet grey once it is done or has ended; only a session asking for a
permission has a ring. A row's first line is its name and, at the end,
when the row last changed: `now`, `4m`, `1h`, a weekday within the week, then `3w`. A session
the agent has left a line for, or one that started others, takes a second
line: the agent's line, in the accent while it asks for a permission, or
for a session that started others what those are doing; at its end is the
model the session was started on, when the app knows it. The two lines are
laid out apart, so the model never narrows the name. A running session
with neither takes one line, and its dot says what it is doing. A row left
from the last quit with nothing running behind it takes one line too, its
name and its time, the time its transcript was last written. Those rows come after the running
ones, and once a project has more than three of them the first two stand
and the rest fold into one row that counts them, such as `8 more from this
week`, which opens in place. No row says which agent it runs.

A row says what its agent is doing. Codex's turn-start, completion and
interruption events are read from its session log every half second. A new
session waits until a turn starts, and a resumed session follows only new
events. Terminal redraws do not start work, and a quiet terminal does not
end an active turn. This works with hooks off. An unavailable or unrecognised
log leaves the row running without the working animation.

For Claude Code without hooks, activity is read off the pty. An agent at work
streams for seconds on end and an agent waiting shows a still screen, give
or take a redraw, so more than a redraw's worth of bytes in each of three
seconds running is **working**, with the dot breathing, and two seconds
without another such second is waiting. A single burst, a clock ticking
over in the footer or a cursor blinking, is not work and holds nothing
back, and nothing the agent draws while starting counts
until it has been sent a line or a minute has passed. A session started
with a prompt has been sent one, and so has one that another session
types a line into. The dot says it on the row, with the words on hover and
for a screen reader; the agent pane's header spells the state out. A
session that goes quiet, ends, or rings for
attention while nobody is looking at it is **unread**: the accent dot, the
name a step stronger than a live session's that has been read, as it is
while a session asks for a permission, `waiting for you` in the agent pane,
a count in the status bar,
and the same count on the app's icon. Having it on
screen in a focused window reads it. A session that goes unread while the
window is in the background also says so through the system, once each time
it goes unread: a notification with the project, the session and what it
waits on, the line the agent left when there is one, and a chime if that is
turned on. Both are switched
in the [settings](settings.md#notifications). A session an orchestrator
started goes unread only when it needs a permission, which no agent can
grant for it: its stopping, ending, ringing or leaving a line is the
orchestrator's to hear, and marks nothing for you. Attention comes through the pty for
both agents, as the bell or a terminal notification, with nothing installed.
With hooks on, a row also carries a line under its name from the turn
that just ended: the first line of what the agent last said, as plain
words, so the row says how the turn ended for someone who was elsewhere.
The agent can leave a line of its own instead, why it stopped or what it
needs, which the ending keeps. Either goes when the session is looked at,
and the next prompt clears it.

With the project's hooks on (Live updates, in the settings) the transitions
are reported by the agent. Both agents' prompt, stop and permission hooks
append to a log the core tails, and from the first line a session's row follows the
hooks: working from the prompt, needs permission while the agent asks,
with a hollow ring on the dot, waiting for you from the stop. A stop that
leaves the agent's own subagents running in the background is not one: the
agent has ended its turn to wait for their report, which starts the next,
and the row stays working through it, with the agent's parting line under
the name. The pty
heuristic stands down for that session, except for two things the hooks
cannot say: output after a permission prompt means it was granted and the
agent went on, and, for Claude Code, a screen that goes still, give or take a
redraw, for five seconds while the hooks still say working means the turn ended
without them, which is what an Escape at the keyboard does. A session
waiting on its subagents is still by nature, and that silence is not read
that way; an idle notice from the agent, which it sends only once nothing
of its own is running, ends the working either way.

## Accounts

With accounts named in the [settings](settings.md#accounts), a project
runs under one of them, and its header carries the account's name as a tag
when that is not the agents' own. A new session then opens the choice
whether or not there is more than one agent, and the choice asks
for the account first: under `new session as`, the accounts share a row
across the column with the project's own marked, and the agents follow
under `with`, even when there is only one. The session starts under the
account marked; a click on another, or Left and Right at the keyboard,
switches it for this one session, and the next choice starts on the
project's account again. A session an orchestrator
starts runs under the project's account unless the start names another,
and a session resumed runs under the account it ran under. The status bar
names the account the active session runs under, Default included, as
long as there are accounts to tell apart.

The past sessions under a project are read from every account's
directory, so a session started under another account is listed under its
project like the rest, with the account's name as a tag, and resumes under
that account.

## Names

A project is its folder's name. Two open projects with the same name each
take as much of the path above them as tells them apart, so two checkouts
of `main-truck` read `work/main-truck` and `spike/main-truck`, the part in
front of the name dimmed.

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

Ours first, the rest behind a row. The agents' history holds every session
run in the project, including ones started from a plain terminal, and months
of those would bury the app's own. The sessions this app has run lately are
remembered by id and listed under the project on screen, one line each
with its time, among the rows left from the last quit and folded with them
once there are more than a few. The others, every agent's together, sit
behind a single row, `33 earlier sessions…`, that counts them and opens a
dialog over them, with a filter that takes every word you type against a
session's name, its id and the worktree it ran in, and Enter or a click on
one to resume it. With more than one agent installed, the dialog says
whose each one is. Resuming one adopts it.
How long lately is, is a [setting](settings.md#sessions): forever to begin
with, or a span after which a session of the app's own that has not changed
goes behind the row with the rest, and a row left from the last quit with
nothing running behind it goes with them.
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

What is read from inside a transcript, the directory it ran in and its
title, is kept against the file's path, modification time, size and, where
the system has them, its inode and change time, so a transcript that has not
changed is not opened again and one that has, or that was replaced, is read
afresh. A link is followed to the file it points at. A title is read only for
a session listed under a project. The past sessions of several projects are
listed from one read of an account's directory, and Codex's index is opened
once for all of them.

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
added. A worktree the workbench makes for a session gets them too, as
[hooks](hooks.md) describes.
