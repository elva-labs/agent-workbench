/**
 * The tools a session gets for directing other sessions.
 *
 * An agent calls them where it runs; the core carries each call to the
 * window as a request and waits for exactly one answer to it. The window
 * is where the projects and the sessions are, so the work and the
 * answering are here. Every answer is plain lines for an agent to read.
 *
 * Starting a session is the one call the user is brought into. The first
 * time a caller asks to start one in a project the window puts the
 * question up and holds the call until it is answered, and an allowed
 * caller is remembered for that project and the account its sessions run
 * under until the board takes it back or the window goes. Calls that
 * arrive while a question is up wait their turn.
 *
 * A session may start others, and those may not start any of their own:
 * one level deep, and no more than the cap at a time, so a loop of agents
 * starting agents cannot run away with the machine.
 *
 * Every session the workbench starts names itself in each call its tools
 * make, by a token the window chose for it and gave its environment, and
 * the caller is the session that token names. A call that names no session
 * the workbench runs, as one from an agent it did not start does, is
 * refused: these tools serve the workbench's own sessions and no other
 * agent.
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
  OWN_LABEL,
} from "$lib/accounts.svelte";
import { agentLabel } from "$lib/agent.svelte";
import { untrack } from "svelte";
import { SvelteSet } from "svelte/reactivity";

import { core, type ConductRequest } from "$lib/core";
import {
  nameTaken,
  byKey,
  byToken,
  close,
  create,
  disown,
  defaultAgent,
  isLive,
  label,
  onDirected,
  onForgotten,
  sessions,
  statusMessage,
  typed,
  type Session,
} from "$lib/sessions.svelte";
import type { AgentId, ReviewStep, Workflow, WorkflowStep, WorkStep } from "$lib/core";
import { CODEX_DEFAULT } from "$lib/models";
import { hostOf } from "$lib/remote.svelte";
import { instructionLines, modelText } from "$lib/workflowInstructions";
import { stepFacts } from "$lib/workflows.svelte";
import { screen, takesPaste } from "$lib/screens";
import {
  conversationOf,
  handleOf,
  notesFrom,
  send as sendIntegrated,
  userWaiting,
} from "$lib/integrated.svelte";
import { lastRun } from "$lib/thread";
import { OUTCOME_ASK, REPORTS_HEAD } from "$lib/instructions";
import { senderOf, startersFrom } from "$lib/senders.svelte";
import { mixesScripts, readsAsYou } from "$lib/unseen";
import { within } from "$lib/show.svelte";
import { printable } from "$lib/terminals.svelte";
import { projectLabel, workspace } from "$lib/workspace.svelte";

/** How many sessions one caller may have running at a time. */
export const CAP = 8;
/** How long a wait runs when the call names no seconds, and the most it
    runs whatever it names. The core gives up on the same clock. */
export const WAIT_SECONDS = 600;
export const WAIT_MAX = 1800;
/** How long a start waits for the new session to come up and say its id.
    Inside the minute the core gives the window to answer. */
export const START_WAIT = 30_000;
/** How much of a session's screen the read tool answers with when the
    call names no number, and the most it answers with whatever it names. */
export const LINES = 40;
export const LINES_MAX = 200;
export { OUTCOME_ASK, REPORTS_HEAD };

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

/** Types a line into a session the way a person does: the text, whole, and
    then Enter on its own. The agent has been spoken to, as by a line typed
    into its terminal. */
export async function typeLine(
  key: string,
  ptyId: string,
  line: string,
): Promise<void> {
  const wait = await typeWhole(key, ptyId, line);
  await pause(wait);
  await core().write(ptyId, "\r");
  typed(ptyId, "\r");
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
  close(key);
  if (id === null) return;
  disown(project, id);
  if (owner !== null) forget(owner, id);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The question on screen: which call it holds, who asked, and what for. */
export interface Ask {
  request: Placed;
  /** What the calling session is called, for the title. */
  caller: string;
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
}

/** Where a started session stands in its caller's workflow. */
export interface Place {
  /** The step it is for, by name. */
  step: string;
  kind: WorkflowStep["kind"];
  /** The piece of work it is part of: the id of the session that began the
      piece. Null for a work session that began one and has no id yet. */
  piece: string | null;
  /** For a review, which round of it this is, from one. */
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
}

const STARTED_KEY = "workbench.started";
const RUNS_KEY = "workbench.runs";
const CARRIED_KEY = "workbench.carried";

export const conductor = $state({
  asking: null as Ask | null,
  /** The session that started each row, by the row's key and the
      starter's token: the link for a row that has no id yet, and for the
      rest until the window goes. */
  startedBy: {} as Record<string, string>,
  /** What each caller started, by the caller's token, kept between runs.
      A row whose id is here is the caller's whether or not it was started
      in this run. A list an earlier version kept under the folder a caller
      that named no session called from is kept as it is, and is no
      caller's, since no call names a folder. */
  started: {} as Record<string, Started[]>,
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
});

/** Reads what callers started in earlier runs. A corrupt entry reads as
    nothing remembered rather than a broken pane. */
export function loadStarted() {
  loadStartedList();
  loadRuns();
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
      const { places, rounds } = run as Record<string, unknown>;
      const kept: Run = { places: {}, rounds: {} };
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
  const { sessions: running, held } = runningFor(caller, step.name);
  if (running.length + held < step.parallel) return null;
  const at = step.parallel === 1 ? "one session" : `${step.parallel} sessions at most`;
  if (running.length === 0)
    return `The step ${quoted(step.name)} runs ${at} at once, and another start for it is on its way. Wait for it to answer before starting another.`;
  const ids = either(
    running.map((session) => session.id ?? label(session)),
    "and",
  );
  return `The step ${quoted(step.name)} runs ${at} at once, and ${running.length === 1 ? `session ${ids} is` : `sessions ${ids} are`} running for it. Stop one once its work is done, before starting another; a stopped session can be resumed.`;
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

function forget(caller: string, id: string) {
  const list = conductor.started[caller];
  if (list === undefined) return;
  const kept = list.filter((known) => known.id !== id);
  if (kept.length === 0) delete conductor.started[caller];
  else conductor.started[caller] = kept;
  saveStarted();
}

/** Whether a list is kept under a folder rather than a caller's token: an
    earlier version's, for a caller whose calls named no session. */
const byFolder = (caller: string) => /^(?:\/|ssh:\/\/|[A-Za-z]:[\\/])/.test(caller);

/** The caller of each remembered session, by the session's id: the first
    caller listed where two remember one, a caller's own list before one
    kept under a folder. A session a folder's list holds was started by
    another all the same, so it starts none of its own, and no call acts
    on it: no call names a folder. */
const owners = $derived.by(() => {
  const index = new Map<string, string>();
  const lists = Object.entries(conductor.started);
  for (const folders of [false, true])
    for (const [caller, entries] of lists) {
      if (byFolder(caller) !== folders) continue;
      for (const entry of entries)
        if (!index.has(entry.id)) index.set(entry.id, caller);
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
/** Calls given up on by the agent: their answer is not written. */
const given = new Set<string>();
/** Callers whose last wait was given up on, as the user's message cutting
    it short does: the next note they are given says what is still out. */
const cut = new Set<string>();

/**
 * The agent gave up on a call. A wait still held for it ends without
 * answering and tells nothing, since no one is there to hear it.
 */
export function cancelled(id: string) {
  const held = waiting.get(id);
  if (held === undefined) return;
  given.add(id);
  if (held.noted !== true) cut.add(held.caller);
  held.abandon();
}

/** What a wait the user's message ended answers. */
export const USER_WROTE =
  "The user wrote to you, which ends this wait. Read their message, ending your turn if it has not reached you yet, and answer it before you wait again.";

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
  try {
    answered = await run(request);
  } catch (error) {
    answered = refused(String(error));
  }
  if (request.tool === "start" && answered.byUser !== true)
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
  const call = request as Placed;
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

/** A call the workbench has placed: its token names a session it runs,
    which is the caller. */
export type Placed = ConductRequest & { session: string };

/** What a call is told that names no session: each session the workbench
    starts names itself in every call its tools make, so it is not taken
    for one of them. */
export const OUTSIDE =
  "This call names no session, so the workbench cannot tell it comes from one of its sessions: each session it starts names itself in every call its tools make, and an agent it did not start names none. The tools that start and direct sessions are for the sessions the workbench runs. Start the agent from the workbench to use them.";

/** What a call is told that names a session the workbench is not running:
    one it never had, or one that has stopped and so cannot be calling. */
export const UNKNOWN =
  "This call names a session the workbench is not running, so it cannot tell what this call may do. The tools that start and direct sessions are for the sessions the workbench runs.";

/** Why a call cannot be held to a session, when it cannot: it names none,
    or names one the workbench is not running. Null for a call whose token
    names a running session, which is the caller. */
function unplaced(request: ConductRequest): string | null {
  if (request.session === null) return OUTSIDE;
  return callerRow(request) === null ? UNKNOWN : null;
}

/** The running session a call's token names, the caller. */
function callerRow(request: ConductRequest): Session | null {
  const row = byToken(request.session);
  return row !== null && isLive(row) ? row : null;
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
  const role = `${at.step}${at.kind === "review" && at.round !== null ? ` round ${at.round}` : ""}`;
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

/** What the user knows a session's work by: the name its row has, or had,
    and never its id. */
export function workName(caller: string, id: string): string {
  const row = byId(id);
  if (row !== null && row.title !== null) return row.title;
  const known = sessions.names[id] ?? remembered(caller, id)?.name ?? null;
  if (known !== null) return known;
  return row !== null && row.resumedFrom === null ? label(row) : "the work it checks";
}

/** The open projects, the caller's own marked. */
function projectLines(request: Placed): string {
  if (workspace.open.length === 0)
    return "No projects are open in the workbench.";
  const here = projectOf(request.cwd);
  // The name is the one the pane shows: the folder's, with as much of the
  // path above it as tells it from another open project called the same.
  return workspace.open
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
    workspace.open
      .map((project) => project.path)
      .filter((path) => within(cwd, path))
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}

/** How a session is at rest: gone, waiting on the user, or gone quiet. */
type Rest = "ended" | "permission" | "quiet";

/**
 * What each session a caller started is doing about stopping, by the row's
 * key: whether it has worked, how it is at rest now, if it is, and how it
 * was at rest when the caller was last told. A stop is untold while the two
 * differ, so a session that goes from one kind of rest to another is
 * reported again, and one that works again starts over.
 */
type Mark = { worked: boolean; rest: Rest | null; told: Rest | null };

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
  const mark = stops.get(key) ?? { worked: false, rest: null, told: null };
  const before = unheardMark(stops.get(key));
  stops.set(key, mark);
  if (!isLive(session)) mark.rest = "ended";
  else if (session.needs === "permission") mark.rest = "permission";
  else if (session.working) {
    mark.worked = true;
    mark.rest = null;
    mark.told = null;
  } else mark.rest = mark.worked ? "quiet" : null;
  if (unheardMark(mark) !== before) moved();
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
  moved();
}

/**
 * Notes stops as the rows change, so one that lands while no wait is
 * running is still there for the next call. Called once by the page;
 * the function it returns stops the watching.
 */
export function watchStops(): () => void {
  return $effect.root(() => {
    $effect(observeAll);
  });
}

/** Whether a started session is still at work: running, and not at rest
    in any way, which takes in one that has not begun yet. */
function atWork(session: Session): boolean {
  observe(session);
  return isLive(session) && stops.get(session.key)?.rest === null;
}

/** A note for a caller, and what counts it as told once it has reached
    the agent. */
export interface Note {
  text: string;
  deliver: () => void;
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
  const name = (kid: Session) => oneLine(kid.id ?? label(kid));
  const lines = news.map((kid) => restText(kid, name(kid)));
  const out = holding.length > 0 || lapsed ? kids.filter(atWork) : [];
  if (out.length > 0)
    lines.push(
      `Still at work when the user wrote: ${either(out.map(name), "and")}. Call wait to hear from them once you have answered.`,
    );
  if (lines.length === 0) return null;
  return {
    text: [REPORTS_HEAD, ...lines].join("\n"),
    deliver: () => {
      for (const [key, rest] of reported) tellAs(key, rest);
      cut.delete(caller);
      // A wait the message is about to cut short has had its still-out
      // line.
      for (const wait of holding) wait.noted = true;
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
  if (listed.length === 0 && gone.length === 0)
    return "You have started no sessions.";
  const lines = [
    ...listed.map(describe),
    ...gone.map((entry) => describeGone(callerOf(request), entry)),
  ];
  // Listing a stop is telling it.
  for (const session of listed) tell(session.key);
  return lines.join("\n");
}

function describe(session: Session): string {
  const parts = [session.id ?? "", label(session), session.project];
  const tree = session.worktree ?? session.startIn;
  if (tree !== null && tree !== session.project) parts.push(`worktree ${tree}`);
  parts.push(session.agent);
  const place = placeOf(session.key);
  if (place !== null) parts.push(placeText(place));
  parts.push(stateOf(session));
  if (untold(session)) parts.push("not reported to you yet");
  if (session.note !== null) parts.push(`last line: ${session.note}`);
  return parts.join("  ");
}

/** A remembered session that is not open as a row, in the same words. */
function describeGone(owner: string, entry: Started): string {
  const parts = [
    entry.id,
    sessions.names[entry.id] ?? entry.name ?? entry.id.slice(0, 8),
    entry.project,
  ];
  if (entry.worktree !== null) parts.push(`worktree ${entry.worktree}`);
  parts.push(entry.agent);
  const at = placed(owner, entry.id);
  if (at !== null) parts.push(placeText(at));
  parts.push("stopped", `resume it with start, naming session ${entry.id}`);
  return parts.join("  ");
}

/** Where a session stands in the workflow, in the words the tools answer
    in: its step, and for a review the round and the work it checks. */
export function placeText(place: Place): string {
  if (place.kind === "work") return `step "${place.step}"`;
  return `step "${place.step}" round ${place.round ?? 1}, reviewing session ${place.work ?? "unknown"}`;
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
  if (!workspace.open.some((open) => open.path === project))
    return refused(`No project at ${project} is open in the workbench.`);
  // An account is one the user named in the settings.
  const wanted = text(request, "account");
  if (wanted !== null && !(wanted in accounts.list))
    return refused(
      names().length === 0
        ? "There are no accounts in the workbench's settings; leave the account out."
        : `There is no account called ${wanted}. The accounts are ${names().join(", ")}.`,
    );
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
    const answer = await startFitted(request, project, prompt, name, wanted, caller, fit);
    started = answer.error === null;
    return answer;
  } finally {
    fit?.release(started);
  }
}

/** The rest of a start, once it has been held to the caller's workflow:
    the account it runs under, which turns on the agent the step chose, the
    question, and the session itself. */
async function startFitted(
  request: Placed,
  project: string,
  prompt: string,
  name: string | null,
  wanted: string | null,
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
  const answer = await askUser(
    request,
    project,
    prompt,
    wants,
    { account, bare },
    named,
    beyond,
  );
  if (answer === "no")
    return {
      ...refused(
        beyond === null
          ? "The user did not allow the session to be started."
          : notAllowed(beyond),
      ),
      byUser: true,
    };

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
  }

  // A started session does not take the window: the user is in the session
  // that started it, and that is where its questions are answered. The row
  // appears folded under its project, and going to it is a click.
  const looking = sessions.active;
  const session = create(
    project,
    null,
    agent,
    startIn,
    `${oneLine(prompt)} ${OUTCOME_ASK}`,
    fit === null ? text(request, "model") : fit.model,
    account,
    null,
  );
  conductor.startedBy[session.key] = caller;
  if (fit !== null) {
    conductor.places[session.key] = fit.place;
    // The row holds its place in the step from here.
    fit.hold();
  }
  // The name the caller gave is the row's, until the agent names it. One
  // that reads as "You" is the user's alone, and one another live session
  // has is that session's: neither is taken, and the row is named by the
  // prompt instead.
  // Weighed as it would be stored.
  const candidate = name === null ? null : oneLine(name);
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
  remember(caller, {
    id,
    project,
    worktree: startIn,
    agent,
    name: called,
    account,
  });
  const where = startIn === null ? project : `${project}, in ${startIn}`;
  const notCalled = you
    ? ` It is not called ${oneLine(name!)}: a conversation shows the user's own words under that name, so the session is named by its prompt.`
    : taken
      ? mixesScripts(candidate!)
        ? ` It is not called ${oneLine(name!)}: its letters mix scripts, as a name made to pass for another's does, so the session is named by its prompt.`
        : ` It is not called ${oneLine(name!)}: another session is called that, so the session is named by its prompt.`
      : "";
  if (fit === null)
    return said(
      `Started session ${id} in ${where}${underWords(named)}. It has the prompt.${notCalled} Call wait to hear how it goes.`,
    );
  // A work session that began a piece is the piece's name from here.
  const at: Place = { ...fit.place, piece: fit.place.piece ?? id };
  conductor.places[session.key] = at;
  place(caller, id, at);
  return said(
    `Started session ${id} for ${placeText(at)} in ${where}${underWords(named)}. It has the prompt.${notCalled} Call wait to hear how it goes.`,
  );
}

/**
 * The account a start runs under, and whether the question and the answer
 * name it.
 *
 * An account the start names is the one. Otherwise the caller's own is
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
 * on, and when one handed on keeps no directory for the agent.
 */
function underFor(
  request: Placed,
  project: string,
  agent: AgentId,
  wanted: string | null,
): { account: string | null; say: boolean } {
  const own = accountOf(project);
  const under = (account: string | null, anyway: boolean) => ({
    account,
    say: hasAccounts() && (anyway || account !== own),
  });
  if (wanted !== null) return under(wanted, false);
  const calling = callingSession(request);
  if (calling === null) return under(own, true);
  const theirs = calling.account;
  if (theirs === accountOf(calling.project)) return under(own, false);
  if (hostOf(calling.project) !== hostOf(project)) return under(own, true);
  if (theirs !== null && !(theirs in accounts.list)) return under(own, true);
  return under(theirs, theirs !== null && dirFor(theirs, agent) === undefined);
}

/** The session a placed call comes from, while it runs: the one its token
    names. Null once that session has stopped. */
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
      place: { step: step.name, kind: "work", piece, round: null, work: null },
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
    beyond: pastLimit(caller, step, from, done),
    hold: () => {},
    release: (started) => {
      if (!started) uncountRound(caller, step.name, piece);
    },
  };
}

/** A round past the most a review gives a piece: one more than the first
    and a round for every time it may send the work back. Null within it. */
function pastLimit(
  caller: string,
  step: ReviewStep,
  work: string,
  done: number,
): Beyond | null {
  return done > step.limit
    ? { step: step.name, work, name: workName(caller, work), done, limit: step.limit }
    : null;
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
  return `${quoted(beyond.name)}, the work of session ${beyond.work}, has had ${beyond.done} rounds of ${quoted(beyond.step)}, ${against}, and the user did not allow another. Ask the user how to go on.`;
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
    a session that is not running cannot be calling. */
function callerFlow(
  request: Placed,
): { workflow: Workflow | null } | { refusal: string } {
  const row = callingSession(request);
  if (row === null) return { refusal: UNKNOWN };
  return { workflow: row.workflow };
}

const ONE_LEVEL =
  "A session that another session started cannot start sessions of its own.";

/** Why a caller may not start another session right now, when it may not:
    it has as many running as one may, or it was itself started by one. */
function roomFor(request: Placed): Answered | null {
  if (startedBy(callerOf(request)).filter(isLive).length >= CAP)
    return refused(
      `You have ${CAP} sessions running already, which is as many as one session may have. Stop one before starting another.`,
    );
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
  if (!workspace.open.some((open) => open.path === project))
    return refused(
      `Session ${id} ran in ${project}, which is not open in the workbench.`,
    );

  const prompt = text(request, "prompt");
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
    } else if (prompt !== null && at.piece !== null) {
      const piece = at.piece;
      const done = roundsOf(caller, step.name, piece);
      beyond = pastLimit(caller, step, at.work ?? piece, done);
      countRound(caller, step.name, piece);
      goesOn = { ...at, round: done + 1 };
      release = (started) => {
        if (!started) uncountRound(caller, step.name, piece);
      };
    }
  }

  let started = false;
  try {
    // Resuming is not asked about, the consent having been given when the
    // session was started, except for a round past the review's limit.
    if (
      beyond !== null &&
      (await askUser(
        request,
        project,
        prompt ?? "",
        false,
        null,
        null,
        beyond,
      )) === "no"
    )
      return { ...refused(notAllowed(beyond)), byUser: true };
    if (worktree !== null && !(await treeStands(project, worktree)))
      return refused(
        `Session ${id} ran in the worktree ${worktree}, which is gone. Start a new session for the work instead.`,
      );

    // A row that ended is its transcript again; the resumed session takes
    // its place rather than sitting beside it.
    const now = byId(id);
    if (now !== null) close(now.key);
    const looking = sessions.active;
    const session = create(
      project,
      id,
      agent,
      worktree,
      prompt === null ? null : `${oneLine(prompt)} ${OUTCOME_ASK}`,
      model,
      entry.account ?? null,
      null,
    );
    conductor.startedBy[session.key] = caller;
    if (goesOn !== null) {
      conductor.places[session.key] = goesOn;
      hold();
    }
    if (session.title === null && entry.name !== null) session.title = entry.name;
    if (looking !== null && byKey(looking) !== null) sessions.active = looking;

    const trouble = await cameUp(session.key);
    if (trouble !== null) return refused(trouble);
    started = true;
    if (owesRound) owed.add(session.key);
    if (goesOn !== null && goesOn !== at) place(caller, id, goesOn);
    const where = worktree === null ? project : `${project}, in ${worktree}`;
    const round =
      goesOn !== null && goesOn !== at ? ` for ${placeText(goesOn)}` : "";
    return said(
      prompt === null
        ? `Resumed session ${id} in ${where}. It has its conversation and is waiting. Send it a line to go on, then call wait.`
        : `Resumed session ${id}${round} in ${where}. It has its conversation and the prompt. Call wait to hear how it goes.`,
    );
  } finally {
    release(started);
  }
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
  const session = byId(id);
  if (session === null) return refused(`The workbench has no session ${id}.`);
  if (!mine(request, session)) return notMine(id);
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
  const at = placeOf(session.key);
  const flow = callerFlow(request);
  if ("refusal" in flow) return refused(flow.refusal);
  // A session started for a step stays on the model the step gave it, and a
  // caller under a workflow changes the model of none it reaches.
  if ((at !== null || flow.workflow !== null) && mayChangeModel(typed))
    return refused(
      at !== null
        ? keepsItsModel(id, at)
        : `You follow a workflow, so the workbench gives the sessions you reach no command but /compact, and takes a line that begins with a slash, a path included, for one. Say what you want in words, with a word before any path.`,
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
      const beyond = pastLimit(caller, review, at.work ?? at.piece, done);
      if (
        beyond !== null &&
        (await askUser(
          request,
          session.project,
          typed,
          false,
          null,
          null,
          beyond,
        )) === "no"
      )
        return refused(notAllowed(beyond));
      if (!reachable(session)) return unreachable();
      countRound(caller, review.name, at.piece);
      owed.delete(session.key);
      round = { ...at, round: done + 1 };
      conductor.places[session.key] = round;
      if (session.id !== null) place(caller, session.id, round);
      // The round is counted once, however many lines go before it works.
      const mark = stops.get(session.key);
      if (mark !== undefined) mark.worked = false;
    }
  }
  const sent = round === null ? `Sent to session ${id}` : `Sent to session ${id}, for ${placeText(round)}`;
  if (integrated) {
    const working = session.working;
    if (sendIntegrated(session.key, typed, [], callerOf(request)) === null)
      return refused(`Session ${id} is an integrated session and took no message: there was nothing to send.`);
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
  const typed = line.normalize("NFKC").replace(/^[\s\p{Cf}]+/u, "");
  return typed.startsWith("/") && !/^\/compact(\s|$)/i.test(typed);
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
  return mark !== undefined && mark.worked && mark.rest === "quiet";
}

function stopSession(request: Placed): Answered {
  const id = text(request, "session");
  if (id === null) return refused("Stopping needs a session to stop.");
  const session = byId(id);
  if (session === null) return refused(`The workbench has no session ${id}.`);
  if (!mine(request, session)) return notMine(id);
  stopStarted(session.key);
  return said(`Stopped session ${id}.`);
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
    if (watched.length === 0)
      return refused(
        "You have started no sessions to wait for. Name one to wait for it, or start one first.",
      );
  } else {
    const session = byId(id);
    if (session === null) return refused(`The workbench has no session ${id}.`);
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
  // What each one was doing when the wait began: what is worth answering
  // is a change from here, so a session at work is waited out rather than
  // answered for at once. One that stopped without the caller being told
  // counts as having been at work, so its stop is answered now.
  const worked = new Map<string, boolean>();
  const names = new Map<string, string>();
  for (const session of watched) {
    worked.set(session.key, session.working || untold(session));
    names.set(session.key, session.id ?? label(session));
  }

  // The calling session's row: a wait held for a session that is no longer
  // running has no one to hear it.
  const callerAt = callingSession(request)?.key ?? null;
  let reported: string | null = null;
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
      // A session that ended or asks, and was told so already, is answered
      // again only when none of the others can still move; one the caller
      // has not been told of comes first, whatever order they are in.
      let busy = false;
      let again: { key: string; text: string } | null = null;
      for (const key of worked.keys()) {
        const name = names.get(key) ?? key;
        const session = byKey(key);
        if (session === null) {
          settle(`Session ${name} was closed.`);
          return;
        }
        const resting =
          !isLive(session) || session.needs === "permission"
            ? restText(session, name)
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
        if (session.working) worked.set(key, true);
        else if (worked.get(key) === true || untold(session)) {
          reported = key;
          settle(restText(session, name));
          return;
        }
      }
      if (!busy && again !== null) {
        reported = again.key;
        settle(again.text);
      }
    },
    seconds * 1000,
    null,
  );
  waiting.delete(request.id);
  if (abandoned) return said("");
  if (interrupted !== null) return said(interrupted);
  if (reported !== null) tell(reported);
  if (happened === null)
    return said(
      `Nothing happened within ${seconds} seconds: no session stopped and none asked anything.`,
    );
  return said(happened);
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
  if (session === null) return refused(`The workbench has no session ${id}.`);
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

/** What a session at rest is doing, in the words a wait answers with: it
    ended, it is asking for permission, or it stopped working. Its name goes
    on one line, as its last line does. */
function restText(session: Session, called: string): string {
  const name = oneLine(called);
  if (!isLive(session))
    return `Session ${name} ${stateOf(session)}. ${lastLine(session)}`;
  if (session.needs === "permission")
    return `Session ${name} is asking for permission. ${lastLine(session)}`;
  return `Session ${name} stopped working. ${lastLine(session)}`;
}

/** The most of a session's last line a tool answers with, in characters,
    as the core cuts a line left on a row. */
export const LINE_CAP = 120;

/** What a session last left for its row: its own words, on one line and
    cut short, so they read as a line of the answer and nothing more. */
function lastLine(session: Session): string {
  const line = session.note === null ? "" : oneLine(session.note);
  if (line === "") return "It has left no line.";
  const chars = [...line];
  return `Its last line: ${chars.length > LINE_CAP ? `${chars.slice(0, LINE_CAP - 1).join("")}…` : line}`;
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
// The prompt a session is started with is its starter's.
startersFrom(startedFor);

// A session gone from its project goes from what its workflow ran too.
onForgotten((ids) => {
  for (const id of ids) delete conductor.runs[id];
  saveRuns();
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

/** Who is calling: the token of the session the call names. */
function callerOf(request: Placed): string {
  return request.session;
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
 * round past a review's limit is always asked. A question that arrives
 * while another is up waits behind it.
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
  if (
    round === null &&
    login !== null &&
    allowed.has(allowance(callerOf(request), project, login))
  )
    return Promise.resolve("allow");
  const session = callingSession(request);
  const ask: Ask = {
    request,
    caller: session === null ? "A session" : label(session),
    project,
    prompt: prompt.split("\n")[0],
    worktree,
    round,
    login,
    named,
  };
  return new Promise<Choice>((settle) => {
    queue.push({ ask, settle });
    nextAsk();
  });
}

function nextAsk() {
  if (conductor.asking !== null) return;
  const head = queue.shift();
  if (head === undefined) return;
  conductor.asking = head.ask;
  pending = head.settle;
}

function answerAsk(choice: Choice) {
  const ask = conductor.asking;
  const settle = pending;
  conductor.asking = null;
  pending = null;
  // A round past the limit is allowed once, whatever the button.
  if (
    ask !== null &&
    choice === "allow" &&
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
  cut.clear();
  conductor.listening = {};
}
