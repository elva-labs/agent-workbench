import { core, type ProjectInfo } from "$lib/core";
import { activeSession, closeProject, forProject, sessions } from "$lib/sessions.svelte";
import { closeProject as closeShells, follow } from "$lib/terminals.svelte";

/**
 * The projects this window has open.
 *
 * More than one can be open at a time, each with its own sessions, and all of
 * them stay alive. Switching project is a change of view, not a teardown:
 * nothing is killed and nothing needs confirming. The layout shows one
 * project's work at a time, and the left pane is where the others live.
 */

const KEY = "workbench.workspace";
const RECENT_LIMIT = 8;

export const workspace = $state({
  open: [] as ProjectInfo[],
  /** Path of the project whose sessions the panes are showing. */
  active: null as string | null,
  /** Paths, most recent first, whether currently open or not. */
  recent: [] as string[],
  error: null as string | null,
  opening: false,
});

export function activeProject(): ProjectInfo | null {
  return workspace.open.find((project) => project.path === workspace.active) ?? null;
}

export function projectName(): string {
  return activeProject()?.name ?? "No project";
}

/** The directory the changes pane watches: the whole repository, not the
    subdirectory you happened to open. Null for a folder git knows nothing
    about, which has no changes to show. A session that has moved into a
    worktree is followed there: its changes are the ones to review. */
export function watchRoot(): string | null {
  const project = activeProject();
  if (project === null) return null;
  const worktree = activeSession()?.worktree ?? null;
  if (worktree !== null) return worktree;
  if (!project.isGit) return null;
  return project.repository ?? project.path;
}

/** The worktree the changes pane is following instead of the project's own,
    as a name to show, or null while it is the project's own. */
export function followedWorktree(): string | null {
  const project = activeProject();
  const worktree = activeSession()?.worktree ?? null;
  if (project === null || worktree === null) return null;
  const own = project.repository ?? project.path;
  if (worktree === own) return null;
  return worktree.slice(worktree.lastIndexOf("/") + 1);
}

export function isOpen(path: string): boolean {
  return workspace.open.some((project) => project.path === path);
}

/**
 * Opens a folder, or brings it forward if it is already open.
 *
 * Reopening is deliberately not a reload: the sessions already running in that
 * project are the reason to go back to it.
 */
export async function openPath(path: string): Promise<boolean> {
  workspace.error = null;

  const already = workspace.open.find((project) => project.path === path);
  if (already !== undefined) {
    activate(already.path);
    return true;
  }

  try {
    const info = await core().projectInfo(path);
    if (!isOpen(info.path)) workspace.open.push(info);
    remember(info.path);
    activate(info.path);
    return true;
  } catch (error) {
    // A folder that cannot be described is not one worth offering again.
    workspace.recent = workspace.recent.filter((recent) => recent !== path);
    save();
    workspace.error = String(error);
    return false;
  }
}

export function activate(path: string) {
  workspace.active = path;
  // Follow the project with its own most recent session rather than leaving
  // the pane pointed at another project's terminal.
  const own = forProject(path);
  if (own.length > 0) sessions.active = own[own.length - 1].key;
  else sessions.active = null;
  follow(path);

  save();
  const project = workspace.open.find((candidate) => candidate.path === path);
  if (project !== undefined) {
    core()
      .setWindowTitle(`${project.name} — Agent Workbench`)
      .catch(() => {});
  }
}

/** Opens the native picker. Returns false when the user cancels. */
export async function pick(): Promise<boolean> {
  workspace.opening = true;
  try {
    const path = await core().pickProject();
    if (path === null) return false;
    return await openPath(path);
  } finally {
    workspace.opening = false;
  }
}

/** Removes a project from the window, stopping everything running in it. */
export function close(path: string) {
  closeProject(path);
  closeShells(path);
  workspace.open = workspace.open.filter((project) => project.path !== path);

  if (workspace.active !== path) {
    save();
    return;
  }
  const next = workspace.open[0]?.path ?? null;
  workspace.active = next;
  if (next !== null) activate(next);
  else save();
}

function remember(path: string) {
  workspace.recent = [path, ...workspace.recent.filter((p) => p !== path)].slice(0, RECENT_LIMIT);
}

function save() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        open: workspace.open.map((project) => project.path),
        active: workspace.active,
        recent: workspace.recent,
      }),
    );
  } catch {
    // Non-fatal: the workspace simply does not survive a restart.
  }
}

/**
 * Reopens what the window had last time.
 *
 * Paths are re-described rather than restored from storage: a directory may
 * have been moved, or may have become a repository since, so the core is asked
 * afresh. Sessions are not restored, because processes do not survive a quit.
 */
export async function restore() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return;
  }
  if (raw === null) return;

  let stored: { open?: unknown; active?: unknown; recent?: unknown };
  try {
    stored = JSON.parse(raw);
  } catch {
    return;
  }

  if (Array.isArray(stored.recent)) {
    workspace.recent = stored.recent.filter((path): path is string => typeof path === "string");
  }

  const paths = Array.isArray(stored.open)
    ? stored.open.filter((path): path is string => typeof path === "string")
    : [];

  for (const path of paths) {
    try {
      const info = await core().projectInfo(path);
      if (!isOpen(info.path)) workspace.open.push(info);
    } catch {
      // The directory is gone. Drop it quietly rather than opening on an error.
    }
  }

  const wanted = typeof stored.active === "string" ? stored.active : null;
  const target = workspace.open.find((project) => project.path === wanted) ?? workspace.open[0];
  if (target !== undefined) activate(target.path);
}

/** Test seam. */
export function reset() {
  workspace.open = [];
  workspace.active = null;
  workspace.recent = [];
  workspace.error = null;
  workspace.opening = false;
}
