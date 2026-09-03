import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  basename,
  canDiff,
  changedCount,
  clear,
  effectiveView,
  files,
  isOpen,
  listed,
  refresh,
  reveal,
  select,
  selectedEntry,
  setScope,
  setView,
  toggleDir,
  toggleScope,
  toggleView,
} from "$lib/files.svelte";
import { workspace, reset as resetWorkspace } from "$lib/workspace.svelte";

const ROOT = "/repo";

/** What the core would report. Reassigned per test to stand in for git. */
const fake = {
  status: [] as { path: string; status: string; add: number; del: number; binary: boolean }[],
  fileList: [] as string[],
  diff: { lines: [{ kind: "hunk", text: "@@ -1 +1 @@", old: null, new: null }], binary: false, truncated: false },
  content: { lines: ["one", "two"], binary: false, truncated: false },
  statusCalls: 0,
  diffCalls: 0,
  fail: null as string | null,
};

vi.mock("$lib/core", () => ({
  core: () => ({
    async gitStatus() {
      fake.statusCalls += 1;
      if (fake.fail !== null) throw new Error(fake.fail);
      return fake.status;
    },
    async gitFiles() {
      return fake.fileList;
    },
    async gitDiff() {
      fake.diffCalls += 1;
      return fake.diff;
    },
    async gitContent() {
      return fake.content;
    },
    async gitWatch() {},
    async onGitChanged() {
      return () => {};
    },
    async setWindowTitle() {},
    async projectInfo(path: string) {
      return { path, name: path, repository: path, isGit: true };
    },
  }),
}));

const changed = (path: string, status = "M", add = 2, del = 1) => ({
  path,
  status,
  add,
  del,
  binary: false,
});

beforeEach(() => {
  clear();
  resetWorkspace();
  workspace.open.push({ path: ROOT, name: "repo", repository: ROOT, isGit: true });
  workspace.active = ROOT;

  fake.status = [changed("src/cache/mod.rs"), changed("src/lib.rs"), changed("gone.rs", "D", 0, 41)];
  fake.fileList = ["Cargo.toml", "src/cache/mod.rs", "src/lib.rs", "src/main.rs"];
  fake.statusCalls = 0;
  fake.diffCalls = 0;
  fake.fail = null;
});

describe("refresh", () => {
  it("reads the changed files from the core", async () => {
    await refresh();
    expect(changedCount()).toBe(3);
    expect(listed().map((f) => f.path)).toContain("src/lib.rs");
  });

  it("reports an error rather than showing a stale tree", async () => {
    await refresh();
    fake.fail = "not a git repository";
    await refresh();

    expect(files.error).toContain("not a git repository");
    expect(listed()).toHaveLength(0);
  });

  it("shows nothing when no project is open", async () => {
    resetWorkspace();
    await refresh();
    expect(listed()).toHaveLength(0);
    expect(fake.statusCalls).toBe(0);
  });

  // The watcher says the tree moved; the pane asks again.
  it("re-reads on every call, because the core keeps no state", async () => {
    await refresh();
    await refresh();
    expect(fake.statusCalls).toBe(2);
  });

  it("re-reads the open file's diff, which the agent may have changed", async () => {
    await refresh();
    await select("src/lib.rs");
    const before = fake.diffCalls;

    await refresh();
    expect(fake.diffCalls).toBeGreaterThan(before);
  });
});

describe("scope", () => {
  it("lists only changed files by default", async () => {
    await refresh();
    expect(listed()).toHaveLength(3);
    expect(listed().every((f) => f.status !== null)).toBe(true);
  });

  it("adds unchanged files in the all-files scope", async () => {
    await refresh();
    await setScope("all");

    const paths = listed().map((f) => f.path);
    expect(paths).toContain("Cargo.toml");
    expect(paths).toContain("src/main.rs");
    expect(listed().some((f) => f.status === null)).toBe(true);
  });

  it("keeps status and counts on files that appear in both", async () => {
    await refresh();
    await setScope("all");

    const entry = listed().find((f) => f.path === "src/lib.rs")!;
    expect(entry.status).toBe("M");
    expect(entry.add).toBe(2);
  });

  // A deleted file is in status but no longer in the listing.
  it("still shows a deleted file in the all-files scope", async () => {
    await refresh();
    await setScope("all");
    expect(listed().map((f) => f.path)).toContain("gone.rs");
  });

  it("only asks for the full listing when it is needed", async () => {
    await refresh();
    expect(files.everythingLoaded).toBe(false);
    await setScope("all");
    expect(files.everythingLoaded).toBe(true);
  });

  it("toggles between the two", async () => {
    await refresh();
    await toggleScope();
    expect(files.scope).toBe("all");
    await toggleScope();
    expect(files.scope).toBe("changed");
  });

  it("drops a selection that narrowing the scope removes", async () => {
    await refresh();
    await setScope("all");
    await select("Cargo.toml");
    await setScope("changed");

    expect(files.selected).toBeNull();
    expect(files.diff).toBeNull();
  });

  it("keeps a selection that survives the narrowing", async () => {
    await refresh();
    await setScope("all");
    await select("src/lib.rs");
    await setScope("changed");
    expect(files.selected).toBe("src/lib.rs");
  });
});

describe("selection", () => {
  it("loads the diff for a changed file", async () => {
    await refresh();
    await select("src/lib.rs");
    expect(files.diff?.lines.length).toBeGreaterThan(0);
    expect(effectiveView()).toBe("diff");
  });

  it("loads content too, so switching view needs no round trip", async () => {
    await refresh();
    await select("src/lib.rs");
    expect(files.content?.lines).toEqual(["one", "two"]);
  });

  // Widening the scope must never land you on an empty pane.
  it("falls back to content for a file with no diff", async () => {
    await refresh();
    await setScope("all");
    await select("Cargo.toml");

    expect(files.view).toBe("diff");
    expect(effectiveView()).toBe("content");
    expect(files.diff).toBeNull();
  });

  // A deleted file has a diff but nothing left to read.
  it("asks for no content for a deleted file", async () => {
    await refresh();
    await select("gone.rs");
    expect(files.diff).not.toBeNull();
    expect(files.content).toBeNull();
  });

  it("is null when nothing is selected", () => {
    expect(selectedEntry()).toBeNull();
  });

  it("is null when the selection is not in the current list", async () => {
    await refresh();
    files.selected = "nope/missing.rs";
    expect(selectedEntry()).toBeNull();
  });
});

describe("canDiff", () => {
  it("is true for a changed text file", async () => {
    await refresh();
    await select("src/lib.rs");
    expect(canDiff(selectedEntry())).toBe(true);
  });

  it("is false for an unchanged file", async () => {
    await refresh();
    await setScope("all");
    await select("Cargo.toml");
    expect(canDiff(selectedEntry())).toBe(false);
  });

  it("is false for a binary file", () => {
    expect(canDiff({ path: "a.png", status: "M", binary: true })).toBe(false);
  });

  it("is false with nothing selected", () => {
    expect(canDiff(null)).toBe(false);
  });
});

describe("view", () => {
  it("switches to content and back", async () => {
    await refresh();
    await select("src/lib.rs");

    setView("content");
    expect(effectiveView()).toBe("content");
    setView("diff");
    expect(effectiveView()).toBe("diff");
  });

  it("toggles", async () => {
    await refresh();
    await select("src/lib.rs");
    toggleView();
    expect(effectiveView()).toBe("content");
  });
});

describe("folder state", () => {
  const dir = (path: string, hasChange: boolean) => ({ path, hasChange });

  // The default that makes the all-files scope usable.
  it("opens a folder that holds a change and shuts one that does not", () => {
    expect(isOpen(dir("src", true))).toBe(true);
    expect(isOpen(dir("docs", false))).toBe(false);
  });

  it("lets you shut a folder the default opened", () => {
    toggleDir(dir("src", true));
    expect(isOpen(dir("src", true))).toBe(false);
  });

  it("returns to the default when toggled back, storing no override", () => {
    toggleDir(dir("docs", false));
    toggleDir(dir("docs", false));
    expect(isOpen(dir("docs", false))).toBe(false);
    expect(files.expanded.has("docs")).toBe(false);
    expect(files.collapsed.has("docs")).toBe(false);
  });

  it("opens every folder on the way to a selected file", async () => {
    await refresh();
    await select("src/cache/mod.rs");
    expect(isOpen(dir("src", false))).toBe(true);
    expect(isOpen(dir("src/cache", false))).toBe(true);
  });

  it("reopens a folder you had shut, so a selection is never hidden", () => {
    toggleDir(dir("src", true));
    reveal("src/cache/mod.rs");
    expect(isOpen(dir("src", true))).toBe(true);
  });
});

describe("clear", () => {
  it("forgets everything when the project changes", async () => {
    await refresh();
    await select("src/lib.rs");
    toggleDir({ path: "src", hasChange: true });

    clear();
    expect(listed()).toHaveLength(0);
    expect(files.selected).toBeNull();
    expect(files.diff).toBeNull();
    expect(files.scope).toBe("changed");
    expect(files.expanded.size).toBe(0);
    expect(files.collapsed.size).toBe(0);
  });
});

describe("basename", () => {
  it("takes the last segment", () => {
    expect(basename("src/cache/mod.rs")).toBe("mod.rs");
  });

  it("leaves a bare filename alone", () => {
    expect(basename("Cargo.toml")).toBe("Cargo.toml");
  });
});
