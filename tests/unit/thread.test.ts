import { describe, expect, it } from "vitest";
import { Conversation, type Part, type TextPart, type ToolCall } from "$lib/conversation.svelte";
import type { IntegratedEventBody, PermissionOffer } from "$lib/core";
import {
  asks,
  choiceLabel,
  choiceMeans,
  inputPath,
  mcpName,
  revealed,
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
        call({ tool: "other", name: "TodoWrite" }),
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
    expect(stepTitle(call({ done: false }))).toEqual({ verb: "Running", object: "npm test" });
    expect(stepTitle(call())).toEqual({ verb: "Ran", object: "npm test" });
    expect(stepTitle(call({ input: { command: "a\nb" } })).object).toBe("a …");
    expect(stepTitle(call({ tool: "read", name: "Read", input: { file_path: "/repo/src/a.ts" } }), "/repo")).toEqual({
      verb: "Read",
      object: "src/a.ts",
    });
    expect(stepTitle(call({ tool: "edit", name: "Write", input: { file_path: "/x/y" } })).verb).toBe("Wrote");
    expect(stepTitle(call({ tool: "search", name: "Grep", input: { pattern: "foo" } }))).toEqual({
      verb: "Searched for",
      object: "foo",
    });
    expect(stepTitle(call({ tool: "web", name: "WebFetch", input: { url: "https://a.b" } })).verb).toBe("Fetched");
    expect(stepTitle(call({ tool: "web", name: "WebSearch", input: { query: "q" } })).verb).toBe(
      "Searched the web for",
    );
    expect(stepTitle(call({ tool: "agent", name: "Task", input: { description: "Explore" } }))).toEqual({
      verb: "A subagent worked on",
      object: "Explore",
    });
    expect(stepTitle(call({ tool: "mcp", name: "mcp__github__list_issues" }))).toEqual({
      verb: "Used github's",
      object: "list_issues",
    });
    expect(stepTitle(call({ tool: "other", name: "TodoWrite" })).verb).toBe("Updated the plan");
    expect(stepTitle(call({ tool: "other", name: "Skill" }))).toEqual({ verb: "Used", object: "Skill" });
  });

  it("reads what has come of an input that is still streaming", () => {
    expect(
      stepTitle(
        call({ done: false, inputDone: false, input: null, inputText: '{"command":"cargo te' }),
      ),
    ).toEqual({ verb: "Running", object: null });
    expect(
      stepTitle(
        call({ done: false, inputDone: false, input: null, inputText: '{"command":"cargo test","timeout":' }),
      ),
    ).toEqual({ verb: "Running", object: "cargo test" });
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
    expect(speaker(c, null)).toBe("Claude");
    expect(speaker(c, "default")).toBe("Claude");
    expect(speaker(c, "opus")).toBe("Opus");
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
    expect(speaker(c, "sonnet")).toBe("Sonnet 5.5");
  });
});

describe("the sessions a run started", () => {
  it("are read off what the workbench's start answered", () => {
    expect(
      startedIds([
        call({ tool: "mcp", name: "mcp__agent-workbench__start", result: "Started session abc-1 in demo. It has the prompt." }),
        call({ tool: "mcp", name: "mcp__agent-workbench__start", error: true, result: "Started session no in x. " }),
        call({ tool: "mcp", name: "mcp__other__start", result: "Started session other in x. " }),
        call({ tool: "mcp", name: "mcp__agent-workbench__start", done: false }),
      ]),
    ).toEqual(["abc-1"]);
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

  it("says what the agent asks to do, and to what", () => {
    expect(asks(asked("Bash", { command: "cargo test" }))).toEqual({ verb: "run", object: "cargo test" });
    expect(asks(asked("Edit", { file_path: "/a" }))).toEqual({ verb: "edit", object: "/a" });
    expect(asks(asked("Write", {}, "/b"))).toEqual({ verb: "write", object: "/b" });
    expect(asks(asked("WebFetch", { url: "https://x" }))).toEqual({ verb: "fetch", object: "https://x" });
    expect(asks(asked("ExitPlanMode", {}))).toEqual({ verb: "go ahead with the plan", object: null });
    expect(asks(asked("mcp__github__merge", {}))).toEqual({ verb: "use github's", object: "merge" });
    expect(asks(asked("Skill", {}))).toEqual({ verb: "use", object: "Skill" });
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

  it("leaves line breaks, tabs and ordinary text alone", () => {
    expect(revealed("a\tb\nc ü 日本")).toEqual([{ text: "a\tb\nc ü 日本", unseen: false }]);
    expect(revealed("")).toEqual([{ text: "", unseen: false }]);
  });
});
