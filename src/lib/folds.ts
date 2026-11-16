import { getContext, setContext } from "svelte";
import { SvelteSet } from "svelte/reactivity";

/**
 * The folds of a thread that stand open, by their `foldKey`. The thread
 * shares the set its conversation keeps, so a fold drawn again after the
 * thread left it out is as the user left it, and something other than a
 * click can open one.
 */

const FOLDS = Symbol("folds");

/** Shares the open folds with what the thread draws. */
export function shareFolds(open: () => SvelteSet<string>) {
  setContext(FOLDS, open);
}

/** The open folds of the thread this is drawn in, or a set of its own
    when it is drawn outside one. */
export function openFolds(): () => SvelteSet<string> {
  const shared = getContext<(() => SvelteSet<string>) | undefined>(FOLDS);
  if (shared !== undefined) return shared;
  const own = new SvelteSet<string>();
  return () => own;
}

export function toggle(open: SvelteSet<string>, key: string) {
  if (open.has(key)) open.delete(key);
  else open.add(key);
}
