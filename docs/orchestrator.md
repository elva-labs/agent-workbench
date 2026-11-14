# The orchestrator

An orchestrator is a session that starts and steers other sessions. It is a
session like any other, an agent in a pty with a terminal of its own, and
you talk to it the way you talk to any agent. What it has that the others
do not is a set of tools for the sessions around it: it can see the open
projects, start a session in one of them with a prompt, send a running
session a line, wait until one of them stops or asks for something, read
what one has on screen, and stop them.

It runs in a project of its own, `orchestrator` under the workbench's home.
The first one starts from New orchestrator session, in the menu on the
sessions pane's title row; from then on the project sits above the ones
you opened, with its sessions and the past ones to resume, and a session
started there is an orchestrator. Its header's button starts another, and
with more than one agent installed it opens the choice of agent, as any
project's does. Nothing else about it differs,
except what it is told: an orchestrator is told to direct work rather than
do it, to start a session per piece in the project it belongs to, on a
worktree of its own when pieces touch the same files, to wait on them rather
than ask after them in a loop, to put the user's whole task in the prompt it
starts a session with and none of its own housekeeping, and to leave a line
on its own row when it stops, whether to relay a question or to report.
Every other session has the same tools and none of the nudge.

## The tools

The seven tools reach the workbench through the same tool server the app's
own tools use. The orchestrator's own directory carries them whatever the
projects were told about live updates; any other session has them where its
project's hooks are on. See [hooks](hooks.md).

`projects` lists the open projects, the caller's own marked, so a session
names a project the app actually has. `sessions` lists the sessions the
caller started, each with its id, its project and worktree, its agent, what
it is doing and the last line it left. A session that has stopped, ended or
asked for permission without the caller having been told says so beside
what it is doing, and listing it counts as telling. `start` starts a
session in a project with a first prompt, on a worktree of its own if it
asks for one, and answers with the new session's id. `send` types a line
into a running session, and Enter after it on its own, as a person does. A
long line goes in as a paste when the session's terminal has asked for
paste, and in small pieces a moment apart when it has not, so the agent
takes it whole either way. Its Enter follows on its own, later the longer
the line is.
`wait` sits until a session stops working, asks for permission or ends, or
until the seconds it was given run out. A stop is told once: the wait that
answers with it and a listing that shows it each count, so a session that
stopped between two waits is answered by the next one at once, and one that
went back to work in the meantime is waited out as usual. A wait over all
of a caller's sessions answers first with a stop the caller has not been
told of; a session that ended or asked, and was told so, is answered again
only when none of the others is still running. A wait the agent gave up on,
because the user interrupted it or the agent itself is gone, ends without
telling anything. `read` answers with the last lines on a session's screen,
as you would see them, whether or not it has ever been on screen. `stop`
stops a session and files it with the earlier sessions to resume, behind
their row, rather than leaving a row of it under the project.
A start can carry a name for the work, which the
session's row and its worktree take; a name the project already has is
numbered rather than refused, so the same work twice is fix-it and fix-it-2.
A worktree it starts in is trusted where its project is, with either agent,
so nothing asks on the way in. It has the project's hooks when the project
has them on, so `sessions` and `wait` follow the agent's own word for what
it is doing there as they do in the project, except for a project that is
a folder inside its repository; see [hooks](hooks.md). A start can also
name a model, which goes to the agent on its command line and holds from
the session's first turn, so an orchestrator chooses the model for a piece
of work when it starts it rather than sending a model command afterwards.
A model's name belongs to one agent, so a start that names a model names
the agent too, and one that leaves the agent out is refused rather than
given the project's last.
A start can name an account as well, by the name it has in the settings,
for work under a login other than the project's own; one that names an
account there is not is refused with the names there are. A session
resumed comes back under the account it ran under.

## What is remembered

What a session started is written down by session id, with the project,
the worktree, the agent and the name, and kept between runs beside the
sessions the app knows as its own. An orchestrator closed and resumed
keeps its id, so the sessions it started are still its own: the ones
still running answer to its tools as before, and a row with one of its
ids, resumed from the pane by hand, hangs under it all the same. When
the app itself was closed, the orchestrator comes back with the other
sessions that were open, and the sessions it started do not. `sessions`
then lists them as stopped, after the running ones, and `start` with one
of those ids in place of a project and prompt brings it back where it ran,
in its worktree with its conversation. A prompt given with it is what the
session goes on with; without one it comes up waiting for a line. The cap
and the one-level rule apply, and a session whose worktree has since been
cleaned up, or whose project is no longer open, is refused with the
reason. A session the orchestrator
stopped itself is not offered back: the stop said it was done with. The
record lives with the window's other memory, so a wiped local storage
forgets it, which only means the orchestrator starts afresh.

A session it starts is asked, at the end of its prompt, to leave a line on
its row when it is done or stuck, so the pane, the board and the wait tool
all say how it went.

The tools act on the sessions the caller started and on no others. A
session you started yourself is yours, on a subject of your own: another
agent cannot type into it, stop it, read it or so much as list it,
whatever it has been told to do by something it read.

## What the user is asked

The first time a session asks to start another in a project, the window
puts the question up over the agent pane and holds the call until it is
answered: allow it from now on, allow this one, or refuse. An allowed
caller is remembered for that project for as long as the app runs. A
refusal is an answer the agent reads, not an error. Bringing back a
session it already started is never asked about: the consent was given
when the session was, and the resumed session is that one going on.

A session started by another may not start any of its own, and no session
may have more than eight running at a time.

![The question over the agent pane: which session wants to start one, in which project, the prompt it would give, and Allow this session, Once or No.](orchestrator-ask.png)

## In the panes

The sessions a session started hang directly under it, one line each,
joined to its dot by a thin rail: the state dot, the name, the model it was
started on and when it last changed. One that runs in another project than
its starter names that project after its own name. Short of room, the
project is cut first, then the model is left out and the project with it,
and the name is cut last; the time always stands. The line speaks
up in the accent, `asking` where the model stands, when the session needs
a permission, which only you can grant. Everything else they wait on, the
starter hears, so the place to go is still the starter and not the
session it started. A session whose starter the window no longer has
stands in its own project like any other.

A starter's second line says in words what the sessions it started are
doing, each counted once, `2 running, 1 asking, 1 done`, unless its agent
has left a line there. A starter can be folded, from the chevron at the end
of its second line or with Left on the keyboard, and Right lets them out
again: folded, its second line says what they are doing whatever the agent
left, with a small dot for each where the model stands otherwise. Left on a
started session moves the cursor up to its starter. Nothing about the fold
is remembered.

The orchestrator's changes pane, headed Orchestrator, shows the sessions it
started instead
of a file tree: each with its project, its worktree, what it is doing, how
long it has been at it and the line it left, with Stop all on the section's
header. Each row can be stopped on its own, or sent a line without leaving the
orchestrator. Under the list, the projects the orchestrator has been allowed
to start sessions in, each with a way to take that back, and the worktrees its
starts have left behind, with Clean up for the ones whose work is merged and
whose trees are clean; the rest say why they stay.

![An orchestrator on screen with the sessions it started, and the board in the changes pane with a row for each, what it is doing, and the project it may start in.](orchestrator-board.png)

The sessions it started keep out of the keyboard's way too: Delete on one
of them does nothing. Its own × stops it, and Stop all on the board stops
every one.

## Where the work happens

An orchestrator directs; it does not edit. The sessions it starts run in
their own projects, on their own branches when they asked for a worktree,
each with its own terminal and scrollback, and they are sessions you can
open, type in and take over at any point.
