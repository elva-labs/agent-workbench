# Hooks

Both agents can run commands of the user's at points in a session: when a
tool finishes, when a prompt is sent, when a turn ends, when permission is
asked. The app can install a few of its own, chosen once in the settings for
every project, with a word for any project that should go the other way.
Each project is brought to that choice as it is opened. A fresh install has
them on; a setup from before the choice keeps them off until asked, since
they write into the project's own agent configuration.

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

## The show and present tools

With the hooks goes a tool for the agent: `show`, offered over MCP by the
daemon, which the app puts on the machine alongside. Called with a file, a
range of lines and a note, it opens the file in the changes pane's viewer,
scrolled to the lines with them highlighted and the note above, in the
project the agent runs in, brought forward if it was not on screen. The
daemon tells the agent when to reach for it as it connects: when the user
asks where something is, or an answer points at a place in a file, once,
for the place being talked about. Claude Code is pointed at the server in
its own per-project state under the user's home; Codex in the project's
`.codex/config.toml`, kept out of the repository like the hooks file. A
machine kind the app has no daemon build for gets the hooks without the
tool.

A reference the agent writes in its answer, `src/lib/a.ts:12`, opens the
same way on a click with the modifier a link takes, with nothing installed.

The second tool, `present`, is for what the agent made or found to look at:
one or more images or PDFs, with a caption. The first opens over the
workbench with the caption, and every file of the call sits beneath it as
a preview, the one on screen marked; the arrow keys and a click move
between them, Escape closes. What was presented stays on the session's
media list, a fold above the file tree in the changes pane, to open again;
the list names the files where they are rather than keeping copies, so one
the agent later removes shows as gone. Files are read where the agent runs,
a remote included, up to eight megabytes each. Video is not among the kinds
taken yet.

## Removing them

Turning hooks off for a project removes the app's entries and nothing else.
A Codex hooks file the app created and emptied is deleted with them. On a
remote project the same is done on that machine.
