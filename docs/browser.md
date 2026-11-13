# Browser

A browser sits beside the agent for development: the app you are building
running live, a doc, a pull request. It is not a browser for everyday use,
and it keeps no bookmarks or history of its own beyond the tabs open in it.

It is the platform's own web view, WKWebView on macOS. A login page that
refuses to run inside an embedded view refuses here for the same reason,
and neither a passkey nor a password manager's browser extension works in
it.

## Where it lives

A Browser fold sits under the tree, beside the folds for what the agent has
presented and what runs under the project's sessions, standing even with
nothing open since opening a tab is what the fold is for. Its header counts
the tabs of the session on screen and carries the action that opens one; a
row under it shows a tab's title or host, its address with the scheme left
off and, ahead of the address, the word "agent" for a tab an agent opened,
and a dot for whether it is loading or failed. A click or Enter on a row
brings that tab to the front, the row of the tab on show is marked, and a
hover action closes it. See [layout](layout.md) for how the fold shares
the column with the others.

The viewer shows the browser the way it shows a file: opening it puts away
whatever file, presented media or plugin page the viewer held, and opening
one of those, or closing the viewer, puts the browser away in turn, leaving
its tabs exactly as they were. Switching sessions keeps the browser, and
the tab it was on, with the session it was open beside, the way a file is
kept, so coming back to a session puts its tab in front again. The pane's
"⋯" menu opens the browser on whatever tab is in front, opening one first if
the session has none.

## Whose tabs they are

Every tab belongs to one owner, and the fold, its count and the tab strip
show only the tabs of the owner on screen. A tab an agent opens belongs to
that agent's session. A tab opened by hand, from the fold, the "⋯" menu or
the strip, belongs to the session on screen; with no session on screen it
belongs to the project on screen, and shows there for as long as no session
is selected. A page that opens a popup gives the popup's tab the same owner
as its own.

Each owner has its own tab in front. Switching sessions switches the set of
tabs shown and the one in front with it, and coming back to a session finds
its tabs as it left them. A tab an agent opens for a session that is not on
screen becomes that session's front tab without touching what is on
screen, and the viewer shows it when the user switches to the session.

Closing a session closes its tabs, and so does filing it away, which
closes it first. Closing a project closes the tabs it owns. A session that
has only stopped, and sits as a row, keeps them. A session resumed as a new
row starts with no tabs, since the row it came from was closed.

Above a tab sits a bar with back, forward, reload and home, each grey until
there is somewhere to go, a strip of tabs, those of the session on screen,
with a button to open another, and an address field. What you type there
becomes an address or is refused with a short reason: a bare word
with no scheme becomes `https`, unless it looks like a machine nearby, in
which case it gets `http` instead: `localhost`, an address ending in
`.local`, `.test` or `.internal`, a bare IP, or a single name followed by a
port. A colon that isn't followed by digits and then the end of the
address, a path, a query or a fragment names a scheme rather than a port,
so `javascript:alert(1)` is refused while `localhost:3000` opens as a page.
Nothing but `http` and `https` is let through, and there is no search
fallback for text that reads as neither an address nor a scheme. Home
returns to the address a tab was opened with, or to `about:blank` for one
opened as a new tab. Clicking from the address field into the page hands
the page the keyboard; see [focus](focus-model.md) for what the app still
takes back.

A new tab draws its own page in the body: a line asking for an address and,
with nothing else open, a button to start one. A page that did not load
says so in the same place, with the reason: the host's name did not
resolve, or nothing answered it within a few seconds. That is worked out in
the background, apart from anything the page itself reports, since a
connection that never gets a response fires no load event of its own to
wait on.

## How it is built

Each tab is a native web view of its own, laid over a rectangle the viewer
measures on its body. A page framed inside the app's own page would not do:
most sites refuse to be framed, and the agent could not reach into one. The
rectangle is followed on a resize and, since a
pane's column eases its width with no resize event of its own, on every
frame while the rectangle is still moving, settling once it has stood still
for a few frames running. On Linux, WebKitGTK views in one window stack in a
column and share its height, so the app's own page is put under a layer of
its own as the window opens, and each tab's view is moved into that layer
and placed there by coordinates.

The native view floats above everything the app draws, so it is hidden for
as long as a menu or a dialog is drawn over the viewer's body, and placed
back at its last rectangle once the last one lifts. Only the active tab's
view is ever shown; the rest stay hidden but keep running, address and all,
so a tab is exactly as it was left when it comes back to the front, and
opening something else in the viewer hides the browser without touching a
tab underneath it. A popup a page opens becomes a tab of its own rather
than a window.

On macOS the browser keeps a data store of its own, apart from the app's
own page's. A frame of a page, not the top one alone, may load the web and
whatever a page builds its own frames from, never a local file, the app's
own schemes or another program's. A tab's page runs with none of the app's
commands reachable from it.

## What the agent can do

With the hooks on, ten more tools join the six every session already has:
`browser_open` opens a tab at a `url` and shows the browser in the viewer,
as the [show tool](hooks.md#the-agents-tools) does: now for the session on
screen, and for another the tab opens for that session behind whatever the
user has in front, in whichever project, and the viewer shows it when they
switch to the session; `browser_close` closes one. `browser_tabs` answers
with the session's open tabs and which is in front. `browser_navigate` sends
a tab to a `url`, or steps it back, forward or reloads it. Opening and
navigating answer once the page has stopped loading, with where the tab
landed or why it did not load, so the call after reads the page that was
asked for. `browser_snapshot` reads a tab back as a short tree of text:
headings, links, buttons, fields, images, landmark regions and blocks of
visible text, everything a click or a type can reach marked
with a ref; asking again after the page has changed gives fresh refs.
`browser_click` presses the element a `ref` names, and `browser_type` sets
its text, submitting it too when told to. `browser_console`
answers with what the page has logged since it was last asked, failed
resources, errors and unhandled rejections among them, and empties it as it
reads. `browser_screenshot` answers with the path to a PNG of the tab,
bringing it to the front first; while the user is looking at another
session it is refused instead, since a hidden tab cannot be captured and
the user's own view is not the agent's to take over. `browser_eval` runs a script, a function
body, in the tab's page, `return` and `await` both work, and answers with
what it returned.

A click and a keystroke arrive as their own events, not the ones a pointer
or a keyboard would have produced, which a page that checks can tell apart
from a person's own; the click itself is a real one on the element, so a
link is followed and a form's default submit runs. Running script sees
whatever the page itself put on its own globals; the snapshot, the click
and the typing instead run in a script world of the app's own, which the
page can neither see nor reach, and nothing they leave behind survives to
the next call, so a ref lives as an attribute on its element rather than in
memory.

The tools act within the calling session's own tabs. `browser_tabs` lists
only those, the tools that act on a tab take its id, and a call that names
no tab means the session's front tab, whichever session the user is looking
at. A tab id that belongs to another session is refused with a plain
message. A call from an agent the window does not know, one run in a
terminal inside an open project, acts on the tabs of the project it runs in.
A call from a folder that is no open project, or from a session the window
has no row for, is refused by every tool. The browser is always the one in
the app on the user's own machine: a session running on a remote machine
still opens its tabs there, in the window in front of the user, so
`localhost` in an address then means that machine, not the remote one.

## Platforms

macOS has all of it. On Linux a tab opens, navigates and closes through
WebKitGTK, sits over the viewer the same way, greys its buttons the same
way, and gives Escape and the app's chords back. On Windows a tab opens,
navigates and closes through WebView2, its back and forward buttons stay
usable whether or not there is somewhere to go, and a page keeps every key
typed into it. On both, the tools that read or drive a page, the script,
the console, the snapshot, the click, the type and the screenshot, answer
that they are not supported there.
