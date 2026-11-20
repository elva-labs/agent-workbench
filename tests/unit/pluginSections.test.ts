import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginAction,
  PluginActionRequest,
  PluginRow,
  PluginSectionEvent,
} from "$lib/core";
import {
  NOTICE_MS,
  grouped,
  listed,
  noticeOf,
  factsOf,
  isOpen,
  noticed,
  pluginSections,
  resetPluginSections,
  run,
  sectionChanged,
  sectionOf,
  toggleOpen,
} from "$lib/pluginSections.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

const taken: PluginActionRequest[] = [];
let refuse: string | null = null;
vi.mock("$lib/core", () => ({
  core: () => ({
    async pluginAction(request: PluginActionRequest) {
      taken.push(request);
      if (refuse !== null) throw refuse;
    },
  }),
}));

/** The session on screen, as the sessions store would give it. */
let shown: { project: string; token: string } | null = null;
vi.mock("$lib/sessions.svelte", () => ({
  activeSession: () => shown,
}));

const open: PluginAction = { id: "open", label: "Open", input: null };
const refresh: PluginAction = { id: "refresh", label: "Refresh", input: null };

const row = (id: string, extra: Partial<PluginRow> = {}): PluginRow => ({
  id,
  label: id,
  detail: null,
  state: null,
  actions: [open],
  default: "open",
  ...extra,
});

const event = (
  extra: Partial<PluginSectionEvent> = {},
): PluginSectionEvent => ({
  source: "src-1",
  plugin: "github",
  section: "Pull request",
  title: "Pull request",
  detail: null,
  project: "/one",
  session: null,
  rows: [row("checks/lint")],
  actions: [refresh],
  folded: false,
  order: 0,
  ...extra,
});

beforeEach(() => {
  resetWorkspace();
  resetPluginSections();
  taken.length = 0;
  refuse = null;
  shown = null;
  workspace.active = "/one";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a section's rows", () => {
  it("keeps the latest the plugin sent, per project", () => {
    sectionChanged(event());
    sectionChanged(event({ project: "/two", rows: [row("checks/test")] }));
    sectionChanged(event({ rows: [row("checks/lint"), row("checks/test")] }));
    expect(pluginSections.sections).toHaveLength(2);
    expect(listed()).toHaveLength(1);
    expect(listed()[0].rows.map((r) => r.id)).toEqual([
      "checks/lint",
      "checks/test",
    ]);
    expect(listed()[0].key).toBe("src-1/github/Pull request");
  });

  it("goes when the plugin sends no rows, no actions and no detail, leaving the other projects alone", () => {
    sectionChanged(event());
    sectionChanged(event({ project: "/two" }));
    sectionChanged(event({ rows: [], actions: [] }));
    expect(listed()).toEqual([]);
    workspace.active = "/two";
    expect(listed()).toHaveLength(1);
  });

  it("stands on its actions or its detail alone, with no rows at all", () => {
    sectionChanged(event({ rows: [] }));
    expect(listed()).toHaveLength(1);
    expect(listed()[0].rows).toEqual([]);
    expect(listed()[0].actions).toEqual([refresh]);
    sectionChanged(event({ rows: [], actions: [], detail: "main, 2 ahead" }));
    expect(listed()).toHaveLength(1);
    expect(listed()[0].detail).toBe("main, 2 ahead");
    sectionChanged(event({ rows: [], actions: [], detail: null }));
    expect(listed()).toEqual([]);
  });

  it("lists the project on screen, by plugin then section", () => {
    sectionChanged(event({ plugin: "git", section: "Git", title: "Git" }));
    sectionChanged(event({ plugin: "github", section: "Reviews" }));
    sectionChanged(event({ plugin: "github", section: "Checks" }));
    expect(
      listed().map((section) => `${section.plugin}/${section.section}`),
    ).toEqual(["git/Git", "github/Checks", "github/Reviews"]);
    workspace.active = null;
    expect(listed()).toEqual([]);
  });

  it("draws one plugin's sections as one group, the first of them its face", () => {
    sectionChanged(
      event({
        plugin: "git",
        section: "branches",
        title: "Branches",
        order: 1,
        rows: [row("main"), row("topic")],
      }),
    );
    sectionChanged(
      event({
        plugin: "git",
        section: "status",
        title: "Git",
        detail: "main, 2 ahead",
        order: 0,
        rows: [row("src/lib.rs")],
      }),
    );
    sectionChanged(event({ plugin: "github", section: "checks" }));
    const groups = grouped();
    expect(groups.map((group) => group.key)).toEqual([
      "src-1/git",
      "src-1/github",
    ]);
    // The order the plugin declared wins over the section's own name.
    expect(groups[0].sections.map((section) => section.section)).toEqual([
      "status",
      "branches",
    ]);
    expect(groups[0].title).toBe("Git");
    expect(groups[0].detail).toBe("main, 2 ahead");
    expect(groups[0].count).toBe(3);
    expect(groups[1].title).toBe("Pull request");
    expect(groups[1].detail).toBeNull();
    expect(groups[1].count).toBe(1);
  });

  it("falls back to the section's name when two stand in the same place", () => {
    sectionChanged(event({ plugin: "git", section: "notes", order: 3 }));
    sectionChanged(event({ plugin: "git", section: "alerts", order: 3 }));
    expect(grouped()[0].sections.map((section) => section.section)).toEqual([
      "alerts",
      "notes",
    ]);
  });

  it("finds a section by its key in the project on screen", () => {
    sectionChanged(event());
    expect(sectionOf("src-1/github/Pull request")?.title).toBe("Pull request");
    expect(sectionOf("src-1/github/Checks")).toBeNull();
  });
});

describe("an action", () => {
  it("goes to the core with the section, the row and what was filled in", async () => {
    sectionChanged(event());
    const section = listed()[0];
    await run(section, open, "checks/lint", { branch: "main" });
    await run(section, refresh, null);
    expect(taken).toEqual([
      {
        source: "src-1",
        plugin: "github",
        section: "Pull request",
        action: "open",
        row: "checks/lint",
        input: { branch: "main" },
        project: "/one",
        session: null,
      },
      {
        source: "src-1",
        plugin: "github",
        section: "Pull request",
        action: "refresh",
        row: null,
        input: {},
        project: "/one",
        session: null,
      },
    ]);
    expect(noticeOf(section)).toBeNull();
  });

  it("leaves what the core refused on the plugin's sections", async () => {
    refuse = "the plugin is not running";
    sectionChanged(event());
    sectionChanged(event({ section: "Checks", title: "Checks" }));
    await run(listed()[0], refresh, null);
    expect(noticeOf(listed()[0])).toBe("the plugin is not running");
    expect(noticeOf(listed()[1])).toBe("the plugin is not running");
  });
});

describe("a notice", () => {
  it("stands for a while and then goes", () => {
    vi.useFakeTimers();
    sectionChanged(event());
    noticed({ source: "src-1", plugin: "github", text: "gh: not signed in" });
    expect(noticeOf(listed()[0])).toBe("gh: not signed in");
    vi.advanceTimersByTime(NOTICE_MS - 1);
    expect(noticeOf(listed()[0])).toBe("gh: not signed in");
    vi.advanceTimersByTime(1);
    expect(noticeOf(listed()[0])).toBeNull();
  });

  it("is one per plugin, the later one lasting the whole while", () => {
    vi.useFakeTimers();
    sectionChanged(event());
    noticed({ source: "src-1", plugin: "github", text: "first" });
    vi.advanceTimersByTime(NOTICE_MS - 10);
    noticed({ source: "src-1", plugin: "github", text: "second" });
    vi.advanceTimersByTime(20);
    expect(noticeOf(listed()[0])).toBe("second");
    vi.advanceTimersByTime(NOTICE_MS);
    expect(noticeOf(listed()[0])).toBeNull();
  });

  it("belongs to the plugin that said it and not to another", () => {
    sectionChanged(event());
    noticed({ source: "src-1", plugin: "git", text: "nothing to commit" });
    expect(noticeOf(listed()[0])).toBeNull();
  });
});

describe("a session's section", () => {
  const pr = (session: string | null, rows = [row("pr/12")]) =>
    event({ section: "pr", title: "Pull request", session, rows });

  it("shows only while its session is on screen, in place of the project's of the same name", () => {
    sectionChanged(pr(null, [row("none")]));
    sectionChanged(pr("tok-a", [row("pr/12")]));
    sectionChanged(pr("tok-b", [row("pr/13")]));
    sectionChanged(event({ section: "checks", title: "Checks" }));
    const ids = () => listed().map((section) => section.rows[0].id);
    expect(ids()).toEqual(["checks/lint", "none"]);
    shown = { project: "/one", token: "tok-a" };
    expect(ids()).toEqual(["checks/lint", "pr/12"]);
    shown = { project: "/one", token: "tok-b" };
    expect(ids()).toEqual(["checks/lint", "pr/13"]);
    // A session of another project brings nothing of its own here.
    shown = { project: "/two", token: "tok-a" };
    expect(ids()).toEqual(["checks/lint", "none"]);
  });

  it("is replaced by the next the plugin sends for that session alone, and goes when it sends nothing", () => {
    shown = { project: "/one", token: "tok-a" };
    sectionChanged(pr("tok-a"));
    sectionChanged(pr("tok-b"));
    sectionChanged(pr("tok-a", [row("pr/14")]));
    expect(listed().map((section) => section.rows[0].id)).toEqual(["pr/14"]);
    sectionChanged({ ...pr("tok-a", []), actions: [] });
    expect(listed()).toEqual([]);
    shown = { project: "/one", token: "tok-b" };
    expect(listed()).toHaveLength(1);
  });

  it("names its session when one of its actions runs", async () => {
    shown = { project: "/one", token: "tok-a" };
    sectionChanged(pr("tok-a"));
    await run(listed()[0], open, "pr/12");
    expect(taken[0].session).toBe("tok-a");
  });
});

describe("a row with facts", () => {
  const facts = [
    { label: "Checks", text: "3 of 4 passed", state: "failed" as const },
    { label: "Review", text: "Waiting on Ada", state: "waiting" as const },
  ];

  it("opens and closes, several at once, and a row without facts never opens", () => {
    sectionChanged(
      event({ rows: [row("a", { facts }), row("b", { facts }), row("c")] }),
    );
    const [section] = listed();
    const [a, b, c] = section.rows;
    expect(factsOf(a)).toEqual(facts);
    expect(factsOf(c)).toEqual([]);
    toggleOpen(section, a);
    toggleOpen(section, b);
    toggleOpen(section, c);
    expect([isOpen(section, a), isOpen(section, b), isOpen(section, c)]).toEqual([true, true, false]);
    toggleOpen(section, a);
    expect(isOpen(section, a)).toBe(false);
    toggleOpen(section, b, true);
    expect(isOpen(section, b)).toBe(true);
    toggleOpen(section, b, false);
    expect(isOpen(section, b)).toBe(false);
  });

  it("stays open across new rows from the plugin, and is forgotten once the row loses its facts or goes", () => {
    sectionChanged(event({ rows: [row("a", { facts }), row("b", { facts })] }));
    let [section] = listed();
    toggleOpen(section, section.rows[0]);
    toggleOpen(section, section.rows[1]);
    sectionChanged(event({ rows: [row("a", { facts }), row("b"), row("c", { facts })] }));
    [section] = listed();
    expect(isOpen(section, section.rows[0])).toBe(true);
    expect(isOpen(section, section.rows[1])).toBe(false);
    sectionChanged(event({ rows: [row("b", { facts })] }));
    [section] = listed();
    expect(isOpen(section, section.rows[0])).toBe(false);
    expect(Object.keys(pluginSections.open)).toEqual([]);
  });

  it("is open in one session and not in another", () => {
    sectionChanged(event({ session: "tok-a", rows: [row("a", { facts })] }));
    sectionChanged(event({ session: "tok-b", rows: [row("a", { facts })] }));
    shown = { project: "/one", token: "tok-a" };
    toggleOpen(listed()[0], listed()[0].rows[0]);
    expect(isOpen(listed()[0], listed()[0].rows[0])).toBe(true);
    shown = { project: "/one", token: "tok-b" };
    expect(isOpen(listed()[0], listed()[0].rows[0])).toBe(false);
  });
});
