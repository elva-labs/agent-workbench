import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import {
  activate,
  activeTab,
  anyUnsaved,
  attachView,
  cancelAsk,
  cancelSaveAs,
  closeTab,
  closeWithoutSaving,
  closingSave,
  closeAsking,
  editor,
  editorShows,
  isUntitled,
  keepName,
  keyOf,
  leaveRequested,
  openFile,
  openUntitled,
  ownerShown,
  recheckOpen,
  resetEditor,
  save,
  saveAllAndLeave,
  saveAndClose,
  setSaveAsName,
  stateOf,
  tabKey,
  unsavedNames,
  viewsOf,
  watchedFiles,
} from "$lib/editor.svelte";
import { commitSaveAs, confirmReplace, newUntitled, resetFileOps, fileOps, savePathFor } from "$lib/fileOps.svelte";
import { resolveAction } from "$lib/keymap";
import { ACTIONS, PRESETS, chordFor, describe as describeChord } from "$lib/keys.svelte";
import { clear, files, refresh, setScope } from "$lib/files.svelte";
import { flash } from "$lib/flash.svelte";
import { layout } from "$lib/layout.svelte";
import { sessions } from "$lib/sessions.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

/** What the fake disk holds, by path. */
const disk = new Map<string, string>();
/** Every write and read the fake core was asked for. */
const writes: { file: string; text: string; stamp: string | null; overwrite: boolean }[] = [];
/** The tree each write went to, in order. */
const writeRoots: string[] = [];
const reads: string[] = [];
/** The window controls the fake core was asked for. */
const controls: string[] = [];
/** What the fake core says when it cannot write a file, by file. */
const writeErrors = new Map<string, string>();
const stampOf = (text: string) => `s:${text}`;

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
      return { lines: ["one"], binary: false, truncated: false };
    },
    async fileRead(_root: string, file: string) {
      reads.push(file);
      const text = disk.get(file);
      if (text === undefined) throw new Error(`${file} does not exist`);
      return { text, stamp: stampOf(text) };
    },
    async fileWrite(root: string, file: string, text: string, stamp: string | null, overwrite: boolean) {
      writes.push({ file, text, stamp, overwrite });
      writeRoots.push(root);
      const refusal = writeErrors.get(file);
      if (refusal !== undefined) throw new Error(refusal);
      const current = disk.get(file);
      if (!overwrite) {
        if (stamp === null && current !== undefined) return { written: false, stamp: stampOf(current) };
        if (stamp !== null && current !== undefined && stampOf(current) !== stamp)
          return { written: false, stamp: stampOf(current) };
      }
      disk.set(file, text);
      return { written: true, stamp: stampOf(text) };
    },
    async windowControl(action: string) {
      controls.push(action);
    },
    async leaveHeard() {},
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

let view: EditorView | null = null;

/** A CodeMirror view attached to the store as the editor component
    attaches one, showing the buffer in front. */
function mount(): EditorView {
  view?.destroy();
  const key = editor.active!;
  view = new EditorView({ parent: document.body, state: stateOf(key)! });
  attachView(view);
  editorShows(key);
  return view;
}

/** Types at the end of the buffer in front. */
function type(text: string) {
  const shown = mount();
  shown.dispatch({ changes: { from: shown.state.doc.length, insert: text } });
}

async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  view?.destroy();
  view = null;
  resetEditor();
  resetFileOps();
  resetWorkspace();
  clear();
  disk.clear();
  writes.length = 0;
  writeRoots.length = 0;
  reads.length = 0;
  controls.length = 0;
  writeErrors.clear();
  disk.set("docs/a.md", "# A\n");
  disk.set("src/b.rs", "fn b() {}\n");
  layout.mode = "editing";
  layout.focus = "changes";
  sessions.active = null;
  workspace.open.push(repo("/one"));
  workspace.active = "/one";
  await refresh();
  await setScope("all");
  document.body.innerHTML = "";
});

describe("an untitled file", () => {
  it("opens empty in a tab of its own after the one in front, with nothing written", async () => {
    await openFile("docs/a.md", { keep: true });
    await openFile("src/b.rs", { keep: true });
    await activate(keyOf("/one", "docs/a.md"));
    openUntitled(null);
    expect(editor.tabs.map((tab) => tab.path)).toEqual(["docs/a.md", "Untitled", "src/b.rs"]);
    const tab = activeTab()!;
    expect(tab.preview).toBe(false);
    expect(isUntitled(tabKey(tab))).toBe(true);
    expect(stateOf(tabKey(tab))?.doc.toString()).toBe("");
    expect(editor.buffers[tabKey(tab)].dirty).toBe(false);
    expect(editor.target).toBe("editor");
    expect(writes).toEqual([]);
  });

  it("is named Untitled, then Untitled 2 and on, taking the lowest name free", () => {
    openUntitled(null);
    openUntitled(null);
    openUntitled(null);
    expect(editor.tabs.map((tab) => tab.path)).toEqual(["Untitled", "Untitled 2", "Untitled 3"]);
    closeTab(keyOf("", "Untitled 2"));
    openUntitled(null);
    expect(activeTab()?.path).toBe("Untitled 2");
  });

  it("is in no tree: the viewer names no file, and it is never read or watched", async () => {
    await openFile("docs/a.md");
    expect(files.selected).toBe("docs/a.md");
    openUntitled(null);
    await settle();
    expect(files.selected).toBeNull();
    expect(watchedFiles()).toEqual(["/one/docs/a.md"]);
    reads.length = 0;
    recheckOpen();
    await settle();
    expect(reads).toEqual(["docs/a.md"]);
    // Only editing: it has no diff and nothing to render.
    expect(viewsOf(activeTab())).toEqual(["edit"]);
  });

  it("is unsaved once typed in, and saved again when emptied back", () => {
    openUntitled(null);
    type("hello");
    const key = editor.active!;
    expect(editor.buffers[key].dirty).toBe(true);
    expect(anyUnsaved()).toBe(true);
    expect(unsavedNames()).toEqual(["Untitled"]);
    undo(view!);
    expect(editor.buffers[key].dirty).toBe(false);
  });

  it("flips to the editor from agent mode", () => {
    layout.mode = "working";
    newUntitled();
    expect(layout.mode).toBe("editing");
    expect(activeTab()?.path).toBe("Untitled");
  });

  it("is not made without a project", () => {
    workspace.active = null;
    openUntitled(null);
    expect(editor.tabs).toEqual([]);
  });

  it("is not made without a tree to write it to", () => {
    workspace.open.push({ ...repo("/plain"), isGit: false });
    workspace.active = "/plain";
    openUntitled(null);
    expect(editor.tabs).toEqual([]);
  });

  it("starts in the folder of the file in front, for saving", async () => {
    await openFile("src/b.rs");
    newUntitled();
    void save();
    expect(editor.savingAs?.value).toBe("src/Untitled");
  });
});

describe("closing an untitled file", () => {
  it("closes at once with nothing typed", () => {
    openUntitled(null);
    closeTab(editor.active!);
    expect(editor.tabs).toEqual([]);
    expect(editor.asking).toBeNull();
    expect(Object.keys(editor.buffers)).toEqual([]);
  });

  it("asks with text, and Close without saving drops it, writing nothing", () => {
    openUntitled(null);
    type("draft");
    const key = editor.active!;
    closeTab(key);
    expect(editor.asking).toEqual({ kind: "close", key });
    cancelAsk();
    expect(editor.tabs).toHaveLength(1);
    closeTab(key);
    closeWithoutSaving();
    expect(editor.tabs).toEqual([]);
    expect(editor.buffers[key]).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it("asks for the path on Save and close, and closes once written", async () => {
    openUntitled(null);
    type("draft");
    closeTab(editor.active!);
    await saveAndClose();
    expect(editor.asking).toBeNull();
    expect(editor.savingAs?.value).toBe("Untitled");
    setSaveAsName("notes.md");
    await commitSaveAs();
    expect(disk.get("notes.md")).toBe("draft");
    expect(editor.tabs).toEqual([]);
    expect(editor.savingAs).toBeNull();
  });

  it("keeps the tab when the field is put away after Save and close", async () => {
    openUntitled(null);
    type("draft");
    closeTab(editor.active!);
    await saveAndClose();
    cancelSaveAs();
    expect(editor.savingAs).toBeNull();
    expect(activeTab()?.path).toBe("Untitled");
    expect(writes).toEqual([]);
  });
});

describe("saving an untitled file", () => {
  it("asks for a path first, in the folder it was started in, and writes nothing yet", async () => {
    openUntitled("docs");
    type("text");
    expect(await save()).toBe(false);
    expect(editor.savingAs).toMatchObject({ key: editor.active, value: "docs/Untitled", problem: null });
    expect(writes).toEqual([]);
  });

  it("becomes the file once written: an ordinary tab, its text and history kept, the tree marking it", async () => {
    openUntitled(null);
    type("one two");
    void save();
    setSaveAsName("docs/notes.md");
    await commitSaveAs();
    expect(writes).toEqual([{ file: "docs/notes.md", text: "one two", stamp: null, overwrite: false }]);
    const key = keyOf("/one", "docs/notes.md");
    expect(editor.active).toBe(key);
    expect(editor.tabs.map((tab) => [tab.path, tab.preview])).toEqual([["docs/notes.md", false]]);
    const buffer = editor.buffers[key];
    expect(buffer).toMatchObject({ root: "/one", path: "docs/notes.md", dirty: false, stamp: stampOf("one two") });
    expect(editor.buffers[keyOf("", "Untitled")]).toBeUndefined();
    expect(editor.savingAs).toBeNull();
    expect(files.selected).toBe("docs/notes.md");
    expect(watchedFiles()).toEqual(["/one/docs/notes.md"]);
    // The history came along: undo takes back what was typed, and the file
    // is unsaved again.
    mount();
    undo(view!);
    expect(view!.state.doc.toString()).toBe("");
    expect(editor.buffers[key].dirty).toBe(true);
    await save();
    expect(writes.at(-1)).toEqual({ file: "docs/notes.md", text: "", stamp: stampOf("one two"), overwrite: false });
  });

  it("refuses a path that will not do, and says why", async () => {
    openUntitled(null);
    void save();
    for (const [value, problem] of [
      ["", "A name is needed."],
      ["../notes.md", "The file is saved inside the project: give a path from its top."],
      ["/tmp/notes.md", "The file is saved inside the project: give a path from its top."],
      ["~/notes.md", "The file is saved inside the project: give a path from its top."],
      ["C:\\notes.md", "The file is saved inside the project: give a path from its top."],
      [".git/notes", "Nothing is made inside .git."],
      ["src/", "A name is needed."],
      ["notes\\", "A name is needed."],
    ]) {
      setSaveAsName(value);
      await commitSaveAs();
      expect(editor.savingAs?.problem).toBe(problem);
    }
    expect(writes).toEqual([]);
    setSaveAsName("ok.md");
    expect(editor.savingAs?.problem).toBeNull();
  });

  it("asks before replacing a file, and Cancel goes back to the field", async () => {
    openUntitled(null);
    type("mine");
    void save();
    setSaveAsName("src/b.rs");
    await commitSaveAs();
    expect(editor.savingAs?.replace).toBe("src/b.rs");
    expect(disk.get("src/b.rs")).toBe("fn b() {}\n");
    keepName();
    expect(editor.savingAs).toMatchObject({ replace: null, value: "src/b.rs" });
    await commitSaveAs();
    await confirmReplace();
    expect(writes.at(-1)).toEqual({ file: "src/b.rs", text: "mine", stamp: null, overwrite: true });
    expect(activeTab()?.path).toBe("src/b.rs");
    expect(editor.buffers[keyOf("/one", "src/b.rs")].dirty).toBe(false);
  });

  it("replaces a file open beside it with nothing unsaved, which takes in what was written", async () => {
    await openFile("src/b.rs", { keep: true });
    openUntitled(null);
    type("mine");
    void save();
    setSaveAsName("src/b.rs");
    await commitSaveAs();
    await confirmReplace();
    expect(editor.tabs.map((tab) => tab.path)).toEqual(["src/b.rs"]);
    expect(stateOf(keyOf("/one", "src/b.rs"))?.doc.toString()).toBe("mine");
    expect(editor.buffers[keyOf("/one", "src/b.rs")].dirty).toBe(false);
  });

  it("will not write over a file open with unsaved edits", async () => {
    await openFile("src/b.rs", { keep: true });
    type("x");
    openUntitled(null);
    type("mine");
    void save();
    setSaveAsName("src/b.rs");
    await commitSaveAs();
    expect(editor.savingAs?.problem).toBe("src/b.rs is open with unsaved edits. Save or close it first.");
    expect(writes).toEqual([]);
  });

  it("says why a write failed under the field, and stays untitled", async () => {
    writeErrors.set("locked.md", "locked.md is read-only");
    openUntitled(null);
    type("mine");
    void save();
    setSaveAsName("locked.md");
    await commitSaveAs();
    expect(editor.savingAs?.problem).toBe("locked.md is read-only");
    expect(editor.savingAs?.busy).toBe(false);
    expect(activeTab()?.path).toBe("Untitled");
  });

  it("puts the field away when another tab comes to the front", async () => {
    await openFile("docs/a.md", { keep: true });
    openUntitled(null);
    void save();
    expect(editor.savingAs).not.toBeNull();
    await activate(keyOf("/one", "docs/a.md"));
    expect(editor.savingAs).toBeNull();
  });

  it("keeps the path as typed when Save is asked again while the field is up", async () => {
    openUntitled(null);
    void save();
    setSaveAsName("draft.md");
    void save();
    expect(editor.savingAs?.value).toBe("draft.md");
  });
});

describe("leaving with untitled text", () => {
  it("saves the named files, then asks each untitled file's path in turn, and leaves once all are written", async () => {
    await openFile("docs/a.md", { keep: true });
    type("edit ");
    openUntitled(null);
    type("first");
    openUntitled(null);
    type("second");
    openUntitled(null);
    leaveRequested({ kind: "quit", generation: 1 });
    await saveAllAndLeave();
    expect(disk.get("docs/a.md")).toBe("# A\nedit ");
    expect(editor.savingAs?.key).toBe(keyOf("", "Untitled"));
    expect(activeTab()?.path).toBe("Untitled");
    setSaveAsName("first.md");
    await commitSaveAs();
    expect(controls).toEqual([]);
    expect(editor.savingAs?.key).toBe(keyOf("", "Untitled 2"));
    setSaveAsName("second.md");
    await commitSaveAs();
    // The empty one has nothing to save.
    expect(controls).toEqual(["leave quit"]);
    expect(disk.get("first.md")).toBe("first");
    expect(disk.get("second.md")).toBe("second");
  });

  it("stays, and says so, when an untitled file's field is put away", async () => {
    openUntitled(null);
    type("draft");
    leaveRequested({ kind: "window", generation: 1 });
    await saveAllAndLeave();
    cancelSaveAs();
    expect(controls).toEqual([]);
    expect(flash.text).toBe("The window stays open: Untitled was not saved");
  });

  it("asks the path before a project holding untitled text is closed", async () => {
    await ownerShown();
    openUntitled(null);
    type("draft");
    let closed = false;
    closeAsking("one", ["project:/one"], () => (closed = true));
    expect(editor.closing?.keys).toEqual([keyOf("", "Untitled")]);
    await closingSave();
    expect(closed).toBe(false);
    setSaveAsName("kept.md");
    await commitSaveAs();
    expect(closed).toBe(true);
  });
});

describe("an untitled file of another project", () => {
  /** Untitled text started beside project one, with project two on
      screen after. */
  async function startedInOne() {
    await ownerShown();
    openUntitled("docs");
    type("draft");
    workspace.open.push(repo("/two"));
    workspace.active = "/two";
    await ownerShown();
    expect(editor.tabs).toEqual([]);
  }

  it("is written to the tree it was started in on quit, and its tab goes back", async () => {
    await startedInOne();
    leaveRequested({ kind: "quit", generation: 1 });
    await saveAllAndLeave();
    expect(activeTab()?.path).toBe("Untitled");
    expect(editor.savingAs).toMatchObject({ root: "/one", project: "/one", value: "docs/Untitled" });
    setSaveAsName("docs/note.md");
    await commitSaveAs();
    expect(writeRoots).toEqual(["/one"]);
    expect(disk.get("docs/note.md")).toBe("draft");
    expect(controls).toEqual(["leave quit"]);
    // The tab shown beside two goes once written; one keeps its own.
    expect(editor.tabs).toEqual([]);
    workspace.active = "/one";
    await ownerShown();
    expect(editor.tabs.map((tab) => [tab.path, tab.preview])).toEqual([["docs/note.md", false]]);
  });

  it("is written to its own project when that project is closed from another", async () => {
    await startedInOne();
    let closed = false;
    closeAsking("one", ["project:/one"], () => (closed = true));
    expect(editor.closing?.keys).toEqual([keyOf("", "Untitled")]);
    await closingSave();
    expect(editor.savingAs).toMatchObject({ root: "/one", project: "/one" });
    setSaveAsName("kept.md");
    await commitSaveAs();
    expect(writeRoots).toEqual(["/one"]);
    expect(closed).toBe(true);
    expect(editor.tabs).toEqual([]);
  });

  it("is written to its own project when saved where it is shown", async () => {
    await startedInOne();
    leaveRequested({ kind: "window", generation: 1 });
    await saveAllAndLeave();
    cancelSaveAs();
    // Stopped, it stays in front beside two; saved from there, it still
    // goes to one.
    expect(activeTab()?.path).toBe("Untitled");
    void save();
    expect(editor.savingAs?.root).toBe("/one");
    setSaveAsName("later.md");
    await commitSaveAs();
    expect(writeRoots).toEqual(["/one"]);
  });
});

describe("the chord", () => {
  it("is listed with the editor's actions, on Cmd+N in both presets", () => {
    expect(ACTIONS.find((action) => action.key === "file.untitled")).toEqual({
      key: "file.untitled",
      label: "New untitled file",
      group: "Editor",
    });
    expect(PRESETS.default["file.untitled"]).toEqual({ key: "n", shift: false, alt: false });
    expect(PRESETS.vim["file.untitled"]).toEqual({ key: "n", shift: false, alt: false });
    expect(describeChord(chordFor("file.untitled"), true)).toBe("⌘N");
    expect(describeChord(chordFor("file.untitled"), false)).toBe("Ctrl+N");
  });

  it("is the app's from anywhere on macOS, terminals included, in either mode", () => {
    const press = { key: "n", metaKey: true };
    for (const focus of ["agent", "terminal", "changes", "sessions"] as const) {
      for (const editing of [true, false]) {
        expect(resolveAction(press, { focus, reviewing: false, editing, mac: true })).toEqual({ type: "newUntitled" });
      }
    }
  });

  it("leaves Ctrl+N to a terminal on Windows and Linux, and takes it elsewhere", () => {
    const press = { key: "n", ctrlKey: true };
    expect(resolveAction(press, { focus: "agent", reviewing: false, editing: true, mac: false })).toBeNull();
    expect(resolveAction(press, { focus: "terminal", reviewing: false, editing: false, mac: false })).toBeNull();
    expect(resolveAction(press, { focus: "changes", reviewing: false, editing: true, inEditor: true, mac: false })).toEqual({
      type: "newUntitled",
    });
    expect(resolveAction(press, { focus: "sessions", reviewing: false, editing: false, mac: false })).toEqual({
      type: "newUntitled",
    });
    // An integrated session's composer is a text field, not a terminal.
    expect(resolveAction(press, { focus: "agent", reviewing: false, editing: true, integrated: true, mac: false })).toEqual({
      type: "newUntitled",
    });
  });
});

describe("the path field", () => {
  it("reads a path from the top of the tree, slashes either way", () => {
    expect(savePathFor(" docs/notes.md ")).toEqual({ path: "docs/notes.md" });
    expect(savePathFor("docs\\notes.md")).toEqual({ path: "docs/notes.md" });
    expect(savePathFor("a:b.md")).toEqual({ path: "a:b.md" });
    expect(fileOps.naming).toBeNull();
  });
});
