import type { Conversation } from "$lib/conversation.svelte";
import type { AgentId, Workflow } from "$lib/core";
import { configure, linkOf } from "$lib/integrated.svelte";
import { choose as keepChoice } from "$lib/lastChosen.svelte";
import { modelLabel } from "$lib/models";
import { byKey, cannotDirect } from "$lib/sessions.svelte";
import { modelName, offeredModel } from "$lib/thread";
import { workflowGist, workflows } from "$lib/workflows.svelte";

/**
 * What an integrated session can be switched to, and the switch itself, for
 * every control that offers it: the composer's chips and the status bar's
 * model and effort. The choices are the agent's own, as it said when it was
 * ready and as each change of model told; a tick marks the one in use.
 */

export interface Choice {
  value: string;
  name: string;
  about: string | null;
  on: boolean;
  /** It cannot be chosen here: its line says why. */
  off?: boolean;
}

/** Claude Code's entry for its own default model. */
const DEFAULT_MODEL = "default";

/** The model the session runs on, as the agent offers it where it does. */
function inUse(conversation: Conversation): string | null {
  const current = conversation.settings.model;
  return offeredModel(conversation, current)?.value ?? current;
}

/** The models the agent offers. */
export function modelChoices(conversation: Conversation): Choice[] {
  const current = inUse(conversation);
  return (conversation.ready?.models ?? []).map((model) => ({
    value: model.value,
    name: model.name ?? model.value,
    about: model.description,
    on: model.value === current,
  }));
}

/** A mode as the chip and the menu name it: by the agent's own name for a
    mode it offers, and in plain words for one it runs in from its own
    settings, such as `bypassPermissions`, Bypass permissions. */
export function modeName(conversation: Conversation, mode: string): string {
  const offered = conversation.ready?.modes.find((known) => known.value === mode);
  if (offered !== undefined) return offered.name;
  const words = mode
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The modes the agent offers, after one it runs in from its own
    configuration, which it does not offer and which is not to be come back
    to once left. */
export function modeChoices(conversation: Conversation): Choice[] {
  const modes = conversation.ready?.modes ?? [];
  const mode = conversation.settings.mode;
  const own =
    mode !== null && !modes.some((known) => known.value === mode)
      ? [
          {
            value: mode,
            name: modeName(conversation, mode),
            about: "From the agent's own settings. Once another is chosen, it comes back only in a new session.",
            on: true,
          },
        ]
      : [];
  return [
    ...own,
    ...modes.map((known) => ({
      value: known.value,
      name: known.name,
      about: known.description,
      on: known.value === mode,
    })),
  ];
}

/** What an effort is called, and a line on what it does where the agent
    says nothing of it, for the efforts the agents name. Any other is shown
    as it is written. */
const EFFORTS: Record<string, { name: string; about: string }> = {
  minimal: { name: "Minimal", about: "Hardly any thinking" },
  low: { name: "Low", about: "Quick, little thinking" },
  medium: { name: "Medium", about: "Balanced" },
  high: { name: "High", about: "Thorough" },
  xhigh: { name: "Extra high", about: "More thorough still" },
  max: { name: "Max", about: "Slowest, for the hardest problems" },
  ultra: { name: "Ultra", about: "Hands parts of the task to subagents" },
};

/** An effort as it is shown in a menu: `High`. */
export function effortName(effort: string): string {
  return EFFORTS[effort]?.name ?? effort;
}

/** The efforts the model the session runs on takes, each said in the
    agent's words where it has some for it. */
export function effortChoices(conversation: Conversation): Choice[] {
  const effort = conversation.settings.effort;
  const words = offeredModel(conversation, conversation.settings.model)?.effortDescriptions ?? {};
  return conversation.efforts.map((value) => ({
    value,
    name: effortName(value),
    about: words[value] ?? EFFORTS[value]?.about ?? null,
    on: value === effort,
  }));
}

/** The effort the session runs at, or null where there is none: before the
    agent has said, or where it offers the model in use with no efforts to
    take. Where nothing says which efforts the model takes, the effort is
    the one the agent last named. */
export function effortInUse(conversation: Conversation): string | null {
  const effort = conversation.settings.effort;
  if (effort === null || conversation.efforts.length > 0) return effort;
  const offered = offeredModel(conversation, conversation.settings.model);
  return offered !== null && offered.efforts.length === 0 ? null : effort;
}

/** The model the session runs on as it is named, or null before the agent
    has said. */
export function modelInUse(conversation: Conversation): string | null {
  return modelName(conversation, conversation.settings.model);
}

/** Switches the session to a model, an effort or a mode, unless it is on it
    already. Once the agent has taken it, it is what the next new session
    of the agent starts on; Claude Code's default model starts the next one
    on its default again. */
export function choose(
  key: string,
  conversation: Conversation,
  setting: "model" | "mode" | "effort",
  value: string,
) {
  const agent = byKey(key)?.agent;
  const keep = () => {
    if (agent === undefined || linkOf(key)?.configureError != null) return;
    // Kept only once the agent runs on it. The agent's default model keeps
    // none, which needs no proof.
    if (setting === "model") {
      if (value !== DEFAULT_MODEL && inUse(conversation) !== value && conversation.settings.model !== value) return;
    } else if (conversation.settings[setting] !== value) return;
    keepChoice(agent, setting, value);
  };
  if (setting === "model") {
    if (value !== inUse(conversation) && value !== conversation.settings.model)
      void configure(key, { model: value }).then(keep);
    else keep();
  } else if (value !== conversation.settings[setting]) void configure(key, { [setting]: value }).then(keep);
  else keep();
}

/** The workflows a new conversation can follow, after none: the agent
    alone. Each says in a line who directs, works and reviews, or why it
    cannot direct a conversation here. The one the session follows is
    ticked, and kept in the list though the settings have dropped it. */
export function workflowChoices(agent: AgentId, name: string, following: Workflow | null): Choice[] {
  const list = workflows.list;
  const all =
    following !== null && !list.some((known) => known.name === following.name) ? [following, ...list] : list;
  return [
    {
      value: "",
      name: "No workflow",
      about: `${name} works alone, on the model you pick`,
      on: following === null,
    },
    ...all.map((workflow) => {
      const why = workflow.orchestrator.agent === agent ? null : cannotDirect(workflow);
      return {
        value: workflow.name,
        name: workflow.name,
        about: why ?? workflowGist(workflow),
        on: workflow.name === following?.name,
        ...(why === null ? {} : { off: true }),
      };
    }),
  ];
}

/** The model a session under a workflow runs on, as the composer and the
    status bar both name it: the one its run says it is on, once the run
    has said, and the workflow's orchestrator's until then. Each is named
    as the agent names it where it offers it, else by the workflow's own
    name for it. */
export function heldModel(conversation: Conversation, workflow: Workflow): string {
  const { agent, model } = workflow.orchestrator;
  const said = conversation.sessionId === null ? null : conversation.settings.model;
  const named = said ?? model;
  const offered = offeredModel(conversation, named) === null ? null : modelName(conversation, named);
  return offered ?? modelLabel(agent, named);
}
