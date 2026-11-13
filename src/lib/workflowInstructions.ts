import type { Workflow, WorkflowModel, WorkflowStep } from "$lib/core";
import { CODEX_DEFAULT } from "$lib/models";

/**
 * What an orchestrator is told, written from a workflow.
 *
 * The result is a short list of sentences in the order the work goes: how
 * to delegate, one sentence or two per step with the models it allows, and
 * where a review sends the work back and how often. A model is named the
 * way the `start` tool takes it, the model and then its agent.
 */

/** A model as the `start` tool is given it. */
export function modelText(model: WorkflowModel): string {
  if (model.agent === "codex" && model.model === CODEX_DEFAULT) {
    return "codex's default model";
  }
  return `${model.model} on ${model.agent}`;
}

/** Where a step may run: any model, one, or a set whose first is used
    unless there is a reason. */
function placeText(step: WorkflowStep): string {
  const [first, ...rest] = step.models;
  if (first === undefined) return "on any model";
  if (rest.length === 0) return `on ${modelText(first)}`;
  return `on ${modelText(first)}, unless you have a reason to pick another of ${rest
    .map(modelText)
    .join(", ")}`;
}

const times = (count: number) => (count === 1 ? "once" : `${count} times`);

function stepLine(step: WorkflowStep, before: WorkflowStep | undefined): string {
  if (step.kind === "work") {
    const lead =
      before === undefined
        ? `Split the task into pieces and start a session for each for the step "${step.name}"`
        : `When a piece has come out of "${before.name}", start a session for it for the step "${step.name}"`;
    const at =
      step.parallel === 1
        ? "Run one session at a time."
        : `Run at most ${step.parallel} sessions at once.`;
    return `${lead}, ${placeText(step)}. ${at}`;
  }
  const lead =
    before === undefined
      ? `When a piece is done, start a review of it for the step "${step.name}"`
      : `When a piece has come out of "${before.name}", start a review of it for the step "${step.name}"`;
  const passes =
    step.reviewerApproves && step.orchestratorAgrees
      ? "The piece passes when the reviewer approves and you agree."
      : step.reviewerApproves
        ? "The piece passes when the reviewer approves."
        : "The piece passes when you agree; the reviewer's verdict is advice.";
  const otherwise = `If it does not pass, send it back to its session for "${step.backTo}" and review it again, at most ${times(step.limit)}; after that, stop and ask the user.`;
  return `${lead}, ${placeText(step)}. ${passes} ${otherwise}`;
}

/** The instructions as sentences, one per line of the list. */
export function instructionLines(workflow: Workflow): string[] {
  const lines = [
    "You direct this work and do not do it yourself: do not edit files. Delegate every piece by starting a session with the workbench's `start` tool, never with your own subagents, and name the model and its agent in each start.",
  ];
  workflow.steps.forEach((step, index) => {
    lines.push(stepLine(step, workflow.steps[index - 1]));
  });
  const last = workflow.steps[workflow.steps.length - 1];
  lines.push(
    last === undefined
      ? "Report to the user when the task is done."
      : `When every piece has come out of "${last.name}", report to the user.`,
  );
  return lines;
}

/** The instructions as plain text, numbered. */
export function instructions(workflow: Workflow): string {
  return instructionLines(workflow)
    .map((line, index) => `${index + 1}. ${line}`)
    .join("\n");
}
