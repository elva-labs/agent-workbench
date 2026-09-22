import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  followOpenRequests,
  projectLabel,
  reset,
  workspace,
} from "$lib/workspace.svelte";

/** Folders waiting to be taken, and the window's word that more are. */
const fake = vi.hoisted(() => {
  const state = { waiting: [] as string[], told: null as (() => void) | null };
  const core = {
    projectInfo: async (path: string) => ({
      path,
      name: path.split("/").pop()!,
      repository: path,
      isGit: true,
    }),
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

beforeEach(() => {
  reset();
  fake.state.waiting = [];
  fake.state.told = null;
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
