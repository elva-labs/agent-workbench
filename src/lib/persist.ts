import { core, type Settings } from "$lib/core";
import { showRefusal } from "$lib/refusal.svelte";

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
 */

let inFlight = 0;
let settle: ((settings: Settings) => void) | null = null;
let recover: (() => Promise<void>) | null = null;
let outstanding: Promise<string | null>[] = [];

/** What to do when the core refuses the last change on its way: take what
    is stored. */
export function onRefused(handler: (() => Promise<void>) | null) {
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

/** What to do with the settings the core answers the last change with. */
export function onSettled(handler: ((settings: Settings) => void) | null) {
  settle = handler;
}

/** Whether a change is on its way to the core. */
export function sending(): boolean {
  return inFlight > 0;
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
    answer = core().settingsSet(change);
    if (typeof answer?.then !== "function") return Promise.resolve(null);
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
      if (inFlight === 0 && recover !== null) {
        try {
          await recover();
        } catch {
          // The window keeps what it has.
        }
      }
      if (options.quiet !== true) showRefusal(reason);
      return reason;
    },
  );
  outstanding.push(done);
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
}
