import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  conductors,
  foldLabel,
  groupsFor,
  isAsking,
  isConductor,
  load,
  orchestrator,
  ownFor,
  summary,
  summaryLine,
} from "$lib/orchestrator.svelte";
import { conductor, resetConductor } from "$lib/conductor.svelte";
import {
  create,
  reset as resetSessions,
  started,
  type Session,
} from "$lib/sessions.svelte";

const DIR = "/home/ada/.agent-workbench/orchestrator";
const A = "/home/ada/dev/one";
const B = "/home/ada/dev/two";

/** Where the core says an orchestrator runs, or nothing it can say. */
const fake = { dir: DIR as string | null };

vi.mock("$lib/core", () => ({
  core: () => ({
    async orchestratorDir() {
      if (fake.dir === null) throw new Error("no core");
      return fake.dir;
    },
  }),
}));

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
  fake.dir = DIR;
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
