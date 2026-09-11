import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  elapsed,
  owners,
  processes,
  refresh,
  resetProcesses,
  stop,
} from "$lib/processes.svelte";
import { create, reset as resetSessions, started } from "$lib/sessions.svelte";
import {
  create as createShell,
  reset as resetShells,
  started as shellStarted,
} from "$lib/terminals.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

const under: Record<string, unknown[]> = {};
const stopped: [string, number][] = [];
vi.mock("$lib/core", () => ({
  core: () => ({
    async setWindowTitle() {},
    async projectInfo(path: string) {
      return { path, name: path, repository: path, isGit: true };
    },
    async ptyProcesses(id: string) {
      if (id === "pty-gone") throw new Error("no such session");
      return under[id] ?? [];
    },
    async stopProcess(id: string, pid: number) {
      stopped.push([id, pid]);
      under[id] = (under[id] as { pid: number }[]).filter((p) => p.pid !== pid);
    },
  }),
}));

const repo = (path: string) => ({
  path,
  name: path.split("/").pop()!,
  repository: path,
  isGit: true,
});
const process = (pid: number, command: string) => ({
  pid,
  parent: 1,
  name: command.split(" ")[0],
  command,
  cpu: 1,
  memory: 1048576,
  started: 1_700_000_000,
});

beforeEach(() => {
  resetWorkspace();
  resetSessions();
  resetShells();
  resetProcesses();
  for (const key of Object.keys(under)) delete under[key];
  stopped.length = 0;
  workspace.open.push(repo("/one"), repo("/two"));
  workspace.active = "/one";
});

describe("what is looked under", () => {
  it("is the active project's running sessions and shells, by name", () => {
    const session = create("/one");
    started(session.key, "pty-1", "s1");
    const other = create("/two");
    started(other.key, "pty-2", "s2");
    const shell = createShell("/one");
    shellStarted(shell.key, "pty-3");
    const starting = create("/one");
    expect(starting.ptyId).toBeNull();
    expect(owners()).toEqual([
      { ptyId: "pty-1", owner: "session 1" },
      { ptyId: "pty-3", owner: "shell 1" },
    ]);
    workspace.active = null;
    expect(owners()).toEqual([]);
  });
});

describe("the list", () => {
  it("gathers what runs under each, named for its owner, and skips a pty that went", async () => {
    const session = create("/one");
    started(session.key, "pty-1", "s1");
    const shell = createShell("/one");
    shellStarted(shell.key, "pty-gone");
    under["pty-1"] = [
      process(10, "node server.js"),
      process(11, "esbuild --watch"),
    ];
    await refresh();
    expect(processes.rows.map((row) => [row.pid, row.owner])).toEqual([
      [10, "session 1"],
      [11, "session 1"],
    ]);
  });

  it("stops a process under its pty and reads the list again", async () => {
    const session = create("/one");
    started(session.key, "pty-1", "s1");
    under["pty-1"] = [process(10, "node server.js")];
    await refresh();
    await stop(processes.rows[0]);
    expect(stopped).toEqual([["pty-1", 10]]);
    expect(processes.rows).toEqual([]);
  });
});

describe("elapsed", () => {
  it("reads in the shortest form", () => {
    const now = 1_700_000_000_000;
    expect(elapsed(1_700_000_000 - 12, now)).toBe("12s");
    expect(elapsed(1_700_000_000 - 125, now)).toBe("2m");
    expect(elapsed(1_700_000_000 - 3600, now)).toBe("1h");
    expect(elapsed(1_700_000_000 - 3600 * 2 - 600, now)).toBe("2h 10m");
  });
});
