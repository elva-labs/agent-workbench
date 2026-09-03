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
| <kbd>Cmd</kbd><kbd>D</kbd> | Open or close the file viewer |
| <kbd>Cmd</kbd><kbd>E</kbd> | Diff or whole file |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>A</kbd> | Changed files or all files |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>T</kbd> | Cycle theme: light, dark, system |

Unbound <kbd>Cmd</kbd> chords are passed through rather than swallowed, so a
future binding is additive and a typo is not silently absorbed.

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
  it there. A pane that owns focus may use it, which is how the file viewer
  closes without a chord. This is the one key whose meaning depends on context,
  which is why `resolveAction` takes the focus state rather than leaving each
  caller to decide: the model stays in one testable place.

## Focus follows the pointer down, not the hover

A pane takes focus on `pointerdown` and on `focusin`, never on hover. Hover focus
in a three-pane layout means typing into whichever pane the mouse drifted over,
which is how a keystroke ends up in the wrong process.

## What focus looks like

The focused pane draws its border and its title in `--accent`. The status bar
names it outright. Once the terminal is real, an unfocused agent pane shows a
hollow cursor, which is the terminal convention and needs no explanation.

## Phase 4 note

When xterm.js lands, `attachCustomKeyEventHandler` consults `resolveAction`: a
non-null result is the app's, and everything else returns `true` and reaches the
PTY. One function, one decision, testable without a DOM.
