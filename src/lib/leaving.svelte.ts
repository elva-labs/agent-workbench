/**
 * What closing the window takes with it.
 *
 * Closing the window ends the app, and every session running in it with
 * it. So the core holds the window's close, by any way it is asked for,
 * and the app's quit, while a session runs or the editor holds unsaved
 * edits, and the window asks first. The window keeps the core told whether
 * sessions run; the editor tells it about the edits. A row left from the
 * last quit runs nothing until it is woken, so it is not counted.
 */

import { untrack } from "svelte";
import { core } from "$lib/core";
import { anyUnsaved, editor, leaveRequested } from "$lib/editor.svelte";
import { groupOf, isLive, sessions } from "$lib/sessions.svelte";

/** The sessions running, and how many of them wait on the user: asking
    for a permission, or stopped with something unread. */
export function running(): { count: number; waiting: number } {
  const live = sessions.all.filter(isLive);
  return { count: live.length, waiting: live.filter((session) => groupOf(session) === "needs").length };
}

/** Keeps the core told whether sessions run. Runs in an effect root: call
    once, from the page. */
export function watchRunning() {
  $effect(() => {
    const any = running().count > 0;
    untrack(() => void core().setRunning(any).catch(() => {}));
  });
}

/** The core held back the window's close or the app's quit. The question
    goes up, unless what held it is gone by now: a session that ended, a
    file saved meanwhile. Then the window goes at once. */
export function leaveAsked(ask: { kind: "window" | "quit"; generation: number }) {
  if (running().count === 0 && !anyUnsaved()) {
    if (editor.asking?.kind === "leave") editor.asking = null;
    void core().leaveConfirmed(ask.kind).catch(() => {});
    return;
  }
  leaveRequested(ask);
}

const sessionsWord = (count: number) => (count === 1 ? "1 session" : `${count} sessions`);

/** The question and what it says, for sessions running and nothing
    unsaved. */
export function runningQuestion(
  kind: "window" | "quit",
  { count, waiting }: { count: number; waiting: number },
): { question: string; detail: string; action: string } {
  const action = kind === "quit" ? "Quit" : "Close window";
  // Every session ended while the question was up.
  if (count === 0) {
    return { question: kind === "quit" ? "Quit?" : "Close the window?", detail: "No session is running now.", action };
  }
  const question =
    kind === "quit"
      ? `Quit with ${sessionsWord(count)} running?`
      : `Close the window with ${sessionsWord(count)} running?`;
  const asking =
    waiting === 0
      ? ""
      : count === 1
        ? "It is waiting on you. "
        : `${waiting} of them ${waiting === 1 ? "is" : "are"} waiting on you. `;
  const one = count === 1;
  const stops =
    kind === "quit"
      ? `Quitting stops ${one ? "it" : "them"}.`
      : `Closing the window quits the app and stops ${one ? "it" : "them"}.`;
  const back = one ? "It comes back as a row next time, to resume." : "They come back as rows next time, to resume.";
  return { question, detail: `${asking}${stops} ${back}`, action };
}

/** What the unsaved question adds about sessions running, if any. */
export function runningAside({ count }: { count: number; waiting: number }): string {
  if (count === 0) return "";
  return count === 1 ? " 1 session is running, and stops with the app." : ` ${count} sessions are running, and stop with the app.`;
}
