import { flushSync } from "svelte";
import type { SpawnOptions } from "$lib/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conductor, resetConductor } from "$lib/conductor.svelte";
import { reopen } from "$lib/reopen.svelte";
import { attention, resetAttention } from "$lib/attention.svelte";
import {
  activeSession,
  create,
  exact,
  followWaiting,
  forProject,
  loadRemembered,
  markRead,
  markUnread,
  nextNeedingYou,
  noted,
  onScreenNow,
  onWaiting,
  reset as resetSessions,
  select,
  sessions,
  started,
  unreadCount,
  viewed,
  waitingRecord,
  WAITING_FOR,
  wake,
  type Session,
} from "$lib/sessions.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";
import { reset as resetWorkflows } from "$lib/workflows.svelte";

const spawned: SpawnOptions[] = [];

vi.mock("$lib/core", () => ({
  core: () => ({
    spawn: async (options: SpawnOptions) => {
      spawned.push(options);
      return { ptyId: `pty-${spawned.length + 10}`, sessionId: options.session ?? null };
    },
    kill: async () => {},
    setWindowTitle: async () => {},
    projectInfo: async (path: string) => ({ path, name: path, repository: path, isGit: true }),
    transcripts: async () => [],
    transcriptsMany: async (projects: string[]) => projects.map(() => []),
  }),
}));

const A = "/home/ada/dev/one";
const B = "/home/ada/dev/two";
const repo = (path: string) => ({ path, name: path, repository: path, isGit: true });

let stops: (() => void)[] = [];
const told: string[] = [];

/** The window as it opens: what was remembered is read, the record is
    followed, and the sessions that were open come back. */
function open() {
  resetWorkflows();
  resetSessions();
  resetWorkspace();
  resetConductor();
  resetAttention();
  workspace.open.push(repo(A), repo(B));
  workspace.active = A;
  loadRemembered();
  stops.push(followWaiting());
  stops.push(reopen());
  told.length = 0;
  onWaiting((session) => told.push(session.id ?? session.key));
  flushSync();
}

/** The app quits, or crashes: nothing is written on the way out. */
function quit() {
  flushSync();
  for (const stop of stops) stop();
  stops = [];
  onWaiting(null);
}

function restart() {
  quit();
  open();
}

/** A session that has come up with an id, as one does in practice. */
function live(project: string, id: string): Session {
  const session = create(project);
  started(session.key, `pty-${id}`, id);
  return session;
}

const row = (id: string) => sessions.all.find((session) => session.id === id)!;

beforeEach(() => {
  localStorage.clear();
  told.length = 0;
  open();
});

afterEach(() => quit());

describe("a row unread at the quit", () => {
  it("comes back unread with the line under its name, and says nothing", () => {
    const one = live(A, "one");
    const two = live(A, "two");
    attention.focused = false;
    noted(one.key, "Plugin in main-truck staged, need approvals");
    expect(told).toEqual(["one"]);
    void two;

    restart();
    const back = row("one");
    expect(back.status).toBe("dormant");
    expect(back.unread).toBe(true);
    expect(back.note).toBe("Plugin in main-truck staged, need approvals");
    expect(row("two").unread).toBe(false);
    expect(unreadCount()).toBe(1);
    expect(told).toEqual([]);
    expect(nextNeedingYou()?.id).toBe("one");
  });

  it("is kept as it changes, so a crash keeps it as well", () => {
    const one = live(A, "one");
    live(A, "two");
    noted(one.key, "Over to you.");
    flushSync();
    // Nothing is written on the way out: the record is already current.
    expect(waitingRecord().one).toMatchObject({ unread: true, note: "Over to you." });
    expect(JSON.parse(localStorage.getItem("workbench.waiting")!).one.unread).toBe(true);
  });

  it("comes back read once it was read, and keeps none of its lines", () => {
    const one = live(A, "one");
    live(A, "two");
    noted(one.key, "Done.");
    viewed(one.key);
    flushSync();
    expect(JSON.parse(localStorage.getItem("workbench.waiting")!)).toEqual({});

    restart();
    expect(row("one").unread).toBe(false);
    expect(row("one").note).toBeNull();
    markUnread(row("one").key);
    expect(row("one").note).toBeNull();
  });

  it("comes back for an integrated session", () => {
    localStorage.setItem(
      "workbench.open",
      JSON.stringify({
        open: [{ project: A, id: "conv", agent: "claude-code", startIn: null, model: null, kind: "integrated" }],
        active: null,
        waiting: true,
      }),
    );
    localStorage.setItem(
      "workbench.waiting",
      JSON.stringify({ conv: { unread: true, note: "Tests green.", notice: "Tests green.", at: 1 } }),
    );
    restart();
    expect(row("conv").kind).toBe("integrated");
    expect(row("conv").unread).toBe(true);
    expect(row("conv").note).toBe("Tests green.");
  });

  it("waits for a session another started until its starter brings it back", () => {
    const caller = live(A, "caller");
    const child = live(B, "child");
    conductor.startedBy[child.key] = "caller";
    select(caller.key);
    exact("child", "permission");
    expect(child.unread).toBe(true);

    restart();
    expect(sessions.all.some((session) => session.id === "child")).toBe(false);
    // Kept through another start meanwhile.
    restart();
    const resumed = create(B, "child");
    expect(resumed.unread).toBe(true);
  });

  it("lets go of a row that has not come back for a week", () => {
    const caller = live(A, "caller");
    const child = live(B, "child");
    conductor.startedBy[child.key] = "caller";
    select(caller.key);
    exact("child", "permission");
    restart();
    expect(waitingRecord().child).toBeDefined();

    quit();
    const kept = JSON.parse(localStorage.getItem("workbench.waiting")!);
    kept.child.seen = Date.now() - WAITING_FOR - 1;
    localStorage.setItem("workbench.waiting", JSON.stringify(kept));
    open();
    expect(waitingRecord().child).toBeUndefined();
    expect(create(B, "child").unread).toBe(false);
  });

  it("announces news after the restart as it would have before", () => {
    const one = live(A, "one");
    live(A, "two");
    exact("one", "prompt");
    exact("one", "stop", "First.");

    restart();
    expect(told).toEqual([]);
    // Already unread: a further line is not news, a permission is.
    noted(row("one").key, "Second.");
    expect(told).toEqual([]);
    expect(row("one").note).toBe("Second.");
    wake(row("one").key);
    exact("one", "permission");
    expect(told).toEqual(["one"]);
    void one;
  });

  it("is ignored when a version before wrote the record last", () => {
    const one = live(A, "one");
    live(A, "two");
    noted(one.key, "Over to you.");
    quit();
    // A version before rewrites the record of open rows without its flag.
    const record = JSON.parse(localStorage.getItem("workbench.open")!);
    localStorage.setItem("workbench.open", JSON.stringify({ open: record.open, active: record.active }));
    open();
    expect(row("one").unread).toBe(false);
    expect(row("one").note).toBeNull();
  });
});

describe("a mark made by hand", () => {
  it("comes back with its rule: the first news over it is announced, with its own line", () => {
    const one = live(A, "one");
    live(A, "two");
    noted(one.key, "Old line.");
    viewed(one.key);
    markUnread(one.key);

    restart();
    expect(row("one").unread).toBe(true);
    expect(row("one").note).toBe("Old line.");
    expect(told).toEqual([]);
    noted(row("one").key, "New line.");
    expect(told).toEqual(["one"]);
    expect(row("one").note).toBe("New line.");
  });

  it("keeps through a director's prompt after the restart", () => {
    const one = live(A, "one");
    live(A, "two");
    markUnread(one.key);
    restart();
    wake(row("one").key);
    exact("one", "prompt");
    expect(row("one").unread).toBe(true);
  });

  it("ends with Mark as read", () => {
    const one = live(A, "one");
    live(A, "two");
    markUnread(one.key);
    restart();
    markRead(row("one").key);
    expect(row("one").unread).toBe(false);
    restart();
    expect(row("one").unread).toBe(false);
  });
});

describe("the row the restore puts on screen", () => {
  /** Two rows, the first on screen at the quit and unread. */
  function unreadOnScreen() {
    const one = live(A, "one");
    const two = live(A, "two");
    noted(one.key, "Waiting on you.");
    select(one.key);
    flushSync();
    void two;
    restart();
    expect(activeSession()?.id).toBe("one");
  }

  it("is not read by being restored, nor by the first look", () => {
    unreadOnScreen();
    onScreenNow(sessions.active);
    viewed(sessions.active!);
    expect(row("one").unread).toBe(true);
  });

  it("is read once the user leaves it and comes back", () => {
    unreadOnScreen();
    select(row("two").key);
    onScreenNow(sessions.active);
    viewed(sessions.active!);
    select(row("one").key);
    onScreenNow(sessions.active);
    viewed(sessions.active!);
    expect(row("one").unread).toBe(false);
  });

  it("is read when the user writes to it", () => {
    unreadOnScreen();
    wake(row("one").key);
    exact("one", "prompt");
    expect(row("one").unread).toBe(false);
  });

  it("holds nothing when it was read", () => {
    live(A, "one");
    restart();
    expect(activeSession()?.id).toBe("one");
    expect(forProject(A).every((session) => !session.unread)).toBe(true);
  });
});
