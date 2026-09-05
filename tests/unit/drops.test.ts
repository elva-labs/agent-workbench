import { beforeEach, describe, expect, it, vi } from "vitest";
import { drops, handle, pasteFor, register, resetDrops, shellPath, targetAt, unregister } from "$lib/drops.svelte";
import { layout } from "$lib/layout.svelte";
import { create, reset as resetSessions, started } from "$lib/sessions.svelte";
import { create as createShell, reset as resetShells, started as shellStarted } from "$lib/terminals.svelte";

vi.mock("$lib/core", () => ({
  core: () => ({
    kill: async () => {},
    transcripts: async () => [],
  }),
}));

/** Stands in for an xterm: what a drop does to it is paste and focus. */
function fakeTerminal() {
  const pasted: string[] = [];
  let focused = 0;
  return {
    pasted,
    focusCount: () => focused,
    handle: {
      paste: (text: string) => {
        pasted.push(text);
      },
      focus: () => {
        focused += 1;
      },
    } as unknown as import("@xterm/xterm").Terminal,
  };
}

function host(id: string) {
  const element = document.createElement("div");
  element.dataset.terminal = id;
  document.body.appendChild(element);
  return element;
}

/** jsdom does no layout, so it has no elementFromPoint. The tests say what
    is under the pointer. */
function under(element: Element | null) {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => element,
  });
}

beforeEach(() => {
  resetDrops();
  resetSessions();
  resetShells();
  document.body.innerHTML = "";
  layout.focus = "agent";
  under(null);
});

describe("paths as typed", () => {
  it("escapes what a shell would read as something else", () => {
    expect(shellPath("/Users/ada/Screen Shot 1.png", false)).toBe("/Users/ada/Screen\\ Shot\\ 1.png");
    expect(shellPath("/tmp/a&b(c).txt", false)).toBe("/tmp/a\\&b\\(c\\).txt");
    expect(shellPath("/plain/path.rs", false)).toBe("/plain/path.rs");
  });

  it("types every path, and a space after the last", () => {
    expect(pasteFor(["/a", "/b c"], false)).toBe("/a /b\\ c ");
  });

  // A backslash is a separator on Windows, so a path that needs it is quoted.
  it("quotes rather than escapes on Windows", () => {
    expect(shellPath("C:\\Users\\ada\\Screen Shot.png", true)).toBe('"C:\\Users\\ada\\Screen Shot.png"');
    expect(shellPath("C:\\work\\notes.md", true)).toBe("C:\\work\\notes.md");
    expect(pasteFor(["C:\\a b", "C:\\c"], true)).toBe('"C:\\a b" C:\\c ');
  });
});

describe("where a drop lands", () => {
  it("goes to the terminal under the pointer", () => {
    const term = fakeTerminal();
    const element = host("s1");
    register("s1", element, term.handle);
    under(element);

    handle({ type: "drop", paths: ["/tmp/x.png"], x: 10, y: 10 });
    expect(term.pasted).toEqual(["/tmp/x.png "]);
    expect(term.focusCount()).toBe(1);
  });

  // Dropping on the header, or the status bar, still means this window's
  // agent: the one the keyboard is in.
  it("falls back to the terminal that has the keyboard", () => {
    const agent = fakeTerminal();
    const session = create("/p");
    started(session.key, "pty-1", "id");
    register(session.key, host(session.key), agent.handle);

    const shell = fakeTerminal();
    const tab = createShell("/p");
    shellStarted(tab.key, "pty-2");
    register(tab.key, host(tab.key), shell.handle);

    under(null);
    expect(targetAt(0, 0)).toBe(session.key);
    handle({ type: "drop", paths: ["/tmp/x"], x: 0, y: 0 });
    expect(agent.pasted).toEqual(["/tmp/x "]);

    layout.focus = "terminal";
    expect(targetAt(0, 0)).toBe(tab.key);
    handle({ type: "drop", paths: ["/tmp/y"], x: 0, y: 0 });
    expect(shell.pasted).toEqual(["/tmp/y "]);
  });

  it("does nothing with nowhere to go", () => {
    under(null);
    expect(() => handle({ type: "drop", paths: ["/tmp/x"], x: 0, y: 0 })).not.toThrow();
    expect(targetAt(0, 0)).toBeNull();
  });

  it("marks the target while the drag is over it, and clears it after", () => {
    const term = fakeTerminal();
    const element = host("s1");
    register("s1", element, term.handle);
    under(element);

    handle({ type: "over", x: 1, y: 1 });
    expect(drops.over).toBe("s1");
    handle({ type: "leave" });
    expect(drops.over).toBeNull();

    handle({ type: "over", x: 1, y: 1 });
    handle({ type: "drop", paths: ["/tmp/x"], x: 1, y: 1 });
    expect(drops.over).toBeNull();
  });

  it("forgets a terminal that has gone", () => {
    const term = fakeTerminal();
    const element = host("s1");
    register("s1", element, term.handle);
    under(element);
    handle({ type: "over", x: 1, y: 1 });
    unregister("s1");
    expect(drops.over).toBeNull();
    handle({ type: "drop", paths: ["/tmp/x"], x: 1, y: 1 });
    expect(term.pasted).toEqual([]);
  });
});
