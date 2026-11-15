import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answer,
  configure,
  conversationOf,
  handleOf,
  interrupt,
  lastWords,
  launch,
  linkFor,
  listenIntegrated,
  startMode,
  reattach,
  reply,
  resetIntegrated,
  resume,
  send,
  trust,
} from "$lib/integrated.svelte";
import {
  byKey,
  close,
  create,
  isMine,
  noted,
  reopened,
  reset as resetSessions,
  sessions,
} from "$lib/sessions.svelte";
import { attention, resetAttention } from "$lib/attention.svelte";
import { limitsOf, resetLimits } from "$lib/limits.svelte";
import { fakeIntegrated, type FakeIntegrated, type FakeIntegratedOptions } from "../fakeIntegrated";

const PROJECT = "/home/ada/dev/demo";

let fake: FakeIntegrated;
let stopListening = () => {};

/** The fake core behind the seam, its integrated sessions scripted. */
async function install(options: FakeIntegratedOptions = {}) {
  fake = fakeIntegrated(options);
  (window as unknown as { __WORKBENCH_CORE__: unknown }).__WORKBENCH_CORE__ = {
    integratedStart: async (start: Parameters<FakeIntegrated["start"]>[0]) => fake.start(start),
    integratedTrust: async (trusted: Parameters<FakeIntegrated["trust"]>[0]) => fake.trust(trusted),
    integratedSend: async (id: string, message: string, text: string, images?: never[]) =>
      fake.send(id, message, text, images),
    integratedInterrupt: async (id: string) => fake.interrupt(id),
    integratedCompact: async (id: string) => fake.compact(id),
    integratedAnswer: async (id: string, request: string, choice: never, message?: string) =>
      fake.answer(id, request, choice, message),
    integratedReply: async (id: string, request: string, answers: string[][] | null) =>
      fake.reply(id, request, answers),
    integratedConfigure: async (id: string, settings: never) => fake.configure(id, settings),
    integratedSnapshot: async (id: string) => fake.snapshot(id),
    integratedStop: async (id: string) => fake.stop(id),
    onIntegratedEvent: async (handler: Parameters<FakeIntegrated["subscribe"]>[0]) =>
      fake.subscribe(handler),
    projectInfo: async (path: string) => ({ path, name: "demo", repository: path, isGit: true }),
    transcriptsMany: async (projects: string[]) => projects.map(() => []),
    kill: async () => {},
  };
  stopListening = await listenIntegrated();
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An integrated row, started, with its conversation's id known. */
async function started(options: { prompt?: string; resumedFrom?: string } = {}) {
  const session = create(
    PROJECT,
    options.resumedFrom ?? null,
    "claude-code",
    null,
    options.prompt ?? null,
    null,
    null,
    undefined,
    "integrated",
  );
  await launch(session.key);
  return { session: byKey(session.key)!, key: session.key, handle: handleOf(session.key)! };
}

beforeEach(async () => {
  resetSessions();
  resetIntegrated();
  resetAttention();
  resetLimits();
  await install();
});

afterEach(() => {
  stopListening();
  delete (window as unknown as { __WORKBENCH_CORE__?: unknown }).__WORKBENCH_CORE__;
});

describe("an integrated session behind its row", () => {
  it("starts the agent and takes the conversation's id from ready, heard before the start answered", async () => {
    const { session, handle } = await started();
    expect(fake.calls[0]).toMatchObject({
      method: "start",
      options: { agent: "claude-code", project: PROJECT },
    });
    expect(handle).toBe("int-1");
    expect(session.status).toBe("running");
    expect(session.id).toBe("integrated-session-1");
    expect(isMine(PROJECT, "integrated-session-1")).toBe(true);
    expect(conversationOf(session.key).ready?.sessionId).toBe("integrated-session-1");
  });

  it("takes the id from ready for an agent that makes its own", async () => {
    await install({ mints: true });
    const { session } = await started();
    expect(session.id).toBe("agent-thread-1");
  });

  it("resumes a past conversation by its id", async () => {
    const { session } = await started({ resumedFrom: "old-conversation" });
    expect(fake.calls[0]).toMatchObject({ method: "start", options: { session: "old-conversation" } });
    expect(session.id).toBe("old-conversation");
  });

  it("says on its row what the core's events say: working, asking, idle", async () => {
    const { session, handle } = await started();
    attention.focused = false;
    send(session.key, "do it");
    expect(session.working).toBe(true);
    fake.startTurn(handle);
    const request = fake.ask(handle, "Bash", { command: "ls" });
    expect(session.working).toBe(false);
    expect(session.needs).toBe("permission");
    expect(session.unread).toBe(true);
    fake.answer(handle, request, "allow");
    expect(session.needs).toBeNull();
    expect(session.working).toBe(true);
    fake.emit(handle, { type: "text", block: "b", parent: null, text: "## Done\nAll three files pass.", done: true });
    fake.endTurn(handle);
    expect(session.working).toBe(false);
    expect(session.note).toBe("Done");
  });

  it("keeps a line the agent left of its own over its last words", async () => {
    const { session, handle } = await started();
    send(session.key, "go");
    noted(session.key, "Waiting on the review");
    fake.turn(handle, "Finished.");
    expect(session.note).toBe("Waiting on the review");
  });

  it("is read when the user is looking at it", async () => {
    const { session, handle } = await started();
    attention.focused = true;
    sessions.active = session.key;
    send(session.key, "go");
    fake.turn(handle, "ok");
    expect(session.unread).toBe(false);
  });

  it("names an untitled row after the first line of its first message, and a new message clears the line", async () => {
    const { session } = await started();
    session.note = "old line";
    send(session.key, "\n  Fix the slow startup scan\nmore detail");
    expect(session.title).toBe("Fix the slow startup scan");
    expect(session.note).toBeNull();
    send(session.key, "and another thing");
    expect(session.title).toBe("Fix the slow startup scan");
  });

  it("marks a message the core refused as not sent", async () => {
    const { session } = await started();
    const id = send(session.key, "   ");
    expect(id).toBeNull();
    fake.stop("int-1");
    await settled();
    const late = linkFor(session.key);
    late.handle = "int-1";
    const failed = send(session.key, "hello")!;
    await settled();
    expect(conversationOf(session.key).messages[failed]).toMatchObject({ state: "failed", error: "no such session" });
  });

  it("sends the first prompt of a session another session started", async () => {
    const { session } = await started({ prompt: "Scan the history" });
    expect(fake.calls.find((call) => call.method === "send")).toMatchObject({ text: "Scan the history" });
    expect(conversationOf(session.key).messages[Object.keys(conversationOf(session.key).messages)[0]].text).toBe(
      "Scan the history",
    );
  });

  it("interrupts, answers, replies and changes the model through the core", async () => {
    const { session, handle } = await started();
    send(session.key, "go");
    fake.startTurn(handle);
    const request = fake.ask(handle, "Bash", { command: "ls" });
    answer(session.key, request, "deny", "  not that  ");
    await settled();
    expect(fake.calls.find((call) => call.method === "answer")).toMatchObject({
      request,
      choice: "deny",
      message: "not that",
    });
    const question = fake.question(handle, [{ header: null, question: "Which?", options: [{ label: "A", description: null }], multiple: false }]);
    reply(session.key, question, [["A"]]);
    await settled();
    expect(fake.calls.find((call) => call.method === "reply")).toMatchObject({ answers: [["A"]] });
    interrupt(session.key);
    expect(conversationOf(session.key).interrupting).toBe(true);
    await settled();
    expect(conversationOf(session.key).interrupting).toBe(false);
    expect(conversationOf(session.key).turns[1].outcome).toBe("interrupted");
    await configure(session.key, { model: "haiku" });
    expect(conversationOf(session.key).settings.model).toBe("haiku");
    expect(session.model).toBe("haiku");
  });

  it("says why an answer was refused and lets it be tried again", async () => {
    const { session, handle } = await started();
    send(session.key, "go");
    fake.startTurn(handle);
    fake.ask(handle, "Bash", { command: "ls" });
    answer(session.key, "no-such-request", "allow");
    conversationOf(session.key).requests.push({
      request: "no-such-request",
      asked: conversationOf(session.key).requests[0].asked,
      state: "open",
      answer: null,
      answering: false,
      error: null,
      at: null,
    });
    answer(session.key, "no-such-request", "allow");
    await settled();
    const refused = conversationOf(session.key).requests.find((known) => known.request === "no-such-request")!;
    expect(refused.answering).toBe(false);
    expect(refused.error).toBe("the agent is not waiting on that request");
  });

  it("is stopped when its row is closed, and its last words are let go", async () => {
    const { session, handle } = await started();
    close(session.key);
    await settled();
    expect(fake.calls.at(-1)).toEqual({ method: "stop", id: handle });
    expect(byKey(session.key)).toBeNull();
  });

  it("stops an agent whose row was closed while it came up", async () => {
    const session = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "integrated");
    const coming = launch(session.key);
    close(session.key);
    await coming;
    await settled();
    expect(fake.calls.map((call) => call.method)).toEqual(["start", "stop"]);
  });

  it("asks before a folder that is not trusted, and starts once trusted", async () => {
    fake.untrusted.add(PROJECT);
    const session = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "integrated");
    await launch(session.key);
    expect(linkFor(session.key).untrusted).toBe(true);
    expect(byKey(session.key)!.status).toBe("failed");
    await trust(session.key);
    expect(fake.calls.map((call) => call.method)).toEqual(["trust", "start"]);
    expect(fake.calls[0]).toMatchObject({ options: { agent: "claude-code", project: PROJECT } });
    expect(linkFor(session.key).untrusted).toBe(false);
    expect(byKey(session.key)!.status).toBe("running");
  });

  it("ends with its process, and resumes its conversation where the thread left off", async () => {
    const { session, handle } = await started();
    send(session.key, "go");
    fake.turn(handle, "first answer");
    fake.end(handle, false);
    expect(session.status).toBe("crashed");
    expect(handleOf(session.key)).toBeNull();
    expect(conversationOf(session.key).ended).toEqual({ code: 1, clean: false });
    await resume(session.key);
    expect(fake.calls.at(-1)).toMatchObject({
      method: "start",
      options: { session: "integrated-session-1" },
    });
    expect(session.status).toBe("running");
    expect(conversationOf(session.key).ended).toBeNull();
    // The thread goes on under what was drawn before, the reason it ended
    // among it.
    expect(conversationOf(session.key).entries.map((entry) => entry.kind)).toEqual([
      "user",
      "agent",
      "note",
    ]);
  });

  it("ends as exited when stopped cleanly, and as crashed when it was not signed in", async () => {
    const { session, handle } = await started();
    fake.emit(handle, { type: "error", kind: "notLoggedIn", message: "Not logged in" });
    fake.end(handle, true);
    expect(session.status).toBe("crashed");
    const other = await started();
    fake.stop(other.handle);
    await settled();
    expect(other.session.status).toBe("exited");
  });

  it("fails with the core's reason when the start fails otherwise", async () => {
    const session = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "integrated");
    (window as unknown as { __WORKBENCH_CORE__: { integratedStart: () => Promise<never> } }).__WORKBENCH_CORE__.integratedStart =
      async () => {
        throw new Error("claude was not found on your PATH");
      };
    await launch(session.key);
    expect(byKey(session.key)).toMatchObject({ status: "failed", error: "claude was not found on your PATH" });
    expect(linkFor(session.key).untrusted).toBe(false);
  });
});

describe("the account's limits", () => {
  it("are kept for the account the session runs under, as the newest report", async () => {
    const session = create(PROJECT, null, "claude-code", null, null, null, "Work", undefined, "integrated");
    await launch(session.key);
    const handle = handleOf(session.key)!;
    fake.limits(handle, [{ kind: "session", percent: 11 }], { plan: "team", takenAt: 1_000 });
    expect(limitsOf(null, "claude-code", "Work")).toMatchObject({ plan: "team", windows: [{ percent: 11 }] });
    expect(limitsOf(null, "claude-code", null)).toBeNull();
    // Another session on the account reports later figures; an earlier
    // report arriving after them is let go.
    const other = create(PROJECT, null, "claude-code", null, null, null, "Work", undefined, "integrated");
    await launch(other.key);
    fake.limits(handleOf(other.key)!, [{ kind: "session", percent: 40 }], { takenAt: 2_000 });
    fake.limits(handle, [{ kind: "session", percent: 12 }], { takenAt: 1_500 });
    expect(limitsOf(null, "claude-code", "Work")?.windows[0].percent).toBe(40);
  });

  it("are kept apart for a session on another machine", async () => {
    const remote = "ssh://ada@build/home/ada/dev/demo";
    const session = create(remote, null, "claude-code", null, null, null, "Work", undefined, "integrated");
    await launch(session.key);
    fake.limits(handleOf(session.key)!, [{ kind: "weekly", percent: 70 }]);
    expect(limitsOf("ada@build", "claude-code", "Work")?.windows[0].kind).toBe("weekly");
    expect(limitsOf(null, "claude-code", "Work")).toBeNull();
  });

  it("come from the snapshot when the window comes to a session late", async () => {
    const before = await started();
    fake.limits(before.handle, [{ kind: "session", percent: 64 }], { takenAt: 3_000 });
    resetSessions();
    resetIntegrated();
    resetLimits();
    stopListening();
    stopListening = await listenIntegrated();
    const row = reopened(PROJECT, "integrated-session-1", "claude-code", null, null, null, "integrated");
    expect(await reattach(row.key, before.handle)).toBe(true);
    expect(limitsOf(null, "claude-code", null)).toMatchObject({ takenAt: 3_000, windows: [{ percent: 64 }] });
  });
});

describe("a session the core still runs after a reload", () => {
  it("is taken up from its snapshot, with the events heard meanwhile", async () => {
    // The session as the window before the reload left it.
    const before = await started();
    send(before.key, "first");
    fake.startTurn(before.handle);
    const request = fake.ask(before.handle, "Bash", { command: "ls" });
    resetSessions();
    resetIntegrated();
    stopListening();
    stopListening = await listenIntegrated();

    // Heard before the row came back: kept until it claims them.
    fake.emit(before.handle, { type: "text", block: "late", parent: null, text: "meanwhile", done: true });
    const row = reopened(PROJECT, "integrated-session-1", "claude-code", null, null, null, "integrated");
    expect(await reattach(row.key, before.handle)).toBe(true);
    const session = byKey(row.key)!;
    expect(session.status).toBe("running");
    expect(session.needs).toBe("permission");
    const conversation = conversationOf(row.key);
    expect(conversation.late).toBe(true);
    expect(conversation.open.map((open) => open.request)).toEqual([request]);
    // A start waits for the attach and starts nothing.
    await launch(row.key);
    expect(fake.calls.filter((call) => call.method === "start")).toHaveLength(1);
    fake.answer(before.handle, request, "allow");
    fake.turn(before.handle, "listed", { messages: [] });
    expect(session.needs).toBeNull();
  });

  it("is left for a resume when the core has no such session, or another conversation under that id", async () => {
    const row = reopened(PROJECT, "integrated-session-1", "claude-code", null, null, null, "integrated");
    expect(await reattach(row.key, "int-9")).toBe(false);
    expect(byKey(row.key)!.status).toBe("dormant");
    await started();
    const other = reopened(PROJECT, "another-conversation", "claude-code", null, null, null, "integrated");
    expect(await reattach(other.key, "int-1")).toBe(false);
    expect(handleOf(other.key)).toBeNull();
  });
});

describe("the last words of a run", () => {
  it("are the first line of the last text in the main thread", () => {
    expect(lastWords([])).toBeNull();
    expect(
      lastWords([
        { kind: "agent", key: "a", turn: 1, at: 0, parts: [{ kind: "text", block: "b", text: "\n> **Done.** The tests pass.\nMore", done: true, gap: false, at: 0, until: 0 }] },
        { kind: "note", key: "n", tone: "info", text: "x", at: 0 },
      ]),
    ).toBe("Done. The tests pass.");
  });
});

describe("the mode a session starts in", () => {
  it("is the agent's safe one, never left to its own configuration", async () => {
    const { session } = await started();
    expect(fake.calls[0]).toMatchObject({ method: "start", options: { mode: "default" } });
    const codex = create(PROJECT, null, "codex", null, null, null, null, undefined, "integrated");
    await launch(codex.key);
    expect(fake.calls.filter((call) => call.method === "start")[1]).toMatchObject({ options: { agent: "codex", mode: "read-only" } });
    expect(session.kind).toBe("integrated");
  });

  it("is the one the user chose when the session starts again, and the safe one for a mode the agent does not offer", async () => {
    const { session, handle } = await started();
    await configure(session.key, { mode: "plan" });
    expect(startMode(session, linkFor(session.key))).toBe("plan");
    fake.end(handle, true);
    await resume(session.key);
    expect(fake.calls.filter((call) => call.method === "start").at(-1)).toMatchObject({ options: { mode: "plan" } });
    linkFor(session.key).conversation.settings.mode = "untrusted, workspace-write";
    expect(startMode(session, linkFor(session.key))).toBe("default");
  });
});

describe("an interrupt with no turn running", () => {
  it("says nothing is stopping, though a subagent is still at work", async () => {
    const { session, handle } = await started();
    fake.task(handle, null, { kind: "agent", description: "background look" });
    expect(conversationOf(session.key).working).toBe(true);
    interrupt(session.key);
    expect(conversationOf(session.key).interrupting).toBe(false);
    await settled();
    expect(fake.calls.some((call) => call.method === "interrupt")).toBe(true);
    expect(conversationOf(session.key).interrupting).toBe(false);
  });
});
