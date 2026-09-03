import { beforeEach, describe, expect, it, vi } from "vitest";
import { agent } from "$lib/agent.svelte";
import {
  activeSession,
  byKey,
  close,
  closeProject,
  create,
  ended,
  failed,
  forProject,
  isLive,
  label,
  liveCount,
  reset,
  select,
  sessions,
  shouldAutoStart,
  started,
  statusLabel,
  statusMessage,
  stopProject,
} from "$lib/sessions.svelte";

const A = "/home/ada/dev/one";
const B = "/home/ada/dev/two";

const killed: string[] = [];
vi.mock("$lib/core", () => ({
  core: () => ({
    kill: async (id: string) => {
      killed.push(id);
    },
  }),
}));

beforeEach(() => {
  reset();
  killed.length = 0;
  agent.availability = "ready";
});

/** A session that has actually come up, as one does in practice. */
function live(project: string, ptyId: string) {
  const session = create(project);
  started(session.key, ptyId);
  return session;
}

describe("creating sessions", () => {
  it("starts as starting, and becomes the active one", () => {
    const session = create(A);
    expect(session.status).toBe("starting");
    expect(sessions.active).toBe(session.key);
    expect(activeSession()).toBe(session);
  });

  // The row exists before the process does, so a failure to start has
  // somewhere to be reported.
  it("has an identity before it has a pty", () => {
    const session = create(A);
    expect(session.ptyId).toBeNull();
    expect(byKey(session.key)).toBe(session);
  });

  it("gives every session a distinct key", () => {
    expect(create(A).key).not.toBe(create(A).key);
  });

  it("holds several sessions in the same project", () => {
    live(A, "pty-1");
    live(A, "pty-2");
    expect(forProject(A)).toHaveLength(2);
    expect(liveCount(A)).toBe(2);
  });

  it("keeps projects apart", () => {
    live(A, "pty-1");
    live(B, "pty-2");
    expect(forProject(A)).toHaveLength(1);
    expect(forProject(B)).toHaveLength(1);
  });
});

describe("switching", () => {
  // The point of the whole model: looking at another session kills nothing.
  it("changes what is active without touching anything else", () => {
    const first = live(A, "pty-1");
    const second = live(A, "pty-2");

    select(first.key);
    expect(sessions.active).toBe(first.key);
    expect(second.status).toBe("running");
    expect(second.ptyId).toBe("pty-2");
    expect(killed).toEqual([]);
  });

  it("ignores a key that is not there", () => {
    const session = live(A, "pty-1");
    select("nope");
    expect(sessions.active).toBe(session.key);
  });
});

describe("the exit policy", () => {
  it("treats code zero as a clean end", () => {
    const session = live(A, "pty-1");
    ended({ id: "pty-1", code: 0, clean: true });
    expect(session.status).toBe("exited");
    expect(session.ptyId).toBeNull();
  });

  it("treats anything else as a crash and names the code", () => {
    const session = live(A, "pty-1");
    ended({ id: "pty-1", code: 127, clean: false });
    expect(session.status).toBe("crashed");
    expect(statusMessage(session)).toContain("code 127");
  });

  it("reports a signal kill without inventing a code", () => {
    const session = live(A, "pty-1");
    ended({ id: "pty-1", code: null, clean: false });
    expect(statusMessage(session)).toBe("The session was stopped.");
  });

  // With several live at once, an exit has to land on the right row.
  it("ends only the session the event belongs to", () => {
    const first = live(A, "pty-1");
    const second = live(A, "pty-2");

    ended({ id: "pty-2", code: 1, clean: false });
    expect(second.status).toBe("crashed");
    expect(first.status).toBe("running");
  });

  it("ignores an exit for a session it does not know", () => {
    const session = live(A, "pty-1");
    ended({ id: "pty-99", code: 1, clean: false });
    expect(session.status).toBe("running");
  });

  it("records a failure to start", () => {
    const session = create(A);
    failed(session.key, "no pty available");
    expect(session.status).toBe("failed");
    expect(statusMessage(session)).toBe("no pty available");
  });
});

describe("closing", () => {
  it("stops a live session and removes its row", () => {
    const session = live(A, "pty-1");
    close(session.key);
    expect(killed).toEqual(["pty-1"]);
    expect(sessions.all).toHaveLength(0);
  });

  it("does not try to stop one that already ended", () => {
    const session = live(A, "pty-1");
    ended({ id: "pty-1", code: 0, clean: true });
    close(session.key);
    expect(killed).toEqual([]);
  });

  // Closing one should not throw you into a different project's work.
  it("falls back to a sibling in the same project", () => {
    const first = live(A, "pty-1");
    const second = live(A, "pty-2");
    live(B, "pty-3");

    select(second.key);
    close(second.key);
    expect(sessions.active).toBe(first.key);
  });

  it("falls back to another project only when there is no sibling", () => {
    const only = live(A, "pty-1");
    const other = live(B, "pty-2");
    select(only.key);
    close(only.key);
    expect(sessions.active).toBe(other.key);
  });

  it("leaves nothing active when the last one goes", () => {
    close(live(A, "pty-1").key);
    expect(sessions.active).toBeNull();
  });

  it("leaves the active session alone when closing another", () => {
    const first = live(A, "pty-1");
    const second = live(A, "pty-2");
    select(second.key);
    close(first.key);
    expect(sessions.active).toBe(second.key);
  });

  it("closes a whole project's sessions and leaves the rest", () => {
    live(A, "pty-1");
    live(A, "pty-2");
    live(B, "pty-3");

    closeProject(A);
    expect(forProject(A)).toHaveLength(0);
    expect(forProject(B)).toHaveLength(1);
    expect(killed).toEqual(["pty-1", "pty-2"]);
  });

  it("stops a project's sessions without removing their rows", () => {
    live(A, "pty-1");
    stopProject(A);
    expect(killed).toEqual(["pty-1"]);
    expect(forProject(A)).toHaveLength(1);
  });
});

describe("auto-start", () => {
  it("starts one for a project that has none", () => {
    expect(shouldAutoStart(A)).toBe(true);
  });

  it("does not start a second", () => {
    create(A);
    expect(shouldAutoStart(A)).toBe(false);
  });

  // Coming back to a project you left is the reason its sessions stayed alive.
  it("does not start one when returning to a project that has some", () => {
    live(A, "pty-1");
    expect(shouldAutoStart(A)).toBe(false);
  });

  // The rule the exit policy turns on: a crash must never become a loop.
  it("does not restart after a crash", () => {
    const session = live(A, "pty-1");
    ended({ id: "pty-1", code: 1, clean: false });
    expect(session.status).toBe("crashed");
    expect(shouldAutoStart(A)).toBe(false);
  });

  it("starts one again once the last row is closed", () => {
    close(live(A, "pty-1").key);
    expect(shouldAutoStart(A)).toBe(true);
  });

  it("starts nothing without a project", () => {
    expect(shouldAutoStart(null)).toBe(false);
  });

  it("starts nothing when there is no agent to run", () => {
    agent.availability = "missing";
    expect(shouldAutoStart(A)).toBe(false);
  });
});

describe("labels", () => {
  it("numbers sessions within their project", () => {
    const first = create(A);
    const second = create(A);
    expect(label(first)).toBe("session 1");
    expect(label(second)).toBe("session 2");
  });

  it("names a resumed session by its transcript id", () => {
    const session = create(A, "9604da0e-c207-4138-974b-8e1ef8cffd07");
    expect(label(session)).toBe("9604da0e");
  });

  it("reports liveness for the dot in the tree", () => {
    const session = live(A, "pty-1");
    expect(isLive(session)).toBe(true);
    ended({ id: "pty-1", code: 0, clean: true });
    expect(isLive(session)).toBe(false);
  });

  it("names every state the header can be in", () => {
    expect(statusLabel(null)).toBe("no session");

    const session = create(A);
    expect(statusLabel(session)).toBe("starting");
    started(session.key, "pty-1");
    expect(statusLabel(session)).toBe("running");
    ended({ id: "pty-1", code: 0, clean: true });
    expect(statusLabel(session)).toBe("ended");

    const other = live(A, "pty-2");
    ended({ id: "pty-2", code: 1, clean: false });
    expect(statusLabel(other)).toBe("stopped");
  });
});

describe("closing does not double-kill", () => {
  // The row's terminal unmounts when the row goes, and its teardown kills
  // whatever pty the session still names. Closing has to leave it nothing.
  it("clears the pty id at the point of the kill", () => {
    const session = live(A, "pty-1");
    const key = session.key;
    close(key);
    expect(killed).toEqual(["pty-1"]);
    expect(byKey(key)).toBeNull();
  });

  it("kills each of a project's sessions exactly once", () => {
    live(A, "pty-1");
    live(A, "pty-2");
    closeProject(A);
    expect(killed).toEqual(["pty-1", "pty-2"]);
  });
});
