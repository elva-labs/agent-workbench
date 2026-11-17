/**
 * Whether the user is asked before every session another session starts.
 *
 * Off, a start in the starter's own project, on its agent and account,
 * goes ahead without a question where the starter's mode is known, the
 * session beginning in no more than that mode, and only the rest are put
 * to the user. On, every start is. It is a setting kept with the others
 * for the machine, off unless the user turns it on, and the user's alone
 * to change.
 */

import type { Settings } from "$lib/core";
import { persist } from "$lib/persist";

export const startAsk = $state({
  /** Whether every start is put to the user. */
  every: false,
});

/** This part of the settings. */
export function startAskSettings(): Pick<Settings, "askEveryStart"> {
  return { askEveryStart: startAsk.every };
}

/** Takes the core's word for the machine. Anything but true is off. */
export function adoptStartAsk(value: unknown) {
  startAsk.every = value === true;
}

/** Sets whether every start is put to the user, from the next one. */
export function setAskEveryStart(on: boolean) {
  startAsk.every = on;
  persist({ askEveryStart: on });
}

/** Test seam. */
export function resetStartAsk() {
  startAsk.every = false;
}
