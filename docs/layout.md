# Layout

Three shapes, the transitions between them, and rules for what gives way
when the window is too small.

## The three shapes

**Working** is three panes: projects and sessions, the agent, the changes.
The agent takes whatever the side panes do not.

**Reviewing** is the changes pane grown into a file viewer, with the sessions
pane folded. Inside the pane the tree keeps the left column and the
content takes the rest. You enter it by opening a file or with
<kbd>Cmd</kbd><kbd>D</kbd>, and leave it with <kbd>Esc</kbd>, the same chord,
or the control in the viewer's bar.

**Editing** is the window's other mode: the file tree and a plain text
editor take the middle, and the agent moves to the right pane and keeps
running. A two-part switch, Agent and Editor, flips between working and
editing, and so does <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>E</kbd> or the
command palette. The mode belongs to the window and is remembered across a
restart. Reviewing stays what it is in agent mode; [editor
mode](#editor-mode) has the editing shape's own rules.

The viewer is a pane rather than a sheet over the terminal. A sheet traps
focus and hides what you were watching; a pane takes its room from somewhere
real. The tree is the same component in all three shapes, so it keeps its
scroll position, open folders and selection across the transitions.

Opening a file costs the agent one resize: the pane opens at six tenths of
the window, or wider when it and the sessions pane already came to more, and
the agent gives up the difference. Clicking through files after that reflows
nothing. Drag the viewer's splitter and the
app stops sizing it for you; working and reviewing widths, and the tree
column, are remembered separately.

## The corner

The switch and a button that shows and hides the right pane stand at the
end of the rightmost pane's header, so they are in the same place in both
modes whatever the panes under them do. The right pane is the changes pane
in agent mode and the agent while editing; the button and
<kbd>Cmd</kbd><kbd>\\</kbd> show and hide whichever it is. On Windows and
Linux the window controls the app draws come after them. Pressing either
leaves the keyboard where it was.

## What gives way, in order

The agent pane is a character grid, and below a certain width a TUI stops
being usable. It is the last pane to lose room and the only one that can
never be closed.

| Content width | Layout                                        |
| ------------- | --------------------------------------------- |
| 812 and up    | All three panes                               |
| 682 to 812    | Sessions folds                                |
| Under 682     | Changes folds away too, agent beside the fold |

The window's minimum width is that 682 plus the frame's padding, which stays
under half of a 1440-wide display so macOS split-screen still accepts the
window. A unit test keeps the window configuration and the layout's numbers
in step.

Within a shape, the changes pane gives width up before the sessions pane.

While editing the editor comes before the agent. When the window cannot give
the editor 640 pixels with everything open, the sessions pane folds, forced
and not remembered, and peeks from its column as it does while reviewing.
Then the tree column goes, and then the agent is hidden rather than squeezed
below its minimum. The agent and the tree give way down to their own
minimums before they go. At 1440 wide the sessions pane is folded while
editing; at 1728 everything is open.

## Folded, not gone

The sessions pane is never gone, only open or folded. Folded, its column is
50 pixels wide and the pane keeps every row where it stands when open: each
project's name, cut at the column's edge, and under it the dots of its
sessions, each in its own row. Listed by status, it is each group's name
that is cut, with the dots under it. The rest of the rows keep their height
and show nothing, so the dots stay with their heading and nothing moves
when the pane opens again. Its header joins the header beside it into one row, and
the line down the column's edge starts under that row.

The folded column is one button. A click anywhere on it opens the pane and
gives it the keyboard, and so does focusing the pane by its key or pressing
<kbd>Cmd</kbd><kbd>B</kbd>. In a window too narrow for the pane, the fold is
all there is and there is nothing to open.

Reviewing folds the pane as part of its shape, so opening it for real there
closes the viewer, which is what <kbd>Cmd</kbd><kbd>B</kbd> still does.
Editing folds it only in a window too narrow for it beside the editor, and
there the column peeks it the same way, <kbd>Cmd</kbd><kbd>B</kbd> included,
since there is nowhere to open it into.
Instead the pane peeks: the pointer resting on the column, a click on it,
or <kbd>Cmd</kbd><kbd>1</kbd> draws the pane at its open width over the
agent pane, with the column, the viewer and the agent exactly where they
were and nothing resized. Every row is where it stands in the column, so
the dots do not move and the names appear beside them. Picking a session
puts the pane back; so does the pointer leaving it, <kbd>Esc</kbd>, or the
chord again, and the keyboard then returns to the viewer. A pane peeked
from the keyboard stays while the pointer wanders.

## Forced is not chosen

A pane can be folded or missing for two reasons, and they are kept apart:

- **chosen**: you pressed the toggle. Persisted.
- **forced**: the window cannot hold it. Transient, never persisted.

Without the distinction, one stint in split-screen would permanently forget
that you like the sessions pane open. The same holds for the tree column and
the agent while editing: hidden by the window, they come back when it grows;
the agent hidden with its toggle stays hidden until asked for.

## Hiding is free, resizing is not

Below 988px of content, reviewing hides the agent rather than squeezing it.
The pane keeps its width while hidden, so no pty resize is sent and the
terminal comes back as it was, with nothing redrawn or rewrapped. The agent
pane is hidden rather than unmounted for the same reason; unmounting would
destroy the terminal.

## What moves

Toggling the sessions pane eases its column between folded and open. What
the pane holds keeps its open width throughout and the column cuts it off,
so no row moves, and the panes beside it widen into the room it leaves, or
narrow to make room as it returns. The header beside the column keeps its
title clear of the traffic lights by whatever the column leaves short of
them, so the title stands still. Opening and closing the viewer moves the
same way: the sessions column eases folded or open while the changes column
eases to its new width on the same curve, so the agent between them moves
steadily from its old width to its new one and never below its minimum. When
the pane folds because the window is too narrow for it, its column folds at
once.

A terminal whose pane is widening or narrowing keeps the size it had until
the column arrives, then is measured once. The agent is told one new size per
toggle rather than one per frame, and does not redraw at every width in
between. While the column moves, the terminal's grid is either short of its
pane's new edge or clipped by it.

The terminal panel eases up and down the same way, and the panes above it
give up and take back the height as it goes. The panel keeps its own height
inside and is cut off at the window's foot while it moves, so it slides
rather than squeezes, and its shells are measured once it arrives. In the
sessions pane a row that goes fades where it stands, and the rows below it
close the gap rather than jump into it; a row that arrives fades in.

Flipping between agent mode and editor mode moves every pane at once, so it
is drawn as one movement rather than column by column: the panes travel from
where they were to where they go. The layout changes in a single step under
it, so the agent is told one new size per flip, and none while it is hidden.

None of this happens when the system asks for reduced motion. Panes and rows
are then simply where they end up.

## The terminal panel

Under every shape sits a strip for plain shells, the way an editor keeps a
terminal below the editors. <kbd>Cmd</kbd><kbd>J</kbd> shows and hides it,
<kbd>Cmd</kbd><kbd>4</kbd> focuses it, and opening it gives it focus.
Reviewing and editing neither open nor close it, and it keeps its height
across the shapes.

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
pane is closed or folded, the viewer when reviewing hides the agent too, the
files pane while editing once the sessions pane folds, and that pane's
header is inset so its title clears them. The app measures that
header once the look has painted and again when the look changes, and places
the buttons on its middle; since macOS lays the title bar out again whenever
it likes, it listens for the buttons' frames changing and puts them back each
time. The window keeps its plain title bar rather than a toolbar, because
macOS 26 rounds a toolbar window's corners far more than every other window's.
In full screen macOS keeps the buttons in a bar of its own that shows under
the pointer, and the app places nothing from the start of the way in until
the window is back out. The headers keep no room for the buttons from the
start of the way in to the start of the way out, so the leftmost title sits
at the pane's edge like any other.
The pane headers are drag regions: grab one to move the window, double-click
to zoom.

On Windows and Linux the window is undecorated and the app draws minimize,
maximize and close at the end of the rightmost pane's header, where the
platform has them, after [the corner](#the-corner). The pane headers are drag regions there too, and the
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

The process is told the same size as the grid xterm draws. A shell wraps a
long line where it believes the right edge is and redraws on that belief, so
any other width garbles what it shows.

## Zoom

<kbd>Cmd</kbd><kbd>=</kbd> and <kbd>Cmd</kbd><kbd>-</kbd> make the text of
the terminal the keyboard is in a pixel larger or smaller, from 8 to 24,
and <kbd>Cmd</kbd><kbd>0</kbd> puts it back at 12. That terminal is the
panel's shell when the panel has the keyboard, and the agent on screen
otherwise. On a keyboard where = needs Shift, or where + has a key of its
own, <kbd>Cmd</kbd> with either zooms in as well.

While the editor has the keyboard the same chords step its text, over the
same range, and its size is kept in the window's storage.

Each terminal has its own size. A larger size fits fewer rows and columns,
so the terminal measures its grid again and tells the process, as a change
of [font](settings.md#font) does. The status bar names the new size.
An agent session's size stays with the session, so resuming it, or a
restart, brings it back at that size. A shell's lasts as long as the
shell. The sizes are kept in the window's own storage, not in the settings
file.

## The field above the tree

The changes pane's toolbar is a search field, across the pane, or at the
top of the tree's column in editor mode. What is typed narrows the tree
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

## Under the tree

Sections sit at the bottom of the tree's column, each folded to its header
until asked, with a count in the header when there is anything to count, and
a divider to drag above them when one is open; the share and the folds are
remembered, and the open ones share the height.

**Media** is what the agent has presented for the session on screen, one
row per set of files under its caption, opening in the viewer. **Processes** is
what runs under the project's sessions and shells: the dev server the agent
typed for you, the test run it started, each with what it runs under, how
long it has run, its share of a CPU and its memory, read every couple of
seconds while the section is open and less often while it is folded. A
stop button on the row ends the process, and nothing outside a session's
own tree can be reached from there. **Browser** is the embedded browser's
tabs for the session on screen, one row per tab, standing even with none
open since it is where a tab is opened from; see [browser](browser.md). A
plugin that sends sections adds a fold of its own under those three;
[plugins](plugins.md) says what it holds.

The tree's cursor walks on into the sections: <kbd>Down</kbd> past the
last file lands on the first header, <kbd>Enter</kbd> opens a media call
in the viewer or folds and unfolds a header, <kbd>Left</kbd> and
<kbd>Right</kbd> fold and unfold the section the cursor is in as they close
and open a folder, and <kbd>End</kbd> is the last row of the column. The
rows are not tab stops, and a click on one keeps the keyboard on the
tree.

## Inside the viewer

A file opens as its diff or as it is, with a line or a range a tool pointed
at highlighted and the tool's note above. A Markdown document has a third
view, rendered as a reader sees it, which it opens on when it has no diff;
the view chord walks the views a file has, round and round. An image or a
PDF git calls binary is shown as the picture it is, read where it is and
read again when it changes there, whether or not git would notice; any
other binary file says so. Lines selected with the mouse
stay marked once the keyboard has moved on, to the agent above all, so they
are still the answer to "this" while the question is typed; a click in the
viewer lets them go, and the line numbers are never part of a selection.
What the agent presented opens in the same place, every file of the call
down the viewer. The embedded browser takes the same place again, in place
of a file or what was presented; [browser](browser.md) has what it shows
there.

What the viewer holds belongs to the session on screen. Switching to
another session shows what that one had, the file at its place, what was
presented, a plugin's page or the browser, and closes the viewer for a
session that had nothing in it. Coming back to a session finds its viewer
as it was left, open again if it had been closed in the meantime, with the
keyboard where picking the session put it. A viewer closed with
<kbd>Esc</kbd> is closed for its session too; one that opening the sessions
pane closed is not, since the pane is opened to pick a session rather than
to put the document away, so switching away and back finds it open. This
holds across projects and worktrees: a session working in a worktree, or
in another project, gets its document back although the switch gave the
changes pane a different tree to list.

## Editor mode

The changes pane becomes the files pane: the tree keeps a column on the
left, 240 pixels to begin with, and lists every file; the editor takes the
rest. The agent's pane on the right opens at 420. Both widths are dragged at
their edges and remembered apart from the other shapes', and a drag never
folds or hides a pane: it stops where the editor would get less than 640.
The column's header names the project, with the worktree a session follows,
and holds buttons for a new file and a new folder; the editor's header holds
its tabs and the views control.

### The editor

A plain editor: line numbers, the line the cursor is on, undo, find in the
file, and at the foot the line and column, what the file is written in and
whether it is saved. Nothing completes or highlights. It is drawn in the
terminal's [font](settings.md#font) and the look's colours, at a size of its
own that the zoom chords step while it has the keyboard.

Files open as tabs. A file only looked at, clicked in the tree or pointed at
by a tool, reuses one tab drawn in italics until it is edited or the tab is
double-clicked. Each session keeps its own tabs, as it keeps its viewer, and
a file open beside two sessions is one buffer, so an edit made beside one is
there beside the other. Middle-click or the tab's × closes it.

The views stay: Edit, Diff when git changed the file, and Preview for
Markdown, walked with the view chord. Diff and Preview are read only and are
drawn as the viewer draws them. A file that is binary, not UTF-8 or larger
than 4 MB says so and shows as the viewer shows it.

### Saving

Nothing is written until <kbd>Cmd</kbd><kbd>S</kbd>. Until then the tab and
the file's row in the tree carry a dot. A save sends what the file held when
the editor read it, and the core writes only while the disk still holds that.
Reading and writing go through the core, so a project on another machine is
edited where it is, and a write that fails part way leaves the old file
whole.

A file that changes on disk is read in at once when the editor has no
unsaved edits for it, replacing only what differs so the cursor and the
scroll hold. Under unsaved edits a bar over the editor says the file changed
on disk, without naming who changed it, and offers Compare, which shows the
disk's version against the editor's, Keep mine, which writes the editor's
over it, and Load from disk, which drops the edits for it as one change that
undo can take back. A save never writes over the change silently.

Closing a tab with unsaved edits asks first, with Save and close beside
Close without saving. So does the close button the app draws on Windows and
Linux. The window's own close and quit, from the system or its menu, do not
ask.

### New files and the row menu

A new file is named in a field in place in the tree, in the folder the
tree's cursor is in, from the button over the tree, the row menu or
<kbd>Alt</kbd><kbd>Cmd</kbd><kbd>N</kbd>, which flips to the editor from
agent mode. Enter makes the file and opens it, Escape drops the field, and
slashes in the name make the folders on the way. A name that cannot be used
says why under the field. The tree lists what git lists and git lists no
empty folder, so naming a new folder shows it open in the tree with a field
for its first file, and the folder is made with that file; Escape drops
both.

A right-click on a row opens a menu: New file, New folder, Rename, Delete,
Copy path, which copies the path from the project's root, and Reveal in
Finder, Show in Explorer or Show in file manager, for a project on this
machine. Rename puts the field over the row, and the tabs on what was
renamed follow it. Delete asks first and says what goes, every file in a
folder, and deletes from the disk rather than moving to the trash.

### Between the two modes

In agent mode a file still opens in the viewer without moving the agent,
and the viewer's bar has an Edit button that flips to the editor at the file
and the line it shows. Flipping to the editor from the viewer brings the file
along at its place. In editor mode what a tool points at opens in the
editor's place: a file as a tab at its line, with what the tool said above
it, a diff as that tab's Diff view, and what was presented, a plugin's page
or the browser where the viewer shows them, until its Esc or Escape gives the
editor back. Flipping back to agent mode shows that in the viewer, or puts
the agent in the middle with the changes beside it.
