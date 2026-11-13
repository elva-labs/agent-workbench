import { describe, expect, it } from "vitest";
import type { Workflow } from "$lib/core";
import { instructionLines, instructions, modelText } from "$lib/workflowInstructions";
import { defaultWorkflow } from "$lib/workflows.svelte";

describe("what an orchestrator is told", () => {
  it("names a model the way the start tool takes it", () => {
    expect(modelText({ agent: "claude-code", model: "sonnet" })).toBe("sonnet on claude-code");
    expect(modelText({ agent: "codex", model: "default" })).toBe("codex's default model");
  });

  it("tells it to delegate through start and not to do the work", () => {
    const [first] = instructionLines(defaultWorkflow());
    expect(first).toContain("`start` tool");
    expect(first).toContain("never with your own subagents");
    expect(first).toContain("do not edit files");
  });

  it("writes the default workflow as numbered sentences, one per step", () => {
    const text = instructions(defaultWorkflow());
    const lines = text.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^1\. /);
    expect(lines[1]).toBe(
      '2. Split the task into pieces and start a session for each for the step "Work", on sonnet on claude-code. Run one session at a time.',
    );
    expect(lines[2]).toBe(
      '3. When a piece has come out of "Work", start a review of it for the step "Review", on opus on claude-code. The piece passes when the reviewer approves and you agree. If it does not pass, send it back to its session for "Work" and review it again, at most 3 times; after that, stop and ask the user.',
    );
    expect(lines[3]).toBe('4. When every piece has come out of "Review", report to the user.');
  });

  it("names the models allowed, the first as the one used, and any model when none are chosen", () => {
    const workflow = defaultWorkflow();
    workflow.steps[0].models = [
      { agent: "claude-code", model: "sonnet" },
      { agent: "codex", model: "default" },
    ];
    workflow.steps[1].models = [];
    const lines = instructionLines(workflow);
    expect(lines[1]).toContain(
      "on sonnet on claude-code, unless you have a reason to pick another of codex's default model.",
    );
    expect(lines[2]).toContain("on any model.");
  });

  it("says how many sessions run at once and how many rounds a review may repeat", () => {
    const workflow = defaultWorkflow();
    if (workflow.steps[0].kind === "work") workflow.steps[0].parallel = 4;
    if (workflow.steps[1].kind === "review") workflow.steps[1].limit = 1;
    const lines = instructionLines(workflow);
    expect(lines[1]).toContain("Run at most 4 sessions at once.");
    expect(lines[2]).toContain("at most once");
  });

  it("says which of the reviewer and the orchestrator decides", () => {
    const workflow = defaultWorkflow();
    const review = workflow.steps[1];
    if (review.kind !== "review") throw new Error("review expected");
    review.orchestratorAgrees = false;
    expect(instructionLines(workflow)[2]).toContain("passes when the reviewer approves.");
    review.orchestratorAgrees = true;
    review.reviewerApproves = false;
    expect(instructionLines(workflow)[2]).toContain("passes when you agree; the reviewer's verdict is advice.");
  });

  it("follows a longer workflow in order and sends a review back to the step it names", () => {
    const workflow: Workflow = {
      name: "Plan first",
      orchestrator: { agent: "claude-code", model: "opus" },
      steps: [
        { kind: "work", name: "Plan", models: [], parallel: 1 },
        { kind: "work", name: "Build", models: [], parallel: 3 },
        {
          kind: "review",
          name: "Check",
          models: [],
          reviewerApproves: true,
          orchestratorAgrees: true,
          backTo: "Plan",
          limit: 2,
        },
      ],
    };
    const lines = instructionLines(workflow);
    expect(lines).toHaveLength(5);
    expect(lines[2]).toContain('When a piece has come out of "Plan", start a session for it for the step "Build"');
    expect(lines[3]).toContain('send it back to its session for "Plan"');
    expect(lines[4]).toContain('"Check"');
  });

  it("uses no em dashes", () => {
    expect(instructions(defaultWorkflow())).not.toContain("—");
  });
});
