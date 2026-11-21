import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "$lib/sessions.svelte";

const logged: unknown[][] = [];

vi.mock("$lib/core", () => ({
  core: () => ({
    async usageLog(...args: unknown[]) {
      logged.push(args);
    },
  }),
}));
vi.mock("$lib/accounts.svelte", () => ({ dirFor: (account: string | null) => (account === null ? undefined : `/dirs/${account}`) }));
vi.mock("$lib/remote.svelte", () => ({ hostOf: () => null }));

const { logUsage } = await import("$lib/usageLog");
const { heardLimits, resetLimits } = await import("$lib/limits.svelte");

function row(fields: Partial<Session> = {}): Session {
  return {
    key: "row-1",
    id: "sid-1",
    agent: "claude-code",
    kind: "terminal",
    model: "opus",
    project: "/p",
    startIn: null,
    account: null,
    token: "token-1",
    ...fields,
  } as Session;
}

beforeEach(() => {
  logged.length = 0;
  resetLimits();
});

describe("the usage log", () => {
  it("names a terminal Claude Code turn's conversation, for the core to read its tokens", () => {
    logUsage(row({ startIn: "/p/.worktrees/x", account: "work" }), "turn");
    expect(logged).toEqual([
      [
        "/p",
        "token-1",
        { kind: "turn", id: "sid-1", agent: "claude-code", surface: "terminal", model: "opus", fiveHour: null },
        { session: "sid-1", cwd: "/p/.worktrees/x", configDir: "/dirs/work" },
      ],
    ]);
  });

  it("names the model the agent says the session runs on, where it said one", () => {
    logUsage(row({ agent: "codex", kind: "integrated", model: null, runsOn: "gpt-6.1-sol" }), "start");
    expect(logged[0][2]).toMatchObject({ agent: "codex", model: "gpt-6.1-sol" });
  });

  it("gives what the window knows of other events, with the account's five-hour figure", () => {
    heardLimits(null, null, {
      type: "limits",
      agent: "claude-code",
      plan: null,
      readAt: 100,
      takenAt: 120,
      windows: [
        { kind: "weekly", model: null, percent: 40, resetsAt: null, severity: null },
        { kind: "session", model: null, percent: 12, resetsAt: null, severity: null },
      ],
    });
    logUsage(row({ kind: "integrated" }), "turn", { tokens: { inputTokens: 5 }, context: 9000 });
    logUsage(row(), "wake", { reports: 2 });
    expect(logged).toEqual([
      [
        "/p",
        "token-1",
        {
          kind: "turn",
          id: "sid-1",
          agent: "claude-code",
          surface: "integrated",
          model: "opus",
          fiveHour: { percent: 12, takenAt: 120 },
          tokens: { inputTokens: 5 },
          context: 9000,
        },
        undefined,
      ],
      [
        "/p",
        "token-1",
        { kind: "wake", id: "sid-1", agent: "claude-code", surface: "terminal", model: "opus", fiveHour: { percent: 12, takenAt: 120 }, reports: 2 },
        undefined,
      ],
    ]);
  });
});
