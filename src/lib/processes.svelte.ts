/**
 * What runs under the sessions and shells of the project on screen: the
 * dev server the agent typed for you, the test run it started, listed in a
 * section under the tree and stopped from there. Read from the core on a
 * timer while the changes pane is up, slower while the section is folded
 * since only its count shows then.
 */

import { core, type Process } from "$lib/core";
import { changesVisible, layout } from "$lib/layout.svelte";
import {
  forProject as sessionsOf,
  label as sessionLabel,
} from "$lib/sessions.svelte";
import {
  forProject as shellsOf,
  label as shellLabel,
} from "$lib/terminals.svelte";
import { workspace } from "$lib/workspace.svelte";

export interface ProcessRow extends Process {
  /** The pty the process runs under, on whichever machine. */
  ptyId: string;
  /** What the row it runs under is called: the session or the shell. */
  owner: string;
}

export const processes = $state({
  rows: [] as ProcessRow[],
});

export const POLL_OPEN = 2000;
export const POLL_FOLDED = 6000;

/** The ptys to look under: the active project's running sessions and
    shells, with what each is called. */
export function owners(): { ptyId: string; owner: string }[] {
  const project = workspace.active;
  if (project === null) return [];
  const list: { ptyId: string; owner: string }[] = [];
  for (const session of sessionsOf(project)) {
    if (session.ptyId !== null && session.status === "running") {
      list.push({ ptyId: session.ptyId, owner: sessionLabel(session) });
    }
  }
  for (const shell of shellsOf(project)) {
    if (shell.ptyId !== null && shell.status === "running") {
      list.push({ ptyId: shell.ptyId, owner: shellLabel(shell) });
    }
  }
  return list;
}

let reading = 0;

export async function refresh() {
  const turn = ++reading;
  const list = owners();
  const found = await Promise.all(
    list.map(async ({ ptyId, owner }) => {
      try {
        const under = await core().ptyProcesses(ptyId);
        return under.map((process) => ({ ...process, ptyId, owner }));
      } catch {
        // A pty that went between the list and the ask has nothing under it.
        return [];
      }
    }),
  );
  if (turn === reading) processes.rows = found.flat();
}

/** Keeps the list current while the pane is up. Runs in an effect root:
    call once, from the page. */
export function watchProcesses() {
  $effect(() => {
    const delay = layout.processesOpen ? POLL_OPEN : POLL_FOLDED;
    const project = workspace.active;
    if (project === null || !changesVisible()) {
      processes.rows = [];
      return;
    }
    // Read here so a session or shell coming up, or going, reads the list
    // again at once rather than at the next tick.
    owners();
    void refresh();
    const timer = setInterval(() => void refresh(), delay);
    return () => clearInterval(timer);
  });
}

export async function stop(row: ProcessRow) {
  await core().stopProcess(row.ptyId, row.pid);
  await refresh();
}

/** How long a process has run, in the shortest form that reads. */
export function elapsed(startedSeconds: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor(now / 1000) - startedSeconds);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Test seam. */
export function resetProcesses() {
  reading = 0;
  processes.rows = [];
}
