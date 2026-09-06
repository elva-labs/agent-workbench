# Focus model

## The rule

**The agent pane owns the keyboard.** Every keystroke goes to the agent
unless the app has explicitly reserved it, and the app reserves as little as
it can. The middle pane is a real TUI, not a text field. Claude Code binds
<kbd>Ctrl+C</kbd>, <kbd>Ctrl+R</kbd>, <kbd>Esc</kbd> and
<kbd>Shift+Tab</kbd>, and a shortcut that silently eats one of them turns
into a bug report about the agent.

## What the app claims

Only <kbd>Cmd</kbd> chords (<kbd>Ctrl</kbd> on Windows and Linux). The
default preset:

| Keys | Does |
| --- | --- |
| <kbd>Cmd</kbd><kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> / <kbd>4</kbd> | Focus sessions / agent / changes / terminal |
| <kbd>Cmd</kbd><kbd>B</kbd> | Show or hide the sessions pane |
| <kbd>Cmd</kbd><kbd>\\</kbd> | Show or hide the changes pane |
| <kbd>Cmd</kbd><kbd>J</kbd> | Show or hide the terminal panel |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>↓</kbd> / <kbd>↑</kbd> | Next or previous session, or shell when the panel has focus |
| <kbd>Cmd</kbd><kbd>D</kbd> | Open or close the file viewer |
| <kbd>Cmd</kbd><kbd>E</kbd> | Diff or whole file |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>A</kbd> | Changed files or all files |
| <kbd>Cmd</kbd><kbd>F</kbd> | Filter files, when a list pane has focus |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>F</kbd> | Search in files |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>T</kbd> | Cycle theme: light, dark, system |
| <kbd>Cmd</kbd><kbd>,</kbd> | Open the settings |

Unbound <kbd>Cmd</kbd> chords pass through rather than being swallowed.

## The chords are the user's

Settings, from the native menu or <kbd>Cmd</kbd><kbd>,</kbd>, holds the
whole table: pick a preset, or click a chord and press a new one. The same
dialog holds the appearance (system, light or dark), the colour palette, and
live updates per project. The one rule that does not move is the modifier:
every chord carries <kbd>Cmd</kbd> (<kbd>Ctrl</kbd> elsewhere), because the
keys without it belong to whatever terminal has focus, and <kbd>Ctrl+C</kbd>
and <kbd>Ctrl+R</kbd> are refused outright since on Windows and Linux they
are the agent's. A chord another action holds is refused with the name of
that action.

The **Vim** preset lays movement between panes on <kbd>h</kbd>, <kbd>j</kbd>,
<kbd>k</kbd> and <kbd>l</kbd>, as the panes lie: sessions to the left,
changes to the right, the terminal below, the agent above it. The terminal
panel toggles on <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>J</kbd>, and sessions
step on <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>N</kbd> and <kbd>P</kbd>.

## What the app never claims

- **<kbd>Tab</kbd> does not move focus between panes.** It is completion
  inside the TUI, and <kbd>Shift</kbd><kbd>Tab</kbd> is Claude Code's mode
  switch. Pane focus moves on <kbd>Cmd</kbd><kbd>1/2/3/4</kbd> or a click.
- **<kbd>Ctrl</kbd> chords belong to the agent** on macOS, where the app
  modifier is <kbd>Cmd</kbd>. On Windows and Linux the modifier is
  <kbd>Ctrl</kbd>, so the bound chords are taken from the terminal there,
  and <kbd>Ctrl+C</kbd> and <kbd>Ctrl+R</kbd> are never among them.
- **<kbd>Esc</kbd> belongs to whichever terminal has focus.** The agent
  needs it, and so does a shell in the panel. A pane that owns focus may use
  it: the file viewer closes on it, and a list pane hands the keyboard back
  to the agent. This is the one key whose meaning depends on context, so
  the resolution takes the focus state and lives in one testable place.
- **<kbd>Shift</kbd><kbd>Enter</kbd> is a new line in the agent pane.** The
  terminal would send the same carriage return as for <kbd>Enter</kbd>, so
  the app sends Meta+Enter, which Claude Code takes as a newline. A shell in
  the panel gets the plain return.
- **A click in a terminal is the program's.** Links open on
  <kbd>Cmd</kbd>+click (<kbd>Ctrl</kbd> elsewhere), bare URLs and links the
  program marked up alike. A plain click is left to the TUI.

## Focus follows the pointer down, not the hover

A pane takes focus on pointer down and on focus-in, never on hover. Hover
focus in a three-pane layout means typing into whichever pane the mouse
drifted over.

Focusing a pane by key puts the keyboard where that pane takes it:
<kbd>Cmd</kbd><kbd>2</kbd> lands in the agent's terminal,
<kbd>Cmd</kbd><kbd>4</kbd> in whichever shell of the panel was last used,
and <kbd>Cmd</kbd><kbd>1</kbd> and <kbd>Cmd</kbd><kbd>3</kbd> on the list
panes' own cursors.

## The list panes are one tab stop each

The sessions pane and the file tree are each a single tab stop with a cursor
inside. <kbd>↑</kbd> and <kbd>↓</kbd> move the cursor, <kbd>Home</kbd> and
<kbd>End</kbd> jump, <kbd>Enter</kbd> does what a click on the row does, and
the cursor only shows while the keyboard is in the pane. A click puts the
cursor on what was clicked; focusing the pane by key starts it over from the
session you are in, else your project, or the selected file. Everything in
the sessions pane is on that cursor, the Open project and Remote buttons at
the top included, and <kbd>Delete</kbd> does what the × on a project or
session row does.

Confirming a session moves the keyboard into the agent, so
<kbd>Cmd</kbd><kbd>1</kbd>, <kbd>↓</kbd>, <kbd>Enter</kbd>, type is the whole
flow. The tree opens the file in the viewer and keeps the keyboard, because
the next thing is usually another file.

## What focus looks like

The focused pane draws its border and its title in the accent colour, and
the status bar names it. An unfocused agent pane shows a hollow cursor, the
terminal convention.
