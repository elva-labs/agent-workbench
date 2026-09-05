# Focus model

Decided in phase 0, before there was a terminal to argue with. The implementation
lives in `src/lib/keymap.ts`; this is the reasoning behind it.

## The rule

**The agent pane owns the keyboard.** Every keystroke goes to the agent unless
the app has explicitly reserved it, and the app reserves as little as it can.

This is the opposite of the usual desktop default, and it is deliberate. The
middle pane is a real TUI, not a text field. Claude Code binds <kbd>Ctrl+C</kbd>,
<kbd>Ctrl+R</kbd>, <kbd>Esc</kbd> and <kbd>Shift+Tab</kbd>, and a shortcut that
silently eats one of them turns into a bug report about the agent, not about us.

## What the app claims

Only <kbd>Cmd</kbd> chords (<kbd>Ctrl</kbd> on Windows and Linux). Nothing else.

| Keys | Does |
| --- | --- |
| <kbd>Cmd</kbd><kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> / <kbd>4</kbd> | Focus sessions / agent / changes / terminal |
| <kbd>Cmd</kbd><kbd>B</kbd> | Toggle the sessions pane |
| <kbd>Cmd</kbd><kbd>\\</kbd> | Toggle the changes pane |
| <kbd>Cmd</kbd><kbd>J</kbd> | Show or hide the terminal panel |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>↓</kbd> / <kbd>↑</kbd> | Next or previous session, or shell when the panel has focus |
| <kbd>Cmd</kbd><kbd>D</kbd> | Open or close the file viewer |
| <kbd>Cmd</kbd><kbd>E</kbd> | Diff or whole file |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>A</kbd> | Changed files or all files |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>T</kbd> | Cycle theme: light, dark, system |

| <kbd>Cmd</kbd><kbd>,</kbd> | Open the settings |

Unbound <kbd>Cmd</kbd> chords are passed through rather than swallowed, so a
future binding is additive and a typo is not silently absorbed.

## The chords are the user's

The table above is the default preset. Settings, reached from the native menu
or <kbd>Cmd</kbd><kbd>,</kbd>, holds the whole table: pick a preset, or click
a chord and press a new one. The same dialog holds the appearance (system,
light or dark) and the colour palette: teal, which `tokens.css` is written in,
or one of the others in `palettes.css`, each restating the accent and the cast
of the greys for both appearances while add and del stay what they are. The one rule that does not move is the modifier:
every chord carries <kbd>Cmd</kbd> (<kbd>Ctrl</kbd> elsewhere), because the
keys without it belong to whatever terminal has focus, and <kbd>Ctrl+C</kbd>
and <kbd>Ctrl+R</kbd> are refused outright since on Windows and Linux they
are the agent's. A chord another action holds is refused with the name of that
action, rather than taken from it. The table is kept under `workbench.keys`
and the status bar spells whatever it holds.

The **Vim** preset lays movement between panes on <kbd>h</kbd>, <kbd>j</kbd>,
<kbd>k</kbd> and <kbd>l</kbd>, as the panes lie: sessions to the left, changes
to the right, the terminal below, the agent above it. The terminal panel
toggles on <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>J</kbd>, and sessions step on
<kbd>Shift</kbd><kbd>Cmd</kbd><kbd>N</kbd> and <kbd>P</kbd>. The model in
`src/lib/keys.svelte.ts`; the dialog in `src/lib/components/Settings.svelte`.

## What the app never claims

- **<kbd>Tab</kbd> does not move focus between panes.** It is completion inside
  the TUI, and <kbd>Shift</kbd><kbd>Tab</kbd> is Claude Code's mode switch. Pane
  focus moves on <kbd>Cmd</kbd><kbd>1/2/3/4</kbd> or a click, and nothing else.
- **<kbd>Ctrl</kbd> chords belong to the agent** on macOS, where the app
  modifier is <kbd>Cmd</kbd>. On Windows and Linux the modifier is
  <kbd>Ctrl</kbd>, so the handful of bound chords (<kbd>Ctrl</kbd><kbd>1/2/3/4</kbd>,
  <kbd>B</kbd>, <kbd>D</kbd>, <kbd>E</kbd>, <kbd>J</kbd>, <kbd>\</kbd>) are
  taken from the terminal there. <kbd>Ctrl+C</kbd> and <kbd>Ctrl+R</kbd> are
  never bound, so interrupting and history search always reach the agent.
- **<kbd>Esc</kbd> belongs to whichever terminal has focus.** The agent needs
  it, and so does a shell in the terminal panel: `vi` and `less` are waiting for
  it there. A pane that owns focus may use it: the file viewer closes on it,
  and a list pane hands the keyboard back to the agent, so a look at the side
  panes ends where typing resumes. This is the one key whose meaning depends
  on context, which is why `resolveAction` takes the focus state rather than
  leaving each caller to decide: the model stays in one testable place.
- **<kbd>Shift</kbd><kbd>Enter</kbd> is a new line in the agent pane.** xterm
  would send the same carriage return for it as for <kbd>Enter</kbd>, which
  is a send. The app sends Meta+Enter instead, which Claude Code takes as a
  newline without any terminal setup on its side. A shell in the panel gets
  the plain return.
- **A click in a terminal is the program's.** Links open on
  <kbd>Cmd</kbd>+click (<kbd>Ctrl</kbd> elsewhere), both bare URLs in the
  output and links the program marked up with OSC 8. A plain click is left to
  the TUI, which may be using the mouse.

## Focus follows the pointer down, not the hover

A pane takes focus on `pointerdown` and on `focusin`, never on hover. Hover focus
in a three-pane layout means typing into whichever pane the mouse drifted over,
which is how a keystroke ends up in the wrong process.

Focusing a pane by key puts the keyboard where that pane takes it, not just
on the pane: <kbd>Cmd</kbd><kbd>2</kbd> lands in the agent's terminal,
<kbd>Cmd</kbd><kbd>4</kbd> in whichever shell of the panel was last used, and
<kbd>Cmd</kbd><kbd>1</kbd> and <kbd>Cmd</kbd><kbd>3</kbd> on the list panes'
own cursors. With a split on screen, clicking a half or its row in the list is
what picks it.

## The list panes are one tab stop each

The sessions pane and the file tree follow the same pattern: the pane is a
single tab stop with a cursor inside it. <kbd>↑</kbd> and <kbd>↓</kbd> move the
cursor, <kbd>Home</kbd> and <kbd>End</kbd> jump, <kbd>Enter</kbd> does what a
click on the row does, and the cursor only shows while the keyboard is in the
pane. A click puts the cursor on what was clicked; focusing the pane by key
starts it over from the session you are in, or the selected file.

Confirming a session, a past session or a new one moves the keyboard into the
agent, so <kbd>Cmd</kbd><kbd>1</kbd>, <kbd>↓</kbd>, <kbd>Enter</kbd>, type is
the whole flow. The tree opens the file in the viewer and keeps the keyboard,
because the next thing is usually another file.

## What focus looks like

The focused pane draws its border and its title in `--accent`. The status bar
names it outright. Once the terminal is real, an unfocused agent pane shows a
hollow cursor, which is the terminal convention and needs no explanation.

## Phase 4 note

When xterm.js lands, `attachCustomKeyEventHandler` consults `resolveAction`: a
non-null result is the app's, and everything else returns `true` and reaches the
PTY. One function, one decision, testable without a DOM.
