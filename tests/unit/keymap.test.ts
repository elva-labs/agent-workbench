import { beforeEach, describe, expect, it } from "vitest";
import {
  bindingsFor,
  isMac,
  resolveAction as resolve,
  type KeyContext,
  type KeyState,
} from "$lib/keymap";
import { applyPreset, resetKeys, setBinding } from "$lib/keys.svelte";

beforeEach(resetKeys);

const mod = (key: string, extra: Partial<KeyState> = {}): KeyState => ({
  key,
  metaKey: true,
  ...extra,
});

/** The tests run on macOS unless they say otherwise: Cmd is the modifier. */
const resolveAction = (e: KeyState, ctx: Partial<KeyContext> = {}) =>
  resolve(e, { focus: "agent", reviewing: false, mac: true, ...ctx });

const reviewing: KeyContext = { focus: "changes", reviewing: true };

describe("resolveAction", () => {
  it("maps the palette, the jump to who needs you, and the zoom", () => {
    expect(resolveAction(mod("p", { shiftKey: true }))).toEqual({ type: "palette" });
    expect(resolveAction(mod("p"))).toEqual({ type: "goto" });
    expect(resolveAction(mod("."))).toEqual({ type: "attention" });
    expect(resolveAction(mod("="))).toEqual({ type: "zoom", step: 1 });
    expect(resolveAction(mod("-"))).toEqual({ type: "zoom", step: -1 });
    expect(resolveAction(mod("0"))).toEqual({ type: "zoom", step: 0 });
  });

  it("takes the zoom from a terminal, as it does every chord", () => {
    expect(resolveAction(mod("="), { focus: "terminal" })).toEqual({ type: "zoom", step: 1 });
  });

  // A layout that puts = under Shift, or gives + a key of its own.
  it("zooms in on + and on a shifted =", () => {
    expect(resolveAction(mod("+", { shiftKey: true }))).toEqual({ type: "zoom", step: 1 });
    expect(resolveAction(mod("+"))).toEqual({ type: "zoom", step: 1 });
    expect(resolveAction(mod("=", { shiftKey: true }))).toEqual({ type: "zoom", step: 1 });
  });

  it("leaves a chord bound to Shift+= with what it is bound to", () => {
    expect(setBinding("theme", { key: "=", shift: true, alt: false })).toBeNull();
    expect(resolveAction(mod("=", { shiftKey: true }))).toEqual({ type: "cycleTheme" });
  });

  it("resolves the new chords with Ctrl where Ctrl is the modifier", () => {
    const ctrl = (key: string, extra: Partial<KeyState> = {}): KeyState => ({
      key,
      ctrlKey: true,
      ...extra,
    });
    expect(resolveAction(ctrl("p", { shiftKey: true }), { mac: false })).toEqual({
      type: "palette",
    });
    expect(resolveAction(ctrl("="), { mac: false })).toEqual({ type: "zoom", step: 1 });
  });

  it("opens the palettes on Cmd+; and Cmd+P in the vim preset", () => {
    applyPreset("vim");
    expect(resolveAction(mod(";"))).toEqual({ type: "palette" });
    expect(resolveAction(mod("p"))).toEqual({ type: "goto" });
  });

  it("maps modifier digits to pane focus", () => {
    expect(resolveAction(mod("1"))).toEqual({ type: "focus", pane: "sessions" });
    expect(resolveAction(mod("2"))).toEqual({ type: "focus", pane: "agent" });
    expect(resolveAction(mod("3"))).toEqual({ type: "focus", pane: "changes" });
    expect(resolveAction(mod("4"))).toEqual({ type: "focus", pane: "terminal" });
  });

  it("maps the terminal toggle", () => {
    expect(resolveAction(mod("j"))).toEqual({ type: "toggleTerminal" });
    expect(resolveAction(mod("J"))).toEqual({ type: "toggleTerminal" });
  });

  it("maps the pane toggles", () => {
    expect(resolveAction(mod("b"))).toEqual({ type: "toggle", pane: "sessions" });
    expect(resolveAction(mod("B"))).toEqual({ type: "toggle", pane: "sessions" });
    expect(resolveAction(mod("\\"))).toEqual({ type: "toggle", pane: "changes" });
  });

  it("maps the viewer controls", () => {
    expect(resolveAction(mod("d"))).toEqual({ type: "toggleReview" });
    expect(resolveAction(mod("e"))).toEqual({ type: "toggleView" });
    expect(resolveAction(mod("a", { shiftKey: true }))).toEqual({ type: "toggleScope" });
  });

  it("treats ctrl as the modifier for Windows and Linux", () => {
    expect(resolveAction({ key: "1", ctrlKey: true }, { mac: false })).toEqual({
      type: "focus",
      pane: "sessions",
    });
  });

  // One modifier per platform. On macOS every Ctrl chord is the agent's:
  // Ctrl+B and Ctrl+E are readline inside the TUI, and Ctrl+D is EOT.
  it("leaves every ctrl chord to the agent on macOS", () => {
    for (const key of ["1", "4", "b", "d", "e", "j", "\\"]) {
      expect(resolveAction({ key, ctrlKey: true }, { mac: true })).toBeNull();
    }
  });

  it("does not answer to cmd where there is no cmd", () => {
    expect(resolveAction({ key: "d", metaKey: true }, { mac: false })).toBeNull();
  });

  it("tells the platforms apart by what the browser reports", () => {
    expect(isMac({ platform: "MacIntel" })).toBe(true);
    expect(isMac({ platform: "Linux x86_64" })).toBe(false);
    expect(isMac({ platform: "Win32" })).toBe(false);
    expect(isMac({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" })).toBe(true);
    expect(isMac(undefined)).toBe(false);
  });

  it("steps between sessions on shift+mod+arrows", () => {
    expect(resolveAction(mod("ArrowDown", { shiftKey: true }))).toEqual({ type: "cycle", direction: 1 });
    expect(resolveAction(mod("ArrowUp", { shiftKey: true }))).toEqual({ type: "cycle", direction: -1 });
    expect(resolveAction(mod("ArrowDown"))).toBeNull();
  });

  it("cycles the theme on shift+mod+T", () => {
    expect(resolveAction(mod("t", { shiftKey: true }))).toEqual({ type: "cycleTheme" });
    expect(resolveAction(mod("T", { shiftKey: true }))).toEqual({ type: "cycleTheme" });
  });

  // The whole point of the focus model: these belong to the agent, not to us.
  it.each(["c", "r", "Tab", "d", "e", "l", "k"])("passes %s through when unmodified", (key) => {
    expect(resolveAction({ key })).toBeNull();
  });

  it("does not claim ctrl+c, ctrl+r or shift+tab from the agent", () => {
    expect(resolveAction({ key: "c", ctrlKey: true })).toBeNull();
    expect(resolveAction({ key: "r", ctrlKey: true })).toBeNull();
    expect(resolveAction({ key: "Tab", shiftKey: true })).toBeNull();
    expect(resolveAction({ key: "Tab", ctrlKey: true, shiftKey: true })).toBeNull();
  });

  it("ignores unbound modifier chords rather than swallowing them", () => {
    expect(resolveAction(mod("9"))).toBeNull();
    expect(resolveAction(mod("z"))).toBeNull();
    expect(resolveAction(mod("x", { shiftKey: true }))).toBeNull();
  });

  it("publishes a binding for every action it resolves", () => {
    const bindings = bindingsFor(true);
    expect(bindings.length).toBeGreaterThan(0);
    for (const binding of bindings) {
      expect(binding.keys).not.toBe("");
      expect(binding.does).not.toBe("");
    }
  });

  // Narrowing the tree is the changes pane's own. In a terminal the chord is
  // the process's: Ctrl+F is forward-char in a shell.
  it("claims the filter only outside the terminals, and the search anywhere", () => {
    expect(resolveAction(mod("f"), { focus: "changes" })).toEqual({ type: "find", mode: "files" });
    expect(resolveAction(mod("f"), { focus: "sessions" })).toEqual({ type: "find", mode: "files" });
    expect(resolveAction(mod("f"), { focus: "agent" })).toBeNull();
    expect(resolveAction(mod("f"), { focus: "terminal" })).toBeNull();
    expect(resolveAction(mod("f", { shiftKey: true }), { focus: "agent" })).toEqual({
      type: "find",
      mode: "lines",
    });
  });

  it("opens the settings on mod+comma", () => {
    expect(resolveAction(mod(","))).toEqual({ type: "openSettings" });
  });

  // The chords are the user's: a preset or a chord of their own is what
  // resolves, and the status bar follows.
  it("resolves whatever the keymap says", () => {
    applyPreset("vim");
    expect(resolveAction(mod("h"))).toEqual({ type: "focus", pane: "sessions" });
    expect(resolveAction(mod("l"))).toEqual({ type: "focus", pane: "changes" });
    expect(resolveAction(mod("j"))).toEqual({ type: "focus", pane: "terminal" });
    expect(resolveAction(mod("j", { shiftKey: true }))).toEqual({ type: "toggleTerminal" });
    expect(resolveAction(mod("1"))).toBeNull();
    expect(bindingsFor(true).map((b) => b.keys)).toContain("⌘⇧J");

    setBinding("review", { key: "g", shift: false, alt: false });
    expect(resolveAction(mod("g"))).toEqual({ type: "toggleReview" });
    expect(resolveAction(mod("d"))).toBeNull();
  });

  // The status bar shows the keys you actually have.
  it("spells the bindings in the platform's own keys", () => {
    expect(bindingsFor(true).map((b) => b.keys)).toContain("⌘D");
    expect(bindingsFor(true).map((b) => b.keys)).toContain("⌘J");
    expect(bindingsFor(false).map((b) => b.keys)).toContain("Ctrl+D");
    expect(bindingsFor(false).every((b) => !b.keys.includes("⌘"))).toBe(true);
  });
});

describe("Escape", () => {
  it("closes the viewer when a pane other than the agent has focus", () => {
    expect(resolveAction({ key: "Escape" }, reviewing)).toEqual({ type: "exitReview" });
  });

  // Claude Code needs Escape. It is only ours when the agent is not listening.
  it("is the agent's whenever the agent has focus", () => {
    expect(resolveAction({ key: "Escape" }, { focus: "agent", reviewing: true })).toBeNull();
  });

  // A shell in the panel is a terminal too: vi and less want Escape.
  it("belongs to the terminal panel when that has focus", () => {
    expect(resolveAction({ key: "Escape" }, { focus: "terminal", reviewing: true })).toBeNull();
  });

  // A look at a side pane ends where typing resumes.
  it("hands the keyboard back to the agent from a list pane", () => {
    expect(resolveAction({ key: "Escape" }, { focus: "changes", reviewing: false })).toEqual({
      type: "focus",
      pane: "agent",
    });
    expect(resolveAction({ key: "Escape" }, { focus: "sessions", reviewing: false })).toEqual({
      type: "focus",
      pane: "agent",
    });
  });

  it("is the shell's in the terminal panel", () => {
    expect(resolveAction({ key: "Escape" }, { focus: "terminal", reviewing: false })).toBeNull();
  });

  it("is the agent's by default", () => {
    expect(resolveAction({ key: "Escape" })).toBeNull();
  });
});

describe("editor mode", () => {
  const editor: Partial<KeyContext> = { focus: "changes", editing: true, inEditor: true };
  const tree: Partial<KeyContext> = { focus: "changes", editing: true, inEditor: false };

  it("flips the mode on Shift+Cmd+E from anywhere, a terminal included", () => {
    expect(resolveAction(mod("e", { shiftKey: true }))).toEqual({ type: "toggleMode" });
    expect(resolveAction(mod("E", { shiftKey: true }), editor)).toEqual({ type: "toggleMode" });
  });

  it("starts a new file on Alt+Cmd+N, read from the key's place", () => {
    // macOS spells Option+N as a dead key; the chord is the key it sits on.
    expect(resolveAction(mod("Dead", { altKey: true, code: "KeyN" }))).toEqual({ type: "newFile" });
    expect(resolveAction(mod("n", { altKey: true, code: "KeyN" }), tree)).toEqual({ type: "newFile" });
  });

  it("saves on Cmd+S anywhere in editor mode but a terminal", () => {
    expect(resolveAction(mod("s"), editor)).toEqual({ type: "save" });
    expect(resolveAction(mod("s"), tree)).toEqual({ type: "save" });
    expect(resolveAction(mod("s"), { focus: "agent", editing: true })).toBeNull();
    expect(resolveAction(mod("s"))).toBeNull();
  });

  it("closes the tab on Cmd+W in editor mode, and leaves it to the menu elsewhere", () => {
    expect(resolveAction(mod("w"), editor)).toEqual({ type: "closeTab" });
    expect(resolveAction(mod("w"), tree)).toEqual({ type: "closeTab" });
    expect(resolveAction(mod("w"), { focus: "terminal", editing: true })).toBeNull();
    expect(resolveAction(mod("w"), { focus: "changes" })).toBeNull();
  });

  it("finds in the file from the editor, and filters the tree from the tree", () => {
    expect(resolveAction(mod("f"), editor)).toEqual({ type: "findInFile" });
    expect(resolveAction(mod("f"), tree)).toEqual({ type: "find", mode: "files" });
  });

  it("leaves every chord on an arrow key to the editor", () => {
    expect(resolveAction(mod("ArrowDown", { shiftKey: true }), editor)).toBeNull();
    expect(resolveAction(mod("ArrowUp", { shiftKey: true }), editor)).toBeNull();
    expect(resolveAction(mod("ArrowDown", { shiftKey: true }), tree)).toEqual({ type: "cycle", direction: 1 });
  });

  it("keeps the app's other chords while the editor has the keyboard", () => {
    expect(resolveAction(mod("1"), editor)).toEqual({ type: "focus", pane: "sessions" });
    expect(resolveAction(mod("e"), editor)).toEqual({ type: "toggleView" });
  });

  it("leaves Cmd+D to the editor, and does nothing with it elsewhere in editor mode", () => {
    expect(resolveAction(mod("d"), editor)).toBeNull();
    expect(resolveAction(mod("d"), tree)).toBeNull();
    expect(resolveAction(mod("d"), { focus: "changes" })).toEqual({ type: "toggleReview" });
  });

  it("leaves Escape to the editor, and sends it there from the panes around it", () => {
    expect(resolveAction({ key: "Escape" }, editor)).toBeNull();
    expect(resolveAction({ key: "Escape" }, tree)).toEqual({ type: "toEditor" });
    expect(resolveAction({ key: "Escape" }, { focus: "sessions", editing: true })).toEqual({ type: "toEditor" });
    expect(resolveAction({ key: "Escape" }, { focus: "agent", editing: true })).toBeNull();
  });

  it("follows a chord the user moved", () => {
    expect(setBinding("file.save", { key: "s", shift: true, alt: false })).toBeNull();
    expect(resolveAction(mod("s", { shiftKey: true }), editor)).toEqual({ type: "save" });
    expect(resolveAction(mod("s"), editor)).toBeNull();
  });
});
