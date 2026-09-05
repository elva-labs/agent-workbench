import { core } from "$lib/core";

/**
 * Whether the window has the user's attention, and what the app's icon says
 * when it does not.
 *
 * A session that stops while it is on screen in a focused window was seen
 * stop; one that stops anywhere else was not, and is unread until it is
 * looked at. The window's focus is the difference, so it is tracked here,
 * and the count of unread sessions goes on the icon as a badge.
 */
export const attention = $state({
  /** Whether the window is the one the user is looking at. */
  focused: true,
});

/** Follows the window's focus. Returns a stop function. */
export function followFocus(target: Window = window): () => void {
  attention.focused = target.document.hasFocus();
  const on = () => (attention.focused = true);
  const off = () => (attention.focused = false);
  target.addEventListener("focus", on);
  target.addEventListener("blur", off);
  return () => {
    target.removeEventListener("focus", on);
    target.removeEventListener("blur", off);
  };
}

let shown: number | null = null;

/** Puts the count on the icon, once per change. Nothing to say is no badge. */
export function badge(count: number) {
  const next = count === 0 ? null : count;
  if (next === shown) return;
  shown = next;
  core()
    .setBadge(next)
    .catch(() => {});
}

/** Test seam. */
export function resetAttention() {
  attention.focused = true;
  shown = null;
}
