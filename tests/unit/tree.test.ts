import { describe, expect, it } from "vitest";
import { buildTree, flatten, parentOf } from "$lib/tree";
import type { FileEntry } from "$lib/files.svelte";

const file = (path: string, status: FileEntry["status"] = null): FileEntry => ({ path, status });

const openAll = () => true;
const closeAll = () => false;
const names = (rows: { node: { name: string } }[]) => rows.map((r) => r.node.name);

describe("buildTree", () => {
  it("nests files under their folders", () => {
    const tree = buildTree([file("src/cache/mod.rs"), file("src/lib.rs")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("src");
    expect(names(flatten(tree, openAll))).toEqual(["src", "cache", "mod.rs", "lib.rs"]);
  });

  it("puts folders before files, then sorts alphabetically", () => {
    const tree = buildTree([
      file("zeta.txt"),
      file("alpha.txt"),
      file("beta/one.txt"),
      file("alpha/two.txt"),
    ]);
    expect(names(flatten(tree, closeAll))).toEqual(["alpha", "beta", "alpha.txt", "zeta.txt"]);
  });

  it("gives every node a unique path, so it can be keyed", () => {
    const tree = buildTree([file("a/mod.rs"), file("b/mod.rs")]);
    const paths = flatten(tree, openAll).map((r) => r.node.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("reports depth so rows can be indented", () => {
    const rows = flatten(buildTree([file("src/cache/mod.rs"), file("src/lib.rs")]), openAll);
    expect(names(rows)).toEqual(["src", "cache", "mod.rs", "lib.rs"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 1]);
  });

  it("carries the entry on file nodes and nothing on folders", () => {
    const entry = file("src/lib.rs", "M");
    const rows = flatten(buildTree([entry]), openAll);
    expect(rows[0].node.entry).toBeUndefined();
    expect(rows[1].node.entry).toBe(entry);
  });
});

describe("path compression", () => {
  // Three rows that each carry no information collapse into one.
  it("folds a chain of single-child folders into one row", () => {
    const tree = buildTree([file("src/lib/components/Pane.svelte")]);
    expect(names(flatten(tree, openAll))).toEqual(["src/lib/components", "Pane.svelte"]);
  });

  it("keeps the deepest path, so a parent lookup still resolves", () => {
    const tree = buildTree([file("src/lib/components/Pane.svelte")]);
    expect(tree[0].path).toBe("src/lib/components");
    expect(parentOf("src/lib/components/Pane.svelte")).toBe("src/lib/components");
  });

  it("stops folding where the tree actually branches", () => {
    const tree = buildTree([file("src/lib/a/one.ts"), file("src/lib/b/two.ts")]);
    expect(names(flatten(tree, openAll))).toEqual(["src/lib", "a", "one.ts", "b", "two.ts"]);
  });

  it("does not fold a folder that holds a file", () => {
    const tree = buildTree([file("src/lib.rs")]);
    expect(names(flatten(tree, openAll))).toEqual(["src", "lib.rs"]);
  });
});

describe("hasChange", () => {
  it("marks a folder when anything beneath it changed", () => {
    const tree = buildTree([file("src/deep/changed.rs", "M"), file("docs/quiet.md")]);
    const rows = flatten(tree, openAll);
    const byName = Object.fromEntries(rows.map((r) => [r.node.name, r.node.hasChange]));
    expect(byName["src/deep"]).toBe(true);
    expect(byName["changed.rs"]).toBe(true);
    expect(byName["docs"]).toBe(false);
    expect(byName["quiet.md"]).toBe(false);
  });

  it("propagates up through several levels", () => {
    const tree = buildTree([file("a/b/c/changed.rs", "A"), file("a/quiet.md")]);
    expect(tree[0].name).toBe("a");
    expect(tree[0].hasChange).toBe(true);
  });
});

describe("flatten", () => {
  it("hides everything under a closed folder", () => {
    const tree = buildTree([file("src/cache/mod.rs"), file("top.txt")]);
    // src holds only cache, so the two fold into one row before anything opens.
    expect(names(flatten(tree, closeAll))).toEqual(["src/cache", "top.txt"]);
  });

  it("shows only the folders that are open", () => {
    const tree = buildTree([file("src/cache/mod.rs"), file("src/lib.rs")]);
    const openSrc = (node: { path: string }) => node.path === "src";
    expect(names(flatten(tree, openSrc))).toEqual(["src", "cache", "lib.rs"]);
  });

  it("returns rows in the order they are read down the screen", () => {
    const tree = buildTree([file("b/two.txt"), file("a/one.txt"), file("z.txt")]);
    expect(names(flatten(tree, openAll))).toEqual(["a", "one.txt", "b", "two.txt", "z.txt"]);
  });

  it("copes with a few hundred paths", () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      file(`src/mod${i % 20}/file${i}.rs`, i % 50 === 0 ? "M" : null),
    );
    const rows = flatten(buildTree(many), openAll);
    expect(rows.filter((r) => !r.node.dir)).toHaveLength(400);
    expect(rows.filter((r) => r.node.dir)).toHaveLength(21);
  });
});

describe("parentOf", () => {
  it("drops the last segment", () => {
    expect(parentOf("src/cache/mod.rs")).toBe("src/cache");
  });

  it("is null at the top level", () => {
    expect(parentOf("Cargo.toml")).toBeNull();
  });
});
