import { core, type SessionEnded, type Transcript } from "$lib/core";
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

export type SessionStatus = "starting" | "running" | "exited" | "crashed" | "failed";

export interface Session {
  /** Stable for the lifetime of the row, unlike the pty id which only exists
      once the process is actually up. */
  key: string;
  /** The project this session belongs to, as an absolute path. */
  project: string;
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
  /** The repository root of `cwd`: the worktree the session is in, which
      is the project's own unless the agent has moved. */
  worktree: string | null;
  exitCode: number | null;
  error: string | null;
  /** Set once the terminal has been created, so it is only built once. */
  mounted: boolean;
}

const MINE_KEY = "workbench.mine";

export const sessions = $state({
  all: [] as Session[],
  active: null as string | null,
  /**
   * Sessions already on disk, by project path. Read from Claude Code's own
   * transcripts, so this is history rather than anything the window owns.
   */
  history: {} as Record<string, Transcript[]>,
  /**
   * Session ids this app has run, by project path. Claude Code keeps every
   * transcript for a directory in one place, whichever terminal it came from;
   * these are the ones that are ours to list first.
   */
  mine: {} as Record<string, string[]>,
});

export async function loadHistory(project: string) {
  try {
    sessions.history[project] = await core().transcripts(project);
  } catch {
    // No history is a shorter list, never an error.
    sessions.history[project] = [];
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

export function loadMine() {
  try {
    const raw = localStorage.getItem(MINE_KEY);
    if (raw === null) return;
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== "object" || stored === null) return;
    const mine: Record<string, string[]> = {};
    for (const [project, ids] of Object.entries(stored)) {
      if (Array.isArray(ids)) mine[project] = ids.filter((id): id is string => typeof id === "string");
    }
    sessions.mine = mine;
  } catch {
    // A corrupt entry is not worth a broken pane. Nothing is ours, then.
  }
}

/** Transcripts not already open as a row: the one a row was resumed from, or
    the one it has been writing since it started, is that row. */
function closed(project: string): Transcript[] {
  const known = sessions.history[project] ?? [];
  const open = new Set(
    forProject(project)
      .map((session) => session.id)
      .filter((id): id is string => id !== null),
  );
  return known.filter((transcript) => !open.has(transcript.id));
}

/** Past sessions this app ran, ready to resume. */
export function historyFor(project: string): Transcript[] {
  return closed(project).filter((transcript) => isMine(project, transcript.id));
}

/** Past sessions from outside the app: Claude Code run in a terminal in the
    same directory. Just as resumable, but not the first thing to show. */
export function outsideFor(project: string): Transcript[] {
  return closed(project).filter((transcript) => !isMine(project, transcript.id));
}

/**
 * What a past session is called. The title comes from a format documented as
 * internal and version-unstable, so a missing one falls back to when it last
 * moved rather than to an error.
 */
export function historyLabel(transcript: Transcript): string {
  if (transcript.title !== null && transcript.title !== "") return transcript.title;
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
  return sessions.all.find((session) => session.key === sessions.active) ?? null;
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
  title = title.replace(/\s*[-·|:]\s*claude(\s+code)?\s*$/iu, "");
  title = title.replace(/^claude(\s+code)?\s*[-·|:]\s*/iu, "");
  title = title.trim();
  if (title === "" || /^claude(\s+code)?$/iu.test(title)) return null;
  return title;
}

/** The agent set the terminal title: that is what the session is called. */
export function titled(key: string, raw: string) {
  const session = byKey(key);
  if (session === null) return;
  session.title = sessionTitle(raw);
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

/** Asks, every couple of seconds, where the active session is working. Cheap:
    one syscall on the core's side. Returns a stop function. */
export function followCwd(): () => void {
  const timer = setInterval(() => {
    const session = activeSession();
    if (session === null || session.ptyId === null || session.status !== "running") return;
    const { key, ptyId } = session;
    core()
      .ptyCwd(ptyId)
      .then((cwd) => located(key, cwd))
      .catch(() => {});
  }, CWD_POLL);
  return () => clearInterval(timer);
}

export function select(key: string) {
  if (byKey(key) !== null) sessions.active = key;
}

/**
 * Adds a session row and starts it. The row exists before the process does so
 * the pane has something to render while it comes up, and so a failure to
 * start has somewhere to be reported.
 */
export function create(project: string, resumedFrom: string | null = null): Session {
  ordinals[project] = (ordinals[project] ?? 0) + 1;
  const session: Session = {
    key: `s${++counter}`,
    project,
    ptyId: null,
    status: "starting",
    id: resumedFrom,
    resumedFrom,
    ordinal: ordinals[project],
    title: null,
    cwd: null,
    worktree: null,
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
        agent: "claude-code",
        project: session.project,
        session: session.resumedFrom ?? undefined,
        cols,
        rows,
      },
      onOutput,
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
export function started(key: string, ptyId: string, sessionId: string): boolean {
  const session = byKey(key);
  if (session === null) return false;
  session.ptyId = ptyId;
  session.id = sessionId;
  session.status = "running";
  adopt(session.project, sessionId);

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
  const session = sessions.all.find((candidate) => candidate.ptyId === event.id);
  if (session === undefined) return false;
  session.ptyId = null;
  session.exitCode = event.code;
  session.status = event.clean ? "exited" : "crashed";
  // The transcript is complete now, so the history it belongs in has moved.
  loadHistory(session.project);
  return true;
}

/** Closes a row for good, stopping it first if it is still going. */
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
export function shouldAutoStart(project: string | null): boolean {
  if (project === null || !isReady()) return false;
  return forProject(project).length === 0;
}

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
      return "running";
    case "exited":
      return "ended";
    default:
      return "stopped";
  }
}

/** Test seam: the counter is module state and rows outlive a component. */
export function reset() {
  sessions.all = [];
  sessions.active = null;
  sessions.history = {};
  sessions.mine = {};
  counter = 0;
  ordinals = {};
  resetExits();
}
