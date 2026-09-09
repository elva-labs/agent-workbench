# Layout

Two shapes, one transition, and rules for what gives way when the window is
too small.

## The two shapes

**Working** is three panes: projects and sessions, the agent, the changes.
The agent takes whatever the side panes do not.

**Reviewing** is the changes pane grown into a file viewer, with the sessions
pane folded away. Inside the pane the tree keeps the left column and the
content takes the rest. You enter it by opening a file or with
<kbd>Cmd</kbd><kbd>D</kbd>, and leave it with <kbd>Esc</kbd>, the same chord,
or the control in the viewer's bar.

The viewer is a pane rather than a sheet over the terminal. A sheet traps
focus and hides what you were watching; a pane takes its room from somewhere
real. The tree is the same component in both shapes, so it keeps its scroll
position, open folders and selection across the transition.

Opening a file costs the agent one resize: the pane opens at six tenths of
the window, or wider when it and the sessions pane already came to more, and
the agent gives up the difference. Clicking through files after that reflows
nothing. Drag the viewer's splitter and the
app stops sizing it for you; working and reviewing widths, and the tree
column, are remembered separately.

## What gives way, in order

The agent pane is a character grid, and below a certain width a TUI stops
being usable. It is the last pane to lose room and the only one that can
never be closed.

| Content width | Layout                              |
| ------------- | ----------------------------------- |
| 812 and up    | All three panes                     |
| 626 to 812    | Sessions folds away                 |
| Under 626     | Changes folds away too, agent alone |

The window's minimum width is that 626 plus the frame's padding, which stays
under half of a 1440-wide display so macOS split-screen still accepts the
window. A unit test keeps the window configuration and the layout's numbers
in step.

Within a shape, the changes pane gives width up before the sessions pane.

## Forced is not chosen

A pane can be missing for two reasons, and they are kept apart:

- **chosen**: you pressed the toggle. Persisted.
- **forced**: the window cannot hold it. Transient, never persisted.

Without the distinction, one stint in split-screen would permanently forget
that you like the sessions pane open.

## Hiding is free, resizing is not

Below 932px of content, reviewing hides the agent rather than squeezing it.
The pane keeps its width while hidden, so no pty resize is sent and the
terminal comes back as it was, with nothing redrawn or rewrapped. The agent
pane is hidden rather than unmounted for the same reason; unmounting would
destroy the terminal.

## The terminal panel

Under either shape sits a strip for plain shells, the way an editor keeps a
terminal below the editors. <kbd>Cmd</kbd><kbd>J</kbd> shows and hides it,
<kbd>Cmd</kbd><kbd>4</kbd> focuses it, and opening it gives it focus.
Reviewing neither opens nor closes it, and it keeps its height across both
shapes.

The panel takes its height from the panes above it, one pty resize for the
agent when it opens and one when it closes. It follows the same rules as the
side panes: chosen is remembered and forced is not, it folds away below 366px
of content height and comes back at its height when there is room, hidden
shells keep running, and it never squeezes the panes below 240px or drops
below 120px itself.

Each shell belongs to the project it was opened in and starts there with the
environment the agent gets. A list down the right of the panel names the
active project's shells; switching project switches the list and kills
nothing, and opening the panel on a project with no shell starts one. Typing
`exit` closes the shell, and the project's last shell takes the panel with
it. A shell that dies any other way keeps its place, with its exit code.

Shells come in groups, one group on screen at a time. A new shell is a group
of its own; `split` opens one beside the current shell, in its group, taking
half of that shell's width. The bar between two halves moves the boundary,
never below 200px on either side, and Home makes the group even again.
Closing one half leaves you in the other. Split widths are not persisted,
since shells do not survive a restart. The list's own width is remembered
with the others; below 140px it stops giving way and the shells keep 320px.

## The window's own chrome

On macOS the window has no title bar. The traffic lights sit over the header
of whichever pane is at the left edge, sessions normally, the agent once that
pane is closed or folded, the viewer when reviewing hides the agent too, and
that pane's header is inset so its title clears them. The app places the
buttons on the header's text itself, and since macOS lays the title bar out
again whenever it likes, it listens for the buttons' frames changing and
puts them back each time. The window keeps its plain title bar rather than a
toolbar, because macOS 26 rounds a toolbar window's corners far more than
every other window's. The pane headers are drag regions: grab one to move
the window, double-click to zoom.

On Windows and Linux the window is undecorated and the app draws minimize,
maximize and close at the end of the rightmost pane's header, where the
platform has them. The pane headers are drag regions there too, and the
platform keeps the resize borders. A menu button at the start of the
leftmost header pops the native menu with Settings and Quit in it, since
a menu bar would sit in the row the app took.

## On window resize

Resizing the window resizes the pty, and that is fine: you did it, and the
redraw is the consequence. Two things keep it cheap: columns and rows are
integers, so a few pixels of drag usually crosses no character boundary and
sends nothing; and the frame's content box is what gets measured, not the
window, so padding is never counted as usable width. Scrollback wrapped at
the old width stays wrapped that way, as in every terminal.

The process is told one column fewer than the grid has. A glyph can overhang
its cell to the right, an italic _d_ most of all, and the renderer clips at
the last column; with that column never written, the overhang always has
room.

## The field above the tree

The changes pane's toolbar is a search field. What is typed narrows the tree
to the paths holding every word of it, in any order, with every folder on
the way open. In **lines** mode it is searched for inside the files, and the
hits stand in for the tree: a row per file and a row per hit, the match
marked. A hit opens the file scrolled to the line. Search follows the scope,
changed files or every file the tree lists, runs through `git grep` as a
case-folded fixed string over tracked and untracked files alike, and is cut
at a few hundred hits with a note saying so. Escape clears the field, then
leaves it; Enter searches at once, or opens the first match in files mode;
Down steps into what was found.

Scope, view and reload sit in the menu at the field's end, each with its
chord beside it. <kbd>Cmd</kbd><kbd>F</kbd> puts the keyboard in the field
in files mode when the changes pane has focus, and
<kbd>Shift</kbd><kbd>Cmd</kbd><kbd>F</kbd> in lines mode from anywhere,
opening the pane if it was closed.

## Inside the tree

Folders come before files, then alphabetical. A chain of folders that holds
nothing but one more folder collapses into a single row.

A folder is open by default when something beneath it changed. Widening the
scope on a real repository adds hundreds of paths, and this keeps the
handful the agent touched in view. Opening and closing a folder yourself
records an override, and only where it differs from the default.

The tree is one tab stop, not one per row. Arrow keys move a cursor within
it, <kbd>Left</kbd> and <kbd>Right</kbd> close and open folders or step to
the parent and the first child, and <kbd>Enter</kbd> opens the file under
the cursor. The cursor is drawn separately from the open file, so you can
walk the tree without changing what the viewer shows. Escape, the Esc
button, or a click on the empty part of the tree closes the viewer and
clears the selection together; the keyboard stays in the tree.
