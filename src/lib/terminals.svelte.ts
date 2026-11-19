import { untrack } from "svelte";
import { core, type Process, type SessionEnded } from "$lib/core";
import { claim } from "$lib/exits";
import { hideTerminal } from "$lib/layout.svelte";
import { activeSession, byKey as sessionByKey, label as sessionLabel } from "$lib/sessions.svelte";
import { projectLabel, workspace } from "$lib/workspace.svelte";

/**
 * The shells in the terminal panel.
 *
 * Plain terminals, not sessions: nothing is resumed and nothing is indexed.
 * Each starts in the project it was opened in and belongs to the session it
 * was opened beside, or to the project itself when it was opened with no
 * session on screen, the way a browser tab does. The panel shows the shells
 * of the session on screen, or of the project on screen with none, and each
 * keeps its own shell in front. A project's own shells stay in reach while
 * one of its sessions is on screen, listed apart at the foot: a shell keeps
 * a process running, and one out of sight would be a dev server nobody can
 * find. Switching session or project kills nothing: every shell stays
 * mounted, and the ones not shown are only hidden.
 *
 * Shells come in groups. A group is what the panel shows at a time: one shell,
 * or several side by side once one of them has been split. The list beside
 * the shells names every group it shows, and the active shell decides which
 * group is on screen.
 *
 * A shell that exits cleanly takes its slot with it, which is what typing
 * `exit` means. One that dies any other way stays, with the code, because a
 * shell that vanishes on a crash hides the crash.
 */

export type ShellStatus = "starting" | "running" | "crashed" | "failed";

export interface Shell {
  /** Stable for the lifetime of the slot, unlike the pty id. */
  key: string;
  /** The project it starts in, and belongs to when no session owns it. */
  project: string;
  /** The key of the session it belongs to, or null for the project's own. */
  session: string | null;
  /** Shells that share a group sit side by side, in list order. */
  group: string;
  ptyId: string | null;
  status: ShellStatus;
  /** Position among its owner's shells at creation. Never reused. */
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
  /** Counts the closes asked again while the question is up, each a call
      for the keyboard to go back to it. */
  askRequests: 0,
});

/** Whose shells: a session's, by its key, or with none the project's own. */
export interface ShellOwner {
  project: string;
  session: string | null;
}

let counter = 0;
let groups = 0;
/** The next number for each owner's shells, by owner key. */
let ordinals: Record<string, number> = {};
/** The shell each owner had in front when it was last on screen, by owner
    key. */
let fronts = new Map<string, string>();
/** The owner whose shells the panel shows, as last followed. */
let followed: ShellOwner | null = null;

function ownerKey(owner: ShellOwner): string {
  return owner.session ?? `project:${owner.project}`;
}

function sameOwner(a: ShellOwner | null, b: ShellOwner | null): boolean {
  if (a === null || b === null) return a === b;
  return ownerKey(a) === ownerKey(b);
}

/** Whose shells the panel shows: the session on screen, else the project on
    screen, else nobody's. */
export function ownerOnScreen(): ShellOwner | null {
  const session = activeSession();
  if (session !== null) return { project: session.project, session: session.key };
  if (workspace.active !== null) return { project: workspace.active, session: null };
  return null;
}

/** Whether the shell is one of the owner's. */
export function belongsTo(shell: Shell, owner: ShellOwner | null): boolean {
  if (owner === null) return false;
  if (owner.session !== null) return shell.session === owner.session;
  return shell.session === null && shell.project === owner.project;
}

/** An owner's shells, in list order. */
export function forOwner(owner: ShellOwner | null): Shell[] {
  return terminals.all.filter((shell) => belongsTo(shell, owner));
}

/** The shells of the owner on screen: what the panel cycles through and
    opens beside. */
export function ownShells(): Shell[] {
  return forOwner(ownerOnScreen());
}

/** The project's own shells listed beside a session's, at the foot of the
    panel's list: none for a project, whose own they are. */
export function besideOf(owner: ShellOwner | null): Shell[] {
  if (owner === null || owner.session === null) return [];
  return forOwner({ project: owner.project, session: null });
}

/** What the panel lists for an owner, in list order: its own shells, then
    beside a session the project's own. */
export function shownFor(owner: ShellOwner | null): Shell[] {
  return [...forOwner(owner), ...besideOf(owner)];
}

/** What the panel lists now. */
export function shownShells(): Shell[] {
  return shownFor(ownerOnScreen());
}

/** Whether showing the panel now starts a shell: someone is on screen with
    none to list. As the window starts, it waits for the sessions that were
    open to be back, so the shell goes to the one on screen. */
export function opensWithShell(): boolean {
  return ownerOnScreen() !== null && shownShells().length === 0;
}

/** A shell named with whose it is, for where it is not on screen or not
    the owner's own: the session it belongs to, and the project too when
    that is not the one in front; or the project, for the project's own. */
export function withOwner(shell: Shell): string {
  const session = shell.session === null ? null : sessionByKey(shell.session);
  if (session === null) return `${label(shell)} of ${projectLabel(shell.project)}`;
  const elsewhere = shell.project === workspace.active ? "" : ` in ${projectLabel(shell.project)}`;
  return `${label(shell)} of ${sessionLabel(session)}${elsewhere}`;
}

/** Every shell that started in the project, whoever it belongs to. */
export function forProject(project: string): Shell[] {
  return terminals.all.filter((shell) => shell.project === project);
}

/** The owner's groups in the order they were opened, each in slot order. */
export function groupsFor(owner: ShellOwner | null): Shell[][] {
  return groupsOf(forOwner(owner));
}

/** These shells' groups in the order they were opened, each in slot order. */
export function groupsOf(shells: Shell[]): Shell[][] {
  const result: Shell[][] = [];
  const seen = new Map<string, Shell[]>();
  for (const shell of shells) {
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

/** Steps to the next or previous shell of the owner on screen, in list
    order and wrapping around: the project's own beside a session are not
    among them. From one of those, it steps to the owner's first. False when
    there is nothing to step to. */
export function cycle(direction: 1 | -1): boolean {
  const own = ownShells();
  const at = own.findIndex((shell) => shell.key === terminals.active);
  if (own.length === 0 || (at !== -1 && own.length < 2)) return false;
  const next = at === -1 ? 0 : (at + direction + own.length) % own.length;
  select(own[next].key);
  return true;
}

/**
 * Points the panel at the front shell of the owner on screen: the one it
 * had in front when it was last on screen, else its newest, else the
 * project's newest listed beside it, else nothing. The owner it leaves
 * keeps its own for when it comes back. Nothing is started or stopped, so
 * a switch is only a change of what is shown.
 */
export function follow() {
  const owner = ownerOnScreen();
  if (sameOwner(owner, followed)) return;
  const front = activeShell();
  if (front !== null && followed !== null && shownFor(followed).includes(front)) fronts.set(ownerKey(followed), front.key);
  followed = owner;
  // A shell opened for the owner as it came on screen is in front already.
  if (front === null || !belongsTo(front, owner)) {
    const own = forOwner(owner);
    const beside = besideOf(owner);
    const kept = owner === null ? undefined : fronts.get(ownerKey(owner));
    terminals.active =
      shownFor(owner).find((shell) => shell.key === kept)?.key ?? own.at(-1)?.key ?? beside.at(-1)?.key ?? null;
  }
  if (terminals.asking !== null && terminals.asking.key !== terminals.active) terminals.asking = null;
}

/** Keeps the panel following the owner on screen as the session or project
    on screen changes. Runs in an effect root: call once, from the page. */
export function followOwner() {
  $effect(() => {
    ownerOnScreen();
    untrack(follow);
  });
}

/** Adds a shell in a group of its own. It is the one shown when the panel
    lists it, and its owner's front shell for when it is otherwise. The
    process starts when the shell's terminal mounts and knows its size. */
export function create(owner: ShellOwner, typed: string | null = null): Shell {
  const shell = add(owner, `g${++groups}`, terminals.all.length, 1);
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
    { project: source.project, session: source.session },
    source.group,
    terminals.all.indexOf(source) + 1,
    source.weight,
  );
}

/** The next number for a shell of this owner. */
function nextOrdinal(owner: ShellOwner): number {
  const key = ownerKey(owner);
  ordinals[key] = (ordinals[key] ?? 0) + 1;
  return ordinals[key];
}

function add(
  owner: ShellOwner,
  group: string,
  at: number,
  weight: number,
): Shell {
  const shell: Shell = {
    key: `t${++counter}`,
    project: owner.project,
    session: owner.session,
    group,
    ptyId: null,
    status: "starting",
    ordinal: nextOrdinal(owner),
    weight,
    exitCode: null,
    error: null,
    typed: null,
  };
  terminals.all.splice(at, 0, shell);
  const live = terminals.all[at];
  if (shownShells().includes(live)) select(live.key);
  else fronts.set(ownerKey(owner), live.key);
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
  // Gone while the core was asked.
  if (byKey(key) === null) return true;
  // Asked about already: the keyboard goes back to the question, where the
  // answer is.
  if (terminals.asking?.key === key) {
    terminals.askRequests += 1;
    return false;
  }
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

/** The project is going, with every shell that started in it, whoever it
    belongs to, and the panel with what it shows next, not away. */
export function closeProject(project: string) {
  if (activeShell()?.project === project) terminals.active = null;
  for (const shell of forProject(project)) {
    fronts.delete(ownerKey(shell));
    close(shell.key);
  }
}

/** Closes every shell an owner has, at once: the user said to, with what
    runs in them. The panel stays, with what it shows next. */
export function closeOwner(owner: ShellOwner) {
  const front = activeShell();
  if (front !== null && belongsTo(front, owner)) terminals.active = null;
  fronts.delete(ownerKey(owner));
  for (const shell of forOwner(owner)) close(shell.key);
}

/**
 * Gives a session's shells to the row that takes its place, as a resume
 * does: the same shells, numbers and shell in front, nothing closed. The
 * row they leave must be closed with its shells kept.
 */
export function handOver(from: string, to: ShellOwner) {
  const key = ownerKey(to);
  for (const shell of terminals.all.filter((candidate) => candidate.session === from)) {
    shell.project = to.project;
    shell.session = to.session;
    ordinals[key] = Math.max(ordinals[key] ?? 0, shell.ordinal);
  }
  const shown = activeShell();
  const front = fronts.get(from) ?? (shown !== null && belongsTo(shown, to) ? shown.key : undefined);
  fronts.delete(from);
  if (front !== undefined && !fronts.has(key)) fronts.set(key, front);
}

/**
 * A session closed, and its shells go with it. A shell with something
 * still running in it, which only happens when the user was not asked, as
 * when the session that started this one stops it, joins the project's own
 * rather than stopping what runs: a dev server never goes without the user
 * having said so, and the project's own stay listed beside each of its
 * sessions. What runs is read the way closing a shell reads it, and the
 * rest close at once.
 */
export async function sessionClosed(key: string) {
  fronts.delete(key);
  const own = terminals.all.filter((shell) => shell.session === key);
  const live: Shell[] = [];
  for (const shell of own) {
    if (shell.ptyId === null || shell.status !== "running") close(shell.key);
    else live.push(shell);
  }
  if (live.length === 0) return;
  const read = await Promise.all(live.map((shell) => runningIn(shell.ptyId!)));
  live.forEach((shell, at) => {
    // Gone, or taken in elsewhere, while the core was asked.
    const now = byKey(shell.key);
    if (now === null || now.session !== key) return;
    if (read[at].length === 0) close(now.key);
    else adopt(now);
  });
}

/** Gives a shell whose session went to the project it started in,
    numbered among the project's own. It goes in front only where nothing
    shown is. */
function adopt(shell: Shell) {
  const owner = { project: shell.project, session: null };
  shell.session = null;
  shell.ordinal = nextOrdinal(owner);
  const shown = shownShells();
  const front = activeShell();
  if (shown.includes(shell) && (front === null || !shown.includes(front))) terminals.active = shell.key;
}

/**
 * Takes a shell out. Focus stays in the group while it has a shell left,
 * then falls back to its owner's most recent one where that is listed, else
 * to the newest listed. The last shell listed takes the panel with it: an
 * empty panel is not what closing the shell asked for.
 */
function remove(shell: Shell) {
  if (terminals.asking?.key === shell.key) terminals.asking = null;
  const wasActive = terminals.active === shell.key;
  const wasShown = shownShells().includes(shell);
  const group = groupOf(shell.key);
  const at = group.indexOf(shell);
  terminals.all.splice(terminals.all.indexOf(shell), 1);
  if (!wasActive) return;

  const neighbour = group[at - 1] ?? group[at + 1];
  if (neighbour !== undefined) {
    terminals.active = neighbour.key;
    return;
  }
  const shown = shownShells();
  const next = forOwner(shell).filter((other) => shown.includes(other)).at(-1) ?? ownShells().at(-1) ?? shown.at(-1);
  if (next !== undefined) {
    terminals.active = next.key;
    return;
  }
  terminals.active = null;
  if (wasShown) hideTerminal();
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
  terminals.askRequests = 0;
  counter = 0;
  groups = 0;
  ordinals = {};
  fronts = new Map();
  followed = null;
}
