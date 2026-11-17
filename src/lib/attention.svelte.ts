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

/** The page has the keyboard. */
let page = true;
/** One of the window's own browser tabs has the keyboard, which takes it
    from the page while the window stays the one in front. */
let tab = false;

function settle() {
  attention.focused = page || tab;
}

/** Follows the window's focus: the page's, and a browser tab's in the
    window while it holds the keyboard. Returns a stop function. */
export function followFocus(target: Window = window): () => void {
  page = target.document.hasFocus();
  tab = false;
  settle();
  const on = () => {
    page = true;
    tab = false;
    settle();
  };
  const off = () => {
    page = false;
    settle();
  };
  target.addEventListener("focus", on);
  target.addEventListener("blur", off);
  return () => {
    target.removeEventListener("focus", on);
    target.removeEventListener("blur", off);
  };
}

/** A browser tab in the window took the keyboard from the page: the window
    is still the one the user is in. */
export function tabFocused() {
  tab = true;
  settle();
}

/** The window itself became the one in front, or stopped being it, as the
    system says. Back in front with the page not holding the keyboard, a
    browser tab of the window holds it. */
export function windowFocused(focused: boolean, target: Window = window) {
  tab = focused && !target.document.hasFocus();
  settle();
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
  page = true;
  tab = false;
  shown = null;
}
