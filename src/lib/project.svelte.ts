import { core, type ProjectInfo } from "$lib/core";

/**
 * The project this window is pointed at.
 *
 * One window, one project, one agent, one worktree. The agent spawns here, the
 * changes pane watches here, and the session index is keyed by here. Opening a
 * project replaces the current one rather than adding a tab: the three-pane
 * layout has room for exactly one of each, and two projects at once is a second
 * window.
 */

const KEY = "workbench.project";
const RECENT_LIMIT = 8;

export const project = $state({
  current: null as ProjectInfo | null,
  /** Paths, most recent first. Phase 3 replaces this with the real index. */
  recent: [] as string[],
  error: null as string | null,
  opening: false,
});

export function projectName(): string {
  return project.current?.name ?? "No project";
}

/** The directory the changes pane watches: the whole repository, not the
    subdirectory you happened to open. */
export function watchRoot(): string | null {
  return project.current?.repository ?? project.current?.path ?? null;
}

export async function openPath(path: string): Promise<boolean> {
  project.error = null;
  try {
    const info = await core().projectInfo(path);
    project.current = info;
    remember(info.path);
    save();
    await core().setWindowTitle(`${info.name} — Agent Workbench`);
    return true;
  } catch (error) {
    project.error = String(error);
    return false;
  }
}

/** Opens the native picker. Returns false when the user cancels. */
export async function pick(): Promise<boolean> {
  project.opening = true;
  try {
    const path = await core().pickProject();
    if (path === null) return false;
    return await openPath(path);
  } finally {
    project.opening = false;
  }
}

export function closeProject() {
  project.current = null;
  save();
}

function remember(path: string) {
  project.recent = [path, ...project.recent.filter((p) => p !== path)].slice(0, RECENT_LIMIT);
}

export function load() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const stored = JSON.parse(raw);
    if (Array.isArray(stored.recent)) {
      project.recent = stored.recent.filter((p: unknown) => typeof p === "string");
    }
    // The path is reopened rather than restored: the directory may be gone, or
    // may have become a repository since, so the core describes it afresh.
    if (typeof stored.current === "string") return stored.current as string;
  } catch {
    // A corrupt entry just means no project is open.
  }
  return undefined;
}

function save() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ current: project.current?.path ?? null, recent: project.recent }),
    );
  } catch {
    // Non-fatal: the project simply does not survive a restart.
  }
}

/** Reopens last session's project, if it is still there. */
export async function restore() {
  const path = load();
  if (typeof path === "string") await openPath(path);
}
