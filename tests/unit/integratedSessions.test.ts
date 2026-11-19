import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answer,
  compact,
  configure,
  conversationOf,
  follow,
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
  sendNow,
  sendNowBlocked,
  onTheirWay,
  takeBack,
  trust,
  unspoken,
} from "$lib/integrated.svelte";
import {
  byKey,
  close,
  create,
  isMine,
  loadRemembered,
  markUnread,
  noted,
  onScreenNow,
  reopened,
  runningByToken,
  reset as resetSessions,
  sessions,
  started as startedTerminal,
  ended as endedTerminal,
  label,
  midTurn,
  otherWayFor,
  reopenOtherWay,
  reopeningRow,
  byToken,
  launch as launchTerminal,
  viewed,
  exact,
  belled,
  wake,
} from "$lib/sessions.svelte";
import { modeOf, resetModes } from "$lib/sessionModes";
import { adoptLastChosen, anyChosen, chosenFor, lastChosen, resetLastChosen } from "$lib/lastChosen.svelte";
import { choose } from "$lib/settingChoices";
import { create as createShell, forOwner, reset as resetShells } from "$lib/terminals.svelte";
import { conductor, resetConductor, startedFor } from "$lib/conductor.svelte";
import { attention, resetAttention } from "$lib/attention.svelte";
import { applyDetect, resetAgent } from "$lib/agent.svelte";
import { adoptWorkflows, defaultWorkflow, reset as resetWorkflows, unknowWorkflows } from "$lib/workflows.svelte";
import { adoptAccounts, reset as resetAccounts } from "$lib/accounts.svelte";
import { orchestratorPrompt } from "$lib/workflowInstructions";
import { limitsOf, resetLimits } from "$lib/limits.svelte";
import { fakeIntegrated, type FakeIntegrated, type FakeIntegratedOptions } from "../fakeIntegrated";

const PROJECT = "/home/ada/dev/demo";

let fake: FakeIntegrated;

/** The terminal side of the fake core, made new for each test. */
const pty = {
  spawned: [] as { session?: string; mode?: string; agent?: string }[],
  written: [] as [string, string][],
  killed: [] as string[],
  onWrite: (_id: string, _data: string) => {},
};
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
    integratedSendNow: async (id: string) => fake.sendNow(id),
    integratedWithdraw: async (id: string, message: string) => fake.withdraw(id, message),
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
    // A terminal session: what each spawn asked for, what was typed to a
    // pty, and which were killed.
    spawn: async (options: { session?: string }) => {
      pty.spawned.push(options);
      return { ptyId: `pty-${100 + pty.spawned.length}`, sessionId: options.session ?? null };
    },
    write: async (id: string, data: string) => {
      pty.written.push([id, data]);
      pty.onWrite(id, data);
    },
    kill: async (id: string) => {
      pty.killed.push(id);
    },
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
  resetAccounts();
  pty.spawned = [];
  pty.written = [];
  pty.killed = [];
  pty.onWrite = () => {};
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

  // Claude Code compacts a long conversation by itself before its cache
  // expires, in a turn of its own with nothing said: housekeeping, which
  // leaves a read row read and puts no old line back under its name.
  it("takes a compaction the agent does by itself while idle for nothing new", async () => {
    const { session, handle } = await started();
    attention.focused = false;
    send(session.key, "go");
    fake.turn(handle, "All green.");
    expect(session.unread).toBe(true);
    expect(session.note).toBe("All green.");
    attention.focused = true;
    sessions.active = session.key;
    viewed(session.key);
    attention.focused = false;

    fake.emit(handle, { type: "turnStarted", messages: [] });
    fake.compaction(handle);
    fake.context(handle, 20_000, 200_000);
    fake.notice(handle, "Context compacted.");
    fake.endTurn(handle);
    expect(session.working).toBe(false);
    expect(session.unread).toBe(false);
    expect(session.note).toBeNull();

    // A turn of its own that says something is news.
    fake.emit(handle, { type: "turnStarted", messages: [] });
    fake.emit(handle, { type: "text", block: "r", parent: null, text: "The review is back.", done: true });
    fake.endTurn(handle);
    expect(session.unread).toBe(true);
    expect(session.note).toBe("The review is back.");
  });

  it("shows the line its last turn ended on when marked unread, and none once a message is sent", async () => {
    const { session, handle } = await started();
    attention.focused = false;
    send(session.key, "go");
    fake.turn(handle, "All green.");
    attention.focused = true;
    sessions.active = session.key;
    viewed(session.key);
    sessions.active = null;
    expect(session.note).toBeNull();

    markUnread(session.key);
    expect(session.unread).toBe(true);
    expect(session.note).toBe("All green.");

    viewed(session.key);
    send(session.key, "next");
    markUnread(session.key);
    expect(session.note).toBeNull();
  });

  it("ends a mark when the user writes to the session, and keeps it through a director's message", async () => {
    const { session, handle } = await started();
    attention.focused = true;
    sessions.active = session.key;
    send(session.key, "go");
    fake.turn(handle, "All green.");
    onScreenNow(session.key);
    viewed(session.key);

    // Marked on screen, then a director writes to it: still marked.
    markUnread(session.key);
    send(session.key, "from the starter", [], "Starter");
    viewed(session.key);
    expect(session.unread).toBe(true);

    // The user writes to it: read, and the hold is gone.
    send(session.key, "carry on please");
    expect(session.unread).toBe(false);
    attention.focused = false;
    fake.turn(handle, "Carried on.");
    expect(session.unread).toBe(true);
    expect(session.note).toBe("Carried on.");
    attention.focused = true;
    viewed(session.key);
    expect(session.unread).toBe(false);
  });

  it("announces the turn that ends over a mark with its own words", async () => {
    const { session, handle } = await started();
    attention.focused = false;
    send(session.key, "go");
    fake.turn(handle, "First words.");
    viewed(session.key);
    markUnread(session.key);
    expect(session.note).toBe("First words.");
    fake.emit(handle, { type: "turnStarted", messages: [] });
    fake.emit(handle, { type: "text", block: "n", parent: null, text: "Newer words.", done: true });
    fake.endTurn(handle);
    expect(session.unread).toBe(true);
    expect(session.note).toBe("Newer words.");
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

  it("sends the waiting messages now by interrupting Claude Code's turn, and they start the next at once", async () => {
    const { session, handle } = await started();
    const conversation = conversationOf(session.key);
    send(session.key, "go");
    fake.startTurn(handle);
    expect(sendNowBlocked(session.key)).toBe("No message waits");
    const first = send(session.key, "and this")!;
    const second = send(session.key, "and that")!;
    await settled();
    expect(sendNowBlocked(session.key)).toBeNull();
    const going = sendNow(session.key);
    // On their way, with nothing said yet of how: the agent decides
    // whether the turn stops.
    expect(onTheirWay(session.key)).toBe(true);
    expect(conversation.interrupting).toBe(false);
    expect(await going).toBe(true);
    await settled();
    expect(conversation.turns[1].outcome).toBe("interrupted");
    // One turn for both, in the order sent.
    expect(conversation.turns[2].messages).toEqual([first, second]);
    expect(conversation.waiting).toEqual([]);
    expect(onTheirWay(session.key)).toBe(false);
  });

  it("leaves the next turn going when the agent says it stopped the last only after the next began", async () => {
    const { session, handle } = await started();
    const conversation = conversationOf(session.key);
    send(session.key, "go");
    fake.startTurn(handle);
    const waiting = send(session.key, "and this")!;
    await settled();
    // The turn's end and the next turn's start are heard before the answer.
    fake.sendNow = (id) => {
      fake.endTurn(id, "interrupted");
      fake.startTurn(id, [waiting]);
      return { sendNow: "stopped" };
    };
    expect(await sendNow(session.key)).toBe(true);
    expect(conversation.turns[2].messages).toEqual([waiting]);
    expect(conversation.current).toBe(2);
    expect(conversation.interrupting).toBe(false);
  });

  it("keeps Codex's steered messages on their way until Codex takes them", async () => {
    await install({ holding: true, mints: true });
    const session = create(PROJECT, null, "codex", null, null, null, null, undefined, "integrated");
    await launch(session.key);
    const handle = handleOf(session.key)!;
    send(session.key, "go");
    fake.startTurn(handle);
    const waiting = send(session.key, "and this")!;
    await settled();
    fake.holdSteers = true;
    expect(await sendNow(session.key)).toBe(true);
    // Answered, and not yet taken: neither sent again nor taken back.
    expect(onTheirWay(session.key)).toBe(true);
    expect(sendNowBlocked(session.key)).toBe("Sending it now");
    fake.releaseSteers();
    expect(conversationOf(session.key).messages[waiting].state).toBe("taken");
    expect(onTheirWay(session.key)).toBe(false);
  });

  it("puts a message taken back in the composer when the agent lets go of it, though the answer is lost", async () => {
    const { session, handle } = await started();
    const link = linkFor(session.key);
    send(session.key, "go");
    fake.startTurn(handle);
    const waiting = send(session.key, "a thought to finish")!;
    await settled();
    link.draft = "something new";
    fake.withdrawAnswer = "the agent did not answer in time";
    expect(await takeBack(session.key, waiting)).toBe(true);
    expect(conversationOf(session.key).messages[waiting]).toBeUndefined();
    expect(link.draft).toBe("a thought to finish\n\nsomething new");
    expect(link.nowError).toBeNull();
  });

  it("lets a failed try go once the turn moves on", async () => {
    const { session, handle } = await started();
    const link = linkFor(session.key);
    send(session.key, "go");
    fake.startTurn(handle);
    const taken = send(session.key, "and that")!;
    await settled();
    fake.startTurn(handle, [taken]);
    expect(await takeBack(session.key, taken)).toBe(false);
    expect(link.nowError).not.toBeNull();
    fake.endTurn(handle);
    expect(link.nowError).toBeNull();
  });

  it("says why the waiting messages cannot go now", async () => {
    const { session, handle } = await started();
    send(session.key, "go");
    fake.startTurn(handle);
    send(session.key, "and this");
    await settled();
    fake.ask(handle, "Bash", { command: "ls" });
    expect(sendNowBlocked(session.key)).toBe("Answer the request below first");
    expect(await sendNow(session.key)).toBe(false);
    expect(fake.calls.some((call) => call.method === "sendNow")).toBe(false);
  });

  it("steers the messages held for Codex into its running turn", async () => {
    await install({ holding: true, mints: true });
    const session = create(PROJECT, null, "codex", null, null, null, null, undefined, "integrated");
    await launch(session.key);
    const handle = handleOf(session.key)!;
    const conversation = conversationOf(session.key);
    send(session.key, "go");
    fake.startTurn(handle);
    const waiting = send(session.key, "and this")!;
    await settled();
    expect(await sendNow(session.key)).toBe(true);
    expect(conversation.interrupting).toBe(false);
    await settled();
    expect(conversation.messages[waiting].state).toBe("taken");
    expect(conversation.turns[1].messages).toContain(waiting);
    expect(conversation.current).not.toBeNull();
  });

  it("takes a waiting message back, and says so when the agent took it first", async () => {
    const { session, handle } = await started();
    const conversation = conversationOf(session.key);
    send(session.key, "go");
    fake.startTurn(handle);
    const waiting = send(session.key, "and this")!;
    await settled();
    expect(await takeBack(session.key, waiting)).toBe(true);
    expect(conversation.messages[waiting]).toBeUndefined();
    expect(conversation.waiting).toEqual([]);
    const taken = send(session.key, "and that")!;
    await settled();
    fake.startTurn(handle, [taken]);
    expect(await takeBack(session.key, taken)).toBe(false);
    expect(linkFor(session.key).nowError).toBe("Not taken back: the agent has taken the message already");
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

  it("is read for Codex from the thread Codex keeps", async () => {
    fake.transcript("codex-thread", written(1_000_000, "Count the files", "There are 12."), "codex");
    const session = create(PROJECT, "codex-thread", "codex", null, null, null, null, undefined, "integrated");
    await launch(session.key);
    const conversation = conversationOf(session.key);
    await vi.waitFor(() => expect(conversation.earlier).toBe("read"));
    expect(agentTexts(conversation)).toEqual(["There are 12."]);
    expect(fake.calls.find((call) => call.method === "history")).toMatchObject({
      options: { agent: "codex", session: "codex-thread" },
    });
  });

  it("is read under the session's account once the settings say where it keeps it, as it is started", async () => {
    fake.transcript("old-conversation", written(1_000_000, "Count the files", "There are 12."), "claude-code", "~/.claude-work");
    // The window does not have the settings yet.
    unknowWorkflows();
    const row = reopened(PROJECT, "old-conversation", "claude-code", "/home/ada/dev/demo/.claude/worktrees/fix", null, "Work", "integrated");
    wake(row.key);
    const launching = launch(row.key);
    await settled();
    expect(fake.calls.filter((call) => call.method === "history" || call.method === "start")).toEqual([]);
    const conversation = conversationOf(row.key);
    expect(conversation.earlier).toBe("loading");
    expect(conversation.began).toMatchObject({ after: null });
    adoptAccounts({ list: { Work: { claude: "~/.claude-work", codex: null } }, everywhere: null, overrides: {} });
    adoptWorkflows({ list: [defaultWorkflow()], default: null, overrides: {} });
    await launching;
    await vi.waitFor(() => expect(conversation.earlier).toBe("read"));
    const read = { agent: "claude-code", project: PROJECT, cwd: "/home/ada/dev/demo/.claude/worktrees/fix", session: "old-conversation", configDir: "~/.claude-work" };
    expect(fake.calls.find((call) => call.method === "history")).toEqual({ method: "history", options: read });
    expect(fake.calls.find((call) => call.method === "start")).toMatchObject({
      options: { session: "old-conversation", cwd: read.cwd, configDir: read.configDir },
    });
    expect(agentTexts(conversation)).toEqual(["There are 12."]);
  });

  it("says its earlier messages were not read, and why, when the agent kept no record of a session it resumes", async () => {
    const { session, handle } = await started({ resumedFrom: "never-written" });
    const conversation = conversationOf(session.key);
    await vi.waitFor(() => expect(conversation.earlier).toBe("unread"));
    expect(conversation.earlierWhy).toBe("Claude Code has no transcript of it in ~/.claude");
    // The session goes on, written to as ever.
    send(session.key, "Where are we?");
    fake.turn(handle, "Here.");
    expect(agentTexts(conversation)).toEqual(["Here."]);
    expect(conversation.earlier).toBe("unread");
  });

  it("does not take an empty record of a session it resumes for one with nothing before", async () => {
    fake.transcript("emptied", []);
    const { session } = await started({ resumedFrom: "emptied" });
    const conversation = conversationOf(session.key);
    await vi.waitFor(() => expect(conversation.earlier).toBe("unread"));
    expect(conversation.earlierWhy).toBe("Claude Code's record of it holds no messages");
  });

  it("is not read for a session nothing was said in, which ended and is resumed", async () => {
    const { session, handle } = await started();
    fake.end(handle, false);
    await resume(session.key);
    const conversation = conversationOf(session.key);
    expect(fake.calls.filter((call) => call.method === "history")).toEqual([]);
    expect(conversation.earlier).toBeNull();
    // Nor when it ends again before anything is said.
    fake.end(handleOf(session.key)!, false);
    await resume(session.key);
    expect(fake.calls.filter((call) => call.method === "history")).toEqual([]);
    expect(conversation.earlier).toBeNull();
  });

  it("says why when Codex cannot read the thread, and leaves the session as it is", async () => {
    const session = create(PROJECT, "codex-unknown", "codex", null, null, null, null, undefined, "integrated");
    await launch(session.key);
    const conversation = conversationOf(session.key);
    await vi.waitFor(() => expect(conversation.earlier).toBe("unread"));
    expect(conversation.earlierWhy).toBe("Codex does not have this conversation");
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

  // What the turn did before the reload is not heard again: its end is
  // news whatever comes after the window takes it up.
  it("marks a turn that ran across the reload when it ends, with nothing said after it", async () => {
    const before = await started();
    send(before.key, "run the tests");
    fake.startTurn(before.handle);
    fake.emit(before.handle, { type: "text", block: "t", parent: null, text: "All green.", done: true });
    resetSessions();
    resetIntegrated();
    stopListening();
    stopListening = await listenIntegrated();
    const row = reopened(PROJECT, "integrated-session-1", "claude-code", null, null, null, "integrated");
    expect(await reattach(row.key, before.handle)).toBe(true);
    const session = byKey(row.key)!;
    expect(session.working).toBe(true);
    attention.focused = false;

    fake.endTurn(before.handle);
    expect(session.working).toBe(false);
    expect(session.unread).toBe(true);
    expect(session.note).toBe("All green.");
  });

  it("is taken up under the id it was named by only once that run has said the id", async () => {
    // A run the version before named by its id, still going after a reload.
    fake.transcript("old-run", written(1_000_000, "Count the files", "There are 12."));
    const before = await started({ resumedFrom: "old-run" });
    resetSessions();
    resetIntegrated();
    stopListening();
    stopListening = await listenIntegrated();
    const row = reopened(PROJECT, "old-run", "claude-code", null, null, null, "integrated", null, true, "old-run");
    expect(await reattach(row.key, before.handle)).toBe(true);
    expect(byKey(row.key)!.token).toBe("old-run");
    expect(runningByToken("old-run")?.key).toBe(row.key);
    // A newer session the core numbered the same, which has not said its
    // id yet, is not taken for it.
    resetSessions();
    resetIntegrated();
    stopListening();
    stopListening = await listenIntegrated();
    fake.holdReady = true;
    const newer = await started();
    resetSessions();
    resetIntegrated();
    stopListening();
    stopListening = await listenIntegrated();
    const stale = reopened(PROJECT, "old-gone", "claude-code", null, null, null, "integrated", null, true, "old-gone");
    expect(await reattach(stale.key, newer.handle)).toBe(false);
    expect(byKey(stale.key)!.status).toBe("dormant");
    expect(runningByToken("old-gone")).toBeNull();
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
  const starts = () => fake.calls.filter((call) => call.method === "start");

  beforeEach(async () => {
    localStorage.removeItem("workbench.modes");
    resetModes();
    stopListening();
    await install({ defaultMode: "auto" });
  });

  it("is named by none for a new session, so the agent's own settings decide as in a terminal", async () => {
    const { session } = await started();
    expect(starts()[0]).toMatchObject({ method: "start" });
    expect((starts()[0] as { options: { mode?: string } }).options.mode).toBeUndefined();
    // The agent says the mode its settings start it in, and the session
    // runs in it.
    expect(conversationOf(session.key).settings.mode).toBe("auto");
    const codex = create(PROJECT, null, "codex", null, null, null, null, undefined, "integrated");
    await launch(codex.key);
    expect((starts()[1] as { options: { agent: string; mode?: string } }).options).toMatchObject({ agent: "codex" });
    expect((starts()[1] as { options: { mode?: string } }).options.mode).toBeUndefined();
  });

  it("is the one the session last ran in when it starts again", async () => {
    const { session, handle } = await started();
    await configure(session.key, { mode: "plan" });
    expect(startMode(session, linkFor(session.key))).toBe("plan");
    fake.end(handle, true);
    await resume(session.key);
    expect(starts().at(-1)).toMatchObject({ options: { mode: "plan" } });
  });

  it("leaves a mode from the agent's own settings that it does not offer to those settings, rather than one that asks", async () => {
    const { session } = await started();
    linkFor(session.key).conversation.settings.mode = "bypassPermissions";
    expect(startMode(session, linkFor(session.key))).toBeUndefined();
  });

  it("is kept for the conversation across a restart, and goes to no other", async () => {
    const { session, handle } = await started();
    const id = session.id!;
    await configure(session.key, { mode: "acceptEdits" });
    fake.end(handle, true);
    close(session.key);
    // The window starts again: what it keeps in memory is gone.
    resetModes();
    resetIntegrated();
    const again = await started({ resumedFrom: id });
    expect(starts().at(-1)).toMatchObject({ options: { session: id, mode: "acceptEdits" } });
    expect(again.session.id).toBe(id);
    // Another conversation, and a new one another session starts, take
    // none of it: the agent's settings decide for each.
    await started({ resumedFrom: "another-conversation" });
    expect((starts().at(-1) as { options: { mode?: string } }).options.mode).toBeUndefined();
    await started({ prompt: "Fix the flaky test" });
    expect((starts().at(-1) as { options: { mode?: string } }).options.mode).toBeUndefined();
  });

  it("is let go when a mode the agent does not offer replaces it, and once a terminal run of the conversation has shut down", async () => {
    const { session } = await started();
    const id = session.id!;
    await configure(session.key, { mode: "plan" });
    expect(modeOf(id)).toBe("plan");
    fake.emit(handleOf(session.key)!, { type: "configured", model: null, mode: "bypassPermissions", effort: null, efforts: [] });
    expect(modeOf(id)).toBeNull();
    await configure(session.key, { mode: "plan" });
    expect(modeOf(id)).toBe("plan");
    // A terminal run of it holds the record until it ends; shut down by
    // itself, it has written its own mode down.
    const terminal = create(PROJECT, id, "claude-code", null, null, null, null, undefined, "terminal");
    startedTerminal(terminal.key, "pty-1", id);
    expect(modeOf(id)).toBe("plan");
    endedTerminal({ id: "pty-1", code: 0, clean: true });
    expect(modeOf(id)).toBeNull();
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

describe("a session reopened the other way", () => {
  beforeEach(() => {
    localStorage.removeItem("workbench.modes");
    resetModes();
    resetShells();
    resetConductor();
    applyDetect(
      {
        id: "claude-code",
        path: "/usr/local/bin/claude-code",
        caps: { resumable: true, titles: true, acp: false, integrated: true },
        fromLoginShell: true,
      },
      true,
    );
  });
  afterEach(() => {
    resetAgent();
    resetConductor();
    resetShells();
  });

  /** A conversation that was spoken to and answered, so there is a
      conversation to go on with. */
  async function spoken() {
    const made = await started();
    send(made.key, "Go");
    fake.turn(made.handle, "Done.");
    return { ...made, session: byKey(made.key)! };
  }

  /** A terminal row of a conversation, its process up. */
  function terminalRow(id: string) {
    const row = create(PROJECT, id, "claude-code", null, null, null, null, undefined, "terminal");
    startedTerminal(row.key, "pty-7", id);
    return byKey(row.key)!;
  }

  it("goes on with a terminal session as a conversation once its process has ended, in the same row", async () => {
    const row = terminalRow("conversation-1");
    const { key, token, ordinal } = row;
    const name = label(row);
    expect(otherWayFor(row)).toBe("integrated");
    const reopening = reopenOtherWay(key);
    // Its process is asked to end, and nothing starts until it has.
    await settled();
    expect(byKey(key)!.kind).toBe("terminal");
    expect(otherWayFor(byKey(key)!)).toBeNull();
    endedTerminal({ id: "pty-7", code: 0, clean: true });
    await reopening;
    const now = byKey(key)!;
    expect(now).toMatchObject({ kind: "integrated", status: "starting", resumedFrom: "conversation-1", token, ordinal });
    expect(label(now)).toBe(name);
    // Its end was the user's doing, and no news.
    expect(now.unread).toBe(false);
    await launch(key);
    expect(fake.calls.find((call) => call.method === "start")).toMatchObject({
      options: { session: "conversation-1", token },
    });
    expect(sessions.all.filter((one) => one.id === "conversation-1")).toHaveLength(1);
  });

  it("goes on with a conversation in a terminal once its agent has ended, in the same row", async () => {
    const { session, key } = await spoken();
    const id = session.id!;
    const token = session.token;
    await reopenOtherWay(key);
    const now = byKey(key)!;
    expect(fake.calls.some((call) => call.method === "stop")).toBe(true);
    expect(now).toMatchObject({ kind: "terminal", status: "starting", resumedFrom: id, token, ptyId: null });
    expect(handleOf(key)).toBeNull();
    expect(now.unread).toBe(false);
  });

  it("is offered for a session whose conversation is known and whose agent runs both ways", async () => {
    const { session } = await started();
    expect(otherWayFor(session)).toBe("terminal");
    const fresh = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "terminal");
    expect(otherWayFor(fresh)).toBeNull();
    resetAgent();
    expect(otherWayFor(session)).toBeNull();
  });

  it("asks first while a turn runs", async () => {
    const { session, handle } = await started();
    expect(midTurn(session)).toBe(false);
    send(session.key, "Go");
    fake.emit(handle, { type: "state", state: "working" });
    expect(midTurn(byKey(session.key)!)).toBe(true);
  });

  it("is never seen ended: the row goes from its run straight to the next", async () => {
    const row = terminalRow("conversation-1");
    const statuses: string[] = [];
    const reopening = reopenOtherWay(row.key);
    await settled();
    statuses.push(byKey(row.key)!.status);
    endedTerminal({ id: "pty-7", code: 0, clean: true });
    // Inside the end itself the row is already the other way.
    statuses.push(byKey(row.key)!.status);
    expect(await reopening).toBe(true);
    expect(statuses).toEqual(["running", "starting"]);
    expect(reopeningRow(row.key)).toBe(true);
    // Until the next run is up.
    await launch(row.key);
    expect(byKey(row.key)!.status).toBe("running");
    expect(reopeningRow(row.key)).toBe(false);
  });

  it("keeps a row read at rest read, there and back, through what each stopped run does and the agent's notice after", async () => {
    const row = terminalRow("conversation-1");
    attention.focused = true;
    sessions.active = row.key;
    viewed(row.key);
    attention.focused = false;
    // On its way out the terminal's hooks say it stopped, and it rings.
    pty.onWrite = (id) => {
      if (pty.written.filter(([on, data]) => on === id && data === "\x03").length < 2) return;
      exact("conversation-1", "stop");
      belled(row.key);
      endedTerminal({ id, code: 0, clean: true });
    };
    expect(await reopenOtherWay(row.key)).toBe(true);
    expect(byKey(row.key)!.unread).toBe(false);
    await launch(row.key);
    expect(await reopenOtherWay(row.key)).toBe(true);
    await launchTerminal(row.key, 80, 24, () => {});
    expect(byKey(row.key)).toMatchObject({ kind: "terminal", status: "running", unread: false });
    // A minute on, Claude Code says again that it waits, and rings for it.
    exact("conversation-1", "idle");
    belled(row.key);
    expect(byKey(row.key)!.unread).toBe(false);
    // A turn of its own is news.
    exact("conversation-1", "prompt");
    exact("conversation-1", "stop");
    expect(byKey(row.key)!.unread).toBe(true);
  });

  it("goes on in a terminal in the mode the user last chose, and in none the agent does not offer", async () => {
    stopListening();
    await install({ defaultMode: "auto" });
    const { session, key } = await spoken();
    expect(conversationOf(key).settings.mode).toBe("auto");
    await configure(key, { mode: "default" });
    await reopenOtherWay(key);
    await launchTerminal(key, 80, 24, () => {});
    expect(pty.spawned.at(-1)).toMatchObject({ session: session.id, mode: "default" });
    // The terminal run holds the record until it ends.
    expect(modeOf(session.id!)).toBe("default");
    // A run in a mode from the agent's own settings that it offers no
    // switch to names none: the terminal's settings decide again.
    const other = await spoken();
    fake.emit(other.handle, { type: "configured", model: null, mode: "bypassPermissions", effort: null, efforts: [] });
    await reopenOtherWay(other.key);
    await launchTerminal(other.key, 80, 24, () => {});
    expect(pty.spawned.at(-1)!.mode).toBeUndefined();
  });

  /** The integrated start the fake core was last asked for. */
  const lastStart = () =>
    (fake.calls.filter((call) => call.method === "start").at(-1) as { options: { mode?: string } }).options;

  it("keeps the mode the user last chose through a terminal run that is killed, and leaves it to the agent once one shuts down", async () => {
    stopListening();
    await install({ defaultMode: "auto" });
    const { session, key } = await spoken();
    const id = session.id!;
    await configure(key, { mode: "default" });
    await reopenOtherWay(key);
    await launchTerminal(key, 80, 24, () => {});
    // Killed, as a stop on Windows or a crash ends it, the terminal wrote
    // no mode down: the conversation goes on in the user's last choice.
    endedTerminal({ id: byKey(key)!.ptyId!, code: 1, clean: false });
    expect(byKey(key)!.status).toBe("crashed");
    expect(modeOf(id)).toBe("default");
    await reopenOtherWay(key);
    await launch(key);
    expect(lastStart().mode).toBe("default");
    // Shut down by a quit or a hang-up, it wrote its own: the agent's
    // record of that run decides.
    for (const shutdown of [
      { code: 0, clean: true },
      { code: 129, clean: false },
    ]) {
      await configure(key, { mode: "default" });
      await reopenOtherWay(key);
      await launchTerminal(key, 80, 24, () => {});
      expect(modeOf(id)).toBe("default");
      const pid = byKey(key)!.ptyId!;
      pty.onWrite = (on) => {
        if (on === pid && pty.written.filter(([at, data]) => at === pid && data === "\x03").length === 2)
          endedTerminal({ id: pid, ...shutdown });
      };
      expect(await reopenOtherWay(key)).toBe(true);
      expect(modeOf(id)).toBeNull();
      await launch(key);
      expect(lastStart().mode).toBeUndefined();
    }
  });

  it("lets the end of a closed row's terminal run decide, and lets go at the window's start of a mode a run still held", async () => {
    stopListening();
    await install({ defaultMode: "auto" });
    for (const [end, kept] of [
      [{ code: 1, clean: false }, "plan"],
      [{ code: 0, clean: true }, null],
    ] as const) {
      const { session, key } = await spoken();
      const id = session.id!;
      await configure(key, { mode: "plan" });
      await reopenOtherWay(key);
      await launchTerminal(key, 80, 24, () => {});
      const ptyId = byKey(key)!.ptyId!;
      close(key);
      expect(modeOf(id)).toBe("plan");
      expect(endedTerminal({ id: ptyId, ...end })).toBe(true);
      expect(modeOf(id)).toBe(kept);
    }
    // A terminal run still up when the window goes, as at a quit, which
    // hangs up on it: its agent writes its own down.
    const { session, key } = await spoken();
    const id = session.id!;
    await configure(key, { mode: "acceptEdits" });
    const other = await spoken();
    await configure(other.key, { mode: "plan" });
    await reopenOtherWay(key);
    await launchTerminal(key, 80, 24, () => {});
    resetModes();
    expect(modeOf(id)).toBeNull();
    // A record no terminal run held is kept.
    expect(modeOf(other.session.id!)).toBe("plan");
  });

  it("goes on in the mode chosen while it is being reopened, or asked just before and not answered", async () => {
    stopListening();
    await install({ defaultMode: "auto" });
    const seam = (window as unknown as { __WORKBENCH_CORE__: Record<string, (...args: never[]) => unknown> })
      .__WORKBENCH_CORE__;
    const stopNow = seam.integratedStop;
    let release = () => {};
    seam.integratedStop = (async (handle: string) => {
      release = () => void stopNow(handle as never);
    }) as never;
    const { session, key } = await spoken();
    const reopening = reopenOtherWay(key);
    await settled();
    // The run is on its way out, and the user turns the chip.
    const asked = fake.calls.filter((call) => call.method === "configure").length;
    await configure(key, { mode: "default" });
    expect(conversationOf(key).settings.mode).toBe("default");
    expect(fake.calls.filter((call) => call.method === "configure")).toHaveLength(asked);
    expect(modeOf(session.id!)).toBe("default");
    release();
    expect(await reopening).toBe(true);
    await launchTerminal(key, 80, 24, () => {});
    expect(pty.spawned.at(-1)).toMatchObject({ session: session.id, mode: "default" });

    // A change asked of the run that it has not answered when the reopen
    // stops it.
    const other = await spoken();
    const configureNow = seam.integratedConfigure;
    seam.integratedConfigure = (() => new Promise(() => {})) as never;
    void configure(other.key, { mode: "plan" });
    await settled();
    const again = reopenOtherWay(other.key);
    await settled();
    release();
    expect(await again).toBe(true);
    await launchTerminal(other.key, 80, 24, () => {});
    expect(pty.spawned.at(-1)).toMatchObject({ session: other.session.id, mode: "plan" });
    seam.integratedConfigure = configureNow;
    seam.integratedStop = stopNow;
  });

  it("starts a session another started in the mode its starter gave it, integrated and in a terminal", async () => {
    const given = create(PROJECT, null, "claude-code", null, "Fix it", null, null, undefined, "integrated");
    given.modeGiven = "auto";
    await launch(given.key);
    expect(lastStart().mode).toBe("auto");
    expect(conversationOf(given.key).settings.mode).toBe("auto");
    // Started again before anything was said, it takes that mode again.
    expect(startMode(byKey(given.key)!, linkFor(given.key))).toBe("auto");
    const term = create(PROJECT, null, "claude-code", null, "Fix it", null, null, undefined, "terminal");
    term.modeGiven = "acceptEdits";
    await launchTerminal(term.key, 80, 24, () => {});
    expect(pty.spawned.at(-1)).toMatchObject({ mode: "acceptEdits" });
    expect(byKey(term.key)!.modeNamed).toBe("acceptEdits");
    // A resumed one goes on in the mode its conversation last ran in.
    const back = create(PROJECT, "old-1", "claude-code", null, null, null, null, undefined, "terminal");
    back.modeGiven = "acceptEdits";
    await launchTerminal(back.key, 80, 24, () => {});
    expect(pty.spawned.at(-1)!.mode).toBeUndefined();
  });

  it("runs one whose agent does not take the mode it was given in the nearest narrower one", async () => {
    stopListening();
    // The agent starts in Default whatever it is asked, as where the
    // account has no auto.
    await install({ ownMode: "default" });
    const row = create(PROJECT, null, "claude-code", null, "Fix it", null, null, undefined, "integrated");
    row.modeGiven = "auto";
    await launch(row.key);
    await vi.waitFor(() => expect(conversationOf(row.key).settings.mode).toBe("acceptEdits"));
    expect(fake.calls.filter((call) => call.method === "configure").at(-1)).toMatchObject({ settings: { mode: "acceptEdits" } });
    await vi.waitFor(() =>
      expect(conversationOf(row.key).entries.at(-1)).toMatchObject({
        kind: "note",
        text: "The session that started it runs in Auto mode, so it runs in Accept edits mode, the nearest below that it can take.",
      }),
    );
    // One the user started is left in the mode its agent chose.
    const own = await started();
    expect(conversationOf(own.key).settings.mode).toBe("default");
    expect(fake.calls.filter((call) => call.method === "configure")).toHaveLength(1);
  });

  it("leaves no line on the row from what the run it stops says on its way out", async () => {
    const { key, handle } = await started();
    // Nobody looks at it.
    attention.focused = false;
    send(key, "Go");
    fake.startTurn(handle);
    fake.emit(handle, { type: "state", state: "working" });
    fake.emit(handle, { type: "text", block: "b-1", parent: null, text: "Halfway through the fix", done: true });
    const seam = (window as unknown as { __WORKBENCH_CORE__: Record<string, (...args: never[]) => unknown> })
      .__WORKBENCH_CORE__;
    const stopNow = seam.integratedStop;
    let release = () => {};
    seam.integratedStop = (async (id: string) => {
      release = () => void stopNow(id as never);
    }) as never;
    const reopening = reopenOtherWay(key);
    await settled();
    // Its turn ends as it goes, and it comes to rest.
    fake.endTurn(handle, "interrupted");
    fake.emit(handle, { type: "state", state: "idle" });
    release();
    expect(await reopening).toBe(true);
    seam.integratedStop = stopNow;
    await launchTerminal(key, 80, 24, () => {});
    expect(byKey(key)).toMatchObject({ kind: "terminal", note: null, unread: false });

    // A terminal's stop hook on its way out says the same.
    const row = terminalRow("conversation-1");
    pty.onWrite = (id) => {
      if (pty.written.filter(([on, data]) => on === id && data === "\x03").length < 2) return;
      exact("conversation-1", "stop", "Fixed the flaky test");
      endedTerminal({ id, code: 0, clean: true });
    };
    expect(await reopenOtherWay(row.key)).toBe(true);
    expect(byKey(row.key)).toMatchObject({ kind: "integrated", note: null, unread: false });
  });

  it("quits a terminal Claude Code session as the user would, and kills it only if it does not go", async () => {
    const row = terminalRow("conversation-1");
    // It quits on the second Ctrl+C, as Claude Code does at its prompt.
    pty.onWrite = (id) => {
      if (pty.written.filter(([on, data]) => on === id && data === "\x03").length === 2)
        endedTerminal({ id, code: 0, clean: true });
    };
    expect(await reopenOtherWay(row.key)).toBe(true);
    expect(pty.written).toEqual([
      ["pty-7", "\x03"],
      ["pty-7", "\x03"],
    ]);
    expect(pty.killed).toEqual([]);
    expect(byKey(row.key)!.kind).toBe("integrated");
  });

  it("hangs up on a terminal session that the presses do not end, and on Codex at once", async () => {
    applyDetect(
      { id: "codex", path: "/usr/local/bin/codex", caps: { resumable: true, titles: true, acp: false, integrated: true }, fromLoginShell: true },
      true,
    );
    const codex = create(PROJECT, "thread-1", "codex", null, null, null, null, undefined, "terminal");
    startedTerminal(codex.key, "pty-8", "thread-1");
    const reopening = reopenOtherWay(codex.key);
    await settled();
    expect(pty.written).toEqual([]);
    expect(pty.killed).toEqual(["pty-8"]);
    endedTerminal({ id: "pty-8", code: 0, clean: true });
    expect(await reopening).toBe(true);
  });

  it("is given up, leaving the row as it was, when the run does not stop in time", async () => {
    vi.useFakeTimers();
    try {
      const row = terminalRow("conversation-1");
      const reopening = reopenOtherWay(row.key);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await reopening).toBe(false);
      // Pressed, then hung up on, and still there.
      expect(pty.written.length).toBeGreaterThan(0);
      expect(pty.killed).toEqual(["pty-7"]);
      expect(byKey(row.key)).toMatchObject({ kind: "terminal", status: "running", ptyId: "pty-7" });
      expect(reopeningRow(row.key)).toBe(false);
      expect(otherWayFor(byKey(row.key)!)).toBe("integrated");
      // An end that comes later is an end like any other.
      endedTerminal({ id: "pty-7", code: 0, clean: true });
      expect(byKey(row.key)).toMatchObject({ kind: "terminal", status: "exited" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the shells beside the session and the sessions it started", async () => {
    const row = terminalRow("conversation-1");
    const shell = createShell({ project: PROJECT, session: row.key });
    const kid = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "terminal");
    conductor.startedBy[kid.key] = row.token;
    const reopening = reopenOtherWay(row.key);
    await settled();
    endedTerminal({ id: "pty-7", code: 0, clean: true });
    await reopening;
    expect(forOwner({ project: PROJECT, session: row.key }).map((one) => one.key)).toEqual([shell.key]);
    expect(startedFor(kid.key)).toBe(byKey(row.key)!.token);
    expect(byToken(byKey(row.key)!.token)?.key).toBe(row.key);
    expect(byKey(kid.key)).not.toBeNull();
  });

  it("reopens a session another started, which stays its starter's", async () => {
    const starter = terminalRow("conversation-0");
    const { session, key } = await started({ prompt: "Fix the flaky test" });
    conductor.startedBy[key] = starter.token;
    const token = session.token;
    expect(await reopenOtherWay(key)).toBe(true);
    expect(byKey(key)).toMatchObject({ kind: "terminal", status: "starting", token });
    expect(startedFor(key)).toBe(starter.token);
    // The prompt it was started with is not given again.
    await launchTerminal(key, 80, 24, () => {});
    expect(pty.spawned.at(-1)).toMatchObject({ session: session.id });
    expect((pty.spawned.at(-1) as { prompt?: string }).prompt).toBeUndefined();
  });
});

describe("a new conversation put under a workflow", () => {
  // Both agents are here and can run as conversations, so a workflow's
  // orchestrator can be either.
  beforeEach(() => {
    for (const id of ["claude-code", "codex"])
      applyDetect(
        { id, path: `/usr/local/bin/${id}`, caps: { resumable: true, titles: true, acp: false, integrated: true }, fromLoginShell: true },
        true,
      );
    adoptWorkflows({ list: [defaultWorkflow()], default: null, overrides: {} });
  });
  afterEach(() => {
    resetAgent();
    localStorage.removeItem("workbench.workflows");
    localStorage.removeItem("workbench.tokens");
  });

  const starts = () => fake.calls.filter((call) => call.method === "start");

  /** Holds every start the core is asked for until the test lets it go. */
  function holdStarts() {
    const core = (window as unknown as { __WORKBENCH_CORE__: { integratedStart: (options: never) => unknown } })
      .__WORKBENCH_CORE__;
    const plain = core.integratedStart;
    const waiting: (() => void)[] = [];
    core.integratedStart = (options: never) =>
      new Promise((resolve, reject) =>
        waiting.push(() => {
          try {
            resolve(plain(options));
          } catch (error) {
            reject(error);
          }
        }),
      );
    return {
      next: async () => {
        await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0));
        waiting.shift()!();
        await settled();
      },
    };
  }

  it("starts it again as the workflow's orchestrator, on the same row and token, told what a session started under it is", async () => {
    const { session, key, handle } = await started();
    const token = session.token;
    const first = session.id!;
    expect(unspoken(session)).toBe(true);

    follow(key, "Build and review");
    // The run it leaves is stopped at once, so nothing can reach it.
    expect(handleOf(key)).toBeNull();
    expect(fake.calls.some((call) => call.method === "stop" && call.id === handle)).toBe(true);
    await vi.waitFor(() => expect(handleOf(key)).toBe("int-2"));

    const row = byKey(key)!;
    expect(sessions.all).toHaveLength(1);
    expect(row.token).toBe(token);
    expect(row.status).toBe("running");
    expect(row.workflow?.name).toBe("Build and review");
    expect(row.model).toBe("fable");
    expect(starts().at(-1)).toMatchObject({
      options: {
        agent: "claude-code",
        model: "fable",
        token,
        instructions: orchestratorPrompt(defaultWorkflow()),
        startOnly: true,
      },
    });
    expect((starts().at(-1)!.options as { session?: string }).session).toBeUndefined();
    // A new conversation, kept under its own id alone.
    expect(row.id).toBe("integrated-session-2");
    expect(sessions.tokens[first]).toBeUndefined();
    expect(sessions.workflows[first]).toBeUndefined();
    expect(sessions.workflows[row.id!].workflow).toMatchObject({ name: "Build and review" });
    // Nothing the run it left said stands; the ended run is not the row's.
    expect(row.status).toBe("running");
    expect(conversationOf(key).sessionId).toBe("integrated-session-2");
  });

  it("is told what a new session under the workflow is told", async () => {
    const plain = create(PROJECT, null, undefined, null, null, null, null, defaultWorkflow(), "integrated");
    await launch(plain.key);
    const direct = starts().at(-1)!.options;
    const { key } = await started();
    follow(key, "Build and review");
    await vi.waitFor(() => expect(starts()).toHaveLength(3));
    const picked = starts().at(-1)!.options;
    const without = ({ token: _token, ...rest }: Record<string, unknown>) => rest;
    expect(without(picked as never)).toEqual(without(direct as never));
  });

  it("goes back to the agent alone, on its own default model", async () => {
    const { key } = await started();
    follow(key, "Build and review");
    await vi.waitFor(() => expect(handleOf(key)).toBe("int-2"));
    follow(key, null);
    await vi.waitFor(() => expect(handleOf(key)).toBe("int-3"));
    const { options } = starts().at(-1) as Extract<(typeof fake.calls)[number], { method: "start" }>;
    expect(options.instructions).toBeUndefined();
    expect(options.startOnly).toBeUndefined();
    expect(options.model).toBeUndefined();
    expect(byKey(key)!.workflow).toBeNull();
    expect(byKey(key)!.model).toBeNull();
  });

  it("does nothing for the workflow it follows already", async () => {
    const { key } = await started();
    follow(key, null);
    await settled();
    expect(starts()).toHaveLength(1);
    expect(handleOf(key)).toBe("int-1");
  });

  it("is never started again once a message was sent", async () => {
    const { key, handle } = await started();
    send(key, "Fix the scan");
    expect(unspoken(byKey(key)!)).toBe(false);
    follow(key, "Build and review");
    await settled();
    expect(byKey(key)!.workflow).toBeNull();
    expect(starts()).toHaveLength(1);
    expect(handleOf(key)).toBe(handle);
  });

  it("is not offered for a resumed session, or one another session started", async () => {
    const resumed = await started({ resumedFrom: "past-1" });
    expect(unspoken(resumed.session)).toBe(false);
    const prompted = await started({ prompt: "Fix the scan" });
    expect(unspoken(prompted.session)).toBe(false);
  });

  it("waits for a start on its way, then starts it again once, under the last pick", async () => {
    const gate = holdStarts();
    const row = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "integrated");
    const launching = launch(row.key);
    follow(row.key, "Build and review");
    follow(row.key, null);
    follow(row.key, "Build and review");
    // The start on its way was asked for before the pick.
    await gate.next();
    await launching;
    expect(starts()).toHaveLength(1);
    expect(starts()[0].options).not.toHaveProperty("instructions");
    // Once it is up it is started again, under what was picked last.
    await gate.next();
    await vi.waitFor(() => expect(handleOf(row.key)).toBe("int-2"));
    expect(starts()).toHaveLength(2);
    expect(starts()[1].options).toMatchObject({ instructions: orchestratorPrompt(defaultWorkflow()) });
    expect(fake.calls.filter((call) => call.method === "stop")).toEqual([{ method: "stop", id: "int-1" }]);
  });

  it("counts as ready while it starts again, and makes a change of mode asked for meanwhile on the new run", async () => {
    const gate = holdStarts();
    const row = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "integrated");
    const launching = launch(row.key);
    await gate.next();
    await launching;
    follow(row.key, "Build and review");
    const link = linkFor(row.key);
    expect(link.restarting).toBe(true);
    expect(handleOf(row.key)).toBeNull();
    // Nothing reaches the run being left, or the one not up yet.
    expect(send(row.key, "too soon")).toBeNull();
    await configure(row.key, { mode: "plan" });
    await gate.next();
    await vi.waitFor(() => expect(link.restarting).toBe(false));
    await vi.waitFor(() => expect(conversationOf(row.key).settings.mode).toBe("plan"));
    expect(fake.calls.filter((call) => call.method === "configure")).toEqual([
      { method: "configure", id: "int-2", settings: { mode: "plan" } },
    ]);
  });

  it("keeps the mode chosen with the same agent, and starts another agent as its own settings say", async () => {
    const codexFlow = { ...defaultWorkflow(), name: "Codex directs", orchestrator: { agent: "codex" as const, model: "default" } };
    adoptWorkflows({ list: [defaultWorkflow(), codexFlow], default: null, overrides: {} });
    const { key } = await started();
    await configure(key, { mode: "plan" });
    follow(key, "Build and review");
    await vi.waitFor(() => expect(handleOf(key)).toBe("int-2"));
    expect(starts().at(-1)).toMatchObject({ options: { mode: "plan" } });
    follow(key, "Codex directs");
    await vi.waitFor(() => expect(handleOf(key)).toBe("int-3"));
    expect(starts().at(-1)).toMatchObject({ options: { agent: "codex", startOnly: true } });
    expect(starts().at(-1)!.options.mode).toBeUndefined();
    expect(byKey(key)!.agent).toBe("codex");
    expect(byKey(key)!.model).toBeNull();
    expect(conversationOf(key).ready?.models.map((model) => model.value)).toEqual(["gpt-5-codex"]);
  });

  /** Holds every change of the settings the core is asked for until the
      test answers it, with what the core would answer or what it is told
      to answer. */
  function holdConfigures() {
    const core = (window as unknown as { __WORKBENCH_CORE__: { integratedConfigure: (id: string, change: never) => unknown } })
      .__WORKBENCH_CORE__;
    const plain = core.integratedConfigure;
    const waiting: ((answer?: unknown) => void)[] = [];
    core.integratedConfigure = (id: string, change: never) =>
      new Promise((resolve, reject) =>
        waiting.push((answer) => {
          if (answer !== undefined) return resolve(answer);
          try {
            resolve(plain(id, change));
          } catch (error) {
            reject(error);
          }
        }),
      );
    return {
      answer: async (answer?: unknown) => {
        await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0));
        waiting.shift()!(answer);
        await settled();
      },
      plain: () => (core.integratedConfigure = plain),
    };
  }

  it("starts the new run in a mode asked of the run it leaves and not answered yet, and takes nothing that run answers later", async () => {
    const { key } = await started();
    await configure(key, { mode: "acceptEdits" });
    const held = holdConfigures();
    void configure(key, { mode: "default" });
    follow(key, "Build and review");
    await vi.waitFor(() => expect(handleOf(key)).toBe("int-2"));
    expect(starts().at(-1)).toMatchObject({ options: { mode: "default" } });
    expect(conversationOf(key).settings.mode).toBe("default");
    // The run left behind answers late, by its old mode or by having gone:
    // neither reaches the composer.
    await held.answer({ model: "claude-sonnet-5-5", mode: "acceptEdits", effort: null });
    expect(conversationOf(key).settings.mode).toBe("default");
    void configure(key, { mode: "plan" });
    follow(key, null);
    await vi.waitFor(() => expect(handleOf(key)).toBe("int-3"));
    expect(starts().at(-1)).toMatchObject({ options: { mode: "plan" } });
    await held.answer();
    expect(linkFor(key).configureError).toBeNull();
    expect(conversationOf(key).settings.mode).toBe("plan");
  });

  it("keeps what is asked while it starts again for the run after, when another pick starts it again at once", async () => {
    const gate = holdStarts();
    const row = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "integrated");
    const launching = launch(row.key);
    await gate.next();
    await launching;
    follow(row.key, "Build and review");
    await configure(row.key, { effort: "high" });
    await configure(row.key, { mode: "plan" });
    follow(row.key, null);
    // The run for the first pick comes up and is left at once for the
    // second: nothing asked meanwhile goes to it.
    await gate.next();
    await vi.waitFor(() => expect(fake.calls.some((call) => call.method === "stop" && call.id === "int-2")).toBe(true));
    await gate.next();
    await vi.waitFor(() => expect(linkFor(row.key).restarting).toBe(false));
    expect(starts().at(-1)).toMatchObject({ options: { mode: "plan" } });
    expect(handleOf(row.key)).toBe("int-3");
    expect(fake.calls.filter((call) => call.method === "configure")).toEqual([
      { method: "configure", id: "int-3", settings: { effort: "high" } },
    ]);
  });

  it("goes back to the agent it was started on under no workflow", async () => {
    const codexFlow = { ...defaultWorkflow(), name: "Codex directs", orchestrator: { agent: "codex" as const, model: "default" } };
    adoptWorkflows({ list: [codexFlow], default: null, overrides: {} });
    const { key } = await started();
    follow(key, "Codex directs");
    await vi.waitFor(() => expect(handleOf(key)).toBe("int-2"));
    expect(byKey(key)!.agent).toBe("codex");
    follow(key, null);
    await vi.waitFor(() => expect(handleOf(key)).toBe("int-3"));
    expect(byKey(key)!.agent).toBe("claude-code");
    expect(starts().at(-1)).toMatchObject({ options: { agent: "claude-code" } });
    expect(starts().at(-1)!.options.mode).toBeUndefined();
    expect(conversationOf(key).ready?.models.map((model) => model.value)).toContain("sonnet");
  });

  it("refuses a workflow whose orchestrator's agent is not here", async () => {
    resetAgent();
    applyDetect(
      { id: "claude-code", path: "/usr/local/bin/claude", caps: { resumable: true, titles: true, acp: false, integrated: true }, fromLoginShell: true },
      true,
    );
    const codexFlow = { ...defaultWorkflow(), name: "Codex directs", orchestrator: { agent: "codex" as const, model: "default" } };
    adoptWorkflows({ list: [codexFlow], default: null, overrides: {} });
    const { key } = await started();
    follow(key, "Codex directs");
    await settled();
    expect(byKey(key)!.workflow).toBeNull();
    expect(starts()).toHaveLength(1);
  });

  it("fails on its row with the core's reason when the new run will not start", async () => {
    const { key } = await started();
    const core = (window as unknown as { __WORKBENCH_CORE__: { integratedStart: () => unknown } }).__WORKBENCH_CORE__;
    core.integratedStart = async () => {
      throw new Error("no tool server to give the orchestrator its start tool");
    };
    follow(key, "Build and review");
    await vi.waitFor(() => expect(byKey(key)!.status).toBe("failed"));
    expect(byKey(key)!.error).toBe("no tool server to give the orchestrator its start tool");
    expect(linkFor(key).restarting).toBe(false);
  });
});

describe("what a new session starts on from the user's last choices", () => {
  const lastStart = () =>
    (fake.calls.filter((call) => call.method === "start").at(-1) as {
      options: { model?: string; mode?: string; effort?: string };
    }).options;
  const configures = () => fake.calls.filter((call) => call.method === "configure");

  beforeEach(() => resetLastChosen());

  it("starts a new one on what was last chosen on the chips, and shows it before the agent says", async () => {
    const first = await started();
    const conversation = conversationOf(first.key);
    choose(first.key, conversation, "model", "sonnet");
    choose(first.key, conversation, "effort", "high");
    choose(first.key, conversation, "mode", "acceptEdits");
    await vi.waitFor(() => expect(chosenFor("claude-code")).toEqual({ model: "sonnet", effort: "high", mode: "acceptEdits" }));
    fake.holdReady = true;
    const next = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "integrated");
    expect(next.model).toBe("sonnet");
    // The chips have it from the first frame.
    expect(conversationOf(next.key).settings).toEqual({ model: "sonnet", mode: "acceptEdits", effort: "high" });
    void launch(next.key);
    await vi.waitFor(() => expect(lastStart()).toMatchObject({ model: "sonnet", mode: "acceptEdits", effort: "high" }));
    fake.holdReady = false;
  });

  it("keeps no default the agent started on, nor a mode a run fell back to, and none of Plan", async () => {
    stopListening();
    await install({ ownMode: "default" });
    const first = await started();
    expect(anyChosen("claude-code")).toBe(false);
    const conversation = conversationOf(first.key);
    choose(first.key, conversation, "mode", "auto");
    await vi.waitFor(() => expect(chosenFor("claude-code").mode).toBe("auto"));
    choose(first.key, conversation, "mode", "plan");
    await settled();
    expect(chosenFor("claude-code").mode).toBe("auto");
    // Where auto is not taken, the next runs in the nearest below, says so,
    // and what is kept stays.
    const next = await started();
    expect(lastStart().mode).toBe("auto");
    await vi.waitFor(() => expect(conversationOf(next.key).settings.mode).toBe("acceptEdits"));
    expect(configures().at(-1)).toMatchObject({ settings: { mode: "acceptEdits" } });
    await vi.waitFor(() =>
      expect(conversationOf(next.key).entries.at(-1)).toMatchObject({
        kind: "note",
        text: "Auto mode, last chosen, is not available here, so it runs in Accept edits mode, the nearest below that it can take.",
      }),
    );
    expect(chosenFor("claude-code").mode).toBe("auto");
  });

  it("starts on the agent's default where the model last chosen is not offered, keeping the choice", async () => {
    adoptLastChosen({ "claude-code": { model: "opus" } });
    const next = await started();
    expect(lastStart().model).toBe("opus");
    await vi.waitFor(() => expect(configures().at(-1)).toMatchObject({ settings: { model: "default" } }));
    await vi.waitFor(() =>
      expect(conversationOf(next.key).entries.at(-1)).toMatchObject({
        kind: "note",
        text: "Opus is not offered here, so the session runs on Default.",
      }),
    );
    expect(chosenFor("claude-code").model).toBe("opus");
    // The account was heard, so its next session starts on the default.
    const after = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "integrated");
    expect(after.model).toBeNull();
  });

  it("starts nothing in a stored Plan, bypassing permissions or full access, integrated or in a terminal", async () => {
    // Written to the store past every check, as a later version or a hand
    // might write the file.
    for (const [agent, mode] of [
      ["claude-code", "bypassPermissions"],
      ["claude-code", "plan"],
      ["codex", "full-access"],
    ] as const) {
      lastChosen.byAgent = { [agent]: { mode } };
      const row = create(PROJECT, null, agent, null, null, null, null, undefined, "integrated");
      expect(conversationOf(row.key).settings.mode).toBeNull();
      await launch(row.key);
      expect(lastStart().mode).toBeUndefined();
      const term = create(PROJECT, null, agent, null, null, null, null, undefined, "terminal");
      await launchTerminal(term.key, 80, 24, () => {});
      expect(pty.spawned.at(-1)!.mode).toBeUndefined();
    }
  });

  it("keeps no model pick the agent did not switch to", async () => {
    const first = await started();
    const seam = (window as unknown as { __WORKBENCH_CORE__: Record<string, unknown> }).__WORKBENCH_CORE__;
    const configureNow = seam.integratedConfigure;
    // The agent answers, still on the model it ran on.
    seam.integratedConfigure = async () => conversationOf(first.key).settings;
    choose(first.key, conversationOf(first.key), "model", "haiku");
    await settled();
    await settled();
    expect(chosenFor("claude-code").model).toBeUndefined();
    seam.integratedConfigure = configureNow;
    choose(first.key, conversationOf(first.key), "model", "haiku");
    await vi.waitFor(() => expect(chosenFor("claude-code").model).toBe("haiku"));
  });

  it("gives nothing kept to a session another started, a resumed one, or a workflow's model", async () => {
    adoptLastChosen({ "claude-code": { model: "sonnet", effort: "low", mode: "acceptEdits" } });
    const given = create(PROJECT, null, "claude-code", null, "Fix it", "haiku", null, undefined, "integrated");
    given.modeGiven = "default";
    await launch(given.key);
    expect(lastStart()).toMatchObject({ model: "haiku", mode: "default" });
    expect(lastStart().effort).toBeUndefined();
    await started({ resumedFrom: "old-1" });
    expect(lastStart().model).toBeUndefined();
    expect(lastStart().mode).toBeUndefined();
    expect(lastStart().effort).toBeUndefined();
    // A pick on a chip of a session another started is still the user's.
    choose(given.key, conversationOf(given.key), "mode", "dontAsk");
    await vi.waitFor(() => expect(chosenFor("claude-code").mode).toBe("dontAsk"));
  });

  it("launches a terminal on the kept model and mode, and keeps a mode its hooks say it switched to", async () => {
    adoptLastChosen({ "claude-code": { model: "sonnet", effort: "high", mode: "acceptEdits" } });
    const row = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "terminal");
    await launchTerminal(row.key, 80, 24, () => {});
    expect(pty.spawned.at(-1)).toMatchObject({ model: "sonnet", mode: "acceptEdits" });
    startedTerminal(row.key, "pty-1", "conversation-t");
    // The mode it says it began in is not a choice. A switch after it is
    // kept only where it narrows what is kept, since any process can
    // write what the hooks report.
    exact("conversation-t", "prompt", null, false, { mode: "auto" });
    expect(chosenFor("claude-code").mode).toBe("acceptEdits");
    exact("conversation-t", "stop", null, false, { mode: "default" });
    expect(chosenFor("claude-code").mode).toBe("default");
    exact("conversation-t", "prompt", null, false, { mode: "auto" });
    exact("conversation-t", "stop", null, false, { mode: "plan" });
    expect(chosenFor("claude-code").mode).toBe("default");
    // One resumed goes on as its conversation did.
    const back = create(PROJECT, "old-2", "claude-code", null, null, null, null, undefined, "terminal");
    await launchTerminal(back.key, 80, 24, () => {});
    expect(pty.spawned.at(-1)).toMatchObject({ session: "old-2" });
    expect((pty.spawned.at(-1) as { model?: string }).model).toBeUndefined();
    expect(pty.spawned.at(-1)!.mode).toBeUndefined();
  });
});
