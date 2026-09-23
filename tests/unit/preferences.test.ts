import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, StoredSettings } from "$lib/core";

const state = {
  stored: null as Settings | null,
  sets: [] as Partial<Settings>[],
  /** Holds each change's answer until the test lets it go. */
  holding: false,
  held: [] as (() => void)[],
  changed: null as ((settings: Settings) => void) | null,
  noCore: false,
  refuse: null as string | null,
  hookCalls: [] as string[],
};

const DEFAULTS: Settings = {
  appearance: "system",
  look: "modern",
  palette: "teal",
  terminalFont: "system",
  interfaceFont: "system",
  keys: {},
  hooks: { everywhere: true, overrides: {} },
  themes: {},
  userStyles: false,
};

vi.mock("$lib/core", () => ({
  core: () => ({
    async settingsGet(): Promise<StoredSettings> {
      if (state.noCore) throw new Error("no core");
      return state.stored === null
        ? { stored: false, settings: DEFAULTS }
        : { stored: true, settings: state.stored };
    },
    settingsSet(change: Partial<Settings>): Promise<Settings> {
      if (state.noCore) return Promise.reject(new Error("no core"));
      state.sets.push(change);
      if (state.refuse !== null) return Promise.reject(new Error(state.refuse));
      const next = { ...(state.stored ?? DEFAULTS), ...change };
      state.stored = next;
      if (!state.holding) return Promise.resolve(next);
      // Answered with the file as it is when the answer goes, which may
      // carry what something else wrote meanwhile.
      return new Promise((resolve) => state.held.push(() => resolve({ ...state.stored! })));
    },
    async onSettingsChanged(handler: (settings: Settings) => void) {
      if (state.noCore) throw new Error("no core");
      state.changed = handler;
      return () => {
        state.changed = null;
      };
    },
    async hookStatus(project: string) {
      state.hookCalls.push(`status:${project}`);
      return { installed: false, settings: "", events: "" };
    },
    async hookInstall(project: string) {
      state.hookCalls.push(`install:${project}`);
      return { installed: true, settings: "", events: "" };
    },
    async hookUninstall(project: string) {
      state.hookCalls.push(`uninstall:${project}`);
      return { installed: false, settings: "", events: "" };
    },
  }),
}));

import { hook, loadHooks, reset as resetHooks, setEverywhere } from "$lib/hook.svelte";
import { PRESETS, applyPreset, keys, resetKeys, setBinding } from "$lib/keys.svelte";
import { resetPersist } from "$lib/persist";
import { adopt, currentSettings, followSettings } from "$lib/preferences.svelte";
import { loadTheme, setLook, setPalette, theme } from "$lib/theme.svelte";
import { workspace } from "$lib/workspace.svelte";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  state.stored = null;
  state.sets = [];
  state.holding = false;
  state.held = [];
  state.changed = null;
  state.noCore = false;
  state.refuse = null;
  state.hookCalls = [];
  localStorage.clear();
  resetPersist();
  resetKeys();
  resetHooks();
  theme.choice = "system";
  theme.palette = "teal";
  theme.look = "modern";
  theme.mono = "system";
  theme.sans = "system";
  delete document.documentElement.dataset.palette;
  delete document.documentElement.dataset.look;
  workspace.open = [];
});

describe("followSettings", () => {
  it("takes the machine's settings when the core has a file", async () => {
    state.stored = {
      ...DEFAULTS,
      appearance: "dark",
      palette: "amber",
      look: "terminal",
      keys: { review: { key: "g", shift: false, alt: false } },
      hooks: { everywhere: false, overrides: { "/p": true } },
    };
    await followSettings();
    expect(theme.choice).toBe("dark");
    expect(theme.palette).toBe("amber");
    expect(document.documentElement.dataset.palette).toBe("amber");
    expect(document.documentElement.dataset.look).toBeUndefined();
    expect(keys.bindings.review).toEqual({ key: "g", shift: false, alt: false });
    expect(keys.bindings.find).toEqual(PRESETS.default.find);
    expect(keys.preset).toBe("custom");
    expect(hook.everywhere).toBe(false);
    expect(hook.overrides).toEqual({ "/p": true });
    expect(state.sets).toEqual([]);
  });

  it("keeps a copy for the first frame of the next start", async () => {
    state.stored = { ...DEFAULTS, palette: "rose" };
    await followSettings();
    theme.palette = "teal";
    loadTheme();
    expect(theme.palette).toBe("rose");
  });

  it("hands over the window's own copy once, when the machine has no file", async () => {
    localStorage.setItem("workbench.palette", "indigo");
    localStorage.setItem("workbench.look", "terminal");
    loadTheme();
    loadHooks();
    setBindingQuietly();
    await followSettings();
    expect(state.sets).toHaveLength(1);
    const handed = state.sets[0];
    expect(handed.palette).toBe("indigo");
    expect(handed.look).toBe("terminal");
    expect(handed.keys?.review).toEqual({ key: "g", shift: false, alt: false });
    expect(Object.keys(handed.keys ?? {})).toHaveLength(Object.keys(PRESETS.default).length);
    expect(handed.hooks).toEqual({ everywhere: true, overrides: {} });
    expect(state.stored?.palette).toBe("indigo");
  });

  it("hands over hooks off for a setup from before the hooks choice", async () => {
    localStorage.setItem("workbench.workspace", JSON.stringify({ open: [] }));
    loadHooks();
    await followSettings();
    expect(state.sets[0].hooks).toEqual({ everywhere: false, overrides: {} });
  });

  it("leaves the window on its own copy when there is no core", async () => {
    state.noCore = true;
    localStorage.setItem("workbench.palette", "mono");
    loadTheme();
    await followSettings();
    expect(theme.palette).toBe("mono");
    setPalette("amber");
    await settle();
    expect(theme.palette).toBe("amber");
  });

  it("takes news of a change made elsewhere", async () => {
    state.stored = { ...DEFAULTS };
    await followSettings();
    state.changed?.({ ...DEFAULTS, palette: "indigo", look: "terminal" });
    expect(theme.palette).toBe("indigo");
    expect(theme.look).toBe("terminal");
    expect(document.documentElement.dataset.palette).toBe("indigo");
  });

  it("stops listening when told to", async () => {
    state.stored = { ...DEFAULTS };
    const stop = await followSettings();
    stop();
    expect(state.changed).toBeNull();
  });
});

describe("a change in the window", () => {
  beforeEach(async () => {
    state.stored = { ...DEFAULTS };
    await followSettings();
  });

  it("sends only what changed", async () => {
    setPalette("amber");
    setLook("terminal");
    await settle();
    expect(state.sets).toEqual([{ palette: "amber" }, { look: "terminal" }]);
    expect(state.stored?.palette).toBe("amber");
  });

  it("sends the whole chord table", async () => {
    applyPreset("vim");
    expect(setBinding("review", { key: "g", shift: false, alt: false })).toBeNull();
    await settle();
    expect(state.sets).toHaveLength(2);
    expect(state.sets[1].keys?.review).toEqual({ key: "g", shift: false, alt: false });
    expect(state.sets[1].keys?.["focus.sessions"]).toEqual(PRESETS.vim["focus.sessions"]);
  });

  it("sends the hooks answer", async () => {
    await setEverywhere(false, []);
    await settle();
    expect(state.sets).toEqual([{ hooks: { everywhere: false, overrides: {} } }]);
  });

  it("is not undone by an echo that arrives while it is on its way", async () => {
    state.holding = true;
    setPalette("amber");
    setPalette("rose");
    // The core's news of the first change lands while the second is still
    // on its way: the window has already moved past it.
    state.changed?.({ ...DEFAULTS, palette: "amber" });
    expect(theme.palette).toBe("rose");
    state.held.forEach((release) => release());
    await settle();
    expect(theme.palette).toBe("rose");
  });

  it("settles on what the core answered once the last change is in", async () => {
    state.holding = true;
    setPalette("amber");
    // Something else wrote the look meanwhile; the answer carries it.
    state.stored = { ...(state.stored ?? DEFAULTS), look: "terminal" };
    state.held.forEach((release) => release());
    await settle();
    expect(theme.palette).toBe("amber");
    expect(theme.look).toBe("terminal");
  });

  it("holds in the window when the core refuses it", async () => {
    state.refuse = "the disk is full";
    setPalette("amber");
    await settle();
    expect(theme.palette).toBe("amber");
  });
});

describe("adopt", () => {
  it("leaves a part it does not know as it is", () => {
    theme.palette = "rose";
    adopt({
      ...DEFAULTS,
      palette: "plaid",
      look: "baroque" as Settings["look"],
      appearance: "dark",
    });
    expect(theme.palette).toBe("rose");
    expect(theme.look).toBe("modern");
    expect(theme.choice).toBe("dark");
  });

  it("brings the open projects to a new hooks answer", async () => {
    workspace.open = [
      { path: "/a", name: "a", repository: "/a", isGit: true } as never,
    ];
    adopt({ ...DEFAULTS, hooks: { everywhere: true, overrides: {} } });
    await settle();
    expect(state.hookCalls).toContain("install:/a");
  });

  it("does not touch the projects when the hooks answer is the same", async () => {
    workspace.open = [
      { path: "/a", name: "a", repository: "/a", isGit: true } as never,
    ];
    hook.everywhere = true;
    hook.overrides = {};
    adopt({ ...DEFAULTS, hooks: { everywhere: true, overrides: {} } });
    await settle();
    expect(state.hookCalls).toEqual([]);
  });

  it("is what currentSettings reads back", () => {
    const settings: Settings = {
      ...DEFAULTS,
      appearance: "light",
      palette: "mono",
      terminalFont: "jetbrains",
      interfaceFont: "inter",
      keys: { ...PRESETS.vim },
      hooks: { everywhere: false, overrides: { "/x": true } },
    };
    adopt(settings);
    expect(currentSettings()).toEqual(settings);
  });
});

/** A binding made before the core is heard from, as a window from before
    the settings file would have it in its own storage. */
function setBindingQuietly() {
  keys.bindings.review = { key: "g", shift: false, alt: false };
  localStorage.setItem("workbench.keys", JSON.stringify({ bindings: keys.bindings }));
}
