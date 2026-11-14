import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, StoredSettings } from "$lib/core";

const state = {
  stored: null as Settings | null,
  sets: [] as Partial<Settings>[],
  handOvers: [] as Settings[],
  /** Holds the answer to the next hand-over until the test lets it go. */
  holdingHandOver: false,
  heldHandOver: null as (() => void) | null,
  /** Holds each change's answer until the test lets it go. */
  holding: false,
  held: [] as (() => void)[],
  /** Holds the answer to the first read until the test lets it go. */
  holdingRead: false,
  heldRead: null as (() => void) | null,
  changed: null as ((settings: Settings) => void) | null,
  missing: null as (() => void) | null,
  noCore: false,
  refuse: null as string | null,
  /** The file is there and does not parse. */
  unreadable: false,
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
  accounts: { list: {}, everywhere: null, overrides: {} },
  workflows: { list: [], default: null, overrides: {} },
  pastSessions: "forever",
  inactiveAfter: "week",
  themes: {},
  userStyles: false,
  notifications: true,
  chime: false,
};

vi.mock("$lib/core", () => ({
  core: () => ({
    async settingsGet(): Promise<StoredSettings> {
      if (state.noCore) throw new Error("no core");
      // Answered with the file as it was when it was read.
      const answer: StoredSettings = state.unreadable
        ? { stored: true, unreadable: true, settings: DEFAULTS }
        : state.stored === null
          ? { stored: false, settings: DEFAULTS }
          : { stored: true, settings: state.stored };
      if (!state.holdingRead) return answer;
      // Only the first read is held; a later one answers at once.
      state.holdingRead = false;
      return new Promise((resolve) => (state.heldRead = () => resolve(answer)));
    },
    settingsSet(change: Partial<Settings>): Promise<Settings> {
      if (state.noCore) return Promise.reject(new Error("no core"));
      state.sets.push(change);
      if (state.refuse !== null) {
        const refusal = new Error(state.refuse);
        if (!state.holding) return Promise.reject(refusal);
        return new Promise((_, reject) => state.held.push(() => reject(refusal)));
      }
      const next = { ...(state.stored ?? DEFAULTS), ...change };
      state.stored = next;
      if (!state.holding) return Promise.resolve(next);
      // Answered with the file as it is when the answer goes, which may
      // carry what something else wrote meanwhile.
      return new Promise((resolve) => state.held.push(() => resolve({ ...state.stored! })));
    },
    settingsHandOver(held: Settings): Promise<StoredSettings> {
      if (state.noCore) return Promise.reject(new Error("no core"));
      const answer = (): StoredSettings => {
        state.handOvers.push(held);
        // Written only while there is no file.
        if (state.unreadable) return { stored: true, unreadable: true, settings: DEFAULTS };
        // A field the core does not accept is set aside and the rest is
        // written.
        if (state.stored === null) {
          const accepted = { ...held };
          if (!["system", "plex", "jetbrains"].includes(accepted.terminalFont)) {
            accepted.terminalFont = DEFAULTS.terminalFont;
          }
          state.stored = { ...DEFAULTS, ...accepted };
        }
        return { stored: true, settings: state.stored };
      };
      if (!state.holdingHandOver) return Promise.resolve(answer());
      state.holdingHandOver = false;
      return new Promise((resolve) => (state.heldHandOver = () => resolve(answer())));
    },
    async onSettingsChanged(handler: (settings: Settings) => void) {
      if (state.noCore) throw new Error("no core");
      state.changed = handler;
      return () => {
        state.changed = null;
      };
    },
    async onSettingsMissing(handler: () => void) {
      state.missing = handler;
      return () => {
        state.missing = null;
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

import { ensure, hook, loadHooks, reset as resetHooks, setEverywhere } from "$lib/hook.svelte";
import { PRESETS, applyPreset, keys, resetKeys, setBinding } from "$lib/keys.svelte";
import { flush, resetPersist } from "$lib/persist";
import { refusal, showRefusal } from "$lib/refusal.svelte";
import { unread } from "$lib/unread.svelte";
import { accounts, reset as resetAccounts } from "$lib/accounts.svelte";
import { adopt, currentSettings, followSettings } from "$lib/preferences.svelte";
import { loadTheme, setLook, setPalette, setThemes, theme } from "$lib/theme.svelte";
import { notify, resetNotify, setChime, setNotifications } from "$lib/notify.svelte";
import { workspace } from "$lib/workspace.svelte";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  state.stored = null;
  state.sets = [];
  state.handOvers = [];
  state.holdingHandOver = false;
  state.heldHandOver = null;
  state.holding = false;
  state.held = [];
  state.holdingRead = false;
  state.heldRead = null;
  state.changed = null;
  state.missing = null;
  state.noCore = false;
  state.refuse = null;
  state.unreadable = false;
  state.hookCalls = [];
  localStorage.clear();
  showRefusal(null);
  unread.entries = [];
  resetPersist();
  resetKeys();
  resetHooks();
  resetNotify();
  resetAccounts();
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

  it("takes the notifications and the chime from the machine's settings", async () => {
    state.stored = { ...DEFAULTS, notifications: false, chime: true };
    await followSettings();
    expect(notify.notifications).toBe(false);
    expect(notify.chime).toBe(true);
    state.changed?.({ ...DEFAULTS });
    expect(notify.notifications).toBe(true);
    expect(notify.chime).toBe(false);
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
    expect(state.sets).toEqual([]);
    expect(state.handOvers).toHaveLength(1);
    const handed = state.handOvers[0];
    expect(handed.palette).toBe("indigo");
    expect(handed.look).toBe("terminal");
    expect(handed.keys?.review).toEqual({ key: "g", shift: false, alt: false });
    expect(Object.keys(handed.keys ?? {})).toHaveLength(Object.keys(PRESETS.default).length);
    expect(handed.hooks).toEqual({ everywhere: true, overrides: {} });
    expect(state.stored?.palette).toBe("indigo");
  });

  it("hands over a copy with a stale value in it and takes what the core kept", async () => {
    localStorage.setItem("workbench.palette", "indigo");
    loadTheme();
    theme.mono = "gone-mono" as typeof theme.mono;
    await followSettings();
    expect(state.handOvers).toHaveLength(1);
    expect(state.handOvers[0].terminalFont).toBe("gone-mono");
    expect(state.handOvers[0].palette).toBe("indigo");
    expect(state.stored?.palette).toBe("indigo");
    expect(theme.mono).toBe("system");
    expect(theme.palette).toBe("indigo");
    expect(refusal.reason).toBeNull();
  });

  it("hands over hooks off for a setup from before the hooks choice", async () => {
    localStorage.setItem("workbench.workspace", JSON.stringify({ open: [] }));
    loadHooks();
    await followSettings();
    expect(state.handOvers[0].hooks).toEqual({ everywhere: false, overrides: {} });
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

  it("keeps news that overtakes the answer to its first read", async () => {
    state.stored = { ...DEFAULTS };
    state.holdingRead = true;
    const following = followSettings();
    await vi.waitFor(() => expect(state.heldRead).not.toBeNull());
    // The file changed after the core read it for the answer, and the news
    // of the change reached the window before the answer did.
    state.changed?.({
      ...DEFAULTS,
      palette: "indigo",
      accounts: {
        list: { Work: { claude: null, codex: "~/.codex-work" } },
        everywhere: null,
        overrides: { "/p": "Work" },
      },
    });
    state.heldRead?.();
    await following;
    expect(theme.palette).toBe("indigo");
    expect(Object.keys(accounts.list)).toEqual(["Work"]);
    expect(accounts.overrides).toEqual({ "/p": "Work" });
  });

  it("takes the newer file, not the older read, when a change made before the first read answered is refused", async () => {
    state.stored = { ...DEFAULTS, look: "terminal" };
    state.holdingRead = true;
    state.holding = true;
    state.refuse = "the disk is full";
    const following = followSettings();
    await vi.waitFor(() => expect(state.heldRead).not.toBeNull());
    // A change made before the first read answers waits for it. News of
    // another change arrives meanwhile and is let pass, the read answers
    // and is let pass too, and the write is then refused. The file holds
    // the news.
    setPalette("amber");
    await settle();
    expect(state.sets).toEqual([]);
    state.stored = { ...DEFAULTS, look: "terminal", palette: "indigo" };
    state.changed?.(state.stored);
    expect(theme.look).toBe("modern");
    state.heldRead?.();
    await following;
    expect(theme.palette).toBe("amber");
    await vi.waitFor(() => expect(state.held).toHaveLength(1));
    state.held.forEach((release) => release());
    await settle();
    expect(theme.palette).toBe("indigo");
    expect(theme.look).toBe("terminal");
  });

  it("takes the news that was let pass when a refused write finds the file unreadable", async () => {
    state.stored = { ...DEFAULTS };
    await followSettings();
    state.holding = true;
    state.refuse = "the settings file could not be read";
    setPalette("amber");
    state.unreadable = true;
    state.changed?.({ ...DEFAULTS, palette: "indigo" });
    state.held.forEach((release) => release());
    await settle();
    expect(theme.palette).toBe("indigo");
  });

  it("counts a write's answer as heard, so the older read does not undo it", async () => {
    state.stored = { ...DEFAULTS };
    state.holdingRead = true;
    state.holding = true;
    const following = followSettings();
    await vi.waitFor(() => expect(state.heldRead).not.toBeNull());
    setPalette("amber");
    state.heldRead?.();
    await following;
    expect(theme.palette).toBe("amber");
    await vi.waitFor(() => expect(state.held).toHaveLength(1));
    // Something else wrote the look after the read and before the answer.
    state.stored = { ...(state.stored ?? DEFAULTS), look: "terminal" };
    state.held.forEach((release) => release());
    await settle();
    expect(theme.look).toBe("terminal");
    expect(theme.palette).toBe("amber");
  });

  it("keeps what it has when the core could not read the file, and takes the file once it is whole", async () => {
    localStorage.setItem("workbench.palette", "indigo");
    loadTheme();
    state.stored = { ...DEFAULTS, palette: "rose" };
    state.unreadable = true;
    await followSettings();
    expect(theme.palette).toBe("indigo");
    expect(state.sets).toEqual([]);
    state.changed?.({ ...DEFAULTS, palette: "rose" });
    expect(theme.palette).toBe("rose");
  });

  it("does not hand over its copy to a file that could not be read", async () => {
    localStorage.setItem("workbench.palette", "indigo");
    loadTheme();
    state.stored = null;
    state.unreadable = true;
    await followSettings();
    expect(state.sets).toEqual([]);
    expect(state.handOvers).toEqual([]);
    expect(theme.palette).toBe("indigo");
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

  it("sends the notifications and the chime on their own", async () => {
    setNotifications(false);
    setChime(true);
    await settle();
    expect(state.sets).toEqual([{ notifications: false }, { chime: true }]);
    expect(currentSettings()).toMatchObject({ notifications: false, chime: true });
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

  it("sends the themes without the palette when the palette does not move", async () => {
    const dusk = { label: "Dusk", light: {}, dark: {}, shape: {} };
    setThemes({ dusk });
    await settle();
    expect(state.sets.at(-1)).toEqual({ themes: { dusk } });
    setThemes({ dusk }, "dusk");
    await settle();
    expect(state.sets.at(-1)).toEqual({ themes: { dusk }, palette: "dusk" });
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

  it("goes back to what is stored when the core refuses it, and says why", async () => {
    state.refuse = "the disk is full";
    setPalette("amber");
    await settle();
    expect(theme.palette).toBe("teal");
    expect(refusal.reason).toBe("the disk is full");
    state.refuse = null;
    setPalette("rose");
    await settle();
    expect(refusal.reason).toBeNull();
  });

  it("takes the file as it is now when a change is refused, even when no news of it arrived", async () => {
    state.refuse = "the disk is full";
    // The file was edited by hand and the news has not reached the window.
    state.stored = { ...DEFAULTS, palette: "rose", look: "terminal" };
    setPalette("amber");
    await settle();
    expect(theme.palette).toBe("rose");
    expect(theme.look).toBe("terminal");
  });

  it("keeps the change a refusal could not be recovered from, and says why", async () => {
    state.unreadable = true;
    state.refuse = "the settings file could not be read";
    setPalette("amber");
    await settle();
    expect(theme.palette).toBe("teal");
    expect(refusal.reason).toContain("could not be read");
  });

  it("tells an agent's change that the core refused it", async () => {
    state.refuse = "the disk is full";
    setPalette("amber");
    expect(await flush()).toBe("the disk is full");
    state.refuse = null;
    setPalette("rose");
    expect(await flush()).toBeNull();
  });

  it("hands over what it holds when the file goes missing", async () => {
    await followSettings();
    setPalette("indigo");
    await settle();
    state.sets = [];
    state.stored = null;
    state.missing?.();
    await settle();
    expect(state.sets).toEqual([]);
    expect(state.handOvers).toHaveLength(1);
    expect(state.handOvers[0].palette).toBe("indigo");
    expect(Object.keys(state.handOvers[0].keys ?? {}).length).toBeGreaterThan(0);
    expect((state.stored as Settings | null)?.palette).toBe("indigo");
  });

  it("takes the file an editor wrote while it was missing, and writes nothing over it", async () => {
    await followSettings();
    setPalette("indigo");
    await settle();
    state.sets = [];
    // The editor moved the old file aside and wrote the new one before the
    // window's copy reached the core.
    const edited = { ...DEFAULTS, palette: "mono", look: "terminal" } as Settings;
    state.stored = edited;
    state.missing?.();
    await settle();
    expect(state.sets).toEqual([]);
    expect(state.stored).toEqual(edited);
    expect(theme.palette).toBe("mono");
    expect(theme.look).toBe("terminal");
  });

  it("hands over what it knows the file held and did not use", async () => {
    await followSettings();
    const entry = {
      field: "keys" as const,
      section: "",
      name: "find",
      reason: "the chord for find is not a key",
      entry: { key: 3 },
    };
    state.changed?.({ ...DEFAULTS, unreadEntries: [entry] });
    state.stored = null;
    state.missing?.();
    await settle();
    expect(state.handOvers[0].unreadEntries).toEqual([entry]);
  });

  it("holds a change made while it hands over, and lays it over what the hand-over left", async () => {
    await followSettings();
    state.sets = [];
    state.stored = null;
    state.holdingHandOver = true;
    state.missing?.();
    await vi.waitFor(() => expect(state.heldHandOver).not.toBeNull());
    setLook("terminal");
    await settle();
    expect(state.sets).toEqual([]);
    state.heldHandOver?.();
    await vi.waitFor(() => expect(state.sets).toEqual([{ look: "terminal" }]));
    await settle();
    expect((state.stored as Settings | null)?.look).toBe("terminal");
    expect(theme.look).toBe("terminal");
  });

  it("says the window shows what is stored after a refusal it could read the file for", async () => {
    await followSettings();
    state.refuse = "the disk is full";
    setPalette("amber");
    await settle();
    expect(refusal.reason).toBe("the disk is full");
    expect(refusal.shows).toBe("stored");
  });

  it("says the window shows the last settings that could be read when the file cannot be", async () => {
    await followSettings();
    state.unreadable = true;
    state.refuse = "the settings file is empty or not valid settings";
    setPalette("amber");
    await settle();
    expect(refusal.shows).toBe("last");
    expect(theme.palette).toBe("teal");
  });

  it("hands its settings back when a change finds the file gone", async () => {
    await followSettings();
    state.stored = null;
    state.refuse = "the settings file is gone";
    setPalette("amber");
    await settle();
    expect(theme.palette).toBe("teal");
    expect(state.handOvers).toHaveLength(1);
    expect(state.handOvers[0].palette).toBe("teal");
    expect(refusal.shows).toBe("last");
  });

  it("leaves a key the file holds and the app does not use out of what it sends", async () => {
    await followSettings();
    state.changed?.({
      ...DEFAULTS,
      unreadEntries: [
        { field: "keys", section: "", name: "find", reason: "the chord for find is not a key" },
      ],
    });
    expect(unread.entries).toHaveLength(1);
    setPalette("amber");
    setBinding("review", { key: "g", shift: false, alt: false });
    await settle();
    const sentKeys = state.sets.at(-1)?.keys ?? {};
    expect(sentKeys.review).toEqual({ key: "g", shift: false, alt: false });
    expect(sentKeys.find).toBeUndefined();
    setBinding("find", { key: "f", shift: true, alt: true });
    await settle();
    expect(state.sets.at(-1)?.keys?.find).toEqual({ key: "f", shift: true, alt: true });
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
    hook.everywhere = false;
    ensure("/a");
    await settle();
    state.hookCalls = [];
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
