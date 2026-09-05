import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTIONS,
  PRESETS,
  actionOf,
  applyPreset,
  chordFor,
  chordFromEvent,
  describe as spell,
  keys,
  loadKeys,
  presetOf,
  resetBinding,
  resetKeys,
  setBinding,
} from "$lib/keys.svelte";

const chord = (key: string, shift = false, alt = false) => ({ key, shift, alt });

beforeEach(() => {
  resetKeys();
  localStorage.clear();
});

describe("presets", () => {
  it("starts on the default preset", () => {
    expect(keys.preset).toBe("default");
    expect(chordFor("focus.sessions")).toEqual(chord("1"));
  });

  it("switches whole tables", () => {
    applyPreset("vim");
    expect(keys.preset).toBe("vim");
    expect(chordFor("focus.sessions")).toEqual(chord("h"));
    expect(chordFor("session.next")).toEqual(chord("n", true));
    applyPreset("default");
    expect(chordFor("focus.sessions")).toEqual(chord("1"));
  });

  it("has no two actions on one chord in any preset", () => {
    for (const table of Object.values(PRESETS)) {
      const seen = new Set(ACTIONS.map(({ key }) => JSON.stringify(table[key])));
      expect(seen.size).toBe(ACTIONS.length);
    }
  });

  it("recognises a table as the preset it matches", () => {
    expect(presetOf({ ...PRESETS.vim })).toBe("vim");
    expect(presetOf({ ...PRESETS.default, review: chord("g") })).toBe("custom");
  });
});

describe("a chord of one's own", () => {
  it("binds, and the table becomes custom", () => {
    expect(setBinding("review", chord("g"))).toBeNull();
    expect(chordFor("review")).toEqual(chord("g"));
    expect(keys.preset).toBe("custom");
    expect(actionOf(chord("g"))).toBe("review");
    expect(actionOf(chord("d"))).toBeNull();
  });

  it("is a preset again once the table matches one", () => {
    setBinding("review", chord("g"));
    setBinding("review", chord("d"));
    expect(keys.preset).toBe("default");
  });

  // Taking a chord away from another action is a second decision, not a
  // side effect of the first.
  it("refuses a chord another action holds, and says which", () => {
    const text = setBinding("review", chord("e"));
    expect(text).toContain("Diff or whole file");
    expect(chordFor("review")).toEqual(chord("d"));
    expect(chordFor("view")).toEqual(chord("e"));
  });

  it("lets an action keep its own chord", () => {
    expect(setBinding("review", chord("d"))).toBeNull();
  });

  // Ctrl is the modifier on Windows and Linux, and these two are the agent's.
  it("refuses the chords the agent needs", () => {
    expect(setBinding("review", chord("c"))).toContain("agent");
    expect(setBinding("review", chord("r"))).toContain("agent");
    expect(setBinding("review", chord("c", true))).toBeNull();
  });

  it("resets one action to the default preset's chord", () => {
    applyPreset("vim");
    expect(resetBinding("focus.sessions")).toBeNull();
    expect(chordFor("focus.sessions")).toEqual(chord("1"));
    expect(keys.preset).toBe("custom");
  });
});

describe("chords and key events", () => {
  it("reads a chord off an event with the platform modifier", () => {
    expect(chordFromEvent({ key: "D", metaKey: true, shiftKey: true }, true)).toEqual(chord("d", true));
    expect(chordFromEvent({ key: "ArrowDown", ctrlKey: true, shiftKey: true }, false)).toEqual(
      chord("ArrowDown", true),
    );
    expect(chordFromEvent({ key: "d", ctrlKey: true }, true)).toBeNull();
    expect(chordFromEvent({ key: "d", metaKey: true }, false)).toBeNull();
    expect(chordFromEvent({ key: "Shift", metaKey: true, shiftKey: true }, true)).toBeNull();
  });

  it("spells a chord in the platform's own glyphs", () => {
    expect(spell(chord("d"), true)).toBe("⌘D");
    expect(spell(chord("ArrowDown", true), true)).toBe("⌘⇧↓");
    expect(spell(chord("t", true, true), true)).toBe("⌘⇧⌥T");
    expect(spell(chord("d"), false)).toBe("Ctrl+D");
    expect(spell(chord("ArrowUp", true), false)).toBe("Ctrl+Shift+Up");
    expect(spell(chord("\\"), false)).toBe("Ctrl+\\");
  });
});

describe("persistence", () => {
  it("keeps a custom table across a restart", () => {
    setBinding("review", chord("g"));
    resetKeys();
    loadKeys();
    expect(chordFor("review")).toEqual(chord("g"));
    expect(keys.preset).toBe("custom");
  });

  it("keeps a preset across a restart", () => {
    applyPreset("vim");
    resetKeys();
    loadKeys();
    expect(keys.preset).toBe("vim");
  });

  it("survives a corrupt or partial entry", () => {
    localStorage.setItem("workbench.keys", "{not json");
    expect(() => loadKeys()).not.toThrow();
    expect(chordFor("review")).toEqual(chord("d"));

    localStorage.setItem(
      "workbench.keys",
      JSON.stringify({ bindings: { review: { key: "g", shift: false, alt: false }, view: "nope" } }),
    );
    loadKeys();
    expect(chordFor("review")).toEqual(chord("g"));
    expect(chordFor("view")).toEqual(chord("e"));
  });
});
