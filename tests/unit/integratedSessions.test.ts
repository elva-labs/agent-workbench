import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answer,
  compact,
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
  loadRemembered,
  noted,
  reopened,
  reset as resetSessions,
  sessions,
  wake,
} from "$lib/sessions.svelte";
import { attention, resetAttention } from "$lib/attention.svelte";
import { applyDetect, resetAgent } from "$lib/agent.svelte";
import { adoptWorkflows, defaultWorkflow, reset as resetWorkflows } from "$lib/workflows.svelte";
import { orchestratorPrompt } from "$lib/workflowInstructions";
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
    integratedCompact: async (id: string, instructions?: string) => fake.compact(id, instructions),
    integratedAnswer: async (id: string, request: string, choice: never, message?: string) =>
      fake.answer(id, request, choice, message),
    integratedReply: async (id: string, request: string, answers: string[][] | null) =>
      fake.reply(id, request, answers),
    integratedConfigure: async (id: string, settings: never) => fake.configure(id, settings),
    integratedSnapshot: async (id: string) => fake.snapshot(id),
    integratedHistory: async (options: Parameters<FakeIntegrated["history"]>[0]) =>
      fake.history(options),
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

/** What the agent said in the main thread, block by block. */
function agentTexts(conversation: ReturnType<typeof conversationOf>): string[] {
  return conversation.entries.flatMap((entry) =>
    entry.kind === "agent"
      ? entry.parts.flatMap((part) => (part.kind === "text" ? [part.text] : []))
      : [],
  );
}

/** A past conversation as its transcript reads back: a question, a call
    and an answer, a minute apart, on the model it ran on. */
function written(at: number, words: string, answer: string, message = `m-${at}`) {
  return [
    {
      at,
      event: { type: "message" as const, message, state: "sent" as const, error: null, text: words, images: [] },
    },
    { at, model: "claude-haiku-5-5", event: { type: "turnStarted" as const, messages: [message] } },
    {
      at: at + 1_000,
      event: { type: "toolStarted" as const, call: `c-${at}`, parent: null, name: "Bash", kind: "command" as const },
    },
    {
      at: at + 2_000,
      event: {
        type: "toolFinished" as const,
        call: `c-${at}`,
        parent: null,
        output: "ok",
        error: false,
        truncated: false,
        changes: [],
      },
    },
    { at: at + 3_000, event: { type: "text" as const, block: `b-${at}`, parent: null, text: answer, done: true } },
    {
      at: at + 3_000,
      event: {
        type: "turnEnded" as const,
        outcome: "done" as const,
        error: null,
        totalCostUsd: null,
        durationMs: 3_000,
        usage: null,
      },
    },
  ];
}

beforeEach(async () => {
  resetSessions();
  resetIntegrated();
  resetAttention();
  resetLimits();
  // The window has the workflows, so a resumed row finds out what it
  // follows as it starts.
  resetWorkflows();
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
    expect(fake.calls.find((call) => call.method === "start")).toMatchObject({
      options: { session: "old-conversation" },
    });
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

  it("compacts with what the summary should keep, saying it waits while a turn runs", async () => {
    const { session, handle } = await started();
    const link = linkFor(session.key);
    send(session.key, "go");
    fake.startTurn(handle);
    const asked = compact(session.key, "  keep the API notes ");
    expect(link.compactAsked).toBe(true);
    expect(await asked).toBe(true);
    expect(fake.calls.at(-1)).toEqual({ method: "compact", id: handle, instructions: "keep the API notes" });
    expect(link.compactAsked).toBe(true);
    fake.endTurn(handle);
    expect(link.compactAsked).toBe(false);
    await settled();
    await settled();
    expect(conversationOf(session.key).entries.at(-1)).toMatchObject({ kind: "compaction", done: true, failed: false });
    expect(await compact("no-such-row")).toBe(false);
  });

  it("waits for nothing when no turn runs, and stops waiting when the turn ends with no compaction", async () => {
    const { session, handle } = await started();
    const link = linkFor(session.key);
    const idle = compact(session.key);
    expect(link.compactAsked).toBe(false);
    await idle;
    send(session.key, "go");
    fake.startTurn(handle);
    void compact(session.key);
    expect(link.compactAsked).toBe(true);
    // An agent that answers a compaction of too little with a reply alone.
    fake.endTurn(handle);
    expect(link.compactAsked).toBe(false);
  });

  it("says why a compaction was refused", async () => {
    await install();
    const session = create(PROJECT, null, "codex", null, null, null, null, undefined, "integrated");
    await launch(session.key);
    const link = linkFor(session.key);
    expect(await compact(session.key, "keep it")).toBe(false);
    expect(link.compactAsked).toBe(false);
    expect(link.compactError).toBe("Codex compacts without instructions");
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
    // The core's answer to the start is held until the row has gone.
    const core = (window as unknown as { __WORKBENCH_CORE__: Record<string, unknown> }).__WORKBENCH_CORE__;
    let answer: (() => void) | null = null;
    core.integratedStart = (options: Parameters<FakeIntegrated["start"]>[0]) =>
      new Promise((resolve) => (answer = () => resolve(fake.start(options))));
    const session = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "integrated");
    const coming = launch(session.key);
    await vi.waitFor(() => expect(answer).not.toBeNull());
    close(session.key);
    answer!();
    await coming;
    await settled();
    expect(fake.calls.map((call) => call.method)).toEqual(["start", "stop"]);
  });

  it("starts nothing for a row closed before its start was sent", async () => {
    const session = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "integrated");
    const coming = launch(session.key);
    close(session.key);
    await coming;
    await settled();
    expect(fake.calls).toEqual([]);
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

describe("what a resumed session said before", () => {
  it("is read from its transcript and drawn above what this run says, with where this run began", async () => {
    fake.transcript("old-conversation", written(1_000_000, "Count the files", "There are 12."));
    const { session, handle } = await started({ resumedFrom: "old-conversation" });
    expect(fake.calls[0]).toEqual({
      method: "history",
      options: { agent: "claude-code", project: PROJECT, session: "old-conversation" },
    });
    const conversation = conversationOf(session.key);
    await vi.waitFor(() => expect(conversation.earlier).toBe("read"));
    expect(conversation.entries.map((entry) => entry.kind)).toEqual(["user", "agent"]);
    const [said] = Object.values(conversation.messages);
    expect(said).toMatchObject({ text: "Count the files", at: 1_000_000, state: "taken" });
    expect(Object.values(conversation.turns)[0]).toMatchObject({ model: "claude-haiku-5-5", outcome: "done" });
    const line = conversation.began!;
    expect(line.after).toBe(conversation.entries[1].key);
    send(session.key, "And the tests?");
    fake.turn(handle, "Four of them.");
    expect(agentTexts(conversation)).toEqual(["There are 12.", "Four of them."]);
    expect(conversation.entries.findIndex((entry) => entry.key === line.after)).toBe(1);
  });

  it("of an orchestrator, is drawn above as for any session, and the orchestrator is told its workflow afresh", async () => {
    // It was first told other instructions than the workflow has now.
    adoptWorkflows({ list: [defaultWorkflow()], default: null, overrides: {} });
    sessions.workflows["old-orchestrator"] = {
      workflow: defaultWorkflow(),
      told: "1. Direct the work as it was.",
      project: PROJECT,
    };
    fake.transcript("old-orchestrator", written(1_000_000, "Fix the cache", "Started a session for it."));
    const { session } = await started({ resumedFrom: "old-orchestrator" });
    expect(session.workflow?.name).toBe("Build and review");
    expect(fake.calls.find((call) => call.method === "start")).toMatchObject({
      options: {
        session: "old-orchestrator",
        instructions: orchestratorPrompt(defaultWorkflow()),
        startOnly: true,
        afresh: true,
      },
    });
    const conversation = conversationOf(session.key);
    await vi.waitFor(() => expect(conversation.earlier).toBe("read"));
    expect(agentTexts(conversation)).toEqual(["Started a session for it."]);
    expect(conversation.began!.after).toBe(conversation.entries[1].key);
  });

  it("draws the line at once and goes on under it while what it said before is read, which then goes above", async () => {
    fake.transcript("old-conversation", written(1_000_000, "Count the files", "There are 12."));
    fake.holdHistory();
    const before = Date.now();
    const { session, handle } = await started({ resumedFrom: "old-conversation" });
    const conversation = conversationOf(session.key);
    // The session runs and can be written to while the read is out.
    expect(byKey(session.key)!.status).toBe("running");
    expect(conversation.earlier).toBe("loading");
    expect(conversation.began).toMatchObject({ after: null });
    expect(conversation.began!.at).toBeGreaterThanOrEqual(before);
    send(session.key, "And the tests?");
    fake.turn(handle, "Four of them.");
    expect(agentTexts(conversation)).toEqual(["Four of them."]);
    fake.releaseHistory();
    await vi.waitFor(() => expect(conversation.earlier).toBe("read"));
    expect(conversation.entries.map((entry) => entry.kind)).toEqual(["user", "agent", "user", "agent"]);
    expect(agentTexts(conversation)).toEqual(["There are 12.", "Four of them."]);
    expect(conversation.began!.after).toBe(conversation.entries[1].key);
  });

  it("after a restart, lays what it read as all from before, its open turn over and the line where the new run began", async () => {
    // The app quit in the middle of a turn: its call has no result and the
    // turn no end.
    fake.transcript("old-conversation", [
      ...written(1_000_000, "Count the files", "There are 12."),
      {
        at: 2_000_000,
        event: { type: "message", message: "m-2", state: "sent", error: null, text: "Fix the count", images: [] },
      },
      { at: 2_000_000, event: { type: "turnStarted", messages: ["m-2"] } },
      { at: 2_001_000, event: { type: "toolStarted", call: "c-open", parent: null, name: "Edit", kind: "edit" } },
    ]);
    fake.holdHistory();
    const row = reopened(PROJECT, "old-conversation", "claude-code", null, null, null, "integrated");
    // The core it ran in is gone, so its old handle answers nothing.
    expect(await reattach(row.key, "int-9")).toBe(false);
    const conversation = conversationOf(row.key);
    expect(conversation.earlier).toBe("loading");
    // The row in front starts at once, while the read is still out.
    wake(row.key);
    const before = Date.now();
    await launch(row.key);
    const handle = handleOf(row.key)!;
    expect(conversation.began).toMatchObject({ after: null });
    fake.notice(handle, "Fell back to another model");
    fake.releaseHistory();
    await vi.waitFor(() => expect(conversation.earlier).toBe("read"));
    expect(conversation.entries.map((entry) => entry.kind)).toEqual(["user", "agent", "user", "agent", "note"]);
    expect(conversation.began!.after).toBe(conversation.entries[3].key);
    expect(conversation.began!.at).toBeGreaterThanOrEqual(before);
    expect(conversation.call("c-open")).toMatchObject({ done: true, error: true });
    expect(conversation.current).toBeNull();
    expect(conversation.working).toBe(false);
    expect(byKey(row.key)!.working).toBe(false);
  });

  it("goes on under the run drawn here when it is resumed again, and is not read again", async () => {
    const { session, handle } = await started();
    send(session.key, "go");
    fake.turn(handle, "first answer");
    fake.end(handle, true);
    const conversation = conversationOf(session.key);
    const last = conversation.entries.at(-1)!.key;
    await resume(session.key);
    expect(fake.calls.filter((call) => call.method === "history")).toEqual([]);
    expect(conversation.began?.after).toBe(last);
    expect(conversation.earlier).toBeNull();
  });

  it("is not read for Codex, which says so as it did", async () => {
    const session = create(PROJECT, "codex-thread", "codex", null, null, null, null, undefined, "integrated");
    await launch(session.key);
    const conversation = conversationOf(session.key);
    await vi.waitFor(() => expect(conversation.earlier).toBe("unread"));
    expect(conversation.entries).toEqual([]);
    expect(conversation.began).toBeNull();
  });

  it("is taken up after a reload with the line where a resumed run began", async () => {
    fake.transcript("old-conversation", written(1_000_000, "Count the files", "There are 12."));
    const before = await started({ resumedFrom: "old-conversation" });
    send(before.key, "And the tests?");
    fake.turn(before.handle, "Four of them.");
    resetSessions();
    resetIntegrated();
    stopListening();
    stopListening = await listenIntegrated();
    const row = reopened(PROJECT, "old-conversation", "claude-code", null, null, null, "integrated");
    expect(await reattach(row.key, before.handle)).toBe(true);
    const conversation = conversationOf(row.key);
    expect(agentTexts(conversation)).toEqual(["There are 12.", "Four of them."]);
    expect(conversation.began!.after).toBe(conversation.entries[1].key);
    expect(conversation.late).toBe(false);
  });
});

describe("the workflow a session follows, kept for it", () => {
  // Both agents are here, so a workflow's orchestrator can start on either.
  beforeEach(() => {
    for (const id of ["claude-code", "codex"])
      applyDetect(
        { id, path: `/usr/local/bin/${id}`, caps: { resumable: true, titles: true, acp: false, integrated: true }, fromLoginShell: true },
        true,
      );
  });
  afterEach(() => {
    resetAgent();
    localStorage.removeItem("workbench.workflows");
  });

  it("is the copy its last run started on, so a reload after a resume under an edited workflow follows the edit", async () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: null, overrides: {} });
    const row = create(PROJECT, null, "claude-code", null, null, null, null, defaultWorkflow(), "integrated");
    await launch(row.key);
    const id = byKey(row.key)!.id!;
    fake.stop(handleOf(row.key)!);
    await vi.waitFor(() => expect(byKey(row.key)!.status).toBe("exited"));
    // The workflow is edited, and the session resumed in place under it.
    const edited = { ...defaultWorkflow(), startOnly: false };
    adoptWorkflows({ list: [edited], default: null, overrides: {} });
    await resume(row.key);
    const handle = handleOf(row.key)!;
    expect(fake.calls.filter((call) => call.method === "start").at(-1)).toMatchObject({
      options: { session: id, startOnly: false },
    });
    expect(sessions.workflows[id].workflow).toMatchObject({ startOnly: false });

    // The window reloads while the core goes on running it.
    resetSessions();
    resetIntegrated();
    stopListening();
    stopListening = await listenIntegrated();
    loadRemembered();
    const back = reopened(PROJECT, id, "claude-code", null, null, null, "integrated");
    expect(await reattach(back.key, handle)).toBe(true);
    expect(byKey(back.key)!.workflow).toMatchObject({ name: "Build and review", startOnly: false });
  });

  it("is kept for a Codex session once ready names its thread", async () => {
    const codexFlow = { ...defaultWorkflow(), orchestrator: { agent: "codex" as const, model: "default" } };
    adoptWorkflows({ list: [codexFlow], default: null, overrides: {} });
    const row = create(PROJECT, null, "codex", null, null, null, null, codexFlow, "integrated");
    await launch(row.key);
    const id = byKey(row.key)!.id!;
    expect(id).toBe("agent-thread-1");
    expect(sessions.workflows[id]).toMatchObject({
      workflow: { orchestrator: { agent: "codex" } },
      told: orchestratorPrompt(codexFlow),
    });
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
    // What was said before is read back, and what was heard meanwhile is
    // drawn once, in the turn that still runs.
    expect(conversation.late).toBe(false);
    expect(conversation.earlier).toBe("read");
    expect(conversation.entries.map((entry) => entry.kind)).toEqual(["user", "agent"]);
    expect(Object.values(conversation.messages).map((message) => message.text)).toEqual(["first"]);
    expect(agentTexts(conversation)).toEqual(["meanwhile"]);
    expect(conversation.current).not.toBeNull();
    expect(conversation.began).toBeNull();
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
