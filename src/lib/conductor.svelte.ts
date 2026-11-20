/**
 * The tools a session gets for directing other sessions.
 *
 * An agent calls them where it runs; the core carries each call to the
 * window as a request and waits for exactly one answer to it. The window
 * is where the projects and the sessions are, so the work and the
 * answering are here. Every answer is plain lines for an agent to read.
 *
 * Starting a session is the one call the user is brought into. A start in
 * the caller's own project, on the caller's agent and account, is the
 * caller's to make. The first time a caller asks to start any other in a
 * project the window puts the question up and holds the call until it is
 * answered, and an allowed caller is remembered for that project and the
 * account its sessions run under until the board takes it back or the
 * window goes. Calls that arrive while a question is up wait their turn.
 *
 * A session may start others, and those may not start any of their own:
 * one level deep, and no more than the cap at a time, so a loop of agents
 * starting agents cannot run away with the machine.
 *
 * Every session the workbench starts names itself in each call its tools
 * make, by a token the window chose for it and gave its environment, and
 * the caller is the session that token names. A call naming a session the
 * workbench is not running is refused. A call that names none comes from an
 * agent the workbench did not start, which is a caller of its own, known by
 * the folder it calls from: it follows no workflow, and every session it
 * asks to start is put to the user, who is told what is asking.
 *
 * What a session started is remembered between runs, by its token, which
 * a session resumed keeps, so a caller resumed after the app was closed
 * still finds its sessions: the running ones are its to direct as before,
 * and the ones that went with the app are listed as stopped and can be
 * resumed where they ran.
 *
 * A caller that follows a workflow starts sessions in its shape: each start
 * names a step of it, on a model the step allows, no more at once than a
 * work step lets run, and a review of a session that did work. The started
 * session remembers its place, and the rounds of each review are counted
 * per piece of work, up to the most the review sends the work back.
 */

import {
  accountLabel,
  accountOf,
  accounts,
  dirFor,
  dirsOf,
  hasAccounts,
  names,
  namesOwn,
  OWN_LABEL,
} from "$lib/accounts.svelte";
import { agentLabel } from "$lib/agent.svelte";
import { untrack } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { keepMode } from "$lib/sessionModes";

import { core, type ConductRequest, type ProjectInfo } from "$lib/core";
import { HOLD } from "$lib/hold";
import {
  nameTaken,
  named as nameRow,
  readsAsAgent,
  byKey,
  byToken,
  close,
  create,
  disown,
  defaultAgent,
  drafting,
  isLive,
  keepName,
  reopeningRow,
  isViewed,
  keysStillIn,
  label,
  modelLabel as sessionModelLabel,
  onClosed,
  onGiven,
  onDirected,
  onForgotten,
  onMoved,
  onTurn,
  runningByToken,
  sessions,
  spokenTo,
  statusMessage,
  type Session,
} from "$lib/sessions.svelte";
import type { AgentId, ReviewStep, Workflow, WorkflowStep, WorkStep } from "$lib/core";
import { CODEX_DEFAULT } from "$lib/models";
import { hostOf } from "$lib/remote.svelte";
import { forgetNotes } from "$lib/notes";
import { onWentOn, wentOn, wentOnFrom } from "$lib/goingOn.svelte";
import { instructionLines, modelText } from "$lib/workflowInstructions";
import { stepFacts } from "$lib/workflows.svelte";
import {
  placeLong,
  placeShort,
  placeWords,
  roundText,
  summarize,
  type Doing,
  type RunEntry,
  type RunSummary,
} from "$lib/runSummary";
import { screen, takesPaste } from "$lib/screens";
import {
  conversationOf,
  handleOf,
  linkOf,
  notesFrom,
  send as sendIntegrated,
  sendAsWorkbench,
  userWaiting,
  userWriting,
} from "$lib/integrated.svelte";
import { lastRun, nameSessionsBy } from "$lib/thread";
import { logUsage } from "$lib/usageLog";
import { defaultModelOf } from "$lib/lastChosen.svelte";
import { failureOnScreen, type Failure } from "$lib/turnFailure";
import { atWorkLine, OUTCOME_ASK, OUTCOME_ASK_TERMINAL, REPORTS_HEAD, stillOutLine } from "$lib/instructions";
import { nameKeptBy, outsideCaller, outsideFolder, senderOf, startersFrom } from "$lib/senders.svelte";
import { mixesScripts, readsAsWorkbench, readsAsYou, reservedName, shown } from "$lib/unseen";
import { within } from "$lib/show.svelte";
import { handOver, printable } from "$lib/terminals.svelte";
import { projectLabel, workspace } from "$lib/workspace.svelte";
import { startsIn } from "$lib/orchestratorFolder.svelte";
import { kindFor } from "$lib/sessionKind.svelte";
import { startAsk } from "$lib/startAsk.svelte";
import { fitMode, modeName, narrowerOf } from "$lib/modeFit";

/** How many sessions one caller may have running at a time. */
export const CAP = 8;
/** How long a wait runs when the call names no seconds, and the most it
    runs whatever it names. The core gives up on the same clock. */
export const WAIT_SECONDS = 600;
export const WAIT_MAX = 1800;
/** How long a start waits for the new session to come up and say its id.
    Inside the minute the core gives the window to answer. */
export const START_WAIT = 30_000;
/** How much sooner than the seconds it was given a wait answers that
    nothing happened: the tool server counts them from before the window
    heard of the call, and stops reading at their end. A wait never
    answers sooner than halfway through its seconds. */
export const WAIT_EARLY = 2000;
/** How long after a session comes to rest the session that started it is
    woken, when it is idle and nothing else it started is at work: the
    sessions that come to rest meanwhile go in the same message. */
export const WAKE_AFTER = 3000;
/** While others it started are still at work, how long a starter's wake
    waits after the last session came to rest, for more to go in the same
    message, and the most it waits after the first. */
export const GATHER = 30_000;
export const GATHER_MOST = 120_000;
/** How long a starter has rested when its prompt cache has lapsed, by
    agent, so a wake reads its whole conversation again at full price: a
    Claude Code conversation's cache lasts an hour, and Codex's is taken to
    last ten minutes. A cold starter's wake waits until nothing it started
    is at work, and at most COLD_MOST after the first came to rest. */
export const COLD_AFTER: Record<AgentId, number> = { "claude-code": 58 * 60_000, codex: 10 * 60_000 };
export const COLD_MOST = 20 * 60_000;
/** How long the user's keys in a starter's terminal have been still
    before the workbench types into it. */
export const WAKE_QUIET = 5000;
/** What the answer to a start ends with. */
export const KEEP_WAITING =
  "Keep calling wait until all the sessions you started are done, and do not hand the turn back while any is running unless you need the user.";
/** How much of a session's screen the read tool answers with when the
    call names no number, and the most it answers with whatever it names. */
export const LINES = 40;
export const LINES_MAX = 200;
export { OUTCOME_ASK, OUTCOME_ASK_TERMINAL, REPORTS_HEAD };

/** How long after a line is typed its Enter follows. An agent takes a
    chunk that arrives at once for a paste, and an Enter inside a paste is
    a newline in it rather than a send. */
export const ENTER_AFTER = 150;

/** The size in bytes from which a line is not typed in one write. An
    agent's input loses the start of a long run of characters that arrives
    at once, so a longer line goes in as a paste or in small pieces. */
export const PASTE_FROM = 200;
/** The size in bytes of each piece of a line typed in pieces, and the wait
    between them. */
export const PIECE = 64;
export const PIECE_EVERY = 10;
/** The most a line's Enter waits after a paste, which grows with the line
    so the agent has taken the paste in before the key arrives. */
export const ENTER_AFTER_MAX = 1000;

const encoder = new TextEncoder();

/** The line in pieces of at most PIECE bytes, none cut through a character. */
function pieces(line: string): string[] {
  const out: string[] = [];
  let piece = "";
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > PIECE) {
      out.push(piece);
      piece = "";
      size = 0;
    }
    piece += char;
    size += bytes;
  }
  if (piece !== "") out.push(piece);
  return out;
}

/** Writes text into a session's pty whole, without Enter. Short text goes in
    as it is. Long text goes in as one bracketed paste when the session's
    terminal has asked for paste, and otherwise in small pieces with a short
    wait between them, so no markers reach a program that did not ask for
    them. Answers with how long to wait before a key that follows it. */
export async function typeWhole(
  key: string,
  ptyId: string,
  text: string,
): Promise<number> {
  const size = encoder.encode(text).length;
  if (size < PASTE_FROM) {
    await core().write(ptyId, text);
    return ENTER_AFTER;
  }
  if (takesPaste(key)) {
    await core().write(ptyId, `\x1b[200~${text}\x1b[201~`);
    return Math.min(ENTER_AFTER + size / 20, ENTER_AFTER_MAX);
  }
  const parts = pieces(text);
  for (const [index, part] of parts.entries()) {
    if (index > 0) await pause(PIECE_EVERY);
    await core().write(ptyId, part);
  }
  return ENTER_AFTER;
}

/** The line being typed into each session's terminal, by the row's key:
    one line goes in whole, its Enter after it, before the next begins, so
    a line `send` types and a wake never run into each other. */
const typing = new Map<string, Promise<void>>();

/** Whether a line is being typed into the session's terminal. */
export function typingInto(key: string): boolean {
  return typing.has(key);
}

/** Types a line into a session the way a person does: the text, whole, and
    then Enter on its own, after any other line being typed into it. The
    agent has been spoken to, as by a line typed into its terminal. `held`,
    asked before the text goes in and again before its Enter, stops it
    there: the text then stays unsent, and the line fails. */
export async function typeLine(
  key: string,
  ptyId: string,
  line: string,
  held?: () => boolean,
): Promise<void> {
  const ahead = typing.get(key) ?? Promise.resolve();
  const mine = ahead
    .catch(() => {})
    .then(async () => {
      if (held?.() === true) throw new Error("held before the line");
      const wait = await typeWhole(key, ptyId, line);
      await pause(wait);
      if (held?.() === true) throw new Error("held before Enter");
      await core().write(ptyId, "\r");
      spokenTo(ptyId);
    });
  typing.set(key, mine);
  try {
    await mine;
  } finally {
    if (typing.get(key) === mine) typing.delete(key);
  }
}

/** Stops a session another session started, and files it away: it was
    never the user's own to come back to, and a row for every piece of
    work an orchestrator finished would bury the ones that are. The caller
    is done with it, so it is not offered back to resume either. */
export function stopStarted(key: string): void {
  const session = byKey(key);
  if (session === null) return;
  const { project, id } = session;
  const owner = startedFor(key);
  // What the caller's reports said of it keeps its name.
  keepName(session);
  close(key);
  // Stopped for good, it does not go on from its notes.
  forgetNotes([{ project, token: session.token }]);
  if (id === null) return;
  disown(project, id);
  if (owner !== null) forget(owner, id);
}

/**
 * A session another session started is put away by the workbench once its
 * work is over, so finished rows do not pile up under their starter and no
 * agent has to tidy them. Its work is over when it is running, ended its
 * turn itself with nothing left running and no error, its starter has
 * been told so, and nothing of it is open: the user has read it, has it
 * not on screen and has no words in it, it asks nothing, no message waits
 * for it and none is being typed into it, its starter holds no call that
 * names it, and none of the sessions it started itself is at work or has
 * come to rest without its hearing. After `PUT_AWAY_AFTER` of that, unbroken, and counted
 * again from the end of each call that names it, its row closes and goes
 * among the earlier sessions, as a stopped one does, but it stays on its
 * starter's list, and a line its starter sends it resumes it. The time is
 * kept by the window, so a reload counts it again from the start. A row of
 * a session another started that is left from before a restart goes the
 * same way, without being started, unless it was on screen at the quit;
 * one that comes back unread or with words of the user's in it goes
 * `PUT_AWAY_AFTER` after the user has seen it.
 */

/** How long a started session stays at least once its work is over: long
    enough for its starter to answer what it reported while it still runs,
    short enough that finished rows do not pile up. */
export const PUT_AWAY_AFTER = 5 * 60_000;

/** The rows on their way to being put away, by key. */
const puttingAway = new Map<string, ReturnType<typeof setTimeout>>();

/** Rows of sessions another started, left from before a restart, that
    stay until the user has seen them, by key. */
const leftToSee = new SvelteSet<string>();

/** Closes a started session's row and files it with the earlier sessions,
    keeping it on its starter's list: the starter did not say it was done
    with it. The list says the workbench put it away, or for a row left
    from before a restart, that it has not run since. */
function putAway(key: string, done: boolean) {
  const session = byKey(key);
  if (session === null) return;
  const { project, id } = session;
  const owner = startedFor(key);
  keepName(session);
  // A line brings it back in the mode it ran in. An integrated run's is
  // kept as its agent says it; a terminal closed under its agent may not
  // have written its own down.
  const mode = session.kind === "integrated" || session.status !== "running" ? null : (modeNow(session) ?? session.modeNamed);
  if (id !== null && mode !== null) keepMode(id, mode, true);
  close(key);
  if (id === null) return;
  disown(project, id);
  const entry = owner === null ? null : remembered(owner, id);
  if (entry === null) return;
  if (done) entry.left = "done";
  else delete entry.left;
  saveStarted();
}

/** Puts away a started session's row left from before a restart, which
    has nothing running behind it, without starting it. One the user has
    yet to see stays until they have. */
export function putAwayLeft(key: string) {
  const session = byKey(key);
  if (session === null || session.status !== "dormant" || startedFor(key) === null) return;
  if (openToUser(session)) leftToSee.add(key);
  else putAway(key, false);
}

/** Whether something of a row is the user's still: it is unread or on
    screen, holds words they have not sent, or has a line being typed
    into it. */
function openToUser(session: Session): boolean {
  const key = session.key;
  return session.unread || sessions.active === key || drafting(key) || typingInto(key) || userWriting(key);
}

/** Whether a row left from before a restart that stayed for the user to
    see is still left, and has been seen. */
function seenLeft(session: Session): boolean {
  return (
    leftToSee.has(session.key) &&
    session.status === "dormant" &&
    startedFor(session.key) !== null &&
    !openToUser(session)
  );
}

/** Whether a started session's work is over, as far as the rows say: see
    above. What no row says, a call naming it, is asked as it goes. */
function overWith(session: Session): boolean {
  if (session.id === null || startedFor(session.key) === null) return false;
  if (session.status !== "running" || session.working || session.needs !== null) return false;
  if (reopeningRow(session.key) || openToUser(session)) return false;
  const mark = stops.get(session.key);
  if (mark === undefined || !mark.worked || mark.rest !== "quiet" || mark.told !== "quiet") return false;
  if (restWay(session).way !== "done") return false;
  // What it started itself reports to it: it stays while one of those is
  // at work or has a rest it has not heard.
  if (startedBy(session.token).some((kid) => atWork(kid) || untold(kid))) return false;
  return session.kind === "integrated" ? handleOf(session.key) !== null : session.ptyId !== null;
}

/** Whether what a call was given names the session with this id, whole or
    by the start of it. */
function namedIn(given: Record<string, unknown>, id: string): boolean {
  return namesId(given.session, id) || namesId(given.work, id);
}

function namesId(given: unknown, id: string): boolean {
  const start = typeof given === "string" ? given.trim() : "";
  return start === id || (start.length >= ID_START && id.startsWith(start));
}

/** Whether a call of the starter's that is not done names a session: a
    wait on it alone, a read of it, or a line or a resume on its way. */
function calledFor(id: string): boolean {
  for (const request of calling.values()) if (namedIn(request.arguments, id)) return true;
  for (const list of Object.values(conductor.later))
    if (list.some((one) => one.outcome === null && one.same.split("\n").some((line) => namesId(line, id)))) return true;
  return false;
}

/** Sets each row whose work is over on its way to being put away, and
    calls back the ones where something of it opened again. */
function planPutAways() {
  void heard.version;
  for (const key of [...leftToSee]) if (byKey(key)?.status !== "dormant") leftToSee.delete(key);
  const due = new Set(
    sessions.all.filter((session) => overWith(session) || seenLeft(session)).map((session) => session.key),
  );
  for (const [key, timer] of puttingAway)
    if (!due.has(key)) {
      clearTimeout(timer);
      puttingAway.delete(key);
    }
  for (const key of due) if (!puttingAway.has(key)) countFromNow(key);
}

function countFromNow(key: string) {
  clearTimeout(puttingAway.get(key));
  puttingAway.set(key, setTimeout(() => putAwayDue(key), PUT_AWAY_AFTER));
}

/** A row's time is up: it goes if its work is still over, and waits again
    while a call names it. */
function putAwayDue(key: string) {
  puttingAway.delete(key);
  const session = byKey(key);
  if (session === null) return;
  if (seenLeft(session)) {
    leftToSee.delete(key);
    putAway(key, false);
    return;
  }
  if (!overWith(session)) return;
  if (calledFor(session.id!)) {
    countFromNow(key);
    return;
  }
  putAway(key, true);
}

/** A call is done: each row on its way to being put away that the call
    named counts its time again from now, so its starter has the whole of
    it to follow the call up. */
function callEnded(request: ConductRequest) {
  for (const key of [...puttingAway.keys()]) {
    const id = byKey(key)?.id ?? null;
    if (id !== null && namedIn(request.arguments, id)) countFromNow(key);
  }
}

/** Puts away at once the rows among these whose work is over, to make room
    for a start: they were on their way out. */
function makeRoom(rows: Session[]) {
  for (const row of rows)
    if (overWith(row) && !calledFor(row.id!)) {
      const timer = puttingAway.get(row.key);
      if (timer !== undefined) clearTimeout(timer);
      puttingAway.delete(row.key);
      putAway(row.key, true);
    }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The question on screen: which call it holds, who asked, and what for. */
export interface Ask {
  request: Placed;
  /** What the calling session is called, for the title. */
  caller: string;
  /** The folder an agent the workbench did not start calls from, when that
      is what asks: the question says so, and offers this one session or
      none, never a standing answer. */
  outside: string | null;
  project: string;
  /** The prompt's first line. */
  prompt: string;
  worktree: boolean;
  /** For a round of a review past the most the workflow gives a piece: the
      review, the work it checks and how many rounds it has had. The user's
      yes lets this one round through. */
  round: Beyond | null;
  /** What the session would run on, which a standing answer is kept by.
      Null for a round of an existing session, which neither takes a
      standing answer nor gives one. */
  login: Login | null;
  /** The question offers this one session or none, never a standing
      answer: for an agent the workbench did not start, and while the
      settings ask before every start. */
  once: boolean;
  /** What the question says of the account, when it names it. */
  named: Named | null;
}

/** What a started session runs on: the account, by name, null for the
    agents' own, and the agent when the account keeps no directory for it,
    so the agent runs on its own. */
export interface Login {
  account: string | null;
  bare: AgentId | null;
}

/** A round of a review past the workflow's limit, which only the user can
    allow. */
export interface Beyond {
  step: string;
  /** The session whose work it checks, by id, for the caller. */
  work: string;
  /** The piece, by the id of the work session that began it. */
  piece: string;
  /** What the user knows that work by: its row's name. */
  name: string;
  done: number;
  limit: number;
}

/** The account a started session runs under, as the question and the
    answer name it. */
export interface Named {
  /** The account as it is shown: its name, or Default for the agents' own. */
  label: string;
  /** Whether it is the account the project runs under. */
  projects: boolean;
  /** The agent being started, when the account keeps no directory for it
      and the agent runs on its own. */
  bare: AgentId | null;
}

/** What the question says of the account a session would run under. */
export function accountWords(named: Named): string {
  const which = named.projects
    ? `Under the project's account, ${named.label}.`
    : `Under the ${named.label} account, not the project's own.`;
  if (named.bare === null) return which;
  const agent = agentLabel(named.bare);
  return `${which} ${named.label} has no ${agent} directory, so ${agent} uses the ${OWN_LABEL} one.`;
}

/** What the answer to a start says of the account, after where it runs. */
function underWords(named: Named | null): string {
  if (named === null) return "";
  const which = named.projects
    ? `, under the project's account, ${named.label}`
    : `, under the ${named.label} account`;
  if (named.bare === null) return which;
  const agent = agentLabel(named.bare);
  return `${which}, which has no ${agent} directory, so ${agent} uses the ${OWN_LABEL} one`;
}

/** What the user answered: allowed from now on, allowed this once, or no. */
export type Choice = "allow" | "once" | "no";

/** A session a caller started, as it is remembered between runs: enough
    to list it and to resume it where it ran. */
export interface Started {
  id: string;
  project: string;
  /** The worktree it ran in, when it did not run in the project itself. */
  worktree: string | null;
  agent: AgentId;
  /** The name the caller gave the work, when it gave one. */
  name: string | null;
  /** The account it ran under, by name; null for the agents' own. A record
      from before there were accounts has none, which reads as null. */
  account?: string | null;
  /** Why its row went, when it went in this window: the user closed it
      while it ran or waited to start, it had ended, or the workbench put it
      away once its work was over. None for a session whose row is open, or
      that has had none since the app last started. A version that does not
      know it reads the record without it, or a value it does not know as
      none. */
  left?: "closed" | "ended" | "done";
  /** It was started in its caller's own project without the user being
      asked, so it takes no command but /compact from its caller. A version
      that does not know it reads the record without it. */
  unasked?: true;
  /** It came to rest while a window watched, and its caller has not heard
      yet, so a window that comes back to it at rest still wakes the
      caller for it. A version that does not know it reads the record
      without it. */
  unheard?: true;
}

/** Where a started session stands in its caller's workflow. */
export interface Place {
  /** The step it is for, by name. */
  step: string;
  kind: WorkflowStep["kind"];
  /** The piece of work it is part of: the id of the session that began the
      piece. Null for a work session that began one and has no id yet. */
  piece: string | null;
  /** For a review, which round of it this is, from one. For work, the
      round its piece is in once a review has sent it back: one past the
      rounds the review has had. Null for work in its first round. */
  round: number | null;
  /** For a review, the session whose work it checks. */
  work: string | null;
}

/** What a caller that follows a workflow has run by it: where each session
    it started stands, by session id, and how many rounds each review has
    had of each piece, by the review's step and the piece. Kept between
    runs, and not forgotten when a session is stopped, since a piece
    outlives the sessions that worked on it. */
export interface Run {
  places: Record<string, Place>;
  rounds: Record<string, number>;
  /** The pieces the user stopped at a review's limit, by the review's
      step and the piece as rounds are, with the rounds each had then,
      until another round of the piece goes ahead. A version that does
      not know it reads a run without it. */
  stopped?: Record<string, number>;
  /** The sessions, by id, the workbench last saw at rest after a turn of
      work, so one whose row is gone, closed or not back after a restart,
      is told apart from one cut off at work. A version that does not know
      it reads a run without it. */
  rested?: string[];
}

const STARTED_KEY = "chord.started";
const RUNS_KEY = "chord.runs";
const CARRIED_KEY = "chord.carried";
const TREES_KEY = "chord.trees";

export const conductor = $state({
  asking: null as Ask | null,
  /** The session that started each row, by the row's key and the
      starter's token: the link for a row that has no id yet, and for the
      rest until the window goes. */
  startedBy: {} as Record<string, string>,
  /** What each caller started, by the caller's token, or for an agent the
      workbench did not start by its folder with a mark of its own, kept
      between runs. A row whose id is here is the caller's whether or not it
      was started in this run. A list an earlier version kept under the bare
      folder a caller that named no session called from is kept as it is,
      and is no caller's, since no caller is a bare folder. A list it kept
      under a session's id is the token's that session is given. */
  started: {} as Record<string, Started[]>,
  /** The worktrees each caller's starts made, by the caller's token, kept
      between runs until they are taken away. A caller's board offers to
      clean up these and no others: a tree another caller's start made, or
      one the user made, is not its to take. */
  trees: {} as Record<string, MadeTree[]>,
  /** Where each started row stands in its caller's workflow, by the row's
      key, from the moment it is made: the place of a row with no id yet. */
  places: {} as Record<string, Place>,
  /** What each caller has run by its workflow, by the caller's token. */
  runs: {} as Record<string, Run>,
  /** The last start refused to a caller that follows a workflow, by the
      caller's row key, until it starts one or the user puts it away: the
      user sees why as well as the agent. */
  refusals: {} as Record<string, string>,
  /** How many waits each caller has held, by the caller's token: a caller
      with one is listening for its sessions itself. */
  listening: {} as Record<string, number>,
  /** The starters the workbench woke, by the row's key, until the user
      looks at one once the turn its wake began is over, or a turn begins
      that the workbench did not start. */
  woken: {} as Record<string, Woken>,
  /** How many times the workbench has woken each starter, by the row's
      key, since a turn began that it did not start. */
  wakesInRow: {} as Record<string, number>,
  /** The calls answered before they were done, by caller, until the
      caller is told how each went: see `held`. */
  later: {} as Record<string, Later[]>,
});

/** A call answered that it was on its way before it was done: a start, a
    resume or a line that waited on the user, or on a session coming up. */
export interface Later {
  /** The call's id. */
  call: string;
  /** What the same call made again would be, to refuse it meanwhile. */
  same: string;
  /** The call in a few words, as "start of "Fix the cache" in /p". */
  what: string;
  /** How it went, once it is done: what the call would have answered, and
      whether it went ahead, null where that is not known. */
  outcome: { went: boolean | null; text: string } | null;
}

/** A starter the workbench woke: the sessions it was woken for, by their
    row's key, with the name the row had then and how it was at rest, and
    when. */
export interface Woken {
  by: { key: string; name: string; rest: "quiet" | "cut" | "permission" | "ended" }[];
  at: number;
}

/** A worktree a caller's start made: the project it is under and where
    it is. */
export interface MadeTree {
  project: string;
  path: string;
}

/** Reads what callers started in earlier runs. A corrupt entry reads as
    nothing remembered rather than a broken pane. */
export function loadStarted() {
  loadStartedList();
  loadRuns();
  loadTrees();
  loadLater();
}

function loadTrees() {
  try {
    const raw = localStorage.getItem(TREES_KEY);
    if (raw === null) return;
    const stored: unknown = JSON.parse(raw);
    if (!isRecord(stored)) return;
    const trees: Record<string, MadeTree[]> = {};
    for (const [caller, entries] of Object.entries(stored)) {
      if (!Array.isArray(entries)) continue;
      const kept = entries.filter(
        (entry): entry is MadeTree =>
          isRecord(entry) && typeof entry.project === "string" && typeof entry.path === "string",
      );
      if (kept.length > 0) trees[caller] = kept.map(({ project, path }) => ({ project, path }));
    }
    conductor.trees = trees;
  } catch {
    // No start made a worktree, then.
  }
}

function saveTrees() {
  try {
    localStorage.setItem(TREES_KEY, JSON.stringify(conductor.trees));
  } catch {
    // Non-fatal: the trees stay where they are, and no board offers them.
  }
}

/** A worktree one of this caller's starts made. */
function madeTree(caller: string, project: string, path: string) {
  const list = conductor.trees[caller] ?? [];
  if (list.some((tree) => tree.project === project && tree.path === path)) return;
  conductor.trees[caller] = [...list, { project, path }];
  saveTrees();
}

/** The worktrees this caller's starts made, whether or not a session still
    runs in them. */
export function treesMadeBy(caller: string): MadeTree[] {
  return conductor.trees[caller] ?? [];
}

/** A worktree that has been taken away is no caller's any more. */
export function treeRemoved(project: string, path: string) {
  let changed = false;
  for (const [caller, list] of Object.entries(conductor.trees)) {
    const kept = list.filter((tree) => !(tree.project === project && tree.path === path));
    if (kept.length === list.length) continue;
    if (kept.length === 0) delete conductor.trees[caller];
    else conductor.trees[caller] = kept;
    changed = true;
  }
  if (changed) saveTrees();
}

function loadStartedList() {
  try {
    const raw = localStorage.getItem(STARTED_KEY);
    if (raw === null) return;
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== "object" || stored === null) return;
    const started: Record<string, Started[]> = {};
    for (const [caller, entries] of Object.entries(stored)) {
      if (!Array.isArray(entries)) continue;
      const kept = entries.filter(isStarted);
      if (kept.length > 0) started[caller] = kept;
    }
    conductor.started = started;
  } catch {
    // Nothing was started, then.
  }
}

function loadRuns() {
  try {
    const raw = localStorage.getItem(RUNS_KEY);
    if (raw === null) return;
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== "object" || stored === null) return;
    const runs: Record<string, Run> = {};
    for (const [caller, run] of Object.entries(stored)) {
      if (typeof run !== "object" || run === null) continue;
      const { places, rounds, stopped, rested } = run as Record<string, unknown>;
      const kept: Run = { places: {}, rounds: {} };
      if (Array.isArray(rested)) {
        const ids = rested.filter((id): id is string => typeof id === "string");
        if (ids.length > 0) kept.rested = [...new Set(ids)];
      }
      for (const [key, count] of Object.entries(isRecord(stopped) ? stopped : {}))
        if (typeof count === "number" && Number.isInteger(count) && count > 0 && key.includes("\n"))
          (kept.stopped ??= {})[key] = count;
      for (const [id, place] of Object.entries(isRecord(places) ? places : {}))
        if (isPlace(place)) kept.places[id] = place;
      for (const [key, count] of Object.entries(
        isRecord(rounds) ? rounds : {},
      )) {
        if (typeof count !== "number" || !Number.isInteger(count) || count <= 0)
          continue;
        const cut = key.indexOf("\n");
        if (cut === -1) continue;
        const counted = roundKey(key.slice(0, cut), key.slice(cut + 1));
        kept.rounds[counted] = (kept.rounds[counted] ?? 0) + count;
      }
      runs[caller] = kept;
    }
    conductor.runs = runs;
  } catch {
    // Nothing was run by a workflow, then.
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function isPlace(value: unknown): value is Place {
  if (typeof value !== "object" || value === null) return false;
  const { step, kind, piece, round, work } = value as Record<string, unknown>;
  return (
    typeof step === "string" &&
    (kind === "work" || kind === "review") &&
    (piece === null || typeof piece === "string") &&
    (round === null ||
      (typeof round === "number" && Number.isInteger(round))) &&
    (work === null || typeof work === "string")
  );
}

function isStarted(entry: unknown): entry is Started {
  if (typeof entry !== "object" || entry === null) return false;
  const { id, project, worktree, agent, name, account } = entry as Record<
    string,
    unknown
  >;
  return (
    typeof id === "string" &&
    typeof project === "string" &&
    (worktree === null || typeof worktree === "string") &&
    (agent === "claude-code" || agent === "codex") &&
    (name === null || typeof name === "string") &&
    (account === undefined || account === null || typeof account === "string")
  );
}

function saveStarted() {
  try {
    localStorage.setItem(STARTED_KEY, JSON.stringify(conductor.started));
  } catch {
    // Non-fatal: what was started does not survive a restart.
  }
}

/** Puts a session on a caller's list, or brings its entry up to date. */
function remember(caller: string, entry: Started) {
  const list = conductor.started[caller] ?? [];
  conductor.started[caller] = [
    ...list.filter((known) => known.id !== entry.id),
    entry,
  ];
  saveStarted();
}

function saveRuns() {
  try {
    localStorage.setItem(RUNS_KEY, JSON.stringify(conductor.runs));
  } catch {
    // Non-fatal: the places and rounds start afresh after a restart.
  }
}

const runOf = (caller: string): Run =>
  (conductor.runs[caller] ??= { places: {}, rounds: {} });

/** What the rounds of a review of a piece are counted under: the step's
    name in any case, as the workflows compare names. */
const roundKey = (step: string, piece: string) => `${asciiLower(step)}\n${piece}`;

/** How many rounds of a review a piece has had. */
export function roundsOf(caller: string, step: string, piece: string): number {
  return conductor.runs[caller]?.rounds[roundKey(step, piece)] ?? 0;
}

function countRound(caller: string, step: string, piece: string) {
  const { rounds } = runOf(caller);
  const key = roundKey(step, piece);
  rounds[key] = (rounds[key] ?? 0) + 1;
  saveRuns();
}

/** Takes back a round counted for a start that did not happen. */
function uncountRound(caller: string, step: string, piece: string) {
  const { rounds } = runOf(caller);
  const key = roundKey(step, piece);
  const left = (rounds[key] ?? 0) - 1;
  if (left > 0) rounds[key] = left;
  else delete rounds[key];
  saveRuns();
}

/** Keeps that the user stopped a piece at a review's limit. */
function stopAtLimit(caller: string, beyond: Beyond) {
  const run = runOf(caller);
  run.stopped = { ...run.stopped, [roundKey(beyond.step, beyond.piece)]: beyond.done };
  saveRuns();
}

/** Keeps whether a session placed in a caller's run was last seen at rest
    after a turn of work, for when its row is gone. */
function keepRested(caller: string, id: string, rested: boolean) {
  const run = conductor.runs[caller];
  if (run === undefined || !(id in run.places)) return;
  const has = run.rested?.includes(id) ?? false;
  if (has === rested) return;
  if (rested) run.rested = [...(run.rested ?? []), id];
  else {
    const left = (run.rested ?? []).filter((known) => known !== id);
    if (left.length > 0) run.rested = left;
    else delete run.rested;
  }
  saveRuns();
}

/** Another round of a piece has gone ahead, so it is no longer stopped. */
function goneAhead(caller: string, step: string, piece: string) {
  const stopped = conductor.runs[caller]?.stopped;
  const key = roundKey(step, piece);
  if (stopped === undefined || !(key in stopped)) return;
  delete stopped[key];
  saveRuns();
}

/** Places in a work step taken by starts and resumes still on their way,
    by the caller and the step. A start takes its place before it awaits
    anything, so two at once cannot both find room. */
const reserved = new Map<string, number>();
const slotKey = (caller: string, step: string) => `${caller}\n${asciiLower(step)}`;

/** Takes a place in a work step, and answers with what gives it back. */
function reserveSlot(caller: string, step: string): () => void {
  const key = slotKey(caller, step);
  reserved.set(key, (reserved.get(key) ?? 0) + 1);
  let given = false;
  return () => {
    if (given) return;
    given = true;
    const left = (reserved.get(key) ?? 1) - 1;
    if (left > 0) reserved.set(key, left);
    else reserved.delete(key);
  };
}

/** The sessions a caller has running for a step, and how many places in it
    starts on their way hold besides. */
function runningFor(caller: string, step: string): { sessions: Session[]; held: number } {
  return {
    sessions: startedBy(caller).filter(
      (session) => {
        const at = isLive(session) ? placeOf(session.key) : null;
        return at !== null && sameName(at.step, step);
      },
    ),
    held: reserved.get(slotKey(caller, step)) ?? 0,
  };
}

/** Why a work step has no room for another session, when it has none. */
function noRoom(caller: string, step: WorkStep): string | null {
  makeRoom(runningFor(caller, step.name).sessions);
  const { sessions: running, held } = runningFor(caller, step.name);
  if (running.length + held < step.parallel) return null;
  const at = step.parallel === 1 ? "one session" : `${step.parallel} sessions at most`;
  if (running.length === 0)
    return `The step ${quoted(step.name)} runs ${at} at once, and another start for it is on its way. Wait for it to answer before starting another.`;
  const ids = either(
    running.map(namedAs),
    "and",
  );
  return `The step ${quoted(step.name)} runs ${at} at once, and ${running.length === 1 ? `session ${ids} is` : `sessions ${ids} are`} running for it. Wait for one to finish, or stop one whose work is not wanted, before starting another.`;
}

function place(caller: string, id: string, at: Place) {
  runOf(caller).places[id] = at;
  saveRuns();
}

/** Where a started row stands in its caller's workflow, when it does. */
export function placeOf(key: string): Place | null {
  const own = conductor.places[key];
  if (own !== undefined) return own;
  const session = byKey(key);
  const caller = startedFor(key);
  const id = session?.id ?? null;
  if (id === null || caller === null) return null;
  return placed(caller, id);
}

/** Where a session a caller started stands, by its id, whether or not it
    is still a row. */
function placed(caller: string, id: string): Place | null {
  const kept = conductor.runs[caller]?.places[id];
  if (kept !== undefined) return kept;
  const row = byId(id);
  if (row === null || startedFor(row.key) !== caller) return null;
  return conductor.places[row.key] ?? null;
}

/** Takes a session off its caller's list, and off the list a session
    from before there were tokens kept under its id, which is the caller's
    as well: a session the caller is done with is not moved back to it.
    That is the list of each id whose kept token the caller is, and of the
    caller's own id, whose kept token two rows of it running at once leave
    to neither. */
function forget(caller: string, id: string) {
  const own = sessions.all.find((row) => row.token === caller)?.id ?? null;
  let changed = false;
  for (const key of new Set([caller, ...idsOf(caller), ...(own === null ? [] : [own])])) {
    const list = conductor.started[key];
    if (list === undefined || !list.some((known) => known.id === id)) continue;
    const kept = list.filter((known) => known.id !== id);
    if (kept.length === 0) delete conductor.started[key];
    else conductor.started[key] = kept;
    changed = true;
  }
  if (changed) saveStarted();
}

/** The token a session kept under this id is named by now; anything else
    as it is. So is an id while a run named by it still runs: what is kept
    under the id is that run's until it stops. */
function tokenOf(caller: string): string {
  const kept = sessions.tokens[caller]?.token;
  if (kept === undefined || kept === "" || namesLiveRun(caller)) return caller;
  return kept;
}

/** Whether a running row is named by this, as a run taken up after a
    reload can be named by its id. */
const namesLiveRun = (name: string) =>
  sessions.all.some((row) => row.token === name && isLive(row));

/** The ids of the sessions whose kept token this is. */
function idsOf(token: string): string[] {
  return Object.entries(sessions.tokens)
    .filter(([id, kept]) => kept.token === token && id !== token)
    .map(([id]) => id);
}

/** Whether a list is kept under a folder rather than a caller's token: an
    earlier version's, for a caller whose calls named no session. */
const byFolder = (caller: string) => /^(?:\/|ssh:\/\/|[A-Za-z]:[\\/])/.test(caller);

/** The caller of each remembered session, by the session's id: the first
    caller listed where two remember one, a caller's own list before one
    kept under the id of a session from before there were tokens, which
    holds what moved to the token as well, and both before one kept under
    a bare folder. A session a folder's list holds was started by another
    all the same, so it starts none of its own, and no call acts on it: no
    caller is a bare folder. */
const owners = $derived.by(() => {
  const index = new Map<string, string>();
  const lists = Object.entries(conductor.started);
  const rank = (caller: string) =>
    byFolder(caller) ? 2 : sessions.tokens[caller] !== undefined ? 1 : 0;
  for (const at of [0, 1, 2])
    for (const [caller, entries] of lists) {
      if (rank(caller) !== at) continue;
      // A list kept under the id of a session from before there were
      // tokens is its token's, once it has one: no call names the id.
      const owner = tokenOf(caller);
      for (const entry of entries)
        if (!index.has(entry.id)) index.set(entry.id, owner);
    }
  return index;
});

/** A session open when the app last quit, as the window kept it. */
export interface WasOpen {
  project: string;
  id: string;
  agent: AgentId;
  startIn: string | null;
}

/**
 * Carries what an earlier version kept under a folder over to the session
 * that kept it there, so an orchestration running when the app was updated
 * goes on. Such a version kept what a caller that named no session started
 * under the folder it called from, and the callers that named none were
 * the Codex sessions. A folder that one Codex session among those open at
 * the last quit ran in is that session's, and its list and its workflow's
 * record are copied to the session's id, which is its token.
 * A folder where none ran, or several did, is left as it was: what it
 * holds was started by another session, and no call acts on it. The
 * folder's own copy stays, for that earlier version to go on reading.
 *
 * Each folder is looked at once, carried or not, and the folders looked at
 * are kept: which sessions were open at a later quit says nothing of which
 * one kept the folder's list, so a folder left as it was stays so. A folder
 * that earlier version first writes after a downgrade is looked at on the
 * next start of this one.
 */
export function carryOver(open: WasOpen[]) {
  let moved = false;
  const looked = lookedAt();
  const folders = new Set(
    [...Object.keys(conductor.started), ...Object.keys(conductor.runs)].filter(
      (caller) => byFolder(caller) && !looked.has(caller),
    ),
  );
  if (folders.size === 0) return;
  for (const folder of folders) {
    looked.add(folder);
    const ran = open.filter(
      (entry) => entry.agent === "codex" && (entry.startIn ?? entry.project) === folder,
    );
    if (ran.length !== 1) continue;
    const id = ran[0].id;
    const kept = conductor.started[folder] ?? [];
    const have = conductor.started[id] ?? [];
    const added = kept.filter((entry) => !have.some((known) => known.id === entry.id));
    if (added.length > 0) {
      conductor.started[id] = [...have, ...added];
      moved = true;
    }
    const run = conductor.runs[folder];
    if (run !== undefined && conductor.runs[id] === undefined) {
      conductor.runs[id] = structuredClone($state.snapshot(run)) as Run;
      moved = true;
    }
  }
  try {
    localStorage.setItem(CARRIED_KEY, JSON.stringify([...looked]));
  } catch {
    // Non-fatal: the folders are looked at again at the next start.
  }
  if (!moved) return;
  saveStarted();
  saveRuns();
}

/** The folders the carry-over has looked at. */
function lookedAt(): Set<string> {
  try {
    const raw = localStorage.getItem(CARRIED_KEY);
    const stored: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(stored) ? stored.filter((folder) => typeof folder === "string") : []);
  } catch {
    return new Set();
  }
}

/** The caller that started a session, by its id, when one is remembered. */
function ownerOf(id: string | null): string | null {
  if (id === null) return null;
  return owners.get(id) ?? null;
}

/** A caller's remembered session, by id, when it is one. */
function remembered(caller: string, id: string): Started | null {
  return (
    (conductor.started[caller] ?? []).find((entry) => entry.id === id) ?? null
  );
}

/** The calls being answered, by id. */
const calling = new Map<string, ConductRequest>();

/** The ids of the calls handled lately, so a call delivered twice is
    handled once. */
const seen = new Set<string>();
const SEEN = 500;
/** Callers with a standing answer, by caller, project and account. */
const allowed = new SvelteSet<string>();
/** Questions waiting for the one on screen to be answered. */
const queue: { ask: Ask; settle: (choice: Choice) => void }[] = [];
let pending: ((choice: Choice) => void) | null = null;

interface Answered {
  content: string | null;
  error: string | null;
  /** The refusal is the user's own answer to the question, which they
      need not be shown again. */
  byUser?: boolean;
  /** What follows once the answer has been left where the caller reads
      it, and only then. */
  delivered?: () => void;
  /** The call is not done: it goes on, and how it went is the caller's
      news once it is, which alone says whether a start was refused. */
  later?: true;
}

/** A wait being held: the caller it is for, the sessions it watches by
    row key, what ends it unanswered, and what ends it with an answer of
    its own. */
interface Held {
  caller: string;
  watched: string[];
  abandon: () => void;
  interrupt: (answer: string) => void;
  /** A note went with the user's message while it was held and named
      what was still out, so giving the wait up for that message leaves
      nothing more to say. */
  noted?: boolean;
}

/** The waits being held, by call. */
const waiting = new Map<string, Held>();
/** Whether a wait another session holds watches this row: what it waits
    to hear of the session must not be cut short. */
export function waitedOn(key: string): boolean {
  // The waits held, as each caller counts them, so whoever asks hears
  // when one is taken up or let go.
  if (Object.values(conductor.listening).length === 0) return false;
  for (const wait of waiting.values()) if (wait.watched.includes(key)) return true;
  return false;
}

/** Calls given up on by the agent: their answer is not written. */
const given = new Set<string>();

/**
 * A call that waits on the user.
 *
 * A start the user is asked about, a resume or a start for a round past a
 * review's limit, and a line to a review past its limit wait on the user's
 * answer to a question in the window, for as long as the user is away. An
 * agent gives up on a call of its own accord after a while, Codex after a
 * minute unless it is told otherwise, and the tool server after its own
 * wait; it never reads an answer that comes after. So such a call is held
 * no longer than `HOLD` (see the hold module): still not done by then, it is answered that it is
 * on its way, that nothing is done yet, and that wait says how it went, and
 * the question stays. A call the agent gives up on before then goes the
 * same way. Once it is done, how it went is the caller's to hear, once: from
 * its next wait, a listing, the note on the user's next message, or a wake.
 * A call is done once, whoever hears of it, and the same start, resume or
 * line asked for again while one waits is refused, so no work is started
 * twice for it. One whose caller has stopped by the time the user answers
 * does nothing, there being no one to hear of it or to direct it.
 */

export { HOLD };

/** The tools whose calls can wait on the user. */
const ON_USER = new Set(["start", "send"]);

/** The calls being held, by id, until they are done or `HOLD` is up. */
const holding = new Map<string, { caller: string; same: string; what: string; work: Promise<Answered> }>();

/** The calls whose question is up, or waits behind another, by id. */
const onUser = new Set<string>();

/** Holds a call that can wait on the user until it is done, or `HOLD`. */
async function held(request: ConductRequest): Promise<Answered> {
  const caller = request.session ?? outsideCaller(request.cwd);
  const { same, what } = callWords({ ...request, caller });
  // The same call again, after the caller was told one is on its way, is
  // that one asked for twice. Calls made together are each meant.
  const already = (conductor.later[caller] ?? []).find((one) => one.outcome === null && one.same === same);
  if (already !== undefined)
    return refused(
      `Your ${already.what} is on its way already${onUser.has(already.call) ? ", waiting on the user's answer," : ""} and nothing was asked again. Call wait, which tells you how it went.`,
    );
  // Begun at once, as any call is, so its question is up as it returns.
  let work: Promise<Answered>;
  try {
    work = Promise.resolve(run(request)).catch((error: unknown) => refused(String(error)));
  } catch (error) {
    work = Promise.resolve(refused(String(error)));
  }
  holding.set(request.id, { caller, same, what, work });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([
    work,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), HOLD);
    }),
  ]);
  clearTimeout(timer);
  const entry = holding.get(request.id);
  holding.delete(request.id);
  // Given up on meanwhile, it is the caller's news already, and its answer
  // is written to no one.
  if (entry === undefined) return { ...refused("The call was given up on."), later: true };
  if (done !== null) return done;
  const asking = onUser.has(request.id);
  later(request, entry);
  return { ...said(onItsWay(request, asking)), later: true };
}

/** Makes a held call the caller's news once it is done. */
function later(request: ConductRequest, entry: { caller: string; same: string; what: string; work: Promise<Answered> }) {
  const item: Later = { call: request.id, same: entry.same, what: entry.what, outcome: null };
  // Pushed onto the list the state holds, not the one handed to it.
  conductor.later[entry.caller] = [...(conductor.later[entry.caller] ?? []), item];
  saveLater();
  void entry.work.then((answered) => {
    if (request.tool === "start" && answered.byUser !== true) noteRefusal(request, answered.error);
    const kept = conductor.later[entry.caller]?.find((one) => one.call === request.id);
    if (kept === undefined) return;
    kept.outcome =
      answered.error === null
        ? { went: true, text: answered.content ?? "" }
        : { went: false, text: answered.error };
    saveLater();
    moved();
  });
}

const LATER_KEY = "chord.later";

/** What a call answered before it was done comes to once the window that
    held it was closed or reloaded first: the question went with it, so it
    was not done; or, the user having allowed it, it was under way and may
    or may not have been. */
export const DROPPED_ASKING =
  "the workbench's window was closed or reloaded while the user was still being asked, so it was not done.";
export const DROPPED_UNDER_WAY =
  "the workbench's window was closed or reloaded while it was under way, after the user allowed it, so whether it was done is not known: the sessions tool says what runs.";

/** Keeps what each caller has to hear of the calls answered before they
    were done, with whether each still waiting is in front of the user, so
    a window that comes back can say how each went. */
function saveLater() {
  try {
    const kept: Record<string, (Later & { asking?: boolean })[]> = {};
    for (const [caller, list] of Object.entries(conductor.later))
      kept[caller] = list.map((one) => ({
        ...$state.snapshot(one),
        ...(one.outcome === null ? { asking: onUser.has(one.call) } : {}),
      }));
    localStorage.setItem(LATER_KEY, JSON.stringify(kept));
  } catch {
    // Non-fatal: a window that comes back does not know of them.
  }
}

/** Takes up what the window before knew of the calls it answered before
    they were done: how each went where it was done, and for one that was
    not, that the window went first. A record that does not read is none. */
function loadLater() {
  try {
    const raw = localStorage.getItem(LATER_KEY);
    if (raw === null) return;
    const stored: unknown = JSON.parse(raw);
    if (!isRecord(stored)) return;
    const later: Record<string, Later[]> = {};
    for (const [caller, entries] of Object.entries(stored)) {
      if (!Array.isArray(entries)) continue;
      const kept: Later[] = [];
      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        const { call, same, what, outcome, asking } = entry;
        if (typeof call !== "string" || typeof same !== "string" || typeof what !== "string") continue;
        if (isRecord(outcome)) {
          const { went, text } = outcome;
          if ((typeof went === "boolean" || went === null) && typeof text === "string")
            kept.push({ call, same, what, outcome: { went, text } });
        } else if (outcome === null)
          kept.push({
            call,
            same,
            what,
            outcome: asking === false ? { went: null, text: DROPPED_UNDER_WAY } : { went: false, text: DROPPED_ASKING },
          });
      }
      if (kept.length > 0) later[caller] = kept;
    }
    conductor.later = later;
    saveLater();
  } catch {
    // Nothing to tell, then.
  }
}

/** What a call that can wait on the user is, in a few words, and what the
    same call made again would be: for a start, the same work in the same
    place, on the same agent and model, under the same login, by the same
    name. A start that differs in any of those is another start. */
function callWords(request: Placed): { same: string; what: string } {
  const args = request.arguments;
  const word = (name: string) => (typeof args[name] === "string" ? (args[name] as string).trim() : "");
  if (request.tool === "send") {
    const to = word("session");
    return { same: `send\n${to}\n${word("text")}`, what: `line to session ${idText(to)}` };
  }
  const resumed = word("session");
  if (resumed !== "")
    return { same: `resume\n${resumed}`, what: `resume of session ${idText(resumed)}` };
  const prompt = oneLine(word("prompt"));
  const called = word("name") !== "" ? word("name") : prompt;
  const project = word("project");
  // The login it would run under, as the start resolves it: the account a
  // start does not name turns on its caller, never on the agent.
  const wanted = wantedAccount(request);
  const login =
    "refusal" in wanted
      ? `named ${word("account")}`
      : `under ${underFor(request, project, agentOf(request, project), wanted.named).account ?? "\u0000own"}`;
  return {
    same: [
      "start",
      project,
      word("step"),
      word("work"),
      agentOf(request, project),
      word("model"),
      login,
      word("name"),
      prompt,
    ].join("\n"),
    what: `start of ${quotedName(nameCut(oneLine(called)))} in ${oneLine(word("project"))}`,
  };
}

/** What a held call answers when `HOLD` is up and it is not done. */
function onItsWay(request: ConductRequest, asking: boolean): string {
  const resume = request.tool === "start" && typeof request.arguments.session === "string";
  const noun = request.tool === "send" ? "line" : resume ? "resume" : "start";
  const nothing =
    request.tool === "send"
      ? "the line has not been sent"
      : resume
        ? "the session has not been resumed"
        : "nothing has started";
  const why = asking
    ? request.tool === "start" && !resume && !roundAsked.has(request.id)
      ? `The user is asked about this start in the workbench and has not answered yet, so ${nothing}.`
      : `The user is asked in the workbench about another round of the review and has not answered yet, so ${nothing}.`
    : `This ${noun} is still under way.`;
  return `${why} Do not ask for the same ${noun} again: call wait, which tells you how it went${noun === "start" ? ", with the new session's id if it started" : ""}.`;
}

/** The calls whose question is about a round past a review's limit. */
const roundAsked = new Set<string>();

/** What the caller has not been told of the calls it was answered early,
    each done: the calls and a line for each. */
function laterNews(caller: string): { calls: string[]; lines: string[] } {
  const done = (conductor.later[caller] ?? []).filter((one) => one.outcome !== null);
  return {
    calls: done.map((one) => one.call),
    lines: done.map((one) =>
      one.outcome!.went === true
        ? `Your ${one.what} went ahead: ${one.outcome!.text}`
        : one.outcome!.went === false
          ? `Your ${one.what} did not go ahead: ${one.outcome!.text}`
          : `Your ${one.what} may or may not have gone ahead: ${one.outcome!.text}`,
    ),
  };
}

/** Whether the caller has a call answered early that is not done yet. */
function laterWaiting(caller: string): Later[] {
  return (conductor.later[caller] ?? []).filter((one) => one.outcome === null);
}

/** The caller has been told how these calls went. */
function toldLater(caller: string, calls: string[]) {
  const left = (conductor.later[caller] ?? []).filter((one) => !calls.includes(one.call) || one.outcome === null);
  if (left.length > 0) conductor.later[caller] = left;
  else delete conductor.later[caller];
  saveLater();
  moved();
}

/** Whether the session that made a call has stopped: a call from an agent
    the workbench did not start has no session to stop. */
function callerGone(request: ConductRequest): boolean {
  return request.session !== null && callerRow(request) === null;
}

/** What a call answers whose caller stopped before the user answered. */
export const CALLER_GONE = "The session that asked has stopped, so nothing was done.";
/** Callers whose last wait was given up on, as the user's message cutting
    it short does: the next note they are given says what is still out. */
const cut = new Set<string>();

/**
 * The agent gave up on a call. A wait still held for it ends without
 * answering and tells nothing, since no one is there to hear it.
 */
export function cancelled(id: string) {
  // A call that can wait on the user goes on, and how it went is the
  // caller's to hear.
  const entry = holding.get(id);
  if (entry !== undefined) {
    holding.delete(id);
    given.add(id);
    const request = calling.get(id);
    if (request !== undefined) later(request, entry);
    return;
  }
  const held = waiting.get(id);
  if (held === undefined) return;
  given.add(id);
  if (held.noted !== true) cut.add(held.caller);
  held.abandon();
}

/** What a wait the user's message ended answers. */
export const USER_WROTE =
  "The user wrote to you, which ends this wait. If their message has not reached you yet, end your turn now so that it does. Answer it as the final message of your turn and end the turn there without calling wait again: the workbench writes to you when one of your sessions stops or asks.";

/** Ends the waits these callers hold, each with the answer given. */
function endWaits(callers: string[], answer: string) {
  for (const held of [...waiting.values()])
    if (callers.includes(held.caller)) held.interrupt(answer);
}

const said = (content: string): Answered => ({ content, error: null });
const refused = (error: string): Answered => ({ content: null, error });

/**
 * Answers one call. The agent on the other side is blocked until it is
 * answered, so every call is, whatever happens, except a wait the agent
 * has given up on or whose calling session has ended.
 */
export async function handle(request: ConductRequest): Promise<void> {
  // An app and a daemon sharing a home both read the same log, and both
  // deliver the call: the second copy is the same call, not another.
  if (seen.has(request.id)) return;
  seen.add(request.id);
  if (seen.size > SEEN) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  let answered: Answered;
  calling.set(request.id, request);
  try {
    answered = ON_USER.has(request.tool) ? await held(request) : await run(request);
  } catch (error) {
    answered = refused(String(error));
  } finally {
    calling.delete(request.id);
    callEnded(request);
  }
  // A start not done yet is said on the caller's row once it is.
  if (request.tool === "start" && answered.byUser !== true && answered.later !== true)
    noteRefusal(request, answered.error);
  if (given.delete(request.id)) return;
  await core()
    .conductAnswer(request.id, request.cwd, answered.content, answered.error)
    .then(
      () => answered.delivered?.(),
      () => {
        // The core has gone, or the call had already given up. Nothing here
        // can tell the agent either way, and nothing counts as told.
      },
    );
}

function run(request: ConductRequest): Answered | Promise<Answered> {
  // The prompt hook asks for a note, and is given none for a call it
  // cannot hold to a session; it never fails the user's message.
  if (request.tool === "prompt") return promptNote(request);
  const refusal = unplaced(request);
  if (refusal !== null) return refused(refusal);
  const call = wholeIds({ ...request, caller: request.session ?? outsideCaller(request.cwd) });
  if ("refusal" in call) return refused(call.refusal);
  switch (call.tool) {
    case "projects":
      return said(projectLines(call));
    case "sessions":
      return said(sessionLines(call));
    case "start":
      return startSession(call);
    case "send":
      return sendText(call);
    case "stop":
      return stopSession(call);
    case "wait":
      return waitFor(call);
    case "read":
      return readSession(call);
    default:
      return refused(`The workbench has no ${String(call.tool)} tool.`);
  }
}

/** A call the workbench has placed, with its caller: the token of the
    session it names, or, for a call that names none, an agent the
    workbench did not start, by the folder it calls from. */
export type Placed = ConductRequest & { caller: string };

/** The arguments of each tool that name a session by its id. */
const ID_ARGUMENTS: Partial<Record<ConductRequest["tool"], string[]>> = {
  start: ["session", "work"],
  send: ["session"],
  stop: ["session"],
  wait: ["session"],
  read: ["session"],
};

/** The fewest characters of an id that name a session by its start: as
    many as a row with no title of its own shows of its id. */
export const ID_START = 8;

/**
 * The call with each session it names by the start of its id named by the
 * whole id instead, or why it cannot be: the start fits more than one. A
 * start is looked for among the caller's own sessions and no others, so it
 * never reaches a session the caller did not start; one that fits none of
 * them is left as it is, and is refused as an id the workbench does not
 * know. A whole id is always taken as it is.
 */
function wholeIds(call: Placed): Placed | { refusal: string } {
  let args = call.arguments;
  for (const name of ID_ARGUMENTS[call.tool] ?? []) {
    const given = text(call, name);
    if (given === null || given.length < ID_START || byId(given) !== null) continue;
    const own = ownIds(call.caller, name === "work");
    if (own.has(given)) continue;
    const fits = [...own].filter((id) => id.startsWith(given)).sort();
    // One that went on from its notes is still named by its old id.
    const now = fits.length === 0 ? wentOnFrom(given) : null;
    if (now !== null && own.has(now)) {
      args = { ...args, [name]: now };
      continue;
    }
    if (fits.length > 1)
      return {
        refusal: `More than one of your sessions has an id that starts with ${idText(given)}: ${either(fits.map(idText), "and")}. Give enough of the id to tell them apart.`,
      };
    if (fits.length === 1) args = { ...args, [name]: fits[0] };
  }
  return args === call.arguments ? call : { ...call, arguments: args };
}

/** The ids of the sessions a caller started: its rows and the ones it
    remembers, and with `withPlaced` the ones its workflow placed as well,
    which keep the sessions it stopped. Only the work a start carries on
    may name one of those, so they make no other id's start ambiguous. */
function ownIds(caller: string, withPlaced: boolean): Set<string> {
  const ids = new Set<string>();
  for (const row of startedBy(caller)) if (row.id !== null) ids.add(row.id);
  for (const entry of conductor.started[caller] ?? []) ids.add(entry.id);
  if (withPlaced) for (const id of Object.keys(conductor.runs[caller]?.places ?? {})) ids.add(id);
  return ids;
}

/** What a call that names no session is told when it would start or send
    while a session follows a workflow: such a call may come from an agent
    run outside the workbench or from a session that left its name out, and
    it cannot be held to the workflow. */
export const OUTSIDE =
  "This call names no session. Each session the workbench starts is given a name its tools pass on in every call, so this call comes from an agent run outside the workbench or from a session whose tools left its name out. A session the workbench runs follows a workflow, and a call that names no session cannot be held to it, so starting and sending are refused to such calls until none follows one. An agent run outside the workbench can be started from it instead.";

/** What a call is told that names a session the workbench is not running:
    one it never had, or one that has stopped and so cannot be calling. */
export const UNKNOWN =
  "This call names a session the workbench is not running, so it cannot tell what this call may do. The tools that start and direct sessions are for the sessions the workbench runs.";

/** Why a call cannot be placed, when it cannot: it names a session the
    workbench is not running. Null for a call whose token names a running
    session, which is the caller, and for one that names none, from an agent
    the workbench did not start. */
function unplaced(request: ConductRequest): string | null {
  if (request.session === null) return null;
  return callerRow(request) === null ? UNKNOWN : null;
}

/** The running session a call's token names, the caller. */
function callerRow(request: ConductRequest): Session | null {
  return runningByToken(request.session);
}

/** Keeps a refused start where the user can see it, for a caller that
    follows a workflow, and clears it once a start goes through. */
function noteRefusal(request: ConductRequest, error: string | null) {
  const row = callerRow(request);
  if (row === null) return;
  if (error === null) delete conductor.refusals[row.key];
  else if (row.workflow !== null) conductor.refusals[row.key] = error;
}

/** Puts away the refusal shown on a caller's row. */
export function dismissRefusal(key: string) {
  delete conductor.refusals[key];
}

/** What a session's header says of the workflow it is part of. */
export interface WorkflowTag {
  /** The workflow's name, marked when it was deleted and the session
      follows the copy it kept; null when the caller's workflow is not known
      here. */
  workflow: string | null;
  /** The session's place in it: orchestrator, or the step and round. */
  role: string;
  /** The rules that place goes by: the orchestrator's instructions, a
      sentence or a few each, or what a step allows, a line each. */
  rules: string[];
  /** Whether the rules are steps in order, as instructions are. */
  numbered: boolean;
}

/** The workflow a session is part of and its place in it, with the rules
    that place goes by. Null for a session outside any workflow. */
export function workflowTag(session: Session): WorkflowTag | null {
  if (session.workflow !== null) {
    return {
      workflow: session.workflowGone
        ? `${session.workflow.name} (deleted)`
        : session.workflow.name,
      role: "orchestrator",
      rules: instructionLines(session.workflow),
      numbered: true,
    };
  }
  const at = placeOf(session.key);
  if (at === null) return null;
  const caller = startedFor(session.key);
  const workflow = caller === null ? null : (byToken(caller)?.workflow ?? null);
  const role = placeLong(placeWords(workflow, at));
  const step = workflow?.steps.find((candidate) => sameName(candidate.name, at.step));
  const work =
    at.kind === "review" && at.work !== null && caller !== null
      ? workName(caller, at.work)
      : null;
  const rules =
    step === undefined
      ? [`Runs for the step ${at.step}.`, ...(work === null ? [] : [`Reviews ${work}.`])]
      : stepFacts(step, work);
  return { workflow: workflow?.name ?? null, role, rules, numbered: false };
}

/** A started session's place in words: its step, its round of the most
    there are, the header's long form and the rail's short one. */
export interface PlaceText {
  step: string;
  /** "round 2 of 4", or null where there is no round to say. */
  round: string | null;
  /** "Review, round 2 of 4". */
  long: string;
  /** "Review, 2 of 4". */
  short: string;
}

/** Where a started row stands in its starter's workflow, in words. Null
    for a row started for no step. */
export function placeTextOf(key: string): PlaceText | null {
  const at = placeOf(key);
  if (at === null) return null;
  const caller = startedFor(key);
  const words = placeWords(caller === null ? null : (byToken(caller)?.workflow ?? null), at);
  return { step: words.step, round: roundText(words), long: placeLong(words), short: placeShort(words) };
}

/** What a started session is doing, as the run tells it. One that no
    longer runs, its row gone, ended or not yet started again, is done only
    where it was last seen at rest after a turn of work. */
function doingOf(row: Session | null, rested: boolean): Doing {
  if (row === null) return rested ? "done" : "ended";
  switch (row.status) {
    case "crashed":
    case "failed":
      return "stopped";
    case "starting":
      return "working";
    case "running":
      if (row.needs === "permission") return "asking";
      return row.working ? "working" : "done";
    default:
      return rested ? "done" : "ended";
  }
}

/** Where the run of a session that follows a workflow stands, from what
    the conductor keeps of the sessions it started. Null for a session
    that follows none. */
export function runStanding(session: Session): RunSummary | null {
  const workflow = session.workflow;
  if (workflow === null) return null;
  const caller = session.token;
  const mineRow = (id: string) =>
    sessions.all.find((row) => row.id === id && isLive(row) && startedFor(row.key) === caller) ??
    sessions.all.find((row) => row.id === id && startedFor(row.key) === caller) ??
    null;
  const entries: RunEntry[] = [];
  const kept = conductor.runs[caller]?.places ?? {};
  const rested = new Set(conductor.runs[caller]?.rested ?? []);
  for (const [id, at] of Object.entries(kept)) {
    const row = mineRow(id);
    const now = row === null ? at : (conductor.places[row.key] ?? at);
    entries.push({ key: row?.key ?? null, id, name: workName(caller, id), place: now, doing: doingOf(row, rested.has(id)) });
  }
  for (const row of startedBy(caller)) {
    const at = conductor.places[row.key];
    if (at === undefined || (row.id !== null && row.id in kept)) continue;
    entries.push({ key: row.key, id: row.id, name: label(row), place: at, doing: doingOf(row, false) });
  }
  const asking = conductor.asking;
  const wait =
    asking !== null && asking.round !== null && asking.request.caller === caller
      ? { step: asking.round.step, done: asking.round.done, limit: asking.round.limit }
      : null;
  const name = session.workflowGone ? `${workflow.name} (deleted)` : workflow.name;
  const stops = Object.entries(conductor.runs[caller]?.stopped ?? {}).map(([key, round]) => {
    const cut = key.indexOf("\n");
    return { step: key.slice(0, cut), piece: key.slice(cut + 1), round };
  });
  return summarize({ workflow, entries, wait, stops, directing: session.working || session.needs !== null, name });
}

/** What the user knows a session's work by: the name its row has, or had,
    and never its id. */
export function workName(caller: string, id: string): string {
  const row = byId(id);
  if (row !== null && row.title !== null) return row.title;
  const known = sessions.names[id] ?? remembered(caller, id)?.name ?? null;
  if (known !== null) return known;
  return row !== null && row.resumedFrom === null ? label(row) : "the work it checks";
}

/** The open projects a session may be started in: every one but the
    orchestrator folder, should a version that let it be opened as a
    project have left it among them. */
function startable(): ProjectInfo[] {
  return workspace.open.filter((project) => startsIn(project.path));
}

/** Whether a session may be started in a project: it is open, and it is
    not the orchestrator folder. */
function isStartable(project: string): boolean {
  return startable().some((open) => open.path === project);
}

/** The open projects, the caller's own marked. */
function projectLines(request: Placed): string {
  const open = startable();
  if (open.length === 0)
    return "No projects are open in the workbench.";
  const here = projectOf(request.cwd);
  // The name is the one the pane shows: the folder's, with as much of the
  // path above it as tells it from another open project called the same.
  return open
    .map((project) =>
      [
        project.path,
        projectLabel(project.path),
        project.path === here ? "(this one)" : null,
      ]
        .filter((part) => part !== null)
        .join("  "),
    )
    .join("\n");
}

/** The open project a directory is in: the deepest one it lies under. */
function projectOf(cwd: string): string | null {
  return (
    startable()
      .map((project) => project.path)
      .filter((path) => within(cwd, path))
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}

/** How a session is at rest: gone, waiting on the user, gone quiet, or
    gone quiet after the user's key as far as the window can tell. That
    last is the window's guess, since stopping a turn fires no hook: a stop
    the agent's hooks report after it, in the same turn, is news. */
type Rest = "ended" | "permission" | "quiet" | "cut";

/**
 * What each session a caller started is doing about stopping, by the row's
 * key: whether it has worked, how it is at rest now, if it is, and how it
 * was at rest when the caller was last told, with the turn it was in then.
 * A stop is untold while the two differ, so a session that goes from one
 * kind of rest to another is reported again. One that works again starts
 * over once it is in another turn than the one the caller was told of: a
 * session whose hooks report its turns can be seen at work again within
 * the same one, as when a permission it asked for is granted, and coming
 * to the same rest again in it is nothing new. A session read off its
 * output has no turns but its spells of work, and each starts over.
 * Whether it has been seen not at rest in this window's run, too: a rest
 * that began before the window first saw the session, as after a reload,
 * wakes no one, unless the window before saw it begin and its caller had
 * not heard of it.
 */
type Mark = {
  worked: boolean;
  rest: Rest | null;
  told: Rest | null;
  /** The turn the session was in when the caller was told, if it was. */
  toldTurn: number | null;
  /** The turn the session is in, as last seen. */
  turn: number;
  seen: boolean;
  /** When it came to rest as it is now, as the window saw it. */
  restAt: number | null;
};

const stops = new Map<string, Mark>();

/** Moves whenever a stop goes untold or is told, for what is drawn from
    the marks, which are kept outside the rows' reactive state. Moved
    without being read, so an effect that moves it does not run again for
    it. */
const heard = $state({ version: 0 });
const moved = () => untrack(() => heard.version++);

const unheardMark = (mark: Mark | undefined) =>
  mark !== undefined && mark.rest !== null && mark.rest !== mark.told;

/** Brings the record of a started session's stops up to date with the row. */
function observe(session: Session) {
  const key = session.key;
  if (startedFor(key) === null) {
    if (stops.delete(key)) moved();
    return;
  }
  // Reopened the other way, it is the same session going on: how it is
  // stays as last seen until its next run is up.
  if (reopeningRow(key) && stops.has(key)) return;
  const fresh = !stops.has(key);
  const mark =
    stops.get(key) ?? { worked: false, rest: null, told: null, toldTurn: null, turn: 0, seen: false, restAt: null };
  const before = unheardMark(stops.get(key));
  const was = mark.rest;
  stops.set(key, mark);
  mark.turn = session.turns;
  // A session whose hooks report its turns has worked once it has begun
  // one, though the turn began and ended between two looks, and what the
  // caller was told of it was of the turn it was in then.
  if (session.exact) {
    if (session.turns > 0) mark.worked = true;
    if (mark.toldTurn !== session.turns) mark.told = null;
  }
  if (!isLive(session)) mark.rest = "ended";
  else if (session.needs === "permission") mark.rest = "permission";
  else if (session.working) {
    mark.worked = true;
    mark.rest = null;
    // At work again after a permission it was told of, the ask is over and
    // the next one is news. Only the same quiet rest within one turn is
    // not news twice.
    if (!session.exact || mark.told !== "quiet") mark.told = null;
  } else if (!mark.worked) mark.rest = null;
  else mark.rest = session.turnEnd === "cut" ? "cut" : "quiet";
  if (mark.rest !== was) mark.restAt = mark.rest === null ? null : Date.now();
  if (mark.rest === null) mark.seen = true;
  const { id } = session;
  const caller = startedFor(key);
  // A rest a window before this one saw come, which its caller has not
  // heard, was seen.
  if (fresh && mark.rest !== null && id !== null && caller !== null && untrack(() => remembered(caller, id)?.unheard))
    mark.seen = true;
  if (unheardMark(mark) !== before) moved();
  keepUnheard(key);
  // Kept with the run as well: a session that ends keeps what was last
  // seen of it before it ended.
  if (id !== null && caller !== null && mark.rest !== "ended") {
    const rested = mark.rest === "quiet" || mark.rest === "cut";
    untrack(() => keepRested(caller, id, rested));
  }
  // Up again in a row of its own, however it came back, why its last row
  // went is past.
  if (id !== null && caller !== null && isLive(session)) untrack(() => cameBack(caller, id));
}

/** The live row a caller's session has under the same id, when the one a
    wait watched has gone and another took its place. */
function rowAgain(owner: string, id: string | null): Session | null {
  if (id === null) return null;
  return sessions.all.find((row) => row.id === id && isLive(row) && startedFor(row.key) === owner) ?? null;
}

/** A session a caller started has a live row again: the reason its last
    row went is no longer what the tools say of it. */
function cameBack(caller: string, id: string) {
  const entry = remembered(caller, id);
  if (entry?.left === undefined) return;
  delete entry.left;
  saveStarted();
}

function observeAll() {
  const keys = new Set(sessions.all.map((session) => session.key));
  for (const key of stops.keys())
    if (!keys.has(key)) {
      stops.delete(key);
      moved();
    }
  for (const session of sessions.all) observe(session);
}

/** Whether a session has stopped and the caller has not been told. */
function untold(session: Session): boolean {
  observe(session);
  return unheardMark(stops.get(session.key));
}

function tell(key: string) {
  const mark = stops.get(key);
  if (mark === undefined || mark.told === mark.rest) return;
  mark.told = mark.rest;
  mark.toldTurn = mark.turn;
  moved();
  keepUnheard(key);
}

/** Keeps with a started session's record whether it came to rest while
    the window watched without its caller having heard. */
function keepUnheard(key: string) {
  untrack(() => {
    const row = byKey(key);
    const caller = startedFor(key);
    if (row === null || row.id === null || caller === null) return;
    const entry = remembered(caller, row.id);
    if (entry === null) return;
    const mark = stops.get(key);
    const unheard = mark !== undefined && unheardMark(mark) && mark.seen;
    if ((entry.unheard === true) === unheard) return;
    if (unheard) entry.unheard = true;
    else delete entry.unheard;
    saveStarted();
  });
}

/**
 * Notes stops as the rows change, so one that lands while no wait is
 * running is still there for the next call, and wakes a starter that is
 * idle for the stops it has not heard. Called once by the page; the
 * function it returns stops the watching.
 */
export function watchStops(): () => void {
  const stop = $effect.root(() => {
    $effect(observeAll);
    $effect(planWakes);
    $effect(forgetWoken);
    $effect(withdrawGone);
    $effect(planPutAways);
  });
  return () => {
    stop();
    for (const wake of wakes.values()) clearTimeout(wake.timer);
    wakes.clear();
    restingSince.clear();
    answeredAt.clear();
    for (const timer of puttingAway.values()) clearTimeout(timer);
    puttingAway.clear();
    leftToSee.clear();
  };
}

/** Whether a started session is still at work: running, and not at rest
    in any way, which takes in one that has not begun yet. */
function atWork(session: Session): boolean {
  observe(session);
  return isLive(session) && stops.get(session.key)?.rest === null;
}

/** A note for a caller, what counts it as told once it has reached the
    agent, and what counts it as not told again once the conversation went
    back on the message that carried it. */
export interface Note {
  text: string;
  deliver: () => void;
  untold: () => void;
}

/**
 * What a caller is told of the sessions it started as a message from the
 * user reaches it, ahead of the user's words: a line for each that stopped,
 * asked for permission or ended without the caller having heard, and, when
 * it was waiting on them or a wait of its was given up on since, which of
 * them are still at work. It counts as told, as a wait's answer does, once
 * it is delivered, and only as it was then: a session at rest another way
 * by that time is told again. A wait the caller still holds answers for the
 * sessions it watches itself, so the note leaves those out, unless
 * `ending`, which ends the wait for the message at once. Null when there
 * is nothing to say.
 */
function reportNote(caller: string, ending: boolean): Note | null {
  const kids = startedBy(caller);
  const holding = [...waiting.values()].filter((wait) => wait.caller === caller);
  const watched = new Set(ending ? [] : holding.flatMap((wait) => wait.watched));
  const lapsed = cut.has(caller);
  if (ending) endWaits([caller], USER_WROTE);
  const news = kids.filter((kid) => !watched.has(kid.key) && untold(kid));
  const reported = news.map((kid) => [kid.key, stops.get(kid.key)?.rest ?? null] as const);
  // How a call answered before it was done went, unless a wait the caller
  // holds is to tell it.
  const went = holding.length > 0 && !ending ? { calls: [], lines: [] } : laterNews(caller);
  const lines = [...went.lines, ...news.map((kid) => restText(kid))];
  const out = holding.length > 0 || lapsed ? kids.filter(atWork) : [];
  if (out.length > 0)
    lines.push(stillOutLine(either(out.map(namedAs), "and")));
  if (lines.length === 0) return null;
  // What each report was counted as before it was told, to count it so
  // again should the conversation go back on the message.
  let before: { key: string; rest: Rest | null; told: Rest | null; turn: number | null }[] = [];
  return {
    text: [REPORTS_HEAD, ...lines].join("\n"),
    deliver: () => {
      before = reported.map(([key, rest]) => {
        const mark = stops.get(key);
        return { key, rest, told: mark?.told ?? null, turn: mark?.toldTurn ?? null };
      });
      for (const [key, rest] of reported) tellAs(key, rest);
      if (went.calls.length > 0) toldLater(caller, went.calls);
      cut.delete(caller);
      // A wait the message is about to cut short has had its still-out
      // line.
      for (const wait of holding) wait.noted = true;
    },
    untold: () => {
      for (const { key, rest, told, turn } of before) untell(key, rest, told, turn);
      before = [];
    },
  };
}

/** The answer to a prompt hook's call as the user's message goes in: the
    note for the session the call's token names, told once the answer is
    left where the hook reads it. The core leaves none once the hook has
    stopped waiting, so a note the agent never read stays untold. The call
    is held to the agent's own id as well, so an agent started from a
    starter's shell, which has the starter's token in its environment, gets
    nothing; a Codex session whose id the window has not learned yet is
    taken at its token's word. A call that names no session the workbench
    runs gets nothing. An integrated session is given its note by the
    window, with the message itself. */
function promptNote(request: ConductRequest): Answered {
  const row = callerRow(request);
  const own = text(request, "agentSession");
  if (row === null || row.kind === "integrated" || own === null) return said("");
  if (row.id !== own && !(row.id === null && row.agent === "codex")) return said("");
  const note = reportNote(row.token, false);
  return note === null ? said("") : { ...said(note.text), delivered: note.deliver };
}

/** Counts a stop told as it was when the note was made, unless the session
    has since come to rest another way, which is news of its own. */
function tellAs(key: string, rest: Rest | null) {
  const mark = stops.get(key);
  if (mark === undefined || mark.rest !== rest || mark.told === rest) return;
  mark.told = rest;
  mark.toldTurn = mark.turn;
  moved();
}

// An integrated session is sent the user's message by the window, which
// puts the note in ahead of the words, tells it once the agent takes the
// message, and ends the session's waits, so the message is not held behind
// one.
notesFrom((key) => {
  const row = byKey(key);
  if (row === null) return null;
  return reportNote(row.token, true);
});

/**
 * The sessions a session started that stopped, asked or ended without it
 * having heard, while it is idle and holds no wait: what its row says it
 * has to read. None while it works or waits, since it may yet look.
 */
export function unheard(session: Session): Session[] {
  void heard.version;
  if (!isLive(session) || session.working || session.needs === "permission") return [];
  if ((conductor.listening[session.token] ?? 0) > 0) return [];
  return startedBy(session.token).filter((kid) => unheardMark(stops.get(kid.key)));
}

/**
 * Waking a starter.
 *
 * A session that started others and handed its turn back hears nothing of
 * them until it calls wait or the user writes to it. So once one of them
 * comes to rest, and its starter is idle, the workbench sends the starter
 * what a wait would have answered, as its own message, and the starter
 * takes the work up from there. The sessions that come to rest within a
 * moment of each other go in one message, and while others it started are
 * still at work the wake waits for them a while, longer for a starter
 * whose prompt cache has lapsed. A session asking for permission is the
 * user's to answer: it goes along in a wake and sets none off.
 *
 * Idle is narrow. The starter is running, ended its last turn itself, as
 * its hooks or its events say, and holds no wait; it is not asking for
 * anything; the user is not writing to it, in its composer or with keys in
 * its terminal that its agent has not taken in; and, in a terminal, the
 * user's keys there have been still a while. A turn the user cut short
 * leaves it unwoken until a turn of theirs ends. A line typed into it, by
 * `send` or a wake, leaves it so until a turn of its agent's ends, and
 * lines are typed into a terminal one at a time. A session another
 * started cannot start sessions of its own, so no two sessions can wake
 * each other in turn. After
 * WAKES_MAX wakes with no turn between that the workbench did not start,
 * it is not woken again until one begins, so a session that ends turns on
 * its own does not keep its starter at work with no one there. An agent
 * the workbench did not start has no row to wake.
 *
 * What it is woken for counts as told the moment it is sent, so the prompt
 * hook the message sets off has nothing to say again, and a window
 * reloaded afterwards does not send it twice; a message that never
 * reaches the agent, or a line typed into a terminal that starts no turn,
 * leaves it untold. A rest the window did not see begin wakes no one.
 */

/** How long a line sent to a session being reopened waits for its next
    run to be up. */
const MOVE_WAIT = 30_000;

/** The most times a starter is woken with no turn between that the
    workbench did not start. */
export const WAKES_MAX = 5;
/** How long a turn has to begin after a wake is typed into a terminal: one
    that has not begun by then never reached the agent, as when its Enter
    took a completion, and what the wake carried is untold again. */
export const WAKE_TAKEN = 30_000;

/** The wakes on their way, by the starter's row key, with when each goes,
    and whether it waits for the user's keys in the starter's terminal to
    be still. */
const wakes = new Map<string, { timer: ReturnType<typeof setTimeout>; at: number; keys?: true }>();
/** Since when each row has not been at work, as the window saw it. */
const restingSince = new Map<string, number>();
/** When the window first saw each call answered later done, by the call's
    id, so the wake for it goes a moment after that however often wakes
    are planned meanwhile. */
const answeredAt = new Map<string, number>();
/** Starters whose wake is being typed or sent. */
const waking = new Set<string>();
/** Starters whose next turn is the one their wake began, with what gives
    a wake typed into a terminal up if that turn has not begun in time. */
const wakeTurns = new Map<string, ReturnType<typeof setTimeout> | null>();

/** Whether a session is idle in the way a wake asks. A run being moved the
    other way is on its way out, and the next run takes the wake. */
function idle(starter: Session): boolean {
  if (starter.status !== "running" || starter.working || starter.needs !== null) return false;
  if (reopeningRow(starter.key)) return false;
  if (starter.turnEnd !== "done") return false;
  if ((conductor.listening[starter.token] ?? 0) > 0) return false;
  if (starter.kind === "integrated")
    return handleOf(starter.key) !== null && !userWriting(starter.key);
  return starter.ptyId !== null && !drafting(starter.key);
}

/** Whether a starter has been woken as often as it may be with no turn
    between that the workbench did not start. */
function spent(starter: Session): boolean {
  return (conductor.wakesInRow[starter.key] ?? 0) >= WAKES_MAX;
}

/** The sessions a starter is woken for: the ones it started that came to
    rest, while the window watched, without its having heard. */
function wakeNews(starter: Session): Session[] {
  return startedBy(starter.token).filter((kid) => {
    const mark = stops.get(kid.key);
    return unheardMark(mark) && mark!.seen;
  });
}

/** Whether a starter has rested long enough for its prompt cache to have
    lapsed. */
function cold(starter: Session, now: number): boolean {
  return now - (restingSince.get(starter.key) ?? now) >= COLD_AFTER[starter.agent];
}

/**
 * When an idle starter is woken, or null when nothing it has to hear wakes
 * it: a session asking for permission is the user's to answer, so it goes
 * along in a wake but sets none off. With nothing else it started at
 * work, a session that failed or ended to hear, which the starter may
 * want to take up at once, or a call answered later, the wake goes a
 * moment after the last came to rest or the call was seen done. While
 * others are at work it waits for them to come along: a warm starter a
 * while after the last, within a bound after the first, and a cold one
 * until they are done, within a longer bound, since each wake of a cold
 * starter reads its whole conversation again. Never sooner than a moment
 * after the starter came to rest itself.
 */
function wakeAt(starter: Session, now: number): number | null {
  const news = wakeNews(starter).filter((kid) => stops.get(kid.key)?.rest !== "permission");
  const calls = laterNews(starter.token).calls.map((call) => {
    if (!answeredAt.has(call)) answeredAt.set(call, now);
    return answeredAt.get(call)!;
  });
  if (news.length === 0 && calls.length === 0) return null;
  const rests = news.map((kid) => stops.get(kid.key)?.restAt ?? now);
  const first = Math.min(...rests, ...calls);
  const last = Math.max(...rests, ...calls);
  const soonest = (restingSince.get(starter.key) ?? now) + WAKE_AFTER;
  const pressing =
    calls.length > 0 ||
    !startedBy(starter.token).some(atWork) ||
    news.some((kid) => ["failed", "ended"].includes(restWay(kid).way));
  const at = pressing
    ? last + WAKE_AFTER
    : cold(starter, now)
      ? first + COLD_MOST
      : Math.min(last + GATHER, first + GATHER_MOST);
  return Math.max(soonest, at);
}

/** How a starter's wake is held back for others to come along, while it
    is: for a moment while it is warm, until the rest are done while it is
    cold. Null when it is not held. */
export function wakeHeld(session: Session): "gathering" | "cold" | null {
  void heard.version;
  const wake = wakes.get(session.key);
  if (wake === undefined) return null;
  const now = Date.now();
  if (wake.at - now <= WAKE_AFTER || !startedBy(session.token).some(atWork)) return null;
  return cold(session, now) ? "cold" : "gathering";
}

/** Sets a wake on its way for each starter that is idle with something to
    hear, for when it goes, and calls back the ones whose starter is no
    longer so. */
function planWakes() {
  void heard.version;
  const now = Date.now();
  for (const row of sessions.all)
    if (row.working) restingSince.delete(row.key);
    else if (!restingSince.has(row.key)) restingSince.set(row.key, now);
  for (const key of restingSince.keys()) if (byKey(key) === null) restingSince.delete(key);
  const later = new Set(Object.values(conductor.later).flatMap((list) => list.map((one) => one.call)));
  for (const call of answeredAt.keys()) if (!later.has(call)) answeredAt.delete(call);
  const due = new Map<string, number>();
  for (const starter of sessions.all) {
    if (!idle(starter) || spent(starter)) continue;
    const at = wakeAt(starter, now);
    if (at !== null) due.set(starter.key, at);
  }
  for (const [key, wake] of wakes)
    if (!due.has(key) || (wake.keys !== true && due.get(key) !== wake.at)) {
      clearTimeout(wake.timer);
      wakes.delete(key);
    }
  for (const [key, at] of due)
    if (!wakes.has(key) && !waking.has(key))
      wakes.set(key, { timer: setTimeout(() => void wakeUp(key), Math.max(0, at - now)), at });
}

/** A wake's time has come: it goes when the starter is still idle, later
    while the user's keys in its terminal have not been still long. */
async function wakeUp(key: string) {
  wakes.delete(key);
  const starter = byKey(key);
  if (starter === null || !idle(starter) || spent(starter)) return;
  if (wakeAt(starter, Date.now()) === null) return;
  const news = wakeNews(starter);
  const still = starter.kind === "terminal" ? keysStillIn(key, WAKE_QUIET) : 0;
  if (still > 0) {
    wakes.set(key, { timer: setTimeout(() => void wakeUp(key), still), at: Date.now() + still, keys: true });
    return;
  }
  waking.add(key);
  try {
    await wake(starter, news);
  } finally {
    waking.delete(key);
    moved();
  }
}

/** Marks that read as the bar between sessions, once a line is in its
    compatibility form, where a fullwidth bar is a plain one: vertical lines
    of every kind, from box drawing, mathematics and other scripts. */
const BAR_LIKE =
  /[|\u01c0\u05c0\u0964\u0965\u2016\u2223\u2225\u23b8\u23b9\u23d0\u2502\u2503\u2506\u2507\u250a\u250b\u254e\u254f\u2551\u2575\u2577\u2579\u257b\u2758-\u275a]/g;

/** A line of a wake typed into a terminal, where a bar keeps the sessions
    apart: any bar of its own, or anything that reads as one, in a session's
    name or last line, is another mark, so nothing in it reads as the start
    of another session's line. */
const barless = (line: string) => line.normalize("NFKC").replace(BAR_LIKE, "\u00a6");

/**
 * Sends a starter what the sessions it is woken for did, in the words a
 * wait answers with, and which of the rest are still at work. An
 * integrated starter is sent it as the workbench's message; one in a
 * terminal has it typed in on one line, as send types a line, once any
 * line being typed into it is in, and only while it is still idle, then
 * and again before the Enter.
 */
async function wake(starter: Session, news: Session[]) {
  const key = starter.key;
  // How a call answered before it was done went, first: told as the wake
  // is sent, and untold again if it never reaches the starter.
  const went = laterNews(starter.token);
  const kept = (conductor.later[starter.token] ?? []).filter((one) => went.calls.includes(one.call));
  const lines = [...went.lines, ...news.map((kid) => restText(kid))];
  const out = startedBy(starter.token).filter(atWork);
  if (out.length > 0) lines.push(atWorkLine(either(out.map(namedAs), "and")));
  const told = news.map((kid) => {
    const mark = stops.get(kid.key)!;
    return { key: kid.key, rest: mark.rest, before: mark.told, beforeTurn: mark.toldTurn };
  });
  for (const { key: kid, rest } of told) tellAs(kid, rest);
  if (went.calls.length > 0) toldLater(starter.token, went.calls);
  const lost = () => {
    for (const { key: kid, rest, before, beforeTurn } of told) untell(kid, rest, before, beforeTurn);
    if (kept.length > 0) {
      const back = $state.snapshot(kept) as Later[];
      conductor.later[starter.token] = [...back, ...(conductor.later[starter.token] ?? [])];
      saveLater();
      moved();
    }
    gaveUp(key);
  };
  // The row says which sessions it was woken for; a call alone names none.
  if (news.length > 0)
    conductor.woken[key] = {
      by: news.map((kid) => ({ key: kid.key, name: label(kid), rest: stops.get(kid.key)!.rest! })),
      at: Date.now(),
    };
  conductor.wakesInRow[key] = (conductor.wakesInRow[key] ?? 0) + 1;
  logUsage(starter, "wake", { reports: news.length, others: out.length });
  if (starter.kind === "integrated") {
    wakeTurns.set(key, null);
    if (sendAsWorkbench(key, [REPORTS_HEAD, ...lines].join("\n"), lost) === null) lost();
    else starter.turnEnd = null;
    return;
  }
  wakeTurns.set(key, setTimeout(lost, WAKE_TAKEN));
  try {
    await typeLine(
      key,
      starter.ptyId!,
      oneLine(`${REPORTS_HEAD} ${lines.map(barless).join(" | ")}`),
      () => !idle(starter),
    );
  } catch {
    lost();
  }
}

/** Takes back a stop counted told by a wake that never reached the
    starter, unless it has been told or come to rest another way since. */
function untell(key: string, rest: Rest | null, before: Rest | null, beforeTurn: number | null) {
  const mark = stops.get(key);
  if (mark === undefined || mark.rest !== rest || mark.told !== rest) return;
  mark.told = before;
  mark.toldTurn = beforeTurn;
  moved();
}

/** Forgets that a starter's next turn is its wake's. */
function noWakeTurn(key: string) {
  const timer = wakeTurns.get(key);
  if (timer !== undefined && timer !== null) clearTimeout(timer);
  wakeTurns.delete(key);
}

/** A wake that never reached the starter: it is not woken again until a
    turn of its own has ended, so a starter that cannot be reached is not
    tried over and over. */
function gaveUp(key: string) {
  delete conductor.woken[key];
  noWakeTurn(key);
  const row = byKey(key);
  if (row !== null) row.turnEnd = null;
}

// A woken starter's mark stays while the turn its wake began runs and
// after, and goes once a turn begins that the workbench did not start: the
// user's, or a line another session sent. Such a turn starts the count of
// its wakes over.
onTurn((session) => {
  if (wakeTurns.has(session.key)) {
    noWakeTurn(session.key);
    return;
  }
  delete conductor.woken[session.key];
  delete conductor.wakesInRow[session.key];
});

/** Lets a woken starter's mark go once the user has looked at it with the
    turn its wake began over, as looking clears the line a row was left,
    and with its row. */
function forgetWoken() {
  for (const key of Object.keys(conductor.woken)) {
    const row = byKey(key);
    if (row === null || (isViewed(row) && !row.working && !wakeTurns.has(key))) delete conductor.woken[key];
  }
  for (const key of Object.keys(conductor.wakesInRow)) if (byKey(key) === null) delete conductor.wakesInRow[key];
}

/** Whether a wake is on its way to a starter: set to go within a moment,
    or being typed or sent. One held back for others to come along is not
    yet: the starter may be moved meanwhile, and its next run takes it. */
export function wakeComing(key: string): boolean {
  void heard.version;
  const wake = wakes.get(key);
  return (wake !== undefined && wake.at - Date.now() <= WAKE_AFTER) || waking.has(key) || wakeTurns.has(key);
}

/** Whether the workbench has stopped waking a starter, having woken it as
    often as it may with no turn between that it did not start: what the
    starter has not heard waits for its next wait or the user. */
export function wakesSpent(session: Session): boolean {
  return spent(session);
}

/** The starter's mark: the sessions it was woken for, while it is kept. */
export function wokenBy(session: Session): Woken | null {
  return conductor.woken[session.key] ?? null;
}

/**
 * The caller's own sessions, the ones it started: the user's own are on
 * their own subjects, and a session directing work has no business in
 * them, not even to know what they are. A session with no id yet is left
 * out: the id is how the agent names one. After the rows, the sessions the
 * caller started that are no longer open, from this run or an earlier one,
 * which a start with the session named brings back.
 */
function sessionLines(request: Placed): string {
  const only = text(request, "project");
  const listed = sessions.all.filter(
    (session) =>
      session.id !== null &&
      mine(request, session) &&
      (only === null || session.project === only),
  );
  const gone = (conductor.started[callerOf(request)] ?? []).filter(
    (entry) =>
      byId(entry.id) === null && (only === null || entry.project === only),
  );
  const caller = callerOf(request);
  const news = laterNews(caller);
  const owed = laterWaiting(caller);
  if (listed.length === 0 && gone.length === 0 && news.calls.length === 0 && owed.length === 0)
    return "You have started no sessions.";
  const lines = [
    ...news.lines,
    ...owed.map((one) =>
      onUser.has(one.call)
        ? `Your ${one.what} waits on the user's answer; wait tells you how it went.`
        : `Your ${one.what} is still under way; wait tells you how it went.`,
    ),
    ...listed.map(describe),
    ...gone.map((entry) => describeGone(caller, entry)),
  ];
  // Listing a stop is telling it, and so is listing how a call went.
  for (const session of listed) tell(session.key);
  if (news.calls.length > 0) toldLater(caller, news.calls);
  return lines.join("\n");
}

function describe(session: Session): string {
  const parts = [idText(session.id!), quotedName(label(session)), session.project];
  const tree = session.worktree ?? session.startIn;
  if (tree !== null && tree !== session.project) parts.push(`worktree ${oneLine(tree)}`);
  parts.push(session.agent);
  const place = placeOf(session.key);
  if (place !== null) parts.push(placeText(place));
  parts.push(stateWords(session));
  // A row with nothing running behind it is resumed in place.
  if (!isLive(session)) parts.push(`resume it with start, naming session ${idText(session.id!)}`);
  if (untold(session)) parts.push("not reported to you yet");
  const line = quotedLine(session.note);
  if (line !== null) parts.push(`last line: ${line}`);
  return parts.join("  ");
}

/** A remembered session that is not open as a row, in the same words. */
function describeGone(owner: string, entry: Started): string {
  const parts = [
    idText(entry.id),
    quotedName(sessions.names[entry.id] ?? entry.name ?? entry.id.slice(0, 8)),
    entry.project,
  ];
  if (entry.worktree !== null) parts.push(`worktree ${oneLine(entry.worktree)}`);
  parts.push(entry.agent);
  const at = placed(owner, entry.id);
  if (at !== null) parts.push(placeText(at));
  parts.push(
    goneState(entry),
    backOnALine(entry) ? "a line you send it resumes it" : `resume it with start, naming session ${idText(entry.id)}`,
  );
  return parts.join("  ");
}

/** Why a remembered session has no row, in a listing's words. */
function goneState(entry: Started): string {
  if (entry.left === "closed") return "closed by the user";
  if (entry.left === "ended") return "ended";
  if (entry.left === "done") return "put away by the workbench once its work was over";
  return "not running since the workbench was restarted";
}

/** Where a session stands in the workflow, in the words the tools answer
    in: its step, and for a review the round and the work it checks. */
export function placeText(place: Place): string {
  if (place.kind === "work") return `step "${place.step}"`;
  return `step "${place.step}" round ${place.round ?? 1}, reviewing session ${place.work === null ? "unknown" : idText(place.work)}`;
}

/** What a session is doing, in the words the tools answer in. */
export function stateOf(session: Session): string {
  switch (session.status) {
    case "dormant":
      return "not started since the workbench restarted";
    case "starting":
      return "starting";
    case "exited":
      return "exited";
    case "crashed":
    case "failed":
      return "stopped";
    default:
      if (session.needs === "permission") return "asking for permission";
      return session.working ? "working" : "waiting";
  }
}

/** Starts a session for the caller, once the user allows it. With a
    session named, resumes one of the caller's own instead. */
async function startSession(request: Placed): Promise<Answered> {
  const resuming = text(request, "session");
  if (resuming !== null) return resumeSession(request, resuming);
  const project = text(request, "project");
  const prompt = text(request, "prompt");
  const name = text(request, "name");
  if (project === null) return refused("Starting a session needs a project.");
  if (prompt === null)
    return refused("Starting a session needs a prompt to give it.");
  // A model's name means something to one agent only, so the agent is
  // named with it rather than taken from the project's last one.
  if (text(request, "model") !== null && text(request, "agent") === null)
    return refused(
      "A start that names a model names the agent too, claude-code or codex: the model's name is the agent's to read.",
    );
  if (!isStartable(project))
    return refused(`No project at ${project} is open in the workbench.`);
  const wanted = wantedAccount(request);
  if ("refusal" in wanted) return refused(wanted.refusal);
  const caller = callerOf(request);
  const room = roomFor(request);
  if (room !== null) return room;
  // A caller that follows a workflow starts sessions in its shape. What the
  // start takes, a place in a work step or a round of a review, is taken
  // now, before anything is awaited, and given back if it does not happen.
  const flow = callerFlow(request);
  if ("refusal" in flow) return refused(flow.refusal);
  if (flow.workflow !== null && mayChangeModel(oneLine(prompt)))
    return refused(
      "A session you start for a step of your workflow runs on the model the step allows, so its prompt is words, not a command: the workbench starts none with a prompt that begins with a slash, a path included. Put a word before it.",
    );
  const fit =
    flow.workflow === null ? null : fitStart(request, flow.workflow, caller);
  if (fit !== null && "refusal" in fit) return refused(fit.refusal);
  let started = false;
  try {
    const answer = await startFitted(request, project, prompt, name, wanted.named, caller, fit);
    started = answer.error === null;
    return answer;
  } finally {
    fit?.release(started);
  }
}

/** The account a start names: one the user named in the settings, by its
    name, or the agents' own, by the name they go by, which no account of
    the user's can have. `named` is null where the start names none, and
    holds null for the agents' own. */
function wantedAccount(request: Placed): { named: { account: string | null } | null } | { refusal: string } {
  const wanted = text(request, "account");
  if (wanted === null) return { named: null };
  if (namesOwn(wanted)) return { named: { account: null } };
  if (wanted in accounts.list) return { named: { account: wanted } };
  const own = `${OWN_LABEL} for the agents' own login`;
  return {
    refusal:
      names().length === 0
        ? `There are no accounts in the workbench's settings, only ${own}: leave the account out.`
        : `There is no account called ${wanted}. The accounts are ${names().join(", ")}, and ${own}.`,
  };
}

/** How many characters a name a caller gives a session keeps: as many as
    a row's name taken from a first message. */
export const NAME_MOST = 60;

/** A name cut to what a row's name holds, marked where it was cut. */
function nameCut(name: string): string {
  const chars = Array.from(name);
  return chars.length > NAME_MOST ? `${chars.slice(0, NAME_MOST - 1).join("")}…` : name;
}

/** The sentence a started session's prompt ends with, by the way its
    agent runs: a conversation's row reads its last message, a terminal's
    the line it gives the notify tool. */
function outcomeAsk(agent: AgentId): string {
  return kindFor(agent) === "integrated" ? OUTCOME_ASK : OUTCOME_ASK_TERMINAL;
}

/** The rest of a start, once it has been held to the caller's workflow:
    the account it runs under, which turns on the agent the step chose, the
    question, and the session itself. */
async function startFitted(
  request: Placed,
  project: string,
  prompt: string,
  name: string | null,
  wanted: { account: string | null } | null,
  caller: string,
  fit: Fit | null,
): Promise<Answered> {
  const wants = flag(request, "worktree");
  const agent = fit?.agent ?? agentOf(request, project);
  const { account, say } = underFor(request, project, agent, wanted);
  const bare =
    account !== null && dirFor(account, agent) === undefined ? agent : null;
  // The account is said to the user in the question and to the caller in
  // the answer.
  const named: Named | null = say
    ? {
        label: accountLabel(account),
        projects: account === accountOf(project),
        bare,
      }
    : null;
  const beyond = fit?.beyond ?? null;
  if (kindFor(agent) === "terminal" && runsShell(oneLine(prompt))) return refused(SHELL_PROMPT);
  const unasked = !startAsk.every && beyond === null && ownStart(request, project, agent, account);
  if (unasked && mayChangeModel(oneLine(prompt))) return refused(UNASKED_PROMPT);
  const given = givenMode(callingSession(request), agent);
  const answer = unasked
    ? "once"
    : await askUser(request, project, prompt, wants, { account, bare }, named, beyond);
  if (!unasked && callerGone(request)) return refused(CALLER_GONE);
  if (answer === "no") {
    if (beyond !== null) stopAtLimit(callerOf(request), beyond);
    return {
      ...refused(
        beyond === null
          ? "The user did not allow the session to be started."
          : notAllowed(beyond),
      ),
      byUser: true,
    };
  }

  let startIn: string | null = null;
  if (wants) {
    // The core numbers a name the project already has, so the path it
    // answers with is the one to run in.
    try {
      startIn = await core().worktreeAdd(
        project,
        worktreeName(name ?? prompt),
        dirsOf(),
      );
    } catch (error) {
      return refused(`The worktree could not be made: ${String(error)}`);
    }
    madeTree(caller, project, startIn);
  }

  // A started session does not take the window: the user is in the session
  // that started it, and that is where its questions are answered. The row
  // appears folded under its project, and going to it is a click.
  const looking = sessions.active;
  const chosen = fit === null ? text(request, "model") : fit.model;
  const below = chosen === null && fit?.place.kind !== "review" ? modelBelow(callingSession(request), agent, account) : null;
  const model = chosen ?? below;
  const session = create(
    project,
    null,
    agent,
    startIn,
    `${oneLine(prompt)} ${outcomeAsk(agent)}`,
    model,
    account,
    null,
  );
  // It begins in its starter's mode, the narrower of the one asked about
  // and the one now where the starter's changed meanwhile.
  session.modeGiven = narrowerOf(agent, given, givenMode(callingSession(request), agent));
  const begins = session.modeGiven === null ? "" : ` It begins in ${modeName(agent, session.modeGiven)} mode.`;
  conductor.startedBy[session.key] = caller;
  if (fit !== null) {
    conductor.places[session.key] = fit.place;
    // The row holds its place in the step from here.
    fit.hold();
  }
  // The name the caller gave is the row's, until the agent names it, cut
  // to what a row's name holds. One that reads as "You" is the user's
  // alone, one that reads as "Workbench" the workbench's, one that reads as
  // an agent's that agent's, and one another live session has is that
  // session's: none is taken, and the row is named by the prompt instead.
  // Weighed as it would be stored.
  const candidate = name === null ? null : nameCut(oneLine(name));
  const you = candidate !== null && readsAsYou(candidate);
  const taken = candidate !== null && !you && nameTaken(candidate, session.key);
  const called = candidate !== null && !you && !taken ? candidate : null;
  if (called !== null) session.title = called;
  if (looking !== null && byKey(looking) !== null) sessions.active = looking;

  const id = await idFor(session.key);
  if (id === null) {
    const row = byKey(session.key);
    return refused(
      row === null
        ? "The session was closed before it started."
        : statusMessage(row),
    );
  }
  const row = byKey(session.key);
  if (row !== null) logUsage(row, "start", { starter: caller, modelBelow: below !== null });
  remember(caller, {
    id,
    project,
    worktree: startIn,
    agent,
    name: called,
    account,
    ...(unasked ? { unasked: true as const } : {}),
  });
  // Kept by the session's id as well, as any name is, so the row is called
  // so after a restart; unless the agent named it meanwhile.
  if (called !== null && byKey(session.key)?.title === called) nameRow(session.key, called);
  const where = startIn === null ? project : `${project}, in ${startIn}`;
  const notCalled = you
    ? ` It is not called ${quotedName(name!)}: a conversation shows the user's own words under that name, so the session is named by its prompt.`
    : taken
      ? mixesScripts(candidate!)
        ? ` It is not called ${quotedName(name!)}: its letters mix scripts, as a name made to pass for another's does, so the session is named by its prompt.`
        : readsAsWorkbench(candidate!)
          ? ` It is not called ${quotedName(name!)}: a conversation shows the workbench's own messages under that name, so the session is named by its prompt.`
          : readsAsAgent(candidate!)
            ? ` It is not called ${quotedName(name!)}: a conversation shows an agent's own words and requests under that name, so the session is named by its prompt.`
            : ` It is not called ${quotedName(name!)}: another session is called that, so the session is named by its prompt.`
      : called !== null && called !== oneLine(name!)
        ? ` Its name is cut to ${NAME_MOST} characters: ${quotedName(called)}.`
        : "";
  const runsOn =
    model === null
      ? ` It runs on ${agentLabel(agent)}'s default model.`
      : below !== null
        ? ` It runs on ${sessionModelLabel(model)}, one model below yours, since the start named none: name a model to choose another.`
        : ` It runs on ${sessionModelLabel(model)}.`;
  if (fit === null)
    return said(
      `Started session ${idText(id)} in ${where}${underWords(named)}. It has the prompt.${runsOn}${begins}${notCalled} ${KEEP_WAITING}`,
    );
  // A work session that began a piece is the piece's name from here.
  const at: Place = { ...fit.place, piece: fit.place.piece ?? id };
  conductor.places[session.key] = at;
  place(caller, id, at);
  return said(
    `Started session ${idText(id)} for ${placeText(at)} in ${where}${underWords(named)}. It has the prompt.${runsOn}${begins}${notCalled} ${KEEP_WAITING}`,
  );
}

/** Claude's models, most capable first, by the family a model's name
    begins with, and the alias the next one down is started by. */
const TIERS = ["fable", "opus", "sonnet", "haiku"];

/** The family of a Claude model's name, `claude-opus-5-5[1m]` or `opus`
    alike, or null for a name of none of them. */
function familyOf(model: string): string | null {
  const family = model.toLowerCase().replace(/^claude-/, "").replace(/\[.*\]$/, "").split("-")[0];
  return TIERS.includes(family) ? family : null;
}

/**
 * The model a session is started on when neither the start nor its step
 * names one: one below its starter's, by the alias that follows the newest
 * of that family, where the starter runs Claude Code on a model above
 * Sonnet and the session runs Claude Code too. Most work handed out needs
 * less than the session directing it, and every turn costs by the model.
 * The starter's model is the one its agent reports, which only a
 * conversation does: a terminal's may have changed since it started. Null
 * otherwise, for the agent's own default: a starter on Sonnet or below, a
 * terminal starter, one whose model the window does not know, any other
 * agent, and where the model below would be above the default the account
 * runs on, as far as the window has heard.
 */
function modelBelow(starter: Session | null, agent: AgentId, account: string | null): string | null {
  if (starter === null || starter.kind !== "integrated" || starter.model === null) return null;
  if (starter.agent !== "claude-code" || agent !== "claude-code") return null;
  const at = TIERS.indexOf(familyOf(starter.model) ?? "");
  if (at < 0 || at >= TIERS.indexOf("sonnet")) return null;
  const fallback = defaultModelOf(agent, account);
  const floor = fallback === null ? -1 : TIERS.indexOf(familyOf(fallback) ?? "");
  return floor > at + 1 ? null : TIERS[at + 1];
}

/**
 * The account a start runs under, and whether the question and the answer
 * name it.
 *
 * An account the start names is the one, the agents' own by the name
 * they go by among them. Otherwise the caller's own is
 * handed on when it was chosen for the caller's session, which is when it
 * is not the account of the caller's project; a caller that runs under its
 * project's, the one for every project included, hands nothing on, and the
 * session runs under the account of the project it starts in. That is the
 * project's as well when the caller's chosen account cannot be handed on:
 * the project is on another machine than the caller, where the caller's
 * login may not be, or the settings no longer hold the account. An account
 * handed on that keeps no directory for the agent runs it on the agent's
 * own, as a blank directory does anywhere.
 *
 * Once there are accounts to tell apart, the account is named when it is
 * not the project's own, when the caller's chosen account was not handed
 * on, when one handed on keeps no directory for the agent, and for an agent
 * the workbench did not start, which hands none on.
 */
function underFor(
  request: Placed,
  project: string,
  agent: AgentId,
  wanted: { account: string | null } | null,
): { account: string | null; say: boolean } {
  const own = accountOf(project);
  const under = (account: string | null, anyway: boolean) => ({
    account,
    say: hasAccounts() && (anyway || account !== own),
  });
  if (wanted !== null) return under(wanted.account, false);
  const calling = callingSession(request);
  if (calling === null) return under(own, true);
  const theirs = calling.account;
  if (theirs === accountOf(calling.project)) return under(own, false);
  if (hostOf(calling.project) !== hostOf(project)) return under(own, true);
  if (theirs !== null && !(theirs in accounts.list)) return under(own, true);
  return under(theirs, theirs !== null && dirFor(theirs, agent) === undefined);
}

/**
 * Whether a start is the caller's to make without asking the user: the
 * caller is a session the workbench runs, and the session would run in the
 * caller's own project, on a worktree of it or not, on the caller's agent,
 * under the caller's account, while the window knows the caller's mode and
 * can place it on the scale of modes. The same agent and account mean the
 * same login and the same directory of the agent's own settings. The
 * session begins in the caller's mode, so it begins in no more than the
 * caller. A Claude Code terminal's mode is known only once its hooks have
 * said it, so one whose hooks have not is asked about. A Codex terminal is
 * not compared: its hooks never say its mode, and Codex asks before
 * `start` itself in each of its modes but full access. Every other start
 * is asked about, an agent the workbench did not start, which has no
 * project of its own to the workbench, among them.
 */
function ownStart(request: Placed, project: string, agent: AgentId, account: string | null): boolean {
  const calling = callingSession(request);
  if (calling === null || calling.project !== project || calling.agent !== agent || calling.account !== account)
    return false;
  if (uncompared(calling)) return true;
  const now = modeNow(calling);
  return now !== null && fitMode(calling.agent, now, agent) !== null;
}

/** A Codex session in a terminal, whose mode the window does not compare
    before a start. */
function uncompared(session: Session): boolean {
  return session.kind !== "integrated" && session.agent === "codex";
}

/** The mode a session runs in now, where the window knows it: an
    integrated session's as its agent says, a Claude Code terminal's as its
    hooks last said, since a mode chosen in it is seen only through them,
    and a Codex terminal's as the workbench started it, since its hooks
    never say and a change made in it is not seen. Null where none is
    known. */
function modeNow(session: Session): string | null {
  if (session.kind === "integrated") return linkOf(session.key)?.conversation.settings.mode ?? null;
  return session.agent === "claude-code" ? session.modeSeen : session.modeNamed;
}

/** The mode a session of `agent` that `starter` starts begins in: the
    starter's own as far as that agent has it, else the mode the starter
    was started in, as a cap on a start the user allowed. Null where
    neither is known, or on the scale. */
function givenMode(starter: Session | null, agent: AgentId): string | null {
  const mode = starter === null ? null : (modeNow(starter) ?? starter.modeNamed);
  return starter === null || mode === null ? null : fitMode(starter.agent, mode, agent);
}

/** The session a placed call comes from, while it runs: the one its token
    names. Null once that session has stopped, and for an agent the
    workbench did not start. */
function callingSession(request: Placed): Session | null {
  return callerRow(request);
}

/** What a start in a workflow's shape comes to: where the session stands,
    and the agent and model it runs on, null where the step leaves them to
    the call. */
interface Fit {
  place: Place;
  agent: AgentId | null;
  model: string | null;
  /** For a round past the review's limit, what the user is asked to allow. */
  beyond: Beyond | null;
  /** The row now holds the place in the step the start took. */
  hold: () => void;
  /** Gives back what the start took, unless it started. */
  release: (started: boolean) => void;
}

/** Names the same when they differ only in the case of A to Z, as the
    workflows compare them. */
const asciiLower = (name: string) =>
  name.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const sameName = (a: string, b: string) => asciiLower(a) === asciiLower(b);

const quoted = (name: string) => `"${name}"`;

/** A list in a sentence: "a", "a or b", "a, b or c". */
function either(items: string[], joiner = "or"): string {
  return items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} ${joiner} ${items[items.length - 1]}`;
}

/** The steps of a workflow, each with its kind, for an answer. */
function stepsText(workflow: Workflow): string {
  return either(
    workflow.steps.map((step) => `${quoted(step.name)} (${step.kind})`),
    "and",
  );
}

/**
 * Holds a start to the caller's workflow. The step is named, and is one the
 * workflow has; the model is one the step allows, its first when none is
 * named; a work step has room for another session; a review is of a session
 * the caller started for a work step, with rounds left for that piece.
 * Each refusal says what would do.
 */
function fitStart(
  request: Placed,
  workflow: Workflow,
  caller: string,
): Fit | { refusal: string } {
  const named = text(request, "step");
  if (named === null)
    return {
      refusal: `You follow the workflow ${quoted(workflow.name)}, so a start names the step it is for, with step. The steps are ${stepsText(workflow)}.`,
    };
  const step = workflow.steps.find((candidate) =>
    sameName(candidate.name, named),
  );
  if (step === undefined)
    return {
      refusal: `The workflow ${quoted(workflow.name)} has no step called ${quoted(named)}. The steps are ${stepsText(workflow)}.`,
    };
  const runs = modelFor(text(request, "agent"), text(request, "model"), step);
  if ("refusal" in runs) return runs;
  const from = text(request, "work");

  if (step.kind === "work") {
    const full = noRoom(caller, step);
    if (full !== null) return { refusal: full };
    // Work that carries on a piece another work session began names it,
    // so the piece's reviews go on counting; without one it begins a piece.
    let piece: string | null = null;
    if (from !== null) {
      const earlier = placed(caller, from);
      if (earlier === null)
        return {
          refusal: `Session ${from} is not one you started for a step of ${quoted(workflow.name)}, so there is no piece of work to carry on. Leave work out to begin a new piece.`,
        };
      piece = earlier.piece ?? from;
    }
    const free = reserveSlot(caller, step.name);
    return {
      ...runs,
      place: {
        step: step.name,
        kind: "work",
        piece,
        round: piece === null ? null : workRound(caller, workflow, step, piece),
        work: null,
      },
      beyond: null,
      hold: free,
      release: free,
    };
  }

  if (from === null)
    return {
      refusal: `A review checks a piece of work: name the session that did it, one you started for a work step of ${quoted(workflow.name)}, with work.`,
    };
  const earlier = placed(caller, from);
  if (earlier === null || earlier.kind !== "work")
    return {
      refusal: `Session ${from} is not one you started for a work step of ${quoted(workflow.name)}, so there is no work behind this review. Name the session that did the work, with work.`,
    };
  const piece = earlier.piece ?? from;
  const done = roundsOf(caller, step.name, piece);
  countRound(caller, step.name, piece);
  return {
    ...runs,
    place: {
      step: step.name,
      kind: "review",
      piece,
      round: done + 1,
      work: from,
    },
    beyond: pastLimit(caller, step, from, piece, done),
    hold: () => {},
    release: (started) => {
      if (!started) uncountRound(caller, step.name, piece);
      else goneAhead(caller, step.name, piece);
    },
  };
}

/** A round past the most a review gives a piece: one more than the first
    and a round for every time it may send the work back. Null within it. */
function pastLimit(
  caller: string,
  step: ReviewStep,
  work: string,
  piece: string,
  done: number,
): Beyond | null {
  return done > step.limit
    ? { step: step.name, work, piece, name: workName(caller, work), done, limit: step.limit }
    : null;
}

/** The round a piece's work goes on in once a review that sends work back
    to its step has had it and come to rest: one past that review's rounds.
    Null before then, so a line to the work while its review is still at
    it is no round of its own. Whether the review passed is not known, so
    a line after a review that passed counts as work sent back all the
    same. A piece the user stopped at that review's limit goes on in the
    review's last round: no round past the stop. */
function workRound(caller: string, workflow: Workflow, step: WorkStep, piece: string): number | null {
  const reviews = workflow.steps.filter(
    (candidate): candidate is ReviewStep => candidate.kind === "review" && sameName(candidate.backTo, step.name),
  );
  let had = 0;
  let review: ReviewStep | null = null;
  for (const candidate of reviews) {
    const count = roundsOf(caller, candidate.name, piece);
    if (count > had) [had, review] = [count, candidate];
  }
  if (review === null || !reviewRested(caller, review, piece, had)) return null;
  if (conductor.runs[caller]?.stopped?.[roundKey(review.name, piece)] !== undefined) return had;
  return had + 1;
}

/** Whether a piece's review has come to rest in a round: the session of
    that round has worked and gone quiet, or is not running. A round
    counted for a start still on its way has no session yet, and has not
    come to rest. */
function reviewRested(caller: string, review: ReviewStep, piece: string, round: number): boolean {
  const ofRound = (at: Place | null) =>
    at !== null && at.kind === "review" && at.piece === piece && at.round === round && sameName(at.step, review.name);
  const rows = startedBy(caller).filter((row) => ofRound(placeOf(row.key)));
  if (rows.length > 0) return rows.every((row) => !isLive(row) || finished(row));
  return Object.values(conductor.runs[caller]?.places ?? {}).some(ofRound);
}

/** What the user is asked about a round past the limit, in the words
    they know the work by: "Review has run twice on Fix the cache, as many
    times as the workflow allows. Allow another round?" */
export function roundQuestion(beyond: Beyond): string {
  const times =
    beyond.done === 1 ? "once" : beyond.done === 2 ? "twice" : `${beyond.done} times`;
  const most =
    beyond.done === beyond.limit + 1
      ? "as many times as the workflow allows"
      : "more times than the workflow allows";
  return `${beyond.step} has run ${times} on ${beyond.name}, ${most}. Allow another round?`;
}

/** What a caller is told when the user did not allow a round past the
    limit. */
function notAllowed(beyond: Beyond): string {
  const most = beyond.limit + 1;
  const against =
    beyond.done === most
      ? "as many as the workflow gives a piece"
      : `more than the ${most} the workflow gives a piece`;
  return `${quotedName(beyond.name)}, the work of session ${idText(beyond.work)}, has had ${beyond.done} rounds of ${quoted(beyond.step)}, ${against}, and the user did not allow another. Ask the user how to go on.`;
}

/** The agent and model a step runs a start on: the first the step allows
    of those the call names, the agent's own when the step allows any. */
function modelFor(
  agent: string | null,
  model: string | null,
  step: WorkflowStep,
): { agent: AgentId | null; model: string | null } | { refusal: string } {
  const named: AgentId | null =
    agent === "claude-code" || agent === "codex" ? agent : null;
  if (step.models.length === 0) return { agent: named, model };
  const fits = step.models.filter(
    (allowed) =>
      (agent === null || allowed.agent === agent) &&
      (model === null || allowed.model === model),
  );
  const first = fits[0];
  if (first === undefined) {
    const asked =
      agent !== null && model !== null
        ? `${agent} with the model ${model}`
        : agent !== null
          ? agent
          : `the model ${model}`;
    return {
      refusal: `The step ${quoted(step.name)} does not allow ${asked}. It allows ${either(step.models.map(modelText))}. Leave the agent and the model out to use the first.`,
    };
  }
  return {
    agent: first.agent,
    model:
      first.agent === "codex" && first.model === CODEX_DEFAULT
        ? null
        : first.model,
  };
}

/** The workflow the caller follows, null for none, or why the call cannot
    be held to one: its session has stopped since the call was placed, and
    a session that is not running cannot be calling. An agent the workbench
    did not start follows none, and is refused while any session follows
    one, since it cannot be held to it. */
function callerFlow(
  request: Placed,
): { workflow: Workflow | null } | { refusal: string } {
  if (request.session === null)
    return workflowRunning() ? { refusal: OUTSIDE } : { workflow: null };
  const row = callingSession(request);
  if (row === null) return { refusal: UNKNOWN };
  return { workflow: row.workflow };
}

/** Whether a running session follows a workflow. */
function workflowRunning(): boolean {
  return sessions.all.some((session) => isLive(session) && session.workflow !== null);
}

const ONE_LEVEL =
  "A session that another session started cannot start sessions of its own.";

/** Why a caller may not start another session right now, when it may not:
    it has as many running as one may, or it was itself started by one. An
    agent the workbench did not start has a cap of its own, and the user is
    asked about each start it makes, being told what asks. */
function roomFor(request: Placed): Answered | null {
  const running = () => startedBy(callerOf(request)).filter(isLive);
  if (running().length >= CAP) makeRoom(running());
  if (running().length >= CAP)
    return refused(
      `You have ${CAP} sessions running already, which is as many as one session may have. Wait for one to finish, or stop one whose work is not wanted, before starting another.`,
    );
  if (request.session === null) return null;
  const calling = callingSession(request);
  if (calling === null) return refused(UNKNOWN);
  if (startedFor(calling.key) !== null) return refused(ONE_LEVEL);
  return null;
}

/**
 * Brings back a session the caller started that is no longer running,
 * where it ran, with its conversation. The user is not asked again: the
 * record holds only sessions they allowed this caller to start, so the
 * consent was given when the session was, and bringing it back is that
 * session going on rather than a new one. A prompt, when the call gives
 * one, is what the session goes on with; without one it comes up waiting,
 * for the caller to send a line.
 */
async function resumeSession(
  request: Placed,
  id: string,
): Promise<Answered> {
  const caller = callerOf(request);
  const entry = remembered(caller, id);
  if (entry === null)
    return refused(
      `Session ${id} is not one you started. The sessions tool lists the ones you can resume.`,
    );
  const open = byId(id);
  if (open !== null && isLive(open))
    return refused(
      `Session ${id} is running already. Send it a line, or wait for it.`,
    );
  const room = roomFor(request);
  if (room !== null) return room;
  const flow = callerFlow(request);
  if ("refusal" in flow) return refused(flow.refusal);
  const { project, worktree, agent } = entry;
  if (!isStartable(project))
    return refused(
      `Session ${id} ran in ${project}, which is not open in the workbench.`,
    );

  const prompt = text(request, "prompt");
  if (prompt !== null && kindFor(agent) === "terminal" && runsShell(oneLine(prompt)))
    return refused(SHELL_PROMPT);
  if (prompt !== null && entry.unasked === true && mayChangeModel(oneLine(prompt)))
    return refused(unaskedLine(id));
  // A session resumed for a step of the caller's workflow goes on in that
  // step, on a model the step allows, held to the step as a start is: a
  // work step's room, and for a review given a prompt, another round.
  const at = placed(caller, id);
  const step =
    at === null
      ? undefined
      : flow.workflow?.steps.find((candidate) => sameName(candidate.name, at.step));
  // A caller under a workflow runs every session in its shape, so one
  // started outside it, such as by a plain session in the same directory,
  // is not brought back under it.
  if (at === null && flow.workflow !== null)
    return refused(
      `Session ${id} was not started for a step of the workflow ${quoted(flow.workflow.name)}, so it cannot be held to it, and you follow that workflow. Start a new session for a step instead.`,
    );
  // A session whose step the workflow no longer has has nothing to be held
  // to, so it is not brought back.
  if (at !== null && flow.workflow !== null && step === undefined)
    return refused(
      `Session ${id} ran for the step ${quoted(at.step)}, which the workflow ${quoted(flow.workflow.name)} no longer has. The steps are ${stepsText(flow.workflow)}. Start a new session for the step its work is in now.`,
    );
  let model = text(request, "model");
  let goesOn = at;
  let release: (started: boolean) => void = () => {};
  let hold = () => {};
  let beyond: Beyond | null = null;
  // A review brought back with no prompt waits for a line, and that line is
  // its next round.
  const owesRound =
    step?.kind === "review" && prompt === null && at !== null && at.piece !== null;
  if (step !== undefined && at !== null) {
    if (prompt !== null && mayChangeModel(oneLine(prompt)))
      return refused(keepsItsModel(id, at));
    const runs = modelFor(agent, model, step);
    if ("refusal" in runs) return refused(runs.refusal);
    model = runs.model;
    if (step.kind === "work") {
      const full = noRoom(caller, step);
      if (full !== null) return refused(full);
      const free = reserveSlot(caller, step.name);
      hold = free;
      release = free;
      if (prompt !== null && flow.workflow !== null) {
        const round = workRound(caller, flow.workflow, step, at.piece ?? id);
        if (round !== null && (at.round ?? 1) < round) goesOn = { ...at, round };
      }
    } else if (prompt !== null && at.piece !== null) {
      const piece = at.piece;
      const done = roundsOf(caller, step.name, piece);
      beyond = pastLimit(caller, step, at.work ?? piece, piece, done);
      countRound(caller, step.name, piece);
      goesOn = { ...at, round: done + 1 };
      release = (started) => {
        if (!started) uncountRound(caller, step.name, piece);
        else goneAhead(caller, step.name, piece);
      };
    }
  }

  let started = false;
  try {
    // Resuming is not asked about, the consent having been given when the
    // session was started, except for a round past the review's limit.
    if (beyond !== null) {
      const answer = await askUser(request, project, prompt ?? "", false, null, null, beyond);
      if (callerGone(request)) return refused(CALLER_GONE);
      if (answer === "no") {
        stopAtLimit(caller, beyond);
        return { ...refused(notAllowed(beyond)), byUser: true };
      }
    }
    if (worktree !== null && !(await treeStands(project, worktree)))
      return refused(
        `Session ${id} ran in the worktree ${worktree}, which is gone. Start a new session for the work instead.`,
      );

    // A row that ended is its transcript again; the resumed session takes
    // its place rather than sitting beside it, with the shells opened
    // beside it.
    const now = byId(id);
    if (now !== null) close(now.key, true);
    const looking = sessions.active;
    const session = create(
      project,
      id,
      agent,
      worktree,
      prompt === null ? null : `${oneLine(prompt)} ${outcomeAsk(agent)}`,
      model,
      entry.account ?? null,
      null,
    );
    conductor.startedBy[session.key] = caller;
    // It has a row again, so why the last one went is past.
    const kept = remembered(caller, id);
    if (kept?.left !== undefined) {
      delete kept.left;
      saveStarted();
    }
    if (goesOn !== null) {
      conductor.places[session.key] = goesOn;
      hold();
    }
    if (session.title === null && entry.name !== null) session.title = entry.name;
    if (now !== null) handOver(now.key, { project, session: session.key });
    if (looking !== null && byKey(looking) !== null) sessions.active = looking;

    const trouble = await cameUp(session.key);
    if (trouble !== null) return refused(trouble);
    started = true;
    if (owesRound) owed.add(session.key);
    // A cold and large conversation went on fresh from its notes, under
    // an id of its own that the old one still names.
    const fresh = wentOn(session.key) !== null;
    const named = (fresh ? byKey(session.key)?.id : null) ?? id;
    if (goesOn !== null && goesOn !== at) place(caller, named, goesOn);
    const where = worktree === null ? project : `${project}, in ${worktree}`;
    const round =
      goesOn !== null && goesOn !== at ? ` for ${placeText(goesOn)}` : "";
    if (fresh)
      return said(
        `Session ${id}${round} went on in ${where} as a fresh conversation, ${idText(named)}, from its notes and last exchanges: its own was cold and large, so it was not read again. Either id names it. ${prompt === null ? "It is waiting. Send it a line to go on, then call wait." : `It has the prompt. ${KEEP_WAITING}`}`,
      );
    return said(
      prompt === null
        ? `Resumed session ${id} in ${where}. It has its conversation and is waiting. Send it a line to go on, then call wait.`
        : `Resumed session ${id}${round} in ${where}. It has its conversation and the prompt. ${KEEP_WAITING}`,
    );
  } finally {
    release(started);
  }
}

/** The sessions a line is bringing back, by id, until each is up or
    could not be. */
const comingBack = new Map<string, Promise<Answered>>();

/** Resumes a session the caller started that has no row, with a line the
    caller sent it as what it goes on with, as a start naming it would. */
async function bringBack(request: Placed, entry: Started, line: string): Promise<Answered> {
  const why = goneWhy(entry);
  const resuming = resumeSession(
    { ...request, tool: "start", arguments: { session: entry.id, prompt: line } },
    entry.id,
  );
  comingBack.set(entry.id, resuming);
  let resumed: Answered;
  try {
    resumed = await resuming;
  } finally {
    if (comingBack.get(entry.id) === resuming) comingBack.delete(entry.id);
  }
  if (resumed.error !== null || resumed.content === null) return resumed;
  return { ...resumed, content: `Session ${idText(entry.id)} was not running: ${why}. Your line resumed it. ${resumed.content}` };
}

/** Whether a worktree is still one of the project's. */
async function treeStands(project: string, worktree: string): Promise<boolean> {
  try {
    const trees = await core().worktrees(project);
    return trees.some((tree) => tree.path === worktree);
  } catch {
    // A project that cannot say has no worktrees to resume in.
    return false;
  }
}

/**
 * A worktree's name, from the prompt that asked for it: its words in
 * lowercase joined by dashes, cut to 40 characters. The core numbers it
 * when the project has one of that name already.
 */
export function worktreeName(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  let cut = words.slice(0, 40);
  // A cut that landed inside a word takes the whole word with it, so the
  // name reads as words rather than ending mid-one.
  if (words.length > 40 && words[40] !== "-") {
    const boundary = cut.lastIndexOf("-");
    if (boundary > 0) cut = cut.slice(0, boundary);
  }
  return cut.replace(/-+$/, "") || "session";
}

async function sendText(request: Placed): Promise<Answered> {
  const id = text(request, "session");
  const line = text(request, "text");
  if (id === null) return refused("Sending needs a session to send to.");
  if (line === null) return refused("Sending needs the text to send.");
  // A line that comes while another line brings the session back goes
  // once it is up, as a line to a running session does.
  const coming = comingBack.get(id);
  if (coming !== undefined) await coming;
  const session = byId(id);
  if (session === null) {
    const entry = remembered(callerOf(request), id);
    if (entry === null) return refused(`The workbench has no session ${id}.`);
    if (!backOnALine(entry)) return refused(notRunning(entry));
    return bringBack(request, entry, line);
  }
  if (!mine(request, session)) return notMine(id);
  // A session being reopened the other way takes the line once its next
  // run is up, the way it then runs.
  if (
    reopeningRow(session.key) &&
    !(await settles<boolean>(
      (settle) => {
        if (!reopeningRow(session.key)) settle(true);
      },
      MOVE_WAIT,
      false,
    ))
  )
    return refused(`Session ${id} is being reopened and is not up yet. Send it again in a moment.`);
  // An integrated session takes the message whole, as the user's own; one
  // sent while it works waits for its turn. A terminal one takes a line.
  const integrated = session.kind === "integrated";
  const reachable = (row: Session) =>
    row.status === "running" && (integrated ? handleOf(row.key) !== null : row.ptyId !== null);
  const unreachable = () =>
    refused(
      integrated
        ? `Session ${id} is an integrated session and is ${stateOf(session)}, so it takes no message now. Start it again with start, naming session ${id}, then send.`
        : `Session ${id} is not running.`,
    );
  if (!reachable(session)) return unreachable();
  const typed = integrated ? line : oneLine(line);
  if (!integrated && runsShell(typed)) return refused(SHELL_LINE);
  const at = placeOf(session.key);
  const flow = callerFlow(request);
  if ("refusal" in flow) return refused(flow.refusal);
  // A session started for a step stays on the model the step gave it, a
  // caller under a workflow changes the model of none it reaches, and a
  // session started without the user being asked is given no command that
  // could change what it may do.
  const unasked = session.id !== null && remembered(callerOf(request), session.id)?.unasked === true;
  if ((at !== null || flow.workflow !== null || unasked) && mayChangeModel(typed))
    return refused(
      at !== null
        ? keepsItsModel(id, at)
        : flow.workflow !== null
          ? `You follow a workflow, so the workbench gives the sessions you reach no command but /compact, and takes a line that begins with a slash, a path included, for one. Say what you want in words, with a word before any path.`
          : unaskedLine(id),
    );
  // A line to a review that has finished its round asks it for another
  // look, which is another round of the piece.
  let round: Place | null = null;
  if (
    at !== null &&
    at.kind === "review" &&
    at.piece !== null &&
    (finished(session) || owed.has(session.key))
  ) {
    const caller = callerOf(request);
    const review = flow.workflow?.steps.find((candidate) =>
      sameName(candidate.name, at.step),
    );
    if (review?.kind === "review") {
      const done = roundsOf(caller, review.name, at.piece);
      const beyond = pastLimit(caller, review, at.work ?? at.piece, at.piece, done);
      if (beyond !== null) {
        const answer = await askUser(request, session.project, typed, false, null, null, beyond);
        if (callerGone(request)) return refused(CALLER_GONE);
        if (answer === "no") {
          stopAtLimit(caller, beyond);
          return refused(notAllowed(beyond));
        }
      }
      if (!reachable(session)) return unreachable();
      countRound(caller, review.name, at.piece);
      goneAhead(caller, review.name, at.piece);
      owed.delete(session.key);
      round = { ...at, round: done + 1 };
      conductor.places[session.key] = round;
      if (session.id !== null) place(caller, session.id, round);
      // The round is counted once, however many lines go before it works.
      const mark = stops.get(session.key);
      if (mark !== undefined) mark.worked = false;
    }
  }
  // A line to work whose piece a review has had since is the work sent
  // back: it goes on in the round after the review's.
  if (at !== null && at.kind === "work" && flow.workflow !== null && session.id !== null) {
    const step = flow.workflow.steps.find((candidate) => sameName(candidate.name, at.step));
    const next = step?.kind === "work" ? workRound(callerOf(request), flow.workflow, step, at.piece ?? session.id) : null;
    if (next !== null && (at.round ?? 1) < next) {
      const goesOn = { ...at, round: next };
      conductor.places[session.key] = goesOn;
      place(callerOf(request), session.id, goesOn);
    }
  }
  const sent = round === null ? `Sent to session ${id}` : `Sent to session ${id}, for ${placeText(round)}`;
  if (integrated) {
    const working = session.working;
    if (sendIntegrated(session.key, typed, [], callerOf(request)) === null)
      return refused(`Session ${id} is an integrated session and took no message: there was nothing to send.`);
    // How its last turn ended no longer says it is idle.
    session.turnEnd = null;
    return said(
      working
        ? `${sent}. It is at work, so the message waits for its turn. Call wait to hear what it does next.`
        : `${sent}. Call wait to hear what it does next.`,
    );
  }
  await typeLine(session.key, session.ptyId!, typed);
  return said(`${sent}. Call wait to hear what it does next.`);
}

/** Whether a line may change the model an agent runs on. Any command an
    agent takes after a slash might, /model, /fast and /config among them,
    and either agent completes a command from the start of its name, so
    every one may except /compact, which only shortens the conversation. A
    line is read as a command where it begins with a slash once characters
    that draw nothing are passed over and a wide slash is read as a slash,
    which takes a path at its start for one as well. */
export function mayChangeModel(line: string): boolean {
  const typed = asTyped(line);
  return typed.startsWith("/") && !/^\/compact(\s|$)/i.test(typed);
}

/** A line as an agent reads its start: in its compatibility form, so a
    wide mark is read as the plain one, with the characters that draw
    nothing before it passed over. */
const asTyped = (line: string) => line.normalize("NFKC").replace(/^[\s\p{Cf}]+/u, "");

/** Whether a line typed into an agent's terminal runs as a shell command:
    Claude Code takes a line that begins with ! for one, and so do recent
    versions of Codex, and runs it in the user's shell with no permission
    asked. Read as `mayChangeModel` reads a slash. */
export function runsShell(line: string): boolean {
  return asTyped(line).startsWith("!");
}

/** What a caller is told of a line for a session's terminal, or a prompt
    for a session that runs in one, that begins with !. */
const SHELL_LINE =
  "A line that begins with ! is run by the agent as a shell command when it is typed into its terminal, with no permission asked, so the workbench types none into a session's terminal. Put a word before it.";
const SHELL_PROMPT =
  "A prompt that begins with ! is run by the agent as a shell command when its session runs in a terminal, with no permission asked, so the workbench starts none in a terminal with such a prompt. Put a word before it.";

/** What a caller is told of a command for a session it started in its own
    project without the user being asked. */
const UNASKED_PROMPT =
  "A session you start in your own project without the user being asked takes no command but /compact, so its prompt is words: the workbench starts none with a prompt that begins with a slash, a path included. Put a word before it.";
function unaskedLine(id: string): string {
  return `Session ${id} was started in your own project without the user being asked, so the workbench gives it no command but /compact, and takes a line that begins with a slash, a path included, for one. Say what you want in words, with a word before any path.`;
}

/** What a caller is told when a line or a prompt for a session placed in
    its workflow could change the session's model. */
function keepsItsModel(id: string, at: Place): string {
  return `Session ${id} runs ${placeText(at)} of your workflow, on a model the step allows, and stays on it: the workbench gives it no command but /compact, and takes a line that begins with a slash, a path included, for one. Say what you want in words, with a word before any path.`;
}

/** Reviews resumed with no prompt, by row key, whose next line is their
    next round: they have not worked since they came back, so they have not
    finished one. */
const owed = new Set<string>();

/** Whether a session has worked and come to rest since it was last sent a
    line or started. */
function finished(session: Session): boolean {
  observe(session);
  const mark = stops.get(session.key);
  return mark !== undefined && mark.worked && (mark.rest === "quiet" || mark.rest === "cut");
}

function stopSession(request: Placed): Answered {
  const id = text(request, "session");
  if (id === null) return refused("Stopping needs a session to stop.");
  const session = byId(id);
  if (session === null) {
    // One the caller started that is not running has nothing to stop; the
    // stop still says the caller is done with it, so it is not offered back.
    const entry = remembered(callerOf(request), id);
    if (entry === null) return refused(`The workbench has no session ${id}.`);
    forget(callerOf(request), id);
    forgetNotes([{ project: entry.project, token: sessions.tokens[entry.id]?.token ?? "" }]);
    return said(
      `Session ${idText(id)} was not running: ${goneWhy(entry)}. It is off your list now, and not offered to resume.`,
    );
  }
  if (!mine(request, session)) return notMine(id);
  stopStarted(session.key);
  return said(`Stopped session ${id}. It is off your list now, and not offered to resume.`);
}

/**
 * Waits for a session to come to rest: it stops working, it asks for
 * permission, or it ends. With no session named, for whichever of the
 * caller's own does so first.
 */
async function waitFor(request: Placed): Promise<Answered> {
  const id = text(request, "session");
  const seconds = number(request, "seconds", WAIT_SECONDS, WAIT_MAX);
  let watched: Session[];
  if (id === null) {
    watched = startedBy(callerOf(request));
    // A call answered before it was done is waited on as a session is.
    const owed = (conductor.later[callerOf(request)] ?? []).length > 0;
    if (watched.length === 0 && !owed && (conductor.started[callerOf(request)] ?? []).length > 0)
      return said(
        "None of the sessions you started is running. The sessions tool lists them with why each is not; resume one with start, naming its session, to wait on it.",
      );
    if (watched.length === 0 && !owed)
      return refused(
        "You have started no sessions to wait for. Name one to wait for it, or start one first.",
      );
  } else {
    const session = byId(id);
    if (session === null) {
      const entry = remembered(callerOf(request), id);
      return entry === null ? refused(`The workbench has no session ${id}.`) : said(notRunning(entry));
    }
    if (!mine(request, session)) return notMine(id);
    watched = [session];
  }
  const owner = callerOf(request);
  // A message from the user that the caller's agent has not taken yet
  // waits behind this call: it goes first.
  const calling = callingSession(request);
  if (calling !== null && calling.kind === "integrated" && userWaiting(calling.key))
    return said(USER_WROTE);
  cut.delete(owner);
  conductor.listening[owner] = (conductor.listening[owner] ?? 0) + 1;
  try {
    return await holdWait(request, owner, watched, seconds);
  } finally {
    const left = (conductor.listening[owner] ?? 1) - 1;
    if (left > 0) conductor.listening[owner] = left;
    else delete conductor.listening[owner];
  }
}

/** A wait once it is held: until one of the sessions watched comes to
    rest, the seconds run out, the agent gives up on it, or the user's
    message ends it. */
async function holdWait(
  request: Placed,
  owner: string,
  watched: Session[],
  seconds: number,
): Promise<Answered> {
  // What is worth answering is a rest the caller has not been told of: one
  // that came before the wait is answered now, and a session at work is
  // waited out. A rest told already, by an earlier wait, a listing, a note
  // or a wake, is not answered again until the session has been at work in
  // another turn and come to rest after it.
  const names = new Map<string, string>();
  const ids = new Map<string, string | null>();
  for (const session of watched) {
    names.set(session.key, namedAs(session));
    ids.set(session.key, session.id);
  }

  // The calling session's row: a wait held for a session that is no longer
  // running has no one to hear it.
  const callerAt = callingSession(request)?.key ?? null;
  // A wait over all of them has nothing to hear of a row the workbench put
  // away: its rest was told before its work counted as over.
  const overAll = text(request, "session") === null;
  let reported: string | null = null;
  /** The calls answered early whose outcome the answer tells. */
  let toldCalls: string[] = [];
  let abandoned = false;
  let interrupted: string | null = null;
  let ending: (() => void) | null = null;
  waiting.set(request.id, {
    caller: owner,
    watched: watched.map((session) => session.key),
    abandon: () => {
      abandoned = true;
      ending?.();
    },
    interrupt: (answer) => {
      interrupted = answer;
      ending?.();
    },
  });
  const happened = await settles<string | null>(
    (settle) => {
      ending = () => settle(null);
      if (abandoned || interrupted !== null) {
        settle(null);
        return;
      }
      if (callerAt !== null) {
        const calling = byKey(callerAt);
        if (calling === null || !isLive(calling)) {
          abandoned = true;
          given.add(request.id);
          settle(null);
          return;
        }
      }
      // How a call answered before it was done went comes first: the
      // caller made it, and was told to wait for it.
      const news = laterNews(owner);
      if (news.calls.length > 0) {
        toldCalls = news.calls;
        settle(news.lines.join("\n"));
        return;
      }
      // A session that ended or asks, and was told so already, is answered
      // again only when none of the others can still move; one the caller
      // has not been told of comes first, whatever order they are in.
      let busy = false;
      let again: { key: string; text: string } | null = null;
      let away = 0;
      for (const watchedKey of names.keys()) {
        // A row that went while another row of the same session came up,
        // as when it was resumed in place, is that session going on.
        const session = byKey(watchedKey) ?? rowAgain(owner, ids.get(watchedKey) ?? null);
        if (session === null) {
          const id = ids.get(watchedKey) ?? null;
          if (overAll && id !== null && remembered(owner, id)?.left === "done") {
            away += 1;
            continue;
          }
          settle(closedText(owner, id, names.get(watchedKey) ?? watchedKey));
          return;
        }
        const key = session.key;
        // Reopened the other way, it is the same session going on, at
        // work as far as the wait goes until its next run is up.
        if (reopeningRow(key)) {
          busy = true;
          continue;
        }
        const resting =
          !isLive(session) || session.needs === "permission"
            ? restText(session)
            : null;
        if (resting !== null) {
          if (untold(session)) {
            reported = key;
            settle(resting);
            return;
          }
          again ??= { key, text: resting };
          continue;
        }
        busy = true;
        if (!session.working && untold(session)) {
          reported = key;
          settle(waitText(session));
          return;
        }
      }
      if (!busy && again !== null) {
        reported = again.key;
        settle(again.text);
      } else if (away > 0 && away === names.size) settle(ALL_PUT_AWAY);
    },
    Math.max(seconds * 1000 - WAIT_EARLY, seconds * 500),
    null,
  );
  waiting.delete(request.id);
  if (abandoned) return said("");
  if (interrupted !== null) return said(interrupted);
  if (happened === null) {
    const still = laterWaiting(owner).map((one) => ` Your ${one.what} still waits on the user's answer.`);
    return said(
      `Nothing happened within ${seconds} seconds: no session stopped and none asked anything.${still.join("")}`,
    );
  }
  if (toldCalls.length > 0) {
    const calls = toldCalls;
    return { ...said(happened), delivered: () => toldLater(owner, calls) };
  }
  // The stop is told once the answer is left where the call reads it, and
  // only as it was now: the core leaves none once the tool server has
  // stopped reading, and then the next wait answers with it.
  const key: string | null = reported;
  if (key === null) return said(happened);
  const rest = stops.get(key)?.rest ?? null;
  return { ...said(happened), delivered: () => tellAs(key, rest) };
}

/**
 * What a session has on screen. An agent's transcript is its own, in a
 * format it documents as internal, so what the workbench reads is what
 * the user reads: the last lines of the session's terminal, as they are
 * drawn, box drawing and all.
 */
function readSession(request: Placed): Answered {
  const id = text(request, "session");
  if (id === null) return refused("Reading needs a session to read.");
  const session = byId(id);
  if (session === null) {
    const entry = remembered(callerOf(request), id);
    return entry === null ? refused(`The workbench has no session ${id}.`) : said(notRunning(entry));
  }
  if (!mine(request, session)) return notMine(id);
  const lines = number(request, "lines", LINES, LINES_MAX);
  // An integrated session has no screen: what its agent last said and did
  // is read from its conversation instead.
  if (session.kind === "integrated") {
    const run = lastRun(
      conversationOf(session.key),
      lines,
      (message) => senderOf(message)?.name ?? null,
    );
    if (run === "")
      return said(`Session ${id} is an integrated session and has said nothing yet. ${lastLine(session)}`);
    return said(`Session ${id}, what its agent last said and did:\n${run}`);
  }
  const drawn = screen(session.key, lines);
  if (drawn === null || drawn === "") {
    return said(`Session ${id} has drawn nothing yet. ${lastLine(session)}`);
  }
  return said(`Session ${id}, as it is on screen:\n${drawn}`);
}

/** A line as the agent's own keyboard would deliver it: one line, with
    nothing in it that could drive the terminal instead of being read. */
export function oneLine(text: string): string {
  return printable(text.replace(/[\r\n]+/g, " ")).trim();
}

/** How a session came to rest: it ended, it is asking for permission, an
    error or a usage limit ended its turn, the user interrupted it, it ended
    its turn with work still running in the background, or it ended its turn
    itself with nothing left running. What a wait, a note and a wake say of
    it all turn on this. */
type RestWay =
  | { way: "ended" }
  | { way: "permission" }
  | { way: "failed"; failure: Failure }
  | { way: "cut" }
  | { way: "background"; running: string }
  | { way: "done" };

function restWay(session: Session): RestWay {
  if (!isLive(session)) return { way: "ended" };
  if (session.needs === "permission") return { way: "permission" };
  const failure = failureFor(session);
  if (failure !== null) return { way: "failed", failure };
  if (session.turnEnd === "cut") return { way: "cut" };
  const running = backgroundWords(session);
  if (running !== null) return { way: "background", running };
  return { way: "done" };
}

/** What a session at rest is doing, in the words a wait answers with. */
function restText(session: Session, rest: RestWay = restWay(session)): string {
  const name = namedAs(session);
  const last = lastLine(session);
  switch (rest.way) {
    case "ended":
      return `Session ${name} ${stateOf(session)}. ${last}`;
    case "permission":
      return `Session ${name} is asking for permission. ${last}`;
    case "failed": {
      const { failure } = rest;
      const shown = failure.line === null || failure.line === session.note ? null : quotedLine(failure.line);
      return `Session ${name} ${failureWords(failure)}. ${shown === null ? "" : `Its error: ${shown}. `}${last}`;
    }
    case "cut":
      return `Session ${name} stopped: the user interrupted its turn. ${last}`;
    case "background":
      return `Session ${name} ended its turn with ${rest.running}. ${last}`;
    case "done":
      return `Session ${name} stopped working. ${last}`;
  }
}

/** What a wait adds, on a line of its own, for a session that ended its
    turn itself with nothing left running: what becomes of it. */
export const STOP_WHEN_DONE =
  "The workbench puts it away once it has rested at least five minutes with nothing open; a line you send it after that resumes it.";

/** What a wait over all of a caller's sessions answers once every one it
    watched was put away. */
export const ALL_PUT_AWAY =
  "None of the sessions you started is running: the workbench put away the ones whose work was over. The sessions tool lists them; a line you send one resumes it.";

/** What a wait answers for a session at rest: what a note or a wake says
    of it, and for one that ended its turn itself with nothing left
    running, when to stop it. */
function waitText(session: Session): string {
  const rest = restWay(session);
  const said = restText(session, rest);
  return rest.way === "done" ? `${said}\n${STOP_WHEN_DONE}` : said;
}

/** How many of the last lines on a session's screen are read for what
    ended its turn. */
const SCREEN_TAIL = 16;

/**
 * What ended a session's last turn when it did not finish it itself: what
 * its hooks or its events said for a failed turn, or, for a turn this
 * window saw begin that ended with no word of how, what its screen says in
 * Claude Code's own lines, a usage limit or an error. Null for a turn the
 * agent ended or the user cut short, for a session seen to begin no turn,
 * whose screen may be a conversation drawn again from long ago, and for a
 * screen that says neither.
 */
function failureFor(session: Session): Failure | null {
  if (session.turnEnd === "failed") return session.failure ?? { limit: false, until: null, line: null };
  if (session.turnEnd !== null || session.kind === "integrated" || session.turns === 0) return null;
  const drawn = screen(session.key, SCREEN_TAIL);
  return drawn === null ? null : failureOnScreen(drawn.split("\n"));
}

/** A failed turn in a few words: at its usage limit, until when where it
    said, or stopped on an error. */
function failureWords(failure: Failure): string {
  if (!failure.limit) return "stopped on an error";
  return failure.until === null
    ? "stopped at a usage limit"
    : `is at its usage limit until ${failure.until}`;
}

/** The work a session left running in the background as it ended its
    turn, its tasks quoted as its own words, with what their end does. A
    task such as a dev server may never end, so nothing is promised of
    when. Null for none. */
function backgroundWords(session: Session): string | null {
  const quoted = session.background.map(quotedLine).filter((line) => line !== null);
  if (quoted.length === 0) return null;
  return quoted.length === 1
    ? `work still running in the background, ${quoted[0]}; when it finishes, the session takes it up in a turn of its own`
    : `work still running in the background, ${quoted.join(", ")}; as each finishes, the session takes it up in a turn of its own`;
}

/** A session's state as a listing gives it: what `stateOf` says, and for
    one waiting, what ended its turn when it did not end it itself. */
function stateWords(session: Session): string {
  const state = stateOf(session);
  if (state !== "waiting") return state;
  const failure = failureFor(session);
  if (failure !== null) return failure.limit ? failureWords(failure).replace(/^is /, "") : "stopped on an error";
  if (session.turnEnd === "cut") return "waiting, its turn interrupted by the user";
  if (session.background.length > 0) return "waiting on work in the background";
  return state;
}

/** Why a session a caller started has no row: the user closed it, it
    ended, or it has not run since the workbench was restarted. */
function goneWhy(entry: Started): string {
  if (entry.left === "closed") return "the user closed it";
  if (entry.left === "ended") return "it ended";
  if (entry.left === "done") return "the workbench put it away once its work was over";
  return "it has not run since the workbench was restarted";
}

/** Whether a line the caller sends a session that has no row resumes it:
    one the workbench put away, or one not run since a restart. One the
    user closed or that ended is resumed only by a start that names it. */
const backOnALine = (entry: Started) => entry.left !== "closed" && entry.left !== "ended";

/** How a session the caller started that has no row comes back. */
function wayBack(entry: Started): string {
  const id = idText(entry.id);
  return backOnALine(entry)
    ? `A line you send it resumes it, as start naming session ${id} does.`
    : `Resume it with start, naming session ${id}.`;
}

/** What a call naming a session the caller started, which has no row, is
    answered: it is not running, why, and how to bring it back. */
function notRunning(entry: Started): string {
  return `Session ${idText(entry.id)} is not running: ${goneWhy(entry)}. ${wayBack(entry)}`;
}

/** What a wait says of a session it watched whose row went: closed, by the
    user where the caller's list says so, and how to bring it back. */
function closedText(owner: string, id: string | null, name: string): string {
  const entry = id === null ? null : remembered(owner, id);
  if (entry?.left === "done") return `Session ${name} was put away once its work was over. ${wayBack(entry)}`;
  if (entry?.left !== "closed") return `Session ${name} was closed.`;
  return `Session ${name} was closed by the user. Resume it with start, naming session ${idText(entry.id)}.`;
}

/** An id of the shape the agents' own ids have, uuids and the like: the
    characters a call's id may hold, as the core holds it to, and no more of
    them. */
const PLAIN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A session as a tool's answer, a note or a wake names it to an agent: by
 * its id, which the agent did not choose and which is what the tools take,
 * or, while the window does not know the id, by its name as a quote of the
 * session's own words. A name may be the one a start gave, the agent's
 * title for its terminal or the first words of its conversation, so it is
 * bounded as a last line is and never reads as the workbench's words or as
 * another session's entry.
 */
export function namedAs(session: Session): string {
  return session.id === null ? quotedName(label(session)) : idText(session.id);
}

/** A session's id in an answer: as it is when it has the plain shape of
    the agents' own ids, and otherwise quoted as a name is, since some ids
    are read from where an agent can write. */
export function idText(id: string): string {
  return PLAIN_ID.test(id) ? id : quotedName(id);
}

/** A session's name as an answer gives it: its own words on one line, with
    its spaces each one, cut as a row's name is and in double quotes. */
export function quotedName(name: string): string {
  return `"${nameCut(ownWords(name).replace(/\s+/g, " "))}"`;
}

/** The most of a session's last line a tool answers with, in characters,
    as the core cuts a line left on a row. */
export const LINE_CAP = 120;

/** What a session last left for its row, in the words a tool answers
    with. */
function lastLine(session: Session): string {
  const line = quotedLine(session.note);
  return line === null ? "It has left no line." : `Its last line: ${line}`;
}

/** Marks that read as a double quote, once a line is in its compatibility
    form, where a fullwidth quote is a plain one: the quotation marks that
    open and close, the low ones, primes, and the double marks of other
    scripts. */
const QUOTE_LIKE =
  /["\p{Pi}\p{Pf}\u201a\u201e\u02ba\u02dd\u02ee\u05f3\u05f4\u2032-\u2037\u2e42\u275b-\u2760\u3003\u301d-\u301f]/gu;

/** A session's own words made safe to quote: on one line, in their
    compatibility form, anything that would change how they read without
    being seen written as its marker, and any quote mark of their own, or
    anything that reads as one, turned single, so nothing in them closes
    the quote and reads as words of the answer's own, the workbench's or
    the user's. */
function ownWords(text: string): string {
  return shown(oneLine(text.normalize("NFKC"))).replace(QUOTE_LIKE, "'");
}

/** A session's last line as an answer quotes it: its own words, cut short
    and in double quotes. Null for no words. */
function quotedLine(note: string | null): string | null {
  const line = note === null ? "" : ownWords(note);
  if (line === "") return null;
  const chars = [...line];
  return `"${chars.length > LINE_CAP ? `${chars.slice(0, LINE_CAP - 1).join("")}…` : line}"`;
}

/** The id of the session that started this one, when one did: the row's
    own link, else the one remembered by the row's session id. */
export function startedFor(key: string | null): string | null {
  if (key === null) return null;
  return conductor.startedBy[key] ?? ownerOf(byKey(key)?.id ?? null);
}

// A session a caller started answers to the caller: the rows do not call
// for the user over it unless it needs a permission.
onDirected((session) => startedFor(session.key) !== null);

/** What a person knows a session by, by its id: its row's name, and once
    the row has gone the name its caller gave it, or the one it was known
    by, so what the thread said of it stays said. Null when none is kept. */
function nameOf(id: string): string | null {
  const row = byId(id);
  if (row !== null) return label(row);
  // A name that would read as the user's or the workbench's is no name for
  // a session, as a row's never is.
  const fit = (name: string | null | undefined) =>
    name !== null && name !== undefined && name.trim() !== "" && !reservedName(name) ? shown(name) : null;
  for (const list of Object.values(conductor.started)) {
    const name = fit(list.find((entry) => entry.id === id)?.name);
    if (name !== null) return name;
  }
  return fit(sessions.names[id]);
}

nameKeptBy(nameOf);

// The thread words a call on the workbench's tools by the rows' names: a
// session by its id, and the sessions a wait that names none is watching
// when exactly one caller is waiting.
nameSessionsBy({
  named: nameOf,
  watching: () => {
    const holding = Object.keys(conductor.listening);
    if (holding.length !== 1) return null;
    const rows = startedBy(holding[0]).filter((row) => isLive(row));
    return rows.length === 0 ? null : rows.map((row) => label(row));
  },
});

// The name a start gave a session is kept on its caller's list, and is the
// session's row's name while its agent's own title names nothing.
onGiven((session) => {
  if (session.id === null) return null;
  const caller = startedFor(session.key);
  return caller === null ? null : (remembered(caller, session.id)?.name ?? null);
});

// A row of a session a caller started that goes is remembered on the
// caller's list as closed or ended, so the tools say why it is not running.
// One the caller stops is taken off the list as it goes.
onClosed((session) => {
  // A caller whose row goes has no one to hear how its calls went.
  if (conductor.later[session.token] !== undefined && !sessions.all.some((row) => row !== session && row.token === session.token)) {
    delete conductor.later[session.token];
    saveLater();
  }
  const caller = startedFor(session.key);
  if (caller === null || session.id === null) return;
  const entry = remembered(caller, session.id);
  if (entry === null) return;
  const ended = session.status === "exited" || session.status === "crashed" || session.status === "failed";
  entry.left = ended ? "ended" : "closed";
  saveStarted();
});
// The prompt a session is started with is its starter's.
startersFrom(startedFor);

// A session gone from its project goes from what its workflow ran too,
// and its notes go, with those of the sessions it started.
onForgotten((tokens, project) => {
  const notes = tokens.map((token) => ({ project, token }));
  for (const token of tokens)
    for (const entry of conductor.started[token] ?? [])
      notes.push({ project: entry.project, token: sessions.tokens[entry.id]?.token ?? "" });
  forgetNotes(notes);
  for (const token of tokens) delete conductor.runs[token];
  saveRuns();
});

// A session another started that went on from its notes as a fresh
// conversation keeps its place on its starter's list and in its workflow
// under the fresh conversation's id, and the old id still names it.
onWentOn((from, to) => {
  let started = false;
  for (const list of Object.values(conductor.started))
    for (const entry of list)
      if (entry.id === from) {
        entry.id = to;
        started = true;
      }
  if (started) saveStarted();
  let ran = false;
  for (const run of Object.values(conductor.runs)) {
    const place = run.places[from];
    if (place !== undefined) {
      delete run.places[from];
      run.places[to] = place;
      ran = true;
    }
    for (const at of Object.values(run.places))
      if (at.work === from) {
        at.work = to;
        ran = true;
      }
    if (run.rested?.includes(from)) {
      run.rested = run.rested.map((id) => (id === from ? to : id));
      ran = true;
    }
  }
  for (const at of Object.values(conductor.places)) if (at.work === from) at.work = to;
  if (ran) saveRuns();
});

// A session from before there were tokens kept what it started, what its
// workflow ran and its standing answers under its id. They go to the
// token it is given whenever it is given one, unless a run named by the id
// still runs, whose they stay until it stops. What it started is joined
// by session id, the id's list staying for the version before, so a move
// made again, or by a second window, adds nothing and puts back what a
// window that wrote over it lost. Standing answers, the rows it started in
// this run and what its workflow ran move whole: no version reads the
// id's copy of them, and one left behind would bring back what the token
// has since let go of.
onMoved((id, token) => {
  if (namesLiveRun(id)) return;
  for (const entry of [...allowed]) {
    const [caller, project, account, bare] = JSON.parse(entry) as Allowance;
    if (caller !== id) continue;
    allowed.delete(entry);
    allowed.add(allowance(token, project, { account, bare }));
  }
  for (const [key, caller] of Object.entries(conductor.startedBy))
    if (caller === id) conductor.startedBy[key] = token;
  if (cut.delete(id)) cut.add(token);
  const trees = conductor.trees[id];
  if (trees !== undefined) {
    delete conductor.trees[id];
    for (const tree of trees) madeTree(token, tree.project, tree.path);
    saveTrees();
  }
  const list = conductor.started[id];
  if (list !== undefined) {
    const have = conductor.started[token] ?? [];
    const added = list.filter((entry) => !have.some((known) => known.id === entry.id));
    if (added.length > 0) {
      conductor.started[token] = [...have, ...added.map((entry) => ({ ...entry }))];
      saveStarted();
    }
  }
  const run = $state.snapshot(conductor.runs[id]);
  if (run !== undefined) {
    const into = $state.snapshot(conductor.runs[token]) ?? { places: {}, rounds: {} };
    for (const [kid, at] of Object.entries(run.places)) into.places[kid] ??= at;
    for (const [key, count] of Object.entries(run.rounds))
      into.rounds[key] = Math.max(into.rounds[key] ?? 0, count);
    for (const [key, count] of Object.entries(run.stopped ?? {}))
      (into.stopped ??= {})[key] = Math.max(into.stopped[key] ?? 0, count);
    const rested = [...new Set([...(into.rested ?? []), ...(run.rested ?? [])])];
    if (rested.length > 0) into.rested = rested;
    conductor.runs[token] = into;
    delete conductor.runs[id];
    saveRuns();
  }
});

/** The rows a session started, running or not. */
export function startedBy(sessionId: string): Session[] {
  return sessions.all.filter(
    (session) => startedFor(session.key) === sessionId,
  );
}

/** Closes every session a session started. */
export function stopAll(sessionId: string) {
  for (const session of startedBy(sessionId)) stopStarted(session.key);
}

/**
 * Whether a call may act on a session: a caller acts on the sessions it
 * started and on no others. The user allowed a caller to start sessions,
 * which is not leave to type into the one they are working in themselves,
 * and an agent takes its instructions from what it reads.
 */
function mine(request: Placed, session: Session): boolean {
  return startedFor(session.key) === callerOf(request);
}

/** What a caller is told about a session that is not its own. */
function notMine(id: string): Answered {
  return refused(
    `Session ${id} was not started by you. Sending, stopping, reading and waiting are for the sessions you started; this one is the user's own.`,
  );
}

/** Who is calling: the token of the session the call names, or an agent
    the workbench did not start, by the folder it calls from. */
function callerOf(request: Placed): string {
  return request.caller;
}

function byId(sessionId: string): Session | null {
  return sessions.all.find((session) => session.id === sessionId) ?? null;
}

/** The agent to run: the one the call named when it is one the workbench
    drives, else the project's own. */
function agentOf(request: ConductRequest, project: string): AgentId {
  const wanted = text(request, "agent");
  if (wanted === "claude-code" || wanted === "codex") return wanted;
  return defaultAgent(project);
}

/**
 * Puts the question to the user, unless this caller already has a
 * standing answer for the project and what the session would run on. A
 * round past a review's limit is always asked, and so is every start a
 * call that names no session asks for: the workbench cannot tell which
 * agent makes it, one run outside the workbench or a session that left its
 * name out, so it neither uses nor gives a standing answer. Nor does any
 * start while the settings ask before every start. A question that
 * arrives while another is up waits behind it.
 */
function askUser(
  request: Placed,
  project: string,
  prompt: string,
  worktree: boolean,
  login: Login | null,
  named: Named | null,
  round: Beyond | null = null,
): Promise<Choice> {
  const outside = outsideFolder(callerOf(request));
  const once = outside !== null || startAsk.every;
  if (
    !once &&
    round === null &&
    login !== null &&
    allowed.has(allowance(callerOf(request), project, login))
  )
    return Promise.resolve("allow");
  const session = callingSession(request);
  const ask: Ask = {
    request,
    outside,
    caller:
      outside !== null
        ? "An unnamed agent"
        : session === null
          ? "A session"
          : label(session),
    project,
    prompt: prompt.split("\n")[0],
    worktree,
    round,
    login,
    named,
    once,
  };
  onUser.add(request.id);
  if (round !== null) roundAsked.add(request.id);
  return new Promise<Choice>((settle) => {
    queue.push({
      ask,
      settle: (choice) => {
        onUser.delete(request.id);
        roundAsked.delete(request.id);
        // A call answered before it was done is kept as no longer in front
        // of the user.
        if (Object.values(conductor.later).some((list) => list.some((one) => one.call === request.id)))
          saveLater();
        settle(choice);
      },
    });
    nextAsk();
  });
}

/** Takes down the question on screen once the session that asked has
    stopped, and puts up the next: nothing it asked for would be done, and
    an answer would go to no one. */
function withdrawGone() {
  const ask = conductor.asking;
  if (ask === null || !callerGone(ask.request)) return;
  untrack(() => {
    const settle = pending;
    conductor.asking = null;
    pending = null;
    settle?.("no");
    nextAsk();
  });
}

/** Puts up the next question, passing over those whose caller has stopped
    meanwhile, which do nothing. */
function nextAsk() {
  if (conductor.asking !== null) return;
  let head = queue.shift();
  while (head !== undefined && callerGone(head.ask.request)) {
    head.settle("no");
    head = queue.shift();
  }
  if (head === undefined) return;
  conductor.asking = head.ask;
  pending = head.settle;
}

function answerAsk(choice: Choice) {
  const ask = conductor.asking;
  const settle = pending;
  conductor.asking = null;
  pending = null;
  // A round past the limit is allowed once, whatever the button, and so is
  // a session for an agent the workbench did not start, and every session
  // while the settings ask before every start.
  if (
    ask !== null &&
    choice === "allow" &&
    !ask.once &&
    ask.round === null &&
    ask.login !== null
  )
    allowed.add(allowance(callerOf(ask.request), ask.project, ask.login));
  settle?.(choice);
  nextAsk();
}

/** This caller may start sessions in this project from now on. */
export function allow() {
  answerAsk("allow");
}

/** This one session, and the question again next time. */
export function once() {
  answerAsk("once");
}

/** No session, and the caller hears it as a refusal. */
export function refuse() {
  answerAsk("no");
}

/** Answers a round past a review's limit, for this one round or not,
    when it is still the question on screen: an answer given to a question
    that has gone reaches no other. True when it was answered. */
export function answerRound(ask: Ask, allowed: boolean): boolean {
  if (conductor.asking !== ask || ask.round === null) return false;
  answerAsk(allowed ? "once" : "no");
  return true;
}

/** The projects a caller may start sessions in without being asked. */
export function allowedProjects(callerId: string): string[] {
  const projects: string[] = [];
  for (const entry of allowed) {
    const [caller, project] = JSON.parse(entry) as Allowance;
    if (caller === callerId && !projects.includes(project))
      projects.push(project);
  }
  return projects;
}

/** Takes a standing answer back: the caller's next start in that project is
    put to the user again, under whichever account. */
export function revoke(callerId: string, project: string) {
  for (const entry of [...allowed]) {
    const [caller, held] = JSON.parse(entry) as Allowance;
    if (caller === callerId && held === project) allowed.delete(entry);
  }
}

/** A standing answer: the caller, the project, and what the sessions it
    allowed run on, the account and the agent where the account keeps no
    directory for it. */
type Allowance = [string, string, string | null, AgentId | null];

function allowance(caller: string, project: string, login: Login): string {
  return JSON.stringify([
    caller,
    project,
    login.account,
    login.bare,
  ] satisfies Allowance);
}

/** Null once a row's process is up, else why it is not: the row failed,
    ended, was closed, or never came up in the time a start is given. */
function cameUp(key: string): Promise<string | null> {
  return settles<string | null>(
    (settle) => {
      const session = byKey(key);
      if (session === null) settle("The session was closed before it started.");
      else if (session.status === "running") settle(null);
      else if (session.status !== "starting") settle(statusMessage(session));
    },
    START_WAIT,
    "The session did not come up.",
  );
}

/** The id of a session once it has one, or null when it never came up. */
function idFor(key: string): Promise<string | null> {
  return settles<string | null>(
    (settle) => {
      const session = byKey(key);
      if (session === null) {
        settle(null);
        return;
      }
      if (session.id !== null) settle(session.id);
      else if (session.status !== "starting") settle(null);
    },
    START_WAIT,
    null,
  );
}

/**
 * A promise the session rows settle. The test runs whenever anything it
 * read changes, so nothing here polls the store; the timer is only the
 * cap on how long the caller is held.
 */
function settles<T>(
  test: (settle: (value: T) => void) => void,
  ms: number,
  onTimeout: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    let stop: (() => void) | null = null;
    const timer = setTimeout(() => settle(onTimeout), ms);
    function settle(value: T) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Torn down after the effect that is settling has finished running.
      void Promise.resolve().then(() => stop?.());
      resolve(value);
    }
    stop = $effect.root(() => {
      $effect(() => test(settle));
    });
  });
}

/** A string argument, trimmed. Null when it is missing or empty. */
function text(request: ConductRequest, name: string): string | null {
  const value = request.arguments[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function flag(request: ConductRequest, name: string): boolean {
  const value = request.arguments[name];
  return value === true || value === "true";
}

/** A whole number argument, within what the tool offers. */
function number(
  request: ConductRequest,
  name: string,
  fallback: number,
  most: number,
): number {
  const value = request.arguments[name];
  const asked =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(asked) || asked < 1) return fallback;
  return Math.min(Math.floor(asked), most);
}

/** Test seam. */
export function resetConductor() {
  conductor.asking = null;
  for (const key of Object.keys(conductor.startedBy))
    delete conductor.startedBy[key];
  conductor.started = {};
  conductor.trees = {};
  conductor.places = {};
  conductor.runs = {};
  conductor.refusals = {};
  pending = null;
  queue.length = 0;
  allowed.clear();
  seen.clear();
  stops.clear();
  owed.clear();
  reserved.clear();
  waiting.clear();
  given.clear();
  holding.clear();
  onUser.clear();
  roundAsked.clear();
  calling.clear();
  conductor.later = {};
  cut.clear();
  conductor.listening = {};
  for (const wake of wakes.values()) clearTimeout(wake.timer);
  wakes.clear();
  restingSince.clear();
  answeredAt.clear();
  waking.clear();
  for (const timer of wakeTurns.values()) if (timer !== null) clearTimeout(timer);
  wakeTurns.clear();
  typing.clear();
  conductor.woken = {};
  conductor.wakesInRow = {};
  for (const timer of puttingAway.values()) clearTimeout(timer);
  puttingAway.clear();
  leftToSee.clear();
  comingBack.clear();
}
