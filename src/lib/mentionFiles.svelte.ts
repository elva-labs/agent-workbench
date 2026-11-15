import { core, type ChangedFile } from "$lib/core";
import { FileIndex, type Found } from "$lib/mention";

/**
 * The project's files for the `@` menu of a composer: what changed, what
 * stands at the top, and what a query leaves.
 *
 * The files are read the way the changes pane reads them, from git, so
 * they are the working tree's own, ignored files left out, on this machine
 * or another, in a worktree when the session is in one. They are read once
 * each time the menu opens, never on a keystroke, and until they are in a
 * query is answered from the listing before. A query against a few
 * thousand files is answered at once; against more it runs in a worker,
 * away from the window's thread, so a repository of tens of thousands of
 * files never holds up typing, and only the best of what it finds comes
 * back. One menu is open at a time, so one listing is kept.
 */

/** The most rows the menu shows of one group. */
export const LIMIT = 50;

/** The most files a query is answered against on the window's thread. */
export const AT_ONCE = 5000;

export const finder = $state({
  /** The folder the listing is of. */
  root: null as string | null,
  /** What changed, with its counts, a deleted file left out. */
  changed: [] as ChangedFile[],
  /** The files and folders at the top. */
  top: [] as string[],
  /** Whether every file has been read. */
  listed: false,
  error: null as string | null,
  /** The answer to the latest query. */
  found: { query: null as string | null, paths: [] as Found[], total: 0 },
});

type Heard =
  | { kind: "listed"; id: number; top: string[] }
  | { kind: "found"; id: number; query: string; found: Found[]; total: number };

let worker: Worker | null | undefined;
/** The listing, when it is kept on the window's thread. */
let local: FileIndex | null = null;
/** Every file of the listing, to tell a path typed whole by, and to index
    here should the worker fail. */
let known = new Set<string>();
let files: string[] = [];
/** The latest listing asked for, and the latest query. */
let listing = 0;
let asked = 0;
/** The query to answer once the listing is in. */
let wanted: string | null = null;

function thread(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker =
      typeof Worker === "undefined"
        ? null
        : new Worker(new URL("./fileFind.worker.ts", import.meta.url), { type: "module" });
    if (worker !== null) {
      worker.onmessage = (event: MessageEvent<Heard>) => heard(event.data);
      worker.onerror = failed;
      worker.onmessageerror = failed;
    }
  } catch {
    worker = null;
  }
  return worker;
}

/** The worker could not load or answer: it is let go, and the listing is
    kept here from then on. */
function failed() {
  worker?.terminate();
  worker = null;
  if (finder.root !== null && local === null) here(files);
}

/** Keeps the listing on the window's thread and answers what waits. */
function here(paths: string[]) {
  local = new FileIndex(paths);
  finder.top = local.top();
  finder.listed = true;
  if (wanted !== null) find(wanted);
}

function heard(said: Heard) {
  if (said.kind === "listed") {
    if (said.id !== listing) return;
    finder.top = said.top;
    finder.listed = true;
    if (wanted !== null) find(wanted);
    return;
  }
  if (said.id !== asked) return;
  finder.found = { query: said.query, paths: said.found, total: said.total };
}

/**
 * Reads the files under `root` again: what changed, and every file. A
 * file git still lists that is deleted from the tree is left out, since
 * there is nothing to read. While the same folder is read again, queries
 * are answered from the listing before.
 */
export async function list(root: string): Promise<void> {
  const read = ++listing;
  if (finder.root !== root) {
    // An answer on its way is for the folder before.
    asked += 1;
    local = null;
    known = new Set();
    files = [];
    finder.changed = [];
    finder.top = [];
    finder.listed = false;
    finder.found = { query: null, paths: [], total: 0 };
  }
  finder.root = root;
  finder.error = null;
  const status = core()
    .gitStatus(root)
    .then((changed) => {
      if (read === listing) finder.changed = changed.filter((file) => file.status !== "D");
      return changed;
    })
    .catch(() => null);
  try {
    const [changed, listed] = await Promise.all([status, core().gitFiles(root)]);
    if (read !== listing) return;
    const gone = new Set((changed ?? []).filter((file) => file.status === "D").map((file) => file.path));
    files = gone.size === 0 ? listed : listed.filter((path) => !gone.has(path));
    known = new Set(files);
    const away = files.length > AT_ONCE ? thread() : null;
    if (away === null) here(files);
    else {
      local = null;
      away.postMessage({ kind: "list", id: read, files });
    }
  } catch (error) {
    if (read === listing) finder.error = String(error);
  }
}

/** Whether a path from the folder listed is a file in the listing. */
export function isListed(path: string): boolean {
  return known.has(path);
}

/** Asks what a query leaves; the answer lands in `finder.found`. */
export function find(query: string) {
  wanted = query;
  if (!finder.listed) return;
  const id = ++asked;
  const changed = finder.changed.map((file) => file.path);
  if (local === null) {
    thread()?.postMessage({ kind: "find", id, query, changed, limit: LIMIT });
    return;
  }
  const result = local.find(query, new Set(changed), LIMIT);
  finder.found = { query, paths: result.found, total: result.total };
}

/** Forgets the listing and the worker, for tests. */
export function reset() {
  worker?.terminate();
  worker = undefined;
  listing += 1;
  asked += 1;
  wanted = null;
  local = null;
  known = new Set();
  files = [];
  finder.root = null;
  finder.changed = [];
  finder.top = [];
  finder.listed = false;
  finder.error = null;
  finder.found = { query: null, paths: [], total: 0 };
}
