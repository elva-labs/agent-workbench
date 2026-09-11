# Settings

Settings open from the native menu, or with <kbd>Cmd</kbd><kbd>,</kbd>
(<kbd>Ctrl</kbd> on Windows and Linux), over the workbench. Everything in
them is kept by the window and applies at once.

## Appearance

System, light or dark. System follows the desktop and changes with it.

## Colour

Five palettes: teal, indigo, amber, rose and mono. Every colour in the app
comes from a small set of semantic tokens, ink, surface, rule, accent, add,
del, and a palette restates the accent and the cast of the greys for both
appearances while add and del stay what they are. The terminal's sixteen
ANSI colours are derived from the same tokens, so the agent's own interface
sits in the palette rather than beside it.

## Keys

The whole chord table, with two presets and room for your own. What the app
may claim and why is in [focus](focus-model.md).

## Plugins

Sources of plugins, each a git repository or a directory on this machine,
with the plugins each names and a switch per plugin. Adding a source clones
it, pins the commit, reads its manifest and lists its plugins off; turning
one on asks once what it declares and that it runs with your privileges,
then starts it, and the row says whether it is running, starting again
after it went, or could not be started and why. A source is checked for a
newer commit once a day and on request, and updated only when asked.
[Plugins](plugins.md) has the whole of it.

## Live updates

Watcher only, or agent hooks, chosen once for every project; each project
you open follows it, and a project that should go the other way can say so
under it. A fresh install starts with the hooks on; a setup from before the
choice existed starts with them off, and is told once, in a word over the
agent pane, what turning them on gives; the word's link opens the settings
at this section. What each means for the changes pane and for a session's
row is in [sessions](sessions.md); what the hooks write and where, and the
tools they bring the agent, is in [hooks](hooks.md).
