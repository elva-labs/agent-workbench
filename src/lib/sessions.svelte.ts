import { core, type SessionEnded, type Transcript } from "$lib/core";
import { isReady } from "$lib/agent.svelte";

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
  /** A Claude Code session id, when this one was resumed from a transcript. */
  resumedFrom: string | null;
  exitCode: number | null;
  error: string | null;
  /** Set once the terminal has been created, so it is only built once. */
  mounted: boolean;
}

export const sessions = $state({
  all: [] as Session[],
  active: null as string | null,
  /**
   * Sessions already on disk, by project path. Read from Claude Code's own
   * transcripts, so this is history rather than anything the window owns.
   */
  history: {} as Record<string, Transcript[]>,
});

export async function loadHistory(project: string) {
  try {
    sessions.history[project] = await core().transcripts(project);
  } catch {
    // No history is a shorter list, never an error.
    sessions.history[project] = [];
  }
}

export function historyFor(project: string): Transcript[] {
  const known = sessions.history[project] ?? [];
  // A transcript already open as a live session is that session, not a
  // separate row to resume.
  const resumed = new Set(
    forProject(project)
      .map((session) => session.resumedFrom)
      .filter((id): id is string => id !== null),
  );
  return known.filter((transcript) => !resumed.has(transcript.id));
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

/** A short label for the row: the resumed id, or its position in the project. */
export function label(session: Session): string {
  if (session.resumedFrom !== null) return session.resumedFrom.slice(0, 8);
  const position = forProject(session.project).indexOf(session) + 1;
  return `session ${position}`;
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
  const session: Session = {
    key: `s${++counter}`,
    project,
    ptyId: null,
    status: "starting",
    resumedFrom,
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

export function started(key: string, ptyId: string) {
  const session = byKey(key);
  if (session === null) return;
  session.ptyId = ptyId;
  session.status = "running";
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
 */
export function ended(event: SessionEnded) {
  const session = sessions.all.find((candidate) => candidate.ptyId === event.id);
  if (session === undefined) return;
  session.ptyId = null;
  session.exitCode = event.code;
  session.status = event.clean ? "exited" : "crashed";
}

/** Closes a row for good, stopping it first if it is still going. */
export function close(key: string) {
  const session = byKey(key);
  if (session === null) return;

  if (session.ptyId !== null) {
    core().kill(session.ptyId);
    // Cleared before the row goes, so the terminal's own teardown does not
    // kill the same pty a second time on its way out. That teardown still
    // matters for the case it is there for: the whole pane going away with
    // sessions still live.
    session.ptyId = null;
  }

  const at = sessions.all.indexOf(session);
  sessions.all.splice(at, 1);

  if (sessions.active !== key) return;
  // Prefer another session in the same project, so closing one does not throw
  // you into a different project's work.
  const sibling = forProject(session.project)[0] ?? sessions.all[0] ?? null;
  sessions.active = sibling?.key ?? null;
}

/** Stops every session in a project without removing its rows. */
export function stopProject(project: string) {
  for (const session of forProject(project)) {
    if (session.ptyId !== null) core().kill(session.ptyId);
  }
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
  counter = 0;
}
