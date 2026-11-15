# The editor

Editor mode puts the file tree and a plain text editor in the middle of the
window and moves the agent to the right pane, where it keeps running. The
switch at the end of the rightmost header flips between agent mode and
editor mode, and so does <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>E</kbd> or the
command palette. The mode belongs to the window and is remembered across a
restart. [Layout](layout.md#editor-mode) has the shape and what gives way
when the window is narrow; [focus](focus-model.md#the-editor) has the
keyboard.

## Tabs

Files open as tabs heading the editor's column. A file only looked at,
clicked in the tree or pointed at by a tool, reuses one tab drawn in italics
until it is edited or the tab is double-clicked; a double-click on a file in
the tree keeps its tab too. The file a tool pointed at opens at its line,
the range selected, with what the tool said in a bar above until the file is
edited.

Each session keeps its own tabs, as it keeps its viewer, and switching
sessions shows the tabs that session had. A file open beside two sessions is
one buffer, so an edit made beside one is there beside the other.

The tab in front is always in view and keeps its whole name. The others
show their close button only under the pointer and narrow before the row
overflows, no further than a short name; past that the row scrolls, and an
edge with tabs past it fades. The × on a tab, a middle-click, Close
Tab in the File menu or <kbd>Cmd</kbd><kbd>W</kbd> closes it, and the tab
beside it comes to the front.

## The editor

A plain editor: line numbers, the line the cursor is on, undo, and find in
the file, and nothing that completes or highlights. It is drawn in the
terminal's [font](settings.md#font) and the look's colours, at a size of its
own that the zoom chords step while it has the keyboard, kept in the
window's storage.

Find opens a bar over the editor: the text, how many matches it has,
Previous, Next and All, and whether case, whole words or a regular
expression count. <kbd>Enter</kbd> goes to the next match,
<kbd>Shift</kbd><kbd>Enter</kbd> to the one before, and <kbd>Esc</kbd>
closes the bar. There is nothing to replace with. The matches are counted
as the text is typed, and once typing pauses in a large file or in the file
itself.

The foot has the line and column, what the file is written in by its name,
and whether it is saved.

## The views

Edit, Diff when git changed the file, and Preview for Markdown, walked with
the view chord; Preview is offered only for a file that has one. Diff and
Preview are read only and drawn as the viewer draws them, from the file on
disk: with unsaved edits the foot says they show the saved version.

A file that is binary, not UTF-8 or larger than 4 MB says so and shows as
the viewer shows it.

## Saving

Nothing is written until <kbd>Cmd</kbd><kbd>S</kbd>, or Save in the File
menu, from anywhere in editor mode but a terminal. Until then the tab and
the file's row in the tree carry a dot, in agent mode as well. A save sends
what the file held when the editor read it, and the core writes only while
the disk still holds that. Reading and writing go through the core, so a
project on another machine is edited where it is; a write that fails part
way leaves the old file whole, a read-only file is not written, and nothing
in `.git` is. A save that cannot be made says why over that file's editor.

## Changes on disk

The core watches the open files where they are. A file that changes on disk
while the editor has no unsaved edits for it is read in at once, one change
for each run of lines that differs, so the lines between keep their places
and the cursor and the scroll on them hold. The tab stays as it was, a
preview still a preview, and undo takes back what was read in as a step of
its own.

Under unsaved edits a bar over the editor says the file changed on disk,
without naming who changed it, and a save never writes over it:

- **Compare** shows the disk's version against the editor's, read only.
- **Keep mine** writes the editor's version over what the disk holds.
- **Load from disk** drops the edits for the disk's version, as one change
  undo can take back.

When the file is gone, the bar says it was deleted, and offers to write it
back or Close without saving. When it is there but cannot be read, because
it grew past 4 MB, turned binary or its machine could not be reached, the
bar says so and why, and offers Keep mine and Try again.

## Nothing unsaved goes unasked

Whatever would take the only copy of unsaved edits asks first, with Save and
close as the answer drawn to give, Cancel with the keyboard, and Close
without saving apart:

- closing a tab, the question over the editor about that tab, put away if
  another tab comes to the front;
- closing a session or a project whose tabs hold edits no other session has
  open, the question in the sessions pane, which goes, closing nothing, if
  the pane folds;
- closing the window or quitting the app, the question over the whole
  window, whatever the panes show, naming every unsaved file.

When a save in Save and close or Save all cannot be made, because the file
changed on disk or could not be written, nothing is closed: that file comes
forward in the editor with its bar or why, and the status bar says what was
stopped.

The core takes the window's question as heard only once it is drawn; if it
is not drawn soon, the close or the quit goes through rather than keep the
window open. The system's own ways of ending the app, logging out
or Quit in the Dock's menu, end it without asking. A session that goes
without the user closing it, such as one an orchestrator stopped, hands any
tab with the only copy of unsaved edits to the tabs shown next.

## The File menu

On macOS a File menu holds New File, Save and Close Tab, each showing and
answering the chord its action has in the [chord table](focus-model.md):
move a chord there and the menu's moves with it. Save is greyed out
outside editor mode, or without a file in front to save, and New File
without a project. Close Tab with no tab
in front, or in agent mode, closes the window, as its chord does in every
Mac window. Close Window in the Window menu is on
<kbd>Shift</kbd><kbd>Cmd</kbd><kbd>W</kbd>, and Settings shows the chord the
table gives it; when the table gives Shift+Cmd+W to an action, Close Window
shows no chord. On Windows and Linux the menu button at the top left holds
the same three items.

## New files and the row menu

A new file is named in a field in place in the tree, from the button heading
the tree's column, the row menu, New File, or
<kbd>Alt</kbd><kbd>Cmd</kbd><kbd>N</kbd>, which flips to the editor from
agent mode. It goes in the folder the tree's cursor is in, or at the top
until the cursor has been put somewhere or a file chosen. Enter makes the
file and opens it, Escape drops the field, and slashes in the name make the
folders on the way. A click elsewhere makes the file when the name will do
and keeps the field with why when it will not; switching to another app
leaves the field as it is, and so does a click away from a new folder's
name. The field stays as it is while the agent adds or removes files
around it.

The tree lists what git lists and git lists no empty folder, so naming a new
folder shows it open in the tree with a field for its first file, and the
folder is made with that file; Escape drops both.

A right-click on a row opens a menu: New file, New folder, Rename, Delete,
Copy path, which copies the path from the project's root, and Reveal in
Finder, Show in Explorer or Show in file manager, for a project on this
machine. The row the menu is for is marked while it is open. Rename puts the
field over the row, a change of case alone included, and the tabs on what was
renamed follow it. Delete marks the row, asks first and says what goes,
every file in a folder, and deletes from the disk rather than moving to the
Trash. The core refuses to rename or delete a folder holding another
repository or a worktree, and the refusal is said over the tree, or under
the field for a rename.

## Between the two modes

In agent mode a file opens in the viewer without moving the agent, and the
viewer's bar has an Edit button that flips to the editor at the file and the
line it shows. Flipping to the editor from the viewer brings the file along
at its place.

In editor mode what a tool points at opens in the editor's place: a file as
a tab at its line, a diff as that tab's Diff view, and what was presented, a
plugin's page or the browser where the viewer shows them. While one of those
has the editor's place no tab is drawn in front; its Esc, or Escape from the
tree, gives the editor back. Flipping back to agent mode shows it in the
viewer, or puts the agent in the middle with the changes beside it.
