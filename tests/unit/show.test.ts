import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  projectFor,
  referenced,
  relativeTo,
  resetHeld,
  diffRequested,
  showRequested,
  switched,
  terminalRequested,
  within,
} from "$lib/show.svelte";
import {
  create,
  located,
  reset as resetSessions,
  select,
  started,
} from "$lib/sessions.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

const shown: unknown[][] = [];
const diffed: unknown[][] = [];
const shells: unknown[][] = [];
vi.mock("$lib/files.svelte", () => ({
  showRange: async (...args: unknown[]) => {
    shown.push(args);
  },
  showDiff: async (...args: unknown[]) => {
    diffed.push(args);
  },
}));
vi.mock(import("$lib/terminals.svelte"), async (importOriginal) => ({
  ...(await importOriginal()),
  create: (...args: unknown[]) => {
    shells.push(args);
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
  shells.length = 0;
  resetHeld();
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

// What an agent asks to open is for its own session: held while the user
// looks at another, opened when they switch to it.
describe("a call from a session the user is not looking at", () => {
  const place = (session: string, path = "/one/src/a.rs") => ({
    path,
    from: 3,
    to: 5,
    note: "Here.",
    cwd: "/one",
    session,
  });

  it("opens at once from the session on screen", async () => {
    workspace.open.push(repo("/one"));
    workspace.active = "/one";
    const a = create("/one");
    started(a.key, "pty-1", "s1");
    await showRequested(place("s1"));
    expect(shown).toEqual([["src/a.rs", 3, 5, "Here."]]);
  });

  it("holds a show until the user switches to the session", async () => {
    workspace.open.push(repo("/one"));
    workspace.active = "/one";
    const a = create("/one");
    started(a.key, "pty-1", "s1");
    const b = create("/one");
    started(b.key, "pty-2", "s2");
    await showRequested(place("s1"));
    expect(shown).toEqual([]);
    select(a.key);
    switched(a.key);
    await Promise.resolve();
    expect(shown).toEqual([["src/a.rs", 3, 5, "Here."]]);
    // Opened once: switching again opens nothing more.
    switched(a.key);
    await Promise.resolve();
    expect(shown).toHaveLength(1);
  });

  it("keeps only the latest call, of whichever kind", async () => {
    workspace.open.push(repo("/one"));
    workspace.active = "/one";
    const a = create("/one");
    started(a.key, "pty-1", "s1");
    const b = create("/one");
    started(b.key, "pty-2", "s2");
    await showRequested(place("s1"));
    await diffRequested({
      path: "/one/src/b.rs",
      note: "The rename.",
      cwd: "/one",
      session: "s1",
    });
    select(a.key);
    switched(a.key);
    await Promise.resolve();
    expect(shown).toEqual([]);
    expect(diffed).toEqual([["src/b.rs", "The rename."]]);
  });

  it("holds a terminal the same way, and brings the project forward with it", async () => {
    workspace.open.push(repo("/one"), repo("/two"));
    workspace.active = "/one";
    const a = create("/one");
    started(a.key, "pty-1", "s1");
    workspace.active = "/two";
    const b = create("/two");
    started(b.key, "pty-2", "s2");
    terminalRequested({ command: "npm run dev", cwd: "/one", session: "s1" });
    expect(shells).toEqual([]);
    expect(workspace.active).toBe("/two");
    select(a.key);
    switched(a.key);
    expect(shells).toEqual([["/one", "npm run dev"]]);
    expect(workspace.active).toBe("/one");
  });

  it("holds a call from a session known only by where it runs", async () => {
    workspace.open.push(repo("/one"));
    workspace.active = "/one";
    const a = create("/one");
    started(a.key, "pty-1", "s1");
    await located(a.key, "/one/.claude/worktrees/w");
    const b = create("/one");
    started(b.key, "pty-2", "s2");
    await showRequested({
      ...place("unknown", "/one/.claude/worktrees/w/src/a.rs"),
      cwd: "/one/.claude/worktrees/w",
    });
    expect(shown).toEqual([]);
    select(a.key);
    switched(a.key);
    await Promise.resolve();
    expect(shown).toHaveLength(1);
  });

  it("opens at once from no session the window knows", async () => {
    workspace.open.push(repo("/one"), repo("/two"));
    workspace.active = "/two";
    const b = create("/two");
    started(b.key, "pty-2", "s2");
    await showRequested(place("s9"));
    expect(shown).toEqual([["src/a.rs", 3, 5, "Here."]]);
    expect(workspace.active).toBe("/one");
  });

  it("drops what a closed session held", async () => {
    workspace.open.push(repo("/one"));
    workspace.active = "/one";
    const a = create("/one");
    started(a.key, "pty-1", "s1");
    const b = create("/one");
    started(b.key, "pty-2", "s2");
    await showRequested(place("s1"));
    resetSessions();
    switched(a.key);
    await Promise.resolve();
    expect(shown).toEqual([]);
  });

  // A reference the user clicks is theirs, not the agent's: it opens now.
  it("opens a clicked reference at once whichever session it is in", async () => {
    workspace.open.push(repo("/one"));
    workspace.active = "/one";
    const a = create("/one");
    started(a.key, "pty-1", "s1");
    const b = create("/one");
    started(b.key, "pty-2", "s2");
    referenced(a.key, "src/b.rs", 12);
    await Promise.resolve();
    expect(shown).toEqual([["src/b.rs", 12, 12, null]]);
  });
});
