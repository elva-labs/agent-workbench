# Hooks

Both agents can run commands of the user's at points in a session: when a
tool finishes, when a prompt is sent, when a turn ends, when permission is
asked. The app can install a few of its own, per project, from the settings.
They are off until asked for, because they write into the project's own
agent configuration.

## What is installed

For Claude Code, entries in the project's `.claude/settings.local.json`:
one after every tool use, which writes what the agent just did to a file
the changes pane watches, and one each for prompt submitted, stop and
notification, which append what the agent reported to a session log under
the app's own directory in the user's home.

For Codex, entries in the project's `.codex/hooks.json` for prompt
submitted, stop and permission request, appending to the same log.

Neither file turns up in a diff or as untracked: installing adds both to
the repository's own exclude list, the one git keeps outside the commits,
under `.git/info/exclude`. Claude Code does the same for its local settings
file the first time it writes one; the app does it in case it gets there
first, and for the Codex file, which Codex leaves alone. The two lines stay
in the exclude list when the hooks are turned off, where they do nothing.

## What they give

The changes pane hears the moment a tool finishes, and hears what the agent
did rather than inferring it from the filesystem. A session's row follows
the agent's own word for working, waiting and asking for permission, in
place of the reading off its output. [Sessions](sessions.md) describes both.

The session log holds a line per event and is trimmed once it grows past
half a megabyte; nothing in it is needed after the window has seen it.

## Removing them

Turning hooks off for a project removes the app's entries and nothing else.
A Codex hooks file the app created and emptied is deleted with them. On a
remote project the same is done on that machine.
