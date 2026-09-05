import { SvelteSet } from "svelte/reactivity";
import { core, type ChangedFile, type DiffLine } from "$lib/core";
import { exitReview } from "$lib/layout.svelte";
import { lastSegment } from "$lib/paths";
import { watchRoot } from "$lib/workspace.svelte";

/**
 * What the changes pane is showing.
 *
 * Two controls, and they are connected, which is why they share a head:
 *
 *   scope — which files are listed. Changed is `git status`; all files is the
 *           index plus untracked, honouring .gitignore. A second data source,
 *           not a filter over the first.
 *   view  — how the selected file is shown. Diff or content.
 *
 * The connection: a file with no changes has no diff to show, so widening the
 * scope is exactly what puts files in the list that can only be read as
 * content. The viewer resolves that itself rather than making you notice.
 *
 * Everything here comes from the core. The core holds no state of its own for
 * this: the watcher says the tree moved and the pane asks again, because
 * re-running `git status` is cheap and being right is worth more than being
 * clever about diffing two states.
 */

export type Scope = "changed" | "all";
export type View = "diff" | "content";

export interface FileEntry {
  path: string;
  /** null means unchanged: listed only in the all-files scope. */
  status: string | null;
  add?: number;
  del?: number;
  binary?: boolean;
}

export const files = $state({
  scope: "changed" as Scope,
  view: "diff" as View,
  selected: null as string | null,

  changed: [] as FileEntry[],
  everything: [] as FileEntry[],
  /** Loaded lazily: the all-files list is only worth asking for when shown. */
  everythingLoaded: false,

  diff: null as { lines: DiffLine[]; binary: boolean; truncated: boolean } | null,
  content: null as { lines: string[]; binary: boolean; truncated: boolean } | null,
  loading: false,
  error: null as string | null,

  /**
   * Folders you opened and folders you closed, as overrides. A folder with no
   * entry in either falls back to the default: open when something beneath it
   * changed. That way widening the scope to hundreds of files does not bury
   * the handful the agent touched.
   */
  expanded: new SvelteSet<string>(),
  collapsed: new SvelteSet<string>(),
});

function fromChanged(file: ChangedFile): FileEntry {
  return {
    path: file.path,
    status: file.status,
    add: file.add,
    del: file.del,
    binary: file.binary,
  };
}

/**
 * Which read of the tree is the current one. The watcher fires in bursts and
 * the project can change mid-read, so every answer is checked against the
 * question that is still being asked before it lands; an answer to an older
 * question is dropped rather than painted over a newer one.
 */
let treeRead = 0;
let fileRead = 0;

/** Re-reads the working tree. Called on open and whenever the watcher fires. */
export async function refresh() {
  const root = watchRoot();
  const read = ++treeRead;
  if (root === null) {
    files.changed = [];
    files.everything = [];
    files.everythingLoaded = false;
    return;
  }

  try {
    const changed = (await core().gitStatus(root)).map(fromChanged);
    if (read !== treeRead) return;
    files.changed = changed;
    files.error = null;
  } catch (error) {
    if (read !== treeRead) return;
    files.changed = [];
    files.error = String(error);
    return;
  }

  if (files.everythingLoaded || files.scope === "all") await loadEverything(read);
  // The open file may have been changed by the agent, so its diff is stale.
  if (read === treeRead && files.selected !== null) await loadSelected();
}

async function loadEverything(read = treeRead) {
  const root = watchRoot();
  if (root === null) return;

  try {
    const paths = await core().gitFiles(root);
    if (read !== treeRead) return;
    const changedByPath = new Map(files.changed.map((file) => [file.path, file]));

    // The changed ones keep their status and counts; the rest are plain.
    files.everything = paths.map(
      (path) => changedByPath.get(path) ?? { path, status: null },
    );
    // A deleted file is in status but no longer on disk, so it is not in the
    // listing. It still belongs in the tree.
    for (const file of files.changed) {
      if (!paths.includes(file.path)) files.everything.push(file);
    }
    files.everything.sort((a, b) => a.path.localeCompare(b.path));
    files.everythingLoaded = true;
  } catch (error) {
    if (read === treeRead) files.error = String(error);
  }
}

export function listed(): FileEntry[] {
  return files.scope === "changed" ? files.changed : files.everything;
}

export function changedCount() {
  return files.changed.length;
}

export function selectedEntry(): FileEntry | null {
  if (files.selected === null) return null;
  return listed().find((file) => file.path === files.selected) ?? null;
}

/** A file has a diff to show if git changed it and it is not binary. */
export function canDiff(entry: FileEntry | null): boolean {
  return entry !== null && entry.status !== null && entry.binary !== true;
}

/**
 * What the viewer actually renders. Falls back to content rather than showing
 * an empty diff, so widening the scope never lands you on a blank pane.
 */
export function effectiveView(): View {
  return canDiff(selectedEntry()) ? files.view : "content";
}

async function loadSelected() {
  const root = watchRoot();
  const entry = selectedEntry();
  const read = ++fileRead;
  if (root === null || entry === null) {
    files.diff = null;
    files.content = null;
    files.loading = false;
    return;
  }

  files.loading = true;
  try {
    const diff = canDiff(entry) ? await core().gitDiff(root, entry.path) : null;
    // A deleted file has a diff but nothing left to read.
    const content = entry.status === "D" ? null : await core().gitContent(root, entry.path);
    if (read !== fileRead) return;
    files.diff = diff;
    files.content = content;
    files.error = null;
  } catch (error) {
    if (read === fileRead) files.error = String(error);
  } finally {
    if (read === fileRead) files.loading = false;
  }
}

export async function select(path: string) {
  files.selected = path;
  reveal(path);
  await loadSelected();
}

/** Nothing chosen: the tree shows no highlight and the viewer has nothing. */
export function deselect() {
  if (files.selected === null) return;
  files.selected = null;
  files.diff = null;
  files.content = null;
  fileRead += 1;
}

/** Done reading: the file is let go and the viewer closes, if it was open. */
export function closeViewer() {
  deselect();
  exitReview();
}

export async function setScope(scope: Scope) {
  files.scope = scope;
  if (scope === "all" && !files.everythingLoaded) await loadEverything();

  // Narrowing the scope can drop the open file out of the list.
  if (files.selected !== null && !listed().some((file) => file.path === files.selected)) {
    files.selected = null;
    files.diff = null;
    files.content = null;
    fileRead += 1;
  }
}

export function setView(view: View) {
  files.view = view;
}

export function toggleView() {
  setView(files.view === "diff" ? "content" : "diff");
}

export function toggleScope() {
  return setScope(files.scope === "changed" ? "all" : "changed");
}

export function isOpen(node: { path: string; hasChange: boolean }): boolean {
  if (files.collapsed.has(node.path)) return false;
  if (files.expanded.has(node.path)) return true;
  return node.hasChange;
}

export function toggleDir(node: { path: string; hasChange: boolean }) {
  const next = !isOpen(node);
  files.expanded.delete(node.path);
  files.collapsed.delete(node.path);
  // Only record an override where it differs from the default. The sets then
  // stay proportional to what you actually changed rather than to what you
  // clicked, which matters once a repository has a few hundred folders.
  if (next !== node.hasChange) {
    if (next) files.expanded.add(node.path);
    else files.collapsed.add(node.path);
  }
}

/** Opens every folder on the way to a path, so a selection is never hidden. */
export function reveal(path: string) {
  const segments = path.split("/");
  segments.pop();
  let prefix = "";
  for (const segment of segments) {
    prefix = prefix === "" ? segment : `${prefix}/${segment}`;
    files.collapsed.delete(prefix);
    files.expanded.add(prefix);
  }
}

export function basename(path: string) {
  return lastSegment(path);
}

/** Called when the project changes: none of the old tree applies. */
export function clear() {
  treeRead += 1;
  fileRead += 1;
  files.changed = [];
  files.everything = [];
  files.everythingLoaded = false;
  files.selected = null;
  files.diff = null;
  files.content = null;
  files.error = null;
  files.loading = false;
  files.scope = "changed";
  files.expanded.clear();
  files.collapsed.clear();
}
