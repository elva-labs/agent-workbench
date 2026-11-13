import type {
  AgentId,
  ReviewStep,
  Settings,
  WorkStep,
  Workflow,
  WorkflowModel,
  WorkflowStep,
} from "$lib/core";
import { mostCapable } from "$lib/models";
import { persist } from "$lib/persist";

/**
 * The workflows a session can follow.
 *
 * A workflow names the model a session starts on, the orchestrator, and
 * steps in order that either do work or review it, each with the models it
 * may use. The window holds its copy of the list, the name of the workflow
 * new sessions start with (none is a choice) and the projects that choose
 * another; each change is checked here with the rules the core holds the
 * settings to, shown at once and sent. What the core answers, or announces
 * from another window, is taken as it comes.
 */

export const workflows = $state({
  /** The workflows in the order they are shown. */
  list: [] as Workflow[],
  /** The one new sessions start with; null is none. */
  default: null as string | null,
  /** The projects with a word of their own: a workflow's name, or null
      for none, whatever the default. */
  overrides: {} as Record<string, string | null>,
});

/** What the core holds the settings to. */
export const MOST_WORKFLOWS = 16;
export const MOST_STEPS = 12;
export const LONGEST_NAME = 40;
export const MOST_PARALLEL = 8;
export const MOST_ROUNDS = 10;

/** The workflow a fresh install has: the orchestrator on Claude's most
    capable model, work on Sonnet, and a review on Opus that sends the work
    back up to three times and then asks. */
export function defaultWorkflow(): Workflow {
  return {
    name: "Build and review",
    orchestrator: { agent: "claude-code", model: mostCapable().model },
    steps: [
      {
        kind: "work",
        name: "Work",
        models: [{ agent: "claude-code", model: "sonnet" }],
        parallel: 1,
      },
      {
        kind: "review",
        name: "Review",
        models: [{ agent: "claude-code", model: "opus" }],
        reviewerApproves: true,
        orchestratorAgrees: true,
        backTo: "Work",
        limit: 3,
      },
    ],
  };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The workflows' part of the settings. */
export function workflowsSettings(): Settings["workflows"] {
  return {
    list: clone($state.snapshot(workflows.list)),
    default: workflows.default,
    overrides: { ...workflows.overrides },
  };
}

/** Takes the core's word for the workflows, which is the machine's. A
    settings object from before workflows existed gets the default one. A
    choice naming a workflow the list does not hold is dropped. */
export function adoptWorkflows(settings: Settings["workflows"] | undefined) {
  if (settings === undefined || !Array.isArray(settings.list)) {
    const fresh = defaultWorkflow();
    workflows.list = [fresh];
    workflows.default = fresh.name;
    workflows.overrides = {};
    return;
  }
  const list = clone(settings.list);
  const known = (name: unknown): name is string =>
    typeof name === "string" && list.some((workflow) => workflow.name === name);
  workflows.list = list;
  workflows.default = known(settings.default) ? settings.default : null;
  const overrides: Record<string, string | null> = {};
  for (const [project, choice] of Object.entries(settings.overrides ?? {})) {
    if (choice === null || known(choice)) overrides[project] = choice;
  }
  workflows.overrides = overrides;
}

const stepNames = (workflow: Workflow) => workflow.steps.map((step) => step.name);

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Why a name will not do among the others, or null when it will. */
export function nameProblem(name: string, others: string[]): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "A name is needed.";
  if (trimmed.length > LONGEST_NAME) return `A name is ${LONGEST_NAME} characters at most.`;
  if (others.some((other) => sameName(other, trimmed))) return `${trimmed} is taken already.`;
  return null;
}

function modelProblem(model: WorkflowModel): string | null {
  if (model.agent !== "claude-code" && model.agent !== "codex") {
    return `${model.agent} is not an agent.`;
  }
  return model.model.trim() === "" ? "A model needs a name." : null;
}

/** Why a workflow will not do, or null when it will: the rules the core
    holds a workflow to. */
export function workflowProblem(workflow: Workflow): string | null {
  const own = nameProblem(workflow.name, []);
  if (own !== null) return own;
  const orchestrator = modelProblem(workflow.orchestrator);
  if (orchestrator !== null) return orchestrator;
  if (workflow.steps.length === 0) return "A workflow needs at least one step.";
  if (workflow.steps.length > MOST_STEPS) return `A workflow has ${MOST_STEPS} steps at most.`;
  for (const [index, step] of workflow.steps.entries()) {
    const named = nameProblem(
      step.name,
      workflow.steps.slice(0, index).map((earlier) => earlier.name),
    );
    if (named !== null) return named;
    for (const model of step.models) {
      const problem = modelProblem(model);
      if (problem !== null) return problem;
    }
    if (step.kind === "work") {
      if (!Number.isInteger(step.parallel) || step.parallel < 1 || step.parallel > MOST_PARALLEL) {
        return `${step.name} runs between 1 and ${MOST_PARALLEL} sessions at once.`;
      }
    } else {
      if (!step.reviewerApproves && !step.orchestratorAgrees) {
        return `${step.name} passes the work on something: the reviewer approving, the orchestrator agreeing, or both.`;
      }
      if (!stepNames(workflow).slice(0, index).includes(step.backTo)) {
        return `${step.name} goes back to a step before it.`;
      }
      if (!Number.isInteger(step.limit) || step.limit < 1 || step.limit > MOST_ROUNDS) {
        return `${step.name} goes back between 1 and ${MOST_ROUNDS} times.`;
      }
    }
  }
  return null;
}

/** Why a set of workflows will not do, or null: each one, and a name
    only once. */
export function listProblem(list: Workflow[]): string | null {
  if (list.length > MOST_WORKFLOWS) return `The settings hold ${MOST_WORKFLOWS} workflows at most.`;
  for (const [index, workflow] of list.entries()) {
    const problem = workflowProblem(workflow);
    if (problem !== null) return problem;
    if (list.slice(0, index).some((earlier) => sameName(earlier.name, workflow.name))) {
      return `There are two workflows called ${workflow.name}.`;
    }
  }
  return null;
}

export function workflowNamed(name: string | null | undefined): Workflow | undefined {
  return name === null || name === undefined
    ? undefined
    : workflows.list.find((workflow) => workflow.name === name);
}

/** The workflow a project follows: its own word, else the default. Null
    is none. */
export function workflowOf(project: string): Workflow | null {
  const own = workflows.overrides[project];
  const chosen = own === undefined ? workflows.default : own;
  return workflowNamed(chosen) ?? null;
}

/** A project's own word: a name, null for none, or undefined when it
    follows the default. */
export function overrideOf(project: string): string | null | undefined {
  const own = workflows.overrides[project];
  if (own === undefined) return undefined;
  if (own === null) return null;
  return workflowNamed(own) === undefined ? undefined : own;
}

/** Points each review at a step before it again after steps moved or went:
    the step just before the review, which is where the work came from. */
function repair(workflow: Workflow) {
  const names = stepNames(workflow);
  workflow.steps.forEach((step, index) => {
    if (step.kind === "review" && !names.slice(0, index).includes(step.backTo) && index > 0) {
      step.backTo = names[index - 1];
    }
  });
}

/** Changes one workflow: the draft is mended, checked whole, and kept and
    sent only if it will do. Says why not otherwise. */
function edit(name: string, change: (draft: Workflow) => string | null): string | null {
  const index = workflows.list.findIndex((workflow) => workflow.name === name);
  if (index < 0) return `There is no workflow called ${name}.`;
  const draft = clone($state.snapshot(workflows.list[index]));
  const early = change(draft);
  if (early !== null) return early;
  repair(draft);
  const others = workflows.list.filter((_, at) => at !== index);
  const problem =
    workflowProblem(draft) ??
    (others.some((other) => sameName(other.name, draft.name))
      ? `There is a workflow called ${draft.name} already.`
      : null);
  if (problem !== null) return problem;
  workflows.list[index] = draft;
  if (draft.name !== name) {
    if (workflows.default === name) workflows.default = draft.name;
    for (const [project, choice] of Object.entries(workflows.overrides)) {
      if (choice === name) workflows.overrides[project] = draft.name;
    }
  }
  save();
  return null;
}

/** A name that is not taken: the wanted one, then numbered. */
export function freeName(wanted: string, taken: string[]): string {
  if (!taken.some((other) => sameName(other, wanted))) return wanted;
  for (let n = 2; ; n += 1) {
    const candidate = `${wanted} ${n}`;
    if (!taken.some((other) => sameName(other, candidate))) return candidate;
  }
}

/** Adds a workflow of the default shape, and answers with its name, or
    null when the settings hold as many as they can. */
export function addWorkflow(): string | null {
  if (workflows.list.length >= MOST_WORKFLOWS) return null;
  const fresh = defaultWorkflow();
  fresh.name = freeName("New workflow", workflows.list.map((workflow) => workflow.name));
  workflows.list.push(fresh);
  save();
  return fresh.name;
}

/** Copies a workflow under a name of its own, and answers with the name. */
export function duplicateWorkflow(name: string): string | null {
  const source = workflowNamed(name);
  if (source === undefined || workflows.list.length >= MOST_WORKFLOWS) return null;
  const copy = clone($state.snapshot(source));
  copy.name = freeName(
    `${source.name} copy`.slice(0, LONGEST_NAME),
    workflows.list.map((workflow) => workflow.name),
  );
  workflows.list.splice(workflows.list.indexOf(source) + 1, 0, copy);
  save();
  return copy.name;
}

/** Takes a workflow away. If it was the default, new sessions start with
    none; a project that named it follows the default again. */
export function deleteWorkflow(name: string) {
  const index = workflows.list.findIndex((workflow) => workflow.name === name);
  if (index < 0) return;
  workflows.list.splice(index, 1);
  if (workflows.default === name) workflows.default = null;
  for (const [project, choice] of Object.entries(workflows.overrides)) {
    if (choice === name) delete workflows.overrides[project];
  }
  save();
}

export function renameWorkflow(name: string, to: string): string | null {
  const wanted = to.trim();
  if (wanted === name) return null;
  return edit(name, (draft) => {
    draft.name = wanted;
    return null;
  });
}

/** Marks the workflow new sessions start with; null is none. */
export function setDefault(name: string | null) {
  if (name !== null && workflowNamed(name) === undefined) return;
  workflows.default = name;
  save();
}

/** A project's own word, or undefined to have it follow the default. */
export function setOverride(project: string, choice: string | null | undefined) {
  if (typeof choice === "string" && workflowNamed(choice) === undefined) return;
  if (choice === undefined) delete workflows.overrides[project];
  else workflows.overrides[project] = choice;
  save();
}

export function setOrchestrator(name: string, model: WorkflowModel): string | null {
  return edit(name, (draft) => {
    draft.orchestrator = { ...model };
    return null;
  });
}

/** A step of the kind given, with the models and bounds a new one has. */
export function newStep(workflow: Workflow, kind: WorkflowStep["kind"], before: number): WorkflowStep {
  const taken = stepNames(workflow);
  if (kind === "work") {
    return {
      kind,
      name: freeName("Work", taken),
      models: [{ agent: "claude-code", model: "sonnet" }],
      parallel: 1,
    };
  }
  return {
    kind,
    name: freeName("Review", taken),
    models: [{ agent: "claude-code", model: "opus" }],
    reviewerApproves: true,
    orchestratorAgrees: true,
    backTo: taken[Math.max(0, before - 1)] ?? "",
    limit: 3,
  };
}

/** Adds a step so that it sits at `at`, after the steps before it. */
export function addStep(name: string, at: number, kind: WorkflowStep["kind"]): string | null {
  return edit(name, (draft) => {
    if (kind === "review" && at < 1) return "A review follows a step.";
    const position = Math.min(Math.max(at, 0), draft.steps.length);
    draft.steps.splice(position, 0, newStep(draft, kind, position));
    return null;
  });
}

export function removeStep(name: string, at: number): string | null {
  return edit(name, (draft) => {
    if (draft.steps.length <= 1) return "A workflow needs at least one step.";
    const [removed] = draft.steps.splice(at, 1);
    // A review that went back to the removed step goes back to the one
    // before it, which repair does once the list is whole again.
    for (const step of draft.steps) {
      if (step.kind === "review" && step.backTo === removed.name) step.backTo = "";
    }
    return null;
  });
}

/** Moves a step to another place in the order. */
export function moveStep(name: string, from: number, to: number): string | null {
  return edit(name, (draft) => {
    if (to < 0 || to >= draft.steps.length || from === to) return null;
    const [step] = draft.steps.splice(from, 1);
    draft.steps.splice(to, 0, step);
    return null;
  });
}

/** What can be set on a step: its name and models, and the settings of
    its kind. */
export type StepPatch = Partial<Omit<WorkStep, "kind">> & Partial<Omit<ReviewStep, "kind">>;

/** Changes a step. Renaming one carries the reviews that go back to it. */
export function updateStep(name: string, at: number, patch: StepPatch): string | null {
  return edit(name, (draft) => {
    const step = draft.steps[at];
    if (step === undefined) return "There is no such step.";
    const before = step.name;
    if (patch.name !== undefined) {
      const wanted = patch.name.trim();
      const problem = nameProblem(
        wanted,
        draft.steps.filter((_, other) => other !== at).map((other) => other.name),
      );
      if (problem !== null) return problem;
      for (const other of draft.steps) {
        if (other.kind === "review" && other.backTo === before) other.backTo = wanted;
      }
      step.name = wanted;
    }
    if (patch.models !== undefined) step.models = patch.models.map((model) => ({ ...model }));
    if (step.kind === "work") {
      if (patch.parallel !== undefined) step.parallel = patch.parallel;
    } else {
      if (patch.reviewerApproves !== undefined) step.reviewerApproves = patch.reviewerApproves;
      if (patch.orchestratorAgrees !== undefined) step.orchestratorAgrees = patch.orchestratorAgrees;
      if (patch.backTo !== undefined) {
        if (!draft.steps.slice(0, at).some((earlier) => earlier.name === patch.backTo)) {
          return `${step.name} goes back to a step before it.`;
        }
        step.backTo = patch.backTo;
      }
      if (patch.limit !== undefined) step.limit = patch.limit;
    }
    return null;
  });
}

/** Turns a step into the other kind, keeping its name and models. */
export function setStepKind(name: string, at: number, kind: WorkflowStep["kind"]): string | null {
  return edit(name, (draft) => {
    const step = draft.steps[at];
    if (step === undefined) return "There is no such step.";
    if (step.kind === kind) return null;
    if (kind === "review" && at === 0) return "The first step does the work.";
    const base = { name: step.name, models: step.models };
    draft.steps[at] =
      kind === "work"
        ? { kind, ...base, parallel: 1 }
        : {
            kind,
            ...base,
            reviewerApproves: true,
            orchestratorAgrees: true,
            backTo: draft.steps[at - 1].name,
            limit: 3,
          };
    // A review that went back to a step now a review keeps its name; the
    // rules do not ask the target to be work.
    return null;
  });
}

/** The agents a model set holds, for showing a step's models. */
export function agentsOf(models: WorkflowModel[]): AgentId[] {
  return [...new Set(models.map((model) => model.agent))];
}

function save() {
  persist({ workflows: workflowsSettings() });
}

/** Test seam. */
export function reset() {
  workflows.list = [];
  workflows.default = null;
  workflows.overrides = {};
}
