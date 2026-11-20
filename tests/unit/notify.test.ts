import { beforeEach, describe, expect, it, vi } from "vitest";

const told = {
  notified: [] as { title: string; body: string }[],
  names: [] as string[],
  taken: [] as string[],
  chimes: 0,
};
vi.mock("$lib/core", () => ({
  core: () => ({
    notify: async (title: string, body: string, name: string) => {
      told.notified.push({ title, body });
      told.names.push(name);
    },
    unnotify: async (name: string) => {
      told.taken.push(name);
    },
    chime: async () => {
      told.chimes += 1;
    },
    settingsSet: async (change: object) => change,
    setWindowTitle: async () => {},
  }),
}));

import { attention, resetAttention } from "$lib/attention.svelte";
import { conductor, resetConductor } from "$lib/conductor.svelte";
import {
  announce,
  bodyFor,
  clicked,
  notify,
  resetNotify,
  seen,
  setChime,
  titleFor,
} from "$lib/notify.svelte";
import { create, exact, onWaiting, reset, sessions, started, type Session } from "$lib/sessions.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

const A = "/home/ada/dev/one";

function live(project: string, ptyId: string): Session {
  const session = create(project);
  started(session.key, ptyId, `session-${ptyId}`);
  return session;
}

beforeEach(() => {
  reset();
  resetAttention();
  resetConductor();
  resetWorkspace();
  resetNotify();
  told.notified = [];
  told.names = [];
  told.taken = [];
  told.chimes = 0;
  workspace.open = [{ path: A, name: "one", repository: A, isGit: true }];
  attention.focused = false;
  onWaiting(announce);
  return () => onWaiting(null);
});

describe("a session that starts waiting while the window is in the background", () => {
  it("is a notification naming the project and the session, without a chime", () => {
    live(A, "pty-1");
    exact("session-pty-1", "stop");
    expect(told.notified).toEqual([{ title: "one · session 1", body: "Waiting for you" }]);
    expect(told.chimes).toBe(0);
  });

  it("chimes as well once the chime is on", () => {
    notify.chime = true;
    live(A, "pty-1");
    exact("session-pty-1", "stop");
    expect(told.notified).toHaveLength(1);
    expect(told.chimes).toBe(1);
  });

  it("only chimes with the notifications off", () => {
    notify.notifications = false;
    notify.chime = true;
    live(A, "pty-1");
    exact("session-pty-1", "permission");
    expect(told.notified).toEqual([]);
    expect(told.chimes).toBe(1);
  });

  it("says nothing in a focused window, where the row says it", () => {
    attention.focused = true;
    notify.chime = true;
    const behind = live(A, "pty-1");
    live(A, "pty-2");
    exact("session-pty-1", "stop");
    expect(behind.unread).toBe(true);
    expect(told.notified).toEqual([]);
    expect(told.chimes).toBe(0);
  });

  it("from a session another started, says only that it needs a permission", () => {
    const caller = live(A, "pty-1");
    const child = live(A, "pty-2");
    conductor.startedBy[child.key] = caller.id!;
    exact("session-pty-2", "stop");
    expect(told.notified).toEqual([]);
    exact("session-pty-2", "prompt");
    exact("session-pty-2", "permission");
    expect(told.notified.map((n) => n.body)).toEqual(["Needs permission"]);
  });
});

describe("a session's notification once sent", () => {
  it("goes to the session on a click", () => {
    const behind = live(A, "pty-1");
    const other = live(A, "pty-2");
    sessions.active = other.key;
    exact("session-pty-1", "stop");
    clicked(told.names[0]);
    expect(sessions.active).toBe(behind.key);
  });

  it("takes the place of the last for the same session", () => {
    live(A, "pty-1");
    exact("session-pty-1", "stop");
    exact("session-pty-1", "prompt");
    exact("session-pty-1", "permission");
    expect(told.names).toHaveLength(2);
    expect(told.names[1]).toBe(told.names[0]);
  });

  it("is taken away once the session is looked at, and only then", () => {
    const behind = live(A, "pty-1");
    seen(behind.key);
    expect(told.taken).toEqual([]);
    exact("session-pty-1", "stop");
    seen(behind.key);
    seen(behind.key);
    expect(told.taken).toEqual([told.names[0]]);
  });
});

describe("the words", () => {
  it("carry the line the agent left, or say what it waits on", () => {
    const session = live(A, "pty-1");
    expect(bodyFor(session)).toBe("Waiting for you");
    session.note = "Tests pass; over to you.";
    expect(bodyFor(session)).toBe("Tests pass; over to you.");
    session.needs = "permission";
    expect(bodyFor(session)).toBe("Needs permission");
    session.needs = null;
    session.status = "exited";
    expect(bodyFor(session)).toBe("Ended");
  });

  it("name the orchestrator folder by its name, as the pane does", () => {
    const session = live("/home/ada/.chord/orchestrator", "pty-1");
    session.title = "release";
    expect(titleFor(session)).toBe("orchestrator · release");
  });
});

describe("the chime setting", () => {
  it("plays the chime when it is turned on, so the user hears it", () => {
    setChime(true);
    expect(told.chimes).toBe(1);
    setChime(false);
    expect(told.chimes).toBe(1);
  });
});
