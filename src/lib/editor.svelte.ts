/**
 * Editor mode: the file tree and a plain text editor in the middle of the
 * window, the agent on the right.
 *
 * The mode belongs to the window and flips with the switch at the end of the
 * rightmost header. The changes pane is the files pane while editing: its
 * tree takes a column on the left and lists every file, and the editor takes
 * the rest. What the viewer held when the window flipped comes along: a file
 * opens in the editor at the place it was shown, and what the agent
 * presented, a plugin's page or the browser stays in the editor's place.
 *
 * Files open as tabs, and each session keeps its own, as it keeps its viewer:
 * switching sessions shows the tabs that session had. A file that is only
 * looked at reuses one tab, the preview, until it is edited or its tab is
 * double-clicked. What a file holds is its buffer, one per file however many
 * sessions have it open, so an edit made beside one session is there beside
 * another. The buffer keeps CodeMirror's state, which holds the text, the
 * selection and the history, and the stamp of what it was read from.
 *
 * Nothing is written until the user saves. The tab and the tree's row carry
 * a dot until then.
 */

import { tick } from "svelte";
import type { EditorState, Text } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
import { browser } from "$lib/browser.svelte";
import { onEditorUpdate, stateFor } from "$lib/codeEditor";
import { core } from "$lib/core";
import {
  canDiff,
  canRender,
  deselect,
  files,
  listed,
  pick,
  select,
  setScope,
  showRange,
  treeSettled,
  type FileEntry,
  type Scope,
  type View,
} from "$lib/files.svelte";
import { say } from "$lib/flash.svelte";
import { enterReview, focusPane, layout, setEditing } from "$lib/layout.svelte";
import { reduced } from "$lib/motion";
import { sessions } from "$lib/sessions.svelte";
import { watchRoot, workspace } from "$lib/workspace.svelte";
import { MAX_SIZE, MIN_SIZE, DEFAULT_SIZE } from "$lib/zoom.svelte";

/** How a tab shows its file: to edit, its diff against HEAD, or rendered.
    The last two are read only. */
export type TabView = "edit" | "diff" | "preview";

export interface Tab {
  /** The working tree the file is in: the project's own, or the worktree
      the session moved into. */
  root: string;
  /** The file, relative to `root`, with forward slashes. */
  path: string;
  /** Only looked at: drawn in italics, and reused for the next file looked
      at until the file is edited or the tab double-clicked. */
  preview: boolean;
  view: TabView;
  /** What a tool said about the place it opened the file at, until the
      file is edited or the tab is shown another way. */
  note: string | null;
}

export interface Buffer {
  root: string;
  path: string;
  loading: boolean;
  /** Why the file cannot be edited as text, when it cannot: the viewer
      shows it instead. */
  error: string | null;
  /** The stamp of what the buffer was read from or last wrote. */
  stamp: string | null;
  /** Edited since it was read or written. */
  dirty: boolean;
}

export const editor = $state({
  /** The tabs of the session on screen. */
  tabs: [] as Tab[],
  /** The key of the tab in front. */
  active: null as string | null,
  /** Every open file's buffer, by key. */
  buffers: {} as Record<string, Buffer>,
  /** Where the cursor is in the file in front, one-based. */
  cursor: { line: 1, col: 1 },
  /** Where the keyboard goes when the files pane takes it while editing:
      the editor, or the tree. Follows where it last was in the pane. */
  target: "editor" as "editor" | "tree",
  /** A place for the editor to put the cursor on and bring into view, once
      the file it is in is showing. */
  reveal: null as { key: string; from: number; to: number } | null,
  /** The size of the editor's text, in pixels. */
  size: DEFAULT_SIZE as number,
});

/** A file's key: the working tree and the path in it. */
export function keyOf(root: string, path: string): string {
  return `${root}\u0000${path}`;
}

export function tabKey(tab: Tab): string {
  return keyOf(tab.root, tab.path);
}

/** Each buffer's CodeMirror state, kept outside the rune so it is not
    proxied: the state is immutable and replaced on every change. */
const states = new Map<string, EditorState>();
/** The text each buffer was read with or last wrote, to tell an edit that
    was undone back to it from one that was not. */
const saved = new Map<string, Text>();
/** Where each buffer was scrolled to when another took the editor. */
const scrolls = new Map<string, { top: number; left: number }>();

/** The tabs of the sessions not on screen, by owner. */
const owners = new Map<string, { tabs: Tab[]; active: string | null }>();
/** Whose tabs are on screen: the session, or the project with none. */
let owner: string | null = null;

/** The editor on screen, and the buffer it shows. */
let view: EditorView | null = null;
let shown: string | null = null;

/** The tab in front, if any. */
export function activeTab(): Tab | null {
  return editor.tabs.find((tab) => tabKey(tab) === editor.active) ?? null;
}

export function activeBuffer(): Buffer | null {
  return editor.active === null ? null : (editor.buffers[editor.active] ?? null);
}

/** Whether any open file has edits not yet written. */
export function anyUnsaved(): boolean {
  return Object.values(editor.buffers).some((buffer) => buffer.dirty);
}

/** Whether the file at `path` in the tree on screen has unsaved edits. */
export function unsavedAt(path: string): boolean {
  const root = watchRoot();
  return root !== null && editor.buffers[keyOf(root, path)]?.dirty === true;
}

/** Find in the file in front: the app's find chord while the editor has
    the keyboard. */
export function findInFile() {
  if (view === null) return;
  const showing = view;
  openSearchPanel(showing);
  // The panel is drawn after the call that opens it; asked again once it
  // is there, CodeMirror puts the keyboard in its field.
  requestAnimationFrame(() => openSearchPanel(showing));
}

/** A buffer's state, for the editor to show. */
export function stateOf(key: string): EditorState | null {
  return states.get(key) ?? null;
}

/** The editor view is there, or gone. */
export function attachView(next: EditorView | null) {
  view = next;
  if (next === null) shown = null;
}

/** The editor now shows this buffer, or none. Where the one it showed
    before was scrolled to is kept for when it comes back. */
export function editorShows(key: string | null, scroll?: { top: number; left: number }) {
  if (shown !== null && scroll !== undefined) scrolls.set(shown, scroll);
  shown = key;
  if (key !== null) cursorFrom(states.get(key) ?? null);
}

/** Where a buffer was scrolled to, when it was shown before. */
export function scrollOf(key: string) {
  return scrolls.get(key) ?? null;
}

onEditorUpdate((update: ViewUpdate) => {
  const key = shown;
  if (key === null) return;
  states.set(key, update.state);
  if (update.docChanged) {
    edited(key, update.state);
  }
  if (update.docChanged || update.selectionSet) {
    cursorFrom(update.state);
    pickFrom(update.state);
  }
});

/** A buffer was edited: it is unsaved unless the edit took it back to what
    it was read with, and every tab showing it is kept rather than reused. */
function edited(key: string, state: EditorState) {
  const buffer = editor.buffers[key];
  if (buffer === undefined) return;
  const base = saved.get(key);
  buffer.dirty = base === undefined || !state.doc.eq(base);
  for (const tab of editor.tabs) {
    if (tabKey(tab) !== key) continue;
    tab.preview = false;
    tab.note = null;
  }
}

function cursorFrom(state: EditorState | null) {
  if (state === null) {
    editor.cursor = { line: 1, col: 1 };
    return;
  }
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  editor.cursor = { line: line.number, col: head - line.from + 1 };
}

/** Lines selected in the editor are what the user points at, as lines
    selected in the viewer are: on record for the agent's selection tool. */
function pickFrom(state: EditorState) {
  const range = state.selection.main;
  if (range.empty) {
    pick(null);
    return;
  }
  const from = state.doc.lineAt(range.from).number;
  // A selection that ends at the start of a line does not take that line.
  const end = state.doc.lineAt(range.to);
  const to = range.to === end.from && end.number > from ? end.number - 1 : end.number;
  pick({ from, to });
}

/** Reads a file into a buffer, once: a buffer open in another tab or
    beside another session is the same buffer. */
async function load(root: string, path: string) {
  const key = keyOf(root, path);
  if (editor.buffers[key] !== undefined) return;
  editor.buffers[key] = { root, path, loading: true, error: null, stamp: null, dirty: false };
  try {
    const read = await core().fileRead(root, path);
    const buffer = editor.buffers[key];
    if (buffer === undefined) return;
    const state = stateFor(read.text);
    states.set(key, state);
    saved.set(key, state.doc);
    buffer.stamp = read.stamp;
    buffer.loading = false;
  } catch (error) {
    const buffer = editor.buffers[key];
    if (buffer === undefined) return;
    buffer.error = reason(error);
    buffer.loading = false;
  }
}

/** An error from the core as the sentence it is. */
function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error:\s*/, "");
}

/** Whether any session still has a tab on the buffer. */
function stillOpen(key: string): boolean {
  if (editor.tabs.some((tab) => tabKey(tab) === key)) return true;
  for (const kept of owners.values()) {
    if (kept.tabs.some((tab) => tabKey(tab) === key)) return true;
  }
  return false;
}

/** Lets a buffer go once no tab shows it. */
function release(key: string) {
  if (stillOpen(key)) return;
  delete editor.buffers[key];
  states.delete(key);
  saved.delete(key);
  scrolls.delete(key);
}

export interface OpenOptions {
  /** The line to put the cursor on, and the last of a range to select. */
  line?: number;
  to?: number;
  /** Kept rather than the preview. */
  keep?: boolean;
  view?: TabView;
  /** What a tool said about the place. */
  note?: string | null;
  /** Give the editor the keyboard. */
  focus?: boolean;
}

/**
 * Opens a file of the tree on screen as a tab and brings it to the front:
 * the tab it already has, else the preview tab reused, else a new tab after
 * the one in front. Kept, it opens as a tab of its own.
 */
export async function openFile(path: string, options: OpenOptions = {}) {
  const root = watchRoot();
  if (root === null) return;
  const key = keyOf(root, path);
  const existing = editor.tabs.find((tab) => tabKey(tab) === key);
  if (existing !== undefined) {
    if (options.keep) existing.preview = false;
    if (options.view !== undefined) existing.view = options.view;
    if (options.note !== undefined) existing.note = options.note;
  } else {
    const tab: Tab = {
      root,
      path,
      preview: !options.keep,
      view: options.view ?? "edit",
      note: options.note ?? null,
    };
    const preview = editor.tabs.findIndex((candidate) => candidate.preview);
    if (tab.preview && preview !== -1) {
      const old = tabKey(editor.tabs[preview]);
      editor.tabs[preview] = tab;
      release(old);
    } else {
      const at = editor.tabs.findIndex((candidate) => tabKey(candidate) === editor.active);
      editor.tabs.splice(at === -1 ? editor.tabs.length : at + 1, 0, tab);
    }
  }
  editor.active = key;
  if (options.line !== undefined) {
    editor.reveal = { key, from: options.line, to: options.to ?? options.line };
  }
  if (options.focus) focusFiles("editor");
  await Promise.all([load(root, path), showInViewer()]);
}

/** Brings a tab to the front and gives the editor the keyboard. */
export async function activate(key: string, focus = true) {
  if (!editor.tabs.some((tab) => tabKey(tab) === key)) return;
  editor.active = key;
  if (focus) focusFiles("editor");
  await showInViewer();
}

/** A double-click on a tab, or on its row in the tree: the tab is kept. */
export function keep(key: string) {
  const tab = editor.tabs.find((candidate) => tabKey(candidate) === key);
  if (tab !== undefined) tab.preview = false;
}

/** Closes a tab, bringing the one beside it to the front. */
export function closeTab(key: string) {
  const at = editor.tabs.findIndex((tab) => tabKey(tab) === key);
  if (at === -1) return;
  editor.tabs.splice(at, 1);
  if (editor.active === key) {
    const next = editor.tabs[at] ?? editor.tabs[at - 1] ?? null;
    editor.active = next === null ? null : tabKey(next);
  }
  release(key);
  void showInViewer();
}

/** The views a tab has, in the order the view chord walks them: editing,
    the diff when git changed the file, and rendered for Markdown. */
export function viewsOf(tab: Tab | null): TabView[] {
  if (tab === null) return [];
  const entry = entryOf(tab);
  const own: TabView[] = ["edit"];
  if (canDiff(entry)) own.push("diff");
  if (canRender(entry ?? { path: tab.path, status: null })) own.push("preview");
  return own;
}

function entryOf(tab: Tab): FileEntry | null {
  if (tab.root !== watchRoot()) return null;
  return listed().find((file) => file.path === tab.path) ?? null;
}

/** Shows the tab in front another way. */
export function setTabView(next: TabView) {
  const tab = activeTab();
  if (tab === null || !viewsOf(tab).includes(next)) return;
  tab.view = next;
  void showInViewer();
}

/** The view chord in editor mode: the next view the tab in front has. */
export function walkView() {
  const tab = activeTab();
  if (tab === null) return;
  const own = viewsOf(tab);
  const at = own.indexOf(tab.view);
  setTabView(own[(at + 1) % own.length]);
}

const VIEWER: Record<TabView, View> = { edit: "content", diff: "diff", preview: "rendered" };

/**
 * Keeps the viewer's record on the tab in front while editing: the tree
 * marks the file, the diff and the rendering come from the viewer, and what
 * the agent's tools read of the screen names the file. With no tab, the
 * viewer holds nothing.
 */
async function showInViewer() {
  if (layout.mode !== "editing") return;
  const tab = activeTab();
  if (tab === null) {
    deselect();
    return;
  }
  files.view = VIEWER[tab.view];
  if (files.selected !== tab.path || otherKindShown()) await select(tab.path);
}

/** What took the editor's place is put away, and the tab in front comes
    back: the close button over it, or Escape. */
export function putAwayOther() {
  deselect();
  void showInViewer();
}

/** Where the keyboard goes in the files pane, and asks for it there. With
    nothing open there is nothing to type into, and the tree takes it. */
export function focusFiles(target: "editor" | "tree") {
  editor.target = target === "editor" && activeTab() === null ? "tree" : target;
  focusPane("changes");
}

/** Whether the viewer holds something other than a file: what the agent
    presented, a plugin's page or the browser. In editor mode these take
    the editor's place. */
export function otherKindShown(): boolean {
  return files.media !== null || files.pluginView !== null || browser.showing;
}

/** The tree's scope in agent mode, given back on leaving editor mode. */
let agentScope: Scope | null = null;
/** The tree's scope in editor mode: every file until the user narrows it. */
let editingScope: Scope = "all";

/** The panes travel to their new places rather than jump, where the
    webview can draw the way between two layouts and the system does not
    ask for less movement. The layout changes in one step either way, so
    the agent is told one new size. */
function travel(change: () => void) {
  const start = (
    document as Document & { startViewTransition?: (update: () => void) => unknown }
  ).startViewTransition;
  if (typeof start !== "function" || reduced()) {
    change();
    return;
  }
  start.call(document, change);
}

/** Into editor mode. A file the viewer showed opens in the editor at the
    place it was shown; `then` runs once the window has flipped. */
export function enterEditor(then?: () => void) {
  if (layout.mode === "editing") {
    then?.();
    return;
  }
  travel(() => {
    const carried =
      layout.mode === "reviewing" && files.selected !== null && !otherKindShown()
        ? {
            path: files.selected,
            line: files.target?.path === files.selected ? files.target.line : undefined,
            view: files.view === "diff" ? ("diff" as const) : ("edit" as const),
          }
        : null;
    agentScope = files.scope;
    setEditing(true);
    if (files.scope !== editingScope) void setScope(editingScope);
    if (carried !== null) {
      void openFile(carried.path, {
        line: carried.line !== undefined && carried.line > 0 ? carried.line : undefined,
        view: carried.view,
      });
    } else if (!otherKindShown()) {
      void showInViewer();
    }
    editor.target = activeTab() === null ? "tree" : "editor";
    then?.();
  });
}

/** Back to agent mode: the viewer opens again on what took the editor's
    place, or on the file in front at its line when `review` asks, else the
    agent has the middle with the changes beside it. */
export function leaveEditor(review = false) {
  if (layout.mode !== "editing") return;
  travel(() => {
    editingScope = files.scope;
    const tab = activeTab();
    const other = otherKindShown();
    const line = editor.cursor.line;
    if (!other) deselect();
    setEditing(false);
    if (agentScope !== null && files.scope !== agentScope) void setScope(agentScope);
    agentScope = null;
    if (other) enterReview();
    else if (review && tab !== null) void showRange(tab.path, line, line, null);
  });
}

/** The switch, or its chord. */
export function flipMode() {
  if (layout.mode === "editing") leaveEditor();
  else enterEditor();
}

/** The viewer's Edit button: the file in the editor at the line shown. */
export function editAt(path: string, line: number | undefined) {
  enterEditor(() => {
    void openFile(path, { line, keep: true, focus: true });
  });
}

/** The tabs of whoever is on screen now: the session, or the project when
    no session is. Each keeps its own; switching puts the last one's away
    and brings this one's back, and while editing the tree marks its file. */
export async function ownerShown() {
  const next =
    sessions.active ?? (workspace.active === null ? null : `project:${workspace.active}`);
  if (next === owner) return;
  if (owner !== null) owners.set(owner, { tabs: editor.tabs, active: editor.active });
  const back = next === null ? undefined : owners.get(next);
  if (next !== null) owners.delete(next);
  owner = next;
  editor.tabs = back?.tabs ?? [];
  editor.active = back?.active ?? null;
  editor.reveal = null;
  if (layout.mode !== "editing") return;
  // The switch may have moved the project or the worktree, and the tree
  // clears itself on that: the file is marked once it is read again.
  await tick();
  await treeSettled();
  if (owner === next) await showInViewer();
}

/** Keeps `ownerShown` called as the session or project on screen changes.
    Runs in an effect root: call once, from the page. */
export function followOwner() {
  $effect(() => {
    sessions.active;
    workspace.active;
    void ownerShown();
  });
}

const SIZE_KEY = "workbench.editorSize";

/** The editor's text size as the window last had it. */
export function loadEditorSize() {
  try {
    const size = Number(localStorage.getItem(SIZE_KEY));
    if (Number.isInteger(size) && size >= MIN_SIZE && size <= MAX_SIZE) editor.size = size;
  } catch {
    // The default stands.
  }
}

/** The zoom chords while the editor has the keyboard: a pixel larger or
    smaller, or back to the default. Kept in the window's storage. */
export function zoomEditor(step: 1 | -1 | 0) {
  editor.size =
    step === 0 ? DEFAULT_SIZE : Math.min(MAX_SIZE, Math.max(MIN_SIZE, editor.size + step));
  try {
    localStorage.setItem(SIZE_KEY, String(editor.size));
  } catch {
    // Non-fatal: the size lasts until the window closes.
  }
  say(`${editor.size} px`);
}

/** Test seam. */
export function resetEditor() {
  agentScope = null;
  editingScope = "all";
  owners.clear();
  owner = null;
  states.clear();
  saved.clear();
  scrolls.clear();
  view = null;
  shown = null;
  editor.tabs = [];
  editor.active = null;
  editor.buffers = {};
  editor.cursor = { line: 1, col: 1 };
  editor.target = "editor";
  editor.reveal = null;
  editor.size = DEFAULT_SIZE;
}
