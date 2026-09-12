import {
  core,
  type AgentId,
  type SessionEnded,
  type SessionEvent,
  type Transcript,
} from "$lib/core";
import { AGENTS, installed } from "$lib/agent.svelte";
import { attention } from "$lib/attention.svelte";
import { isReady } from "$lib/agent.svelte";
import { claim, resetExits } from "$lib/exits";

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

export type SessionStatus =
  "starting" | "running" | "exited" | "crashed" | "failed";

export interface Session {
  /** Stable for the lifetime of the row, unlike the pty id which only exists
      once the process is actually up. */
  key: string;
  /** The project this session belongs to, as an absolute path. */
  project: string;
  /** Which agent is running in it. */
  agent: AgentId;
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
  /** The directory the process was last seen working in. */
  cwd: string | null;
  /** Where the agent was started when that is not the project: the
      worktree a resumed session belongs to. */
  startIn: string | null;
  /** The first prompt, when the session was started with one: another
      session's, given to the agent on its command line. */
  prompt: string | null;
  /** The repository root of `cwd`: the worktree the session is in, which
      is the project's own unless the agent has moved. */
  worktree: string | null;
  /** Whether the agent is doing something right now, read off the pty:
      output is flowing while it works, and the screen is still when it
      waits. */
  working: boolean;
  /** Whether output can mean work yet: the user has sent the agent a line,
      or it has been up long enough to have finished starting. Until then
      what it draws is its own start-up, spinners included. */
  engaged: boolean;
  /** When the process came up, for the start-up allowance. */
  startedAt: number | null;
  /** The agent stopped, or asked for attention, while nobody was looking.
      Cleared by looking. */
  unread: boolean;
  /** A line the agent left for the row, through its notify tool. Cleared
      by looking. */
  note: string | null;
  /** The agent's own hooks are reporting this session, so its transitions
      are exact and the pty heuristic stands down. */
  exact: boolean;
  /** What the agent is blocked on, when its hooks say so. */
  needs: "permission" | null;
  exitCode: number | null;
  error: string | null;
  /** Set once the terminal has been created, so it is only built once. */
  mounted: boolean;
}

const MINE_KEY = "workbench.mine";
const NAMES_KEY = "workbench.names";
const PREFERRED_KEY = "workbench.agents";

/** A past session, and whose it is. */
export type HistoryEntry = Transcript & { agent: AgentId };

export const sessions = $state({
  all: [] as Session[],
  active: null as string | null,
  /**
   * Sessions already on disk, by project path, from every agent's own index
   * of them: history rather than anything the window owns.
   */
  history: {} as Record<string, HistoryEntry[]>,
  /** The agent last started in each project: what the new-session row
      offers first. */
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
});

export async function loadHistory(project: string) {
  const lists = await Promise.all(
    AGENTS.map((agent) =>
      core()
        .transcripts(project, agent)
        .then((list) => list.map((transcript) => ({ ...transcript, agent })))
        // No history is a shorter list, never an error.
        .catch(() => [] as HistoryEntry[]),
    ),
  );
  // Listed once per id, as the newest: a session resumed from another
  // directory can be reported from more than one place.
  const newest = new Map<string, HistoryEntry>();
  for (const entry of lists.flat().sort((a, b) => b.modified - a.modified)) {
    if (!newest.has(entry.id)) newest.set(entry.id, entry);
  }
  sessions.history[project] = [...newest.values()];
}

/** The agent a new session in the project starts with: the one last started
    there, else the first one installed. */
export function defaultAgent(project: string): AgentId {
  const preferred = sessions.preferred[project];
  if (preferred !== undefined && installed().includes(preferred))
    return preferred;
  return installed()[0] ?? "claude-code";
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
function adopt(project: string, id: string) {
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

/** Past sessions this app ran, ready to resume. */
export function historyFor(project: string): HistoryEntry[] {
  return closed(project).filter((transcript) => isMine(project, transcript.id));
}

/** Past sessions from outside the app: an agent run in a terminal in the
    same directory. Just as resumable, but not the first thing to show. One
    agent's, or every agent's. */
export function outsideFor(
  project: string,
  agent: AgentId | null = null,
): HistoryEntry[] {
  return closed(project).filter(
    (transcript) =>
      !isMine(project, transcript.id) &&
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
  if (known !== undefined) return known;
  if (transcript.title !== null && transcript.title !== "")
    return transcript.title;
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

let counter = 0;
/** Next ordinal per project. Never reused, so labels never shift. */
let ordinals: Record<string, number> = {};

export function forProject(project: string): Session[] {
  return sessions.all.filter((session) => session.project === project);
}

export function activeSession(): Session | null {
  return (
    sessions.all.find((session) => session.key === sessions.active) ?? null
  );
}

export function byKey(key: string): Session | null {
  return sessions.all.find((session) => session.key === key) ?? null;
}

export function isLive(session: Session): boolean {
  return session.status === "starting" || session.status === "running";
}

export function liveCount(project: string): number {
  return forProject(project).filter(isLive).length;
}

/** A short label for the row: the resumed id, or its number in the project. */
export function label(session: Session): string {
  if (session.title !== null) return session.title;
  if (session.resumedFrom !== null) return session.resumedFrom.slice(0, 8);
  return `session ${session.ordinal}`;
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
  adopt(session.project, sessionId);
  if (title !== null) named(session.key, title);
}

/** The agent's index calls the session this. Taken as it is, unlike a
    terminal title, which carries the agent's own name around it. */
export function named(key: string, title: string) {
  const session = byKey(key);
  if (session === null || title === "") return;
  session.title = title;
  if (session.id !== null) rememberName(session.id, title);
}

/** The agent set the terminal title: that is what the session is called,
    now and when it is listed as a past session later. */
export function titled(key: string, raw: string) {
  const session = byKey(key);
  if (session === null) return;
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

const CWD_POLL = 2000;

/**
 * Asks, every couple of seconds, where the active session is working, and
 * what an agent that names sessions in its own index calls it now. Cheap:
 * one syscall and at most one small query on the core's side. Returns a
 * stop function.
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
    const { key, ptyId, agent, id } = session;
    core()
      .ptyCwd(ptyId)
      .then((cwd) => located(key, cwd))
      .catch(() => {});
    if (agent === "codex" && id !== null) {
      core()
        .sessionTitle(agent, id)
        .then((title) => {
          if (title !== null) named(key, title);
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
 */
export function create(
  project: string,
  resumedFrom: string | null = null,
  agent: AgentId = defaultAgent(project),
  startIn: string | null = null,
  prompt: string | null = null,
): Session {
  ordinals[project] = (ordinals[project] ?? 0) + 1;
  prefer(project, agent);
  const session: Session = {
    key: `s${++counter}`,
    project,
    agent,
    ptyId: null,
    status: "starting",
    id: resumedFrom,
    resumedFrom,
    ordinal: ordinals[project],
    // A resumed session keeps the name it had until the agent says otherwise.
    title: resumedFrom === null ? null : (sessions.names[resumedFrom] ?? null),
    cwd: null,
    startIn,
    prompt,
    worktree: null,
    working: false,
    engaged: false,
    startedAt: null,
    unread: false,
    note: null,
    exact: false,
    needs: null,
    exitCode: null,
    error: null,
    mounted: false,
  };
  sessions.all.push(session);
  // Return what the array holds, not what was handed to it: $state proxies the
  // object on the way in, and the original would be a stale copy whose
  // mutations nothing sees.
  const live = sessions.all[sessions.all.length - 1];
  sessions.active = live.key;
  return live;
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
  const session = byKey(key);
  if (session === null) return false;
  try {
    const { ptyId, sessionId } = await core().spawn(
      {
        agent: session.agent,
        project: session.project,
        cwd: session.startIn ?? undefined,
        session: session.resumedFrom ?? undefined,
        prompt: session.prompt ?? undefined,
        cols,
        rows,
      },
      (bytes) => {
        output(key, bytes.length);
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
    failed(key, String(error));
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
  if (sessionId !== null) {
    session.id = sessionId;
    adopt(session.project, sessionId);
  }

  const early = claim(ptyId);
  if (early !== undefined) ended(early);
  return true;
}

export function failed(key: string, error: string) {
  const session = byKey(key);
  if (session === null) return;
  session.ptyId = null;
  session.status = "failed";
  session.error = String(error);
}

/**
 * A session ended on its own. Anything but a clean zero reads as a crash, and
 * nothing restarts by itself: a broken install would otherwise become a loop
 * that burns CPU and hides the actual error.
 *
 * False when no row here has that pty: the exit is someone else's, or the
 * spawn result has not landed yet.
 */
export function ended(event: SessionEnded): boolean {
  const session = sessions.all.find(
    (candidate) => candidate.ptyId === event.id,
  );
  if (session === undefined) return false;
  session.ptyId = null;
  session.exitCode = event.code;
  session.status = event.clean ? "exited" : "crashed";
  // An ending is something to see too, and not a thing still working.
  session.working = false;
  if (!isViewed(session)) session.unread = true;
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

export function close(key: string) {
  const session = byKey(key);
  if (session === null) return;

  if (session.ptyId !== null) {
    // A kill that fails is a process that is already gone.
    core()
      .kill(session.ptyId)
      .catch(() => {});
    // Cleared before the row goes, so the terminal's own teardown does not
    // kill the same pty a second time on its way out. That teardown still
    // matters for the case it is there for: the whole pane going away with
    // sessions still live.
    session.ptyId = null;
  }

  const pulse = pulses.get(key);
  if (pulse?.quiet) clearTimeout(pulse.quiet);
  pulses.delete(key);

  const at = sessions.all.indexOf(session);
  sessions.all.splice(at, 1);
  // The row is gone, so its transcript is history again.
  if (session.id !== null) loadHistory(session.project);

  if (sessions.active !== key) return;
  // Prefer another session in the same project, so closing one does not throw
  // you into a different project's work.
  const sibling = forProject(session.project)[0] ?? sessions.all[0] ?? null;
  sessions.active = sibling?.key ?? null;
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
  switch (session.status) {
    case "starting":
      return "starting";
    case "running":
      if (session.needs === "permission") return "needs permission";
      return session.working
        ? "working"
        : session.unread
          ? "waiting for you"
          : "running";
    case "exited":
      return "ended";
    default:
      return "stopped";
  }
}

/**
 * Activity, read off the pty.
 *
 * An agent at work streams: its spinner and its text keep bytes flowing for
 * seconds on end. An agent waiting shows a still screen, give or take a
 * redraw, and a redraw is one burst: a footer's clock ticking over, a
 * status line changing. So "working" is more than a redraw's worth of bytes
 * in each of three seconds running, and "waiting" is two seconds of quiet
 * after that. Nothing counts until the user has sent the agent a line or a
 * minute has passed since it came up: an agent starting draws plenty, its
 * spinner while it connects most of all, and none of it is work. A session
 * that goes quiet while nobody is looking at it, or rings for attention,
 * is unread until someone does.
 */

/** Quiet this long after output is the agent waiting. */
export const QUIET_MS = 2000;
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
}

const pulses = new Map<string, Pulse>();

/** Whether the session is the one on screen, in a window that is looked at. */
export function isViewed(session: Session): boolean {
  return attention.focused && sessions.active === session.key;
}

/** The user typed into a pty. A line sent is the agent spoken to: from
    then on what it writes back can be work. */
export function typed(ptyId: string, data: string) {
  if (!data.includes("\r") && !data.includes("\n")) return;
  const session = sessions.all.find((candidate) => candidate.ptyId === ptyId);
  if (session !== undefined) session.engaged = true;
}

/** Bytes arrived for a session. */
export function output(key: string, bytes: number, now = Date.now()) {
  const session = byKey(key);
  if (session === null) return;
  if (session.exact) {
    // The hooks say when it starts and stops. Output still says one thing
    // they do not: a permission was granted and the agent went on.
    if (session.needs !== null && bytes >= WORK_BYTES) {
      session.needs = null;
      session.working = true;
    }
    return;
  }
  if (!session.engaged) {
    if (session.startedAt === null || now - session.startedAt < GRACE_MS)
      return;
    session.engaged = true;
  }
  let pulse = pulses.get(key);
  if (pulse === undefined) {
    pulse = { bytes: 0, windowStart: now, run: 0, quiet: null };
    pulses.set(key, pulse);
  }
  if (now - pulse.windowStart > WINDOW_MS) {
    // The window closed. A busy one followed directly by this one extends
    // the run; a whole window of quiet between them ends it.
    const followed = now - pulse.windowStart < 2 * WINDOW_MS;
    pulse.run = followed && pulse.bytes >= WORK_BYTES ? pulse.run + 1 : 0;
    pulse.bytes = 0;
    pulse.windowStart = now;
  }
  pulse.bytes += bytes;
  if (
    pulse.bytes >= WORK_BYTES &&
    pulse.run >= WORK_WINDOWS - 1 &&
    !session.working
  ) {
    session.working = true;
  }

  if (pulse.quiet !== null) clearTimeout(pulse.quiet);
  pulse.quiet = setTimeout(() => settle(key), QUIET_MS);
}

/** The agent went quiet: it is waiting, and unread unless watched stop. */
function settle(key: string) {
  const session = byKey(key);
  const pulse = pulses.get(key);
  if (pulse !== undefined) {
    pulse.quiet = null;
    pulse.bytes = 0;
    pulse.run = 0;
  }
  if (session === null || !session.working) return;
  session.working = false;
  if (!isViewed(session)) session.unread = true;
}

/** The agent rang the bell, or sent a notification: it wants the user,
    whatever else is going on. Heard in a focused window on this session,
    it needs no mark. */
export function rang(key: string) {
  const session = byKey(key);
  if (session === null) return;
  if (!isViewed(session)) session.unread = true;
}

/** The user looked: the session is on screen in a focused window. */
export function viewed(key: string) {
  const session = byKey(key);
  if (session === null) return;
  session.unread = false;
  session.note = null;
}

/** The agent left a line for the row: shown under the name, and the row
    wants attention, until someone looks. */
export function noted(key: string, text: string) {
  const session = byKey(key);
  if (session === null) return;
  session.note = text;
  if (!isViewed(session)) session.unread = true;
}

/**
 * One of the agent's own hooks fired. From here on the session's transitions
 * are exact: the heuristic stands down for it. A prompt is the user at the
 * keyboard, so it reads the session as well as starting it.
 */
export function exact(sessionId: string, kind: SessionEvent["kind"]) {
  const session = sessions.all.find((candidate) => candidate.id === sessionId);
  if (session === undefined) return;
  session.exact = true;
  const pulse = pulses.get(session.key);
  if (pulse?.quiet) clearTimeout(pulse.quiet);
  pulses.delete(session.key);
  switch (kind) {
    case "prompt":
      session.working = true;
      session.needs = null;
      session.unread = false;
      break;
    case "stop":
      session.working = false;
      session.needs = null;
      if (!isViewed(session)) session.unread = true;
      break;
    case "permission":
      session.working = false;
      session.needs = "permission";
      if (!isViewed(session)) session.unread = true;
      break;
    case "idle":
      if (!isViewed(session)) session.unread = true;
      break;
  }
}

/** How many sessions are waiting for the user. */
export function unreadCount(): number {
  return sessions.all.filter((session) => session.unread).length;
}

/** Test seam: the counter is module state and rows outlive a component. */
export function reset() {
  for (const pulse of pulses.values()) {
    if (pulse.quiet !== null) clearTimeout(pulse.quiet);
  }
  pulses.clear();
  sessions.all = [];
  sessions.active = null;
  sessions.history = {};
  sessions.mine = {};
  sessions.names = {};
  sessions.preferred = {};
  counter = 0;
  ordinals = {};
  resetExits();
}
