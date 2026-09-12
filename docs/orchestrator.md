# The orchestrator

An orchestrator is a session that starts and steers other sessions. It is a
session like any other, an agent in a pty with a terminal of its own, and
you talk to it the way you talk to any agent. What it has that the others
do not is a set of tools for the sessions around it: it can see the open
projects, start a session in one of them with a prompt, send a running
session a line, wait until one of them stops or asks for something, read
what one has on screen, and stop them.

It runs in a project of its own, `orchestrator` under the workbench's home,
pinned above the projects you opened. Starting a session there is starting
an orchestrator; nothing else about it differs.

## The tools

The seven tools reach the workbench through the same tool server the app's
own tools use, so hooks must be on for the project the calling session runs
in. See [hooks](hooks.md).

`projects` lists the open projects, the caller's own marked, so a session
names a project the app actually has. `sessions` lists the sessions, each
with its id, its project and worktree, its agent, what it is doing and the
last line it left. `start` starts a session in a project with a first
prompt, on a worktree of its own if it asks for one, and answers with the
new session's id. `send` types a line into a running session. `wait` sits
until a session stops working, asks for permission or ends, or until the
seconds it was given run out. `read` answers with the last lines on a
session's screen, as you see them. `stop` stops a session.

Those four act on the sessions the caller started and on no others. A
session you started yourself is yours: another agent cannot type into it,
stop it or read it, whatever it has been told to do by something it read.
They are all still listed, so an orchestrator knows what is running and
keeps out of its way.

## What the user is asked

The first time a session asks to start another in a project, the window
puts the question up over the agent pane and holds the call until it is
answered: allow it from now on, allow this one, or refuse. An allowed
caller is remembered for that project for as long as the app runs. A
refusal is an answer the agent reads, not an error.

A session started by another may not start any of its own, and no session
may have more than eight running at a time.

## In the panes

The sessions an orchestrator started stay in the project they run in, where
the work is, and keep out of the way: the pane folds them into one quiet
line per orchestrator, "2 started by Retry rollout", which opens into a row
each. The line speaks up in the accent when one of them is waiting on you,
"1 asking", so the place to go is still the orchestrator and not the
session it started.

The orchestrator's own row says what it has out, "3 running, 1 asking", and
its changes pane shows the sessions it started instead of a file tree:
each with its project, its worktree, what it is doing and how long it has
been at it, and Stop all on the section's header.

## Where the work happens

An orchestrator directs; it does not edit. The sessions it starts run in
their own projects, on their own branches when they asked for a worktree,
each with its own terminal and scrollback, and they are sessions you can
open, type in and take over at any point.
