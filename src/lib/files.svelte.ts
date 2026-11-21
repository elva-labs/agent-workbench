import { SvelteSet } from "svelte/reactivity";
import { core, type ChangedFile, type DiffLine, type GrepHit } from "$lib/core";
import type { MediaItem } from "$lib/media.svelte";
import {
  browser,
  hide as hideBrowser,
  ownTabs,
  open as openBrowserTab,
  show as showBrowserView,
} from "$lib/browser.svelte";
import { enterReview, exitReview, layout, togglePane } from "$lib/layout.svelte";
import { lastSegment } from "$lib/paths";
import { pathOn } from "$lib/remote.svelte";
import { watchRoot, workspace } from "$lib/workspace.svelte";

/**
 * What the changes pane is showing.
 *
 * Two controls, and they are connected, which is why they share a head:
 *
 *   scope — which files are listed. Changed is `git status`; all files is the
 *           index plus untracked, honouring .gitignore. A second data source,
 *           not a filter over the first.
 *   view  — how the selected file is shown. Diff, content, or rendered,
 *           which a file the app can render has: a Markdown, HTML, Mermaid
 *           or SVG file as a reader sees it. The rendered view belongs to
 *           the file it was chosen on.
 *
 * The connection: a file with no changes has no diff to show, so widening the
 * scope is exactly what puts files in the list that can only be read as
 * content. The viewer resolves that itself rather than making you notice,
 * and a Markdown file with no diff opens rendered. A picture git calls
 * binary, an image or a PDF, is shown as one whatever the view.
 *
 * Everything here comes from the core. The core holds no state of its own for
 * this: the watcher says the tree moved and the pane asks again, because
 * re-running `git status` is cheap and being right is worth more than being
 * clever about diffing two states.
 */

export type Scope = "changed" | "all";
export type View = "diff" | "content" | "rendered";

export interface FileEntry {
  path: string;
  /** null means unchanged: listed only in the all-files scope. */
  status: string | null;
  add?: number;
  del?: number;
  binary?: boolean;
}

export type SearchMode = "files" | "lines";

/** Typing pauses this long before a search runs: a query is typed, not sent. */
export const SEARCH_DELAY = 250;

export const files = $state({
  scope: "changed" as Scope,
  view: "diff" as View,
  /** The file whose rendered view was chosen. Markdown keeps the rendered
      view from file to file; any other kind shows it only for this file. */
  renderedFor: null as string | null,
  selected: null as string | null,
  /** What the agent presented, when the viewer holds that rather than a
      file: every file of one call, down the viewer. */
  media: null as MediaItem | null,
  /** A plugin's own page, when the viewer holds that: the page as the
      plugin last sent it, and how much room it asks for. */
  pluginView: null as {
    key: string;
    source: string;
    plugin: string;
    project: string;
    width: "wide" | "full";
    html: string;
  } | null,

  /**
   * The search field. In files mode the query narrows the tree to paths
   * holding it; in lines mode it is searched for inside the files, and the
   * hits stand in for the tree.
   */
  query: "",
  mode: "files" as SearchMode,
  hits: [] as GrepHit[],
  hitsTruncated: false,
  searching: false,
  /** Bumped when a chord asks for the field, which the pane answers by
      putting the keyboard in it. */
  fieldRequests: 0,
  /** A line the viewer should scroll to and mark, from a search hit. */
  /** The place a search hit, a reference in the agent's output or the
      agent's own show request asked for: a line, or a range of them, and
      what was said about it. */
  target: null as {
    path: string;
    line: number;
    to?: number;
    note?: string | null;
  } | null,
  /** The lines the user selected with the mouse in the viewer. Kept, and
      drawn, after the keyboard has gone elsewhere, so what was pointed at
      is still on screen when the agent is asked about it. */
  picked: null as { path: string; from: number; to: number } | null,

  changed: [] as FileEntry[],
  everything: [] as FileEntry[],
  /** Loaded lazily: the all-files list is only worth asking for when shown. */
  everythingLoaded: false,

  diff: null as {
    lines: DiffLine[];
    binary: boolean;
    truncated: boolean;
  } | null,
  content: null as {
    lines: string[];
    binary: boolean;
    truncated: boolean;
  } | null,
  loading: false,
  error: null as string | null,
  /** Counts the reads of the working tree, for what shows a file of it
      and reads the file again when the tree moves: the media the agent
      presented above all. */
  treeReads: 0,
  /** Counts the changes the core saw to the files the viewer shows as
      they are on disk, wherever they are: a document presented from
      outside the tree, a picture in an ignored directory. */
  shownReads: 0,

  /**
   * Folders you opened and folders you closed, kept for the project and saved
   * with it. A folder with no entry in either falls back to the default: open
   * when something beneath it changed. That way widening the scope to
   * hundreds of files does not bury the handful the agent touched, and a
   * folder you chose stays as you chose it whatever changes inside it.
   */
  expanded: new SvelteSet<string>(),
  collapsed: new SvelteSet<string>(),
  /** Folders shown open on the way to the selected file, never saved. They
      fold again as you left them once the selection moves elsewhere. */
  lent: new SvelteSet<string>(),
});

/** Where the folders chosen in each project are kept between runs, keyed by
    the project's path. The folders of a project are the same in each of its
    worktrees, so a fold holds across its sessions. */
const FOLDS_KEY = "chord.folds";
/** The projects whose folds are kept; the one used longest ago goes first. */
const KEPT_PROJECTS = 50;
/** The folders opened and the folders closed kept for each project; the
    choice made longest ago goes first. */
const KEPT_FOLDS = 500;
/** How long a folder can be missing from the full listing before its fold
    is forgotten. A folder another branch has comes back on a switch. */
const FORGET_AFTER = 30 * 24 * 60 * 60 * 1000;

interface KeptFolds {
  open: string[];
  closed: string[];
  /** When each folder with a fold was first missing from the full listing. */
  missing: Record<string, number>;
}

/** The project the folds in `files` belong to, or null when none is open. */
let foldsFor: string | null = null;
/** When each folder with a fold in `files` was first missing from the full
    listing; a folder seen again leaves it. */
const missingSince = new Map<string, number>();

function readFolds(): Record<string, KeptFolds> {
  try {
    const raw = localStorage.getItem(FOLDS_KEY);
    if (raw === null) return {};
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
    const kept: Record<string, KeptFolds> = {};
    for (const [project, entry] of Object.entries(stored)) {
      if (typeof entry !== "object" || entry === null) continue;
      const { open, closed, missing } = entry as Record<string, unknown>;
      const paths = (list: unknown) =>
        Array.isArray(list) ? list.filter((path): path is string => typeof path === "string") : [];
      const since: Record<string, number> = {};
      if (typeof missing === "object" && missing !== null && !Array.isArray(missing)) {
        for (const [path, time] of Object.entries(missing))
          if (typeof time === "number" && Number.isFinite(time)) since[path] = time;
      }
      kept[project] = { open: paths(open), closed: paths(closed), missing: since };
    }
    return kept;
  } catch {
    // Nothing kept reads as every folder at its default.
    return {};
  }
}

function saveFolds() {
  if (foldsFor === null) return;
  for (const set of [files.expanded, files.collapsed]) {
    for (const path of [...set].slice(0, Math.max(0, set.size - KEPT_FOLDS))) set.delete(path);
  }
  for (const path of [...missingSince.keys()])
    if (!files.expanded.has(path) && !files.collapsed.has(path)) missingSince.delete(path);
  const kept = readFolds();
  delete kept[foldsFor];
  if (files.expanded.size > 0 || files.collapsed.size > 0)
    kept[foldsFor] = {
      open: [...files.expanded],
      closed: [...files.collapsed],
      missing: Object.fromEntries(missingSince),
    };
  const projects = Object.keys(kept);
  for (const project of projects.slice(0, Math.max(0, projects.length - KEPT_PROJECTS)))
    delete kept[project];
  try {
    localStorage.setItem(FOLDS_KEY, JSON.stringify(kept));
  } catch {
    // Non-fatal: the folds hold for this run and start at the default next.
  }
}

/** Takes up the folds kept for the project open now. */
function loadFolds() {
  foldsFor = workspace.active;
  files.expanded.clear();
  files.collapsed.clear();
  files.lent.clear();
  missingSince.clear();
  if (foldsFor === null) return;
  const kept = readFolds()[foldsFor];
  if (kept === undefined) return;
  for (const path of kept.open) files.expanded.add(path);
  for (const path of kept.closed) files.collapsed.add(path);
  for (const [path, since] of Object.entries(kept.missing)) missingSince.set(path, since);
}

/** Forgets the folds kept for folders the full listing has not had for
    `FORGET_AFTER`, and notes when the others went missing. */
function pruneFolds() {
  const folders = new Set<string>();
  for (const { path } of files.everything) {
    for (let cut = path.indexOf("/"); cut !== -1; cut = path.indexOf("/", cut + 1))
      folders.add(path.slice(0, cut));
  }
  const now = Date.now();
  let changed = false;
  for (const set of [files.expanded, files.collapsed]) {
    for (const path of [...set]) {
      const since = missingSince.get(path);
      if (folders.has(path)) {
        if (since !== undefined) {
          missingSince.delete(path);
          changed = true;
        }
      } else if (since === undefined) {
        missingSince.set(path, now);
        changed = true;
      } else if (now - since >= FORGET_AFTER) {
        set.delete(path);
        changed = true;
      }
    }
  }
  if (changed) saveFolds();
}

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

/** The latest read of the tree, settled or still being answered. */
let reading: Promise<void> = Promise.resolve();

/** Resolves when the latest read of the tree has landed, so what needs
    the list waits for it rather than reading one that is on its way. */
export function treeSettled(): Promise<void> {
  return reading;
}

/** Re-reads the working tree. Called on open and whenever the watcher fires. */
export function refresh(): Promise<void> {
  reading = readTree();
  return reading;
}

async function readTree() {
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
    files.treeReads += 1;
  } catch (error) {
    if (read !== treeRead) return;
    files.changed = [];
    files.error = String(error);
    return;
  }

  if (files.everythingLoaded || files.scope === "all")
    await loadEverything(read);
  // The open file may have been changed by the agent, so its diff is stale.
  if (read === treeRead && files.selected !== null) await loadSelected();
  // The files moved, so what matched may have too.
  if (read === treeRead && searchingLines()) void search();
}

async function loadEverything(read = treeRead) {
  const root = watchRoot();
  if (root === null) return;

  try {
    const paths = await core().gitFiles(root);
    if (read !== treeRead) return;
    const changedByPath = new Map(
      files.changed.map((file) => [file.path, file]),
    );

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
    pruneFolds();
  } catch (error) {
    if (read === treeRead) files.error = String(error);
  }
}

export function listed(): FileEntry[] {
  return files.scope === "changed" ? files.changed : files.everything;
}

/** Whether the tree is being narrowed by the field right now. */
export function filtering(): boolean {
  return files.mode === "files" && files.query.trim() !== "";
}

/** Whether the hits stand in for the tree right now. */
export function searchingLines(): boolean {
  return files.mode === "lines" && files.query.trim() !== "";
}

/** A path holds the query when every word of the query is in it, in any
    order: `cache mod` finds `src/cache/mod.rs`. Case does not count. */
export function matches(path: string, query: string): boolean {
  const haystack = path.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
    .every((word) => haystack.includes(word));
}

/** What the tree shows: the listing, narrowed by the field in files mode. */
export function visible(): FileEntry[] {
  if (!filtering()) return listed();
  return listed().filter((file) => matches(file.path, files.query));
}

export function setQuery(query: string) {
  files.query = query;
  if (files.mode === "lines") scheduleSearch();
}

export function setMode(mode: SearchMode) {
  if (files.mode === mode) return;
  files.mode = mode;
  if (mode === "lines") scheduleSearch();
  else {
    files.hits = [];
    files.hitsTruncated = false;
  }
}

export function clearQuery() {
  files.query = "";
  files.hits = [];
  files.hitsTruncated = false;
  files.searching = false;
}

/** A chord asked for the field: switch it to the mode and hand it the keys. */
export function requestField(mode: SearchMode) {
  setMode(mode);
  files.fieldRequests += 1;
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchRead = 0;

function scheduleSearch() {
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    void search();
  }, SEARCH_DELAY);
}

/** Runs the lines search now. Only the latest answer lands: a slow search
    for an earlier query must not overwrite a quick one for the current. */
export async function search() {
  if (searchTimer !== null) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  const root = watchRoot();
  const query = files.query.trim();
  if (root === null || files.mode !== "lines" || query === "") {
    files.hits = [];
    files.hitsTruncated = false;
    files.searching = false;
    return;
  }
  const read = ++searchRead;
  files.searching = true;
  try {
    const result = await core().gitGrep(root, query, files.scope);
    if (read !== searchRead) return;
    files.hits = result.hits;
    files.hitsTruncated = result.truncated;
    files.error = null;
  } catch (error) {
    if (read !== searchRead) return;
    files.hits = [];
    files.hitsTruncated = false;
    files.error = String(error);
  } finally {
    if (read === searchRead) files.searching = false;
  }
}

/** Opens a file at a line: the whole file, scrolled and marked there. */
export async function openAt(path: string, line: number) {
  files.target = { path, line };
  files.view = "content";
  await select(path);
}

/** Opens a file at a range of lines with a note above it, in the viewer:
    what the agent asked to show, or a reference in its output. A file git
    has not changed is not in the tree until the scope takes in everything,
    so it does. */
export async function showRange(
  path: string,
  from: number,
  to: number,
  note: string | null,
) {
  if (
    files.scope !== "all" &&
    !files.changed.some((file) => file.path === path)
  ) {
    await setScope("all");
  }
  files.target = { path, line: from, to: Math.max(from, to), note };
  files.view = "content";
  await select(path);
  enterReview();
}

/** Opens a file's diff in the viewer with a note above it: what the agent
    asked to show of its changes. A file git has not changed opens as it is,
    which is what the viewer does with an empty diff. */
export async function showDiff(path: string, note: string | null) {
  if (
    files.scope !== "all" &&
    !files.changed.some((file) => file.path === path)
  ) {
    await setScope("all");
  }
  files.target = { path, line: 0, note };
  files.view = "diff";
  await select(path);
  enterReview();
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

/** A file can be shown rendered if it is a Markdown document still there. */
export function canRender(entry: FileEntry | null): boolean {
  return (
    entry !== null &&
    entry.status !== "D" &&
    entry.binary !== true &&
    /\.(md|markdown)$/i.test(entry.path)
  );
}

/** A file can be previewed if the app renders its kind: Markdown, HTML, a
    Mermaid diagram or SVG, still there. A page is drawn as one presented
    by an agent is. */
export function canPreview(entry: FileEntry | null): boolean {
  return (
    entry !== null &&
    entry.status !== "D" &&
    entry.binary !== true &&
    /\.(md|markdown|html?|mmd|mermaid|svg)$/i.test(entry.path)
  );
}

/** A binary file the viewer shows as a picture rather than declining: an
    image or a PDF, by its extension, read where it is. */
export function isPicture(entry: FileEntry | null): boolean {
  return (
    entry !== null &&
    entry.status !== "D" &&
    entry.binary === true &&
    /\.(png|jpe?g|gif|webp|bmp|pdf)$/i.test(entry.path)
  );
}

/** A file of the tree, absolute, on the machine the project is on. */
export function absolute(path: string): string | null {
  const root = watchRoot();
  if (root === null) return null;
  return `${pathOn(root).replace(/[\\/]+$/, "")}/${path}`;
}

/** The views the selected file has, in the order the chord walks them. */
export function views(entry = selectedEntry()): View[] {
  const own: View[] = [];
  if (canDiff(entry)) own.push("diff");
  own.push("content");
  if (canPreview(entry)) own.push("rendered");
  return own;
}

/** The view the user has on, with a rendered view that was chosen for
    another file, of a kind that does not carry, read as the diff. */
export function chosenView(): View {
  if (
    files.view === "rendered" &&
    files.renderedFor !== files.selected &&
    !canRender(selectedEntry())
  )
    return "diff";
  return files.view;
}

/**
 * What the viewer actually renders. A view the file does not have falls
 * to the richest one it does rather than showing an empty diff, so
 * widening the scope never lands you on a blank pane: a Markdown file
 * with no diff opens rendered, a changed code file on its diff, anything
 * else as content.
 */
export function effectiveView(): View {
  const entry = selectedEntry();
  const own = views(entry);
  const chosen = chosenView();
  if (own.includes(chosen)) return chosen;
  if (canRender(entry)) return "rendered";
  return own[0];
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
    const content =
      entry.status === "D" ? null : await core().gitContent(root, entry.path);
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

/** The core saw a file the viewer shows change: what shows it reads it
    again. */
export function shownChanged() {
  files.shownReads += 1;
}

/** Puts away whatever other kind the viewer was holding: media, a plugin's
    page, or the browser. Called by whichever kind is taking the viewer, so
    only one is ever showing. */
function leaveOtherKinds() {
  files.media = null;
  files.pluginView = null;
  if (browser.showing) hideBrowser();
}

export async function select(path: string) {
  if (files.target !== null && files.target.path !== path) files.target = null;
  if (files.picked !== null && files.picked.path !== path) files.picked = null;
  leaveOtherKinds();
  if (files.renderedFor !== null && files.renderedFor !== path)
    files.renderedFor = null;
  files.selected = path;
  lend(path);
  await loadSelected();
}

/** Nothing chosen: the tree shows no highlight and the viewer has nothing. */
export function deselect() {
  files.target = null;
  files.picked = null;
  leaveOtherKinds();
  files.renderedFor = null;
  files.lent.clear();
  if (files.selected === null) return;
  files.selected = null;
  files.diff = null;
  files.content = null;
  fileRead += 1;
}

/** The user selected lines of the open file with the mouse, or let the
    selection go with a click in the viewer. */
export function pick(range: { from: number; to: number } | null) {
  if (files.selected === null || range === null) {
    files.picked = null;
    return;
  }
  files.picked = {
    path: files.selected,
    from: Math.min(range.from, range.to),
    to: Math.max(range.from, range.to),
  };
}

/** Shows what the agent presented in the viewer, in place of any file. */
export function showMedia(item: MediaItem) {
  deselect();
  files.media = item;
  enterReview();
}

/** Shows a plugin's page in the viewer, in place of any file. */
export function showPluginView(page: NonNullable<typeof files.pluginView>) {
  deselect();
  files.pluginView = page;
  enterReview();
}

/** Shows the embedded browser in the viewer, in place of any file, media or
    plugin page. */
export function showBrowser() {
  deselect();
  showBrowserView();
  enterReview();
}

/** Shows the browser, opening a tab first when none is open yet: what the
    "⋯" menu's Browser item does. */
export async function openBrowser() {
  if (ownTabs().length === 0) await openBrowserTab();
  showBrowser();
}

/** Opens a new tab and shows the browser on it: what the Browser fold's
    header action does, whatever is open already. */
export async function newBrowserTab() {
  await openBrowserTab();
  showBrowser();
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
  if (
    files.selected !== null &&
    !listed().some((file) => file.path === files.selected)
  ) {
    files.selected = null;
    files.diff = null;
    files.content = null;
    fileRead += 1;
  }
}

export function setView(view: View) {
  files.view = view;
  files.renderedFor = view === "rendered" ? files.selected : null;
}

/** The chord walks the views the file has, round and round. */
export function toggleView() {
  const own = views();
  const at = own.indexOf(effectiveView());
  setView(own[(at + 1) % own.length]);
}

export function toggleScope() {
  return setScope(files.scope === "changed" ? "all" : "changed");
}

/** A folder row of the tree: its path, and the chain of folders it stands
    for when the tree compressed several into it. */
type Folder = { path: string; hasChange: boolean; chain?: string[] };

function members(node: Folder): string[] {
  return node.chain ?? [node.path];
}

export function isOpen(node: Folder): boolean {
  // A narrowed tree is all matches: every folder on the way to one is open,
  // or the match would be hidden by a fold.
  if (filtering()) return true;
  const paths = members(node);
  if (paths.some((path) => files.lent.has(path))) return true;
  if (paths.some((path) => files.collapsed.has(path))) return false;
  if (paths.some((path) => files.expanded.has(path))) return true;
  return node.hasChange;
}

/** Folds or opens a folder as you asked, and keeps that for the project.
    Every folder of a compressed row takes the choice, so it holds when the
    tree later shows them apart. */
export function toggleDir(node: Folder) {
  const next = !isOpen(node);
  for (const path of members(node)) {
    files.lent.delete(path);
    files.expanded.delete(path);
    files.collapsed.delete(path);
    (next ? files.expanded : files.collapsed).add(path);
  }
  saveFolds();
}

function ancestors(path: string): string[] {
  const segments = path.split("/");
  segments.pop();
  const found: string[] = [];
  let prefix = "";
  for (const segment of segments) {
    prefix = prefix === "" ? segment : `${prefix}/${segment}`;
    found.push(prefix);
  }
  return found;
}

/** Shows every folder on the way to the selected file open, without
    changing what is kept, so a selection is never hidden and the folds you
    chose come back once it moves on. */
function lend(path: string) {
  files.lent.clear();
  for (const prefix of ancestors(path)) files.lent.add(prefix);
}

/** Opens every folder on the way to a path and keeps them open: for a file
    or folder you just made or moved there. */
export function reveal(path: string) {
  for (const prefix of ancestors(path)) {
    files.collapsed.delete(prefix);
    files.expanded.delete(prefix);
    files.expanded.add(prefix);
  }
  saveFolds();
}

export function basename(path: string) {
  return lastSegment(path);
}

/** Called when the tree to show changes: none of the old one applies, and
    the folds are the ones kept for the project open now. */
export function clear() {
  treeRead += 1;
  fileRead += 1;
  files.changed = [];
  files.everything = [];
  files.everythingLoaded = false;
  files.selected = null;
  files.renderedFor = null;
  files.diff = null;
  files.content = null;
  files.error = null;
  files.loading = false;
  // Editor mode lists every file; agent mode starts on what changed.
  files.scope = layout.mode === "editing" ? "all" : "changed";
  files.query = "";
  files.mode = "files";
  files.hits = [];
  files.hitsTruncated = false;
  files.searching = false;
  files.target = null;
  files.pluginView = null;
  loadFolds();
}
