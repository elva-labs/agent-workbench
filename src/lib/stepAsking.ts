import { getContext, setContext } from "svelte";

/**
 * Which calls of a thread started a subagent that asks for something now,
 * from inside it or to start it, shared with the steps the thread draws so
 * the step of such a call says it asks, as the subagent's row on the rail
 * does.
 */

const ASKING = Symbol("asking");

const NONE: ReadonlyMap<string, number> = new Map();

export function shareAsking(asking: () => ReadonlyMap<string, number>) {
  setContext(ASKING, asking);
}

/** The calls whose subagent asks, in the thread this is drawn in; none
    outside one. */
export function askingCalls(): () => ReadonlyMap<string, number> {
  return getContext<(() => ReadonlyMap<string, number>) | undefined>(ASKING) ?? (() => NONE);
}
