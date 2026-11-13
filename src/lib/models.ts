import type { AgentId } from "$lib/core";

/**
 * The models a workflow can name, per agent.
 *
 * Claude Code takes the aliases its command line takes, which follow the
 * newest model of each family. Nothing lists Codex's models, so it offers
 * the one name that means whatever Codex runs by default. A model's name
 * belongs to one agent, so an option is an agent and a name together.
 */

export interface ModelOption {
  agent: AgentId;
  /** What is stored and given to the agent. */
  model: string;
  /** What is shown. */
  label: string;
}

export const AGENT_LABELS: Record<AgentId, string> = {
  "claude-code": "Claude",
  codex: "Codex",
};

/** The agents in the order they are offered. */
export const AGENT_ORDER: AgentId[] = ["claude-code", "codex"];

/** Codex's own default, the one name a Codex model has. */
export const CODEX_DEFAULT = "default";

const MODELS: Record<AgentId, ModelOption[]> = {
  "claude-code": [
    { agent: "claude-code", model: "fable", label: "Fable" },
    { agent: "claude-code", model: "opus", label: "Opus" },
    { agent: "claude-code", model: "sonnet", label: "Sonnet" },
    { agent: "claude-code", model: "haiku", label: "Haiku" },
  ],
  codex: [{ agent: "codex", model: CODEX_DEFAULT, label: "Codex" }],
};

/** The models an agent offers, most capable first. */
export function modelsOf(agent: AgentId): ModelOption[] {
  return MODELS[agent];
}

/** The model a workflow's orchestrator starts on when nothing says
    otherwise: Claude's most capable. */
export function mostCapable(): ModelOption {
  return MODELS["claude-code"][0];
}

/** What a model is called where its name is shown. A name the list does
    not hold is shown as it is written. */
export function modelLabel(agent: AgentId, model: string): string {
  return MODELS[agent]?.find((option) => option.model === model)?.label ?? model;
}

export function sameModel(
  a: { agent: AgentId; model: string },
  b: { agent: AgentId; model: string },
): boolean {
  return a.agent === b.agent && a.model === b.model;
}
