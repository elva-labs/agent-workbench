import { core, type Process, type SessionEnded } from "$lib/core";
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
 * Shells come in groups. A group is what the panel shows at a time: one shell,
 * or several side by side once one of them has been split. The list beside
 * the shells names every group of the project, and the active shell decides
 * which group is on screen.
 *
 * A shell that exits cleanly takes its slot with it, which is what typing
 * `exit` means. One that dies any other way stays, with the code, because a
 * shell that vanishes on a crash hides the crash.
 */

export type ShellStatus = "starting" | "running" | "crashed" | "failed";

export interface Shell {
  /** Stable for the lifetime of the slot, unlike the pty id. */
  key: string;
  project: string;
  /** Shells that share a group sit side by side, in list order. */
  group: string;
  ptyId: string | null;
  status: ShellStatus;
  /** Position among the project's shells at creation. Never reused. */
  ordinal: number;
  /** Share of the group's width, relative to its siblings. */
  weight: number;
  exitCode: number | null;
  error: string | null;
  /** A command to type at the prompt once the shell is up, not run: what
      the agent's terminal tool asked for. */
  typed: string | null;
}

/** How long after its first output a shell gets to finish its prompt
    before a command is typed. */
export const TYPE_AFTER = 300;

/** The text with every control character dropped: a carriage return would
    run the command, and an escape sequence could drive the terminal. */
export function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/** Narrower than this and a split shell shows a prompt and little else. */
export const MIN_SPLIT = 200;

/** The question before a shell is closed with something running in it. */
export interface ShellAsk {
  key: string;
  /** What was started at its prompt and still runs, the first started
      first: each command as the system has it. */
  running: string[];
  /** A key on the shell's row asked, so the keyboard goes back to the
      rows once it is answered. */
  fromRow: boolean;
}

export const terminals = $state({
  all: [] as Shell[],
  active: null as string | null,
  /** The question over the panel, if one is up. */
  asking: null as ShellAsk | null,
});

let counter = 0;
let groups = 0;
let ordinals: Record<string, number> = {};

export function forProject(project: string): Shell[] {
  return terminals.all.filter((shell) => shell.project === project);
}

/** The project's groups in the order they were opened, each in slot order. */
export function groupsFor(project: string): Shell[][] {
  const result: Shell[][] = [];
  const seen = new Map<string, Shell[]>();
  for (const shell of forProject(project)) {
    let group = seen.get(shell.group);
    if (group === undefined) {
      group = [];
      seen.set(shell.group, group);
      result.push(group);
    }
    group.push(shell);
  }
  return result;
}

/** The shells sharing a group with this one, itself included, in slot order. */
export function groupOf(key: string): Shell[] {
  const shell = byKey(key);
  if (shell === null) return [];
  return terminals.all.filter((candidate) => candidate.group === shell.group);
}

export function activeShell(): Shell | null {
  return terminals.all.find((shell) => shell.key === terminals.active) ?? null;
}

/** The group on screen: the active shell's. */
export function shownGroup(): string | null {
  return activeShell()?.group ?? null;
}

export function byKey(key: string): Shell | null {
  return terminals.all.find((shell) => shell.key === key) ?? null;
}

export function label(shell: Shell): string {
  return `shell ${shell.ordinal}`;
}

/** Brings a shell to the front. A question about another shell is put
    away, as the editor's is when another tab comes forward. */
export function select(key: string) {
  if (byKey(key) === null) return;
  terminals.active = key;
  if (terminals.asking !== null && terminals.asking.key !== key) terminals.asking = null;
}

/** Steps to the next or previous shell of the project, in list order and
    wrapping around. False when there is nothing to step to. */
export function cycle(project: string, direction: 1 | -1): boolean {
  const own = forProject(project);
  if (own.length < 2) return false;
  const at = own.findIndex((shell) => shell.key === terminals.active);
  const next = at === -1 ? 0 : (at + direction + own.length) % own.length;
  select(own[next].key);
  return true;
}

/** Points the panel at a project's most recent shell, or at nothing. */
export function follow(project: string | null) {
  const own = project === null ? [] : forProject(project);
  terminals.active = own.length > 0 ? own[own.length - 1].key : null;
}

/** Adds a shell in a group of its own and makes it the one shown. The process
    starts when the shell's terminal mounts and knows its size. */
export function create(project: string, typed: string | null = null): Shell {
  const shell = add(project, `g${++groups}`, terminals.all.length, 1);
  shell.typed = typed;
  return shell;
}

/**
 * Opens a shell beside this one, in the same group, taking half its width.
 * The rest of the group keeps its size: splitting a slot is not a claim on
 * its neighbours.
 */
export function split(key: string): Shell | null {
  const source = byKey(key);
  if (source === null) return null;
  source.weight /= 2;
  return add(
    source.project,
    source.group,
    terminals.all.indexOf(source) + 1,
    source.weight,
  );
}

function add(
  project: string,
  group: string,
  at: number,
  weight: number,
): Shell {
  ordinals[project] = (ordinals[project] ?? 0) + 1;
  const shell: Shell = {
    key: `t${++counter}`,
    project,
    group,
    ptyId: null,
    status: "starting",
    ordinal: ordinals[project],
    weight,
    exitCode: null,
    error: null,
    typed: null,
  };
  terminals.all.splice(at, 0, shell);
  const live = terminals.all[at];
  select(live.key);
  return live;
}

/**
 * Moves the boundary on this shell's left by `dx` pixels, given the width the
 * group has to divide. The neighbour grows by what this one gives up, and
 * neither drops below `MIN_SPLIT`.
 */
export function resizeSplit(key: string, dx: number, width: number) {
  const group = groupOf(key);
  const at = group.findIndex((shell) => shell.key === key);
  if (at < 1 || width <= 0) return;
  const left = group[at - 1];
  const right = group[at];

  const total = group.reduce((sum, shell) => sum + shell.weight, 0);
  const perPixel = total / width;
  const floor = MIN_SPLIT * perPixel;
  const delta = Math.max(
    floor - left.weight,
    Math.min(dx * perPixel, right.weight - floor),
  );
  if (delta === 0) return;
  left.weight += delta;
  right.weight -= delta;
}

/** Gives every shell in this one's group the same width again. */
export function equalize(key: string) {
  for (const shell of groupOf(key)) shell.weight = 1;
}

/** This shell's fraction of its group's width. Always sums to one across the
    group, so a group fills its row whatever a closed sibling took with it. */
export function share(shell: Shell): number {
  const total = groupOf(shell.key).reduce(
    (sum, sibling) => sum + sibling.weight,
    0,
  );
  return total > 0 ? shell.weight / total : 1;
}

export async function launch(
  key: string,
  cols: number,
  rows: number,
  onOutput: (bytes: Uint8Array) => void,
): Promise<boolean> {
  const shell = byKey(key);
  if (shell === null) return false;
  // A command the agent asked to have typed goes in once the shell has
  // drawn something, its prompt: typed earlier, a slow shell may lose it.
  let primed = false;
  const output = (bytes: Uint8Array) => {
    onOutput(bytes);
    if (primed) return;
    primed = true;
    setTimeout(() => typePending(shell), TYPE_AFTER);
  };
  try {
    const ptyId = await core().spawnShell(
      { project: shell.project, cols, rows },
      output,
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

/** Types what the agent asked for at the shell's prompt: not sent, no
    newline, so the user reads it and presses Enter. Nothing that is not
    printable reaches the pty, whatever asked. */
function typePending(shell: Shell) {
  const typed = shell.typed === null ? null : printable(shell.typed);
  shell.typed = null;
  if (typed === null || typed === "") return;
  if (shell.ptyId === null || shell.status !== "running") return;
  core()
    .write(shell.ptyId, typed)
    .catch(() => {});
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

/**
 * Closes a shell as the user asked, by a chord, its row's Delete or its ×.
 * One with something still running in it, a dev server say, asks first:
 * the shell comes to the front and the question goes over the panel. One
 * at an idle prompt closes at once. True when it closed.
 */
export async function closeAsking(key: string, fromRow = false): Promise<boolean> {
  const shell = byKey(key);
  if (shell === null) return true;
  const running = shell.ptyId === null || shell.status !== "running" ? [] : await runningIn(shell.ptyId);
  // Gone, or asked about already, while the core was asked.
  if (byKey(key) === null) return true;
  if (terminals.asking?.key === key) return false;
  if (running.length === 0) {
    close(key);
    return true;
  }
  select(key);
  terminals.asking = { key, running, fromRow };
  return false;
}

/** Programs a shell's prompt keeps running for the shell's whole life,
    such as powerlevel10k's git status daemon: nothing the user started, so
    neither they nor what they run are a reason to ask. */
const HELPERS = [/^gitstatusd/];

/** Shells, which count for what they run rather than for themselves: a
    prompt's worker for its asynchronous parts is one, idle, and so is a
    shell typed at the prompt and left there. */
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "pwsh", "powershell", "cmd"]);

function program(name: string): string {
  return name.replace(/^-/, "").replace(/\.exe$/i, "").toLowerCase();
}

/**
 * What was started at the prompt of the shell on this pty and still runs,
 * the first started first: the processes highest under the shell, leaving
 * out a prompt's helpers with everything under them, and counting a shell
 * started under it for what it runs. What a named process started in turn
 * goes with it and is not named.
 */
export async function runningIn(ptyId: string): Promise<string[]> {
  let under: Process[];
  try {
    under = await core().ptyProcesses(ptyId);
  } catch {
    return [];
  }
  const byPid = new Map(under.map((process) => [process.pid, process]));
  const helped = (process: Process) => {
    const seen = new Set<number>();
    for (let at: Process | undefined = process; at !== undefined && !seen.has(at.pid); at = byPid.get(at.parent)) {
      if (HELPERS.some((helper) => helper.test(program(at!.name)))) return true;
      seen.add(at.pid);
    }
    return false;
  };
  const kept = under.filter((process) => !helped(process) && !SHELLS.has(program(process.name)));
  const pids = new Set(kept.map((process) => process.pid));
  return kept
    .filter((process) => !pids.has(process.parent))
    .sort((a, b) => a.started - b.started)
    .map((process) => process.command || process.name);
}

/** A command as a question names it: short enough to read at once. */
export function shortCommand(command: string): string {
  return command.length > 48 ? `${command.slice(0, 47).trimEnd()}…` : command;
}

/** The question's answer: close the shell after all. */
export function closeAsked() {
  const asked = terminals.asking;
  terminals.asking = null;
  if (asked !== null) close(asked.key);
}

/** The question's answer: keep the shell. */
export function keepAsked() {
  terminals.asking = null;
}

/** The project is going, and the panel with what it shows next, not away. */
export function closeProject(project: string) {
  if (activeShell()?.project === project) terminals.active = null;
  for (const shell of forProject(project)) close(shell.key);
}

/**
 * Takes a shell out. Focus stays in the group while it has a shell left,
 * then falls back to the project's most recent one. The last shell of the
 * project you are looking at takes the panel with it: an empty panel is not
 * what closing the shell asked for.
 */
function remove(shell: Shell) {
  if (terminals.asking?.key === shell.key) terminals.asking = null;
  const wasActive = terminals.active === shell.key;
  const group = groupOf(shell.key);
  const at = group.indexOf(shell);
  terminals.all.splice(terminals.all.indexOf(shell), 1);
  if (!wasActive) return;

  const neighbour = group[at - 1] ?? group[at + 1];
  if (neighbour !== undefined) {
    terminals.active = neighbour.key;
    return;
  }
  const own = forProject(shell.project);
  if (own.length > 0) {
    terminals.active = own[own.length - 1].key;
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
  terminals.asking = null;
  counter = 0;
  groups = 0;
  ordinals = {};
}
