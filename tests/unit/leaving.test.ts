import { beforeEach, describe, expect, it, vi } from "vitest";
import { editor } from "$lib/editor.svelte";
import {
  busyGoing,
  busyShells,
  closingAside,
  closingQuestion,
  leaveAsked,
  leaving,
  running,
  runningAside,
  runningQuestion,
} from "$lib/leaving.svelte";
import { sessions, type Session } from "$lib/sessions.svelte";
import { create, reset as resetShells, started } from "$lib/terminals.svelte";
import { workspace } from "$lib/workspace.svelte";

const confirmed: string[] = [];
let under: Record<string, { pid: number; parent: number; name: string; command: string; started: number }[]> = {};
vi.mock("$lib/core", () => ({
  core: () => ({
    leaveConfirmed: async (kind: string) => {
      confirmed.push(kind);
    },
    setRunning: async () => {},
    setUnsaved: async () => {},
    ptyProcesses: async (id: string) => under[id] ?? [],
  }),
}));

const NBSP = "\u00a0";

/** A shell of the project on screen, running on `ptyId`. */
function shell(ptyId: string) {
  const made = create({ project: workspace.active ?? "/p", session: null });
  started(made.key, ptyId);
  return made;
}

/** A row with only what the count reads. */
function row(status: Session["status"], needs: { unread?: boolean; permission?: boolean } = {}) {
  return {
    key: `s${sessions.all.length + 1}`,
    status,
    unread: needs.unread ?? false,
    needs: needs.permission ? "permission" : null,
    working: false,
  } as unknown as Session;
}

beforeEach(() => {
  confirmed.length = 0;
  under = {};
  resetShells();
  leaving.busy = [];
  workspace.active = "/p";
  workspace.open = [];
  sessions.all = [];
  sessions.active = null;
  editor.asking = null;
  editor.buffers = {};
});

describe("what closing the window takes", () => {
  it("counts the sessions running, and those waiting on the user, but not a row left from the last quit", () => {
    sessions.all = [row("running"), row("starting"), row("running", { unread: true }), row("dormant"), row("exited", { unread: true })];
    expect(running()).toEqual({ count: 3, waiting: 1 });
  });

  it("says how many run and what becomes of them, for the window and for a quit", () => {
    expect(runningQuestion("window", { count: 1, waiting: 0 })).toEqual({
      question: `Close the window with 1${NBSP}session running?`,
      detail: "Closing the window quits the app and stops it. The session comes back as a row next time, to resume.",
      action: "Close window",
    });
    expect(runningQuestion("window", { count: 3, waiting: 2 }).detail).toBe(
      "2 of the sessions are waiting on you. Closing the window quits the app and stops them. The sessions come back as rows next time, to resume.",
    );
    expect(runningQuestion("quit", { count: 2, waiting: 1 })).toEqual({
      question: `Quit with 2${NBSP}sessions running?`,
      detail: "1 of the sessions is waiting on you. Quitting stops them. The sessions come back as rows next time, to resume.",
      action: "Quit",
    });
    expect(runningQuestion("window", { count: 1, waiting: 1 }).detail).toMatch(/^The session is waiting on you\. /);
    expect(runningQuestion("window", { count: 0, waiting: 0 }).question).toBe("Close the window?");
  });

  it("names the busy shells and what runs in them, alone or beside sessions", () => {
    const dev = { label: "shell 2", running: ["npm run dev"] };
    expect(runningQuestion("window", { count: 0, waiting: 0 }, [dev])).toEqual({
      question: `Close the window with 1${NBSP}busy shell running?`,
      detail: "“npm run dev” is running in shell 2. Closing the window quits the app and stops it.",
      action: "Close window",
    });
    expect(runningQuestion("window", { count: 1, waiting: 0 }, [dev]).question).toBe(
      `Close the window with 1${NBSP}session and 1${NBSP}busy shell running?`,
    );
    expect(
      runningQuestion("quit", { count: 0, waiting: 0 }, [
        { label: "shell 1", running: ["npm run dev", "sleep 600"] },
      ]).detail,
    ).toBe(`“npm run dev” and 1${NBSP}more are running in shell 1. Quitting stops it.`);
    expect(
      runningQuestion("window", { count: 0, waiting: 0 }, [
        dev,
        { label: "shell 3", running: ["sleep 600"] },
        { label: "shell 1 in other", running: ["make"] },
      ]).detail,
    ).toBe(
      `“npm run dev” is running in shell 2, “sleep 600” in shell 3, and something in 1${NBSP}more. Closing the window quits the app and stops them.`,
    );
  });

  it("adds what runs to the question about unsaved edits", () => {
    expect(runningAside({ count: 0, waiting: 0 })).toBe("");
    expect(runningAside({ count: 2, waiting: 0 })).toBe(` 2${NBSP}sessions are running, and stop with the app.`);
    expect(runningAside({ count: 0, waiting: 0 }, [{ label: "shell 1", running: ["make"] }])).toBe(
      ` 1${NBSP}busy shell is running, and stops with the app.`,
    );
  });
});

describe("naming a busy shell", () => {
  /** A row with a title, in a project, with only what a name reads. */
  function titled(key: string, title: string, project = "/p") {
    const session = { key, project, title, resumedFrom: null, ordinal: 1 } as unknown as Session;
    sessions.all.push(session);
    return session;
  }

  function busy(owner: { project: string; session: string | null }, ptyId: string, command: string) {
    const made = create(owner);
    started(made.key, ptyId);
    under[ptyId] = [{ pid: 20, parent: 10, name: command.split(" ")[0], command, started: 1 }];
    return made;
  }

  it("says whose a shell not on screen is, for the window's question", async () => {
    titled("s1", "fix login");
    titled("s2", "docs");
    sessions.active = "s1";
    busy({ project: "/p", session: "s1" }, "pty-1", "npm run dev");
    busy({ project: "/p", session: "s2" }, "pty-2", "make watch");
    busy({ project: "/p", session: null }, "pty-3", "sleep 600");
    busy({ project: "/q", session: null }, "pty-4", "vite");
    expect((await busyShells()).map((shell) => shell.label)).toEqual([
      "shell 1",
      "shell 1 of docs",
      "shell 1 in p",
      "shell 1 in q",
    ]);
  });

  it("reads only the shells a session or a project takes with it", async () => {
    titled("s1", "fix login");
    titled("s2", "docs");
    busy({ project: "/p", session: "s1" }, "pty-1", "npm run dev");
    busy({ project: "/p", session: "s2" }, "pty-2", "make watch");
    busy({ project: "/p", session: null }, "pty-3", "sleep 600");
    busy({ project: "/q", session: null }, "pty-4", "vite");
    const idle = create({ project: "/p", session: "s1" });
    started(idle.key, "pty-idle");
    expect(await busyGoing({ session: "s1" })).toEqual([{ label: "shell 1", running: ["npm run dev"] }]);
    expect(await busyGoing({ session: "gone" })).toEqual([]);
    expect(await busyGoing({ project: "/p" })).toEqual([
      { label: "shell 1 of fix login", running: ["npm run dev"] },
      { label: "shell 1 of docs", running: ["make watch"] },
      { label: "shell 1", running: ["sleep 600"] },
    ]);
  });

  it("asks before a session or a project goes in the window's words", () => {
    expect(closingQuestion("session", "fix login", [{ label: "shell 2", running: ["npm run dev"] }])).toEqual({
      question: `Close fix login with 1${NBSP}busy shell running?`,
      detail: "“npm run dev” is running in shell 2. Closing the session stops it.",
      action: "Close session",
    });
    expect(
      closingQuestion("project", "demo", [
        { label: "shell 1", running: ["sleep 600"] },
        { label: "shell 1 of docs", running: ["make watch", "tsc -w"] },
      ]),
    ).toEqual({
      question: `Close demo with 2${NBSP}busy shells running?`,
      detail: "“sleep 600” is running in shell 1, and “make watch” in shell 1 of docs. Closing the project stops them.",
      action: "Close project",
    });
    expect(closingAside("session", [])).toBe("");
    expect(closingAside("session", [{ label: "shell 1", running: ["make"] }])).toBe(
      ` 1${NBSP}busy shell is running, and stops with the session.`,
    );
    expect(closingAside("project", [{ label: "shell 1", running: ["a"] }, { label: "shell 2", running: ["b"] }])).toBe(
      ` 2${NBSP}busy shells are running, and stop with the project.`,
    );
  });
});

describe("the core holding the window back", () => {
  it("puts the question up while sessions run", () => {
    sessions.all = [row("running")];
    void leaveAsked({ kind: "window", generation: 1 });
    expect(editor.asking).toEqual({ kind: "leave", leave: "window", generation: 1 });
    expect(confirmed).toEqual([]);
  });

  it("lets the window go at once when nothing would be lost by now", async () => {
    await leaveAsked({ kind: "quit", generation: 2 });
    expect(editor.asking).toBeNull();
    expect(confirmed).toEqual(["quit"]);
  });

  it("lets the window go at once with only idle shells open", async () => {
    shell("pty-idle");
    await leaveAsked({ kind: "window", generation: 3 });
    expect(editor.asking).toBeNull();
    expect(confirmed).toEqual(["window"]);
  });

  it("asks while a shell has something running, with no session, naming it", async () => {
    shell("pty-dev");
    under["pty-dev"] = [{ pid: 20, parent: 10, name: "npm", command: "npm run dev", started: 1 }];
    await leaveAsked({ kind: "window", generation: 4 });
    expect(editor.asking).toEqual({ kind: "leave", leave: "window", generation: 4 });
    expect(leaving.busy).toEqual([{ label: "shell 1", running: ["npm run dev"] }]);
    expect(confirmed).toEqual([]);
  });

  it("names a busy shell beside the sessions once it is read, the question already up", async () => {
    sessions.all = [row("running")];
    shell("pty-dev");
    under["pty-dev"] = [{ pid: 20, parent: 10, name: "sleep", command: "sleep 600", started: 1 }];
    const asked = leaveAsked({ kind: "window", generation: 5 });
    expect(editor.asking).toEqual({ kind: "leave", leave: "window", generation: 5 });
    await asked;
    expect(leaving.busy).toEqual([{ label: "shell 1", running: ["sleep 600"] }]);
  });
});
