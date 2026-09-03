import type { FileEntry } from "$lib/files.svelte";

/**
 * Turns a flat list of paths into a folder tree.
 *
 * Pure on purpose: the shape of a tree over a few hundred paths is the part
 * worth testing, and it needs no DOM to check. Phase 2 hands this the real
 * `git status` and `git ls-files` output and nothing here changes.
 */

export interface TreeNode {
  /** Display name. Carries a slash when a chain of folders was compressed. */
  name: string;
  /** Full path from the repository root. Unique, so it doubles as the key. */
  path: string;
  dir: boolean;
  children: TreeNode[];
  /** Files only. */
  entry?: FileEntry;
  /** True if this file changed, or if any file beneath this folder did. */
  hasChange: boolean;
}

export interface Row {
  node: TreeNode;
  depth: number;
}

function emptyDir(name: string, path: string): TreeNode {
  return { name, path, dir: true, children: [], hasChange: false };
}

/** Folders before files, then alphabetical. The order a file tree is read in. */
function sortNodes(nodes: TreeNode[]) {
  nodes.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) if (node.dir) sortNodes(node.children);
}

function markChanges(node: TreeNode): boolean {
  if (!node.dir) {
    node.hasChange = node.entry?.status != null;
    return node.hasChange;
  }
  node.hasChange = node.children.map(markChanges).some(Boolean);
  return node.hasChange;
}

/**
 * Collapses a chain of folders with a single folder inside into one row, so a
 * path like src/lib/components reads as one line rather than three that each
 * carry no information. The same thing VS Code and GitHub do.
 */
function compress(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (!node.dir) return node;
    let current = node;
    while (current.children.length === 1 && current.children[0].dir) {
      const only = current.children[0];
      current = {
        ...current,
        name: `${current.name}/${only.name}`,
        path: only.path,
        children: only.children,
      };
    }
    return { ...current, children: compress(current.children) };
  });
}

export function buildTree(entries: FileEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const dirs = new Map<string, TreeNode>();

  for (const entry of entries) {
    const segments = entry.path.split("/");
    const filename = segments.pop()!;

    let siblings = roots;
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      let dir = dirs.get(prefix);
      if (!dir) {
        dir = emptyDir(segment, prefix);
        dirs.set(prefix, dir);
        siblings.push(dir);
      }
      siblings = dir.children;
    }

    siblings.push({
      name: filename,
      path: entry.path,
      dir: false,
      children: [],
      entry,
      hasChange: entry.status != null,
    });
  }

  sortNodes(roots);
  for (const root of roots) markChanges(root);
  return compress(roots);
}

/** The rows actually on screen, in order, given which folders are open. */
export function flatten(
  nodes: TreeNode[],
  isOpen: (node: TreeNode) => boolean,
  depth = 0,
): Row[] {
  const rows: Row[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.dir && isOpen(node)) rows.push(...flatten(node.children, isOpen, depth + 1));
  }
  return rows;
}

/** The folder a path sits in, or null at the top level. */
export function parentOf(path: string): string | null {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? null : path.slice(0, cut);
}
