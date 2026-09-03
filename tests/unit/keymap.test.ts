import { describe, expect, it } from "vitest";
import { BINDINGS, resolveAction, type KeyContext, type KeyState } from "$lib/keymap";

const mod = (key: string, extra: Partial<KeyState> = {}): KeyState => ({
  key,
  metaKey: true,
  ...extra,
});

const reviewing: KeyContext = { focus: "changes", reviewing: true };

describe("resolveAction", () => {
  it("maps modifier digits to pane focus", () => {
    expect(resolveAction(mod("1"))).toEqual({ type: "focus", pane: "sessions" });
    expect(resolveAction(mod("2"))).toEqual({ type: "focus", pane: "agent" });
    expect(resolveAction(mod("3"))).toEqual({ type: "focus", pane: "changes" });
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
    expect(resolveAction({ key: "1", ctrlKey: true })).toEqual({
      type: "focus",
      pane: "sessions",
    });
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
    expect(BINDINGS.length).toBeGreaterThan(0);
    for (const binding of BINDINGS) {
      expect(binding.keys).not.toBe("");
      expect(binding.does).not.toBe("");
    }
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

  it("does nothing when there is no viewer open", () => {
    expect(resolveAction({ key: "Escape" }, { focus: "changes", reviewing: false })).toBeNull();
  });

  it("is the agent's by default", () => {
    expect(resolveAction({ key: "Escape" })).toBeNull();
  });
});
