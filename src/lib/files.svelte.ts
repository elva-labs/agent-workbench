/**
 * The file list and what the viewer is showing.
 *
 * Two controls, and they are connected, which is why they share a head:
 *
 *   scope — which files are listed. Changed is git status; all files is
 *           git ls-files plus untracked, honouring .gitignore. A second data
 *           source, not a filter over the first.
 *   view  — how the selected file is shown. Diff or content.
 *
 * The connection: a file with no changes has no diff to show, so widening the
 * scope is exactly what puts files in the list that can only be read as
 * content. The viewer resolves that itself rather than making you notice.
 *
 * Phase 2 replaces the sample entries with git2 status from the core, and the
 * rendering with @codemirror/merge for a diff and a read-only EditorView for
 * content. The shape here is what those will fill.
 */

export type Status = "M" | "A" | "D" | "R";
export type Scope = "changed" | "all";
export type View = "diff" | "content";

export interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx";
  text: string;
  /** Line number in the old file, absent for additions. */
  old?: number;
  /** Line number in the new file, absent for deletions. */
  new?: number;
}

export interface FileEntry {
  path: string;
  /** null means unchanged: listed only in the all-files scope. */
  status: Status | null;
  add?: number;
  del?: number;
  binary?: boolean;
  diff?: DiffLine[];
  content?: string[];
}

const CHANGED: FileEntry[] = [
  {
    path: "src/cache/mod.rs",
    status: "M",
    add: 18,
    del: 6,
    diff: [
      { kind: "hunk", text: "@@ -1,9 +1,12 @@" },
      { kind: "ctx", text: "use std::collections::HashMap;", old: 1, new: 1 },
      { kind: "ctx", text: "use std::time::Instant;", old: 2, new: 2 },
      { kind: "ctx", text: "", old: 3, new: 3 },
      { kind: "del", text: "pub struct TokenCache {", old: 4 },
      { kind: "add", text: "/// Entries expire on read, not on a timer.", new: 4 },
      { kind: "add", text: "pub struct Cache {", new: 5 },
      { kind: "ctx", text: "    entries: HashMap<String, Entry>,", old: 5, new: 6 },
      { kind: "add", text: "    ttl: Duration,", new: 7 },
      { kind: "ctx", text: "}", old: 6, new: 8 },
      { kind: "ctx", text: "", old: 7, new: 9 },
      { kind: "del", text: "impl TokenCache {", old: 8 },
      { kind: "add", text: "impl Cache {", new: 10 },
      { kind: "ctx", text: "    pub fn new() -> Self {", old: 9, new: 11 },
    ],
    content: [
      "use std::collections::HashMap;",
      "use std::time::Instant;",
      "",
      "/// Entries expire on read, not on a timer.",
      "pub struct Cache {",
      "    entries: HashMap<String, Entry>,",
      "    ttl: Duration,",
      "}",
    ],
  },
  {
    path: "src/lib.rs",
    status: "M",
    add: 2,
    del: 2,
    diff: [
      { kind: "hunk", text: "@@ -3,7 +3,7 @@" },
      { kind: "ctx", text: "mod adapter;", old: 3, new: 3 },
      { kind: "del", text: "mod token_cache;", old: 4 },
      { kind: "add", text: "mod cache;", new: 4 },
      { kind: "ctx", text: "mod pty;", old: 5, new: 5 },
      { kind: "ctx", text: "", old: 6, new: 6 },
      { kind: "del", text: "pub use token_cache::TokenCache;", old: 7 },
      { kind: "add", text: "pub use cache::Cache;", new: 7 },
    ],
    content: ["mod adapter;", "mod cache;", "mod pty;", "", "pub use cache::Cache;"],
  },
  {
    path: "src/token_cache.rs",
    status: "D",
    del: 41,
    diff: [
      { kind: "hunk", text: "@@ -1,4 +0,0 @@" },
      { kind: "del", text: "use std::collections::HashMap;", old: 1 },
      { kind: "del", text: "", old: 2 },
      { kind: "del", text: "pub struct TokenCache {", old: 3 },
      { kind: "del", text: "    entries: HashMap<String, Entry>,", old: 4 },
    ],
  },
];

const UNCHANGED: FileEntry[] = [
  {
    path: "Cargo.toml",
    status: null,
    content: [
      "[package]",
      'name = "agent-workbench"',
      'version = "0.1.0"',
      'edition = "2021"',
      "",
      "[dependencies]",
      'tauri = { version = "2", features = [] }',
      'portable-pty = "0.8"',
    ],
  },
  {
    path: "src/main.rs",
    status: null,
    content: [
      '#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]',
      "",
      "fn main() {",
      "    agent_workbench_lib::run()",
      "}",
    ],
  },
  {
    path: "src/cache/store.rs",
    status: null,
    content: ["pub(crate) struct Entry {", "    value: String,", "    seen: Instant,", "}"],
  },
  { path: "assets/icon.png", status: null, binary: true },
];

export const files = $state({
  scope: "changed" as Scope,
  view: "diff" as View,
  selected: null as string | null,
});

export function listed(): FileEntry[] {
  return files.scope === "changed" ? CHANGED : [...CHANGED, ...UNCHANGED];
}

export function changedCount() {
  return CHANGED.length;
}

export function selectedEntry(): FileEntry | null {
  if (files.selected === null) return null;
  return listed().find((f) => f.path === files.selected) ?? null;
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

export function select(path: string) {
  files.selected = path;
}

export function setScope(scope: Scope) {
  files.scope = scope;
  // Narrowing the scope can drop the open file out of the list.
  if (files.selected !== null && !listed().some((f) => f.path === files.selected)) {
    files.selected = null;
  }
}

export function setView(view: View) {
  files.view = view;
}

export function toggleView() {
  setView(files.view === "diff" ? "content" : "diff");
}

export function toggleScope() {
  setScope(files.scope === "changed" ? "all" : "changed");
}

export function basename(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}
