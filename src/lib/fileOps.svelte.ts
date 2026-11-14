/**
 * What the tree can do to the files in editor mode: a new file, a new
 * folder, a rename, a delete, the path copied, the file shown in the
 * platform's file manager.
 *
 * A new file is named in a field in place in the tree, in the folder the
 * cursor is in: Enter makes it and opens it, Escape drops it, and slashes in
 * the name make the folders on the way. The tree lists what git lists, and
 * git lists no empty folder, so a new folder is not made by itself: naming
 * one shows it open in the tree with a field for its first file, and the
 * folder is made with that file. Escape there drops both.
 *
 * Delete asks first with the confirm strip and says what goes. Every change
 * is the core's, routed by the tree's root, so it works on a remote machine
 * as well as here; showing a file in the file manager is for a project on
 * this machine only.
 */

import { core } from "$lib/core";
import {
  deleted,
  enterEditor,
  focusFiles,
  moved,
  openFile,
  unsavedUnder,
} from "$lib/editor.svelte";
import { absolute, files, listed, refresh, reveal, treeSettled } from "$lib/files.svelte";
import { say } from "$lib/flash.svelte";
import { layout } from "$lib/layout.svelte";
import { isMac, isWindows } from "$lib/platform";
import { isRemote } from "$lib/remote.svelte";
import { parentOf } from "$lib/tree";
import { watchRoot } from "$lib/workspace.svelte";

export type Naming =
  /** A new file, in a folder or at the top. */
  | { kind: "file"; folder: string | null }
  /** A new folder, in a folder or at the top. */
  | { kind: "folder"; folder: string | null }
  /** The first file of a folder named but not made yet. */
  | { kind: "first"; folder: string }
  /** A file or a folder renamed, or moved by slashes in the name. */
  | { kind: "rename"; path: string; dir: boolean };

export const fileOps = $state({
  naming: null as Naming | null,
  /** What the name field holds. */
  name: "",
  /** Why the name will not do, under the field. */
  problem: null as string | null,
  /** The name field is being acted on: the core has not answered yet. */
  busy: false,
  /** Counts the namings begun, so the field stays one element for as long
      as one lasts. */
  session: 0,
  /** A folder named but not made yet: the tree shows it until its first
      file makes it, or Escape drops it. */
  pending: null as string | null,
  /** The row the user put the tree's cursor on, for where a new file goes;
      null until they have moved it. */
  cursor: null as { path: string; dir: boolean } | null,
  /** The menu a right-click on a row opens, and where. A null path is the
      tree itself, below its rows. */
  menu: null as { path: string | null; dir: boolean; x: number; y: number } | null,
  /** The question before a delete. */
  deleting: null as { path: string; dir: boolean; files: number; unsaved: number } | null,
  /** Why the last delete could not be made, over the tree until the next
      change. */
  failed: null as string | null,
});

/** The folder the cursor is in: the folder under it, or the one the file
    under it is in. Until the user has put the cursor somewhere or chosen a
    file, the top. */
function cursorFolder(): string | null {
  const at = fileOps.cursor ?? (files.selected === null ? null : { path: files.selected, dir: false });
  if (at === null) return null;
  return at.dir ? at.path : parentOf(at.path);
}

/** Opens every folder on the way to and including `folder`. */
function openFolder(folder: string | null) {
  if (folder === null) return;
  reveal(`${folder}/-`);
}

function begin(naming: Naming, name = "") {
  fileOps.session += 1;
  fileOps.menu = null;
  fileOps.deleting = null;
  fileOps.failed = null;
  fileOps.naming = naming;
  fileOps.name = name;
  fileOps.problem = null;
  fileOps.busy = false;
  editorFocusToTree();
}

/** The name field is in the tree's column: the files pane's keyboard goes
    to the tree's side of it. */
function editorFocusToTree() {
  focusFiles("tree");
}

/** A name field for a new file: in a folder, or where the cursor is. From
    agent mode the window flips to the editor first. */
export function newFile(folder: string | null = cursorFolder()) {
  const start = () => {
    openFolder(folder);
    begin({ kind: "file", folder });
  };
  if (layout.mode === "editing") start();
  else enterEditor(start);
}

/** A name field for a new folder. */
export function newFolder(folder: string | null = cursorFolder()) {
  openFolder(folder);
  begin({ kind: "folder", folder });
}

/** A name field over a row, holding its name. */
export function rename(path: string, dir: boolean) {
  begin({ kind: "rename", path, dir }, path.slice(path.lastIndexOf("/") + 1));
}

export function setName(name: string) {
  fileOps.name = name;
  fileOps.problem = null;
}

/** The field lost the keyboard to something else in the window: a name
    that will do is made or applied, as Enter would; one that will not
    stays in the field with why. Losing it to another app, or a folder's
    name losing it at all, keeps the field as it is, to come back to. */
export function nameLeft() {
  if (fileOps.naming === null || fileOps.busy) return;
  if (typeof document !== "undefined" && !document.hasFocus()) return;
  // A folder is made only with its first file: its name is left as it
  // is, to come back to, rather than half made.
  if (fileOps.naming.kind === "folder") return;
  void commitName();
}

/** Escape: the field goes, and a folder named for it with it. */
export function cancelName() {
  if (fileOps.busy || fileOps.naming === null) return;
  fileOps.naming = null;
  fileOps.pending = null;
  fileOps.problem = null;
  fileOps.name = "";
  editorFocusToTree();
}

/** A name as a path under `folder`: slashes either way are folders, and
    no part of it may leave the tree. Null with the reason when it will not
    do. */
export function pathFor(folder: string | null, name: string): { path: string } | { problem: string } {
  const parts = name
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return { problem: "A name is needed." };
  if (parts.some((part) => part === "." || part === "..")) {
    return { problem: "A name cannot step out of its folder." };
  }
  if (parts[0] === ".git") return { problem: "Nothing is made inside .git." };
  const relative = parts.join("/");
  return { path: folder === null ? relative : `${folder}/${relative}` };
}

/** Whether the tree lists a folder at `path`. */
function folderListed(path: string): boolean {
  return listed().some((file) => file.path.startsWith(`${path}/`));
}

/** Enter in the name field. */
export async function commitName() {
  const naming = fileOps.naming;
  const root = watchRoot();
  if (naming === null || root === null || fileOps.busy) return;
  if (fileOps.name.trim() === "") {
    cancelName();
    return;
  }
  const folder = naming.kind === "rename" ? parentOf(naming.path) : naming.folder;
  const target = pathFor(folder, fileOps.name);
  if ("problem" in target) {
    fileOps.problem = target.problem;
    return;
  }
  if (naming.kind === "folder") {
    // Nothing is made yet: the folder shows open with a field for its
    // first file, and is made with that.
    if (!folderListed(target.path)) fileOps.pending = target.path;
    openFolder(target.path);
    begin({ kind: "first", folder: target.path });
    return;
  }
  fileOps.busy = true;
  try {
    if (naming.kind === "rename") await renameTo(root, naming.path, target.path);
    else await create(root, target.path);
  } finally {
    fileOps.busy = false;
  }
}

/** Makes an empty file, the folders on the way with it, and opens it. */
async function create(root: string, path: string) {
  try {
    const result = await core().fileWrite(root, path, "", null, false);
    if (!result.written) {
      fileOps.problem = `Something is already at ${path}.`;
      return;
    }
  } catch (error) {
    fileOps.problem = reason(error);
    return;
  }
  fileOps.naming = null;
  fileOps.pending = null;
  fileOps.name = "";
  await refresh();
  await treeSettled();
  await openFile(path, { keep: true, focus: true });
}

async function renameTo(root: string, from: string, to: string) {
  if (to === from) {
    cancelName();
    return;
  }
  try {
    await core().pathRename(root, from, to);
  } catch (error) {
    fileOps.problem = reason(error);
    return;
  }
  fileOps.naming = null;
  fileOps.name = "";
  moved(root, from, to);
  reveal(to);
  await refresh();
  editorFocusToTree();
}

function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error:\s*/, "");
}

/** A right-click on a row, or on the tree below its rows. */
export function openMenu(path: string | null, dir: boolean, x: number, y: number) {
  fileOps.menu = { path, dir, x, y };
}

export function closeMenu() {
  fileOps.menu = null;
}

/** The files the tree lists at or under `path`. */
function filesUnder(path: string, dir: boolean): number {
  if (!dir) return 1;
  return listed().filter((file) => file.path.startsWith(`${path}/`) && file.status !== "D").length;
}

/** Delete, from the menu: the question first, saying what goes. */
export function askDelete(path: string, dir: boolean) {
  const root = watchRoot();
  if (root === null) return;
  fileOps.menu = null;
  fileOps.naming = null;
  fileOps.failed = null;
  fileOps.deleting = { path, dir, files: filesUnder(path, dir), unsaved: unsavedUnder(root, path) };
}

/** The question's words. */
export function deleteQuestion(): { question: string; detail: string } | null {
  const asked = fileOps.deleting;
  if (asked === null) return null;
  const name = asked.path;
  const unsaved =
    asked.unsaved === 0
      ? ""
      : ` ${asked.unsaved === 1 ? "Unsaved edits in 1 open file go" : `Unsaved edits in ${asked.unsaved} open files go`} too.`;
  if (!asked.dir) {
    return { question: `Delete ${name}?`, detail: `Deleted from disk, not moved to the Trash.${unsaved}` };
  }
  const count = asked.files === 1 ? "its 1 file" : `all ${asked.files} files`;
  return {
    question: `Delete ${name} and ${count}?`,
    detail: `Deleted from disk, not moved to the Trash.${unsaved}`,
  };
}

export function cancelDelete() {
  fileOps.deleting = null;
  editorFocusToTree();
}

export async function confirmDelete() {
  const asked = fileOps.deleting;
  const root = watchRoot();
  fileOps.deleting = null;
  if (asked === null || root === null) return;
  try {
    await core().pathDelete(root, asked.path);
  } catch (error) {
    fileOps.failed = `Could not delete ${asked.path}: ${reason(error)}.`;
    editorFocusToTree();
    return;
  }
  deleted(root, asked.path);
  await refresh();
  editorFocusToTree();
}

/** The path relative to the project, which is what a prompt wants. */
export async function copyPath(path: string) {
  fileOps.menu = null;
  try {
    await core().copyText(path);
    say(`Copied ${path}`);
  } catch (error) {
    say(`Could not copy the path: ${reason(error)}`);
  }
}

/** Whether the tree on screen is on this machine, where the platform's
    file manager can show its files. */
export function canReveal(): boolean {
  const root = watchRoot();
  return root !== null && !isRemote(root);
}

/** The menu's word for showing a file in the platform's file manager. */
export function revealLabel(): string {
  if (isMac()) return "Reveal in Finder";
  if (isWindows()) return "Show in Explorer";
  return "Show in file manager";
}

export async function revealInFiles(path: string) {
  fileOps.menu = null;
  const full = absolute(path);
  if (full === null || !canReveal()) return;
  try {
    await core().revealPath(full);
  } catch (error) {
    say(`Could not show it: ${reason(error)}`);
  }
}

/** Test seam. */
export function resetFileOps() {
  fileOps.failed = null;
  fileOps.naming = null;
  fileOps.name = "";
  fileOps.problem = null;
  fileOps.busy = false;
  fileOps.pending = null;
  fileOps.cursor = null;
  fileOps.menu = null;
  fileOps.deleting = null;
}
