# The orchestrator

An orchestrator is a session that starts and steers other sessions. It is a
session like any other, in a terminal or integrated, and you talk to it
the way you talk to any agent. What it has that the others
do not is a set of tools for the sessions around it: it can see the open
projects, start a session in one of them with a prompt, send a running
session a line, wait until one of them stops or asks for something, read
what one has on screen, and stop them.

It runs in a project of its own, `orchestrator` under the workbench's home.
The first one starts from New orchestrator session, in the menu on the
sessions pane's title row; from then on the project sits above the ones
you opened, with its sessions and the past ones to resume, and a session
started there is an orchestrator. Its header's button starts another, and
with more than one agent installed it opens the choice of agent, as any
project's does. Nothing else about it differs,
except what it is told: an orchestrator is told to direct work rather than
do it, to start a session per piece in the project it belongs to, on a
worktree of its own when pieces touch the same files, to wait on them rather
than ask after them in a loop, to put the user's whole task in the prompt it
starts a session with and none of its own housekeeping, and to leave a line
on its own row when it stops, whether to relay a question or to report.
A session that follows a workflow is an orchestrator as well, in whatever
project it runs: it is told the same, and the workflow besides, as
[following a workflow](#following-a-workflow) describes. Every other
session has the same tools and none of the nudge. Every session, the
orchestrator included, is told that once it has started sessions it keeps
calling `wait` until all of them are done, and does not hand its turn back
while any is running unless it needs the user, and that a message from the
workbench, not the user, is what those sessions did while it was idle.

## The tools

The seven tools reach the workbench through the same tool server the app's
own tools use. The orchestrator's own directory carries them whatever the
projects were told about live updates, and so does a session that follows a
workflow, which is pointed at the server when it starts where its
project's configuration does not point at it already; any other session has
them where its project's hooks are on. See [hooks](hooks.md) and
[agents](adapters.md#under-a-workflow).

`projects` lists the open projects, the caller's own marked, so a session
names a project the app actually has. `sessions` lists the sessions the
caller started, each with its id, its project and worktree, its agent, what
it is doing and the last line it left. A session that has stopped, ended or
asked for permission without the caller having been told says so beside
what it is doing, and listing it counts as telling. `start` starts a
session in a project with a first prompt, on a worktree of its own if it
asks for one, and answers with the new session's id and tells it to keep
calling `wait` until every session it started is done. `send` types a line
into a running session, and Enter after it on its own, as a person does. A
long line goes in as a paste when the session's terminal has asked for
paste, and in small pieces a moment apart when it has not, so the agent
takes it whole either way. Its Enter follows on its own, later the longer
the line is. A session that runs integrated is sent the text as a message,
whole, as the user's own is, and one sent while it works waits for its
turn.
`wait` sits until a session stops working, asks for permission or ends, or
until the seconds it was given run out. The tool server counts those
seconds from before the window heard of the call, and the call carries a
time a moment before the tool server stops reading; the core leaves no
answer past it. A stop a wait answers with counts as
told only once the answer is left where the call reads it, so one that
comes too late for the call is still untold, and the next wait answers
with it. The window answers that nothing happened two seconds early, or
halfway through a wait of four seconds or less, so that answer is in time
as well. A stop is told once: the wait that
answers with it and a listing that shows it each count, so a session that
stopped between two waits is answered by the next one at once, and one that
went back to work in the meantime is waited out as usual. A wait over all
of a caller's sessions answers first with a stop the caller has not been
told of; a session that ended or asked, and was told so, is answered again
only when none of the others is still running. A wait the agent gave up on,
because the user interrupted it or the agent itself is gone, ends without
telling anything; what the user's message says instead is under [when the
user writes to it](#when-the-user-writes-to-it). `read` answers with the
last lines on a session's screen, as you would see them, whether or not it
has ever been on screen; for an integrated session, which has no screen,
with what its agent last said and did, a line for each step, and what it is
doing or waiting for now; each message in it, and each that waits for the
turn, is said to be the user's or the session's that sent it. A message one
session sends another shows in that session's thread under the sender's
name, never as the user's. `stop`
stops a session and files it with the earlier sessions to resume, behind
their row, rather than leaving a row of it under the project.
A session `start` starts runs in a terminal or integrated as the
agent's own setting says, and every tool acts on it either way; what an
integrated session cannot do when it is not running, such as take a
message, the answer says, with the way to start it again.
A start can carry a name for the work, which the
session's row and its worktree take; a name the project already has is
numbered rather than refused, so the same work twice is fix-it and fix-it-2.
The row takes the name cut to 60 characters, and not at all when it would
pass for the user, the workbench, an agent or another session (see
[sessions](sessions.md#integrated-sessions)); the answer says which.
A worktree it starts in is trusted where its project is, with either agent,
so nothing asks on the way in. It has the project's hooks when the project
has them on, so `sessions` and `wait` follow the agent's own word for what
it is doing there as they do in the project, except for a project that is
a folder inside its repository; see [hooks](hooks.md). A start can also
name a model, which goes to the agent on its command line and holds from
the session's first turn, so an orchestrator chooses the model for a piece
of work when it starts it rather than sending a model command afterwards.
A model's name belongs to one agent, so a start that names a model names
the agent too, and one that leaves the agent out is refused rather than
given the project's last.
A start can name an account, by the name it has in the settings, for work
the user asked to have done under a particular login; one that names an
account there is not is refused with the names there are. A start that
names none runs under the account of the session that started it when that
account was chosen for the starter itself, which is when it is not the
account of the starter's project; the agents' own, chosen that way, is
handed on like any other. A starter that runs under its project's account,
or under the one for every project, hands nothing on, and the session runs
under the account of the project it starts in. The project's account is
used as well when the starter's chosen account cannot be handed on: when
the project is on another machine than the starter, where the starter's
login may not be, and when the account is no longer in the settings. An
account handed on that keeps no directory for the agent being started runs
that agent on its own directory, as a blank directory does anywhere. A
session resumed comes back under the account it ran under.

## Who is calling

Every session the workbench starts is given a token as it starts, chosen by
the workbench, in its environment as `WORKBENCH_SESSION`. The agent passes
its environment on to the tool server and its hooks, so every call they
make carries the token, for Claude Code and Codex alike, in a terminal or
integrated, here or on another machine. A Codex session carries it from its
first call, before Codex has told the workbench its own id. The starter is
the session whose token the call carries, and two sessions in one directory
are two starters, each with its own sessions, its own standing answers and
its own cap.

A session resumed has the token it had, kept by its agent's id, between
runs of the app too, so it is the same starter as before. The agent's own
id is what it is resumed by, and what the tools name the sessions it
started by; no tool answers with a token.

A call whose token names a session the workbench is not running, one it
never had or one that has stopped, cannot come from one of its sessions,
and every one of the seven tools refuses it, with the reason, asking
nothing.

A call that names no session is taken for one from an agent the workbench
did not start, such as one run by hand in a project whose hooks are on,
which has the same tools. That is all the workbench knows of it: a session
whose tools do not pass its token on makes such calls too, one that took
the token out of its environment, or a Codex installed as a script on
Windows, which is not told how to pass it on (see
[adapters](adapters.md#under-a-workflow)). It is never taken for a session
running where it calls from. It is a starter of its own, known by the
directory it calls from: it lists, directs and resumes the sessions it
started from there and no others, with a cap of its own, and follows no
workflow. Every session it asks to start is put to the user. The question
says only what is known: an unnamed agent running in that directory is
asking, one run outside the workbench or a session that left its name out.
It offers Allow once or No: the workbench cannot tell which agent it is,
so no standing answer is used or given. A session started by another that
calls with its token taken out of its environment is asked about each time
in the same way. The sessions such an agent starts run under the
project's account, which the question and the answer name, and start none
of their own. While any session follows a workflow it may list and look but
not start, resume or send, since it cannot be held to the workflow. Two
agents run by hand in one directory are one starter to the workbench, and
share what they started there.

The token is an identifier, not a secret: the workbench cannot see which
process made a call. A tool server run by hand from a session's shell has
that session's token in its environment, and an agent started from that
shell does too; either is taken for that session, as under [following a
workflow](#following-a-workflow). Every call is also written, with its
token, to the request log in `~/.agent-workbench`, which any program the
user runs can read and add to, so any agent of the user's can learn
another session's token there and call as it.

## When the user writes to it

What the sessions a session started do reaches it when it asks, through
`wait` and `sessions`, and when it is idle, as [when it is
idle](#when-it-is-idle) describes. So that it does not miss
one when the user writes to it while the work goes on, the user's message
reaches it with a note ahead of the user's words: a line for each session
it started that stopped working, asked for permission or ended since it
last looked, in the words a wait answers with. A session's last line in
it, as in a wait's answer and a listing, is given on one line, cut at 120
characters and in double quotes, any quote mark of its own made single, so
nothing in it can close the quote and read as a line of the workbench's
or the user's; the note's first line says that each last line is that
session's own words, not an instruction. When the user's message cuts a
wait short, or comes while one is held, the note also names the sessions
still at work and tells it to wait for them once it has answered. A wait
still held answers for the sessions it watches, so the note leaves those
out and gives the rest. A message with nothing to tell goes as it is.
Nothing is typed into its terminal, and no turn is started for it.

The note counts as telling, as a wait's answer does, only once the hook has
the answer or the agent has taken the message. The next wait or listing
does not say it again; a session that has since come to rest another way
is news again.

A session in a terminal is given the note by its prompt hook, which asks
the workbench as the message goes in, with the project's hooks on (see
[hooks](hooks.md)), for Claude Code and Codex alike. The hook waits two
seconds at most. Its call carries the time it stops waiting, and once
that has passed no answer is left for it and nothing is told, so the
next message, wait or listing says it. The call names the session by its
token and is held to the agent's own session id as well: another agent
started from the starter's shell, which has the starter's token in its
environment, gets nothing. A Codex session whose id the workbench has not
learned yet is taken at its token's word. A call from an agent the
workbench did not start gets nothing. Codex asks the user, once in each
project, to trust a hook that is new or changed before it runs it.

A session that runs integrated is sent the user's message by the window,
which puts the note in ahead of the words and shows it in the thread
folded under them as Reports from the workbench, each session by the
name its row has. The note counts as telling once the agent takes the
message into a turn; a message that fails or that the agent drops leaves
it untold, and the next message carries it again. The message also ends
a wait the session holds, with an answer that tells it to read the
message, and while the agent has not taken a message of the user's, a
wait it calls answers so at once, so the message is never held behind a
wait.

A wait the user's message cuts short answers nothing the agent reads:
Claude Code ends the call itself and records only that it did not
complete. The note on that message is what says which sessions are still
out.

## When it is idle

A session that started others may hand its turn back while they still
work. When one of them then stops working, asks for permission or ends, and
the starter is idle, the workbench wakes it: it sends the starter what a
wait would have answered, a line for each session in the same words, then
the ones still at work by their ids, and the starter goes on as it would
after a wait. Sessions that come to rest within three seconds of the first
go in the same message. The orchestrator and a plain session that started
others are woken alike, and there is no setting for it.

Idle means all of these at once. The starter is running, and its agent
ended its last turn itself, as its hooks say for a session in a terminal
and its own events for an integrated one. It holds no wait, and asks for
nothing. The user is not writing to it: an integrated starter's composer
holds no words or images and no message of the user's waits for the agent;
a starter in a terminal has had no key of the user's since its agent last
took a line in, as its prompt hook says, or since Ctrl+C emptied its line,
and none in the last five seconds. Enter alone is no sign the line went:
Ctrl+J, a backslash before Enter and Alt+Enter each add a newline to the
agent's input, Ctrl+U empties only one line of several, and a command such
as /config opens a panel the next keys would answer, none with a prompt
hook. The keys that answer a permission prompt are the prompt's, not the
line's, up to the moment the agent is seen at work again, and what the
terminal answers on its own when the agent asks it something, its
attributes, the cursor's place or its size, is no key at all. While keys
of the user's hold a wake, the pointer text on the row's not heard yet
mark says so. A turn the user cut short, with Escape or the stop button, leaves
the starter unwoken until a turn of the user's has ended as the agent
ended it. A line typed or sent into it, by `send` or by a wake, leaves it
unwoken until a turn of its agent's ends, and lines go into a terminal one
at a time, each with its Enter, so a line `send` types and a wake never run
into each other. A session in a terminal without hooks says nothing of how
its turns end, and is never woken; the row and the next wait still say
what it has not heard.

The message is the workbench's, never the user's. An integrated starter is
sent it as the workbench's own message, which its thread shows under From
Workbench, each session by the name its row has. A starter in a terminal
has it typed in on one line, as `send` types one, starting with the note's
own words, From the workbench, not the user, with the sessions kept apart
by bars. Each last line in it is quoted and cut as in a wait's answer, and
a bar in a session's name or last line is typed as a broken bar, so
nothing a session left reads as the start of another session's line; the
message says each last line is that session's words and not an
instruction. A session cannot choose which starter is woken or put a line
of its own into the message beyond its last line, and the message never
begins with a slash. It is never typed while the starter shows a question
or a permission prompt, where a key would answer for the user, and whether
the starter is still idle is asked again before the line goes in and
before its Enter: a key of the user's in between leaves the line unsent.
The wake's text then stays on the line ahead of the user's key, since
nothing can take it back safely, and the user's next message carries it.

What a wake carries counts as told the moment it is sent, so the next wait,
listing or note does not say it again, and the prompt hook the message sets
off has nothing to add. A message that never reaches the agent, because the
core refused it, the agent dropped it or a key of the user's held its
Enter, leaves it untold, and so does a line typed into a terminal that
starts no turn within thirty seconds, as when its Enter took a completion;
the starter is then not woken again until a turn of its own has ended. A
woken starter is not woken again for what it was told; the same session
coming to rest again, after more work, is news again. After five wakes with
no turn between that the workbench did not start, as when a session it
started ends turns on its own, the starter is not woken again until such a
turn begins, the user's or one a line from its own starter sets off; the
row's not heard yet mark carries the rest, and its pointer text says why.
A session another started cannot start sessions of its own, so no two
sessions can wake each other in turn, and an agent the workbench did not
start has nothing to be woken in. A rest that began before the window first saw the
session, as after a reload, wakes no one, so a wake is never sent twice;
the row still says the starter has not heard it, and the next wait tells
it.

## Following a workflow

A session runs one of two ways: under a workflow, as its orchestrator, or
as one agent with no workflow. What the user picks is what starts. Picking
an agent, in the agent pane, in a project's new-session row or in the
palette, starts that agent alone. Picking a workflow, in the palette or in
the choice a project's new-session row opens, starts its orchestrator, on the workflow's agent and model, and a plain new
session where there was nothing to pick follows the project's workflow, as
[settings](settings.md#workflows) describes. A workflow whose
orchestrator runs on an agent that is not installed is refused on the row,
and so is a session under a workflow on a machine with no tool server to
give it the `start` tool.

An orchestrator runs in a terminal or integrated, as its agent is set, and
is held to its workflow the same way in either. It is told the workflow's
instructions and, unless the workflow says otherwise, has its agent's own
ways of handing work to agents the user cannot see taken away, so every
piece it hands out is a session of its own started with `start`.
[Agents](adapters.md#under-a-workflow) says what each agent loses and what
remains. What a session is held to comes from the workbench's own record of
it, found by its token. Nothing a call says, such as a step, a workflow or
a role in its arguments, changes that, and a session another started
cannot start one of its own however it runs.

Each start from such a session names the step of the workflow it is for,
and is held to that step before the user is asked anything. A start that
names no step, or one the workflow does not have, is refused with the
steps there are. A start that names an agent or a model the step does not
allow is refused with the ones it does; one that names neither runs on the
step's first model, and one that names only the agent on the first of that
agent's. A session started for a step stays on the model it was given:
`send` gives it no command but `/compact`, since commands such as `/model`
and `/fast` change the model and either agent completes a command from the
start of its name, and a start or a resume for a step does not begin with
one either. A line counts as a command where it begins with a slash once
characters that draw nothing are passed over and a wide slash is read as a
slash, so one that begins with a path is refused too, and says to put a
word before it.

A work step runs no more sessions at once than it says. A start past that
is refused with the sessions running for it, and so is a resume: a session
that has finished its piece is stopped to make room, and a stopped one can
be resumed later. A session whose step the workflow no longer has, because
the step was renamed or removed since, is not resumed, nor is one that was
not started for a step of the workflow, such as one a plain session in the
same directory started; the refusal names
the steps there are. A start takes its place in the step, or its round of a
review, the moment it is checked, before the user is asked, and gives it
back when the user refuses or the session does not come up, so two starts
at once cannot both find room or share a round.

A review names the session whose work it checks. One that names none, or
names a session the caller did not start for a work step, is refused: there
is no work behind it. A piece is named by the work session that began it;
a start for a later work step can name the session the piece came from,
and carries the piece on. A piece that does not pass is sent back with
`send` to its own session for the step the review goes back to, resumed
first if it was stopped, and is reviewed again by a new review naming the
same work or by a line to the reviewer.

The workbench counts the rounds of each review for each piece: a review
started, a review resumed with a prompt, and a line sent to a review that
has finished its round each count one. A review resumed with no prompt has
not finished a round since it came back, so the first line it is sent
counts its round. A review may run once and then once
more for every time it may send the work back, so a review that sends it
back three times at most has four rounds of a piece. A round past those is
put to the user through the same question a start is, worded as another
round of review for that piece; the user's yes lets that one round through,
and a no tells the orchestrator, by the work's name and its count of
rounds, to ask the user how to go on; the user's own no is not shown back
to them as a refused start. Another piece
has rounds of its own, and stopping a session does not reset the count. A
fresh piece is not checked against the others, so work started again as a
new piece begins its rounds again.

A started session remembers its step, and a review its round and the work
it checks. `sessions` says both for each session, the stopped ones too.

A call is held to the workflow of the session its token names, as under
[who is calling](#who-is-calling), so a Codex orchestrator is held to its
workflow from its first call, and a session beside it in the same
directory is held to its own. A caller under a workflow is given no
command but `/compact` in a line to any session it started, placed in the
workflow or not.

What this holds to is the session a call names, and the workbench cannot
see which process made the call. A tool server run by hand from a
session's shell has that session's token, or can be given another running
session's, and is then taken for that session: held to its workflow when
it follows one, and its starts asked about as that session's are. One
given no token is taken for an agent the workbench did not start, which may
not start or send while a session follows a workflow. This is no wider than the shell
itself: from it an agent can run another copy of itself, on any model,
with no tool server and no question at all.

## What is remembered

What a session started is written down under the starter's token, or for an
agent the workbench did not start under the directory it called from, each
by its session id, with the project, the worktree, the agent, the name and
the account, and kept between runs beside the sessions the app knows as its
own. Under a workflow, so are the step and round of each, and the rounds
each piece has had; those go with the orchestrator once it is gone from its
project's past sessions, and so does its token. An orchestrator closed and
resumed keeps its token, so the sessions it started are still its own: the
ones still running answer to its tools as before, and a row with one of its
ids, resumed from the pane by hand, hangs under it all the same. When the
app itself was closed, the orchestrator comes back with the other sessions
that were open, and the sessions it started do not. `sessions` then lists
them as stopped, after the running ones, and `start` with one of those ids
in place of a project and prompt brings it back where it ran, in its
worktree with its conversation. A prompt given with it is what the session
goes on with; without one it comes up waiting for a line. The cap and the
one-level rule apply, and a session whose worktree has since been cleaned
up, or whose project is no longer open, is refused with the reason. A
session the orchestrator stopped itself is not offered back: the stop said
it was done with. The record lives with the window's other memory, so a
wiped local storage forgets it, which only means the orchestrator starts
afresh.

A session it starts is asked, at the end of its prompt, to leave a line on
its row when it is done or stuck, so the pane, the board and the wait tool
all say how it went.

The tools act on the sessions the caller started and on no others. A
session you started yourself is yours, on a subject of your own: another
agent cannot type into it, stop it, read it or so much as list it,
whatever it has been told to do by something it read.

## What the user is asked

The first time a session asks to start another in a project, the window
puts the question up over the agent pane and holds the call until it is
answered: allow it from now on, allow this one, or refuse. A round of
review past a workflow's limit is asked about every time, however the
project was allowed. It says the project the round runs in, then names the
review and the work by the names the user sees, "Review has run twice on
Fix the cache, as many times as the workflow allows. Allow another round?",
with Allow one more round or Stop at the limit. For a caller that runs
integrated, the round docks over its composer while its conversation is on
screen, with the same two choices taken as the dock takes any request (see
[sessions](sessions.md#integrated-sessions)), so it never covers the
header that says where the run stands; anywhere else it is put over the
agent pane as above, and it moves into the dock once the caller is on
screen. An allowed caller is
remembered for that project and what the session ran on, for as long as the
app runs: the account, and the agent too where the account keeps no
directory for it, since that agent then runs on its own. A later start
there under another account, or under the same account by an agent it keeps
no directory for, is asked about again. A refusal is an answer the agent
reads, not an error. Bringing back a session it already started is never
asked about: the consent was given when the session was, and the resumed
session is that one going on. A start an agent the workbench did not start
asks for is asked about every time, with Allow once or No, as under [who is
calling](#who-is-calling).

Once there are accounts to tell apart, the question names the account the
session would run under when it is not the project's own, when the
starter's chosen account could not be handed on, when an account handed on
keeps no directory for the agent being started, and for an agent the
workbench did not start, which hands none on. When the account it names
keeps no directory for that agent, it says the agent uses its own. A round
of review that would start a session names the account in the same cases,
after the project. The answer the caller gets to its start names the
account in the same cases and says when the agent uses its own directory,
for a start for a step of a workflow as well as any other.

A session started by another may not start any of its own, and no session
may have more than eight running at a time. Both hold by the token, so a
session started by another is held to them from its first call, whatever
its agent. An agent the workbench did not start has a cap of its own, by
the directory it calls from.

![The question over the agent pane: which session wants to start one, in which project, the prompt it would give, and Allow this session, Once or No.](orchestrator-ask.png)

## In the panes

The agent pane's header says where a session stands in its workflow,
right after the title and in the header's own type, the same for a session
in a terminal and an integrated one.

For the session that follows the workflow it is a chip: a pip for each step
in order, grey once the run has passed it, in the accent where the run
stands and empty for a step to come, and the words for where it stands.
The chip says what the workbench knows and no more.

Before anything is started the words are the workflow's name, marked
deleted where it follows the copy it kept. Then they name the step where
the work stands, with its round where it has one, "Review, round 2 of 4",
and with pieces of work in different steps, how many stand in each, "1 in
Work, 1 in Review". A piece stands where a session of it is at work, or
else where its latest session came to rest. With pieces at work the chip
names their steps; with none, the steps the pieces rest in. A piece that
never reached the work a review checks, such as a plan the orchestrator
did not carry on into the work, is left out once another piece has.

The workbench never learns whether a review passed. Once every piece has
finished a round of the last step and nothing is at work, the orchestrator
included, every pip is grey and the words say the round that finished,
"Review, round 2 of 4 done", or how many pieces finished it, "2 done in
Review". They never say the run is done.

A round is finished only when the workbench saw its session come to rest
after a turn of work. That is remembered with the run, so a session the
orchestrator stopped once it was done, or one that is not back after a
restart, is still done. A session that crashed reads stopped. One that
ended or was closed while at work, or before it was seen to rest, reads
ended. Neither has finished its round, and the chip names its step
without saying done.

While a round past the limit waits on the user the chip turns to the
accent and says so, "Round 4 of 4 done, asks you", with the step of any
piece still at work lit beside it. A piece the user stopped there, with
Stop at the limit, reads "Stopped at round 4 of 4" in the chip's own ink,
its review lit, until another round of it goes ahead. A screen reader hears
the same, with each step done, skipped, now or to come; a step passed with
nothing run for it, as when the orchestrator did it itself, is grey and
said to be skipped.

A popover under the chip says what stands in each step: the latest session
of each piece there, by its name, with its round and whether it is
working, asking, done, stopped, ended or stopped at the limit, and the
name opens that
session; a step passed with nothing run for it says skipped. The rules the
orchestrator was given are folded at its foot. It shows when the pointer
rests on the chip, and a click, Enter or Space holds it open, the one the
pointer showed as well, with Tab going on into it; a second click puts it
away. Escape, wherever the keyboard is, or a press elsewhere puts it
away without reaching the agent, and Escape gives the keyboard back to the
chip when it was in the popover.

A round is one pass of work and review. A review's round is counted as
under [following a workflow](#following-a-workflow). Work its piece goes
back to once that review has come to rest, by a line, a resume with a
prompt or a new start that carries the piece on, goes on in the next
round, so work sent back once reads "Work, round 2 of 4". A line to the
work while its review is still at it, such as an answer to the review's
question, is no round of its own. The workbench cannot tell work sent back
from a line after a review that passed, such as one asking for a commit,
so that too reads as the next round. Work the user stopped at the limit
goes on in the last round, never past it, so it reads "Stopped at round 4
of 4" again once it rests. The most counts the first pass: a review that
sends the work back three times at most has four rounds. A
round of work is remembered with the run, as a review's is, and so is a
stop at the limit.

A session started for a step has a quiet tag in the chip's place: the
workflow and its place, "Review, round 2 of 4". Its rules open in a popover
under it the same way: what the step allows, in the words of its settings,
the models it may use, how many sessions it runs at once, and for a review
when the work passes, and where and how often it sends the work back, and
Escape puts it away wherever the keyboard is, without reaching the agent.

Where the header is short of room, a tag's workflow name is cut short and
then left out, then the header's status, and the place, or the chip's
words, stay whole until both have gone; only then are they cut short, and
they go at a letter or two. The chip's pips stay until the title has given
way, and the words take no room once gone (see [layout](layout.md)). A
start the workflow refuses its
orchestrator is shown over the terminal in one line, whole while the
pointer or the keyboard is on it, as well as answered to the agent, until
a start goes through or the line is put away.

The sessions a session started hang directly under it, one line each,
joined to its dot by a thin rail: the state dot, the name, the model it was
started on and when it last changed. A session started for a step of its
starter's workflow shows its step there instead of the model, since the
step chose the model, with its round of the most in short, "Review, 2 of
4", kept whole while the name is cut. One
that runs under another account than its project's names the account after
its own name, as in `as Work`, and one that runs in another project than
its starter names that project next. Short of room, the project is cut
first, then the model is left out and the project with it, then the
account, and the name is cut last; the time, the step and asking always
stand. The line speaks
up in the accent, `asking` where the model stands, when the session needs
a permission, which only you can grant. A starter that runs integrated
also holds that request in its dock, to be answered there for that session,
or for one in a terminal with the way to it (see
[sessions](sessions.md#integrated-sessions)). Everything else they wait on, the
starter hears, so the place to go is still the starter and not the
session it started. A session whose starter the window no longer has
stands in its own project like any other.

In an integrated session's thread, the sessions a turn started stand as
rows under it: the state dot, the step it was started for, the name, its
round of the most and what it is doing, "round 2 of 4, working", the model,
and Open, which goes to it.

A starter's second line says in words what the sessions it started are
doing, each counted once, `2 running, 1 asking, 1 done`, unless its agent
has left a line there. While the starter is idle and holds no wait, the
line also says how many of them stopped, asked or ended since it last
looked, `2 not heard yet` where the model stands, in the line's own colour
with a small mark in the accent, and the line of each such session carries
the same mark at its end, which a screen reader hears as not heard by the
starter yet. The pointer resting on it names the starter, which sessions
and how it hears of them: on its next wait, or with your next message
where it gets the note. It is the starter's to read, not yours to answer,
so it marks nothing unread, and it goes once the starter is told. Once the
workbench has woken the starter, the same place says what woke it, `woken by
Fix the cache`, or `woken by 3 sessions` when there were more, quietly in
the line's own colour, and the pointer resting on it says what each of
them did. It stays through the turn the wake began and after it, and goes
when you look at the starter once that turn is over, as the line a row was
left does, or when a turn of yours begins. Short of room it gives way
before the line beside it, down to "woken by" and the first letters of the
name, and only then is the line cut; how many sessions woke it is never
cut. Once the workbench has stopped waking the starter, after five wakes
in a row, the pointer text on its not heard yet mark says so. Short of
room it gives way before anything else on the line: the words go, then
the mark and the count, and what the sessions are doing stands, asking
included. On a started session's line the mark is the first thing to go. A
starter can be folded, from the chevron at the end of its second line or
with Left on the keyboard, and Right lets them out again: folded, its second
line says what they are doing whatever the agent left, with a small dot for
each where the model stands otherwise. Left on a started session moves the
cursor up to its starter. Nothing about the fold is remembered.

The orchestrator's changes pane, headed Orchestrator, shows the sessions it
started instead
of a file tree: each with its project, its worktree, what it is doing, how
long it has been at it and the line it left, with Stop all on the section's
header. Each row can be stopped on its own, or sent a line without leaving the
orchestrator. Under the list, the projects the orchestrator has been allowed
to start sessions in, each with a way to take that back, and the worktrees its
starts have left behind, with Clean up for the ones whose work is merged and
whose trees are clean; the rest say why they stay.

![An orchestrator on screen with the sessions it started, and the board in the changes pane with a row for each, what it is doing, and the project it may start in.](orchestrator-board.png)

The sessions it started keep out of the keyboard's way too: Delete on one
of them does nothing. Its own × stops it, and Stop all on the board stops
every one.

## Where the work happens

An orchestrator directs; it does not edit. The sessions it starts run in
their own projects, on their own branches when they asked for a worktree,
each with its own terminal and scrollback, and they are sessions you can
open, type in and take over at any point.
