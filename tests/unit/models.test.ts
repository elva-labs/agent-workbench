import { describe, expect, it } from "vitest";
import { AGENT_ORDER, modelLabel, modelsOf, mostCapable, sameModel } from "$lib/models";

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
