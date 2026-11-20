# Sessions

A session is one agent process in one project. In a terminal session it runs
in a pty of its own with its own terminal and scrollback; an integrated
session has no terminal, and the window draws its conversation instead, as
[integrated sessions](#integrated-sessions) describes. A project holds as
many as you start, several
projects can be open at once, and switching between any of them stops
nothing. The sessions you are not looking at are hidden rather than
unmounted. A terminal session is hidden in a way that keeps its box in
layout, so a background session's pty is never resized and never reflows.
An integrated session's conversation is taken out of layout while it is
not in front, so a window holding many costs no more to lay out than one
holding the conversation on screen; it comes back where it was left, and
at its foot if it was following it. Each
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
for a folder on another machine, and Settings; see [remote](remote.md).
Under it sits a
field, `Go to session or project` with the chord of go to, which opens
[go to](focus-model.md#the-palettes), and beside it a button in the accent
that asks for a new session in the palette, which project first when more
than one is open, as the palette's New session does. With no project open,
the pane says so and offers Open project there as well.

Each project starts with a header: its name, the account it runs under as a
tag when that is not the agents' own, and a button that starts a session in
it. Beside that button, while the pointer is on the header, a ⋯ opens the
project's own menu, New session and, set apart below a separator and in the
colour of a removal, Close project; a right click on the header opens it
too. Closing a project stops everything running in it. The header stays in
view while the project's rows scroll under it, until the next project's
pushes it out, and the list's scroll bar is drawn over the headers as it is
over the rows. A hairline separates one project from the next. With more
than one agent installed, a new session from a project's own button or menu
opens the choice in place under the project's name, a row per agent; see
[agents](adapters.md). Nothing else changes until a session is picked: the
session on screen stays, the list keeps its order, and the project comes
forward with the new session once it starts, which is when it counts as
used. None of the project's other sessions is put on screen on the way, so
none of them starts. Backing out of the choice leaves everything as it was.
The `orchestrator` folder an earlier version kept sessions in is listed among
the projects while it holds past sessions, with no button for a new session
and Close project alone in its menu; see [orchestrator](orchestrator.md).

A row's own button takes the place of its time while the pointer is on the
row, so it never covers a word of the name. On a live row it is ×, which
stops the session and leaves it under the project's own past; on a past
row it is archive, which files the session with the earlier ones, behind
their row. Two steps, so nothing running is archived by accident. On the
keyboard, Delete does either for the row under the cursor.

Closing a session also closes the browser tabs it owns; see
[browser](browser.md#whose-tabs-they-are), and the shells opened beside it;
see [the terminal panel](layout.md#the-terminal-panel). Closing a session
or a project whose editor tabs hold the only copy of unsaved edits asks
first, at the top of the pane; see
[the editor](editor.md#nothing-unsaved-goes-unasked). So does closing one
while a shell that goes with it has something running, naming what runs.

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
on screen, while the choice for a new session in it is open, and for a span
after anything last happened in it; the span is a
[setting](settings.md#sessions), a week to begin with, and Never keeps
every project active. The active projects are the list. The rest fold
under one row at the foot of the pane, Inactive with how many there are,
closed until it is opened and closed again on the next start. Open, it
lists each with when it was last used, the latest first: `now`, `4m`, `1h`,
a weekday within the week, then `3w`, `2mo`. Past seven of them the rest
stand behind a row that says how many more. Picking one brings it forward,
which is using it, and it is active again, and the pane scrolls to where it
lands among the others. Its ⋯, in the place of its time while the pointer is
on it, opens the same menu as a header's. Its New session does what a
header's does, and the pane scrolls to the project, which stands among the
active ones while its choice is open and goes back under Inactive if
nothing is picked. Nothing is filed by hand.

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
setup starts, or Name. Last used is when the user last opened the project or
brought it forward, or started or picked a session in it, from the pane, the
palette or the chord that goes to the next session needing them; for a
project with no such record, when one of its own transcripts was last
written. The window putting a project in front as it opens, and an agent
asking to show something in one, is not the user using it. What the agents do keeps a project out of
Inactive but never moves it. When each project was last used is kept in the
window's own storage, and a project's record goes when it is closed. The
choice of order is kept there too, and Inactive is listed in the same order.
The sessions inside a project are in the order they last changed, the latest
first, with one exception: its past sessions come after every session still
open, however lately they changed.

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
recent session, so that one starts too; asking for a new session in it does
not, as the project's header describes above. A session closed by hand
before the quit stays closed, a session whose project did not open again is
left out, and a session another session started stays with its starter,
which brings it back when it is wanted, rather than coming back as a row;
see [orchestrator](orchestrator.md#when-the-work-is-over). A session left open in the `orchestrator`
folder of an earlier version comes back too, and lists that folder again;
see [orchestrator](orchestrator.md).

A row that was unread when the app quit comes back unread, with the line
it had under its name, whether it went unread by itself or was marked by
hand; a row that was read comes back read, and none of its lines is kept,
so marking it unread then puts no line back. A mark made by hand comes
back with its rule. This holds for a
terminal and an integrated session, whether its agent is started again or
the row is left as it was, and for a session another session started, which
comes back unread when its starter brings it back. A row that has not come
back within a week, as when its project does not open again or its starter
is not resumed, is let go, and comes back read if it ever does. What waits is kept as
it changes, not on the way out, so a crash keeps it as a quit does. It
counts at once in the status bar, on the app's icon and for the chord to
the next session that needs you, and coming back says nothing through the
system: what was unread was news before the quit. What happens after it is
news as it would have been before. The session the restore puts on screen
is not read by being put there, nor by the window being looked at: unread,
it waits as a mark made on screen does, until another session has been on
screen and the user comes back to it, writes to it, or marks it read. A
session that ended before the quit is not among the rows that come back,
and its unread with it. A version that does not keep what waits, run in
between, leaves the rows to come back read.

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
model the session was started on, when the app knows it, or for a session
that started others how many of them it has not yet heard from, as the
[orchestrator](orchestrator.md#in-the-panes) describes. The two lines are
laid out apart, so the model never narrows the name. A running session
with neither takes one line, and its dot says what it is doing. A row left
from the last quit with nothing running behind it takes one line too, its
name and its time, the time its transcript was last written, unless it
came back unread with a line, as [after a restart](#after-a-restart)
says. Those rows come after the running
ones, and the project's past sessions after them. Once a project has more
than three rows with nothing running, the first two stand and the rest fold
into one row that counts them, such as `8 more from this week`. Opened, that
row stays where it is with the rows it holds under it, and closes them away
again. Every row's name starts at the same place, past its dot. No row says
which agent it runs.

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
types a line into. An idle agent also keeps house by itself: Claude Code
writes a recap of the conversation while you are away and compacts a long
one before its cache expires, each under a spinner for seconds. Once you
have read a session at rest, output nobody sent it a line for counts as
work only when it draws the bullet Claude Code puts before what it says or
does in a turn, which a recap and a compaction do not draw of their own.
That holds once the session's own turns have been seen to draw the
bullet; until then all such output can be work. Output cannot tell
everything apart: a recap or compaction that moves the conversation on a
full screen draws the bullets already there again and counts as work,
and a turn with less than three seconds of output is not seen at all.
With hooks on, every turn is reported, one the agent starts by itself
included, and output decides neither. The dot says
it on the row, with the words on hover and for a screen reader; the status
bar spells the state out. A session that goes quiet, ends, or
rings for attention while nobody is looking at it is **unread**: the accent dot, the
name a step stronger than a live session's that has been read, as it is
while a session asks for a permission, `waiting for you` in the status bar
and a count at its end, and the same count on the app's icon. Having it on
screen in a focused window reads it. A session read stays read until the
agent does something new: a turn that ends, a permission it asks for, a
line it leaves, its ending, or a bell while it works. A notice that only
says again that it waits changes nothing: Claude Code's idle notice, which
it sends a minute after a turn ends and again a minute after each recap or
compaction, and a bell or terminal notification from a session read at
rest with nothing new from it since, when its hooks report its turns.
Without hooks such a bell is news, since a short turn may show nothing
else. A session that goes unread while the
window is in the background also says so through the system, once each time
it goes unread: a notification with the project, the session and what it
waits on, the line the agent left when there is one, and a chime if that is
turned on. A question that waits on the user says so the same way, once for
each question, when it comes while the window is in the background: an
integrated session's permission or question, one asked by a session another
started included, the workbench's question when a session wants to start
another, and an agent's change to the settings. The notification names the
project and the session that asks, and says what for in a line, with no
more than the row would show of what is asked: a question's own words, a
command by its program alone, an address without its query or fragment, a
session another wants to start by the name it would have, and a change to
the settings by what kind of setting it touches, without the agent's
reason. A notification can be read on a locked screen and stays in the
system's list, and a command's arguments and an address's query are where
a secret would be. One asked
while the window has focus is not told of later, and one answered without
the user, by a standing answer or the agent's own rules, never waits. The
window counts as in front while its page or one of its browser tabs has the
keyboard. A
click on a notification brings the window forward at what it was about:
the session, or the dock where a question is answered, which for a session
another started is its starter's. A session's notification is taken away
once the session is looked at, and a question's once it is answered or
gone. Where the system does not tell the app of a click or let it take a
notification away, the notification is left as the system leaves it; see
[platforms](platforms.md). Both are switched
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

The user can mark a session unread from its row's menu, to come back to
it. The row is then drawn as one that went unread by itself: the accent
dot, the stronger name, and under the name the line it last showed, the
agent's own line or the first line of what it last said, for as long as
no new turn has begun since. It counts wherever unread sessions count,
the status bar, the app's icon, the chord to the next session that needs
you and keeping its project active, and nothing is said through the
system, since the user did it.

A mark stays while the user stays in the session, whatever the window's
focus does, and while the user is in another session. It ends when the
user comes back to the session after another session, or a project with
none, has been on screen; when the user writes to the session, typing a
prompt into its terminal or sending a message in its conversation; and
with Mark as read in the same menu, which reads it without opening it. A
message a session sends to a session it started does not end the user's
mark, and nor does anything the agent does. The first news after a mark
is said as it would be without one, and with its own line: the line the
mark put back gives way to whatever line comes with the news, on the row
and in the notification.

Any row can be marked, a session another session started and a row left
from the last quit among them. A past session, listed under its project
or behind the fold, has no menu and cannot be marked: nothing of it is
open to wait for the user, and opening it starts it again. A mark comes
back after a restart, as [after a restart](#after-a-restart) describes.

With the project's hooks on (Live updates, in the settings) the transitions
are reported by the agent. Both agents' prompt, stop and permission hooks
append to a log the core tails, and from the first line a session's row follows the
hooks: working from the prompt, needs permission while the agent asks,
with a hollow ring on the dot, waiting for you from the stop. A stop that
leaves the agent's own subagents running in the background is not one: the
agent has ended its turn to wait for their report, which starts the next,
and the row stays working through it, with the agent's parting line under
the name. A stop that leaves other work of its own running in the
background, a command or a call of its tools, is one, and the row keeps
their descriptions: when one finishes, the agent takes it up in a turn of
its own, though a dev server may never finish. Claude Code reports a turn that an error
from the model's service ended, a usage limit or a connection lost
mid-response, with a hook of its own in place of the stop: the row is
waiting from it, keeps the error's first line as its line where the agent
left none, and knows when a usage limit lifts where the line says. The pty
heuristic stands down for that session, except for two things the hooks
cannot say: output after a permission prompt means it was granted and the
agent went on, and, for Claude Code, after Escape or Ctrl+C at the keyboard
while the hooks say working, a screen that goes still, give or take a
redraw, for five seconds means the turn was stopped, which fires no hook,
and the row says it was cut short. Ctrl+C with words typed on the line only
empties the line, and stops nothing. At Claude Code's permission prompt,
Escape is its No, which stops the turn the same way; a digit or Enter may
be a yes or a no, and the turn is taken as stopped only when the screen,
once still, shows Claude Code's interrupted line under the turn's last
bullet. Without such a key a still screen ends
nothing: an agent running a long command, or thinking, draws only its
spinner's clock for minutes on end. An idle notice from the agent, which
it sends only once nothing of its own is running, ends the working either
way, and is news only when it does; it is what ends a turn that stopped
with no hook at all. A transition heard before the row knows its session's id waits
half a minute for it; one older than that is from a session run elsewhere,
which a resume of it here does not take for news. A turn Codex reports as
aborted, which is what an Escape does there, is a stop that says the user
cut it short. Neither turn cut short wakes a session that started others;
see [orchestrator](orchestrator.md#when-it-is-idle).

## Subagents on the rail

An integrated Claude Code session's subagents hang under its row while they
run, one line each and a little smaller than a session's, on a rail from
the session's dot: a dot for its state, the agent's glyph, what it was
asked to do, its kind while it runs (Explore, Plan, general) or else
`asking` in the accent, `done`, `stopped` or `failed`, and how long since
that last changed. A session that started others has its own subagents
right under its row and the sessions it started after them; the subagents
of a session it started hang one step further in, under that session's
row. With nothing else to say, the session's second line counts them, as in
`2 subagents running, 1 asking`.

What a subagent was asked and its kind are the agent's own words: each is
cut to what a row holds, and drawn with every character that would change
how it reads without being seen shown as a marker. A subagent is a run
inside its session, not a session of its own: its row has no × and cannot
be typed into, and the rows come in the order the subagents started.

The rows are worked out from the conversation alone. A subagent shows from
the call that starts it until it is done; one started in the background is
followed past the turn that started it until its own run ends. A window
that comes to the session late, after a reload, is told by the core which
subagents are still at work, which no transcript holds, and finds their
calls in what the conversation said before. Once done
it stays, greyed, while the session is still at work and no turn has ended
since, so the subagents of a piece of work go together once the turn that
waits on them is over, or the session stops working. A subagent that asks
for a permission, or whose start the agent asks for, says `asking`, and its
request docks in its session and in the dock of the session that started
that one, as described under the dock below.

A click on a row, or Enter on it from the keyboard, opens the session at
the call that started the subagent: the folds around it and the call itself
open, the call comes into the middle of the view and is ringed in the
accent for a moment, and the keyboard goes to the composer. The thread
stops following its foot there, so what the run goes on to do leaves the
call in view. The call's step says `asking` while its subagent asks. The rows are on the pane's cursor
walk, and Left on one climbs to its session. They are no stops for Tab of
their own, as no row in the pane is.

Rows coming and going never move what is under the pointer or where the
keyboard is walking: while either is in the pane, the subagent rows of the
sessions above it keep what they show, a row that has gone standing as
done and one that has come waiting, until both have moved off or away;
the rows below come and go as they will, and the session's line counts the
rows it shows. A screen reader is told politely as subagents start: a
session's starts within a moment and a half are said in one line, with
what it was asked for one alone and a count for several, each subagent
once. One whose call was made before the window came, such as one read
from what the conversation said before, is not news and is not said.

Folded to the narrow column, the subagent rows keep their height so nothing
moves when the pane opens, and show only a small dot for each, packed
beside the session's rail, which runs straight past them to the sessions it
started. With no words beside them the dots differ in shape: running is
filled, asking a ring with a halo, done a plain hollow ring, failed a
cross.

A session in a terminal shows no subagent rows. Its hooks could say when a
subagent starts and stops, but not what it was asked or which call started
it without hooks on the agent's own tool besides, so the window does not
guess. Codex runs its sub-agents as conversations of their own, which the
window does not follow, so a Codex session shows none either.

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
project's account again. A session another session starts runs under
the account the start names, else under the starter's when that was
chosen for the starter, else under its project's, as the
[orchestrator](orchestrator.md#the-tools) describes; its row under the
starter names the account when it is not its project's. A session resumed
runs under the account it ran under. The status bar names the account the
active session runs under, Default included, as long as there are
accounts to tell apart, and beside it the account's allowance, as the
[status bar](layout.md#the-status-bar) describes. An account of the same
name on another machine is another login, with figures of its own.

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

A name the user gives a session through the agent's own rename command is
the row's name at once and from then on. An integrated session hears it
from the agent; for a Claude Code terminal session the transcript records
it, and the end of the transcript is read as the session's working folder
is, every couple of seconds while it is on screen. A title the agent sets
later does not replace it, and a later rename does.

A slash command is never a name. A row named from its first message passes
over a message that is a command, a slash and a word with nothing or a
space after it, and takes the first message that is not one; until then
it keeps its plain name. A past session's title passes over commands and
what they printed the same way.

## Following the session

The changes pane follows the session, not just the project. Every couple of
seconds the core is asked where the active session's process is working, and
a directory it has not seen before is resolved to its repository root. When
that is not the project's own worktree, the pane watches it instead and says
so in its header: the agent has moved into a worktree, and the changes there
are the ones to review. Switching to another session switches back. This
relies on the agent changing its process directory when it enters a
worktree.

## Integrated sessions

How an agent's sessions run is a setting per agent, a terminal to begin
with; see [settings](settings.md#sessions). Switching it moves the
sessions already open, as [when the setting is
switched](#when-the-setting-is-switched) describes. An agent runs
integrated only where the core says it can drive it in messages, and the
rest run in a terminal. A session under a
[workflow](orchestrator.md#following-a-workflow) runs the way the setting
of its orchestrator's agent says, as any session does, and is told the
workflow either way; so does a resumed one. A single new
session can be started the other way from New session's, for the agent the
project used last: from the project's ⋯ menu, under its New session; from
the palette, beside New session in the project on screen; and, with no
session on screen, from the agent pane beside its New session button.
Started the other way, a session is a pick, as an agent picked is, and
runs alone whatever the project follows. The + and
New session start the agent's own way, or the project's workflow, so
nothing is asked of someone who never changes it. An integrated session is
driven through the core in messages, as [integrated](integrated.md)
describes, and is a row like any other: it is listed, stopped with its ×,
brought back after a restart and resumed the same way.

A session's row has a menu, opened with a right click on the row, or with
the menu key or Shift+F10 on the row under the pane's cursor. Its arrows
walk it, Enter picks and Escape puts it away. It holds Mark as unread, or
Mark as read on a row that is unread, as described under
[what a row says](#what-a-row-says); Stop, or Close for a
row with nothing running; and for a session whose agent runs both ways and
whose conversation's id is known, Reopen as a conversation for a terminal
session and Reopen in a terminal for an integrated one. Reopening stops the
session and, once its process has ended, resumes the same conversation the
other way in the same row, with its name, its token, its place, its shells
and the sessions it started, so the tools of the session and those of a
session that started it go on naming it. The prompt a started session
began with is not given again. A conversation nothing was said in has
nothing for its agent to resume, and starts afresh the other way, in the
mode kept for it. The row stays live throughout: nothing
watching it, a wait of the session that started it among them, hears that
it ended, and such a wait counts it as at work until its next run is up.
A line another session sends it meanwhile goes to the next run. While a
terminal session's agent is quit, the pane shows `Reopening as a
conversation…` where its terminal was. In the middle of a turn, where
the run would end a command it left running in the background or what was
allowed for its session alone, or where a conversation went back to a point
a terminal does not take, the pane asks first, saying what reopening ends
or brings back, at the top of the pane above the field that opens go to, where it
asks before closing busy shells. For a conversation that went back, it
also offers Write a message first, which puts the question away and the
keyboard in the composer: a message sent from there lets the point go,
leaving what was gone back on behind, and a terminal then has nothing of
it to bring back. Any other
start in a terminal of a conversation held where it went back, such as a
past session resumed that way, does not start: the pane says why and
offers Open as a conversation, which goes on from the point. A row left
from the last quit only changes the way it will start.

A terminal Claude Code session is quit as the user would quit it, with
Ctrl+C a press at a time. Claude Code writes down the mode it resumed a
conversation in as it starts, and the mode it ran in only as it shuts
down, on a quit or a hang-up, and a kill on Windows would leave it no time
to. One the presses do not end is hung up on, and any other agent's
terminal session is hung up on at once. A run that has not ended within
twenty seconds is left as it was, and the pane says the session was not
reopened. A mode chosen on the chip while the session is being reopened
is the one it goes on in.

The session starts in the mode the agent resumes it in that way, as for
any resume, except that a conversation whose last run was integrated goes
on in a terminal in the mode it ran in there, which the agent's own record
does not hold, so a terminal never starts looser than the mode last chosen
on the chip. Bypassing permissions, or a mode a session cannot switch to,
is never passed on; the agent's settings decide then.

The agent pane's header names the session. The status bar names its
folder, the branch the folder has checked out, and what the session is
doing: working, idle, asking the user or waiting for a permission, as
[the status bar](layout.md#the-status-bar) describes. The bar, the row's
dot and the row's words decide it the same way, from the session's own events: a
turn that only waits on the sessions it started is working, and a session
at rest while sessions it started work reads `a session working` or `2
sessions working`, with its dot breathing. At rest, a session reads `idle`
where the app knows its turn ended, an integrated one or a terminal one
whose hooks report its turns, and `running` where its activity is
guessed. A session another session
started is named by the name its start gave, cut to 60 characters, or by
the first line of its prompt; a name that reads as You or Workbench, in any
case or with anything unseen around it, is never taken, since the thread
says You for the user alone and Workbench for the workbench's own
messages, and nor is an agent's own name, Claude, Claude Code or Codex,
whatever marks stand between its words, since the dock names an agent's
own requests by it, nor a name another live session has, ignoring case,
spaces, accents, anything unseen and letters of other scripts that look
like Latin ones, or a name whose letters mix scripts, so no message, row
or request can pass for another session's, the workbench's or an agent's; the start
tool says which it was to its caller, and the session is named by its
prompt instead. A name the start gave is kept by the session's id, so the
session is called so after a restart too. Under it is the thread. The
thread and the composer span the pane, as the terminal they replace does,
with a margin that grows a little with the pane and narrows in a narrow
one. Code, diffs, what a command printed and tables use the whole width;
words wrap at about 140 characters, so a line still reads in a wide pane.
The user's words sit to the right in a
tinted bubble under You, and nothing else does. What another session sent,
the prompt it started the session with or a message it sent later, stands
on the left with everything not the user's, as a notice rather than a
message: no bubble, lined up with the agent's text, in the quieter ink of
the thread's own notes, under From and that session's name, its time and a
way to go to it. What the workbench sends of its own, to wake a session
that started others, stands the same way under Workbench, with nothing to
go to and nothing to put back in the composer; see
[orchestrator](orchestrator.md#when-it-is-idle). Each session in it is
named as the user knows it: by its row's name, and once its row has gone,
as it does when the starter stops it, by the name it was started with or
known by, and as a session where none is kept. Its id is for the agent
alone. A message is known as
another session's by the id it was sent under, never by its words, so the
user's own message reads as theirs whatever another session sent; the sentence the
workbench adds to a started session's prompt, asking it to call notify and end with a report, is
never shown as part of it, only behind a fold of its own. The agent's run
on the left under the model it ran on, or the agent's own name where that is
not known, with the time, down a quiet line at the side. Codex's app-server
names no model for a turn, so every run of a Codex session, live or read
back, goes under the agent's name and keeps it over a reload; the model it
runs on is on the composer's model chip. What the session
shows is chosen by the kind of each call and the shape of what it carries,
the same for every agent. What the agent wrote is drawn as
Markdown, its code and tables included, and grows in place while it streams,
with a caret where the next words come. An image the agent names by an
address is shown as a link to it rather than fetched. The thread stays at
its foot while new content comes, and where the user scrolled to otherwise,
with a button back down; only the user's own scrolling stops it following,
and sending a message takes it to its foot.

A conversation of any length opens and scrolls as a short one does. The
thread draws only the messages and runs in and near the view, a screen's
worth either side, and keeps the space of the rest at the height each was
last drawn at, or at what the first ones drawn averaged, so the scrollbar
spans the whole conversation. What the reader looks at stays where it is
when what is drawn above it turns out taller or shorter than reckoned, or
when earlier messages come above it; while the user scrolls, the space
above takes up the difference rather than the view being moved. A fold
stays open while it is out of view. A selection keeps what it lies in
drawn while the view is no more than a long stretch away. While a reply
streams, the blocks before its last are drawn once and kept, and only the
last is drawn again as words come, so a long reply streams as a short one
does and a selection in what it has already said holds.

What the agent did between two things it said folds into one line, such as
Worked for 3m, changed 3 files, ran 1 command, which opens into the steps:
each tool call with what it did to what, its input, a command's output as it
came, the files it changed as diffs, and a subagent's own run under the call
that started it. The changes pane stays the place to review changes. While a
turn runs, a line at its foot says what the agent is doing now: running a
command, reading a file, thinking, waiting for an answer. The workbench's own
tools are worded for a person, by the session's name in the sessions list
where a call names one, between quotes: starting a session, writing to it,
reading what it did, and the same in the past tense once the call is done,
a start then with the mode the session begins in, as its answer says.
A session whose row has gone keeps the name its caller gave it. An agent's
request to use one of them reads the same way in the dock, as what it would
do: asks to start a session, to write to one. Another server's tool reads as
using that server's tool, by the server's own name. Two of the workbench's tools are not
drawn at all: wait, which an agent calls to hear from the sessions it
started, and notify, which leaves a line on its row. Neither has a step, a
count in the line work folds into, or a line at the foot of its own, and
neither folds anything: what the agent wrote before them stays the last
thing in its run, in full, and a wait that follows a wake leaves it so as
well. In the run that follows a message the agent took while its turn went
on, the last thinking that is all it said before one of the workbench's
own calls, with no words of its own after it, is not folded into work: it is drawn in sight under a label that
calls it a summary of the agent's thinking, as an answer the agent left
there would be read nowhere else. While a turn is only waiting, its foot says on what, in the
wait's own words: waiting on a session by its name, or on the sessions it
started. A plan is drawn
where it came and changed in place, a question the user answered with the
answer, a secret one without it, and a compaction, a notice or an error
where it happened. The sessions an agent started with the workbench's start
tool show under its run as rows, each with its state, name and model and a
way to open it.

Five things in the thread can be copied whole, each with a quiet Copy that
shows while the pointer is over it or the keyboard is on the Copy: the
user's message, a reply as Markdown, a code block, a command and a
command's output. A message is copied as its words, without what the
workbench added to it. A reply is everything the agent said in that run,
its text joined, without its work or the sessions it started. A code block,
at the top or in a list or a quote, is its code without the fences, and a
command is the command alone, from a Copy drawn over the end of its step's
row, before its status, so at rest the row is the command's. A click, Enter
or Space copies what is there at that moment, so a reply still coming is
copied as far as it has come, and the word turns to Copied for a moment,
which a screen reader is told once. Copying leaves the scroll and the
keyboard where they were, and nothing moves when a Copy appears. The text reaches the system clipboard through the app rather than
the page, the same on macOS, Linux and Windows. Selecting text and the Edit
menu's Copy work as they do anywhere else.

A fenced block that holds words, one with no language or marked text,
Markdown, message, email or comment, wraps at the block's width, at word
boundaries, and a line that starts with spaces or a list marker keeps its
continuation lines under its words. Copy still gives the lines as written.
A block with no language that is laid out in columns, such as a table or a
tree drawn in text, aligned output or a diff, keeps its lines, as does a
block in any other language, and scrolls sideways, since wrapped code
misleads.

The conversation can be searched with find, which looks in all of it
whether the thread draws it yet or not: the messages, what the agent wrote
as it reads rendered rather than as its Markdown, plans, questions and
notes, earlier messages read from the transcript, and inside folded work
each step's command, input, changed lines and output, a subagent's run,
and what the user told the agent when refusing a call. The labels around
them, who spoke, when, the line a stretch of work folds into and a step's
verb, are not looked in. Case is ignored unless the words looked for hold
a capital.

The bar opens over the top of the thread with the count, such as 2 of 7,
or No matches in the warning colour, which it does not say while earlier
messages are still being read, and buttons for the match before, the
next one and closing. The thread keeps room at its top for it, so its
first message is never under it. Every match drawn is tinted and the
current one filled; the marks are painted over the text without changing
it, so selecting, copying and links work as ever. A new search starts
from the top of the view, or from the match the words were on before
they changed. Stepping brings the current match into the middle of the
view and stops the thread following its foot, drawing its turn if it is
not drawn and opening the fold and the step that hold it; they close
again when find moves on or the bar closes, unless the user opened or
closed them meanwhile. It glides from near and is there at once from
further than a screen away, or always where the system asks for less
motion. Closing the bar leaves the thread where it is and lets go of
what find read.

While the conversation changes, a reply streaming among it, the count
stays right and the current match stays on what holds it; words that had
no match go to the first one that comes. A long conversation is counted
a slice at a time, and typing never waits on it. The keys are in
[focus](focus-model.md#an-integrated-session).

A permission the agent asks for docks over the composer rather than in the
thread: who asks, the agent or one of its subagents, and what for, with the
choices the core offers. It says the agent asks to run a command only for a
call known to be one; otherwise it names the tool. A command of several
lines is shown whole from the start. A path is read against the folder the
request runs in, and is taken as inside the project only when it plainly
resolves into it: one that climbs out, or a folder the request runs in that
is elsewhere, is marked outside, and one that starts at a home folder,
names a variable or a glob is marked as not plainly in the project. The
mark comes before the path, as in "asks to write a path outside the
project: ~/.ssh/authorized_keys", so no path can push it out of sight.
Whenever any path of a request lies outside the project or not plainly in
it, the line itself says so and how many, and those paths are listed before
the description the agent wrote, which is cut like other long text. A link
inside the project that leads out of it cannot be seen from the window. A command, path or address
longer than the line holds is cut, with its whole a fold away that opens
in place, and the line says in the warning colour how many characters the
cut leaves out, a subagent's description included. A request the core cut
before it reached the window, as it does past what a connection should
carry, says so on its line in the warning colour, that it is longer than
the workbench can show and its end is hidden; its folds say they show it as
far as it came, never whole, and a step whose input was cut says so on its
row. An address is read
after trimming, whatever its slashes, and the line names the host it really
goes to, since its start can look like another; where a client such as curl
would read another host from it, as with a backslash before an `@`, it
names that one too, and it says in the warning colour when the address
names a user before its host, holds a backslash, or has a host that mixes
scripts. The whole request, with the tool it names, is a fold away
wherever the line does not say all of it. What the request holds scrolls
between its line and its choices, which stay in sight whatever it holds.
The first allows the call once and remembers
nothing; the others allow it for the session or always, saying what each
keeps, deny it, with words for the agent if the user wants, or deny it and
stop the turn. A line under the choices says what the one in focus or under
the pointer does. A question docks the same way with its options, answered by
picking one where one is all it takes, with room for the user's own words
where it takes them; a secret answer is typed hidden. A
permission the agent withdraws before it is answered says so on the step
that asked for it, or where no step is known in a note that says what it
was for, as a question that settles itself does. When the dock goes by
itself while it has the keyboard, the keyboard goes back to the composer.

The dock also holds the requests of the sessions this one started. One of
them names the session that asks, after the step it was started for when
it has one, as in "Work: Fix the cache asks to run cargo test", and a
subagent inside it by both, as in "The subagent for Check every link in Fix
the broken links"; Open beside it goes to that session, whose own dock
holds the same request, and for a subagent's request opens it at the call
that started the subagent, as its row on the rail does. A name longer
than the line holds is cut wherever the dock says it, and the line says
in the warning colour how many characters are cut. It is answered exactly as it is there, and every
choice acts on that session: the line under the choices names it, what a
choice keeps is that session's, and Deny and stop stops that session's
turn. A rule kept for good goes in the local settings of the folder that
session works in, which every session there reads, so the line names the
folder and says so, as in "in demo's uncommitted local settings, for every
session in demo". The answer goes to that session's own request and to no other, it is
the user's alone, and the agent of the session on screen is neither told
of it nor given any way to answer. A request answered in one place goes
from the other at once. A started session that runs in a terminal can be
answered only in its terminal, so its ask shows with one choice, Open,
which goes to it with its terminal focused, and leaves the dock once the
session stops asking; its hooks say only that it asks, not what for.

Requests are answered one at a time: the session's own first, in the order
its agent asked, then those of the sessions it started, in the order they
asked. The dock says how many more wait, and from which session when they
are all one session's. While the pointer is over the dock or the keyboard
is in it, the request shown stays until it is answered or goes, and what
arrives meanwhile waits behind it; the dock tells again whether the
pointer is over it whenever what it shows changes, since a smaller request
can leave the pointer outside without a move. A request that takes the
place of another, because the one before was answered, withdrawn or put
behind the session's own, or that comes within half a second of the dock
emptying, takes no answer for half a second, its choices faded meanwhile
and whole again the moment they answer, so a click or a key meant for the
one before never answers it. While an
answer is on its way to the agent, the request stays with its choices
faded, and they keep the keyboard until the request goes.

Every text that comes from an agent, a tool or a server is drawn by one
rule, in the conversation and outside it: a command, a path, a URL, a
tool's or a server's name, a subagent's description, a task, a question and
its options, a note, an error, a field's name, a line of a change, and a
session's or a model's name in the sessions pane, the palette, the header,
a notification and an orchestrator's question. It is set apart left to
right, so it cannot turn the words around it, and any character that
changes how it reads without being seen shows as a marker such as
⟨U+202E⟩. Those characters are taken from Unicode's own categories:
controls, format characters and every character Unicode says is drawn as
nothing, line breaks and tabs aside.

The composer under the dock takes several lines and files: an image
dropped, pasted or picked with the paper clip goes with the message as a
picture, and any other file dropped or picked goes as a mention of it (see
below), shown as a card with its name and size until the message is sent.
A file from outside the project goes by its full path, and its card says
which folder it is from; the agent's own rules on reading outside its
folder then apply, as Claude Code's do by asking. A session on another
machine is given pictures only, since the files are on this one, and the
composer says which were left out until the message is sent. A message sent while an image is still
being read waits for it. The empty composer names the keys that open its
menus, `/` for commands where the agent lists them and `@` for files where
the project has a git repository. It shows the model the
session runs on, which a click changes, and a new session the user starts
shows from its first frame the model, the mode and the effort last chosen
for its agent, which it starts on, as
[integrated](integrated.md#what-a-new-session-starts-on) describes: the agent's default is named once
the agent has said which model that is, and a model chosen during a turn is
said to be used from the next. A session that follows a workflow shows its
orchestrator's model and holds it, saying the workflow sets it, and so does
the status bar. Both name the model the run says it is on, and the
workflow's own name for it until the run has said. It shows the mode the
session runs in, as the agent says it does, which a click changes at once
among the modes the agent offers. A session starts in the mode a terminal
session would, as [integrated](integrated.md#the-mode-a-session-starts-in)
describes: for a new session the one last chosen for its agent, else the
one the user's own agent settings name, and for a session that starts again
or is resumed, the one it last ran in. A mode from those
settings that the agent offers no switch to, such as bypassing permissions,
is shown in plain words and comes back only in a new session once another
is chosen. It shows how much of the context window the conversation takes. While
the agent works its Send button is a Stop button, and a message sent
meanwhile stands under the thread, marked as waiting, until the turn that
takes it. The line under the last of them offers Send now, which sends
every waiting message at once, in the order sent: Claude Code takes them
into its running turn, or stops the turn for them, which is then drawn as
interrupted, and they start the next turn straight away; Codex is given
them in the turn it runs, which goes on. Its tooltip says which. The line
says Sending now until the agent has taken them. Each of the user's own
waiting messages offers Take back, which takes it from the agent and puts
its words and images back in the composer as soon as the agent lets go of
it, unless the agent has taken it first, which the composer then says
until the waiting messages or the turn move on. While a request waits for
an answer the line says the message waits for the turn and that
answering the request lets it be sent now, and while the conversation is
being compacted it says it waits for that; Send now is not offered then.
A message another session sent can be sent now but not taken back. From
the composer, Cmd+Enter sends them now, with what is written when the
agent is at work, and Cmd+Shift+Enter takes the newest of the user's own
back (Ctrl off macOS), as its hint says; a chord the user has given to an
action of the keymap is not named. Both are on the thread's arrow walk
too. Up in the empty composer takes the newest back as well, where nothing
is docked, with the caret at the start of its words, and Up again, while
the composer holds only what Up took back, unchanged, takes the one before
and puts it ahead, each in the order sent, so Enter sends them as one
message; the hint under the composer says while there is one before. The thread at its foot keeps the waiting messages and their line in
view above the composer and the dock as they come and change. While the
dock holds a request the user answers there, the composer says Up
reaches it, and a lone digit
sent then goes only on a second Enter, so it is not sent as a message by surprise. A message that was not delivered, refused
by the agent or never sent, can be put back in the composer. What is being
written stays with its session while another is on screen. The keys are in
[focus](focus-model.md#an-integrated-session).

A new session, until its first message, also shows the
[workflow](orchestrator.md#following-a-workflow) it follows in a chip
after the mode: the project's workflow to begin with, or none. The chip
opens a menu of no workflow, the agent working alone on the model the user
picks, then each workflow with a line saying which model directs, works and
reviews. A workflow directed by an agent that is not installed, or that
runs only in a terminal, is listed with why and cannot be picked. Picking a
workflow makes the session its orchestrator, as starting a session under it
does: the session starts again on the orchestrator's agent and model, told
the workflow's instructions and with the agent's own subagent tools taken
away where the workflow says so, and the thread's first line says what it
follows. A workflow directed by another agent puts the session on that
agent, still as a conversation, whatever that agent's own setting is.
Picking none starts it again alone, on the agent it was started on and the
model last chosen for that agent, else its own default. Either way it keeps its row and its token, the
words being written, the keyboard, and, while the agent stays the same, the
user's last choice of mode, one still on its way included. The run it
leaves is stopped before anything can reach it, and what that run answers
later is let go. A start already on its way is waited for, and a message
sent while the new run comes up waits for it, as does a change of the
settings, which is made on the new run before the message goes.
Once the first message is sent the choice is kept: the chip goes, and the
header's chip names the workflow. Working another way takes a new session.
A resumed session, one another session started and a session in a terminal
have no chip, and neither does any session while the settings have no
workflow.

A slash typed as the first thing in the composer opens a menu over the
thread of the agent's slash commands, then its skills, for an agent that
lists them, as Claude Code does; Codex lists none, so there a slash is
text. Each shows its argument hint, what it does, and where it comes from:
built in, a project, the user, a plugin or an MCP server. Typing narrows
the list to names that begin with what was typed, then names with a later
word that does, and marks the letters that match; the first is marked.
Taking one puts it in the composer with a space after it, and its argument
hint waits in grey after the caret until something is typed; a second
Enter sends it. Before the agent has listed its commands the menu says so
and fills in place once it has, and until then a message that begins with
a slash is not sent. A word nothing matches is said to go as a message,
and the menu closes at the first space. Which entries are skills the agent
says when its first turn starts, so until then those that are not its own
are listed as skills. An MCP server's prompt is offered by the name a
message gives it, which starts with `mcp__`. The compact command does not
go as a message: the conversation is compacted through the agent's own
compaction, with any words after the command for the summary to keep, and
while a turn runs the composer says it waits for the turn to end. A
compaction that fails says so in the thread, with the agent's reason, and
words that could not be sent to compact go back in the composer.

An `@` typed at the start of the composer or after a space opens the
project's files in the same kind of menu: the changed files first, with
their counts, then the files and folders at the project's top. The files
are the ones the changes pane lists, from git, so ignored files are left
out, a file deleted from the tree is not offered, a session in a worktree
lists its own tree, and a project on another machine lists that machine's;
they are read each time the menu opens, and what was read before answers
until they are in.
Typing narrows the list by the file's name first, the whole name before
one that begins with what was typed, then by its path, and a `/` in what
was typed matches folders; a changed file comes first among equals, then
the one fewer folders down. The matched letters are marked. A few thousand
files are filtered as the keys come; more are filtered away from the
window's thread, and Tab or Enter pressed before the answer picks its best
once it comes; with nothing to pick, Enter then sends as it would have. An `@` inside a word, as in an email address, or inside code
between backticks, is text. Taking a file puts its path from the project in
the composer, drawn in the accent, with a space after it, and Backspace
right after it takes the whole mention out; undo takes either back. A path
typed whole after an `@` that is a file in the list is a mention too, once
the word is done.

A mention is the path, for the agent to read itself, so the read shows in
its work and it reads the file as it is then. It goes to the agent as the
path between backticks with its `@`, as in `` `@src/lib/a.ts` ``, one more
backtick on each side than the longest run in the path, and nothing before
the `@`: Claude Code takes any word of a message that begins with `@` as a
file whose content it sends along, and leaves a word that begins with a
backtick as written; Codex takes a path in the text as it is. A path with
a line break or another control character in it, or a space before an
`@`, would break out of that form, so it is not mentioned or attached, and
a line under the composer says why. Where each mention stands is kept with
the message, never read back from its words, since the same form is how
code is written: the user's message in the thread shows each mention as
`@path` in the accent, and one in the project opens the file in the
viewer, its changes when it has some, while code the user wrote between
backticks stays as written. Copy and putting a message back in the
composer give the mentions as they were typed. A message whose mentions
were not kept, from another session or another window's store, shows its
words as they are.

A session at rest goes back to before one of the user's own messages, as
[integrated](integrated.md#going-back) describes. Esc twice within a
moment in its empty composer, or Go back to an earlier message in the
palette, opens a list over the composer of the user's own messages the
agent keeps, oldest first, with the newest marked; a first Esc says what a
second does, and an Esc that stopped a turn or put something away opens
nothing. Go back to here, shown on each of the user's messages as Copy is,
opens the same list at the choices for that message. As the mark moves,
the thread brings the message into view under a line and fades what would
leave with it, and the list says what leaves, or why the conversation
cannot go back there. Enter turns the list into the choices for the marked
message: the conversation alone, and, where the agent puts files back and
a dry run named some, the conversation and the files, and only the files,
naming the files and counting what changes. Past three files a choice
names two and counts the rest, and names them all once marked by a key or
clicked, so none goes back unnamed. Enter takes the marked choice. A digit
takes one that can be undone, and only marks one that cannot, which says
so, for Enter to take. Esc goes back to the list and closes it from
there, and typing closes it and types. A turn the agent begins by itself closes it, and the composer
says why.

Going back with the conversation cuts the thread at the message at once,
marks the place with `Rewound here` and the time, and puts the message's
words in the composer, a blank line above anything written there, to be
edited and sent again. Claude Code starts again for it, which the choices say, with
the commands it left running that stop with it, and while it starts the
composer says what is sent waits for it. Gone back with the conversation
alone, it can be undone from the mark until a message is sent or a turn
runs. Files put back are named under the composer, with when they are
from and a reminder that what commands changed stays. Where they went back
and the conversation did not, as with only the files, or where Claude Code
went on with the whole conversation or did not start again, the composer
says so too, and the agent is told ahead of the user's next message, which
the thread shows folded under it as `Files put back, from the workbench`;
a message that never reaches the agent, or that the conversation goes back
on, has it told again with the next. Codex goes back in place, puts no files back
and cannot undo it, which the choices say. A report of a session it
started that reached it in a message gone back on counts as not told, so
it comes again. Where going back fails, the composer says why, the thread
is whole again, the words leave the composer where they stand unchanged,
and a message sent meanwhile is not sent.

The row's id is the conversation's id as the agent says it once ready, so
the agent's own tools find the row. Its state, working, asking or idle,
comes from the session's events, never from the hooks or from output; the
hooks still fire for it and are left alone. When it stops working or asking
while nobody looks, the line under its name is the first line of what the
agent last said, unless the agent left a line of its own. A spell of work
that was only a compaction the agent did by itself, with nothing said,
marks nothing. A turn already running when the window takes the session
up again after a reload marks when it ends, since what it did before is
not heard again. A row with no name yet takes the first line of its first
message that is not a slash command, as [names](#names) describes.

Before a session can run it may need the user. In a folder the agent has
not been told to trust, the pane asks whether to trust it, and on a yes the
trust is recorded where the agent's own question records it and the session
starts. Under an account that is not signed in, the pane says so and gives
the command to sign in with in a terminal; the workbench never signs in. A
session that ended or could not start says why, and Resume starts it again
on the same conversation, the thread drawn so far staying above what comes,
with a quiet line saying when it resumed.

An integrated session opened from the past sessions, brought back after
a restart, or moved from a terminal by the setting or by Reopen, draws its
earlier messages above what this run says, in the same look: Claude
Code's read from its transcript, and Codex's from its thread, through
Codex itself. The line where this run began is there at
once, with a breathing line above it while the earlier messages are read;
the session can be written to meanwhile, and what it says goes under the
line. The earlier messages fill in above it, and a thread with earlier
messages sits at the foot of the pane while it is shorter than the pane,
so nothing under them moves. A turn the agent's record gives no end, as
when the app quit during it, is over, and its unfinished steps failed.
A conversation too long to hold whole leaves out its start and says so.
Earlier messages that cannot be read leave the session able to be written
to, with a line at the top of the thread saying they could not be read
and why, such as that Codex does not have the conversation, or that
Claude Code has no transcript of it in the account's directory. A record
that holds no message of a session that was spoken to is said to be so in
the same way. The line stays above whatever the session says after it.
A session nothing was said in, resumed after it ended, has nothing to
read, and says nothing of earlier messages.
[Integrated sessions](integrated.md#history) has what is read and how.

The line reads `Resumed here, today 09:40`, naming the day when it is
another. The first time shown on each day names its day too, as `Thu 18:02`,
unless every time shown is today's.

A window reloaded while the core still runs a session takes it up where it
is: its earlier messages read again, its open requests and waiting messages,
its own name, who sent each message and when, and the line where a resumed
run began. That holds for an orchestrator's sessions and for an integrated
session another session started, which comes back under its starter, as
after a restart, when it waits to be resumed like any other.

### When the setting is switched

The sessions already open follow a switch of the setting: each that runs
the other way moves, as a reopen from its menu does, with its
conversation, its name, its token, its account, its mode, its worktree,
the session that started it and those it started, whether it was read,
and its place and its time in the list. A row left from the last quit has
nothing running, and only changes the way it will start. A running session
moves once it has been at rest for a moment, wherever it rested, so a rest
that the next turn follows at once is not taken for one, and once it is on
screen with nothing over it: the moment it is opened, or for the one on
screen, as the settings close. A session out of sight waits until it is
shown, as a row left from the last quit waits to start, since starting
every agent at once is a burst of work for sessions nobody is looking at.

The switch never cuts a session short. One at work, asking for a
permission or a question, with messages waiting for its turn, with
subagents at work, watched by a wait of the session that started it,
about to be woken by the workbench, or with words in its composer or on
its terminal's line goes on as it is, its row and its pane showing it as
they always do, and moves once all of that is over. Nor is a session moved
under its reader: one that comes to rest, or is let go of by what held it,
while it is on screen stays as it is until it is next shown, and its
second line says so, as in `Moves to a terminal next time`.

What a run ends with it is never ended unasked. A session with a command
it left running in the background moves once the command ends, and its
second line says when, as in `Moves to a terminal when npm run dev ends`,
while its tooltip says that moving it now ends the command. One that holds
what never ends by itself stays as it is, and its second line says why:

- something allowed, in a conversation, for the rest of that session
  alone, as in `Stays a conversation: moving ends Bash(npm test)`. A
  permission mode allowed for the session is not among these, since the
  mode goes on with the conversation, and what a terminal allowed for its
  session alone is not seen by the window, so it is not counted;
- a Claude Code session in a terminal, in a project whose hooks are off,
  says live updates are off: its output cannot tell a long quiet command
  from rest;
- a Claude Code conversation that went back to an earlier message, which
  is held at that point until a message is sent from there, says `Stays a
  conversation: it went back, and a terminal would bring back what was
  gone back on`, since Claude Code's terminal does not take the point.
  Whether a conversation is held is the core's to say.

Where the second line holds what the agent left, a word of it takes the
place of the model, and a session another started says it where its model
stands; either way the tooltip has the whole. Reopen from the row's menu
moves any of them now, and asks first, saying what it ends or, for a held
conversation, that the terminal brings back what was gone back on, which
on a yes it does.

A session the user started the other way, or reopened the other way from
its menu, runs its own way, and a later switch leaves it as it is, since
the user chose that for the session. Reopened back to the setting's way, it
follows the setting again. Which sessions run their own way is kept with
the record of those open, so it holds after a restart; a record from a
version before says nothing, and its sessions follow the setting. So is a
move not yet made when the app quits: the row comes back as it was and
starts the new way when it is woken, so it never starts one way and moves
a moment later, even before the window has the setting again. A
session that has ended stays as it ended, and an agent that runs only in a
terminal has nothing to move. A session on another machine moves as one
here does.

## Dropping files

A file dropped on a terminal is its path, typed there with spaces and shell
characters escaped the way a terminal app does it. Dropped anywhere else on
the window, it goes to the terminal the keyboard is in. Claude Code reads a
pasted path and shows an image file as an attachment, so a screenshot
dragged in arrives the way it would in a plain terminal. The webview never
sees the drag: the window takes it and reports paths with a position, and
the terminal under a drag shows an accent inset while it lasts. Dropped on
an integrated session, an image goes with the next message and any other
file is its path in the text.

## Notes

Every session keeps notes of its own conversation, so that it can go on
later from them rather than from the whole conversation read again. A
session has one brief, what is being built, kept current, and notes, each
with a title, a one-line summary, a few lines of body and the day it was
kept. A later note can replace an earlier one, which then no longer
stands, so a changed decision does not stand beside the old one.

The agent keeps and reads them with the workbench's own tools, as
[hooks](hooks.md#the-agents-tools) describes. It is told as it connects to
keep a note whenever something settles: a decision and why, a finding,
what the user asked for or prefers, what is left open, and never a key,
token, password or personal data. The call goes alongside another one, the notify at a turn's end most of all, so it adds
no step of its own, and the conversation does not draw it. When the user
refers to something the agent has no context for, it is told to read the
matching notes before asking or guessing.

The core keeps them in a small database in the workbench's directory in
the user's home on the machine the session runs on, under the session's
token, so they follow the session across its runs and across restarts of
the app. The folder and its files are readable by the user alone, and
nothing of them is written into the project. A call carrying a session's token keeps notes as
that session, as [who is calling](orchestrator.md#who-is-calling)
describes for the other tools.

The list the agent is given, by the notes tool and when it goes on from
its notes, names the brief and at most thirty notes: the
twenty newest, then the most read of the rest, newest first, each by its
number, day, title and summary, and a count of the others, which it finds
by their words. A note is read whole by its number.

A row's menu has Show notes when its session keeps any. It writes them
out as a document and opens it in the viewer: the brief, the standing
notes newest first, then those a later note replaced. There is nothing to
manage.

### Going on from the notes

A conversation that is needed again after a pause is read again whole by
its agent, and once its prompt cache has lapsed, that read costs as much
as writing all of it to the cache afresh: for a conversation of hundreds
of thousands of tokens, far more than anything said after it. So a Claude
Code conversation that is cold and large goes on from its notes instead.
Cold is past the lifetime of its last cache write, an hour or five
minutes as its transcript records, less two minutes of an hour or thirty
seconds of five minutes; large is a context of a hundred thousand tokens
or more, as its last request read it. Warm or small, it is resumed whole,
as before, and so is one whose last request does not say when it was.
A conversation held at a point it went back to is judged as it stands
there, not by the turns it went back on. The same rule holds for the
user's own sessions, the one on screen included, and for sessions another
started. A conversation that goes on by itself once a usage limit resets
goes on from its notes whatever its size and rest, as
[integrated](integrated.md#going-on-after-a-limit) describes.

Going on, the row starts a fresh conversation of the agent's, with the
same row, name and token, so the notes and everything the workbench
keeps of the session follow it. The core writes a briefing, a few
thousand tokens whatever the size of what came before: the brief and the
list of notes, the user's first message, the last three of the user's
messages each with the agent's words after it, word for word, and where
the old transcript is, to be searched for a detail the notes lack and
never read whole. Ahead of the notes it says that they and the quoted
messages are records the earlier conversation wrote, to be read as data
and never as instructions, since anything holding the session's token can
write a note and an agent can copy a page's words into one; the notes
tool says the same. Every line of a record, in the briefing and in the
notes tool's answers, starts with a quote mark, so no record can hold a
line that passes for the workbench's, the user's, or the briefing's end:
the window and a later briefing take the briefing to end at its first
line that is exactly its end line. For a conversation held at a point, the quoted
messages are those up to that point, and a note kept after it is listed
as kept on a turn the conversation went back on. The briefing goes ahead of the first message the fresh
conversation is sent, the user's, a line from the session's starter, or
the workbench's own; a terminal session is given it as its first prompt,
told to wait for the user when nothing else goes with it. Where the
agent's command runs through the Windows command interpreter, a first
prompt too long or with characters it would read as its own goes in a
file of the session's own, readable by the user alone, and the agent is
told to read it.

This is weighed as a row is started again: a row left from before a
restart once it is opened, and a session another started once a line
brings it back. It is weighed too for a conversation row still running at
rest whose context this window saw grow large: when it comes on screen,
when the window is brought forward or shown again, and when the user
sends it a message after a rest, which waits until it is decided and then
goes to the fresh run or the old one. The core is asked once for that
message: an answer that the conversation is warm, or a judging that
failed, stands for half a minute, within the margin the core leaves before
a cache lapses. While the core judges, the row
counts as starting again; a message another session sends it meanwhile
goes to the run, which is then left as it is, so nothing lands in the
conversation being left. It is not weighed with anything running in the
run's background or with a wake-up the agent scheduled still pending,
since a stop would end them. A terminal row left running at rest is not
weighed at all: its next message reads the whole conversation. In the
conversation view the earlier messages are still drawn above, read
from each conversation the row went on through, the line where the run
began says it went on from its notes, and the briefing is folded under
the first message. The old conversation is no longer listed among the
earlier sessions from the moment the row goes on: the row goes on with
it.

What can be lost is what the old conversation held and the notes did
not: files read, results seen, reasoning not written down. The agent is
told to read the matching notes, then search the old transcript, before
asking the user. The way back to the old conversation is the row's
menu: Resume whole, in a terminal row as in a conversation row, says how
many tokens it reads where the transcript said, and starts the row again
on the whole old conversation, at once when the row is on screen. It is
offered only until anything is said to the fresh run: the old
conversation would not hold what was said after it, while the row still
drew it. A Codex conversation is always resumed whole.

The notes go once the session cannot come back. For a session another
session started, that is when its starter stops it, or when the starter
is itself gone from its project's history. For a session of the user's
own, it is when its conversation is gone from the project's history,
which happens when its transcript is deleted, by the user or by the
agent's own clean-up. Closing a row, or the workbench putting a finished
one away, keeps them.

## Usage log

The workbench keeps a log of what each session spends, for tuning the
points at which it saves tokens: when a conversation counts as cold and
large, how long a starter's wake is held, and where a started session's
context is capped. Nothing in the app shows it, and nothing in it is a
warning. It is kept where the session's project is, in the usage folder
of the workbench's directory in the user's home, one file per session
named by the session's token, readable by the user alone, with one JSON
object per line. A file that reaches two megabytes is moved aside to one
older file, which it replaces. A file not written for thirty days is
removed when the next session's log begins.

Each line has its time, the kind of event, the conversation's id, the
agent, whether the session runs in a terminal or as a conversation, its
model where known, and the account's five-hour figure as last reported,
with when it last moved, so the figure before and after any event can be
read off the lines around it. The events are:

- **turn**: a turn ended, by the agent or by an error. For a
  conversation, the tokens the agent reported for it, how it ended and the
  context's size. For Claude Code in a terminal, the core reads the turn
  from its transcript: the fresh input, the cache reads, the cache writes
  by their lifetime, the output, the number of requests, and the context
  the last one left. A compaction within the turn counts as part of it.
- **resume**: a conversation was taken up again, whole or from its notes,
  with its context and how long it had rested where its transcript says.
- **wake**: the workbench woke a starter, with how many reports went in
  the message and how many sessions were still at work.
- **start**: a session another session started came up, with its
  starter's token and whether it runs one model below its starter's.

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
