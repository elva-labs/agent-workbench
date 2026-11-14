import { core, type Settings } from "$lib/core";
import { showRefusal, type Shown } from "$lib/refusal.svelte";

/**
 * Hands a change to the settings to the core, which keeps them for the
 * machine and tells every window what they now are.
 *
 * The window changes its own state first and sends after, so a choice shows
 * at once. While changes are on their way the window's state is ahead of
 * the core's news, and news that arrives then is an echo of something
 * already shown, or older: it is let pass. When the last change is answered,
 * what the core answered with is what the window settles on. When the core
 * refuses a change and nothing else is on its way, the window goes back to
 * what is stored, and the reason is shown wherever the change was made.
 *
 * While the window hands its settings over to a file that is not there,
 * changes wait, and are sent once the hand-over is answered.
 */

/** A change sent: the settings it names, and the core's reason when it
    refused it, or null once it was kept. */
interface Sent {
  fields: string[];
  done: Promise<string | null>;
}

let inFlight = 0;
let settle: ((settings: Settings) => void) | null = null;
let recover: (() => Promise<Shown>) | null = null;
let outstanding: Promise<string | null>[] = [];
let collecting: Sent[] | null = null;
let held: Promise<unknown> | null = null;

/** What to do when the core refuses the last change on its way: take what
    is stored, and answer with what the window then shows. */
export function onRefused(handler: (() => Promise<Shown>) | null) {
  recover = handler;
}

/** Whether a refusal takes the window back to what is stored. */
export function recovering(): boolean {
  return recover !== null;
}

/** Answers once every change sent so far is answered: with the reason of
    the first one the core refused, or null when all were kept. */
export async function flush(): Promise<string | null> {
  const reasons = await Promise.all([...outstanding]);
  return reasons.find((reason) => reason !== null) ?? null;
}

/** Starts noting the changes sent from now on. Answers with what stops
    noting and answers, once each is answered, with what each named and the
    reason the core refused it, or null for one it kept. */
export function noteSent(): () => Promise<{ fields: string[]; reason: string | null }[]> {
  const mine: Sent[] = [];
  const before = collecting;
  collecting = mine;
  return async () => {
    if (collecting === mine) collecting = before;
    return Promise.all(mine.map(async (sent) => ({ fields: sent.fields, reason: await sent.done })));
  };
}

/** Holds changes back until `done` is settled, and answers with it. */
export function holdUntil<T>(done: Promise<T>): Promise<T> {
  const gate: Promise<unknown> = done.then(
    () => undefined,
    () => undefined,
  );
  held = gate;
  void gate.then(() => {
    if (held === gate) held = null;
  });
  return done;
}

/** What to do with the settings the core answers the last change with. */
export function onSettled(handler: ((settings: Settings) => void) | null) {
  settle = handler;
}

/** Whether a change is on its way to the core. */
export function sending(): boolean {
  return inFlight > 0;
}

function send(change: Partial<Settings>): Promise<Settings> | null {
  const answer = core().settingsSet(change);
  return typeof answer?.then === "function" ? answer : null;
}

/** Sends a change, and answers with the core's reason when it refuses it,
    or null once it is kept. A change a store shows the reason of itself is
    sent quiet. */
export function persist(
  change: Partial<Settings>,
  options: { quiet?: boolean } = {},
): Promise<string | null> {
  let answer: Promise<Settings>;
  try {
    if (held !== null) {
      // Sent once the hand-over is answered, laid over what it left.
      answer = held.then(() => send(change) ?? Promise.reject(new Error("no core")));
    } else {
      const sent = send(change);
      if (sent === null) return Promise.resolve(null);
      answer = sent;
    }
  } catch {
    // A core without settings: the window's own copy holds for this run.
    return Promise.resolve(null);
  }
  inFlight += 1;
  const done = answer.then(
    (settings) => {
      inFlight -= 1;
      if (inFlight === 0) {
        settle?.(settings);
        if (options.quiet !== true) showRefusal(null);
      }
      return null;
    },
    async (error: unknown) => {
      inFlight -= 1;
      const reason = error instanceof Error ? error.message : String(error);
      let shows: Shown = null;
      if (inFlight === 0 && recover !== null) {
        try {
          shows = await recover();
        } catch {
          // The window keeps what it has.
        }
      }
      if (options.quiet !== true) showRefusal(reason, shows);
      return reason;
    },
  );
  outstanding.push(done);
  collecting?.push({ fields: Object.keys(change), done });
  void done.then(() => {
    outstanding = outstanding.filter((other) => other !== done);
  });
  return done;
}

/** Test seam. */
export function resetPersist() {
  inFlight = 0;
  settle = null;
  recover = null;
  outstanding = [];
  collecting = null;
  held = null;
}
