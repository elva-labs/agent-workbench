# Sessions

A session is one agent process in one project. In a terminal session it runs
in a pty of its own with its own terminal and scrollback; an integrated
session has no terminal, and the window draws its conversation instead, as
[integrated sessions](#integrated-sessions) describes. A project holds as
many as you start, several
projects can be open at once, and switching between any of them stops
nothing. The sessions you are not looking at are hidden rather than
unmounted, and hidden in a way that keeps their box in layout, so a
background session's pty is never resized and never reflows.

Nothing new starts by itself. Opening a project shows what the project has:
live sessions if any, past ones to resume, and a new-session row. Opening the
app brings back the sessions that were open when it quit, as described under
[after a restart](#after-a-restart).
The past ones of every open project are read again, in one request per
agent directory and per machine, each time the window comes back into view
and once a minute while it is looked at, so a session run in a terminal
outside the app is there to resume without a restart. A list that has not
changed is left as it is, and a machine that does not answer holds up only
its own projects. The menu beside Open project
holds Open remote project, for a folder on another machine, and New
orchestrator session; see [remote](remote.md) and
[orchestrator](orchestrator.md). With more than one agent installed the row
opens in place into a row per agent; see [agents](adapters.md).

A row's own button appears over its end on hover, so a name is never
squeezed to make room for it. On a live row it is ×, which stops the session
and leaves it under the project's own past; on a past row it is archive,
which files the session with the ones to resume, behind the fold. Two steps,
so nothing running is archived by accident. On the keyboard, Delete does
either for the row under the cursor.

Closing a session also closes the browser tabs it owns; see
[browser](browser.md#whose-tabs-they-are).

The kill lives in one place: closing a session stops its pty and clears the
id, and the terminal's own teardown does not, so a second signal never lands
on an id that may since have been reused. On shutdown the pty master closes
with the process and the agent sees SIGHUP. Picking a session that belongs
to another project brings that project forward.

## By status

The pane lists sessions one of two ways, chosen with the switch under the
Open project button and kept across restarts. By project is the tree
described above. By status is every session across the open projects in
one list, in three groups: **Needs you**, a session asking for a
permission or one that stopped, ended or rang while nobody was looking;
**Working**, a session whose dot breathes, which for an orchestrator
includes a session it started being at work; and **Active**, the rest,
which is a live session that is idle and read, with the dormant rows
last. A group with nothing in it is not drawn, and the first takes the
accent while it has rows.

Within a group the rows are in the order they last changed, the latest
first, and the time of that change stands at the row's end: a session
that asked a minute ago is above one that has waited an hour. A change is
the row starting work, going quiet, asking, being looked at, or ending; a
row already waiting that stops again has not changed.

No project stands over a row here, so each row says where it belongs on a
line under its name: the project as the tree labels it, the orchestrator
that started the session when one did, and the line the agent left, after
a middle dot. The account and host tags follow the name as they do on the
project's row. Picking a row brings its project forward, as it does in the
tree.

The projects themselves sit under the groups, each with its tags and its
close button, and under the one you are looking at the rows the tree shows
for it: its past sessions, the new-session row and the fold of sessions
to resume.

On the keyboard the switch sits on the cursor path after the menu button,
and Left and Right flip it. Up and Down walk the rows in the order drawn,
groups first and the projects after.

<kbd>Cmd</kbd><kbd>.</kbd> goes to the next session that needs you and
puts the keyboard in it. The sessions that need you are taken
in order: those asking for a permission first, and within each kind the one
that has waited longest first. The chord goes to the one after the session
on screen, or to the first when the session on screen is not among them,
and round to the first again after the last. When no other session needs
you, the status bar says so. While a dialog or a question over the agent
pane is up, the chord does nothing.

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
until you have sent it a line or a minute has passed. The dot is the whole of it on the
row, with the words on hover and for a screen reader; the agent pane's
header spells the state out. A session that goes quiet, ends, or rings for
attention while nobody is looking at it is **unread**: the accent dot, the
name in ink, `waiting for you` in the agent pane, a count in the status bar,
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
runs under one of them, and its row carries the account's name as a tag
when that is not the agents' own. The new-session row then opens into the
choice whether or not there is more than one agent, and the choice asks
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

## Integrated sessions

How an agent's sessions run is a setting per agent, a terminal to begin
with; see [settings](settings.md#sessions). An agent runs integrated only
where the core says it can drive it in messages, and the rest run in a
terminal. With no session on screen, the agent
pane offers a single new session the other way beside its New session
button. An integrated session is driven through the core in messages, as
[integrated](integrated.md) describes, and is a row like any other: it is
listed, stopped with its ×, brought back after a restart and resumed the
same way.

The agent pane's header names the session, its project and the branch the
folder has checked out, and what the session is doing: working, idle,
asking the user or waiting for a permission. Under it is the thread. The
user's words sit to the right in a tinted bubble under You; the agent's run
on the left under the model it ran on, or the agent's own name where that is
not known, with the time, down a quiet line at the side. What the session
shows is chosen by the kind of each call and the shape of what it carries,
the same for every agent. What the agent wrote is drawn as
Markdown, its code and tables included, and grows in place while it streams,
with a caret where the next words come. An image the agent names by an
address is shown as a link to it rather than fetched. The thread stays at
its foot while new content comes, and where the user scrolled to otherwise,
with a button back down; only the user's own scrolling stops it following,
and sending a message takes it to its foot.

What the agent did between two things it said folds into one line, such as
Worked for 3m, changed 3 files, ran 1 command, which opens into the steps:
each tool call with what it did to what, its input, a command's output as it
came, the files it changed as diffs, and a subagent's own run under the call
that started it. The changes pane stays the place to review changes. While a
turn runs, a line at its foot says what the agent is doing now: running a
command, reading a file, thinking, waiting for an answer. A plan is drawn
where it came and changed in place, a question the user answered with the
answer, a secret one without it, and a compaction, a notice or an error
where it happened. The sessions an agent started with the workbench's start
tool show under its run as rows, each with its state, name and model and a
way to open it.

A permission the agent asks for docks over the composer rather than in the
thread: who asks, the agent or one of its subagents, and what for, with the
choices the core offers. A command of several lines is shown whole from the
start, a path outside the project is marked as such, every other path the
request names outside the project is listed, and any character that would
change how the text reads without being seen, a control or a mark that
reorders text, shows as a marker. The whole request, with the tool it names,
is a fold away wherever the line does not say all of it. The first allows the call once and remembers
nothing; the others allow it for the session or always, saying what each
keeps, deny it, with words for the agent if the user wants, or deny it and
stop the turn. A line under the choices says what the one in focus or under
the pointer does. A question docks the same way with its options, answered by
picking one where one is all it takes, with room for the user's own words
where it takes them; a secret answer is typed hidden. Requests are answered
one at a time, the oldest first, and the dock says how many more wait.

The composer under the dock takes several lines, images dropped, pasted or
picked, and any other dropped file as its path in the text; a message sent
while an image is still being read waits for it. It shows the model the
session runs on, which a click changes: the agent's default is named once
the agent has said which model that is, and a model chosen during a turn is
said to be used from the next. It shows the mode the session runs in, which
a click changes among the modes the agent offers; a session starts in the
agent's safe mode, which asks before it acts, whatever the agent's own
configuration says, and a mode taken from that configuration is shown as it
is. It shows how much of the context window the conversation takes. While
the agent works its Send button is a Stop button, and a message sent
meanwhile stands under the thread, marked as waiting, until the turn that
takes it. While the agent waits on an answer the composer says Up reaches
it, and a lone digit sent then goes only on a second Enter, so it is not
sent as a message by surprise. A message that was not delivered, refused by
the agent or never sent, can be put back in the composer. What is being written
stays with its session while another is on screen. The keys are in
[focus](focus-model.md#an-integrated-session).

The row's id is the conversation's id as the agent says it once ready, so
the agent's own tools find the row. Its state, working, asking or idle,
comes from the session's events, never from the hooks or from output; the
hooks still fire for it and are left alone. When it stops working or asking
while nobody looks, the line under its name is the first line of what the
agent last said, unless the agent left a line of its own. A row with no name
yet takes the first line of its first message.

Before a session can run it may need the user. In a folder the agent has
not been told to trust, the pane asks whether to trust it, and on a yes the
trust is recorded where the agent's own question records it and the session
starts. Under an account that is not signed in, the pane says so and gives
the command to sign in with in a terminal; the workbench never signs in. A
session that ended or could not start says why, and Resume starts it again
on the same conversation, the thread drawn so far staying above what comes.
A resumed session's earlier messages are in its transcript and are not drawn.
A window reloaded while the core still runs a session takes it up where it
is, its open requests and waiting messages included.

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

## Past sessions

Under the live sessions sit the ones the agent has already had in this
project, read from the agent's own transcripts or index. Clicking one opens
it as another live session through the agent's resume command, so a past
conversation becomes a row like any other and the one you were in keeps
running.

Ours first, the rest behind a row. The agent's history holds every session
run in the project, including ones started from a plain terminal, and months
of those would bury the app's own. The sessions this app has run lately are
remembered by id and listed outright; the others sit behind a single row per
agent that counts them and opens a dialog over them, with a filter that
takes every word you type against a session's name, its id and the worktree
it ran in, and Enter or a click on one to resume it. Resuming one adopts it.
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
added.
