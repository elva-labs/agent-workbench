import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IntegratedLimitWindow } from "$lib/core";
import {
  ageOf,
  figuresOf,
  heardLimits,
  limitsOf,
  planName,
  resetLimits,
  resetWhen,
  resetWords,
  shownPercent,
  toneOf,
  topFigure,
  type LimitsReport,
} from "$lib/limits.svelte";

const NOW = new Date(2026, 10, 16, 10, 0, 0).getTime();
const SECONDS = NOW / 1000;

function window(over: Partial<IntegratedLimitWindow> & Pick<IntegratedLimitWindow, "kind">): IntegratedLimitWindow {
  return { model: null, percent: 10, resetsAt: null, severity: null, ...over };
}

function report(over: Partial<LimitsReport> = {}): LimitsReport {
  return {
    type: "limits",
    agent: "claude-code",
    plan: "team",
    takenAt: SECONDS,
    windows: [window({ kind: "session", percent: 11 })],
    ...over,
  };
}

beforeEach(() => resetLimits());
afterEach(() => resetLimits());

describe("the store of limits", () => {
  it("keeps the newest report for an account, whichever session sent it", () => {
    heardLimits(null, "Work", report({ takenAt: SECONDS, windows: [window({ kind: "session", percent: 20 })] }));
    heardLimits(null, "Work", report({ takenAt: SECONDS + 60, windows: [window({ kind: "session", percent: 30 })] }));
    expect(limitsOf(null, "claude-code", "Work")?.windows[0].percent).toBe(30);
    // A report taken before the one held, arriving late, is let go.
    heardLimits(null, "Work", report({ takenAt: SECONDS + 10, windows: [window({ kind: "session", percent: 25 })] }));
    expect(limitsOf(null, "claude-code", "Work")?.windows[0].percent).toBe(30);
    // One taken at the same second is the later word.
    heardLimits(null, "Work", report({ takenAt: SECONDS + 60, windows: [window({ kind: "session", percent: 31 })] }));
    expect(limitsOf(null, "claude-code", "Work")?.windows[0].percent).toBe(31);
  });

  it("keeps each machine's, agent's and account's figures apart", () => {
    heardLimits(null, "Work", report({ windows: [window({ kind: "session", percent: 1 })] }));
    heardLimits(null, null, report({ windows: [window({ kind: "session", percent: 2 })] }));
    heardLimits(null, "Work", report({ agent: "codex", windows: [window({ kind: "session", percent: 3 })] }));
    heardLimits("ada@build", "Work", report({ windows: [window({ kind: "session", percent: 4 })] }));
    expect(limitsOf(null, "claude-code", "Work")?.windows[0].percent).toBe(1);
    expect(limitsOf(null, "claude-code", null)?.windows[0].percent).toBe(2);
    expect(limitsOf(null, "codex", "Work")?.windows[0].percent).toBe(3);
    expect(limitsOf("ada@build", "claude-code", "Work")?.windows[0].percent).toBe(4);
    expect(limitsOf("ada@build", "claude-code", null)).toBeNull();
    expect(limitsOf(null, "codex", null)).toBeNull();
  });

  it("holds a copy, so the event it came in can change without moving it", () => {
    const told = report();
    heardLimits(null, null, told);
    told.windows[0].percent = 99;
    expect(limitsOf(null, "claude-code", null)?.windows[0].percent).toBe(11);
  });
});

describe("what a report says", () => {
  it("orders the windows, session first, and names each", () => {
    const figures = figuresOf(
      report({
        windows: [
          window({ kind: "weeklyScoped", model: "Fable", percent: 52 }),
          window({ kind: "weekly", percent: 34 }),
          window({ kind: "session", percent: 11 }),
        ],
      }),
      NOW,
    );
    expect(figures.map((figure) => [figure.label, figure.name, figure.percent])).toEqual([
      ["5h", "Session (5 hours)", 11],
      ["Week", "Week", 34],
      ["Fable", "Week, Fable only", 52],
    ]);
  });

  it("rounds a share, and says 100 only when it is all used", () => {
    expect(shownPercent(11.4)).toBe(11);
    expect(shownPercent(33.5)).toBe(34);
    expect(shownPercent(99.6)).toBe(99);
    expect(shownPercent(100)).toBe(100);
    expect(shownPercent(-0.2)).toBe(0);
  });

  it("takes the agent's reading of how near its end a window is, else 80% and over", () => {
    expect(toneOf(window({ kind: "session", percent: 79.9 }))).toBe("normal");
    expect(toneOf(window({ kind: "session", percent: 80 }))).toBe("warn");
    // The agent's own reading stands over the share.
    expect(toneOf(window({ kind: "session", percent: 90, severity: "normal" }))).toBe("normal");
    expect(toneOf(window({ kind: "session", percent: 40, severity: "warning" }))).toBe("warn");
    expect(toneOf(window({ kind: "session", percent: 97, severity: "reached" }))).toBe("error");
    // At 100% it is at its end whatever the agent reads.
    expect(toneOf(window({ kind: "session", percent: 100, severity: "normal" }))).toBe("error");
    expect(toneOf(window({ kind: "session", percent: 100 }))).toBe("error");
  });

  it("draws a window whose reset time has passed as reset, not as it was", () => {
    const [passed, coming] = figuresOf(
      report({
        windows: [
          window({ kind: "session", percent: 100, severity: "reached", resetsAt: SECONDS - 60 }),
          window({ kind: "weekly", percent: 100, resetsAt: SECONDS + 3600 }),
        ],
      }),
      NOW,
    );
    expect(passed).toMatchObject({ percent: null, tone: "normal", reached: false });
    expect(coming).toMatchObject({ percent: 100, tone: "error", reached: true });
  });

  it("picks the window nearest its end to stand for the rest", () => {
    const pick = (windows: IntegratedLimitWindow[]) => topFigure(figuresOf(report({ windows }), NOW))?.kind;
    expect(
      pick([window({ kind: "session", percent: 11 }), window({ kind: "weekly", percent: 34 }), window({ kind: "weeklyScoped", model: "Fable", percent: 52 })]),
    ).toBe("weeklyScoped");
    // A window the agent reads as near its end beats a fuller one it does not.
    expect(
      pick([window({ kind: "session", percent: 60, severity: "warning" }), window({ kind: "weekly", percent: 85, severity: "normal" })]),
    ).toBe("session");
    // Reached beats near; level shares go to the first.
    expect(pick([window({ kind: "session", percent: 92 }), window({ kind: "weekly", percent: 100 })])).toBe("weekly");
    expect(pick([window({ kind: "session", percent: 40 }), window({ kind: "weekly", percent: 40 })])).toBe("session");
    // A window that has reset counts for nothing.
    expect(
      pick([window({ kind: "session", percent: 90, resetsAt: SECONDS - 1 }), window({ kind: "weekly", percent: 5 })]),
    ).toBe("weekly");
    expect(topFigure([])).toBeNull();
  });

  it("says when a window resets as a person would", () => {
    const at = (minutes: number) => NOW + minutes * 60_000;
    expect(resetWhen(at(40), NOW)).toBe("in 40 min");
    expect(resetWhen(at(130.5), NOW)).toBe("in 2 h 10 min");
    expect(resetWhen(at(180), NOW)).toBe("in 3 h");
    expect(resetWhen(NOW + 5_000, NOW)).toBe("in 1 min");
    const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    // Later today, tomorrow, and within the week by its day.
    const evening = new Date(2026, 10, 16, 21, 0).getTime();
    expect(resetWhen(evening, NOW)).toBe(`today ${time(evening)}`);
    const tomorrow = new Date(2026, 10, 17, 9, 0).getTime();
    expect(resetWhen(tomorrow, NOW)).toBe(`tomorrow ${time(tomorrow)}`);
    const thursday = new Date(2026, 10, 19, 9, 0).getTime();
    expect(resetWhen(thursday, NOW)).toBe(`Thursday ${time(thursday)}`);
    expect(resetWhen(thursday, NOW, true)).toBe(`Thu ${time(thursday)}`);
  });

  it("puts reached and reset into the popover's words", () => {
    const [session, weekly, scoped] = figuresOf(
      report({
        windows: [
          window({ kind: "session", percent: 38, resetsAt: SECONDS + 3 * 3600 + 5 * 60 + 30 }),
          window({ kind: "weekly", percent: 100, resetsAt: SECONDS + 40 * 60 + 30 }),
          window({ kind: "weeklyScoped", model: "Fable", percent: 64, resetsAt: SECONDS - 600 }),
        ],
      }),
      NOW,
    );
    expect(resetWords(session, NOW)).toBe("resets in 3 h 5 min");
    expect(resetWords(weekly, NOW)).toBe("Reached, resets in 40 min");
    expect(resetWords(scoped, NOW)).toMatch(/^Reset at /);
  });

  it("says how old the figures are, and from ten minutes that they are old", () => {
    expect(ageOf(SECONDS - 20, NOW)).toEqual({ stale: false, short: "now", long: "just now" });
    expect(ageOf(SECONDS - 4 * 60, NOW)).toMatchObject({ stale: false, long: "4 min ago" });
    expect(ageOf(SECONDS - 10 * 60, NOW)).toMatchObject({ stale: true, short: "10 min" });
    expect(ageOf(SECONDS - 3 * 3600, NOW)).toMatchObject({ stale: true, short: "3 h", long: "3 hours ago" });
    expect(ageOf(SECONDS - 3600, NOW).long).toBe("an hour ago");
    expect(ageOf(SECONDS - 2 * 86_400, NOW)).toMatchObject({ short: "2 d", long: "2 days ago" });
    // Figures from a clock a little ahead are new, not from the future.
    expect(ageOf(SECONDS + 30, NOW).long).toBe("just now");
  });

  it("names a plan in plain words, and one it does not know as the agent wrote it", () => {
    expect(planName("team")).toBe("Team");
    expect(planName("max")).toBe("Max");
    expect(planName("plus")).toBe("Plus");
    expect(planName("max_20x")).toBe("max_20x");
    expect(planName(null)).toBeNull();
    expect(planName(" ")).toBeNull();
  });
});
