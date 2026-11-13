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

| Keys                                                                    | Does                                                        |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| <kbd>Cmd</kbd><kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> / <kbd>4</kbd> | Focus sessions / agent / changes / terminal; while reviewing, <kbd>Cmd</kbd><kbd>1</kbd> peeks the sessions pane over the agent and puts it back |
| <kbd>Cmd</kbd><kbd>B</kbd>                                              | Show or hide the sessions pane                              |
| <kbd>Cmd</kbd><kbd>\\</kbd>                                             | Show or hide the changes pane                               |
| <kbd>Cmd</kbd><kbd>J</kbd>                                              | Show or hide the terminal panel                             |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>↓</kbd> / <kbd>↑</kbd>               | Next or previous session, or shell when the panel has focus |
| <kbd>Cmd</kbd><kbd>.</kbd>                                              | Go to the next session that needs you                       |
| <kbd>Cmd</kbd><kbd>D</kbd>                                              | Open or close the file viewer                               |
| <kbd>Cmd</kbd><kbd>E</kbd>                                              | Diff, whole file or rendered                                |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>A</kbd>                              | Changed files or all files                                  |
| <kbd>Cmd</kbd><kbd>F</kbd>                                              | Filter files, when a list pane has focus                    |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>F</kbd>                              | Search in files                                             |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>T</kbd>                              | Cycle theme: light, dark, system                            |
| <kbd>Cmd</kbd><kbd>=</kbd> / <kbd>-</kbd> / <kbd>0</kbd>                | Zoom the terminal that has focus in, out, or back           |
| <kbd>Cmd</kbd><kbd>P</kbd>                                              | Go to a session or project                                  |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>P</kbd>                              | Open the command palette                                    |
| <kbd>Cmd</kbd><kbd>,</kbd>                                              | Open the settings                                           |

Unbound <kbd>Cmd</kbd> chords pass through rather than being swallowed.

## The chords are the user's

Settings, from the native menu or <kbd>Cmd</kbd><kbd>,</kbd>, holds the whole
table: pick a preset, or click a chord and press a new one. The keys are one
tab of it; the appearance and the look, the fonts and the colours, live
updates and plugins are the others, in [settings](settings.md). The one rule
that does not move is the modifier: every chord carries <kbd>Cmd</kbd>
(<kbd>Ctrl</kbd> elsewhere), because the keys without it belong to whatever
terminal has focus, and <kbd>Ctrl+C</kbd> and <kbd>Ctrl+R</kbd> are refused
outright since on Windows and Linux they are the agent's. A chord another
action holds is refused with the name of that action.

The **Vim** preset lays movement between panes on <kbd>h</kbd>, <kbd>j</kbd>,
<kbd>k</kbd> and <kbd>l</kbd>, as the panes lie: sessions to the left,
changes to the right, the terminal below, the agent above it. The terminal
panel toggles on <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>J</kbd>, and sessions
step on <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>N</kbd> and <kbd>P</kbd>. The command
palette opens on <kbd>Cmd</kbd><kbd>;</kbd> there, since
<kbd>Shift</kbd><kbd>Cmd</kbd><kbd>P</kbd> steps sessions. Going to a session
or project stays on <kbd>Cmd</kbd><kbd>P</kbd>.

## The palettes

Two lists share one field over the workbench. What is typed narrows the
list to the entries holding every word of it, in any order, as
[the tree's filter](layout.md#the-field-above-the-tree) does.
<kbd>Up</kbd> and <kbd>Down</kbd> move the cursor and <kbd>Enter</kbd>
picks. The cursor starts on the first entry that can be picked, and stays on
the same entry while sessions change state and move under it.

**Go to** opens on <kbd>Cmd</kbd><kbd>P</kbd> and lists the sessions, then
the projects. A session matches on its name or on the label of its project.
Sessions are listed by when they last changed, the latest first, each with a
dot for its state, its project and the time since. Every open project is
listed, with how many sessions are live in it or the time since it was last
used, the most recently used first. <kbd>Enter</kbd> on a session shows it and
puts the keyboard in its agent, as a click on its row does. On a project it
brings the project forward, with the keyboard in the session on screen or, for
a project with none, in the sessions pane. A sessions pane that is folded
opens for that, or peeks over the agent while reviewing, so the viewer stays,
and in a window too narrow for the pane the keyboard stays with the agent.
<kbd>Cmd</kbd><kbd>Enter</kbd> on either starts a session in that project, as
below. A <kbd>&gt;</kbd> typed as the first character switches to the
commands, with the rest of what was typed.

**Commands** open on <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>P</kbd> and list every
action the keys can do, each with its chord, and the ones that have none: new
session, new session in the project on screen, open project and open remote
project. Picking an action does what its chord does. The first entry goes to
the next session that needs you, as <kbd>Cmd</kbd><kbd>.</kbd> does (see
[sessions](sessions.md)). It shows how many are waiting, and with none it
cannot be picked.

**A new session** is asked for in the same field, a step at a time. First the
project, unless only one is open: the one on screen above the others, then by
when they were last used. Then the account, when accounts are named in the
[settings](settings.md#accounts), with the project's own under the cursor;
then the agent, when more than one is installed, with the one last started in
the project under the cursor. A step with nothing to choose is not asked.
Each answer stays in the field as a chip, and <kbd>Backspace</kbd> on an empty
field takes the last one back, one step to a press however long the key is
held; from the first step it returns to the commands. The last answer brings
the project forward and starts the session the way the new-session row of the
sessions pane does, and the keyboard goes to the new agent.

<kbd>Escape</kbd> puts the palette away from any step, and so does the chord
of the list that is up: <kbd>Cmd</kbd><kbd>P</kbd> for go to,
<kbd>Shift</kbd><kbd>Cmd</kbd><kbd>P</kbd> for the commands and a new session.
The other chord switches to its list. The keyboard goes back where it was.
While the palette is up it has the keyboard and no other chord reaches past
it, except that Settings opened from the app's menu puts the palette away
first.

While a dialog, or a question over the agent pane, is up, neither chord opens
a palette and <kbd>Cmd</kbd><kbd>.</kbd> does nothing, so the keyboard stays
where the dialog has it.

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
  it: the file viewer closes on it and leaves the keyboard in the tree, and
  a list pane hands the keyboard back to the agent. This is the one key whose meaning depends on context, so
  the resolution takes the focus state and lives in one testable place.
- **<kbd>Shift</kbd><kbd>Enter</kbd> is a new line in the agent pane.** The
  terminal would send the same carriage return as for <kbd>Enter</kbd>, so
  the app sends Meta+Enter, which Claude Code takes as a newline. A shell in
  the panel gets the plain return.
- **A click in a terminal is the program's.** Links open on
  <kbd>Cmd</kbd>+click (<kbd>Ctrl</kbd> elsewhere), bare URLs and links the
  program marked up alike. A plain click is left to the TUI.

## A page in the browser

A page shown in the embedded browser is a native view of its own, not part
of the app's page, and once a person clicks into it the keyboard is the
page's: every key reaches it, the same as a real browser tab. The app takes
back only what it always takes back, Escape and its own chords, and lets
the rest through untouched, Cmd+C and Cmd+V among them. Clicking into a
page counts as focusing the changes pane, since that is where the tab
lives, but it does not pull the keyboard there the way pressing
Cmd+3 would: the page keeps it until Escape or a chord takes it back. Linux
does the same with Ctrl in Cmd's place; on Windows a page keeps every key.

## Focus follows the pointer down, not the hover

A pane takes focus on pointer down and on focus-in, never on hover. Hover
focus in a three-pane layout means typing into whichever pane the mouse
drifted over.

Focusing a pane by key puts the keyboard where that pane takes it:
<kbd>Cmd</kbd><kbd>2</kbd> lands in the agent's terminal,
<kbd>Cmd</kbd><kbd>4</kbd> in whichever shell of the panel was last used,
and <kbd>Cmd</kbd><kbd>1</kbd> and <kbd>Cmd</kbd><kbd>3</kbd> on the list
panes' own cursors.

A dialog, the settings, the remote picker or the sessions to resume, holds
the keyboard while it is up. When it closes, the pane that had the keyboard
takes it back where it was: the cursor in a list pane stays on its row, and
typing goes into the terminal again without a click.

## The list panes are one tab stop each

The sessions pane and the file tree are each a single tab stop with a cursor
inside. <kbd>↑</kbd> and <kbd>↓</kbd> move the cursor, <kbd>Home</kbd> and
<kbd>End</kbd> jump, <kbd>Enter</kbd> does what a click on the row does, and
the cursor only shows while the keyboard is in the pane. A click puts the
cursor on what was clicked; focusing the pane by key starts it over from the
session you are in, else your project, or the selected file. Everything in
the sessions pane is on that cursor, the Open project button and the menu
beside it at the top included, and <kbd>Delete</kbd> does what the × on a
project or session row does, except on a session another session started,
which only its own × stops.

Confirming a session moves the keyboard into the agent, so
<kbd>Cmd</kbd><kbd>1</kbd>, <kbd>↓</kbd>, <kbd>Enter</kbd>, type is the whole
flow. The tree opens the file in the viewer and keeps the keyboard, because
the next thing is usually another file.

## What focus looks like

The focused pane is marked in the accent, its title with it, and the status
bar names it; which part of the pane carries the mark is the look's, in
[settings](settings.md#theme). An unfocused agent pane shows a hollow cursor,
the terminal convention.