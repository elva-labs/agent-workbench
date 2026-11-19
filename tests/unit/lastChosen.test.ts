import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "$lib/core";

const sets: Partial<Settings>[] = [];

vi.mock("$lib/core", () => ({
  core: () => ({
    settingsSet: async (change: Partial<Settings>) => {
      sets.push(change);
      return change as Settings;
    },
  }),
}));

import {
  adoptLastChosen,
  anyChosen,
  choose,
  chosenFor,
  forget,
  heardOffers,
  lastChosen,
  lastChosenSettings,
  modelToStart,
  narrowTo,
  resetLastChosen,
} from "$lib/lastChosen.svelte";
import { carriedOver } from "$lib/modeFit";
import { resetPersist } from "$lib/persist";

beforeEach(() => {
  resetLastChosen();
  resetPersist();
  sets.length = 0;
});

describe("what new sessions of an agent start on", () => {
  it("keeps the user's last model, effort and mode for each agent apart, and stores each change", () => {
    choose("claude-code", "model", "opus");
    choose("claude-code", "effort", "high");
    choose("claude-code", "mode", "acceptEdits");
    choose("codex", "mode", "auto");
    expect(chosenFor("claude-code")).toEqual({ model: "opus", effort: "high", mode: "acceptEdits" });
    expect(chosenFor("codex")).toEqual({ mode: "auto" });
    expect(sets.at(-1)).toEqual({
      lastChosen: { "claude-code": { model: "opus", effort: "high", mode: "acceptEdits" }, codex: { mode: "auto" } },
    });
    expect(lastChosenSettings().lastChosen).toEqual(sets.at(-1)!.lastChosen);
    // The same choice again changes nothing.
    const before = sets.length;
    choose("claude-code", "model", "opus");
    expect(sets).toHaveLength(before);
  });

  it("never keeps Plan, bypassing permissions or full access, and leaves the last mode kept", () => {
    choose("claude-code", "mode", "acceptEdits");
    for (const mode of ["plan", "bypassPermissions", "somethingNew"]) choose("claude-code", "mode", mode);
    expect(chosenFor("claude-code").mode).toBe("acceptEdits");
    choose("codex", "mode", "full-access");
    expect(anyChosen("codex")).toBe(false);
    expect(carriedOver("claude-code", "auto")).toBe(true);
    expect(carriedOver("claude-code", "dontAsk")).toBe(true);
    expect(carriedOver("codex", "read-only")).toBe(true);
    expect(carriedOver("claude-code", "plan")).toBe(false);
  });

  it("goes back to the agent's own: its default model keeps none, and forgetting keeps nothing", () => {
    choose("claude-code", "model", "opus");
    choose("claude-code", "effort", "low");
    choose("claude-code", "model", "default");
    expect(chosenFor("claude-code")).toEqual({ effort: "low" });
    forget("claude-code");
    expect(anyChosen("claude-code")).toBe(false);
    expect(sets.at(-1)).toEqual({ lastChosen: {} });
  });

  it("starts an account's sessions on the agent's default where the account was heard not to offer the model", () => {
    choose("claude-code", "model", "opus");
    expect(modelToStart("claude-code", "work")).toBe("opus");
    heardOffers("claude-code", "work", ["default", "sonnet", "haiku"]);
    heardOffers("claude-code", null, ["default", "opus", "sonnet"]);
    expect(modelToStart("claude-code", "work")).toBeNull();
    expect(modelToStart("claude-code", null)).toBe("opus");
    // The choice stays for the accounts that offer it.
    expect(chosenFor("claude-code").model).toBe("opus");
  });

  it("takes no Plan, bypassing permissions or full access from the settings, whoever wrote them", () => {
    adoptLastChosen({
      "claude-code": { model: "opus", mode: "bypassPermissions" },
      codex: { mode: "full-access", effort: "high" },
      later: { mode: "auto" },
    });
    expect(chosenFor("claude-code")).toEqual({ model: "opus" });
    expect(chosenFor("codex")).toEqual({ effort: "high" });
    adoptLastChosen({ "claude-code": { mode: "plan" } });
    expect(anyChosen("claude-code")).toBe(false);
  });

  it("lets a terminal's report narrow the kept mode, never widen it", () => {
    // A forged pair of lines: Default, then Auto. Nothing kept stands for
    // Default, so Auto is not kept.
    narrowTo("claude-code", "default");
    narrowTo("claude-code", "auto");
    expect(chosenFor("claude-code").mode).toBe("default");
    resetLastChosen();
    narrowTo("claude-code", "auto");
    narrowTo("claude-code", "acceptEdits");
    expect(anyChosen("claude-code")).toBe(false);
    // From what a chip kept, a narrower report is taken and a wider one not.
    choose("claude-code", "mode", "auto");
    narrowTo("claude-code", "acceptEdits");
    expect(chosenFor("claude-code").mode).toBe("acceptEdits");
    narrowTo("claude-code", "auto");
    narrowTo("claude-code", "bypassPermissions");
    expect(chosenFor("claude-code").mode).toBe("acceptEdits");
    narrowTo("claude-code", "plan");
    expect(chosenFor("claude-code").mode).toBe("acceptEdits");
    expect(lastChosen.byAgent["claude-code"]).toEqual({ mode: "acceptEdits" });
  });

  it("takes from the settings only what reads", () => {
    adoptLastChosen({
      "claude-code": { model: "opus", effort: 3, mode: "" },
      codex: "auto",
      later: { mode: "auto", extra: true },
    });
    expect(chosenFor("claude-code")).toEqual({ model: "opus" });
    expect(chosenFor("codex")).toEqual({});
    adoptLastChosen(undefined);
    expect(anyChosen("claude-code")).toBe(false);
  });
});
