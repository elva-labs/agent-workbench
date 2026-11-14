import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "$lib/core";
import {
  adoptSessionKinds,
  canIntegrate,
  kindFor,
  otherKind,
  resetSessionKinds,
  sessionKindSettings,
  sessionKinds,
  setKind,
} from "$lib/sessionKind.svelte";
import {
  byKey,
  close,
  create,
  exact,
  onIntegratedClose,
  reopened,
  reset as resetSessions,
  sessions,
  started,
} from "$lib/sessions.svelte";
import { reopen } from "$lib/reopen.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";
import { resetConductor } from "$lib/conductor.svelte";

const sets = vi.hoisted(() => [] as Partial<Settings>[]);

vi.mock("$lib/core", () => ({
  core: () => ({
    settingsSet: async (change: Partial<Settings>) => {
      sets.push(change);
      return change;
    },
    kill: async () => {},
    projectInfo: async (path: string) => ({ path, name: path, repository: path, isGit: true }),
    transcripts: async () => [],
    transcriptsMany: async (projects: string[]) => projects.map(() => []),
    integratedSnapshot: async () => {
      throw new Error("no such session");
    },
  }),
}));

const PROJECT = "/home/ada/dev/demo";

beforeEach(() => {
  resetSessionKinds();
  resetSessions();
  resetWorkspace();
  resetConductor();
  sets.length = 0;
});

afterEach(() => onIntegratedClose(() => {}));

describe("how an agent's sessions run", () => {
  it("is a terminal unless the user says otherwise", () => {
    expect(kindFor("claude-code")).toBe("terminal");
    expect(kindFor("codex")).toBe("terminal");
    expect(sessionKindSettings()).toEqual({ integrated: [] });
  });

  it("can be integrated for Claude Code and never for Codex", () => {
    expect(canIntegrate("claude-code")).toBe(true);
    expect(canIntegrate("codex")).toBe(false);
    setKind("claude-code", "integrated");
    setKind("codex", "integrated");
    expect(kindFor("claude-code")).toBe("integrated");
    expect(kindFor("codex")).toBe("terminal");
    expect(sets).toEqual([{ integrated: ["claude-code"] }]);
    expect(otherKind("claude-code")).toBe("terminal");
    expect(otherKind("codex")).toBeNull();
  });

  it("is sent to the core only when it changes", () => {
    setKind("claude-code", "terminal");
    expect(sets).toEqual([]);
    setKind("claude-code", "integrated");
    setKind("claude-code", "integrated");
    setKind("claude-code", "terminal");
    expect(sets).toEqual([{ integrated: ["claude-code"] }, { integrated: [] }]);
  });

  it("takes the core's word, leaving out what cannot run integrated", () => {
    adoptSessionKinds(["codex", "claude-code", 7]);
    expect(sessionKinds.integrated).toEqual(["claude-code"]);
    adoptSessionKinds(undefined);
    expect(sessionKinds.integrated).toEqual([]);
    adoptSessionKinds("claude-code");
    expect(sessionKinds.integrated).toEqual([]);
  });
});

describe("a session's kind", () => {
  it("follows the agent's setting, unless the session is started the other way", () => {
    expect(create(PROJECT, null, "claude-code").kind).toBe("terminal");
    setKind("claude-code", "integrated");
    expect(create(PROJECT, null, "claude-code").kind).toBe("integrated");
    expect(create(PROJECT, null, "codex").kind).toBe("terminal");
    const once = create(PROJECT, null, "claude-code", null, null, null, null, "terminal");
    expect(once.kind).toBe("terminal");
    // The next one follows the setting again.
    expect(create(PROJECT, null, "claude-code").kind).toBe("integrated");
  });

  it("is told to whatever stops an integrated session when its row is closed", () => {
    const stopped: string[] = [];
    onIntegratedClose((session) => stopped.push(session.key));
    const terminal = create(PROJECT, null, "claude-code");
    const integrated = create(PROJECT, null, "claude-code", null, null, null, null, "integrated");
    close(terminal.key);
    close(integrated.key);
    expect(stopped).toEqual([integrated.key]);
    expect(byKey(integrated.key)).toBeNull();
  });

  it("leaves an integrated session's state to its own events, whatever the hooks say", () => {
    const terminal = create(PROJECT, null, "claude-code");
    started(terminal.key, "pty-1", "terminal-id");
    const integrated = create(PROJECT, null, "claude-code", null, null, null, null, "integrated");
    integrated.id = "integrated-id";
    integrated.status = "running";
    exact("terminal-id", "prompt");
    exact("integrated-id", "prompt");
    exact("integrated-id", "permission");
    expect(byKey(terminal.key)!.working).toBe(true);
    expect(byKey(integrated.key)!.working).toBe(false);
    expect(byKey(integrated.key)!.needs).toBeNull();
    expect(byKey(integrated.key)!.exact).toBe(false);
  });

  it("comes back after a restart as it ran", () => {
    workspace.open.push({ path: PROJECT, name: "demo", repository: PROJECT, isGit: true });
    workspace.active = PROJECT;
    const integrated = create(PROJECT, null, "claude-code", null, null, null, null, "integrated");
    integrated.id = "integrated-id";
    integrated.status = "running";
    const terminal = create(PROJECT, null, "claude-code");
    started(terminal.key, "pty-1", "terminal-id");
    const stop = reopen();
    flushSync();
    stop();
    const record = JSON.parse(localStorage.getItem("workbench.open")!);
    expect(record.open.map((entry: { kind: string }) => entry.kind)).toEqual([
      "integrated",
      "terminal",
    ]);

    resetSessions();
    const again = reopen();
    flushSync();
    again();
    expect(sessions.all.map((session) => [session.id, session.kind, session.status])).toEqual([
      ["integrated-id", "integrated", "dormant"],
      ["terminal-id", "terminal", "dormant"],
    ]);
  });

  it("reads a record from before there were integrated sessions as a terminal", () => {
    expect(reopened(PROJECT, "old", "claude-code", null, null, null).kind).toBe("terminal");
  });
});
