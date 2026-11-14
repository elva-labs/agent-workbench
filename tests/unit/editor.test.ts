import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import {
  activeTab,
  activate,
  attachView,
  closeTab,
  editor,
  editorShows,
  keep,
  keyOf,
  openFile,
  ownerShown,
  resetEditor,
  setTabView,
  stateOf,
  unsavedAt,
  viewsOf,
  walkView,
  zoomEditor,
  loadEditorSize,
} from "$lib/editor.svelte";
import { changeBetween, languageOf } from "$lib/codeEditor";
import { clear, files, refresh, setScope } from "$lib/files.svelte";
import { layout } from "$lib/layout.svelte";
import { sessions } from "$lib/sessions.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";
import { showRequested } from "$lib/show.svelte";

/** What the fake disk holds, by path. */
const disk = new Map<string, string>();
/** Paths the fake core reads as binary. */
const binary = new Set<string>();

vi.mock("$lib/core", () => ({
  core: () => ({
    async setWindowTitle() {},
    async gitStatus() {
      return [{ path: "docs/a.md", status: "M", add: 1, del: 0, binary: false }];
    },
    async gitFiles() {
      return ["docs/a.md", "src/b.rs", "src/c.rs", "logo.png"];
    },
    async gitDiff() {
      return { lines: [], binary: false, truncated: false };
    },
    async gitContent() {
      return { lines: ["one"], binary: false, truncated: false };
    },
    async fileRead(_root: string, file: string) {
      if (binary.has(file)) throw new Error(`${file} is a binary file, not text`);
      const text = disk.get(file);
      if (text === undefined) throw new Error(`${file} is not there`);
      return { text, stamp: `s:${text.length}` };
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

/** A CodeMirror view in the page, attached to the store as the editor
    component attaches one, showing the buffer in front. */
function mount(): EditorView {
  const key = editor.active!;
  const view = new EditorView({ parent: document.body, state: stateOf(key)! });
  attachView(view);
  editorShows(key);
  return view;
}

beforeEach(async () => {
  resetEditor();
  resetWorkspace();
  clear();
  disk.clear();
  binary.clear();
  disk.set("docs/a.md", "# A\n\nfirst\nsecond\n");
  disk.set("src/b.rs", "fn b() {}\n");
  disk.set("src/c.rs", "fn c() {}\n");
  binary.add("logo.png");
  layout.mode = "editing";
  layout.focus = "changes";
  sessions.active = null;
  workspace.open.push(repo("/one"), repo("/two"));
  workspace.active = "/one";
  await refresh();
  await setScope("all");
  document.body.innerHTML = "";
});

describe("opening files", () => {
  it("opens a file looked at as the preview tab, and reuses it for the next", async () => {
    await openFile("docs/a.md");
    expect(editor.tabs).toHaveLength(1);
    expect(editor.tabs[0].preview).toBe(true);
    await openFile("src/b.rs");
    expect(editor.tabs.map((tab) => tab.path)).toEqual(["src/b.rs"]);
    expect(activeTab()?.path).toBe("src/b.rs");
  });

  it("opens a kept file as a tab of its own, after the one in front", async () => {
    await openFile("docs/a.md", { keep: true });
    await openFile("src/c.rs", { keep: true });
    await activate(keyOf("/one", "docs/a.md"));
    await openFile("src/b.rs", { keep: true });
    expect(editor.tabs.map((tab) => tab.path)).toEqual(["docs/a.md", "src/b.rs", "src/c.rs"]);
  });

  it("keeps a preview tab on a double-click, so the next file gets a tab of its own", async () => {
    await openFile("docs/a.md");
    keep(keyOf("/one", "docs/a.md"));
    await openFile("src/b.rs");
    expect(editor.tabs.map((tab) => [tab.path, tab.preview])).toEqual([
      ["docs/a.md", false],
      ["src/b.rs", true],
    ]);
  });

  it("brings a file that has a tab to the front rather than opening it again", async () => {
    await openFile("docs/a.md", { keep: true });
    await openFile("src/b.rs", { keep: true });
    await openFile("docs/a.md");
    expect(editor.tabs).toHaveLength(2);
    expect(activeTab()?.path).toBe("docs/a.md");
  });

  it("reads the file into a buffer with its stamp, and marks it in the tree", async () => {
    await openFile("docs/a.md");
    const buffer = editor.buffers[keyOf("/one", "docs/a.md")];
    expect(buffer.loading).toBe(false);
    expect(buffer.stamp).toBe("s:18");
    expect(stateOf(keyOf("/one", "docs/a.md"))?.doc.toString()).toBe("# A\n\nfirst\nsecond\n");
    expect(files.selected).toBe("docs/a.md");
  });

  it("says why a file cannot be edited as text", async () => {
    await openFile("logo.png");
    const buffer = editor.buffers[keyOf("/one", "logo.png")];
    expect(buffer.error).toBe("logo.png is a binary file, not text");
    expect(stateOf(keyOf("/one", "logo.png"))).toBeNull();
  });

  it("asks for a place to be brought into view", async () => {
    await openFile("docs/a.md", { line: 3, to: 4 });
    expect(editor.reveal).toEqual({ key: keyOf("/one", "docs/a.md"), from: 3, to: 4 });
  });
});

describe("closing tabs", () => {
  it("brings the tab beside it to the front, and lets the buffer go", async () => {
    await openFile("docs/a.md", { keep: true });
    await openFile("src/b.rs", { keep: true });
    await openFile("src/c.rs", { keep: true });
    await activate(keyOf("/one", "src/b.rs"));
    closeTab(keyOf("/one", "src/b.rs"));
    expect(activeTab()?.path).toBe("src/c.rs");
    expect(editor.buffers[keyOf("/one", "src/b.rs")]).toBeUndefined();
    closeTab(keyOf("/one", "src/c.rs"));
    expect(activeTab()?.path).toBe("docs/a.md");
  });

  it("leaves nothing in the viewer when the last tab goes", async () => {
    await openFile("docs/a.md");
    closeTab(keyOf("/one", "docs/a.md"));
    expect(editor.active).toBeNull();
    await Promise.resolve();
    expect(files.selected).toBeNull();
  });
});

describe("editing", () => {
  it("marks the buffer unsaved, keeps its preview tab, and clears the note", async () => {
    await openFile("docs/a.md", { note: "Look here." });
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    const key = keyOf("/one", "docs/a.md");
    expect(editor.buffers[key].dirty).toBe(true);
    expect(unsavedAt("docs/a.md")).toBe(true);
    expect(activeTab()?.preview).toBe(false);
    expect(activeTab()?.note).toBeNull();
    view.destroy();
  });

  it("is saved again once the edit is taken back", async () => {
    await openFile("docs/a.md");
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    view.dispatch({ changes: { from: 0, to: 1 } });
    expect(editor.buffers[keyOf("/one", "docs/a.md")].dirty).toBe(false);
    view.destroy();
  });

  it("follows the cursor for the foot, and puts selected lines on record", async () => {
    await openFile("docs/a.md");
    const view = mount();
    view.dispatch({ selection: { anchor: 6, head: 14 } });
    expect(editor.cursor).toEqual({ line: 4, col: 4 });
    expect(files.picked).toEqual({ path: "docs/a.md", from: 3, to: 4 });
    view.dispatch({ selection: { anchor: 2 } });
    expect(files.picked).toBeNull();
    view.destroy();
  });
});

describe("the views", () => {
  it("are editing, the diff when git changed the file, and rendered for Markdown", async () => {
    await openFile("docs/a.md");
    expect(viewsOf(activeTab())).toEqual(["edit", "diff", "preview"]);
    await openFile("src/b.rs");
    expect(viewsOf(activeTab())).toEqual(["edit"]);
  });

  it("walk round and round, and set the viewer's view to match", async () => {
    await openFile("docs/a.md");
    walkView();
    expect(activeTab()?.view).toBe("diff");
    await Promise.resolve();
    expect(files.view).toBe("diff");
    walkView();
    expect(activeTab()?.view).toBe("preview");
    walkView();
    expect(activeTab()?.view).toBe("edit");
  });

  it("refuse a view the file does not have", async () => {
    await openFile("src/b.rs");
    setTabView("diff");
    expect(activeTab()?.view).toBe("edit");
  });
});

describe("each session's tabs", () => {
  it("are put away when another session is shown, and come back with it", async () => {
    sessions.active = "a";
    await ownerShown();
    await openFile("docs/a.md", { keep: true });
    sessions.active = "b";
    await ownerShown();
    expect(editor.tabs).toEqual([]);
    await openFile("src/b.rs", { keep: true });
    sessions.active = "a";
    await ownerShown();
    expect(editor.tabs.map((tab) => tab.path)).toEqual(["docs/a.md"]);
    expect(activeTab()?.path).toBe("docs/a.md");
  });

  it("share one buffer for a file both have open", async () => {
    sessions.active = "a";
    await ownerShown();
    await openFile("docs/a.md", { keep: true });
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    view.destroy();
    attachView(null);
    sessions.active = "b";
    await ownerShown();
    await openFile("docs/a.md", { keep: true });
    expect(stateOf(keyOf("/one", "docs/a.md"))?.doc.toString().startsWith("x# A")).toBe(true);
    // Closing it in one session leaves it open in the other.
    closeTab(keyOf("/one", "docs/a.md"));
    expect(editor.buffers[keyOf("/one", "docs/a.md")]).toBeDefined();
  });
});

describe("what a tool points at in editor mode", () => {
  it("opens as a tab at its line, with what the tool said", async () => {
    await showRequested({
      path: "/one/docs/a.md",
      from: 3,
      to: 4,
      note: "This part.",
      cwd: "/one",
      session: null,
    });
    expect(activeTab()).toMatchObject({ path: "docs/a.md", note: "This part.", preview: true });
    expect(editor.reveal).toEqual({ key: keyOf("/one", "docs/a.md"), from: 3, to: 4 });
    expect(layout.mode).toBe("editing");
  });
});

describe("the editor's text size", () => {
  it("steps a pixel at a time within the terminal's bounds, and is kept", () => {
    zoomEditor(1);
    expect(editor.size).toBe(13);
    for (let i = 0; i < 30; i++) zoomEditor(1);
    expect(editor.size).toBe(24);
    zoomEditor(0);
    expect(editor.size).toBe(12);
    zoomEditor(-1);
    editor.size = 12;
    loadEditorSize();
    expect(editor.size).toBe(11);
  });
});

describe("a reload's change", () => {
  it("is the part between what is the same at both ends", () => {
    expect(changeBetween("abcdef", "abXYef")).toEqual({ from: 2, to: 4, insert: "XY" });
    expect(changeBetween("same", "same")).toBeNull();
    expect(changeBetween("ab", "abc")).toEqual({ from: 2, to: 2, insert: "c" });
    expect(changeBetween("aaa", "aa")).toEqual({ from: 2, to: 3, insert: "" });
  });
});

describe("the language at the foot", () => {
  it("is named from the file's extension", () => {
    expect(languageOf("docs/layout.md")).toBe("Markdown");
    expect(languageOf("src/lib/layout.svelte.ts")).toBe("TypeScript");
    expect(languageOf("Dockerfile")).toBe("Dockerfile");
    expect(languageOf("LICENSE")).toBe("Plain text");
    expect(languageOf(".gitignore")).toBe("Plain text");
  });
});

