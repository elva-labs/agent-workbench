import { describe, expect, it } from "vitest";
import type { IntegratedCommand } from "$lib/core";
import { pieces, rank } from "$lib/completion";
import { complete, named, slashGroups, slashWord, sourceOf, waitingHint } from "$lib/slash";

function command(name: string, options: Partial<IntegratedCommand> = {}): IntegratedCommand {
  return { name, description: null, hint: null, skill: false, builtin: true, source: null, ...options };
}

const COMMANDS = [
  command("review", { hint: "[pr]" }),
  command("compact", { hint: "[instructions]" }),
  command("release", { builtin: false, source: "project", hint: "<version>" }),
  command("security-review"),
  command("code-review", { skill: true, builtin: false, source: "user" }),
  command("run", { skill: true, builtin: false, source: "project" }),
  command("kit:deploy", { skill: true, builtin: false, source: "kit" }),
];

const names = (groups: ReturnType<typeof slashGroups>) =>
  groups.map((group) => [group.label, group.matches.map((match) => match.item.name)]);

describe("completing a word from a list", () => {
  it("puts names that begin with the query first, then those with a later word that does", () => {
    const found = rank(["code-review", "review", "previews", "re_run", "kit:recap"], (name) => name, "re");
    expect(found.map((match) => [match.item, match.marks])).toEqual([
      ["re_run", [[0, 2]]],
      ["review", [[0, 2]]],
      ["code-review", [[5, 7]]],
      ["kit:recap", [[4, 6]]],
    ]);
  });

  it("ignores case, keeps an order the owner gives, and leaves all for nothing typed", () => {
    expect(rank(["Beta", "alpha"], (name) => name, "B").map((match) => match.item)).toEqual(["Beta"]);
    const ordered = rank(["b", "a", "c"], (name) => name, "", (x, y) => (x === "c" ? -1 : y === "c" ? 1 : 0));
    expect(ordered.map((match) => [match.item, match.marks])).toEqual([
      ["c", []],
      ["a", []],
      ["b", []],
    ]);
  });

  it("cuts a name where its marks begin and end", () => {
    expect(pieces("code-review", [[5, 7]])).toEqual([
      { text: "code-", hit: false },
      { text: "re", hit: true },
      { text: "view", hit: false },
    ]);
    expect(pieces("run", [])).toEqual([{ text: "run", hit: false }]);
    expect(pieces("run", [[0, 3]])).toEqual([{ text: "run", hit: true }]);
  });
});

describe("slash commands", () => {
  it("start only at the very beginning of a message, and end at the first space", () => {
    expect(slashWord("/", 1)).toEqual({ query: "", end: 1 });
    expect(slashWord("/re", 3)).toEqual({ query: "re", end: 3 });
    expect(slashWord("/review the PR", 4)).toEqual({ query: "rev", end: 7 });
    expect(slashWord("/review ", 8)).toBeNull();
    expect(slashWord("/review", 0)).toBeNull();
    expect(slashWord(" /review", 2)).toBeNull();
    expect(slashWord("see /review", 11)).toBeNull();
    expect(slashWord("a/b", 3)).toBeNull();
  });

  it("list commands, then skills, the agent's own first among those as good", () => {
    expect(names(slashGroups(COMMANDS, ""))).toEqual([
      ["Commands", ["compact", "review", "security-review", "release"]],
      ["Skills", ["code-review", "kit:deploy", "run"]],
    ]);
    expect(names(slashGroups(COMMANDS, "re"))).toEqual([
      ["Commands", ["review", "release", "security-review"]],
      ["Skills", ["code-review"]],
    ]);
    expect(names(slashGroups(COMMANDS, "dep"))).toEqual([["Skills", ["kit:deploy"]]]);
    expect(slashGroups(COMMANDS, "zzz")).toEqual([]);
  });

  it("complete the word being typed, keeping what follows it", () => {
    expect(complete("/re", { query: "re", end: 3 }, "review")).toEqual({ text: "/review ", caret: 8 });
    expect(complete("/rev the PR", { query: "rev", end: 4 }, "review")).toEqual({
      text: "/review the PR",
      caret: 8,
    });
  });

  it("say which command a message names, and the words after it", () => {
    expect(named("/compact", COMMANDS)).toMatchObject({ command: { name: "compact" }, rest: "" });
    expect(named("  /compact keep the API\nnotes ", COMMANDS)).toMatchObject({
      command: { name: "compact" },
      rest: "keep the API\nnotes",
    });
    expect(named("/compacted", COMMANDS)).toBeNull();
    expect(named("compact", COMMANDS)).toBeNull();
  });

  it("show a command's hint while nothing is typed after it", () => {
    expect(waitingHint("/review ", COMMANDS)).toBe("[pr]");
    expect(waitingHint("/review 1", COMMANDS)).toBeNull();
    expect(waitingHint("/review", COMMANDS)).toBeNull();
    expect(waitingHint("/security-review ", COMMANDS)).toBeNull();
    expect(waitingHint("/nothing ", COMMANDS)).toBeNull();
  });

  it("say where one comes from", () => {
    expect(sourceOf(COMMANDS[0])).toBe("built in");
    expect(sourceOf(COMMANDS[2])).toBe("project");
    expect(sourceOf(command("x", { builtin: false }))).toBe("");
  });
});
