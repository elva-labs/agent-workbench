import { core, type ChangedFile } from "$lib/core";
import { FileIndex, type Found } from "$lib/mention";

/**
 * The project's files for the `@` menu of a composer: what changed, what
 * stands at the top, and what a query leaves.
 *
 * The files are read the way the changes pane reads them, from git, so
 * they are the working tree's own, ignored files left out, on this machine
 * or another, in a worktree when the session is in one. They are read once
 * each time the menu opens, never on a keystroke. A query against a few
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
    if (worker !== null) worker.onmessage = (event: MessageEvent<Heard>) => heard(event.data);
  } catch {
    worker = null;
  }
  return worker;
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

/** Reads the files under `root` again: what changed, and every file. */
export async function list(root: string): Promise<void> {
  const read = ++listing;
  if (finder.root !== root) {
    finder.changed = [];
    finder.top = [];
    finder.found = { query: null, paths: [], total: 0 };
  }
  finder.root = root;
  finder.listed = false;
  finder.error = null;
  const changed = core()
    .gitStatus(root)
    .then((files) => {
      if (read === listing) finder.changed = files.filter((file) => file.status !== "D");
    })
    .catch(() => {
      // The listing below says what went wrong.
    });
  try {
    const files = await core().gitFiles(root);
    if (read !== listing) return;
    const away = files.length > AT_ONCE ? thread() : null;
    if (away !== null) {
      local = null;
      away.postMessage({ kind: "list", id: read, files });
    } else {
      local = new FileIndex(files);
      finder.top = local.top();
      finder.listed = true;
      if (wanted !== null) find(wanted);
    }
  } catch (error) {
    if (read === listing) finder.error = String(error);
  }
  await changed;
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

/** Forgets the listing, for tests. */
export function reset() {
  listing += 1;
  asked += 1;
  wanted = null;
  local = null;
  finder.root = null;
  finder.changed = [];
  finder.top = [];
  finder.listed = false;
  finder.error = null;
  finder.found = { query: null, paths: [], total: 0 };
}
