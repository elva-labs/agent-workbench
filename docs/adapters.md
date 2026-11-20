# Agents

The workbench drives two agents, both full-screen TUIs in a pty: Claude Code
and Codex CLI. Either can also run as an
[integrated session](integrated.md), driven in messages with the
conversation drawn by the window: Claude Code in print mode with JSON
lines, Codex through its app-server. The differences between them sit behind
one seam; everything above it sees a session with an agent id, a project,
and an id to resume by.

|               | Claude Code                                                        | Codex CLI                                                |
| ------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| Binary        | `claude`, on the login shell's PATH                                | `codex`, likewise                                        |
| Start         | `claude --session-id <uuid>`                                       | `codex`                                                  |
| Resume        | `claude --resume <id>`                                             | `codex resume <id>`                                      |
| Session id    | Chosen by the workbench, known from the first byte                 | Minted by Codex; the core watches for it                 |
| Past sessions | Its transcripts under its configuration directory                  | Its SQLite index under its home                          |
| Earlier messages | Read from the session's transcript                              | Read through its own app-server, from the thread's turns and items |
| Account       | `CLAUDE_CONFIG_DIR`, its configuration directory                   | `CODEX_HOME`, its home                                   |
| Session name  | The terminal title, stripped of the glyph and the agent's own name | The thread's name, else its title, else the first prompt |
| Workflow      | `--append-system-prompt-file`, `--disallowedTools`                 | `-c developer_instructions=…`, `-c features.multi_agent=false`, `-c features.multi_agent_v2.disable_native_tools=true`; integrated, the same in the thread's start |

## Accounts

Each agent keeps its login, its settings and its record of past sessions in
one directory, `~/.claude` and `~/.codex` by default, and reads another
from the variable named above. An account in the settings names a
directory for either agent or both, and a session under it is started with
the agent's variable set to the account's directory for that agent, so the
agent logs in, reads its settings and files its transcript there. An
account with no directory for the agent leaves the variable as it is, and
the agent uses its own. The past sessions a project lists are read from
the same directory. The core is given directories rather than names, so a
session on a remote machine runs under directories on that machine.

## Naming the session to its tools

Every session is given a token the workbench chose, in its environment as
`CHORD_SESSION`, with `CHORD_ROLE` beside it for a session that
follows a workflow, which directs the others, and `CHORD_WAKE` for a
session in a terminal whose project has the hooks on, which the workbench
can wake once its turn ends (see [when the user writes to
it](orchestrator.md#when-the-user-writes-to-it)). The tool server and the hooks
read them, and every call they make names the session by its token; see
[who is calling](orchestrator.md#who-is-calling). Claude Code passes its whole
environment to the servers it starts. Codex passes a server only the
variables its entry names, so wherever a Codex session has the tool
server, from its project's configuration or named for a workflow, the
server is named whole on its command line, its command, its arguments and
those three variables to pass on, with the time a call of its tools may take:
the longest a wait sits, half an hour, and a minute more, where Codex's own
is a minute and would cut a wait short and leave its answer unread. An
integrated Codex session's thread gives the server the same time. A Codex
session started outside the workbench keeps whatever its configuration
says, a minute unless the user set `tool_timeout_sec`. Named for a workflow where no
configuration names it, it is given the approvals the
[hooks](hooks.md#the-agents-tools) write: the server's own tools that
read, and those the window asks the user about every time, run without
asking, each by an approval of its own, and the rest ask as the user's
approval policy says. Named again
where the project's configuration has it, the command line says nothing
of approval, since Codex takes the command line over the project's file:
the entry there decides, as the hooks wrote it or as the user changed it.
Every other server asks as the user configured it, and the approval
policy is the user's.
An entry that named only the variables, for a server no configuration
names, would stop Codex from starting, so a session without the tool
server is told nothing of it. On Windows a Codex installed as a script is
not told the server either; see [under a workflow](#under-a-workflow).

Codex passes a server the variables its entry names from 0.47.0 on. An
older Codex takes the entry without a word and passes the server none of
them, so every call its sessions make names no session, and is taken for
one from [an agent the workbench did not
start](orchestrator.md#who-is-calling). A session under a workflow could
then direct nothing, so one on a Codex older than 0.47.0 is refused in a
terminal, saying to update; the version is what `codex --version` prints,
and a Codex whose version cannot be read is started all the same. An
integrated Codex session gives the server the two variables' values in the
thread's own configuration rather than their names, and runs only on a
Codex far newer than that, so it needs no such check.

## Under a workflow

A session that follows a workflow is told the workflow's instructions on
every start and every resume, in a terminal or integrated alike. Claude
Code adds them to its own system prompt, reading them from a file the
workbench writes for the session, with the same flags either way; Codex
takes them as developer instructions, the nearest setting it has. In a
terminal Codex has no setting that reads them from a file, so they go on
its command line; integrated, they go in the message that starts or
resumes its thread. The file is made new for each session, readable by
its owner alone, and removed when the session's process ends. Each
workbench process keeps its sessions' files in a folder of its own, beside
a lock it holds for as long as it runs; the folder of a process that ended
without removing its files, because it crashed, is removed the next time a
workbench starts a session under a workflow. On a filesystem that cannot
lock, sessions start all the same, and nothing is removed: the folder has
no lock, so no workbench takes it for one left behind, and a workbench that
cannot lock removes no folder at all.

Claude Code records the system prompt a conversation is first given and
sends that on every resume. A resumed session told something other than
what its conversation began with, a changed workflow or no workflow where
it had one, is started with that record turned off, so it reads what it is
told now.

Codex keeps what a thread began with. Resumed, in a terminal or
integrated, it reads the instructions its first turn was given, whatever
it is told now, and its subagent tools stay as they were then: a thread
started under a workflow that took them away is without them for good,
and one resumed under a changed workflow does not read the change.
Resuming it under no workflow, or with its subagent tools asked for, undoes
neither. A Codex session resumed under other instructions than it began
with, a changed workflow or none, says so over the session in one line,
Resumed as it began, until it is put away; a new session starts as the
workflow is now.

Where the workflow delegates only through the workbench, each agent loses
its own ways of handing work to agents the user cannot see. Claude Code is
started without `Agent`, its subagents, `Workflow`, its multi-agent
workflows, `SendMessage` and `ListAgents`, which reach other agents, and
`RemoteTrigger`, which runs agents in the cloud. Codex is started with its
multi-agent features off and its native collaboration tools turned off:
`spawn_agent`, `send_message`, `wait_agent`, `list_agents`,
`interrupt_agent` and `followup_task`, which a model on its newer
multi-agent version is given whatever the multi-agent features say. A
Codex from before that version passes over the second setting without a
word, and the first takes its multi-agent tools away. What remains is the shell, from which either agent could run
another copy of itself, and Claude Code's skills, some of which run in a
subagent of their own; the instructions tell the orchestrator to hand out
every piece with `start`.

Such a session has the workbench's tools whatever its project was told
about live updates. In a terminal, where the agent's configuration for the
directory does not already point at the tool server, the server is named
when the session starts: to Claude Code in a configuration file of the
session's own, to Codex as one of its servers on the command line. An
integrated session is given the server whatever its configuration says, as
[integrated sessions](integrated.md) describes. A machine with no tool
server does not start a session under a workflow, and says why.

On Windows an agent installed as a script runs through the command
interpreter, which ends a command at its first line break. Claude Code's
command line holds only file names there. Codex would lose all but the
first line of the instructions, so a Codex session under a workflow is
refused in a terminal on Windows, saying so, and runs integrated, where
nothing of the workflow is on its command line. A session with no workflow
starts as the table above says. The interpreter also takes the first and
the last quote off a line with more than two, which cuts short a script
path with a space in it, and the settings that name the tool server to
Codex hold quotes. So a Codex installed as a script is not told the server
on Windows: it starts the server from its own configuration, which passes
the server none of the session's variables, and every call the session
makes names no session. The workbench takes such a call for one from [an
agent it did not start](orchestrator.md#who-is-calling). Its tools ask or
not as the project's entry for the server says, as they do wherever the
project's configuration names it.

## Detection

Each agent is looked for once, on the login shell's PATH. A machine with one
of them shows no sign of the other, and a new session starts it. With
both, a new session opens the choice in place under the project's name, a
row per agent, and the
list of earlier sessions to resume says whose each one is; the session
rows themselves carry no agent tag. The cursor starts on
the agent last started in the project, marked `last used`, else the first
installed; Up and Down move it, Enter or a click starts that agent, alone
whatever workflow the project follows, Escape closes the choice.

## Ids that the agent mints

Claude Code takes the id it is given, so a running session and the
transcript it writes are the same thing from the start. Codex mints its own.
After spawning it the core watches Codex's index for a thread started in the
project since the spawn, and reports it: every half second for as long as the session lives, since
Codex records the thread when the first prompt is sent, which may be a while
after the spawn. Until then the row has no id and no name: it cannot be
resumed and is not yet the app's own. A Codex row also polls the
index every couple of seconds for its name. An integrated Codex session
needs no watching: its thread's id comes with the session's ready event.

## What is quarantined

Both indexes and Codex's session log are the agents' own and move with their
versions. Every line that reads one is kept apart, and every failure there
is an empty answer: a
project with no history, never a pane that will not open. Codex leaves an
old index behind when its schema moves; the newest is read.

The protocols the integrated sessions speak move with the agents' versions
too, and are read the same way, as [integrated sessions](integrated.md)
describes, and so is what a past conversation said, which
[history](integrated.md#history) describes for each agent. Codex
generates its app-server's protocol from its own code for each version,
and a version can drop what an earlier one had. Everything the workbench
reads from that protocol and writes to it, each method, field, status and
shape of an answer, is listed with the code, and a test checks each
against the schema the Codex installed on a developer's machine
generates, so what moved shows when Codex is upgraded. What the workbench
does not use may come and go.
