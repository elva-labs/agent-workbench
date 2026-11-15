import { describe, expect, it } from "vitest";
import { Conversation } from "$lib/conversation.svelte";
import { effortInUse } from "$lib/settingChoices";

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
