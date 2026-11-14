import type {
  AgentId,
  ReviewStep,
  Settings,
  UnreadWorkflow,
  WorkStep,
  Workflow,
  WorkflowModel,
  WorkflowStep,
} from "$lib/core";
import { AGENT_ORDER, modelLabel, mostCapable, sameModel } from "$lib/models";
import { core } from "$lib/core";
import { persist, recovering } from "$lib/persist";
import { startsOnly } from "$lib/workflowInstructions";

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

export const workflows = $state({
  /** The workflows in the order they are shown. A window that has heard
      nothing yet has the one a fresh install has. */
  list: [defaultWorkflow()] as Workflow[],
  /** The one new sessions start with; null is none, which is what a
      fresh install has. */
  default: null as string | null,
  /** The projects with a word of their own: a workflow's name, or null
      for none, whatever the default. */
  overrides: {} as Record<string, string | null>,
  /** The workflows in the settings file that are not used, each with the
      rule it breaks, carried through every write until removed. */
  unread: [] as UnreadWorkflow[],
  /** Why the last change in the editor was not kept, while it matters. */
  refused: null as string | null,
});

let known: () => void = () => {};
let knowing = new Promise<void>((settle) => (known = settle));

/** Settles once the window has the machine's workflows, or knows it keeps
    only its own: what a resumed session follows is read after that. */
export function workflowsKnown(): Promise<void> {
  return knowing;
}

/** The window has the workflows it will go on with. */
export function knowWorkflows() {
  known();
}

/** Test seam: the window has not heard what the workflows are. */
export function unknowWorkflows() {
  knowing = new Promise<void>((settle) => (known = settle));
}

/** What the core holds the settings to. */
export const MOST_WORKFLOWS = 16;
export const MOST_STEPS = 12;
export const MOST_MODELS = 16;
export const LONGEST_NAME = 40;
export const MOST_PARALLEL = 8;
export const MOST_ROUNDS = 10;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The workflows' part of the settings. */
export function workflowsSettings(): Settings["workflows"] {
  return {
    list: clone($state.snapshot(workflows.list)),
    default: workflows.default,
    overrides: { ...workflows.overrides },
    // Like the core, the set names its unread workflows only when it has any.
    ...(workflows.unread.length === 0 ? {} : { unread: clone($state.snapshot(workflows.unread)) }),
  };
}

/** Takes the core's word for the workflows, which is the machine's. A
    settings object from before workflows existed gets the default one,
    with new sessions following none. A choice naming a workflow the list
    does not hold is dropped. */
export function adoptWorkflows(settings: Settings["workflows"] | undefined) {
  knowWorkflows();
  if (settings === undefined || !Array.isArray(settings.list)) {
    const fresh = defaultWorkflow();
    workflows.list = [fresh];
    workflows.default = null;
    workflows.overrides = {};
    workflows.unread = [];
    return;
  }
  workflows.unread = clone(settings.unread ?? []);
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

/** Names are the same when they differ only in the case of A to Z, as the
    core compares them. */
const asciiLower = (name: string) => name.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const sameName = (a: string, b: string) => asciiLower(a) === asciiLower(b);

/** Why a name will not do among the others, or null when it will. */
export function nameProblem(name: string, others: string[]): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "A name is needed.";
  if ([...trimmed].length > LONGEST_NAME) return `A name is ${LONGEST_NAME} characters at most.`;
  if (others.some((other) => sameName(other, trimmed))) return `${trimmed} is taken already.`;
  return null;
}

function modelProblem(model: WorkflowModel): string | null {
  if (model.agent !== "claude-code" && model.agent !== "codex") {
    return `${model.agent} is not an agent.`;
  }
  const name = model.model.trim();
  // eslint-disable-next-line no-control-regex
  if (name === "" || [...name].length > LONGEST_NAME || /[\s\u0000-\u001f\u007f-\u009f]/u.test(name)) {
    return `A model is named in one word, ${LONGEST_NAME} characters at most, not "${model.model}".`;
  }
  return null;
}

/** The step a review may send the work back to: a work step before it. */
export function canGoBackTo(workflow: Workflow, review: number, name: string): boolean {
  return workflow.steps
    .slice(0, review)
    .some((earlier) => earlier.kind === "work" && earlier.name === name);
}

/** The work step nearest before a place in the order, by name. */
function nearestWork(steps: WorkflowStep[], before: number): string | undefined {
  return steps
    .slice(0, before)
    .reverse()
    .find((step) => step.kind === "work")?.name;
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
    if (step.models.length > MOST_MODELS) return `${step.name} lists ${MOST_MODELS} models at most.`;
    for (const [at, model] of step.models.entries()) {
      const problem = modelProblem(model);
      if (problem !== null) return problem;
      if (step.models.slice(0, at).some((earlier) => sameModel(earlier, model))) {
        return `${step.name} lists ${modelLabel(model.agent, model.model)} twice.`;
      }
    }
    if (step.kind === "work") {
      if (!Number.isInteger(step.parallel) || step.parallel < 1 || step.parallel > MOST_PARALLEL) {
        return `${step.name} runs between 1 and ${MOST_PARALLEL} sessions at once.`;
      }
    } else {
      if (!step.reviewerApproves && !step.orchestratorAgrees) {
        return `${step.name} passes the work when the reviewer approves, the orchestrator agrees, or both, so one of them stays on.`;
      }
      if (!canGoBackTo(workflow, index, step.backTo)) {
        return `${step.name} goes back to a work step before it.`;
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

/** Why a whole set of workflows will not do, or null: each workflow, a name
    once, and the default and every project choice naming one there is. */
export function setProblem(set: Settings["workflows"]): string | null {
  const problem = listProblem(set.list);
  if (problem !== null) return problem;
  const there = (name: string | null) => name === null || set.list.some((workflow) => workflow.name === name);
  if (!there(set.default)) return `There is no workflow called ${set.default}.`;
  for (const choice of Object.values(set.overrides)) {
    if (!there(choice)) return `There is no workflow called ${choice}.`;
  }
  return null;
}

export { startsOnly };

/** Turns a workflow's own subagents off, so start is the one way it
    delegates, or back on. */
export function setStartOnly(name: string, on: boolean): string | null {
  return edit(name, (draft) => {
    if (on) delete draft.startOnly;
    else draft.startOnly = false;
    return null;
  });
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

/** Points each review at a work step before it again after steps moved,
    went or changed kind: the nearest one, which is where the work came
    from. */
function repair(workflow: Workflow) {
  workflow.steps.forEach((step, index) => {
    if (step.kind !== "review" || canGoBackTo(workflow, index, step.backTo)) return;
    const nearest = nearestWork(workflow.steps, index);
    if (nearest !== undefined) step.backTo = nearest;
  });
}

/** The workflow the file holds but cannot use under a name, if any. Its
    name is taken: a workflow of that name would be read as the one the
    file's default and project choices mean. */
function unreadNamed(name: string, unread: UnreadWorkflow[] = workflows.unread): UnreadWorkflow | undefined {
  return unread.find((entry) => entry.name !== null && sameName(entry.name, name));
}

const unreadNames = () =>
  workflows.unread.flatMap((entry) => (entry.name === null ? [] : [entry.name]));

function unreadProblem(name: string): string {
  return `"${name}" is the name of a workflow in the settings file that is not used. Mend that one there, or remove it, first.`;
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
      : !sameName(draft.name, name) && unreadNamed(draft.name) !== undefined
        ? unreadProblem(draft.name)
        : null);
  if (problem !== null) return problem;
  workflows.list[index] = draft;
  if (draft.name !== name) {
    if (workflows.default === name) workflows.default = draft.name;
    for (const [project, choice] of Object.entries(workflows.overrides)) {
      if (choice === name) workflows.overrides[project] = draft.name;
    }
  }
  keep();
  return null;
}

/**
 * Sends the editor's change. When the core refuses it, the window goes back
 * to what is stored and says why; a later change that is kept clears that.
 */
function keep() {
  workflows.refused = null;
  void Promise.resolve(save()).then((refused) => {
    if (refused === null || refused === undefined) return;
    workflows.refused = refused;
  });
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
  fresh.name = freeName("New workflow", [...workflows.list.map((workflow) => workflow.name), ...unreadNames()]);
  workflows.list.push(fresh);
  keep();
  return fresh.name;
}

/** Copies a workflow under a name of its own, and answers with the name. */
export function duplicateWorkflow(name: string): string | null {
  const source = workflowNamed(name);
  if (source === undefined || workflows.list.length >= MOST_WORKFLOWS) return null;
  const copy = clone($state.snapshot(source));
  copy.name = freeName(
    `${source.name} copy`.slice(0, LONGEST_NAME),
    [...workflows.list.map((workflow) => workflow.name), ...unreadNames()],
  );
  workflows.list.splice(workflows.list.indexOf(source) + 1, 0, copy);
  keep();
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
  keep();
}

/** Takes a workflow the file holds but cannot use out of the file, with
    the default and the project choices that named it. */
export function removeUnread(at: number) {
  const index = workflows.unread.findIndex((entry) => entry.at === at);
  if (index < 0) return;
  workflows.unread.splice(index, 1);
  keep();
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
  for (const entry of workflows.unread) entry.default = false;
  keep();
}

/** A project's own word, or undefined to have it follow the default. */
export function setOverride(project: string, choice: string | null | undefined) {
  if (typeof choice === "string" && workflowNamed(choice) === undefined) return;
  if (choice === undefined) delete workflows.overrides[project];
  else workflows.overrides[project] = choice;
  for (const entry of workflows.unread) {
    entry.projects = entry.projects.filter((other) => other !== project);
  }
  keep();
}

export function setOrchestrator(name: string, model: WorkflowModel): string | null {
  return edit(name, (draft) => {
    draft.orchestrator = { ...model };
    return null;
  });
}

/** The name a review added at a place in the order gets, short enough to
    show whole on its step: Review, then numbered so the names read in
    order, Review 2 after Review. Added before a review already there, it
    is a Check, so no number reads out of order. */
function reviewName(workflow: Workflow, before: number): string {
  const taken = stepNames(workflow);
  const numbered = (name: string) => {
    const found = /^Review(?: (\d+))?$/.exec(name);
    return found === null ? null : Number(found[1] ?? 1);
  };
  const later = workflow.steps.slice(before).some((step) => numbered(step.name) !== null);
  if (later) return freeName("Check", taken);
  const most = Math.max(0, ...taken.map(numbered).filter((n) => n !== null));
  return freeName(most === 0 ? "Review" : `Review ${most + 1}`, taken);
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
  const target = nearestWork(workflow.steps, before) ?? "";
  return {
    kind,
    name: reviewName(workflow, before),
    models: [{ agent: "claude-code", model: "opus" }],
    reviewerApproves: true,
    orchestratorAgrees: true,
    backTo: target,
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

/** A workflow as it would be with a step taken away: each review that went
    back to it goes back to the nearest work step before it instead. */
export function withoutStep(workflow: Workflow, at: number): Workflow {
  const draft = clone($state.snapshot(workflow));
  draft.steps.splice(at, 1);
  repair(draft);
  return draft;
}

export function removeStep(name: string, at: number): string | null {
  return edit(name, (draft) => {
    const problem = removeProblem(draft, at);
    if (problem !== null) return problem;
    draft.steps.splice(at, 1);
    return null;
  });
}

/** Why a workflow as it would be after a step moved or went will not do,
    in terms of what was done: the first step that would be a review, or
    the rule the result breaks. Null when it will do. */
function afterProblem(after: Workflow): string | null {
  if (after.steps[0]?.kind === "review") {
    return `"${after.steps[0].name}" would come first, and the first step does the work.`;
  }
  return workflowProblem(after);
}

/** A workflow as it would be with a step moved, reviews repointed. */
export function withMovedStep(workflow: Workflow, from: number, to: number): Workflow {
  const draft = clone($state.snapshot(workflow));
  const [step] = draft.steps.splice(from, 1);
  draft.steps.splice(to, 0, step);
  repair(draft);
  return draft;
}

/** Why a step cannot move to another place, or null when it can. */
export function moveProblem(workflow: Workflow, from: number, to: number): string | null {
  if (to < 0) return "It is the first step already.";
  if (to >= workflow.steps.length) return "It is the last step already.";
  return afterProblem(withMovedStep(workflow, from, to));
}

/** Why a step cannot be taken away, or null when it can. */
export function removeProblem(workflow: Workflow, at: number): string | null {
  if (workflow.steps.length <= 1) return "A workflow needs at least one step.";
  return afterProblem(withoutStep(workflow, at));
}

/** Moves a step to another place in the order. */
export function moveStep(name: string, from: number, to: number): string | null {
  return edit(name, (draft) => {
    if (to < 0 || to >= draft.steps.length || from === to) return null;
    const problem = moveProblem(draft, from, to);
    if (problem !== null) return problem;
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
        if (!canGoBackTo(draft, at, patch.backTo)) {
          return `${step.name} goes back to a work step before it.`;
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
            backTo: nearestWork(draft.steps, at) ?? "",
            limit: 3,
          };
    return null;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function only(value: Record<string, unknown>, allowed: string[], what: string) {
  const other = Object.keys(value).find((field) => !allowed.includes(field));
  if (other !== undefined) throw new Error(`${what} has ${allowed.join(", ")}, not ${other}.`);
}

function readModel(value: unknown, what: string): WorkflowModel {
  if (!isObject(value)) throw new Error(`${what} is a model: {"agent": ..., "model": ...}.`);
  only(value, ["agent", "model"], what);
  if (!AGENT_ORDER.includes(value.agent as AgentId)) {
    throw new Error(`${what} names an agent that is one of ${AGENT_ORDER.join(", ")}.`);
  }
  if (typeof value.model !== "string") throw new Error(`${what} names its model as text.`);
  return { agent: value.agent as AgentId, model: value.model.trim() };
}

function readModels(value: unknown, what: string): WorkflowModel[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${what} lists models as an array; empty means any.`);
  return value.map((model) => readModel(model, what));
}

/** A workflow as an agent writes it, read strictly: every field the shape
    has and no other, then held to the rules. Throws the reason when it
    will not do. */
export function readWorkflow(value: unknown): Workflow {
  if (!isObject(value)) {
    throw new Error("A workflow is an object of a name, an orchestrator and steps.");
  }
  only(value, ["name", "orchestrator", "steps", "startOnly"], "A workflow");
  if (value.startOnly !== undefined && typeof value.startOnly !== "boolean") {
    throw new Error("A workflow's startOnly is true or false.");
  }
  if (typeof value.name !== "string") throw new Error("A workflow has a name.");
  if (!Array.isArray(value.steps)) throw new Error("A workflow's steps are an array.");
  const steps = value.steps.map((raw, at): WorkflowStep => {
    if (!isObject(raw)) throw new Error(`Step ${at + 1} is an object.`);
    const what = `Step ${at + 1}`;
    if (typeof raw.name !== "string") throw new Error(`${what} has a name.`);
    const models = readModels(raw.models, what);
    if (raw.kind === "work") {
      only(raw, ["kind", "name", "models", "parallel"], what);
      return { kind: "work", name: raw.name.trim(), models, parallel: raw.parallel as number };
    }
    if (raw.kind === "review") {
      only(
        raw,
        ["kind", "name", "models", "reviewerApproves", "orchestratorAgrees", "backTo", "limit"],
        what,
      );
      if (typeof raw.reviewerApproves !== "boolean" || typeof raw.orchestratorAgrees !== "boolean") {
        throw new Error(`${what} says with reviewerApproves and orchestratorAgrees, each true or false, when the work passes.`);
      }
      if (typeof raw.backTo !== "string") throw new Error(`${what} names the step it goes back to as backTo.`);
      return {
        kind: "review",
        name: raw.name.trim(),
        models,
        reviewerApproves: raw.reviewerApproves,
        orchestratorAgrees: raw.orchestratorAgrees,
        backTo: raw.backTo,
        limit: raw.limit as number,
      };
    }
    throw new Error(`${what} has a kind that is work or review.`);
  });
  const workflow: Workflow = {
    name: value.name.trim(),
    orchestrator: readModel(value.orchestrator, "The orchestrator"),
    steps,
    // On is what a workflow is without the field, which is how the
    // settings file keeps it.
    ...(value.startOnly === false ? { startOnly: false } : {}),
  };
  const problem = workflowProblem(workflow);
  if (problem !== null) throw new Error(problem);
  return workflow;
}

/** A model as a few words: its name, or any when none is chosen. */
function modelsText(models: WorkflowModel[]): string {
  return models.length === 0
    ? "any model"
    : models.map((model) => modelLabel(model.agent, model.model)).join(" / ");
}

/** When a review passes the work, in a few words. */
export function passesText(step: ReviewStep): string {
  if (step.reviewerApproves && step.orchestratorAgrees) {
    return "the reviewer approves and the orchestrator agrees";
  }
  return step.reviewerApproves ? "the reviewer approves" : "the orchestrator agrees";
}

/** What a step allows, a line each in the words its settings use, for the
    person reading about a session that runs for it: what it does, the
    models, and how many sessions at once or when a review passes the work
    and how often it sends it back. A review names the work it checks when
    that is known. */
export function stepFacts(step: WorkflowStep, work: string | null = null): string[] {
  const [first, ...rest] = step.models;
  const label = (model: WorkflowModel) => modelLabel(model.agent, model.model);
  const models =
    first === undefined
      ? "any model"
      : rest.length === 0
        ? label(first)
        : `${label(first)}, used first, or ${rest.map(label).join(" or ")}`;
  if (step.kind === "work")
    return ["Does work.", `Models it may use: ${models}.`, `Sessions at once: ${step.parallel}.`];
  const times = step.limit === 1 ? "1 time" : `${step.limit} times`;
  return [
    work === null ? "Reviews work." : `Reviews ${work}.`,
    `Models it may use: ${models}.`,
    `The work passes when ${passesText(step)}.`,
    `Otherwise: go back to ${step.backTo} at most ${times}, then ask me.`,
  ];
}

/** A workflow in a line, for showing what a change makes of it: the
    orchestrator, then each step with its models and what bounds it. */
export function describeWorkflow(workflow: Workflow): string {
  const steps = workflow.steps.map((step) =>
    step.kind === "work"
      ? `${step.name} (${modelsText(step.models)}, ${step.parallel} at once)`
      : `${step.name} (${modelsText(step.models)}, passes when ${passesText(step)}, else back to ${step.backTo} ${step.limit} times at most)`,
  );
  const own = startsOnly(workflow) ? "" : ", keeping its own subagents";
  return `${modelLabel(workflow.orchestrator.agent, workflow.orchestrator.model)} directs ${steps.join(", then ")}${own}`;
}

/** What an agent's change does to the workflows: one written whole,
    replacing the one of its name or added; one taken away; and the one new
    sessions start with, null for none. */
export interface WorkflowChange {
  write?: Workflow;
  remove?: string;
  default?: string | null;
}

const namesOf = (list: Workflow[]) => list.map((workflow) => workflow.name).join(", ") || "none";

/** What a change makes of a set of workflows, checked whole. A project
    that chose a workflow taken away follows the default again. Throws the
    reason when it will not do. */
export function changed(
  held: Settings["workflows"],
  change: WorkflowChange,
): Settings["workflows"] {
  const list = clone(held.list);
  let chosen = held.default;
  const overrides = { ...held.overrides };
  let unread = clone(held.unread ?? []);
  if (change.write !== undefined) {
    const name = change.write.name;
    const at = list.findIndex((workflow) => workflow.name === name);
    const mended = at < 0 ? unreadNamed(name, unread) : undefined;
    if (mended !== undefined && mended.name !== name) throw new Error(unreadProblem(mended.name!));
    if (at < 0) list.push(clone(change.write));
    else list[at] = clone(change.write);
    // Written under the name of one the file cannot use, it mends that one:
    // it takes its place, and the default and the choices that meant it.
    if (mended !== undefined) {
      unread = unread.filter((entry) => entry !== mended);
      if (mended.default && chosen === null) chosen = name;
      for (const project of mended.projects) {
        if (overrides[project] === undefined) overrides[project] = name;
      }
    }
  }
  if (change.remove !== undefined) {
    const at = list.findIndex((workflow) => workflow.name === change.remove);
    if (at < 0) {
      throw new Error(`There is no workflow called ${change.remove}; the workflows are ${namesOf(list)}.`);
    }
    list.splice(at, 1);
    if (chosen === change.remove) chosen = null;
    for (const [project, choice] of Object.entries(overrides)) {
      if (choice === change.remove) delete overrides[project];
    }
  }
  if (change.default !== undefined) chosen = change.default;
  if (chosen !== null && !list.some((workflow) => workflow.name === chosen)) {
    throw new Error(`There is no workflow called ${chosen}; the workflows are ${namesOf(list)}.`);
  }
  const problem = listProblem(list);
  if (problem !== null) throw new Error(problem);
  return { list, default: chosen, overrides, ...(unread.length > 0 ? { unread } : {}) };
}

/** Replaces the whole set and sends it. Answers with why not when it will
    not do, or with the core's reason when the core refuses it, in which
    case the window goes back to what it held. */
export async function setWorkflows(next: Settings["workflows"]): Promise<string | null> {
  const problem = setProblem(next);
  if (problem !== null) return problem;
  const before = workflowsSettings();
  adoptWorkflows(next);
  const refused = (await save()) ?? null;
  if (refused !== null) {
    if (!recovering()) adoptWorkflows(before);
    workflows.refused = refused;
  }
  return refused;
}

/**
 * Makes an agent's change to the workflows as they are when the user allows
 * it, so edits made in the editor meanwhile stay. Throws the reason when it
 * will not do or the core refuses it. Answers with what undoes it: the
 * workflow written goes back to what it was, or away if it was new; one
 * taken away comes back where it stood, with the projects that chose it;
 * and the default goes back if it is still the one the change named.
 */
export async function takeWorkflowChange(change: WorkflowChange): Promise<() => void> {
  const before = workflowsSettings();
  const after = changed(before, change);
  const refused = await setWorkflows(after);
  if (refused !== null) throw new Error(refused);
  return () => {
    const now = workflowsSettings();
    const list = clone(now.list);
    let chosen = now.default;
    const overrides = { ...now.overrides };
    const at = (name: string) => list.findIndex((workflow) => workflow.name === name);
    let unread = clone(now.unread ?? []);
    if (change.write !== undefined) {
      const name = change.write.name;
      const was = before.list.find((workflow) => workflow.name === name);
      if (was !== undefined && at(name) >= 0) list[at(name)] = clone(was);
      if (was === undefined && at(name) >= 0) {
        list.splice(at(name), 1);
        if (chosen === name) chosen = null;
        for (const [project, choice] of Object.entries(overrides)) {
          if (choice === name) delete overrides[project];
        }
        // One it mended goes back to the file as it was.
        const mended = before.unread?.find((entry) => entry.name === name);
        if (mended !== undefined && !unread.some((entry) => entry.at === mended.at)) unread.push(clone(mended));
      }
    }
    if (change.remove !== undefined) {
      const name = change.remove;
      const index = before.list.findIndex((workflow) => workflow.name === name);
      if (index >= 0 && !list.some((workflow) => sameName(workflow.name, name))) {
        list.splice(Math.min(index, list.length), 0, clone(before.list[index]));
        for (const [project, choice] of Object.entries(before.overrides)) {
          if (choice === name && overrides[project] === undefined) overrides[project] = name;
        }
      }
    }
    if (after.default !== before.default && chosen === after.default) {
      chosen =
        before.default !== null && list.some((workflow) => workflow.name === before.default)
          ? before.default
          : null;
    }
    void setWorkflows({ list, default: chosen, overrides, ...(unread.length > 0 ? { unread } : {}) });
  };
}

function save(): Promise<string | null> {
  return persist({ workflows: workflowsSettings() }, { quiet: true });
}

/** Test seam. */
export function reset() {
  knowing = Promise.resolve();
  workflows.list = [];
  workflows.default = null;
  workflows.overrides = {};
  workflows.unread = [];
  workflows.refused = null;
}
