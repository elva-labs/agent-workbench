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

import { core } from "$lib/core";
import { startedBy, startedFor } from "$lib/conductor.svelte";
import { isLive, label, sessions, type Session } from "$lib/sessions.svelte";

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
