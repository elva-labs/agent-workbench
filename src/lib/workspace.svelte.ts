import { untrack } from "svelte";
import { core, type AgentId, type ProjectInfo } from "$lib/core";
import { closeOwner } from "$lib/browser.svelte";
import { lastSegment } from "$lib/paths";
import { accountOf } from "$lib/accounts.svelte";
import { focusPane } from "$lib/layout.svelte";
import {
  activeSession,
  byKey,
  closeProject,
  create,
  defaultAgent,
  forProject,
  select,
  sessions,
  type Session,
} from "$lib/sessions.svelte";
import { closeProject as closeShells, follow } from "$lib/terminals.svelte";
import { drawnIn, forgetUsed, touch } from "$lib/projects.svelte";

/**
 * The projects this window has open.
 *
 * More than one can be open at a time, each with its own sessions, and all of
 * them stay alive. Switching project is a change of view, not a teardown:
 * nothing is killed and nothing needs confirming. The layout shows one
 * project's work at a time, and the left pane is where the others live.
 */

const KEY = "workbench.workspace";

export const workspace = $state({
  open: [] as ProjectInfo[],
  /** Path of the project whose sessions the panes are showing. */
  active: null as string | null,
  error: null as string | null,
  opening: false,
});

export function activeProject(): ProjectInfo | null {
  return (
    workspace.open.find((project) => project.path === workspace.active) ?? null
  );
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
  return lastSegment(worktree);
}

/**
 * What a project is called in the pane: its folder's name, and as much of
 * the path above it as it takes to tell it from another open project with
 * the same name, so two `main-truck` checkouts read `work/main-truck` and
 * `spike/main-truck`.
 */
export function projectLabel(path: string): string {
  const project = workspace.open.find((candidate) => candidate.path === path);
  if (project === undefined) return lastSegment(path);
  const others = workspace.open.filter(
    (candidate) => candidate.path !== path && candidate.name === project.name,
  );
  if (others.length === 0) return project.name;
  const segments = (of: string) =>
    of
      .replace(/^ssh:\/\/[^/]+/, "")
      .split(/[\\/]+/)
      .filter((segment) => segment !== "");
  const own = segments(path);
  const rest = others.map((other) => segments(other.path));
  for (let depth = 2; depth <= own.length; depth += 1) {
    const tail = own.slice(-depth).join("/");
    if (rest.every((other) => other.slice(-depth).join("/") !== tail))
      return tail;
  }
  return own.join("/");
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
    bringForward(already.path);
    return true;
  }

  try {
    const info = await core().projectInfo(path);
    if (!isOpen(info.path)) workspace.open.push(info);
    bringForward(info.path);
    return true;
  } catch (error) {
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
      .setWindowTitle(`${projectLabel(project.path)} — Agent Workbench`)
      .catch(() => {});
  }
}

/** The user brought a project forward, from the sessions pane, go to or
    by opening it again: it is in front and counts as used. What it shows
    is a session drawn under it: the one on screen when that is one, else
    its newest. A session that hangs under its starter in another project
    is drawn there, so a project whose only sessions are such is shown with
    none, and is itself the project on screen. The session on screen stays
    when it hangs under this project from another one: the project in front
    stays the one that session runs in. */
export function bringForward(path: string) {
  const current = sessions.active === null ? null : byKey(sessions.active);
  if (current !== null && current.project !== path && drawnIn(current) === path) {
    touch(path);
    return;
  }
  if (workspace.active !== path) activate(path);
  touch(path);
  const drawnHere = (session: Session) => session.project === path && drawnIn(session) === path;
  if (current !== null && drawnHere(current)) return;
  const own = forProject(path).filter(drawnHere);
  sessions.active = own.length > 0 ? own[own.length - 1].key : null;
}

/** The project on screen, as the sessions pane and the palette both mean
    it: the one in front, except while the session on screen hangs under
    its starter in another project, when it is the starter's. The one in
    front stays the project the session runs in, which is the repository
    the changes pane, the terminal and the window's title follow. */
export function onScreen(): string | null {
  const current = workspace.active;
  const session = sessions.active === null ? null : byKey(sessions.active);
  if (session === null || session.project !== current) return current;
  return drawnIn(session);
}

/** The user picked a session: it comes forward, and its project with it
    when that is another. The project it is drawn under counts as used,
    which for a session hanging under its starter is the starter's. False
    for a key no row has. */
export function goTo(key: string): boolean {
  const session = byKey(key);
  if (session === null) return false;
  if (session.project !== workspace.active) activate(session.project);
  select(key);
  touch(drawnIn(session));
  return true;
}

/** Starts a session in a project, brought forward, and gives it the
    keyboard. The agent is the one the project used last and the account the
    one it runs under, unless named. Starting one is the user using the
    project, so it counts as used. */
export function startSession(
  path: string,
  agent: AgentId = defaultAgent(path),
  account: string | null = accountOf(path),
) {
  if (workspace.active !== path) activate(path);
  touch(path);
  create(path, null, agent, null, null, null, account);
  focusPane("agent");
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

/**
 * Opens the folders the app is asked to open from outside the window: named
 * when it started, or later from a terminal or a second launch. None opens
 * before the stored projects on this machine are back, so the one asked for
 * is left in front; a project on another machine arriving later does not
 * take its place.
 */
export function followOpenRequests(restored: Promise<void>): () => void {
  let off: (() => void) | null = null;
  let stopped = false;
  const follow = async () => {
    const unlisten = await core().onOpenRequested(() => void openRequested());
    if (stopped) {
      unlisten();
      return;
    }
    off = unlisten;
    await openRequested();
  };
  void restored.then(follow, follow);
  return () => {
    stopped = true;
    off?.();
  };
}

async function openRequested() {
  for (const path of await core().takeOpened()) await openPath(path);
}

/** Removes a project from the window, stopping everything running in it. */
export function close(path: string) {
  closeProject(path);
  closeShells(path);
  void closeOwner({ kind: "project", path });
  workspace.open = workspace.open.filter((project) => project.path !== path);
  forgetUsed(path);

  if (workspace.active !== path) {
    save();
    return;
  }
  const next = workspace.open[0]?.path ?? null;
  workspace.active = next;
  if (next !== null) activate(next);
  else save();
}

function save() {
  const open = workspace.open.map((project) => project.path);
  let active = workspace.active;
  // A project still being described keeps its stored place, and stays the
  // one in front while nothing else has been chosen, so a quit before its
  // machine answers loses neither.
  if (restoring !== null) {
    for (const path of restoring.paths) {
      if (restoring.pending.has(path) && !open.includes(path))
        open.splice(placeAmong(open, path, restoring.paths), 0, path);
    }
    const wanted = restoring.wanted;
    if (wanted !== null && restoring.pending.has(wanted) && untouched())
      active = wanted;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify({ open, active }));
  } catch {
    // Non-fatal: the workspace simply does not survive a restart.
  }
}

/**
 * A restore under way: the stored order, the stored projects not yet
 * described, the one stored in front, and what the window last put in front
 * by itself.
 */
let restoring: {
  paths: string[];
  pending: Set<string>;
  wanted: string | null;
  placed: { project: string | null; session: string | null };
} | null = null;

/** Counts restores, so the answers of one that was reset are ignored. */
let restores = 0;

/** Whether a project or session has been chosen during the restore under
    way, which then leaves what is in front alone from then on. */
let chosen = $state(false);

/** Stops watching for a choice during the restore under way. */
let unwatch: () => void = () => {};

/** Watches what is in front while a restore waits, and takes the first time
    it differs from what the restore put there as chosen, stored at once. */
function watchChoice() {
  unwatch();
  chosen = false;
  unwatch = $effect.root(() => {
    $effect(() => {
      const project = workspace.active;
      const session = sessions.active;
      if (restoring === null || untrack(() => chosen)) return;
      if (
        restoring.placed.project !== project ||
        restoring.placed.session !== session
      ) {
        chosen = true;
        save();
      }
    });
  });
}

/** Where a stored project goes among the open ones: before the first that
    was stored after it or was not stored at all, else at the end. */
function placeAmong(open: string[], path: string, paths: string[]): number {
  const at = paths.indexOf(path);
  const index = open.findIndex((other) => {
    const its = paths.indexOf(other);
    return its === -1 || its > at;
  });
  return index === -1 ? open.length : index;
}

/** Whether the project and session in front are still the ones a restore
    put there, with nothing chosen since. False once no restore is waiting. */
export function untouched(): boolean {
  return (
    restoring !== null &&
    !chosen &&
    restoring.placed.project === workspace.active &&
    restoring.placed.session === sessions.active
  );
}

/** Whether the project stored in front is still waiting for its machine,
    with nothing chosen since. */
export function frontPending(): boolean {
  return (
    restoring !== null &&
    restoring.wanted !== null &&
    restoring.pending.has(restoring.wanted) &&
    untouched()
  );
}

/** Takes what is in front now as put there by the restore, not chosen. */
export function restoredInFront() {
  if (restoring === null) return;
  restoring.placed = { project: workspace.active, session: sessions.active };
}

/**
 * Reopens what the window had last time.
 *
 * Paths are re-described rather than restored from storage: a directory may
 * have been moved, or may have become a repository since, so the core is asked
 * afresh. Every project is asked for at once. Those on this machine are put in
 * the list together, in the order they were stored, and the returned promise
 * settles then. One on another machine is put in when it answers, at its
 * stored place among those open, so a host that is slow or gone holds nothing
 * else up; the map returned names each such project with a promise that
 * settles once it is in the list or has been given up. A directory that is
 * gone is dropped quietly rather than opening on an error.
 *
 * The project stored in front is put in front. While it is on a machine that
 * has not answered, the first project open is put in front instead, and the
 * stored one replaces it on arrival unless a project or session has been
 * chosen since.
 */
export async function restore(): Promise<Map<string, Promise<void>>> {
  const arriving = new Map<string, Promise<void>>();
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return arriving;
  }
  if (raw === null) return arriving;

  let stored: { open?: unknown; active?: unknown };
  try {
    stored = JSON.parse(raw);
  } catch {
    return arriving;
  }

  const paths = Array.isArray(stored.open)
    ? stored.open.filter((path): path is string => typeof path === "string")
    : [];
  const wanted = typeof stored.active === "string" ? stored.active : null;
  const remote = (path: string) => path.startsWith("ssh://");

  const state = {
    paths,
    pending: new Set(paths),
    wanted,
    placed: { project: workspace.active, session: sessions.active },
  };
  restoring = state;
  watchChoice();
  const mine = (restores += 1);
  let localIn = false;
  const finish = () => {
    if (localIn && state.pending.size === 0 && restoring === state) {
      restoring = null;
      unwatch();
    }
  };

  const asked = paths.map((path) => ({
    path,
    info: core()
      .projectInfo(path)
      .catch(() => null),
  }));

  const insert = (info: ProjectInfo) => {
    if (isOpen(info.path)) return;
    const open = workspace.open.map((project) => project.path);
    workspace.open.splice(placeAmong(open, info.path, paths), 0, info);
  };
  const front = () => {
    if (!untouched()) return;
    let target: string | null = null;
    if (wanted !== null && isOpen(wanted)) {
      if (workspace.active !== wanted) target = wanted;
    } else if (localIn && workspace.active === null) {
      target = workspace.open[0]?.path ?? null;
    }
    if (target === null) return;
    activate(target);
    restoredInFront();
    save();
  };

  for (const entry of asked.filter((entry) => remote(entry.path))) {
    const arrived = entry.info.then((info) => {
      if (restores !== mine) return;
      if (info !== null) insert(info);
      state.pending.delete(entry.path);
      front();
      save();
      finish();
    });
    arriving.set(entry.path, arrived);
  }

  const here = asked.filter((entry) => !remote(entry.path));
  const local = await Promise.all(here.map((entry) => entry.info));
  if (restores !== mine) return arriving;
  for (const info of local) if (info !== null) insert(info);
  for (const entry of here) state.pending.delete(entry.path);
  localIn = true;
  front();
  finish();
  return arriving;
}

/** Test seam. */
export function reset() {
  restoring = null;
  unwatch();
  chosen = false;
  restores += 1;
  workspace.open = [];
  workspace.active = null;
  workspace.error = null;
  workspace.opening = false;
}
