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
 * caller is remembered for that project until the board takes it back or
 * the window goes. Calls that arrive while a question is up wait their
 * turn.
 *
 * A session may start others, and those may not start any of their own:
 * one level deep, and no more than the cap at a time, so a loop of agents
 * starting agents cannot run away with the machine.
 *
 * What a session started is remembered between runs, by session id, so a
 * caller resumed after the app was closed still finds its sessions: the
 * running ones are its to direct as before, and the ones that went with
 * the app are listed as stopped and can be resumed where they ran.
 *
 * A caller that follows a workflow starts sessions in its shape: each start
 * names a step of it, on a model the step allows, no more at once than a
 * work step lets run, and a review of a session that did work. The started
 * session remembers its place, and the rounds of each review are counted
 * per piece of work, up to the most the review sends the work back.
 */

import { accountOf, accounts, dirsOf, names } from "$lib/accounts.svelte";
import { SvelteSet } from "svelte/reactivity";

import { core, type ConductRequest } from "$lib/core";
import {
  byKey,
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
  type Session,
} from "$lib/sessions.svelte";
import type { AgentId, ReviewStep, Workflow, WorkflowStep, WorkStep } from "$lib/core";
import { CODEX_DEFAULT } from "$lib/models";
import { modelText } from "$lib/workflowInstructions";
import { screen } from "$lib/screens";
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
/** The sentence every started session gets after the caller's own line, so
    what became of it comes back on its row instead of being watched for. */
export const OUTCOME_ASK =
  "When you are done, or stuck, call the notify tool with one line saying which, before your final message.";

/** How long after a line is typed its Enter follows. An agent takes a
    chunk that arrives at once for a paste, and an Enter inside a paste is
    a newline in it rather than a send. */
export const ENTER_AFTER = 150;

/** Types a line into a session the way a person does: the text, and then
    Enter on its own. */
export async function typeLine(ptyId: string, line: string): Promise<void> {
  await core().write(ptyId, line);
  await pause(ENTER_AFTER);
  await core().write(ptyId, "\r");
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
  request: ConductRequest;
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
}

/** A round of a review past the workflow's limit, which only the user can
    allow. */
export interface Beyond {
  step: string;
  work: string;
  done: number;
  limit: number;
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

export const conductor = $state({
  asking: null as Ask | null,
  /** The session that started each row, by the row's key and the
      starter's session id: the link for a row that has no id yet, and for
      the rest until the window goes. */
  startedBy: {} as Record<string, string>,
  /** What each caller started, by the caller's session id, kept between
      runs. A row whose id is here is the caller's whether or not it was
      started in this run. */
  started: {} as Record<string, Started[]>,
  /** Where each started row stands in its caller's workflow, by the row's
      key, from the moment it is made: the place of a row with no id yet. */
  places: {} as Record<string, Place>,
  /** What each caller has run by its workflow, by the caller's id. */
  runs: {} as Record<string, Run>,
});

/** Reads what callers started in earlier runs. A corrupt entry reads as
    nothing remembered rather than a broken pane. */
export function loadStarted() {
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
      for (const [piece, count] of Object.entries(
        isRecord(rounds) ? rounds : {},
      ))
        if (typeof count === "number" && Number.isInteger(count) && count > 0)
          kept.rounds[piece] = count;
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

/** What the rounds of a review of a piece are counted under. */
const roundKey = (step: string, piece: string) => `${step}\n${piece}`;

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
const slotKey = (caller: string, step: string) => `${caller}\n${step}`;

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
      (session) => isLive(session) && placeOf(session.key)?.step === step,
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

/** The caller that started a session, by its id, when one is remembered. */
function ownerOf(id: string | null): string | null {
  if (id === null) return null;
  for (const [caller, entries] of Object.entries(conductor.started))
    if (entries.some((entry) => entry.id === id)) return caller;
  return null;
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
/** Callers with a standing answer, by caller and project. */
const allowed = new SvelteSet<string>();
/** Questions waiting for the one on screen to be answered. */
const queue: { ask: Ask; settle: (choice: Choice) => void }[] = [];
let pending: ((choice: Choice) => void) | null = null;

interface Answered {
  content: string | null;
  error: string | null;
}

/** The waits being held, by call, each with what ends it unanswered. */
const waiting = new Map<string, () => void>();
/** Calls given up on by the agent: their answer is not written. */
const given = new Set<string>();

/**
 * The agent gave up on a call. A wait still held for it ends without
 * answering and tells nothing, since no one is there to hear it.
 */
export function cancelled(id: string) {
  const end = waiting.get(id);
  if (end === undefined) return;
  given.add(id);
  end();
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
  if (given.delete(request.id)) return;
  await core()
    .conductAnswer(request.id, request.cwd, answered.content, answered.error)
    .catch(() => {
      // The core has gone, or the call had already given up. Nothing here
      // can tell the agent either way.
    });
}

function run(request: ConductRequest): Answered | Promise<Answered> {
  switch (request.tool) {
    case "projects":
      return said(projectLines(request));
    case "sessions":
      return said(sessionLines(request));
    case "start":
      return startSession(request);
    case "send":
      return sendText(request);
    case "stop":
      return stopSession(request);
    case "wait":
      return waitFor(request);
    case "read":
      return readSession(request);
    default:
      return refused(`The workbench has no ${String(request.tool)} tool.`);
  }
}

/** The open projects, the caller's own marked. */
function projectLines(request: ConductRequest): string {
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
const stops = new Map<
  string,
  { worked: boolean; rest: Rest | null; told: Rest | null }
>();

/** Brings the record of a started session's stops up to date with the row. */
function observe(session: Session) {
  const key = session.key;
  if (startedFor(key) === null) {
    stops.delete(key);
    return;
  }
  const mark = stops.get(key) ?? { worked: false, rest: null, told: null };
  stops.set(key, mark);
  if (!isLive(session)) mark.rest = "ended";
  else if (session.needs === "permission") mark.rest = "permission";
  else if (session.working) {
    mark.worked = true;
    mark.rest = null;
    mark.told = null;
  } else mark.rest = mark.worked ? "quiet" : null;
}

function observeAll() {
  const keys = new Set(sessions.all.map((session) => session.key));
  for (const key of stops.keys()) if (!keys.has(key)) stops.delete(key);
  for (const session of sessions.all) observe(session);
}

/** Whether a session has stopped and the caller has not been told. */
function untold(session: Session): boolean {
  observe(session);
  const mark = stops.get(session.key);
  return mark !== undefined && mark.rest !== null && mark.rest !== mark.told;
}

function tell(key: string) {
  const mark = stops.get(key);
  if (mark !== undefined) mark.told = mark.rest;
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

/**
 * The caller's own sessions, the ones it started: the user's own are on
 * their own subjects, and a session directing work has no business in
 * them, not even to know what they are. A session with no id yet is left
 * out: the id is how the agent names one. After the rows, the sessions the
 * caller started that are no longer open, from this run or an earlier one,
 * which a start with the session named brings back.
 */
function sessionLines(request: ConductRequest): string {
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
async function startSession(request: ConductRequest): Promise<Answered> {
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
  // An account is one the user named in the settings, or the project's.
  const wanted = text(request, "account");
  if (wanted !== null && !(wanted in accounts.list))
    return refused(
      names().length === 0
        ? "There are no accounts in the workbench's settings; leave the account out."
        : `There is no account called ${wanted}. The accounts are ${names().join(", ")}.`,
    );
  const account = wanted ?? accountOf(project);
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
      "A session you start for a step of your workflow runs on the model the step allows, so its prompt is words, not a command: the workbench starts none with a prompt that begins with a slash.",
    );
  const fit =
    flow.workflow === null ? null : fitStart(request, flow.workflow, caller);
  if (fit !== null && "refusal" in fit) return refused(fit.refusal);
  let started = false;
  try {
    const answer = await startFitted(request, project, prompt, name, account, caller, fit);
    started = answer.error === null;
    return answer;
  } finally {
    fit?.release(started);
  }
}

/** The rest of a start, once it has been held to the caller's workflow. */
async function startFitted(
  request: ConductRequest,
  project: string,
  prompt: string,
  name: string | null,
  account: string | null,
  caller: string,
  fit: Fit | null,
): Promise<Answered> {
  const wants = flag(request, "worktree");
  const beyond = fit?.beyond ?? null;
  if ((await askUser(request, project, prompt, wants, beyond)) === "no")
    return refused(
      beyond === null
        ? "The user did not allow the session to be started."
        : notAllowed(beyond),
    );

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
  const agent = fit?.agent ?? agentOf(request, project);
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
  // The name the caller gave is the row's, until the agent names it.
  if (name !== null) session.title = oneLine(name);
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
    name: name === null ? null : oneLine(name),
    account,
  });
  const where = startIn === null ? project : `${project}, in ${startIn}`;
  if (fit === null)
    return said(
      `Started session ${id} in ${where}. It has the prompt. Call wait to hear how it goes.`,
    );
  // A work session that began a piece is the piece's name from here.
  const at: Place = { ...fit.place, piece: fit.place.piece ?? id };
  conductor.places[session.key] = at;
  place(caller, id, at);
  return said(
    `Started session ${id} for ${placeText(at)} in ${where}. It has the prompt. Call wait to hear how it goes.`,
  );
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
  request: ConductRequest,
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
    beyond: pastLimit(step, from, done),
    hold: () => {},
    release: (started) => {
      if (!started) uncountRound(caller, step.name, piece);
    },
  };
}

/** A round past the most a review gives a piece: one more than the first
    and a round for every time it may send the work back. Null within it. */
function pastLimit(step: ReviewStep, work: string, done: number): Beyond | null {
  return done > step.limit
    ? { step: step.name, work, done, limit: step.limit }
    : null;
}

/** What a caller is told when the user did not allow a round past the
    limit. */
function notAllowed(beyond: Beyond): string {
  return `The work of session ${beyond.work} has had ${beyond.done} rounds of ${quoted(beyond.step)}, as many as the workflow gives a piece, and the user did not allow another. Ask the user how to go on.`;
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

/** The live rows an agent that was not told its id may be calling from:
    the ones running where the call came from. */
function untoldHere(cwd: string): Session[] {
  return sessions.all.filter(
    (session) =>
      isLive(session) &&
      !session.told &&
      (session.startIn ?? session.project) === cwd,
  );
}

/** What a caller is told when the workbench cannot tell which of several
    sessions in its directory it is, and one of them follows a workflow. */
export const UNPLACED =
  "Several sessions run in this directory, one of them under a workflow, and the workbench cannot tell which is calling, so it cannot hold this call to a workflow. Start sessions from a session in a directory of its own, such as a worktree.";

/** The workflow the caller follows, null for none, or why the call cannot
    be held to one: a caller that is one of several in its directory, where
    one of them follows a workflow, is refused rather than let through
    unchecked. */
function callerFlow(
  request: ConductRequest,
): { workflow: Workflow | null } | { refusal: string } {
  if (request.session !== null)
    return { workflow: byId(request.session)?.workflow ?? null };
  const here = untoldHere(request.cwd);
  if (here.length === 1) return { workflow: here[0].workflow };
  if (here.some((session) => session.workflow !== null))
    return { refusal: UNPLACED };
  return { workflow: null };
}

/** Why a caller may not start another session right now, when it may not:
    it has as many running as one may, or it was itself started by one. */
function roomFor(request: ConductRequest): Answered | null {
  if (startedBy(callerOf(request)).filter(isLive).length >= CAP)
    return refused(
      `You have ${CAP} sessions running already, which is as many as one session may have. Stop one before starting another.`,
    );
  if (startedFor(callerKey(request)) !== null)
    return refused(
      "A session that another session started cannot start sessions of its own.",
    );
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
  request: ConductRequest,
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
      : flow.workflow?.steps.find((candidate) => candidate.name === at.step);
  let model = text(request, "model");
  let goesOn = at;
  let release: (started: boolean) => void = () => {};
  let hold = () => {};
  let beyond: Beyond | null = null;
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
      beyond = pastLimit(step, at.work ?? piece, done);
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
      (await askUser(request, project, prompt ?? "", false, beyond)) === "no"
    )
      return refused(notAllowed(beyond));
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

async function sendText(request: ConductRequest): Promise<Answered> {
  const id = text(request, "session");
  const line = text(request, "text");
  if (id === null) return refused("Sending needs a session to send to.");
  if (line === null) return refused("Sending needs the text to send.");
  const session = byId(id);
  if (session === null) return refused(`The workbench has no session ${id}.`);
  if (!mine(request, session)) return notMine(id);
  if (session.status !== "running" || session.ptyId === null)
    return refused(`Session ${id} is not running.`);
  const typed = oneLine(line);
  const at = placeOf(session.key);
  // A session started for a step stays on the model the step gave it.
  if (at !== null && mayChangeModel(typed))
    return refused(keepsItsModel(id, at));
  const flow = callerFlow(request);
  if ("refusal" in flow) return refused(flow.refusal);
  // A line to a review that has finished its round asks it for another
  // look, which is another round of the piece.
  let round: Place | null = null;
  if (at !== null && at.kind === "review" && at.piece !== null && finished(session)) {
    const caller = callerOf(request);
    const review = flow.workflow?.steps.find(
      (candidate) => candidate.name === at.step,
    );
    if (review?.kind === "review") {
      const done = roundsOf(caller, review.name, at.piece);
      const beyond = pastLimit(review, at.work ?? at.piece, done);
      if (
        beyond !== null &&
        (await askUser(request, session.project, typed, false, beyond)) === "no"
      )
        return refused(notAllowed(beyond));
      if (session.status !== "running" || session.ptyId === null)
        return refused(`Session ${id} is not running.`);
      countRound(caller, review.name, at.piece);
      round = { ...at, round: done + 1 };
      conductor.places[session.key] = round;
      if (session.id !== null) place(caller, session.id, round);
      // The round is counted once, however many lines go before it works.
      const mark = stops.get(session.key);
      if (mark !== undefined) mark.worked = false;
    }
  }
  await typeLine(session.ptyId!, typed);
  return said(
    round === null
      ? `Sent to session ${id}. Call wait to hear what it does next.`
      : `Sent to session ${id}, for ${placeText(round)}. Call wait to hear what it does next.`,
  );
}

/** Whether a line may change the model an agent runs on. Any command an
    agent takes after a slash might, /model, /fast and /config among them,
    and either agent completes a command from the start of its name, so
    every one may except /compact, which only shortens the conversation. */
export function mayChangeModel(line: string): boolean {
  const typed = line.trim();
  return typed.startsWith("/") && !/^\/compact(\s|$)/i.test(typed);
}

/** What a caller is told when a line or a prompt for a session placed in
    its workflow could change the session's model. */
function keepsItsModel(id: string, at: Place): string {
  return `Session ${id} runs ${placeText(at)} of your workflow, on a model the step allows, and stays on it: the workbench gives it no command but /compact. Say what you want in words instead.`;
}

/** Whether a session has worked and come to rest since it was last sent a
    line or started. */
function finished(session: Session): boolean {
  observe(session);
  const mark = stops.get(session.key);
  return mark !== undefined && mark.worked && mark.rest === "quiet";
}

function stopSession(request: ConductRequest): Answered {
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
async function waitFor(request: ConductRequest): Promise<Answered> {
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

  // The calling session's row, if this window has one: a wait held for a
  // session that is no longer running has no one to hear it.
  const caller = request.session === null ? null : byId(request.session);
  const callerAt = caller?.key ?? null;
  let reported: string | null = null;
  let abandoned = false;
  let ending: (() => void) | null = null;
  waiting.set(request.id, () => {
    abandoned = true;
    ending?.();
  });
  const happened = await settles<string | null>(
    (settle) => {
      ending = () => settle(null);
      if (abandoned) {
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
        const resting = !isLive(session)
          ? `Session ${name} ${stateOf(session)}. ${lastLine(session)}`
          : session.needs === "permission"
            ? `Session ${name} is asking for permission. ${lastLine(session)}`
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
          settle(`Session ${name} stopped working. ${lastLine(session)}`);
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
function readSession(request: ConductRequest): Answered {
  const id = text(request, "session");
  if (id === null) return refused("Reading needs a session to read.");
  const session = byId(id);
  if (session === null) return refused(`The workbench has no session ${id}.`);
  if (!mine(request, session)) return notMine(id);
  const lines = number(request, "lines", LINES, LINES_MAX);
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

/** What a session last left for its row. */
function lastLine(session: Session): string {
  return session.note === null
    ? "It has left no line."
    : `Its last line: ${session.note}`;
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
function mine(request: ConductRequest, session: Session): boolean {
  return startedFor(session.key) === callerOf(request);
}

/** What a caller is told about a session that is not its own. */
function notMine(id: string): Answered {
  return refused(
    `Session ${id} was not started by you. Sending, stopping, reading and waiting are for the sessions you started; this one is the user's own.`,
  );
}

/** Who is calling: the session it runs as, else the directory it runs in. */
function callerOf(request: ConductRequest): string {
  return request.session ?? request.cwd;
}

/** The calling session's row key, when the call names a session this
    window has. */
function callerKey(request: ConductRequest): string | null {
  if (request.session === null) return null;
  return byId(request.session)?.key ?? null;
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
 * standing answer for the project. A question that arrives while another
 * is up waits behind it.
 */
function askUser(
  request: ConductRequest,
  project: string,
  prompt: string,
  worktree: boolean,
  round: Beyond | null = null,
): Promise<Choice> {
  const caller = callerOf(request);
  if (round === null && allowed.has(`${caller}\n${project}`))
    return Promise.resolve("allow");
  const session = request.session === null ? null : byId(request.session);
  const ask: Ask = {
    request,
    caller: session === null ? "A session" : label(session),
    project,
    prompt: prompt.split("\n")[0],
    worktree,
    round,
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
  if (ask !== null && choice === "allow" && ask.round === null)
    allowed.add(`${callerOf(ask.request)}\n${ask.project}`);
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
  const prefix = `${callerId}\n`;
  return [...allowed]
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length));
}

/** Takes a standing answer back: the caller's next start in that project is
    put to the user again. */
export function revoke(callerId: string, project: string) {
  allowed.delete(`${callerId}\n${project}`);
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
  pending = null;
  queue.length = 0;
  allowed.clear();
  seen.clear();
  stops.clear();
  reserved.clear();
  waiting.clear();
  given.clear();
}
