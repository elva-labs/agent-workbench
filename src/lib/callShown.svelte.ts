/**
 * A session to be opened at a call in its conversation: the call that
 * started a subagent whose row on the sessions rail was picked, or whose
 * request the dock offers the way to. The session's conversation, once on
 * screen, takes it, brings the call into view with the folds around it and
 * the call itself open, and marks it for a moment.
 */

export const shownCall = $state<{ key: string | null; call: string | null; asked: number }>({
  key: null,
  call: null,
  asked: 0,
});

/** The call marked in the thread, while it is. */
export const markedCall = $state<{ call: string | null }>({ call: null });

/** How long a call stays marked. */
export const MARK_MS = 1600;

let timer: ReturnType<typeof setTimeout> | null = null;

/** Asks for the session with this key to open at the call. */
export function showCall(key: string, call: string) {
  shownCall.key = key;
  shownCall.call = call;
  shownCall.asked += 1;
}

/** The call the session with this key is to open at, taken so it opens
    there once; null when none waits for it. */
export function takeCall(key: string): string | null {
  if (shownCall.key !== key) return null;
  const call = shownCall.call;
  shownCall.key = null;
  shownCall.call = null;
  return call;
}

/** Marks a call for a moment. */
export function markCall(call: string) {
  markedCall.call = call;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    markedCall.call = null;
    timer = null;
  }, MARK_MS);
}

/** Test seam. */
export function resetCallShown() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  shownCall.key = null;
  shownCall.call = null;
  markedCall.call = null;
}
