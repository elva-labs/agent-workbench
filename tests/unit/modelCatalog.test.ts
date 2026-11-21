import { beforeEach, describe, expect, it } from "vitest";
import { catalogName, catalogOf, heardCatalog, resetCatalogs } from "$lib/modelCatalog.svelte";
import { modelLabel } from "$lib/models";
import { sessionModelName } from "$lib/sessions.svelte";

const SOL = { value: "gpt-6.2-sol", name: "GPT-6.2-Sol" };
const LUNA = { value: "gpt-6.1-luna", name: "GPT-6.1-Luna (preview)" };

beforeEach(() => resetCatalogs());

describe("what a Codex model is called", () => {
  it("is the name Codex's own list gives it for the account", () => {
    heardCatalog("codex", "work", [SOL, LUNA]);
    expect(catalogName("codex", "gpt-6.2-sol", "work")).toBe("GPT-6.2-Sol");
    expect(modelLabel("codex", "gpt-6.2-sol", "work")).toBe("GPT-6.2-Sol");
    expect(sessionModelName({ agent: "codex", model: "gpt-6.2-sol", account: "work" })).toBe("GPT-6.2-Sol");
  });

  it("leaves off a note in brackets, as the composer does", () => {
    heardCatalog("codex", null, [LUNA]);
    expect(catalogName("codex", "gpt-6.1-luna")).toBe("GPT-6.1-Luna");
  });

  it("takes another account's name where the account's list has not been heard", () => {
    heardCatalog("codex", "work", [SOL]);
    expect(catalogName("codex", "gpt-6.2-sol", "personal")).toBe("GPT-6.2-Sol");
  });

  it("is the id where no list names it", () => {
    heardCatalog("codex", "work", [SOL]);
    expect(catalogName("codex", "gpt-7-nova", "work")).toBe("gpt-7-nova");
    expect(sessionModelName({ agent: "codex", model: "gpt-7-nova", account: null })).toBe("gpt-7-nova");
  });

  it("keeps Codex's own default called Codex", () => {
    heardCatalog("codex", null, [{ value: "default", name: "Default" }]);
    expect(modelLabel("codex", "default")).toBe("Codex");
  });

  it("keeps the last list heard for each account", () => {
    heardCatalog("codex", "work", [SOL]);
    heardCatalog("codex", "work", [LUNA]);
    heardCatalog("codex", "work", []);
    expect(catalogOf("codex", "work")?.map((model) => model.value)).toEqual(["gpt-6.1-luna"]);
  });
});

describe("what a Claude Code model is called", () => {
  it("is as it always was, whatever its list says", () => {
    heardCatalog("claude-code", null, [{ value: "opus", name: "Opus 5.5 (1M)" }]);
    expect(catalogOf("claude-code", null)).toBeNull();
    expect(catalogName("claude-code", "opus")).toBeNull();
    expect(modelLabel("claude-code", "opus")).toBe("Opus");
    expect(sessionModelName({ agent: "claude-code", model: "claude-opus-4-1-20250805", account: null })).toBe(
      "Opus 4.1",
    );
    expect(sessionModelName({ agent: "claude-code", model: null, account: null })).toBeNull();
  });
});
