import { beforeEach, describe, expect, it } from "vitest";
import { AGENT_ORDER, modelLabel, modelsOf, mostCapable, offeredModels, sameModel } from "$lib/models";
import { heardCatalog, resetCatalogs } from "$lib/modelCatalog.svelte";

describe("the models an agent offers", () => {
  it("offers Claude Code the aliases its command line takes, the most capable first", () => {
    expect(modelsOf("claude-code").map((option) => option.model)).toEqual([
      "fable",
      "opus",
      "sonnet",
      "haiku",
    ]);
    expect(mostCapable().model).toBe("fable");
  });

  it("offers Codex its own default under the name Codex", () => {
    expect(modelsOf("codex")).toEqual([{ agent: "codex", model: "default", label: "Codex" }]);
  });

  it("belongs each model to one agent", () => {
    for (const agent of AGENT_ORDER) {
      for (const option of modelsOf(agent)) expect(option.agent).toBe(agent);
    }
    expect(sameModel({ agent: "claude-code", model: "opus" }, { agent: "codex", model: "opus" })).toBe(false);
  });

  it("shows a name the list does not hold as it is written", () => {
    expect(modelLabel("claude-code", "opus")).toBe("Opus");
    expect(modelLabel("claude-code", "claude-opus-5-5")).toBe("claude-opus-5-5");
  });
});

describe("what a workflow picker offers", () => {
  beforeEach(() => resetCatalogs());

  it("offers Codex its default first, then the models Codex listed, by their names", () => {
    heardCatalog("codex", "work", [
      { value: "gpt-6.2-sol", name: "GPT-6.2-Sol" },
      { value: "gpt-6.1-luna", name: "GPT-6.1-Luna (preview)" },
    ]);
    heardCatalog("codex", null, [
      { value: "gpt-6.2-sol", name: "GPT-6.2-Sol" },
      { value: "gpt-5-mini", name: null },
    ]);
    expect(offeredModels("codex")).toEqual([
      { agent: "codex", model: "default", label: "Codex" },
      { agent: "codex", model: "gpt-6.2-sol", label: "GPT-6.2-Sol" },
      { agent: "codex", model: "gpt-6.1-luna", label: "GPT-6.1-Luna" },
      { agent: "codex", model: "gpt-5-mini", label: "gpt-5-mini" },
    ]);
  });

  it("offers Codex its default alone where no list has been heard", () => {
    expect(offeredModels("codex")).toEqual(modelsOf("codex"));
  });

  it("offers Claude Code its aliases alone, whatever its list says", () => {
    heardCatalog("claude-code", null, [{ value: "claude-opus-5-5", name: "Opus 5.5" }]);
    expect(offeredModels("claude-code")).toEqual(modelsOf("claude-code"));
  });
});
