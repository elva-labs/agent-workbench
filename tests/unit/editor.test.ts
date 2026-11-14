import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import {
  activeTab,
  activate,
  anyUnsaved,
  cancelAsk,
  closeDropping,
  closeFront,
  closeTabInFront,
  closeWithoutSaving,
  closeAsking,
  closingDrop,
  closingSave,
  diskChanged,
  leaveCancelled,
  leaveRequested,
  leaveWithoutSaving,
  saveAllAndLeave,
  ownerGoneForTests,
  compare,
  diskText,
  keepMine,
  loadFromDisk,
  recheckOpen,
  save,
  saveAndClose,
  watchedFiles,
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
import { languageOf } from "$lib/codeEditor";
import { flash } from "$lib/flash.svelte";
import { undo } from "@codemirror/commands";
import { clear, files, refresh, setScope } from "$lib/files.svelte";
import { layout } from "$lib/layout.svelte";
import { sessions } from "$lib/sessions.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";
import { showRequested } from "$lib/show.svelte";

/** What the fake disk holds, by path. */
const disk = new Map<string, string>();
/** Paths the fake core reads as binary. */
const binary = new Set<string>();
/** Every write the fake core was asked for. */
const writes: { file: string; text: string; stamp: string | null; overwrite: boolean }[] = [];
/** The window controls the fake core was asked for. */
const controls: string[] = [];
/** The reads held back, to be answered in the order a test chooses, while
    this is not null. */
let heldReads: (() => void)[] | null = null;
/** Files the fake core will not write. */
const readOnly = new Set<string>();
/** A stamp names exact content. */
const stampOf = (text: string) => `s:${text}`;

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
      if (binary.has(file)) throw new Error(`${file} is a binary file`);
      const text = disk.get(file);
      if (text === undefined) throw new Error(`${file} does not exist`);
      const answer = { text, stamp: stampOf(text) };
      // A test can hold the reads back, to answer them in an order of its own.
      if (heldReads !== null) return new Promise((resolve) => heldReads!.push(() => resolve(answer)));
      return answer;
    },
    async fileWrite(_root: string, file: string, text: string, stamp: string | null, overwrite: boolean) {
      writes.push({ file, text, stamp, overwrite });
      if (readOnly.has(file)) throw new Error(`${file} is read-only`);
      const current = disk.get(file);
      if (!overwrite) {
        if (stamp === null && current !== undefined) return { written: false, stamp: stampOf(current) };
        if (stamp !== null && current === undefined) return { written: false, stamp: null };
        if (stamp !== null && current !== undefined && stampOf(current) !== stamp)
          return { written: false, stamp: stampOf(current) };
      }
      disk.set(file, text);
      return { written: true, stamp: stampOf(text) };
    },
    async windowControl(action: string) {
      controls.push(action);
    },
    async leaveHeard(generation: number) {
      controls.push(`heard ${generation}`);
    },
    async leaveConfirmed(kind: string) {
      controls.push(`leave ${kind}`);
    },
    async setUnsaved() {},
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
  writes.length = 0;
  controls.length = 0;
  readOnly.clear();
  heldReads = null;
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
    expect(buffer.stamp).toBe(stampOf("# A\n\nfirst\nsecond\n"));
    expect(stateOf(keyOf("/one", "docs/a.md"))?.doc.toString()).toBe("# A\n\nfirst\nsecond\n");
    expect(files.selected).toBe("docs/a.md");
  });

  it("says why a file cannot be edited as text", async () => {
    await openFile("logo.png");
    const buffer = editor.buffers[keyOf("/one", "logo.png")];
    expect(buffer.error).toBe("logo.png is a binary file");
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

describe("the language at the foot", () => {
  it("is named from the file's extension", () => {
    expect(languageOf("docs/layout.md")).toBe("Markdown");
    expect(languageOf("src/lib/layout.svelte.ts")).toBe("TypeScript");
    expect(languageOf("Dockerfile")).toBe("Dockerfile");
    expect(languageOf("LICENSE")).toBe("Plain text");
    expect(languageOf(".gitignore")).toBe("Plain text");
  });
});


/** Lets every pending read and write land. */
async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("saving", () => {
  it("writes the buffer with the stamp it was read with, and is saved after", async () => {
    await openFile("docs/a.md");
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(await save()).toBe(true);
    expect(writes).toEqual([
      {
        file: "docs/a.md",
        text: "x# A\n\nfirst\nsecond\n",
        stamp: stampOf("# A\n\nfirst\nsecond\n"),
        overwrite: false,
      },
    ]);
    const buffer = editor.buffers[keyOf("/one", "docs/a.md")];
    expect(buffer.dirty).toBe(false);
    expect(buffer.stamp).toBe(stampOf("x# A\n\nfirst\nsecond\n"));
    view.destroy();
  });

  it("never writes over a file that changed underneath: the bar goes up instead", async () => {
    await openFile("docs/a.md");
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "mine " } });
    disk.set("docs/a.md", "theirs\n");
    expect(await save()).toBe(false);
    expect(disk.get("docs/a.md")).toBe("theirs\n");
    const buffer = editor.buffers[keyOf("/one", "docs/a.md")];
    expect(buffer.changed).toEqual({ stamp: stampOf("theirs\n"), problem: null });
    expect(buffer.dirty).toBe(true);
    // A second save does not try again over it.
    expect(await save()).toBe(false);
    expect(writes).toHaveLength(1);
    view.destroy();
  });

  it("writes mine over the disk on Keep mine", async () => {
    await openFile("docs/a.md");
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "mine " } });
    disk.set("docs/a.md", "theirs\n");
    await save();
    await keepMine();
    expect(writes.at(-1)).toMatchObject({ overwrite: true });
    expect(disk.get("docs/a.md")).toBe("mine # A\n\nfirst\nsecond\n");
    const buffer = editor.buffers[keyOf("/one", "docs/a.md")];
    expect(buffer.changed).toBeNull();
    expect(buffer.dirty).toBe(false);
    view.destroy();
  });

  it("drops my edits for the disk's on Load from disk, undoably", async () => {
    await openFile("docs/a.md");
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "mine " } });
    disk.set("docs/a.md", "theirs\n");
    await save();
    await loadFromDisk();
    expect(view.state.doc.toString()).toBe("theirs\n");
    const buffer = editor.buffers[keyOf("/one", "docs/a.md")];
    expect(buffer.dirty).toBe(false);
    expect(buffer.changed).toBeNull();
    view.destroy();
  });

  it("compares the disk's version against mine", async () => {
    await openFile("docs/a.md");
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "mine " } });
    disk.set("docs/a.md", "theirs\n");
    await save();
    await compare();
    expect(editor.comparing).toBe(true);
    expect(diskText(keyOf("/one", "docs/a.md"))).toBe("theirs\n");
    await compare();
    expect(editor.comparing).toBe(false);
    view.destroy();
  });

  it("says the file is gone when the save finds nothing there", async () => {
    await openFile("docs/a.md");
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    disk.delete("docs/a.md");
    expect(await save()).toBe(false);
    expect(editor.buffers[keyOf("/one", "docs/a.md")].changed).toEqual({ stamp: null, problem: null });
    view.destroy();
  });

  it("keeps why a save failed on the file it belongs to", async () => {
    await openFile("docs/a.md", { keep: true });
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    readOnly.add("docs/a.md");
    expect(await save()).toBe(false);
    const key = keyOf("/one", "docs/a.md");
    // The core's sentence names the file; the message says it once.
    expect(editor.buffers[key].failed).toBe("Could not save: docs/a.md is read-only");
    view.destroy();
    attachView(null);
    await openFile("src/b.rs", { keep: true });
    expect(editor.buffers[keyOf("/one", "src/b.rs")].failed).toBeNull();
    readOnly.clear();
    await activate(key);
    const again = mount();
    expect(await save()).toBe(true);
    expect(editor.buffers[key].failed).toBeNull();
    again.destroy();
  });
});

describe("a change on disk", () => {
  it("is read in at once with no unsaved edits, keeping the cursor where it was", async () => {
    await openFile("docs/a.md");
    const view = mount();
    view.dispatch({ selection: { anchor: 12 } });
    disk.set("docs/a.md", "# A\n\nfirst\nsecond\nthird\n");
    recheckOpen();
    await settle();
    expect(view.state.doc.toString()).toBe("# A\n\nfirst\nsecond\nthird\n");
    expect(view.state.selection.main.head).toBe(12);
    expect(editor.buffers[keyOf("/one", "docs/a.md")].dirty).toBe(false);
    view.destroy();
  });

  it("raises the bar under unsaved edits, and leaves them be", async () => {
    await openFile("docs/a.md");
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    disk.set("docs/a.md", "theirs\n");
    recheckOpen();
    await settle();
    expect(view.state.doc.toString().startsWith("x# A")).toBe(true);
    expect(editor.buffers[keyOf("/one", "docs/a.md")].changed).toEqual({
      stamp: stampOf("theirs\n"),
      problem: null,
    });
    view.destroy();
  });

  it("is nothing when the disk holds what the buffer was read with", async () => {
    await openFile("docs/a.md");
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    recheckOpen();
    await settle();
    expect(editor.buffers[keyOf("/one", "docs/a.md")].changed).toBeNull();
    view.destroy();
  });

  it("names the open files for the core to watch", async () => {
    await openFile("docs/a.md", { keep: true });
    await openFile("logo.png", { keep: true });
    expect(watchedFiles()).toEqual(["/one/docs/a.md"]);
  });
});

describe("closing with unsaved edits", () => {
  it("asks first, and closes without saving on the answer", async () => {
    await openFile("docs/a.md");
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    const key = keyOf("/one", "docs/a.md");
    closeTab(key);
    expect(editor.asking).toEqual({ kind: "close", key });
    expect(editor.tabs).toHaveLength(1);
    cancelAsk();
    expect(editor.tabs).toHaveLength(1);
    closeTab(key);
    closeWithoutSaving();
    expect(editor.tabs).toHaveLength(0);
    expect(anyUnsaved()).toBe(false);
    view.destroy();
  });

  it("saves and closes on the other answer", async () => {
    await openFile("docs/a.md");
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    closeTab(keyOf("/one", "docs/a.md"));
    await saveAndClose();
    expect(disk.get("docs/a.md")?.startsWith("x# A")).toBe(true);
    expect(editor.tabs).toHaveLength(0);
    view.destroy();
  });

  it("puts the question about the right tab, and puts it away when another comes forward", async () => {
    await openFile("docs/a.md", { keep: true });
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    view.destroy();
    attachView(null);
    await openFile("src/b.rs", { keep: true });
    const a = keyOf("/one", "docs/a.md");
    closeTab(a);
    expect(editor.asking).toEqual({ kind: "close", key: a });
    expect(activeTab()?.path).toBe("docs/a.md");
    await activate(keyOf("/one", "src/b.rs"));
    expect(editor.asking).toBeNull();
    // Nothing the answer could do now drops a.md's edits.
    closeWithoutSaving();
    expect(editor.buffers[a].dirty).toBe(true);
    expect(editor.tabs.map((tab) => tab.path)).toEqual(["docs/a.md", "src/b.rs"]);
  });
});

describe("leaving with unsaved edits", () => {
  it("puts the question up, leaving it to the drawn question to say it is heard", async () => {
    await openFile("docs/a.md");
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    leaveRequested({ kind: "quit", generation: 3 });
    expect(controls).not.toContain("heard 3");
    expect(editor.asking).toEqual({ kind: "leave", leave: "quit", generation: 3 });
    leaveCancelled();
    expect(editor.asking).toBeNull();
    leaveRequested({ kind: "window", generation: 4 });
    leaveWithoutSaving();
    await settle();
    expect(controls).toContain("leave window");
    view.destroy();
  });

  it("saves every file before leaving, and stays when one cannot be written", async () => {
    await openFile("docs/a.md", { keep: true });
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    readOnly.add("docs/a.md");
    leaveRequested({ kind: "window", generation: 1 });
    await saveAllAndLeave();
    expect(controls).not.toContain("leave window");
    expect(editor.buffers[keyOf("/one", "docs/a.md")].failed).toContain("read-only");
    // What stopped it is said, and the file is in front.
    expect(flash.text).toBe("The window stays open: a.md could not be saved");
    expect(activeTab()?.path).toBe("docs/a.md");
    readOnly.clear();
    leaveRequested({ kind: "window", generation: 2 });
    await saveAllAndLeave();
    expect(controls).toContain("leave window");
    view.destroy();
  });
});

describe("close tab", () => {
  it("closes the tab in front, asking as its × does", async () => {
    await openFile("docs/a.md", { keep: true });
    await openFile("src/b.rs", { keep: true });
    expect(closeTabInFront()).toBe(true);
    expect(editor.tabs.map((tab) => tab.path)).toEqual(["docs/a.md"]);
  });

  it("is nothing outside editor mode, and the menu's item closes the window on macOS", async () => {
    layout.mode = "working";
    expect(closeTabInFront()).toBe(false);
    closeFront();
    await settle();
    // jsdom is no Mac: the item does nothing more there.
    expect(controls).toEqual([]);
  });
});

describe("a session or a project closed", () => {
  it("closes at once when nothing unsaved is only beside it", async () => {
    sessions.active = "a";
    await ownerShown();
    await openFile("docs/a.md", { keep: true });
    let closed = false;
    closeAsking("session 1", ["a"], () => (closed = true));
    expect(closed).toBe(true);
    expect(editor.closing).toBeNull();
  });

  it("asks when its tabs hold the only copy of unsaved edits, and lets them go on the answer", async () => {
    sessions.active = "a";
    await ownerShown();
    await openFile("docs/a.md", { keep: true });
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    view.destroy();
    attachView(null);
    sessions.active = "b";
    await ownerShown();
    let closed = false;
    closeAsking("session 1", ["a"], () => {
      closed = true;
      ownerGoneForTests("a");
    });
    expect(closed).toBe(false);
    expect(editor.closing?.keys).toEqual([keyOf("/one", "docs/a.md")]);
    closingDrop();
    expect(closed).toBe(true);
    expect(anyUnsaved()).toBe(false);
    expect(editor.buffers[keyOf("/one", "docs/a.md")]).toBeUndefined();
  });

  it("saves before it closes on the other answer", async () => {
    sessions.active = "a";
    await ownerShown();
    await openFile("docs/a.md", { keep: true });
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    let closed = false;
    closeAsking("session 1", ["a"], () => (closed = true));
    await closingSave();
    expect(closed).toBe(true);
    expect(disk.get("docs/a.md")?.startsWith("x# A")).toBe(true);
    view.destroy();
  });

  it("does not ask for a file another session still has open", async () => {
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
    let closed = false;
    closeAsking("session 1", ["a"], () => (closed = true));
    expect(closed).toBe(true);
  });

  it("moves unsaved tabs to what is shown next when it went without asking", async () => {
    sessions.active = "a";
    await ownerShown();
    await openFile("docs/a.md", { keep: true });
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    view.destroy();
    attachView(null);
    await openFile("src/b.rs", { keep: true });
    sessions.active = "b";
    ownerGoneForTests("a");
    await ownerShown();
    await settle();
    expect(editor.tabs.map((tab) => tab.path)).toEqual(["docs/a.md"]);
    expect(editor.buffers[keyOf("/one", "src/b.rs")]).toBeUndefined();
    // The tab asks again when it is closed: no dead session holds it.
    closeTab(keyOf("/one", "docs/a.md"));
    expect(editor.asking).toEqual({ kind: "close", key: keyOf("/one", "docs/a.md") });
  });
});

describe("a reload", () => {
  /** A file of many lines, with the cursor put on one of them. */
  async function longFile(cursorLine: number) {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
    disk.set("docs/a.md", `${lines.join("\n")}\n`);
    await openFile("docs/a.md");
    const view = mount();
    view.dispatch({ selection: { anchor: view.state.doc.line(cursorLine).from + 2 } });
    return { lines, view };
  }

  it("keeps the cursor on its line when the change is above it", async () => {
    const { lines, view } = await longFile(150);
    const changed = [...lines];
    changed.splice(1, 0, "import one", "import two");
    disk.set("docs/a.md", `${changed.join("\n")}\n`);
    diskChanged(["/one/docs/a.md"]);
    await settle();
    const head = view.state.selection.main.head;
    expect(view.state.doc.lineAt(head).text).toBe("line 150");
    expect(head - view.state.doc.lineAt(head).from).toBe(2);
    view.destroy();
  });

  it("keeps the cursor on its line with changes on both sides of it", async () => {
    const { lines, view } = await longFile(150);
    const changed = [...lines];
    changed[1] = "line 2, changed";
    changed[289] = "line 290, changed";
    changed.push("line 301");
    disk.set("docs/a.md", `${changed.join("\n")}\n`);
    diskChanged(["/one/docs/a.md"]);
    await settle();
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe("line 150");
    expect(view.state.doc.toString()).toBe(`${changed.join("\n")}\n`);
    view.destroy();
  });

  it("leaves a preview tab a preview, and the tool's note in place", async () => {
    await openFile("docs/a.md", { note: "Here." });
    const view = mount();
    disk.set("docs/a.md", "# A\n\nfirst\nsecond\nthird\n");
    diskChanged(["/one/docs/a.md"]);
    await settle();
    expect(activeTab()).toMatchObject({ preview: true, note: "Here." });
    view.destroy();
  });

  it("is a step of its own in the history, not joined to the user's typing", async () => {
    await openFile("docs/a.md", { keep: true });
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });
    await save();
    disk.set("docs/a.md", "x# A\n\nfirst\nsecond\nthird\n");
    diskChanged(["/one/docs/a.md"]);
    await settle();
    undo(view);
    expect(view.state.doc.toString()).toBe("x# A\n\nfirst\nsecond\n");
    view.destroy();
  });

  it("only looks at the files the core names", async () => {
    await openFile("docs/a.md");
    const view = mount();
    disk.set("docs/a.md", "changed\n");
    diskChanged(["/one/src/b.rs"]);
    await settle();
    expect(view.state.doc.toString()).toBe("# A\n\nfirst\nsecond\n");
    view.destroy();
  });

  it("drops the answer to an older read that comes back after a newer one", async () => {
    await openFile("docs/a.md");
    const view = mount();
    heldReads = [];
    disk.set("docs/a.md", "older\n");
    diskChanged(["/one/docs/a.md"]);
    disk.set("docs/a.md", "newer\n");
    diskChanged(["/one/docs/a.md"]);
    await settle();
    const [older, newer] = heldReads;
    // The newer read answers first, the older one last.
    newer();
    await settle();
    expect(view.state.doc.toString()).toBe("newer\n");
    older();
    await settle();
    expect(view.state.doc.toString()).toBe("newer\n");
    view.destroy();
  });

  it("tells a session close that stopped which file stopped it, beside the session on screen", async () => {
    sessions.active = "a";
    await ownerShown();
    await openFile("docs/a.md", { keep: true });
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    view.destroy();
    attachView(null);
    sessions.active = "b";
    await ownerShown();
    readOnly.add("docs/a.md");
    let closed = false;
    closeAsking("session 1", ["a"], () => (closed = true));
    await closingSave();
    expect(closed).toBe(false);
    expect(flash.text).toBe("session 1 stays open: a.md could not be saved");
    // Open only beside the other session, it comes forward beside this one.
    expect(activeTab()?.path).toBe("docs/a.md");
  });

  it("does not land a check that began before a save", async () => {
    await openFile("docs/a.md", { keep: true });
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    diskChanged(["/one/docs/a.md"]);
    // The save lands after the check's read began and before it answers.
    expect(await save()).toBe(true);
    await settle();
    const buffer = editor.buffers[keyOf("/one", "docs/a.md")];
    expect(buffer.changed).toBeNull();
    expect(buffer.dirty).toBe(false);
    view.destroy();
  });
});

describe("a file that cannot be read under unsaved edits", () => {
  it("is gone only when the core says nothing is there, and closes without saving on its button", async () => {
    await openFile("docs/a.md");
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    disk.delete("docs/a.md");
    diskChanged(["/one/docs/a.md"]);
    await settle();
    const key = keyOf("/one", "docs/a.md");
    expect(editor.buffers[key].changed).toEqual({ stamp: null, problem: null });
    closeDropping();
    expect(editor.tabs).toEqual([]);
    view.destroy();
  });

  it("says it could not be read, and why, when something else is wrong", async () => {
    await openFile("docs/a.md");
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    binary.add("docs/a.md");
    diskChanged(["/one/docs/a.md"]);
    await settle();
    expect(editor.buffers[keyOf("/one", "docs/a.md")].changed).toEqual({
      stamp: null,
      problem: "docs/a.md is a binary file",
    });
    // Compare has nothing to show against.
    await compare();
    expect(editor.comparing).toBe(false);
    view.destroy();
  });
});
