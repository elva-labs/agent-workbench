# Settings

Settings open from the native menu, or with <kbd>Cmd</kbd><kbd>,</kbd>
(<kbd>Ctrl</kbd> on Windows and Linux), over the workbench. A choice applies
at once.

The settings are in eight tabs down the left. Appearance carries the
appearance, theme, font, colour, background and custom styles sections; live updates,
sessions, workflows, accounts, plugins, keys and notifications each carry
the section of that name. Opening the settings again lands on the tab last used, for as long as
the window is open. The dialog follows the look the panes are drawn in. It
has one size for every tab, so nothing moves when the tab changes, and a tab
that needs less width keeps its content at the width it reads at.

![The settings over the workbench: the four tabs down the left, and the Appearance tab with its appearance, theme, font and colour choices.](settings.png)

## Appearance

System, light or dark. System follows the desktop and changes with it.

## Theme

Modern or terminal, modern to begin with. Modern sets the chrome in the
sans, in sentence case, with soft corners: the sessions pane, the pane
headers and the status bar lie on the window's ground, its darkest tone,
and what the other panes hold stands on it as rounded cards. Terminal is
mono chrome, small capitals, square corners and panes drawn as boxes on the
ground. Either way nothing is drawn between two panes: the gap is the
divider, which shows itself as the pointer nears it, as
[layout](layout.md#dividers) describes. The focused pane is marked in the
accent either way, its title with it: an edge along its card's top under
modern, the pane's own border under terminal. Both use the same colours, so
the appearance and the palette hold across either. The system's
increase-contrast setting brings plain lines back in both: an outline round
each card and box, and a line in each divider inside a pane.

## Font

Two families, chosen apart: the one the terminal and the editor draw in and
the one the rest of the app is set in. Each starts on the machine's own, the monospace
and the sans the system draws with; the terminal can have IBM Plex Mono or
JetBrains Mono instead, and the interface IBM Plex Sans or Inter, all four
shipped with the app. Each name is shown in its own face. A change reaches
every open terminal at once, which measures its grid again and tells the
process the size it now has, so there is nothing to restart, and the editor
with them.

## Colour

Five palettes: teal, indigo, amber, rose and mono. Every colour in the app
comes from a small set of semantic tokens, ink, surface, rule, accent, add,
del, and a palette restates the accent and the cast of the greys for both
appearances while add and del stay what they are. The terminal's sixteen
ANSI colours are derived from the same tokens, so the agent's own interface
sits in the palette rather than beside it.

Themes of your own sit after the five. A theme restates some of those
tokens, for the light appearance and the dark, and may set a few measures of
the chrome's shape: the corner radii and the padding inside a pane. A token
it leaves out keeps the teal palette's value, and a colour it sets only for
light gives way to teal's dark value in the dark, so a theme never paints
the light ground into the dark appearance. Colours are taken only as hex and
measures only as whole pixels within a limit, so a theme can recolour and
reshape the window and do nothing else. A theme is chosen like a palette and
deleted with the cross beside it; deleting the one in use goes back to
teal. An agent can make one for you, as the next section describes, and the
file described under [where they are kept](#where-they-are-kept) holds them
for editing by hand.

## Background

A colour or a gradient of up to three colours of your own behind the
window's chrome. It tints the chrome: in the modern look the window's
ground, with the sessions pane, the pane headers and the status bar on it,
and the settings' title row and tab column. The cards, with the terminal,
the conversation, the diff, the editor and the viewer in them, stay solid
unless [Cards](#cards) lets a little of the background through them. In
dark the ground under the tint is the chrome's darkest tone, so the headers
on it stand apart from the cards below them. In the terminal look it shows
in the ground between the boxes and in the status bar, at half strength at
most and with no grain.

Each palette and each theme of your own keeps a background of its own, so
choosing another colour brings its background with it, and one that has
none shows the plain chrome. A theme taken away takes its background with
it.

The section has a colour pad. A colour's angle on the pad is its hue and
its distance from the centre how much colour it has. A click places the
first colour, and dragging a colour repaints the window as it moves; what
is let go of is kept. While a colour moves, the gradient is drawn coarser
so the window keeps up with the pointer, and a moment after it stops the
gradient is drawn again finely enough that no steps show where the colour
changes steeply, on a 4K screen or a screen of twice the density. A
harmony keeps the colours a fixed turn of the hue apart: single holds
one, complementary two opposite each other, analogous
three close together, 50 degrees either side of the first, and triad three
evenly spread. The first colour is drawn larger. Dragging it carries the
others with it, each keeping its own turn from it, and dragging another
sets them free. The plus and minus under the pad add a colour, up to
three, and take one away. A second colour is placed opposite the first,
and a third makes three close colours around the first, since colours
near in hue belong together and mix cleanly; to two colours placed freely
the plus adds one close to the first, on the side away from the second.
The minus shows the colour it takes, which is the one last moved or
focused and has a white centre on the pad. Taking the last leaves none. A row of ready-made
backgrounds sets the colours and keeps the strength and grain, and None
goes back to the plain chrome. Strength is how far the background shows
through the chrome's own ground, from a tenth to all of it, and grain lays
a fine speckle over it. Two small windows show the choice in light and in
dark.

By keyboard each colour on the pad is a stop. The left and right arrows
turn its hue and the up and down arrows give it more or less colour, by
more with <kbd>Shift</kbd>; <kbd>+</kbd> adds a colour and
<kbd>Delete</kbd> takes the focused one away. With no colour on the pad,
the pad itself is the stop and <kbd>Enter</kbd> places one in the hue of
the palette's accent. The harmonies and the ready-made row are one stop
each, walked with the arrows.

One choice serves light and dark. The pad sets the hue and how much
colour, and the chrome it lies on sets how light it paints: light on a
light chrome and dark on a dark one, read from the palette's own colours,
so a theme that is dark in both appearances is painted dark in both. It
paints at about the lightness of the chrome's darkest tone, so the tinted
ground stays below the cards, and a dark chrome takes more colour at the
rim, since near black the screen shows little of it.
Switching between them cannot leave anything hard to read, and the rim of
the pad is held where the strongest choice is still a tint. Text on a
tinted part is judged at the worst point of the gradient behind it, grain
included, and drawn a step stronger, darker on a light chrome and lighter
on a dark one, where it would fall under a contrast of 4.5 to 1, so every
text holds that, quiet text included. A hovered or chosen row on a tinted part lets the ink or the
accent through rather than laying a solid patch over the tint, and is
judged the same way.

Every line the window draws stays. With a background each line on or
beside a tinted part is the text colour let through at one amount for the
whole window, so it takes the colour of what it crosses, stands off a
tinted part as far as the plain line stands off the plain chrome, and
lines that meet are one paint. In the terminal look the boxes' outline and
the status rule take the background, which shows in the gap between them,
and the rules inside a box keep their colour while the box is solid. A
divider's grip and line, the focus rings, the focused pane's mark and a
chosen row stay in the accent.

The system's increase-contrast setting, or a contrast theme that forces
the system's own colours, sets the background aside, with every line and
text as they are without one and every card solid, and the section says
so, with Cards greyed out.

### Cards

Cards, under strength and grain, lets a little of the background show
through the cards as well: the panes in the modern look, the boxes in the
terminal look, and what stands over the window, such as the settings, the
palette and a menu. It runs from none, the default, to 100%, where a card
shows as much of the background's colour as the window around it does.
A card keeps its own lightness while it takes on the colour, so cards
still stand off the window around them at every step, in light and dark.
It does nothing while there is no background, and each palette and theme
keeps its own share with its background. The settings file keeps it as a
number from 0 to 0.25, a quarter of what the section shows.

A card shows the background soft: the gradient, with the grain blurred
into an even veil rather than speckled. Everything inside a card takes
the card's paint, so nothing in it looks patched: a list beside what is
read lets the background through its own step toward the ground, and a
hovered, chosen or selected row, a field, your message, inline code, a
diff's rows and a find match let the ink or the accent through rather
than laying a solid fill over it. A menu or popover takes the card's tint
from the background, never from what is under it. In the terminal look
the rules inside a see-through box are the text colour let through, as
the lines on the ground are. The browser pane's page and media such as
images stay as they are.

A terminal on a see-through card shows the card through its ground, and
its selection is the accent let through. Rows and cells a program paints
in colours of its own, such as a diff in Claude Code or an inverse status
line, keep them. While Cards shows anything, a terminal is drawn the way
the rest of the window draws text rather than by the GPU, which on a clear
ground draws glyphs too thin to read dark text on a dark colour. Drawn
that way, the box and line characters a program frames itself with, such
as Claude Code's input box, are the font's own and can show small gaps at
their joins, and a flood of output costs the window more. Where Cards
shows nothing, terminals are drawn by the GPU as before.

Text on a card is judged as text on the chrome is, at the worst point of
the gradient behind it, and the app's own text is drawn a step stronger
where it would fall under 4.5 to 1, quiet text included. A terminal draws
its sixteen colours as they are, so the share is held back where one of
them that holds 4.5 to 1 on a solid card would fall under it. In dark the
share is also held back where the cards would stop standing off the
ground, which happens only near the top of the range at full strength. A
white card in light cannot keep its lightness and darkens a little toward
the colour, so in light a terminal colour is what most often holds it
back. The section says beside the slider when either holds the share
back, by how much, and in which appearance. Where it holds the share at
none, nothing changes.

## Custom styles

A stylesheet of your own, `user.css` beside the settings file, laid over
the app's own when this is on. It can restyle anything, and it can load
nothing: a sheet with an `@import`, a `url()` that is not a `data:` url, an
image function that takes an address, or a backslash escape, which could
spell one of those out of sight, is not used, and the section says why.
It is off to begin with, and turning it on is kept with the rest of the
settings.

The sheet is set aside while the settings are open and while the app asks
you something, such as whether an agent may start a session or change a
setting. A sheet can dress anything up, and a question has to read as the
app's own; the settings being plain is also the way back from a sheet that
has made the rest hard to use. Turn Off Custom Styles, in the app's menu on
macOS and in the menu at the top left elsewhere, turns it off from anywhere
by writing the settings file itself.

A sheet holds up best aimed at what stays put: each pane is a
`section[data-pane]`, named `sessions`, `agent`, `changes` and `terminal`,
with its header the first thing in it; the controls the tests reach for
carry a `data-testid`; and the colours, sizes and shapes the stylesheets
are written in are custom properties on the root, the ones a theme sets
among them. Class names are the app's own and change without notice.

## Live updates

Watcher only, or agent hooks, chosen once for every project; each project
you open follows it, and a project that should go the other way can say so
under it. The `orchestrator` folder is among those projects while the
sessions pane lists it (see [orchestrator](orchestrator.md)). A fresh install starts with the hooks on; a setup from before the
choice existed starts with them off, and is told once, in a word over the
agent pane, what turning them on gives; the word's link opens the settings
at this section. What each means for the changes pane and for a session's
row is in [sessions](sessions.md); what the hooks write and where, and the
tools they bring the agent, is in [hooks](hooks.md).

## Sessions

How each agent's sessions run: in a terminal, the agent's own interface,
or integrated, the conversation drawn by the window, a terminal to begin
with. An agent the core says it can drive in messages offers the choice,
and the tab says an agent that runs only in a terminal does. A session
that follows a workflow runs the way its orchestrator's agent is set, as
any other does. A session that is running keeps the way it started,
and a single new one can be started the other way from a project's ⋯ menu,
the palette or the agent pane. What an integrated session is like is in
[sessions](sessions.md#integrated-sessions). It is the user's to change,
and an agent's settings tools refuse it.

How long a past session stays listed under its project: forever, 30 days,
7 days or 1 day, forever to begin with. A session this app ran is listed
under its project, one line with its time, ready to resume, as [sessions](sessions.md#past-sessions)
describes. Left unchanged for longer than the span chosen, it goes behind
the row of earlier sessions with the rest of the project's history instead, where it is still
there to resume and to search; a row left from the last quit, with nothing
running behind it, goes the same way. Resuming one brings it back to the
list. Nothing is deleted: the transcripts are the agent's own and stay where
they are.

How long a project stays in the sessions pane's list unused: 1 day, 7 days,
30 days or Never, 7 days to begin with. After that it folds under Inactive
at the foot of the pane until it is used again, as
[sessions](sessions.md#active-and-inactive) describes; a project with a
session running or waiting for you stays whatever the span. Never keeps
every project in the list.

## Workflows

A workflow says which model a session starts on and which models it may hand
work and review to. It holds a name, the orchestrator's model, and steps in
order. The roles are fixed: the orchestrator is the session the user talks
to, a worker does a piece of work, and a reviewer checks it.

A model is an agent and a model name, since a model's name belongs to one
agent. Claude Code offers the aliases its command line takes, fable, opus,
sonnet and haiku. Codex offers one, called Codex, which means whatever Codex
runs by default. Only the agents found on the machine are offered, with any
a workflow already names so that its choice can still be shown.

A step has a name, a kind and the models it may use. The models are any, or
a chosen set across the agents, and the first one chosen is the one used
unless the orchestrator has a reason to pick another. A step that does work
says how many sessions may run at once, from one to eight. A step that
reviews says when the work passes: the reviewer approves, the orchestrator
agrees, or both, so at least one is on. Otherwise the work goes back to a
named earlier work step, never to another review, at most so many times,
from one to ten, and then the user is asked.

A workflow has from one to twelve steps and the first does work. A name is
a few words, forty characters at most, and is unique among the steps of a
workflow and among the workflows, of which there are sixteen at most, the
upper and lower case of a letter from A to Z counting as the same. A model is named in
one word of forty characters at most, and a step lists a model once and
sixteen at most. The window holds a change to the same rules the settings
file is kept by, so a change it shows is one that is kept.

A fresh install has two workflows. In Build and review the orchestrator is
on Claude's most capable model alias, the Work step is on Sonnet, and the
Review step is on Opus, passes when the reviewer approves and the
orchestrator agrees, and goes back to Work up to three times before it asks.
Direct is for directing work with no review: its orchestrator is on the
same model, and its one step, Work, runs on any model, eight sessions at
once at most, which is as many as a session may run. Its orchestrator hands
each piece to a session of its own and does none itself, as
[orchestrator](orchestrator.md) describes. A settings file from before
workflows existed gets the same two, and a list written before Direct
shipped is given Direct once, at its end, unless it holds a workflow of
that name or as many as it may. They are ordinary workflows, changed,
renamed or deleted like any other, and one deleted stays deleted. New
sessions follow none until the user turns a workflow on, in this tab or by
picking one when starting a session.

A workflow in the file that does not read or keep the rules is not used, and
neither is a default or a project choice that names it. It is not dropped:
the tab names it, says the rule it breaks, and offers to remove it from the
file, and until then every write keeps it in the file as it was written,
with the default and the project choices that named it. Choosing another
default, or another workflow for such a project, takes the place of the one
in the file. Its name stays taken, so no other workflow can be given it and
then be read as the one the file's choices mean. A choice naming a workflow
the file does not hold at all is dropped.

One workflow is marked as the one new sessions start with, and none is a
valid choice. A project can choose another, or none, whatever the default
is. Deleting a workflow that was the default leaves new sessions with none,
and a project that chose it follows the default again.

A workflow also says whether its orchestrator hands out work only as
sessions the user can see, which it does unless the workflow says
otherwise. Its agent's own ways of handing work to agents the user cannot
see are then taken away, as [agents](adapters.md#under-a-workflow) lists,
so every piece it hands out is a session of its own on the sessions pane,
started with the `start` tool; with the setting off it keeps its own
subagents, and their work does not show as sessions. The settings file
writes the setting only when it is off.

A project's workflow is its own choice, else the one for new sessions, else
none. A plain new session, where there is nothing to pick, follows it. In a
project that follows a workflow, by its own choice or by the default, the
palette's new session offers every workflow, the project's first, marked as
the project's workflow or as the default, beside the agents to run alone.
The choice a project's own new-session row opens, when there is more than
one agent or an account to pick, offers the project's workflow first in the
same way, with the cursor on it, above the agents. In a project that follows none it asks nothing it did not ask before
workflows, whatever other projects chose, and with one agent installed it
starts that agent at once. An agent picked anywhere starts alone. A
session under a workflow starts on the workflow's orchestrator, its agent
and its model, told the workflow's instructions, and keeps the workflow as
it was for as long as it runs, whatever changes in the settings. Resumed,
it takes the workflow of the same name as the settings have it then; an
integrated one the window takes up again after a reload, its agent still
running, goes on with the copy its run was started on. Where
that workflow was deleted it follows the copy it kept, which its header
says; where that copy no longer reads either, the session does not start,
its header says it waits for the user's choice, and the user is asked
whether to resume it without a workflow. A session another session started follows
none. How a workflow's session directs the others is in
[orchestrator](orchestrator.md).

The tab lists the workflows across the top, with the default tagged, and
New workflow after them. The picked one has its name above the diagram,
with Duplicate. The diagram draws the orchestrator as the frame, since it is
the session the user talks to, with its model in a menu on its head. Inside
sit the steps in order with an arrow between each, each showing its role
and its models. A plus on every arrow opens a menu to add a work step or a
review step there; the step added is picked and has the keyboard. A new
review is numbered after the reviews before it, Review 2 after Review, and
one added before a review already there is a Check, so no number reads out
of order. The
picked step has two arrows above it that move it earlier or later, as Alt
with the left or right arrow key does on the step. A review that goes back
draws a line under the row from itself to the step it repeats, lines that
arrive at one step standing side by side so they do not cross, and under all
the lines a label names the review and says where the work goes back to,
until when (the reviewer approves, the orchestrator agrees, or both approve)
and how many times at most, as the step's settings say it. A review that
sends the work back at most three times reviews a piece four times at most;
the round counted on a review's header and in the question past the limit
count reviews the same way. The steps share the width there is; where even
the narrowest steps do not fit, the row scrolls sideways under the
orchestrator's head, which stays in place, with the hidden edge faded, and
the step picked is scrolled into view.

The diagram stays at the top while the rest of the tab works around it.
Picking a step shows its settings beside the diagram where the window has
room for a workflow of four steps and the settings together, and under it
where it has not, whatever the number of steps; there they take two columns
where they have the width. They scroll on their own and the diagram does
not move. The settings read from top to bottom: the step's name, whether it
does work or reviews it, the models it may use with the first chosen marked,
and the settings of its kind, a review's ending in one sentence such as go
back to Work at most 3 times, then ask me. A model other than the first can
be made the one used first. Any model stays ticked until a model is chosen.
Removing a step, at the foot of its settings, asks first and says which
reviews would go back elsewhere. Renaming a step carries the reviews that go
back to it, and removing or moving one points a review that went back to it
at the nearest work step before the review.

A control the rules would always refuse is dimmed and does nothing, and says
why when the pointer rests on it and to a screen reader: moving a step past
the end, or where a review would come first; removing the only step, or one
whose review would then come first; and turning off the one way left for a
review to pass. A change whose refusal cannot be known before, such as a
name another step has, is said beside the control it came from until
another step is picked. A change the settings file refuses, when it cannot
be written, is said at the top of the tab, and the window shows what is
stored. Every control can be reached with the keyboard, and the two kinds
are a radio group the arrow keys move through.

Under the diagram, a box, Hand out work only as sessions you can see, says
whether the orchestrator keeps its own subagents, with a line on what that
means. What the orchestrator is told unfolds into the instructions the
workflow comes to: a short numbered list. The first tells the orchestrator
to direct the work rather than do it, and to delegate by starting sessions
with the workbench's `start` tool, not with its own subagents, or, where it
keeps them, to use them for help and not for a piece of the work; to name
the step each start is for, give the agent and the model each step names
and no model for Codex's own default, and name, for a review, the session
whose work it checks. Then each step has a sentence naming the step, what a
piece has come out of or passed before it, the models it may use with the
first as the one to use, how many of its sessions may run at once and to
stop each once its piece is done with, or for a review when the work
passes, that it goes back with `send` to the piece's own session for the
step it returns to, which steps the piece is taken through again, that it
is reviewed again by a new review or a line to the reviewer, how many
times, and that the user is asked after that. The last sentence says to
report to the user once every piece has come out of or passed the last
step.

The foot always shows. A switch there marks the workflow for new sessions, with a line
saying which workflow new sessions start with. Turning it off leaves them
with none. Delete workflow stands apart at the other end, drawn as
destructive, and asks first, saying what follows: new sessions starting with
none, or projects following the default again. After what the orchestrator
is told, Project choices lists each open project with a menu: as for new
sessions, no workflow, or one of the workflows. The choices are kept with
the settings, by project path.

## Accounts

An account is a login kept apart from the others. Claude Code keeps its
login, its settings and its past sessions in a configuration directory,
`~/.claude` unless `CLAUDE_CONFIG_DIR` names another; Codex keeps its own
in a home, `~/.codex` unless `CODEX_HOME` names another, as an absolute
path in the environment the agent is started with. An account names a
directory of each, so a work login and a personal one can both be on the
machine and a session run under either. The agents' own directories are
the account every setup has, called Default where a name is shown, and a
setup with no other account named is what it always was.

The tab lists the accounts, Default first, each with where it keeps each
agent. Add an account… opens a form: a name, and under it the two
directories the name suggests, `~/.claude-work` and `~/.codex-work` for an
account called Work, shown as they will be. A pencil beside either opens
it for editing, and a directory opened that way keeps what is typed into
it while the other goes on following the name. A directory left blank
means the agent's own, so an account can be for one agent alone. Nothing
exists until Add. Remove takes an account away; the projects that named
it follow the rest again.

Naming an account does not log anything in. The directory is empty until
the agent has been run with it once: in a terminal, with
`CLAUDE_CONFIG_DIR` or `CODEX_HOME` set to the directory, the agent asks
for a login the first time and keeps it there. Whatever of the agent's
global configuration the account should share, Claude Code's `CLAUDE.md`
and skills most of all, is copied or linked in by hand.

Under the list, Which account is chosen the way live updates are: one
account for every project, and a fold of project overrides where a project
can name an account of its own, or Default, whatever the rest. A session
runs under its project's account unless another is chosen for it. Under an
account it starts with the agent's directory set to the account's, its
past sessions are read from there, and the tools the hooks bring are
registered there too, as [hooks](hooks.md) describes; an account with no
directory for the agent runs it on the agent's own. What a project's row
shows, and how one session can go another way, is in
[sessions](sessions.md#accounts).

On a remote project the directories are on the remote machine, spelled
with `~` for its home; the accounts themselves are kept with the settings
of the machine the window runs on.

## Plugins

Sources of plugins, each a git repository or a directory on this machine, with
the plugins each names, what each plugin is for and how it is faring, and a
switch per plugin. Check for updates, at the top, asks every fetched source at
once. The sources the workbench knows are listed from the first launch with
every plugin off, and turning one on fetches its source first. A source of
your own goes in behind Add a source, under them. What adding, enabling,
checking and updating do is in [plugins](plugins.md).

## Keys

The whole chord table, with two presets and room for your own. What the app
may claim and why is in [focus](focus-model.md).

## Notifications

Two switches for a session that starts waiting for you while the window is
in the background, as [sessions](sessions.md) describes. System
notifications are on to begin with: the system shows the project and the
session, and what it waits on. The chime is off to begin with: a short,
quiet tone, played once as it is turned on. Each is kept with the rest of
the settings.

## An agent changing them

An agent can read the settings and ask to change them, with two tools the
workbench offers it alongside the others in [hooks](hooks.md). They are for
when the user asks the agent for a change to the workbench itself, a darker
appearance or a chord of their own, and the agent is told so.

Reading answers at once, with every setting, what it takes, and the chord
of every action. A change names only what should change, and the agent may
give a reason in the user's terms. It is checked whole before the user
sees it: a value a setting does not take, an action that does not exist, a
chord two actions would share or one the agent's terminal needs, and the
agent is told why without the user being troubled. The agent hooks, the
plugins, the accounts, which workflow a project follows, how long past
sessions stay listed, how long a project stays active, the notifications
and the chime are refused outright, as the user's to change.

A change that will do is put to the user over the agent pane: who is
asking, the reason, and each setting from what it is to what it would be.
Nothing changes unless they allow it, and the agent waits for the answer,
which says which it was. A change the user allows can be undone, from a
word where the question was, for twenty seconds; undoing puts back only the
settings that change moved. Changes asked at once are put one after
another, each read against the settings as they are by the time it comes
up.

An agent can add a workflow, replace the one of the same name, delete one,
and name the workflow new sessions start with, or none. It reads the
workflows with the other settings, as they are stored, with what each
field takes. A workflow it writes is checked whole against the rules under
[workflows](#workflows) and read strictly, so a field the shape does not have
is refused. The user is shown the workflow as one line each from and to: the
orchestrator's model and then each step with its models, when a review
passes the work and its limits. The agent also reads the workflows the file
holds but cannot use, each with the rule it breaks and as it is written, and
writing a workflow under one's name mends it: it takes that one's place, with
the default and the project choices that named it. Deleting one also shows each project that
chose it and would follow the default again. The change is planned again
when the user allows it, against the workflows as they are by then, so
edits made in the settings meanwhile stay; if what it would do has changed
since it was shown, the user is asked again about what it now does. If it
cannot be kept the agent is told so and nothing changes. Undoing puts back what the change touched: the workflow
written as it was, or away if it was new, one deleted where it stood with
the projects that chose it, and the default.

An agent can also save a theme of the user's own, for a look the palettes
do not give, and switch to it in the same step. The theme is checked the
way the file is, and for being readable: the ink needs a contrast of 4.5 to
1 against the surface and the background in either appearance, and the
accent 3 to 1 against the surface, or the agent is told the ratio that fell
short. The user sees the theme as a small card on its ground for each
appearance before allowing it, and undoing takes the theme away again with
the palette it replaced.

An agent can give the palette in use a [background](#background), or the
palette the same change switches to, or take it away, and can save one
with a theme. It writes the colours as hues and how much colour each has,
with the harmony, the strength and the grain, and the window works out how
light it paints. The user sees the palette's cards standing on the
background before allowing it, and undoing puts back the one it replaced.
A theme saved again without a background keeps the one it had.

An agent can write the stylesheet too, for a change the settings and a
theme cannot make. It replaces the sheet whole, is held to the same rules
before the user is troubled, and is shown to the user as the sheet itself;
allowing it writes it and turns custom styles on. Undo puts back the sheet
it replaced. The agent reads the sheet there with the other settings, and
is told to aim at the stable parts named in the section above.

The settings an agent changes are those of the machine the window runs
on, whichever machine the agent runs on.

## Where they are kept

The appearance, the look, the palette, the fonts, the chords, the answer
on hooks, the accounts, the workflows and the projects' choices among them,
how long past sessions stay listed, how long a project stays active, the
notifications, your own themes, the backgrounds and the cards' shares are kept for the machine, in `settings.json` under `~/.agent-workbench`, and every
window on the machine follows the same file.
The window reads it at start and hears of every change to it, whether made
in the settings, by another window, or by an edit to the file itself, which
reaches an open window at once. A value in the file that the app does not
know is passed over and the default stands for it in the window, and the file
keeps it as written until that setting is chosen. A field that is not a
setting at all is kept in the file as written and not shown.

The keys, the hooks, the accounts, the themes, the backgrounds, the cards' shares and the workflows are read one
entry at a time. An entry that does not read, a chord that is not a key, a
choice that is neither on nor off, an account with a directory that is not a
path, a theme with a colour that is not hex, a background with a colour past the
rim of the pad, a workflow that breaks a rule, is
not used and costs nothing else. The file keeps it as written through every
save, until a change names that entry again or replaces the whole setting it
belongs to. A choice that names such an entry is kept with it: the palette
naming a theme that is not used, or the account every project uses naming an
account that is not used. The window shows the default in its place, and the
file keeps the choice until another is made. The tab of the setting says
which entry is not used and the rule it breaks: the keys tab for a chord, live
updates for a hook choice, accounts for an account, the colour section of
appearance for a theme or the palette, and its background section for a
background. A value that is not used is named in
the section of its setting. Workflows say so in their own tab, as
[workflows](#workflows) describes. A setting that is not the shape it should
be at all is kept whole in the same way.

A read finds the file in one of three states: there is none, it is whole, or
it is there and cannot be read, because it is empty, cut short or not
settings at all, or because the app is not allowed to read it. A file that is
not there is the defaults, and the window hands over the copy it keeps. A file
that is not readable is not the defaults: the window keeps the settings it
has, hands nothing over, and takes the file once a whole one is announced. A
whole file is announced when it differs from what was last announced, and also
when the look before it found the file unreadable, so the same content written
again after the file was emptied still reaches the window. The window's first
read is passed over only when it has already taken settings that are as new
or newer, from news or from the answer to a change of its own. News that
arrives while a change of its own is on its way is not taken then; it is kept,
and taken if that change is refused.

Some editors save by moving the old file aside and writing a new one, and
restoring a copy by removing the file and copying the other in does the same,
so the file is missing for a moment. A file that was there and is found
missing is looked at again a quarter of a second later, and only if it is
still missing is every window told it is gone. A window that hears this, or
that finds no file at start, hands over the settings it holds, with the
entries it knows the file held and did not use. The hand-over is read a setting
at a time, the way a file is, so a value the app does not accept is set aside
and kept as written in the file while the rest is handed over. The hand-over is
written only if the file is still missing when it is about to be written, and
it is put in place in a way that never replaces a file; a file that is there
by then is what stands, and the window takes it. Changes made in the window before its
first read is answered, or while it hands over, wait, and are laid over what
the read or the hand-over left. Once the windows are told the file
is gone, a change that is not a hand-over is refused until a hand-over has
been written or the file is back, so nothing is laid over the defaults in its
place.

A change builds on the file as it is. If the file is not readable, or is
missing after it was there, the save looks again a few times, forty
milliseconds apart, since whatever writes a file by emptying or moving it
first is usually done within moments. If the file is whole by then, the change
is laid over it. If it is still not readable, nothing is written, the file is
left as it is, and the change is refused with a reason that says what is
wrong and where the file is: that it is empty or not valid settings and needs
mending, or that the app is not allowed to read it. A hand edit under way is
never written over with the defaults. A change that still finds the file gone
is refused as well, and the windows are told it is gone. Just before the new
text is moved into place the file is looked at again, and a file that was
edited since it was read is read again and the change laid over it, so a hand
edit saved during a write is kept.

A refused change is shown over the window, wherever it was made, with the
reason, until another change is kept or it is dismissed. The window goes back
to what is stored and says which it shows: the file when it can be read, and
otherwise the last settings that could be read from it. A change an agent
asked for waits for this, and the agent is told which of the settings it asked
for were saved and which were not, with the reason. Turning custom styles off
from the app's menu shows a failure in a dialog.

The app writes the file whole: the text goes to a new temporary file beside
it, any temporary file left there by an earlier run being removed first, so
the settings file is never written into in place. The text is flushed to disk
and is moved over the settings file, or put in its place when there is none,
so anything reading the file, the app's own watcher included, finds the old
settings or the new.
A settings file that is a link stays a link: the write goes to the file it
points at.

The window keeps a copy of its own as well, so the first frame of a start is
painted as the last one was before the file has been read. On a machine
without the file, that copy is what the file is first written from.

The plugins keep their own record, described in [plugins](plugins.md). A
window on a remote machine's project still follows the settings of the
machine the window runs on.
