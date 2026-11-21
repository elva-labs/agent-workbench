import type { AgentId } from "$lib/core";
import { catalogName, catalogsOf } from "$lib/modelCatalog.svelte";

/**
 * The models a workflow can name, per agent.
 *
 * Claude Code takes the aliases its command line takes, which follow the
 * newest model of each family. Codex takes the name that means whatever
 * Codex runs by default, then the models Codex lists at run time, named as
 * its list names them. A model's name belongs to one agent, so an option
 * is an agent and a name together.
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

/** The name that means whatever model Codex runs by default. */
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

/** The names an agent always takes, most capable first. */
export function modelsOf(agent: AgentId): ModelOption[] {
  return MODELS[agent];
}

/** What a picker offers for an agent: the names it always takes, then the
    models it listed for any account heard, each once, in its list's order
    and by its list's names. Claude Code's are the names alone. */
export function offeredModels(agent: AgentId): ModelOption[] {
  const always = MODELS[agent];
  const listed = catalogsOf(agent)
    .filter((listed) => !always.some((option) => option.model === listed.value))
    .map((listed) => ({ agent, model: listed.value, label: catalogName(agent, listed.value) ?? listed.value }));
  return [...always, ...listed];
}

/** The model a workflow's orchestrator starts on when nothing says
    otherwise: Claude's most capable. */
export function mostCapable(): ModelOption {
  return MODELS["claude-code"][0];
}

/** What a model is called where its name is shown: as the list here
    names it, else as the agent's own list names it for the account on the
    machine `host`, null for this one, else as it is written. */
export function modelLabel(
  agent: AgentId,
  model: string,
  account: string | null = null,
  host: string | null = null,
): string {
  return (
    MODELS[agent]?.find((option) => option.model === model)?.label ?? catalogName(agent, model, account, host) ?? model
  );
}

export function sameModel(
  a: { agent: AgentId; model: string },
  b: { agent: AgentId; model: string },
): boolean {
  return a.agent === b.agent && a.model === b.model;
}

/** The agents a model can be chosen from: the installed ones, then any a
    workflow already uses so its choice can be shown. When none is found,
    both, so a workflow can still be edited. */
export function offeredAgents(installed: AgentId[], inUse: AgentId[]): AgentId[] {
  const wanted = installed.length === 0 ? AGENT_ORDER : installed;
  return AGENT_ORDER.filter((agent) => wanted.includes(agent) || inUse.includes(agent));
}

/** A model as one string, for a control that holds a single value. */
export function modelKey(model: { agent: AgentId; model: string }): string {
  return `${model.agent}:${model.model}`;
}

export function modelFromKey(key: string): { agent: AgentId; model: string } | null {
  const at = key.indexOf(":");
  if (at < 0) return null;
  const agent = key.slice(0, at);
  if (agent !== "claude-code" && agent !== "codex") return null;
  return { agent, model: key.slice(at + 1) };
}
