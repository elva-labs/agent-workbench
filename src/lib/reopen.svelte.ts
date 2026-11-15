import type { AgentId } from "$lib/core";
import { carryOver, startedFor } from "$lib/conductor.svelte";
import { handleOf, reattach } from "$lib/integrated.svelte";
import {
  activeSession,
  forProject,
  reopened,
  sessions,
  type Session,
} from "$lib/sessions.svelte";
import {
  frontPending,
  isOpen,
  restoredInFront,
  untouched,
  workspace,
} from "$lib/workspace.svelte";

/**
 * The sessions that were open when the app quit.
 *
 * Every live row is on record, with the one on screen, and the record is
 * kept current as rows come and go. A row closed by hand leaves it; a quit
 * leaves it as it was. On the next start each comes back as a dormant row
 * in its project, and only the one on screen starts: the rest start when
 * they are selected. A terminal session another session started is not on
 * record: it is the caller's to bring back, and the caller's list offers
 * it. An integrated one is, as any other is: the core goes on running it
 * through a reload, and a window that dropped its row would leave an agent
 * running that no row shows. It comes back under the session that started
 * it, which the caller's own record still says.
 */

const KEY = "workbench.open";

/** A row as it is remembered: enough to resume it where it ran. */
interface Open {
  project: string;
  id: string;
  agent: AgentId;
  startIn: string | null;
  model: string | null;
  /** The account it ran under, by name; null for the agents' own. A record
      from before there were accounts has none, which reads as null. */
  account?: string | null;
  /** How it ran. A record from before there were integrated sessions has
      none, which reads as a terminal. */
  kind?: "terminal" | "integrated";
  /** The core's id for an integrated session while it ran, which a window
      reloaded while the core still runs it takes it up by. */
  handle?: string | null;
  /** Whether the session had been spoken to, so a session taken up again
      says it has earlier messages only when it has. A record from before
      says nothing, which reads as spoken to. */
  spoken?: boolean;
}

function onRecord(session: Session): boolean {
  return (
    session.id !== null &&
    (session.status === "dormant" ||
      session.status === "starting" ||
      session.status === "running") &&
    (session.kind === "integrated" || startedFor(session.key) === null)
  );
}

function isOpenEntry(entry: unknown): entry is Open {
  if (typeof entry !== "object" || entry === null) return false;
  const { project, id, agent, startIn, model, account, kind, handle, spoken } = entry as Record<
    string,
    unknown
  >;
  return (
    typeof project === "string" &&
    typeof id === "string" &&
    (agent === "claude-code" || agent === "codex") &&
    (startIn === null || typeof startIn === "string") &&
    (model === null || typeof model === "string") &&
    (account === undefined || account === null || typeof account === "string") &&
    (kind === undefined || kind === "terminal" || kind === "integrated") &&
    (handle === undefined || handle === null || typeof handle === "string") &&
    (spoken === undefined || typeof spoken === "boolean")
  );
}

/** What was on record at the last quit. A corrupt record is nothing open. */
function read(): { open: Open[]; active: string | null } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return { open: [], active: null };
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== "object" || stored === null)
      return { open: [], active: null };
    const { open, active } = stored as Record<string, unknown>;
    return {
      open: Array.isArray(open) ? open.filter(isOpenEntry) : [],
      active: typeof active === "string" ? active : null,
    };
  } catch {
    return { open: [], active: null };
  }
}

function write(open: Open[], active: string | null) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ open, active }));
  } catch {
    // Non-fatal: the sessions do not come back after a restart.
  }
}

/**
 * Brings back the sessions that were open, in the projects that are, and
 * from then on keeps the record current. Call once the projects on this
 * machine are back. `arriving` names the projects on other machines still
 * on their way, each with a promise that settles once it is open or has
 * been given up: their sessions stay on record meanwhile, come back when
 * the project does, and leave the record when it does not. Returns a stop
 * function.
 */
export function reopen(
  arriving: ReadonlyMap<string, Promise<void>> = new Map(),
  /** The orchestrator's directory once it is known: its sessions are on
      record like any project's, though it is never an open project. */
  conductor: Promise<string | null> | null = null,
): () => void {
  const { open, active } = read();
  // What an earlier version kept of an open session's starts under the
  // folder it called from is that session's from here.
  carryOver(open);
  let conductorDir: string | null = null;
  const here = (project: string) => isOpen(project) || (conductorDir !== null && project === conductorDir);
  const bring = (entry: Open) => {
    if (!here(entry.project)) return;
    if (sessions.all.some((session) => session.id === entry.id)) return;
    const row = reopened(
      entry.project,
      entry.id,
      entry.agent,
      entry.startIn,
      entry.model,
      entry.account ?? null,
      entry.kind ?? "terminal",
    );
    // A window reloaded while the core still runs the session takes it up
    // where it is; after a restart there is nothing to take up, and the
    // row waits to be resumed like any other.
    if (row.kind === "integrated" && entry.handle) void reattach(row.key, entry.handle, entry.spoken ?? true);
  };
  // The session on screen at the quit, when its project is the one in front
  // and nothing else is on screen; otherwise the project's most recent, as
  // bringing a project forward does. While the project or the session on
  // screen at the quit waits for its machine, the project in front meanwhile
  // gets none.
  const front = (project: string | null) => {
    if (project === null || activeSession() !== null) return;
    const own = forProject(project);
    const waits =
      frontPending() || held.some((entry) => entry.id === active);
    const wanted =
      own.find((session) => session.id === active) ??
      (waits ? undefined : own.at(-1));
    if (wanted === undefined) return;
    sessions.active = wanted.key;
    restoredInFront();
  };

  // A session in a folder that is not open may be the orchestrator's, which
  // is known only once the core says where it is: it stays on record until
  // then.
  const waiting = open.filter(
    (entry) => !isOpen(entry.project) && (arriving.has(entry.project) || conductor !== null),
  );
  let held = $state(waiting);
  for (const entry of open) bring(entry);
  front(workspace.active);

  let stopped = false;
  if (conductor !== null)
    void conductor.then((dir) => {
      if (stopped) return;
      conductorDir = dir;
      const theirs = held.filter((entry) => entry.project === dir);
      held = held.filter((entry) => entry.project !== dir && arriving.has(entry.project));
      for (const entry of theirs) bring(entry);
    });
  for (const [project, arrived] of arriving) {
    const settle = () => {
      if (stopped) return;
      const theirs = held.filter((entry) => entry.project === project);
      held = held.filter((entry) => entry.project !== project);
      for (const entry of theirs) bring(entry);
      if (workspace.active === project) front(project);
      else if (!isOpen(project)) front(workspace.active);
    };
    void arrived.then(settle, settle);
  }

  const stop = $effect.root(() => {
    $effect(() => {
      const shown = activeSession()?.id ?? null;
      // While the session on screen at the quit waits for its machine and
      // nothing has been chosen since, it stays the one on record.
      const kept = held.some((entry) => entry.id === active) && untouched();
      write(
        [
          ...sessions.all.filter(onRecord).map((session) => ({
            project: session.project,
            id: session.id!,
            agent: session.agent,
            startIn: session.startIn,
            model: session.model,
            account: session.account,
            kind: session.kind,
            ...(session.kind === "integrated" ? { handle: handleOf(session.key), spoken: session.engaged } : {}),
          })),
          ...held,
        ],
        kept ? active : shown,
      );
    });
  });
  return () => {
    stopped = true;
    stop();
  };
}
