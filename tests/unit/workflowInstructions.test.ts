import { describe, expect, it } from "vitest";
import type { ReviewStep, Workflow, WorkflowStep } from "$lib/core";
import { instructionLines, instructions, modelText, orchestratorPrompt } from "$lib/workflowInstructions";
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
    expect(first).toContain("the workbench's start tool");
    // Shown to the user as well, in the settings and on the tag, so no
    // line carries a raw backtick.
    for (const workflow of [defaultWorkflow(), { ...defaultWorkflow(), startOnly: false }])
      for (const line of instructionLines(workflow)) expect(line).not.toContain("`");
    expect(first).toContain("never with your own subagents");
    expect(first).toContain("do not edit files");
    expect(first).toContain("leave the model out where it says no model");
    expect(first).toContain("name the step it is for");
    expect(first).toContain("names the session whose work it checks");
  });

  it("lets an orchestrator that keeps its subagents use them for help, and not for a piece", () => {
    const [first] = instructionLines({ ...defaultWorkflow(), startOnly: false });
    expect(first).not.toContain("never with your own subagents");
    expect(first).toContain("so the user can see it; your own subagents are for help along the way, not for a piece of the work.");
  });

  it("tells a session which workflow it follows, before the numbered list", () => {
    const lines = orchestratorPrompt(defaultWorkflow()).split("\n");
    expect(lines[0]).toBe('You are the orchestrator of the Agent Workbench workflow "Build and review". Follow it:');
    expect(lines.slice(1).join("\n")).toBe(instructions(defaultWorkflow()));
  });

  it("writes the default workflow as numbered sentences, one per step", () => {
    const lines = instructions(defaultWorkflow()).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^1\. /);
    expect(lines[1]).toBe(
      '2. For the step "Work", split the task into pieces and start a session for each, on claude-code with the model sonnet. Run one "Work" session at a time, and stop it once its piece is done with; a stopped session can be resumed.',
    );
    expect(lines[2]).toBe(
      '3. For the step "Review", start a review of each piece once it has come out of "Work", on claude-code with the model opus. The piece passes when the reviewer approves and you agree. If it does not pass, send it back with send to the piece\'s own session for "Work", with what the review found, resuming that session first with start if it was stopped. Then review it again for "Review", with a new review naming the same work or a line to the reviewer. Send a piece back at most 3 times; after that, stop and ask the user, and start another round only if they want one.',
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
    expect(lines[1]).toContain('Run at most 4 "Work" sessions at once, and stop each once its piece is done with;');
    expect(lines[2]).toContain("Send a piece back at most once;");
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
      'send it back with send to the piece\'s own session for "Plan", with what the review found, resuming that session first with start if it was stopped, take it through "Build" again. Then review it again for "Check",',
    );
    expect(lines[4]).toBe('When every piece has passed "Check", report to the user.');
  });

  it("with two reviews, says the piece passed the first and which steps repeat for the second", () => {
    const lines = instructionLines(
      workflowOf(work("Plan"), review("Plan review", "Plan"), work("Build"), review("Check", "Plan")),
    );
    expect(lines[3]).toContain('For the step "Build", start a session for each piece once it has passed "Plan review"');
    expect(lines[4]).toContain(
      'resuming that session first with start if it was stopped, take it through "Plan review" and "Build" again. Then review it again for "Check",',
    );
    const near = instructionLines(
      workflowOf(work("Plan"), review("Plan review", "Plan"), work("Build"), review("Check", "Build")),
    );
    expect(near[4]).toContain('to the piece\'s own session for "Build", with what the review found, resuming that session first with start if it was stopped. Then review it again for "Check",');
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
