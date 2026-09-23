import type { AgentId } from "$lib/core";
import { startedFor } from "$lib/conductor.svelte";
import {
  activeSession,
  forProject,
  reopened,
  sessions,
  type Session,
} from "$lib/sessions.svelte";
import { isOpen, workspace } from "$lib/workspace.svelte";

/**
 * The sessions that were open when the app quit.
 *
 * Every live row is on record, with the one on screen, and the record is
 * kept current as rows come and go. A row closed by hand leaves it; a quit
 * leaves it as it was. On the next start each comes back as a dormant row
 * in its project, and only the one on screen starts: the rest start when
 * they are selected. A session another session started is not on record:
 * it is the caller's to bring back, and the caller's list offers it.
 */

const KEY = "workbench.open";

/** A row as it is remembered: enough to resume it where it ran. */
interface Open {
  project: string;
  id: string;
  agent: AgentId;
  startIn: string | null;
  model: string | null;
}

function onRecord(session: Session): boolean {
  return (
    session.id !== null &&
    (session.status === "dormant" ||
      session.status === "starting" ||
      session.status === "running") &&
    startedFor(session.key) === null
  );
}

function isOpenEntry(entry: unknown): entry is Open {
  if (typeof entry !== "object" || entry === null) return false;
  const { project, id, agent, startIn, model } = entry as Record<
    string,
    unknown
  >;
  return (
    typeof project === "string" &&
    typeof id === "string" &&
    (agent === "claude-code" || agent === "codex") &&
    (startIn === null || typeof startIn === "string") &&
    (model === null || typeof model === "string")
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
 * from then on keeps the record current. Call once the workspace is back.
 * Returns a stop function.
 */
export function reopen(): () => void {
  const { open, active } = read();
  for (const entry of open) {
    if (!isOpen(entry.project)) continue;
    if (sessions.all.some((session) => session.id === entry.id)) continue;
    reopened(entry.project, entry.id, entry.agent, entry.startIn, entry.model);
  }

  // The session on screen at the quit, when its project is the one in front;
  // otherwise the project's most recent, as bringing a project forward does.
  const project = workspace.active;
  if (project !== null && activeSession() === null) {
    const own = forProject(project);
    const wanted = own.find((session) => session.id === active) ?? own.at(-1);
    if (wanted !== undefined) sessions.active = wanted.key;
  }

  return $effect.root(() => {
    $effect(() => {
      write(
        sessions.all.filter(onRecord).map((session) => ({
          project: session.project,
          id: session.id!,
          agent: session.agent,
          startIn: session.startIn,
          model: session.model,
        })),
        activeSession()?.id ?? null,
      );
    });
  });
}
