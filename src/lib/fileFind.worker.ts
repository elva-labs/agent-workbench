import { FileIndex } from "./mention";

/**
 * Finds a project's files for the `@` menu away from the window's own
 * thread, so a repository of tens of thousands of files never holds up a
 * keystroke. It keeps the latest listing it was given and answers each
 * query against it.
 */

let index: FileIndex | null = null;

export type Ask =
  | { kind: "list"; id: number; files: string[] }
  | { kind: "find"; id: number; query: string; changed: string[]; limit: number };

self.onmessage = (event: MessageEvent<Ask>) => {
  const ask = event.data;
  if (ask.kind === "list") {
    index = new FileIndex(ask.files);
    self.postMessage({ kind: "listed", id: ask.id, top: index.top() });
    return;
  }
  const result = index?.find(ask.query, new Set(ask.changed), ask.limit) ?? { found: [], total: 0 };
  self.postMessage({ kind: "found", id: ask.id, query: ask.query, ...result });
};
