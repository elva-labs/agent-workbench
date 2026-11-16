import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Conversation } from "$lib/conversation.svelte";
import { effortInUse, heldModel, workflowChoices } from "$lib/settingChoices";
import { applyDetect, resetAgent } from "$lib/agent.svelte";
import { adoptWorkflows, defaultWorkflow, reset as resetWorkflows } from "$lib/workflows.svelte";

const MODELS = [
  { value: "haiku", name: "Haiku", description: null, efforts: [] as string[] },
  { value: "sonnet", name: "Sonnet", description: null, efforts: ["low", "medium", "high"] },
];

function ready(model: string | null, effort: string | null, efforts: string[], models = MODELS): Conversation {
  const c = new Conversation(() => 0);
  c.apply({
    type: "ready",
    sessionId: "s",
    model,
    mode: null,
    effort,
    version: null,
    models,
    modes: [],
    efforts,
    commands: [],
  });
  return c;
}

describe("the effort the session runs at", () => {
  it("is the one the agent names where the model takes efforts", () => {
    expect(effortInUse(ready("claude-sonnet-5-5", "high", ["low", "medium", "high"]))).toBe("high");
  });

  it("is none where the agent offers the model in use with no efforts", () => {
    const c = ready("claude-sonnet-5-5", "high", ["low", "medium", "high"]);
    c.apply({ type: "configured", model: "haiku", mode: null, effort: "high", efforts: [] });
    expect(effortInUse(c)).toBeNull();
  });

  it("is the one the agent names where nothing says which efforts the model takes", () => {
    expect(effortInUse(ready("claude-unknown-9", "high", []))).toBe("high");
    expect(effortInUse(ready("haiku", "high", [], []))).toBe("high");
  });

  it("is none before the agent names one", () => {
    expect(effortInUse(ready("claude-sonnet-5-5", null, ["low", "medium", "high"]))).toBeNull();
  });
});

describe("the workflows a new conversation can follow", () => {
  const codexFlow = { ...defaultWorkflow(), name: "Codex directs", orchestrator: { agent: "codex" as const, model: "default" } };

  beforeEach(() => {
    resetWorkflows();
    applyDetect(
      { id: "claude-code", path: "/bin/claude", caps: { resumable: true, titles: true, acp: false, integrated: true }, fromLoginShell: true },
      true,
    );
  });
  afterEach(() => resetAgent());

  it("are none first, then each workflow with who directs, works and reviews, the one followed ticked", () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: null, overrides: {} });
    expect(workflowChoices("claude-code", "Claude", null)).toEqual([
      { value: "", name: "No workflow", about: "Claude works alone, on the model you pick", on: true },
      { value: "Build and review", name: "Build and review", about: "Fable directs, Sonnet works, Opus reviews", on: false },
    ]);
    expect(workflowChoices("claude-code", "Claude", defaultWorkflow()).map((choice) => choice.on)).toEqual([false, true]);
  });

  it("say why one directed by an agent that is not here cannot be chosen", () => {
    adoptWorkflows({ list: [defaultWorkflow(), codexFlow], default: null, overrides: {} });
    expect(workflowChoices("claude-code", "Claude", null)[2]).toEqual({
      value: "Codex directs",
      name: "Codex directs",
      about: "Directed by Codex, which is not installed here",
      on: false,
      off: true,
    });
    applyDetect(
      { id: "codex", path: "/bin/codex", caps: { resumable: true, titles: true, acp: false, integrated: false }, fromLoginShell: true },
      true,
    );
    expect(workflowChoices("claude-code", "Claude", null)[2].about).toBe("Directed by Codex, which runs only in a terminal");
  });

  it("keep the one the session follows though the settings dropped it", () => {
    adoptWorkflows({ list: [codexFlow], default: null, overrides: {} });
    expect(workflowChoices("claude-code", "Claude", defaultWorkflow()).map((choice) => [choice.name, choice.on])).toEqual([
      ["No workflow", false],
      ["Build and review", true],
      ["Codex directs", false],
    ]);
  });
});

describe("the model a workflow holds its orchestrator to", () => {
  it("is named as the agent offers it, else as the workflow's settings name it", () => {
    const offered = ready("claude-fable-5-2", null, [], [
      ...MODELS,
      { value: "fable", name: "Fable 5.2 (most capable)", description: null, efforts: [] },
    ]);
    expect(heldModel(offered, defaultWorkflow())).toBe("Fable 5.2");
    expect(heldModel(ready("claude-fable-5-2", null, []), defaultWorkflow())).toBe("Fable");
    expect(heldModel(new Conversation(() => 0), defaultWorkflow())).toBe("Fable");
  });
});
