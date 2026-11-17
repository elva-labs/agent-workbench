import { afterEach, describe, expect, it, vi } from "vitest";
import { isUntrusted, type IntegratedEvent } from "$lib/core";
import { fakeIntegrated } from "../fakeIntegrated";

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const M3 = "33333333-3333-4333-8333-333333333333";

const invoke = vi.fn();
const listen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listen(...args),
}));

/** The real seam, talking to Tauri, which is mocked. */
async function tauri() {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  const { core } = await import("$lib/core");
  return core();
}

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  invoke.mockReset();
  listen.mockReset();
});

describe("the seam's integrated sessions", () => {
  it("call the core's commands by the names and arguments it takes", async () => {
    const seam = await tauri();
    invoke.mockResolvedValue(null);
    await seam.integratedStart({
      agent: "claude-code",
      project: "/repo",
      model: "haiku",
      mode: "plan",
      effort: "high",
      configDir: "~/.claude-work",
    });
    await seam.integratedTrust({ agent: "claude-code", project: "/repo", cwd: "/repo/wt" });
    await seam.integratedSend("int-1", M1, "look", [{ mediaType: "image/png", data: "AAAA" }]);
    await seam.integratedSend("int-1", M2, "again");
    await seam.integratedInterrupt("int-1");
    await seam.integratedSendNow("int-1");
    await seam.integratedWithdraw("int-1", M2);
    await seam.integratedCompact("int-1");
    await seam.integratedCompact("int-1", "keep the API notes");
    await seam.integratedAnswer("int-1", "r-1", "deny", "not that");
    await seam.integratedAnswer("int-1", "r-2", "allowSession");
    await seam.integratedReply("int-1", "q-1", [["Red"], ["my own words"]]);
    await seam.integratedReply("int-1", "q-2", null);
    await seam.integratedConfigure("int-1", { model: "sonnet" });
    await seam.integratedConfigure("int-1", { mode: "acceptEdits", effort: "low" });
    await seam.integratedSnapshot("int-1");
    await seam.integratedHistory({
      agent: "claude-code",
      project: "/repo",
      cwd: "/repo/wt",
      session: "s-1",
      configDir: "~/.claude-work",
    });
    await seam.integratedRewindPoints("int-1");
    await seam.integratedRewindPreview("int-1", M1);
    await seam.integratedRewind("int-1", M1, { conversation: true, files: false });
    await seam.integratedRewindUndo("int-2");
    await seam.integratedStop("int-1");
    expect(invoke.mock.calls).toEqual([
      [
        "integrated_start",
        {
          agent: "claude-code",
          project: "/repo",
          model: "haiku",
          mode: "plan",
          effort: "high",
          configDir: "~/.claude-work",
        },
      ],
      ["integrated_trust", { agent: "claude-code", project: "/repo", cwd: "/repo/wt" }],
      [
        "integrated_send",
        {
          id: "int-1",
          message: M1,
          text: "look",
          images: [{ mediaType: "image/png", data: "AAAA" }],
        },
      ],
      ["integrated_send", { id: "int-1", message: M2, text: "again", images: [] }],
      ["integrated_interrupt", { id: "int-1" }],
      ["integrated_send_now", { id: "int-1" }],
      ["integrated_withdraw", { id: "int-1", message: M2 }],
      ["integrated_compact", { id: "int-1", instructions: null }],
      ["integrated_compact", { id: "int-1", instructions: "keep the API notes" }],
      [
        "integrated_answer",
        { id: "int-1", request: "r-1", choice: "deny", message: "not that" },
      ],
      [
        "integrated_answer",
        { id: "int-1", request: "r-2", choice: "allowSession", message: null },
      ],
      [
        "integrated_reply",
        { id: "int-1", request: "q-1", answers: [["Red"], ["my own words"]] },
      ],
      ["integrated_reply", { id: "int-1", request: "q-2", answers: null }],
      ["integrated_configure", { id: "int-1", model: "sonnet", mode: null, effort: null }],
      [
        "integrated_configure",
        { id: "int-1", model: null, mode: "acceptEdits", effort: "low" },
      ],
      ["integrated_snapshot", { id: "int-1" }],
      [
        "integrated_history",
        {
          agent: "claude-code",
          project: "/repo",
          cwd: "/repo/wt",
          session: "s-1",
          configDir: "~/.claude-work",
        },
      ],
      ["integrated_rewind_points", { id: "int-1" }],
      ["integrated_rewind_preview", { id: "int-1", message: M1 }],
      ["integrated_rewind", { id: "int-1", message: M1, conversation: true, files: false }],
      ["integrated_rewind_undo", { id: "int-2" }],
      ["integrated_stop", { id: "int-1" }],
    ]);
  });

  it("tell a folder that is not trusted from other failures", () => {
    expect(isUntrusted("untrusted: /repo has not been trusted in claude yet")).toBe(true);
    expect(isUntrusted(new Error("untrusted: /repo"))).toBe(true);
    expect(isUntrusted("claude was not found on your PATH")).toBe(false);
  });

  it("hear every session's news on one event", async () => {
    const seam = await tauri();
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const heard: IntegratedEvent[] = [];
    const off = await seam.onIntegratedEvent((event) => heard.push(event));
    expect(listen.mock.calls[0][0]).toBe("integrated_event");
    const deliver = listen.mock.calls[0][1] as (event: { payload: IntegratedEvent }) => void;
    deliver({ payload: { id: "int-1", type: "state", state: "working" } });
    expect(heard).toEqual([{ id: "int-1", type: "state", state: "working" }]);
    off();
    expect(unlisten).toHaveBeenCalled();
  });
});

describe("the scripted integrated session", () => {
  function started() {
    const fake = fakeIntegrated();
    const heard: IntegratedEvent[] = [];
    fake.subscribe((event) => heard.push(event));
    const { id } = fake.start({ agent: "claude-code", project: "/repo", model: "haiku" });
    return { fake, heard, id };
  }

  const kinds = (events: IntegratedEvent[]) => events.map((event) => event.type);
  const states = (events: IntegratedEvent[]) =>
    events.flatMap((event) => (event.type === "state" ? [event.state] : []));
  const turns = (events: IntegratedEvent[]) =>
    events.flatMap((event) => (event.type === "turnStarted" ? [event.messages] : []));

  it("says it is ready before the caller has the id, and is idle", () => {
    const { heard, id } = started();
    expect(kinds(heard)).toEqual(["ready", "state"]);
    expect(heard[0]).toMatchObject({ id, type: "ready", model: "haiku", mode: "default" });
    expect(states(heard)).toEqual(["idle"]);
  });

  it("refuses a folder that is not trusted until it is", () => {
    const fake = fakeIntegrated();
    fake.untrusted.add("/repo");
    let error: unknown;
    try {
      fake.start({ agent: "claude-code", project: "/repo" });
    } catch (thrown) {
      error = thrown;
    }
    expect(isUntrusted(error)).toBe(true);
    fake.trust({ agent: "claude-code", project: "/repo" });
    expect(fake.start({ agent: "claude-code", project: "/repo" }).id).toBeTruthy();
  });

  it("checks a message as the core does", () => {
    const { fake, id } = started();
    expect(() => fake.send(id, "message-1", "hi")).toThrow();
    expect(() => fake.send(id, M1, "  ")).toThrow();
    fake.send(id, M1, "hi");
    expect(() => fake.send(id, M1, "again")).toThrow();
  });

  it("plays a turn for the message it was sent", () => {
    const { fake, heard, id } = started();
    fake.send(id, M1, "hello");
    fake.turn(id, "hi there", { pieces: 2 });
    expect(turns(heard)).toEqual([[M1]]);
    const texts = heard.filter((event) => event.type === "text");
    expect(texts.map((event) => event.type === "text" && event.text)).toEqual([
      "hi t",
      "here",
      "hi there",
    ]);
    expect(states(heard)).toEqual(["idle", "working", "idle"]);
  });

  it("queues messages sent during a turn, and one turn may answer them all", () => {
    const { fake, heard, id } = started();
    fake.send(id, M1, "first");
    fake.startTurn(id);
    fake.send(id, M2, "second");
    fake.send(id, M3, "third");
    expect(heard.filter((event) => event.type === "message")).toMatchObject([
      { message: M1, state: "sent", text: "first" },
      { message: M2, state: "queued", text: "second" },
      { message: M3, state: "queued", text: "third" },
    ]);
    fake.endTurn(id);
    expect(states(heard).at(-1)).toBe("working");
    fake.turn(id, "both");
    expect(turns(heard)).toEqual([[M1], [M2, M3]]);
    expect(states(heard).at(-1)).toBe("idle");
  });

  it("takes a message into the running turn, and a turn of its own names none", () => {
    const { fake, heard, id } = started();
    fake.turn(id, "on my own");
    expect(turns(heard)).toEqual([[]]);
    fake.startTurn(id, []);
    fake.send(id, M1, "and this");
    fake.startTurn(id, [M1]);
    expect(heard.at(-1)).toMatchObject({ type: "message", message: M1, state: "taken" });
    fake.endTurn(id);
    expect(states(heard).at(-1)).toBe("idle");
  });

  it("offers only the choices a request remembers, and an answer settles it", () => {
    const { fake, heard, id } = started();
    fake.send(id, M1, "touch it");
    fake.startTurn(id);
    const bare = fake.ask(id, "Bash", { command: "rm -rf build" });
    expect(() => fake.answer(id, bare, "allowSession")).toThrow();
    fake.answer(id, bare, "allow");
    const request = fake.ask(
      id,
      "Bash",
      { command: "touch x" },
      { session: "Bash(touch x) for the rest of this session", always: "Bash(touch x) here" },
    );
    expect(states(heard).at(-1)).toBe("asking");
    fake.answer(id, request, "allowAlways", "ignored");
    expect(states(heard).at(-1)).toBe("working");
    expect(fake.calls.at(-1)).toEqual({
      method: "answer",
      id,
      request,
      choice: "allowAlways",
      message: null,
    });
    expect(() => fake.answer(id, request, "allow")).toThrow();
  });

  it("asks questions apart from permissions, answered with a reply", () => {
    const { fake, heard, id } = started();
    fake.startTurn(id);
    const request = fake.question(id, [
      { header: "Colour", question: "Which?", options: [{ label: "Red", description: null }], multiple: false },
    ]);
    expect(states(heard).at(-1)).toBe("asking");
    expect(() => fake.answer(id, request, "allow")).toThrow();
    expect(() => fake.reply(id, request, [])).toThrow();
    expect(() => fake.reply(id, request, [[" "]])).toThrow();
    fake.reply(id, request, [["Teal, my own"]]);
    expect(states(heard).at(-1)).toBe("working");
  });

  it("holds in a snapshot what a window that comes late cannot read elsewhere", () => {
    const { fake, id } = started();
    fake.send(id, M1, "one");
    fake.startTurn(id);
    fake.send(id, M2, "two", [{ mediaType: "image/png", data: "AAAA" }]);
    const request = fake.ask(id, "Bash", { command: "ls" }, { path: "/repo/a" });
    const snapshot = fake.snapshot(id);
    expect(snapshot).toMatchObject({
      state: "asking",
      turn: true,
      settings: { model: "haiku", mode: "default" },
      ready: { type: "ready", sessionId: "integrated-session-1" },
      requests: [{ type: "permissionAsked", request, tool: "Bash", path: "/repo/a" }],
      messages: [
        {
          type: "message",
          message: M2,
          state: "queued",
          text: "two",
          images: [{ mediaType: "image/png", data: "AAAA" }],
        },
      ],
    });
    fake.answer(id, request, "allow");
    fake.endTurn(id);
    fake.startTurn(id);
    expect(fake.snapshot(id)).toMatchObject({ state: "working", requests: [], messages: [] });
  });

  it("tells the account's limits as the agent reports them, and the snapshot holds the last", () => {
    const { fake, heard, id } = started();
    expect(fake.snapshot(id).limits).toBeNull();
    fake.limits(id, [{ kind: "session", percent: 10, resetsAt: 1_900_000_000 }], { plan: "max", takenAt: 100 });
    fake.limits(
      id,
      [
        { kind: "session", percent: 80, severity: "warning" },
        { kind: "weeklyScoped", model: "Fable", percent: 100, severity: "reached" },
      ],
      { readAt: 100 },
    );
    const told = heard.filter((event) => event.type === "limits");
    expect(told).toEqual([
      {
        id,
        type: "limits",
        agent: "claude-code",
        plan: "max",
        windows: [{ kind: "session", model: null, percent: 10, resetsAt: 1_900_000_000, severity: null }],
        readAt: 100,
        takenAt: 100,
      },
      expect.objectContaining({ plan: null, readAt: 100 }),
    ]);
    const { id: _id, ...last } = told[1];
    expect(fake.snapshot(id).limits).toEqual(last);
    expect(fake.snapshot(id).limits?.windows[1]).toEqual({
      kind: "weeklyScoped",
      model: "Fable",
      percent: 100,
      resetsAt: null,
      severity: "reached",
    });
    expect(Math.abs((last.type === "limits" ? last.takenAt : 0) - Date.now() / 1000)).toBeLessThan(60);
    expect(states(heard)).toEqual(["idle"]);

    const codex = fake.start({ agent: "codex", project: "/repo" });
    fake.limits(codex.id, [{ kind: "weekly", percent: 3 }], { readAt: null });
    expect(fake.snapshot(codex.id).limits).toMatchObject({
      agent: "codex",
      readAt: null,
      windows: [{ kind: "weekly" }],
    });
  });

  it("tells no window a secret answer, and takes only options where it takes no words", () => {
    const { fake, heard, id } = started();
    fake.startTurn(id);
    const request = fake.question(id, [
      { header: null, question: "Password?", options: [], multiple: false, secret: true },
      {
        header: null,
        question: "Go on?",
        options: [
          { label: "yes", description: null },
          { label: "no", description: null },
        ],
        multiple: false,
        other: false,
      },
    ]);
    const asked = heard.find((event) => event.type === "questionAsked");
    expect(asked).toMatchObject({
      questions: [
        { secret: true, other: true },
        { secret: false, other: false },
      ],
    });
    expect(() => fake.reply(id, request, [["hunter2"], ["maybe"]])).toThrow(/not one of the options/);
    fake.reply(id, request, [["hunter2"], ["yes"]]);
    expect(heard.find((event) => event.type === "answered")).toMatchObject({
      answers: [null, ["yes"]],
    });
    expect(JSON.stringify(heard)).not.toContain("hunter2");
  });

  it("ends a turn after an interrupt, withdraws what it asked, and closes open calls", async () => {
    const { fake, heard, id } = started();
    fake.send(id, M1, "go");
    fake.startTurn(id);
    const call = fake.startTool(id, "Bash", { command: "sleep 9" }, { kind: "command" });
    const request = fake.ask(id, "Bash", { command: "sleep 9" }, { call });
    fake.interrupt(id);
    expect(kinds(heard).at(-1)).toBe("state");
    await Promise.resolve();
    expect(heard.slice(-5)).toMatchObject([
      { type: "withdrawn", request },
      { type: "state", state: "working" },
      { type: "toolFinished", call, error: true, output: "" },
      { type: "turnEnded", outcome: "interrupted" },
      { type: "state", state: "idle" },
    ]);
  });

  it("keeps working while a subagent runs and until its report's turn ends", () => {
    const { fake, heard, id } = started();
    fake.send(id, M1, "find it");
    fake.startTurn(id);
    const call = fake.tool(id, "Agent", { prompt: "find it" }, "launched", { kind: "agent" });
    const task = fake.task(id, call);
    const grep = fake.startTool(id, "Grep", { pattern: "x" }, { parent: call, kind: "search" });
    fake.endTurn(id);
    expect(heard.some((e) => e.type === "toolFinished" && e.call === grep)).toBe(false);
    expect(states(heard).at(-1)).toBe("working");
    fake.think(id, "hmm", { parent: call });
    fake.finishTask(id, task, "completed", "found");
    expect(heard.some((e) => e.type === "toolFinished" && e.call === grep && e.error)).toBe(true);
    expect(states(heard).at(-1)).toBe("working");
    fake.turn(id, "it found it");
    expect(turns(heard).at(-1)).toEqual([]);
    expect(states(heard).at(-1)).toBe("idle");
  });

  it("waits for no report from a task the agent lost, nor from one interrupted while idle", () => {
    const { fake, heard, id } = started();
    const lost = fake.task(id, null);
    fake.finishTask(id, lost, "lost");
    expect(states(heard).at(-1)).toBe("idle");
    const done = fake.task(id, null);
    fake.finishTask(id, done, "failed");
    expect(states(heard).at(-1)).toBe("working");
    fake.interrupt(id);
    expect(states(heard).at(-1)).toBe("idle");
  });

  it("is working while it compacts by itself", () => {
    const { fake, heard, id } = started();
    fake.compaction(id);
    expect(states(heard)).toEqual(["idle", "working", "idle"]);
    expect(heard.find((event) => event.type === "compacted")).toMatchObject({ reason: "full" });
  });

  it("compacts when asked, once no turn runs, in a turn that names no message", async () => {
    const { fake, heard, id } = started();
    fake.send(id, M1, "go");
    fake.startTurn(id);
    fake.compact(id);
    await Promise.resolve();
    expect(kinds(heard)).not.toContain("compacting");
    fake.endTurn(id);
    await Promise.resolve();
    await Promise.resolve();
    expect(turns(heard)).toEqual([[M1], []]);
    expect(heard.find((event) => event.type === "compacted")).toMatchObject({ reason: "asked" });
    expect(heard.find((event) => event.type === "context")).toMatchObject({ used: 10 });
    expect(states(heard).at(-1)).toBe("idle");
    expect(fake.calls.at(-1)).toEqual({ method: "compact", id, instructions: null });
  });

  it("echoes a message with its text and images, and later states without them", () => {
    const { fake, heard, id } = started();
    const image = { mediaType: "image/png", data: "AAAA" };
    fake.send(id, M1, "look", [image]);
    fake.startTurn(id, []);
    fake.send(id, M2, "and this");
    fake.startTurn(id, [M2]);
    expect(heard.filter((event) => event.type === "message")).toEqual([
      { id, type: "message", message: M1, state: "sent", error: null, text: "look", images: [image] },
      { id, type: "message", message: M2, state: "queued", error: null, text: "and this", images: [] },
      { id, type: "message", message: M2, state: "taken", error: null, text: null, images: [] },
    ]);
    fake.drop(id, M1);
    expect(heard.at(-1)).toMatchObject({ type: "message", message: M1, state: "dropped" });
  });

  it("tells every window what a request was answered with", async () => {
    const { fake, heard, id } = started();
    fake.startTurn(id);
    const request = fake.ask(id, "Bash", { command: "ls" });
    fake.answer(id, request, "deny", "  not now ");
    const question = fake.question(id, [
      { header: null, question: "Which?", options: [], multiple: false },
    ]);
    fake.reply(id, question, null);
    expect(heard.filter((event) => event.type === "answered")).toEqual([
      { id, type: "answered", request, choice: "deny", answers: null, message: "not now" },
      { id, type: "answered", request: question, choice: "deny", answers: null, message: null },
    ]);
    const cancelled = fake.ask(id, "Bash", { command: "rm" });
    fake.answer(id, cancelled, "cancel");
    await Promise.resolve();
    expect(heard.find((event) => event.type === "turnEnded")).toMatchObject({
      outcome: "interrupted",
    });
  });

  it("leaves housekeeping and tasks with no report out of whether it works", () => {
    const { fake, heard, id } = started();
    fake.startTurn(id);
    fake.task(id, null, { ambient: true });
    const quiet = fake.task(id, null);
    fake.endTurn(id);
    expect(states(heard).at(-1)).toBe("working");
    fake.finishTask(id, quiet, "completed", "done", { reports: false });
    expect(heard.at(-2)).toMatchObject({ type: "taskFinished", reports: false });
    expect(states(heard).at(-1)).toBe("idle");
  });

  it("hands a holding agent one message at a time, each once the last is named", () => {
    const fake = fakeIntegrated({ holding: true });
    const { id } = fake.start({ agent: "codex", project: "/repo" });
    fake.send(id, M1, "one");
    fake.send(id, M2, "two");
    expect(fake.handed).toEqual([M1]);
    fake.startTurn(id);
    fake.send(id, M3, "three");
    expect(fake.handed).toEqual([M1]);
    fake.endTurn(id);
    expect(fake.handed).toEqual([M1, M2]);
    fake.turn(id, "two done");
    expect(fake.handed).toEqual([M1, M2, M3]);
  });

  it("names no conversation at the start for an agent that makes its own ids", () => {
    const fake = fakeIntegrated({ mints: true });
    const heard: IntegratedEvent[] = [];
    fake.subscribe((event) => heard.push(event));
    expect(fake.start({ agent: "codex", project: "/repo" }).sessionId).toBeNull();
    expect(heard[0]).toMatchObject({ type: "ready", sessionId: expect.any(String) });
  });

  it("cuts long output down and says so, as the core does", () => {
    const { fake, heard, id } = started();
    fake.startTurn(id);
    fake.tool(id, "Read", {}, "x".repeat(70 * 1024));
    const finished = heard.find((event) => event.type === "toolFinished");
    expect(finished).toMatchObject({ truncated: true });
    expect(finished?.type === "toolFinished" && finished.output.length).toBe(64 * 1024);

    // In UTF-8 bytes, on a character's edge: "é" takes two.
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    fake.tool(id, "Read", {}, "é".repeat(40 * 1024));
    const wide = heard.filter((event) => event.type === "toolFinished").at(-1);
    expect(wide?.type === "toolFinished" && bytes(wide.output)).toBe(64 * 1024);
    expect(wide?.type === "toolFinished" && wide.output.endsWith("é")).toBe(true);

    const long = "y".repeat(70 * 1024);
    fake.startTool(id, "Write", { path: "/a", content: long });
    const input = heard.filter((event) => event.type === "toolInput").at(-1);
    expect(input).toMatchObject({ truncated: true, input: { path: "/a" } });
    const request = fake.ask(id, "Write", { content: long });
    const asked = heard.find((event) => event.type === "permissionAsked");
    expect(asked).toMatchObject({ request, truncated: true });
    expect(
      asked?.type === "permissionAsked" && (asked.input as { content: string }).content.length,
    ).toBe(64 * 1024);
    fake.answer(id, request, "allow");

    const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["+" + "z".repeat(200 * 1024)] };
    fake.tool(id, "Edit", {}, "", {
      changes: [
        { path: "/a", kind: "update", to: null, hunks: [hunk, hunk], content: null, truncated: false },
      ],
    });
    const edited = heard.filter((event) => event.type === "toolFinished").at(-1);
    expect(edited?.type === "toolFinished" && edited.changes[0]).toMatchObject({
      truncated: true,
      hunks: [hunk],
    });
    fake.emit(id, { type: "turnDiff", diff: "d".repeat(300 * 1024), truncated: false });
    const diff = heard.find((event) => event.type === "turnDiff");
    expect(diff?.type === "turnDiff" && diff.truncated && diff.diff.length).toBe(256 * 1024);
  });

  it("changes the model, mode and effort, and ends when stopped", async () => {
    const { fake, heard, id } = started();
    expect(fake.configure(id, { model: "sonnet", effort: "high" })).toEqual({
      model: "sonnet",
      mode: "default",
      effort: "high",
    });
    expect(fake.configure(id, { mode: "plan" }).mode).toBe("plan");
    expect(heard.filter((event) => event.type === "configured")).toMatchObject([
      { model: "sonnet", effort: "high", efforts: ["low", "medium", "high"] },
      { mode: "plan" },
    ]);
    fake.stop(id);
    await Promise.resolve();
    expect(heard.at(-1)).toMatchObject({ type: "ended", clean: true });
    expect(() => fake.send(id, M2, "anyone?")).toThrow();
  });

  it("goes back as the core does: Claude Code by starting again, held at the cut, until undone", async () => {
    const { fake, heard, id } = started();
    for (const [message, text] of [
      [M1, "one"],
      [M2, "two"],
      [M3, "three"],
    ]) {
      fake.send(id, message, text);
      fake.turn(id, `${text} done`);
    }
    fake.files.set(M2, { files: ["/repo/b.ts"], insertions: 1, deletions: 3 });
    const conversation = fake.snapshot(id).ready!.sessionId;
    expect(fake.rewindPoints(id)).toEqual({
      points: [
        { message: M1, conversation: true, files: false, why: null },
        { message: M2, conversation: true, files: true, why: null },
        { message: M3, conversation: true, files: false, why: null },
      ],
      why: null,
    });
    expect(fake.rewindPreview(id, M2)).toEqual({ files: ["/repo/b.ts"], insertions: 1, deletions: 3 });
    expect(() => fake.rewindPreview(id, M3)).toThrow("No file checkpoint found for this message.");
    expect(() => fake.rewind(id, M3, { conversation: true, files: true })).toThrow(
      "Claude Code kept no files from before this message.",
    );
    const went = fake.rewind(id, M3, { conversation: true, files: false });
    expect(went).toMatchObject({ sessionId: conversation, files: [], fallback: null, error: null });
    const next = went.id!;
    expect(next).not.toBe(id);
    // The session left ends before the answer; the one started again is
    // ready, then says it went back.
    expect(heard.filter((event) => event.id === id).at(-1)?.type).toBe("ended");
    expect(kinds(heard.filter((event) => event.id === next))).toEqual(["ready", "state", "rewound"]);
    expect(heard.find((event) => event.type === "rewound")).toEqual({
      id: next,
      type: "rewound",
      message: M3,
      conversation: true,
      files: [],
    });
    const read = async () =>
      (await fake.history({ agent: "claude-code", project: "/repo", session: conversation }))!.items
        .flatMap((item) => (item.event.type === "message" ? [item.event.message] : []));
    expect(await read()).toEqual([M1, M2]);
    // Undone: the conversation as it was.
    const undone = fake.rewindUndo(next);
    expect(undone.sessionId).toBe(conversation);
    expect(await read()).toEqual([M1, M2, M3]);
    // Back to before the first: a new conversation, the old one kept.
    const fresh = fake.rewind(undone.id!, M1, { conversation: true, files: false });
    expect(fresh.sessionId).not.toBe(conversation);
    expect(await read()).toEqual([M1, M2, M3]);
    // Gone on since: there is nothing to undo.
    fake.send(fresh.id!, "44444444-4444-4444-8444-444444444444", "anew");
    fake.turn(fresh.id!, "ok");
    expect(() => fake.rewindUndo(fresh.id!)).toThrow("the conversation has gone on since it went back");
  });

  it("puts only the files back in the same session, and refuses what the core refuses", () => {
    const { fake, heard, id } = started();
    fake.send(id, M1, "one");
    fake.turn(id, "done");
    fake.send(id, M2, "two");
    fake.turn(id, "done");
    fake.compaction(id, "asked");
    fake.files.set(M2, { files: ["/repo/a.ts"], insertions: 0, deletions: 2 });
    fake.send(id, M3, "three");
    fake.startTurn(id);
    expect(() => fake.rewind(id, M2, { conversation: false, files: true })).toThrow("a turn runs");
    fake.endTurn(id);
    // Before the last compaction the conversation cannot go back, but the
    // files can; the first message starts a new conversation still.
    const points = fake.rewindPoints(id).points;
    expect(points.map((point) => [point.message, point.conversation, point.files])).toEqual([
      [M1, true, false],
      [M2, false, true],
      [M3, true, false],
    ]);
    expect(points[1].why).toMatch(/compacted/);
    expect(() => fake.rewind(id, M2, { conversation: true, files: false })).toThrow(/compacted/);
    const went = fake.rewind(id, M2, { conversation: false, files: true });
    expect(went).toEqual({
      id,
      sessionId: fake.snapshot(id).ready!.sessionId,
      files: ["/repo/a.ts"],
      fallback: null,
      error: null,
    });
    expect(heard.at(-1)).toEqual({
      id,
      type: "rewound",
      message: M2,
      conversation: false,
      files: ["/repo/a.ts"],
    });
    expect(() => fake.rewindUndo(id)).toThrow("there is no going back to undo in this session");
  });

  it("starts a Claude Code conversation again whole where it does not come up from the point", () => {
    const { fake, id } = started();
    fake.send(id, M1, "one");
    fake.turn(id, "done");
    fake.send(id, M2, "two");
    fake.turn(id, "done");
    fake.rewindFallback = "claude ended with code 1: No message found";
    const went = fake.rewind(id, M2, { conversation: true, files: false });
    expect(went.fallback).toBe("claude ended with code 1: No message found");
    expect(fake.rewindPoints(went.id!).points.map((point) => point.message)).toEqual([M1, M2]);
    expect(() => fake.rewindUndo(went.id!)).toThrow();
  });

  it("goes back in the same Codex session, by the turn a message began", async () => {
    const fake = fakeIntegrated();
    const heard: IntegratedEvent[] = [];
    fake.subscribe((event) => heard.push(event));
    const { id } = fake.start({ agent: "codex", project: "/repo" });
    fake.send(id, M1, "one");
    fake.startTurn(id);
    fake.send(id, M2, "and this");
    fake.sendNow(id);
    await Promise.resolve();
    fake.endTurn(id);
    fake.send(id, M3, "three");
    fake.turn(id, "ok");
    const thread = fake.snapshot(id).ready!.sessionId;
    expect(fake.rewindPoints(id).points.map(({ message, conversation, files }) => [message, conversation, files])).toEqual([
      [M1, true, false],
      [M2, false, false],
      [M3, true, false],
    ]);
    expect(() => fake.rewindPreview(id, M1)).toThrow("Codex cannot put files back.");
    expect(() => fake.rewind(id, M2, { conversation: true, files: false })).toThrow(/took this message into a turn/);
    const went = fake.rewind(id, M3, { conversation: true, files: false });
    expect(went).toEqual({ id, sessionId: thread, files: [], fallback: null, error: null });
    expect(heard.at(-1)).toMatchObject({ id, type: "rewound", message: M3, conversation: true });
    const read = await fake.history({ agent: "codex", project: "/repo", session: thread });
    expect(read!.items.flatMap((item) => (item.event.type === "message" ? [item.event.message] : []))).toEqual([M1, M2]);
    fake.older.add(thread);
    expect(fake.rewindPoints(id)).toEqual({
      points: [],
      why: "This conversation was kept by an older Codex and cannot go back.",
    });
  });

  it("fails the turn, withdraws, and drops what waits when the process dies", () => {
    const { fake, heard, id } = started();
    fake.send(id, M1, "go");
    fake.startTurn(id);
    fake.send(id, M2, "waiting");
    fake.ask(id, "Bash", { command: "ls" });
    fake.end(id, false);
    expect(kinds(heard).slice(-5)).toEqual(["turnEnded", "withdrawn", "message", "error", "ended"]);
    expect(heard.at(-3)).toMatchObject({ message: M2, state: "dropped" });
  });
});
