import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountLimitsOptions, IntegratedLimitWindow } from "$lib/core";
import type { LimitsReport } from "$lib/limits.svelte";
import type { Session } from "$lib/sessions.svelte";

const rows = new Map<string, Session>();
const parents = new Map<string, string>();
const asked: AccountLimitsOptions[] = [];
const persisted: unknown[] = [];
/** What a read of the usage answers with, or null for a read that fails. */
let read: (() => LimitsReport | null) | null = null;

vi.mock("$lib/core", () => ({
  core: () => ({
    async accountLimits(options: AccountLimitsOptions) {
      asked.push(options);
      return read === null ? null : read();
    },
  }),
}));
vi.mock("$lib/accounts.svelte", () => ({ dirFor: (account: string | null) => account ?? undefined }));
vi.mock("$lib/remote.svelte", () => ({ hostOf: () => null }));
vi.mock("$lib/persist", () => ({ persist: (change: unknown) => persisted.push(change) }));
vi.mock("$lib/sessions.svelte", () => ({ byKey: (key: string) => rows.get(key) ?? null }));

const {
  GIVE_UP_AFTER,
  GO_ON,
  MARGIN,
  adoptAutoResume,
  autoResume,
  autoResumeSettings,
  choose,
  followed,
  isOn,
  limitEnded,
  look,
  offered,
  parentsFrom,
  resetAutoResume,
  resumesAt,
  resumesWords,
  runOver,
  setHands,
  settle,
  turnMoved,
} = await import("$lib/autoResume.svelte");
const { clock, heardLimits, resetLimits } = await import("$lib/limits.svelte");

/** 14:00 on a day, and the reset an hour later, in seconds. */
const NOW = new Date(2030, 0, 2, 14, 0, 0).getTime();
const RESET = NOW / 1000 + 3600;

function row(fields: Partial<Session> = {}): Session {
  const session = {
    key: "a",
    agent: "claude-code",
    kind: "integrated",
    project: "/p",
    account: null,
    status: "running",
    working: false,
    needs: null,
    ...fields,
  } as Session;
  rows.set(session.key, session);
  return session;
}

function session(percent: number, resetsAt: number | null, severity: IntegratedLimitWindow["severity"] = null) {
  return { kind: "session" as const, model: null, percent, resetsAt, severity };
}

function report(readAt: number, windows: IntegratedLimitWindow[]): LimitsReport {
  return { type: "limits", agent: "claude-code", plan: "max", readAt, takenAt: readAt, windows };
}

/** The account's figures hold a session window, used up until the reset. */
function withWindow(account: string | null = null) {
  heardLimits(null, account, report(NOW / 1000, [session(100, RESET, "reached")]));
}

const went: { key: string; at: number }[] = [];
const sent: { key: string; text: string; lost: () => void }[] = [];
/** Whether a message of the user's waits, and what runs while the run
    starts again. */
let written = false;
let meanwhile: () => void = () => {};
const said: { key: string; text: string; warning: boolean }[] = [];
let goes = true;

beforeEach(() => {
  resetAutoResume();
  resetLimits();
  rows.clear();
  parents.clear();
  asked.length = 0;
  persisted.length = 0;
  went.length = 0;
  sent.length = 0;
  said.length = 0;
  goes = true;
  written = false;
  meanwhile = () => {};
  read = null;
  parentsFrom((session) => rows.get(parents.get(session.key) ?? "") ?? null);
  setHands({
    goOn: async (key, at) => {
      went.push({ key, at });
      meanwhile();
      return goes;
    },
    send: (key, text, lost) => {
      sent.push({ key, text, lost });
      return true;
    },
    written: () => written,
    say: (key, text, warning) => {
      said.push({ key, text, warning });
    },
  });
});

afterEach(() => {
  resetAutoResume();
  setHands(null);
});

/** The usage read after the reset shows the session window open. */
function opens() {
  read = () => report(RESET + 61, [session(2, RESET + 5 * 3600, "normal")]);
}

const AFTER = RESET * 1000 + MARGIN;

describe("where going on by itself is offered", () => {
  it("is offered to a Claude Code conversation whose account has a session window, and to no other", () => {
    const one = row();
    expect(offered(one)).toBe(false);
    withWindow();
    expect(offered(one)).toBe(true);
    expect(offered(row({ key: "t", kind: "terminal" }))).toBe(false);
    expect(offered(row({ key: "c", agent: "codex" }))).toBe(false);
    // An account whose figures hold only a week has no such window.
    heardLimits(null, "work", report(NOW / 1000, [{ kind: "weekly", model: null, percent: 10, resetsAt: RESET, severity: null }]));
    expect(offered(row({ key: "w", account: "work" }))).toBe(false);
  });

  it("is off until chosen, and the choice is kept for the next new conversation", () => {
    withWindow();
    const one = row();
    settle("a");
    expect(isOn(one)).toBe(false);
    expect(autoResumeSettings()).toEqual({ autoResume: false });
    choose("a", true);
    expect(isOn(one)).toBe(true);
    expect(persisted).toEqual([{ autoResume: true }]);
    // The next conversation takes it as its run starts, and one already
    // running keeps what it has when another is switched.
    const next = row({ key: "b" });
    settle("b");
    expect(isOn(next)).toBe(true);
    choose("a", false);
    expect(isOn(one)).toBe(false);
    expect(isOn(next)).toBe(true);
    expect(autoResumeSettings()).toEqual({ autoResume: false });
    adoptAutoResume("yes");
    expect(autoResume.next).toBe(false);
    adoptAutoResume(true);
    expect(autoResume.next).toBe(true);
  });

  it("a session another started goes by its starter's choice, and loses it with the window", () => {
    withWindow();
    const starter = row();
    const started = row({ key: "k" });
    parents.set("k", "a");
    expect(followed(started)?.key).toBe("a");
    expect(followed(starter)).toBeNull();
    choose("k", true);
    choose("a", false);
    expect(isOn(started)).toBe(false);
    choose("a", true);
    expect(isOn(started)).toBe(true);
    // Moved to an account without the window, it is offered nothing.
    started.account = "api";
    expect(isOn(started)).toBe(false);
  });
});

describe("what is waited for", () => {
  it("waits for the session window's reset after a turn that limit cut short, and says when", () => {
    withWindow();
    const one = row();
    choose("a", true);
    expect(resumesAt(one)).toBeNull();
    limitEnded("a", "session", RESET);
    expect(resumesAt(one)).toBe(RESET * 1000);
    expect(resumesWords(one)).toBe(`resumes ${clock(RESET * 1000)}`);
  });

  it("never waits for a week's limit, a limit with no time, or with the choice off", () => {
    withWindow();
    const one = row();
    choose("a", true);
    for (const window of ["weekly", "weeklyScoped", null]) {
      limitEnded("a", window, RESET);
      expect(resumesAt(one)).toBeNull();
    }
    limitEnded("a", "session", null);
    expect(resumesAt(one)).toBeNull();
    choose("a", false);
    limitEnded("a", "session", RESET);
    expect(resumesAt(one)).toBeNull();
    expect(autoResume.stopped.a).toBeUndefined();
    // Turned on while that limit holds, nothing is waited for.
    choose("a", true);
    expect(resumesAt(one)).toBeNull();
  });

  it("turning it off ends the wait for good, for the session and for those it started", async () => {
    withWindow();
    opens();
    const one = row();
    const started = row({ key: "k" });
    parents.set("k", "a");
    choose("a", true);
    limitEnded("a", "session", RESET);
    limitEnded("k", "session", RESET);
    expect(resumesAt(started)).toBe(RESET * 1000);
    choose("a", false);
    expect(autoResume.stopped.a).toBeUndefined();
    expect(autoResume.stopped.k).toBeUndefined();
    // Turned on again once the reset has passed, nothing goes.
    choose("a", true);
    expect(resumesAt(one)).toBeNull();
    await look(AFTER);
    expect(asked).toHaveLength(0);
    expect(went).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("stops waiting when a turn begins, the run ends, the row stops or the account has no window", async () => {
    withWindow();
    withWindow("work");
    opens();
    const one = row();
    choose("a", true);
    limitEnded("a", "session", RESET);
    turnMoved("a", true);
    expect(resumesAt(one)).toBeNull();
    limitEnded("a", "session", RESET);
    runOver("a");
    expect(resumesAt(one)).toBeNull();
    // A row that no longer runs is waited for no more, at once.
    limitEnded("a", "session", RESET);
    one.status = "exited";
    expect(resumesAt(one)).toBeNull();
    await look(AFTER);
    expect(autoResume.stopped.a).toBeUndefined();
    // A row that is gone, the same.
    row({ key: "g" });
    choose("g", true);
    limitEnded("g", "session", RESET);
    rows.delete("g");
    await look(AFTER);
    expect(autoResume.stopped.g).toBeUndefined();
    // Moved to an account with no session window, nothing goes.
    const moved = row({ key: "m", account: "work" });
    choose("m", true);
    limitEnded("m", "session", RESET);
    expect(resumesAt(moved)).toBe(RESET * 1000);
    moved.account = "api";
    expect(resumesAt(moved)).toBeNull();
    await look(AFTER);
    expect(autoResume.stopped.m).toBeUndefined();
    // Moved back, what it waited for is not taken up again.
    moved.account = "work";
    expect(resumesAt(moved)).toBeNull();
    await look(AFTER);
    expect(asked).toHaveLength(0);
    expect(went).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe("going on once the limit resets", () => {
  it("asks nothing before the reset and its margin, then reads the usage and goes on once", async () => {
    withWindow();
    opens();
    const one = row({ account: "work" });
    withWindow("work");
    choose("a", true);
    limitEnded("a", "session", RESET);
    await look(RESET * 1000);
    await look(AFTER - 1);
    expect(asked).toHaveLength(0);
    await look(AFTER);
    // The figures are asked for as they stand since the reset.
    expect(asked).toEqual([
      { project: "/p", agent: "claude-code", configDir: "work", read: true, worked: true, since: RESET },
    ]);
    expect(went).toEqual([{ key: "a", at: RESET * 1000 }]);
    expect(sent).toMatchObject([{ key: "a", text: GO_ON }]);
    expect(said).toHaveLength(0);
    expect(resumesAt(one)).toBeNull();
    await look(AFTER + 60_000);
    expect(sent).toHaveLength(1);
  });

  it("sends nothing while the window reads as used up, and waits for the later reset it names", async () => {
    withWindow();
    const one = row();
    choose("a", true);
    limitEnded("a", "session", RESET);
    const later = RESET + 1800;
    read = () => report(RESET + 61, [session(100, later, "reached")]);
    await look(AFTER);
    expect(went).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(resumesAt(one)).toBe(later * 1000);
    // A window used up that names no later time is not waited for.
    read = () => report(later + 61, [session(100, null, "reached")]);
    await look(later * 1000 + MARGIN);
    expect(sent).toHaveLength(0);
    expect(resumesAt(one)).toBeNull();
    expect(said).toEqual([
      { key: "a", text: "Did not go on by itself: the usage limit still holds.", warning: true },
    ]);
  });

  it("sends nothing on figures from before the reset, and gives up saying so after a while", async () => {
    withWindow();
    const one = row();
    choose("a", true);
    limitEnded("a", "session", RESET);
    // A read that fails leaves the figures taken before the reset.
    await look(AFTER);
    await look(AFTER + 60_000);
    expect(asked).toHaveLength(2);
    expect(went).toHaveLength(0);
    expect(resumesAt(one)).toBe(RESET * 1000);
    await look(RESET * 1000 + GIVE_UP_AFTER);
    expect(resumesAt(one)).toBeNull();
    expect(sent).toHaveLength(0);
    expect(said).toEqual([
      { key: "a", text: "Did not go on by itself: the usage could not be read after the limit reset.", warning: true },
    ]);
  });

  it("goes on only from the notes: where the run cannot start again from them it says so and sends nothing", async () => {
    withWindow();
    opens();
    const one = row();
    choose("a", true);
    limitEnded("a", "session", RESET);
    goes = false;
    await look(AFTER);
    expect(went).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect(resumesAt(one)).toBeNull();
    expect(said[0].text).toBe(
      "Did not go on by itself: the conversation could not be started again from its notes.",
    );
  });

  it("sends no line where the choice was turned off, or the user wrote, while the run started again", async () => {
    withWindow();
    opens();
    row();
    choose("a", true);
    limitEnded("a", "session", RESET);
    meanwhile = () => choose("a", false);
    await look(AFTER);
    expect(went).toHaveLength(1);
    expect(sent).toHaveLength(0);
    // The user's own message waits for the fresh run: it is the turn.
    const other = row({ key: "b" });
    choose("b", true);
    limitEnded("b", "session", RESET);
    meanwhile = () => {
      written = true;
    };
    await look(AFTER);
    expect(went).toHaveLength(2);
    expect(sent).toHaveLength(0);
    // That turn was not the one try: the limit refusing it is waited for.
    turnMoved("b", true);
    limitEnded("b", "session", RESET + 5 * 3600);
    expect(resumesAt(other)).toBe((RESET + 5 * 3600) * 1000);
    expect(said).toHaveLength(0);
  });

  it("a line that never reached the agent was no try", async () => {
    withWindow();
    opens();
    const one = row();
    choose("a", true);
    limitEnded("a", "session", RESET);
    await look(AFTER);
    sent[0].lost();
    limitEnded("a", "session", RESET + 5 * 3600);
    expect(resumesAt(one)).toBe((RESET + 5 * 3600) * 1000);
    expect(said).toHaveLength(0);
  });

  it("leaves a row alone that works or asks, and one a turn began in while the usage was read", async () => {
    withWindow();
    opens();
    const one = row();
    choose("a", true);
    limitEnded("a", "session", RESET);
    one.working = true;
    await look(AFTER);
    one.working = false;
    one.needs = "permission";
    await look(AFTER);
    expect(asked).toHaveLength(0);
    one.needs = null;
    // The user's own message starts a turn while the usage is read.
    read = () => {
      turnMoved("a", true);
      return report(RESET + 61, [session(2, RESET + 5 * 3600, "normal")]);
    };
    await look(AFTER);
    expect(asked).toHaveLength(1);
    expect(went).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("tries once: the turn it sent, cut short by the limit too, is said and not waited for", async () => {
    withWindow();
    opens();
    const one = row();
    choose("a", true);
    limitEnded("a", "session", RESET);
    await look(AFTER);
    expect(sent).toHaveLength(1);
    turnMoved("a", true);
    limitEnded("a", "session", RESET + 5 * 3600);
    expect(resumesAt(one)).toBeNull();
    expect(said).toEqual([
      {
        key: "a",
        text: "The usage limit stopped it again. It does not go on by itself a second time.",
        warning: true,
      },
    ]);
    // A message of the user's refused after that is waited for like any.
    turnMoved("a", true);
    limitEnded("a", "session", RESET + 5 * 3600);
    expect(resumesAt(one)).toBe((RESET + 5 * 3600) * 1000);
  });

  it("a turn it sent that ends any other way leaves the next limit to be waited for", async () => {
    withWindow();
    opens();
    const one = row();
    choose("a", true);
    limitEnded("a", "session", RESET);
    await look(AFTER);
    turnMoved("a", true);
    turnMoved("a", false);
    turnMoved("a", true);
    limitEnded("a", "session", RESET + 5 * 3600);
    expect(resumesAt(one)).toBe((RESET + 5 * 3600) * 1000);
    expect(said).toHaveLength(0);
  });
});
