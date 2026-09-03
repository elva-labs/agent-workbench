import { core, type SessionEnded } from "$lib/core";
import { claim } from "$lib/exits";
import { hideTerminal } from "$lib/layout.svelte";

/**
 * The shells in the terminal panel.
 *
 * Plain terminals, not sessions: nothing is resumed and nothing is indexed.
 * Each belongs to the project it was opened in and starts there, and the panel
 * shows the active project's shells the way the agent pane shows its sessions.
 * Switching project kills nothing.
 *
 * A shell that exits cleanly takes its tab with it, which is what typing
 * `exit` means. One that dies any other way stays, with the code, because a
 * shell that vanishes on a crash hides the crash.
 */

export type ShellStatus = "starting" | "running" | "crashed" | "failed";

export interface Shell {
  /** Stable for the lifetime of the tab, unlike the pty id. */
  key: string;
  project: string;
  ptyId: string | null;
  status: ShellStatus;
  /** Position among the project's shells at creation. Never reused. */
  ordinal: number;
  exitCode: number | null;
  error: string | null;
}

export const terminals = $state({
  all: [] as Shell[],
  active: null as string | null,
});

let counter = 0;
let ordinals: Record<string, number> = {};

export function forProject(project: string): Shell[] {
  return terminals.all.filter((shell) => shell.project === project);
}

export function activeShell(): Shell | null {
  return terminals.all.find((shell) => shell.key === terminals.active) ?? null;
}

export function byKey(key: string): Shell | null {
  return terminals.all.find((shell) => shell.key === key) ?? null;
}

export function label(shell: Shell): string {
  return `shell ${shell.ordinal}`;
}

export function select(key: string) {
  if (byKey(key) !== null) terminals.active = key;
}

/** Points the panel at a project's most recent shell, or at nothing. */
export function follow(project: string | null) {
  const own = project === null ? [] : forProject(project);
  terminals.active = own.length > 0 ? own[own.length - 1].key : null;
}

/** Adds a tab and makes it the one shown. The process starts when the tab's
    terminal mounts and knows its size. */
export function create(project: string): Shell {
  ordinals[project] = (ordinals[project] ?? 0) + 1;
  const shell: Shell = {
    key: `t${++counter}`,
    project,
    ptyId: null,
    status: "starting",
    ordinal: ordinals[project],
    exitCode: null,
    error: null,
  };
  terminals.all.push(shell);
  const live = terminals.all[terminals.all.length - 1];
  terminals.active = live.key;
  return live;
}

export async function launch(
  key: string,
  cols: number,
  rows: number,
  onOutput: (bytes: Uint8Array) => void,
): Promise<boolean> {
  const shell = byKey(key);
  if (shell === null) return false;
  try {
    const ptyId = await core().spawnShell(
      { project: shell.project, cols, rows },
      onOutput,
    );
    if (started(key, ptyId)) return true;
    // Closed while it was coming up: nothing owns it, so it must not run on.
    core()
      .kill(ptyId)
      .catch(() => {});
    return false;
  } catch (error) {
    failed(key, String(error));
    return false;
  }
}

export function started(key: string, ptyId: string): boolean {
  const shell = byKey(key);
  if (shell === null) return false;
  shell.ptyId = ptyId;
  shell.status = "running";

  const early = claim(ptyId);
  if (early !== undefined) ended(early);
  return true;
}

export function failed(key: string, error: string) {
  const shell = byKey(key);
  if (shell === null) return;
  shell.ptyId = null;
  shell.status = "failed";
  shell.error = error;
}

/** False when no tab here has that pty. */
export function ended(event: SessionEnded): boolean {
  const shell = terminals.all.find((candidate) => candidate.ptyId === event.id);
  if (shell === undefined) return false;
  shell.ptyId = null;
  shell.exitCode = event.code;
  if (event.clean) {
    remove(shell);
    return true;
  }
  shell.status = "crashed";
  return true;
}

/** Closes a tab for good, stopping the shell first if it is still going. */
export function close(key: string) {
  const shell = byKey(key);
  if (shell === null) return;
  if (shell.ptyId !== null) {
    core()
      .kill(shell.ptyId)
      .catch(() => {});
    shell.ptyId = null;
  }
  remove(shell);
}

/** The project is going, and the panel with what it shows next, not away. */
export function closeProject(project: string) {
  if (activeShell()?.project === project) terminals.active = null;
  for (const shell of forProject(project)) close(shell.key);
}

/**
 * Takes a tab out. The last tab of the project you are looking at takes the
 * panel with it: an empty panel is not what closing the shell asked for.
 */
function remove(shell: Shell) {
  const wasShown = terminals.active === shell.key;
  terminals.all.splice(terminals.all.indexOf(shell), 1);
  if (!wasShown) return;

  const siblings = forProject(shell.project);
  if (siblings.length > 0) {
    terminals.active = siblings[siblings.length - 1].key;
    return;
  }
  terminals.active = null;
  hideTerminal();
}

export function statusMessage(shell: Shell): string {
  switch (shell.status) {
    case "starting":
      return "Starting…";
    case "running":
      return "Running.";
    case "crashed":
      return shell.exitCode === null
        ? "The shell was stopped."
        : `The shell exited with code ${shell.exitCode}.`;
    case "failed":
      return shell.error ?? "The shell could not be started.";
  }
}

/** Test seam. */
export function reset() {
  terminals.all = [];
  terminals.active = null;
  counter = 0;
  ordinals = {};
}
