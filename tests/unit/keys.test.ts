import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTIONS,
  PRESETS,
  actionOf,
  adoptKeys,
  applyPreset,
  chordFor,
  chordFromEvent,
  chordText,
  parseChord,
  setBindings,
  tableProblem,
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
    expect(text).toContain("Diff, whole file or rendered");
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
    localStorage.setItem("chord.keys", "{not json");
    expect(() => loadKeys()).not.toThrow();
    expect(chordFor("review")).toEqual(chord("d"));

    localStorage.setItem(
      "chord.keys",
      JSON.stringify({ bindings: { review: { key: "g", shift: false, alt: false }, view: "nope" } }),
    );
    loadKeys();
    expect(chordFor("review")).toEqual(chord("g"));
    expect(chordFor("view")).toEqual(chord("e"));
  });
});

describe("chords as text", () => {
  it("reads a key with shift and alt before it, the modifier implied", () => {
    expect(parseChord("k")).toEqual(chord("k"));
    expect(parseChord("Shift+K")).toEqual(chord("k", true));
    expect(parseChord("alt+shift+down")).toEqual(chord("ArrowDown", true, true));
    expect(parseChord("cmd+option+ArrowUp")).toEqual(chord("ArrowUp", false, true));
    expect(parseChord("ctrl+space")).toEqual(chord(" "));
    expect(parseChord("shift+,")).toEqual(chord(",", true));
    expect(parseChord("\\")).toEqual(chord("\\"));
    expect(parseChord("shift++")).toEqual(chord("+", true));
    expect(parseChord("Enter")).toEqual(chord("Enter"));
  });

  it("reads nothing from text that is not one chord", () => {
    expect(parseChord("")).toBeNull();
    expect(parseChord("hyper+k")).toBeNull();
    expect(parseChord("shift+")).toBeNull();
    expect(parseChord("two words")).toBeNull();
    expect(parseChord("<script>")).toBeNull();
  });

  it("writes a chord the way it is read", () => {
    for (const table of Object.values(PRESETS)) {
      for (const bound of Object.values(table)) {
        expect(parseChord(chordText(bound))).toEqual(bound);
      }
    }
    expect(chordText(chord("ArrowDown", true, true))).toBe("alt+shift+down");
    expect(chordText(chord(" "))).toBe("space");
  });
});

describe("a whole table", () => {
  it("is refused with a chord two actions share", () => {
    const table = { ...PRESETS.default, review: chord("e") };
    expect(tableProblem(table)).toMatch(/would be both/);
  });

  it("is refused with a chord the agent needs", () => {
    const table = { ...PRESETS.default, review: chord("r") };
    expect(tableProblem(table)).toMatch(/stays with the agent/);
  });

  it("is taken whole, with the preset it matches", () => {
    expect(tableProblem(PRESETS.vim)).toBeNull();
    setBindings(PRESETS.vim);
    expect(keys.preset).toBe("vim");
    setBindings({ ...PRESETS.vim, review: chord("g") });
    expect(keys.preset).toBe("custom");
    resetKeys();
    loadKeys();
    expect(chordFor("review")).toEqual(chord("g"));
  });

  it("is adopted from the core, filling what it lacks from the default", () => {
    adoptKeys({ review: chord("g"), unknown: chord("q") } as never);
    expect(chordFor("review")).toEqual(chord("g"));
    expect(chordFor("view")).toEqual(chord("e"));
    expect(keys.preset).toBe("custom");
    adoptKeys({});
    expect(keys.preset).toBe("default");
  });
});

describe("the palette, the jump and the zoom", () => {
  it("have chords of their own in the default preset", () => {
    expect(chordFor("palette")).toEqual(chord("p", true));
    expect(chordFor("goto")).toEqual(chord("p"));
    expect(chordFor("session.attention")).toEqual(chord("."));
    expect(chordFor("zoom.in")).toEqual(chord("="));
    expect(chordFor("zoom.out")).toEqual(chord("-"));
    expect(chordFor("zoom.reset")).toEqual(chord("0"));
  });

  // Shift+Cmd+P steps to the previous session in the vim preset.
  it("open the palette on Cmd+; in the vim preset", () => {
    applyPreset("vim");
    expect(chordFor("palette")).toEqual(chord(";"));
    expect(chordFor("goto")).toEqual(chord("p"));
    expect(chordFor("session.previous")).toEqual(chord("p", true));
  });

  it("can be rebound, go to apart from commands", () => {
    expect(setBinding("goto", chord("k"))).toBeNull();
    expect(chordFor("goto")).toEqual(chord("k"));
    expect(chordFor("palette")).toEqual(chord("p", true));
    expect(setBinding("goto", chord("p", true))).toContain("already");
  });
});

describe("actions a stored table does not have yet", () => {
  const without = (table: Record<string, unknown>, ...gone: string[]) => {
    const copy = { ...table };
    for (const key of gone) delete copy[key];
    return copy as Record<string, ReturnType<typeof chord>>;
  };

  it("take the default's chords in a table that follows the default", () => {
    adoptKeys(without(PRESETS.default, "palette", "zoom.in"));
    expect(chordFor("palette")).toEqual(chord("p", true));
    expect(chordFor("zoom.in")).toEqual(chord("="));
  });

  it("take vim's chords in a table that follows vim", () => {
    adoptKeys(without(PRESETS.vim, "palette"));
    expect(chordFor("palette")).toEqual(chord(";"));
    expect(chordFor("session.previous")).toEqual(chord("p", true));
  });

  it("take another preset's chord where the table gave the default's away", () => {
    adoptKeys(without({ ...PRESETS.default, review: chord("p", true) }, "palette"));
    expect(chordFor("review")).toEqual(chord("p", true));
    expect(chordFor("palette")).toEqual(chord(";"));
  });

  it("never land on a chord the table gives to another action", () => {
    adoptKeys(without({ ...PRESETS.default, theme: chord("=") }, "zoom.in", "zoom.out", "zoom.reset"));
    expect(chordFor("theme")).toEqual(chord("="));
    expect(chordFor("zoom.in")).not.toEqual(chord("="));
    expect(tableProblem(keys.bindings)).toBeNull();
  });

  it("keep the chord the table holds for another action, a dot included", () => {
    adoptKeys(without({ ...PRESETS.default, review: chord(".") }, "session.attention"));
    expect(chordFor("review")).toEqual(chord("."));
    expect(chordFor("session.attention")).not.toEqual(chord("."));
    expect(tableProblem(keys.bindings)).toBeNull();
  });

  it("give exactly the default preset for an empty table", () => {
    adoptKeys({});
    expect(keys.bindings).toEqual(PRESETS.default);
    expect(keys.preset).toBe("default");
  });
});

describe("the editor's chords", () => {
  it("are free in both presets", () => {
    for (const name of ["default", "vim"] as const) {
      expect(tableProblem(PRESETS[name])).toBeNull();
      expect(PRESETS[name].mode).toEqual({ key: "e", shift: true, alt: false });
      expect(PRESETS[name]["file.new"]).toEqual({ key: "n", shift: false, alt: true });
      expect(PRESETS[name]["file.save"]).toEqual({ key: "s", shift: false, alt: false });
      expect(PRESETS[name]["file.close"]).toEqual({ key: "w", shift: false, alt: false });
    }
  });

  it("are given to a stored table that never had them", () => {
    localStorage.setItem(
      "chord.keys",
      JSON.stringify({ bindings: { "focus.sessions": { key: "1", shift: false, alt: false } } }),
    );
    loadKeys();
    expect(keys.bindings["file.save"]).toEqual({ key: "s", shift: false, alt: false });
    expect(keys.bindings.mode).toEqual({ key: "e", shift: true, alt: false });
  });

  it("read an Alt chord from the key's place, whatever Option spells", () => {
    expect(chordFromEvent({ key: "˜", code: "KeyN", metaKey: true, altKey: true }, true)).toEqual({
      key: "n",
      shift: false,
      alt: true,
    });
    expect(chordFromEvent({ key: "¡", code: "Digit1", metaKey: true, altKey: true }, true)).toEqual({
      key: "1",
      shift: false,
      alt: true,
    });
  });
});

describe("the chords that differ by platform", () => {
  const macOld = () => {
    resetKeys({ mac: true });
    const table: Record<string, unknown> = { ...PRESETS.default };
    delete table["terminal.new"];
    delete table["focus.status"];
    return table as Record<string, ReturnType<typeof chord>>;
  };

  it("open a shell on Cmd+T on macOS, and on Ctrl+Shift+T elsewhere, where the theme moves to Shift+D", () => {
    resetKeys({ mac: true });
    expect(chordFor("terminal.new")).toEqual(chord("t"));
    expect(chordFor("theme")).toEqual(chord("t", true));
    resetKeys({ mac: false });
    expect(chordFor("terminal.new")).toEqual(chord("t", true));
    expect(chordFor("theme")).toEqual(chord("d", true));
    for (const name of ["default", "vim"] as const) expect(tableProblem(PRESETS[name])).toBeNull();
  });

  it("move a stored table's theme off the new shell's chord off macOS, and keep the preset", () => {
    const stored = macOld();
    resetKeys({ mac: false });
    adoptKeys(stored);
    expect(chordFor("terminal.new")).toEqual(chord("t", true));
    expect(chordFor("theme")).toEqual(chord("d", true));
    expect(keys.preset).toBe("default");
    expect(tableProblem(keys.bindings)).toBeNull();
  });

  it("leave a stored table's theme where it is on macOS, and give the new shell Cmd+T", () => {
    const stored = macOld();
    adoptKeys(stored);
    expect(chordFor("theme")).toEqual(chord("t", true));
    expect(chordFor("terminal.new")).toEqual(chord("t"));
    expect(keys.preset).toBe("default");
  });

  it("leave a theme the user moved where it is", () => {
    const stored = { ...macOld(), theme: chord("y", true) };
    resetKeys({ mac: false });
    adoptKeys(stored);
    expect(chordFor("theme")).toEqual(chord("y", true));
    expect(chordFor("terminal.new")).toEqual(chord("t", true));
  });

  it("name close as what is in front, among the app's", () => {
    expect(ACTIONS.find(({ key }) => key === "file.close")).toEqual({
      key: "file.close",
      label: "Close what is in front",
      group: "App",
    });
    // Each group stands together, once.
    const groups = ACTIONS.map(({ group }) => group).filter((group, at, all) => group !== all[at - 1]);
    expect(new Set(groups).size).toBe(groups.length);
  });
});

describe("the status bar's chord", () => {
  it("is 5 in both presets, on every platform", () => {
    for (const mac of [true, false]) {
      resetKeys({ mac });
      expect(PRESETS.default["focus.status"]).toEqual(chord("5"));
      expect(PRESETS.vim["focus.status"]).toEqual(chord("5"));
    }
  });

  it("is given to a stored table that never had it", () => {
    const table: Record<string, unknown> = { ...PRESETS.default };
    delete table["focus.status"];
    adoptKeys(table as Record<string, ReturnType<typeof chord>>);
    expect(chordFor("focus.status")).toEqual(chord("5"));
    expect(keys.preset).toBe("default");
  });
});
