import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const fake = { reachable: new Set(["lab"]) };

vi.mock("$lib/core", () => ({
  core: () => ({
    remoteHosts: async () => ({
      configured: ["lab"],
      saved: [
        {
          name: "lab.example",
          host: "10.0.0.5",
          user: "ada",
          port: 22,
          target: "ada@lab.example",
        },
      ],
    }),
    remoteConnect: async (target: string) => {
      calls.push(`connect ${target}`);
      if (!fake.reachable.has(target))
        throw new Error(`ssh: Could not resolve hostname ${target}`);
      return { host: target, version: "0.1.0" };
    },
    remotePair: async (token: string) => {
      calls.push(`pair ${token}`);
      if (token === "awb1.stale")
        throw new Error("the token is not whole; copy all of it");
      return { host: "ada@lab.example", version: "0.1.0" };
    },
    remoteDirs: async (target: string, path: string) => {
      const base = path === "" ? `ssh://${target}/home/ada` : path;
      return { path: base, dirs: [{ name: "dev", path: `${base}/dev` }] };
    },
    projectInfo: async (path: string) => ({
      path,
      name: path.split("/").pop(),
      repository: path,
      isGit: true,
    }),
  }),
}));

import {
  browse,
  choose,
  connect,
  hostOf,
  isRemote,
  looksLikeToken,
  openRemote,
  pair,
  parentOf,
  pathOn,
  remote,
  resetRemote,
} from "$lib/remote.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

beforeEach(() => {
  calls.length = 0;
  fake.reachable = new Set(["lab"]);
  resetRemote();
  resetWorkspace();
});

describe("paths on other machines", () => {
  it("knows where a path is", () => {
    expect(isRemote("ssh://ada@lab/home/ada")).toBe(true);
    expect(isRemote("/home/ada")).toBe(false);
    expect(hostOf("ssh://ada@lab/home/ada/dev")).toBe("ada@lab");
    expect(hostOf("ssh://lab#pty-1")).toBe("lab");
    expect(hostOf("ssh://lab")).toBe("lab");
    expect(hostOf("/home/ada")).toBeNull();
    expect(pathOn("ssh://lab/home/ada")).toBe("/home/ada");
    expect(pathOn("ssh://lab")).toBe("/");
    expect(pathOn("/x")).toBe("/x");
  });

  it("goes one directory up and stops at the root", () => {
    expect(parentOf("ssh://lab/home/ada/dev")).toBe("ssh://lab/home/ada");
    expect(parentOf("ssh://lab/home")).toBe("ssh://lab/");
    expect(parentOf("ssh://lab/")).toBeNull();
    expect(parentOf("ssh://lab")).toBeNull();
    expect(parentOf("/home/ada")).toBeNull();
  });

  it("knows the shape of a token", () => {
    expect(looksLikeToken("awb1.eyJob3N0Ijoi_-")).toBe(true);
    expect(looksLikeToken("  awb1.abc \n")).toBe(true);
    expect(looksLikeToken("awb1.")).toBe(false);
    expect(looksLikeToken("lab")).toBe(false);
    expect(looksLikeToken("awb1.ab c")).toBe(false);
  });
});

describe("the dialog", () => {
  it("takes a token in and browses the machine it names", async () => {
    await openRemote();
    expect(remote.open).toBe(true);
    expect(remote.hosts.saved[0].target).toBe("ada@lab.example");
    remote.token = " awb1.abc\n";
    await pair();
    expect(calls).toEqual(["pair awb1.abc"]);
    expect(remote.token).toBe("");
    expect(remote.target).toBe("ada@lab.example");
    expect(remote.step).toBe("browse");
    expect(remote.listing?.path).toBe("ssh://ada@lab.example/home/ada");
    await browse(remote.listing!.dirs[0].path);
    expect(remote.listing?.path).toBe("ssh://ada@lab.example/home/ada/dev");
  });

  it("says what is wrong with a token before and after sending it", async () => {
    await openRemote();
    await pair();
    expect(remote.error).toBe("Paste what the machine printed.");
    remote.token = "hello";
    await pair();
    expect(remote.error).toContain("not a token");
    expect(calls).toEqual([]);
    remote.token = "awb1.stale";
    await pair();
    expect(remote.error).toContain("not whole");
    expect(remote.step).toBe("connect");
  });

  it("connects to a host the ssh setup knows, and says so when it cannot", async () => {
    await openRemote();
    await connect();
    expect(remote.error).toBe("Say which host.");
    remote.host = " lab ";
    await connect();
    expect(calls).toEqual(["connect lab"]);
    expect(remote.step).toBe("browse");
    remote.host = "nowhere";
    remote.step = "connect";
    await connect();
    expect(remote.error).toContain("Could not resolve");
    expect(remote.error).not.toContain("new token");
    // A paired machine that cannot be reached may have moved.
    remote.host = "ada@lab.example";
    await connect();
    expect(remote.error).toContain("paste the new token");
  });

  it("opens the chosen folder as a project and closes", async () => {
    await openRemote();
    remote.host = "lab";
    await connect();
    await choose("ssh://lab/home/ada/dev");
    expect(remote.open).toBe(false);
    expect(workspace.open.map((project) => project.path)).toEqual([
      "ssh://lab/home/ada/dev",
    ]);
    expect(workspace.open[0].name).toBe("dev");
  });
});
