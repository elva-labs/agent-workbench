import {
  core,
  isHeld,
  type AgentId,
  type SessionEnded,
  type SessionEvent,
  type PastSessions,
  type Settings,
  type Transcript,
  type Workflow,
} from "$lib/core";
import { SvelteSet } from "svelte/reactivity";
import { accountOf, dirFor, names } from "$lib/accounts.svelte";
import { CODEX_DEFAULT } from "$lib/models";
import { orchestratorPrompt } from "$lib/workflowInstructions";
import {
  readWorkflow,
  startsOnly,
  workflowNamed,
  workflowOf,
  workflowsKnown,
} from "$lib/workflows.svelte";
import { persist } from "$lib/persist";
import { identifiedZoom } from "$lib/zoom.svelte";
import { AGENTS, agentLabel, agentProfile, installed } from "$lib/agent.svelte";
import { attention } from "$lib/attention.svelte";
import { hostOf } from "$lib/remote.svelte";
import { closeOwner } from "$lib/browser.svelte";
import { handOver, sessionClosed as closeShells } from "$lib/terminals.svelte";
import { isReady } from "$lib/agent.svelte";
import { claim, resetExits } from "$lib/exits";
import { canIntegrate, kindFor, type SessionKind } from "$lib/sessionKind.svelte";
import { isInstalled } from "$lib/hook.svelte";
import { holdMode, modeOf, terminalEnded } from "$lib/sessionModes";
import { chosenFor, modelToStart, narrowTo } from "$lib/lastChosen.svelte";
import { carriedOver } from "$lib/modeFit";
import { starterOf } from "$lib/senders.svelte";
import { bareName, mixesScripts, readsAsWorkbench, reservedName, shown } from "$lib/unseen";
import { failureOf, interruptedOnScreen, type Failure } from "$lib/turnFailure";
import { screen } from "$lib/screens";

/**
 * Every session this window has, live or finished.
 *
 * A project can hold several, and switching between them kills nothing: each
 * keeps its own PTY, its own terminal and its own scrollback, and the ones you
 * are not looking at are hidden rather than unmounted. Hiding costs nothing,
 * so a background session never gets resized and never reflows.
 *
 * The Rust side needed no change for this. `Sessions` there has always been a
 * map with a reader and a waiter thread each; it was the frontend that assumed
 * there could only ever be one.
 */

/** `dormant` is a session that was open when the app last quit, back as a
    row with nothing running behind it until it is woken. */
export type SessionStatus =
  "dormant" | "starting" | "running" | "exited" | "crashed" | "failed";

export interface Session {
  /** Stable for the lifetime of the row, unlike the pty id which only exists
      once the process is actually up. */
  key: string;
  /** What the session's tools name it by: chosen by the window, given to
      the agent's environment when it starts, and the same for a session
      resumed. Every call its tools make carries it, so the window knows
      which session called. Not a secret: an identifier. Never the agent's
      id, but for a run from before there were tokens that the window took
      up after a reload, until it stops. */
  token: string;
  /** The project this session belongs to, as an absolute path. */
  project: string;
  /** Which agent is running in it. */
  agent: AgentId;
  /** How it runs: the agent's own interface in a pty, or integrated, the
      conversation drawn by the window. */
  kind: SessionKind;
  /** It runs its own way, whatever its agent's setting says: the user
      started it the other way, or reopened it the other way from its menu.
      Otherwise it follows the setting, and moves when that is switched. */
  ownWay: boolean;
  ptyId: string | null;
  status: SessionStatus;
  /** The Claude Code session id. Known from the start when resuming, and from
      the moment the process is up otherwise: the workbench hands the agent
      the id rather than discovering it afterwards. */
  id: string | null;
  /** A Claude Code session id, when this one was resumed from a transcript. */
  resumedFrom: string | null;
  /** Position among the project's sessions at creation. Stable, unlike the
      index in a list that closing another row would renumber. */
  ordinal: number;
  /** What the agent calls the session, from the terminal title it sets.
      Null until it says, and when what it says is just its own name. */
  title: string | null;
  /** The title is a name the user gave the session through its agent's
      rename command, which a title the agent chooses later does not
      replace. */
  ownTitle: boolean;
  /** The directory the process was last seen working in. */
  cwd: string | null;
  /** Where the agent was started when that is not the project: the
      worktree a resumed session belongs to. */
  startIn: string | null;
  /** The first prompt, when the session was started with one: another
      session's, given to the agent on its command line. */
  prompt: string | null;
  /** The model the session was started on, when one was chosen for it:
      given to the agent on its command line, so it holds from the first
      turn. Null for the agent's own default. */
  model: string | null;
  /** The account the session runs under, by name: the project's unless
      one was chosen for the session, or the session that started it
      handed its own on. Null for the agents' own directories. */
  account: string | null;
  /** The workflow the session follows, as it was when this run of it
      started: it directs the others by it. Null for none. A change to the
      settings does not reach a session while it runs; a resumed one takes
      the workflow's version of the day. */
  workflow: Workflow | null;
  /** Whether the workflow it follows was deleted since, so it follows the
      copy it kept. */
  workflowGone: boolean;
  /** The name of a workflow a resumed session followed that is gone, and
      whose kept copy no longer reads: the user says whether it goes on
      without one. Null otherwise. */
  workflowLost: string | null;
  /** What the user is told of a Codex session resumed under other
      instructions than it began with: Codex keeps what a thread began
      with, so neither the instructions nor its own subagent tools are what
      the workflow says now. Said over the session until put away. Null
      otherwise. */
  keptFromStart: string | null;
  /** The repository root of `cwd`: the worktree the session is in, which
      is the project's own unless the agent has moved. */
  worktree: string | null;
  /** Whether the agent is doing something right now, read off the pty:
      output is flowing while it works, and the screen is still when it
      waits. */
  working: boolean;
  /** Whether output can mean work yet: the agent has been sent a line, on
      its command line or typed, or it has been up long enough to have
      finished starting. Until then what it draws is its own start-up,
      spinners included. */
  engaged: boolean;
  /** When the process came up, for the start-up allowance. */
  startedAt: number | null;
  /** The agent stopped, or asked for attention, while nobody was looking.
      Cleared by looking. */
  unread: boolean;
  /** A line the agent left for the row, through its notify tool. Cleared
      by looking. */
  note: string | null;
  /** The line the row last showed under its name when it went unread,
      kept after looking clears it, so a session the user marks unread
      shows it again. Cleared with the line when a new turn begins. */
  notice: string | null;
  /** The agent's own hooks are reporting this session, so its transitions
      are exact and the pty heuristic stands down. */
  exact: boolean;
  /** What the agent is blocked on, when its hooks say so. */
  needs: "permission" | null;
  /** The agent ended its turn with subagents of its own still running,
      whose report starts its next one: working, with a still screen. */
  delegated: boolean;
  /** How the agent's last turn ended, where its hooks or its events say:
      done, as the agent itself ended it, cut short by the user, or failed
      on an error, a usage limit among them. Null while a turn runs, before
      the first, and where nothing says, as for a terminal session without
      hooks. */
  turnEnd: "done" | "cut" | "failed" | null;
  /** What ended the last turn when it failed. Null otherwise. */
  failure: Failure | null;
  /** The tasks the agent left running in the background when it ended
      its last turn, by its own description of each: when one finishes,
      the agent takes it up in a turn of its own. */
  background: string[];
  /** The permission mode the workbench started this run in, by the agent's
      name for it: one kept for the conversation it resumes, or the one its
      starter gave it. Null where it named none and the agent chose one
      from its own settings. */
  modeNamed: string | null;
  /** For a session another started, the permission mode its starter gave
      it, which a new run of it starts in: its starter's own as far as its
      agent has it, never a wider one. Null where the starter's mode is not
      known, and for a session the user started. */
  modeGiven: string | null;
  /** For a terminal run, the permission mode its hooks last said it runs
      in. Null until they say, and for an agent whose hooks do not, as
      Codex's do not. */
  modeSeen: string | null;
  /** What this run was started on from the choices the user last made
      for its agent, each null where it named none of them. Null for a run
      that took none: one resumed, or one another session started. */
  carried: Carried | null;
  /** How many turns the agent has begun in this run, as its hooks or its
      events say, or, without them, as its output does. */
  turns: number;
  /** When the row last changed what it says: started working, went quiet,
      asked, was looked at, ended. The palette and the chord to the next
      session that needs you order by it. */
  changedAt: number;
  exitCode: number | null;
  error: string | null;
  /** Set once the terminal has been created, so it is only built once. */
  mounted: boolean;
}

/** What a run takes from the choices the user last made for its agent. */
export interface Carried {
  model: string | null;
  effort: string | null;
  mode: string | null;
}

/**
 * What a new session the user started takes from the choices kept for its
 * agent: the mode and the effort, and the model where the row was made on
 * the kept one. A resumed session goes on as its conversation did, and a
 * session another started begins as its starter says; neither takes any.
 */
export function carriedFor(session: Session): Carried | null {
  if (session.resumedFrom !== null || session.prompt !== null || session.modeGiven !== null) return null;
  if (starterOf(session.key) !== null) return null;
  const kept = chosenFor(session.agent);
  return {
    model: session.workflow === null && session.model !== null && session.model === kept.model ? session.model : null,
    effort: kept.effort ?? null,
    // Checked again here: a mode a new session is not begun in starts
    // nothing, wherever it came from.
    mode: kept.mode !== undefined && carriedOver(session.agent, kept.mode) ? kept.mode : null,
  };
}

const MINE_KEY = "workbench.mine";
const NAMES_KEY = "workbench.names";
const TOKENS_KEY = "workbench.tokens";
const PREFERRED_KEY = "workbench.agents";
const WORKFLOWS_KEY = "workbench.workflows";
const WAITING_KEY = "workbench.waiting";
/** The record of the rows open at the last quit, whose flag says the
    version that last wrote it kept what waits on the user too. */
const OPEN_KEY = "workbench.open";

/** What an unread row is brought back with after a restart or a reload,
    by its session's id: that it waits on the user, the line under its
    name, the line it last showed, when it last changed, a mark the user
    made on it, and when the record last saw the row. A row that is read
    has no record, and none of its lines is kept. */
export interface KeptWaiting {
  unread: boolean;
  note: string | null;
  notice: string | null;
  at: number;
  mark?: { restored: string | null; heard: boolean };
  /** When a run last had the row. A record from before there was one
      reads as seen now. */
  seen?: number;
}

/** How many records are kept, the latest last. */
const WAITING_KEPT = 200;

/** How long a record waits for its row to come back: a project that does
    not open again, or a session another started whose starter is not
    resumed, takes its rows' records with it after this. */
export const WAITING_FOR = 7 * 24 * 60 * 60 * 1000;

/** What is kept of the workflow a session follows: the workflow as its
    last run started on it, as it was written, since it may no longer read,
    or null for none by the user's word, given when the one it followed was
    lost;
    the instructions its conversation was first given, which an agent that
    records them keeps until told otherwise; and the project, so what is
    kept goes once the session is gone from it. */
export interface KeptWorkflow {
  workflow: unknown;
  told: string | null;
  project: string | null;
}

/** A session's token as it is kept, and its project, so it goes once the
    session is gone from the project's history. */
export interface KeptToken {
  token: string;
  project: string;
}

/** A past session, whose it is, and the account it ran under: the name
    of the account whose directory holds it, or null for the agents' own.
    It resumes under that account. */
export type HistoryEntry = Transcript & {
  agent: AgentId;
  account: string | null;
};

export const sessions = $state({
  all: [] as Session[],
  active: null as string | null,
  /**
   * Sessions already on disk, by project path, from every agent's own index
   * of them: history rather than anything the window owns.
   */
  history: {} as Record<string, HistoryEntry[]>,
  /** The agent last started in each project: what the choice for a new
      session offers first. */
  preferred: {} as Record<string, AgentId>,
  /**
   * Session ids this app has run, by project path. Claude Code keeps every
   * transcript for a directory in one place, whichever terminal it came from;
   * these are the ones that are ours to list first.
   */
  mine: {} as Record<string, string[]>,
  /**
   * What the agent called each session, by session id, kept so a past
   * session is listed under the name you knew it by rather than by a title
   * read out of the transcript, or by when it last moved.
   */
  names: {} as Record<string, string>,
  /** The token each session's tools name it by, with the project it runs
      in, by the agent's id for the session, kept between runs, so a session
      resumed is named as it was and still owns what was kept under its
      token. Never the id itself. */
  tokens: {} as Record<string, KeptToken>,
  /** What is kept of the workflow each session follows, by session id. A
      session that follows none is not here. */
  workflows: {} as Record<string, KeptWorkflow>,
  /** How long a past session stays listed under its project. Older than
      that, it goes behind the fold with the rest of the history, where it
      is still there to resume and to search. */
  pastSessions: "forever" as PastSessions,
});

/** The spans a past session may stay listed for, in the order they are
    offered, with the seconds each stands for. Forever has no limit. */
export const PAST_SESSIONS: {
  choice: PastSessions;
  label: string;
  seconds: number | null;
}[] = [
  { choice: "forever", label: "Forever", seconds: null },
  { choice: "month", label: "30 days", seconds: 30 * 24 * 60 * 60 },
  { choice: "week", label: "7 days", seconds: 7 * 24 * 60 * 60 },
  { choice: "day", label: "1 day", seconds: 24 * 60 * 60 },
];

function isPastSessions(value: unknown): value is PastSessions {
  return PAST_SESSIONS.some((span) => span.choice === value);
}

/** The past sessions' part of the settings. */
export function pastSessionsSettings(): Pick<Settings, "pastSessions"> {
  return { pastSessions: sessions.pastSessions };
}

/** Takes the core's word for how long past sessions stay listed. A value
    it does not know is forever, which lists everything as before. */
export function adoptPastSessions(value: unknown) {
  sessions.pastSessions = isPastSessions(value) ? value : "forever";
  pruneDormant();
}

export function setPastSessions(value: PastSessions) {
  if (sessions.pastSessions === value) return;
  sessions.pastSessions = value;
  persist({ pastSessions: value });
  pruneDormant();
}

/** Whether a transcript has gone unchanged for longer than past sessions
    stay listed. */
export function aged(transcript: { modified: number }): boolean {
  const limit = PAST_SESSIONS.find(
    (span) => span.choice === sessions.pastSessions,
  )?.seconds;
  if (limit === null || limit === undefined) return false;
  return Date.now() / 1000 - transcript.modified > limit;
}

/** A row left from the last quit, with nothing running behind it, is a
    past session that happens to be drawn as a row. One whose transcript has
    aged past the limit goes behind the fold like the rest; the row goes,
    and nothing is stopped, since nothing was running. */
function pruneDormant(project: string | null = null) {
  for (const session of [...sessions.all]) {
    if (session.status !== "dormant" || session.id === null) continue;
    if (project !== null && session.project !== project) continue;
    const transcript = (sessions.history[session.project] ?? []).find(
      (entry) => entry.id === session.id,
    );
    if (transcript !== undefined && aged(transcript)) close(session.key);
  }
}

/** The directories a project's history is read from: every account's,
    for each agent, the agents' own included. An account that leaves an
    agent on its own directory is that directory, read once as the agents'
    own. */
function historySources(): {
  agent: AgentId;
  account: string | null;
  dir?: string;
}[] {
  const sources: { agent: AgentId; account: string | null; dir?: string }[] =
    [];
  for (const agent of AGENTS) {
    sources.push({ agent, account: null });
    for (const account of names()) {
      const dir = dirFor(account, agent);
      if (dir !== undefined) sources.push({ agent, account, dir });
    }
  }
  return sources;
}

/** The projects split by the machine they are on, in the order given: null
    for this one, the `user@host` for the rest. */
export function groupByHost(projects: string[]): Map<string | null, string[]> {
  const groups = new Map<string | null, string[]>();
  for (const project of projects) {
    const host = hostOf(project);
    const group = groups.get(host);
    if (group === undefined) groups.set(host, [project]);
    else group.push(project);
  }
  return groups;
}

/** The latest reading started for each project. An answer is put in only
    while no later reading of that project has started. */
const readings = new Map<string, number>();
let readingCount = 0;

/** Reads the past sessions of the projects from every account's directory,
    so a session run under any account is listed under its project. Each
    directory is asked for once per machine, for all the projects on it, and
    each machine's answer is put in as it arrives, so a machine that is slow
    holds back only its own projects. */
export async function loadHistories(projects: string[]) {
  if (projects.length === 0) return;
  const sources = historySources();
  const signature = JSON.stringify(sources);
  const ticket = ++readingCount;
  for (const project of projects) readings.set(project, ticket);
  await Promise.all(
    [...groupByHost(projects).values()].map(async (group) => {
      const lists = await Promise.all(
        sources.map(async ({ agent, account, dir }) => {
          try {
            const lists = await core().transcriptsMany(group, agent, dir);
            return group.map((_, at) =>
              (lists[at] ?? []).map((transcript) => ({
                ...transcript,
                agent,
                account,
              })),
            );
          } catch {
            // No history is a shorter list, never an error.
            return null;
          }
        }),
      );
      // A source that could not be read may hold sessions the others do
      // not list, so nothing kept is let go of on this reading.
      const whole = lists.every((source) => source !== null);
      group.forEach((project, at) => {
        if (readings.get(project) !== ticket) return;
        // Listed once per id, as the newest: a session resumed from another
        // directory can be reported from more than one place.
        const newest = new Map<string, HistoryEntry>();
        const entries = lists.flatMap((source) => source?.[at] ?? []);
        for (const entry of entries.sort((a, b) => b.modified - a.modified)) {
          if (!newest.has(entry.id)) newest.set(entry.id, entry);
        }
        const next = [...newest.values()];
        // A reading that found nothing new leaves the list as it is, so
        // nothing that shows it is drawn again.
        if (!sameHistory(sessions.history[project], next))
          sessions.history[project] = next;
        readFrom.set(project, signature);
        pruneDormant(project);
        if (whole) pruneKept(project);
      });
    }),
  );
}

/** The directories each project's history was last read from, and is being
    read from now. */
const readFrom = new Map<string, string>();
const loading = new Map<string, string>();

/** Reads the past sessions of the projects whose history has not been read
    from the directories there are now, leaving out those being read from
    them. An account that arrives after a project was read reads it again. */
export function loadMissingHistories(projects: string[]) {
  const sources = JSON.stringify(historySources());
  const wanted = projects.filter(
    (project) =>
      (sessions.history[project] === undefined ||
        readFrom.get(project) !== sources) &&
      loading.get(project) !== sources,
  );
  wanted.forEach((project) => loading.set(project, sources));
  return loadHistories(wanted).finally(() =>
    wanted.forEach((project) => {
      if (loading.get(project) === sources) loading.delete(project);
    }),
  );
}

/** Reads one project's past sessions. */
export function loadHistory(project: string) {
  return loadHistories([project]);
}

function sameHistory(a: HistoryEntry[] | undefined, b: HistoryEntry[]) {
  if (a === undefined || a.length !== b.length) return false;
  return a.every((entry, at) => {
    const other = b[at];
    return (
      entry.id === other.id &&
      entry.agent === other.agent &&
      entry.account === other.account &&
      entry.modified === other.modified &&
      entry.size === other.size &&
      entry.title === other.title &&
      entry.cwd === other.cwd
    );
  });
}

/** How often a project's history is read again while the window is
    looked at. A session run in a terminal outside the app, or one that
    ended there, shows up on the next reading. */
export const HISTORY_EVERY = 60_000;

/** The projects whose history is kept fresh, set by `followHistory`. */
let watched: () => string[] = () => [];

/** The clock that reads the watched histories again, while one runs. */
let historyClock: ReturnType<typeof setInterval> | null = null;

/** The readings under way by machine. */
const refreshing = new Map<string | null, Promise<void>>();

/** Reads the history of the watched projects again, one reading per machine.
    A reading still under way for a machine is the one that serves its
    projects, so a window that gains and loses focus quickly does not queue
    them up, and a machine that does not answer never holds up the others. */
export function refreshHistory() {
  const started: Promise<void>[] = [];
  for (const [host, group] of groupByHost(watched())) {
    let reading = refreshing.get(host);
    if (reading === undefined) {
      reading = loadHistories(group).finally(() => {
        refreshing.delete(host);
      });
      refreshing.set(host, reading);
    }
    started.push(reading);
  }
  return Promise.all(started).then(() => {});
}

/** Keeps the histories of the projects `projects` names fresh: read again
    on a clock while the window is looked at, and each time it comes back
    into view. Returns a stop function. */
export function followHistory(projects: () => string[]): () => void {
  stopHistoryClock();
  watched = projects;
  const timer = setInterval(() => {
    if (attention.focused) void refreshHistory();
  }, HISTORY_EVERY);
  historyClock = timer;
  return () => {
    if (historyClock !== timer) return;
    stopHistoryClock();
    watched = () => [];
  };
}

function stopHistoryClock() {
  if (historyClock !== null) clearInterval(historyClock);
  historyClock = null;
}

/** The agent a new session in the project starts with: the one last started
    there, else the first one installed. */
export function defaultAgent(project: string): AgentId {
  const preferred = sessions.preferred[project];
  if (preferred !== undefined && installed().includes(preferred))
    return preferred;
  return installed()[0] ?? "claude-code";
}

/** How New session in the project runs: the way the setting of the agent
    it starts says, the workflow's orchestrator's under the project's
    workflow. */
export function newSessionKind(project: string): SessionKind {
  const workflow = workflowOf(project);
  return kindFor(workflow !== null ? workflow.orchestrator.agent : defaultAgent(project));
}

/** The other way to start one session in the project, for the agent New
    session starts with: integrated where New session runs in a terminal,
    a terminal where it runs integrated. Null for an agent that runs only
    one way. Started this way it runs alone, whatever the project follows. */
export function otherWay(project: string): SessionKind | null {
  if (!canIntegrate(defaultAgent(project))) return null;
  return newSessionKind(project) === "integrated" ? "terminal" : "integrated";
}

function prefer(project: string, agent: AgentId) {
  if (sessions.preferred[project] === agent) return;
  sessions.preferred[project] = agent;
  try {
    localStorage.setItem(PREFERRED_KEY, JSON.stringify(sessions.preferred));
  } catch {
    // Non-fatal: the choice does not survive a restart.
  }
}

export function isMine(project: string, id: string): boolean {
  return (sessions.mine[project] ?? []).includes(id);
}

/** Records a session as ours. Resuming one from outside counts: from then on
    it is a session of this workbench. */
export function adopt(project: string, id: string) {
  if (isMine(project, id)) return;
  sessions.mine[project] = [...(sessions.mine[project] ?? []), id];
  try {
    localStorage.setItem(MINE_KEY, JSON.stringify(sessions.mine));
  } catch {
    // Non-fatal: the split into ours and outside does not survive a restart.
  }
}

/** What is remembered between runs: which sessions are ours, and what they
    were called. A corrupt entry is not worth a broken pane: it reads as
    nothing remembered. */
export function loadRemembered() {
  try {
    const raw = localStorage.getItem(MINE_KEY);
    if (raw !== null) {
      const stored: unknown = JSON.parse(raw);
      if (typeof stored === "object" && stored !== null) {
        const mine: Record<string, string[]> = {};
        for (const [project, ids] of Object.entries(stored)) {
          if (Array.isArray(ids)) {
            mine[project] = ids.filter(
              (id): id is string => typeof id === "string",
            );
          }
        }
        sessions.mine = mine;
      }
    }
  } catch {
    // Nothing is ours, then.
  }
  try {
    const raw = localStorage.getItem(NAMES_KEY);
    if (raw !== null) {
      const stored: unknown = JSON.parse(raw);
      if (typeof stored === "object" && stored !== null) {
        const names: Record<string, string> = {};
        for (const [id, name] of Object.entries(stored)) {
          if (typeof name === "string") names[id] = name;
        }
        sessions.names = names;
      }
    }
  } catch {
    // Nothing is named, then.
  }
  loadWaiting();
  try {
    const raw = localStorage.getItem(TOKENS_KEY);
    if (raw !== null) {
      const stored: unknown = JSON.parse(raw);
      if (typeof stored === "object" && stored !== null) {
        const tokens: Record<string, KeptToken> = {};
        for (const [id, kept] of Object.entries(stored)) {
          if (typeof kept !== "object" || kept === null) continue;
          const { token, project } = kept as Record<string, unknown>;
          if (typeof token === "string" && token !== "" && typeof project === "string")
            tokens[id] = { token, project };
        }
        sessions.tokens = tokens;
      }
    }
  } catch {
    // No token is kept, then: a session resumed is given a new one.
  }
  try {
    const raw = localStorage.getItem(WORKFLOWS_KEY);
    if (raw !== null) {
      const stored: unknown = JSON.parse(raw);
      if (typeof stored === "object" && stored !== null) {
        const kept: Record<string, KeptWorkflow> = {};
        for (const [id, entry] of Object.entries(stored)) {
          if (typeof entry !== "object" || entry === null) continue;
          const { workflow, told, project } = entry as Record<string, unknown>;
          // A record of the workflow alone is the workflow, first told as
          // it reads.
          kept[id] =
            "workflow" in entry
              ? {
                  workflow,
                  told: typeof told === "string" ? told : null,
                  project: typeof project === "string" ? project : null,
                }
              : { workflow: entry, told: null, project: null };
        }
        sessions.workflows = kept;
      }
    }
  } catch {
    // No session follows a workflow, then.
  }
  try {
    const raw = localStorage.getItem(PREFERRED_KEY);
    if (raw !== null) {
      const stored: unknown = JSON.parse(raw);
      if (typeof stored === "object" && stored !== null) {
        const preferred: Record<string, AgentId> = {};
        for (const [project, agent] of Object.entries(stored)) {
          if (agent === "claude-code" || agent === "codex")
            preferred[project] = agent;
        }
        sessions.preferred = preferred;
      }
    }
  } catch {
    // No preference, then.
  }
}

/** A workflow as it was kept, or null when it no longer reads. */
export function storedWorkflow(value: unknown): Workflow | null {
  if (value === null || value === undefined) return null;
  try {
    return readWorkflow(value);
  } catch {
    return null;
  }
}

/** Keeps the workflow a session follows by its id, now that it has one:
    the version this run started on, and the instructions the conversation
    was first given, which stay those of its first run. */
export function rememberWorkflow(session: Session) {
  if (session.id === null || session.workflow === null) return;
  const before = sessions.workflows[session.id];
  const workflow = $state.snapshot(session.workflow) as Workflow;
  sessions.workflows[session.id] = {
    workflow,
    told: before === undefined ? orchestratorPrompt(workflow) : firstTold(before),
    project: session.project,
  };
  saveKept();
}

function saveKept() {
  try {
    localStorage.setItem(WORKFLOWS_KEY, JSON.stringify(sessions.workflows));
  } catch {
    // Non-fatal: a resumed session follows no workflow.
  }
}

/** The instructions a session's conversation was first given. A record
    that does not say is taken to be its kept workflow's. */
function firstTold(kept: KeptWorkflow): string | null {
  if (kept.told !== null) return kept.told;
  const read = storedWorkflow(kept.workflow);
  return read === null ? null : orchestratorPrompt(read);
}

/** The workflow a session with this id followed, as it was kept, when it
    still reads. */
export function workflowFor(id: string): Workflow | null {
  const kept = sessions.workflows[id];
  return kept === undefined ? null : storedWorkflow(kept.workflow);
}

/** What a session resumed by its id follows. */
export type Resumed =
  /** A workflow, or none. `gone` when it is the copy the session kept of
      a workflow deleted since. */
  | { workflow: Workflow | null; gone: boolean }
  /** The workflow it followed is gone and its kept copy no longer reads:
      the user is asked. */
  | { lost: string };

/**
 * What a resumed session follows: the workflow it followed, as the settings
 * have it now, by name; the copy it kept, when that workflow was deleted;
 * and when the copy no longer reads either, a question for the user rather
 * than no workflow.
 */
export function resumedWorkflow(id: string): Resumed {
  const kept = sessions.workflows[id];
  if (kept === undefined || kept.workflow === null) return { workflow: null, gone: false };
  const raw = kept.workflow;
  const name =
    typeof raw === "object" && raw !== null && typeof (raw as { name?: unknown }).name === "string"
      ? (raw as { name: string }).name
      : null;
  const current = name === null ? undefined : workflowNamed(name);
  if (current !== undefined) return { workflow: current, gone: false };
  const copy = storedWorkflow(raw);
  if (copy !== null) return { workflow: copy, gone: true };
  return { lost: name ?? "it followed" };
}

/** Whether a resumed session is told afresh: what it is told now, a
    workflow's instructions or none, differs from what its conversation was
    first given, which an agent that records it would otherwise keep. A
    session with nothing kept was given no workflow. */
function toldAfresh(id: string, workflow: Workflow | null): boolean {
  const kept = sessions.workflows[id];
  if (kept === undefined) return false;
  const now = workflow === null ? null : orchestratorPrompt(workflow);
  const told = firstTold(kept);
  // A kept record that no longer says what it was told was told a
  // workflow's instructions all the same.
  return told === null ? true : told !== now;
}

/** Lets go of what is kept for the sessions of a project that are gone
    from its history, their workflows and their tokens: no row has them,
    and the agent lists them no more. A history that came back empty may be
    one that could not be read, and takes nothing away. */
function pruneKept(project: string) {
  const listed = new Set((sessions.history[project] ?? []).map((entry) => entry.id));
  if (listed.size === 0) return;
  const rows = new Set(sessions.all.map((session) => session.id));
  const gone = (id: string, of: string | null) => of === project && !listed.has(id) && !rows.has(id);
  const workflows = Object.entries(sessions.workflows)
    .filter(([id, kept]) => gone(id, kept.project))
    .map(([id]) => id);
  const tokens = Object.entries(sessions.tokens)
    .filter(([id, kept]) => gone(id, kept.project))
    .map(([id]) => id);
  if (workflows.length === 0 && tokens.length === 0) return;
  // What else is kept for them is kept under their tokens, and for a
  // session from before there were tokens under its id as well.
  const ids = [...new Set([...workflows, ...tokens])];
  const callers = [
    ...new Set(ids.flatMap((id) => [sessions.tokens[id]?.token ?? id, id])),
  ];
  for (const id of workflows) delete sessions.workflows[id];
  for (const id of tokens) delete sessions.tokens[id];
  if (workflows.length > 0) saveKept();
  if (tokens.length > 0) saveTokens();
  forgotten(callers);
}

let forgotten: (tokens: string[]) => void = () => {};

/** Hears the tokens of sessions gone from their project's history, whose
    kept workflow or token went with them, and their ids, under which a
    session from before there were tokens kept what it ran. */
export function onForgotten(handler: ((tokens: string[]) => void) | null) {
  forgotten = handler ?? (() => {});
}

let moving: (id: string, token: string) => void = () => {};

/** Hears a session given its token, to move what is kept under its id
    there. */
export function onMoved(handler: ((id: string, token: string) => void) | null) {
  moving = handler ?? (() => {});
}

/** The model a workflow's orchestrator runs on, as the agent's command
    line takes it: none for Codex's own default. */
function orchestratorModel(workflow: Workflow): string | null {
  const { agent, model } = workflow.orchestrator;
  return agent === "codex" && model === CODEX_DEFAULT ? null : model;
}

/**
 * The token a new row's tools name it by. A session resumed has the one it
 * had, kept by its id, so it is the same session to everything kept under
 * that token. One with none kept, as a session from before there were
 * tokens has, is given a new one, kept by its id at once. Either way what
 * an earlier version kept under the id moves to the token, joined to what
 * is there so that a move made again adds nothing. A fresh session has a
 * new one, and so does a session whose token a live row holds already:
 * two rows never answer to one token at once.
 *
 * An agent's id is never a token: the tools answer with ids and the
 * sessions pane shows them, so a session named by its id could be called
 * as by any agent that learned it.
 */
function tokenFor(resumedFrom: string | null, project: string): string {
  if (resumedFrom === null) return crypto.randomUUID();
  // A run named by the id still runs: what is kept under the id is that
  // run's until it stops, and moves at its own next start.
  if (heldLive(resumedFrom)) return crypto.randomUUID();
  const kept = keptToken(resumedFrom);
  if (kept !== null) {
    if (heldLive(kept)) return crypto.randomUUID();
    moving(resumedFrom, kept);
    return kept;
  }
  // Kept before anything moves to it, so a move cut short is made again
  // at the next start, to the same token.
  const token = crypto.randomUUID();
  sessions.tokens[resumedFrom] = { token, project };
  saveTokens();
  moving(resumedFrom, token);
  return token;
}

/** The token kept for a session's id, when one is: never the id. */
function keptToken(id: string): string | null {
  const kept = sessions.tokens[id]?.token;
  return kept === undefined || kept === id ? null : kept;
}

/** Whether a live row other than this one answers to this token. */
function heldLive(token: string, except: string | null = null): boolean {
  return sessions.all.some((row) => row.key !== except && row.token === token && isLive(row));
}

/**
 * Gives a row that is about to start a process of its own a token no
 * running process holds. A row taken up after the window was reloaded has
 * the token of the run it took up, which for a session from before there
 * were tokens is its id: that run keeps it, since its environment holds
 * it, and the next start is given a token of its own, with what was kept
 * under the id moved to it.
 */
export function renewToken(session: Session) {
  if (session.id !== null && session.token === session.id)
    session.token = tokenFor(session.id, session.project);
  if (heldLive(session.token, session.key)) session.token = crypto.randomUUID();
}

/**
 * Keeps a row's token by the agent's id for it, once that is known, for the
 * session resumed later to be named the same.
 *
 * An id that a live row has already is found for two sessions at once, as
 * two Codex sessions started in one folder close together can be, whose id
 * the window finds by folder and time. Neither row's token is kept for it:
 * the id is kept a token of its own that neither holds, so the session
 * resumed by that id owns nothing either of them started.
 */
export function keepToken(session: Session) {
  const id = session.id;
  if (id === null) return;
  const twice = sessions.all.some(
    (row) => row.key !== session.key && row.id === id && isLive(row),
  );
  if (twice) {
    sessions.tokens[id] = { token: crypto.randomUUID(), project: session.project };
    saveTokens();
    return;
  }
  if (sessions.tokens[id]?.token === session.token) return;
  // A run taken up after a reload that was named by its id goes on so
  // until it stops; an id is never kept as a token, nor the one the row
  // was resumed from.
  if (session.token === id || session.token === session.resumedFrom) return;
  // Nor is another row's while a run named by the id still has its row:
  // what is kept under the id is that run's, and goes to the token its
  // next start gives it.
  if (sessions.all.some((row) => row.key !== session.key && row.token === id)) return;
  sessions.tokens[id] = { token: session.token, project: session.project };
  saveTokens();
}

function saveTokens() {
  try {
    localStorage.setItem(TOKENS_KEY, JSON.stringify(sessions.tokens));
  } catch {
    // Non-fatal: the session resumed after a restart is given a new token.
  }
}

/** The row whose tools name it by this token: the live one, where a row
    that has stopped holds it as well. Null for a token no row has. */
export function byToken(token: string | null): Session | null {
  if (token === null) return null;
  let found: Session | null = null;
  for (const session of sessions.all) {
    if (session.token !== token) continue;
    if (isLive(session)) return session;
    found ??= session;
  }
  return found;
}

/** The running row whose tools name it by this token. Null for a token no
    running row has: a stopped session is not calling, so what a process
    left over from it asks for is done for none of the rows. */
export function runningByToken(token: string | null): Session | null {
  const row = byToken(token);
  return row !== null && isLive(row) ? row : null;
}

function rememberName(id: string, name: string) {
  if (sessions.names[id] === name) return;
  sessions.names[id] = name;
  try {
    localStorage.setItem(NAMES_KEY, JSON.stringify(sessions.names));
  } catch {
    // Non-fatal: the name does not survive a restart.
  }
}

/** Transcripts not already open as a row: the one a row was resumed from, or
    the one it has been writing since it started, is that row. */
function closed(project: string): HistoryEntry[] {
  const known = sessions.history[project] ?? [];
  const open = new Set(
    forProject(project)
      .map((session) => session.id)
      .filter((id): id is string => id !== null),
  );
  return known.filter((transcript) => !open.has(transcript.id));
}

/** Whether a past session is listed under its project: one this app ran,
    and not left unchanged for longer than past sessions stay listed. */
function listed(project: string, transcript: HistoryEntry): boolean {
  return isMine(project, transcript.id) && !aged(transcript);
}

/** Past sessions this app ran lately, ready to resume. */
export function historyFor(project: string): HistoryEntry[] {
  return closed(project).filter((transcript) => listed(project, transcript));
}

/** Past sessions behind the fold: from outside the app, an agent run in a
    terminal in the same directory, and the app's own that have aged past
    the limit. Just as resumable, but not the first thing to show. One
    agent's, or every agent's. */
export function outsideFor(
  project: string,
  agent: AgentId | null = null,
): HistoryEntry[] {
  return closed(project).filter(
    (transcript) =>
      !listed(project, transcript) &&
      (agent === null || transcript.agent === agent),
  );
}

/**
 * What a past session is called. The title comes from a format documented as
 * internal and version-unstable, so a missing one falls back to when it last
 * moved rather than to an error.
 */
export function historyLabel(transcript: Transcript): string {
  const known = sessions.names[transcript.id];
  if (known !== undefined && !reservedName(known)) return shown(known);
  if (transcript.title !== null && transcript.title !== "" && !reservedName(transcript.title))
    return shown(transcript.title);
  return `session from ${ago(transcript.modified)}`;
}

/** Coarse on purpose: the pane wants recency, not a timestamp. */
export function ago(epochSeconds: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor(now / 1000) - epochSeconds);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** When something happened, as short as a row's end can say it: now, 4m,
    1h, then the weekday within the week, then 3w, 2mo and 1y. */
export function since(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  const days = Math.floor(seconds / 86_400);
  if (days < 7) return WEEKDAYS[new Date(ms).getDay()];
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** How the rows that fold away at the end of a project are counted on
    the row that holds them: `8 more from this week`, by how long ago the
    oldest of them changed. */
export function moreLabel(count: number, oldest: number, now = Date.now()): string {
  const days = (now - oldest) / 86_400_000;
  if (days < 1) return `${count} more from today`;
  if (days < 7) return `${count} more from this week`;
  if (days < 30) return `${count} more from this month`;
  return `${count} more`;
}

/** What a model is called on a row. Claude's own names read as they are
    said, `opus-4-1` as Opus 4.1 and `sonnet` as Sonnet; any other model
    is named as it was given. */
export function modelLabel(model: string): string {
  const bare = model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const [family, ...version] = bare.split("-");
  if (!/^(opus|sonnet|haiku|fable)$/i.test(family)) return model;
  const name = family[0].toUpperCase() + family.slice(1).toLowerCase();
  return version.length === 0 ? name : `${name} ${version.join(".")}`;
}

let counter = 0;
/** Next ordinal per project. Never reused, so labels never shift. */
let ordinals: Record<string, number> = {};

export function forProject(project: string): Session[] {
  return sessions.all.filter((session) => session.project === project);
}

/** When each project's transcripts were last written, in milliseconds,
    by session id: the newest where one is listed twice. */
const written = $derived.by(() => {
  const index = new Map<string, Map<string, number>>();
  for (const [project, entries] of Object.entries(sessions.history)) {
    const byId = new Map<string, number>();
    for (const entry of entries)
      if (!byId.has(entry.id)) byId.set(entry.id, entry.modified * 1000);
    index.set(project, byId);
  }
  return index;
});

/** When a session's transcript in a project was last written, in
    milliseconds, or null when the project's history does not list it. */
export function transcriptAt(project: string, id: string): number | null {
  return written.get(project)?.get(id) ?? null;
}

/** When a row last changed what it says, in milliseconds. A row left from
    the last quit changed when its transcript was last written: the row
    itself was only drawn again at the start. */
export function lastChanged(session: Session): number {
  if (session.status === "dormant" && session.id !== null) {
    const at = transcriptAt(session.project, session.id);
    if (at !== null) return at;
  }
  return session.changedAt;
}

/** Rows in the order they last changed, the latest first. Rows that
    changed in the same moment keep the order they were made in. */
export function byChange(rows: Session[]): Session[] {
  return [...rows].sort((a, b) => lastChanged(b) - lastChanged(a));
}

export function activeSession(): Session | null {
  return (
    sessions.all.find((session) => session.key === sessions.active) ?? null
  );
}

/** The rows by key, the first row with a key where two share one. */
const keyed = $derived.by(() => {
  const index = new Map<string, Session>();
  for (const session of sessions.all)
    if (!index.has(session.key)) index.set(session.key, session);
  return index;
});

export function byKey(key: string): Session | null {
  return keyed.get(key) ?? null;
}

export function isLive(session: Session): boolean {
  return session.status === "starting" || session.status === "running";
}

export function liveCount(project: string): number {
  return forProject(project).filter(isLive).length;
}

/** A short label for the row: its name, the resumed id, or its number in
    the project. A name is the agent's or a caller's text, so what it holds
    that cannot be seen is written out; and a name that reads as "You" or
    "Workbench", which are the user's and the workbench's alone, is not
    taken. */
export function label(session: Session): string {
  if (session.title !== null && !reservedName(session.title)) return shown(session.title);
  const given = givenBy(session);
  if (given !== null && !reservedName(given)) return shown(given);
  if (session.resumedFrom !== null) return session.resumedFrom.slice(0, 8);
  return `session ${session.ordinal}`;
}

let givenBy: (session: Session) => string | null = () => null;

/** Who knows the name a session was given rather than one its agent
    chose: the conductor, by the name a start gave the session it started.
    It is the row's name whenever the agent's own title names nothing, as
    when a session resumed in a terminal has not titled itself yet, so it
    stays with the session across a close, a resume, a change of how it
    runs and a restart, until the agent names it. */
export function onGiven(handler: ((session: Session) => string | null) | null) {
  givenBy = handler ?? (() => null);
}

/** The name a session was given rather than one its agent chose. Null for
    none. */
export function givenName(session: Session): string | null {
  return givenBy(session);
}

/** Whether a name reads as an agent's own, as the window names an agent
    that speaks or asks: Claude, Claude Code or Codex. A session never
    takes one, so no request of a session another started can read as the
    request of the agent on screen. */
export function readsAsAgent(name: string): boolean {
  // Its letters and digits alone, so no mark between the words gets past.
  const letters = (text: string) => bareName(text).replace(/[^\p{L}\p{N}]/gu, "");
  const bare = letters(name);
  return AGENTS.some((id) => letters(agentProfile(id).name) === bare || letters(agentLabel(id)) === bare);
}

/** Whether a name reads as the name of another live session, `except`
    aside, as the workbench's own or an agent's, or mixes scripts, as a
    name made to pass for another's often does: a session never takes one,
    so no message, row or request can pass for another session's, the
    workbench's or an agent's. */
export function nameTaken(name: string, except: string | null = null): boolean {
  if (mixesScripts(name) || readsAsWorkbench(name) || readsAsAgent(name)) return true;
  const bare = bareName(name);
  return sessions.all.some(
    (session) => session.key !== except && isLive(session) && bareName(label(session)) === bare,
  );
}

/**
 * What a terminal title from the agent means as a session name.
 *
 * Claude Code writes its own name and a status glyph around the session's
 * name, and both change with versions. The glyph is stripped, the name is
 * dropped, and a title that was only ever the agent's name is no title.
 */
export function sessionTitle(raw: string): string | null {
  let title = raw.trim();
  // Leading status marks: anything before the first letter or digit.
  title = title.replace(/^[^\p{L}\p{N}]+/u, "");
  title = title.replace(/\s*[-\u2013\u2014·|:]\s*claude(\s+code)?\s*$/iu, "");
  title = title.replace(/^claude(\s+code)?\s*[-\u2013\u2014·|:]\s*/iu, "");
  title = title.trim();
  if (title === "" || /^claude(\s+code)?$/iu.test(title)) return null;
  return title;
}

/**
 * An agent that mints its own ids has written one down. The row is found
 * by its pty, since that is all the two sides share until now. The id makes
 * the session ours, and the name that came with it names the row.
 */
export function identified(
  ptyId: string,
  sessionId: string,
  title: string | null,
) {
  const session = sessions.all.find((candidate) => candidate.ptyId === ptyId);
  if (session === undefined) return;
  session.id = sessionId;
  keepToken(session);
  identifiedZoom(session.key, sessionId);
  adopt(session.project, sessionId);
  rememberWorkflow(session);
  replayActivity(sessionId);
  if (title !== null) named(session.key, title);
}

/** Keeps the name a session's row goes by under its id, for when the row
    has gone: the title it has, or the name its caller gave it, and never
    its number, nor a name the user's or the workbench's own would read
    as. */
export function keepName(session: Session) {
  if (session.id === null) return;
  const name = session.title ?? givenName(session);
  if (name !== null && name.trim() !== "" && !reservedName(name)) rememberName(session.id, name);
}

/** The agent's index calls the session this. Taken as it is, unlike a
    terminal title, which carries the agent's own name around it. */
export function named(key: string, title: string) {
  const session = byKey(key);
  if (session === null || title === "") return;
  session.title = title;
  if (session.id !== null) rememberName(session.id, title);
}

/** The user named the session through its agent, by the agent's rename
    command. That is what the row is called from now on, whatever title
    the agent sets later, unless it reads as another live session's name
    or as the user's or the workbench's own. */
export function renamed(key: string, title: string) {
  const session = byKey(key);
  const name = title.trim();
  if (session === null || name === "" || reservedName(name) || nameTaken(name, key)) return;
  session.ownTitle = true;
  if (session.title === name) return;
  session.title = name;
  if (session.id !== null) rememberName(session.id, name);
}

/** The agent set the terminal title: that is what the session is called,
    now and when it is listed as a past session later, unless the user
    has named it. */
export function titled(key: string, raw: string) {
  const session = byKey(key);
  if (session === null || session.ownTitle) return;
  session.title = sessionTitle(raw);
  if (session.title !== null && session.id !== null)
    rememberName(session.id, session.title);
}

/**
 * The OS says where the process is working. A new directory is resolved to
 * its repository, so the changes pane can follow the agent into a worktree.
 */
export async function located(key: string, cwd: string | null) {
  const session = byKey(key);
  if (session === null || cwd === null || session.cwd === cwd) return;
  session.cwd = cwd;
  try {
    const info = await core().projectInfo(cwd);
    // Only the latest answer counts: the agent may have moved again.
    if (session.cwd === cwd) session.worktree = info.repository;
  } catch {
    if (session.cwd === cwd) session.worktree = null;
  }
}

/**
 * The repository a session was started in, on the row from the start.
 *
 * A session started in a worktree, or resumed into the one it ran in, belongs
 * to that worktree before its process has said anything, and a session whose
 * process has ended never says anything again. Without this the changes pane
 * would show the project's own tree, where a worktree's files are a directory
 * git does not look inside.
 */
export async function startedIn(key: string, dir: string) {
  try {
    const info = await core().projectInfo(dir);
    const session = byKey(key);
    // Only while nothing better is known: the running session's own cwd is
    // the more current answer, and it may have arrived first.
    if (session !== null && session.worktree === null)
      session.worktree = info.repository;
  } catch {
    // A directory the core cannot describe is no worktree, which is what the
    // row already says.
  }
}

const CWD_POLL = 2000;

/**
 * Asks, every couple of seconds, where the active session is working, what
 * an agent that names sessions in its own index calls it now, and what the
 * user named a Claude Code session through its rename command. Cheap: one
 * syscall, and one small query or a look at the end of the transcript on
 * the core's side. Returns a stop function.
 */
export function followCwd(): () => void {
  const timer = setInterval(() => {
    const session = activeSession();
    if (
      session === null ||
      session.ptyId === null ||
      session.status !== "running"
    )
      return;
    const { key, ptyId, agent, id, account } = session;
    core()
      .ptyCwd(ptyId)
      .then((cwd) => located(key, cwd))
      .catch(() => {});
    // Codex keeps what it calls a session in an index of its own, and
    // Claude Code the name the user gave it in its transcript.
    if (id !== null) {
      core()
        .sessionTitle(agent, id, dirFor(account, agent))
        .then((title) => {
          if (title === null) return;
          if (agent === "codex") named(key, title);
          else renamed(key, title);
        })
        .catch(() => {});
    }
  }, CWD_POLL);
  return () => clearInterval(timer);
}

export function select(key: string) {
  if (byKey(key) !== null) sessions.active = key;
}

/** Steps to the next or previous session of the project, wrapping around.
    False when there is nothing to step to. */
export function cycle(project: string, direction: 1 | -1): boolean {
  const own = forProject(project);
  if (own.length < 2) return false;
  const at = own.findIndex((session) => session.key === sessions.active);
  const next = at === -1 ? 0 : (at + direction + own.length) % own.length;
  sessions.active = own[next].key;
  return true;
}

/**
 * Adds a session row and starts it. The row exists before the process does so
 * the pane has something to render while it comes up, and so a failure to
 * start has somewhere to be reported.
 *
 * A session runs one of two ways: under a workflow, on the workflow's
 * orchestrator, or as one agent with no workflow. What was picked is what
 * starts. A workflow given starts under it; null starts the agent alone.
 * Left out, a resumed session follows the workflow it followed before, and a
 * new one follows its project's workflow when nothing was picked: the agent
 * left out, or nothing there to pick between, one agent installed and no
 * accounts. An agent picked from several starts alone, and so does one
 * started the other way by name. A workflow whose orchestrator runs on an
 * agent that is not installed is refused on the row.
 *
 * It runs the way the agent's setting says, unless started the other way,
 * under a workflow as under none: either way of running tells the
 * orchestrator its workflow as it starts. Started the other way, it runs its
 * own way from then on, and a switch of the setting leaves it as it is.
 */
export function create(
  project: string,
  resumedFrom: string | null = null,
  agent?: AgentId,
  startIn: string | null = null,
  prompt: string | null = null,
  model: string | null = null,
  account: string | null = accountOf(project),
  workflow?: Workflow | null,
  kind?: SessionKind,
): Session {
  // Started the other way by name is a pick, as an agent picked is: it runs
  // alone, whatever the project follows.
  const following =
    workflow !== undefined
      ? workflow
      : resumedFrom !== null || kind !== undefined
        ? null
        : agent === undefined || nothingToPick()
          ? workflowOf(project)
          : null;
  let runs: AgentId = agent ?? defaultAgent(project);
  if (following !== null) {
    if (resumedFrom === null) runs = following.orchestrator.agent;
    if (model === null && runs === following.orchestrator.agent)
      model = orchestratorModel(following);
  } else if (model === null && resumedFrom === null && prompt === null) {
    // A new session the user starts alone begins on the model last chosen
    // for its agent.
    model = modelToStart(runs, account);
  }
  const runsAs: SessionKind = kind ?? kindFor(runs);
  // A resumed session left to follow what it followed before finds out what
  // that is when it starts, once the window has the workflows.
  const resolving = workflow === undefined && resumedFrom !== null;
  const missing =
    following !== null && resumedFrom === null && !installed().includes(runs)
      ? `The workflow "${following.name}" runs its orchestrator on ${agentLabel(runs)}, which is not installed here. Pick an agent to start one alone, or choose another workflow for this project in the settings.`
      : null;
  if (missing === null) prefer(project, runs);
  const live = added(
    row(
      project,
      resumedFrom,
      runs,
      startIn,
      prompt,
      model,
      account,
      missing === null ? "starting" : "failed",
      following,
      runsAs,
    ),
  );
  if (missing !== null) live.error = missing;
  live.ownWay = runsAs !== kindFor(runs);
  if (resolving) pending.add(live.key);
  sessions.active = live.key;
  return live;
}

/** The rows of resumed sessions that find out what they follow when they
    start. */
const pending = new Set<string>();

/** Gives a resumed row the workflow it follows from here, and the
    orchestrator's model where it runs on the orchestrator's agent and
    names none. A workflow lost to the user's question fails the row with
    it. */
function takeUp(session: Session, id: string) {
  const resumed = resumedWorkflow(id);
  if ("lost" in resumed) {
    session.workflowLost = resumed.lost;
    session.status = "failed";
    session.error = `This session followed the workflow "${resumed.lost}", which is gone, and the copy it kept no longer reads. Resume it without a workflow, or start a new session.`;
    changed(session);
    return;
  }
  const { workflow, gone } = resumed;
  session.workflow = workflow === null ? null : (structuredClone($state.snapshot(workflow)) as Workflow);
  session.workflowGone = gone;
  if (workflow === null) return;
  if (session.model === null && session.agent === workflow.orchestrator.agent)
    session.model = orchestratorModel(workflow);
}

/** What a start tells the agent of the workflow its session follows. */
export interface Told {
  /** The workflow's instructions, for a session that follows one. */
  instructions?: string;
  /** Whether the agent's own subagent tools are taken away. */
  startOnly?: boolean;
  /** Whether a resumed session lets go of what its conversation was
      first told. */
  afresh?: boolean;
}

/**
 * What the agent behind a starting row is told of its workflow, the same
 * for a terminal and an integrated start: a resumed row left to follow what
 * it followed before finds out what that is first, once the window has the
 * workflows. Null when the row is gone or no longer starting, as when the
 * workflow it followed is lost and the user is asked.
 */
export async function toldAtStart(key: string): Promise<Told | null> {
  let session = byKey(key);
  if (session === null || session.status !== "starting") return null;
  const resumed = session.resumedFrom;
  if (pending.delete(key) && resumed !== null) {
    await workflowsKnown();
    session = byKey(key);
    if (session === null || session.status !== "starting") return null;
    takeUp(session, resumed);
    if (session.status !== "starting") return null;
  }
  return toldFor(session);
}

/** What the agent behind a row is told of the workflow the row follows
    now, as it starts. */
export function toldFor(session: Session): Told {
  // Resumed with other instructions than its conversation was first given,
  // or with none where it was given some, the agent lets go of the ones it
  // recorded. Codex cannot, and the user is told.
  const afresh =
    session.resumedFrom !== null && toldAfresh(session.resumedFrom, session.workflow);
  session.keptFromStart = afresh && session.agent === "codex" ? keptBy(session.workflow) : null;
  return {
    ...(session.workflow === null
      ? {}
      : {
          instructions: orchestratorPrompt(session.workflow),
          startOnly: startsOnly(session.workflow),
        }),
    ...(afresh ? { afresh: true } : {}),
  };
}

/** Why a session running as a conversation cannot be made the
    orchestrator of a workflow, or null when it can: its orchestrator's
    agent is not installed here, or runs only in a terminal. */
export function cannotDirect(workflow: Workflow): string | null {
  const runs = workflow.orchestrator.agent;
  if (!installed().includes(runs)) return `Directed by ${agentLabel(runs)}, which is not installed here`;
  if (!canIntegrate(runs)) return `Directed by ${agentLabel(runs)}, which runs only in a terminal`;
  return null;
}

/**
 * Puts a row under a workflow, or under none, the way a new row is put
 * under one: on the orchestrator's agent and model and told the workflow
 * as it starts, or alone on the agent given and the model last chosen for
 * it, else its own default. It changes what the row says it is; the run behind it is the
 * caller's to start again. False when the workflow cannot direct a
 * conversation here.
 */
export function putUnder(key: string, workflow: Workflow | null, alone: AgentId): boolean {
  const session = byKey(key);
  if (session === null) return false;
  if (workflow !== null && cannotDirect(workflow) !== null) return false;
  if (workflow === null) {
    session.workflow = null;
    session.agent = alone;
    session.model = modelToStart(alone, session.account);
  } else {
    session.workflow = structuredClone($state.snapshot(workflow)) as Workflow;
    session.agent = workflow.orchestrator.agent;
    session.model = orchestratorModel(workflow);
  }
  session.workflowGone = false;
  // A conversation stays one on an agent whose setting is a terminal: it
  // runs its own way from here.
  if (session.kind !== kindFor(session.agent)) session.ownWay = true;
  return true;
}

/** A row starts again before it was spoken to, under another workflow:
    nothing is kept from here under the id of the run it leaves, so its
    token and the workflow it follows are kept under the id of the run
    that takes over alone. */
export function leaveRun(session: Session) {
  const id = session.id;
  session.id = null;
  if (id === null) return;
  if (sessions.tokens[id] !== undefined) {
    delete sessions.tokens[id];
    saveTokens();
  }
  if (sessions.workflows[id] !== undefined) {
    delete sessions.workflows[id];
    saveKept();
  }
}

/** What a Codex session resumed under other instructions than it began
    with does: it goes on with those it began with, and with its own
    subagent tools as they were then. */
function keptBy(workflow: Workflow | null): string {
  return workflow === null
    ? "Codex goes on with the instructions and the subagent tools this session began with under its workflow. Start a new session to work without one."
    : `Codex goes on with the instructions and the subagent tools this session began with, not those of "${workflow.name}" as it is now. Start a new session for those.`;
}

/** Puts away what is said over a session of what Codex kept. */
export function dismissKept(key: string) {
  const session = byKey(key);
  if (session !== null) session.keptFromStart = null;
}

/** A row started again in place, resuming its conversation, finds out what
    it follows as a row resumed from the past sessions does: by the name
    of the workflow it followed, as the settings have it now. */
export function followsAgain(key: string) {
  const session = byKey(key);
  if (session !== null && session.resumedFrom !== null) pending.add(key);
}

/**
 * A row taken up again while its agent still runs, after the window was
 * reloaded: it follows what its run was started on, the copy of the
 * workflow kept for it then, so the calls it makes are held to the
 * workflow it was told. A row that followed none follows none.
 */
export async function rejoined(key: string) {
  if (!pending.delete(key)) return;
  const session = byKey(key);
  if (session === null || session.id === null) return;
  const kept = sessions.workflows[session.id];
  if (kept === undefined || kept.workflow === null) return;
  const copy = storedWorkflow(kept.workflow);
  if (copy === null) return;
  // Held to it at once, so no call it makes meanwhile goes unheld; whether
  // the settings still have it waits for the settings.
  session.workflow = copy;
  await workflowsKnown();
  const now = byKey(key);
  if (now !== null) now.workflowGone = workflowNamed(copy.name) === undefined;
}

/** Resumes a session whose workflow was lost, with no workflow, in place
    of the row that asked. The user's word is kept, so the session is not
    asked about again, along with what its conversation was first told, so
    it goes on being told afresh. */
export function resumeWithout(key: string): Session | null {
  const session = byKey(key);
  if (session === null || session.workflowLost === null || session.id === null) return null;
  const { project, id, agent, startIn, model, account, kind } = session;
  const before = sessions.workflows[id];
  sessions.workflows[id] = {
    workflow: null,
    told: before === undefined ? null : firstTold(before),
    project,
  };
  saveKept();
  // The row resumed in its place runs the way this one did, its own way
  // only where this one ran so, and keeps the shells opened beside it.
  const ownWay = session.ownWay;
  close(key, true);
  const next = create(project, id, agent, startIn, null, model, account, null, kind);
  next.ownWay = ownWay;
  handOver(key, { project, session: next.key });
  return next;
}

/** Whether a new session has nothing to pick between: one agent to run
    and no accounts to run it under. */
function nothingToPick(): boolean {
  return installed().length <= 1 && names().length === 0;
}

/**
 * Adds a row for a session that was open when the app last quit. It is
 * listed where it was, under the name it had, and nothing runs behind it
 * until `wake` is called for it. Neither the active session nor the agent
 * the project last started changes.
 */
export function reopened(
  project: string,
  id: string,
  agent: AgentId,
  startIn: string | null,
  model: string | null,
  account: string | null,
  kind: SessionKind = "terminal",
  workflow: Workflow | null = null,
  resolve = true,
  /** The token of a run the core may still be running from before the
      window was reloaded, which the row takes up with it. */
  running: string | null = null,
  /** It ran its own way, whatever its agent's setting says. */
  ownWay = false,
): Session {
  const live = added(
    row(project, id, agent, startIn, null, model, account, "dormant", workflow, kind, running),
  );
  live.ownWay = ownWay;
  if (resolve) pending.add(live.key);
  return live;
}

/** Who hears that a row left from the last quit is about to start, while
    it can still be turned the way it is to run. */
let waking: (session: Session) => void = () => {};

export function onWake(handler: (session: Session) => void) {
  waking = handler;
}

/** Starts the process behind a row that was open when the app last quit:
    from here it is a resumed session like any other. */
export function wake(key: string) {
  const session = byKey(key);
  if (session?.status !== "dormant") return;
  waking(session);
  renewToken(session);
  session.status = "starting";
  changed(session);
}

function row(
  project: string,
  resumedFrom: string | null,
  agent: AgentId,
  startIn: string | null,
  prompt: string | null,
  model: string | null,
  account: string | null,
  status: SessionStatus,
  workflow: Workflow | null = null,
  kind: SessionKind = "terminal",
  running: string | null = null,
): Session {
  ordinals[project] = (ordinals[project] ?? 0) + 1;
  return {
    key: `s${++counter}`,
    token: running ?? tokenFor(resumedFrom, project),
    project,
    agent,
    kind,
    ownWay: false,
    ptyId: null,
    status,
    id: resumedFrom,
    resumedFrom,
    ordinal: ordinals[project],
    // A resumed session keeps the name it had until the agent says otherwise.
    title: resumedFrom === null ? null : (sessions.names[resumedFrom] ?? null),
    ownTitle: false,
    cwd: null,
    startIn,
    prompt,
    model,
    account,
    workflow:
      workflow === null ? null : (structuredClone($state.snapshot(workflow)) as Workflow),
    workflowGone: false,
    workflowLost: null,
    keptFromStart: null,
    worktree: null,
    working: false,
    engaged: prompt !== null,
    startedAt: null,
    unread: false,
    note: null,
    notice: null,
    exact: false,
    needs: null,
    delegated: false,
    turnEnd: null,
    failure: null,
    background: [],
    modeNamed: null,
    modeGiven: null,
    modeSeen: null,
    carried: null,
    turns: 0,
    changedAt: Date.now(),
    exitCode: null,
    error: null,
    mounted: false,
  };
}

/** The row changed what it says, now. */
function changed(session: Session) {
  session.changedAt = Date.now();
}

function added(session: Session): Session {
  sessions.all.push(session);
  // Return what the array holds, not what was handed to it: $state proxies the
  // object on the way in, and the original would be a stale copy whose
  // mutations nothing sees.
  const live = sessions.all[sessions.all.length - 1];
  if (live.startIn !== null) void startedIn(live.key, live.startIn);
  backAsItWas(live);
  return live;
}

/** What waited on the user in rows of the last run that have not come back
    yet, by the session's id: a project still on its way, or a session
    another started that its starter has not resumed. */
const waitingBack = new Map<string, KeptWaiting>();

/** Bumped when a mark changes, which the record follows. */
const markEpoch = $state({ n: 0 });

function marksChanged() {
  markEpoch.n += 1;
}

function isKeptWaiting(value: unknown): value is KeptWaiting {
  if (typeof value !== "object" || value === null) return false;
  const { unread, note, notice, at, mark, seen } = value as Record<string, unknown>;
  const line = (text: unknown) => text === null || typeof text === "string";
  return (
    typeof unread === "boolean" &&
    (seen === undefined || typeof seen === "number") &&
    line(note) &&
    line(notice) &&
    typeof at === "number" &&
    (mark === undefined ||
      (typeof mark === "object" &&
        mark !== null &&
        line((mark as Record<string, unknown>).restored) &&
        typeof (mark as Record<string, unknown>).heard === "boolean"))
  );
}

/** Reads what waited on the user at the last quit. The record of open
    rows says whether the version that last wrote it kept this too: one
    from a version before keeps only the rows, so what is here is older
    than what that version did and is not taken. */
function loadWaiting() {
  waitingBack.clear();
  try {
    const open: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "null");
    if (typeof open !== "object" || open === null || (open as Record<string, unknown>).waiting !== true) return;
    const stored: unknown = JSON.parse(localStorage.getItem(WAITING_KEY) ?? "null");
    if (typeof stored !== "object" || stored === null) return;
    const now = Date.now();
    for (const [id, kept] of Object.entries(stored)) {
      if (!isKeptWaiting(kept) || !kept.unread) continue;
      const seen = kept.seen ?? now;
      if (now - seen > WAITING_FOR) continue;
      waitingBack.set(id, { ...kept, seen });
    }
  } catch {
    // Nothing waits, then: the rows come back read.
  }
}

/** A row of the last run comes back as it was: unread with the line under
    its name, and a mark the user made with its rule. Nothing is said of
    it: it is not news. */
function backAsItWas(session: Session) {
  if (session.id === null) return;
  const kept = waitingBack.get(session.id);
  if (kept === undefined) return;
  waitingBack.delete(session.id);
  session.unread = true;
  session.note = kept.note;
  session.notice = kept.notice;
  session.changedAt = kept.at;
  if (kept.mark !== undefined) {
    marks.set(session.key, { ...kept.mark });
    marksChanged();
  }
}

/** Whether a row is one that comes back after a restart: one whose
    process runs, or one left from the last quit. */
function comesBack(session: Session): boolean {
  return session.id !== null && (session.status === "dormant" || session.status === "starting" || session.status === "running");
}

/** What is kept now: each row that comes back and waits on the user, and
    what is still waiting to come back. */
export function waitingRecord(): Record<string, KeptWaiting> {
  const record = new Map(waitingBack);
  const now = Date.now();
  for (const session of sessions.all) {
    if (!comesBack(session)) continue;
    const id = session.id!;
    record.delete(id);
    if (!session.unread) continue;
    const mark = marks.get(session.key);
    record.set(id, {
      unread: true,
      note: session.note,
      notice: session.notice,
      at: session.changedAt,
      ...(mark === undefined ? {} : { mark: { restored: mark.restored, heard: mark.heard } }),
      seen: now,
    });
  }
  return Object.fromEntries([...record].slice(-WAITING_KEPT));
}

/** Keeps the record of what waits on the user current as rows change, so
    it holds after a quit and after a crash alike. Returns a stop
    function. */
export function followWaiting(): () => void {
  return $effect.root(() => {
    $effect(() => {
      void markEpoch.n;
      const record = waitingRecord();
      try {
        localStorage.setItem(WAITING_KEY, JSON.stringify(record));
      } catch {
        // Non-fatal: the rows come back read after a restart.
      }
    });
  });
}

/** The restore put this row on screen. Unread, it is not read by being
    restored there: it waits as a mark made on screen does, until another
    session is put on screen and it comes back, the user writes to it, or
    marks it read. */
export function restoredOnScreen(key: string) {
  if (byKey(key)?.unread === true) markedOnScreen = key;
}

/**
 * Starts the process behind a row. The terminal supplies its grid and takes
 * the bytes; everything about what the process is lives here.
 */
export async function launch(
  key: string,
  cols: number,
  rows: number,
  onOutput: (bytes: Uint8Array) => void,
): Promise<boolean> {
  const told = await toldAtStart(key);
  const session = byKey(key);
  // A row refused before it started has no process to start.
  if (told === null || session === null) return false;
  const bullets = session.agent === "claude-code" ? bulletWatch() : null;
  // A conversation goes on in the mode the window keeps for it: the one its
  // last integrated run ran in, which its agent's terminal has no record
  // of, or the one a terminal run was killed in before it could write its
  // own down. A new one another session started begins in the mode its
  // starter gave it, and one reopened before anything was said in it, in
  // the mode kept for the conversation it leaves.
  // A new one the user started begins in the mode last chosen for its
  // agent.
  const carried = carriedFor(session);
  const mode =
    session.resumedFrom !== null
      ? modeOf(session.resumedFrom)
      : (session.modeGiven ?? (session.id === null ? null : modeOf(session.id)) ?? carried?.mode ?? null);
  session.carried = carried === null ? null : { ...carried, effort: null, mode: mode === carried.mode ? mode : null };
  session.modeNamed = mode;
  session.modeSeen = null;
  const back = bringingBack.delete(key);
  try {
    const { ptyId, sessionId } = await core().spawn(
      {
        ...(back ? { bringBack: true } : {}),
        agent: session.agent,
        project: session.project,
        cwd: session.startIn ?? undefined,
        session: session.resumedFrom ?? undefined,
        token: session.token,
        prompt: session.prompt ?? undefined,
        model: session.model ?? undefined,
        mode: mode ?? undefined,
        configDir: dirFor(session.account, session.agent),
        ...told,
        cols,
        rows,
      },
      (bytes) => {
        output(key, bytes.length, Date.now(), bullets?.(bytes) ?? false);
        onOutput(bytes);
      },
    );
    if (started(key, ptyId, sessionId)) return true;
    // The row was closed while the process was coming up. Nothing owns it
    // now, so it must not be left running.
    core()
      .kill(ptyId)
      .catch(() => {});
    return false;
  } catch (error) {
    // A conversation held where it went back is not resumed in a terminal
    // without the user's say: the row says so, and offers to open it as a
    // conversation, which goes on from that point.
    if (isHeld(error)) {
      heldAtStart.add(key);
      failed(key, String(error instanceof Error ? error.message : error).replace(/^held:\s*/, ""));
    } else failed(key, String(error));
    return false;
  }
}

/**
 * The process is up. False when the row is already gone, which is the caller's
 * cue that nothing owns the pty it was just handed.
 */
export function started(
  key: string,
  ptyId: string,
  sessionId: string | null,
): boolean {
  const session = byKey(key);
  if (session === null) return false;
  session.ptyId = ptyId;
  session.startedAt = Date.now();
  session.status = "running";
  const quiet = quietly.has(key);
  runUp(key);
  if (!quiet) changed(session);
  if (sessionId !== null) {
    session.id = sessionId;
    // A run in the mode kept for the conversation holds that record until
    // it ends.
    holdMode(sessionId);
    keepToken(session);
    identifiedZoom(key, sessionId);
    adopt(session.project, sessionId);
    rememberWorkflow(session);
    replayActivity(sessionId);
  }

  const early = claim(ptyId);
  if (early !== undefined) ended(early);
  return true;
}

export function failed(key: string, error: string) {
  const session = byKey(key);
  if (session === null) return;
  runUp(key);
  session.ptyId = null;
  session.status = "failed";
  session.error = String(error);
  changed(session);
}

/** The rows whose terminal start the core refused, their conversation
    being held at the point it went back to. */
const heldAtStart = new SvelteSet<string>();

/** Whether a row's terminal start was refused for its conversation being
    held at the point it went back to. */
export function refusedAsHeld(key: string): boolean {
  return heldAtStart.has(key);
}

/** The rows whose next terminal start brings back what their conversation
    went back on, the user having agreed: a core that holds a conversation
    at the point it went back to refuses that start otherwise. */
const bringingBack = new Set<string>();

/** The user agreed that the row's next start in a terminal brings back what
    its conversation went back on. */
export function bringBack(key: string) {
  bringingBack.add(key);
}

/** The conversation each closed row's run had, by its pty, until that run
    is heard to end. */
const closedRuns = new Map<string, string>();

/** The exit of an agent that shut down on a hang-up, as Claude Code does:
    128 and the signal's number. */
const HUNG_UP = 129;

/** Whether a terminal run ended by a shutdown of its own, on a quit or a
    hang-up, rather than killed: only then has its agent written down the
    mode it ran in. */
function shutDown(event: SessionEnded): boolean {
  return event.clean || event.code === HUNG_UP;
}

/**
 * A session ended on its own. Anything but a clean zero reads as a crash, and
 * nothing restarts by itself: a broken install would otherwise become a loop
 * that burns CPU and hides the actual error.
 *
 * False when no row here has or had that pty: the exit is someone else's,
 * or the spawn result has not landed yet.
 */
export function ended(event: SessionEnded): boolean {
  const session = sessions.all.find(
    (candidate) => candidate.ptyId === event.id,
  );
  if (session === undefined) {
    // The run of a row closed while it went on.
    const id = closedRuns.get(event.id);
    if (id === undefined) return false;
    closedRuns.delete(event.id);
    terminalEnded(id, shutDown(event));
    return true;
  }
  session.ptyId = null;
  if (session.id !== null) terminalEnded(session.id, shutDown(event));
  // A run a reopen stopped goes on the other way, and its row never ends.
  if (runEnded(session.key)) return true;
  session.exitCode = event.code;
  session.status = event.clean ? "exited" : "crashed";
  // An ending is something to see too, and not a thing still working.
  session.working = false;
  changed(session);
  unseen(session);
  // The transcript is complete now, so the history it belongs in has moved.
  loadHistory(session.project);
  return true;
}

/** Closes a row for good, stopping it first if it is still going. */
/** Takes a session out of ours: from then on it is listed with the ones
    from outside, behind the fold, still there to resume. */
export function disown(project: string, id: string) {
  if (!isMine(project, id)) return;
  sessions.mine[project] = (sessions.mine[project] ?? []).filter(
    (mine) => mine !== id,
  );
  try {
    localStorage.setItem(MINE_KEY, JSON.stringify(sessions.mine));
  } catch {
    // Non-fatal: the split into ours and outside does not survive a restart.
  }
}

/** Who hears that a session, or a project with `project:` before its
    path, has gone: the editor, which lets its tabs go. */
let goneHandler: ((owner: string) => void) | null = null;

export function onOwnerGone(handler: ((owner: string) => void) | null) {
  goneHandler = handler;
}

/** A session or a project's own place has gone. */
export function ownerGone(owner: string) {
  goneHandler?.(owner);
}

/** What stops an integrated session's agent, which has no pty to kill. */
let stopIntegrated: (session: Session) => void = () => {};

export function onIntegratedClose(handler: (session: Session) => void) {
  stopIntegrated = handler;
}

let closing: (session: Session) => void = () => {};

/** Who hears that a row is about to close, while it still says how it
    stood: the conductor, which remembers why a session it started is no
    longer open. */
export function onClosed(handler: ((session: Session) => void) | null) {
  closing = handler ?? (() => {});
}

/** What stops an integrated session's agent and keeps its row, whose run
    then ends as any run does. */
let haltIntegrated: (session: Session) => void = () => {};

export function onIntegratedHalt(handler: (session: Session) => void) {
  haltIntegrated = handler;
}

/** The rows being reopened the other way, from the stop of their run until
    the next run is up. Such a row is live throughout: the end of the run
    that was stopped never shows on it, and what watches how a session is,
    such as the wait of the session that started it, passes it over until
    the next run is up. */
const reopening = new SvelteSet<string>();

/** Whether the row is being reopened the other way. */
export function reopeningRow(key: string): boolean {
  return reopening.has(key);
}

/** The rows being moved the other way because their agent's setting was
    switched, until the next run is up. Nothing the row says has changed,
    so such a move keeps its place in the list and its time. */
const quietly = new SvelteSet<string>();

/** Whether the row is being moved by its agent's setting rather than by
    the user's hand. */
export function movingBySetting(key: string): boolean {
  return quietly.has(key);
}

/** The next run of a row is up, or did not start: a reopen of it is over. */
export function runUp(key: string) {
  reopening.delete(key);
  quietly.delete(key);
}

/** What a reopen does once the run it stopped has ended, by the row's key. */
const endings = new Map<string, () => void>();

/** How long a reopen waits for the run it stopped to end. A run still
    there by then is left as it was, and the reopen given up. */
const REOPEN_WAIT = 20_000;

/** How many times a terminal Claude Code session is pressed Ctrl+C to
    quit, and how far apart: enough to stop a turn, clear what is typed and
    quit, each press before the one that asks again lapses. */
const QUIT_PRESSES = 5;
const QUIT_GAP = 300;

/** The run of a row has ended. True when a reopen stopped it, which then
    swaps the row over at once, inside the end, so nothing that watches the
    row sees it end. */
export function runEnded(key: string): boolean {
  const done = endings.get(key);
  endings.delete(key);
  done?.();
  return done !== undefined;
}

/**
 * The way a row can be reopened the other way: integrated for a terminal
 * session whose agent can run so, a terminal for an integrated one. Null
 * where it cannot be: its agent runs one way only, its conversation's id
 * is not known yet, a start or a reopen of it is on its way, or it waits on
 * the user's word about a workflow it lost.
 */
export function otherWayFor(session: Session): SessionKind | null {
  if (session.id === null || !canIntegrate(session.agent)) return null;
  if (session.status === "starting" || session.workflowLost !== null || reopening.has(session.key)) return null;
  return session.kind === "terminal" ? "integrated" : "terminal";
}

/** Whether the agent is at work in the session, or waits on the user in
    the middle of a turn: what reopening it would stop. */
export function midTurn(session: Session): boolean {
  return isLive(session) && (session.working || session.needs !== null);
}

/**
 * Reopens a session the other way: a terminal session as a conversation,
 * a conversation in a terminal. Its run is stopped, and once that has
 * ended the same conversation resumes the other way in the same row, with
 * its token, its name, its place, its shells and the sessions it started.
 * The row is live throughout, so neither the user nor a session that
 * started it hears of an end. A row left from the last quit only changes
 * the way it will start. False when the run did not stop in time: the row
 * is left as it was.
 *
 * Reopened by the user's hand, the row runs its own way from then on where
 * that is not its agent's setting, and follows the setting again where it
 * is. Moved `bySetting`, it goes on following the setting, and keeps its
 * time and its place in the list.
 */
export async function reopenOtherWay(key: string, bySetting = false): Promise<boolean> {
  const session = byKey(key);
  if (session === null) return false;
  const to = otherWayFor(session);
  if (to === null) return false;
  reopening.add(key);
  if (bySetting) quietly.add(key);
  if (session.status !== "running") {
    swap(session, to, bySetting);
    return true;
  }
  const stopped = await stopRun(session, () => {
    const row = byKey(key);
    if (row !== null) swap(row, to, bySetting);
  });
  if (!stopped) {
    runUp(key);
    // What the user agreed to was for this reopen.
    bringingBack.delete(key);
  }
  return stopped;
}

/** Turns a row left from the last quit the way it is to start, as its
    agent's setting says: nothing runs behind it to stop. False for a row
    that is not left from the last quit, or already runs that way. */
export function turnDormant(key: string, to: SessionKind): boolean {
  const row = byKey(key);
  if (row === null || row.status !== "dormant" || row.kind === to || row.id === null) return false;
  swap(row, to, true);
  return true;
}

/** Turns a row whose run has ended, or that has none, the other way, to
    start again there on the same conversation. */
function swap(row: Session, to: SessionKind, bySetting: boolean) {
  heldAtStart.delete(row.key);
  if (!bySetting) row.ownWay = to !== kindFor(row.agent);
  // The conversation the stopped run had, which the other way lets go of:
  // the next run reads it back from the agent's own record.
  // A conversation nothing was said in has no record of its agent's to
  // resume from, and starts afresh the other way.
  const spoken = row.kind === "integrated" ? saidIn(row) : saidInTerminal(row);
  if (row.kind === "integrated") stopIntegrated(row);
  // The row keeps the name it showed, which a row resumed by its id would
  // otherwise give up for the id's start.
  if (spoken) row.title ??= label(row);
  row.kind = to;
  row.resumedFrom = spoken ? row.id : null;
  // The prompt a started session began with was given then, and is not
  // given again to the conversation that goes on.
  row.prompt = null;
  followsAgain(row.key);
  row.ptyId = null;
  row.working = false;
  row.needs = null;
  row.engaged = false;
  row.startedAt = null;
  row.error = null;
  row.exitCode = null;
  row.exact = false;
  if (row.status === "dormant") runUp(row.key);
  else {
    renewToken(row);
    row.status = "starting";
  }
  if (!bySetting) changed(row);
}

/** Whether anything was said in an integrated row's conversation, as its
    conversation has it. */
let saidIn: (session: Session) => boolean = () => true;

export function onSaid(handler: (session: Session) => boolean) {
  saidIn = handler;
}

/** Whether anything was said in a terminal row's conversation: it was
    resumed, started with a prompt, or a turn of it was heard. Where no hook
    and no log of the agent's reports its turns, a line sent to it counts,
    since a short turn shows nothing in its output. */
function saidInTerminal(row: Session): boolean {
  if (row.resumedFrom !== null || row.prompt !== null || row.turns > 0) return true;
  const reported = row.exact || row.agent === "codex" || isInstalled(row.project);
  return row.engaged && !reported;
}

/** Stops the row's run, and once it has ended, does `then` inside the end.
    False when it has not ended in time. */
function stopRun(session: Session, then: () => void): Promise<boolean> {
  const key = session.key;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      endings.delete(key);
      resolve(false);
    }, REOPEN_WAIT);
    endings.set(key, () => {
      clearTimeout(timer);
      then();
      resolve(true);
    });
    if (session.kind === "integrated") haltIntegrated(session);
    else if (session.ptyId !== null) void quitTerminal(session, session.ptyId);
    else runEnded(key);
  });
}

/**
 * Ends a terminal session's process for a reopen. Claude Code writes down
 * the mode it runs in as it shuts down, and a resume reads it back, so it
 * is quit as the user would quit it, with Ctrl+C a press at a time, rather
 * than killed: a kill on Windows leaves it no time to. One still there
 * after the presses is hung up on, and any other agent is at once.
 */
async function quitTerminal(session: Session, pty: string) {
  const key = session.key;
  // This reopen's own wait, so a press never reaches another's run.
  const ours = endings.get(key);
  const waiting = () => ours !== undefined && endings.get(key) === ours;
  if (session.agent === "claude-code")
    for (let press = 0; press < QUIT_PRESSES && waiting(); press++) {
      await core()
        .write(pty, "\x03")
        .catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, QUIT_GAP));
    }
  if (!waiting()) return;
  core()
    .kill(pty)
    .catch(() => runEnded(key));
}

/** Closes a row. Its shells go with it, unless they are kept for the row
    that takes its place: see `handOver`. */
export function close(key: string, keepShells = false) {
  const session = byKey(key);
  if (session === null) return;
  runUp(key);
  endings.delete(key);
  bringingBack.delete(key);
  if (session.kind === "integrated") stopIntegrated(session);

  if (session.ptyId !== null) {
    const ptyId = session.ptyId;
    // Its end, heard once the row has gone, still says whether the agent
    // wrote down the mode it ran in.
    if (session.id !== null) closedRuns.set(ptyId, session.id);
    // A kill that fails is a process that is already gone.
    core()
      .kill(ptyId)
      .catch(() => closedRuns.delete(ptyId));
    // Cleared before the row goes, so the terminal's own teardown does not
    // kill the same pty a second time on its way out. That teardown still
    // matters for the case it is there for: the whole pane going away with
    // sessions still live.
    session.ptyId = null;
  }

  const pulse = pulses.get(key);
  if (pulse?.quiet) clearTimeout(pulse.quiet);
  pulses.delete(key);
  rested.delete(key);
  bulleted.delete(key);
  const still = stills.get(key);
  if (still !== undefined) clearTimeout(still);
  stills.delete(key);
  interrupts.delete(key);
  answered.delete(key);
  worded.delete(key);
  closing(session);

  // The browser tabs opened for the session go with the row.
  void closeOwner({ kind: "session", key });

  const at = sessions.all.indexOf(session);
  sessions.all.splice(at, 1);
  // The row is gone, so its transcript is history again.
  if (session.id !== null) loadHistory(session.project);
  ownerGone(key);

  if (sessions.active === key) {
    // Prefer another session in the same project, so closing one does not
    // throw you into a different project's work.
    const sibling = forProject(session.project)[0] ?? sessions.all[0] ?? null;
    sessions.active = sibling?.key ?? null;
  }
  // The shells opened beside the session go with the row, once whoever is
  // shown next is chosen.
  if (!keepShells) void closeShells(key);
}

export function closeProject(project: string) {
  for (const session of forProject(project)) close(session.key);
}

/**
 * Whether opening this project should start a session without being asked.
 *
 * Only when it has none at all. A project you return to keeps the sessions it
 * had, and a session that stopped stays stopped until you say otherwise.
 */
export function statusMessage(session: Session): string {
  switch (session.status) {
    case "dormant":
      return "Starts when selected.";
    case "starting":
      return "Starting…";
    case "running":
      return "Running.";
    case "exited":
      return "The session ended.";
    case "crashed":
      return session.exitCode === null
        ? "The session was stopped."
        : `The session exited with code ${session.exitCode}.`;
    case "failed":
      return session.error ?? "The session could not be started.";
  }
}

/** The word shown in the pane header. */
export function statusLabel(session: Session | null): string {
  if (session === null) return "no session";
  // A session whose workflow is lost has not started: it waits on the
  // user to say how it goes on.
  if (session.workflowLost !== null) return "waiting for your choice";
  switch (session.status) {
    case "dormant":
      return "was open, starts when selected";
    case "starting":
      return "starting";
    case "running":
      if (session.needs === "permission") return "needs permission";
      // At rest is idle where the app knows the turn ended: an integrated
      // session's events say so, and so do the hooks of a terminal session
      // they report the turns of. Where activity is guessed, it is running.
      return session.working
        ? "working"
        : session.unread
          ? "waiting for you"
          : session.kind === "integrated" || (session.exact && session.agent !== "codex")
            ? "idle"
            : "running";
    case "exited":
      return "ended";
    default:
      return "stopped";
  }
}

/**
 * Claude Code activity, read off the pty. Codex uses rollout turn events.
 *
 * An agent at work streams: its spinner and its text keep bytes flowing for
 * seconds on end. An agent waiting shows a still screen, give or take a
 * redraw, and a redraw is one burst: a footer's clock ticking over, a
 * status line changing. So "working" is more than a redraw's worth of bytes
 * in each of three seconds running, and "waiting" is two seconds after the
 * last such second, a redraw or two in them notwithstanding. Nothing counts until the agent has been sent a line or a
 * minute has passed since it came up: an agent starting draws plenty, its
 * spinner while it connects most of all, and none of it is work. A session
 * that goes quiet while nobody is looking at it, or rings for attention,
 * is unread until someone does.
 *
 * An idle agent keeps house by itself: Claude Code writes a recap of the
 * conversation while the user is away and compacts a long one before its
 * cache expires, each under a spinner for seconds on end. What it draws for
 * a turn of its own, a reply or a call to a tool, comes after a bullet; a
 * recap and a compaction draw none of their own. So once the user has read
 * a session at rest, a spell of output nobody sent a line for is work only
 * when it draws a bullet. That holds only in a terminal whose turns have
 * been seen to draw one: anywhere else every such spell is work, so that a
 * Claude Code drawing some other glyph loses no turn. What output cannot
 * tell apart: a recap or compaction that moves the conversation on a full
 * screen draws the bullets already on it again, and is taken for work, and
 * a turn with less than three seconds of output is never seen. The hooks
 * report every turn, one the agent starts by itself included.
 */

/** The bullet Claude Code draws before what it says or does in a turn:
    one glyph on macOS and another elsewhere, in UTF-8. */
const BULLETS = [
  [0xe2, 0x8f, 0xba],
  [0xe2, 0x97, 0x8f],
];

/** Whether a chunk of a Claude Code terminal's output draws a turn's
    bullet. */
export function drawsTurn(bytes: Uint8Array): boolean {
  for (let at = 0; at + 2 < bytes.length; at++) {
    if (bytes[at] !== 0xe2) continue;
    for (const [, second, third] of BULLETS)
      if (bytes[at + 1] === second && bytes[at + 2] === third) return true;
  }
  return false;
}

/** Watches one terminal's output for a turn's bullet. A read of the pty
    may cut the glyph in two, so each chunk is looked at together with the
    last two bytes of the one before it. */
export function bulletWatch(): (bytes: Uint8Array) => boolean {
  let tail = new Uint8Array(0);
  return (bytes) => {
    const seam = new Uint8Array(tail.length + Math.min(2, bytes.length));
    seam.set(tail);
    seam.set(bytes.subarray(0, 2), tail.length);
    tail = bytes.length >= 2 ? bytes.slice(-2) : seam.slice(-2);
    return drawsTurn(seam) || drawsTurn(bytes);
  };
}

/** Quiet this long after output is the agent waiting. */
export const QUIET_MS = 2000;
/** With the hooks saying, quiet this long after the user's Escape or
    Ctrl+C while they say working is the turn having ended without them:
    stopping a turn fires no hook. Without such a key a still screen ends
    nothing: an agent at work on a long command, or thinking, draws only
    its spinner's clock for minutes on end. */
export const QUIET_EXACT_MS = 5000;
/** Output within a second below this is a redraw, not work. */
export const WORK_BYTES = 256;
/** Seconds running with more than a redraw each before it is work. */
export const WORK_WINDOWS = 3;
/** How long after the process comes up its output is start-up, not work,
    unless the user has sent it a line. */
export const GRACE_MS = 60_000;
const WINDOW_MS = 1000;

interface Pulse {
  bytes: number;
  windowStart: number;
  /** Windows before this one that were busy, without a quiet one between. */
  run: number;
  quiet: ReturnType<typeof setTimeout> | null;
  /** Whether this spell of output has drawn a turn's bullet, counting the
      second just before it. */
  said: boolean;
  /** Whether this second has drawn one. */
  saidNow: boolean;
}

const pulses = new Map<string, Pulse>();

/** The sessions whose turns have been seen to draw a bullet, by the row's
    key: in these alone a spell of output without one is housekeeping. */
const bulleted = new Set<string>();

/** The sessions the user has read at rest, neither working nor asking,
    with nothing new from the agent since, by the row's key. A reminder of
    what was read, an idle notice or a bell after a stop, marks none of
    them. */
const rested = new Set<string>();

function atRest(session: Session): boolean {
  return !session.working && session.needs === null;
}

/** The agent, or someone speaking to it, has done something new: what the
    user read of it is no longer all there is. What the run a reopen stops
    does on its way out is not new. */
function stirred(session: Session) {
  if (reopening.has(session.key)) return;
  rested.delete(session.key);
}

/** Whether the session is the one on screen, in a window that is looked at. */
export function isViewed(session: Session): boolean {
  return attention.focused && sessions.active === session.key;
}

/** When the user last pressed a key in each session's terminal, by the
    row's key. */
const pressed = new Map<string, number>();
/** The last two characters of the user's keys in each session's terminal,
    by the row's key: whether the last was an Enter that sends the line. */
const lastKeys = new Map<string, string>();
/** The sessions whose terminal the user's keys may have left words in, by
    the row's key: typed into since the agent last took a line in, as its
    prompt hook says, or since Ctrl+C emptied the line. Enter is no sign the
    line went: Ctrl+J, a backslash before Enter and Alt+Enter each add a
    newline to the agent's input, Ctrl+U empties only the current line of
    several, and a command such as /config opens a panel the next keys
    would answer, with no prompt hook for any of them. */
const drafts = $state<Record<string, true>>({});
/** The sessions whose terminal line holds words the user typed, by the
    row's key: Ctrl+C there empties the line, and stops no turn. Narrower
    than a draft, which any key may leave: only printable keys count. */
const worded = new Set<string>();

/** What a terminal sends on its own, which is no key of the user's: focus
    going in or out, and the mouse. */
// eslint-disable-next-line no-control-regex
const REPORT = /^\x1b\[(?:I|O|M|<)/;
/** The terminal's replies to what the agent asks of it, each sent whole:
    its attributes (`ESC[?1;2c`), status (`ESC[0n`), cursor position
    (`ESC[1;1R`), window size (`ESC[8;24;80t`), keyboard flags
    (`ESC[?0u`), a mode (`ESC[?2004;1$y`), and a setting, its version or a
    colour (DCS and OSC). Claude Code asks for its attributes as it starts,
    and Codex for its cursor as it starts and on every resize. No key sends
    any of these but Ctrl+F3, in the shape of a cursor report, which is
    taken for one and so holds no wake. */
const REPLY =
  // eslint-disable-next-line no-control-regex
  /^(?:\x1b\[[?>=]?[\d;]*[cnRt]|\x1b\[\?[\d;]*u|\x1b\[\??[\d;]*\$y|\x1bP[^\x1b]*\x1b\\|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/;
/** Ctrl+C, which empties the agent's input or closes what it has open. */
const EMPTIES = "\x03";
/** The keys that stop the turn an agent in a terminal is taking, sent
    alone: Escape and Ctrl+C. */
const INTERRUPTS = new Set(["\x1b", "\x03"]);

/** The user typed into a pty. A line sent is the agent spoken to: from
    then on what it writes back can be work. A key while the agent asks
    for a permission answers that prompt, and leaves nothing on the line:
    the window hears no hook when the prompt closes, so the keys after it,
    once the agent is seen at work again, are the line's as ever. Escape, or
    Ctrl+C on an empty line, while the hooks say a turn runs may stop it,
    which no hook reports: from that key on, the screen going still ends
    the turn. Ctrl+C with words on the line only empties it. At Claude
    Code's permission prompt Escape is its No, which stops the turn the
    same way; a digit or Enter may be a yes or a no, and the screen says
    which once it is still. */
export function typed(ptyId: string, data: string) {
  const session = sessions.all.find((candidate) => candidate.ptyId === ptyId);
  if (session === undefined) return;
  if (REPORT.test(data) || REPLY.test(data)) return;
  if (data.includes("\r") || data.includes("\n")) {
    session.engaged = true;
    stirred(session);
  }
  pressed.set(session.key, Date.now());
  const hooked = session.exact && session.agent !== "codex";
  if (hooked && session.needs === "permission") {
    if (data === "\x1b") interrupts.add(session.key);
    else answered.add(session.key);
    stillLater(session);
  } else if (
    hooked &&
    INTERRUPTS.has(data) &&
    !(data === EMPTIES && worded.has(session.key)) &&
    session.working &&
    session.needs === null &&
    !session.delegated
  ) {
    interrupts.add(session.key);
    stillLater(session);
  }
  if (session.needs !== null) return;
  // Words typed are on the line until Ctrl+C empties it or an Enter that
  // sends takes it in; Escape, the arrows and a paste's brackets are none.
  const before = lastKeys.get(session.key) ?? "";
  if (data === EMPTIES || (data === "\r" && !before.endsWith("\\"))) worded.delete(session.key);
  // eslint-disable-next-line no-control-regex
  else if (/[^\x00-\x1f\x7f]/u.test(data.replace(/\x1b(?:\[[\d;?]*[~A-Za-z]|O.|.)?/g, "")))
    worded.add(session.key);
  lastKeys.set(session.key, ((lastKeys.get(session.key) ?? "") + data).slice(-2));
  if (data.endsWith(EMPTIES)) delete drafts[session.key];
  else drafts[session.key] = true;
}

/** The workbench typed a line into a pty and sent it, as `send` does: the
    agent has been spoken to, by no key of the user's, and how its last
    turn ended no longer says it is idle. A line that sets off no prompt
    hook, a command such as /config, leaves that unknown until a turn of
    the agent's ends. */
export function spokenTo(ptyId: string) {
  const session = sessions.all.find((candidate) => candidate.ptyId === ptyId);
  if (session === undefined) return;
  session.engaged = true;
  session.turnEnd = null;
  stirred(session);
}

/** The agent in a terminal took a line in, as its prompt hook says. The
    user's keys have left nothing on its line when the last of them was an
    Enter that sends, not one after a backslash or Escape, which adds a
    newline. */
function tookLine(key: string) {
  const last = lastKeys.get(key);
  // eslint-disable-next-line no-control-regex
  if (last === undefined || (last.endsWith("\r") && !/[\\\x1b]\r$/.test(last))) delete drafts[key];
  worded.delete(key);
}

/** Whether the user's keys may have left words on a session's terminal
    line that they have not sent. */
export function drafting(key: string): boolean {
  return drafts[key] === true;
}

/** How long until the user's keys in a session's terminal have been still
    for `quiet` milliseconds: nothing once they have. */
export function keysStillIn(key: string, quiet: number, now = Date.now()): number {
  const at = pressed.get(key);
  return at === undefined ? 0 : Math.max(0, at + quiet - now);
}

/** Bytes arrived for a session, and whether they draw a turn's bullet. */
export function output(key: string, bytes: number, now = Date.now(), said = false) {
  const session = byKey(key);
  if (session === null) return;
  // Codex reports turn boundaries in its rollout. Output is only needed
  // to notice activity after a permission request.
  if (session.agent === "codex" && session.needs === null) return;
  if (!session.exact && !session.engaged) {
    if (session.startedAt === null || now - session.startedAt < GRACE_MS)
      return;
    session.engaged = true;
  }
  const pulse = counted(key, bytes, now);
  // This second holds more than a redraw. Only such a second says anything:
  // a footer ticking over or a cursor blinking under a still screen is a
  // few bytes now and then, and holds nothing back.
  const work = pulse.bytes >= WORK_BYTES;
  if (session.exact) {
    // The hooks say when it starts and stops. Output still says two things
    // they do not: a permission was granted and the agent went on, and,
    // after the user's Escape or Ctrl+C, a turn they cut short is over,
    // which is the screen going still while the hooks still say working.
    // Without that key a still screen is the agent at work on something
    // that draws nothing but its spinner's clock.
    if (session.needs !== null && work) {
      session.needs = null;
      session.working = true;
      stirred(session);
      changed(session);
    }
    if ((interrupts.has(key) || answered.has(key)) && session.working && work) stillLater(session);
    return;
  }
  if (said) {
    pulse.said = true;
    pulse.saidNow = true;
  }
  // Read at rest, the agent at work unasked is a turn of its own only once
  // it draws a turn's bullet, where its turns are known to; until then it
  // is keeping house.
  const turn = pulse.said || !rested.has(key) || !bulleted.has(key);
  if (work && pulse.run >= WORK_WINDOWS - 1 && !session.working && turn) {
    session.working = true;
    session.turns += 1;
    // What an earlier turn left is no longer the session's latest line.
    session.notice = null;
    stirred(session);
    changed(session);
  }
  if (session.working && pulse.said) bulleted.add(key);
  if (!work) return;
  if (pulse.quiet !== null) clearTimeout(pulse.quiet);
  pulse.quiet = setTimeout(() => settle(key), QUIET_MS);
}

/** The bytes added to the second they fall in, and the second before
    closed: a busy one followed directly by this one extends the run, and a
    whole second of quiet between them ends it. */
function counted(key: string, bytes: number, now: number): Pulse {
  let pulse = pulses.get(key);
  if (pulse === undefined) {
    pulse = { bytes: 0, windowStart: now, run: 0, quiet: null, said: false, saidNow: false };
    pulses.set(key, pulse);
  }
  if (now - pulse.windowStart > WINDOW_MS) {
    const followed = now - pulse.windowStart < 2 * WINDOW_MS;
    const goesOn = followed && pulse.bytes >= WORK_BYTES;
    pulse.run = goesOn ? pulse.run + 1 : 0;
    // A spell ends at a quiet second, and what it drew with it, but for a
    // bullet in that second when the next follows at once.
    if (!goesOn) pulse.said = followed && pulse.saidNow;
    pulse.saidNow = false;
    pulse.bytes = 0;
    pulse.windowStart = now;
  }
  pulse.bytes += bytes;
  return pulse;
}

/** Starts, or starts over, the clock that ends a hooked session's turn
    as cut short once its screen has gone still after the user's Escape or
    Ctrl+C. */
function stillLater(session: Session) {
  const held = stills.get(session.key);
  if (held !== undefined) clearTimeout(held);
  stills.set(
    session.key,
    setTimeout(() => {
      stills.delete(session.key);
      const now = byKey(session.key);
      if (now === null || !now.exact) return;
      const key = now.key;
      const drawn = answered.has(key) ? screen(key, SCREEN_TAIL) : null;
      const stopped =
        interrupts.has(key) || (drawn !== null && interruptedOnScreen(drawn.split("\n")));
      interrupts.delete(key);
      answered.delete(key);
      if (!stopped || (!now.working && now.needs === null)) return;
      now.working = false;
      now.needs = null;
      now.turnEnd = "cut";
      changed(now);
      unseen(now);
    }, QUIET_EXACT_MS),
  );
}

const stills = new Map<string, ReturnType<typeof setTimeout>>();
/** The hooked sessions the user pressed Escape, or Ctrl+C on an empty
    line, in while their hooks said a turn ran or at its permission prompt,
    by the row's key, until the next hook says what happened or the screen
    going still says the turn was stopped. */
const interrupts = new Set<string>();
/** The hooked sessions whose permission prompt the user answered with a
    key that may be a yes or a no, by the row's key, until the next hook
    says what happened or the still screen shows the turn stopped or not. */
const answered = new Set<string>();
/** How many of the last lines on a session's screen are read for the line
    Claude Code draws under a turn the user stopped. */
const SCREEN_TAIL = 16;

/** The agent went quiet: it is waiting, and unread unless watched stop. */
function settle(key: string) {
  const session = byKey(key);
  const pulse = pulses.get(key);
  if (pulse !== undefined) {
    pulse.quiet = null;
    pulse.bytes = 0;
    pulse.run = 0;
    pulse.said = false;
    pulse.saidNow = false;
  }
  if (session === null || !session.working) return;
  session.working = false;
  changed(session);
  unseen(session);
}

let waiting: ((session: Session) => void) | null = null;

/** Who is told when a session starts waiting for the user: it was read,
    and something nobody saw has made it unread. */
export function onWaiting(handler: ((session: Session) => void) | null) {
  waiting = handler;
}

let turning: (session: Session) => void = () => {};

/** Who is told when a session's agent begins a turn, as its hooks or its
    events say. */
export function onTurn(handler: ((session: Session) => void) | null) {
  turning = handler ?? (() => {});
}

/** A session's agent began a turn: what ended the last one is past. */
export function beganTurn(session: Session) {
  session.turns += 1;
  session.failure = null;
  session.background = [];
  turning(session);
}

let directed: (session: Session) => boolean = () => false;

/** Who says whether another session answers for a session: one an
    orchestrator started is that session's to hear, and waits on the user
    only for a permission, which no agent can grant for it. */
export function onDirected(handler: ((session: Session) => boolean) | null) {
  directed = handler ?? (() => false);
}

/** Something happened that nobody saw: the session is unread until it is
    looked at. One already unread is still waiting, and is not news unless
    what happened is: an ask for a permission is, whatever came before it.
    A session another session answers for is unread for a permission and
    nothing else: a stop, an ending, a bell or a line left are its
    director's to hear. A reminder, a sign that only says again that the
    agent waits, marks nothing the user has read at rest since. Seen at
    rest, the session is read so. A row being reopened the other way takes
    no mark, and keeps what was read of it. */
function unseen(session: Session, asking = false, reminder = false) {
  if (reopening.has(session.key)) return;
  if (isViewed(session)) {
    if (atRest(session)) rested.add(session.key);
    return;
  }
  if (reminder && rested.has(session.key)) return;
  rested.delete(session.key);
  if (!asking && directed(session)) return;
  // A mark the user made is no news to the user, so the first thing that
  // happens over it is, and brings its own line rather than the mark's.
  const mark = marks.get(session.key);
  const news = asking || !session.unread || (mark !== undefined && !mark.heard);
  if (mark !== undefined) {
    newsOverMark(session);
    mark.heard = true;
    marksChanged();
  }
  session.unread = true;
  if (!news) return;
  changed(session);
  waiting?.(session);
}

/** The agent wants the user, whatever else is going on: an integrated
    session asks, comes to rest after a turn, or ends. Heard in a focused
    window on this session, it needs no mark. */
export function rang(key: string) {
  const session = byKey(key);
  if (session === null) return;
  unseen(session);
}

/** A terminal rang its bell, or was sent a notification. While the agent
    works or asks it is news. At rest it may only say again that the agent
    waits, as Claude Code's idle notice does when it is set to ring: where
    the hooks report the agent's turns, a session read at rest since takes
    no mark from it. Without them it is news, as it may be the only sign of
    a turn too short for its output to show. */
export function belled(key: string) {
  const session = byKey(key);
  if (session === null) return;
  unseen(session, false, session.exact && atRest(session));
}

/** The user looked: the session is on screen in a focused window. A
    session the user marked unread while it was on screen, or that the
    restore put on screen unread, stays so until another is put on screen
    and it comes back. */
export function viewed(key: string) {
  if (markedOnScreen === key) return;
  const session = byKey(key);
  if (session === null) return;
  read(session);
  if (atRest(session)) rested.add(key);
}

/** The session is read: by a look, by Mark as read, or by the user
    writing to it. A mark on it ends, and so does its hold. */
function read(session: Session) {
  if (session.unread) changed(session);
  session.unread = false;
  session.note = null;
  if (marks.delete(session.key)) marksChanged();
  letGo(session.key);
}

/** A row held on screen is no longer: it was read, or the user moved on. */
function letGo(key: string) {
  if (markedOnScreen === key) markedOnScreen = null;
}

/** A mark the user made: the line it put back under the name, while that
    line is still shown, and whether anything new has been announced over
    it since. */
interface Mark {
  restored: string | null;
  heard: boolean;
}

/** The sessions the user marked unread, by the row's key. A mark lasts
    while the user stays in the session or goes to another, and through
    whatever the agent, or a session directing it, does meanwhile. It ends
    when the user comes back to the session, writes to it, or marks it
    read. */
const marks = new Map<string, Mark>();
/** The session held on screen unread: one the user marked unread while it
    was on screen, or one the restore put there unread. It is held while it
    stays unread and until another session, or none, is put on screen.
    Looking at it meanwhile reads nothing. */
let markedOnScreen: string | null = null;

/** Something new comes over a mark: the line the mark put back is the
    mark's, not the agent's, and makes way for whatever line comes now. */
function newsOverMark(session: Session) {
  const mark = marks.get(session.key);
  if (mark === undefined || mark.restored === null) return;
  if (session.note === mark.restored) session.note = null;
  mark.restored = null;
  marksChanged();
}

/** The agent is about to leave a line, or say it is done, over a mark:
    the line the mark put back gives way first. */
export function lineComing(key: string) {
  const session = byKey(key);
  if (session !== null) newsOverMark(session);
}

/** The user wrote to the session: it is read, and a mark on it ends. */
export function userWrote(key: string) {
  const session = byKey(key);
  if (session !== null) read(session);
}

/** The session on screen is now this one, or none: a mark held on
    another is let go, so coming back to it reads it. Called whatever the
    window's focus, since leaving the window is not leaving the session. */
export function onScreenNow(key: string | null) {
  if (markedOnScreen !== key) markedOnScreen = null;
}

/** The user marks a session unread: drawn as one that went unread by
    itself, with the line it last showed under its name, and counted
    wherever unread sessions are, until the user next opens it. The user
    did it, so nothing is said of it: no notification and no chime. */
export function markUnread(key: string) {
  const session = byKey(key);
  if (session === null || session.unread) return;
  session.unread = true;
  const restored = session.note === null ? session.notice : null;
  if (restored !== null) session.note = restored;
  marks.set(key, { restored, heard: false });
  marksChanged();
  if (sessions.active === key) markedOnScreen = key;
}

/** The user marks a session read, as if it had been looked at. */
export function markRead(key: string) {
  const session = byKey(key);
  if (session === null) return;
  read(session);
  if (atRest(session)) rested.add(key);
}

/** The line the row shows under the name, kept as its notice too. */
function leaveLine(session: Session, line: string) {
  session.note = line;
  session.notice = line;
}

/** A new turn begins: the line the last one left, and its notice, are
    stale. */
export function newTurnLine(session: Session) {
  session.note = null;
  session.notice = null;
}

/** The agent left a line for the row: shown under the name, and the row
    wants attention, until someone looks. A line the run a reopen stops
    leaves on its way out is not left for the user. */
export function noted(key: string, text: string) {
  const session = byKey(key);
  if (session === null || reopening.has(key)) return;
  newsOverMark(session);
  leaveLine(session, shown(text));
  unseen(session);
}

// Only the latest transition matters when identification catches up. The
// bound also covers hooks from sessions outside this window, and so does
// the age: a row learns its id within seconds of its start, so a
// transition older than that is a session run elsewhere, which a resume of
// it here must not take for news.
const pendingActivity = new Map<
  string,
  {
    kind: SessionEvent["kind"];
    note: string | null;
    cut: boolean;
    more: TurnEnding;
    at: number;
  }
>();

/** What a hook says beside a turn's end: the kind of error a failed turn
    ended on, and the tasks a stop left running in the background. */
export interface TurnEnding {
  error?: string | null;
  background?: string[];
  /** The permission mode the hook says the agent runs in. */
  mode?: string | null;
}

/** How long a transition waits for its row to learn the session's id. */
export const PENDING_FOR = 30_000;

function replayActivity(sessionId: string) {
  const pending = pendingActivity.get(sessionId);
  pendingActivity.delete(sessionId);
  if (pending !== undefined && Date.now() - pending.at < PENDING_FOR)
    exact(sessionId, pending.kind, pending.note, pending.cut, pending.more);
}

/** A hook or rollout reports a turn transition. With a stop comes the
    first line of what the agent said, which the row takes when the agent
    left no line of its own through its notify tool, whether the user cut
    the turn short, and the tasks it left running. With a failed turn
    come the error's kind and the line the agent showed for it. */
export function exact(
  sessionId: string,
  kind: SessionEvent["kind"],
  note: string | null = null,
  cut = false,
  more: TurnEnding = {},
) {
  // An integrated session's state comes from its own events, and the
  // hooks that fire for it are left alone.
  if (sessions.all.some((candidate) => candidate.id === sessionId && candidate.kind === "integrated"))
    return;
  const session = sessions.all.find(
    (candidate) =>
      candidate.id === sessionId &&
      (candidate.status === "running" || candidate.status === "starting"),
  );
  if (session === undefined) {
    if (sessions.all.some((candidate) => candidate.id === sessionId)) return;
    pendingActivity.delete(sessionId);
    pendingActivity.set(sessionId, { kind, note, cut, more, at: Date.now() });
    if (pendingActivity.size > 256)
      pendingActivity.delete(pendingActivity.keys().next().value!);
    return;
  }
  session.exact = true;
  const pulse = pulses.get(session.key);
  if (pulse?.quiet) clearTimeout(pulse.quiet);
  pulses.delete(session.key);
  const still = stills.get(session.key);
  if (still !== undefined) clearTimeout(still);
  stills.delete(session.key);
  // The hooks have spoken since the user's Escape or Ctrl+C: what it did
  // is theirs to say.
  interrupts.delete(session.key);
  if (typeof more.mode === "string" && more.mode !== "") {
    // A mode the terminal switched to once its run had said the one it
    // began in narrows what the agent's next sessions begin in, and never
    // widens it. The mode it began in, whether its settings', one it fell
    // back to or one its starter gave it, is no switch at all.
    if (session.modeSeen !== null && session.modeSeen !== more.mode) narrowTo(session.agent, more.mode);
    session.modeSeen = more.mode;
  }
  answered.delete(session.key);
  // The line a run that a reopen stops leaves on its way out is not left
  // for the user.
  const line = reopening.has(session.key) ? null : note;
  switch (kind) {
    case "prompt":
      session.working = true;
      session.needs = null;
      session.delegated = false;
      session.turnEnd = null;
      stirred(session);
      // A prompt typed by the user, who is looking at the session, reads
      // it. One that comes from elsewhere, as a director's does, leaves a
      // mark the user made as it is.
      if (isViewed(session)) read(session);
      else if (!marks.has(session.key)) {
        session.unread = false;
        letGo(session.key);
      } else newsOverMark(session);
      // A new turn: whatever line the last one left is stale.
      newTurnLine(session);
      tookLine(session.key);
      changed(session);
      beganTurn(session);
      break;
    case "stop":
      session.working = false;
      session.needs = null;
      session.delegated = false;
      // A turn Codex said the user cut short stays so, though its stop hook
      // calls the end a stop as well. Claude Code's stop after the screen
      // went still on an Escape is the agent's own end of the turn.
      session.turnEnd =
        cut || (session.turnEnd === "cut" && session.agent === "codex") ? "cut" : "done";
      session.failure = null;
      session.background = (more.background ?? []).map(shown);
      changed(session);
      newsOverMark(session);
      if (session.note === null && line !== null) leaveLine(session, shown(line));
      unseen(session);
      break;
    case "failed":
      // An error ended the turn, a usage limit among them, and the agent did
      // not: it is waiting, and how it stopped is said for what it is.
      session.working = false;
      session.needs = null;
      session.delegated = false;
      session.turnEnd = "failed";
      session.failure = failureOf(more.error ?? null, line === null ? null : shown(line));
      session.background = [];
      changed(session);
      newsOverMark(session);
      if (session.note === null && line !== null) leaveLine(session, shown(line));
      unseen(session);
      break;
    case "delegated": {
      // The turn ended, and the next starts when the subagents report:
      // the session is working throughout, and nothing is waiting for the
      // user. The line the agent left says what it is waiting on.
      const idle = !session.working;
      session.working = true;
      session.needs = null;
      session.delegated = true;
      stirred(session);
      if (idle) changed(session);
      newsOverMark(session);
      if (session.note === null && line !== null) leaveLine(session, shown(line));
      break;
    }
    case "permission": {
      const asking = session.needs !== "permission";
      session.working = false;
      session.needs = "permission";
      session.delegated = false;
      stirred(session);
      if (asking) changed(session);
      unseen(session, asking);
      break;
    }
    case "idle": {
      // An agent waiting long enough to say so is not working, whatever
      // was last heard: its subagents are gone, or it never had any. Then
      // the notice ends a turn. Otherwise it only says again what a stop
      // said: Claude Code sends it a minute after a turn ends, and again a
      // minute after each recap or compaction it does while idle.
      const ends = session.working;
      if (ends) {
        session.working = false;
        changed(session);
      }
      session.delegated = false;
      unseen(session, false, !ends);
      break;
    }
  }
}

/** How many sessions are waiting for the user. */
export function unreadCount(): number {
  return sessions.all.filter((session) => session.unread).length;
}

/**
 * What a session is doing, as a group, in the order the palette lists
 * them. A session needs you when it is asking, or stopped, ended or rang while nobody was
 * looking; it is working while its dot breathes, which for an orchestrator
 * may be a started session's work, so the caller says what at work is;
 * the rest are active, which is live and idle, or dormant.
 */
export type StatusGroup = "needs" | "working" | "active";

export const STATUS_GROUPS: { id: StatusGroup; title: string }[] = [
  { id: "needs", title: "Needs you" },
  { id: "working", title: "Working" },
  { id: "active", title: "Active" },
];

export function groupOf(
  session: Session,
  atWork: (session: Session) => boolean = (candidate) => candidate.working,
): StatusGroup {
  if (session.unread || session.needs === "permission") return "needs";
  if (isLive(session) && atWork(session)) return "working";
  return "active";
}

/** Every row, grouped by status and sorted within each group by when the
    row last changed, the latest first. A group with nothing in it is left
    out. */
export function byStatus(
  atWork?: (session: Session) => boolean,
): { id: StatusGroup; title: string; sessions: Session[] }[] {
  return STATUS_GROUPS.map((group) => ({
    ...group,
    sessions: sessions.all
      .filter((session) => groupOf(session, atWork) === group.id)
      .sort((a, b) => b.changedAt - a.changedAt),
  })).filter((group) => group.sessions.length > 0);
}

/** The sessions that need the user: those asking for a permission, and
    those that stopped, ended or rang while nobody looked. Askers come
    first, then the longest unchanged. The one on screen is included while
    it still needs the user. */
export function waitingOnYou(): Session[] {
  return sessions.all
    .filter((session) => groupOf(session) === "needs")
    .sort((a, b) => {
      const asking = Number(b.needs === "permission") - Number(a.needs === "permission");
      return asking !== 0 ? asking : a.changedAt - b.changedAt;
    });
}

/** The session after the one on screen in the order of `waitingOnYou`,
    wrapping round to the first. With the one on screen not among them it is
    the first. Null when none is left to go to. */
export function nextNeedingYou(): Session | null {
  const waiting = waitingOnYou();
  const at = waiting.findIndex((session) => session.key === sessions.active);
  const next = at === -1 ? waiting[0] : waiting[(at + 1) % waiting.length];
  return next === undefined || next.key === sessions.active ? null : next;
}

/** Test seam: the counter is module state and rows outlive a component. */
export function reset() {
  pendingActivity.clear();
  reopening.clear();
  quietly.clear();
  bringingBack.clear();
  endings.clear();
  closedRuns.clear();
  pressed.clear();
  lastKeys.clear();
  for (const key of Object.keys(drafts)) delete drafts[key];
  for (const still of stills.values()) clearTimeout(still);
  stills.clear();
  interrupts.clear();
  answered.clear();
  worded.clear();
  for (const pulse of pulses.values()) {
    if (pulse.quiet !== null) clearTimeout(pulse.quiet);
  }
  pulses.clear();
  rested.clear();
  marks.clear();
  waitingBack.clear();
  markedOnScreen = null;
  bulleted.clear();
  sessions.all = [];
  sessions.active = null;
  sessions.history = {};
  readFrom.clear();
  readings.clear();
  refreshing.clear();
  stopHistoryClock();
  watched = () => [];
  loading.clear();
  sessions.mine = {};
  sessions.names = {};
  sessions.tokens = {};
  sessions.workflows = {};
  pending.clear();
  sessions.preferred = {};
  sessions.pastSessions = "forever";
  counter = 0;
  ordinals = {};
  resetExits();
}
