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
  lastActive,
  lastUsed,
  loadUsed,
  onScreen,
  projects,
  resetProjects,
  setInactiveAfter,
  sortProjects,
  splitProjects,
  steady,
  touch,
} from "$lib/projects.svelte";
import { conductor, resetConductor } from "$lib/conductor.svelte";
import "$lib/orchestrator.svelte";
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
import { activate, close, goTo, openPath, reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

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
  resetConductor();
});

describe("last used", () => {
  it("is nothing for a project nothing dates", () => {
    expect(lastUsed("/repo")).toBeNull();
  });

  // The order is the user's: an agent at work in a project says it is in
  // use, and moves nothing.
  it("is the user's own record, else the newest transcript, never a row changing", () => {
    sessions.history["/repo"] = [entry("b", NOW - 2 * DAY), entry("a", NOW - 9 * DAY)];
    expect(lastUsed("/repo")).toBe(NOW - 2 * DAY);

    touch("/repo", NOW - 5 * DAY);
    expect(lastUsed("/repo")).toBe(NOW - 5 * DAY);

    const live = create("/repo");
    live.changedAt = NOW - DAY;
    expect(lastUsed("/repo")).toBe(NOW - 5 * DAY);
  });

  it("is outlived by the project's activity: a row changing, or a transcript written", () => {
    touch("/repo", NOW - 5 * DAY);
    sessions.history["/repo"] = [entry("b", NOW - 2 * DAY)];
    expect(lastActive("/repo")).toBe(NOW - 2 * DAY);
    const live = create("/repo");
    live.changedAt = NOW - DAY;
    expect(lastActive("/repo")).toBe(NOW - DAY);
  });

  // A row left from the last quit is drawn again at the start, which is no
  // use of the project: its transcript says when it was worked in.
  it("does not take a row left from the last quit as activity", () => {
    const left = reopened("/repo", "a", "claude-code", null, null, null);
    left.changedAt = NOW;
    expect(lastActive("/repo")).toBeNull();
  });

  // The record holds no project once it is closed, so it does not grow
  // with every project ever opened; a project still on its way in keeps
  // its own.
  it("forgets a project once it is closed, and only then", () => {
    workspace.open.push(
      { path: "/a", name: "a", repository: "/a", isGit: true },
      { path: "/b", name: "b", repository: "/b", isGit: true },
    );
    touch("/a", NOW - DAY);
    touch("/b", NOW - 2 * DAY);
    touch("/arriving", NOW - 3 * DAY);
    close("/a");
    expect(projects.used).toEqual({ "/b": NOW - 2 * DAY, "/arriving": NOW - 3 * DAY });
    expect(JSON.parse(localStorage.getItem("workbench.used")!)).not.toHaveProperty("/a");
  });

  // Only what the user does stamps a project: the window or an agent
  // bringing one forward does not.
  it("is stamped by the user alone, and kept between runs", async () => {
    workspace.open.push(
      { path: "/repo", name: "repo", repository: "/repo", isGit: true },
      { path: "/other", name: "other", repository: "/other", isGit: true },
    );
    activate("/repo");
    expect(projects.used).toEqual({});

    const row = create("/other");
    started(row.key, "pty-1", "s-1");
    goTo(row.key);
    const at = projects.used["/other"];
    expect(Date.now() - at).toBeLessThan(1000);
    expect(projects.used["/repo"]).toBeUndefined();
    await openPath("/repo");
    expect(projects.used["/repo"]).toBeGreaterThanOrEqual(at);

    projects.used = {};
    loadUsed();
    expect(projects.used["/other"]).toBe(at);

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
    for (const path of paths) sessions.history[path] = [];

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

// A session an orchestrator started hangs under it, in the orchestrator's
// project: that is where it is drawn, and where it counts.
describe("a session hanging under its starter", () => {
  function hang(project: string) {
    const starter = create("/here");
    started(starter.key, "pty-1", "starter-1");
    const kid = create(project);
    started(kid.key, "pty-2", "kid-1");
    conductor.startedBy[kid.key] = "starter-1";
    return { starter, kid };
  }

  it("keeps the project it is drawn under active, not the one it runs in", () => {
    touch("/here", NOW - 60 * DAY);
    touch("/there", NOW - 60 * DAY);
    const { starter, kid } = hang("/there");
    kid.changedAt = NOW;
    sessions.history["/there"] = [entry("kid-1", NOW)];

    expect(isActive("/there", null, NOW)).toBe(false);
    expect(lastActive("/there")).toBe(NOW - 60 * DAY);
    expect(isActive("/here", null, NOW)).toBe(true);

    starter.status = "exited";
    kid.needs = "permission";
    kid.unread = true;
    expect(isActive("/here", null, NOW)).toBe(true);
    expect(isActive("/there", null, NOW)).toBe(false);
  });

  // Picked, from the pane, the palette or the chord, it is on screen and
  // its starter's project is the one used, and the one the pane counts
  // as on screen.
  it("is picked into its starter's project", () => {
    workspace.open.push(
      { path: "/here", name: "here", repository: "/here", isGit: true },
      { path: "/there", name: "there", repository: "/there", isGit: true },
    );
    touch("/there", NOW - 60 * DAY);
    const { kid } = hang("/there");
    goTo(kid.key);
    expect(workspace.active).toBe("/there");
    expect(sessions.active).toBe(kid.key);
    expect(Date.now() - projects.used["/here"]).toBeLessThan(1000);
    expect(projects.used["/there"]).toBe(NOW - 60 * DAY);
    expect(onScreen(workspace.active)).toBe("/here");
    expect(onScreen("/elsewhere")).toBe("/elsewhere");
  });
});

describe("the projects whose history is not read yet", () => {
  // Their transcripts may make them active: drawn under Inactive first,
  // they would move as soon as they were read.
  it("are in neither half until it is, unless active by what is known", () => {
    touch("/known", NOW - DAY);
    expect(splitProjects(["/known", "/unread"], null, "used", NOW)).toEqual({
      active: ["/known"],
      inactive: [],
    });
    sessions.history["/unread"] = [entry("t", NOW - 40 * DAY)];
    expect(splitProjects(["/known", "/unread"], null, "used", NOW)).toEqual({
      active: ["/known"],
      inactive: ["/unread"],
    });
  });
});

describe("an order that holds still", () => {
  it("keeps what is drawn in place, drops what went and puts what came after what it follows", () => {
    expect(steady(["a", "b", "c"], ["c", "a", "b"])).toEqual(["a", "b", "c"]);
    expect(steady(["a", "b", "c"], ["c", "a"])).toEqual(["a", "c"]);
    expect(steady(["a", "b"], ["new", "b", "a"])).toEqual(["new", "a", "b"]);
    expect(steady(["a", "b"], ["b", "x", "a", "y"])).toEqual(["a", "y", "b", "x"]);
    expect(steady([], ["a", "b"])).toEqual(["a", "b"]);
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
