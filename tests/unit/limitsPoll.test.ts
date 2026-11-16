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
  resetLimitsPoll,
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
  (window as unknown as { __WORKBENCH_CORE__: unknown }).__WORKBENCH_CORE__ = {
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
    sessions.all = [
      session("a", { account: "Work" }),
      session("b", { account: "Work", status: "starting" }),
      session("c", { account: "Home", status: "exited" }),
      session("d", { account: "Old", status: "dormant" }),
      session("e", { agent: "codex", account: "Work" }),
      session("f", { project: REMOTE, account: "Work" }),
    ];
    sessions.active = "d";
    expect(accountsInUse().map((use) => [use.host, use.agent, use.account])).toEqual([
      [null, "claude-code", "Work"],
      [null, "claude-code", "Old"],
      [null, "codex", "Work"],
      ["build", "claude-code", "Work"],
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
      { project: LOCAL, agent: "claude-code", configDir: "~/.claude-work", read: false },
      { project: LOCAL, agent: "claude-code", configDir: "~/.claude-work", read: true },
    ]);
    expect(limitsOf(null, "claude-code", "Work")?.windows[0].percent).toBe(10);

    fresh["claude-code ~/.claude-work"] = report(20, now);
    window.dispatchEvent(new Event("pointermove"));
    await vi.advanceTimersByTimeAsync(ASK_EVERY);
    expect(asked.map((options) => options.read)).toEqual([false, true, true]);
    expect(limitsOf(null, "claude-code", "Work")?.windows[0].percent).toBe(20);
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
    await askForSession("a");
    expect(asked.map((options) => [options.agent, options.configDir])).toEqual([
      ["codex", "~/.codex-work"],
      ["codex", "~/.codex-work"],
    ]);
    await askForSession("gone");
    expect(asked.length).toBe(2);
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
