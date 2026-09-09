/**
 * A word to the user, shown until dismissed and then never again: for now
 * the one that says agent hooks are worth turning on, to a setup that has
 * them off. A dismissal is kept the way the layout is, in the window's
 * storage, so a restart does not bring the word back.
 */

import { hook, loadHooks } from "$lib/hook.svelte";

const KEY = "workbench.notices";

export const notices = $state({
  /** The hooks notice was dismissed, or retired by hooks being turned on. */
  hooksDismissed: false,
});

let loaded = false;

export function loadNotices() {
  loaded = true;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    const record =
      parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    notices.hooksDismissed = record.hooks === "dismissed";
  } catch {
    notices.hooksDismissed = false;
  }
}

function save() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ hooks: notices.hooksDismissed ? "dismissed" : null }),
    );
  } catch {
    // Non-fatal: the word comes back after a restart.
  }
}

/** Whether the hooks notice is on screen: hooks off everywhere, and the
    word not yet dismissed. */
export function hooksNoticeDue(): boolean {
  return loaded && !notices.hooksDismissed && !hook.everywhere;
}

export function dismissHooksNotice() {
  if (!loaded) loadNotices();
  notices.hooksDismissed = true;
  save();
}

/** Hooks turned on while the word was up is the word taken: it is retired
    so turning them off again later does not bring it back. */
export function retireHooksNotice() {
  if (!loaded) loadNotices();
  if (hook.everywhere && !notices.hooksDismissed) dismissHooksNotice();
}

/** Test seam. */
export function resetNotices() {
  loaded = true;
  notices.hooksDismissed = false;
  loadHooks();
}
