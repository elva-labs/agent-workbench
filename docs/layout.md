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
mode](#editor-mode) has the editing shape's own rules, and
[editor](editor.md) what the editor does.

The viewer is a pane rather than a sheet over the terminal. A sheet traps
focus and hides what you were watching; a pane takes its room from somewhere
real. The tree is the same component in all three shapes, so it keeps its
scroll position, open folders and selection across the transitions.

Opening a file costs the agent one resize: the pane opens at six tenths of
the window, or wider when it and the sessions pane already came to more, and
the agent gives up the difference. Clicking through files after that reflows
nothing. Drag the viewer's divider and the
app stops sizing it for you; working and reviewing widths, and the tree
column, are remembered separately.

## Panes on the ground

The window has a ground, its darkest tone: a step below the background in
light, the background itself in dark. In the modern look the sessions pane,
the pane headers and the status bar lie on it. What the agent, the changes
pane and the terminal panel hold stands on it as a card with rounded
corners under the pane's header. The cards stand 8 pixels apart, and the
same gap in from the window's right edge and its foot. The sessions pane starts at
the window's left edge and the header row at its top, so every header is
one band of ground across the window. The card's top edge stands where a
rule under the header would; the sessions pane's header, over its own list
on the ground, keeps its rule. In light a card lifts off the ground with a
faint shadow. The terminal look keeps its boxes on the ground instead, 6
pixels apart inside the frame's padding, each with its header inside it.
With a background of your own the cards and the boxes can let a little of
it through, as [settings](settings.md#cards) describes.

Every pane header is one height in a look, 40 pixels in the modern look and
35 in the terminal look, the terminal list's top row included, and each
title's line sits in its middle, so the titles stand on one line across the
window whatever a header holds.

Inside a pane, a list beside what is read sits a step from the surface
toward the ground: the tree beside the viewer or the editor, and the
terminal panel's list beside its shells. In a group of shells the ones
without the keyboard sit the same step down. Alone in its pane the tree is
what is read, and keeps the surface.

Where the system asks for more contrast, plain lines come back: each card
takes an outline in the strong rule, a box's border takes it too, the rules
on the ground and the status bar's rule do as well, and each divider inside
a pane draws a line.

## Dividers

The gap between two panes is the divider between them, and nothing is
drawn in it at rest. The pointer takes hold over the gap and 4 pixels into
the pane on either side, where it turns into the resize arrow; a divider
inside a pane, between the tree and the viewer or the shells and their
list, takes no room of its own and takes hold 5 pixels either side of the
seam. Where what lies under that reach wants the pointer itself, a scroll
bar along that edge or a control, the reach on that side gives way to it
and the gap alone takes hold.

As the pointer comes within 24 pixels, a grip in the accent fades in on the
divider, stronger the nearer it is, and follows the pointer along it; on
the divider it stands full. While dragged, and while the divider has the
keyboard, a line in the accent runs its length with the grip on it. A
double-click puts the pane back at its default size. With the keyboard the
arrows move a divider 8 pixels, 24 with <kbd>Shift</kbd>, and
<kbd>Home</kbd> puts it back; the grip then stands at the divider's middle
and the status bar names the keys. Where the divider between two panes
meets the one over the terminal panel, the pointer turns into the four-way
arrow there and drags both, both grips meeting in a T, and a double-click
puts both back. Where the system asks for reduced motion, the grip shows
and goes without fading.

## The corner

The switch and a button that shows and hides the right pane stand at the
end of the rightmost pane's header, so they are in the same place in both
modes whatever the panes under them do. The right pane is the changes pane
in agent mode and the agent while editing; the button and
<kbd>Cmd</kbd><kbd>\\</kbd> show and hide whichever it is, and in a window
too narrow to show it at all the status bar says so. On Windows and Linux
the window controls the app draws come after them, and the right pane's
widths are 60 pixels more in both modes: the changes pane opens at 400 and
never goes below 320, so the corner and the window controls never cover
each other, and the agent opens at 480 while editing. A width dragged by
hand stays as dragged, and a double-click on the divider gives the
default back. Short of room, a header's status gives way before its name,
and goes once it would show no more than a letter or two. The agent's header
gives way in this order: a workflow's name and a session's project and
branch, then the status, then the session's place in the workflow, or the
words of a run's chip, and its title last. Each is cut short and then goes
at a letter or two, its icon or its tag with it. A run's chip keeps its
pips: once its words have gone it stands as the pips alone, the words
taking no room, and the title gives way to them. In editor mode on Windows and Linux the window controls
and the corner leave no room for the place in the workflow beside the
title, so it goes there, and on macOS in the terminal look it is cut a few
letters short. A click on the
corner leaves the keyboard where it was, and neither a click nor Tab moves
the pane focus. The switch is one stop for Tab, walked with the arrows, and
a press from the keyboard that moves the corner to another header keeps the
keyboard on it there.

## The status bar

The status bar is the row along the window's foot. From the left it names
the pane that has the keyboard and the window's mode, then what the session
on screen runs on, its model and its effort, then the account the session
runs under, once accounts are named, with that account's allowance. At the
right end stand how many sessions wait for you and, just before it, a word
in passing, such as a new zoom, so they keep their place whatever the
figures do. With no session on screen only the focus, the mode and those
two remain.

For an integrated session the model and the effort are what the agent last
said it runs on. Each opens a small menu of the choices the agent offers,
the same menu the composer opens for the model, and a choice there changes
the session as it does from the composer. A model the agent offers with no
efforts shows no effort at all; where nothing says which efforts the model
takes, the effort the agent last named shows as plain text. A terminal
session's model is the one
the workbench started it on, as plain text, since the agent owns any change
in its terminal; one started on the agent's own default shows none, and its
effort is not known.

The allowance is the share used of each limit window the agent reported for
the account, as text: `5h 11%  Week 34%  Fable 52%` for the five hour window,
the week, and the week for one model. Only the windows the account has are
drawn, and only once an integrated session on the account has reported
them, as [integrated sessions](integrated.md#account-limits) describes;
nothing is fetched to fill them. The figures belong to the account on its
machine, so a terminal session on the same account shows what an integrated
one reported, and the newest report wins whichever session sent it. A share
is rounded, and reads 100% only when the window is used up.

A window near its end, as the agent reads it, or from 80% used where the
agent gives no reading, takes the theme's warning tone in a heavier weight.
One used up takes the error tone and says when it resets. A window whose
reset time has passed reads as reset until new figures come. Figures older
than fifteen minutes are followed by a small clock and their age. A session
reads them when it is ready and after a turn at most every five minutes, so
figures that old mean no turn on the account has ended in a while. The age
is that of the last full read, since what the agent pushes during a turn
moves only some of the windows.

A click on the allowance opens a popover with every window: a meter, the
share used and when it resets in words, such as `resets in 2 h 10 min` or
`resets Thursday 9:00`, with the account and its plan above and how old
the figures are below. Where some figures moved after the last full read,
it says how old each part is: `Some figures are from just now, the rest
from 20 min ago`. How the bar's menus and the popover take the
keyboard and give it back is in the [focus model](focus-model.md#the-status-bar).

Short of room, the bar lets its parts go in this order: the focus and the
mode, then the word `account:`, then every figure but the one nearest its
end, then that figure's reset time. It measures what fits rather than going
by the window's width, and only after all four are the model and the
account's name cut short. What waits for you is never cut. The word in
passing takes no room in that measure, so nothing gives way for it: where
the space before what waits is shorter than the word, the word is drawn
over the parts before it until it goes.

## What gives way, in order

The agent pane is a character grid, and below a certain width a TUI stops
being usable. It is the last pane to lose room and the only one that can
never be closed.

| Content width, macOS | Windows and Linux | Layout                                        |
| -------------------- | ----------------- | --------------------------------------------- |
| 816 and up           | 876 and up        | All three panes                               |
| 722 to 816           | 746 to 876        | Sessions folds                                |
| Under 722            | Under 746         | Changes folds away too, agent beside the fold |

On macOS the folded column holds the window's buttons and is wider, as
[folded, not gone](#folded-not-gone) says; the figures are the modern
look's, and the terminal look's narrower fold lets the changes pane stay
down to 710. The window's minimum width is the narrow fold's 686 plus the
frame's widest padding, 706, which stays under half of a 1440-wide display
so macOS split-screen still accepts the window. A unit test keeps the
window configuration and the layout's numbers in step. The changes pane
needs 60 pixels more on Windows and Linux and the fold is wider on macOS,
so at the window's minimum the changes pane folds away and the agent
stands beside the fold.

Within a shape, the changes pane gives width up before the sessions pane.
The sessions pane opens 300 pixels wide, room for a session's name beside
its time, and keeps whatever width it is dragged to.

While editing the editor comes before the agent. When the window cannot give
the editor 640 pixels with everything open, the sessions pane folds, forced
and not remembered, and peeks from its column as it does while reviewing.
Then the tree column goes, and then the agent is hidden rather than squeezed
below its minimum. The agent and the tree give way down to their own
minimums before they go. At 1440 wide the sessions pane is folded while
editing; everything is open from a window 1624 wide in the modern look and
1636 in the terminal look, and 60 more on Windows and Linux.

## Folded, not gone

The sessions pane is never gone, only open or folded. Folded on Windows and
Linux, its column is 50 pixels wide. On macOS it is wide enough to hold the
window's three buttons on its own ground with even room on either side, 86
pixels in the modern look and 74 for the terminal look's box, and it keeps
that width in full screen so nothing moves on the way in or out. The pane
keeps every row where it stands when open: each project's name, cut at the
column's edge and without the part of the path that tells two projects of
one name apart, and under it the dots of its sessions, each in its own row,
on macOS with the start of the session's name beside its dot, fading out
at the column's edge. A session's subagents are not rows there but a small
dot each, packed beside its rail where their rows stand, the first always
clear of the fading edge, and told apart by shape as well as colour; see
[subagents on the rail](sessions.md#subagents-on-the-rail). The rest of
the rows keep their height and show nothing, so the dots stay with their
heading and nothing moves when the pane opens again. Its header row is part of the band of ground the headers
lie on, with no rule under it in the modern look, and on Windows and Linux
the menu button stands in it. Between the column and the pane beside it is
the plain gap: there is nothing to drag.

The folded column is one button, and a stop for Tab. A click anywhere on it,
or <kbd>Enter</kbd> on it, opens the pane and gives it the keyboard, and so
does focusing the pane by its key or pressing <kbd>Cmd</kbd><kbd>B</kbd>. In a window too narrow for the pane, the fold is
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
puts the pane back; so does the pointer leaving it, <kbd>Esc</kbd>,
<kbd>Tab</kbd>, or the chord again, and the keyboard then returns to the
viewer. A pane peeked
from the keyboard stays while the pointer wanders.

## Forced is not chosen

A pane can be folded or missing for two reasons, and they are kept apart:

- **chosen**: you pressed the toggle. Persisted.
- **forced**: the window cannot hold it. Transient, never persisted.

Without the distinction, one stint in split-screen would permanently forget
that you like the sessions pane open. The same holds for the tree column and
the agent while editing: hidden by the window, they come back when it grows,
and narrowed by it, they widen again to the width chosen, which a squeeze
never replaces; the agent hidden with its toggle stays hidden until asked
for.

## Hiding is free, resizing is not

Below 986px of content, reviewing hides the agent rather than squeezing it;
on macOS, where the folded column is wider, below 1022 in the modern look and
1010 in the terminal look.
The pane keeps its width while hidden, so no pty resize is sent and the
terminal comes back as it was, with nothing redrawn or rewrapped. The agent
pane is hidden rather than unmounted for the same reason; unmounting would
destroy the terminal.

## What moves

Toggling the sessions pane eases its column between folded and open. What
the pane holds keeps its open width throughout and the column cuts it off,
so no row moves, and the panes beside it widen into the room it leaves, or
narrow to make room as it returns. On macOS the column holds the traffic
lights however far it is open, so the header beside it never moves for
them. Opening and closing the viewer moves the
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

Flipping between agent mode and editor mode puts the panes in another
order, so no column eases into it: the layout lands in a single step, the
agent is told one new size per flip, and none while it is hidden.

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

A shell starts in the project it was opened in, with the environment the
agent gets, and belongs to the session that was on screen when it was
opened, or to the project when no session was, the way a browser tab does.
One the agent's `terminal` tool opens belongs to the agent's session. The
panel shows the shells of the session on screen, or of the project while no
session is on screen: a list down the right names them under a line saying
whose they are, numbered from one for each, and each keeps its own shell in
front. Beside a session, the project's own shells stay listed at the foot,
under a line naming the project, so a dev server started before the first
session is never out of sight: they can be picked and closed like any
other, the session's own come first, and stepping through the shells by
chord stays among the session's own. A session with none of its own shows
the project's newest in front, with None open under its line. Switching
session or project switches the list and kills nothing, and every shell
comes back as it was left, scrollback and all. Opening the panel with no
shell to list starts one, and as the window starts only once the sessions
that were open are back, so it lands beside the session on screen;
switching to a session or project with none leaves the panel saying so,
with a New shell button. Typing `exit` closes the shell, and the last one
listed takes the panel with it. A shell that dies any other way keeps its
place, with its exit code.

Closing a session closes its shells, and closing a project every shell
that started in it. While one of them has something running, either asks
first, in the sessions pane, in the words the window uses before it
closes; see [focus](focus-model.md#closing-what-is-in-front). A session
closed without the user being asked, as when the session that started it
stops it, closes its idle shells and gives a busy one to the project's own,
so what runs in it is never stopped unasked. A session that has only
stopped, and sits as a row, keeps its shells, and a session resumed in its
place takes them over, with their numbers.

The + at the head of the list is New shell: another shell for whoever is on
screen, in a group of its own, with the keyboard in it.
<kbd>Cmd</kbd><kbd>T</kbd> does the same from anywhere in the window,
<kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>T</kbd> on Windows and Linux, and opens
the panel for it when it is closed; the + names the chord the table gives
it. A row's × closes its shell, and
<kbd>Cmd</kbd><kbd>W</kbd> closes the shell in front while the panel has the
keyboard. A shell with something still running in it asks first, as
[focus](focus-model.md#closing-what-is-in-front) describes.

Shells come in groups, one group on screen at a time. A new shell is a group
of its own; `split` opens one beside the current shell, in its group, taking
half of that shell's width. The divider between two halves moves the
boundary, never below 200px on either side, and Home makes the group even
again. The shell without the keyboard sits a step toward the ground, as the
list beside them does.
Closing one half leaves you in the other. Split widths are not persisted,
since shells do not survive a restart. The list's own width is remembered
with the others; below 140px it stops giving way and the shells keep 320px.

## The window's own chrome

On macOS the window has no title bar. The traffic lights sit in the
sessions pane's header row, open or folded: open, its title is inset so it
clears them; folded, the column holds them on the ground. The app measures
that header once the look has painted and again when the look changes, and
places the buttons on its middle; since macOS lays the title bar out again
whenever it likes, it listens for the buttons' frames changing and puts
them back each time. The window keeps its plain title bar rather than a toolbar, because
macOS 26 rounds a toolbar window's corners far more than every other window's.
In full screen macOS keeps the buttons in a bar of its own that shows under
the pointer, and the app places nothing from the start of the way in until
the window is back out. The sessions pane's header keeps no room for the
buttons from the start of the way in to the start of the way out, so its
title sits at the pane's edge like any other; the folded column keeps its
width. The pane headers and the gap beside the folded column are drag
regions: grab one to move the window, double-click to zoom.

On Windows and Linux the window is undecorated and the app draws minimize,
maximize and close at the end of the rightmost pane's header, where the
platform has them, after [the corner](#the-corner): in the modern look flush
in the window's corner, as tall as the header band, and in the terminal look
inside the rightmost box. The pane headers are drag regions there too, and
the platform keeps the resize borders. A menu button at the start of the
sessions pane's header, open or folded, pops the native menu with Settings
and Quit in it, since a menu bar would sit in the row the app took.

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
row per set of files under its caption, opening in the viewer. **Sessions
it started** follows it while the session on screen has started sessions
of its own, may start more without being asked, or has worktrees its
starts left behind: a row for each session, with the controls to stop
them, send them a line and clean up after them; the
[orchestrator](orchestrator.md#in-the-panes) says what they are. It stands
open until folded, and opens by itself when one of them asks for a
permission. **Processes** is
what runs under the session on screen, its shells and the project's own
shells listed beside them, named after the project, or with no session on
screen under the project's own shells: the dev server the agent typed for
you, the test run it started, each with what it runs under, how long it
has run, its share of a CPU and its memory, read every couple of seconds
while the section is open and less often while it is folded. Switching
session switches the list at once. A stop button on the row ends the
process, and nothing outside a session's or a shell's own tree can be
reached from there. **Browser** is the embedded browser's
tabs for the session on screen, one row per tab, standing even with none
open since it is where a tab is opened from; see [browser](browser.md). A
plugin that sends sections adds a fold of its own under those;
[plugins](plugins.md) says what it holds.

The tree's cursor walks on into the sections: <kbd>Down</kbd> past the
last file lands on the first header, <kbd>Enter</kbd> opens a media call
in the viewer, goes to a started session, or folds and unfolds a header,
<kbd>Left</kbd> and <kbd>Right</kbd> fold and unfold the section the cursor
is in as they close and open a folder, and <kbd>End</kbd> is the last row of
the column. Under the started sessions, <kbd>Enter</kbd> on a project they
may be started in takes that back, and on the worktrees left behind asks to
clean them up. On a started session <kbd>Shift</kbd>+<kbd>Enter</kbd> opens
the line to send it and <kbd>Delete</kbd> asks before stopping it, and
<kbd>Delete</kbd> on the section's header asks before stopping them all; a
question or a line to send opened there takes the keyboard, and gives it
back to the tree when it goes. The cursor stays on its row while rows come
and go around it, and a row that goes leaves it on the one that took its
place in the same section. The rows are not tab stops, and a click on one
keeps the keyboard on the tree.

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
rest. The agent's pane on the right opens at 420, wider on Windows and Linux
as [the corner](#the-corner) says. Both widths are dragged at
their edges and remembered apart from the other shapes', and a drag never
folds or hides a pane: it stops where the editor would get less than 640.
The column's header names the project, with the worktree a session follows,
and holds buttons for a new file and a new folder; the editor's header holds
its tabs and the views control, and stays with no file open. Peeked, the
sessions pane covers the folded column and the tree's together. What the
editor does is in [editor](editor.md).
