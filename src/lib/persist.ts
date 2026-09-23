import { core, type Settings } from "$lib/core";

/**
 * Hands a change to the settings to the core, which keeps them for the
 * machine and tells every window what they now are.
 *
 * The window changes its own state first and sends after, so a choice shows
 * at once. While changes are on their way the window's state is ahead of
 * the core's news, and news that arrives then is an echo of something
 * already shown, or older: it is let pass. When the last change is answered,
 * what the core answered with is what the window settles on.
 */

let inFlight = 0;
let settle: ((settings: Settings) => void) | null = null;

/** What to do with the settings the core answers the last change with. */
export function onSettled(handler: ((settings: Settings) => void) | null) {
  settle = handler;
}

/** Whether a change is on its way to the core. */
export function sending(): boolean {
  return inFlight > 0;
}

export function persist(change: Partial<Settings>) {
  let answer: Promise<Settings>;
  try {
    answer = core().settingsSet(change);
    if (typeof answer?.then !== "function") return;
  } catch {
    // A core without settings: the window's own copy holds for this run.
    return;
  }
  inFlight += 1;
  answer.then(
    (settings) => {
      inFlight -= 1;
      if (inFlight === 0) settle?.(settings);
    },
    () => {
      inFlight -= 1;
    },
  );
}

/** Test seam. */
export function resetPersist() {
  inFlight = 0;
  settle = null;
}
