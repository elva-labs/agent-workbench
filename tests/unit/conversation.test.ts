import { describe, expect, it } from "vitest";
import { Conversation, type Entry, type ToolCall } from "$lib/conversation.svelte";
import { fakeIntegrated, type FakeIntegratedOptions } from "../fakeIntegrated";

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const M3 = "33333333-3333-4333-8333-333333333333";

/** A scripted session whose every event goes to a conversation, as the
    window plays them, with a clock the test moves. */
function played(options: FakeIntegratedOptions = {}) {
  const fake = fakeIntegrated(options);
  let now = 1_000;
  const conversation = new Conversation(() => now);
  let id = "";
  fake.subscribe((event) => {
    if (event.id !== id && id !== "") return;
    const { id: _id, ...body } = event;
    conversation.apply(body as Parameters<Conversation["apply"]>[0]);
  });
  // The ready that goes out before the start answers is the session's.
  id = "int-1";
  fake.start({ agent: "claude-code", project: "/repo", model: "sonnet" });
  const tick = (ms = 1000) => (now += ms);
  const send = (message: string, text: string) => {
    conversation.sending(message, text);
    fake.send(id, message, text);
  };
  return { fake, conversation, id, tick, send };
}

/** The thread as kinds and what each holds, for an assertion to read. */
function outline(entries: Entry[]): string[] {
  return entries.map((entry) => {
    if (entry.kind === "user") return `you:${entry.message}`;
    if (entry.kind === "agent")
      return `agent:${entry.turn}:${entry.parts.map((part) => part.kind).join(",")}`;
    if (entry.kind === "note") return `note:${entry.tone}:${entry.text}`;
    return `compaction:${entry.done ? "done" : "running"}`;
  });
}

const agentParts = (conversation: Conversation, at = -1) => {
  const entries = conversation.entries.filter((entry) => entry.kind === "agent");
  const entry = entries.at(at);
  if (entry?.kind !== "agent") throw new Error("no run there");
  return entry.parts;
};

describe("a conversation, from the core's events", () => {
  it("knows the session from ready: its id, settings and what it offers", () => {
    const { conversation } = played();
    expect(conversation.sessionId).toBe("integrated-session-1");
    expect(conversation.settings).toEqual({ model: "sonnet", mode: "default", effort: null });
    expect(conversation.efforts).toEqual(["low", "medium", "high"]);
    expect(conversation.ready?.models.map((model) => model.value)).toEqual(["default", "haiku", "sonnet"]);
    expect(conversation.ready?.modes.map((mode) => mode.value)).toContain("plan");
    expect(conversation.state).toBe("idle");
    expect(conversation.entries).toEqual([]);
  });

  it("draws a short exchange: the user's words, then the agent's", () => {
    const { fake, conversation, id, send } = played();
    send(M1, "hello");
    expect(conversation.messages[M1].state).toBe("sent");
    expect(outline(conversation.entries)).toEqual([`you:${M1}`]);
    fake.turn(id, "hi there, how can I help?");
    expect(outline(conversation.entries)).toEqual([`you:${M1}`, "agent:1:text"]);
    const [text] = agentParts(conversation);
    expect(text).toMatchObject({ kind: "text", text: "hi there, how can I help?", done: true });
    expect(conversation.messages[M1].state).toBe("taken");
    expect(conversation.turns[1]).toMatchObject({ messages: [M1], outcome: "done", model: "sonnet" });
    expect(conversation.current).toBeNull();
    expect(conversation.state).toBe("idle");
    expect(conversation.waiting).toEqual([]);
  });

  it("shows a message as sending until the core says where it stands", () => {
    const { conversation } = played();
    conversation.sending(M1, "hello");
    expect(conversation.waiting.map((message) => [message.id, message.state])).toEqual([
      [M1, "sending"],
    ]);
    expect(conversation.entries).toEqual([]);
    conversation.sendFailed(M1, "there is nothing to send");
    expect(conversation.messages[M1]).toMatchObject({ state: "failed", error: "there is nothing to send" });
    conversation.forget(M1);
    expect(conversation.waiting).toEqual([]);
  });

  it("grows text as it streams and takes the whole when it comes", () => {
    const { fake, conversation, id, send } = played();
    send(M1, "go");
    fake.startTurn(id);
    fake.emit(id, { type: "text", block: "b1", parent: null, text: "Hel", done: false });
    fake.emit(id, { type: "text", block: "b1", parent: null, text: "lo, ", done: false });
    expect(agentParts(conversation)[0]).toMatchObject({ text: "Hello, ", done: false });
    fake.emit(id, { type: "text", block: "b1", parent: null, text: "Hello, world", done: true });
    expect(agentParts(conversation)[0]).toMatchObject({ text: "Hello, world", done: true });
    // A piece after the whole changes nothing.
    fake.emit(id, { type: "text", block: "b1", parent: null, text: "!", done: false });
    expect(agentParts(conversation)[0]).toMatchObject({ text: "Hello, world" });
  });

  it("marks a gap a skipped event left, and the whole mends it", () => {
    const { fake, conversation, id, send } = played();
    send(M1, "go");
    fake.startTurn(id);
    fake.emit(id, { type: "text", block: "b1", parent: null, text: "one ", done: false });
    fake.skip(id, 4);
    fake.emit(id, { type: "text", block: "b1", parent: null, text: "six", done: false });
    expect(agentParts(conversation)[0]).toMatchObject({ text: "one six", gap: true });
    expect(conversation.skipped).toBe(4);
    fake.emit(id, { type: "text", block: "b1", parent: null, text: "one two three four five six", done: true });
    expect(agentParts(conversation)[0]).toMatchObject({
      text: "one two three four five six",
      gap: false,
      done: true,
    });
  });

  it("ends a block with no whole when its turn ends, gap and all", () => {
    const { fake, conversation, id, send } = played();
    send(M1, "go");
    fake.startTurn(id);
    fake.emit(id, { type: "thinking", block: "t1", parent: null, text: "hmm", done: false });
    fake.emit(id, { type: "text", block: "b1", parent: null, text: "part", done: false });
    fake.skip(id, 1);
    fake.endTurn(id, "interrupted");
    const [thinking, text] = agentParts(conversation);
    expect(thinking).toMatchObject({ kind: "thinking", text: "hmm", done: true });
    expect(text).toMatchObject({ kind: "text", text: "part", done: true, gap: true });
    expect(conversation.turns[1].outcome).toBe("interrupted");
  });

  it("keeps a message sent during a turn waiting, and places it before the turn that answers it", () => {
    const { fake, conversation, id, send } = played();
    send(M1, "first");
    fake.startTurn(id);
    send(M2, "and this too");
    expect(conversation.messages[M2].state).toBe("queued");
    expect(conversation.waiting.map((message) => message.id)).toEqual([M2]);
    expect(outline(conversation.entries)).toEqual([`you:${M1}`, "agent:1:"]);
    fake.emit(id, { type: "text", block: "b1", parent: null, text: "done with the first", done: true });
    // The turn ends; the next answers the waiting message.
    fake.endTurn(id);
    fake.turn(id, "and the second");
    expect(outline(conversation.entries)).toEqual([
      `you:${M1}`,
      "agent:1:text",
      `you:${M2}`,
      "agent:2:text",
    ]);
    expect(conversation.waiting).toEqual([]);
  });

  it("answers several waiting messages with one turn", () => {
    const { fake, conversation, id, send } = played();
    send(M1, "one");
    fake.startTurn(id);
    send(M2, "two");
    send(M3, "three");
    fake.endTurn(id);
    fake.turn(id, "both");
    expect(outline(conversation.entries)).toEqual([
      `you:${M1}`,
      "agent:1:",
      `you:${M2}`,
      `you:${M3}`,
      "agent:2:text",
    ]);
    expect(conversation.turns[2].messages).toEqual([M2, M3]);
  });

  it("follows a message taken into the running turn with what the agent says after it", () => {
    const { fake, conversation, id, send } = played();
    send(M1, "start");
    fake.startTurn(id);
    fake.emit(id, { type: "text", block: "b1", parent: null, text: "Working on it.", done: true });
    send(M2, "also this");
    fake.emit(id, { type: "turnStarted", messages: [M2] });
    expect(conversation.messages[M2].state).toBe("taken");
    fake.emit(id, { type: "text", block: "b2", parent: null, text: "Noted.", done: true });
    fake.endTurn(id);
    expect(outline(conversation.entries)).toEqual([
      `you:${M1}`,
      "agent:1:text",
      `you:${M2}`,
      "agent:1:text",
    ]);
    expect(conversation.turns[1].messages).toEqual([M1, M2]);
  });

  it("draws a dropped message where it was dropped, with why", () => {
    const { fake, conversation, id, send } = played();
    send(M1, "start");
    fake.startTurn(id);
    send(M2, "never mind");
    fake.drop(id, M2, "the agent refused the message");
    expect(conversation.messages[M2]).toMatchObject({
      state: "dropped",
      error: "the agent refused the message",
      placed: true,
    });
    expect(conversation.waiting).toEqual([]);
  });

  it("draws a turn the agent began by itself with no message of the user's", () => {
    const { fake, conversation, id } = played();
    fake.turn(id, "The background build finished.");
    expect(outline(conversation.entries)).toEqual(["agent:1:text"]);
    expect(conversation.turns[1].messages).toEqual([]);
  });

  it("follows a tool call from its start, input and output to its result", () => {
    const { fake, conversation, id, send, tick } = played();
    send(M1, "test it");
    fake.startTurn(id);
    fake.emit(id, { type: "toolStarted", call: "c1", parent: null, name: "Bash", kind: "command" });
    fake.emit(id, { type: "toolInput", call: "c1", parent: null, delta: '{"command":', input: null, truncated: false });
    fake.emit(id, { type: "toolInput", call: "c1", parent: null, delta: '"npm test"}', input: null, truncated: false });
    let call = conversation.call("c1")!;
    expect(call).toMatchObject({ inputText: '{"command":"npm test"}', inputDone: false, done: false });
    fake.emit(id, { type: "toolInput", call: "c1", parent: null, delta: null, input: { command: "npm test" }, truncated: false });
    fake.emit(id, { type: "toolOutput", call: "c1", parent: null, delta: "PASS 3\n" });
    fake.emit(id, { type: "toolOutput", call: "c1", parent: null, delta: "PASS 4\n" });
    expect(conversation.call("c1")!.output).toBe("PASS 3\nPASS 4\n");
    tick(5000);
    fake.finishTool(id, "c1", "PASS 3\nPASS 4\n", {
      changes: [
        {
          path: "/repo/a.txt",
          kind: "update",
          to: null,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
          content: null,
          truncated: false,
        },
      ],
    });
    call = conversation.call("c1")!;
    expect(call).toMatchObject({
      input: { command: "npm test" },
      inputDone: true,
      done: true,
      error: false,
      result: "PASS 3\nPASS 4\n",
    });
    expect(call.changes[0].path).toBe("/repo/a.txt");
    expect(call.until - call.at).toBe(5000);
  });

  it("finishes a call its turn left open as failed, as the core says", () => {
    const { fake, conversation, id, send } = played();
    send(M1, "go");
    fake.startTurn(id);
    const call = fake.startTool(id, "Read", { file_path: "/repo/x" }, { kind: "read" });
    fake.endTurn(id, "interrupted");
    expect(conversation.call(call)).toMatchObject({ done: true, error: true, result: "" });
  });

  it("hangs a subagent's words, calls and tasks under the call that started it", () => {
    const { fake, conversation, id, send } = played();
    send(M1, "explore");
    fake.startTurn(id);
    const agent = fake.startTool(id, "Task", { description: "Explore the code", prompt: "look" }, { kind: "agent" });
    const task = fake.task(id, agent, { description: "Explore the code", background: false });
    fake.turn(id, "Looking around.", { parent: agent });
    const read = fake.tool(id, "Read", { file_path: "/repo/x" }, "contents", { parent: agent, kind: "read" });
    fake.emit(id, { type: "taskProgress", task, call: agent, tool: "Read", description: null });
    expect(agentParts(conversation).map((part) => part.kind)).toEqual(["tool"]);
    const parent = conversation.call(agent)!;
    expect(parent.parts.map((part) => part.kind)).toEqual(["text", "tool"]);
    expect((parent.parts[1] as ToolCall).call).toBe(read);
    expect(parent.tasks.map((known) => [known.task, known.status, known.tool])).toEqual([
      [task, "running", "Read"],
    ]);
    fake.finishTask(id, task, "completed", "Found it");
    expect(parent.tasks[0]).toMatchObject({ status: "completed", summary: "Found it" });
    expect(conversation.tasks.map((known) => known.task)).toEqual([task]);
  });

  it("keeps a task no call started in the session's own list", () => {
    const { fake, conversation, id } = played();
    const task = fake.task(id, null, { kind: "shell", description: "npm run dev" });
    expect(conversation.tasks.map((known) => [known.task, known.kind, known.call])).toEqual([
      [task, "shell", null],
    ]);
  });

  it("lets a subagent it never saw start speak in a run of its own, with no turn left running", () => {
    const { fake, conversation, id } = played();
    fake.emit(id, { type: "text", block: "x", parent: "unknown-call", text: "late words", done: true });
    expect(outline(conversation.entries)).toEqual(["agent:1:text"]);
    expect(conversation.current).toBeNull();
    expect(conversation.working).toBe(false);
  });

  it("draws a plan once per run and changes it in place", () => {
    const { fake, conversation, id, send } = played();
    send(M1, "plan");
    fake.startTurn(id);
    fake.plan(id, [
      { text: "Read", status: "active" },
      { text: "Write", status: "pending" },
    ]);
    fake.plan(id, [
      { text: "Read", status: "done" },
      { text: "Write", status: "active" },
    ]);
    const parts = agentParts(conversation);
    expect(parts.map((part) => part.kind)).toEqual(["plan"]);
    expect(parts[0]).toMatchObject({ steps: [{ status: "done" }, { status: "active" }] });
  });

  it("keeps a turn's diff", () => {
    const { fake, conversation, id, send } = played();
    send(M1, "go");
    fake.startTurn(id);
    fake.emit(id, { type: "turnDiff", diff: "--- a\n+++ b\n", truncated: false });
    expect(conversation.turn?.diff).toEqual({ diff: "--- a\n+++ b\n", truncated: false });
  });

  it("holds a permission request open until it is answered, and tells the call", () => {
    const { fake, conversation, id, send } = played();
    send(M1, "touch it");
    fake.startTurn(id);
    const call = fake.startTool(id, "Bash", { command: "touch notes.txt" }, { kind: "command" });
    const request = fake.ask(id, "Bash", { command: "touch notes.txt" }, {
      call,
      session: "Bash(touch notes.txt) for the rest of this session",
      always: "Bash(touch notes.txt) in this project's uncommitted local settings",
    });
    expect(conversation.open.map((open) => open.request)).toEqual([request]);
    expect(conversation.state).toBe("asking");
    const asked = conversation.open[0].asked;
    expect(asked.type === "permissionAsked" && asked.choices.map((offer) => offer.choice)).toEqual([
      "allow",
      "allowSession",
      "allowAlways",
      "deny",
      "cancel",
    ]);
    conversation.answering(request, true);
    expect(conversation.open[0].answering).toBe(true);
    fake.answer(id, request, "allowSession");
    expect(conversation.open).toEqual([]);
    expect(conversation.call(call)!.answer).toEqual({ choice: "allowSession", message: null });
    expect(conversation.state).toBe("working");
  });

  it("closes a request the agent stopped waiting for", async () => {
    const { fake, conversation, id, send } = played();
    send(M1, "go");
    fake.startTurn(id);
    const request = fake.ask(id, "Bash", { command: "rm -rf /tmp/x" });
    fake.interrupt(id);
    await Promise.resolve();
    expect(conversation.requests[0]).toMatchObject({ request, state: "withdrawn" });
    expect(conversation.open).toEqual([]);
    expect(conversation.turns[1].outcome).toBe("interrupted");
  });

  it("asks a question in the thread and draws the answer, a secret's left out", () => {
    const { fake, conversation, id, send } = played();
    send(M1, "deploy");
    fake.startTurn(id);
    const request = fake.question(id, [
      { header: "Where", question: "Which stage?", options: [{ label: "dev", description: null }, { label: "prod", description: "careful" }], multiple: false },
      { header: null, question: "The token?", options: [], multiple: false, secret: true },
    ]);
    const part = agentParts(conversation).find((known) => known.kind === "question");
    expect(part).toMatchObject({ request, outcome: "open" });
    expect(conversation.open.map((open) => open.asked.type)).toEqual(["questionAsked"]);
    fake.reply(id, request, [["dev"], ["hunter2"]]);
    expect(agentParts(conversation).find((known) => known.kind === "question")).toMatchObject({
      outcome: "answered",
      answers: [["dev"], null],
    });
  });

  it("draws a question the user declined", () => {
    const { fake, conversation, id, send } = played();
    send(M1, "go");
    fake.startTurn(id);
    const request = fake.question(id, [{ header: null, question: "Sure?", options: [], multiple: false }]);
    fake.reply(id, request, null);
    expect(agentParts(conversation)[0]).toMatchObject({ kind: "question", outcome: "declined", answers: null });
  });

  it("draws a compaction, asked for or because the context was full", async () => {
    const { fake, conversation, id } = played();
    fake.emit(id, { type: "compacting" });
    expect(conversation.compacting).toBe(true);
    expect(conversation.working).toBe(true);
    fake.emit(id, { type: "compacted", reason: "full", tokensBefore: 180_000, tokensAfter: 20_000 });
    expect(conversation.compacting).toBe(false);
    expect(conversation.entries.at(-1)).toMatchObject({
      kind: "compaction",
      done: true,
      reason: "full",
      tokensBefore: 180_000,
      tokensAfter: 20_000,
    });
    fake.compact(id);
    await Promise.resolve();
    expect(conversation.entries.filter((entry) => entry.kind === "compaction")).toHaveLength(2);
    expect(conversation.context).toEqual({ used: 10, size: 200_000 });
  });

  it("draws notices and errors, and takes a retry off once the turn goes on", () => {
    const { fake, conversation, id, send } = played();
    fake.notice(id, "Fell back to Sonnet", "warning");
    send(M1, "go");
    fake.startTurn(id);
    fake.emit(id, { type: "retrying", message: "overloaded", attempt: 2, attempts: 10 });
    expect(conversation.turn?.retrying).toEqual({ message: "overloaded", attempt: 2, attempts: 10 });
    fake.emit(id, { type: "text", block: "b", parent: null, text: "ok", done: true });
    expect(conversation.turn?.retrying).toBeNull();
    fake.emit(id, { type: "error", kind: "protocol", message: "a line was too long" });
    expect(outline(conversation.entries)).toEqual([
      "note:warning:Fell back to Sonnet",
      `you:${M1}`,
      "agent:1:text",
      "note:error:a line was too long",
    ]);
  });

  it("knows when the account is not signed in", () => {
    const { fake, conversation, id } = played();
    fake.emit(id, { type: "error", kind: "notLoggedIn", message: "Not logged in" });
    expect(conversation.notLoggedIn).toBe(true);
    expect(conversation.entries).toEqual([]);
  });

  it("follows a change of model", () => {
    const { fake, conversation, id } = played();
    fake.configure(id, { model: "haiku" });
    expect(conversation.settings.model).toBe("haiku");
    expect(conversation.efforts).toEqual([]);
  });

  it("closes everything when the session ends in the middle of a turn", () => {
    const { fake, conversation, id, send } = played();
    send(M1, "go");
    fake.startTurn(id);
    fake.emit(id, { type: "text", block: "b1", parent: null, text: "half", done: false });
    const call = fake.startTool(id, "Bash", { command: "sleep 100" }, { kind: "command" });
    fake.ask(id, "Bash", { command: "sleep 100" }, { call });
    const task = fake.task(id, call, { kind: "shell" });
    send(M2, "hello?");
    fake.end(id, false);
    expect(conversation.ended).toEqual({ code: 1, clean: false });
    expect(conversation.turns[1]).toMatchObject({ outcome: "failed" });
    expect(conversation.current).toBeNull();
    expect(agentParts(conversation)[0]).toMatchObject({ text: "half", done: true });
    expect(conversation.call(call)).toMatchObject({ done: true, error: true });
    expect(conversation.open).toEqual([]);
    expect(conversation.tasks.find((known) => known.task === task)?.status).toBe("lost");
    expect(conversation.messages[M2]).toMatchObject({ state: "dropped", placed: true });
    expect(outline(conversation.entries).at(-1)).toBe("note:error:claude ended with code 1");
  });

  it("ends cleanly when stopped with nothing running", async () => {
    const { fake, conversation, id } = played();
    fake.stop(id);
    await Promise.resolve();
    expect(conversation.ended).toEqual({ code: 0, clean: true });
    expect(conversation.entries).toEqual([]);
  });

  it("starts again where it was after it ended", () => {
    const { fake, conversation, id } = played();
    fake.emit(id, { type: "error", kind: "notLoggedIn", message: "Not logged in" });
    fake.end(id, false);
    conversation.resumed();
    expect(conversation.ended).toBeNull();
    expect(conversation.notLoggedIn).toBe(false);
  });
});

describe("a conversation a window comes to late", () => {
  it("is rebuilt from the snapshot: state, settings, what waits and what is asked", () => {
    const { fake, id, send } = played();
    send(M1, "first");
    fake.startTurn(id);
    send(M2, "queued one");
    const request = fake.ask(id, "Bash", { command: "ls" });
    const snapshot = fake.snapshot(id);

    const late = new Conversation(() => 5_000);
    late.restore(snapshot);
    expect(late.late).toBe(true);
    expect(late.sessionId).toBe("integrated-session-1");
    expect(late.state).toBe("asking");
    expect(late.settings.model).toBe("sonnet");
    expect(late.current).not.toBeNull();
    expect(late.working).toBe(true);
    expect(late.open.map((open) => open.request)).toEqual([request]);
    expect(late.waiting.map((message) => [message.id, message.state, message.text])).toEqual([
      [M2, "queued", "queued one"],
    ]);
    // The events after it carry on from there.
    fake.answer(id, request, "allow");
    late.apply({ type: "answered", request, choice: "allow", answers: null, message: null });
    late.apply({ type: "text", block: "b9", parent: null, text: "listed", done: true });
    late.apply({ type: "turnEnded", outcome: "done", error: null, totalCostUsd: null, durationMs: null, usage: null });
    expect(late.open).toEqual([]);
    expect(late.current).toBeNull();
    expect(outline(late.entries)).toEqual(["agent:1:text"]);
  });

  it("lays the snapshot over the events heard while it was asked for", async () => {
    const { fake, id, send } = played();
    send(M1, "first");
    fake.startTurn(id);
    const gone = fake.ask(id, "Bash", { command: "ls" });
    const late = new Conversation(() => 5_000);
    // Heard before the snapshot answered: the request was then withdrawn,
    // and the turn ended, both before the snapshot.
    late.apply({ type: "state", state: "asking" });
    late.apply(fake.events.find((event) => event.type === "permissionAsked")! as never);
    fake.interrupt(id);
    await Promise.resolve();
    late.restore(fake.snapshot(id));
    expect(late.requests.find((known) => known.request === gone)?.state).toBe("withdrawn");
    expect(late.state).toBe("idle");
    expect(late.current).toBeNull();
  });

  it("is told of a message no window of its own sent", () => {
    const { fake, id } = played();
    const other = new Conversation(() => 7_000);
    fake.subscribe((event) => {
      const { id: _id, ...body } = event;
      other.apply(body as never);
    });
    fake.send(id, M1, "from the other window");
    fake.turn(id, "answered");
    expect(other.messages[M1]).toMatchObject({ text: "from the other window", state: "taken" });
    expect(outline(other.entries)).toEqual([`you:${M1}`, "agent:1:text"]);
  });
});

describe("a model changed during a turn", () => {
  it("is the one the next turn runs on, said only while the turn it was changed in runs", () => {
    const { fake, conversation, id, send } = played();
    send(M1, "go");
    fake.startTurn(id);
    fake.configure(id, { model: "haiku" });
    expect(conversation.settings.model).toBe("haiku");
    expect(conversation.modelAfterTurn).toBe("haiku");
    fake.endTurn(id);
    expect(conversation.modelAfterTurn).toBeNull();
    fake.configure(id, { model: "sonnet" });
    expect(conversation.modelAfterTurn).toBeNull();
  });
});
