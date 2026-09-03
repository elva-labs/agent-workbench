import { beforeEach, describe, expect, it } from "vitest";
import {
  basename,
  canDiff,
  changedCount,
  effectiveView,
  files,
  listed,
  select,
  selectedEntry,
  setScope,
  setView,
  toggleScope,
  toggleView,
} from "$lib/files.svelte";

beforeEach(() => {
  files.scope = "changed";
  files.view = "diff";
  files.selected = null;
});

describe("scope", () => {
  it("lists only changed files by default", () => {
    expect(listed()).toHaveLength(changedCount());
    expect(listed().every((f) => f.status !== null)).toBe(true);
  });

  it("adds unchanged files in the all-files scope", () => {
    setScope("all");
    expect(listed().length).toBeGreaterThan(changedCount());
    expect(listed().some((f) => f.status === null)).toBe(true);
  });

  it("keeps the changed files listed first when the scope widens", () => {
    setScope("all");
    expect(listed().slice(0, changedCount()).every((f) => f.status !== null)).toBe(true);
  });

  it("toggles between the two", () => {
    toggleScope();
    expect(files.scope).toBe("all");
    toggleScope();
    expect(files.scope).toBe("changed");
  });

  it("drops a selection that narrowing the scope removes from the list", () => {
    setScope("all");
    select("Cargo.toml");
    setScope("changed");
    expect(files.selected).toBeNull();
  });

  it("keeps a selection that survives the narrowing", () => {
    setScope("all");
    select("src/lib.rs");
    setScope("changed");
    expect(files.selected).toBe("src/lib.rs");
  });
});

describe("canDiff", () => {
  it("is true for a changed text file", () => {
    select("src/cache/mod.rs");
    expect(canDiff(selectedEntry())).toBe(true);
  });

  it("is false for an unchanged file", () => {
    setScope("all");
    select("Cargo.toml");
    expect(canDiff(selectedEntry())).toBe(false);
  });

  it("is false for a binary file", () => {
    setScope("all");
    select("assets/icon.png");
    expect(canDiff(selectedEntry())).toBe(false);
  });

  it("is false with nothing selected", () => {
    expect(canDiff(null)).toBe(false);
  });
});

describe("effectiveView", () => {
  it("defaults to the diff for a changed file", () => {
    select("src/cache/mod.rs");
    expect(effectiveView()).toBe("diff");
  });

  it("shows content when asked", () => {
    select("src/cache/mod.rs");
    setView("content");
    expect(effectiveView()).toBe("content");
  });

  // Widening the scope must never land you on an empty pane.
  it("falls back to content for a file with no diff", () => {
    setScope("all");
    select("Cargo.toml");
    expect(files.view).toBe("diff");
    expect(effectiveView()).toBe("content");
  });

  it("restores the diff when you pick a changed file again", () => {
    setScope("all");
    select("Cargo.toml");
    expect(effectiveView()).toBe("content");
    select("src/lib.rs");
    expect(effectiveView()).toBe("diff");
  });

  it("toggles", () => {
    select("src/lib.rs");
    toggleView();
    expect(effectiveView()).toBe("content");
    toggleView();
    expect(effectiveView()).toBe("diff");
  });
});

describe("selectedEntry", () => {
  it("is null with nothing selected", () => {
    expect(selectedEntry()).toBeNull();
  });

  it("is null when the selection is not in the current list", () => {
    files.selected = "nope/missing.rs";
    expect(selectedEntry()).toBeNull();
  });

  it("carries the diff and the content", () => {
    select("src/cache/mod.rs");
    const entry = selectedEntry()!;
    expect(entry.diff!.length).toBeGreaterThan(0);
    expect(entry.content!.length).toBeGreaterThan(0);
  });

  it("has a diff but no content for a deleted file", () => {
    select("src/token_cache.rs");
    const entry = selectedEntry()!;
    expect(entry.diff!.every((l) => l.kind === "del" || l.kind === "hunk")).toBe(true);
    expect(entry.content).toBeUndefined();
  });
});

describe("basename", () => {
  it("takes the last segment", () => {
    expect(basename("src/cache/mod.rs")).toBe("mod.rs");
  });

  it("leaves a bare filename alone", () => {
    expect(basename("Cargo.toml")).toBe("Cargo.toml");
  });
});
