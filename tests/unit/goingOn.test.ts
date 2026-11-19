import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoingOn, GoingOnOptions } from "$lib/core";
import type { Session } from "$lib/sessions.svelte";

let answer: GoingOn = { context: null, idle: null, goesOn: false, briefing: null };
const asked: GoingOnOptions[] = [];

vi.mock("$lib/core", () => ({
  core: () => ({
    async goingOn(options: GoingOnOptions) {
      asked.push(options);
      return answer;
    },
  }),
}));
vi.mock("$lib/accounts.svelte", () => ({ dirFor: () => undefined }));

const {
  askWhole,
  briefingBack,
  briefingFor,
  identified,
  lineageOf,
  onWentOn,
  resetGoingOn,
  takeUp,
  tokensText,
  wentOn,
  wentOnFrom,
} = await import("$lib/goingOn.svelte");

function row(fields: Partial<Session> = {}): Session {
  return {
    key: "row-1",
    agent: "claude-code",
    project: "/p",
    startIn: null,
    account: null,
    token: "token-1",
    resumedFrom: "old-id",
    ...fields,
  } as Session;
}

const COLD: GoingOn = { context: 967_000, idle: 10_800, goesOn: true, briefing: "BRIEFING" };

beforeEach(() => {
  resetGoingOn();
  localStorage.clear();
  asked.length = 0;
  answer = { context: 40_000, idle: 60, goesOn: false, briefing: null };
  onWentOn(null);
});

describe("taking a conversation up again", () => {
  it("resumes a warm or small one whole, and starts a cold and large one fresh from its briefing, once", async () => {
    expect(await takeUp(row())).toBe("old-id");
    expect(wentOn("row-1")).toBeNull();
    expect(asked[0]).toMatchObject({ agent: "claude-code", project: "/p", session: "old-id", token: "token-1" });

    answer = COLD;
    expect(await takeUp(row())).toBeNull();
    expect(wentOn("row-1")).toEqual({ from: "old-id", context: 967_000, briefing: "BRIEFING" });
    expect(briefingFor("row-1")).toBe("BRIEFING");
    expect(briefingFor("row-1")).toBeNull();
    // A first message that never reached the agent takes it back.
    briefingBack("row-1", "BRIEFING");
    expect(briefingFor("row-1")).toBe("BRIEFING");
  });

  it("asks nothing for a new conversation or another agent's, and resumes whole once the user asks", async () => {
    answer = COLD;
    expect(await takeUp(row({ resumedFrom: null }))).toBeNull();
    expect(await takeUp(row({ agent: "codex" }))).toBe("old-id");
    expect(asked).toHaveLength(0);
    askWhole("row-1");
    expect(await takeUp(row())).toBe("old-id");
    expect(asked).toHaveLength(0);
    // Only the next start: the one after is judged again.
    expect(await takeUp(row())).toBeNull();
  });

  it("keeps the fresh conversation as going on from the old one, for its messages and its old id", async () => {
    const moved: [string, string][] = [];
    onWentOn((from, to) => moved.push([from, to]));
    answer = COLD;
    await takeUp(row());
    identified("row-1", "new-id");
    expect(moved).toEqual([["old-id", "new-id"]]);
    expect(lineageOf("new-id")).toEqual(["old-id", "new-id"]);
    expect(JSON.parse(localStorage.getItem("workbench.wentOn") ?? "{}")).toEqual({ "new-id": "old-id" });
    // Again, from the fresh one.
    await takeUp(row({ resumedFrom: "new-id" }));
    identified("row-1", "newer-id");
    expect(lineageOf("newer-id")).toEqual(["old-id", "new-id", "newer-id"]);
    expect(wentOnFrom("old-id")).toBe("newer-id");
    expect(wentOnFrom("old-i")).toBe("newer-id");
    expect(wentOnFrom("other")).toBeNull();
  });

  it("says a context in tokens as the menu does", () => {
    expect(tokensText(412_345)).toBe("412k tokens");
    expect(tokensText(1_000_000)).toBe("1M tokens");
    expect(tokensText(1_250_000)).toBe("1.3M tokens");
  });
});
