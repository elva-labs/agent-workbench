import { getContext, setContext } from "svelte";
import { SvelteSet } from "svelte/reactivity";

/**
 * The folds of a thread that stand open, by their `foldKey`. The thread
 * shares the set its conversation keeps, so a fold drawn again after the
 * thread left it out is as the user left it, and something other than a
 * click can open one.
 *
 * Find opens a fold for a while: it lends it open and gives it back
 * closed, unless the user has toggled it since, which makes it theirs.
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

/** The folds lent open, by the set they stand open in. */
const lent = new WeakMap<SvelteSet<string>, Set<string>>();

/** The user opens or closes a fold, which is theirs from then on. */
export function toggle(open: SvelteSet<string>, key: string) {
  lent.get(open)?.delete(key);
  if (open.has(key)) open.delete(key);
  else open.add(key);
}

/** Opens a fold for a while, unless it stands open already. Answers
    whether it opened it. */
export function lend(open: SvelteSet<string>, key: string): boolean {
  if (open.has(key)) return false;
  let mine = lent.get(open);
  if (mine === undefined) lent.set(open, (mine = new Set()));
  mine.add(key);
  open.add(key);
  return true;
}

/** Closes the folds lent open, but those in `keep`. Answers whether it
    closed any. */
export function giveBack(open: SvelteSet<string>, keep: readonly string[] = []): boolean {
  const mine = lent.get(open);
  if (mine === undefined) return false;
  let closed = false;
  for (const key of [...mine]) {
    if (keep.includes(key)) continue;
    mine.delete(key);
    open.delete(key);
    closed = true;
  }
  return closed;
}
