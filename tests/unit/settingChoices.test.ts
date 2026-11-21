import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Conversation } from "$lib/conversation.svelte";
import { effortChoices, effortInUse, heldModel, modeChoices, modeName, workflowChoices } from "$lib/settingChoices";
import { effortScale, lowerEffort } from "$lib/integrated.svelte";
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

describe("the efforts a model takes", () => {
  const CODEX = [
    {
      value: "gpt-6.2-sol",
      name: "GPT-6.2-Sol",
      description: null,
      efforts: ["low", "max", "ultra"],
      effortDescriptions: { ultra: "Maximum reasoning with automatic task delegation" },
    },
  ];

  it("are said in the agent's words where it has some, and in the app's where it has none", () => {
    const choices = effortChoices(ready("gpt-6.2-sol", "max", ["low", "max", "ultra"], CODEX));
    expect(choices.map(({ value, name, about, on }) => [value, name, about, on])).toEqual([
      ["low", "Low", "Quick, little thinking", false],
      ["max", "Max", "Slowest, for the hardest problems", true],
      ["ultra", "Ultra", "Maximum reasoning with automatic task delegation", false],
    ]);
  });

  it("go from the least to the most as the agent's models list them", () => {
    const scale = effortScale([
      { efforts: ["low", "high"] },
      { efforts: ["medium", "high", "max", "ultra"] },
      { efforts: ["none", "low"] },
    ]);
    expect(scale).toEqual(["none", "low", "medium", "high", "max", "ultra"]);
  });

  it("fall from ultra to the highest below it that the model takes", () => {
    const scale = effortScale([{ efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] }]);
    expect(lowerEffort("ultra", ["low", "medium", "high", "xhigh", "max"], scale)).toBe("max");
    expect(lowerEffort("ultra", ["low", "medium"], [])).toBe("medium");
    expect(lowerEffort("turbo", ["low"], scale)).toBeNull();
  });
});

describe("the mode the session runs in", () => {
  function inMode(mode: string): Conversation {
    const c = ready("claude-sonnet-5-5", null, []);
    c.apply({
      type: "configured",
      model: "claude-sonnet-5-5",
      mode,
      effort: null,
      efforts: [],
    });
    c.ready = {
      ...c.ready!,
      modes: [
        { value: "default", name: "Default", description: null },
        { value: "auto", name: "Auto", description: null },
      ],
    };
    return c;
  }

  it("is named as the agent names a mode it offers, and in plain words otherwise", () => {
    expect(modeName(inMode("auto"), "auto")).toBe("Auto");
    expect(modeName(inMode("auto"), "bypassPermissions")).toBe("Bypass permissions");
    expect(modeName(inMode("auto"), "untrusted, workspace-write")).toBe("Untrusted, workspace write");
  });

  it("is listed first when it comes from the agent's own settings, saying it does not come back once left", () => {
    const choices = modeChoices(inMode("bypassPermissions"));
    expect(choices.map((choice) => [choice.name, choice.on])).toEqual([
      ["Bypass permissions", true],
      ["Default", false],
      ["Auto", false],
    ]);
    expect(choices[0].about).toContain("comes back only in a new session");
    expect(modeChoices(inMode("auto")).map((choice) => choice.name)).toEqual(["Default", "Auto"]);
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
  const FABLE = [...MODELS, { value: "fable", name: "Fable 5.2 (most capable)", description: null, efforts: [] }];

  it("is the workflow's until the run says, then the one the run says it is on, named as the agent offers it", () => {
    expect(heldModel(new Conversation(() => 0), defaultWorkflow())).toBe("Fable");
    expect(heldModel(ready("claude-fable-5-2", null, [], FABLE), defaultWorkflow())).toBe("Fable 5.2");
    expect(heldModel(ready("fable", null, []), defaultWorkflow())).toBe("Fable");
    // A run on another model than the workflow's is named by its own.
    expect(heldModel(ready("claude-sonnet-5-5", null, [], FABLE), defaultWorkflow())).toBe("Sonnet");
    expect(heldModel(ready("claude-unlisted-9", null, []), defaultWorkflow())).toBe("claude-unlisted-9");
  });
});
