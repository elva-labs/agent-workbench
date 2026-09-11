import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginAction,
  PluginActionRequest,
  PluginRow,
  PluginSectionEvent,
} from "$lib/core";
import {
  NOTICE_MS,
  listed,
  noticeOf,
  noticed,
  pluginSections,
  resetPluginSections,
  run,
  sectionChanged,
  sectionOf,
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
  project: "/one",
  rows: [row("checks/lint")],
  actions: [refresh],
  ...extra,
});

beforeEach(() => {
  resetWorkspace();
  resetPluginSections();
  taken.length = 0;
  refuse = null;
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

  it("goes when the plugin sends none, leaving the other projects alone", () => {
    sectionChanged(event());
    sectionChanged(event({ project: "/two" }));
    sectionChanged(event({ rows: [] }));
    expect(listed()).toEqual([]);
    workspace.active = "/two";
    expect(listed()).toHaveLength(1);
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
      },
      {
        source: "src-1",
        plugin: "github",
        section: "Pull request",
        action: "refresh",
        row: null,
        input: {},
        project: "/one",
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
