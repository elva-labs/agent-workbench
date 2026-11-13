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
protocol is.

## How Claude Code is started

Claude Code runs in print mode with JSON lines in both directions, and
stays running for as long as its stdin is open:

```
claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages --forward-subagent-text
  --permission-prompt-tool stdio
  [--permission-mode <mode>] [--model <model>]
  --session-id <id> | --resume <id>
  [--mcp-config <the workbench's tool server>]
```

The partial messages are the text as it streams; the forwarded subagent
text is what a subagent says; and the permission prompts come to the core
instead of being refused. The session id is chosen by the workbench, as for
a terminal session. The workbench's own tool server is attached to each
session on the command line when it is installed, so it needs no entry in
the account's configuration. `--bare` is never used: it would skip the
hooks, the instructions and the MCP servers, and refuse the user's login.

The environment is the one a terminal session gets: the login shell's,
captured once, without the variables that mark a process as running inside
another Claude Code session. The account's configuration directory is set
when the session runs under an account of the user's own. Nothing that
signs in is passed: no token and no key. A session under an account that is
not signed in says so as an error, and the user signs in by running `claude`
in a terminal; the workbench never drives a sign-in.

Print mode skips the agent's workspace trust question. A project the user
never trusted in the terminal runs its hooks and its MCP servers in an
integrated session without being asked.

## Commands

A session is addressed by an id the core gives it at the start, routed by
path like a pty's, so a session on another machine runs through its daemon
the same way.

| Command | What it does |
| --- | --- |
| Start | Starts or resumes a session in a project, with a model, a permission mode and an account. Answers with the session's id and the agent's id for the conversation. |
| Send | Sends the user's message, with any images. Answers with the message's id. |
| Interrupt | Stops the running turn. Messages already queued stay queued. |
| Answer | Answers a permission request: allow once, allow for the session, allow and remember for the project, or deny with a message for the agent. |
| Set model, set permission mode | Switch the running session. Answer with what the agent switched to. |
| Stop | Closes the agent's stdin, which ends the conversation, and kills the process if it is still there a few seconds later. |

Allowing for the session or for the project remembers the one rule the
agent suggested for the call, and nothing else it suggested: for the
project it goes into the project's uncommitted local settings, as the
terminal's "don't ask again" does. A request that names no rule cannot be
remembered for the project, and says so in the choices it offers.

## Events

Everything the session says arrives as one event, `integrated_event`,
naming the session and its kind:

- **ready**, once, before anything else: the model and permission mode,
  the agent's version, the models it can switch to and its slash commands.
- **configured**: the model or the permission mode changed.
- **turn started** and **turn ended**: how the turn ended (done,
  interrupted or failed, with why), its cost, time and token usage.
- **text** and **thinking**, by block: pieces as they stream, then the
  whole block.
- **tool started**, **tool input** (streamed, then whole) and **tool
  finished**: the result as text, and for a file the tool wrote or edited,
  the change with its hunks.
- **permission asked** and **permission withdrawn**.
- **task started**, **task progress** and **task finished**, for subagents
  and background commands.
- **compacting** and **compacted**.
- **message queued**, **state**, **error** and **ended**.

A subagent's text and tool calls name the tool call that started it, so the
window can draw them under that call.

## Turns, queued messages and state

A message sent while a turn runs is not lost or merged: the agent takes it
when the turn ends, and its own turn follows. The core says so with
**message queued** at once, and the turn that answers a message names it.
Turns start in the order messages were sent. A turn with no message behind
it is one the agent started by itself, which happens when work it left
running in the background finishes while the session is idle.

The state a session's row shows comes from the same events, never from
timing or hooks:

- **asking** while a permission request waits for an answer;
- **working** while a turn runs, a message waits for one, the conversation
  is compacted, or a subagent is still at work, including the moment
  between a subagent finishing and the turn its report starts;
- **idle** otherwise. A command left running in the background, such as a
  dev server, does not keep a session working.

## Failure

The agent's protocol has no published format, so the code that reads it is
kept apart and reads defensively, as the transcript readers are: an
unknown message or field is ignored, a line that is not JSON is skipped,
and a request from the agent that the workbench does not handle is refused
rather than left unanswered. Every wait on the process has a limit: the
agent has a minute and a half to say it is ready, half a minute to take a
line or answer a control request, and a few seconds to end when stopped.
Whatever goes wrong becomes an **error** event, and a process that dies
fails the turn it was in, withdraws what it asked, and ends with
**ended**, so a session never hangs and never brings down the core.
