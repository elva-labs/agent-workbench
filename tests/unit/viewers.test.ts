import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetViewers, sessionShown, snapshot } from "$lib/viewers.svelte";
import { clear, closeViewer, files, refresh, showMedia, showRange } from "$lib/files.svelte";
import { enterReview, layout } from "$lib/layout.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

/** The sessions the window knows, by key. */
const known = new Set<string>();

vi.mock("$lib/sessions.svelte", async (original) => ({
  ...(await original<typeof import("$lib/sessions.svelte")>()),
  byKey: (key: string) => (known.has(key) ? { key } : null),
}));

vi.mock("$lib/core", () => ({
  core: () => ({
    async setWindowTitle() {},
    async projectInfo(path: string) {
      return { path, name: path, repository: path, isGit: true };
    },
    async gitStatus() {
      return [{ path: "docs/a.md", status: "M", add: 1, del: 0, binary: false }];
    },
    async gitFiles() {
      return ["docs/a.md", "src/b.rs"];
    },
    async gitDiff() {
      return { lines: [], binary: false, truncated: false };
    },
    async gitContent() {
      return { lines: ["one", "two", "three"], binary: false, truncated: false };
    },
    async setSelection() {},
    async watchShown() {},
  }),
}));

const repo = (path: string) => ({
  path,
  name: path.split("/").pop()!,
  repository: path,
  isGit: true,
});

const item = {
  id: "m1",
  owner: "a",
  project: "/one",
  files: ["/tmp/draft.md"],
  caption: "The draft.",
  at: 1,
};

beforeEach(async () => {
  resetWorkspace();
  clear();
  resetViewers();
  known.clear();
  known.add("a");
  known.add("b");
  layout.mode = "working";
  layout.focus = "agent";
  layout.width = 1600;
  files.media = null;
  workspace.open.push(repo("/one"), repo("/two"));
  workspace.active = "/one";
  await refresh();
});

describe("what a session had in the viewer", () => {
  it("is nothing while the viewer is closed", () => {
    files.selected = "docs/a.md";
    expect(snapshot()).toBeNull();
  });

  it("is the file, its view and the place marked in it", async () => {
    await showRange("docs/a.md", 2, 3, "Here.");
    expect(snapshot()).toEqual({
      kind: "file",
      project: "/one",
      path: "docs/a.md",
      view: "content",
      target: { path: "docs/a.md", line: 2, to: 3, note: "Here." },
      picked: null,
    });
  });

  it("is what the agent presented", () => {
    showMedia(item);
    expect(snapshot()).toEqual({ kind: "media", project: "/one", item });
  });
});

describe("switching sessions", () => {
  it("keeps the viewer of the session left and brings it back", async () => {
    await sessionShown("a");
    await showRange("docs/a.md", 2, 2, null);
    expect(layout.mode).toBe("reviewing");

    // The other session had nothing: the viewer empties and stays open.
    await sessionShown("b");
    expect(files.selected).toBeNull();
    expect(layout.mode).toBe("reviewing");

    await sessionShown("a");
    expect(files.selected).toBe("docs/a.md");
    expect(files.view).toBe("content");
    expect(files.target).toEqual({ path: "docs/a.md", line: 2, to: 2, note: null });
    expect(layout.mode).toBe("reviewing");
  });

  it("opens the viewer again for a session that had one, after it was closed elsewhere", async () => {
    await sessionShown("a");
    showMedia(item);
    await sessionShown("b");
    closeViewer();
    expect(layout.mode).toBe("working");

    await sessionShown("a");
    expect(files.media).toEqual(item);
    expect(layout.mode).toBe("reviewing");
  });

  it("takes a file that git has not changed from the whole tree", async () => {
    await sessionShown("a");
    await showRange("src/b.rs", 1, 1, null);
    await sessionShown("b");
    files.scope = "changed";
    await sessionShown("a");
    expect(files.scope).toBe("all");
    expect(files.selected).toBe("src/b.rs");
  });

  it("remembers the viewer as it was left, not as it was first opened", async () => {
    await sessionShown("a");
    await showRange("docs/a.md", 1, 1, null);
    closeViewer();
    await sessionShown("b");
    await sessionShown("a");
    expect(files.selected).toBeNull();
    expect(layout.mode).toBe("working");
  });

  it("forgets a session that is gone", async () => {
    await sessionShown("a");
    await showRange("docs/a.md", 1, 1, null);
    await sessionShown("b");
    known.delete("a");
    await sessionShown("b");
    known.add("a");
    await sessionShown("a");
    expect(files.selected).toBeNull();
  });

  it("leaves a viewer from another project alone", async () => {
    await sessionShown("a");
    await showRange("docs/a.md", 1, 1, null);
    await sessionShown("b");
    workspace.active = "/two";
    clear();
    enterReview();
    await sessionShown("a");
    expect(files.selected).toBeNull();
  });
});
