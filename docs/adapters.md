# Agents

The workbench drives two agents, both full-screen TUIs in a pty: Claude Code
and Codex CLI. The differences between them sit behind one seam; everything
above it sees a session with an agent id, a project, and an id to resume by.

| | Claude Code | Codex CLI |
| --- | --- | --- |
| Binary | `claude`, on the login shell's PATH | `codex`, likewise |
| Start | `claude --session-id <uuid>` | `codex` |
| Resume | `claude --resume <id>` | `codex resume <id>` |
| Session id | Chosen by the workbench, known from the first byte | Minted by Codex; the core watches for it |
| Past sessions | Its transcripts under the user's home | Its SQLite index under the user's home |
| Session name | The terminal title, stripped of the glyph and the agent's own name | The thread's name, else its title, else the first prompt |

## Detection

Each agent is looked for once, on the login shell's PATH. A machine with one
of them shows no sign of the other: no tags, and a new session starts it.
With both, every session row carries a `claude` or `codex` tag, and the
new-session row opens in place into a row per agent. The cursor starts on
the agent last started in the project, marked `last used`, else the first
installed; Up and Down move it, Enter or a click starts that agent, Escape
closes the choice.

## Ids that the agent mints

Claude Code takes the id it is given, so a running session and the
transcript it writes are the same thing from the start. Codex mints its own.
After spawning it the core watches Codex's index for a thread started in the
project since the spawn, for up to thirty seconds, and reports it. Until
then the row has no id: it cannot be resumed and is not yet the app's own,
which only matters if it dies in that window. A Codex row also polls the
index every couple of seconds for its name.

## What is quarantined

Both indexes are the agents' own and move with their versions. Every line
that reads one is kept apart, and every failure there is an empty answer: a
project with no history, never a pane that will not open. Codex leaves an
old index behind when its schema moves; the newest is read.
