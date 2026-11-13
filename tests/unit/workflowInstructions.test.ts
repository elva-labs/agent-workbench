import { describe, expect, it } from "vitest";
import type { ReviewStep, Workflow, WorkflowStep } from "$lib/core";
import { instructionLines, instructions, modelText } from "$lib/workflowInstructions";
import { defaultWorkflow } from "$lib/workflows.svelte";

const work = (name: string, parallel = 1): WorkflowStep => ({ kind: "work", name, models: [], parallel });
const review = (name: string, backTo: string, limit = 2): ReviewStep => ({
  kind: "review",
  name,
  models: [],
  reviewerApproves: true,
  orchestratorAgrees: true,
  backTo,
  limit,
});
const workflowOf = (...steps: WorkflowStep[]): Workflow => ({
  name: "Shaped",
  orchestrator: { agent: "claude-code", model: "opus" },
  steps,
});

describe("what an orchestrator is told", () => {
  it("names a model the way the start tool takes it, and Codex's default with no model", () => {
    expect(modelText({ agent: "claude-code", model: "sonnet" })).toBe("claude-code with the model sonnet");
    expect(modelText({ agent: "codex", model: "default" })).toBe("codex with no model");
    expect(modelText({ agent: "codex", model: "o3" })).toBe("codex with the model o3");
  });

  it("tells it to delegate through start, not to do the work, and when to leave the model out", () => {
    const [first] = instructionLines(defaultWorkflow());
    expect(first).toContain("`start` tool");
    expect(first).toContain("never with your own subagents");
    expect(first).toContain("do not edit files");
    expect(first).toContain("leave the model out where it says no model");
  });

  it("writes the default workflow as numbered sentences, one per step", () => {
    const lines = instructions(defaultWorkflow()).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^1\. /);
    expect(lines[1]).toBe(
      '2. For the step "Work", split the task into pieces and start a session for each, on claude-code with the model sonnet. Run one session at a time.',
    );
    expect(lines[2]).toBe(
      '3. For the step "Review", start a review of each piece once it has come out of "Work", on claude-code with the model opus. The piece passes when the reviewer approves and you agree. If it does not pass, send it back to its session for "Work", then review it again for "Review". Send a piece back at most 3 times; after that, stop and ask the user.',
    );
    expect(lines[3]).toBe('4. When every piece has passed "Review", report to the user.');
  });

  it("names the models allowed, the first as the one used, and any when none are chosen", () => {
    const workflow = defaultWorkflow();
    workflow.steps[0].models = [
      { agent: "claude-code", model: "sonnet" },
      { agent: "codex", model: "default" },
      { agent: "claude-code", model: "haiku" },
    ];
    workflow.steps[1].models = [];
    const lines = instructionLines(workflow);
    expect(lines[1]).toContain(
      "on claude-code with the model sonnet; when you have a reason to, use codex with no model or claude-code with the model haiku instead.",
    );
    expect(lines[2]).toContain("on any agent and model.");
  });

  it("names a Codex-only step's agent and says to give it no model", () => {
    const workflow = defaultWorkflow();
    workflow.steps[0].models = [{ agent: "codex", model: "default" }];
    const [, line] = instructionLines(workflow);
    expect(line).toContain("on codex with no model.");
    expect(line).not.toMatch(/codex with the model|default model/);
  });

  it("says how many sessions run at once and how many times a piece is sent back", () => {
    const workflow = defaultWorkflow();
    if (workflow.steps[0].kind === "work") workflow.steps[0].parallel = 4;
    if (workflow.steps[1].kind === "review") workflow.steps[1].limit = 1;
    const lines = instructionLines(workflow);
    expect(lines[1]).toContain("Run at most 4 sessions at once.");
    expect(lines[2]).toContain("Send a piece back once;");
  });

  it("says which of the reviewer and the orchestrator decides", () => {
    const workflow = defaultWorkflow();
    const step = workflow.steps[1];
    if (step.kind !== "review") throw new Error("review expected");
    step.orchestratorAgrees = false;
    expect(instructionLines(workflow)[2]).toContain("passes when the reviewer approves.");
    step.orchestratorAgrees = true;
    step.reviewerApproves = false;
    expect(instructionLines(workflow)[2]).toContain("passes when you agree; the reviewer's verdict is advice.");
  });

  it("takes a piece sent back past several steps through each of them again", () => {
    const lines = instructionLines(workflowOf(work("Plan"), work("Build", 3), review("Check", "Plan")));
    expect(lines).toHaveLength(5);
    expect(lines[2]).toContain('For the step "Build", start a session for each piece once it has come out of "Plan"');
    expect(lines[3]).toContain(
      'send it back to its session for "Plan", take it through "Build" again, then review it again for "Check". Send a piece back at most 2 times;',
    );
    expect(lines[4]).toBe('When every piece has passed "Check", report to the user.');
  });

  it("with two reviews, says the piece passed the first and which steps repeat for the second", () => {
    const lines = instructionLines(
      workflowOf(work("Plan"), review("Plan review", "Plan"), work("Build"), review("Check", "Plan")),
    );
    expect(lines[3]).toContain('For the step "Build", start a session for each piece once it has passed "Plan review"');
    expect(lines[4]).toContain(
      'send it back to its session for "Plan", take it through "Plan review" and "Build" again, then review it again for "Check".',
    );
    const near = instructionLines(
      workflowOf(work("Plan"), review("Plan review", "Plan"), work("Build"), review("Check", "Build")),
    );
    expect(near[4]).toContain('send it back to its session for "Build", then review it again for "Check".');
    expect(near[4]).not.toContain("Plan review");
  });

  it("follows a work step that ends the workflow with the work coming out of it", () => {
    const lines = instructionLines(workflowOf(work("Do")));
    expect(lines.at(-1)).toBe('When every piece has come out of "Do", report to the user.');
  });

  it("uses no em dashes", () => {
    expect(instructions(defaultWorkflow())).not.toContain("—");
  });
});
