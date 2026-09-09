import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  projectFor,
  referenced,
  relativeTo,
  diffRequested,
  showRequested,
  within,
} from "$lib/show.svelte";
import {
  create,
  located,
  reset as resetSessions,
  started,
} from "$lib/sessions.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

const shown: unknown[][] = [];
const diffed: unknown[][] = [];
vi.mock("$lib/files.svelte", () => ({
  showRange: async (...args: unknown[]) => {
    shown.push(args);
  },
  showDiff: async (...args: unknown[]) => {
    diffed.push(args);
  },
}));
vi.mock("$lib/core", () => ({
  core: () => ({
    async setWindowTitle() {},
    async projectInfo(path: string) {
      return { path, name: path, repository: path, isGit: true };
    },
    async ptyCwd() {
      return null;
    },
  }),
}));

const repo = (path: string) => ({
  path,
  name: path.split("/").pop()!,
  repository: path,
  isGit: true,
});

beforeEach(() => {
  shown.length = 0;
  diffed.length = 0;
  resetWorkspace();
  resetSessions();
});

describe("where a place is", () => {
  it("knows what is under a root, on either separator", () => {
    expect(within("/a/b/c.rs", "/a/b")).toBe(true);
    expect(within("/a/b", "/a/b")).toBe(true);
    expect(within("/a/bc/d.rs", "/a/b")).toBe(false);
    expect(within("C:\\p\\x.ts", "C:\\p")).toBe(true);
    expect(relativeTo("/a/b/src/c.rs", "/a/b/")).toBe("src/c.rs");
    expect(relativeTo("C:\\p\\src\\x.ts", "C:\\p")).toBe("src/x.ts");
    expect(relativeTo("/elsewhere/c.rs", "/a/b")).toBeNull();
  });

  it("picks the deepest open project the request is under", () => {
    workspace.open.push(
      repo("/home/ada/dev"),
      repo("/home/ada/dev/demo"),
      repo("/other"),
    );
    const request = {
      path: "/home/ada/dev/demo/src/a.rs",
      from: 1,
      to: 1,
      note: null,
      cwd: "/home/ada/dev/demo",
      session: null,
    };
    expect(projectFor(request)).toBe("/home/ada/dev/demo");
    expect(
      projectFor({ ...request, path: "/nowhere/a.rs", cwd: "/nowhere" }),
    ).toBeNull();
  });
});

describe("showing a place", () => {
  it("brings the project forward and opens the file relative to it", async () => {
    workspace.open.push(repo("/one"), repo("/two"));
    workspace.active = "/one";
    await showRequested({
      path: "/two/src/a.rs",
      from: 3,
      to: 5,
      note: "Here.",
      cwd: "/two",
      session: null,
    });
    expect(workspace.active).toBe("/two");
    expect(shown).toEqual([["src/a.rs", 3, 5, "Here."]]);
  });

  it("opens a diff the same way, relative to the project", async () => {
    workspace.open.push(repo("/one"), repo("/two"));
    workspace.active = "/one";
    await diffRequested({
      path: "/two/src/a.rs",
      note: "The rename.",
      cwd: "/two",
      session: null,
    });
    expect(workspace.active).toBe("/two");
    expect(diffed).toEqual([["src/a.rs", "The rename."]]);
    await diffRequested({
      path: "/elsewhere/a.rs",
      note: null,
      cwd: "/elsewhere",
      session: null,
    });
    expect(diffed).toHaveLength(1);
  });

  it("does nothing for a file outside every open project", async () => {
    workspace.open.push(repo("/one"));
    await showRequested({
      path: "/elsewhere/a.rs",
      from: 1,
      to: 1,
      note: null,
      cwd: "/elsewhere",
      session: null,
    });
    expect(shown).toEqual([]);
  });

  // A reference in the output is relative to where the agent runs.
  it("takes a clicked reference against the session's directory", async () => {
    workspace.open.push(repo("/one"));
    workspace.active = "/one";
    const session = create("/one");
    started(session.key, "pty-1", "s1");
    referenced(session.key, "src/b.rs", 12);
    await Promise.resolve();
    expect(shown).toEqual([["src/b.rs", 12, 12, null]]);
  });
});
