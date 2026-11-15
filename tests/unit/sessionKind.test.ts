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
  newSessionKind,
  onIntegratedClose,
  otherWay,
  reopened,
  reset as resetSessions,
  sessions,
  started,
} from "$lib/sessions.svelte";
import { reopen } from "$lib/reopen.svelte";
import { applyDetect, resetAgent } from "$lib/agent.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";
import { resetConductor } from "$lib/conductor.svelte";
import { adoptWorkflows, defaultWorkflow, reset as resetWorkflows } from "$lib/workflows.svelte";

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

/** The core says it can drive Claude Code in messages, and not Codex. */
function detected() {
  resetAgent();
  for (const id of ["claude-code", "codex"])
    applyDetect(
      {
        id,
        path: `/usr/local/bin/${id}`,
        caps: { resumable: true, titles: true, acp: false, integrated: id === "claude-code" },
        fromLoginShell: true,
      },
      true,
    );
}

beforeEach(() => {
  detected();
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

  it("can be integrated only for an agent the core says it can drive in messages", () => {
    resetAgent();
    expect(canIntegrate("claude-code")).toBe(false);
    setKind("claude-code", "integrated");
    expect(kindFor("claude-code")).toBe("terminal");
    applyDetect(
      { id: "codex", path: "/x/codex", caps: { resumable: true, titles: true, acp: false, integrated: true }, fromLoginShell: true },
      true,
    );
    expect(canIntegrate("codex")).toBe(true);
    expect(otherKind("codex")).toBe("integrated");
  });

  it("takes the core's word, leaving out what is not an agent", () => {
    adoptSessionKinds(["codex", "claude-code", 7]);
    expect(sessionKinds.integrated).toEqual(["claude-code", "codex"]);
    expect(kindFor("codex")).toBe("terminal");
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
    const once = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "terminal");
    expect(once.kind).toBe("terminal");
    // The next one follows the setting again.
    expect(create(PROJECT, null, "claude-code").kind).toBe("integrated");
  });

  it("is told to whatever stops an integrated session when its row is closed", () => {
    const stopped: string[] = [];
    onIntegratedClose((session) => stopped.push(session.key));
    const terminal = create(PROJECT, null, "claude-code");
    const integrated = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "integrated");
    close(terminal.key);
    close(integrated.key);
    expect(stopped).toEqual([integrated.key]);
    expect(byKey(integrated.key)).toBeNull();
  });

  it("leaves an integrated session's state to its own events, whatever the hooks say", () => {
    const terminal = create(PROJECT, null, "claude-code");
    started(terminal.key, "pty-1", "terminal-id");
    const integrated = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "integrated");
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
    const integrated = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "integrated");
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

describe("a session under a workflow", () => {
  afterEach(() => resetWorkflows());

  it("runs in a terminal, the one way its orchestrator is told the workflow", () => {
    setKind("claude-code", "integrated");
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: {} });
    const session = create(PROJECT);
    expect(session.workflow?.name).toBe("Build and review");
    expect(session.kind).toBe("terminal");
    // An agent picked from several runs alone, the way its setting says.
    expect(create(PROJECT, null, "claude-code").kind).toBe("integrated");
  });

  it("is not one started integrated by name, which runs alone", () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: {} });
    const session = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "integrated");
    expect(session.workflow).toBeNull();
    expect(session.kind).toBe("integrated");
  });

  it("resumed from one that followed a workflow, runs in a terminal again", () => {
    setKind("claude-code", "integrated");
    sessions.workflows["followed"] = { workflow: defaultWorkflow(), told: null, project: PROJECT };
    expect(create(PROJECT, "followed", "claude-code").kind).toBe("terminal");
    expect(create(PROJECT, "plain", "claude-code").kind).toBe("integrated");
  });

  it("resumed without its workflow, or from history, runs in a terminal to be told to let go of it", () => {
    // The review's case: resumed without the workflow it followed, the
    // record says what it was told and follows none.
    setKind("claude-code", "integrated");
    sessions.workflows["without"] = { workflow: null, told: "1. Direct the work.", project: PROJECT };
    expect(create(PROJECT, "without", "claude-code").kind).toBe("terminal");
    expect(create(PROJECT, "without", "claude-code", null, null, null, null, null).kind).toBe("terminal");
  });

  it("makes the other way from New session integrated, alone, where New session is a terminal", () => {
    workspace.open.push({ path: PROJECT, name: "demo", repository: PROJECT, isGit: true });
    expect(newSessionKind(PROJECT)).toBe("terminal");
    expect(otherWay(PROJECT)).toBe("integrated");
    setKind("claude-code", "integrated");
    expect(newSessionKind(PROJECT)).toBe("integrated");
    expect(otherWay(PROJECT)).toBe("terminal");
    // Under a workflow New session is a terminal whatever the setting.
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: {} });
    expect(newSessionKind(PROJECT)).toBe("terminal");
    expect(otherWay(PROJECT)).toBe("integrated");
    const once = create(PROJECT, null, "claude-code", null, null, null, null, null, otherWay(PROJECT)!);
    expect(once.kind).toBe("integrated");
    expect(once.workflow).toBeNull();
    // An agent that runs one way only has no other way.
    sessions.preferred[PROJECT] = "codex";
    expect(otherWay(PROJECT)).toBeNull();
  });
});
