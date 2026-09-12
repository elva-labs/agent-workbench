import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Worktree } from "$lib/core";
import {
  cleanWorktrees,
  conductors,
  foldLabel,
  groupsFor,
  isAsking,
  isConductor,
  leftBehind,
  load,
  orchestrator,
  ownFor,
  readWorktrees,
  removable,
  summary,
  summaryLine,
  type LeftTree,
} from "$lib/orchestrator.svelte";
import { conductor, resetConductor } from "$lib/conductor.svelte";
import {
  create,
  reset as resetSessions,
  started,
  type Session,
} from "$lib/sessions.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

const DIR = "/home/ada/.agent-workbench/orchestrator";
const A = "/home/ada/dev/one";
const B = "/home/ada/dev/two";

/** Where the core says an orchestrator runs, what worktrees each project
    has, and what a test asked to be removed. */
const fake = {
  dir: DIR as string | null,
  trees: {} as Record<string, Worktree[]>,
  removed: [] as string[],
};

vi.mock("$lib/core", () => ({
  core: () => ({
    async orchestratorDir() {
      if (fake.dir === null) throw new Error("no core");
      return fake.dir;
    },
    async worktrees(project: string) {
      const trees = fake.trees[project];
      if (trees === undefined) throw new Error("not a repository");
      return trees;
    },
    // The core parts with a tree that has nothing in it and nothing of its
    // own, and refuses the rest.
    async worktreeRemove(project: string, name: string) {
      const trees = fake.trees[project] ?? [];
      const tree = trees.find((candidate) => candidate.name === name);
      if (tree === undefined || tree.dirty || !tree.merged)
        throw new Error(`${name} has work in it`);
      fake.removed.push(name);
      fake.trees[project] = trees.filter(
        (candidate) => candidate.name !== name,
      );
    },
  }),
}));

/** A worktree under a project, as the core answers with one. */
function tree(
  project: string,
  name: string,
  state: { merged?: boolean; dirty?: boolean } = {},
): Worktree {
  return {
    path: `${project}/.worktrees/${name}`,
    name,
    branch: name,
    merged: state.merged ?? true,
    dirty: state.dirty ?? false,
  };
}

const names = (trees: LeftTree[]) => trees.map((found) => found.name);

const repo = (path: string) => ({
  path,
  name: path.split("/").pop()!,
  repository: path,
  isGit: true,
});

/** A session that has actually come up, as one does in practice. */
function live(project: string, ptyId: string, id: string): Session {
  const session = create(project, null, "claude-code", null);
  started(session.key, ptyId, id);
  return session;
}

/** A session one orchestrator started in a project. */
function startedIn(
  project: string,
  by: Session,
  ptyId: string,
  id: string,
): Session {
  const session = live(project, ptyId, id);
  conductor.startedBy[session.key] = by.id ?? by.key;
  return session;
}

const keys = (list: Session[]) => list.map((session) => session.key);

beforeEach(() => {
  resetSessions();
  resetConductor();
  resetWorkspace();
  fake.dir = DIR;
  fake.trees = {};
  fake.removed = [];
  leftBehind.trees = [];
  leftBehind.loading = false;
  orchestrator.dir = DIR;
});

describe("the orchestrator's own project", () => {
  it("is where the core says, and nowhere when the core cannot say", async () => {
    orchestrator.dir = null;
    await load();
    expect(orchestrator.dir).toBe(DIR);

    fake.dir = null;
    await load();
    expect(orchestrator.dir).toBeNull();
  });

  it("holds the sessions that run in it, and no others", () => {
    const one = live(DIR, "pty-1", "sid-1");
    const mine = live(A, "pty-2", "sid-2");
    expect(isConductor(one)).toBe(true);
    expect(isConductor(mine)).toBe(false);
    expect(keys(conductors())).toEqual([one.key]);

    // With nowhere for one to run, there are none.
    orchestrator.dir = null;
    expect(isConductor(one)).toBe(false);
    expect(conductors()).toEqual([]);
  });
});

describe("a project's sessions", () => {
  it("keeps the started ones out of the project's own, in a fold apiece", () => {
    const one = live(DIR, "pty-1", "sid-1");
    one.title = "Retry rollout";
    const two = live(DIR, "pty-2", "sid-2");
    two.title = "Cache keys";
    const mine = live(A, "pty-3", "sid-3");
    const first = startedIn(A, one, "pty-4", "sid-4");
    const second = startedIn(A, two, "pty-5", "sid-5");
    const third = startedIn(A, one, "pty-6", "sid-6");
    startedIn(B, one, "pty-7", "sid-7");

    expect(keys(ownFor(A))).toEqual([mine.key]);
    const groups = groupsFor(A);
    expect(groups.map((group) => group.id)).toEqual(["sid-1", "sid-2"]);
    expect(keys(groups[0].sessions)).toEqual([first.key, third.key]);
    expect(keys(groups[1].sessions)).toEqual([second.key]);
    expect(foldLabel(groups[0])).toBe("2 started by Retry rollout");
    expect(foldLabel(groups[1])).toBe("1 started by Cache keys");
    // The other project's fold is its own, and holds only what was started
    // there.
    expect(groupsFor(B)).toHaveLength(1);
    expect(groupsFor(B)[0].sessions).toHaveLength(1);
  });

  it("has no folds where nothing was started", () => {
    live(A, "pty-1", "sid-1");
    expect(groupsFor(A)).toEqual([]);
    expect(ownFor(A)).toHaveLength(1);
  });

  it("names an orchestrator the window no longer has", () => {
    const session = live(A, "pty-1", "sid-1");
    conductor.startedBy[session.key] = "sid-gone";
    expect(foldLabel(groupsFor(A)[0])).toBe("1 started by an orchestrator");
  });
});

describe("what an orchestrator has out", () => {
  it("counts what is running and what is waiting on you", () => {
    const one = live(DIR, "pty-1", "sid-1");
    expect(summary(one)).toEqual({ running: 0, asking: 0 });
    expect(summaryLine(one)).toBeNull();

    const here = startedIn(A, one, "pty-2", "sid-2");
    const there = startedIn(B, one, "pty-3", "sid-3");
    expect(summary(one)).toEqual({ running: 2, asking: 0 });
    expect(summaryLine(one)).toBe("2 running");

    // Asking for permission is waiting on you, and so is a line left
    // behind while nobody was looking.
    there.needs = "permission";
    expect(isAsking(there)).toBe(true);
    expect(summaryLine(one)).toBe("2 running, 1 asking");
    here.unread = true;
    expect(summaryLine(one)).toBe("2 running, 2 asking");
    expect(groupsFor(A)[0].asking).toBe(1);
    expect(groupsFor(B)[0].asking).toBe(1);

    // A session that has stopped is neither running nor waiting, whatever
    // it was doing when it went.
    here.status = "exited";
    expect(isAsking(here)).toBe(false);
    expect(summaryLine(one)).toBe("1 running, 1 asking");
    expect(groupsFor(A)[0].asking).toBe(0);
  });

  it("counts only what the orchestrator itself started", () => {
    const one = live(DIR, "pty-1", "sid-1");
    const two = live(DIR, "pty-2", "sid-2");
    startedIn(A, one, "pty-3", "sid-3");
    startedIn(A, two, "pty-4", "sid-4");
    startedIn(A, two, "pty-5", "sid-5");
    expect(summaryLine(one)).toBe("1 running");
    expect(summaryLine(two)).toBe("2 running");
  });
});

describe("the worktrees the starts left behind", () => {
  it("keeps the ones that can go", () => {
    const trees: LeftTree[] = [
      { ...tree(A, "clean"), project: A },
      { ...tree(A, "working", { dirty: true }), project: A },
      { ...tree(A, "ahead", { merged: false }), project: A },
    ];
    expect(names(removable(trees))).toEqual(["clean"]);
    expect(removable([])).toEqual([]);
  });

  it("reads every open project and leaves out the trees in use", async () => {
    workspace.open.push(repo(A), repo(B));
    fake.trees[A] = [tree(A, "one"), tree(A, "two")];
    fake.trees[B] = [tree(B, "three")];
    // A session running in one of them is a tree that is not left behind.
    create(A, null, "claude-code", `${A}/.worktrees/one`);

    await readWorktrees();

    expect(names(leftBehind.trees)).toEqual(["two", "three"]);
    expect(leftBehind.trees[0].project).toBe(A);
    expect(leftBehind.trees[1].project).toBe(B);
    expect(leftBehind.loading).toBe(false);

    // A session that has ended holds nothing: its tree is left behind.
    const gone = create(A, null, "claude-code", `${A}/.worktrees/two`);
    gone.status = "exited";
    await readWorktrees();
    expect(names(leftBehind.trees)).toEqual(["two", "three"]);
  });

  it("passes over a project the core cannot answer for", async () => {
    workspace.open.push(repo(A), repo(B));
    fake.trees[B] = [tree(B, "three")];
    await readWorktrees();
    expect(names(leftBehind.trees)).toEqual(["three"]);
  });

  it("removes what can go and reads what is left", async () => {
    workspace.open.push(repo(A));
    fake.trees[A] = [
      tree(A, "clean"),
      tree(A, "working", { dirty: true }),
      tree(A, "ahead", { merged: false }),
    ];
    await readWorktrees();
    expect(leftBehind.trees).toHaveLength(3);

    await cleanWorktrees();

    expect(fake.removed).toEqual(["clean"]);
    expect(names(leftBehind.trees)).toEqual(["working", "ahead"]);
  });
});
