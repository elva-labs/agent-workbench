import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountLimitsOptions } from "$lib/core";
import { adoptAccounts, reset as resetAccounts } from "$lib/accounts.svelte";
import { limitsOf, resetLimits, type LimitsReport } from "$lib/limits.svelte";
import {
  ASK_EVERY,
  IDLE_AFTER,
  accountsInUse,
  askForSession,
  followLimits,
  lookAtWork,
  noteWork,
  resetLimitsPoll,
  used,
} from "$lib/limitsPoll";
import { sessions, type Session } from "$lib/sessions.svelte";

const LOCAL = "/home/ada/dev/demo";
const REMOTE = "ssh://build#/srv/demo";

function session(key: string, fields: Partial<Session>): Session {
  return {
    key,
    project: LOCAL,
    agent: "claude-code",
    account: null,
    status: "running",
    ...fields,
  } as unknown as Session;
}

function report(percent: number, readAt: number): LimitsReport {
  return {
    type: "limits",
    agent: "claude-code",
    plan: "max",
    windows: [{ kind: "session", model: null, percent, resetsAt: null, severity: null }],
    readAt,
    takenAt: readAt,
  };
}

/** What each machine holds and has read, by agent and directory, and what
    it was asked. A question can be held open until the test answers it. */
let asked: AccountLimitsOptions[];
let held: Record<string, LimitsReport>;
let fresh: Record<string, LimitsReport>;
let hold: Promise<void> | null;
let failing: boolean;

function install() {
  asked = [];
  held = {};
  fresh = {};
  hold = null;
  failing = false;
  (window as unknown as { __CHORD_CORE__: unknown }).__CHORD_CORE__ = {
    accountLimits: async (options: AccountLimitsOptions) => {
      asked.push(options);
      if (hold !== null) await hold;
      if (failing) throw new Error("not connected");
      const key = `${options.agent} ${options.configDir ?? ""}`;
      return (options.read ? (fresh[key] ?? held[key]) : held[key]) ?? null;
    },
  };
}

/** Lets every question out be answered and taken. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

let stop = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T09:00:00Z"));
  install();
  resetLimits();
  resetLimitsPoll();
  resetAccounts();
  sessions.all = [];
  sessions.active = null;
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe("the accounts in use", () => {
  it("are those of the sessions that run and of the one on screen, each once, on its own machine", () => {
    const dirs = { claude: null, codex: null };
    adoptAccounts({ list: { Work: dirs, Home: dirs, Old: dirs }, everywhere: null, overrides: {} });
    sessions.all = [
      session("a", { account: "Work" }),
      session("b", { account: "Work", status: "starting" }),
      session("c", { account: "Home", status: "exited" }),
      session("d", { account: "Old", status: "dormant" }),
      session("e", { agent: "codex", account: "Work" }),
      session("f", { project: REMOTE, account: "Work" }),
      session("g", { account: null }),
      // An account taken out of the list: its directories are not known.
      session("h", { account: "Removed" }),
    ];
    sessions.active = "d";
    expect(accountsInUse().map((use) => [use.host, use.agent, use.account])).toEqual([
      [null, "claude-code", "Work"],
      [null, "claude-code", "Old"],
      [null, "codex", "Work"],
      ["build", "claude-code", "Work"],
      [null, "claude-code", null],
    ]);
  });
});

describe("asking for the figures", () => {
  beforeEach(() => {
    adoptAccounts({
      list: { Work: { claude: "~/.claude-work", codex: "~/.codex-work" } },
      everywhere: null,
      overrides: {},
    });
  });

  it("takes what the machine kept first, then asks it to read, and asks again every minute while in use", async () => {
    const now = Math.floor(Date.now() / 1000);
    held["claude-code ~/.claude-work"] = report(10, now - 3 * 3600);
    sessions.all = [session("a", { account: "Work" })];
    stop = followLimits();
    await settle();
    expect(asked).toEqual([
      { project: LOCAL, agent: "claude-code", configDir: "~/.claude-work", read: false, worked: false },
      { project: LOCAL, agent: "claude-code", configDir: "~/.claude-work", read: true, worked: false },
    ]);
    expect(limitsOf(null, "claude-code", "Work")?.windows[0].percent).toBe(10);

    fresh["claude-code ~/.claude-work"] = report(20, now);
    window.dispatchEvent(new Event("pointermove"));
    await vi.advanceTimersByTimeAsync(ASK_EVERY);
    expect(asked.map((options) => options.read)).toEqual([false, true, true]);
    expect(limitsOf(null, "claude-code", "Work")?.windows[0].percent).toBe(20);
  });

  it("says whether a session of the account worked since its figures were read", async () => {
    const start = Math.floor(Date.now() / 1000);
    const key = "claude-code ~/.claude-work";
    held[key] = report(10, start - 3 * 3600);
    sessions.all = [session("a", { account: "Work", working: true })];
    const worked = () => asked.filter((options) => options.read).map((options) => options.worked);
    // At work now.
    stop = followLimits();
    await settle();
    expect(worked()).toEqual([true]);
    // Gone quiet, with nothing seen at work since the read.
    sessions.all[0].working = false;
    fresh[key] = report(20, start + 30);
    window.dispatchEvent(new Event("pointermove"));
    await vi.advanceTimersByTimeAsync(ASK_EVERY);
    expect(worked()).toEqual([true, false]);
    // Seen at work after the read, though quiet by the next question.
    noteWork(sessions.all[0]);
    fresh[key] = report(30, start + 2 * 60);
    window.dispatchEvent(new Event("pointermove"));
    await vi.advanceTimersByTimeAsync(ASK_EVERY);
    expect(worked()).toEqual([true, false, true]);
    // A read since that work.
    window.dispatchEvent(new Event("pointermove"));
    await vi.advanceTimersByTimeAsync(ASK_EVERY);
    expect(worked()).toEqual([true, false, true, false]);
    // Another account's work is not this one's.
    noteWork(session("b", { agent: "codex", account: "Work" }));
    window.dispatchEvent(new Event("pointermove"));
    await vi.advanceTimersByTimeAsync(ASK_EVERY);
    expect(worked()).toEqual([true, false, true, false, false]);
  });

  it("counts a turn that runs on past a read as work since it, up to when it stops", async () => {
    const start = Math.floor(Date.now() / 1000);
    const key = "claude-code ~/.claude-work";
    held[key] = report(10, start - 3 * 3600);
    fresh[key] = report(20, start + 30);
    sessions.all = [session("a", { account: "Work", working: true })];
    lookAtWork(sessions.all);
    const worked = () => asked.filter((options) => options.read).map((options) => options.worked);
    // Read while the turn runs, after it began.
    stop = followLimits();
    await settle();
    expect(worked()).toEqual([true]);
    // The turn runs on past that read and stops two minutes in.
    window.dispatchEvent(new Event("pointermove"));
    await vi.advanceTimersByTimeAsync(2 * ASK_EVERY);
    sessions.all[0].working = false;
    lookAtWork(sessions.all);
    window.dispatchEvent(new Event("pointermove"));
    await vi.advanceTimersByTimeAsync(ASK_EVERY);
    expect(worked().at(-1)).toBe(true);
    // A read after it stopped: nothing has worked since.
    fresh[key] = report(30, start + 4 * 60);
    window.dispatchEvent(new Event("pointermove"));
    await vi.advanceTimersByTimeAsync(ASK_EVERY);
    window.dispatchEvent(new Event("pointermove"));
    await vi.advanceTimersByTimeAsync(ASK_EVERY);
    expect(worked().at(-1)).toBe(false);
  });

  it("asks for nothing once the window has been left alone a long while, and at once when it is used again", async () => {
    sessions.all = [session("a", { account: "Work" })];
    stop = followLimits();
    await settle();
    const before = asked.length;
    await vi.advanceTimersByTimeAsync(IDLE_AFTER - ASK_EVERY);
    const whileUsed = asked.length;
    expect(whileUsed).toBeGreaterThan(before);
    await vi.advanceTimersByTimeAsync(10 * ASK_EVERY);
    expect(asked.length).toBe(whileUsed);
    await vi.advanceTimersByTimeAsync(60 * ASK_EVERY);
    expect(asked.length).toBe(whileUsed);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    await settle();
    expect(asked.length).toBe(whileUsed + 1);
  });

  it("asks nothing while the window is hidden", async () => {
    sessions.all = [session("a", { account: "Work" })];
    stop = followLimits();
    await settle();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const before = asked.length;
    await vi.advanceTimersByTimeAsync(3 * ASK_EVERY);
    expect(asked.length).toBe(before);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(ASK_EVERY);
    expect(asked.length).toBeGreaterThan(before);
  });

  it("keeps one question out for an account, however often it is asked for", async () => {
    sessions.all = [session("a", { account: "Work" }), session("b", { account: "Work" })];
    let answer = () => {};
    hold = new Promise((resolve) => (answer = resolve));
    stop = followLimits();
    await settle();
    expect(asked.length).toBe(1);
    void askForSession("a");
    void askForSession("b");
    window.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(3 * ASK_EVERY);
    expect(asked.length).toBe(1);
    hold = null;
    answer();
    await settle();
    expect(asked.length).toBe(2);
  });

  it("asks for a session's account as the session comes on screen, and nothing for one with no session", async () => {
    sessions.all = [session("a", { account: "Work", status: "exited", agent: "codex" })];
    used();
    await askForSession("a");
    expect(asked.map((options) => [options.agent, options.configDir])).toEqual([
      ["codex", "~/.codex-work"],
      ["codex", "~/.codex-work"],
    ]);
    await askForSession("gone");
    expect(asked.length).toBe(2);
  });

  it("asks nothing for a session the app puts on screen in a window left alone, and asks at the first act", async () => {
    sessions.all = [session("a", { account: "Work" }), session("b", { agent: "codex", account: "Work", status: "exited" })];
    stop = followLimits();
    await settle();
    await vi.advanceTimersByTimeAsync(IDLE_AFTER + ASK_EVERY);
    const before = asked.length;
    sessions.active = "b";
    await askForSession("b");
    expect(asked.length).toBe(before);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    await settle();
    expect(asked.slice(before).map((options) => [options.agent, options.read])).toEqual([
      ["claude-code", true],
      ["codex", false],
      ["codex", true],
    ]);
  });

  it("counts the window brought forward as use, and not an element of it focused", async () => {
    sessions.all = [session("a", { account: "Work" })];
    stop = followLimits();
    await settle();
    await vi.advanceTimersByTimeAsync(IDLE_AFTER + ASK_EVERY);
    const before = asked.length;
    const terminal = document.createElement("textarea");
    document.body.append(terminal);
    terminal.focus();
    terminal.dispatchEvent(new FocusEvent("focus"));
    await vi.advanceTimersByTimeAsync(ASK_EVERY);
    expect(asked.length).toBe(before);
    window.dispatchEvent(new FocusEvent("focus"));
    await settle();
    expect(asked.length).toBe(before + 1);
    terminal.remove();
  });

  it("says nothing of a question that fails, and asks again the next minute", async () => {
    const now = Math.floor(Date.now() / 1000);
    held["claude-code ~/.claude-work"] = report(10, now);
    sessions.all = [session("a", { account: "Work" })];
    stop = followLimits();
    await settle();
    failing = true;
    window.dispatchEvent(new Event("wheel"));
    await vi.advanceTimersByTimeAsync(ASK_EVERY);
    expect(limitsOf(null, "claude-code", "Work")?.windows[0].percent).toBe(10);
    const before = asked.length;
    failing = false;
    await vi.advanceTimersByTimeAsync(ASK_EVERY);
    expect(asked.length).toBe(before + 1);
  });

  it("stops asking once stopped", async () => {
    sessions.all = [session("a", { account: "Work" })];
    stop();
    stop = followLimits();
    await settle();
    stop();
    stop = () => {};
    const before = asked.length;
    window.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(5 * ASK_EVERY);
    expect(asked.length).toBe(before);
  });
});
