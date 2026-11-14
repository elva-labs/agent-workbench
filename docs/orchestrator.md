# The orchestrator

An orchestrator is a session that starts and steers other sessions. It is a
session like any other, an agent in a pty with a terminal of its own, and
you talk to it the way you talk to any agent. What it has that the others
do not is a set of tools for the sessions around it: it can see the open
projects, start a session in one of them with a prompt, send a running
session a line, wait until one of them stops or asks for something, read
what one has on screen, and stop them.

It runs in a project of its own, `orchestrator` under the workbench's home.
The first one starts from New orchestrator session, in the menu beside Open
project; from then on the project sits above the ones you opened, with its
sessions and the past ones to resume, and a session started there is an
orchestrator. With more than one agent installed its new-session row opens
into a row per agent, as any project's does. Nothing else about it differs,
except what it is told: an orchestrator is told to direct work rather than
do it, to start a session per piece in the project it belongs to, on a
worktree of its own when pieces touch the same files, to wait on them rather
than ask after them in a loop, to put the user's whole task in the prompt it
starts a session with and none of its own housekeeping, and to leave a line
on its own row when it stops, whether to relay a question or to report.
A session that follows a workflow is an orchestrator as well, in whatever
project it runs: it is told the same, and the workflow besides, as
[following a workflow](#following-a-workflow) describes. Every other
session has the same tools and none of the nudge.

## The tools

The seven tools reach the workbench through the same tool server the app's
own tools use. The orchestrator's own directory carries them whatever the
projects were told about live updates, and so does a session that follows a
workflow, which is pointed at the server when it starts where its
project's configuration does not point at it already; any other session has
them where its project's hooks are on. See [hooks](hooks.md) and
[agents](adapters.md#under-a-workflow).

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
as you see them. `stop` stops a session and files it with the sessions to
resume, behind the fold, rather than leaving a row of it under the project.
A start can carry a name for the work, which the
session's row and its worktree take; a name the project already has is
numbered rather than refused, so the same work twice is fix-it and fix-it-2.
A worktree it starts in is trusted where its project is, with either agent,
so nothing asks on the way in. A start can also name a model, which goes to
the agent on its command line and holds from the session's first turn, so
an orchestrator chooses the model for a piece of work when it starts it
rather than sending a model command afterwards. A model's name belongs to
one agent, so a start that names a model names the agent too, and one
that leaves the agent out is refused rather than given the project's last.
A start can name an account as well, by the name it has in the settings,
for work under a login other than the project's own; one that names an
account there is not is refused with the names there are. A session
resumed comes back under the account it ran under.

## Following a workflow

A session runs one of two ways: under a workflow, as its orchestrator, or
as one agent with no workflow. What the user picks is what starts. Picking
an agent, in the agent pane, in a project's new-session row or in the
palette, starts that agent alone. Picking a workflow in the palette starts
its orchestrator, on the workflow's agent and model, and a plain new
session where there was nothing to pick follows the project's workflow, as
[settings](settings.md#workflows) describes. A workflow whose
orchestrator runs on an agent that is not installed is refused on the row,
and so is a session under a workflow on a machine with no tool server to
give it the `start` tool.

An orchestrator is told the workflow's instructions and, unless the
workflow says otherwise, has its agent's own ways of handing work to
agents the user cannot see taken away, so every piece it hands out is a
session of its own started with `start`. [Agents](adapters.md#under-a-workflow)
says what each agent loses and what remains.

Each start from such a session names the step of the workflow it is for,
and is held to that step before the user is asked anything. A start that
names no step, or one the workflow does not have, is refused with the
steps there are. A start that names an agent or a model the step does not
allow is refused with the ones it does; one that names neither runs on the
step's first model, and one that names only the agent on the first of that
agent's. A session started for a step stays on the model it was given:
`send` gives it no command but `/compact`, since commands such as `/model`
and `/fast` change the model and either agent completes a command from the
start of its name, and a start or a resume for a step does not begin with
one either. A line counts as a command where it begins with a slash once
characters that draw nothing are passed over and a wide slash is read as a
slash, so one that begins with a path is refused too, and says to put a
word before it.

A work step runs no more sessions at once than it says. A start past that
is refused with the sessions running for it, and so is a resume: a session
that has finished its piece is stopped to make room, and a stopped one can
be resumed later. A session whose step the workflow no longer has, because
the step was renamed or removed since, is not resumed; the refusal names
the steps there are. A start takes its place in the step, or its round of a
review, the moment it is checked, before the user is asked, and gives it
back when the user refuses or the session does not come up, so two starts
at once cannot both find room or share a round.

A review names the session whose work it checks. One that names none, or
names a session the caller did not start for a work step, is refused: there
is no work behind it. A piece is named by the work session that began it;
a start for a later work step can name the session the piece came from,
and carries the piece on. A piece that does not pass is sent back with
`send` to its own session for the step the review goes back to, resumed
first if it was stopped, and is reviewed again by a new review naming the
same work or by a line to the reviewer.

The workbench counts the rounds of each review for each piece: a review
started, a review resumed with a prompt, and a line sent to a review that
has finished its round each count one. A review resumed with no prompt has
not finished a round since it came back, so the first line it is sent
counts its round. A review may run once and then once
more for every time it may send the work back, so a review that sends it
back three times at most has four rounds of a piece. A round past those is
put to the user through the same question a start is, worded as another
round of review for that piece; the user's yes lets that one round through,
and a no tells the orchestrator to ask the user how to go on. Another piece
has rounds of its own, and stopping a session does not reset the count. A
fresh piece is not checked against the others, so work started again as a
new piece begins its rounds again.

A started session remembers its step, and a review its round and the work
it checks. `sessions` says both for each session, the stopped ones too.

An agent that is not told its session's id, as Codex is not, is known by
the directory it runs in. A call that names no session is taken to come
from the one session running in its directory that was not told its id.
Where that is not certain and a session running there follows a workflow,
whether or not it was told its id, the call is refused rather than let
through unchecked. So is a call naming a session the workbench does not
run, or one that is no longer running and so cannot be calling, while any
session follows a workflow.

## What is remembered

What a session started is written down by session id, with the project,
the worktree, the agent and the name, and kept between runs beside the
sessions the app knows as its own. Under a workflow, so are the step and
round of each, and the rounds each piece has had; those go with the
orchestrator once it is gone from its project's past sessions. An orchestrator closed and resumed
keeps its id, so the sessions it started are still its own: the ones
still running answer to its tools as before, and a row with one of its
ids, resumed from the pane by hand, is folded under it all the same. When
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
its row when it is done or stuck, so the fold, the board and the wait tool
all say how it went.

The tools act on the sessions the caller started and on no others. A
session you started yourself is yours, on a subject of your own: another
agent cannot type into it, stop it, read it or so much as list it,
whatever it has been told to do by something it read.

## What the user is asked

The first time a session asks to start another in a project, the window
puts the question up over the agent pane and holds the call until it is
answered: allow it from now on, allow this one, or refuse. A round of
review past a workflow's limit is asked about every time, however the
project was allowed. It names the review and the work by the names the user
sees, "Review has run twice on Fix the cache, as many times as the workflow
allows. Allow another round?", with Allow one more round or Stop at the
limit. An allowed
caller is remembered for that project for as long as the app runs. A
refusal is an answer the agent reads, not an error. Bringing back a
session it already started is never asked about: the consent was given
when the session was, and the resumed session is that one going on.

A session started by another may not start any of its own, and no session
may have more than eight running at a time.

![The question over the agent pane: which session wants to start one, in which project, the prompt it would give, and Allow this session, Once or No.](orchestrator-ask.png)

## In the panes

The agent pane's header names the workflow a session is part of and its
place in it, quietly beside the title and in the header's own type: the
workflow and orchestrator for the session following it, the workflow
marked deleted where it follows the copy it kept, or the workflow, the step
and the round for a session started for a step. Where the header is short
of room, the workflow's name is cut short and then left out, and the place
stays whole. The rules for that place open in a popover under the tag when
the pointer rests on it, or on a click, Enter or Space, and Escape puts
them away: the instructions for the orchestrator, and for a session
started for a step what the step allows, in the words of its settings: the
models it may use, how many sessions it runs at once, and for a review
when the work passes, where it goes back and how many rounds it gives
each piece. A start the workflow refuses its orchestrator is shown over the
terminal in one line, whole while the pointer or the keyboard is on it, as
well as answered to the agent, until a start goes through or the line is
put away.

The sessions an orchestrator started stay in the project they run in, where
the work is, and keep out of the way: the pane folds them into one quiet
line per orchestrator, "2 started by Retry rollout", which opens into a row
each. The line speaks up in the accent when one of them needs a
permission, "1 asking", which only you can grant. Everything else they
wait on, the orchestrator hears, so the place to go is still the
orchestrator and not the session it started.

The orchestrator's own row says what it has out, "3 running, 1 asking", and
its changes pane, headed Orchestrator, shows the sessions it started instead
of a file tree: each with its project, its worktree, what it is doing, how
long it has been at it and the line it left, with Stop all on the section's
header. Each row can be stopped on its own, or sent a line without leaving the
orchestrator. Under the list, the projects the orchestrator has been allowed
to start sessions in, each with a way to take that back, and the worktrees its
starts have left behind, with Clean up for the ones whose work is merged and
whose trees are clean; the rest say why they stay.

![An orchestrator on screen: its session under its own project, the two sessions it started folded under theirs, and the board in the changes pane with a row for each, what it is doing, and the project it may start in.](orchestrator-board.png)

The sessions it started keep out of the keyboard's way too: Delete on one
of them does nothing, and a fold stops the lot from its own hover action.

## Where the work happens

An orchestrator directs; it does not edit. The sessions it starts run in
their own projects, on their own branches when they asked for a worktree,
each with its own terminal and scrollback, and they are sessions you can
open, type in and take over at any point.
