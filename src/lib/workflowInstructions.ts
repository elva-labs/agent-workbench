import type { Workflow, WorkflowModel, WorkflowStep } from "$lib/core";
import { CODEX_DEFAULT } from "$lib/models";

/**
 * What an orchestrator is told, written from a workflow.
 *
 * The result is a short list of sentences in the order the work goes: how
 * to delegate, one sentence or a few per step with the models it allows,
 * and where a review sends the work back, through which steps again, and
 * how often. A model is named the way the `start` tool takes it: the agent,
 * and the model unless it is Codex's own default, which takes none.
 */

/** A model as the `start` tool is given it. */
export function modelText(model: WorkflowModel): string {
  if (model.agent === "codex" && model.model === CODEX_DEFAULT) return "codex with no model";
  return `${model.agent} with the model ${model.model}`;
}

/** Where a step may run: any model, one, or a set whose first is used
    unless there is a reason. */
function placeText(step: WorkflowStep): string {
  const [first, ...rest] = step.models;
  if (first === undefined) return "on any agent and model";
  if (rest.length === 0) return `on ${modelText(first)}`;
  return `on ${modelText(first)}; when you have a reason to, use ${rest.map(modelText).join(" or ")} instead`;
}

const quoted = (name: string) => `"${name}"`;

/** Names in a sentence: "A", "A" and "B", "A", "B" and "C". */
function listed(names: string[]): string {
  const all = names.map(quoted);
  return all.length <= 1 ? all.join("") : `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
}

/** How a piece arrives from the step before: a review is passed, work is
    come out of. */
function from(step: WorkflowStep): string {
  return step.kind === "review" ? `passed ${quoted(step.name)}` : `come out of ${quoted(step.name)}`;
}

function stepLine(workflow: Workflow, index: number): string {
  const step = workflow.steps[index];
  const before = workflow.steps[index - 1];
  if (step.kind === "work") {
    const lead =
      before === undefined
        ? `For the step ${quoted(step.name)}, split the task into pieces and start a session for each`
        : `For the step ${quoted(step.name)}, start a session for each piece once it has ${from(before)}`;
    const at =
      step.parallel === 1
        ? "Run one session at a time."
        : `Run at most ${step.parallel} sessions at once.`;
    return `${lead}, ${placeText(step)}. ${at}`;
  }
  const lead =
    before === undefined
      ? `For the step ${quoted(step.name)}, start a review of each piece once it is done`
      : `For the step ${quoted(step.name)}, start a review of each piece once it has ${from(before)}`;
  const passes =
    step.reviewerApproves && step.orchestratorAgrees
      ? "The piece passes when the reviewer approves and you agree."
      : step.reviewerApproves
        ? "The piece passes when the reviewer approves."
        : "The piece passes when you agree; the reviewer's verdict is advice.";
  const target = workflow.steps.findIndex((other) => other.name === step.backTo);
  const between = target < 0 ? [] : workflow.steps.slice(target + 1, index).map((other) => other.name);
  const through = between.length === 0 ? "" : `, take it through ${listed(between)} again`;
  const times = step.limit === 1 ? "once" : `at most ${step.limit} times`;
  const otherwise = `If it does not pass, send it back to its session for ${quoted(step.backTo)}${through}, then review it again for ${quoted(step.name)}. Send a piece back ${times}; after that, stop and ask the user.`;
  return `${lead}, ${placeText(step)}. ${passes} ${otherwise}`;
}

/** The instructions as sentences, one per line of the list. */
export function instructionLines(workflow: Workflow): string[] {
  const lines = [
    "You direct this work and do not do it yourself: do not edit files. Delegate every piece by starting a session with the workbench's `start` tool, never with your own subagents. In each start, give the agent and the model named below, and leave the model out where it says no model.",
  ];
  workflow.steps.forEach((_, index) => {
    lines.push(stepLine(workflow, index));
  });
  const last = workflow.steps[workflow.steps.length - 1];
  lines.push(
    last === undefined
      ? "Report to the user when the task is done."
      : `When every piece has ${from(last)}, report to the user.`,
  );
  return lines;
}

/** The instructions as plain text, numbered. */
export function instructions(workflow: Workflow): string {
  return instructionLines(workflow)
    .map((line, index) => `${index + 1}. ${line}`)
    .join("\n");
}
