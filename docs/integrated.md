# Integrated sessions

An integrated session is an agent run as a process the core talks to in
messages, with no terminal. The window draws the conversation from what
the agent says, and sends it what the user types. The agent's own binary
does the work, so its login, settings, hooks, skills, plugins, MCP servers
and instructions all apply as they do in its terminal interface, and the
transcript it writes is the same one: a session started integrated resumes
in a terminal, and the other way round.

Claude Code is the agent driven this way. The commands and events below
are not particular to it: only the code that speaks an agent's own
protocol is, and it is kept apart from the rest so that another agent's
protocol can sit beside it.

## How Claude Code is started

Claude Code runs in print mode with JSON lines in both directions, and
stays running for as long as its stdin is open:

```
claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages --forward-subagent-text --replay-user-messages
  --permission-prompt-tool stdio
  [--permission-mode <mode>] [--model <model>] [--effort <effort>]
  --session-id <id> | --resume <id>
  [--mcp-config <file>]
```

The partial messages are the text as it streams; the forwarded subagent
text is what a subagent says; the replayed user messages come back with
the ids they were sent with, beside the agent's own lines saying when it
took each; and the permission prompts come to the core instead of being
refused. The session id is chosen by the workbench, as for a terminal
session. The workbench's own tool server is attached to each session when
it is installed, through a configuration file written for the session and
removed when it ends, so it needs no entry in the account's configuration.
`--bare` is never used: it would skip the hooks, the instructions and the
MCP servers, and refuse the user's login.

A model name, a mode, an effort and a session id are checked before they
go on the command line: letters and digits, and for a model name a few
characters of punctuation besides. On Windows an agent installed as a
script runs through the command interpreter, so nothing that interpreter
reads as more than a character may reach it.

The environment is the one a terminal session gets: the login shell's,
captured once, without the variables that mark a process as running inside
another Claude Code session. The account's configuration directory is set
when the session runs under an account of the user's own. Nothing that
signs in is passed: no token and no key. A session under an account that is
not signed in says so as an error, and the user signs in by running `claude`
in a terminal; the workbench never drives a sign-in.

## Trust

Print mode skips the agent's own question of whether a folder's files are
to be trusted, and a trusted folder's hooks and MCP servers run. So before
it starts a session, the core reads the record that question writes: the
`hasTrustDialogAccepted` entry for the folder, or for a folder above it,
in the state file of the account the session runs under. A start in a
folder with no such entry fails with an error of its own kind, which the
window can tell from other failures. The window asks the user, and on a
yes the trust command writes the entry for the folder, where the agent's
own question would have, and the session can start. A worktree the
workbench makes gets the entry when its project has one.

## Commands

A session is addressed by an id the core gives it at the start, routed by
path like a pty's, so a session on another machine runs through its daemon
the same way.

| Command | What it does |
| --- | --- |
| Start | Starts or resumes a session in a project, with a model, a mode, an effort and an account. Answers with the session's id and the agent's id for the conversation, or fails because the folder is not trusted. |
| Trust | Records that the user trusts the folder a session would run in. |
| Send | Sends the user's message, with any images, under an id the window chose: a UUID it has not used in the session. |
| Interrupt | Stops the running turn. Messages already queued stay queued. |
| Answer | Answers a permission request with one of the choices it offered. |
| Reply | Answers a question the agent asked: for each question, the options picked or the user's own words. It can also decline to answer. |
| Configure | Switches the model, the mode or the effort, each that is given. Answers with what the session now runs on. |
| Stop | Closes the agent's stdin, which ends the conversation, and kills the process if it is still there a few seconds later. |

Events can name an id before the command that hands it back has answered:
a session's first events can arrive before the start does. The window
keeps the events of an id it does not know yet, and plays them once it
does. Since the window chooses a message's id before sending it, the events
that name a message never come before the window knows the id.

## Permissions

A permission request offers its answers, each with what it remembers in
words the window can show:

- **allow**: this call only;
- **allow for the session**: this call, and what the offer remembers for
  as long as the session lives;
- **allow always**: this call, and what the offer remembers from now on;
- **deny**: not this call, and the turn goes on, with a message for the
  agent where the offer takes one;
- **cancel**: not this call, and the turn stops.

A choice that would remember something is offered only when the agent
said precisely what. For Claude Code, that is the one rule it suggested
for the call, such as `Bash(touch notes.txt)`, or for a tool with no rule
of its own the permission mode it suggested, such as accepting edits for
the session. Allowing always writes the rule into the project's
uncommitted local settings, as the terminal's "don't ask again" does. A
request with nothing suggested offers allow, deny and cancel alone. Only
what the chosen offer names is sent back, never the rest of what the agent
suggested.

A question the agent asks the user is a request of its own, answered with
a reply rather than a permission: each question with its options, whether
more than one may be picked, and room for an answer in the user's own
words. Asking to go ahead with a plan is a permission, which allowing
grants; the plan itself arrives as a plan event first.

## Events

Everything the session says arrives as one event, `integrated_event`,
naming the session and its kind:

- **ready**, once, before anything else: the model, mode and effort, the
  agent's version, and what it offers: models (each with the efforts it
  takes), modes, the efforts of the model it runs on, and its slash
  commands.
- **configured**: the model, the mode or the effort changed.
- **message**: a sent message is queued behind a running turn, was taken
  into the running turn, or was dropped and will not be answered.
- **turn started**, with the messages it answers, and **turn ended**: how
  it ended (done, interrupted or failed, with why), its time and token
  usage, and the agent's running total cost for its process so far, which
  is not the turn's own cost.
- **text** and **thinking**, by block: pieces as they stream, then the
  whole block.
- **tool started**, with the agent's name for the tool and what kind of
  tool it is (command, edit, read, search, web, MCP, agent or other);
  **tool input**, streamed and then whole, in the agent's own shape; **tool
  output**, streamed, for an agent that streams it; and **tool finished**:
  the result as text, and the files the call created, updated, deleted or
  moved, each with its content or its hunks.
- **plan**: the agent's plan, written out or as a list of steps, whole
  each time it changes; and **turn diff**: everything the turn has changed
  so far as one diff, for an agent that keeps one.
- **permission asked**, **question asked**, and **withdrawn** when the
  agent stops waiting for either.
- **task started**, **task progress** and **task finished**, for subagents
  and background commands. A task ends completed, failed, stopped, or lost:
  gone from what the agent lists as running, with no word of how it ended.
- **compacting** and **compacted**.
- **retrying**: a request to the model failed and the agent tries again;
  the turn goes on.
- **state**, **error** and **ended**.

A subagent's text, tool calls, plans and requests name the tool call that
started it, so the window can draw them under that call.

Long content is cut down before it goes out, so that a whole file does not
cross to the window, or over a connection to another machine, every time a
tool touches one: a tool's output, each string in its input, a changed
file's content and hunks, and a turn's diff, each with a flag that says it
was cut short. Streamed pieces of one call's input or output stop past a
limit; the whole that follows is cut down the same way.

The workbench's hooks fire for an integrated session too, so the session
events the hooks send arrive beside these. A window drawing the session
takes its state from these events and leaves the hooks' alone, so that it
does not tell the user twice.

## Turns, queued messages and state

A message sent while a turn runs is not lost: it waits, and the core says
so. Claude Code takes every message that waited during a turn into the
next one, so one turn may answer several messages, and the turn names them
all. Which messages a turn answers comes from the agent's own account of
when it took each, matched by the ids they were sent with, never from the
order they were sent in. A turn with no message behind it is one the agent
started by itself, which happens when work it left running in the
background finishes while the session is idle. A turn the agent ends
without having said it started is started first, so every end has a start.

Where an agent takes no message while a turn runs, the core holds each one
and hands it over when the turn is done.

The state a session's row shows comes from the same events, never from
timing or hooks:

- **asking** while a permission request or a question waits for an
  answer;
- **working** while a turn runs, a message waits for one, the conversation
  is compacted, or a subagent is still at work, including the moment
  between a subagent ending and the turn its report starts. A subagent
  that is lost has no report to wait for, and an interrupt while no turn
  runs stops waiting for one;
- **idle** otherwise. A command left running in the background, such as a
  dev server, does not keep a session working.

A tool call the agent leaves without a finish is finished by the core, as
failed with no output: those of the main conversation when the turn ends,
a subagent's when the subagent ends, and all of them when the session
does.

## Failure

The agent's protocol has no published format, so the code that reads it is
kept apart and reads defensively, as the transcript readers are: an
unknown message or field is ignored, a line that is not JSON is skipped,
and a request from the agent that the workbench does not handle is refused
rather than left unanswered. A line longer than a few megabytes is skipped,
with an error that says so.

Every wait on the process has a limit. The agent has a minute and a half
to say it is ready, and is ended with an error if it does not. A line it
does not take within half a minute means it has stopped reading: the
session is ended with an error, so that nothing queued behind the line is
written late. A control request it does not answer within half a minute
fails, and the session goes on. A stopped session has a few seconds to end
before it is killed.

The agent runs in a process group of its own. Killing it kills the group,
its MCP servers and the commands it left running among them, and what is
still in the group once the agent has ended is ended too. Every integrated
session is stopped when the app exits, and when the daemon's stdin ends on
another machine. A connection to another machine that goes away ends its
sessions for the window, with an error saying why.

Events go out in order through a thread of their own, so a slow window or
connection never holds up a command. A process that dies fails the turn
it was in, finishes its open tool calls, withdraws what it asked, drops
the messages that waited, says what its last words on stderr were, and
ends with **ended**, so a session never hangs and never brings down the
core.
