import { beforeEach, describe, expect, it, vi } from "vitest";
import { attention } from "$lib/attention.svelte";
import { conductor, resetConductor } from "$lib/conductor.svelte";
import { chordFor, describe as spell, resetKeys } from "$lib/keys.svelte";
import {
  ATTENTION_LABEL,
  closePalette,
  openPalette,
  palette,
  paletteItems,
  resetPalette,
} from "$lib/palette.svelte";
import { matches } from "$lib/files.svelte";
import { orchestrator } from "$lib/orchestrator.svelte";
import { create, exact, label, noted, reset, select, started } from "$lib/sessions.svelte";

vi.mock("$lib/core", () => ({
  core: () => ({
    kill: async () => {},
    setBadge: async () => {},
  }),
}));

const A = "/home/ada/dev/one";
const B = "/home/ada/dev/two";

beforeEach(() => {
  reset();
  resetConductor();
  orchestrator.dir = null;
  resetKeys();
  resetPalette();
  attention.focused = true;
});

describe("matching", () => {
  it("takes every word, in any order and any case", () => {
    expect(matches("Show or hide the terminal", "TERM hide")).toBe(true);
    expect(matches("Show or hide the terminal", "term shell")).toBe(false);
    expect(matches("anything", "   ")).toBe(true);
  });
});

describe("opening", () => {
  it("starts with an empty field", () => {
    palette.query = "left over";
    openPalette();
    expect(palette.open).toBe(true);
    expect(palette.query).toBe("");
  });
});

describe("what the palette lists", () => {
  it("is the jump first, then the sessions, then the actions", () => {
    create(A);
    create(B);
    const items = paletteItems("");
    expect(items[0]).toMatchObject({ kind: "attention", label: ATTENTION_LABEL });
    expect(items.slice(1, 3).map((item) => item.kind)).toEqual(["session", "session"]);
    expect(items.slice(3).every((item) => item.kind === "action")).toBe(true);
  });

  it("leaves out the palette itself and the jump's own action", () => {
    const actions = paletteItems("").flatMap((item) => (item.kind === "action" ? [item.action] : []));
    expect(actions).not.toContain("palette");
    expect(actions).not.toContain("session.attention");
    expect(actions).toContain("zoom.in");
  });

  it("finds a session by its project and an action by its words", () => {
    create(A);
    create(B);
    const sessionDetails = (query: string) =>
      paletteItems(query).flatMap((item) => (item.kind === "session" ? [item.detail] : []));
    expect(sessionDetails("two")).toEqual(["two"]);
    expect(paletteItems("terminal zoom").map((item) => item.label)).toEqual([
      "Zoom the terminal in",
      "Zoom the terminal out",
      "Reset the terminal's zoom",
    ]);
  });

  it("tells two remote projects apart by their host", () => {
    create("ssh://alpha/home/x/proj");
    create("ssh://beta/home/x/proj");
    const found = paletteItems("beta proj").filter((item) => item.kind === "session");
    expect(found).toHaveLength(1);
    expect(found[0].kind === "session" && found[0].detail).toContain("beta");
    expect(paletteItems("alpha").filter((item) => item.kind === "session")).toHaveLength(1);
  });

  it("puts the account in the line and finds the session by it", () => {
    create(B);
    const own = create(A, null, undefined, null, null, null, "work");
    const found = paletteItems("work").filter((item) => item.kind === "session");
    expect(found).toHaveLength(1);
    expect(found[0].kind === "session" && found[0].session.key).toBe(own.key);
    expect(found[0].kind === "session" && found[0].detail).toContain("work");
  });

  it("reads an orchestrator's own project as the orchestrator", () => {
    orchestrator.dir = A;
    create(A);
    const item = paletteItems("").find((candidate) => candidate.kind === "session");
    expect(item?.kind === "session" && item.detail).toContain("orchestrator");
  });

  it("names the orchestrator that started a session", () => {
    const owner = create(A);
    const child = create(B);
    conductor.startedBy[child.key] = owner.key;
    const item = paletteItems("").find(
      (candidate) => candidate.kind === "session" && candidate.session.key === child.key,
    );
    expect(item?.kind === "session" && item.detail).toContain(label(owner));
  });

  it("puts a note in the line and finds it by its words", () => {
    const first = create(A);
    create(B);
    noted(first.key, "refactoring the cache");
    const found = paletteItems("cache refactoring").filter((item) => item.kind === "session");
    expect(found).toHaveLength(1);
    expect(found[0].kind === "session" && found[0].detail).toContain("refactoring the cache");
  });

  it("lists a session that needs you above an idle one made earlier", () => {
    attention.focused = false;
    const idle = create(A);
    const waiting = create(B);
    started(waiting.key, "pty-2", "session-pty-2");
    exact("session-pty-2", "stop");
    const keys = paletteItems("").flatMap((item) => (item.kind === "session" ? [item.session.key] : []));
    expect(keys).toEqual([waiting.key, idle.key]);
  });

  it("does not match the jump to a word it has none of, and keeps ids unique", () => {
    create(A);
    expect(paletteItems("zoom").some((item) => item.kind === "attention")).toBe(false);
    const ids = paletteItems("").map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shows each action's chord", () => {
    const item = paletteItems("open settings").find((candidate) => candidate.kind === "action");
    expect(item?.kind === "action" && item.chord).toBe(spell(chordFor("settings")));
  });

  it("counts the sessions waiting on the user", () => {
    attention.focused = false;
    const first = create(A);
    started(first.key, "pty-1", "session-pty-1");
    exact("session-pty-1", "stop");
    create(B);
    expect(paletteItems("")[0]).toMatchObject({ kind: "attention", waiting: 1 });
    select(first.key);
    expect(paletteItems("")[0]).toMatchObject({ kind: "attention", waiting: 0 });
  });
});
