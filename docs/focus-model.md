# Focus model

## The rule

**The agent pane owns the keyboard.** Every keystroke goes to the agent
unless the app has explicitly reserved it, and the app reserves as little as
it can. The middle pane is a real TUI, not a text field. Claude Code binds
<kbd>Ctrl+C</kbd>, <kbd>Ctrl+R</kbd>, <kbd>Esc</kbd> and
<kbd>Shift+Tab</kbd>, and a shortcut that silently eats one of them turns
into a bug report about the agent.

This holds for a terminal session. An integrated session has no terminal:
the pane is the app's own conversation, and what it takes from the keyboard
is under [an integrated session](#an-integrated-session).

## What the app claims

Only <kbd>Cmd</kbd> chords (<kbd>Ctrl</kbd> on Windows and Linux). The
default preset:

| Keys                                                                    | Does                                                        |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| <kbd>Cmd</kbd><kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> / <kbd>4</kbd> | Focus sessions / agent / changes / terminal; while reviewing, <kbd>Cmd</kbd><kbd>1</kbd> peeks the sessions pane over the agent and puts it back; in [compact mode](layout.md#compact-mode) it slides the pane in and back; while editing, see [the editor](#the-editor) |
| <kbd>Cmd</kbd><kbd>5</kbd>                                              | The keyboard to the [status bar](#the-status-bar)           |
| <kbd>Cmd</kbd><kbd>B</kbd>                                              | Show or hide the sessions pane; in compact mode, slide it in or back |
| <kbd>Cmd</kbd><kbd>\\</kbd>                                             | Show or hide the right pane: the changes, or the agent while editing |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>E</kbd>                              | Agent or editor in the middle                               |
| <kbd>Cmd</kbd><kbd>J</kbd>                                              | Show or hide the terminal panel                             |
| <kbd>Cmd</kbd><kbd>T</kbd>                                              | A new shell in the terminal panel, opening it, with the keyboard in it |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>↓</kbd> / <kbd>↑</kbd>               | Next or previous session, or shell when the panel has focus |
| <kbd>Cmd</kbd><kbd>.</kbd>                                              | Go to the next session that needs you                       |
| <kbd>Cmd</kbd><kbd>D</kbd>                                              | Open or close the file viewer, in agent mode                |
| <kbd>Cmd</kbd><kbd>E</kbd>                                              | Diff, whole file or rendered; in the editor, Edit, Diff or Preview |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>A</kbd>                              | Changed files or all files                                  |
| <kbd>Cmd</kbd><kbd>F</kbd>                                              | Filter files, when a list pane has focus; find in the file, when the editor has it; find in the conversation, in an integrated session's pane |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>F</kbd>                              | Search in files                                             |
| <kbd>Cmd</kbd><kbd>N</kbd>                                              | A new untitled file in the editor, from either mode         |
| <kbd>Alt</kbd><kbd>Cmd</kbd><kbd>N</kbd>                                | A new file in the tree, in editor mode                      |
| <kbd>Cmd</kbd><kbd>S</kbd>                                              | Save the file in front, in editor mode                      |
| <kbd>Cmd</kbd><kbd>W</kbd>                                              | Close what is in front: see [closing](#closing-what-is-in-front) |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>T</kbd>                              | Cycle theme: light, dark, system                            |
| <kbd>Cmd</kbd><kbd>=</kbd> / <kbd>-</kbd> / <kbd>0</kbd>                | Zoom the terminal, or the editor, that has focus in, out, or back |
| <kbd>Cmd</kbd><kbd>P</kbd>                                              | Go to a session or project                                  |
| <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>P</kbd>                              | Open the command palette                                    |
| <kbd>Cmd</kbd><kbd>,</kbd>                                              | Open the settings                                           |

Two chords differ on Windows and Linux, where <kbd>Ctrl</kbd><kbd>T</kbd> is
the process's in a terminal: a new shell is
<kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>T</kbd> there, as in a terminal
emulator, and cycling the theme is
<kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>D</kbd>. A stored table with no chord
for a new shell and the theme on <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>T</kbd>
is read with the theme on <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>D</kbd> and the
new shell on <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>T</kbd>.

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
or project stays on <kbd>Cmd</kbd><kbd>P</kbd>, and the editor's chords,
close, a new shell's and the status bar's are the default's.

A chord with <kbd>Alt</kbd> is read from the key's place on the keyboard,
since on macOS <kbd>Option</kbd> turns a letter into another character.

## The palettes

Two lists share one field over the workbench. What is typed narrows the
list to the entries holding every word of it, in any order, as
[the tree's filter](layout.md#the-field-above-the-tree) does.
<kbd>Up</kbd> and <kbd>Down</kbd> move the cursor and <kbd>Enter</kbd>
picks. The cursor starts on the first entry that can be picked, and stays on
the same entry while sessions change state and move under it.

**Go to** opens on <kbd>Cmd</kbd><kbd>P</kbd> and lists the sessions, then the
projects. A session matches on its name or on the label of its project.
Sessions are listed by when they last changed, the latest first, each with a
dot for its state, its project and the time since. With nothing typed the
cursor starts on the first session that is not the one on screen, so Enter
goes to the previous one. Every open project is listed, with how many of the
sessions the sessions pane draws under it are live, or the time since it was
last used, the most recently used
first. <kbd>Enter</kbd> on a session shows it and puts the keyboard in its
agent, as a click on its row does. On a project it brings the project forward
and counts it as used, as [sessions](sessions.md#active-and-inactive) orders
them, showing a session drawn under it as a click on its header does, with
the keyboard in that session or, for a project with none, in the sessions
pane. A sessions pane that is folded opens for that, or peeks over
the agent while reviewing, so the viewer stays, and in a window too narrow for
the pane, or in compact mode, it stays as the user set it and the keyboard
goes to the agent pane's New session button. <kbd>Cmd</kbd><kbd>Enter</kbd> on either starts a session
in that project, as below. A <kbd>&gt;</kbd> typed as the first character
switches to the commands, with the rest of what was typed. Go to lists no
commands, except that once something is typed the command for the file in the
viewer is listed when it matches, after the sessions and projects, or before
them when what was typed is the start of its name, so Enter on "preview" runs
Preview file.
With nothing open
the list holds one row, Open project. The footer names only what the list on
screen can do.

**Commands** open on <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>P</kbd> and list every
action the keys can do, each with its chord, and the ones that have none: new
session, new session in the project on screen, open project and open remote
project, and Preview file or Show source for the file in the viewer when it
is Markdown, HTML, Mermaid or SVG (the commands have no chord). Picking an
action does what its chord does. The first entry goes to
the next session that needs you, as <kbd>Cmd</kbd><kbd>.</kbd> does (see
[sessions](sessions.md)). It shows how many are waiting, and with none it
cannot be picked.

**A new session** is asked for in the same field, a step at a time. First the
project, unless only one is open: the one on screen above the others, then by
when they were last used. While a session that another started in a
different project is on screen, the project on screen is the starter's, as
[sessions](sessions.md) describes, both here and for the command that starts
a session in the project on screen. Then the account, when accounts are named in the
[settings](settings.md#accounts), with the project's own under the cursor;
then how it runs, when there is a workflow or more than one agent to pick
between: the workflows under one heading, offered once a workflow has been
turned on for new sessions or for a project, the project's own first and
marked as the project's workflow or the default, each with the models it
runs on, and under another the agents to run alone, with no workflow. The cursor starts on the
project's workflow, else on the agent last started in the project. A step
with nothing to choose is not asked. Each
answer stays in the field as a chip, and <kbd>Backspace</kbd> on an empty
field takes the last one back, one step to a press however long the key is
held; from the first step it returns to the commands with what was typed there
still in the field. The last answer brings the project forward and starts the
session the way a project's new-session button in the sessions pane does,
and the keyboard goes to the new agent.

<kbd>Escape</kbd> puts the palette away from any step, and so does the chord
of the list that is up: <kbd>Cmd</kbd><kbd>P</kbd> for go to,
<kbd>Shift</kbd><kbd>Cmd</kbd><kbd>P</kbd> for the commands and a new session.
The other chord switches to its list. The keyboard goes back where it was.
While the palette is up it has the keyboard and no other chord reaches past
it, except that Settings opened from the app's menu puts the palette away
first.

While a dialog, or a question over the agent pane, is up, neither chord opens
a palette and <kbd>Cmd</kbd><kbd>.</kbd> does nothing, so the keyboard stays
where the dialog has it. A new shell, a new untitled file and the chord to
the status bar do nothing either while a dialog or a question in a strip
holds the keyboard.
Answering the question gives the keyboard back to
the pane that has the focus.

## Closing what is in front

<kbd>Cmd</kbd><kbd>W</kbd> closes what is in front, wherever the keyboard is,
and never more than that. It closes the first of these that holds:

- the palette, or a dialog that holds the keyboard, as Escape does;
- nothing, while a question in a strip holds the keyboard: a second press
  neither answers it nor reaches past it;
- the shell in front, while the terminal panel has the keyboard;
- the browser's tab in front, while the browser is shown, in the viewer or
  in the editor's place;
- in editor mode, what the agent presented or a plugin's page in the
  editor's place, else the editor's tab in front, from the agent's terminal
  or conversation as much as from the tree;
- while reviewing, the viewer;
- otherwise the window.

It never closes a session: a session is closed from its row, which says
what goes with it. Close in the File menu does the same as the chord, and
is named for what it would close: Close Tab, Close Shell, Close Viewer or
Close Window.

A shell at an idle prompt closes at once. One with something still running
in it, a dev server say, comes to the front and asks first, by the chord,
its row's <kbd>Delete</kbd> or its ×: the question names what runs and
holds the keyboard on Cancel, <kbd>Escape</kbd> cancels, and either answer
gives the keyboard back where it was, the shell or its row. The question
goes, closing nothing, when the panel is hidden or the session or project
on screen changes, and the chord pressed again while the keyboard is
elsewhere puts it back on Cancel. What a shell's prompt keeps running for
itself, such as a git status daemon, does not count, and a shell started
inside the shell counts for what it runs.

Closing a session from its row closes the shells that belong to it, and
closing a project every shell that started in it, so either asks first
while one of those has something running. The question goes up at the top
of the sessions pane, in the words of the window's below: how many busy
shells, what runs in each, and that closing stops them, with Cancel
holding the keyboard. Asked together with unsaved edits, the edits'
question adds a line about the busy shells. Idle shells go without a
question.

Closing the window ends the app, and every session and shell running in it.
So the window's close, by the chord, by Close Window on
<kbd>Shift</kbd><kbd>Cmd</kbd><kbd>W</kbd>, by the red button or by the
controls the app draws, and the app's quit, ask first while a session runs,
a shell has something running in it, by the rule above, or the editor
holds unsaved edits. The question goes over the whole window. It says how
many sessions run and how many of them wait on you, what runs in each busy
shell and, for one not on screen, the session or project it belongs to,
that the sessions come back as rows next time to resume, and names
every unsaved file, with Cancel holding the keyboard, so <kbd>Return</kbd>
keeps everything. A row left from the last quit runs nothing and counts
for nothing, and a window with nothing running, idle shells included,
closes without a question. There is no setting to turn
the question off. How it is held for unsaved edits is in
[the editor](editor.md#nothing-unsaved-goes-unasked).

On Windows and Linux the chord is <kbd>Ctrl</kbd><kbd>W</kbd> outside a
terminal, which keeps it, since it deletes a word there;
<kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>W</kbd> closes from anywhere, a terminal
included, as in a terminal emulator. A close chord moved in the settings
takes its Shift form with it, unless another action holds that. On macOS
a terminal keeps <kbd>Ctrl</kbd><kbd>W</kbd> and
<kbd>Cmd</kbd><kbd>W</kbd> is the app's from everywhere.

## What the app never claims

- **<kbd>Tab</kbd> does not move focus between panes.** It is completion
  inside the TUI, and <kbd>Shift</kbd><kbd>Tab</kbd> is Claude Code's mode
  switch. Pane focus moves on <kbd>Cmd</kbd><kbd>1/2/3/4</kbd> or a click.
  Outside a terminal Tab walks the controls, as
  [Tab and the controls](#tab-and-the-controls) says.
- **<kbd>Ctrl</kbd> chords belong to the agent** on macOS, where the app
  modifier is <kbd>Cmd</kbd>. On Windows and Linux the modifier is
  <kbd>Ctrl</kbd>, so the bound chords are taken from the terminal there,
  and <kbd>Ctrl+C</kbd> and <kbd>Ctrl+R</kbd> are never among them, nor
  <kbd>Ctrl+W</kbd>, which closes only outside a terminal.
- **<kbd>Esc</kbd> belongs to whichever terminal has focus.** The agent needs
  it, and so does a shell in the panel, and the editor keeps its own. An
  integrated session's composer takes it to stop a running turn. A pane that
  owns focus may use it: the file viewer closes on it and leaves the keyboard
  in the tree, and a list pane hands the keyboard back to the agent, or in
  editor mode to the editor. This is the one key whose meaning
  depends on context, so the resolution takes the focus state and lives in one
  testable place. The one exception is a popover the user opened from a
  header, such as a workflow tag's rules or where a run stands: while it
  is open, Esc puts it away wherever the keyboard is and reaches nothing
  else, since a click does not move the keyboard on every platform and the
  key that closes a popover must never also stop the agent's turn. With no popover open, Esc is the
  terminal's or the composer's again. Find in an integrated session's
  conversation is put away the same way from its thread and its composer,
  before the composer would stop a turn with it.
- **A pane that goes away does not keep the keyboard.** When the window
  narrows past the sessions or changes pane while it has focus, the keyboard
  goes to the agent pane; when editing hides the agent, it goes to the files
  pane. A dialog or the palette that holds the keyboard
  at that moment keeps it, and hands it to the agent pane when it goes.
- **<kbd>Shift</kbd><kbd>Enter</kbd> is a new line in the agent pane.** The
  terminal would send the same carriage return as for <kbd>Enter</kbd>, so
  the app sends Meta+Enter, which Claude Code takes as a newline. A shell in
  the panel gets the plain return, and an integrated session's composer
  breaks the line.
- **A click in a terminal is the program's.** Links open on
  <kbd>Cmd</kbd>+click (<kbd>Ctrl</kbd> elsewhere), bare URLs and links the
  program marked up alike. A plain click is left to the TUI.

## Tab and the controls

Outside a terminal and the editor, <kbd>Tab</kbd> and
<kbd>Shift</kbd><kbd>Tab</kbd> walk the window's controls in reading order,
as on any page, and they do so in WebKit, the app's own webview on macOS,
as everywhere else. WebKit passes over a button, a link or a popup on Tab
unless the system's full keyboard access is on, so the app makes every
control a stop as it is drawn, by one rule for the whole window:

- **A single control is a stop of its own**: a header's buttons, a dialog's
  buttons, the fields, the folded sessions column.
- **A list is one stop**: the sessions pane, the tree, a segmented choice,
  a row of tabs, the settings' sections, the shells in the terminal panel,
  the folders on another machine. Tab lands on the item chosen, or the
  first. The arrow keys walk the list, <kbd>Home</kbd> and <kbd>End</kbd>
  jump, and <kbd>Enter</kbd> or <kbd>Space</kbd> does what a click on the
  item does; moving picks nothing, except that the settings' sections show
  as the arrows reach them. <kbd>Delete</kbd> closes the tab under the
  keyboard, as its × does, and the keyboard stays on the row.
- **A shell's row** in the terminal panel goes to its shell: a click,
  <kbd>Enter</kbd> or <kbd>Space</kbd> on it shows the shell and puts the
  keyboard in it. <kbd>Delete</kbd> closes the shell under the keyboard,
  as its × does, asking first when something runs in it, and the keyboard
  stays on the rows.
- **A menu** opens with the keyboard on the choice in force, or its first
  item. The arrows walk it, <kbd>Enter</kbd> picks, <kbd>Esc</kbd> closes it
  back to its button, and <kbd>Tab</kbd> closes it on the way on. A list
  walked from a field, the palette's or the sessions to resume, is walked
  from the field and is no stop of its own.
- **A terminal keeps Tab**, and so does the editor, where it indents. The
  terminal panel's list and its tools come before its shells, so they are
  reached first, and the status bar comes before the panel for the same
  reason.
- **A dialog, the palette and a question in a strip keep Tab inside**: past
  the last stop it comes round to the first. A question in a strip is one
  put in a pane before something is taken away, such as closing a tab with
  unsaved edits; it takes the keyboard when it opens, on Cancel, which is
  drawn ringed however the question came up. The questions shown
  over the agent pane, whether an agent may start a session or change a
  setting, take neither the keyboard nor Tab: the keyboard stays with the
  agent, and their buttons are stops in reading order. A pane that is
  narrowed away, hidden, or under a dialog takes no Tab, and a peeked
  sessions pane goes back when Tab leaves it rather than let Tab reach the
  pane under it.
- **Wherever Tab lands is drawn** in the look's own way: a ring in the
  accent, a list's cursor on its row, a field's caret, and on a divider a
  line in the accent with its grip at the middle while the status bar names
  the keys it takes, as [dividers](layout.md#dividers) says.

A control added anywhere in the window, the status bar included, follows
the rule without any work of its own. A list that walks its own items, as
the sessions pane and the conversation's dock do, keeps the stops it gives
them.

## An integrated session

The agent pane of an integrated session is a composer, a thread and, while
the agent waits on the user, a dock between them; see
[sessions](sessions.md#integrated-sessions). Focusing the pane by key, or
the session coming on screen in it, puts the keyboard in its composer,
unless another control of that same session has it, or a control of the
pane's own, such as the workflow tag or a run's chip in its header, as
for a terminal; a
session going off screen lets the keyboard go. With no composer, the
keyboard goes to Resume once the session has ended, and to the card that
asks before a session can run, which is read before its buttons are
reached.

| Keys | Does |
| --- | --- |
| <kbd>Enter</kbd> | Sends the message; while the agent works it waits for the turn |
| <kbd>Shift</kbd><kbd>Enter</kbd> | Breaks the line |
| <kbd>Cmd</kbd><kbd>Enter</kbd> | Sends the messages that wait for the turn now, while they can go now, and with words written while the agent works, sends those and has them go now too; Ctrl off macOS. Named in the hint only while no action of the keymap holds it |
| <kbd>Cmd</kbd><kbd>Shift</kbd><kbd>Enter</kbd> | Takes the newest of the user's own waiting messages back into the composer; Ctrl off macOS |
| <kbd>Esc</kbd> | Stops the running turn; with none running, closes the viewer while reviewing, hands the keyboard back to the editor in editor mode, and does nothing else. While a header's popover or find is open it puts that away instead, and stops nothing |
| <kbd>Esc</kbd> <kbd>Esc</kbd> in an empty composer | With the agent at rest, in the working mode, two within about 0.6 seconds open the list of the user's own messages over the composer, to go back to before one; the first says what a second does. A burst in which an <kbd>Esc</kbd> did anything else, such as stopping a turn or closing a menu, opens nothing, so tapping <kbd>Esc</kbd> during a turn only stops it. Key repeats count for nothing |
| <kbd>↑</kbd> <kbd>↓</kbd>, <kbd>Home</kbd> <kbd>End</kbd> in that list | Mark a message; the thread brings it into view under a line and fades what would leave with it |
| <kbd>Enter</kbd> in that list | Turns it into the choices for the marked message: the conversation, the conversation and the files, only the files, each where the agent can |
| <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> or <kbd>Enter</kbd> in the choices | <kbd>Enter</kbd> takes the marked one: the session goes back, and the message's words come back to the composer. A digit takes a choice that can be undone, and only marks one that cannot, for <kbd>Enter</kbd> to take. A choice marked by a key names all its files; one whose files wait behind a count names them first, and is taken on the next press |
| <kbd>Esc</kbd> in the choices / in the list | Back to the list / closes it; typing closes it and types |
| <kbd>↑</kbd> in an empty composer | Goes to the dock, when something waits there: the agent's own requests or those of the sessions it started; <kbd>Esc</kbd> there comes back. With nothing there, takes the newest of the user's own waiting messages back into the composer, the caret at its start |
| <kbd>↑</kbd> again, the caret at the start | While the composer holds only what <kbd>↑</kbd> took back, unchanged, takes the one before, ahead of it; each comes back in the order sent, and <kbd>Enter</kbd> sends them as one. Once the words or the caret move, <kbd>↑</kbd> moves the caret |
| <kbd>/</kbd> first in the composer | Opens the agent's commands and skills, for an agent that lists them |
| <kbd>↑</kbd> <kbd>↓</kbd> in the slash menu | Mark a command or skill |
| <kbd>Tab</kbd> or <kbd>Enter</kbd> in the slash menu | Puts the marked one in the composer, a space after it |
| <kbd>Esc</kbd> in the slash menu | Closes the menu, keeping what is written; it stops nothing |
| <kbd>@</kbd> at the start or after a space | Opens the project's files, where it has a git repository |
| <kbd>↑</kbd> <kbd>↓</kbd>, <kbd>Tab</kbd> or <kbd>Enter</kbd>, <kbd>Esc</kbd> in the files menu | As in the slash menu: the file goes in as its path, a space after it |
| <kbd>Backspace</kbd> right after a mentioned file | Takes the whole mention out |
| <kbd>Tab</kbd> | Moves between the thread, the dock's folds and choices, and the composer's controls, in reading order |
| <kbd>↑</kbd> <kbd>↓</kbd> in the thread | Moves through its folds, steps, links and Copy buttons, and the Send now and Take back of the messages that wait; <kbd>Home</kbd> and <kbd>End</kbd> go to the first and the last of the whole conversation, the last being under what waits, the thread following its foot again after <kbd>End</kbd>, and <kbd>Esc</kbd> goes back to the composer, once find is closed |
| <kbd>Cmd</kbd><kbd>F</kbd> | Opens find over the thread with the keyboard in its field; with find open, selects the words in it |
| <kbd>Enter</kbd> / <kbd>Shift</kbd><kbd>Enter</kbd> in find | The next match, or the one before, coming round at the ends |
| <kbd>Cmd</kbd><kbd>G</kbd> / <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>G</kbd> | The same, from anywhere in the session's pane while find is open, unless an action holds the chord |
| <kbd>Esc</kbd> in find | Closes it and gives the keyboard back where it was; it stops nothing |
| <kbd>Esc</kbd> while find is open | In the thread, or in the composer with no menu open, closes find and stops nothing; the next <kbd>Esc</kbd> does what it does there |

Every control of the view is reached by keyboard alone, by the rule in
[Tab and the controls](#tab-and-the-controls). The lists in it are one stop
each: the thread, where the arrows move through its folds, steps, links
and Copy buttons from what is in view, drawing what is not drawn yet as
they come to it, each Copy after what it belongs to and shown while the
keyboard is on it, and <kbd>Enter</kbd> opens or presses one, and the
dock's choices. The composer's
controls, attach, the model and the mode, the workflow before the first
message, Send and Stop, the dock's folds,
and the buttons of the cards that ask before a session can run are stops
of their own in reading order. A model a workflow holds is a stop too,
which opens nothing and says the workflow sets it. The
model's, the mode's and the workflow's menus open with
<kbd>Enter</kbd> on the choice in use, are walked with the arrows,
<kbd>Home</kbd> and <kbd>End</kbd>, pick with <kbd>Enter</kbd>, and give the
keyboard back to the composer's field once a choice is picked, or to their
chip on <kbd>Esc</kbd>. Focus is always drawn where the keyboard
is.

The dock's choices are one stop for the keyboard. The arrow keys move
between them, <kbd>Home</kbd> and <kbd>End</kbd> jump, <kbd>Enter</kbd> or a
digit picks one, and the first is the choice that allows the call once and
remembers nothing. The dock never takes the keyboard by itself, so nothing
typed for something else answers it, and its digits answer only while it has
the keyboard: the composer says Up reaches it, and a lone digit sent from the
composer while it waits goes as a message only on a second Enter. A question's options move the same
way; where one pick answers the question, picking it answers. A denial that
asks for words takes them in a field where <kbd>Enter</kbd> denies and
<kbd>Esc</kbd> goes back to the choices. Once an answer is on its way the
keyboard goes to the next request, or back to the composer, and so it does
when the request with the keyboard goes by itself: a question that settles
itself, or a permission the agent withdraws. A request of a session this one
started is answered with the same keys, its Open a stop of its own before
the choices; a terminal session's ask has one choice, Open, which
<kbd>Enter</kbd> takes to that session with its terminal focused. While the
keyboard is in the dock the request it is on stays there whatever arrives,
and a request that takes the place of another, or comes just after the dock
emptied, takes no key or click for half a second, so a key pressed for the
one before never answers it. Once an answer is sent its choices stay
reachable, faded, until the agent takes it, so the keyboard stays in the
dock until then and passes on to the next request or the composer when the
request goes. <kbd>Esc</kbd> in the dock gives the keyboard back to the
composer, as from the thread, and answers nothing. The model's menu
opens from its button and is walked with the arrows, <kbd>Enter</kbd>
picking and <kbd>Esc</kbd> closing it. The choice under the pointer takes
the keyboard, so the pointer and the arrows move one mark, and the keyboard
going anywhere else, by a chord or a press, puts the menu away and stays
where it went.

The slash menu and the files menu never take the keyboard: the composer
keeps it and names the marked row to a screen reader, says how many rows
there are or that none match, and the arrows, <kbd>Tab</kbd>,
<kbd>Enter</kbd> and <kbd>Esc</kbd> act on the menu only while it is open
with something in it. A key that is part of a composition, as an input
method makes one, goes to the composition. While the agent is still
starting, <kbd>Enter</kbd> sends nothing, so a command is not sent as text
before the agent can take it.

Every chord the app claims works from the composer as from anywhere else.
Find goes to the pane that holds the keyboard: from an integrated
session's composer, thread or dock it finds in the conversation, from the
editor in the file, and from a list pane it filters the files, in editor
mode as in agent mode, where the editor and the conversation stand side
by side. In a terminal session's pane it stays the terminal's.

Find's bar comes before the thread for <kbd>Tab</kbd>: its field, then
the previous and the next match, which are passed over while nothing
matches, then its close, each a stop of its own. Its arrows and close
leave the keyboard in the field when clicked. While the bar is open the
keyboard can go anywhere in the pane and the bar stays; closing it gives
the keyboard back where it was before it came to the bar, or to the
composer, but only when the bar had it. A screen reader hears the count
once it settles, once for each change, and the field names it.

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
panes' own cursors, except that <kbd>Cmd</kbd><kbd>3</kbd> in editor mode
lands in the editor.

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
the sessions pane is on that cursor, the order and menu
buttons on its title row, the field that opens go to and the
new-session button included, the menus' items walked with the arrows while
one is open. <kbd>Delete</kbd> closes the project or session under the
cursor, except a session another session started, which only its own × or
its starter's board stops. The menu key, or <kbd>Shift</kbd><kbd>F10</kbd>,
opens the menu of the session under the cursor, as a right click on its row
does.

Confirming a session moves the keyboard into the agent, so
<kbd>Cmd</kbd><kbd>1</kbd>, <kbd>↓</kbd>, <kbd>Enter</kbd>, type is the whole
flow. The tree opens the file in the viewer and keeps the keyboard, because
the next thing is usually another file.

## The editor

In editor mode the panes keep their keys where they now stand:
<kbd>Cmd</kbd><kbd>1</kbd> is the sessions pane, peeked over the files when
the window has folded it, <kbd>Cmd</kbd><kbd>2</kbd> the agent on the right,
and <kbd>Cmd</kbd><kbd>4</kbd> the terminal panel. <kbd>Cmd</kbd><kbd>3</kbd>
is the files pane, which holds the tree and the editor: it lands in the
editor, or the tree with nothing open, and pressed again from the editor it
goes to the tree, and from the tree back to the editor. In the Vim preset
the same holds for <kbd>h</kbd>, <kbd>k</kbd>, <kbd>l</kbd> and <kbd>j</kbd>.

The view chord walks the tab's views, Edit, Diff and Preview. The viewer's
chord, <kbd>Cmd</kbd><kbd>D</kbd>, does nothing for the app in editor mode;
the viewer's Edit button and the switch are the ways between the modes.

The editor is a text field of the app's own, and while it has the keyboard
it keeps what a text field needs. <kbd>Esc</kbd> is its: it closes find and
drops extra cursors, and the keyboard stays. Every chord on an arrow key is
its too, moving or selecting, so <kbd>Shift</kbd><kbd>Cmd</kbd><kbd>↓</kbd>
selects to the end of the file there rather than stepping sessions, and
<kbd>Cmd</kbd><kbd>D</kbd> selects the next occurrence of what is selected.
<kbd>Tab</kbd> indents. The other chords are the app's as anywhere, and
<kbd>Cmd</kbd><kbd>F</kbd> finds in the file there, and in the
conversation from an integrated session beside it, as
[an integrated session](#an-integrated-session) says.

Save works from anywhere in editor mode but a terminal: from the tree as
well as the editor, and from an integrated session's composer, which is a
text field with no use for it. A terminal keeps its chord, since on Windows
and Linux <kbd>Ctrl</kbd><kbd>S</kbd> is the process's. On macOS a chord the
page lets through reaches the [File menu](editor.md#the-file-menu), whose
items carry the same chords, so <kbd>Cmd</kbd><kbd>S</kbd> saves from a
terminal too. With the keyboard in a browser tab's page, Save is the app's
only in editor mode; outside it it reaches the menu as from anywhere else.
Close closes the tab in front from anywhere in editor mode, as
[closing what is in front](#closing-what-is-in-front) says.

A new untitled file, <kbd>Cmd</kbd><kbd>N</kbd>, is the app's in either
mode and from anywhere on macOS, a terminal included, since a terminal has
no use for Cmd. On Windows and Linux a terminal keeps
<kbd>Ctrl</kbd><kbd>N</kbd>, the shell's next line of history, and the
chord is the app's everywhere else: the editor, the tree, the lists and an
integrated session's composer.

<kbd>Esc</kbd> in the tree, the sessions pane or an integrated session's
composer with no turn running hands the keyboard back to the editor, where
typing resumes in this mode, and
puts away what the agent presented in the editor's place. Opening a file from
the tree keeps the keyboard in the tree for the next file, as it does for
the viewer; a click on a tab, a new file made, or the Edit button gives it to
the editor.

The name field in the tree, the row menu and the confirm strips over the
editor and the tree hold the keyboard while they are up: the arrows walk the
menu, <kbd>Enter</kbd> picks or makes, <kbd>Esc</kbd> backs out, and the
strips start on Cancel. When they go, the keyboard goes back to the tree,
the editor or the tab row it came from.

## The status bar

The model, the effort and the allowance in the [status
bar](layout.md#the-status-bar) are window chrome: a press on one leaves the
pane focus where it was. What it opens holds the keyboard while it is up: a
menu starts on the choice in use and is walked with the arrows,
<kbd>Home</kbd> and <kbd>End</kbd>, <kbd>Enter</kbd> picking, the choice
under the pointer taking the keyboard as the composer's do, and the popover
takes the keyboard itself. <kbd>Escape</kbd>, a pick, or a press elsewhere
puts either away, and the keyboard goes back where it was before it opened,
the composer or a terminal included; so do <kbd>Enter</kbd> and
<kbd>Space</kbd> in the popover, as on its control. A chord that moves the
keyboard elsewhere, such as one to another pane, puts either away and
leaves the keyboard where the chord sent it. A change of the window's size
leaves either open, above its control. <kbd>Tab</kbd> from a menu goes on
to the next control of the bar, and from the popover stops on the
allowance. The three are stops of their own, WebKit included, and open on
<kbd>Enter</kbd> or <kbd>Space</kbd>.

The bar is drawn along the window's foot but comes after the panes and
before the terminal panel in the walk: the panel ends in a shell, which
keeps Tab, so a walk that reaches the panel has passed the bar, whether the
panel is open or not. A terminal or the editor may still stand before the
bar and keep Tab, so <kbd>Cmd</kbd><kbd>5</kbd> puts the keyboard on the
bar's first control from anywhere, in either mode; with nothing in the bar
to take it, the bar says so. The pane keeps the focus while the keyboard is
on the bar, and <kbd>Escape</kbd> on one of its controls gives the keyboard
back to that pane.

## What focus looks like

The focused pane is marked in the accent, its title with it, and the status
bar names it when there is room; which part of the pane carries the mark is
the look's, in [settings](settings.md#theme): in the modern look an edge
along the top of the pane's card, ending square in its rounded corners, or
under the sessions pane's header, which has no card, on the same line; in the
terminal look the box's own border. An unfocused agent pane shows a hollow
cursor, the terminal convention.