/**
 * How an agent's sessions run: in a terminal, the agent's own interface in
 * a pty, or integrated, the agent driven in messages with the conversation
 * drawn by the window.
 *
 * It is a setting per agent, kept with the others for the machine, and a
 * terminal unless the user says otherwise. Only an agent the core can drive
 * in messages can run integrated; the rest always run in a terminal.
 */

import type { AgentId, Settings } from "$lib/core";
import { persist } from "$lib/persist";

export type SessionKind = "terminal" | "integrated";

/** The agents that can run integrated, in the order they are offered. */
export const INTEGRABLE: AgentId[] = ["claude-code"];

export const sessionKinds = $state({
  /** The agents whose sessions run integrated. */
  integrated: [] as AgentId[],
});

export function canIntegrate(agent: AgentId): boolean {
  return INTEGRABLE.includes(agent);
}

/** How a new session of the agent runs unless it is started the other way. */
export function kindFor(agent: AgentId): SessionKind {
  return canIntegrate(agent) && sessionKinds.integrated.includes(agent)
    ? "integrated"
    : "terminal";
}

/** The other way to run a session of the agent, or null when it runs only
    one way. */
export function otherKind(agent: AgentId): SessionKind | null {
  if (!canIntegrate(agent)) return null;
  return kindFor(agent) === "integrated" ? "terminal" : "integrated";
}

/** This part of the settings. */
export function sessionKindSettings(): Pick<Settings, "integrated"> {
  return { integrated: [...sessionKinds.integrated] };
}

/** Takes the core's word for the machine. An agent that cannot run
    integrated is left out, and so is anything that is not an agent. */
export function adoptSessionKinds(integrated: unknown) {
  const named = Array.isArray(integrated) ? integrated : [];
  sessionKinds.integrated = INTEGRABLE.filter((agent) => named.includes(agent));
}

/** Sets how the agent's sessions run, from the next one started. */
export function setKind(agent: AgentId, kind: SessionKind) {
  if (!canIntegrate(agent) || kindFor(agent) === kind) return;
  const others = sessionKinds.integrated.filter((known) => known !== agent);
  sessionKinds.integrated =
    kind === "integrated"
      ? INTEGRABLE.filter((known) => known === agent || others.includes(known))
      : others;
  persist({ integrated: [...sessionKinds.integrated] });
}

/** Test seam. */
export function resetSessionKinds() {
  sessionKinds.integrated = [];
}
