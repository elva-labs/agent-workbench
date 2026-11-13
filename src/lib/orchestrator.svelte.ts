/**
 * The orchestrator, as the panes show it.
 *
 * A session that directs others is a session like any other: an agent in a
 * project, on the same keys and in the same panes. What it has of its own
 * is a project to run in, the workbench's orchestrator directory, which
 * the sessions pane pins above the projects you opened.
 *
 * The sessions a session starts hang under it in the pane, one line each
 * on a rail from its dot, wherever they run, and speak up only when one of
 * them needs a permission. The place to go is the session that started
 * them, not the session it started.
 */

import { dirsOf } from "$lib/accounts.svelte";
import { core, type Worktree } from "$lib/core";
import { startedBy, startedFor } from "$lib/conductor.svelte";
import { isLive, label, sessions, type Session } from "$lib/sessions.svelte";
import { workspace } from "$lib/workspace.svelte";

/** The name the pane gives the orchestrator's own project. */
export const LABEL = "orchestrator";

export const orchestrator = $state<{ dir: string | null }>({ dir: null });

/** Asks the core where an orchestrator session runs, and makes the
    directory if it is not there yet. A core that cannot say leaves the
    project out of the pane rather than showing one that cannot start. */
export async function load(): Promise<void> {
  try {
    orchestrator.dir = await core().orchestratorDir();
  } catch {
    orchestrator.dir = null;
    return;
  }
  // The tools are what make an orchestrator one, and they reach an agent
  // through the hooks and the tool server written into the directory it
  // runs in. The directory is the app's own, so they are always there,
  // whatever the projects were told about live updates.
  await core()
    .hookInstall(orchestrator.dir, dirsOf())
    .catch(() => {
      // A directory that cannot take them is one no session will get far
      // in either; the session's own start says so.
    });
}

/** A session in the orchestrator's own project. */
export function isConductor(session: Session): boolean {
  return orchestrator.dir !== null && session.project === orchestrator.dir;
}

/** The orchestrator sessions, in the order they were started. */
export function conductors(): Session[] {
  if (orchestrator.dir === null) return [];
  return sessions.all.filter((session) => session.project === orchestrator.dir);
}

/** A started session that is waiting on the user: it needs a permission,
    which only the user can grant. Everything else it waits on is its
    orchestrator's to hear, so its row speaks up for nothing else. */
export function isAsking(session: Session): boolean {
  return isLive(session) && session.needs === "permission";
}

/** What one orchestrator has running, for the line under its name and its
    dot: how many are live, how many are waiting on you, and whether any is
    at work right now. */
export function summary(session: Session): {
  running: number;
  asking: number;
  working: boolean;
} {
  const started = startedBy(session.id ?? session.key);
  return {
    running: started.filter(isLive).length,
    asking: started.filter(isAsking).length,
    working: started.some((child) => isLive(child) && child.working),
  };
}

/** Whether an orchestrator's dot should breathe: its own agent is at work,
    or one it started is. A child that is asking shows in the summary line
    and the fold's accent rather than here, so it does not stop the dot. The
    orchestrator's own call for attention does: its permission ring or its
    unread accent is the row's state, and a working child does not paint
    over it. */
export function conducting(session: Session): boolean {
  if (session.working) return true;
  if (session.unread || session.needs === "permission") return false;
  return summary(session).working;
}

/** The line under an orchestrator's name: what it has out, and how much of
    it is waiting on you. */
export function summaryLine(session: Session): string | null {
  const { running, asking } = summary(session);
  if (running === 0) return null;
  return asking === 0
    ? `${running} running`
    : `${running} running, ${asking} asking`;
}

/** The row of the session that started this one, while the window has
    it. A session whose starter is gone has no parent here and stands in
    its own project like any other. */
export function parentOf(session: Session): Session | null {
  const id = startedFor(session.key);
  if (id === null) return null;
  return (
    sessions.all.find(
      (candidate) =>
        candidate !== session && (candidate.id === id || candidate.key === id),
    ) ?? null
  );
}

/** The sessions that hang under a session's row, in the order they were
    started. */
export function childrenOf(session: Session): Session[] {
  return sessions.all.filter((child) => parentOf(child)?.key === session.key);
}

/** The sessions drawn under a project's name: its own, and any whose
    starter the window no longer has. A session started by one still here
    hangs under that one instead, whichever project it runs in. */
export function ownFor(project: string): Session[] {
  return sessions.all.filter(
    (session) => session.project === project && parentOf(session) === null,
  );
}

/** What an orchestrator is called where its own row is not in sight. */
export function conductorLabel(id: string): string {
  const session = sessions.all.find(
    (candidate) => candidate.id === id || candidate.key === id,
  );
  return session === undefined ? "an orchestrator" : label(session);
}

/** A worktree found under a project, with the project it is under. */
export type LeftTree = Worktree & { project: string };

/**
 * The worktrees of the open projects that nothing is running in.
 *
 * A start that asked for a worktree leaves one behind when the session it
 * was made for ends, so the board says how many are there and offers to
 * take away the ones git will part with.
 */
export const leftBehind = $state<{ trees: LeftTree[]; loading: boolean }>({
  trees: [],
  loading: false,
});

/** The trees that can go: the branch holds nothing the project's own lacks,
    and there is no uncommitted work in the tree. */
export function removable(trees: LeftTree[]): LeftTree[] {
  return trees.filter((tree) => tree.merged && !tree.dirty);
}

/** Asks every open project for its worktrees and keeps the ones no live
    session is running in. A project that cannot say is passed over. */
export async function readWorktrees(): Promise<void> {
  const projects = workspace.open.map((project) => project.path);
  leftBehind.loading = true;
  try {
    const found: LeftTree[] = [];
    for (const project of projects) {
      let trees: Worktree[];
      try {
        trees = await core().worktrees(project);
      } catch {
        continue;
      }
      for (const tree of trees)
        if (!inUse(tree.path)) found.push({ ...tree, project });
    }
    leftBehind.trees = found;
  } finally {
    leftBehind.loading = false;
  }
}

/** Removes the trees that can go, one at a time, and reads what is left. A
    tree the core will not part with stays, and says why on the next read. */
export async function cleanWorktrees(): Promise<void> {
  for (const tree of removable(leftBehind.trees)) {
    try {
      await core().worktreeRemove(tree.project, tree.name);
    } catch {
      // The tree grew work between the read and the removal. It stays.
    }
  }
  await readWorktrees();
}

/** Whether a live session is running in a directory. */
function inUse(path: string): boolean {
  return sessions.all.some(
    (session) =>
      isLive(session) &&
      (session.worktree === path || session.startIn === path),
  );
}
