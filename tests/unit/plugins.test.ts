import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo, PluginSource, ProjectInfo } from "$lib/core";
import {
  addSource,
  checkSource,
  enablePlugin,
  loadPlugins,
  plugins,
  projectsToSend,
  removeSource,
  resetPlugins,
  stateChanged,
  stateLabel,
  summary,
  trust,
  trusted,
  updateSource,
} from "$lib/plugins.svelte";

const github = (): PluginInfo => ({
  name: "github",
  path: "github",
  description: "Pull requests.",
  version: "0.2.0",
  run: ["/usr/local/bin/node", "main.js"],
  tools: ["pr", "checks"],
  sections: ["Pull request"],
  view: "wide",
  enabled: false,
  state: "off",
  detail: null,
  hello: null,
});
const source = (id = "src-1"): PluginSource => ({
  id,
  kind: "git",
  location: "https://github.com/elva-labs/workbench-plugins.git",
  reference: null,
  commit: "0123456789abcdef",
  newer: null,
  error: null,
  plugins: [github()],
});

const calls: string[] = [];
let fail: string | null = null;
vi.mock("$lib/core", () => ({
  core: () => ({
    async pluginSources() {
      return [source()];
    },
    async pluginAdd(location: string) {
      calls.push(`add:${location}`);
      if (fail !== null) throw new Error(fail);
      return source("src-2");
    },
    async pluginRemove(id: string) {
      calls.push(`remove:${id}`);
    },
    async pluginCheck(id: string) {
      calls.push(`check:${id}`);
      return "fedcba9876543210";
    },
    async pluginUpdate(id: string) {
      calls.push(`update:${id}`);
      return { ...source(id), commit: "fedcba9876543210" };
    },
    async pluginEnable(id: string, name: string, on: boolean) {
      calls.push(`enable:${id}:${name}:${on}`);
      const s = source(id);
      s.plugins[0].enabled = on;
      s.plugins[0].state = on ? "starting" : "off";
      return s;
    },
  }),
}));

beforeEach(() => {
  localStorage.clear();
  resetPlugins();
  calls.length = 0;
  fail = null;
});

describe("the sources", () => {
  it("load from the core, and an added one joins them", async () => {
    await loadPlugins();
    expect(plugins.sources.map((s) => s.id)).toEqual(["src-1"]);
    expect(await addSource(" https://example.com/good.git ", null)).toBe(true);
    expect(calls).toEqual(["add: https://example.com/good.git "]);
    expect(plugins.sources.map((s) => s.id)).toEqual(["src-1", "src-2"]);
  });

  it("keep the reason a source could not be added", async () => {
    fail = "could not clone: not found";
    expect(await addSource("https://example.com/bad.git")).toBe(false);
    expect(plugins.error).toContain("could not clone");
    expect(plugins.sources).toEqual([]);
    expect(plugins.busy).toBe(false);
  });

  it("are removed, checked and updated through the core", async () => {
    await loadPlugins();
    await checkSource("src-1");
    expect(plugins.sources[0].newer).toBe("fedcba9876543210");
    await updateSource("src-1");
    expect(plugins.sources[0].commit).toBe("fedcba9876543210");
    expect(plugins.sources[0].newer).toBeNull();
    await removeSource("src-1");
    expect(plugins.sources).toEqual([]);
    expect(calls).toEqual(["check:src-1", "update:src-1", "remove:src-1"]);
  });
});

describe("the open projects", () => {
  it("go to the core as the paths they are, host and all", () => {
    const project = (path: string): ProjectInfo => ({
      path,
      name: path.split("/").pop()!,
      repository: path,
      isGit: true,
    });
    expect(projectsToSend([])).toEqual([]);
    expect(
      projectsToSend([project("/one"), project("ssh://lab/srv/two")]),
    ).toEqual(["/one", "ssh://lab/srv/two"]);
  });
});

describe("a plugin", () => {
  it("is turned on through the core and follows the state the core tells", async () => {
    await loadPlugins();
    await enablePlugin("src-1", "github", true);
    expect(calls).toEqual(["enable:src-1:github:true"]);
    expect(plugins.sources[0].plugins[0].state).toBe("starting");
    stateChanged({
      source: "src-1",
      name: "github",
      state: "running",
      detail: null,
      hello: {
        name: "github",
        version: "0.2.0",
        tools: [],
        sections: [],
        view: null,
      },
    });
    expect(stateLabel(plugins.sources[0].plugins[0])).toBe("running 0.2.0");
    stateChanged({
      source: "src-1",
      name: "github",
      state: "stopped",
      detail: "exited with code 1",
      hello: null,
    });
    expect(stateLabel(plugins.sources[0].plugins[0])).toBe(
      "stopped: exited with code 1, starting again",
    );
    // A state for a plugin that is not listed is nothing.
    stateChanged({
      source: "src-9",
      name: "x",
      state: "running",
      detail: null,
      hello: null,
    });
    expect(plugins.sources).toHaveLength(1);
  });

  // The core tells the window what a plugin's process is doing through
  // events, which can arrive before the answer that started it.
  it("keeps the state the events told, over the answer that starts it", async () => {
    await loadPlugins();
    const running = enablePlugin("src-1", "github", true);
    expect(plugins.sources[0].plugins[0].state).toBe("starting");
    stateChanged({
      source: "src-1",
      name: "github",
      state: "running",
      detail: null,
      hello: {
        name: "github",
        version: "0.2.0",
        tools: [],
        sections: [],
        view: null,
      },
    });
    await running;
    expect(plugins.sources[0].plugins[0].state).toBe("running");
    expect(plugins.sources[0].plugins[0].enabled).toBe(true);
    // Loading afresh takes the core's word for everything.
    await loadPlugins();
    expect(plugins.sources[0].plugins[0].state).toBe("off");
  });

  it("says what enabling it means, in a few words", () => {
    expect(summary(github())).toBe(
      "2 tools, 1 section, a wide view, runs node",
    );
    expect(
      summary({
        ...github(),
        tools: [],
        sections: [],
        view: null,
        run: ["sh", "x"],
      }),
    ).toBe("runs sh");
    expect(
      stateLabel({ ...github(), state: "failed", detail: "needs node" }),
    ).toBe("failed: needs node");
    expect(stateLabel(github())).toBe("off");
  });

  it("is trusted once, and the window remembers", () => {
    expect(trusted("src-1", "github")).toBe(false);
    trust("src-1", "github");
    expect(trusted("src-1", "github")).toBe(true);
    expect(trusted("src-1", "git")).toBe(false);
    localStorage.setItem("workbench.plugins.trusted", "nonsense");
    expect(trusted("src-1", "github")).toBe(false);
  });
});
