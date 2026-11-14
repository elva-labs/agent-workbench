# Integrated sessions

An integrated session is an agent run as a process the core talks to in
messages, with no terminal. The window draws the conversation from what
the agent says, and sends it what the user types. The agent's own binary
does the work, so its login, settings, hooks, skills, plugins, MCP servers
and instructions all apply as they do in its terminal interface, and the
transcript it writes is the same one: a session started integrated resumes
in a terminal, and the other way round.

Claude Code and Codex are the agents driven this way. The commands and
events below are not particular to either: only the code that speaks an
agent's own protocol is, and each agent's is kept apart from the rest and
from the other's.

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

The agent is also asked, through its environment, to say when its session
goes idle: after a turn, and after the turns that report the subagents it
left running. That is the moment nothing it began can still be at work.

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

## How Codex is started

Codex runs its app-server, which speaks JSON-RPC in lines on stdio and
stays running for as long as its stdin is open:

```
codex app-server
```

Everything else is said in messages. The workbench introduces itself by
name, which Codex files the threads it starts under, then reads the
account, the models Codex offers and the efforts each takes, and the
user's configuration as Codex sees it from the session's folder, and
starts a thread in that folder, or resumes the one asked for without its
past turns, which the window reads from the transcript. The thread starts
with the model, the effort and the mode the session asked for, and with
approvals sent to the window whoever the user's own configuration names to
review them. A start that names no mode runs in the mode the user's
configuration sets, which can be full access. The thread's id is Codex's
own, known once the thread has started, so the start answers with none and
ready carries it.

A mode is Codex's approval policy and sandbox together: read only, which
asks before it changes anything; auto, which changes files and runs
commands in the project and asks before going beyond it; and full access,
which asks for nothing, not even for an MCP tool that would ask, which
fails instead. A user configuration that sets another pair shows as that
pair, such as `untrusted, workspace-write`, which is not among the modes
and which a session switched away from cannot switch back to. Auto keeps
the folders the user's configuration lets Codex write to and whether it
may reach the network. Codex takes the model, the effort and the mode with
each message, so a change of any is settled by the workbench, answers at
once, and goes with the next message; a change made while a message is on
its way goes with the one after, and one a message carried that Codex
refused goes with the next.

The workbench's tool server is attached to each thread through the
thread's own configuration, under the name the hooks install it by, with
its tools allowed without asking, so it needs no entry in the account's
configuration. Codex gives the servers it starts an environment of its own
choosing, so the session's id and role go into the server's entry. For a
fresh thread there is no id to give, since Codex makes it when it starts
the thread and the server with it: the tools that need to know which
session calls them, the browser and the waits, refuse a fresh Codex
session's calls, as they do a Codex terminal session's. A resumed thread's
server knows its session.

The account is the home Codex reads from `CODEX_HOME`. An account that
needs an OpenAI login and has none says so with the same error as for
Claude Code, and the user signs in by running `codex login` in a terminal.
A Codex older than the oldest version the workbench speaks to, one that
refuses the introduction, and a thread that cannot start or resume each
end the session with an error that says which.

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
workbench makes gets the entry when its project has one. Nothing is made
for the session, not even the account's folder, before the folder is
trusted.

Codex keeps the same answer in its configuration, as a `trust_level` for
a folder in the `config.toml` of the account's home, and a Codex start
reads it the way Codex does. The folder's own record decides when there is
one, and only `trusted` is a yes. A folder with no record of its own takes
the record of the repository it is in, which for a worktree is its main
repository's; a folder between the two counts for nothing. The trust
command writes the folder's own record, leaving the rest of the file as
the user wrote it.

Running agents, the user's own terminal sessions among them, read and
rewrite the same state file. The workbench reads it right before it
changes it, and writes it whole to a file beside it that is then moved
over it, so a reader never finds it half written. A link to the file is
followed, and the file keeps its permissions. A file of its own that a
write cut off by a crash left beside it is removed by a later write. Within one app or daemon,
a trust write takes turns with the hooks' installs and removals, which
write the same file, so none of them loses another's entry.

## Commands

A session is addressed by an id the core gives it at the start, routed by
path like a pty's, so a session on another machine runs through its daemon
the same way.

| Command | What it does |
| --- | --- |
| Start | Starts or resumes a session in a project, with a model, a mode, an effort and an account. Answers with the session's id and the conversation's id where the workbench knows it then, or fails because the folder is not trusted. |
| Trust | Records that the user trusts the folder a session would run in. |
| Send | Sends the user's message, with any images, under an id the window chose: a UUID it has not used in the session. |
| Interrupt | Stops the running turn. Messages already queued stay queued. |
| Compact | Compacts the conversation, the way the agent does it. Claude Code is sent a compact command as a message of its own, and Codex is asked to compact its thread; either way the turn it starts names no message of the window's. |
| Answer | Answers a permission request with one of the choices it offered. |
| Reply | Answers a question the agent asked: for each question, the options picked or, where the question takes them, the user's own words. It can also decline to answer. |
| Configure | Switches the model, the mode or the effort, each that is given, all within 45 seconds, which is less than a call to another machine waits. A change that would be asked for once that time is up is not asked for at all. Answers with what the session now runs on. Codex takes the change with the next message. |
| Snapshot | Says what a window that comes to the session late needs and no transcript holds: the session's state and whether a turn runs, its settings, what the agent said it offers when it was ready, every permission request and question still waiting for an answer, and the messages no turn has taken yet. It answers once every event that went out before it has, so it reflects those events and none after. |
| Stop | Closes the agent's stdin, which ends the conversation. An agent still there a few seconds later is asked to end, and one still there after that is killed. |

Events can name an id before the command that hands it back has answered:
a session's first events can arrive before the start does. The window
keeps the events of an id it does not know yet, and plays them once it
does. Since the window chooses a message's id before sending it, the events
that name a message never come before the window knows the id.

The conversation's id is known at the start only where the workbench
chooses it, as it does for Claude Code, or resumes one. An agent that
makes its own ids, as Codex does, has none to give yet. The ready event
carries the agent's id in either case, and that is the one to keep for
resuming.

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

For Codex, allowing for the session remembers the command as it was
written, the changes under the folder the request names or to the files it
changes, or the MCP tool asked for; allowing always adds the command
prefix Codex proposed to its rules, or a host it proposed to its network
policy, or allows the MCP tool from now on where Codex offers that. The
command is the one Codex runs, wrapped in its shell, such as
`/bin/zsh -lc 'touch made.txt'`, and the prefix it proposes is often the
whole command. A request for more permissions than the sandbox gives
remembers them for the rest of the turn when allowed, or of the session,
and offers no cancel. Codex takes no message with a denial, and its offers
say so.

A question the agent asks the user is a request of its own, answered with
a reply rather than a permission: each question with its options, whether
more than one may be picked, whether the user may answer in words of their
own, and whether the answer is a secret, such as a password, that is not
to be shown. A reply to a question that takes no words of the user's own
names only its options. Claude Code's questions all take the user's own
words, and none is secret. Codex's may be secret, and may offer options
alone; none lets more than one option be picked, and one with no options
takes the user's own words. Declining a Codex question answers none of it,
and Codex may stop waiting for an answer after a while, which arrives as
withdrawn. Asking to go ahead with a plan is a permission, which allowing
grants; the plan itself arrives as a plan event first.

## Events

Everything the session says arrives as one event, `integrated_event`,
naming the session and its kind:

- **ready**, once, before anything else: the conversation's id, the model,
  mode and effort, the agent's version, and what it offers: models (each
  with the efforts it takes), modes, the efforts of the model it runs on,
  and its slash commands. A mode can be one the list does not hold, when it
  comes from the user's own configuration.
- **configured**: the model, the mode or the effort changed.
- **message**: a sent message went to the agent with nothing ahead of it,
  is queued behind a running turn, was taken into the running turn, or
  was dropped and will not be answered, because the agent refused,
  discarded or cancelled it. The first of these for a message carries its
  text and the images it attached, so that any window can draw it.
- **turn started**, with the messages it answers, and **turn ended**: how
  it ended (done, interrupted or failed, with why), its time and token
  usage, and the agent's running total cost for its process so far, which
  is not the turn's own cost. Usage counts every token the model read,
  with how many came from a cache, and every token it wrote, with how
  many were reasoning. A turn stopped by an interrupt, or by cancelling a
  permission, ends as interrupted.
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
- **permission asked** and **question asked**; **answered**, with the
  choice, or for a question the answers, from whichever window answered,
  with a secret question's answer left out; and **withdrawn** when the
  agent stops waiting for either.
- **task started**, **task progress** and **task finished**, for subagents
  and background commands. A task the agent marks as housekeeping says so,
  and a window may leave it out. A task ends completed, failed, stopped,
  or lost: ended with no word of how by the time the turn, or the agent's
  work as a whole, was over. A finished task says whether the agent
  reports it in a turn of its own.
- **compacting** and **compacted**, which says whether it was asked for or
  the context window was full.
- **context**: how much of the model's context window the conversation
  takes, and how big the window is, where the agent says.
- **notice**: something the agent says that is neither an error nor part
  of a turn, such as that it fell back to another model, as information or
  as a warning.
- **retrying**: a request to the model failed and the agent tries again;
  the turn goes on.
- **skipped**: streamed pieces left out because the window or its
  connection fell behind, as described under failure.
- **state**, **error** and **ended**.

For Codex, a file change's input comes whole again each time the patch it
writes grows; the last is the whole of it. Its new files come with their
content and its changed ones with their hunks, read from the diff Codex
gives. A command's output comes only when it finishes, and a command that
was declined or ended with another code than zero finishes as an error. A
web search and an image view finish with no output. A turn reports no
cost. A tool call Codex makes to start another agent is a tool call of the
agent kind, and what that agent says has no event.

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

Codex takes no message while a turn runs. For an agent like it the core
holds each one, and each message gets a turn of its own. It hands one over
only when the agent has said it is ready, no turn runs, and the agent has
named the one handed over before, in a turn's start or as dropped, and
makes the line for it then, so that it goes with the conversation the
agent has started and the settings the session runs on at that moment.

Codex answers a message with the id of the turn it starts, and that turn
is the one that names it, whatever other turn starts first, such as one
that compacts. A turn that starts before the answer comes names no message
at first; the answer then names the message as taken into it. A message
Codex refuses is dropped with Codex's own words for why.

The state a session's row shows comes from the same events, never from
timing or hooks:

- **asking** while a permission request or a question waits for an
  answer;
- **working** while a turn runs, a message waits for one, the conversation
  is compacted, or a subagent is still at work, including the moment
  between a task ending and the turn its report starts, where the agent
  says one is coming. A task that is lost has no report to wait for, and
  an interrupt while no turn runs stops waiting for one;
- **idle** otherwise. A command left running in the background, such as a
  dev server, does not keep a session working, nor does housekeeping the
  agent does on its own account.

Claude Code says which tasks run in the background as a whole list, in no
promised order with the start and the end of each. A task the list leaves
out is lost only if it is still left out, with no word of its end, when the
turn ends or the agent says it is idle; a word that comes later is dropped.
A subagent that reports in a turn of its own may be told of after the turn
ends, so it is judged only when the agent says it is idle: one that leaves
the list with no word of its end keeps the session working until then. A
subagent the main turn waited on is over with that turn.

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
with an error that says so. The driver still sees its bytes pass, and a
tool call whose result was in it finishes at once as failed and cut short.

Every wait on the process has a limit. The agent has a minute and a half
to say it is ready, and is ended with an error if it does not. A line it
does not take within half a minute means it has stopped reading: the
session is ended with an error, so that nothing queued behind the line is
written late. A control request it does not answer within half a minute
fails, and the session goes on. A message handed to an agent that takes
one at a time, and that the agent has not named within half a minute,
in a turn's start or as dropped, is dropped, and the next one goes.

A Codex permission request or question still waiting when its turn ends is
answered no, so Codex is not left holding it, and withdrawn with no
answered event before it. A form an MCP server asks Codex to show is
declined, with a notice that says so. A request on a line too long to read
is answered no from what the start of the line says. What Codex says of a
thread other than the session's own, such as one of its sub-agents, is
left out, and a request from such a thread is answered no.

The agent runs in a process group of its own. An agent the core ends, on a
stop or after an error, is first asked to end with a termination signal,
and is killed with its whole group, its MCP servers among it, if it is
still there a few seconds later. What is still in the group once the agent
has ended is asked to end too, and killed if it is still there a moment
later. Claude Code runs a command it leaves in the background, such as a
dev server, in a process group of its own, which killing the agent's group
does not reach. It ends those commands itself when it is asked to end, so
a stopped session takes them with it, but an agent that is killed
outright, or that dies, leaves them running. Codex runs each command in a
process group of its own too. An interrupt ends the turn; a command Codex
has said it started is left running, and one it has not yet said it
started ends with the turn. Codex ends the commands left running itself
when its stdin closes, so a stopped session takes them with it, but a
Codex that is killed outright, or that dies, leaves them running. Every
integrated session is stopped when the app exits, and when the daemon's
stdin ends on another machine. A connection to another machine that goes
away ends its sessions for the window, once each, with an error saying
why. The tool server's configuration for a session is a file only its
owner can read, under a name that cannot be guessed, removed when the
session ends.

Events go out in order through a thread of their own, so a slow window or
connection never holds up a command. While too many wait for it, streamed
pieces of text, thinking and a tool call's input and output are left out,
and the next event to go out after them is a skipped event saying how many;
the whole that follows each piece holds all of it. Whole events and the
answers to commands are never left out. When still more wait, the core
stops reading the agent's output until there is room, which in time holds
up the agent rather than any command. A process that dies fails the turn
it was in, finishes its open tool calls, withdraws what it asked, drops
the messages that waited, says what its last words on stderr were, and
ends with **ended**, so a session never hangs and never brings down the
core.

## What has no event

Two things another agent offers have no event: the conversations of
Codex's own sub-agents, which it keeps as threads of their own, and forms
an MCP server asks the user to fill in from a schema. A question the agent
asks covers options and words of the user's own, not such a form.

## Drawing a conversation

What a window that draws an integrated session can rely on, and what it
has to do itself:

- **Order.** A session's events come in order. The first ones can arrive
  before the start answers, so the window keeps the events of an id it
  does not know yet. A change of settings and a snapshot answer after the
  events they caused. The other commands answer once what they wrote
  reached the agent, or the agent said it took it, and what they cause
  can come after, such as the end of an interrupted turn.
- **The conversation's id.** The session's row, and resuming it, need the
  conversation's id. For an agent that makes its own ids the start
  answers with none, and the id is known only from ready.
- **Streaming.** Text, thinking and a tool call's input stream in pieces,
  then come whole. The pieces can have a gap, which a skipped event marks,
  and the whole holds all of it. A block or an input can also end with no
  whole after it, when the turn is interrupted or the agent dies; the end
  of the turn, or of the session, is then its end too.
- **Messages.** A message's id is the window's own, chosen before it is
  sent. A turn names the messages it answers, several where the agent
  took them together; a turn that names none is one the agent began by
  itself. The first message event for an id carries its text and images,
  so a second window can draw a message it did not send.
- **Requests.** Each permission and question is settled by an answered or
  a withdrawn event, whichever window answered it, and a withdrawn one is
  over even where no answered event came before it. The answer to a
  secret question is not in it, so a window can show that the question
  was answered, but not what with.
- **The end.** Nothing comes after ended, and no last state comes with it:
  the open tool calls, the turn, the open requests and the waiting
  messages are closed first, then the session ends.
- **History.** No event is kept or played back. A window that comes to a
  session late, after a reload or as a second window, listens first and
  then asks for a snapshot, and draws from it what no transcript holds:
  the state, the settings and what the agent offers, the requests waiting
  for an answer, which it can still answer, and the messages that wait
  for a turn. Every turn the agent has begun, and what was said in it, is
  read from the agent's transcript, as are a resumed session's past turns.
  The part of a turn still running that the transcript does not hold yet,
  such as a block still streaming, comes in the events that follow.
- **Content.** Images in a tool's result and a command's output kept apart
  from its errors or its exit code arrive as plain text. Long content is
  cut down and flagged.
- **Hooks.** The workbench's hooks still fire for an integrated session.
  Its state comes from these events, and the hooks' are left alone.
- **The sessions pane and the tools.** The browser tools and the
  orchestrator's waits act only for a session the window shows as a
  running row whose id is the conversation's id, so an integrated session
  needs such a row for its agent's tools to work. The orchestrator's send
  and read act on terminals and do not reach an integrated session.
  Past sessions are listed from the transcripts, integrated ones among
  them.
