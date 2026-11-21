import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptAccounts, reset as resetAccounts } from "$lib/accounts.svelte";
import { askCodexCatalog, catalogName, catalogOf, heardCatalog, resetCatalogs } from "$lib/modelCatalog.svelte";
import { modelLabel } from "$lib/models";
import { sessionModelName } from "$lib/sessions.svelte";

const SOL = { value: "gpt-6.2-sol", name: "GPT-6.2-Sol" };
const LUNA = { value: "gpt-6.1-luna", name: "GPT-6.1-Luna (preview)" };

beforeEach(() => resetCatalogs());

describe("what a Codex model is called", () => {
  it("is the name Codex's own list gives it for the account", () => {
    heardCatalog("codex", null, "work", [SOL, LUNA]);
    expect(catalogName("codex", "gpt-6.2-sol", "work")).toBe("GPT-6.2-Sol");
    expect(modelLabel("codex", "gpt-6.2-sol", "work")).toBe("GPT-6.2-Sol");
    expect(sessionModelName({ agent: "codex", model: "gpt-6.2-sol", account: "work", project: "/w" })).toBe("GPT-6.2-Sol");
  });

  it("leaves off a note in brackets, as the composer does", () => {
    heardCatalog("codex", null, null, [LUNA]);
    expect(catalogName("codex", "gpt-6.1-luna")).toBe("GPT-6.1-Luna");
  });

  it("takes another account's name where the account's list has not been heard", () => {
    heardCatalog("codex", null, "work", [SOL]);
    expect(catalogName("codex", "gpt-6.2-sol", "personal")).toBe("GPT-6.2-Sol");
  });

  it("is the id where no list names it", () => {
    heardCatalog("codex", null, "work", [SOL]);
    expect(catalogName("codex", "gpt-7-nova", "work")).toBe("gpt-7-nova");
    expect(sessionModelName({ agent: "codex", model: "gpt-7-nova", account: null, project: "/w" })).toBe("gpt-7-nova");
  });

  it("keeps Codex's own default called Codex", () => {
    heardCatalog("codex", null, null, [{ value: "default", name: "Default" }]);
    expect(modelLabel("codex", "default")).toBe("Codex");
  });

  it("keeps the last list heard for each account", () => {
    heardCatalog("codex", null, "work", [SOL]);
    heardCatalog("codex", null, "work", [LUNA]);
    heardCatalog("codex", null, "work", []);
    expect(catalogOf("codex", null, "work")?.map((model) => model.value)).toEqual(["gpt-6.1-luna"]);
  });
});

describe("what a Claude Code model is called", () => {
  it("is as it always was, whatever its list says", () => {
    heardCatalog("claude-code", null, null, [{ value: "opus", name: "Opus 5.5 (1M)" }]);
    expect(catalogOf("claude-code", null, null)).toBeNull();
    expect(catalogName("claude-code", "opus")).toBeNull();
    expect(modelLabel("claude-code", "opus")).toBe("Opus");
    expect(sessionModelName({ agent: "claude-code", model: "claude-opus-4-1-20250805", account: null, project: "/w" })).toBe(
      "Opus 4.1",
    );
    expect(sessionModelName({ agent: "claude-code", model: null, account: null, project: "/w" })).toBeNull();
  });
});

describe("reading Codex's models where no session has listed them", () => {
  const asked: { project: string; configDir?: string }[] = [];
  let answer: () => Promise<{ models: { value: string; name: string }[] }>;

  beforeEach(() => {
    asked.length = 0;
    answer = async () => ({ models: [SOL] });
    adoptAccounts({ list: { work: { claude: null, codex: "~/.codex-work" } }, everywhere: null, overrides: { "/w": "work" } });
    (window as unknown as { __CHORD_CORE__: unknown }).__CHORD_CORE__ = {
      codexModels: (project: string, configDir?: string) => {
        asked.push({ project, configDir });
        return answer();
      },
    };
  });

  afterEach(() => {
    delete (window as unknown as { __CHORD_CORE__?: unknown }).__CHORD_CORE__;
    resetAccounts();
  });

  it("asks under the project's account, in the project, and names the models from it", async () => {
    await askCodexCatalog("/w", null);
    expect(asked).toEqual([{ project: "/w", configDir: "~/.codex-work" }]);
    expect(catalogName("codex", "gpt-6.2-sol", "work")).toBe("GPT-6.2-Sol");
  });

  it("asks once for each account, and not where a session has listed them", async () => {
    await Promise.all([askCodexCatalog("/w", null), askCodexCatalog("/w", null)]);
    await askCodexCatalog("/w", null);
    expect(asked).toHaveLength(1);
    heardCatalog("codex", null, null, [LUNA]);
    await askCodexCatalog("/elsewhere", null);
    expect(asked).toHaveLength(1);
  });

  it("asks for a project on another machine of the Codex there, and names its models from it", async () => {
    const remote = "ssh://me@box/w";
    heardCatalog("codex", null, null, [{ value: "gpt-6.2-sol", name: "Sol here" }]);
    answer = async () => ({ models: [SOL] });
    await askCodexCatalog(remote, "me@box");
    expect(asked.map((one) => one.project)).toEqual([remote]);
    expect(catalogOf("codex", "me@box", null)?.map((model) => model.name)).toEqual(["GPT-6.2-Sol"]);
    expect(catalogName("codex", "gpt-6.2-sol", null, "me@box")).toBe("GPT-6.2-Sol");
    expect(catalogName("codex", "gpt-6.2-sol", null)).toBe("Sol here");
    expect(sessionModelName({ agent: "codex", model: "gpt-6.2-sol", account: null, project: remote })).toBe(
      "GPT-6.2-Sol",
    );
  });

  it("asks again where Codex listed no models", async () => {
    answer = async () => ({ models: [] });
    await askCodexCatalog("/w", null);
    answer = async () => ({ models: [SOL] });
    await askCodexCatalog("/w", null);
    expect(asked).toHaveLength(2);
    expect(catalogOf("codex", null, "work")).not.toBeNull();
  });

  it("asks again where Codex could not say", async () => {
    answer = () => Promise.reject(new Error("codex: not found"));
    await askCodexCatalog("/w", null);
    expect(catalogOf("codex", null, "work")).toBeNull();
    answer = async () => ({ models: [SOL] });
    await askCodexCatalog("/w", null);
    expect(asked).toHaveLength(2);
    expect(catalogOf("codex", null, "work")).not.toBeNull();
  });
});
