import { describe, expect, it } from "vitest";
import { flushSync } from "svelte";
import { Conversation } from "$lib/conversation.svelte";
import type { IntegratedEventBody } from "$lib/core";
import { Finder, caseCounts, lower, places, rangesIn, readOut, saidText } from "$lib/find.svelte";

/** A turn that answers a question with a command, then a subagent that
    reads a file, then says what it found. */
function conversation(): Conversation {
  const c = new Conversation(() => 0);
  const events: IntegratedEventBody[] = [
    { type: "message", message: "m-1", state: "sent", error: null, text: "Where is the Counter?", images: [] },
    { type: "turnStarted", messages: ["m-1"] },
    { type: "toolStarted", call: "c-1", parent: null, name: "Bash", kind: "command" },
    { type: "toolInput", call: "c-1", parent: null, delta: null, input: { command: "grep -rn counter src" }, truncated: false },
    { type: "toolFinished", call: "c-1", parent: null, output: "src/count.ts:1", error: false, truncated: false, changes: [] },
    { type: "toolStarted", call: "c-2", parent: null, name: "Task", kind: "agent" },
    { type: "toolStarted", call: "c-3", parent: "c-2", name: "Read", kind: "read" },
    { type: "toolFinished", call: "c-3", parent: "c-2", output: "let counter = 0; counter += 1;", error: false, truncated: false, changes: [] },
    { type: "toolFinished", call: "c-2", parent: null, output: "done", error: false, truncated: false, changes: [] },
    { type: "text", block: "b-1", parent: null, text: "The **counter** is in `src/count.ts`.", done: true },
    { type: "turnEnded", outcome: "done", error: null, totalCostUsd: null, durationMs: 1000, usage: null },
  ];
  for (const event of events) c.apply(event);
  return c;
}

async function find(c: Conversation, query: string, from: { key?: string | null; entry?: string | null } | null = {}) {
  const finder = new Finder(() => c);
  finder.query = query;
  await finder.search(from);
  flushSync();
  return finder;
}

describe("what find compares", () => {
  it("ignores case unless the words hold a capital", () => {
    expect(caseCounts("cache")).toBe(false);
    expect(caseCounts("Cache")).toBe(true);
    expect(caseCounts("über")).toBe(false);
    expect(caseCounts("Über")).toBe(true);
    expect(caseCounts("2 of 7")).toBe(false);
  });

  it("lowers text without moving any place in it", () => {
    expect(lower("Cache")).toBe("cache");
    // İ lowers to two characters; it keeps its one.
    const text = "İstanbul Cache";
    expect(lower(text)).toHaveLength(text.length);
    expect(lower(text).indexOf("cache")).toBe(text.indexOf("Cache"));
  });

  it("finds each place after the end of the one before", () => {
    expect(places("aaaa", "aa")).toEqual([0, 2]);
    expect(places("a cache, a cache", "cache")).toEqual([2, 11]);
    expect(places("anything", "")).toEqual([]);
  });
});

describe("reading what the thread draws", () => {
  const html = (markup: string) => {
    const box = document.createElement("div");
    box.innerHTML = markup;
    return box;
  };

  it("reads blocks on lines of their own and inline text as one line", () => {
    const box = html("<p>The <strong>cache</strong> is</p><p>kept</p>");
    expect(readOut([box]).text).toBe("The cache is\nkept");
  });

  it("leaves out what is marked to skip and what another thing draws inside", () => {
    const box = html(
      `<div data-find="a"><span data-find-skip>$ </span>ls<div data-find="b">nested</div><pre>out\n\nmore</pre><button data-find-skip>Copy</button></div>`,
    );
    const place = box.firstElementChild!;
    expect(readOut([place], "a").text).toBe("ls\nout\n\nmore");
  });

  it("reads a space beside a label left out, or at a block's edge, as a line, and one between words as a space", () => {
    // As a changed file's head and a plan's step draw them.
    const head = html(`<div data-find="a"><span data-find-skip>Moved</span> <span>src/a.rs</span> <span data-find-skip>to</span> <span>src/b.rs</span> <span data-find-skip>+1</span></div>`);
    expect(readOut([head.firstElementChild!], "a").text).toBe("src/a.rs\nsrc/b.rs");
    const step = html(`<ol><li><span data-find-skip></span> <span>Read the scan</span></li></ol>`);
    expect(readOut([step]).text).toBe("Read the scan");
    // Between two pieces of code in a sentence, the space is the words'.
    const said = html(`<p><code>a</code> <code>b</code><!----> <em>c</em></p>`);
    expect(readOut([said]).text).toBe("a b c");
  });

  it("puts a range on each match, across the text nodes it runs over", () => {
    const box = html("<p>The <strong>cache</strong> is a Cache</p>");
    const read = readOut([box]);
    expect(rangesIn(read, "the cache", false).map((range) => range.toString())).toEqual(["The cache"]);
    expect(rangesIn(read, "cache", false).map((range) => range.toString())).toEqual(["cache", "Cache"]);
    expect(rangesIn(read, "Cache", true).map((range) => range.toString())).toEqual(["Cache"]);
  });

  it("reads Markdown as it is drawn, not as it is written", () => {
    expect(saidText("The **counter** is in `src/count.ts`.")).toBe("The counter is in src/count.ts.");
    expect(saidText("- one\n- two")).toBe("one\ntwo");
    expect(saidText("```\nlet a = 1;\n```")).toBe("let a = 1;\n");
  });
});

describe("find in a conversation", () => {
  it("counts every match in the whole conversation, folded work and a subagent's run included", async () => {
    const finder = await find(conversation(), "counter");
    expect(finder.total).toBe(5);
    expect(finder.found.map((one) => [one.held.key, one.count])).toEqual([
      ["m-1", 1],
      ["c-1", 1],
      ["c-3:shows", 2],
      ["b-1", 1],
    ]);
    expect(finder.current).toBe(0);
  });

  it("matches what is drawn rather than the Markdown it is written in", async () => {
    expect((await find(conversation(), "**counter**")).total).toBe(0);
    expect((await find(conversation(), "the counter is in src")).total).toBe(1);
  });

  it("ignores case unless the words hold a capital", async () => {
    expect((await find(conversation(), "COUNTER")).total).toBe(0);
    expect((await find(conversation(), "Counter")).total).toBe(1);
    expect((await find(conversation(), "nothing here")).total).toBe(0);
  });

  it("starts new words from where it is asked to, and steps round at the ends", async () => {
    const c = conversation();
    const run = c.entries.find((entry) => entry.kind === "agent")!.key;
    const finder = await find(c, "counter", { entry: run });
    // The message is above the run, so the first match from the run is
    // the command's.
    expect(finder.current).toBe(1);
    expect(finder.hit()).toMatchObject({ key: "c-1", nth: 0 });
    finder.step(1);
    finder.step(1);
    expect(finder.hit()).toMatchObject({ key: "c-3:shows", nth: 1 });
    finder.step(1);
    finder.step(1);
    expect(finder.current).toBe(0);
    finder.step(-1);
    expect(finder.current).toBe(4);
  });

  it("keeps the count right and the current match where it is while a reply streams", async () => {
    const c = conversation();
    const finder = await find(c, "counter");
    finder.step(1);
    finder.step(1);
    expect(finder.hit()).toMatchObject({ key: "c-3:shows", nth: 0 });
    c.apply({ type: "message", message: "m-2", state: "sent", error: null, text: "And now?", images: [] });
    c.apply({ type: "turnStarted", messages: ["m-2"] });
    c.apply({ type: "text", block: "b-2", parent: null, text: "The counter", done: false });
    await finder.search();
    expect(finder.total).toBe(6);
    c.apply({ type: "text", block: "b-2", parent: null, text: " and the counter's test.", done: false });
    await finder.search();
    expect(finder.total).toBe(7);
    expect(finder.hit()).toMatchObject({ key: "c-3:shows", nth: 0 });
  });

  it("finds a message still waiting under the thread", async () => {
    const c = conversation();
    c.apply({ type: "message", message: "m-3", state: "queued", error: null, text: "Rename the counter", images: [] });
    const finder = await find(c, "rename");
    expect(finder.total).toBe(1);
    expect(finder.hit()?.held).toMatchObject({ id: "m-3", entry: null });
  });

  it("counts the whole of a long conversation in slices, and the last count asked for wins", async () => {
    const c = new Conversation(() => 0);
    for (let turn = 0; turn < 1000; turn++) {
      c.apply({ type: "message", message: `m-${turn}`, state: "sent", error: null, text: `Question ${turn}`, images: [] });
      c.apply({ type: "turnStarted", messages: [`m-${turn}`] });
      c.apply({ type: "text", block: `b-${turn}`, parent: null, text: `Reply ${turn}, with a *needle* in it.`, done: true });
      c.apply({ type: "turnEnded", outcome: "done", error: null, totalCostUsd: null, durationMs: 1, usage: null });
    }
    const finder = new Finder(() => c);
    finder.query = "needle";
    const first = finder.search({});
    finder.query = "reply 99";
    const second = finder.search({});
    expect(await second).toBe(true);
    await first;
    // "Reply 99", "Reply 990" to "Reply 999".
    expect(finder.total).toBe(11);
  });
});
