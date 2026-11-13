import { flushSync } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  followOpenRequests,
  openPath,
  projectLabel,
  reset,
  restore,
  workspace,
} from "$lib/workspace.svelte";
import {
  reopened,
  reset as resetSessions,
  select,
  sessions,
} from "$lib/sessions.svelte";

/** Folders waiting to be taken, and the window's word that more are. */
const fake = vi.hoisted(() => {
  const state = {
    waiting: [] as string[],
    told: null as (() => void) | null,
    /** How long each path takes to be described, and how many are being. */
    delays: {} as Record<string, number>,
    describing: 0,
    mostAtOnce: 0,
  };
  const core = {
    projectInfo: async (path: string) => {
      if (path.endsWith("/gone")) throw new Error("gone");
      state.describing += 1;
      state.mostAtOnce = Math.max(state.mostAtOnce, state.describing);
      await new Promise((resolve) => setTimeout(resolve, state.delays[path] ?? 0));
      state.describing -= 1;
      return {
        path,
        name: path.split("/").pop()!,
        repository: path,
        isGit: true,
      };
    },
    setWindowTitle: async () => {},
    takeOpened: async () => state.waiting.splice(0),
    onOpenRequested: async (handler: () => void) => {
      state.told = handler;
      return () => (state.told = null);
    },
  };
  return { state, core };
});

vi.mock("$lib/core", () => ({ core: () => fake.core }));

const repo = (path: string) => ({
  path,
  name: path.split(/[\\/]/).pop()!,
  repository: path,
  isGit: true,
});

/** What is stored for the next start. */
function stored(): { open: string[]; active: string | null } {
  return JSON.parse(localStorage.getItem("workbench.workspace") ?? "null");
}

beforeEach(() => {
  reset();
  resetSessions();
  fake.state.waiting = [];
  fake.state.told = null;
  fake.state.delays = {};
  fake.state.describing = 0;
  fake.state.mostAtOnce = 0;
  localStorage.clear();
});

describe("restoring the open projects", () => {
  it("describes them all at once and lists them in the stored order", async () => {
    localStorage.setItem(
      "workbench.workspace",
      JSON.stringify({
        open: ["/p/slow", "/gone", "/p/quick", "/p/middle"],
        active: "/p/middle",
      }),
    );
    fake.state.delays = { "/p/slow": 30, "/p/middle": 10, "/p/quick": 0 };
    await restore();
    expect(workspace.open.map((project) => project.path)).toEqual([
      "/p/slow",
      "/p/quick",
      "/p/middle",
    ]);
    expect(fake.state.mostAtOnce).toBe(3);
    expect(workspace.active).toBe("/p/middle");
  });

  it("puts the projects here in together, and does not wait for a host", async () => {
    localStorage.setItem(
      "workbench.workspace",
      JSON.stringify({
        open: ["/p/one", "ssh://ada@lab/srv/x", "/p/two"],
        active: "/p/two",
      }),
    );
    fake.state.delays = { "/p/one": 20, "ssh://ada@lab/srv/x": 120 };
    const sizes: number[] = [];
    const watch = setInterval(() => sizes.push(workspace.open.length), 2);
    const arriving = await restore();
    // Both local projects are there, in order, and the active one is chosen,
    // while the host has not answered.
    expect(workspace.open.map((project) => project.path)).toEqual([
      "/p/one",
      "/p/two",
    ]);
    expect(workspace.active).toBe("/p/two");
    expect([...arriving.keys()]).toEqual(["ssh://ada@lab/srv/x"]);
    await Promise.all(arriving.values());
    clearInterval(watch);
    // Never one local project without the other.
    expect(sizes.every((size) => size === 0 || size >= 2)).toBe(true);
    // The host's project takes its stored place between them.
    expect(workspace.open.map((project) => project.path)).toEqual([
      "/p/one",
      "ssh://ada@lab/srv/x",
      "/p/two",
    ]);
    expect(workspace.active).toBe("/p/two");
  });

  it("keeps a project on its way in what is stored, and after it arrives", async () => {
    localStorage.setItem(
      "workbench.workspace",
      JSON.stringify({
        open: ["/p/one", "ssh://ada@lab/srv/x", "/p/two"],
        active: "/p/two",
      }),
    );
    fake.state.delays = { "ssh://ada@lab/srv/x": 30 };
    const arriving = await restore();
    // A quit now loses nothing.
    expect(stored()).toEqual({
      open: ["/p/one", "ssh://ada@lab/srv/x", "/p/two"],
      active: "/p/two",
    });
    await Promise.all(arriving.values());
    expect(stored()).toEqual({
      open: ["/p/one", "ssh://ada@lab/srv/x", "/p/two"],
      active: "/p/two",
    });
  });

  it("drops a project on another machine from what is stored when it cannot be described", async () => {
    localStorage.setItem(
      "workbench.workspace",
      JSON.stringify({ open: ["/p/one", "ssh://ada@lab/gone"], active: "/p/one" }),
    );
    const arriving = await restore();
    await Promise.all(arriving.values());
    expect(stored()).toEqual({ open: ["/p/one"], active: "/p/one" });
  });

  it("puts a late project before one opened while it was on its way", async () => {
    localStorage.setItem(
      "workbench.workspace",
      JSON.stringify({ open: ["/p/zero", "ssh://ada@lab/srv/x", "/p/two"], active: "/p/zero" }),
    );
    fake.state.delays = { "ssh://ada@lab/srv/x": 30 };
    const arriving = await restore();
    await openPath("/p/asked");
    expect(stored().open).toEqual([
      "/p/zero",
      "ssh://ada@lab/srv/x",
      "/p/two",
      "/p/asked",
    ]);
    await Promise.all(arriving.values());
    expect(workspace.open.map((project) => project.path)).toEqual([
      "/p/zero",
      "ssh://ada@lab/srv/x",
      "/p/two",
      "/p/asked",
    ]);
    expect(workspace.active).toBe("/p/asked");
  });

  it("puts the first project in front while the stored one waits for its host", async () => {
    localStorage.setItem(
      "workbench.workspace",
      JSON.stringify({
        open: ["/p/one", "ssh://ada@lab/srv/x"],
        active: "ssh://ada@lab/srv/x",
      }),
    );
    fake.state.delays = { "ssh://ada@lab/srv/x": 30 };
    const arriving = await restore();
    expect(workspace.open).toHaveLength(1);
    expect(workspace.active).toBe("/p/one");
    // The stored one is still the one in front for the next start.
    expect(stored().active).toBe("ssh://ada@lab/srv/x");
    await Promise.all(arriving.values());
    expect(workspace.active).toBe("ssh://ada@lab/srv/x");
  });

  it("leaves the project chosen while the stored one waited in front", async () => {
    localStorage.setItem(
      "workbench.workspace",
      JSON.stringify({
        open: ["/p/one", "/p/two", "ssh://ada@lab/srv/x"],
        active: "ssh://ada@lab/srv/x",
      }),
    );
    fake.state.delays = { "ssh://ada@lab/srv/x": 30 };
    const arriving = await restore();
    await openPath("/p/two");
    expect(stored().active).toBe("/p/two");
    await Promise.all(arriving.values());
    expect(workspace.active).toBe("/p/two");
  });

  it("leaves the session chosen while the stored project waited in front", async () => {
    localStorage.setItem(
      "workbench.workspace",
      JSON.stringify({
        open: ["/p/one", "ssh://ada@lab/srv/x"],
        active: "ssh://ada@lab/srv/x",
      }),
    );
    fake.state.delays = { "ssh://ada@lab/srv/x": 30 };
    const arriving = await restore();
    const row = reopened("/p/one", "s1", "claude-code", null, null, null);
    select(row.key);
    flushSync();
    // A quit now starts the next time with this project in front.
    expect(stored().active).toBe("/p/one");
    await Promise.all(arriving.values());
    expect(workspace.active).toBe("/p/one");
    expect(sessions.active).toBe(row.key);
  });

  it("stores a project opened by hand while on its way only once", async () => {
    localStorage.setItem(
      "workbench.workspace",
      JSON.stringify({
        open: ["/p/one", "ssh://ada@lab/srv/x"],
        active: "/p/one",
      }),
    );
    fake.state.delays = { "ssh://ada@lab/srv/x": 40 };
    const arriving = await restore();
    fake.state.delays = {};
    await openPath("ssh://ada@lab/srv/x");
    expect(stored().open).toEqual(["/p/one", "ssh://ada@lab/srv/x"]);
    await Promise.all(arriving.values());
    expect(stored().open).toEqual(["/p/one", "ssh://ada@lab/srv/x"]);
  });

  it("activates the first project when the stored one cannot be described", async () => {
    localStorage.setItem(
      "workbench.workspace",
      JSON.stringify({ open: ["/p/one", "/gone"], active: "/gone" }),
    );
    await restore();
    expect(workspace.open.map((project) => project.path)).toEqual(["/p/one"]);
    expect(workspace.active).toBe("/p/one");
  });
});

describe("what a project is called", () => {
  it("is the folder's name on its own", () => {
    workspace.open.push(repo("/home/ada/dev/one"));
    expect(projectLabel("/home/ada/dev/one")).toBe("one");
  });

  // Two checkouts of the same repository, told apart by where they are.
  it("takes as much of the path as tells two of the same name apart", () => {
    workspace.open.push(
      repo("/home/ada/work/main-truck"),
      repo("/home/ada/spike/main-truck"),
    );
    expect(projectLabel("/home/ada/work/main-truck")).toBe("work/main-truck");
    expect(projectLabel("/home/ada/spike/main-truck")).toBe("spike/main-truck");
  });

  it("goes as deep as it must", () => {
    workspace.open.push(repo("/a/x/main-truck"), repo("/b/x/main-truck"));
    expect(projectLabel("/a/x/main-truck")).toBe("a/x/main-truck");
    expect(projectLabel("/b/x/main-truck")).toBe("b/x/main-truck");
  });

  it("reads past a remote's host and a Windows drive", () => {
    workspace.open.push(
      repo("ssh://lab/srv/demo"),
      repo("C:\\Users\\ada\\dev\\demo"),
    );
    expect(projectLabel("ssh://lab/srv/demo")).toBe("srv/demo");
    expect(projectLabel("C:\\Users\\ada\\dev\\demo")).toBe("dev/demo");
  });

  it("is the folder's name for a path that is not open", () => {
    expect(projectLabel("/home/ada/dev/elsewhere")).toBe("elsewhere");
  });
});

describe("folders asked for from outside the window", () => {
  const open = () => workspace.open.map((project) => project.path);

  // Started from a terminal: the folder waits for the workspace the window
  // had last time, and is the one left in front.
  it("open once the stored workspace is back, in front", async () => {
    let finish = () => {};
    const restored = new Promise<void>((resolve) => (finish = resolve));
    fake.state.waiting = ["/home/ada/dev/asked"];
    followOpenRequests(restored);
    await Promise.resolve();
    expect(open()).toEqual([]);

    workspace.open.push(repo("/home/ada/dev/demo"));
    workspace.active = "/home/ada/dev/demo";
    finish();
    await vi.waitFor(() => expect(workspace.active).toBe("/home/ada/dev/asked"));
    expect(open()).toEqual(["/home/ada/dev/demo", "/home/ada/dev/asked"]);
  });

  it("open as they are asked for, an open one brought forward", async () => {
    followOpenRequests(Promise.resolve());
    await vi.waitFor(() => expect(fake.state.told).not.toBeNull());

    for (const path of ["/home/ada/dev/one", "/home/ada/dev/two", "/home/ada/dev/one"]) {
      fake.state.waiting.push(path);
      fake.state.told!();
      await vi.waitFor(() => expect(workspace.active).toBe(path));
    }
    expect(open()).toEqual(["/home/ada/dev/one", "/home/ada/dev/two"]);
  });

  it("stop being listened for when the window is done", async () => {
    const stop = followOpenRequests(Promise.resolve());
    await vi.waitFor(() => expect(fake.state.told).not.toBeNull());
    stop();
    expect(fake.state.told).toBeNull();
  });
});
