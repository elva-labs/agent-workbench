/**
 * What closing the window takes with it, and the shells closing a session
 * or a project takes.
 *
 * Closing the window ends the app, and every session and shell running in
 * it with it. So the core holds the window's close, by any way it is asked
 * for, and the app's quit, while a session runs, a shell is open or the
 * editor holds unsaved edits, and the window decides whether to ask. The
 * window keeps the core told whether sessions run or shells are open; the
 * editor tells it about the edits. A row left from the last quit runs
 * nothing until it is woken, so it is not counted, and a shell counts only
 * while something started at its prompt still runs in it.
 *
 * Closing a session closes the shells that belong to it, and closing a
 * project every shell that started in it, so either asks first while one of
 * those is busy, in the same words.
 */

import { untrack } from "svelte";
import { core } from "$lib/core";
import { anyUnsaved, editor, leaveRequested } from "$lib/editor.svelte";
import { byKey as sessionByKey, groupOf, isLive, label as sessionLabel, sessions } from "$lib/sessions.svelte";
import {
  belongsTo,
  forOwner,
  forProject,
  label,
  ownerOnScreen,
  runningIn,
  shortCommand,
  terminals,
  type Shell,
} from "$lib/terminals.svelte";
import { projectLabel } from "$lib/workspace.svelte";

/** A shell with something running in it, as the question names it. */
export interface BusyShell {
  label: string;
  /** What runs in it, the first started first. */
  running: string[];
}

export const leaving = $state({
  /** The busy shells the question names, once they are read. */
  busy: [] as BusyShell[],
});

/** How long a shell's processes are waited for before the window decides
    without them: well inside the time the core waits for the question. */
export const READ_WITHIN = 1500;

/** The sessions running, and how many of them wait on the user: asking
    for a permission, or stopped with something unread. */
export function running(): { count: number; waiting: number } {
  const live = sessions.all.filter(isLive);
  return { count: live.length, waiting: live.filter((session) => groupOf(session) === "needs").length };
}

/** Whether a shell has a process behind it. */
function isOpen(shell: Shell): boolean {
  return shell.ptyId !== null && shell.status === "running";
}

/** The shells with a process behind them, in every project. */
function openShells(): Shell[] {
  return terminals.all.filter(isOpen);
}

/** A shell named from where the user is: alone when it is one of the shells
    on screen, else with the session or the project it belongs to. */
function fromScreen(shell: Shell): string {
  if (belongsTo(shell, ownerOnScreen())) return label(shell);
  return elsewhere(shell);
}

/** A shell named with the session it belongs to, or the project when it is
    the project's own. */
function elsewhere(shell: Shell): string {
  const session = shell.session === null ? null : sessionByKey(shell.session);
  if (session !== null) return `${label(shell)} of ${sessionLabel(session)}`;
  return `${label(shell)} in ${projectLabel(shell.project)}`;
}

/** Keeps the core told whether sessions run or shells are open. Runs in an
    effect root: call once, from the page. */
export function watchRunning() {
  $effect(() => {
    const any = running().count > 0 || openShells().length > 0;
    untrack(() => void core().setRunning(any).catch(() => {}));
  });
}

/** Of these shells, the ones with something still running in them, each
    named for the question: by default every open shell, one not on screen
    saying which session or project it belongs to. A shell whose processes
    are not read in time counts as idle. */
export async function busyShells(shells: Shell[] = openShells(), name: (shell: Shell) => string = fromScreen): Promise<BusyShell[]> {
  const read = await Promise.all(
    shells.filter(isOpen).map(async (shell) => {
      const late = new Promise<string[]>((done) => setTimeout(() => done([]), READ_WITHIN));
      const running = await Promise.race([runningIn(shell.ptyId!), late]);
      return { label: name(shell), running };
    }),
  );
  return read.filter((shell) => shell.running.length > 0);
}

/** What is being closed from the sessions pane: a session, by its key, or
    a project, by its path. */
export type Closed = { session: string } | { project: string };

/** The busy shells closing a session or a project would stop: the
    session's own, or every shell that started in the project. A session's
    are named alone; a project's own are too, and a session's say which. */
export function busyGoing(closed: Closed): Promise<BusyShell[]> {
  if ("session" in closed) {
    const session = sessionByKey(closed.session);
    if (session === null) return Promise.resolve([]);
    return busyShells(forOwner({ project: session.project, session: session.key }), label);
  }
  return busyShells(forProject(closed.project), (shell) => (shell.session === null ? label(shell) : elsewhere(shell)));
}

/** The core held back the window's close or the app's quit. With sessions
    running or edits unsaved the question goes up at once, and names the
    busy shells once they are read; otherwise the shells are read first,
    and the window goes at once when none is busy. */
export async function leaveAsked(ask: { kind: "window" | "quit"; generation: number }) {
  if (running().count > 0 || anyUnsaved()) {
    leaving.busy = [];
    leaveRequested(ask);
    leaving.busy = await busyShells();
    return;
  }
  const busy = await busyShells();
  if (busy.length === 0 && running().count === 0 && !anyUnsaved()) {
    if (editor.asking?.kind === "leave") editor.asking = null;
    void core().leaveConfirmed(ask.kind).catch(() => {});
    return;
  }
  leaving.busy = busy;
  leaveRequested(ask);
}

/** A count and its noun, kept together on one line. */
function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What runs, as one noun phrase: sessions, busy shells, or both. */
function what(count: number, shells: number): string {
  return [
    count > 0 ? counted(count, "session", "sessions") : null,
    shells > 0 ? counted(shells, "busy shell", "busy shells") : null,
  ]
    .filter((part) => part !== null)
    .join(" and ");
}

/** Where the busy shells' first commands run. */
function shellsSentence(busy: BusyShell[]): string {
  const first = (shell: BusyShell) => `“${shortCommand(shell.running[0])}”`;
  if (busy.length === 1) {
    const [shell] = busy;
    const more = shell.running.length - 1;
    return more === 0
      ? `${first(shell)} is running in ${shell.label}.`
      : `${first(shell)} and ${counted(more, "more", "more")} are running in ${shell.label}.`;
  }
  const [one, two, ...rest] = busy;
  const named = `${first(one)} is running in ${one.label}`;
  if (rest.length === 0) return `${named}, and ${first(two)} in ${two.label}.`;
  return `${named}, ${first(two)} in ${two.label}, and something in ${counted(rest.length, "more", "more")}.`;
}

/** The question and what it says, for sessions running or shells busy
    and nothing unsaved. */
export function runningQuestion(
  kind: "window" | "quit",
  { count, waiting }: { count: number; waiting: number },
  busy: BusyShell[] = [],
): { question: string; detail: string; action: string } {
  const action = kind === "quit" ? "Quit" : "Close window";
  const total = count + busy.length;
  // Everything ended while the question was up.
  if (total === 0) {
    return { question: kind === "quit" ? "Quit?" : "Close the window?", detail: "Nothing is running now.", action };
  }
  const running = what(count, busy.length);
  const question = kind === "quit" ? `Quit with ${running} running?` : `Close the window with ${running} running?`;
  const sentences: string[] = [];
  if (waiting > 0) {
    sentences.push(
      count === 1
        ? "The session is waiting on you."
        : `${waiting} of the sessions ${waiting === 1 ? "is" : "are"} waiting on you.`,
    );
  }
  if (busy.length > 0) sentences.push(shellsSentence(busy));
  const them = total === 1 ? "it" : "them";
  sentences.push(kind === "quit" ? `Quitting stops ${them}.` : `Closing the window quits the app and stops ${them}.`);
  if (count > 0) {
    sentences.push(
      count === 1
        ? "The session comes back as a row next time, to resume."
        : "The sessions come back as rows next time, to resume.",
    );
  }
  return { question, detail: sentences.join(" "), action };
}

/** What the unsaved question adds about sessions running and busy
    shells, if any. */
export function runningAside({ count }: { count: number; waiting: number }, busy: BusyShell[] = []): string {
  const total = count + busy.length;
  if (total === 0) return "";
  return ` ${what(count, busy.length)} ${total === 1 ? "is" : "are"} running, and ${total === 1 ? "stops" : "stop"} with the app.`;
}

/** The question before a session or a project closes while shells that go
    with it are busy, and nothing is unsaved: the window's words, for what
    is closed. */
export function closingQuestion(
  kind: "session" | "project",
  name: string,
  busy: BusyShell[],
): { question: string; detail: string; action: string } {
  const them = busy.length === 1 ? "it" : "them";
  return {
    question: `Close ${name} with ${what(0, busy.length)} running?`,
    detail: `${shellsSentence(busy)} Closing the ${kind} stops ${them}.`,
    action: kind === "session" ? "Close session" : "Close project",
  };
}

/** What the unsaved question about closing a session or a project adds
    about the busy shells that go with it, if any. */
export function closingAside(kind: "session" | "project", busy: BusyShell[]): string {
  if (busy.length === 0) return "";
  return ` ${what(0, busy.length)} ${busy.length === 1 ? "is" : "are"} running, and ${busy.length === 1 ? "stops" : "stop"} with the ${kind}.`;
}
