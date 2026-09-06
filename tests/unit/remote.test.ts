import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const fake = {
  authorized: new Set(["box"]),
  fingerprint: "256 SHA256:x box (ED25519)",
};

vi.mock("$lib/core", () => ({
  core: () => ({
    remoteHosts: async () => ({
      configured: ["box"],
      saved: [{ host: "lab", user: "ada", target: "ada@lab" }],
    }),
    remoteFingerprint: async () => fake.fingerprint,
    remoteConnect: async (target: string) => {
      calls.push(`connect ${target}`);
      if (!fake.authorized.has(target))
        throw new Error("Permission denied (publickey).");
      return { host: target, version: "0.1.0" };
    },
    remoteSetup: async (host: string, user: string, password: string) => {
      calls.push(`setup ${user}@${host} ${password}`);
      if (password !== "pw") throw new Error("the password was not accepted");
      fake.authorized.add(`${user}@${host}`);
      return { host: `${user}@${host}`, version: "0.1.0" };
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
  needsSetup,
  openRemote,
  parentOf,
  pathOn,
  remote,
  resetRemote,
  setup,
  targetFor,
} from "$lib/remote.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

beforeEach(() => {
  calls.length = 0;
  fake.authorized = new Set(["box"]);
  resetRemote();
  resetWorkspace();
});

describe("paths on other machines", () => {
  it("knows where a path is", () => {
    expect(isRemote("ssh://ada@box/home/ada")).toBe(true);
    expect(isRemote("/home/ada")).toBe(false);
    expect(hostOf("ssh://ada@box/home/ada/dev")).toBe("ada@box");
    expect(hostOf("ssh://box#pty-1")).toBe("box");
    expect(hostOf("ssh://box")).toBe("box");
    expect(hostOf("/home/ada")).toBeNull();
    expect(pathOn("ssh://box/home/ada")).toBe("/home/ada");
    expect(pathOn("ssh://box")).toBe("/");
    expect(pathOn("/x")).toBe("/x");
  });

  it("goes one directory up and stops at the root", () => {
    expect(parentOf("ssh://box/home/ada/dev")).toBe("ssh://box/home/ada");
    expect(parentOf("ssh://box/home")).toBe("ssh://box/");
    expect(parentOf("ssh://box/")).toBeNull();
    expect(parentOf("ssh://box")).toBeNull();
    expect(parentOf("/home/ada")).toBeNull();
  });

  it("names the target ssh is given", () => {
    expect(targetFor("box", "")).toBe("box");
    expect(targetFor(" box ", " ada ")).toBe("ada@box");
    expect(targetFor("", "ada")).toBe("");
  });

  it("tells a machine that would not let the app in from one that is not there", () => {
    expect(needsSetup("ada@box: Permission denied (publickey,password).")).toBe(
      true,
    );
    expect(needsSetup("the password was not accepted")).toBe(true);
    expect(needsSetup("ssh: Could not resolve hostname box")).toBe(false);
  });
});

describe("the dialog", () => {
  it("offers the hosts it knows and connects to one", async () => {
    await openRemote();
    expect(remote.open).toBe(true);
    expect(remote.hosts.configured).toEqual(["box"]);
    remote.host = "box";
    await connect();
    expect(calls).toEqual(["connect box"]);
    expect(remote.step).toBe("browse");
    expect(remote.listing?.path).toBe("ssh://box/home/ada");
    await browse(remote.listing!.dirs[0].path);
    expect(remote.listing?.path).toBe("ssh://box/home/ada/dev");
  });

  it("asks for a password once when the machine does not know the app", async () => {
    await openRemote();
    remote.host = "lab";
    remote.user = "ada";
    await connect();
    expect(remote.step).toBe("password");
    expect(remote.fingerprint).toContain("SHA256:x");
    remote.password = "nope";
    await setup();
    expect(remote.error).toContain("not accepted");
    expect(remote.step).toBe("password");
    remote.password = "pw";
    await setup();
    expect(calls).toEqual([
      "connect ada@lab",
      "setup ada@lab nope",
      "setup ada@lab pw",
    ]);
    expect(remote.password).toBe("");
    expect(remote.target).toBe("ada@lab");
    expect(remote.step).toBe("browse");
  });

  it("will not set up without a user or a password", async () => {
    await openRemote();
    remote.host = "lab";
    remote.step = "password";
    await setup();
    expect(remote.error).toContain("which user");
    remote.user = "ada";
    await setup();
    expect(remote.error).toContain("password");
    expect(calls).toEqual([]);
  });

  it("opens the chosen folder as a project and closes", async () => {
    await openRemote();
    remote.host = "box";
    await connect();
    await choose("ssh://box/home/ada/dev");
    expect(remote.open).toBe(false);
    expect(workspace.open.map((project) => project.path)).toEqual([
      "ssh://box/home/ada/dev",
    ]);
    expect(workspace.open[0].name).toBe("dev");
  });

  it("says what went wrong when the machine is not there", async () => {
    await openRemote();
    await connect();
    expect(remote.error).toBe("Say which machine.");
    remote.host = "nowhere";
    fake.authorized = new Set();
    await connect();
    // Denied is a password's problem; anything else is shown as it is.
    expect(remote.step).toBe("password");
  });
});
