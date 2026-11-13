import { beforeEach, describe, expect, it, vi } from "vitest";
import { attention } from "$lib/attention.svelte";
import { chordFor, describe as spell, resetKeys } from "$lib/keys.svelte";
import {
  ATTENTION_LABEL,
  closePalette,
  commandItems,
  goToItems,
  lastUsed,
  openCommands,
  openGoTo,
  openPalette,
  palette,
  paletteItems,
  pickItem,
  resetPalette,
  setQuery,
  since,
  type PaletteItem,
} from "$lib/palette.svelte";
import { matches } from "$lib/files.svelte";
import { create, exact, reset, select, sessions, started } from "$lib/sessions.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

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
  resetKeys();
  resetPalette();
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
    expect(end(B)).toMatchObject({ end: "last used 2d ago" });
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

  it("brings a project forward", () => {
    create(B);
    const item = goToItems("").find((candidate) => candidate.kind === "project" && candidate.path === B)!;
    const outcome = pickItem(item);
    expect(outcome.type).toBe("close");
    if (outcome.type === "close") outcome.then();
    expect(workspace.active).toBe(B);
  });
});

describe("commands", () => {
  it("is the jump first, then the commands without a chord, then the actions", () => {
    const items = commandItems("");
    expect(items[0]).toMatchObject({ kind: "attention", label: ATTENTION_LABEL });
    expect(items.slice(1, 3).map((item) => item.label)).toEqual(["Open project", "Open remote project"]);
    expect(items.slice(3).every((item) => item.kind === "action")).toBe(true);
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
