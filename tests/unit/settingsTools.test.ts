import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, SettingsRequest } from "$lib/core";

const answers: {
  id: string;
  cwd: string;
  content: string | null;
  error: string | null;
}[] = [];
const sets: Partial<Settings>[] = [];

vi.mock("$lib/core", () => ({
  core: () => ({
    settingsAnswer: async (
      id: string,
      cwd: string,
      content: string | null,
      error: string | null,
    ) => {
      answers.push({ id, cwd, content, error });
    },
    settingsSet: async (change: Partial<Settings>) => {
      sets.push(change);
      return change as Settings;
    },
  }),
}));

import { PRESETS, keys, resetKeys } from "$lib/keys.svelte";
import { resetPersist } from "$lib/persist";
import { sessions } from "$lib/sessions.svelte";
import {
  UNDO_FOR,
  allowChange,
  declineChange,
  describeSettings,
  dismissUndo,
  handle,
  plan,
  resetSettingsTools,
  settingsAsk,
  undoChange,
} from "$lib/settingsTools.svelte";
import { theme } from "$lib/theme.svelte";

let next = 0;
function request(
  tool: SettingsRequest["tool"],
  args: Record<string, unknown> = {},
  session: string | null = null,
): SettingsRequest {
  next += 1;
  return { id: `call-${next}`, tool, arguments: args, cwd: "/p", session };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  answers.length = 0;
  sets.length = 0;
  resetSettingsTools();
  resetPersist();
  resetKeys();
  theme.choice = "system";
  theme.palette = "teal";
  theme.look = "modern";
  theme.mono = "system";
  theme.sans = "system";
  delete document.documentElement.dataset.palette;
  delete document.documentElement.dataset.look;
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the settings tool", () => {
  it("reads the settings as they are, with what each takes", async () => {
    theme.palette = "amber";
    await handle(request("settings"));
    expect(answers).toHaveLength(1);
    const text = answers[0].content!;
    expect(answers[0].error).toBeNull();
    expect(text).toContain("palette: amber (one of teal, indigo, amber, rose, mono)");
    expect(text).toContain("look: modern (one of modern, terminal)");
    expect(text).toContain("review: d  (Open or close the file viewer)");
    expect(text).toContain("session.next: shift+down");
    expect(text).toContain("user's to change");
  });

  it("answers a call delivered twice once", async () => {
    const call = request("settings");
    await handle(call);
    await handle(call);
    expect(answers).toHaveLength(1);
  });
});

describe("plan", () => {
  it("lists only what moves, in the user's words", () => {
    const { changes } = plan({ palette: "amber", look: "modern", appearance: "dark" });
    expect(changes).toEqual([
      { field: "appearance", label: "Appearance", from: "System", to: "Dark" },
      { field: "palette", label: "Palette", from: "Teal", to: "Amber" },
    ]);
  });

  it("refuses a value a setting does not take, and names what it does", () => {
    expect(() => plan({ look: "baroque" })).toThrow(/look is one of modern, terminal/);
    expect(() => plan({ terminalFont: "comic" })).toThrow(/terminalFont is one of/);
  });

  it("refuses a setting that does not exist", () => {
    expect(() => plan({ colour: "red" })).toThrow(/no setting called colour/);
  });

  it("refuses the hooks and the plugins as the user's own", () => {
    expect(() => plan({ hooks: { everywhere: false } })).toThrow(/user's to change/);
    expect(() => plan({ plugins: [] })).toThrow(/user's to change/);
  });

  it("reads chords as text, the modifier implied", () => {
    const { next, changes } = plan({ keys: { review: "shift+g", find: "cmd+alt+k" } });
    expect(next.keys?.review).toEqual({ key: "g", shift: true, alt: false });
    expect(next.keys?.find).toEqual({ key: "k", shift: false, alt: true });
    expect(changes.map((change) => change.field)).toEqual(["keys.review", "keys.find"]);
    expect(changes[0].label).toBe("Open or close the file viewer");
  });

  it("names a whole preset as one change", () => {
    const { next, changes } = plan({ keyPreset: "vim" });
    expect(next.keys).toEqual(PRESETS.vim);
    expect(changes).toEqual([{ field: "keyPreset", label: "Keys", from: "Default", to: "Vim" }]);
  });

  it("lays chords over a preset", () => {
    const { next } = plan({ keyPreset: "vim", keys: { review: "g" } });
    expect(next.keys?.["focus.sessions"]).toEqual(PRESETS.vim["focus.sessions"]);
    expect(next.keys?.review).toEqual({ key: "g", shift: false, alt: false });
  });

  it("refuses a table with a chord twice, or one the agent needs", () => {
    expect(() => plan({ keys: { review: "e" } })).toThrow(/would be both/);
    expect(() => plan({ keys: { review: "c" } })).toThrow(/stays with the agent/);
    expect(() => plan({ keys: { review: "shift+c" } })).not.toThrow();
  });

  it("refuses an action that does not exist or a chord that does not read", () => {
    expect(() => plan({ keys: { launch: "k" } })).toThrow(/no action called launch/);
    expect(() => plan({ keys: { review: "hyper+k" } })).toThrow(/not a chord/);
    expect(() => plan({ keys: { review: 7 } })).toThrow(/not a chord/);
    expect(() => plan({ keys: "shift+k" })).toThrow(/object of chords/);
    expect(() => plan({ keyPreset: "emacs" })).toThrow(/keyPreset is one of default, vim/);
  });
});

describe("a change", () => {
  it("is refused at once when it will not do, and the user is not asked", async () => {
    await handle(request("settings_change", { look: "baroque" }));
    expect(settingsAsk.asking).toBeNull();
    expect(answers[0].error).toMatch(/look is one of/);
    expect(theme.look).toBe("modern");
  });

  it("that changes nothing is answered without asking", async () => {
    await handle(request("settings_change", { palette: "teal" }));
    expect(settingsAsk.asking).toBeNull();
    expect(answers[0].content).toMatch(/already so/);
  });

  it("waits for the user, and is made when they allow it", async () => {
    sessions.all = [{ id: "s-1", key: "k1", title: "Tidy the docs" } as never];
    const done = handle(request("settings_change", { palette: "amber", reason: "warmer" }, "s-1"));
    await settle();
    expect(answers).toHaveLength(0);
    expect(theme.palette).toBe("teal");
    const ask = settingsAsk.asking!;
    expect(ask.caller).toBe("Tidy the docs");
    expect(ask.reason).toBe("warmer");
    expect(ask.changes).toHaveLength(1);

    allowChange();
    await done;
    expect(theme.palette).toBe("amber");
    expect(document.documentElement.dataset.palette).toBe("amber");
    expect(sets).toContainEqual({ palette: "amber" });
    expect(answers[0].content).toMatch(/allowed the change\. Palette is now Amber/);
    expect(settingsAsk.undo?.caller).toBe("Tidy the docs");
    sessions.all = [];
  });

  it("changes nothing when the user declines, and says so", async () => {
    const done = handle(request("settings_change", { look: "terminal" }));
    await settle();
    declineChange();
    await done;
    expect(theme.look).toBe("modern");
    expect(sets).toEqual([]);
    expect(answers[0].error).toBe("The user declined the change. Nothing changed.");
    expect(settingsAsk.undo).toBeNull();
  });

  it("waits behind another one being asked", async () => {
    const first = handle(request("settings_change", { palette: "rose" }));
    const second = handle(request("settings_change", { look: "terminal" }));
    await settle();
    expect(settingsAsk.asking?.changes[0].field).toBe("palette");
    allowChange();
    await first;
    await settle();
    expect(settingsAsk.asking?.changes[0].field).toBe("look");
    declineChange();
    await second;
    expect(theme.palette).toBe("rose");
    expect(theme.look).toBe("modern");
    expect(answers.map((answer) => answer.error === null)).toEqual([true, false]);
  });

  it("is read against the settings the one before it left", async () => {
    const first = handle(request("settings_change", { palette: "rose" }));
    const second = handle(request("settings_change", { palette: "mono" }));
    const third = handle(request("settings_change", { palette: "rose" }));
    await settle();
    allowChange();
    await first;
    await settle();
    expect(settingsAsk.asking?.changes[0]).toMatchObject({ from: "Rose", to: "Mono" });
    declineChange();
    await second;
    await settle();
    // Rose is what the settings already are: nothing to ask.
    await third;
    expect(settingsAsk.asking).toBeNull();
    expect(answers.at(-1)?.content).toMatch(/already so/);
  });

  it("can be undone, which puts back only what it moved", async () => {
    const done = handle(
      request("settings_change", { palette: "amber", keys: { review: "g" } }),
    );
    await settle();
    allowChange();
    await done;
    expect(keys.bindings.review).toEqual({ key: "g", shift: false, alt: false });
    // The user changes something else meanwhile; undo leaves that alone.
    theme.look = "terminal";
    undoChange();
    expect(theme.palette).toBe("teal");
    expect(keys.bindings.review).toEqual(PRESETS.default.review);
    expect(theme.look).toBe("terminal");
    expect(settingsAsk.undo).toBeNull();
    expect(sets.at(-1)).toEqual({ keys: { ...PRESETS.default } });
  });

  it("is offered for undo for a while, then kept", async () => {
    vi.useFakeTimers();
    const done = handle(request("settings_change", { palette: "mono" }));
    await vi.advanceTimersByTimeAsync(0);
    allowChange();
    await done;
    expect(settingsAsk.undo).not.toBeNull();
    await vi.advanceTimersByTimeAsync(UNDO_FOR + 10);
    expect(settingsAsk.undo).toBeNull();
    undoChange();
    expect(theme.palette).toBe("mono");
  });

  it("can be kept at once", async () => {
    const done = handle(request("settings_change", { palette: "mono" }));
    await settle();
    allowChange();
    await done;
    dismissUndo();
    undoChange();
    expect(theme.palette).toBe("mono");
  });
});

describe("describeSettings", () => {
  it("lists every action with its chord", () => {
    const text = describeSettings();
    for (const action of Object.keys(PRESETS.default)) {
      expect(text).toContain(`  ${action}: `);
    }
  });
});
