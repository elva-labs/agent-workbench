import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  askDelete,
  cancelName,
  commitName,
  confirmDelete,
  deleteQuestion,
  fileOps,
  newFile,
  newFolder,
  pathFor,
  rename,
  resetFileOps,
  revealLabel,
  setName,
} from "$lib/fileOps.svelte";
import { activeTab, editor, keyOf, openFile, resetEditor } from "$lib/editor.svelte";
import { clear, files, refresh, setScope } from "$lib/files.svelte";
import { layout } from "$lib/layout.svelte";
import { sessions } from "$lib/sessions.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

/** The working tree the fake core keeps: text by path. */
const disk = new Map<string, string>();
const calls: unknown[][] = [];

vi.mock("$lib/core", () => ({
  core: () => ({
    async setWindowTitle() {},
    async gitStatus() {
      return [];
    },
    async gitFiles() {
      return [...disk.keys()].sort();
    },
    async gitDiff() {
      return { lines: [], binary: false, truncated: false };
    },
    async gitContent() {
      return { lines: [], binary: false, truncated: false };
    },
    async fileRead(_root: string, file: string) {
      const text = disk.get(file);
      if (text === undefined) throw new Error(`${file} is not there`);
      return { text, stamp: `s:${text}` };
    },
    async fileWrite(root: string, file: string, text: string, stamp: string | null) {
      calls.push(["write", root, file, text, stamp]);
      if (stamp === null && disk.has(file)) return { written: false, stamp: `s:${disk.get(file)}` };
      disk.set(file, text);
      return { written: true, stamp: `s:${text}` };
    },
    async pathRename(root: string, from: string, to: string) {
      calls.push(["rename", root, from, to]);
      for (const path of [...disk.keys()]) {
        if (path === from || path.startsWith(`${from}/`)) {
          disk.set(`${to}${path.slice(from.length)}`, disk.get(path)!);
          disk.delete(path);
        }
      }
    },
    async pathDelete(root: string, path: string) {
      calls.push(["delete", root, path]);
      for (const candidate of [...disk.keys()]) {
        if (candidate === path || candidate.startsWith(`${path}/`)) disk.delete(candidate);
      }
    },
    async copyText(text: string) {
      calls.push(["copy", text]);
    },
    async setSelection() {},
    async watchShown() {},
    async browserFocus() {
      return { tabs: [], owner: null, active: null };
    },
    async browserHide() {},
  }),
}));

const repo = (path: string) => ({ path, name: path.split("/").pop()!, repository: path, isGit: true });

beforeEach(async () => {
  resetFileOps();
  resetEditor();
  resetWorkspace();
  clear();
  disk.clear();
  calls.length = 0;
  disk.set("docs/a.md", "a\n");
  disk.set("src/lib/b.rs", "b\n");
  disk.set("src/lib/c.rs", "c\n");
  layout.mode = "editing";
  sessions.active = null;
  workspace.open.push(repo("/one"));
  workspace.active = "/one";
  await refresh();
  await setScope("all");
});

describe("a name as a path", () => {
  it("is a path under its folder, slashes either way making folders", () => {
    expect(pathFor("src", "a.rs")).toEqual({ path: "src/a.rs" });
    expect(pathFor(null, "a/b\\c.rs")).toEqual({ path: "a/b/c.rs" });
    expect(pathFor("src", " /x/ ")).toEqual({ path: "src/x" });
  });

  it("will not step out of its folder, or into .git", () => {
    expect(pathFor("src", "../a")).toEqual({ problem: "A name cannot step out of its folder." });
    expect(pathFor(null, ".git/hooks/x")).toEqual({ problem: "Nothing is made inside .git." });
    expect(pathFor(null, "   ")).toEqual({ problem: "A name is needed." });
  });
});

describe("a new file", () => {
  it("goes in the folder the cursor is in", () => {
    fileOps.cursor = { path: "src/lib/b.rs", dir: false };
    newFile();
    expect(fileOps.naming).toEqual({ kind: "file", folder: "src/lib" });
    fileOps.cursor = { path: "docs", dir: true };
    newFile();
    expect(fileOps.naming).toEqual({ kind: "file", folder: "docs" });
  });

  it("is made empty on Enter, with the folders on the way, and opens as a kept tab", async () => {
    newFile("src");
    setName("deep/new.rs");
    await commitName();
    expect(calls).toContainEqual(["write", "/one", "src/deep/new.rs", "", null]);
    expect(fileOps.naming).toBeNull();
    expect(activeTab()).toMatchObject({ path: "src/deep/new.rs", preview: false });
  });

  it("says when something is already there, and keeps the field", async () => {
    newFile("docs");
    setName("a.md");
    await commitName();
    expect(fileOps.problem).toBe("Something is already at docs/a.md.");
    expect(fileOps.naming).toEqual({ kind: "file", folder: "docs" });
    expect(disk.get("docs/a.md")).toBe("a\n");
  });

  it("is dropped on Escape, and on Enter with nothing typed", async () => {
    newFile("docs");
    cancelName();
    expect(fileOps.naming).toBeNull();
    newFile("docs");
    await commitName();
    expect(fileOps.naming).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("a new folder", () => {
  it("is made with its first file, not before", async () => {
    newFolder("src");
    setName("cache");
    await commitName();
    expect(calls).toEqual([]);
    expect(fileOps.pending).toBe("src/cache");
    expect(fileOps.naming).toEqual({ kind: "first", folder: "src/cache" });
    setName("mod.rs");
    await commitName();
    expect(calls).toContainEqual(["write", "/one", "src/cache/mod.rs", "", null]);
    expect(fileOps.pending).toBeNull();
  });

  it("drops the folder with the field on Escape", async () => {
    newFolder(null);
    setName("empty");
    await commitName();
    cancelName();
    expect(fileOps.pending).toBeNull();
    expect(fileOps.naming).toBeNull();
  });

  it("names a folder that is already there without showing it twice", async () => {
    newFolder("src");
    setName("lib");
    await commitName();
    expect(fileOps.pending).toBeNull();
    expect(fileOps.naming).toEqual({ kind: "first", folder: "src/lib" });
  });
});

describe("renaming", () => {
  it("moves the file and the tabs on it, edits and all", async () => {
    await openFile("src/lib/b.rs", { keep: true });
    rename("src/lib/b.rs", false);
    expect(fileOps.name).toBe("b.rs");
    setName("../moved.rs");
    await commitName();
    expect(fileOps.problem).toBe("A name cannot step out of its folder.");
    setName("bee.rs");
    await commitName();
    expect(calls).toContainEqual(["rename", "/one", "src/lib/b.rs", "src/lib/bee.rs"]);
    expect(activeTab()?.path).toBe("src/lib/bee.rs");
    expect(editor.buffers[keyOf("/one", "src/lib/bee.rs")]).toBeDefined();
    expect(editor.buffers[keyOf("/one", "src/lib/b.rs")]).toBeUndefined();
  });

  it("moves a folder and every tab inside it", async () => {
    await openFile("src/lib/c.rs", { keep: true });
    rename("src/lib", true);
    setName("core");
    await commitName();
    expect(activeTab()?.path).toBe("src/core/c.rs");
  });
});

describe("deleting", () => {
  it("asks first, saying what goes", () => {
    askDelete("src/lib", true);
    expect(deleteQuestion()).toEqual({
      question: "Delete src/lib and everything in it?",
      detail: "The folder and all 2 files in it are deleted from the disk, not moved to the trash.",
    });
    askDelete("docs/a.md", false);
    expect(deleteQuestion()?.question).toBe("Delete docs/a.md?");
  });

  it("deletes on the answer and closes the tabs on what went", async () => {
    await openFile("src/lib/b.rs", { keep: true });
    await openFile("docs/a.md", { keep: true });
    askDelete("src/lib", true);
    await confirmDelete();
    expect(calls).toContainEqual(["delete", "/one", "src/lib"]);
    expect(editor.tabs.map((tab) => tab.path)).toEqual(["docs/a.md"]);
    expect(fileOps.deleting).toBeNull();
    expect(files.everything.map((file) => file.path)).toEqual(["docs/a.md"]);
  });
});

describe("showing a file in the file manager", () => {
  it("is named for the platform", () => {
    expect(["Reveal in Finder", "Show in Explorer", "Show in file manager"]).toContain(revealLabel());
  });
});
