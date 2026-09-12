# Settings

Settings open from the native menu, or with <kbd>Cmd</kbd><kbd>,</kbd>
(<kbd>Ctrl</kbd> on Windows and Linux), over the workbench. Everything in
them is kept by the window and applies at once.

## Appearance

System, light or dark. System follows the desktop and changes with it.

## Theme

Terminal or modern. Terminal is mono chrome, small capitals, square corners
and panes drawn as boxes. Modern sets the chrome in the sans, in sentence
case, with soft corners and the panes as cards on one canvas. Both use the
same colours, so the appearance and the palette hold across either.

## Font

Two families, chosen apart: the one the terminal draws in and the one the
rest of the app is set in. The terminal has IBM Plex Mono, JetBrains Mono
or the machine's own monospace; the interface has IBM Plex Sans, Inter or
the machine's own. Each name is shown in its own face. A change reaches
every open terminal at once, which measures its grid again and tells the
process the size it now has, so there is nothing to restart.

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
with the plugins each names and a switch per plugin, and a check across
every source at the top. What adding, enabling, checking and updating do
is in [plugins](plugins.md).

## Live updates

Watcher only, or agent hooks, chosen once for every project; each project
you open follows it, and a project that should go the other way can say so
under it. A fresh install starts with the hooks on; a setup from before the
choice existed starts with them off, and is told once, in a word over the
agent pane, what turning them on gives; the word's link opens the settings
at this section. What each means for the changes pane and for a session's
row is in [sessions](sessions.md); what the hooks write and where, and the
tools they bring the agent, is in [hooks](hooks.md).
