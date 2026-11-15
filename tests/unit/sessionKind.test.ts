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
  dismissKept,
  exact,
  newSessionKind,
  onIntegratedClose,
  otherWay,
  rejoined,
  reopened,
  reset as resetSessions,
  resumeWithout,
  sessions,
  started,
  toldAtStart,
} from "$lib/sessions.svelte";
import { orchestratorPrompt } from "$lib/workflowInstructions";
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
  beforeEach(() => resetWorkflows());
  afterEach(() => resetWorkflows());

  const followed = () => adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: {} });

  it("runs the way its orchestrator's agent is set, a terminal or integrated", async () => {
    followed();
    const terminal = create(PROJECT);
    expect(terminal.workflow?.name).toBe("Build and review");
    expect(terminal.kind).toBe("terminal");
    setKind("claude-code", "integrated");
    const integrated = create(PROJECT);
    expect(integrated.workflow?.name).toBe("Build and review");
    expect(integrated.kind).toBe("integrated");
    // Either way it is told the workflow and delegates only through start.
    for (const session of [terminal, integrated])
      expect(await toldAtStart(session.key)).toEqual({
        instructions: orchestratorPrompt(defaultWorkflow()),
        startOnly: true,
      });
    // An agent picked from several runs alone, the way its setting says.
    const alone = create(PROJECT, null, "claude-code");
    expect(alone.workflow).toBeNull();
    expect(alone.kind).toBe("integrated");
    expect(await toldAtStart(alone.key)).toEqual({});
  });

  it("keeps its own subagent tools where the workflow says so", async () => {
    setKind("claude-code", "integrated");
    adoptWorkflows({
      list: [{ ...defaultWorkflow(), startOnly: false }],
      default: "Build and review",
      overrides: {},
    });
    const session = create(PROJECT);
    expect(await toldAtStart(session.key)).toEqual({
      instructions: orchestratorPrompt({ ...defaultWorkflow(), startOnly: false }),
      startOnly: false,
    });
  });

  it("is not one started the other way by name, which runs alone", () => {
    followed();
    for (const kind of ["integrated", "terminal"] as const) {
      const session = create(PROJECT, null, "claude-code", null, null, null, null, undefined, kind);
      expect(session.workflow).toBeNull();
      expect(session.kind).toBe(kind);
    }
  });

  it("resumed from one that followed a workflow, runs the way its agent is set and is told it again", async () => {
    setKind("claude-code", "integrated");
    followed();
    sessions.workflows["followed"] = {
      workflow: defaultWorkflow(),
      told: orchestratorPrompt(defaultWorkflow()),
      project: PROJECT,
    };
    const session = create(PROJECT, "followed", "claude-code");
    expect(session.kind).toBe("integrated");
    // What it follows is found out as it starts, once the workflows are in.
    expect(session.workflow).toBeNull();
    expect(await toldAtStart(session.key)).toEqual({
      instructions: orchestratorPrompt(defaultWorkflow()),
      startOnly: true,
    });
    expect(byKey(session.key)!.workflow?.name).toBe("Build and review");
    expect(create(PROJECT, "plain", "claude-code").kind).toBe("integrated");
  });

  it("resumed without its workflow, is told to let go of it, integrated as in a terminal", async () => {
    // The review's case: resumed without the workflow it followed, the
    // record says what it was told and follows none.
    setKind("claude-code", "integrated");
    sessions.workflows["without"] = { workflow: null, told: "1. Direct the work.", project: PROJECT };
    const session = create(PROJECT, "without", "claude-code");
    expect(session.kind).toBe("integrated");
    expect(await toldAtStart(session.key)).toEqual({ afresh: true });
    const given = create(PROJECT, "without", "claude-code", null, null, null, null, null);
    expect(given.kind).toBe("integrated");
    expect(await toldAtStart(given.key)).toEqual({ afresh: true });
  });

  it("asks the user about a workflow that is lost, and goes on without it the way it ran", async () => {
    setKind("claude-code", "integrated");
    sessions.workflows["lost"] = {
      workflow: { name: "Gone", steps: "not a workflow" },
      told: "1. Direct the work.",
      project: PROJECT,
    };
    const session = create(PROJECT, "lost", "claude-code");
    expect(await toldAtStart(session.key)).toBeNull();
    expect(byKey(session.key)!.status).toBe("failed");
    expect(byKey(session.key)!.workflowLost).toBe("Gone");
    const again = resumeWithout(session.key)!;
    expect(again.kind).toBe("integrated");
    expect(again.workflow).toBeNull();
    expect(await toldAtStart(again.key)).toEqual({ afresh: true });
  });

  it("taken up again after a reload follows the copy its run was started on", async () => {
    setKind("claude-code", "integrated");
    const before = defaultWorkflow();
    sessions.workflows["running"] = { workflow: before, told: orchestratorPrompt(before), project: PROJECT };
    // The settings changed the workflow since the run began.
    adoptWorkflows({
      list: [{ ...before, startOnly: false }],
      default: "Build and review",
      overrides: {},
    });
    const row = reopened(PROJECT, "running", "claude-code", null, null, null, "integrated");
    row.status = "running";
    const rejoining = rejoined(row.key);
    // Held to it at once, before the settings are read.
    expect(byKey(row.key)!.workflow).toEqual(before);
    await rejoining;
    expect(byKey(row.key)!.workflow).toEqual(before);
    expect(byKey(row.key)!.workflowGone).toBe(false);
    // One that followed none follows none.
    const plain = reopened(PROJECT, "plain", "claude-code", null, null, null, "integrated");
    await rejoined(plain.key);
    expect(byKey(plain.key)!.workflow).toBeNull();
  });

  it("resumed on Codex under other instructions than it began with, tells the user what Codex keeps", async () => {
    followed();
    const first = { workflow: defaultWorkflow(), told: "1. Direct the work as it was.", project: PROJECT };
    sessions.workflows["codex-changed"] = first;
    const changed = create(PROJECT, "codex-changed", "codex");
    expect(await toldAtStart(changed.key)).toMatchObject({ afresh: true });
    expect(byKey(changed.key)!.keptFromStart).toBe(
      'Codex goes on with the instructions and the subagent tools this session began with, not those of "Build and review" as it is now. Start a new session for those.',
    );
    dismissKept(changed.key);
    expect(byKey(changed.key)!.keptFromStart).toBeNull();

    // Resumed without the workflow it began under.
    sessions.workflows["codex-left"] = { workflow: null, told: "1. Direct the work.", project: PROJECT };
    const left = create(PROJECT, "codex-left", "codex");
    expect(await toldAtStart(left.key)).toEqual({ afresh: true });
    expect(byKey(left.key)!.keptFromStart).toBe(
      "Codex goes on with the instructions and the subagent tools this session began with under its workflow. Start a new session to work without one.",
    );

    // Told what it began with, there is nothing to say.
    sessions.workflows["codex-same"] = {
      workflow: defaultWorkflow(),
      told: orchestratorPrompt(defaultWorkflow()),
      project: PROJECT,
    };
    const same = create(PROJECT, "codex-same", "codex");
    expect((await toldAtStart(same.key))?.afresh).toBeUndefined();
    expect(byKey(same.key)!.keptFromStart).toBeNull();

    // Claude Code lets go of what it began with, so nothing is said.
    sessions.workflows["claude-changed"] = { ...first };
    const claude = create(PROJECT, "claude-changed", "claude-code");
    expect(await toldAtStart(claude.key)).toMatchObject({ afresh: true });
    expect(byKey(claude.key)!.keptFromStart).toBeNull();
  });

  it("makes the other way from New session the other kind, alone", () => {
    workspace.open.push({ path: PROJECT, name: "demo", repository: PROJECT, isGit: true });
    expect(newSessionKind(PROJECT)).toBe("terminal");
    expect(otherWay(PROJECT)).toBe("integrated");
    setKind("claude-code", "integrated");
    expect(newSessionKind(PROJECT)).toBe("integrated");
    expect(otherWay(PROJECT)).toBe("terminal");
    // Under a workflow New session runs the way the orchestrator's agent is
    // set, and the other way is the other kind, alone.
    followed();
    expect(newSessionKind(PROJECT)).toBe("integrated");
    expect(otherWay(PROJECT)).toBe("terminal");
    const once = create(PROJECT, null, "claude-code", null, null, null, null, null, otherWay(PROJECT)!);
    expect(once.kind).toBe("terminal");
    expect(once.workflow).toBeNull();
    setKind("claude-code", "terminal");
    expect(newSessionKind(PROJECT)).toBe("terminal");
    expect(otherWay(PROJECT)).toBe("integrated");
    // An agent that runs one way only has no other way.
    sessions.preferred[PROJECT] = "codex";
    expect(otherWay(PROJECT)).toBeNull();
  });

  it("runs a Codex orchestrator integrated where the core can drive Codex", async () => {
    applyDetect(
      { id: "codex", path: "/x/codex", caps: { resumable: true, titles: true, acp: false, integrated: true }, fromLoginShell: true },
      true,
    );
    setKind("codex", "integrated");
    const codexFlow = { ...defaultWorkflow(), orchestrator: { agent: "codex" as const, model: "gpt-5-codex" } };
    adoptWorkflows({ list: [codexFlow], default: "Build and review", overrides: {} });
    expect(newSessionKind(PROJECT)).toBe("integrated");
    const session = create(PROJECT);
    expect(session.agent).toBe("codex");
    expect(session.kind).toBe("integrated");
    expect((await toldAtStart(session.key))?.instructions).toBe(orchestratorPrompt(codexFlow));
  });
});
