import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FileIndex,
  forAgent,
  inCode,
  insertMention,
  mentionSpans,
  mentionWord,
  outgoing,
  sentParts,
  size,
  split,
  typedWords,
  unsafe,
  unsent,
  wire,
} from "$lib/mention";
import { finder, find, isListed, list, reset } from "$lib/mentionFiles.svelte";
import { mentionedIn, mentionsOf, resetMentioned } from "$lib/mentioned.svelte";
import type { Core } from "$lib/core";

function setCore(fake: Partial<Core>) {
  window.__WORKBENCH_CORE__ = fake as Core;
}

describe("an @ being typed", () => {
  it("is a mention at the start of a message or after a space, up to the caret", () => {
    expect(mentionWord("@", 1)).toEqual({ at: 0, query: "", end: 1 });
    expect(mentionWord("Why does @sess fill", 14)).toEqual({ at: 9, query: "sess", end: 14 });
    expect(mentionWord("Why does @sessions fill", 14)).toEqual({ at: 9, query: "sess", end: 18 });
    expect(mentionWord("a\n@lib/s", 8)).toEqual({ at: 2, query: "lib/s", end: 8 });
  });

  it("is text inside a word, so an email address opens nothing", () => {
    expect(mentionWord("mail ada@example.com", 20)).toBeNull();
    expect(mentionWord("x@", 2)).toBeNull();
  });

  it("is text once the caret is past a space, or before the @", () => {
    expect(mentionWord("@sess fill", 10)).toBeNull();
    expect(mentionWord("say @sess", 4)).toBeNull();
  });

  it("is text inside code between backticks or in a fenced block", () => {
    expect(mentionWord("run `npm i @types/node`", 22)).toBeNull();
    expect(mentionWord("```\n@Override\n", 13)).toBeNull();
    expect(mentionWord("`a` then @b", 11)).toEqual({ at: 9, query: "b", end: 11 });
    expect(inCode("```\nx\n```\n@b", 10)).toBe(false);
  });
});

describe("picking a file", () => {
  it("writes the path in place of the word, a space after it, and puts the caret there", () => {
    const draft = "Why does @sess fill";
    const word = mentionWord(draft, 14)!;
    expect(insertMention(draft, word, "src/lib/sessions.svelte.ts")).toEqual({
      text: "Why does @src/lib/sessions.svelte.ts fill",
      caret: 37,
    });
    expect(insertMention("@", mentionWord("@", 1)!, "docs/")).toEqual({ text: "@docs/ ", caret: 7 });
  });
});

describe("where the picked mentions stand", () => {
  it("finds each picked path after a space or at the start, before a space, the end or punctuation", () => {
    const draft = "@a.ts and @dir/b c.md, then @a.ts? not x@a.ts or @a.tsx";
    expect(mentionSpans(draft, ["a.ts", "dir/b c.md"])).toEqual([
      { start: 0, end: 5, path: "a.ts" },
      { start: 10, end: 21, path: "dir/b c.md" },
      { start: 28, end: 33, path: "a.ts" },
    ]);
  });

  it("takes the longer of two paths that overlap, and none inside code", () => {
    expect(mentionSpans("@src/a.ts", ["src", "src/a.ts"])).toEqual([{ start: 0, end: 9, path: "src/a.ts" }]);
    expect(mentionSpans("`@a.ts`", ["a.ts"])).toEqual([]);
  });
});

describe("what goes to the agent", () => {
  const text = (draft: string, picked: string[], attached: string[] = []) => outgoing(draft, picked, attached).text;

  it("is each mention between backticks, so Claude Code does not send the file's content", () => {
    expect(text("Why does @src/a.ts fill?", ["src/a.ts"])).toBe("Why does `@src/a.ts` fill?");
    expect(text("@a dir/b.md is it", ["a dir/b.md"])).toBe("`@a dir/b.md` is it");
  });

  it("leaves an @ that was typed, not picked, as it is", () => {
    expect(text("ping @ada and @src/a.ts", ["src/a.ts"])).toBe("ping @ada and `@src/a.ts`");
  });

  it("puts attached files on a line of their own after the words", () => {
    expect(text("What takes the time?  ", [], ["startup.trace", "/home/ada/Downloads/schema.sql"])).toBe(
      "What takes the time?\n\n`@startup.trace` `@/home/ada/Downloads/schema.sql`",
    );
    expect(text("", [], ["a.txt"])).toBe("`@a.txt`");
  });

  it("never puts white space before the @, fencing a backtick with a longer run", () => {
    expect(wire("we`ird.txt")).toBe("``@we`ird.txt``");
    expect(wire("a``b.md")).toBe("```@a``b.md```");
    expect(wire("ends`")).toBe("``@ends` ``");
    for (const path of ["we`ird.txt", "a``b.md", "ends`", "sp ace.md"]) {
      // Every word of the sent form begins with a backtick, never an @.
      expect(wire(path).split(/\s+/).every((word) => !word.startsWith("@"))).toBe(true);
    }
  });

  it("refuses a path with a line break, a control character or a space before an @", () => {
    expect(unsafe("src/a.ts")).toBeNull();
    expect(unsafe("sp ace.md")).toBeNull();
    expect(unsafe("a\nb.md")).toBe("its path has a line break in it");
    expect(unsafe("a\u0007b.md")).toBe("its path has a control character in it");
    expect(unsafe("a @b.md")).toBe("its path has a space before an @");
    expect(text("see @a @b.md now", ["a @b.md"])).toBe("see @a @b.md now");
    expect(outgoing("x", [], ["/tmp/a\nb.txt"]).mentions).toEqual([]);
  });

  it("says where each mention stands in what is sent", () => {
    const sent = outgoing("Why @a b.md and @c.md?", ["a b.md", "c.md"], ["odd`x.txt"]);
    expect(sent.text).toBe("Why `@a b.md` and `@c.md`?\n\n``@odd`x.txt``");
    expect(sent.mentions.map((mention) => sent.text.slice(mention.start, mention.end))).toEqual([
      "`@a b.md`",
      "`@c.md`",
      "``@odd`x.txt``",
    ]);
  });

  it("reads back as the user wrote it from the mentions kept with it", () => {
    const sent = outgoing("Why @a b.md and @c.md?", ["a b.md", "c.md"], ["odd`x.txt"]);
    expect(sentParts(sent.text, sent.mentions)).toEqual([
      { text: "Why " },
      { text: "@a b.md", path: "a b.md" },
      { text: " and " },
      { text: "@c.md", path: "c.md" },
      { text: "?\n\n" },
      { text: "@odd`x.txt", path: "odd`x.txt" },
    ]);
    expect(unsent(sent.text, sent.mentions)).toEqual({
      draft: "Why @a b.md and @c.md?\n\n@odd`x.txt",
      picked: ["a b.md", "c.md", "odd`x.txt"],
    });
  });

  it("leaves typed inline code that starts with @ as it was typed", () => {
    const typed = "Add the `@Override` and `@types/node`";
    expect(sentParts(typed, [])).toEqual([{ text: typed }]);
    expect(unsent(typed, [])).toEqual({ draft: typed, picked: [] });
    // A mention kept with a message whose words do not hold it there is
    // text too.
    expect(sentParts(typed, [{ start: 8, end: 19, path: "Overrid" }])).toEqual([{ text: typed }]);
  });

  it("finds the @ words typed whole, outside code and the word being typed", () => {
    const draft = "see @README.md, @src/a.ts and `@b` @c";
    expect(typedWords(draft, null)).toEqual(["README.md", "src/a.ts", "c"]);
    expect(typedWords(draft, { at: draft.length - 2, query: "c", end: draft.length })).toEqual(["README.md", "src/a.ts"]);
  });
});

describe("finding a project's files", () => {
  const index = new FileIndex([
    "AGENTS.md",
    "package.json",
    "docs/sessions.md",
    "src/lib/sessions.svelte.ts",
    "src/lib/sessionKind.svelte.ts",
    "src/lib/panes/SessionsPane.svelte",
    "src/lib/mysession.ts",
    "tests/e2e/sessions.spec.ts",
    "src-tauri/core/src/transcripts.rs",
  ]);
  const paths = (query: string, changed: string[] = []) =>
    index.find(query, new Set(changed), 50).found.map((found) => found.path);

  it("lists the top of the project, folders too", () => {
    expect(index.top()).toEqual(["AGENTS.md", "docs/", "package.json", "src-tauri/", "src/", "tests/"]);
  });

  it("matches names first, a changed file first among equals, then fewer folders down", () => {
    expect(paths("sess", ["src/lib/sessions.svelte.ts"])).toEqual([
      "src/lib/sessions.svelte.ts",
      "docs/sessions.md",
      "src/lib/sessionKind.svelte.ts",
      "tests/e2e/sessions.spec.ts",
      "src/lib/panes/SessionsPane.svelte",
      "src/lib/mysession.ts",
    ]);
  });

  it("matches a query with a slash against the path, folders included", () => {
    expect(paths("lib/sess")).toEqual([
      "src/lib/sessionKind.svelte.ts",
      "src/lib/sessions.svelte.ts",
    ]);
    expect(paths("src/lib/p")).toEqual(["src/lib/panes/", "src/lib/panes/SessionsPane.svelte"]);
  });

  it("marks the matched letters, in the name or the folder", () => {
    const [first] = index.find("lib/sess", new Set(), 1).found;
    expect(first.marks).toEqual([[4, 12]]);
    expect(split(first)).toEqual({ name: "sessionKind.svelte.ts", dir: "src/lib", nameMarks: [[0, 4]], dirMarks: [[4, 7]] });
    const [named] = index.find("kind", new Set(), 1).found;
    expect(split(named).nameMarks).toEqual([[7, 11]]);
  });

  it("says how many it found while handing back only the best", () => {
    const result = index.find("s", new Set(), 2);
    expect(result.found).toHaveLength(2);
    expect(result.total).toBeGreaterThan(2);
  });

  it("finds tens of thousands of files in one pass", () => {
    const many = Array.from({ length: 40000 }, (_, at) => `pkg${at % 200}/src/module${at}.ts`);
    const big = new FileIndex(many);
    const result = big.find("module3999", new Set(), 50);
    // The whole name before one that only begins with it.
    expect(result.found.map((found) => found.path).slice(0, 2)).toEqual([
      "pkg199/src/module3999.ts",
      "pkg190/src/module39990.ts",
    ]);
  });
});

describe("a path as the agent is told of it", () => {
  it("is from where the agent works when inside it, else in full", () => {
    expect(forAgent("src/a.ts", "/r", "/r")).toBe("src/a.ts");
    expect(forAgent("app/src/a.ts", "/r", "/r/app")).toBe("src/a.ts");
    expect(forAgent("lib/b.ts", "/r", "/r/app")).toBe("/r/lib/b.ts");
    expect(forAgent("/home/ada/Downloads/s.sql", "/r", "/r")).toBe("/home/ada/Downloads/s.sql");
    expect(forAgent("/r/notes.md", "/r", "/r")).toBe("notes.md");
    expect(forAgent("docs/", "/r", "/r")).toBe("docs/");
    expect(forAgent("C:\\r\\src\\a.ts", "C:\\r", "C:\\r")).toBe("src/a.ts");
    expect(forAgent("lib/b.ts", "ssh://ada@box/r", "ssh://ada@box/r/app")).toBe("/r/lib/b.ts");
  });
});

describe("a file's size", () => {
  it("reads in the largest unit under 1024, one decimal under ten", () => {
    expect(size(1)).toBe("1 byte");
    expect(size(512)).toBe("512 bytes");
    expect(size(4096)).toBe("4 KB");
    expect(size(2.1 * 1024 * 1024)).toBe("2.1 MB");
    expect(size(30 * 1024 * 1024 * 1024)).toBe("30 GB");
  });
});

describe("the files for the menu", () => {
  beforeEach(() => reset());
  afterEach(() => {
    delete window.__WORKBENCH_CORE__;
  });

  it("reads what changed and every file, leaving a deleted file out, and answers a query", async () => {
    const gitStatus = vi.fn(async () => [
      { path: "src/a.ts", status: "M", add: 1, del: 0, binary: false },
      { path: "gone.ts", status: "D", add: 0, del: 3, binary: false },
      { path: "old/gone.ts", status: "D", add: 0, del: 3, binary: false },
    ]);
    // As the core does, the listing holds a file deleted from the tree
    // but not from the index.
    const gitFiles = vi.fn(async () => ["README.md", "gone.ts", "old/gone.ts", "src/a.ts", "src/b.ts"]);
    setCore({ gitStatus, gitFiles });
    find("b");
    await list("/r");
    expect(finder.changed.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(finder.top).toEqual(["README.md", "src/"]);
    expect(finder.found.query).toBe("b");
    expect(finder.found.paths.map((found) => found.path)).toEqual(["src/b.ts"]);
    find("a.");
    expect(finder.found.paths.map((found) => found.path)).toEqual(["src/a.ts"]);
    find("gone");
    expect(finder.found.paths).toEqual([]);
    expect(isListed("src/b.ts")).toBe(true);
    expect(isListed("gone.ts")).toBe(false);
    expect(gitFiles).toHaveBeenCalledTimes(1);
  });

  it("says why the files could not be read", async () => {
    setCore({
      gitStatus: async () => [],
      gitFiles: async () => {
        throw new Error("not a repository");
      },
    });
    await list("/r");
    expect(finder.listed).toBe(false);
    expect(finder.error).toContain("not a repository");
  });
});

describe("the worker for a large listing", () => {
  class FakeWorker {
    static last: FakeWorker | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    posted: { kind: string; id: number; query?: string }[] = [];
    constructor() {
      FakeWorker.last = this;
    }
    postMessage(message: { kind: string; id: number }) {
      this.posted.push(message);
    }
    terminate() {}
  }
  const many = Array.from({ length: 6000 }, (_, at) => `src/file${at}.ts`);

  beforeEach(() => {
    reset();
    vi.stubGlobal("Worker", FakeWorker);
    setCore({ gitStatus: async () => [], gitFiles: async () => many });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    reset();
    delete window.__WORKBENCH_CORE__;
  });

  it("keeps the listing here when the worker fails, and answers from it", async () => {
    await list("/r");
    const worker = FakeWorker.last!;
    expect(worker.posted[0].kind).toBe("list");
    expect(finder.listed).toBe(false);
    find("file5999");
    worker.onerror!();
    expect(finder.listed).toBe(true);
    expect(finder.found.paths[0].path).toBe("src/file5999.ts");
  });

  it("drops an answer for the folder listed before", async () => {
    await list("/a");
    const worker = FakeWorker.last!;
    worker.onmessage!({ data: { kind: "listed", id: worker.posted[0].id, top: ["src/"] } });
    find("file1");
    const asked = worker.posted.at(-1)!;
    await list("/b");
    worker.onmessage!({
      data: { kind: "found", id: asked.id, query: "file1", found: [{ path: "src/file1.ts", marks: [] }], total: 1 },
    });
    expect(finder.root).toBe("/b");
    expect(finder.found.paths).toEqual([]);
  });
});

describe("the mentions kept with a message", () => {
  beforeEach(() => resetMentioned());

  it("are known by the message's id, and kept between runs", () => {
    mentionedIn("m-1", [{ start: 4, end: 13, path: "src/a.ts" }]);
    mentionedIn("m-2", []);
    expect(mentionsOf("m-1")).toEqual([{ start: 4, end: 13, path: "src/a.ts" }]);
    expect(mentionsOf("m-2")).toEqual([]);
    expect(JSON.parse(localStorage.getItem("workbench.mentions")!)).toEqual({
      "m-1": [{ start: 4, end: 13, path: "src/a.ts" }],
    });
  });
});
