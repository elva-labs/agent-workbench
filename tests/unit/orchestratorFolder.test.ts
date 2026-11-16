import { beforeEach, describe, expect, it, vi } from "vitest";

/** Where the core says the folder is, and what the window asked it to do
    there. */
const fake = {
  dir: "/home/ada/.agent-workbench/orchestrator" as string | null,
  asked: [] as string[],
};

vi.mock("$lib/core", () => ({
  core: () =>
    new Proxy(
      {
        async orchestratorDir() {
          if (fake.dir === null) throw new Error("no core");
          return fake.dir;
        },
      },
      {
        get(target, name: string) {
          if (name in target) return target[name as keyof typeof target];
          // Anything else the window asks of the core is noted and answered
          // with nothing.
          return async () => {
            fake.asked.push(name);
            return undefined;
          };
        },
      },
    ),
}));

import {
  closeFolder,
  folderShown,
  isOrchestratorFolder,
  load,
  orchestratorFolder,
  resetFolder,
  startsIn,
} from "$lib/orchestratorFolder.svelte";
import { create, forProject, reset as resetSessions, sessions, type HistoryEntry } from "$lib/sessions.svelte";
import { close, hookedProjects, reset as resetWorkspace, startSession, workspace } from "$lib/workspace.svelte";

const DIR = "/home/ada/.agent-workbench/orchestrator";
const A = "/home/ada/dev/one";

/** A past session the agent's own index lists. */
const past = (id: string): HistoryEntry => ({
  id,
  modified: Math.floor(Date.now() / 1000) - 60,
  size: 100,
  title: "Plan the release",
  agent: "claude-code",
  account: null,
});

beforeEach(() => {
  resetSessions();
  resetWorkspace();
  localStorage.clear();
  fake.dir = DIR;
  fake.asked = [];
  resetFolder(DIR);
  workspace.open = [{ path: A, name: "one", repository: A, isGit: true }];
});

describe("the orchestrator folder", () => {
  it("is where the core says, and nowhere when it cannot say, and nothing is written there", async () => {
    resetFolder();
    await load();
    expect(orchestratorFolder.dir).toBe(DIR);
    expect(fake.asked).toEqual([]);

    fake.dir = null;
    await load();
    expect(orchestratorFolder.dir).toBeNull();
    expect(isOrchestratorFolder(DIR)).toBe(false);
  });

  it("offers no new session, and every other project does", () => {
    expect(startsIn(DIR)).toBe(false);
    expect(startsIn(A)).toBe(true);
    expect(startsIn(null)).toBe(true);
    startSession(DIR);
    expect(forProject(DIR)).toEqual([]);
    startSession(A);
    expect(forProject(A)).toHaveLength(1);
  });

  it("shows while it holds past sessions it lists or a row, and not when empty", () => {
    expect(folderShown(A)).toBeNull();
    // A past session the window never ran is not listed, and does not
    // bring the folder in.
    sessions.history[DIR] = [past("old-1")];
    expect(folderShown(A)).toBeNull();
    sessions.mine[DIR] = ["old-1"];
    expect(folderShown(A)).toBe(DIR);
    sessions.history[DIR] = [];
    expect(folderShown(A)).toBeNull();
    // A session resumed there, or back from the last quit, is a row.
    create(DIR, "old-1", "claude-code", null);
    expect(folderShown(A)).toBe(DIR);
  });

  it("is one of the projects the hooks answer covers while it is listed", () => {
    expect(hookedProjects()).toEqual([A]);
    sessions.history[DIR] = [past("old-1")];
    sessions.mine[DIR] = ["old-1"];
    expect(hookedProjects()).toEqual([A, DIR]);
    closeFolder();
    expect(hookedProjects()).toEqual([A]);
  });

  it("leaves the pane for good once closed, unless a session of it has a row", () => {
    sessions.history[DIR] = [past("old-1")];
    sessions.mine[DIR] = ["old-1"];
    const resumed = create(DIR, "old-1", "claude-code", null);
    workspace.active = DIR;
    close(DIR);
    expect(orchestratorFolder.closed).toBe(true);
    expect(sessions.all).not.toContain(resumed);
    expect(workspace.active).toBe(A);
    expect(folderShown(A)).toBeNull();
    expect(JSON.parse(localStorage.getItem("workbench.orchestratorFolder")!)).toEqual({ closed: true });

    // A row of it, as when the version before ran it since, shows it.
    create(DIR, "old-1", "claude-code", null);
    expect(folderShown(A)).toBe(DIR);
  });

  it("reads the close back on the next start", async () => {
    closeFolder();
    vi.resetModules();
    const again = await import("$lib/orchestratorFolder.svelte");
    expect(again.orchestratorFolder.closed).toBe(true);
  });
});
