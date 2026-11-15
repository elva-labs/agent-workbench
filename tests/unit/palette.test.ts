import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attention } from "$lib/attention.svelte";
import { chordFor, describe as spell, resetKeys } from "$lib/keys.svelte";
import {
  ATTENTION_LABEL,
  closePalette,
  commandItems,
  goToItems,
  lastUsed,
  beginNew,
  nextStep,
  openCommands,
  openGoTo,
  openPalette,
  palette,
  paletteItems,
  pickable,
  pickItem,
  resetPalette,
  setQuery,
  since,
  startingId,
  stepBack,
  stepItems,
  stepsLeft,
  type PaletteItem,
} from "$lib/palette.svelte";
import { matches } from "$lib/files.svelte";
import { accounts, reset as resetAccounts } from "$lib/accounts.svelte";
import { agent } from "$lib/agent.svelte";
import { create, exact, reset, select, sessions, started } from "$lib/sessions.svelte";
import { activate, bringForward, onScreen, reset as resetWorkspace, startSession, workspace } from "$lib/workspace.svelte";
import { projects, resetProjects } from "$lib/projects.svelte";
import { conductor, resetConductor } from "$lib/conductor.svelte";
import "$lib/orchestrator.svelte";
import { adoptWorkflows, defaultWorkflow, reset as resetWorkflows } from "$lib/workflows.svelte";

vi.mock("$lib/core", () => ({
  core: () => ({
    kill: async () => {},
    setBadge: async () => {},
    setWindowTitle: async () => {},
  }),
}));

const A = "/home/ada/dev/one";
const B = "/home/ada/dev/two";
const C = "/home/ada/dev/three";

const repo = (path: string) => ({
  path,
  name: path.split("/").pop()!,
  repository: path,
  isGit: true,
});

const sessionKeys = (items: PaletteItem[]) =>
  items.flatMap((item) => (item.kind === "session" ? [item.session.key] : []));
const projectPaths = (items: PaletteItem[]) =>
  items.flatMap((item) => (item.kind === "project" ? [item.path] : []));

beforeEach(() => {
  reset();
  resetWorkspace();
  resetProjects();
  resetConductor();
  resetKeys();
  resetPalette();
  resetAccounts();
  // No workflows unless a test has some.
  resetWorkflows();
  agent.availability = "ready";
  agent.installed = ["claude-code"];
  attention.focused = true;
  workspace.open.push(repo(A), repo(B), repo(C));
});

describe("matching", () => {
  it("takes every word, in any order and any case", () => {
    expect(matches("Show or hide the terminal", "TERM hide")).toBe(true);
    expect(matches("Show or hide the terminal", "term shell")).toBe(false);
    expect(matches("anything", "   ")).toBe(true);
  });
});

describe("opening", () => {
  it("opens go to and commands with an empty field", () => {
    palette.query = "left over";
    openGoTo();
    expect(palette).toMatchObject({ open: true, mode: "goto", query: "" });
    palette.query = "left over";
    openCommands();
    expect(palette).toMatchObject({ open: true, mode: "commands", query: "" });
  });

  it("keeps openPalette working as the commands palette", () => {
    openPalette();
    expect(palette).toMatchObject({ open: true, mode: "commands" });
    closePalette();
    expect(palette.open).toBe(false);
  });

  it("switches to commands on a > typed first, keeping the rest", () => {
    openGoTo();
    setQuery("po");
    expect(palette).toMatchObject({ mode: "goto", query: "po" });
    setQuery(">");
    expect(palette).toMatchObject({ mode: "commands", query: "" });
    openGoTo();
    setQuery(">zoom in");
    expect(palette).toMatchObject({ mode: "commands", query: "zoom in" });
  });

  it("does not read a > later in the text, or in commands, as a switch", () => {
    openGoTo();
    setQuery("a>b");
    expect(palette).toMatchObject({ mode: "goto", query: "a>b" });
    openCommands();
    setQuery(">x");
    expect(palette).toMatchObject({ mode: "commands", query: ">x" });
  });
});

describe("go to", () => {
  it("lists the sessions, then the projects", () => {
    create(A);
    create(B);
    const items = goToItems("");
    expect(items.map((item) => item.kind)).toEqual([
      "session",
      "session",
      "project",
      "project",
      "project",
    ]);
  });

  it("orders the sessions by their latest change, and not by their status", () => {
    attention.focused = false;
    const old = create(A);
    const waiting = create(B);
    const newest = create(C);
    old.changedAt = 3000;
    waiting.changedAt = 1000;
    newest.changedAt = 2000;
    // The one that needs you is the oldest change, and stays last.
    started(waiting.key, "pty-2", "session-pty-2");
    exact("session-pty-2", "stop");
    waiting.changedAt = 1000;
    expect(sessionKeys(goToItems(""))).toEqual([old.key, newest.key, waiting.key]);
  });

  it("matches a session on its name or its project, every word", () => {
    const first = create(A);
    const second = create(B);
    first.changedAt = 1000;
    second.changedAt = 2000;
    first.title = "Fix the cache";
    second.title = "Fix the parser";
    const keys = (query: string) => sessionKeys(goToItems(query));
    expect(keys("fix")).toEqual([second.key, first.key]);
    expect(keys("cache")).toEqual([first.key]);
    expect(keys("two")).toEqual([second.key]);
    expect(keys("fix one")).toEqual([first.key]);
    expect(keys("cache two")).toEqual([]);
  });

  it("matches a session by the label of its project, with the path above it when two share a name", () => {
    workspace.open.push(repo("/work/main"), repo("/spike/main"));
    const work = create("/work/main");
    create("/spike/main");
    expect(sessionKeys(goToItems("work/main"))).toEqual([work.key]);
  });

  it("narrows the projects by their label, inactive ones included", () => {
    create(A);
    expect(projectPaths(goToItems("tw"))).toEqual([B]);
    expect(projectPaths(goToItems("ada"))).toEqual([]);
  });

  it("matches the Open project row against what is typed when nothing is open", () => {
    resetWorkspace();
    reset();
    expect(goToItems("").map((item) => item.label)).toEqual(["Open project"]);
    expect(goToItems("open").map((item) => item.label)).toEqual(["Open project"]);
    expect(goToItems("zzz")).toEqual([]);
  });

  it("gives a session its project and the time of its change", () => {
    const own = create(A);
    own.changedAt = Date.now() - 3 * 60_000;
    const item = goToItems("").find((candidate) => candidate.kind === "session");
    expect(item).toMatchObject({ project: "one", when: "3m", group: "Sessions" });
  });

  it("gives a project its live sessions, else when it was last used", () => {
    create(A);
    const quiet = create(B);
    quiet.status = "dormant";
    quiet.changedAt = Date.now() - 2 * 86_400_000 - 60_000;
    const end = (path: string) =>
      goToItems("").find((item) => item.kind === "project" && item.path === path);
    expect(end(A)).toMatchObject({ end: "1 live", group: "Projects" });
    expect(end(B)).toMatchObject({ end: "2d" });
    expect(end(C)).toMatchObject({ end: "" });
  });

  it("lists the projects by when they were last used", () => {
    const one = create(A);
    const two = create(B);
    one.changedAt = 1000;
    two.changedAt = 5000;
    expect(projectPaths(goToItems(""))).toEqual([B, A, C]);
  });

  it("counts a past session as use of its project", () => {
    sessions.history[C] = [
      { id: "t", modified: 4000, size: 1, title: null, agent: "claude-code", account: null },
    ];
    expect(lastUsed(C)).toBe(4_000_000);
    expect(lastUsed(A)).toBeNull();
    expect(projectPaths(goToItems(""))[0]).toBe(C);
  });

  it("keeps ids unique", () => {
    create(A);
    create(B);
    const ids = goToItems("").map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lists what the palette is showing", () => {
    create(A);
    openGoTo();
    expect(paletteItems().some((item) => item.kind === "session")).toBe(true);
    openCommands();
    expect(paletteItems().some((item) => item.kind === "session")).toBe(false);
  });
});

describe("where go to starts", () => {
  it("puts the cursor on the first session that is not the one on screen", () => {
    const first = create(A);
    const second = create(B);
    first.changedAt = 1_000;
    second.changedAt = 2_000;
    select(second.key);
    expect(goToItems("")[0]).toMatchObject({ id: `session:${second.key}` });
    openGoTo();
    expect(startingId()).toBe(`session:${first.key}`);
  });

  it("starts on the first entry when the only session is the one on screen, and when typing", () => {
    create(A);
    openGoTo();
    expect(startingId()).toBeNull();
    create(B);
    setQuery("session");
    expect(startingId()).toBeNull();
  });

  it("offers to open a project when nothing is open, and nothing when a query matches nothing", () => {
    workspace.open.length = 0;
    expect(goToItems("").map((item) => item.id)).toEqual(["command:open"]);
    expect(pickable(goToItems("")[0])).toBe(true);
    expect(goToItems("x")).toEqual([]);
  });
});

describe("what picking does in go to", () => {
  it("brings a session forward and gives it the keyboard once the palette is away", () => {
    const first = create(A);
    create(B);
    const item = goToItems("").find(
      (candidate) => candidate.kind === "session" && candidate.session.key === first.key,
    )!;
    const outcome = pickItem(item);
    expect(outcome.type).toBe("close");
    if (outcome.type === "close") outcome.then();
    expect(sessions.active).toBe(first.key);
    expect(workspace.active).toBe(A);
  });

  it("gives the keyboard to the sessions pane for a project with no session", async () => {
    const { layout } = await import("$lib/layout.svelte");
    create(A);
    workspace.active = A;
    const item = goToItems("").find((candidate) => candidate.kind === "project" && candidate.path === B)!;
    const outcome = pickItem(item);
    if (outcome.type === "close") outcome.then();
    await tick();
    expect(workspace.active).toBe(B);
    expect(sessions.active).toBeNull();
    expect(layout.focus).toBe("sessions");
  });

  it("leaves the sessions pane alone in a window too narrow for it", async () => {
    const { layout } = await import("$lib/layout.svelte");
    layout.sessionsChosen = false;
    layout.sessionsForced = true;
    layout.mode = "working";
    create(A);
    workspace.active = A;
    const item = goToItems("").find((candidate) => candidate.kind === "project" && candidate.path === B)!;
    const outcome = pickItem(item);
    if (outcome.type === "close") outcome.then();
    await tick();
    expect(layout.sessionsChosen).toBe(false);
    expect(layout.focus).toBe("agent");
    layout.sessionsForced = false;
    layout.sessionsChosen = true;
  });

  it("keeps the session on screen when its project is picked", () => {
    const first = create(A);
    create(A);
    select(first.key);
    workspace.active = A;
    const item = goToItems("").find((candidate) => candidate.kind === "project" && candidate.path === A)!;
    const outcome = pickItem(item);
    if (outcome.type === "close") outcome.then();
    expect(sessions.active).toBe(first.key);
  });

  it("brings a project forward", () => {
    create(B);
    const item = goToItems("").find((candidate) => candidate.kind === "project" && candidate.path === B)!;
    const outcome = pickItem(item);
    expect(outcome.type).toBe("close");
    if (outcome.type === "close") outcome.then();
    expect(workspace.active).toBe(B);
  });

  // A project whose only session hangs under a starter in another project
  // has none drawn under it: go to counts none live there, and picking it
  // shows it with no session, as the project on screen, rather than that
  // session, which would put the starter's project on screen instead.
  it("shows a project whose only session hangs elsewhere with none", () => {
    const starter = create(A);
    started(starter.key, "pty-1", "starter-1");
    const kid = create(C);
    started(kid.key, "pty-2", "kid-1");
    conductor.startedBy[kid.key] = "starter-1";
    activate(A);
    sessions.active = starter.key;
    const row = (path: string) =>
      goToItems("").find((candidate) => candidate.kind === "project" && candidate.path === path)!;
    expect(row(A)).toMatchObject({ end: "2 live" });
    expect(row(C)).toMatchObject({ end: "now" });

    const outcome = pickItem(row(C));
    if (outcome.type === "close") outcome.then();
    expect(workspace.active).toBe(C);
    expect(sessions.active).toBeNull();
    expect(onScreen()).toBe(C);
    expect(Date.now() - projects.used[C]).toBeLessThan(1000);

    // A session of its own drawn under it is the one shown.
    const own = create(C);
    started(own.key, "pty-3", "own-1");
    activate(A);
    const again = pickItem(row(C));
    if (again.type === "close") again.then();
    expect(sessions.active).toBe(own.key);
  });

  // The session on screen hangs under its starter's project from another
  // one: bringing the starter's project forward counts it as used and
  // leaves the session and the project in front as they are.
  it("keeps a started session on screen when its starter's project is brought forward", () => {
    const starter = create(A);
    started(starter.key, "pty-1", "starter-1");
    const kid = create(C);
    started(kid.key, "pty-2", "kid-1");
    conductor.startedBy[kid.key] = "starter-1";
    activate(C);
    sessions.active = kid.key;
    expect(onScreen()).toBe(A);

    bringForward(A);
    expect(sessions.active).toBe(kid.key);
    expect(workspace.active).toBe(C);
    expect(onScreen()).toBe(A);
    expect(Date.now() - projects.used[A]).toBeLessThan(1000);
  });

  // A project picked is the user using it, as a session picked is.
  it("counts a project picked as used, the one in front too", () => {
    workspace.active = A;
    for (const path of [B, A]) {
      const item = goToItems("").find((candidate) => candidate.kind === "project" && candidate.path === path)!;
      const outcome = pickItem(item);
      if (outcome.type === "close") outcome.then();
      expect(Date.now() - projects.used[path]).toBeLessThan(1000);
    }
    expect(projects.used[C]).toBeUndefined();
  });
});

describe("commands", () => {
  it("is the jump first, then the commands without a chord, then the actions", () => {
    const items = commandItems("");
    expect(items[0]).toMatchObject({ kind: "attention", label: ATTENTION_LABEL });
    expect(items.slice(1, 4).map((item) => item.label)).toEqual([
      "New session",
      "Open project",
      "Open remote project",
    ]);
    expect(items.slice(4).every((item) => item.kind === "action")).toBe(true);
  });

  it("offers a new session in the project on screen only while one is", () => {
    expect(commandItems("new session").map((item) => item.label)).toEqual(["New session"]);
    workspace.active = B;
    expect(commandItems("new session").map((item) => item.label)).toEqual([
      "New session",
      "New session in two",
    ]);
    workspace.open = [];
    workspace.active = null;
    expect(commandItems("new session")).toEqual([]);
  });

  it("does not offer a new session while no agent is ready", () => {
    agent.availability = "missing";
    const item = commandItems("new session")[0];
    expect(pickable(item)).toBe(false);
    expect(pickItem(item)).toEqual({ type: "stay" });
  });

  it("has every action that has a chord, but not the palette itself or the jump's own", () => {
    const actions = commandItems("").flatMap((item) => (item.kind === "action" ? [item.action] : []));
    expect(actions).not.toContain("palette");
    expect(actions).not.toContain("session.attention");
    expect(actions).toContain("goto");
    expect(actions).toContain("settings");
    expect(actions).toContain("zoom.in");
  });

  it("narrows by the words of the label", () => {
    expect(commandItems("terminal zoom").map((item) => item.label)).toEqual([
      "Zoom the terminal in",
      "Zoom the terminal out",
      "Reset the terminal's zoom",
    ]);
    expect(commandItems("remote").map((item) => item.label)).toEqual(["Open remote project"]);
  });

  it("shows each action's chord", () => {
    const item = commandItems("open settings").find((candidate) => candidate.kind === "action");
    expect(item?.kind === "action" && item.chord).toBe(spell(chordFor("settings")));
  });

  it("does not list sessions", () => {
    create(A);
    expect(commandItems("").some((item) => item.kind === "session")).toBe(false);
  });

  it("does not match the jump to a word it has none of, and keeps ids unique", () => {
    expect(commandItems("zoom").some((item) => item.kind === "attention")).toBe(false);
    const ids = commandItems("").map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("counts the sessions waiting on the user", () => {
    attention.focused = false;
    const first = create(A);
    started(first.key, "pty-1", "session-pty-1");
    exact("session-pty-1", "stop");
    create(B);
    expect(commandItems("")[0]).toMatchObject({ kind: "attention", waiting: 1 });
    select(first.key);
    expect(commandItems("")[0]).toMatchObject({ kind: "attention", waiting: 0 });
  });

  it("does nothing when the jump has nothing waiting", () => {
    expect(pickItem(commandItems("")[0])).toEqual({ type: "stay" });
  });

  it("hands an action to the page, and the jump too", () => {
    attention.focused = false;
    const first = create(A);
    started(first.key, "pty-1", "session-pty-1");
    exact("session-pty-1", "stop");
    create(B);
    expect(pickItem(commandItems("")[0])).toEqual({ type: "perform", action: { type: "attention" } });
    const zoom = commandItems("zoom in")[0];
    expect(pickItem(zoom)).toEqual({ type: "perform", action: { type: "zoom", step: 1 } });
    expect(pickItem(commandItems("go to")[0])).toEqual({ type: "perform", action: { type: "goto" } });
  });
});

describe("time", () => {
  it("is spelled coarsely, from now to months", () => {
    const now = 10_000_000_000;
    expect(since(now - 5_000, now)).toBe("now");
    expect(since(now - 3 * 60_000, now)).toBe("3m");
    expect(since(now - 5 * 3_600_000, now)).toBe("5h");
    expect(since(now - 2 * 86_400_000, now)).toBe("2d");
    expect(since(now - 21 * 86_400_000, now)).toBe("3w");
    expect(since(now - 70 * 86_400_000, now)).toBe("2mo");
    expect(since(now + 5_000, now)).toBe("now");
  });
});

/** Picks the entry the field would pick on Enter, for a test walking the steps. */
function choose(label: string, alone = false) {
  const item = paletteItems().find((candidate) => candidate.label === label);
  if (item === undefined) throw new Error(`nothing called ${label}`);
  return pickItem(item, alone);
}

describe("how a new session runs", () => {
  const quick = () => ({
    ...defaultWorkflow(),
    name: "Quick fix",
    steps: [defaultWorkflow().steps[0]],
  });

  it("asks nothing more and starts the agent at once, with one agent and no workflow turned on", () => {
    adoptWorkflows(undefined);
    expect(stepsLeft([{ kind: "project", path: A }])).toEqual([]);
    const outcome = beginNew(A);
    if (outcome.type === "close") outcome.then();
    expect(outcome.type).toBe("close");
    expect(sessions.all[0]).toMatchObject({ project: A, agent: "claude-code", workflow: null, model: null });
  });

  it("asks nothing more in a project that follows no workflow, whatever another project chose", () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: null, overrides: { "/elsewhere": "Build and review" } });
    expect(stepsLeft([{ kind: "project", path: A }])).toEqual([]);
    const outcome = beginNew(A);
    if (outcome.type === "close") outcome.then();
    expect(outcome.type).toBe("close");
    expect(sessions.all[0]).toMatchObject({ project: A, agent: "claude-code", workflow: null });
    // Nor where the project chose none over the default.
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: { [A]: null } });
    expect(stepsLeft([{ kind: "project", path: A }])).toEqual([]);
  });

  it("offers the workflows above the agents where the project follows one, even with one agent installed", () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: {} });
    expect(stepsLeft([{ kind: "project", path: A }])).toEqual(["agent"]);
    beginNew(A);
    const items = stepItems("");
    expect(items.map((item) => [item.group, item.label])).toEqual([
      ["Workflows", "Build and review"],
      ["One agent, no workflow", "Claude Code"],
    ]);
    const [flow] = items;
    expect(flow.kind === "choice" && flow.detail).toBe("Fable directs, Sonnet works, Opus reviews");
    expect(flow.kind === "choice" && flow.end).toBe("default");
    expect(startingId()).toBe("workflow:Build and review");
    // Picked, the one agent starts alone, though the project follows a
    // workflow.
    const outcome = choose("Claude Code");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0]).toMatchObject({ project: A, agent: "claude-code", workflow: null, model: null });
  });

  it("says whether the project chose its workflow or follows the default", () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: {} });
    beginNew(A);
    const ends = () => stepItems("").map((item) => (item.kind === "choice" ? item.end : null));
    expect(ends()).toEqual(["default", ""]);
    adoptWorkflows({ list: [defaultWorkflow()], default: null, overrides: { [A]: "Build and review" } });
    expect(ends()).toEqual(["project's workflow", ""]);
  });

  it("puts the project's workflow first, marked, with the cursor on it, and starts under it", () => {
    adoptWorkflows({ list: [quick(), defaultWorkflow()], default: null, overrides: { [A]: "Build and review" } });
    beginNew(A);
    const items = stepItems("");
    expect(items.map((item) => item.label)).toEqual(["Build and review", "Quick fix", "Claude Code"]);
    expect(items.map((item) => (item.kind === "choice" ? item.end : null))).toEqual([
      "project's workflow",
      "",
      "",
    ]);
    expect(startingId()).toBe("workflow:Build and review");
    const outcome = choose("Build and review");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0]).toMatchObject({ project: A, agent: "claude-code", model: "fable" });
    expect(sessions.all[0].workflow?.name).toBe("Build and review");
  });

  it("starts under another workflow picked, and alone on an agent picked", () => {
    agent.installed = ["claude-code", "codex"];
    adoptWorkflows({ list: [defaultWorkflow(), quick()], default: "Build and review", overrides: {} });
    beginNew(A);
    let outcome = choose("Quick fix");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0].workflow?.name).toBe("Quick fix");
    beginNew(A);
    outcome = choose("Codex");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[1]).toMatchObject({ agent: "codex", workflow: null });
    beginNew(A);
    outcome = choose("Claude Code");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[2]).toMatchObject({ agent: "claude-code", workflow: null, model: null });
  });
});

describe("a new session", () => {
  const spawned = () => sessions.all.map((session) => ({ ...session }));

  it("starts from the command with the project to ask for first", () => {
    openCommands();
    expect(choose("New session")).toEqual({ type: "stay" });
    expect(palette).toMatchObject({ open: true, mode: "new", query: "", steps: [] });
    expect(nextStep(palette.steps)).toBe("project");
  });

  it("lists the project on screen first, then the rest by last use", () => {
    const one = create(A);
    const three = create(C);
    one.changedAt = 1000;
    three.changedAt = 9000;
    workspace.active = A;
    beginNew(null);
    expect(stepItems("").map((item) => item.label)).toEqual(["one", "three", "two"]);
    workspace.active = null;
    expect(stepItems("").map((item) => item.label)).toEqual(["three", "one", "two"]);
    expect(stepItems("tw").map((item) => item.label)).toEqual(["two"]);
  });

  // A session started by another hangs under its starter, in the
  // starter's project, which is then the project on screen: the question
  // and the command for the project on screen name it, not the project the
  // session runs in, and the cursor starts on it.
  it("takes the starter's project as the one on screen while a session it started is", () => {
    const starter = create(A);
    started(starter.key, "pty-1", "starter-1");
    const kid = create(C);
    started(kid.key, "pty-2", "kid-1");
    conductor.startedBy[kid.key] = "starter-1";
    kid.changedAt = Date.now();
    activate(C);
    sessions.active = kid.key;
    expect(workspace.active).toBe(C);

    expect(commandItems("new session in").map((item) => item.label)).toEqual(["New session in one"]);
    openCommands();
    expect(choose("New session")).toEqual({ type: "stay" });
    expect(stepItems("")[0]).toMatchObject({ id: `project:${A}`, label: "one" });
    expect(startingId()).toBeNull();

    openCommands();
    const outcome = choose("New session in one");
    expect(outcome.type).toBe("close");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all.at(-1)?.project).toBe(A);
  });

  it("starts in the project at once when there is nothing else to choose", () => {
    openCommands();
    choose("New session");
    const outcome = choose("two");
    expect(outcome.type).toBe("close");
    if (outcome.type === "close") outcome.then();
    expect(spawned()).toHaveLength(1);
    expect(sessions.all[0]).toMatchObject({ project: B, agent: "claude-code", account: null });
    expect(workspace.active).toBe(B);
  });

  it("asks for the account when accounts are named, then starts under it", () => {
    accounts.list = { Work: { claude: "~/.claude-work", codex: null } };
    accounts.overrides = { [B]: "Work" };
    openCommands();
    choose("New session");
    expect(choose("two")).toEqual({ type: "stay" });
    expect(palette.steps).toEqual([{ kind: "project", path: B }]);
    expect(nextStep(palette.steps)).toBe("account");
    expect(stepItems("").map((item) => item.label)).toEqual(["Default", "Work"]);
    // The cursor begins on the account the project runs under.
    expect(startingId()).toBe("account:Work");
    const outcome = choose("Default");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0]).toMatchObject({ project: B, account: null });
  });

  it("asks for the agent only where more than one is installed", () => {
    expect(stepsLeft([{ kind: "project", path: A }])).toEqual([]);
    agent.installed = ["claude-code", "codex"];
    expect(stepsLeft([{ kind: "project", path: A }])).toEqual(["agent"]);
    expect(stepsLeft([])).toEqual(["project", "agent"]);
    accounts.list = { Work: { claude: "~/.claude-work", codex: null } };
    expect(stepsLeft([])).toEqual(["project", "account", "agent"]);
  });

  it("takes each answer as a chip and starts on the last, with the project's agent offered first", () => {
    agent.installed = ["claude-code", "codex"];
    accounts.list = { Work: { claude: "~/.claude-work", codex: null } };
    sessions.preferred[A] = "codex";
    beginNew(A);
    expect(palette.steps).toEqual([{ kind: "project", path: A }]);
    choose("Work");
    expect(palette.steps.map((step) => step.kind)).toEqual(["project", "account"]);
    expect(stepItems("").map((item) => item.label)).toEqual(["Claude Code", "Codex"]);
    expect(startingId()).toBe("agent:codex");
    const outcome = choose("Claude Code");
    expect(outcome.type).toBe("close");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0]).toMatchObject({ project: A, agent: "claude-code", account: "Work" });
  });

  it("marks the agent last used on its entry", () => {
    agent.installed = ["claude-code", "codex"];
    sessions.preferred[A] = "codex";
    beginNew(A);
    const marks = stepItems("").map((item) => (item.kind === "choice" ? item.end : null));
    expect(marks).toEqual(["", "last used"]);
  });

  it("clears the field at each step, and narrows only the question asked", () => {
    agent.installed = ["claude-code", "codex"];
    openCommands();
    choose("New session");
    setQuery("tw");
    expect(palette.query).toBe("tw");
    choose("two");
    expect(palette.query).toBe("");
    setQuery("codex");
    expect(stepItems(palette.query).map((item) => item.label)).toEqual(["Codex"]);
  });

  it("marks the account the project runs under as the project's", () => {
    accounts.list = { Work: { claude: "~/.claude-work", codex: null } };
    beginNew(A);
    const marks = stepItems("").map((item) => (item.kind === "choice" ? item.end : null));
    expect(marks).toEqual(["this project's", ""]);
  });

  it("puts what was typed in the commands back when stepping out of the first question", () => {
    openCommands();
    setQuery("new sess");
    choose("New session");
    expect(palette.query).toBe("");
    stepBack();
    expect(palette).toMatchObject({ mode: "commands", query: "new sess", steps: [] });
    // Opened afresh, the commands start empty again.
    choose("New session");
    openCommands();
    expect(palette.query).toBe("");
    choose("New session");
    stepBack();
    expect(palette.query).toBe("");
  });

  it("steps back by one answer, and from the first question to the commands", () => {
    agent.installed = ["claude-code", "codex"];
    accounts.list = { Work: { claude: "~/.claude-work", codex: null } };
    openCommands();
    choose("New session");
    choose("one");
    choose("Work");
    expect(palette.steps).toHaveLength(2);
    stepBack();
    expect(palette.steps).toEqual([{ kind: "project", path: A }]);
    stepBack();
    expect(palette.steps).toEqual([]);
    expect(palette.mode).toBe("new");
    stepBack();
    expect(palette).toMatchObject({ mode: "commands", query: "", steps: [] });
  });

  it("starts in the project on screen from its own command", () => {
    workspace.active = C;
    openCommands();
    const outcome = choose("New session in three");
    expect(outcome.type).toBe("close");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all[0]).toMatchObject({ project: C });
  });

  it("starts with Cmd+Enter from a session or a project in go to", () => {
    const own = create(B);
    agent.installed = ["claude-code", "codex"];
    openGoTo();
    const session = paletteItems().find((item) => item.kind === "session")!;
    expect(pickItem(session, true)).toEqual({ type: "stay" });
    expect(palette).toMatchObject({ mode: "new", steps: [{ kind: "project", path: B }] });
    expect(own.project).toBe(B);

    openGoTo();
    const project = paletteItems().find((item) => item.kind === "project" && item.path === C)!;
    expect(pickItem(project, true)).toEqual({ type: "stay" });
    expect(palette.steps).toEqual([{ kind: "project", path: C }]);
  });

  it("starts at once with Cmd+Enter when the project is all it needs", () => {
    openGoTo();
    const project = paletteItems().find((item) => item.kind === "project" && item.path === C)!;
    const outcome = pickItem(project, true);
    expect(outcome.type).toBe("close");
    if (outcome.type === "close") outcome.then();
    expect(sessions.all.map((session) => session.project)).toEqual([C]);
  });

  it("does not ask for the project when only one is open", () => {
    workspace.open.splice(0, workspace.open.length, repo(B));
    agent.installed = ["claude-code", "codex"];
    openCommands();
    expect(choose("New session")).toEqual({ type: "stay" });
    expect(palette.steps).toEqual([{ kind: "project", path: B }]);
    expect(stepsLeft(palette.steps)).toEqual(["agent"]);
    stepBack();
    expect(palette).toMatchObject({ mode: "commands", steps: [] });
  });

  it("starts nothing in a project that has closed meanwhile", () => {
    beginNew(A);
    const outcome = pickItem(stepItems("")[0]);
    expect(outcome.type).toBe("close");
    workspace.open.splice(0, workspace.open.length, repo(B), repo(C));
    if (outcome.type === "close") outcome.then();
    expect(sessions.all).toEqual([]);
  });

  it("offers nothing at a later step once the project has closed", () => {
    agent.installed = ["claude-code", "codex"];
    beginNew(A);
    expect(stepItems("")).not.toEqual([]);
    workspace.open.splice(0, workspace.open.length, repo(B), repo(C));
    expect(stepItems("")).toEqual([]);
  });

  it("brings the project forward when a session is started in it", () => {
    workspace.active = A;
    startSession(B);
    expect(workspace.active).toBe(B);
    expect(sessions.all[0]).toMatchObject({ project: B });
  });

  it("leaves the steps behind when a list is opened again", () => {
    beginNew(A);
    openGoTo();
    expect(palette).toMatchObject({ mode: "goto", steps: [] });
    beginNew(A);
    openCommands();
    expect(palette).toMatchObject({ mode: "commands", steps: [] });
  });
});
