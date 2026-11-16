/**
 * The `orchestrator` folder under the workbench's home.
 *
 * It holds the sessions an earlier version of the workbench ran there, in
 * a project of its own for directing work. Any session may start others,
 * so the folder is nothing more than a folder: the sessions pane lists it
 * as a project while it holds sessions to read or resume, each a session
 * like any other, and nothing new starts in it. Once the user closes it,
 * it stays out of the pane, unless a session in it comes back from the
 * last quit.
 */

import { core } from "$lib/core";
import { forProject, historyFor } from "$lib/sessions.svelte";

/** Where the window keeps that the folder was closed. */
const KEY = "workbench.orchestratorFolder";

function readClosed(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return false;
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && (parsed as { closed?: unknown }).closed === true;
  } catch {
    return false;
  }
}

export const orchestratorFolder = $state<{ dir: string | null; closed: boolean }>({
  dir: null,
  closed: readClosed(),
});

let knowDir: (dir: string | null) => void = () => {};
/** Settles with the folder's path once the core has said where it is, or
    with null when it cannot say. */
export const dirKnown: Promise<string | null> = new Promise((resolve) => (knowDir = resolve));

/** Asks the core where the folder is. Nothing is made or written there. */
export async function load(): Promise<void> {
  try {
    orchestratorFolder.dir = await core().orchestratorDir();
  } catch {
    orchestratorFolder.dir = null;
  }
  knowDir(orchestratorFolder.dir);
}

/** Whether a path is the folder. */
export function isOrchestratorFolder(path: string | null): boolean {
  return path !== null && orchestratorFolder.dir !== null && path === orchestratorFolder.dir;
}

/** Whether a new session may start in a project: anywhere but the
    folder. */
export function startsIn(path: string | null): boolean {
  return !isOrchestratorFolder(path);
}

/** The folder while the sessions pane lists it: a session of it has a row,
    or, until the user closes it, it holds past sessions the pane lists or
    is the project on screen. Null otherwise. Past sessions the pane does
    not list, aged past the setting or never the window's own, do not
    bring it back. */
export function folderShown(onScreen: string | null): string | null {
  const dir = orchestratorFolder.dir;
  if (dir === null) return null;
  if (forProject(dir).length > 0) return dir;
  if (orchestratorFolder.closed) return null;
  return historyFor(dir).length > 0 || onScreen === dir ? dir : null;
}

/** The folder while its past sessions are read: until it is closed, and
    after that while a session of it has a row, which lists it again and
    needs its past sessions to be drawn among the projects. Null
    otherwise. */
export function folderToRead(): string | null {
  const dir = orchestratorFolder.dir;
  if (dir === null) return null;
  return !orchestratorFolder.closed || forProject(dir).length > 0 ? dir : null;
}

/** The user closed the folder: it leaves the pane for good. */
export function closeFolder() {
  orchestratorFolder.closed = true;
  try {
    localStorage.setItem(KEY, JSON.stringify({ closed: true }));
  } catch {
    // Non-fatal: the folder is listed again on the next start.
  }
}

/** The user opened the folder: it is listed again, as it was before it
    was closed. */
export function reopenFolder() {
  orchestratorFolder.closed = false;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Non-fatal: the folder stays listed for this run.
  }
}

/** Test seam. */
export function resetFolder(dir: string | null = null, closed = false) {
  orchestratorFolder.dir = dir;
  orchestratorFolder.closed = closed;
}
