import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Conversation, type Part, type TextPart, type ToolCall } from "$lib/conversation.svelte";
import type { IntegratedEventBody, PermissionOffer } from "$lib/core";
import { REPORTS_HEAD } from "$lib/instructions";
import {
  asks,
  clock,
  dayName,
  foldKey,
  held,
  locate,
  notRead,
  stamps,
  choiceLabel,
  choiceMeans,
  choiceMeansIn,
  inputPath,
  lastRun,
  mcpName,
  nameSessionsBy,
  requestPaths,
  revealed,
  place,
  phraseText,
  replyMarkdown,
  address,
  drawnPart,
  nowDoing,
  runningCall,
  segments,
  shortPath,
  span,
  speaker,
  startedIds,
  stepTitle,
  tokens,
  toHear,
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

describe("the workbench's wait and notify in a run", () => {
  const WAIT = "mcp__agent-workbench__wait";
  const NOTIFY = "mcp__agent-workbench__notify";
  const shape = (parts: Part[]) =>
    segments(parts).map((segment) =>
      segment.kind === "work" ? `work:${segment.parts.map((part) => (part.kind === "tool" ? part.name : part.kind)).join("+")}` : segment.kind,
    );
  const running = () => {
    const c = new Conversation(() => 0);
    c.apply({ type: "turnStarted", messages: [] });
    return c;
  };

  it("are not drawn, while every other call is, the workbench's others included", () => {
    expect(drawnPart(call({ name: WAIT, tool: "mcp" }))).toBe(false);
    expect(drawnPart(call({ name: NOTIFY, tool: "mcp" }))).toBe(false);
    expect(drawnPart(call({ name: "mcp__agent-workbench__note", tool: "mcp" }))).toBe(false);
    expect(drawnPart(call({ name: "mcp__agent-workbench__notes", tool: "mcp" }))).toBe(true);
    expect(drawnPart(call({ name: "mcp__agent-workbench__send", tool: "mcp" }))).toBe(true);
    expect(drawnPart(call({ name: "mcp__other__wait", tool: "mcp" }))).toBe(true);
    expect(drawnPart(call())).toBe(true);
    expect(drawnPart(text())).toBe(true);
  });

  it("leave a message followed only by them the last thing in its run, while the wait runs and after", () => {
    const answer = text({ text: "The cache races on its clock." });
    const waiting: Part[] = [answer, call({ name: WAIT, tool: "mcp", done: false })];
    expect(shape(waiting)).toEqual(["text"]);
    expect(runningCall(waiting)).toBeNull();
    // A turn that is only waiting says on what, with no step of its own.
    expect(nowDoing(running(), waiting)).toBe("Waiting on the sessions it started");
    const onOne: Part[] = [answer, call({ name: WAIT, tool: "mcp", done: false, input: { session: "s-9" } })];
    expect(nowDoing(running(), onOne)).toBe("Waiting on a session");
    // A note on the row only flashes past, and says nothing of its own.
    expect(nowDoing(running(), [answer, call({ name: NOTIFY, tool: "mcp", done: false })])).toBe("Working");
    const done: Part[] = [answer, call({ name: WAIT, tool: "mcp" }), call({ name: NOTIFY, tool: "mcp" }), call({ name: WAIT, tool: "mcp" })];
    expect(shape(done)).toEqual(["text"]);
  });

  it("do not join the work before and after a message, nor count in it", () => {
    const parts: Part[] = [
      text({ block: "a" }),
      call({ name: "Bash", call: "real" }),
      call({ name: WAIT, tool: "mcp" }),
      text({ block: "b" }),
      call({ name: WAIT, tool: "mcp", done: false }),
    ];
    expect(shape(parts)).toEqual(["text", "work:Bash", "text"]);
    const work = segments(parts)[1];
    expect(work.kind === "work" && workSummary(work.parts, 0).detail).toBe("ran 1 command");
    expect(nowDoing(running(), parts)).toBe("Waiting on the sessions it started");
  });

  it("keep a message whole across a wake that comes between two waits", () => {
    const c = new Conversation(() => 0);
    const events: IntegratedEventBody[] = [
      { type: "message", message: "m-1", state: "sent", error: null, text: "Is the cache fixed?", images: [] },
      { type: "turnStarted", messages: ["m-1"] },
      { type: "text", block: "b-1", parent: null, text: "Not yet: the review is still running.", done: true },
      { type: "toolStarted", call: "w-1", parent: null, name: WAIT, kind: "mcp" },
      { type: "toolFinished", call: "w-1", parent: null, output: "Fix the cache stopped.", error: false, truncated: false, changes: [] },
      { type: "message", message: "wake", state: "taken", error: null, text: "From the workbench: Fix the cache stopped.", images: [] },
      { type: "toolStarted", call: "w-2", parent: null, name: WAIT, kind: "mcp" },
    ];
    for (const event of events) c.apply(event);
    const runs = c.entries.filter((entry) => entry.kind === "agent");
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => (run.kind === "agent" ? shape(run.parts) : []))).toEqual([["text"], []]);
    const last = runs[1];
    expect(last.kind === "agent" && nowDoing(c, last.parts)).toBe("Waiting on the sessions it started");
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

  it("says each choice of another session's request as that session's, and whose folder keeps a rule", () => {
    const offer = (choice: PermissionOffer["choice"], remembers: string | null = null, message = false): PermissionOffer => ({
      choice,
      remembers,
      message,
    });
    const said = (made: PermissionOffer) => choiceMeansIn(made, "Fix the cache", "demo").join("");
    expect(said(offer("allow"))).toBe("Allows this call in Fix the cache and remembers nothing.");
    expect(said(offer("allowSession", "Bash(cargo test:*) for the rest of this session"))).toBe(
      "Allows this call in Fix the cache and remembers Bash(cargo test:*) for the rest of that session.",
    );
    expect(said(offer("allow", "network access for the rest of this turn"))).toBe(
      "Allows this call in Fix the cache and remembers nothing.",
    );
    expect(said(offer("allowSession", "network access for the rest of this turn"))).toBe(
      "Allows this call in Fix the cache and remembers network access for the rest of its turn.",
    );
    expect(said(offer("allowAlways", "Bash(cargo test:*) in this project's uncommitted local settings"))).toBe(
      "Allows this call in Fix the cache and remembers Bash(cargo test:*) in demo's uncommitted local settings, for every session in demo.",
    );
    // Only the end the core adds is said again, never what the agent wrote.
    expect(said(offer("allowSession", "Bash(echo this session) for the rest of this session"))).toBe(
      "Allows this call in Fix the cache and remembers Bash(echo this session) for the rest of that session.",
    );
    expect(said(offer("allowAlways", "commands that start with cargo in Codex's rules, from now on"))).toBe(
      "Allows this call in Fix the cache and remembers commands that start with cargo in Codex's rules, from now on.",
    );
    expect(said(offer("allowSession"))).toBe("Allows this call in Fix the cache and remembers it.");
    expect(said(offer("deny", null, true))).toBe("Refuses this call in Fix the cache and its turn goes on. You can tell it why.");
    expect(said(offer("cancel"))).toBe("Refuses this call and stops Fix the cache's turn.");
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

  it("says earlier messages could not be read and why, on one short line, or only that they are not shown", () => {
    expect(notRead("Codex does not have this conversation")).toBe(
      "could not be read: Codex does not have this conversation.",
    );
    expect(notRead("codex is not on your PATH.\nmore")).toBe("could not be read: codex is not on your PATH.");
    const long = notRead("x".repeat(400));
    expect(long.length).toBeLessThan(200);
    expect(long.endsWith("….")).toBe(true);
    expect(notRead(null)).toBe("are not shown here.");
    expect(notRead("  ")).toBe("are not shown here.");
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

describe("the workbench's own tools in a step's title", () => {
  const rows: Record<string, string> = { "s-1": "Fix the flake", "s-2": "Tidy the docs" };
  let watching: string[] | null = null;
  const own = (tool: string, input: unknown, over: Partial<ToolCall> = {}) =>
    phraseText(stepTitle(call({ tool: "mcp", name: `mcp__agent-workbench__${tool}`, input, ...over })));

  beforeEach(() => {
    watching = null;
    nameSessionsBy({ named: (id) => rows[id] ?? null, watching: () => watching });
  });
  afterEach(() => nameSessionsBy({ named: () => null, watching: () => null }));

  it("names a session by its row, running and done", () => {
    expect(own("wait", { session: "s-1" }, { done: false })).toBe("Waiting on “Fix the flake”");
    expect(own("wait", { session: "s-1" })).toBe("Waited on “Fix the flake”");
    expect(own("send", { session: "s-2", text: "go" }, { done: false })).toBe("Writing to “Tidy the docs”");
    expect(own("send", { session: "s-2", text: "go" })).toBe("Wrote to “Tidy the docs”");
    expect(own("read", { session: "s-1" }, { done: false })).toBe("Reading “Fix the flake”");
    expect(own("read", { session: "s-1" })).toBe("Read “Fix the flake”");
    expect(own("stop", { session: "s-1" }, { done: false })).toBe("Stopping “Fix the flake”");
    expect(own("stop", { session: "s-1" })).toBe("Stopped “Fix the flake”");
  });

  it("never shows an id no row answers to", () => {
    expect(own("wait", { session: "s-9" }, { done: false })).toBe("Waiting on a session");
    expect(own("wait", { session: "s-9" })).toBe("Waited on a session");
    expect(own("send", { session: "s-9", text: "go" })).toBe("Wrote to a session");
    expect(own("read", {}, { done: false })).toBe("Reading a session");
    expect(own("stop", { session: "s-9" }, { done: false })).toBe("Stopping a session");
  });

  it("words a wait that names no session by what it watches", () => {
    expect(own("wait", {}, { done: false })).toBe("Waiting on the sessions it started");
    watching = ["Fix the flake"];
    expect(own("wait", { seconds: 60 }, { done: false })).toBe("Waiting on “Fix the flake”");
    watching = ["a", "b", "c", "d"];
    expect(own("wait", {}, { done: false })).toBe("Waiting on 4 sessions");
    expect(own("wait", {})).toBe("Waited on the sessions it started");
  });

  it("names a start by its row once it answered, else by the name it was given", () => {
    expect(own("start", { name: "Fix the flake", prompt: "p" }, { done: false })).toBe("Starting “Fix the flake”");
    expect(own("start", { prompt: "p" }, { done: false })).toBe("Starting a session");
    expect(own("start", { name: "Given", prompt: "p" }, { result: "Started session s-2 in demo. " })).toBe("Started “Tidy the docs”");
    expect(own("start", { name: "Given", prompt: "p" }, { result: "Started session s-9 in demo. " })).toBe("Started “Given”");
    expect(own("start", { prompt: "p" })).toBe("Started a session");
    // The answer says the mode it begins in, and so does the line.
    expect(
      own(
        "start",
        { name: "Given", prompt: "p" },
        { result: "Started session s-2 in demo. It has the prompt. It begins in Plan mode. Keep calling wait." },
      ),
    ).toBe("Started “Tidy the docs” in Plan mode");
    expect(own("start", { session: "s-1" }, { done: false })).toBe("Resuming “Fix the flake”");
    expect(own("start", { session: "s-1" })).toBe("Resumed “Fix the flake”");
  });

  it("words the other tools for a person", () => {
    expect(own("sessions", {}, { done: false })).toBe("Listing the sessions it started");
    expect(own("sessions", {})).toBe("Listed the sessions it started");
    expect(own("projects", {})).toBe("Listed the open projects");
    expect(own("notify", { text: "Tests green" }, { done: false })).toBe("Leaving a note on its row: “Tests green”");
    expect(own("show", { path: "/a/b.ts" })).toBe("Showed /a/b.ts");
    expect(own("diff", { path: "/a/b.ts" }, { done: false })).toBe("Showing the changes in /a/b.ts");
    expect(own("present", { files: ["/a/one.png", "/a/two.pdf"] })).toBe("Presented /a/one.png and 1 more");
    expect(own("selection", {}, { done: false })).toBe("Looking at what you have open");
    expect(own("terminal", { command: "npm run dev" })).toBe("Opened a terminal for npm run dev");
    expect(own("browser_open", { url: "https://a.b" }, { done: false })).toBe("Opening https://a.b");
    expect(own("browser_navigate", { url: "https://a.b" })).toBe("Went to https://a.b");
    expect(own("browser_navigate", { action: "reload" }, { done: false })).toBe("Reloading the page");
    expect(own("browser_navigate", { action: "back" })).toBe("Went back a page");
    expect(own("browser_click", { ref: "e1" }, { done: false })).toBe("Clicking in the page");
    expect(own("browser_type", { ref: "e1", text: "secret" })).toBe("Typed in the page");
    expect(own("browser_snapshot", {})).toBe("Read the page");
    expect(own("browser_screenshot", {}, { done: false })).toBe("Taking a screenshot of the page");
    expect(own("browser_console", {})).toBe("Read the page's console");
    expect(own("browser_eval", { script: "1" })).toBe("Ran a script in the page");
    expect(own("browser_tabs", {})).toBe("Listed the open tabs");
    expect(own("browser_close", { tab: 1 }, { done: false })).toBe("Closing a tab");
    expect(own("settings", {})).toBe("Read the workbench's settings");
    expect(own("settings_change", {}, { done: false })).toBe("Changing the workbench's settings");
    expect(own("theme_save", { name: "dusk", label: "Dusk" })).toBe("Saved the theme “Dusk”");
    expect(own("styles_write", { css: "" })).toBe("Wrote the workbench's stylesheet");
    expect(own("git_status", {}, { done: false })).toBe("Checking the git status");
    expect(own("git_log", {})).toBe("Read the git log");
    expect(own("git_commit", { message: "fix: a" })).toBe("Committed “fix: a”");
    expect(own("todos_add", { text: "Ship" }, { done: false })).toBe("Adding a todo “Ship”");
    expect(own("todos_finish", {})).toBe("Finished a todo");
    expect(own("todos_list", {})).toBe("Listed the todos");
  });

  it("draws a name in the text's own type between quotes, and a count after the thing", () => {
    const named = stepTitle(call({ tool: "mcp", name: "mcp__agent-workbench__send", input: { session: "s-1" } }));
    expect(named).toEqual({ lead: ["Wrote to"], object: "Fix the flake", quoted: true });
    const files = stepTitle(call({ tool: "mcp", name: "mcp__agent-workbench__present", input: { files: ["/a/one.png", "/a/two.pdf", "/a/three.svg"] } }));
    expect(files).toEqual({ lead: ["Presented"], object: "/a/one.png", tail: "and 2 more" });
  });

  it("asks in the same words, as what the agent would do", () => {
    const ask = (tool: string, input: unknown) =>
      phraseText(
        asks({
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
        }),
      );
    expect(ask("mcp__agent-workbench__start", { name: "Fix the flake", prompt: "p" })).toBe("start “Fix the flake”");
    expect(ask("mcp__agent-workbench__send", { session: "s-2", text: "go" })).toBe("write to “Tidy the docs”");
    expect(ask("mcp__agent-workbench__browser_open", { url: "https://a.b/c" })).toBe("open https://a.b/c");
    expect(ask("mcp__agent-workbench__show", { path: "/a/b/c/d.ts" })).toBe("show /a/b/c/d.ts");
    expect(ask("mcp__agent-workbench__sessions", {})).toBe("list the sessions it started");
    expect(ask("mcp__claude_ai_Linear__list_issues", {})).toBe("use Linear's list_issues");
    expect(ask("mcp__agent-workbench__no_such_tool", {})).toBe("use Chord's no_such_tool");
  });

  it("leaves other servers' tools in the general wording", () => {
    expect(stepTitle(call({ tool: "mcp", name: "mcp__github__list_issues", done: false }))).toEqual({
      lead: ["Using ", { name: "github" }, "'s"],
      object: "list_issues",
    });
    expect(stepTitle(call({ tool: "mcp", name: "mcp__claude_ai_Linear__list_issues" })).lead).toEqual(["Used ", { name: "Linear" }, "'s"]);
    expect(own("no_such_tool", {})).toBe("Used Chord's no_such_tool");
  });
});

describe("an address", () => {
  it("is read after trimming, whatever its slashes, and names the host it leads to", () => {
    // The reviewer's cases.
    expect(address("https:github.com@evil.example/")).toMatchObject({ host: "evil.example" });
    expect(address(" https://github.com@evil.example/")).toMatchObject({ host: "evil.example" });
    expect(address("https://example.com/a")).toEqual({ host: "example.com", other: null, warnings: [] });
    expect(address("http://example.com:8080/x")).toEqual({ host: "example.com:8080", other: null, warnings: [] });
    expect(address("not an address")).toBeNull();
    expect(address("mailto:a@b.c")).toBeNull();
  });

  it("says what in its authority could mislead", () => {
    expect(address("https:github.com@evil.example/")!.warnings).toEqual(["it names a user before the host"]);
    expect(address("https://аpple.com/")!.warnings).toEqual(["its host mixes scripts"]);
  });

  it("names both hosts where two readers of it disagree", () => {
    // The URL standard reads the backslash as a slash and goes to
    // github.com; a client like curl takes all before the @ as a user and
    // goes to evil.example.
    expect(address("https://github.com\\@evil.example/")).toEqual({
      host: "github.com",
      other: "evil.example",
      warnings: ["it names a user before the host", "it holds a backslash"],
    });
  });
});

describe("what a read says of the messages a session was sent", () => {
  it("gives the user's own words without the workbench's note, and another session's words as sent", () => {
    const c = new Conversation(() => 0);
    const note = `${REPORTS_HEAD}\nSession sid-1 stopped working. It has left no line.`;
    c.sending("u1", `${note}\n\nHow is it going?`);
    c.sending("s1", `${note}\n\nFrom the starter`);
    c.apply({ type: "message", message: "u1", state: "queued", error: null, text: null, images: [] });
    c.apply({ type: "message", message: "s1", state: "queued", error: null, text: null, images: [] });
    const said = lastRun(c, 10, (message) => (message.id === "s1" ? "session 1" : null));
    expect(said).toContain("A message from the user waits for the turn: How is it going?");
    expect(said).toContain(`A message from session 1 waits for the turn: ${note}`);
  });
});

describe("the times a thread shows", () => {
  // Wednesday 4 March 2026, at noon where the tests run.
  const now = new Date(2026, 2, 4, 12, 0).getTime();
  const at = (day: number, hour: number) => new Date(2026, 2, day, hour, 0).getTime();
  const weekday = (time: number) => new Date(time).toLocaleDateString([], { weekday: "short" });

  it("names a day as today, by its weekday within the week, and by its date further back", () => {
    expect(dayName(at(4, 9), now)).toBe("today");
    expect(dayName(at(3, 23), now)).toBe(weekday(at(3, 23)));
    expect(dayName(at(26, 9) - 7 * 86_400_000, now)).not.toBe(weekday(at(26, 9) - 7 * 86_400_000));
    const older = new Date(2026, 1, 20, 9).getTime();
    expect(dayName(older, now)).toBe(
      new Date(older).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }),
    );
    const lastYear = new Date(2025, 11, 20, 9).getTime();
    expect(dayName(lastYear, now)).toContain("2025");
  });

  it("writes the first time of each day with the day, and none when every time is today's", () => {
    expect(stamps([{ at: at(4, 9) }, { at: at(4, 10) }], now)).toEqual([clock(at(4, 9)), clock(at(4, 10))]);
    expect(stamps([{ at: at(2, 9) }, { at: at(2, 10) }, { at: at(4, 9) }, { at: at(4, 10) }], now)).toEqual([
      `${weekday(at(2, 9))} ${clock(at(2, 9))}`,
      clock(at(2, 10)),
      `today ${clock(at(4, 9))}`,
      clock(at(4, 10)),
    ]);
  });

  it("always names the day on a time marked with it, which then names that day for the rest", () => {
    expect(stamps([{ at: at(2, 9) }, { at: at(4, 9), day: true }, { at: at(4, 10) }], now)).toEqual([
      `${weekday(at(2, 9))} ${clock(at(2, 9))}`,
      `today ${clock(at(4, 9))}`,
      clock(at(4, 10)),
    ]);
    expect(stamps([{ at: at(4, 9), day: true }, { at: at(4, 10) }], now)).toEqual([
      `today ${clock(at(4, 9))}`,
      clock(at(4, 10)),
    ]);
  });
});


describe("what the thread holds, drawn or not", () => {
  /** A turn that answers a question with a command, then a subagent that
      reads a file, then says what it found. */
  const conversation = () => {
    const c = new Conversation(() => 0);
    const events: IntegratedEventBody[] = [
      { type: "message", message: "m-1", state: "sent", error: null, text: "Where is the Counter?", images: [] },
      { type: "turnStarted", messages: ["m-1"] },
      { type: "toolStarted", call: "c-1", parent: null, name: "Bash", kind: "command" },
      { type: "toolInput", call: "c-1", parent: null, delta: null, input: { command: "grep -rn counter src" }, truncated: false },
      { type: "toolFinished", call: "c-1", parent: null, output: "src/count.ts:1", error: false, truncated: false, changes: [] },
      { type: "toolStarted", call: "c-2", parent: null, name: "Task", kind: "agent" },
      { type: "toolStarted", call: "c-3", parent: "c-2", name: "Read", kind: "read" },
      { type: "toolFinished", call: "c-3", parent: "c-2", output: "let counter = 0;", error: false, truncated: false, changes: [] },
      { type: "toolFinished", call: "c-2", parent: null, output: "done", error: false, truncated: false, changes: [] },
      { type: "text", block: "b-1", parent: null, text: "The counter is in `src/count.ts`.", done: true },
      { type: "turnEnded", outcome: "done", error: null, totalCostUsd: null, durationMs: 1000, usage: null },
    ];
    for (const event of events) c.apply(event);
    return c;
  };

  it("finds every message, block and call, with the entry it is in and the folds around it", () => {
    const c = conversation();
    const run = c.entries.find((entry) => entry.kind === "agent")!.key;
    const user = c.entries.find((entry) => entry.kind === "user")!.key;
    const work = foldKey("work", c.call("c-1")!);
    // A call is held by its row, then by what its step shows; a
    // subagent's run comes before the output of the call that started it.
    expect(held(c).map((one) => one.key)).toEqual(["m-1", "c-1", "c-1:shows", "c-2", "c-3", "c-3:shows", "c-2:shows", "b-1"]);
    expect(locate(c, "m-1")).toMatchObject({ entry: user, folds: [] });
    expect(locate(c, "b-1")).toMatchObject({ entry: run, folds: [] });
    expect(locate(c, "c-1")).toMatchObject({ entry: run, folds: [work] });
    expect(held(c).find((one) => one.key === "c-1:shows")).toMatchObject({ folds: [work, foldKey("step", c.call("c-1")!)] });
    // A subagent's call is behind the work's fold, the step of the call
    // that started it, and its own run's fold of work.
    expect(locate(c, "c-3")).toMatchObject({
      entry: run,
      folds: [work, foldKey("step", c.call("c-2")!), foldKey("work", c.call("c-3")!)],
    });
    expect(locate(c, "nothing")).toBeNull();
  });

  it("holds what each shows: a row's object, the output under it, and what the agent wrote as Markdown", () => {
    const c = conversation();
    const shows = (key: string) => held(c).find((one) => one.key === key)!;
    expect(shows("m-1")).toMatchObject({ text: "Where is the Counter?", markdown: null });
    expect(shows("c-1")).toMatchObject({ text: "grep -rn counter src" });
    // A short command is the row's whole; under it is the output.
    expect(shows("c-1:shows")).toMatchObject({ text: "src/count.ts:1" });
    expect(shows("c-3:shows")).toMatchObject({ text: "let counter = 0;" });
    expect(shows("c-2:shows")).toMatchObject({ text: "done" });
    expect(shows("b-1")).toMatchObject({ text: "", markdown: "The counter is in `src/count.ts`." });
  });

  it("holds an input as its step shows it, a change's lines and a message still waiting, and not the error said where it resumes", () => {
    const c = conversation();
    const events: IntegratedEventBody[] = [
      { type: "message", message: "m-2", state: "sent", error: null, text: "Fix the path", images: [] },
      { type: "turnStarted", messages: ["m-2"] },
      { type: "toolStarted", call: "c-4", parent: null, name: "Edit", kind: "edit" },
      {
        type: "toolInput", call: "c-4", parent: null, delta: null, truncated: false,
        input: { file_path: "C:\\repo\\src\\count.ts", old_string: 'say("hi")', new_string: 'say("bye")' },
      },
      {
        type: "toolFinished", call: "c-4", parent: null, output: "", error: false, truncated: false,
        changes: [{ path: "C:\\repo\\src\\count.ts", kind: "update", to: null, content: null, truncated: false,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-say("hi")', '+say("farewell")'] }] }],
      },
      { type: "toolStarted", call: "c-5", parent: null, name: "Grep", kind: "search" },
      { type: "toolInput", call: "c-5", parent: null, delta: null, truncated: false, input: { pattern: "say", glob: "*.ts" } },
      { type: "toolFinished", call: "c-5", parent: null, output: "", error: false, truncated: false, changes: [] },
      { type: "message", message: "m-3", state: "queued", error: null, text: "And the tests", images: [] },
    ];
    for (const event of events) c.apply(event);
    const shows = (key: string) => held(c).find((one) => one.key === key)!;
    // An edit with its changes shows them, not its input: the path and the
    // lines without their marks.
    expect(shows("c-4:shows").text).toBe('C:\\repo\\src\\count.ts\nsay("hi")\nsay("farewell")');
    // Other input shows as its fields' values, but what the row says.
    expect(shows("c-5")).toMatchObject({ text: "say" });
    expect(shows("c-5:shows")).toMatchObject({ text: "*.ts" });
    expect(locate(c, "m-3")).toMatchObject({ entry: null, folds: [] });
    // What the user told the agent when refusing a call, without its label.
    c.apply({ type: "toolStarted", call: "c-6", parent: null, name: "Bash", kind: "command" });
    c.apply({ type: "toolInput", call: "c-6", parent: null, delta: null, truncated: false, input: { command: "rm -rf build" } });
    c.apply({ type: "permissionAsked", request: "r-6", call: "c-6", parent: null, tool: "Bash", input: { command: "rm -rf build" }, truncated: false, description: null, path: null, choices: [] });
    c.apply({ type: "answered", request: "r-6", choice: "deny", answers: null, message: "Keep the build folder" });
    c.apply({ type: "toolFinished", call: "c-6", parent: null, output: "denied", error: true, truncated: false, changes: [] });
    expect(shows("c-6:shows").text).toBe("denied\nKeep the build folder");
    const over = conversation();
    over.apply({ type: "error", kind: "process", message: "the agent crashed" });
    over.apply({ type: "ended", code: 1, clean: false });
    expect(held(over).some((one) => one.text.includes("crashed"))).toBe(false);
  });

  it("shows a character that changes how text reads as its marker, as the thread draws it", () => {
    const c = new Conversation(() => 0);
    c.apply({ type: "message", message: "m-1", state: "sent", error: null, text: "a\u202eb", images: [] });
    expect(held(c)[0].text).toBe("a⟨U+202E⟩b");
  });
});

describe("a reply copied as Markdown", () => {
  const text = (block: string, said: string, kind: "text" | "thinking" = "text"): TextPart => ({
    kind,
    block,
    text: said,
    done: true,
    gap: false,
    at: 0,
    until: 0,
  });

  it("is what the agent said, its text parts joined, without its thinking or its work", () => {
    const tool = { kind: "tool", call: "c1", tool: "command" } as unknown as ToolCall;
    const parts: Part[] = [
      text("a", "\n\nThe cache lives in memory.\n"),
      text("b", "I should check the version.", "thinking"),
      tool,
      text("c", "    indented code\n\nDone.  \n"),
    ];
    expect(replyMarkdown(parts)).toBe("The cache lives in memory.\n\n    indented code\n\nDone.");
  });

  it("is empty for a run that only worked", () => {
    expect(replyMarkdown([text("a", "", "text"), text("b", "hmm", "thinking")])).toBe("");
  });
});

describe("what a screen reader hears of what comes", () => {
  /** A turn read from before, of a message and a reply in `blocks` blocks. */
  const before = (at: number, id: string, blocks: number) => [
    { at, event: { type: "message", message: id, state: "sent", error: null, text: `Asked ${id}`, images: [] } },
    { at, event: { type: "turnStarted", messages: [id] } },
    ...Array.from({ length: blocks }, (_, block) => ({
      at,
      event: { type: "text", block: `${id}-${block}`, parent: null, text: `**Reply** ${id} ${block}`, done: true },
    })),
    { at, event: { type: "turnEnded", outcome: "done", error: null, totalCostUsd: null, durationMs: 10, usage: null } },
  ] as { at: number; event: IntegratedEventBody }[];

  it("makes words of each new block once, and never of what was read from before", () => {
    let now = 1_000;
    const c = new Conversation(() => now);
    c.lay({ items: [...before(100, "m1", 6), ...before(200, "m2", 6)], cut: false }, null);
    const told = new Set<string>();
    let made = 0;
    const words = {
      message: (message: { text: string }) => message.text,
      block: (markdown: string) => {
        made += 1;
        return markdown.replace(/\*\*/g, "");
      },
    };
    // A thread opened on what was read hears none of it, at no cost, as
    // often as it asks.
    for (let asked = 0; asked < 5; asked++) expect(toHear(c, told, 500, words)).toEqual([]);
    expect(made).toBe(0);
    // What comes is heard once each, a block once it is whole.
    now = 2_000;
    c.apply({ type: "turnStarted", messages: [] });
    c.apply({ type: "text", block: "live", parent: null, text: "Half", done: false });
    expect(toHear(c, told, 500, words)).toEqual([]);
    c.apply({ type: "text", block: "live", parent: null, text: "**Whole** now", done: true });
    expect(toHear(c, told, 500, words)).toEqual(["Whole now"]);
    for (let asked = 0; asked < 5; asked++) expect(toHear(c, told, 500, words)).toEqual([]);
    expect(made).toBe(1);
    c.apply({ type: "toolStarted", call: "c1", parent: null, name: "Bash", kind: "command" });
    c.apply({ type: "text", block: "after", parent: null, text: "And then", done: true });
    expect(toHear(c, told, 500, words)).toEqual(["And then"]);
    expect(made).toBe(2);
  });
});
