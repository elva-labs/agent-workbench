import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  conversationOf,
  fileNames,
  goBack,
  handleOf,
  launch,
  linkFor,
  listenIntegrated,
  notesFrom,
  resetIntegrated,
  send,
  takeBackUp,
  undoGoBack,
  upHasMore,
  upHolds,
} from "$lib/integrated.svelte";
import { Conversation, type Message } from "$lib/conversation.svelte";
import { byKey, create, reset as resetSessions } from "$lib/sessions.svelte";
import { FILES_BACK_HEAD, spoken } from "$lib/instructions";
import {
  allNamed,
  backCostOf,
  backOf,
  backSaidOf,
  canGoBack,
  choicesOf,
  closeBack,
  markedOf,
  moveBack,
  openBack,
  pickBack,
  resetBack,
  toChoices,
} from "$lib/rewind.svelte";
import { fakeIntegrated, type FakeIntegrated, type FakeIntegratedOptions } from "../fakeIntegrated";

const PROJECT = "/home/ada/dev/demo";
let fake: FakeIntegrated;
let stopListening = () => {};

/** The fake core behind the seam, its integrated sessions scripted. */
async function install(options: FakeIntegratedOptions = {}) {
  fake = fakeIntegrated(options);
  (window as unknown as { __CHORD_CORE__: unknown }).__CHORD_CORE__ = {
    integratedStart: async (start: Parameters<FakeIntegrated["start"]>[0]) => fake.start(start),
    integratedSend: async (id: string, message: string, text: string, images?: never[]) =>
      fake.send(id, message, text, images),
    integratedWithdraw: async (id: string, message: string) => fake.withdraw(id, message),
    integratedSnapshot: async (id: string) => fake.snapshot(id),
    integratedHistory: async (options: Parameters<FakeIntegrated["history"]>[0]) => fake.history(options),
    integratedStop: async (id: string) => fake.stop(id),
    integratedRewindPoints: async (id: string) => fake.rewindPoints(id),
    integratedRewindPreview: async (id: string, message: string) => fake.rewindPreview(id, message),
    integratedRewind: async (id: string, message: string, what: Parameters<FakeIntegrated["rewind"]>[2]) =>
      fake.rewind(id, message, what),
    integratedRewindUndo: async (id: string) => fake.rewindUndo(id),
    integratedHeld: async (options: Parameters<FakeIntegrated["held"]>[0]) => fake.held(options),
    onIntegratedEvent: async (handler: Parameters<FakeIntegrated["subscribe"]>[0]) => fake.subscribe(handler),
    projectInfo: async (path: string) => ({ path, name: "demo", repository: path, isGit: true }),
    transcriptsMany: async (projects: string[]) => projects.map(() => []),
  };
  stopListening = await listenIntegrated();
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An integrated row of the agent given, started. */
async function started(agent: "claude-code" | "codex" = "claude-code") {
  const session = create(PROJECT, null, agent, null, null, null, null, undefined, "integrated");
  await launch(session.key);
  return session.key;
}

/** Sends the user's words and has the agent answer them in a turn. */
async function said(key: string, words: string): Promise<string> {
  const id = send(key, words)!;
  await settled();
  fake.turn(handleOf(key)!, "Done.");
  return id;
}

const own = (message: Message) => message.text !== "";

beforeEach(async () => {
  resetSessions();
  resetIntegrated();
  resetBack();
  await install();
});

afterEach(() => {
  stopListening();
  delete (window as unknown as { __CHORD_CORE__?: unknown }).__CHORD_CORE__;
});

describe("the conversation store going back", () => {
  function thread() {
    const conversation = new Conversation(() => 1_000);
    for (const [id, words] of [
      ["m-1", "one"],
      ["m-2", "two"],
      ["m-3", "three"],
    ]) {
      conversation.apply({ type: "message", message: id, state: "sent", error: null, text: words, images: [] });
      conversation.apply({ type: "turnStarted", messages: [id] });
      conversation.apply({ type: "text", block: `b-${id}`, parent: null, text: `answer to ${words}`, done: true });
      conversation.apply({
        type: "turnEnded",
        outcome: "done",
        error: null,
        totalCostUsd: null,
        durationMs: 1,
        usage: null,
      });
    }
    return conversation;
  }

  const kinds = (conversation: Conversation) =>
    conversation.entries.map((entry) =>
      entry.kind === "user" ? `you:${entry.message}` : entry.kind === "rewound" ? `rewound${entry.undo ? ":undo" : ""}` : entry.kind,
    );

  it("cuts the thread before a message, marks the place, and undoes it until something is said", () => {
    const conversation = thread();
    expect(conversation.rewound("m-2", 2_000)).toEqual(["m-2", "m-3"]);
    expect(kinds(conversation)).toEqual(["you:m-1", "agent", "rewound"]);
    expect(conversation.order).toEqual(["m-1"]);
    expect(conversation.messages["m-2"]).toBeUndefined();
    expect(Object.keys(conversation.turns)).toHaveLength(1);
    conversation.undoable(true);
    expect(kinds(conversation)).toEqual(["you:m-1", "agent", "rewound:undo"]);
    expect(conversation.unrewound()).toBe(true);
    expect(kinds(conversation)).toEqual(["you:m-1", "agent", "you:m-2", "agent", "you:m-3", "agent"]);
    expect(conversation.order).toEqual(["m-1", "m-2", "m-3"]);
    expect(conversation.unrewound()).toBe(false);
  });

  it("lets go of undo once a message is sent or a turn starts from there", () => {
    const conversation = thread();
    conversation.rewound("m-3", 2_000);
    conversation.undoable(true);
    conversation.sending("m-4", "four");
    expect(kinds(conversation).at(-1)).toBe("rewound");
    expect(conversation.unrewound()).toBe(false);
    const other = thread();
    other.rewound("m-1", 2_000);
    other.undoable(true);
    other.apply({ type: "turnStarted", messages: [] });
    expect(other.unrewound()).toBe(false);
    // A message the thread does not hold cuts nothing.
    expect(thread().rewound("m-9", 2_000)).toEqual([]);
  });
});

describe("Up on a waiting message", () => {
  it("takes the newest back, then the one before, and puts them back in the order sent", async () => {
    const key = await started();
    const h = handleOf(key)!;
    await said(key, "Log each retry.");
    send(key, "Fix the test.");
    await settled();
    fake.startTurn(h);
    const a = send(key, "Use console.debug.")!;
    const b = send(key, "Put the attempt first.")!;
    await settled();
    const link = linkFor(key);
    expect(takeBackUp(key, own)).toBe(true);
    await settled();
    expect(link.draft).toBe("Put the attempt first.");
    expect(upHolds(key)).toBe(true);
    expect(upHasMore(key, own)).toBe(true);
    expect(takeBackUp(key, own)).toBe(true);
    await settled();
    expect(link.draft).toBe("Use console.debug.\nPut the attempt first.");
    expect(upHasMore(key, own)).toBe(false);
    expect(takeBackUp(key, own)).toBe(false);
    expect(conversationOf(key).messages[a]).toBeUndefined();
    expect(conversationOf(key).messages[b]).toBeUndefined();
    // Once the words change, Up is the field's again.
    link.draft = `${link.draft} Now.`;
    expect(upHolds(key)).toBe(false);
  });

  it("takes nothing while the composer holds words of its own", async () => {
    const key = await started();
    const h = handleOf(key)!;
    send(key, "Go.");
    await settled();
    fake.startTurn(h);
    send(key, "Waiting.");
    await settled();
    linkFor(key).draft = "Something else";
    expect(takeBackUp(key, own)).toBe(false);
  });
});

/** The words of the last message the window sent the agent. */
function lastSent(): string {
  const sent = fake.calls.findLast((call) => call.method === "send");
  return sent?.method === "send" ? sent.text : "";
}

describe("telling the agent of files put back", () => {
  it("says the files went back where the conversation goes on whole, and tells the agent once", async () => {
    const key = await started();
    await said(key, "One.");
    const second = await said(key, "Two.");
    fake.files.set(second, { files: ["/w/upload.ts"], insertions: 0, deletions: 2 });
    fake.rewindFallback = "claude ended with code 1";
    expect(await goBack(key, second, "both", ["/w/upload.ts"])).toBe("claude ended with code 1");
    expect(linkFor(key).backSaid).toMatch(
      /^It did not go back: claude ended with code 1\. The conversation goes on as it was, but upload\.ts is as it was at .+\. Claude Code is told with your next message\.$/,
    );
    send(key, "Go on.");
    await settled();
    const told = `${FILES_BACK_HEAD}\nAs before the message that begins "Two.":\n/w/upload.ts`;
    expect(lastSent()).toBe(`${told}\n\nGo on.`);
    expect(spoken(lastSent(), true)).toMatchObject({
      text: "Go on.",
      filesBack: 'As before the message that begins "Two.":\n/w/upload.ts',
    });
    fake.turn(handleOf(key)!, "Noted.");
    send(key, "And then?");
    await settled();
    expect(lastSent()).toBe("And then?");
  });

  it("says the files went back where Claude Code does not start again at all", async () => {
    const key = await started();
    await said(key, "One.");
    const second = await said(key, "Two.");
    fake.files.set(second, { files: ["/w/upload.ts", "/w/notes.md"], insertions: 0, deletions: 2 });
    fake.rewindFails = "claude was not found";
    expect(await goBack(key, second, "both", ["/w/upload.ts", "/w/notes.md"])).toBe(
      "Claude Code could not start again: claude was not found.",
    );
    expect(linkFor(key).backSaid).toMatch(
      /^It did not go back: Claude Code could not start again: claude was not found\. The files went back all the same: upload\.ts and notes\.md are as they were at .+\. Claude Code is told with your next message\.$/,
    );
    expect(JSON.stringify(conversationOf(key).entries)).toContain("The files went back all the same: upload.ts and notes.md");
    expect(conversationOf(key).entries.filter((entry) => entry.kind === "user")).toHaveLength(2);
    expect(linkFor(key).filesBack).toEqual([
      { path: "/w/upload.ts", message: second, line: "Two." },
      { path: "/w/notes.md", message: second, line: "Two." },
    ]);
  });

  it("tells the agent of files put back alone, again where that message never reaches it", async () => {
    const key = await started();
    const first = await said(key, "One.");
    fake.files.set(first, { files: ["/w/upload.ts"], insertions: 0, deletions: 2 });
    expect(await goBack(key, first, "files", ["/w/upload.ts"])).toBeNull();
    expect(linkFor(key).backSaid).toMatch(
      /^upload\.ts is as it was at .+\. What commands changed stays\. Claude Code is told with your next message\.$/,
    );
    const seam = (window as unknown as { __CHORD_CORE__: Record<string, unknown> }).__CHORD_CORE__;
    const through = seam.integratedSend;
    seam.integratedSend = async () => {
      throw new Error("the pipe broke");
    };
    send(key, "Go on.");
    await settled();
    expect(linkFor(key).filesBack.map((one) => one.path)).toEqual(["/w/upload.ts"]);
    seam.integratedSend = through;
    send(key, "Go on, again.");
    await settled();
    expect(lastSent()).toBe(`${FILES_BACK_HEAD}\nAs before the message that begins "One.":\n/w/upload.ts\n\nGo on, again.`);
  });

  it("lets go of files to tell once the conversation goes back past their message", async () => {
    const key = await started();
    await said(key, "One.");
    const second = await said(key, "Two.");
    fake.files.set(second, { files: ["/w/upload.ts"], insertions: 0, deletions: 2 });
    expect(await goBack(key, second, "files", ["/w/upload.ts"])).toBeNull();
    expect(linkFor(key).filesBack).toHaveLength(1);
    expect(await goBack(key, second, "conversation", [])).toBeNull();
    expect(linkFor(key).filesBack).toEqual([]);
  });
});

describe("the choices", () => {
  it("name every file they put back, the rest behind n more until marked, and say which can be undone", async () => {
    const key = await started();
    const first = await said(key, "One.");
    const files = ["/w/src/a/upload.ts", "/w/src/b/upload.ts", "/w/queue.ts", "/w/retry.ts", "/w/notes.md"];
    fake.files.set(first, { files, insertions: 9, deletions: 46 });
    expect(await openBack(key, first, true)).toBe(true);
    await settled();
    const choices = choicesOf(key);
    expect(choices.map((choice) => [choice.way, choice.undoable])).toEqual([
      ["conversation", true],
      ["both", false],
      ["files", false],
    ]);
    expect(choices[1].detail).toBe(
      "Also puts a/upload.ts, b/upload.ts, queue.ts, retry.ts and notes.md back as they were, +9\u00a0−46. What commands changed stays. It cannot be undone.",
    );
    expect(choices[2].files?.names).toHaveLength(5);
    expect(allNamed(key, 0)).toBe(true);
    expect(allNamed(key, 1)).toBe(false);
    moveBack(key, 1);
    expect(allNamed(key, 1)).toBe(true);
    expect(allNamed(key, 2)).toBe(false);
  });

  it("tell files of the same name apart by their folders", () => {
    expect(fileNames(["/w/a/upload.ts", "/w/b/upload.ts", "/w/z.ts"])).toBe("a/upload.ts, b/upload.ts and z.ts");
    expect(fileNames(["/w/upload.ts"])).toBe("upload.ts");
  });
});

describe("going back from the window", () => {
  it("lists the user's messages at rest, marks the newest, and says what leaves", async () => {
    const key = await started();
    const first = await said(key, "One.");
    const second = await said(key, "Two.");
    await said(key, "Three.");
    expect(canGoBack(key)).toBe(true);
    fake.files.set(second, { files: ["/w/a.ts", "/w/b.ts"], insertions: 3, deletions: 1 });
    expect(await openBack(key)).toBe(true);
    await settled();
    const back = backOf(key);
    expect(back.rows.map((row) => row.line)).toEqual(["One.", "Two.", "Three."]);
    expect(back.marked).toBe(2);
    expect(markedOf(key)).toBe(back.rows[2].message);
    expect(backSaidOf(key, "Claude")).toBe(
      "This message and what Claude did for it leave the conversation. Files cannot go back to here.",
    );
    moveBack(key, -1);
    expect(backSaidOf(key, "Claude")).toBe(
      "This message and the 1 after it leave the conversation, with what Claude did for them.",
    );
    await settled();
    expect(toChoices(key)).toBe(true);
    expect(choicesOf(key).map((choice) => choice.way)).toEqual(["conversation", "both", "files"]);
    expect(choicesOf(key)[1].detail).toBe(
      "Also puts a.ts and b.ts back as they were, +3\u00a0−1. What commands changed stays. It cannot be undone.",
    );
    expect(backCostOf(key)).toBe("Claude Code starts again for this.");
    // Only the files: nothing starts again, so no cost is said.
    moveBack(key, 2);
    expect(backCostOf(key)).toBe("");
    moveBack(key, -2);
    expect(backCostOf(key)).toBe("Claude Code starts again for this.");
    closeBack(key);
    expect(markedOf(key)).toBeNull();
    expect(first).not.toBe(second);
  });

  it("goes back by starting Claude Code again, fills the composer, and undoes it", async () => {
    const key = await started();
    await said(key, "One.");
    const second = await said(key, "Two.");
    const before = handleOf(key)!;
    expect(await goBack(key, second, "conversation", [])).toBeNull();
    const after = handleOf(key)!;
    expect(after).not.toBe(before);
    const conversation = conversationOf(key);
    expect(conversation.entries.map((entry) => entry.kind)).toEqual(["user", "agent", "rewound"]);
    expect(conversation.entries.at(-1)).toMatchObject({ kind: "rewound", undo: true });
    expect(linkFor(key).draft).toBe("Two.");
    expect(byKey(key)?.status).toBe("running");
    expect(await undoGoBack(key)).toBeNull();
    expect(handleOf(key)).not.toBe(after);
    expect(conversation.entries.map((entry) => entry.kind)).toEqual(["user", "agent", "user", "agent"]);
    expect(linkFor(key).draft).toBe("");
  });

  it("puts back the files shown, and says so instead of offering undo", async () => {
    const key = await started();
    const first = await said(key, "One.");
    fake.files.set(first, { files: ["/w/upload.ts"], insertions: 0, deletions: 2 });
    expect(await goBack(key, first, "both", ["/w/upload.ts"])).toBeNull();
    const link = linkFor(key);
    expect(link.backSaid).toMatch(/^upload\.ts is as it was at .+\. What commands changed stays\.$/);
    expect(conversationOf(key).entries.at(-1)).toMatchObject({ kind: "rewound", undo: false });
    expect(fake.calls.filter((call) => call.method === "rewind")).toEqual([
      { method: "rewind", id: expect.any(String), message: first, conversation: true, files: ["/w/upload.ts"] },
    ]);
  });

  it("says why it did not go back, changing nothing, where the files changed since they were shown", async () => {
    const key = await started();
    const first = await said(key, "One.");
    fake.files.set(first, { files: ["/w/upload.ts", "/w/notes.md"], insertions: 0, deletions: 2 });
    const handle = handleOf(key);
    expect(await goBack(key, first, "both", ["/w/upload.ts"])).toBe(
      "The files to put back changed since they were shown. Look at them again.",
    );
    expect(handleOf(key)).toBe(handle);
    expect(conversationOf(key).entries.map((entry) => entry.kind)).toEqual(["user", "agent"]);
    expect(linkFor(key).goingBack).toBeNull();
  });

  it("cuts the thread and puts the words ahead in the composer at once, and puts both back where it misses", async () => {
    const key = await started();
    await said(key, "One.");
    const second = await said(key, "Two.");
    linkFor(key).draft = "And this.";
    fake.rewindFallback = "claude ended with code 1";
    const going = goBack(key, second, "conversation", []);
    expect(conversationOf(key).entries.map((entry) => entry.kind)).toEqual(["user", "agent", "rewound"]);
    expect(linkFor(key).draft).toBe("Two.\n\nAnd this.");
    expect(await going).toBe("claude ended with code 1");
    expect(conversationOf(key).entries.map((entry) => entry.kind)).toEqual(["user", "agent", "user", "agent"]);
    expect(linkFor(key).draft).toBe("And this.");
    expect(linkFor(key).backMissed).toBe(1);
  });

  it("goes on whole where Claude Code does not come up from the point, and says why", async () => {
    const key = await started();
    await said(key, "One.");
    const second = await said(key, "Two.");
    fake.rewindFallback = "claude ended with code 1";
    expect(await goBack(key, second, "conversation", [])).toBe("claude ended with code 1");
    expect(conversationOf(key).entries.map((entry) => entry.kind)).toEqual(["user", "agent", "user", "agent"]);
    expect(linkFor(key).backSaid).toBe(
      "It did not go back: claude ended with code 1. The conversation goes on as it was.",
    );
  });

  it("goes back in the same Codex session, and names Codex's limits", async () => {
    await install({ mints: true });
    const key = await started("codex");
    await said(key, "One.");
    const second = await said(key, "Two.");
    const handle = handleOf(key);
    expect(backCostOf(key)).toBe(
      "Codex cannot put files back: they stay as they are now. Going back cannot be undone.",
    );
    expect(await openBack(key, second)).toBe(true);
    expect(choicesOf(key).map((choice) => choice.way)).toEqual(["conversation"]);
    expect(await pickBack(key, 0)).toBeNull();
    expect(handleOf(key)).toBe(handle);
    expect(conversationOf(key).entries.map((entry) => entry.kind)).toEqual(["user", "agent", "rewound"]);
    expect(conversationOf(key).entries.at(-1)).toMatchObject({ undo: false });
  });

  it("counts the reports a message that left carried as not told again", async () => {
    let told = 0;
    let untold = 0;
    notesFrom(() => ({ text: "Reports: B finished.", deliver: () => (told += 1), untold: () => (untold += 1) }));
    const key = await started();
    await said(key, "One.");
    const second = await said(key, "Two.");
    expect(told).toBe(2);
    expect(await goBack(key, second, "conversation", [])).toBeNull();
    expect(untold).toBe(1);
    notesFrom(() => null);
  });

  it("does not open while the session works", async () => {
    const key = await started();
    await said(key, "One.");
    send(key, "Two.");
    await settled();
    fake.startTurn(handleOf(key)!);
    expect(canGoBack(key)).toBe(false);
    expect(await openBack(key)).toBe(false);
  });
});
