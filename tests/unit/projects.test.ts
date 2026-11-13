import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: unknown[] = [];

vi.mock("$lib/core", () => ({
  core: () => ({
    settingsSet: async (change: unknown) => {
      sent.push(change);
      return change;
    },
    transcripts: async () => [],
    kill: async () => {},
    projectInfo: async (path: string) => ({ path, name: path, repository: path, isGit: true }),
    setWindowTitle: async () => {},
  }),
}));

import {
  adoptInactiveAfter,
  inactiveAfterSettings,
  isActive,
  lastUsed,
  loadUsed,
  projects,
  resetProjects,
  setInactiveAfter,
  sortProjects,
  splitProjects,
  touch,
} from "$lib/projects.svelte";
import {
  byChange,
  create,
  lastChanged,
  modelLabel,
  moreLabel,
  nextNeedingYou,
  reopened,
  reset as resetSessions,
  sessions,
  since,
  started,
} from "$lib/sessions.svelte";
import { activate, goTo, reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 13, 12);

const entry = (id: string, modifiedMs: number) => ({
  id,
  title: null,
  modified: Math.floor(modifiedMs / 1000),
  size: 1,
  cwd: null,
  agent: "claude-code" as const,
  account: null,
});

beforeEach(() => {
  localStorage.clear();
  sent.length = 0;
  resetSessions();
  resetWorkspace();
  resetProjects();
});

describe("last used", () => {
  it("is nothing for a project nothing dates", () => {
    expect(lastUsed("/repo")).toBeNull();
  });

  it("is the latest of being brought forward, a row changing, and a transcript written", () => {
    touch("/repo", NOW - 5 * DAY);
    expect(lastUsed("/repo")).toBe(NOW - 5 * DAY);

    sessions.history["/repo"] = [entry("b", NOW - 2 * DAY), entry("a", NOW - 9 * DAY)];
    expect(lastUsed("/repo")).toBe(NOW - 2 * DAY);

    const live = create("/repo");
    live.changedAt = NOW - DAY;
    expect(lastUsed("/repo")).toBe(NOW - DAY);
  });

  // A row left from the last quit is drawn again at the start, which is no
  // use of the project: its transcript says when it was worked in.
  it("does not take a row left from the last quit as use", () => {
    const left = reopened("/repo", "a", "claude-code", null, null, null);
    left.changedAt = NOW;
    expect(lastUsed("/repo")).toBeNull();
  });

  it("is stamped when a project is brought forward, and kept between runs", () => {
    workspace.open.push({ path: "/repo", name: "repo", repository: "/repo", isGit: true });
    activate("/repo");
    const at = projects.used["/repo"];
    expect(at).toBeGreaterThan(0);

    projects.used = {};
    loadUsed();
    expect(projects.used["/repo"]).toBe(at);

    localStorage.setItem("workbench.used", "not json");
    projects.used = {};
    loadUsed();
    expect(projects.used).toEqual({});

    localStorage.setItem("workbench.used", JSON.stringify({ "/a": 5, "/b": "soon" }));
    loadUsed();
    expect(projects.used).toEqual({ "/a": 5 });
  });
});

describe("active and inactive", () => {
  it("keeps a project active within the span, and folds it after", () => {
    touch("/repo", NOW - 6 * DAY);
    expect(isActive("/repo", null, NOW)).toBe(true);
    expect(isActive("/repo", null, NOW + 2 * DAY)).toBe(false);

    projects.inactiveAfter = "day";
    expect(isActive("/repo", null, NOW)).toBe(false);
    projects.inactiveAfter = "month";
    expect(isActive("/repo", null, NOW)).toBe(true);
  });

  it("keeps a project with a live or unread session active, however long ago it was used", () => {
    touch("/repo", NOW - 60 * DAY);
    expect(isActive("/repo", null, NOW)).toBe(false);

    const live = create("/repo");
    started(live.key, "pty-1", "s-1");
    live.changedAt = NOW - 60 * DAY;
    expect(isActive("/repo", null, NOW)).toBe(true);

    live.status = "exited";
    expect(isActive("/repo", null, NOW)).toBe(false);
    live.unread = true;
    expect(isActive("/repo", null, NOW)).toBe(true);
  });

  it("keeps the project on screen active, and every project with the span at never", () => {
    expect(isActive("/repo", "/repo", NOW)).toBe(true);
    expect(isActive("/repo", null, NOW)).toBe(false);
    projects.inactiveAfter = "never";
    expect(isActive("/repo", null, NOW)).toBe(true);
  });

  it("splits the projects, each half in the order chosen", () => {
    touch("/b", NOW - DAY);
    touch("/a", NOW - 2 * DAY);
    touch("/old-b", NOW - 20 * DAY);
    touch("/old-a", NOW - 30 * DAY);
    const paths = ["/old-a", "/a", "/b", "/never", "/old-b"];

    expect(splitProjects(paths, null, "used", NOW)).toEqual({
      active: ["/b", "/a"],
      inactive: ["/old-b", "/old-a", "/never"],
    });
    expect(splitProjects(paths, null, "name", NOW)).toEqual({
      active: ["/a", "/b"],
      inactive: ["/never", "/old-a", "/old-b"],
    });
  });

  // Two checkouts of the same name sort by their paths, so the order
  // never flickers between them.
  it("breaks a tie by path", () => {
    expect(sortProjects(["/work/app", "/spike/app"], "name")).toEqual(["/spike/app", "/work/app"]);
    expect(sortProjects(["/work/app", "/spike/app"], "used")).toEqual(["/spike/app", "/work/app"]);
  });
});

describe("the span setting", () => {
  it("is a week to begin with, and takes only a span it knows", () => {
    expect(inactiveAfterSettings()).toEqual({ inactiveAfter: "week" });
    adoptInactiveAfter("never");
    expect(projects.inactiveAfter).toBe("never");
    adoptInactiveAfter("fortnight");
    expect(projects.inactiveAfter).toBe("week");
  });

  it("is sent to the core when changed, and only then", () => {
    setInactiveAfter("week");
    expect(sent).toEqual([]);
    setInactiveAfter("month");
    expect(sent).toEqual([{ inactiveAfter: "month" }]);
    expect(projects.inactiveAfter).toBe("month");
  });
});

// The chord that goes to the next session needing you reaches a session
// in any project, and going there brings its project forward and in use.
describe("the next session that needs you", () => {
  it("is found whatever the project's last use, and brings it forward", () => {
    workspace.open.push(
      { path: "/here", name: "here", repository: "/here", isGit: true },
      { path: "/old", name: "old", repository: "/old", isGit: true },
    );
    activate("/here");
    touch("/old", Date.now() - 40 * DAY);
    const asking = create("/old");
    started(asking.key, "pty-1", "s-1");
    const own = create("/here");
    started(own.key, "pty-2", "s-2");
    asking.needs = "permission";
    asking.changedAt = Date.now() - 40 * DAY;

    expect(isActive("/old", workspace.active)).toBe(true);
    expect(nextNeedingYou()?.key).toBe(asking.key);
    goTo(asking.key);
    expect(workspace.active).toBe("/old");
    expect(Date.now() - (lastUsed("/old") ?? 0)).toBeLessThan(1000);
  });
});

describe("since", () => {
  it("says when, as short as a row's end can", () => {
    const at = new Date(2026, 10, 13, 12).getTime();
    expect(since(at - 20_000, at)).toBe("now");
    expect(since(at - 4 * 60_000, at)).toBe("4m");
    expect(since(at - 90 * 60_000, at)).toBe("1h");
    expect(since(at - 3 * DAY, at)).toBe("Tue");
    expect(since(at - 15 * DAY, at)).toBe("2w");
    expect(since(at - 45 * DAY, at)).toBe("1mo");
    expect(since(at - 400 * DAY, at)).toBe("1y");
    expect(since(at + 5000, at)).toBe("now");
  });
});

describe("the order of a project's rows", () => {
  it("is the latest change first, a row left from the last quit by its transcript", () => {
    const first = create("/repo");
    const second = create("/repo");
    const left = reopened("/repo", "t-1", "claude-code", null, null, null);
    first.changedAt = NOW - 1000;
    second.changedAt = NOW - 5000;
    left.changedAt = NOW;
    sessions.history["/repo"] = [entry("t-1", NOW - DAY)];
    expect(byChange([first, second, left]).map((row) => row.key)).toEqual([first.key, second.key, left.key]);
    expect(lastChanged(left)).toBe(NOW - DAY);

    second.changedAt = NOW;
    expect(byChange([first, second, left])[0].key).toBe(second.key);
  });
});

describe("what a row says", () => {
  it("names a model the way it is said", () => {
    expect(modelLabel("opus")).toBe("Opus");
    expect(modelLabel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelLabel("claude-opus-4-1-20250805")).toBe("Opus 4.1");
    expect(modelLabel("gpt-5-codex")).toBe("gpt-5-codex");
  });

  it("counts the folded tail by how long ago its oldest changed", () => {
    expect(moreLabel(3, NOW - 3600_000, NOW)).toBe("3 more from today");
    expect(moreLabel(8, NOW - 3 * DAY, NOW)).toBe("8 more from this week");
    expect(moreLabel(2, NOW - 12 * DAY, NOW)).toBe("2 more from this month");
    expect(moreLabel(9, NOW - 90 * DAY, NOW)).toBe("9 more");
  });
});
