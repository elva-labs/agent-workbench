/**
 * How an agent's sessions run: in a terminal, the agent's own interface in
 * a pty, or integrated, the agent driven in messages with the conversation
 * drawn by the window.
 *
 * It is a setting per agent, kept with the others for the machine, and a
 * terminal unless the user says otherwise. Only an agent the core says it
 * can drive in messages runs integrated; the rest always run in a terminal.
 */

import { AGENTS, agent } from "$lib/agent.svelte";
import type { AgentId, Settings } from "$lib/core";
import { persist } from "$lib/persist";

export type SessionKind = "terminal" | "integrated";

export const sessionKinds = $state({
  /** The agents whose sessions run integrated. */
  integrated: [] as AgentId[],
  /** The core's word has been taken: until then the setting is not known,
      and every agent reads as a terminal. */
  known: false,
});

/** Whether the core said it can drive the agent in messages. */
export function canIntegrate(id: AgentId): boolean {
  return agent.integrable.includes(id);
}

/** How a new session of the agent runs unless it is started the other way. */
export function kindFor(id: AgentId): SessionKind {
  return canIntegrate(id) && sessionKinds.integrated.includes(id) ? "integrated" : "terminal";
}

/** The other way to run a session of the agent, or null when it runs only
    one way. */
export function otherKind(id: AgentId): SessionKind | null {
  if (!canIntegrate(id)) return null;
  return kindFor(id) === "integrated" ? "terminal" : "integrated";
}

/** This part of the settings. */
export function sessionKindSettings(): Pick<Settings, "integrated"> {
  return { integrated: [...sessionKinds.integrated] };
}

/** Takes the core's word for the machine. Anything that is not an agent
    is left out; one the core cannot drive in messages is kept, and runs in
    a terminal until it can. */
export function adoptSessionKinds(integrated: unknown) {
  const named = Array.isArray(integrated) ? integrated : [];
  sessionKinds.integrated = AGENTS.filter((id) => named.includes(id));
  sessionKinds.known = true;
}

/** Sets how the agent's sessions run: the next one started, and the open
    ones that follow the setting, which move as `followSetting` says. */
export function setKind(id: AgentId, kind: SessionKind) {
  if (!canIntegrate(id) || kindFor(id) === kind) return;
  const others = sessionKinds.integrated.filter((known) => known !== id);
  sessionKinds.integrated =
    kind === "integrated" ? AGENTS.filter((known) => known === id || others.includes(known)) : others;
  persist({ integrated: [...sessionKinds.integrated] });
}

/** Test seam. */
export function resetSessionKinds() {
  sessionKinds.integrated = [];
  sessionKinds.known = false;
}
