/**
 * The orchestrator, as the panes show it.
 *
 * A session that directs others is a session like any other: an agent in a
 * project, on the same keys and in the same panes. What it has of its own
 * is a project to run in, the workbench's orchestrator directory, which
 * the sessions pane pins above the projects you opened.
 *
 * The sessions it starts stay where the work is, in the project they run
 * in, and keep out of the way there: the pane folds them into one line per
 * orchestrator, and the line speaks up when one of them is waiting on you.
 * The place to go is the orchestrator, not the session it started.
 */

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
  }
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

/** A session that is waiting on the user: the state the folds speak up for. */
export function isAsking(session: Session): boolean {
  return isLive(session) && (session.needs === "permission" || session.unread);
}

/** What one orchestrator has running, for the line under its name. */
export function summary(session: Session): { running: number; asking: number } {
  const started = startedBy(session.id ?? session.key);
  return {
    running: started.filter(isLive).length,
    asking: started.filter(isAsking).length,
  };
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

/** The sessions one orchestrator started in one project, folded into a
    line of the project's own. */
export interface Group {
  /** The orchestrator's id, as the started sessions name it. */
  id: string;
  /** What the orchestrator is called, for "started by …". */
  label: string;
  sessions: Session[];
  asking: number;
}

/** The sessions of a project that no orchestrator started. */
export function ownFor(project: string): Session[] {
  return sessions.all.filter(
    (session) =>
      session.project === project && startedFor(session.key) === null,
  );
}

/** The folds under a project, one per orchestrator that has sessions
    there, in the order the sessions were started. */
export function groupsFor(project: string): Group[] {
  const groups: Group[] = [];
  for (const session of sessions.all) {
    if (session.project !== project) continue;
    const id = startedFor(session.key);
    if (id === null) continue;
    let group = groups.find((candidate) => candidate.id === id);
    if (group === undefined) {
      group = { id, label: conductorLabel(id), sessions: [], asking: 0 };
      groups.push(group);
    }
    group.sessions.push(session);
    if (isAsking(session)) group.asking += 1;
  }
  return groups;
}

/** The line on a fold: how many sessions, and who started them. The count
    of those waiting on you is drawn beside it, in the accent, rather than
    said here. */
export function foldLabel(group: Group): string {
  return `${group.sessions.length} started by ${group.label}`;
}

/** What an orchestrator is called where its own row is not in sight. */
function conductorLabel(id: string): string {
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
