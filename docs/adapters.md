# Agents

The workbench drives two agents, both full-screen TUIs in a pty: Claude Code
and Codex CLI. Claude Code can also run as an
[integrated session](integrated.md), driven in messages with the
conversation drawn by the window. The differences between them sit behind
one seam; everything above it sees a session with an agent id, a project,
and an id to resume by.

|               | Claude Code                                                        | Codex CLI                                                |
| ------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| Binary        | `claude`, on the login shell's PATH                                | `codex`, likewise                                        |
| Start         | `claude --session-id <uuid>`                                       | `codex`                                                  |
| Resume        | `claude --resume <id>`                                             | `codex resume <id>`                                      |
| Session id    | Chosen by the workbench, known from the first byte                 | Minted by Codex; the core watches for it                 |
| Past sessions | Its transcripts under its configuration directory                  | Its SQLite index under its home                          |
| Account       | `CLAUDE_CONFIG_DIR`, its configuration directory                   | `CODEX_HOME`, its home                                   |
| Session name  | The terminal title, stripped of the glyph and the agent's own name | The thread's name, else its title, else the first prompt |
| Workflow      | `--append-system-prompt-file`, `--disallowedTools`                 | `-c developer_instructions=…`, `-c features.multi_agent=false`, `-c features.multi_agent_v2.disable_native_tools=true` |

## Accounts

Each agent keeps its login, its settings and its record of past sessions in
one directory, `~/.claude` and `~/.codex` by default, and reads another
from the variable named above. An account in the settings names a
directory of each, and a session under it is started with the agent's
variable set, so the agent logs in, reads its settings and files its
transcript there. The past sessions a project lists are read from the same
directory. The core is given directories rather than names, so a session on
a remote machine runs under directories on that machine.

## Under a workflow

A session that follows a workflow is told the workflow's instructions on
every start and every resume. Claude Code adds them to
its own system prompt, reading them from a file the workbench writes for
the session; Codex takes them as developer instructions, the nearest
setting it has, and has no setting that reads them from a file, so they go
on its command line. The file is made new for each session, readable by
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
about live updates. Where the agent's configuration for the directory does
not already point at the tool server, the server is named when the session
starts: to Claude Code in a configuration file of the session's own, to
Codex as one of its servers on the command line. A machine with no tool
server does not start a session under a workflow, and says why.

On Windows an agent installed as a script runs through the command
interpreter, which ends a command at its first line break. Claude Code's
command line holds only file names there. Codex would lose all but the
first line of the instructions, so a Codex session under a workflow is
refused on Windows, saying so. A session with no workflow starts as the
table above says.

## Detection

Each agent is looked for once, on the login shell's PATH. A machine with one
of them shows no sign of the other: no tags, and a new session starts it.
With both, every session row carries a `claude` or `codex` tag, and the
new-session row opens in place into a row per agent. The cursor starts on
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
index every couple of seconds for its name.

## What is quarantined

Both indexes and Codex's session log are the agents' own and move with their
versions. Every line that reads one is kept apart, and every failure there
is an empty answer: a
project with no history, never a pane that will not open. Codex leaves an
old index behind when its schema moves; the newest is read.
