import { describe, expect, it } from "vitest";
import { Conversation, type Part, type TextPart, type ToolCall } from "$lib/conversation.svelte";
import type { IntegratedEventBody, PermissionOffer } from "$lib/core";
import {
  asks,
  choiceLabel,
  choiceMeans,
  inputPath,
  mcpName,
  requestPaths,
  revealed,
  place,
  phraseText,
  nowDoing,
  runningCall,
  segments,
  shortPath,
  span,
  speaker,
  startedIds,
  stepTitle,
  tokens,
  workSummary,
} from "$lib/thread";

function call(over: Partial<ToolCall> = {}): ToolCall {
  return {
    kind: "tool",
    call: `c${Math.random()}`,
    parent: null,
    name: "Bash",
    tool: "command",
    input: { command: "npm test" },
    inputText: "",
    inputDone: true,
    inputTruncated: false,
    output: "",
    gap: false,
    done: true,
    error: false,
    result: "",
    truncated: false,
    changes: [],
    parts: [],
    tasks: [],
    answer: null,
    withdrawn: false,
    plan: false,
    at: 0,
    until: 1000,
    ...over,
  };
}

function text(over: Partial<TextPart> = {}): TextPart {
  return {
    kind: "text",
    block: `b${Math.random()}`,
    text: "hello",
    done: true,
    gap: false,
    at: 0,
    until: 0,
    ...over,
  };
}

const change = (path: string) => ({
  path,
  kind: "update" as const,
  to: null,
  hunks: [],
  content: null,
  truncated: false,
});

describe("how a run is drawn", () => {
  it("folds each stretch of work between two things said into one", () => {
    const parts: Part[] = [
      call({ call: "1" }),
      text({ kind: "thinking", block: "t" }),
      text({ block: "a" }),
      call({ call: "2" }),
      text({ block: "b" }),
    ];
    expect(segments(parts).map((segment) => [segment.kind, segment.kind === "work" ? segment.parts.length : 1])).toEqual([
      ["work", 2],
      ["text", 1],
      ["work", 1],
      ["text", 1],
    ]);
  });

  it("keeps an open question out of the thread, for the dock, and a settled one in", () => {
    const question = (outcome: "open" | "answered") => ({
      kind: "question" as const,
      request: outcome,
      questions: [],
      answers: null,
      outcome,
      at: 0,
      until: 0,
    });
    expect(segments([question("open")])).toEqual([]);
    expect(segments([question("answered")]).map((segment) => segment.kind)).toEqual(["question"]);
  });
});

describe("the line a stretch of work folds into", () => {
  it("says how long it took and what came of it", () => {
    const summary = workSummary(
      [
        call({ tool: "read", name: "Read", at: 0, until: 2000 }),
        call({ tool: "read", name: "Read" }),
        call({ tool: "search", name: "Grep" }),
        call({ tool: "edit", name: "Edit", changes: [change("/a"), change("/b")] }),
        call({ tool: "edit", name: "Write", input: { file_path: "/a" } }),
        call({ tool: "command" }),
        call({ tool: "command", error: true }),
        call({ tool: "agent", name: "Task" }),
        call({ tool: "web", name: "WebFetch" }),
        call({ tool: "mcp", name: "mcp__agent-workbench__start", result: "Started session s-1 in x." }),
        call({ tool: "mcp", name: "mcp__github__issues" }),
        call({ tool: "other", name: "TodoWrite", plan: true }),
      ],
      0,
    );
    expect(summary).toEqual({
      running: false,
      head: "Worked for 2s",
      detail:
        "changed 2 files, ran 2 commands, read 2 files, searched once, looked on the web once, started 1 subagent, started 1 session, used 1 tool, 1 failed",
    });
  });

  it("counts the time so far while the work goes on", () => {
    expect(workSummary([call({ at: 1000, done: false })], 181_000)).toMatchObject({
      running: true,
      head: "Working for 3m",
    });
  });

  it("says a stretch of thinking alone is thought", () => {
    expect(workSummary([text({ kind: "thinking", at: 0, until: 5000 })], 0).head).toBe("Thought for 5s");
    expect(workSummary([text({ kind: "thinking", done: false })], 0).head).toBe("Thinking");
  });

  it("does not count a call the user denied as failed", () => {
    expect(
      workSummary([call({ error: true, answer: { choice: "deny", message: null } })], 0).detail,
    ).toBe("ran 1 command");
  });
});

describe("a span of time", () => {
  it("is said in the largest unit that reads", () => {
    expect(span(0)).toBe("1s");
    expect(span(12_400)).toBe("12s");
    expect(span(3 * 60_000 + 10_000)).toBe("3m");
    expect(span(65 * 60_000)).toBe("1h 5m");
    expect(span(120 * 60_000)).toBe("2h");
  });
});

describe("a step's title", () => {
  it("says what it does while it runs and what it did once done", () => {
    expect(stepTitle(call({ done: false }))).toEqual({ lead: ["Running"], object: "npm test" });
    expect(stepTitle(call())).toEqual({ lead: ["Ran"], object: "npm test" });
    expect(stepTitle(call({ input: { command: "a\nb" } })).object).toBe("a …");
    expect(stepTitle(call({ tool: "read", name: "Read", input: { file_path: "/repo/src/a.ts" } }), "/repo")).toEqual({
      lead: ["Read"],
      object: "src/a.ts",
    });
    expect(stepTitle(call({ tool: "edit", name: "anything", input: { file_path: "/x/y", content: "z" } })).lead).toEqual(["Wrote"]);
    expect(
      stepTitle(call({ tool: "edit", name: "anything", input: { file_path: "/x/y" }, changes: [{ path: "/x/y", kind: "create", to: null, hunks: [], content: "z", truncated: false }] })).lead,
    ).toEqual(["Wrote"]);
    expect(stepTitle(call({ tool: "edit", name: "Write", input: { file_path: "/x/y" } })).lead).toEqual(["Edited"]);
    expect(stepTitle(call({ tool: "search", name: "Grep", input: { pattern: "foo" } }))).toEqual({
      lead: ["Searched for"],
      object: "foo",
    });
    expect(stepTitle(call({ tool: "web", name: "WebFetch", input: { url: "https://a.b" } })).lead).toEqual(["Fetched"]);
    expect(stepTitle(call({ tool: "web", name: "WebSearch", input: { query: "q" } })).lead).toEqual(["Searched the web for"]);
    expect(stepTitle(call({ tool: "agent", name: "Task", input: { description: "Explore" } }))).toEqual({
      lead: ["A subagent worked on"],
      object: "Explore",
    });
    expect(stepTitle(call({ tool: "mcp", name: "mcp__github__list_issues" }))).toEqual({
      lead: ["Used ", { name: "github" }, "'s"],
      object: "list_issues",
    });
    expect(stepTitle(call({ tool: "other", name: "anything", plan: true })).lead).toEqual(["Updated the plan"]);
    expect(stepTitle(call({ tool: "other", name: "TodoWrite" })).lead).toEqual(["Used"]);
    expect(stepTitle(call({ tool: "other", name: "Skill" }))).toEqual({ lead: ["Used"], object: "Skill" });
  });

  it("reads what has come of an input that is still streaming", () => {
    expect(
      stepTitle(
        call({ done: false, inputDone: false, input: null, inputText: '{"command":"cargo te' }),
      ),
    ).toEqual({ lead: ["Running"], object: null });
    expect(
      stepTitle(
        call({ done: false, inputDone: false, input: null, inputText: '{"command":"cargo test","timeout":' }),
      ),
    ).toEqual({ lead: ["Running"], object: "cargo test" });
  });
});

describe("what the agent is doing now", () => {
  const conversation = () => {
    const c = new Conversation(() => 0);
    c.apply({ type: "turnStarted", messages: [] });
    return c;
  };

  it("names the call that runs, a subagent's own first", () => {
    const parts: Part[] = [
      call({ done: false, tool: "agent", name: "Task", parts: [call({ done: false, tool: "read", name: "Read", input: { file_path: "/a/b" } })] }),
    ];
    expect(runningCall(parts)?.name).toBe("Read");
    expect(nowDoing(conversation(), parts)).toBe("Reading /a/b");
  });

  it("is thinking, working, or nothing to say while text streams", () => {
    expect(nowDoing(conversation(), [text({ kind: "thinking", done: false })])).toBe("Thinking");
    expect(nowDoing(conversation(), [text({ done: false })])).toBeNull();
    expect(nowDoing(conversation(), [text()])).toBe("Working");
  });

  it("waits for an answer, stops, compacts and retries, in that order", () => {
    const c = conversation();
    c.apply({ type: "retrying", message: "overloaded", attempt: 2, attempts: 5 });
    expect(nowDoing(c, [])).toBe("Retrying after an error, attempt 2 of 5: overloaded");
    c.apply({ type: "compacting" });
    expect(nowDoing(c, [])).toBe("Compacting the conversation");
    c.interrupting = true;
    expect(nowDoing(c, [])).toBe("Stopping");
    c.apply({
      type: "questionAsked",
      request: "q",
      call: null,
      parent: null,
      questions: [],
    });
    expect(nowDoing(c, [])).toBe("Waiting for your answer");
  });

  it("waits on subagents that will report once no turn runs", () => {
    const c = new Conversation(() => 0);
    c.apply({ type: "taskStarted", task: "t", call: null, kind: "agent", description: null, prompt: null, background: true, ambient: false });
    c.apply({ type: "state", state: "working" });
    expect(nowDoing(c, [])).toBe("Waiting on 1 subagent to report");
  });
});

describe("whose run it is", () => {
  it("is the model's name, or the agent's own where the model is its default", () => {
    const c = new Conversation(() => 0);
    expect(speaker(c, null, "Claude")).toBe("Claude");
    expect(speaker(c, "default", "Claude")).toBe("Claude");
    expect(speaker(c, "opus", "Claude")).toBe("opus");
    c.apply({
      type: "ready",
      sessionId: "s",
      model: null,
      mode: null,
      effort: null,
      version: null,
      models: [{ value: "sonnet", name: "Sonnet 5.5 (fast)", description: null, efforts: [] }],
      modes: [],
      efforts: [],
      commands: [],
    });
    expect(speaker(c, "sonnet", "Claude")).toBe("Sonnet 5.5");
    expect(speaker(c, "claude-sonnet-5-5", "Claude")).toBe("Sonnet 5.5");
    expect(speaker(c, "claude-unknown-9", "Claude")).toBe("claude-unknown-9");
  });
});

describe("the sessions a run started", () => {
  it("are read off what the workbench's start answered", () => {
    expect(
      startedIds([
        call({ tool: "mcp", name: "mcp__agent-workbench__start", result: "Started session abc-1 in demo. It has the prompt." }),
        call({ tool: "mcp", name: "agent-workbench/start", result: "Started session abc-2 in demo. It has the prompt." }),
        call({ tool: "mcp", name: "mcp__agent-workbench__start", error: true, result: "Started session no in x. " }),
        call({ tool: "command", name: "Bash", result: "Started session not-a-start in x. " }),
        call({ tool: "mcp", name: "mcp__agent-workbench__start", done: false }),
      ]),
    ).toEqual(["abc-1", "abc-2"]);
  });
});

describe("a permission request, in words", () => {
  const asked = (tool: string, input: unknown, path: string | null = null) =>
    ({
      type: "permissionAsked",
      request: "r",
      call: null,
      parent: null,
      tool,
      input,
      truncated: false,
      description: null,
      path,
      choices: [],
    }) as Extract<IntegratedEventBody, { type: "permissionAsked" }>;

  it("says what the agent asks to do, and to what, by the call's kind and the shape of its input", () => {
    const command = call({ tool: "command" });
    expect(asks(asked("Bash", { command: "cargo test" }), command)).toEqual({ lead: ["run"], object: "cargo test", shape: "command" });
    expect(asks(asked("commandExecution", { command: "/bin/zsh -lc 'touch made.txt'", cwd: "/r" }), command)).toEqual({
      lead: ["run"],
      object: "/bin/zsh -lc 'touch made.txt'",
      shape: "command",
    });
    expect(asks(asked("Edit", { file_path: "/a", old_string: "x", new_string: "y" }))).toEqual({ lead: ["edit"], object: "/a", shape: "path" });
    expect(asks(asked("Write", { file_path: "/b", content: "x" }))).toEqual({ lead: ["write"], object: "/b", shape: "path" });
    expect(
      asks(asked("fileChange", { changes: [{ path: "/r/a.ts", diff: "" }, { path: "/r/b.ts", diff: "" }] }, "/r"), call({ tool: "edit", name: "fileChange" })),
    ).toEqual({ lead: ["edit"], object: "/r/a.ts and 1 more", shape: "path" });
    expect(asks(asked("anything", { file_path: "/c" }), call({ tool: "read", name: "anything" }))).toEqual({ lead: ["read"], object: "/c", shape: "path" });
    expect(asks(asked("WebFetch", { url: "https://x" }))).toEqual({ lead: ["fetch"], object: "https://x", shape: "name" });
    expect(asks(asked("webSearch", { query: "q" }), call({ tool: "web", name: "webSearch" }))).toEqual({
      lead: ["search the web for"],
      object: "q",
      shape: "name",
    });
    expect(asks(asked("anything", { plan: "1. do it" }), call({ plan: true }))).toEqual({ lead: ["go ahead with the plan"], object: null, shape: null });
    expect(asks(asked("ExitPlanMode", { plan: "x" }))).toEqual({ lead: ["use"], object: "ExitPlanMode", shape: "name" });
    expect(asks(asked("mcp__github__merge", {}))).toEqual({ lead: ["use ", { name: "github" }, "'s"], object: "merge", shape: "name" });
    expect(asks(asked("permissions", { network: true }))).toEqual({ lead: ["use"], object: "permissions", shape: "name" });
  });

  it("names each choice and what it remembers", () => {
    const offer = (choice: PermissionOffer["choice"], remembers: string | null = null, message = false) => ({
      choice,
      remembers,
      message,
    });
    expect(choiceLabel(offer("allow"))).toBe("Allow once");
    expect(choiceLabel(offer("allowSession"))).toBe("Allow for this session");
    expect(choiceLabel(offer("allowAlways"))).toBe("Always allow");
    expect(choiceLabel(offer("deny"))).toBe("Deny");
    expect(choiceLabel(offer("cancel"))).toBe("Deny and stop");
    expect(choiceMeans(offer("allow"))).toBe("Allows this call and remembers nothing.");
    expect(choiceMeans(offer("allowAlways", "Bash(ls) in this project's uncommitted local settings"))).toBe(
      "Allows this call and remembers Bash(ls) in this project's uncommitted local settings.",
    );
    expect(choiceMeans(offer("deny", null, true))).toContain("You can tell the agent why");
    expect(choiceMeans(offer("cancel"))).toBe("Refuses this call and stops the turn.");
  });
});

describe("small words", () => {
  it("reads paths, names and counts", () => {
    expect(inputPath({ notebook_path: "/n" })).toBe("/n");
    expect(inputPath("x")).toBeNull();
    expect(shortPath("/a/b/c/d/e")).toBe("…/c/d/e");
    expect(shortPath("/r/x/y", "/r")).toBe("x/y");
    expect(mcpName("mcp__a__b__c")).toEqual({ server: "a", tool: "b__c" });
    expect(mcpName("Bash")).toBeNull();
    expect(tokens(812)).toBe("812");
    expect(tokens(12_400)).toBe("12k");
    expect(tokens(1_000_000)).toBe("1M");
    expect(tokens(1_250_000)).toBe("1.3M");
  });
});

describe("text the agent chose, as it reads", () => {
  it("shows every character that would change how it reads without being seen", () => {
    expect(revealed("echo safe \u202efr- mr\u202c && ls")).toEqual([
      { text: "echo safe ", unseen: false },
      { text: "⟨U+202E⟩", unseen: true },
      { text: "fr- mr", unseen: false },
      { text: "⟨U+202C⟩", unseen: true },
      { text: " && ls", unseen: false },
    ]);
    const all = "\u0000\u001b\u007f\u0085\u061c\u200b\u200d\u200f\u2028\u202a\u2066\u2069\u2060\ufeff";
    expect(revealed(all).every((part) => part.unseen)).toBe(true);
    expect(revealed(all)).toHaveLength(14);
  });

  it("takes the hidden characters from Unicode's own categories", () => {
    const unseen = (text: string) => revealed(text).filter((part) => part.unseen).map((part) => part.text);
    // Tag characters after ls, which read as plain ls.
    expect(unseen("ls\u{E0020}\u{E0072}\u{E006D}\u{E007F}")).toEqual(["⟨U+E0020⟩", "⟨U+E0072⟩", "⟨U+E006D⟩", "⟨U+E007F⟩"]);
    // A soft hyphen in curl.
    expect(unseen("c\u00adurl")).toEqual(["⟨U+00AD⟩"]);
    // Variation selectors, and the Hangul fillers.
    expect(unseen("a\ufe0fb\ufe00\u{E0100}")).toEqual(["⟨U+FE0F⟩", "⟨U+FE00⟩", "⟨U+E0100⟩"]);
    expect(unseen("\u115f\u1160\u3164\uffa0")).toEqual(["⟨U+115F⟩", "⟨U+1160⟩", "⟨U+3164⟩", "⟨U+FFA0⟩"]);
    // The combining grapheme joiner, Mongolian vowel separator, and the
    // line and paragraph separators.
    expect(unseen("\u034f\u180e\u2028\u2029")).toHaveLength(4);
  });

  it("leaves line breaks, tabs and ordinary text alone", () => {
    expect(revealed("a\tb\nc ü 日本")).toEqual([{ text: "a\tb\nc ü 日本", unseen: false }]);
    expect(revealed("")).toEqual([{ text: "", unseen: false }]);
  });
});

describe("a Codex-shaped call", () => {
  it("is titled by its kind and the shape of its input", () => {
    expect(stepTitle(call({ name: "commandExecution", input: { command: "/bin/zsh -lc 'ls'", cwd: "/r" } }))).toEqual({
      lead: ["Ran"],
      object: "/bin/zsh -lc 'ls'",
    });
    expect(
      stepTitle(
        call({ tool: "edit", name: "fileChange", input: { changes: [{ path: "/r/a.ts" }, { path: "/r/b.ts" }] }, changes: [] }),
        "/r",
      ),
    ).toEqual({ lead: ["Edited"], object: "a.ts and 1 more" });
    expect(stepTitle(call({ tool: "agent", name: "spawnAgent", input: { prompt: "Look at the scan\nthen report" } }))).toEqual({
      lead: ["A subagent worked on"],
      object: "Look at the scan …",
    });
    expect(stepTitle(call({ tool: "read", name: "imageView", input: { path: "/r/shot.png" } }), "/r")).toEqual({
      lead: ["Read"],
      object: "shot.png",
    });
    expect(stepTitle(call({ tool: "web", name: "webSearch", input: { query: null } }))).toEqual({ lead: ["Used"], object: "webSearch" });
  });

  it("speaks under the agent's own name on its default model", () => {
    const c = new Conversation(() => 0);
    expect(speaker(c, null, "Codex")).toBe("Codex");
    expect(speaker(c, "gpt-5-codex", "Codex")).toBe("gpt-5-codex");
  });
});

describe("a permission request that could be read as something else", () => {
  const asked = (tool: string, input: unknown, path: string | null = null) =>
    ({
      type: "permissionAsked",
      request: "r",
      call: null,
      parent: null,
      tool,
      input,
      truncated: false,
      description: null,
      path,
      choices: [],
    }) as Extract<IntegratedEventBody, { type: "permissionAsked" }>;

  it("names a tool of an MCP server as one, whatever its input holds", () => {
    expect(asks(asked("mcp__deploy__run", { command: "ls" }))).toEqual({ lead: ["use ", { name: "deploy" }, "'s"], object: "run", shape: "name" });
  });

  it("says run only for a call known to run a command, and names the tool of one whose kind is not known", () => {
    // The reviewer's case: no call id, so no kind, and a tool that is not a
    // command carrying a command field.
    expect(asks(asked("DeleteRepository", { command: "ls" }))).toEqual({
      lead: ["use ", { name: "DeleteRepository" }, " to run"],
      object: "ls",
      shape: "command",
    });
    expect(asks(asked("Edit", { command: "ls", file_path: "/r/a" }), call({ tool: "edit", name: "Edit" }))).toEqual({
      lead: ["edit"],
      object: "/r/a",
      shape: "path",
    });
    expect(asks(asked("Thing", { command: "ls" }), call({ tool: "other", name: "Thing" }))).toEqual({
      lead: ["use"],
      object: "Thing",
      shape: "name",
    });
    expect(asks(asked("Bash", { command: "ls" }), call({ tool: "command" })).lead).toEqual(["run"]);
  });

  it("names every path it touches, each change's and a place the core says", () => {
    expect(
      requestPaths(
        asked("fileChange", { changes: [{ path: "/r/a.ts" }, { path: "/etc/hosts", move_path: "/tmp/x" }] }, "/r"),
      ),
    ).toEqual(["/r/a.ts", "/etc/hosts", "/tmp/x", "/r"]);
    expect(requestPaths(asked("commandExecution", { command: "curl x" }, "example.com"))).toEqual([]);
    // The folder a command runs in is one of the paths it touches.
    expect(requestPaths(asked("commandExecution", { command: "ls", cwd: "/" }))).toEqual(["/"]);
  });
});

describe("where a path lies", () => {
  const ROOT = "/home/ada/src/demo";
  it("is inside only when it plainly resolves into the project", () => {
    expect(place(`${ROOT}/src/a.ts`, ROOT)).toEqual({ text: "src/a.ts", where: "inside" });
    expect(place("src/a.ts", ROOT)).toEqual({ text: "src/a.ts", where: "inside" });
    expect(place(`${ROOT}/src/../b.ts`, ROOT)).toEqual({ text: `${ROOT}/src/../b.ts`, where: "inside" });
    expect(place(ROOT, ROOT).where).toBe("inside");
  });

  it("marks what climbs out, starts at a home folder, or runs elsewhere", () => {
    // The reviewer's cases.
    expect(place("~/.ssh/authorized_keys", ROOT).where).toBe("unknown");
    expect(place("../../.zshrc", ROOT)).toEqual({ text: "../../.zshrc", where: "outside" });
    expect(place("/", ROOT).where).toBe("outside");
    expect(place("a.txt", ROOT, "/")).toEqual({ text: "a.txt", where: "outside" });
    expect(place(`${ROOT}/../other/x`, ROOT).where).toBe("outside");
    expect(place(`${ROOT}-evil/x`, ROOT).where).toBe("outside");
    expect(place("$HOME/.zshrc", ROOT).where).toBe("unknown");
    expect(place("src/*.ts", ROOT).where).toBe("unknown");
    expect(place("a.txt", ROOT, "~/elsewhere").where).toBe("unknown");
    expect(place("src/a.ts", null).where).toBe("unknown");
  });
});

describe("a name an MCP server gave", () => {
  const asked = (tool: string, input: unknown) =>
    ({
      type: "permissionAsked",
      request: "r",
      call: null,
      parent: null,
      tool,
      input,
      truncated: false,
      description: null,
      path: null,
      choices: [],
    }) as Extract<IntegratedEventBody, { type: "permissionAsked" }>;

  it("stands apart from the words around it", () => {
    const server = "git\u202ebuh";
    const what = asks(asked("mcp__" + server + "__push", {}));
    expect(what.lead).toEqual(["use ", { name: server }, "'s"]);
    expect(stepTitle(call({ tool: "mcp", name: "mcp__" + server + "__push" })).lead).toEqual(["Used ", { name: server }, "'s"]);
    expect(phraseText(what)).toBe(`use ${server}'s push`);
  });
});
