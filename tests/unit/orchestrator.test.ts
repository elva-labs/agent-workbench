import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workflow, Worktree } from "$lib/core";
import {
  NAME_SHOWN,
  boardOf,
  canSend,
  cleanQuestion,
  cleanWorktrees,
  childrenOf,
  isAsking,
  leftBehind,
  ownFor,
  parentOf,
  readWorktrees,
  removable,
  conducting,
  quotedStarted,
  sendLine,
  startedDetail,
  startedDot,
  stateWord,
  startedName,
  startedRows,
  stopAllQuestion,
  stopOneQuestion,
  madeTrees,
  summary,
  summaryLine,
  treesFor,
  worktreeLine,
  type LeftTree,
} from "$lib/orchestrator.svelte";
import { conductor, resetConductor, treesMadeBy } from "$lib/conductor.svelte";
import {
  create,
  exact,
  nextNeedingYou,
  noted,
  rang,
  reset as resetSessions,
  sessions,
  started,
  unreadCount,
  waitingOnYou,
  type Session,
} from "$lib/sessions.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

/** The project the starters in these tests run in. */
const LEAD = "/home/ada/dev/lead";
const A = "/home/ada/dev/one";
const B = "/home/ada/dev/two";

/** What worktrees each project has, and what a test asked to be
    removed. */
const fake = {
  trees: {} as Record<string, Worktree[]>,
  removed: [] as string[],
  written: [] as [string, string][],
};

vi.mock("$lib/core", () => ({
  core: () => ({
    async write(ptyId: string, data: string) {
      fake.written.push([ptyId, data]);
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
  conductor.startedBy[session.key] = by.token;
  return session;
}

const keys = (list: Session[]) => list.map((session) => session.key);

beforeEach(() => {
  resetSessions();
  resetConductor();
  resetWorkspace();
  fake.trees = {};
  fake.removed = [];
  fake.written = [];
  leftBehind.trees = [];
  leftBehind.loading = false;
});

describe("a project's sessions", () => {
  it("hangs the started ones under the session that started them, wherever they run", () => {
    const one = live(LEAD, "pty-1", "sid-1");
    const two = live(LEAD, "pty-2", "sid-2");
    const mine = live(A, "pty-3", "sid-3");
    const first = startedIn(A, one, "pty-4", "sid-4");
    const second = startedIn(A, two, "pty-5", "sid-5");
    const third = startedIn(A, one, "pty-6", "sid-6");
    const elsewhere = startedIn(B, one, "pty-7", "sid-7");

    expect(keys(ownFor(A))).toEqual([mine.key]);
    expect(ownFor(B)).toEqual([]);
    expect(parentOf(first)?.key).toBe(one.key);
    expect(parentOf(mine)).toBeNull();
    expect(keys(childrenOf(one))).toEqual([first.key, third.key, elsewhere.key]);
    expect(keys(childrenOf(two))).toEqual([second.key]);
    expect(childrenOf(mine)).toEqual([]);
  });

  // A session another one started in the same project hangs under it too.
  it("hangs a session under a starter in its own project", () => {
    const lead = live(A, "pty-1", "sid-1");
    const helper = startedIn(A, lead, "pty-2", "sid-2");
    expect(keys(ownFor(A))).toEqual([lead.key]);
    expect(keys(childrenOf(lead))).toEqual([helper.key]);
  });

  it("stands a session whose starter is gone in its own project", () => {
    const session = live(A, "pty-1", "sid-1");
    conductor.startedBy[session.key] = "sid-gone";
    expect(parentOf(session)).toBeNull();
    expect(keys(ownFor(A))).toEqual([session.key]);
  });
});

describe("what an orchestrator has out", () => {
  it("counts what is running and what is waiting on you", () => {
    const one = live(LEAD, "pty-1", "sid-1");
    expect(summary(one)).toEqual({ running: 0, asking: 0, working: false });
    expect(summaryLine(one)).toBeNull();

    const here = startedIn(A, one, "pty-2", "sid-2");
    const there = startedIn(B, one, "pty-3", "sid-3");
    expect(summary(one)).toEqual({ running: 2, asking: 0, working: false });
    expect(summaryLine(one)).toBe("2 running");

    // Asking for permission is waiting on you. A line left behind while
    // nobody was looking is the orchestrator's to read, not yours.
    there.needs = "permission";
    expect(isAsking(there)).toBe(true);
    expect(summaryLine(one)).toBe("2 running, 1 asking");
    here.unread = true;
    expect(isAsking(here)).toBe(false);
    expect(summaryLine(one)).toBe("2 running, 1 asking");

    // A session that has stopped is neither running nor waiting, whatever
    // it was doing when it went.
    here.status = "exited";
    expect(isAsking(here)).toBe(false);
    expect(summaryLine(one)).toBe("1 running, 1 asking");
  });

  it("breathes when its own agent works, or one it started does", () => {
    const one = live(LEAD, "pty-1", "sid-1");
    // Nothing out, nothing at work: the dot rests.
    expect(conducting(one)).toBe(false);

    // Its own agent at work breathes, as any session's does.
    one.working = true;
    expect(conducting(one)).toBe(true);
    one.working = false;

    // Parked on a wait while a child streams: the child's work bubbles up.
    const child = startedIn(A, one, "pty-2", "sid-2");
    expect(summary(one).working).toBe(false);
    expect(conducting(one)).toBe(false);
    child.working = true;
    expect(summary(one).working).toBe(true);
    expect(conducting(one)).toBe(true);

    // A child that has stopped, whatever it was doing, does not.
    child.status = "exited";
    expect(conducting(one)).toBe(false);
  });

  it("says what it is doing as its dot decides it, in every place", () => {
    const one = live(LEAD, "pty-1", "sid-1");
    expect(stateWord(one)).toBe("running");
    expect(stateWord(null)).toBe("no session");

    one.working = true;
    expect(stateWord(one)).toBe("working");
    one.working = false;

    // At rest while a session it started works: the dot breathes, and the
    // words say why, rather than idle.
    const child = startedIn(A, one, "pty-2", "sid-2");
    child.working = true;
    expect(conducting(one)).toBe(true);
    expect(stateWord(one)).toBe("sessions working");
    expect(startedDot(child)).toBe("busy");

    // Its own call for attention is the row's state over the child's work.
    one.needs = "permission";
    expect(stateWord(one)).toBe("needs permission");
    one.needs = null;
    one.unread = true;
    expect(stateWord(one)).toBe("waiting for you");
    one.unread = false;

    child.working = false;
    expect(stateWord(one)).toBe("running");
  });

  it("lets its own call for attention hold the dot over a working child", () => {
    const one = live(LEAD, "pty-1", "sid-1");
    const child = startedIn(A, one, "pty-2", "sid-2");
    child.working = true;
    expect(conducting(one)).toBe(true);

    // The orchestrator itself needs the user: its permission ring, or its
    // unread accent, is the row's state, not the child's work.
    one.needs = "permission";
    expect(conducting(one)).toBe(false);
    one.needs = null;
    one.unread = true;
    expect(conducting(one)).toBe(false);
  });

  it("leaves a started session read when it stops, and unread for a permission", () => {
    const one = live(LEAD, "pty-1", "sid-1");
    const own = live(A, "pty-2", "sid-2");
    const child = startedIn(A, one, "pty-3", "sid-3");
    // Both end a turn behind the orchestrator's row. The user's own
    // session waits on them; the started one waits on the orchestrator.
    sessions.active = one.key;
    exact("sid-2", "prompt");
    exact("sid-2", "stop");
    exact("sid-3", "prompt");
    exact("sid-3", "stop");
    expect(own.unread).toBe(true);
    expect(child.unread).toBe(false);
    expect(unreadCount()).toBe(1);
    expect(summaryLine(one)).toBe("1 running");

    // A line left, an idle notice or a bell is the orchestrator's to hear.
    noted(child.key, "Which suite did you mean?");
    exact("sid-3", "idle");
    rang(child.key);
    expect(child.unread).toBe(false);
    expect(child.note).toBe("Which suite did you mean?");

    // A permission is the one thing no agent can answer for it.
    exact("sid-3", "prompt");
    exact("sid-3", "permission");
    expect(child.unread).toBe(true);
    expect(summaryLine(one)).toBe("1 running, 1 asking");
    expect(isAsking(child)).toBe(true);
  });

  it("leaves a started session that only stopped out of the jump", () => {
    const one = live(LEAD, "pty-1", "sid-1");
    const own = live(A, "pty-2", "sid-2");
    const child = startedIn(A, one, "pty-3", "sid-3");
    sessions.active = one.key;
    exact("sid-2", "stop");
    exact("sid-3", "stop");
    expect(waitingOnYou().map((session) => session.key)).toEqual([own.key]);

    exact("sid-3", "prompt");
    exact("sid-3", "permission");
    expect(waitingOnYou().map((session) => session.key)).toEqual([
      child.key,
      own.key,
    ]);
    expect(nextNeedingYou()?.key).toBe(child.key);
  });

  it("counts only what the orchestrator itself started", () => {
    const one = live(LEAD, "pty-1", "sid-1");
    const two = live(LEAD, "pty-2", "sid-2");
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

    await cleanWorktrees(leftBehind.trees);

    expect(fake.removed).toEqual(["clean"]);
    expect(names(leftBehind.trees)).toEqual(["working", "ahead"]);
  });
});

describe("the board for any session", () => {
  /** Plan, then Work, then a Review that sends the work back three times
      at most. */
  const FLOW: Workflow = {
    name: "Plan, work, review",
    orchestrator: { agent: "claude-code", model: "fable" },
    steps: [
      { kind: "work", name: "Work", models: [{ agent: "claude-code", model: "sonnet" }], parallel: 2 },
      {
        kind: "review",
        name: "Review",
        models: [{ agent: "claude-code", model: "opus" }],
        reviewerApproves: true,
        orchestratorAgrees: true,
        backTo: "Work",
        limit: 3,
      },
    ],
  };

  it("is the session on screen once it has started some, wherever it runs", () => {
    const starter = live(A, "pty-1", "sid-1");
    expect(boardOf(starter)).toBeNull();
    expect(boardOf(null)).toBeNull();

    const fix = startedIn(A, starter, "pty-2", "sid-2");
    expect(boardOf(starter)).toBe(starter);
    expect(keys(startedRows(starter))).toEqual([fix.key]);
    // The one it started has started none.
    expect(boardOf(fix)).toBeNull();

    // A session in the orchestrator folder is a session like any other.
    const top = live("/home/ada/.agent-workbench/orchestrator", "pty-3", "sid-3");
    startedIn(A, top, "pty-4", "sid-4");
    expect(boardOf(top)).toBe(top);
  });

  it("says each one's step and round, where it runs and what it is doing", () => {
    const starter = live(A, "pty-1", "sid-1");
    starter.workflow = FLOW;
    const now = Date.now();
    const work = startedIn(A, starter, "pty-2", "sid-2");
    work.startIn = `${A}/.claude/worktrees/fix-cache`;
    work.changedAt = now - 12 * 60_000;
    conductor.places[work.key] = { step: "Work", kind: "work", piece: "sid-2", round: null, work: null };
    expect(startedDetail(starter, work, now)).toBe("Work · worktree fix-cache · running, 12m");

    const review = startedIn(A, starter, "pty-3", "sid-3");
    review.needs = "permission";
    review.changedAt = now - 60_000;
    conductor.places[review.key] = { step: "Review", kind: "review", piece: "sid-2", round: 2, work: "sid-2" };
    expect(startedDetail(starter, review, now)).toBe("Review, round 2 of 4 · asking, 1m");
    expect(startedDot(review)).toBe("waiting");

    // One for no step, in another project, at work.
    const other = startedIn(B, starter, "pty-4", "sid-4");
    other.working = true;
    other.changedAt = now;
    expect(startedDetail(starter, other, now)).toBe("two · working, now");
    expect(startedDot(other)).toBe("busy");

    other.status = "exited";
    expect(startedDot(other)).toBe("none");
    expect(startedDot(work)).toBe("ok");
  });

  it("cuts a long name to what a row holds, and quotes it with what is unseen written out", () => {
    const starter = live(A, "pty-1", "sid-1");
    const fix = startedIn(A, starter, "pty-2", "sid-2");
    fix.title = `Fix \u202ethe cache ${"x".repeat(400)}`;
    const name = startedName(fix);
    expect(Array.from(name)).toHaveLength(NAME_SHOWN + 1);
    expect(name.endsWith("…")).toBe(true);
    expect(quotedStarted(fix).startsWith("“Fix ⟨U+202E⟩the cache x")).toBe(true);
    expect(quotedStarted(fix).endsWith("…”")).toBe(true);

    fix.title = "Fix\nthe cache";
    expect(quotedStarted(fix)).toBe("“Fix the cache”");
  });

  it("sends a line to a session that runs, typed as one line", async () => {
    const starter = live(A, "pty-1", "sid-1");
    const fix = startedIn(A, starter, "pty-2", "sid-2");
    expect(canSend(fix)).toBe(true);

    sendLine(fix, "run the\nunit tests");
    await vi.waitFor(() => expect(fake.written).toEqual([["pty-2", "run the unit tests"], ["pty-2", "\r"]]));

    // Nothing is sent to one that has ended, or of nothing.
    sendLine(fix, "   ");
    fix.status = "exited";
    expect(canSend(fix)).toBe(false);
    sendLine(fix, "once more");
    expect(fake.written).toHaveLength(2);
  });

  it("counts only the worktrees its own starts made", () => {
    const starter = live(A, "pty-1", "sid-1");
    const other = live(A, "pty-2", "sid-2");
    startedIn(A, starter, "pty-3", "sid-3");
    startedIn(A, other, "pty-4", "sid-4");
    conductor.trees[starter.token] = [
      { project: A, path: tree(A, "fix-cache").path },
      { project: B, path: tree(B, "bump").path },
    ];
    conductor.trees[other.token] = [{ project: A, path: tree(A, "theirs").path }];
    leftBehind.trees = [
      { ...tree(A, "fix-cache"), project: A },
      { ...tree(A, "theirs"), project: A },
      // Made by the user, or by a start of no session here.
      { ...tree(A, "users-own"), project: A },
      { ...tree(B, "bump"), project: B },
      { ...tree(B, "elsewhere"), project: B },
    ];
    expect(names(treesFor(starter))).toEqual(["fix-cache", "bump"]);
    expect(names(treesFor(other))).toEqual(["theirs"]);
    // The same name under another project is another tree.
    conductor.trees[other.token] = [{ project: B, path: tree(B, "fix-cache").path }];
    expect(names(treesFor(other))).toEqual([]);
  });

  it("stays while the worktrees its starts made are left behind", () => {
    const starter = live(A, "pty-1", "sid-1");
    expect(madeTrees(starter)).toBe(false);
    conductor.trees[starter.token] = [{ project: A, path: tree(A, "fix-cache").path }];
    expect(madeTrees(starter)).toBe(true);
    // Not yet read, or gone: no section for it.
    expect(boardOf(starter)).toBeNull();
    leftBehind.trees = [{ ...tree(A, "fix-cache"), project: A }];
    expect(boardOf(starter)).toBe(starter);
  });

  it("says what the worktrees left behind are, and why the rest stayed", () => {
    const trees: LeftTree[] = [
      { ...tree(A, "clean"), project: A },
      { ...tree(A, "working", { dirty: true }), project: A },
      { ...tree(A, "ahead", { merged: false }), project: A },
    ];
    expect(worktreeLine(trees, false)).toBe("3 worktrees left behind");
    expect(worktreeLine(trees.slice(0, 1), false)).toBe("1 worktree left behind");
    expect(worktreeLine(trees.slice(1), true)).toBe("2 kept: 1 uncommitted work, 1 has commits the project does not");
    expect(worktreeLine(trees.slice(1, 2), true)).toBe("1 kept: uncommitted work");
  });

  it("asks before stopping them all, saying what waits on you", () => {
    const starter = live(A, "pty-1", "sid-1");
    const fix = startedIn(A, starter, "pty-2", "sid-2");
    const review = startedIn(A, starter, "pty-3", "sid-3");
    review.needs = "permission";
    fix.working = true;
    expect(stopAllQuestion([fix, review])).toEqual({
      question: "Stop all 2 sessions it started?",
      detail:
        "1 of them is waiting on you. 1 of them is at work. Stopping them takes their rows away; what they changed stays.",
      action: "Stop all",
    });
    expect(stopAllQuestion([review])).toEqual({
      question: "Stop the session it started?",
      detail: "It is waiting on you. Stopping it takes its row away; what it changed stays.",
      action: "Stop all",
    });
  });

  it("counts the ones still running, and says the ended ones go too", () => {
    const starter = live(A, "pty-1", "sid-1");
    const fix = startedIn(A, starter, "pty-2", "sid-2");
    const bump = startedIn(A, starter, "pty-3", "sid-3");
    const done = startedIn(A, starter, "pty-4", "sid-4");
    done.status = "exited";
    expect(stopAllQuestion([fix, bump, done])).toEqual({
      question: "Stop all 2 sessions it started?",
      detail: "Stopping them takes their rows away; what they changed stays. The one that has ended goes too.",
      action: "Stop all",
    });
    bump.status = "exited";
    expect(stopAllQuestion([fix, bump, done])).toEqual({
      question: "Stop the session that still runs?",
      detail: "Stopping it takes its row away; what it changed stays. The 2 that have ended go too.",
      action: "Stop all",
    });
  });

  it("asks before one is stopped from the keyboard, naming it", () => {
    const starter = live(A, "pty-1", "sid-1");
    const fix = startedIn(A, starter, "pty-2", "sid-2");
    fix.title = "Fix the cache";
    fix.working = true;
    expect(stopOneQuestion(fix)).toEqual({
      question: "Stop “Fix the cache”?",
      detail: "It is at work. Stopping it takes its row away; what it changed stays.",
      action: "Stop",
    });
    fix.status = "exited";
    expect(stopOneQuestion(fix)).toEqual({
      question: "Close “Fix the cache”?",
      detail: "It has ended; its row goes, and what it changed stays.",
      action: "Close",
    });
  });

  it("asks before cleaning up, naming what goes and how many stay", () => {
    const trees: LeftTree[] = [
      { ...tree(A, "clean"), project: A },
      { ...tree(A, "done"), project: A },
      { ...tree(A, "working", { dirty: true }), project: A },
    ];
    expect(cleanQuestion(trees)).toEqual({
      question: "Clean up 2 worktrees?",
      detail:
        "clean and done go, with their branches: their work is merged and nothing in them is uncommitted. 1 stays, with work that is not merged or not committed.",
      action: "Clean up",
    });
    expect(cleanQuestion(trees.slice(0, 1)).detail).toBe(
      "clean goes, with its branch: its work is merged and nothing in it is uncommitted.",
    );
  });

  it("cleans up only the worktrees it is given, and forgets whose they were", async () => {
    workspace.open.push(repo(A));
    fake.trees[A] = [tree(A, "mine"), tree(A, "theirs")];
    conductor.trees["tok-1"] = [{ project: A, path: tree(A, "mine").path }];
    await readWorktrees();

    await cleanWorktrees(leftBehind.trees.filter((left) => left.name === "mine"));

    expect(fake.removed).toEqual(["mine"]);
    expect(names(leftBehind.trees)).toEqual(["theirs"]);
    expect(treesMadeBy("tok-1")).toEqual([]);
  });
});
