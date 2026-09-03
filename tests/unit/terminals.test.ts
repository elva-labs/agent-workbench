import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetExits, stash } from "$lib/exits";
import { DEFAULT, applyLayout, layout, terminalVisible, toggleTerminal } from "$lib/layout.svelte";
import {
  activeShell,
  byKey,
  close,
  closeProject,
  create,
  ended,
  failed,
  follow,
  forProject,
  label,
  launch,
  reset,
  select,
  started,
  statusMessage,
  terminals,
} from "$lib/terminals.svelte";

const A = "/home/ada/dev/one";
const B = "/home/ada/dev/two";

const killed: string[] = [];
let spawned = 0;
let spawnError: string | null = null;
vi.mock("$lib/core", () => ({
  core: () => ({
    // Tauri rejects with the command's string, not an Error.
    spawnShell: async () => {
      if (spawnError !== null) throw spawnError;
      return `pty-${++spawned}`;
    },
    kill: async (id: string) => {
      killed.push(id);
    },
  }),
}));

const noOutput = () => {};

function live(project: string, ptyId: string) {
  const shell = create(project);
  started(shell.key, ptyId);
  return shell;
}

function open() {
  layout.terminalChosen = false;
  layout.terminalForced = false;
  layout.terminal = DEFAULT.terminal;
  layout.focus = "agent";
  applyLayout(1600, 900);
  toggleTerminal();
}

beforeEach(() => {
  reset();
  resetExits();
  killed.length = 0;
  spawned = 0;
  spawnError = null;
  open();
});

describe("tabs", () => {
  it("numbers shells within their project and never reuses a number", () => {
    const first = create(A);
    const second = create(A);
    const other = create(B);
    expect(label(first)).toBe("shell 1");
    expect(label(second)).toBe("shell 2");
    expect(label(other)).toBe("shell 1");

    close(second.key);
    expect(label(create(A))).toBe("shell 3");
  });

  it("shows the newest tab", () => {
    create(A);
    const second = create(A);
    expect(terminals.active).toBe(second.key);
  });

  it("keeps each project's shells apart", () => {
    create(A);
    create(B);
    create(A);
    expect(forProject(A)).toHaveLength(2);
    expect(forProject(B)).toHaveLength(1);
  });

  it("selects a tab by key and ignores one that is not there", () => {
    const first = create(A);
    create(A);
    select(first.key);
    expect(activeShell()).toBe(byKey(first.key));
    select("nope");
    expect(terminals.active).toBe(first.key);
  });

  it("follows a project to its most recent shell, or to nothing", () => {
    create(A);
    const last = create(A);
    create(B);
    follow(A);
    expect(terminals.active).toBe(last.key);
    follow("/home/ada/dev/three");
    expect(terminals.active).toBeNull();
    follow(null);
    expect(terminals.active).toBeNull();
  });
});

describe("starting", () => {
  it("runs once the terminal knows its size", async () => {
    const shell = create(A);
    expect(shell.status).toBe("starting");
    expect(await launch(shell.key, 80, 24, noOutput)).toBe(true);
    expect(shell.status).toBe("running");
    expect(shell.ptyId).toBe("pty-1");
  });

  it("records a failure to start", async () => {
    spawnError = "no pty available";
    const shell = create(A);
    expect(await launch(shell.key, 80, 24, noOutput)).toBe(false);
    expect(shell.status).toBe("failed");
    expect(statusMessage(shell)).toBe("no pty available");
  });

  it("refuses a key that is not there", async () => {
    expect(await launch("nope", 80, 24, noOutput)).toBe(false);
    expect(spawned).toBe(0);
  });

  // The tab can go while the spawn is in flight. What comes back has no
  // owner and must not be left running.
  it("stops a shell whose tab closed while it was coming up", async () => {
    const shell = create(A);
    const pending = launch(shell.key, 80, 24, noOutput);
    close(shell.key);
    expect(await pending).toBe(false);
    expect(killed).toEqual(["pty-1"]);
  });

  it("applies an exit that arrived before the start", () => {
    const shell = create(A);
    expect(ended({ id: "pty-1", code: 1, clean: false })).toBe(false);
    stash({ id: "pty-1", code: 1, clean: false });
    started(shell.key, "pty-1");
    expect(shell.status).toBe("crashed");
    expect(shell.exitCode).toBe(1);
  });
});

describe("the exit policy", () => {
  it("closes the tab on a clean exit", () => {
    const shell = live(A, "pty-1");
    expect(ended({ id: "pty-1", code: 0, clean: true })).toBe(true);
    expect(byKey(shell.key)).toBeNull();
  });

  it("keeps a crashed shell and names the code", () => {
    const shell = live(A, "pty-1");
    ended({ id: "pty-1", code: 130, clean: false });
    expect(shell.status).toBe("crashed");
    expect(shell.ptyId).toBeNull();
    expect(statusMessage(shell)).toContain("code 130");
  });

  it("reports a signal kill without inventing a code", () => {
    const shell = live(A, "pty-1");
    ended({ id: "pty-1", code: null, clean: false });
    expect(statusMessage(shell)).toBe("The shell was stopped.");
  });

  it("ends only the shell the event belongs to", () => {
    const first = live(A, "pty-1");
    const second = live(A, "pty-2");
    ended({ id: "pty-2", code: 1, clean: false });
    expect(second.status).toBe("crashed");
    expect(first.status).toBe("running");
  });

  it("ignores an exit it does not know", () => {
    live(A, "pty-1");
    expect(ended({ id: "pty-99", code: 0, clean: true })).toBe(false);
    expect(terminals.all).toHaveLength(1);
  });

  // Typing exit in the only shell means you are done with the panel.
  it("closes the panel with the last shell of the shown project", () => {
    live(A, "pty-1");
    expect(terminalVisible()).toBe(true);
    ended({ id: "pty-1", code: 0, clean: true });
    expect(terminalVisible()).toBe(false);
    expect(terminals.active).toBeNull();
  });

  it("shows the next tab over when there is one", () => {
    const first = live(A, "pty-1");
    live(A, "pty-2");
    ended({ id: "pty-2", code: 0, clean: true });
    expect(terminals.active).toBe(first.key);
    expect(terminalVisible()).toBe(true);
  });

  it("leaves the panel alone when the shell was not the one shown", () => {
    const first = live(A, "pty-1");
    live(A, "pty-2");
    select(first.key);
    ended({ id: "pty-2", code: 0, clean: true });
    expect(terminals.active).toBe(first.key);
    expect(terminalVisible()).toBe(true);
  });
});

describe("closing", () => {
  it("stops a live shell and removes its tab", () => {
    const shell = live(A, "pty-1");
    close(shell.key);
    expect(killed).toEqual(["pty-1"]);
    expect(terminals.all).toHaveLength(0);
  });

  it("does not try to stop one that already ended", () => {
    const shell = live(A, "pty-1");
    ended({ id: "pty-1", code: 1, clean: false });
    close(shell.key);
    expect(killed).toEqual([]);
  });

  it("hides the panel with the last tab", () => {
    const shell = live(A, "pty-1");
    close(shell.key);
    expect(terminalVisible()).toBe(false);
  });

  // Closing a project is not closing the terminal: the panel goes on
  // showing whatever the next project has.
  it("closes every shell of a project without closing the panel", () => {
    live(A, "pty-1");
    live(A, "pty-2");
    live(B, "pty-3");
    follow(A);
    closeProject(A);
    expect(killed).toEqual(["pty-1", "pty-2"]);
    expect(forProject(A)).toHaveLength(0);
    expect(forProject(B)).toHaveLength(1);
    expect(terminalVisible()).toBe(true);
  });
});
