import type { AgentId, DetectReport } from "$lib/core";

/**
 * Which agents there are to run at all.
 *
 * One question per agent, asked once, about the machine rather than about any
 * session. What individual sessions are doing lives in `sessions.svelte.ts`.
 */

/** Every agent the workbench can drive, in the order they are offered. */
export const AGENTS: AgentId[] = ["claude-code", "codex"];

/** What the window says of an agent, in one place: what it is called as a
    product and as the one speaking in a conversation, how the user signs
    in to it in a terminal, the variable that names its account's
    directory, whether it lists slash commands once ready, and whether its
    record of a conversation names the model each turn ran on. A run of an
    agent whose record does not goes under the agent's name, live or read
    back, so that a reload draws it under the same name. */
export interface AgentProfile {
  product: string;
  name: string;
  signIn: string;
  configVar: string;
  commands: boolean;
  turnModels: boolean;
  /** Its models are shown by the names its own list gives them at run
      time, its ids being no names to read. */
  catalogNames: boolean;
  /** A session's row, its card, the status bar and the usage log name
      the model the agent says the session runs on: the one its own
      configuration names where none was chosen. An agent that does not
      has them name the model chosen for the session. */
  namesRunningModel: boolean;
  /** What sending waiting messages now does: interrupt the turn, after
      which the agent takes them all at once, or add them to the turn
      that runs without stopping it. */
  sendNow: "interrupts" | "steers";
}

const PROFILES: Record<AgentId, AgentProfile> = {
  "claude-code": {
    product: "Claude Code",
    name: "Claude",
    signIn: "claude",
    configVar: "CLAUDE_CONFIG_DIR",
    commands: true,
    turnModels: true,
    catalogNames: false,
    namesRunningModel: false,
    sendNow: "interrupts",
  },
  codex: {
    product: "Codex",
    name: "Codex",
    signIn: "codex login",
    configVar: "CODEX_HOME",
    commands: false,
    turnModels: false,
    catalogNames: true,
    namesRunningModel: true,
    sendNow: "steers",
  },
};

export function agentProfile(id: AgentId): AgentProfile {
  return PROFILES[id];
}

export function agentLabel(id: AgentId): string {
  return PROFILES[id].product;
}

/** The short form for a tag beside a row. */
export function agentTag(id: AgentId): string {
  return id === "codex" ? "codex" : "claude";
}

export type Availability =
  | "unknown" // not every agent has been looked for yet
  | "detached" // no core behind the window
  | "missing" // no binary is on PATH
  | "ready";

export const agent = $state({
  availability: "unknown" as Availability,
  /** The agents whose binary was found, in `AGENTS` order. */
  installed: [] as AgentId[],
  /** The agents that have been looked for, found or not. */
  asked: [] as AgentId[],
  /** Where each binary was found. */
  paths: {} as Partial<Record<AgentId, string>>,
  /** The agents the core can drive in messages, as it said when asked. */
  integrable: [] as AgentId[],
  /** False when the login shell could not be read, which changes what a
      missing binary means. */
  fromLoginShell: false,
  error: null as string | null,
});

export function applyDetect(report: DetectReport, hasCore: boolean) {
  const id = report.id as AgentId;
  if (!agent.asked.includes(id)) agent.asked.push(id);
  agent.fromLoginShell = agent.fromLoginShell || report.fromLoginShell;
  agent.error = null;
  const integrable = report.caps?.integrated === true;
  if (integrable !== agent.integrable.includes(id))
    agent.integrable = integrable
      ? AGENTS.filter((known) => known === id || agent.integrable.includes(known))
      : agent.integrable.filter((known) => known !== id);
  if (report.path !== null) {
    agent.paths[id] = report.path;
    if (!agent.installed.includes(id)) {
      agent.installed = AGENTS.filter((known) => known === id || agent.installed.includes(known));
    }
  } else {
    delete agent.paths[id];
    agent.installed = agent.installed.filter((known) => known !== id);
  }
  settle(hasCore);
}

function settle(hasCore: boolean) {
  if (!hasCore) agent.availability = "detached";
  else if (agent.installed.length > 0) agent.availability = "ready";
  else if (AGENTS.every((id) => agent.asked.includes(id))) agent.availability = "missing";
  else agent.availability = "unknown";
}

export function detectFailed(error: string) {
  agent.error = error;
  if (agent.installed.length === 0) agent.availability = "missing";
}

export function isReady(): boolean {
  return agent.availability === "ready";
}

export function isInstalled(id: AgentId): boolean {
  return agent.installed.includes(id);
}

/** The agents that can be started, in the order they are offered. */
export function installed(): AgentId[] {
  return agent.installed;
}

/** Why no agent can be started, or null when one can. */
export function unavailableReason(): string | null {
  switch (agent.availability) {
    case "unknown":
      return "Looking for an agent…";
    case "detached":
      return "Not connected to the workbench core.";
    case "missing":
      return (
        agent.error ??
        (agent.fromLoginShell
          ? "Neither claude nor codex was found on your PATH. Install Claude Code or Codex CLI, or check that it is on the PATH your login shell sets up."
          : "Neither claude nor codex was found, and your login shell could not be read, so the PATH searched may be incomplete.")
      );
    case "ready":
      return null;
  }
}

/** Test seam. */
export function resetAgent() {
  agent.availability = "unknown";
  agent.installed = [];
  agent.asked = [];
  agent.paths = {};
  agent.integrable = [];
  agent.fromLoginShell = false;
  agent.error = null;
}
