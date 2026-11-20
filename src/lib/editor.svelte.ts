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
 * a dot until then. A save sends the stamp the buffer was read with, and the
 * core writes only while the disk still holds that: a file that changed
 * underneath is never overwritten unasked. With no unsaved edits a change on
 * disk is read in at once, change by change, so the lines between keep their
 * places; with unsaved edits a bar over the editor says the file changed and
 * offers to compare, to keep the editor's version, or to load the disk's.
 *
 * Nothing that holds the only copy of unsaved edits goes without a question:
 * a tab, a session or a project closed, the window closed or the app quit.
 *
 * An untitled file is a buffer with no file behind it, in a tab named
 * Untitled, Untitled 2 and so on. No tree holds it, so nothing reads,
 * watches or lists it, and the viewer's record, which the agent's tools
 * read, names no file while it is in front. It belongs to the tree it was
 * started in, whichever is on screen later. Saving it asks for a path in
 * that tree first; once written it is that file, its tab kept and its
 * history with it.
 */

import { tick, untrack } from "svelte";
import { Transaction, type EditorState, type Text, type TransactionSpec } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { openSearchPanel, searchPanelOpen } from "@codemirror/search";
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
  treeSettled,
  type FileEntry,
  type Scope,
  type View,
} from "$lib/files.svelte";
import { say } from "$lib/flash.svelte";
import {
  editTreeVisible,
  enterReview,
  focusPane,
  layout,
  returnFocus,
  setEditing,
  toggleRightPane,
} from "$lib/layout.svelte";
import type { BusyShell } from "$lib/leaving.svelte";
import { lineEdits } from "$lib/lineDiff";
import { lastSegment } from "$lib/paths";
import { pathOn } from "$lib/remote.svelte";
import { onOwnerGone, sessions } from "$lib/sessions.svelte";
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
  /** Being written. */
  saving: boolean;
  /** The disk no longer holds what the buffer was read with while it has
      unsaved edits: the stamp of what is there now, or null with
      `problem` saying why it could not be read, or with neither when the
      file is gone. */
  changed: { stamp: string | null; problem: string | null } | null;
  /** Why the last save of this file could not be made, until the next. */
  failed: string | null;
}

/** A question put over the editor before something is lost: closing a
    tab with unsaved edits, or the window or the app with any. */
export type Ask =
  /** Closing a tab with unsaved edits; `fromRow` when a key on the tab row
      asked, so the keyboard goes back there once it is answered. */
  | { kind: "close"; key: string; fromRow?: boolean }
  /** The core's question numbered `generation`, about the window or the app. */
  | { kind: "leave"; leave: "window" | "quit"; generation: number };

/** A session or a project being closed while tabs beside it hold the only
    copy of unsaved edits, or shells that go with it are busy: the question
    in the sessions pane. */
export interface Closing {
  /** What is being closed, as the pane names it. */
  what: string;
  kind: "session" | "project";
  /** The owners that go with it: the session, or the project's sessions
      and the project's own tabs. */
  owners: string[];
  /** The buffers whose edits would go. */
  keys: string[];
  /** The shells that go with it with something running in them. */
  busy: BusyShell[];
  close: () => void;
}

/** The path asked for before an untitled file is first written, while the
    field for it is up over the editor. */
export interface SaveAs {
  /** The untitled file's buffer, or the file's once it is written. */
  key: string;
  /** The tree the file is written to: the one it was started in. */
  root: string;
  /** The project it was started in, by its path, to name in the field. */
  project: string;
  /** What the field holds: a path from the top of the tree. */
  value: string;
  /** Why the path will not do, under the field. */
  problem: string | null;
  /** Being written. */
  busy: boolean;
  /** The path a file is already at, while the question whether to replace
      it is up. */
  replace: string | null;
  /** Counts the times the field is put up, so it takes the keyboard each
      time. */
  session: number;
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
  /** The question over the editor, if one is up. */
  asking: null as Ask | null,
  /** Counts the asks for the keyboard on the tab row, on the tab in front:
      a question asked from the row was answered. */
  rowRequests: 0,
  /** The disk's version shown against the editor's, for the file in front
      when it changed on disk under unsaved edits. */
  comparing: false,
  /** The question before closing a session or a project, if one is up. */
  closing: null as Closing | null,
  /** The path asked for before an untitled file is written, if the field
      is up. */
  savingAs: null as SaveAs | null,
});

/** The root an untitled file's tab and buffer carry: no tree's, so no
    tree, watch or read reaches it. */
export const UNTITLED = "";

/** Whether a buffer's key is an untitled file's. */
export function isUntitled(key: string | null): boolean {
  return key !== null && key.startsWith(keyOf(UNTITLED, ""));
}

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
/** What the disk held when a buffer was found changed under its edits,
    for Compare. */
const onDisk = new Map<string, string>();
/** Counts the writes and the reads from disk taken into each buffer, so a
    check of the disk that began before one of them does not land after. */
const generations = new Map<string, number>();

function bump(key: string) {
  generations.set(key, (generations.get(key) ?? 0) + 1);
}

/** Counts the reads of each buffer's file from disk, so an answer to an
    older read that comes back after a newer one is dropped. */
const reads = new Map<string, number>();

/** Where each untitled file was started: the project, the tree it is
    written to whichever is on screen when it is saved, and the folder in
    that tree saving it starts in, null for the top. */
const homes = new Map<string, { project: string; root: string; folder: string | null }>();

/** What follows once the path asked for is given and the file written, or
    the field put away without it; and whether the keyboard goes back to
    the tab row rather than the editor. */
let afterNaming: {
  then?: (key: string) => void;
  cancelled?: () => void;
  fromRow?: boolean;
} | null = null;

/** Tabs whose session went while they held the only copy of unsaved
    edits, without the user being asked: they join the tabs shown next. */
let rescued: Tab[] = [];

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

/** Whether there is a file in front to save: a text file read in, shown
    in the editor's place. */
export function canSaveInFront(): boolean {
  const buffer = activeBuffer();
  return buffer !== null && !buffer.loading && buffer.error === null && !otherKindShown();
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
  // is there, CodeMirror puts the keyboard in its field. One closed in the
  // meantime, by Escape, stays closed.
  requestAnimationFrame(() => {
    if (searchPanelOpen(showing.state)) openSearchPanel(showing);
  });
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

/** What marks a transaction that takes in what the disk holds, rather
    than an edit of the user's. */
const RELOAD = "reload";

onEditorUpdate((update: ViewUpdate) => {
  const key = shown;
  if (key === null) return;
  states.set(key, update.state);
  if (update.docChanged) {
    const reload = update.transactions.some((tr) => tr.isUserEvent(RELOAD));
    edited(key, update.state, reload);
  }
  if (update.docChanged || update.selectionSet) {
    cursorFrom(update.state);
    pickFrom(update.state);
  }
});

/** A buffer was edited: it is unsaved unless the edit took it back to what
    it was read with, and every tab showing it is kept rather than reused.
    What the disk holds read in is not the user's edit: the tab stays as
    it was. */
function edited(key: string, state: EditorState, reload = false) {
  const buffer = editor.buffers[key];
  if (buffer === undefined) return;
  const base = saved.get(key);
  buffer.dirty = base === undefined || !state.doc.eq(base);
  if (reload) return;
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
  editor.buffers[key] = {
    root,
    path,
    loading: true,
    error: null,
    stamp: null,
    dirty: false,
    saving: false,
    changed: null,
    failed: null,
  };
  try {
    const read = await core().fileRead(root, path);
    const buffer = editor.buffers[key];
    // A buffer no longer loading took its text from elsewhere meanwhile: an
    // untitled file was written over the file.
    if (buffer === undefined || !buffer.loading) return;
    const state = stateFor(read.text);
    states.set(key, state);
    saved.set(key, state.doc);
    buffer.stamp = read.stamp;
    buffer.loading = false;
  } catch (error) {
    const buffer = editor.buffers[key];
    if (buffer === undefined || !buffer.loading) return;
    buffer.error = reason(error);
    buffer.loading = false;
  }
}

/** Why a save failed, naming the file once: the core's sentence starts
    with it already when it says what is wrong with it. */
function couldNotSave(path: string, why: string): string {
  return why.startsWith(`${path} `)
    ? `Could not save: ${why}`
    : `Could not save ${lastSegment(path)}: ${why}`;
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
  onDisk.delete(key);
  generations.delete(key);
  reads.delete(key);
  homes.delete(key);
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
  bringForward(key);
  if (options.line !== undefined) {
    editor.reveal = { key, from: options.line, to: options.to ?? options.line };
  }
  if (options.focus) focusFiles("editor");
  await Promise.all([load(root, path), showInViewer()]);
}

/** Brings a tab to the front and gives the editor the keyboard. */
export async function activate(key: string, focus = true) {
  if (!editor.tabs.some((tab) => tabKey(tab) === key)) return;
  bringForward(key);
  if (focus) focusFiles("editor");
  await showInViewer();
}

/** Another tab coming to the front puts away the question about closing
    the one that was there: the answer is only ever about the tab shown. */
function bringForward(key: string) {
  if (editor.asking?.kind === "close" && editor.asking.key !== key) editor.asking = null;
  if (editor.savingAs !== null && editor.savingAs.key !== key) putNamingAway();
  editor.active = key;
}

/** A double-click on a tab, or on its row in the tree: the tab is kept. */
export function keep(key: string) {
  const tab = editor.tabs.find((candidate) => tabKey(candidate) === key);
  if (tab !== undefined) tab.preview = false;
}

/** Closes a tab, bringing the one beside it to the front. A tab whose
    file has unsaved edits that no other session has open asks first. */
export function closeTab(key: string, fromRow = false) {
  const at = editor.tabs.findIndex((tab) => tabKey(tab) === key);
  if (at === -1) return;
  if (editor.buffers[key]?.dirty && !stillOpenElsewhere(key)) {
    if (editor.savingAs !== null) putNamingAway();
    editor.active = key;
    editor.asking = fromRow ? { kind: "close", key, fromRow } : { kind: "close", key };
    void showInViewer();
    return;
  }
  dropTab(key);
}

/** Closes the tab whatever its buffer holds: edits it had that no other
    session's tab still shows are dropped with it. */
function dropTab(key: string) {
  const at = editor.tabs.findIndex((tab) => tabKey(tab) === key);
  if (at === -1) return;
  if (editor.asking?.kind === "close" && editor.asking.key === key) editor.asking = null;
  if (editor.savingAs?.key === key) putNamingAway();
  if (editor.comparing && editor.active === key) editor.comparing = false;
  editor.tabs.splice(at, 1);
  if (editor.active === key) {
    const next = editor.tabs[at] ?? editor.tabs[at - 1] ?? null;
    editor.active = next === null ? null : tabKey(next);
  }
  release(key);
  void showInViewer();
}

/** The keyboard goes back to where a question was asked from: the tab
    row, or else the editor. */
function backFrom(asked: Ask | null) {
  if (asked?.kind === "close" && asked.fromRow === true) editor.rowRequests += 1;
  else focusFiles("editor");
}

/** The confirm strip's answer to closing a tab with unsaved edits. */
export function closeWithoutSaving() {
  const asked = editor.asking;
  if (asked?.kind !== "close") return;
  editor.asking = null;
  const buffer = editor.buffers[asked.key];
  if (buffer !== undefined && !stillOpenElsewhere(asked.key)) buffer.dirty = false;
  dropTab(asked.key);
  backFrom(asked);
}

export async function saveAndClose() {
  const asked = editor.asking;
  if (asked?.kind !== "close") return;
  editor.asking = null;
  // An untitled file is asked its path first, and closes once written.
  if (isUntitled(asked.key)) {
    askName(asked.key, { then: (key) => dropTab(key), fromRow: asked.fromRow === true });
    return;
  }
  if (await save(asked.key)) dropTab(asked.key);
  backFrom(asked);
}

/** Puts the question away, and the keyboard back where it was asked. */
export function cancelAsk() {
  const asked = editor.asking;
  editor.asking = null;
  backFrom(asked);
}

/** The names untitled files go by: Untitled, then Untitled 2 and on, the
    lowest no open untitled file has. */
function freeName(): string {
  const taken = new Set(
    Object.values(editor.buffers)
      .filter((buffer) => buffer.root === UNTITLED)
      .map((buffer) => buffer.path),
  );
  if (!taken.has("Untitled")) return "Untitled";
  let number = 2;
  while (taken.has(`Untitled ${number}`)) number += 1;
  return `Untitled ${number}`;
}

/**
 * A new untitled file in a tab after the one in front, brought to the
 * front with the keyboard in it. It belongs to the tree on screen, which
 * it is written to when saved; `folder` is the folder of that tree saving
 * it starts in, null for the top. From agent mode the window flips to the
 * editor first. Nothing without a tree to write it to.
 */
export function openUntitled(folder: string | null) {
  if (workspace.active === null || watchRoot() === null) return;
  enterEditor(() => {
    const project = workspace.active;
    const root = watchRoot();
    if (project === null || root === null) return;
    const name = freeName();
    const key = keyOf(UNTITLED, name);
    editor.buffers[key] = {
      root: UNTITLED,
      path: name,
      loading: false,
      error: null,
      stamp: null,
      dirty: false,
      saving: false,
      changed: null,
      failed: null,
    };
    const state = stateFor("");
    states.set(key, state);
    saved.set(key, state.doc);
    homes.set(key, { project, root, folder });
    const at = editor.tabs.findIndex((tab) => tabKey(tab) === editor.active);
    editor.tabs.splice(at === -1 ? editor.tabs.length : at + 1, 0, {
      root: UNTITLED,
      path: name,
      preview: false,
      view: "edit",
      note: null,
    });
    bringForward(key);
    focusFiles("editor");
    void showInViewer();
  });
}

/** Counts the times the field for a path is put up. */
let namings = 0;

/**
 * Puts up the field for the path to write an untitled file to, over the
 * editor with the file in front: a path in the tree it was started in,
 * from the folder it was started in, and its name. `then` follows once it
 * is written, with the file's key; `cancelled` once the field is put away
 * without it.
 */
export function askName(key: string, after: NonNullable<typeof afterNaming> = {}) {
  const buffer = editor.buffers[key];
  const home = homes.get(key);
  if (buffer === undefined || buffer.root !== UNTITLED || home === undefined) return;
  if (editor.asking?.kind === "close") editor.asking = null;
  if (editor.active !== key && editor.tabs.some((tab) => tabKey(tab) === key)) bringForward(key);
  if (editor.savingAs?.key === key) return;
  if (editor.savingAs !== null) putNamingAway();
  namings += 1;
  editor.savingAs = {
    key,
    root: home.root,
    project: home.project,
    value: home.folder === null ? buffer.path : `${home.folder}/${buffer.path}`,
    problem: null,
    busy: false,
    replace: null,
    session: namings,
  };
  afterNaming = after;
}

/** The field for a path goes without one being given: what was to follow
    is told so. */
function putNamingAway() {
  const after = afterNaming;
  editor.savingAs = null;
  afterNaming = null;
  after?.cancelled?.();
}

export function setSaveAsName(value: string) {
  if (editor.savingAs === null) return;
  editor.savingAs.value = value;
  editor.savingAs.problem = null;
}

/** Escape, or Cancel, in the field: it goes, the file stays untitled, and
    the keyboard goes back where it was asked from. */
export function cancelSaveAs() {
  const asked = editor.savingAs;
  if (asked === null || asked.busy) return;
  const fromRow = afterNaming?.fromRow === true;
  putNamingAway();
  if (fromRow) editor.rowRequests += 1;
  else focusFiles("editor");
}

/** Cancel on the question whether to replace a file: back to the field,
    the path as it was. */
export function keepName() {
  const asked = editor.savingAs;
  if (asked === null || asked.busy) return;
  asked.replace = null;
  namings += 1;
  asked.session = namings;
}

/**
 * Writes an untitled file to `path` in the tree at `root`: only where
 * nothing is, or over what is there with `overwrite`. Written, it is that
 * file from then on. Answers the file's key, or null when something is at
 * the path already; fails with why it could not be written.
 */
export async function writeUntitled(
  key: string,
  root: string,
  path: string,
  overwrite: boolean,
): Promise<string | null> {
  const buffer = editor.buffers[key];
  const state = states.get(key);
  if (buffer === undefined || state === undefined || buffer.root !== UNTITLED) return null;
  const doc = state.doc;
  buffer.saving = true;
  try {
    const result = await core().fileWrite(root, path, doc.toString(), null, overwrite);
    if (!result.written) return null;
    return becameFile(key, root, path, doc, result.stamp);
  } finally {
    const still = editor.buffers[key];
    if (still !== undefined) still.saving = false;
  }
}

/**
 * An untitled file was written to `path`: every tab on it is a kept tab on
 * the file, in its place, and its buffer is the file's, text, cursor,
 * history and all. A file that was open already, with nothing unsaved, is
 * replaced: a tab on it beside the untitled file's goes, the other tabs on
 * it show the untitled file's buffer, and the buffer it had goes.
 */
function becameFile(from: string, root: string, path: string, doc: Text, stamp: string | null): string {
  const to = keyOf(root, path);
  const buffer = editor.buffers[from];
  if (buffer === undefined) return to;
  const retab = (tabs: Tab[]) => {
    const at = tabs.findIndex((tab) => tabKey(tab) === from);
    if (at === -1) return;
    tabs[at] = { root, path, preview: false, view: "edit", note: null };
    const other = tabs.findIndex((tab, index) => index !== at && tabKey(tab) === to);
    if (other !== -1) tabs.splice(other, 1);
  };
  retab(editor.tabs);
  for (const kept of owners.values()) {
    retab(kept.tabs);
    if (kept.active === from) kept.active = to;
  }
  retab(rescued);
  if (editor.active === from) editor.active = to;
  if (editor.savingAs?.key === from) editor.savingAs.key = to;
  editor.buffers[to] = { ...buffer, root, path, saving: false };
  delete editor.buffers[from];
  for (const map of [states, saved, scrolls] as Map<string, unknown>[]) {
    if (map.has(from)) map.set(to, map.get(from));
    else map.delete(to);
    map.delete(from);
  }
  // A look at the disk under way for the buffer the file had lands on
  // nothing.
  bump(to);
  homes.delete(from);
  if (shown === from) shown = to;
  wrote(to, doc, stamp);
  return to;
}

/** The path was given and the file written: the field goes, the tree
    marks the file, and what was to follow does, the keyboard back in the
    editor or on the tab row. */
export function endSaveAs(key: string) {
  if (editor.savingAs?.key !== key) return;
  const after = afterNaming;
  editor.savingAs = null;
  afterNaming = null;
  void showInViewer();
  after?.then?.(key);
  if (after?.fromRow === true) editor.rowRequests += 1;
  else focusFiles("editor");
}

/** Whether a session not on screen has a tab on the buffer. */
function stillOpenElsewhere(key: string): boolean {
  for (const kept of owners.values()) {
    if (kept.tabs.some((tab) => tabKey(tab) === key)) return true;
  }
  return false;
}

/**
 * Writes a buffer to disk, the file in front unless another is named. The
 * write expects what the buffer was read with; a disk that holds something
 * else answers that it did not write, and the bar over the editor says the
 * file changed. Answers whether it was written. An untitled file is not
 * written yet: the path is asked for first.
 */
export async function save(key: string | null = editor.active): Promise<boolean> {
  if (key === null) return false;
  if (isUntitled(key)) {
    askName(key);
    return false;
  }
  const buffer = editor.buffers[key];
  const state = states.get(key);
  if (buffer === undefined || state === undefined || buffer.loading || buffer.error !== null) return false;
  if (buffer.changed !== null) return false;
  const doc = state.doc;
  buffer.saving = true;
  buffer.failed = null;
  bump(key);
  try {
    const result = await core().fileWrite(buffer.root, buffer.path, doc.toString(), buffer.stamp, false);
    if (!result.written) {
      buffer.changed = { stamp: result.stamp, problem: null };
      if (result.stamp !== null) await readDisk(key);
      return false;
    }
    wrote(key, doc, result.stamp);
    return true;
  } catch (error) {
    const still = editor.buffers[key];
    if (still !== undefined) still.failed = couldNotSave(buffer.path, reason(error));
    return false;
  } finally {
    const still = editor.buffers[key];
    if (still !== undefined) still.saving = false;
  }
}

/** A buffer's text is what the disk now holds: it is saved unless it was
    edited again while the write was on its way. */
function wrote(key: string, doc: Text, stamp: string | null) {
  const buffer = editor.buffers[key];
  if (buffer === undefined) return;
  saved.set(key, doc);
  buffer.stamp = stamp;
  buffer.changed = null;
  onDisk.delete(key);
  const now = states.get(key)?.doc;
  buffer.dirty = now !== undefined && !now.eq(doc);
  if (editor.active === key) editor.comparing = false;
}

/** What the disk holds for a buffer, kept for Compare. */
async function readDisk(key: string) {
  const buffer = editor.buffers[key];
  if (buffer === undefined) return;
  try {
    const read = await core().fileRead(buffer.root, buffer.path);
    onDisk.set(key, read.text);
  } catch {
    onDisk.set(key, "");
  }
}

/** The disk's text for the file in front, as Compare shows it. */
export function diskText(key: string): string {
  return onDisk.get(key) ?? "";
}

/** The buffer's text now. */
export function bufferText(key: string): string {
  return states.get(key)?.doc.toString() ?? "";
}

/** Keep mine: the editor's version is written over what the disk holds. */
export async function keepMine(key: string | null = editor.active) {
  if (key === null) return;
  const buffer = editor.buffers[key];
  const state = states.get(key);
  if (buffer === undefined || state === undefined) return;
  const doc = state.doc;
  buffer.saving = true;
  buffer.failed = null;
  bump(key);
  try {
    const result = await core().fileWrite(buffer.root, buffer.path, doc.toString(), null, true);
    wrote(key, doc, result.stamp);
  } catch (error) {
    const still = editor.buffers[key];
    if (still !== undefined) still.failed = couldNotSave(buffer.path, reason(error));
  } finally {
    const still = editor.buffers[key];
    if (still !== undefined) still.saving = false;
  }
}

/** Load from disk: the editor's edits are dropped for what the disk holds,
    as one change that undo can take back. */
export async function loadFromDisk(key: string | null = editor.active) {
  if (key === null) return;
  const buffer = editor.buffers[key];
  if (buffer === undefined) return;
  bump(key);
  try {
    const read = await core().fileRead(buffer.root, buffer.path);
    takeIn(key, read.text, read.stamp);
  } catch (error) {
    const still = editor.buffers[key];
    if (still !== undefined) still.changed = failedRead(still, reason(error));
  }
}

/** The bar's answer for a file that is gone: the tab closes, and the edits
    with it, as its button says. */
export function closeDropping(key: string | null = editor.active) {
  if (key === null) return;
  const buffer = editor.buffers[key];
  if (buffer !== undefined) {
    buffer.dirty = false;
    buffer.changed = null;
  }
  dropTab(key);
  focusFiles("editor");
}

/** The bar's answer for a file that could not be read: look again. */
export function tryAgain(key: string | null = editor.active) {
  if (key === null) return;
  void recheck(key);
}

/** What a read that failed says about the file under unsaved edits: gone
    when the core says nothing is there, else that it could not be read and
    why. */
function failedRead(buffer: Buffer, problem: string): NonNullable<Buffer["changed"]> {
  const gone = problem.endsWith(" does not exist") || !stillListed(buffer);
  return { stamp: null, problem: gone ? null : problem };
}

/** Whether the tree still lists the buffer's file, when it is the tree on
    screen and the tree lists every file. */
function stillListed(buffer: Buffer): boolean {
  if (buffer.root !== watchRoot() || files.scope !== "all" || !files.everythingLoaded) return true;
  return files.everything.some((file) => file.path === buffer.path && file.status !== "D");
}

/** Compare: the disk's version against the editor's, or back to editing. */
export async function compare(key: string | null = editor.active) {
  const changed = key === null ? null : editor.buffers[key]?.changed;
  if (key === null || changed == null || changed.stamp === null) return;
  if (editor.comparing) {
    editor.comparing = false;
    return;
  }
  if (!onDisk.has(key)) await readDisk(key);
  editor.comparing = true;
}

/** Takes what the disk holds into a buffer, one change per run of lines
    that differ, so the lines between keep their places with the cursor,
    the selection and the scroll on them. It is one step of its own in the
    history, which undo can take back, and not the user's edit. */
function takeIn(key: string, text: string, stamp: string) {
  const buffer = editor.buffers[key];
  const state = states.get(key);
  if (buffer === undefined || state === undefined) return;
  bump(key);
  const changes = lineEdits(state.doc.toString(), text);
  if (changes.length > 0) {
    change(key, {
      changes,
      annotations: [Transaction.userEvent.of(RELOAD), isolateHistory.of("full")],
    });
  }
  const doc = states.get(key)!.doc;
  saved.set(key, doc);
  buffer.stamp = stamp;
  buffer.dirty = false;
  buffer.changed = null;
  buffer.error = null;
  onDisk.delete(key);
  if (editor.active === key) editor.comparing = false;
}

/** Changes a buffer's state: through the editor when it shows the buffer,
    so the two never part, and in the store otherwise. */
function change(key: string, spec: TransactionSpec) {
  if (view !== null && shown === key) {
    view.dispatch(spec);
    return;
  }
  const state = states.get(key);
  if (state === undefined) return;
  states.set(key, state.update(spec).state);
}

/**
 * Looks at the disk for an open buffer, after the core said its file
 * changed or its tab came on screen. The same stamp is nothing to do.
 * Another, with no unsaved edits, is read in; with unsaved edits, the bar
 * goes up. A file that cannot be read with nothing unsaved says why in
 * place of the editor.
 */
async function recheck(key: string) {
  const buffer = editor.buffers[key];
  if (buffer === undefined || buffer.loading || buffer.saving || buffer.root === UNTITLED) return;
  if (buffer.error !== null && buffer.stamp === null) return;
  const generation = generations.get(key) ?? 0;
  const asked = (reads.get(key) ?? 0) + 1;
  reads.set(key, asked);
  let read: { text: string; stamp: string } | null = null;
  let failure: string | null = null;
  try {
    read = await core().fileRead(buffer.root, buffer.path);
  } catch (error) {
    failure = reason(error);
  }
  const now = editor.buffers[key];
  if (now === undefined || now.saving) return;
  if ((generations.get(key) ?? 0) !== generation || reads.get(key) !== asked) return;
  if (read !== null) {
    if (read.stamp === now.stamp) {
      now.changed = null;
      if (now.error !== null && states.has(key)) now.error = null;
      return;
    }
    if (!now.dirty) {
      takeIn(key, read.text, read.stamp);
      return;
    }
    now.changed = { stamp: read.stamp, problem: null };
    onDisk.set(key, read.text);
    return;
  }
  if (now.dirty) {
    now.changed = failedRead(now, failure ?? "");
    onDisk.delete(key);
  } else {
    now.error = failure;
  }
}

/** The tabs that came on screen look at the disk, since the core watches
    only the files of the tabs on screen. */
export function recheckOpen() {
  const seen = new Set<string>();
  for (const tab of editor.tabs) {
    const key = tabKey(tab);
    if (seen.has(key)) continue;
    seen.add(key);
    void recheck(key);
  }
}

/** The core says files it watches changed, by the paths it was given:
    the buffers on them look at the disk again. */
export function diskChanged(paths: string[]) {
  const changed = new Set(paths);
  for (const [key, buffer] of Object.entries(editor.buffers)) {
    if (changed.has(watchedPath(buffer.root, buffer.path))) void recheck(key);
  }
}

/** A file of a tree as the machine the tree is on names it. */
function watchedPath(root: string, path: string): string {
  return `${pathOn(root).replace(/[\\/]+$/, "")}/${path}`;
}

/** The open files of the tabs on screen, as the machine their tree is on
    names them, for the core to watch where they are. */
export function watchedFiles(): string[] {
  const out: string[] = [];
  for (const tab of editor.tabs) {
    const buffer = editor.buffers[tabKey(tab)];
    if (buffer === undefined || buffer.error !== null || tab.root === UNTITLED) continue;
    out.push(watchedPath(tab.root, tab.path));
  }
  return out;
}

/** The core asks before the window closes or the app quits while the
    editor holds unsaved edits. The question is drawn over the whole window,
    whatever the panes show, and it is the drawing that tells the core it
    is up. */
export function leaveRequested(ask: { kind: "window" | "quit"; generation: number }) {
  editor.asking = { kind: "leave", leave: ask.kind, generation: ask.generation };
}

/** The files with unsaved edits, by name, for the question. */
export function unsavedNames(keys: string[] = unsavedKeys()): string[] {
  return keys.map((key) => lastSegment(editor.buffers[key]?.path ?? key));
}

function unsavedKeys(): string[] {
  return Object.entries(editor.buffers)
    .filter(([, buffer]) => buffer.dirty)
    .map(([key]) => key);
}

/** The window closes, or the app quits, unsaved edits and all. */
export function leaveWithoutSaving() {
  const asked = editor.asking;
  if (asked?.kind !== "leave") return;
  editor.asking = null;
  void core().leaveConfirmed(asked.leave).catch(() => {});
}

/** Every unsaved file written, each untitled one once its path is given,
    then the window closes or the app quits if they all were. When one
    could not be, nothing goes: that file comes forward with its bar or
    why, and the status bar says what stopped. */
export async function saveAllAndLeave() {
  const asked = editor.asking;
  if (asked?.kind !== "leave") return;
  editor.asking = null;
  await saveEvery(unsavedKeys(), asked.leave === "quit" ? "Quit stopped" : "The window stays open", () => {
    void core().leaveConfirmed(asked.leave).catch(() => {});
  });
}

/**
 * Writes every file of `keys` that has a name, then asks the path of each
 * untitled one in turn, with that file in front, and does `done` once all
 * are written. A file that could not be written, or an untitled one whose
 * field was put away, stops it there: that file stays in front, and the
 * status bar says what was stopped.
 */
async function saveEvery(keys: string[], what: string, done: () => void) {
  const named = keys.filter((key) => !isUntitled(key));
  const written = await Promise.all(named.map((key) => save(key)));
  const failed = named.filter((_, at) => !written[at]);
  if (failed.length > 0) {
    stopped(what, failed);
    return;
  }
  nameInTurn(keys.filter(isUntitled), what, done);
}

function nameInTurn(keys: string[], what: string, done: () => void) {
  const at = keys.findIndex((key) => editor.buffers[key]?.dirty === true);
  if (at === -1) {
    done();
    return;
  }
  const key = keys[at];
  const name = editor.buffers[key].path;
  bringOut(key, (borrowed) => {
    const shownBefore = new Set(editor.tabs.map(tabKey));
    askName(key, {
      then: (written) => {
        // A tab brought from another session's tabs goes once written:
        // the file stays open beside the session it was started in.
        if (borrowed && !shownBefore.has(written)) dropTab(written);
        nameInTurn(keys.slice(at + 1), what, done);
      },
      cancelled: () => say(`${what}: ${name} was not saved`),
    });
  });
}

/** The user's answer to the window or the app going: stay. */
export function leaveCancelled() {
  if (editor.asking?.kind !== "leave") return;
  editor.asking = null;
  returnFocus();
}

/**
 * A save on the way out could not be made: the first file it stopped at
 * comes forward in the editor, with the bar that holds it back or why it
 * failed, beside whichever session is on screen, and the status bar says
 * what was stopped and why.
 */
function stopped(what: string, keys: string[]) {
  const key = keys[0];
  const buffer = editor.buffers[key];
  if (buffer === undefined) return;
  const why =
    buffer.changed !== null
      ? `${lastSegment(buffer.path)} changed on disk`
      : buffer.failed !== null
        ? lastSegment(buffer.path) + " could not be saved"
        : `${lastSegment(buffer.path)} was not saved`;
  say(`${what}: ${why}`);
  bringOut(key);
}

/** Brings a buffer's tab to the front beside whichever session is on
    screen, in editor mode, then does `then`, told whether the tab was
    brought in from another's tabs. */
function bringOut(key: string, then?: (borrowed: boolean) => void) {
  const buffer = editor.buffers[key];
  if (buffer === undefined) return;
  const show = () => {
    const borrowed = !editor.tabs.some((tab) => tabKey(tab) === key);
    if (borrowed) {
      editor.tabs.push({ root: buffer.root, path: buffer.path, preview: false, view: "edit", note: null });
    }
    void activate(key);
    then?.(borrowed);
  };
  if (layout.mode === "editing") show();
  else enterEditor(show);
}

/** Closes the editor's tab in front, asking as its × does: the chord, or
    the palette. Nothing outside editor mode. */
export function closeTabInFront() {
  const tab = activeTab();
  if (layout.mode !== "editing" || tab === null || otherKindShown()) return false;
  closeTab(tabKey(tab));
  return true;
}

/** Keeps the core told whether anything is unsaved, so it knows whether
    to ask before the window closes or the app quits. */
function tellUnsaved() {
  $effect(() => {
    const any = anyUnsaved();
    untrack(() => void core().setUnsaved(any).catch(() => {}));
  });
}

/** The tabs a set of owners hold whose buffers have the only copy of
    unsaved edits: no owner left after them has the file open. */
function unsavedOnlyIn(gone: string[]): string[] {
  const goneSet = new Set(gone);
  const tabsOf = (key: string) => (key === owner ? editor.tabs : (owners.get(key)?.tabs ?? []));
  const held = new Set<string>();
  for (const key of gone) for (const tab of tabsOf(key)) held.add(tabKey(tab));
  const kept = new Set<string>();
  const others = [...owners.keys(), ...(owner === null ? [] : [owner])].filter((key) => !goneSet.has(key));
  for (const key of others) for (const tab of tabsOf(key)) kept.add(tabKey(tab));
  return [...held].filter((key) => editor.buffers[key]?.dirty && !kept.has(key));
}

/**
 * Closes a session or a project as the user asked, after asking first when
 * tabs beside it hold the only copy of unsaved edits, or shells that go
 * with it are busy: the question goes in the sessions pane, with Save and
 * close, Close without saving and Cancel for the edits, and the close and
 * Cancel for the shells alone.
 */
export function closeAsking(
  what: string,
  gone: string[],
  close: () => void,
  kind: "session" | "project" = "session",
  busy: BusyShell[] = [],
) {
  const keys = unsavedOnlyIn(gone);
  if (keys.length === 0 && busy.length === 0) {
    close();
    return;
  }
  editor.closing = { what, kind, owners: gone, keys, busy, close };
}

export async function closingSave() {
  const asked = editor.closing;
  if (asked === null) return;
  editor.closing = null;
  await saveEvery(asked.keys, `${asked.what} stays open`, asked.close);
}

export function closingDrop() {
  const asked = editor.closing;
  if (asked === null) return;
  editor.closing = null;
  for (const key of asked.keys) {
    const buffer = editor.buffers[key];
    if (buffer !== undefined) buffer.dirty = false;
  }
  asked.close();
}

export function closingCancel() {
  editor.closing = null;
}

/** A session or a project went: its tabs go with it. One that holds the
    only copy of unsaved edits, which only happens when the user was not
    asked, joins the tabs shown next rather than losing them. */
function ownerGone(key: string) {
  const tabs = key === owner ? editor.tabs : (owners.get(key)?.tabs ?? []);
  const keep = new Set(unsavedOnlyIn([key]));
  if (key === owner) {
    editor.tabs = [];
    editor.active = null;
    editor.asking = editor.asking?.kind === "leave" ? editor.asking : null;
    owner = null;
  } else {
    owners.delete(key);
  }
  for (const tab of tabs) {
    if (keep.has(tabKey(tab))) rescued.push({ ...tab, preview: false });
    else release(tabKey(tab));
  }
  // Whoever is shown next is chosen after this, by the store that closed
  // the session: the rescued tabs join them then.
  if (rescued.length > 0) queueMicrotask(() => void ownerShown());
}

/** Whether `path` is `base` or inside it. */
function under(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/** Every tab, the sessions' not on screen included. */
function everyTab(): Tab[] {
  return [...editor.tabs, ...[...owners.values()].flatMap((kept) => kept.tabs)];
}

/** A file or a folder was renamed or moved in the tree: the tabs on it, or
    on what was in it, follow it, with their buffers, edits and all. */
export function moved(root: string, from: string, to: string) {
  const renames = new Map<string, string>();
  for (const tab of everyTab()) {
    if (tab.root !== root || !under(tab.path, from)) continue;
    const before = tabKey(tab);
    tab.path = `${to}${tab.path.slice(from.length)}`;
    renames.set(before, tabKey(tab));
  }
  for (const [before, after] of renames) {
    const buffer = editor.buffers[before];
    if (buffer !== undefined) {
      delete editor.buffers[before];
      editor.buffers[after] = { ...buffer, path: after.slice(after.indexOf("\u0000") + 1) };
    }
    for (const map of [states, saved, scrolls, onDisk, generations] as Map<string, unknown>[]) {
      if (!map.has(before)) continue;
      map.set(after, map.get(before));
      map.delete(before);
    }
    if (editor.active === before) editor.active = after;
    if (shown === before) shown = after;
    for (const kept of owners.values()) if (kept.active === before) kept.active = after;
  }
  void showInViewer();
}

/** A file or a folder was deleted from the tree: the tabs on it, or on
    what was in it, close without asking, since deleting was asked. */
export function deleted(root: string, path: string) {
  for (const [ownerKey, kept] of owners) {
    const left = kept.tabs.filter((tab) => tab.root !== root || !under(tab.path, path));
    const active = left.some((tab) => tabKey(tab) === kept.active) ? kept.active : (left[0] ? tabKey(left[0]) : null);
    owners.set(ownerKey, { tabs: left, active });
  }
  for (const tab of [...editor.tabs]) {
    if (tab.root !== root || !under(tab.path, path)) continue;
    const key = tabKey(tab);
    const buffer = editor.buffers[key];
    if (buffer !== undefined) buffer.dirty = false;
    dropTab(key);
  }
  for (const key of Object.keys(editor.buffers)) {
    const buffer = editor.buffers[key];
    if (buffer.root === root && under(buffer.path, path)) release(key);
  }
}

/** How many open files under `path` have unsaved edits. */
export function unsavedUnder(root: string, path: string): number {
  return Object.values(editor.buffers).filter(
    (buffer) => buffer.root === root && buffer.dirty && under(buffer.path, path),
  ).length;
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
 * the agent's tools read of the screen names the file. With no tab, or an
 * untitled file in front, the viewer holds nothing.
 */
async function showInViewer() {
  if (layout.mode !== "editing") return;
  const tab = activeTab();
  // An untitled file is in no tree: the viewer holds nothing, and the
  // agent's tools are told of no file.
  if (tab === null || tab.root === UNTITLED) {
    deselect();
    return;
  }
  files.view = VIEWER[tab.view];
  files.renderedFor = tab.view === "preview" ? tab.path : null;
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
  const open = activeTab() !== null;
  if (target === "editor" && !open) target = "tree";
  // A window too narrow for the tree's column has only the editor to give.
  if (target === "tree" && open && layout.mode === "editing" && !editTreeVisible()) target = "editor";
  editor.target = target;
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

/** Into editor mode, in one step, so the agent is told one new size. A
    file the viewer showed opens in the editor at the place it was shown;
    `then` runs once the window has flipped. */
export function enterEditor(then?: () => void) {
  if (layout.mode === "editing") {
    then?.();
    return;
  }
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
}

/** Back to agent mode, in one step: the viewer opens again on what took
    the editor's place, else the agent has the middle with the changes
    beside it. */
export function leaveEditor() {
  if (layout.mode !== "editing") return;
  editingScope = files.scope;
  const other = otherKindShown();
  if (!other) deselect();
  setEditing(false);
  if (agentScope !== null && files.scope !== agentScope) void setScope(agentScope);
  agentScope = null;
  if (other) enterReview();
}

/** The right pane's button, or its chord: shows or hides the right pane,
    and says so when the window is too narrow to show it at all. */
export function toggleRight() {
  if (toggleRightPane() !== "no room") return;
  say(
    layout.mode === "editing"
      ? "The window is too narrow for the agent beside the editor"
      : "The window is too narrow for the changes beside the agent",
  );
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
  if (next !== owner) {
    if (owner !== null) owners.set(owner, { tabs: editor.tabs, active: editor.active });
    const back = next === null ? undefined : owners.get(next);
    if (next !== null) owners.delete(next);
    owner = next;
    editor.tabs = back?.tabs ?? [];
    editor.active = back?.active ?? null;
    editor.reveal = null;
    editor.comparing = false;
    if (editor.asking?.kind === "close") editor.asking = null;
    if (editor.savingAs !== null) putNamingAway();
  } else if (rescued.length === 0) {
    return;
  }
  if (owner !== null && rescued.length > 0) {
    for (const tab of rescued) {
      if (!editor.tabs.some((candidate) => tabKey(candidate) === tabKey(tab))) editor.tabs.push(tab);
    }
    if (editor.active === null) editor.active = tabKey(rescued[0]);
    rescued = [];
  }
  recheckOpen();
  if (layout.mode !== "editing") return;
  // The switch may have moved the project or the worktree, and the tree
  // clears itself on that: the file is marked once it is read again.
  await tick();
  await treeSettled();
  if (owner === next) await showInViewer();
}

/** Keeps `ownerShown` called as the session or project on screen
    changes, the tabs of one that goes let go, and the core told whether
    anything is unsaved. Runs in an effect root: call once, from the page. */
export function followOwner() {
  $effect(() => {
    sessions.active;
    workspace.active;
    untrack(() => void ownerShown());
  });
  onOwnerGone(ownerGone);
  tellUnsaved();
}

const SIZE_KEY = "chord.editorSize";

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
  editor.asking = null;
  editor.comparing = false;
  editor.closing = null;
  editor.savingAs = null;
  afterNaming = null;
  namings = 0;
  onDisk.clear();
  generations.clear();
  reads.clear();
  homes.clear();
  rescued = [];
}

/** Test seam: a session or project went, as the sessions store says. */
export const ownerGoneForTests = (key: string) => ownerGone(key);
