import { beforeEach, describe, expect, it, vi } from "vitest";
import { editor } from "$lib/editor.svelte";
import { leaveAsked, running, runningAside, runningQuestion } from "$lib/leaving.svelte";
import { sessions, type Session } from "$lib/sessions.svelte";

const confirmed: string[] = [];
vi.mock("$lib/core", () => ({
  core: () => ({
    leaveConfirmed: async (kind: string) => {
      confirmed.push(kind);
    },
    setRunning: async () => {},
    setUnsaved: async () => {},
  }),
}));

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
  sessions.all = [];
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
      question: "Close the window with 1 session running?",
      detail: "Closing the window quits the app and stops it. It comes back as a row next time, to resume.",
      action: "Close window",
    });
    expect(runningQuestion("window", { count: 3, waiting: 2 }).detail).toBe(
      "2 of them are waiting on you. Closing the window quits the app and stops them. They come back as rows next time, to resume.",
    );
    expect(runningQuestion("quit", { count: 2, waiting: 1 })).toEqual({
      question: "Quit with 2 sessions running?",
      detail: "1 of them is waiting on you. Quitting stops them. They come back as rows next time, to resume.",
      action: "Quit",
    });
    expect(runningQuestion("window", { count: 1, waiting: 1 }).detail).toMatch(/^It is waiting on you\. /);
    expect(runningQuestion("window", { count: 0, waiting: 0 }).question).toBe("Close the window?");
  });

  it("adds the sessions to the question about unsaved edits", () => {
    expect(runningAside({ count: 0, waiting: 0 })).toBe("");
    expect(runningAside({ count: 2, waiting: 0 })).toBe(" 2 sessions are running, and stop with the app.");
  });
});

describe("the core holding the window back", () => {
  it("puts the question up while sessions run", () => {
    sessions.all = [row("running")];
    leaveAsked({ kind: "window", generation: 1 });
    expect(editor.asking).toEqual({ kind: "leave", leave: "window", generation: 1 });
    expect(confirmed).toEqual([]);
  });

  it("lets the window go at once when nothing would be lost by now", () => {
    leaveAsked({ kind: "quit", generation: 2 });
    expect(editor.asking).toBeNull();
    expect(confirmed).toEqual(["quit"]);
  });
});
