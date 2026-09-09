import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetExits, stash } from "$lib/exits";
import {
  DEFAULT,
  applyLayout,
  layout,
  terminalVisible,
  toggleTerminal,
} from "$lib/layout.svelte";
import {
  MIN_SPLIT,
  activeShell,
  byKey,
  close,
  closeProject,
  create,
  TYPE_AFTER,
  printable,
  cycle,
  ended,
  equalize,
  failed,
  follow,
  forProject,
  groupOf,
  groupsFor,
  label,
  launch,
  reset,
  resizeSplit,
  select,
  share,
  shownGroup,
  split,
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
    spawnShell: async (
      _options: unknown,
      onOutput: (bytes: Uint8Array) => void,
    ) => {
      if (spawnError !== null) throw spawnError;
      outputs.push(onOutput);
      return `pty-${++spawned}`;
    },
    kill: async (id: string) => {
      killed.push(id);
    },
    write: async (id: string, data: string) => {
      written.push([id, data]);
    },
  }),
}));
const written: [string, string][] = [];
/** Each spawned shell's output callback, to play a prompt into. */
const outputs: ((bytes: Uint8Array) => void)[] = [];

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
  written.length = 0;
  outputs.length = 0;
  spawned = 0;
  spawnError = null;
  open();
});

describe("a command typed by the agent", () => {
  const prompt = () => outputs.at(-1)?.(new TextEncoder().encode("$ "));

  it("is written to the pty a moment after the shell's first output, without a newline", async () => {
    vi.useFakeTimers();
    const shell = create(A, "npm run dev");
    expect(shell.typed).toBe("npm run dev");
    await launch(shell.key, 80, 24, noOutput);
    await vi.advanceTimersByTimeAsync(TYPE_AFTER * 2);
    expect(written).toEqual([]);
    prompt();
    expect(written).toEqual([]);
    await vi.advanceTimersByTimeAsync(TYPE_AFTER);
    expect(written).toEqual([["pty-1", "npm run dev"]]);
    expect(shell.typed).toBeNull();
    // Later output types nothing more.
    prompt();
    await vi.advanceTimersByTimeAsync(TYPE_AFTER);
    expect(written).toHaveLength(1);
    vi.useRealTimers();
  });

  it("loses every control character on the way, a carriage return above all", async () => {
    vi.useFakeTimers();
    expect(printable("npm test\r\n")).toBe("npm test");
    expect(printable("echo \u001b[2Jhi\u0007")).toBe("echo [2Jhi");
    const shell = create(A, "\r\n");
    await launch(shell.key, 80, 24, noOutput);
    prompt();
    await vi.advanceTimersByTimeAsync(TYPE_AFTER);
    expect(written).toEqual([]);
    vi.useRealTimers();
  });

  it("is dropped when the shell went before it could be typed", async () => {
    vi.useFakeTimers();
    const shell = create(A, "npm run dev");
    await launch(shell.key, 80, 24, noOutput);
    prompt();
    close(shell.key);
    await vi.advanceTimersByTimeAsync(TYPE_AFTER);
    expect(written).toEqual([]);
    vi.useRealTimers();
  });
});

describe("shells", () => {
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

  it("shows the newest shell", () => {
    create(A);
    const second = create(A);
    expect(terminals.active).toBe(second.key);
  });

  it("opens each new shell in a group of its own", () => {
    const first = create(A);
    const second = create(A);
    expect(first.group).not.toBe(second.group);
    expect(groupsFor(A)).toHaveLength(2);
    expect(shownGroup()).toBe(second.group);
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

  it("steps through the project's shells in list order, wrapping around", () => {
    const first = create(A);
    const beside = split(first.key)!;
    const other = create(A);
    create(B);
    expect(cycle(A, 1)).toBe(true);
    expect(terminals.active).toBe(first.key);
    expect(cycle(A, 1)).toBe(true);
    expect(terminals.active).toBe(beside.key);
    expect(cycle(A, -1)).toBe(true);
    expect(cycle(A, -1)).toBe(true);
    expect(terminals.active).toBe(other.key);
    expect(cycle(B, 1)).toBe(false);
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

describe("splitting", () => {
  it("puts the new shell beside the source, in its group, and shows it", () => {
    const first = create(A);
    const other = create(A);
    const beside = split(first.key)!;
    expect(beside.group).toBe(first.group);
    expect(groupOf(first.key).map((shell) => shell.key)).toEqual([
      first.key,
      beside.key,
    ]);
    expect(groupsFor(A)).toHaveLength(2);
    expect(terminals.active).toBe(beside.key);
    expect(shownGroup()).toBe(first.group);
    expect(groupOf(other.key)).toHaveLength(1);
  });

  it("splits the source's own width, not the group's", () => {
    const first = create(A);
    const second = split(first.key)!;
    expect(first.weight).toBe(0.5);
    expect(second.weight).toBe(0.5);

    const third = split(second.key)!;
    expect(first.weight).toBe(0.5);
    expect(second.weight).toBe(0.25);
    expect(third.weight).toBe(0.25);
  });

  it("keeps a split beside its source, ahead of later siblings", () => {
    const first = create(A);
    const second = split(first.key)!;
    const between = split(first.key)!;
    expect(groupOf(first.key).map((shell) => shell.key)).toEqual([
      first.key,
      between.key,
      second.key,
    ]);
  });

  it("numbers a split like any other shell", () => {
    const first = create(A);
    expect(label(split(first.key)!)).toBe("shell 2");
  });

  it("refuses to split a key that is not there", () => {
    expect(split("nope")).toBeNull();
    expect(terminals.all).toHaveLength(0);
  });

  it("moves the boundary between two shells by pixels", () => {
    const left = create(A);
    const right = split(left.key)!;
    // 1000px across, so a weight of 0.5 is 500px each.
    resizeSplit(right.key, 100, 1000);
    expect(left.weight).toBeCloseTo(0.6);
    expect(right.weight).toBeCloseTo(0.4);
  });

  it("stops either shell at its minimum width", () => {
    const left = create(A);
    const right = split(left.key)!;
    resizeSplit(right.key, 900, 1000);
    expect(right.weight * 1000).toBeCloseTo(MIN_SPLIT);
    resizeSplit(right.key, -900, 1000);
    expect(left.weight * 1000).toBeCloseTo(MIN_SPLIT);
  });

  it("does not move the first shell's left edge", () => {
    const left = create(A);
    split(left.key);
    resizeSplit(left.key, 100, 1000);
    expect(left.weight).toBe(0.5);
  });

  it("shares the row out in full, whatever the weights add up to", () => {
    const left = create(A);
    const right = split(left.key)!;
    expect(share(left)).toBe(0.5);
    close(right.key);
    expect(share(left)).toBe(1);
  });

  it("makes the group even again", () => {
    const left = create(A);
    const right = split(left.key)!;
    resizeSplit(right.key, 100, 1000);
    equalize(left.key);
    expect(left.weight).toBe(1);
    expect(right.weight).toBe(1);
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

  it("shows the next group over when there is one", () => {
    const first = live(A, "pty-1");
    live(A, "pty-2");
    ended({ id: "pty-2", code: 0, clean: true });
    expect(terminals.active).toBe(first.key);
    expect(terminalVisible()).toBe(true);
  });

  // Closing one half of a split leaves you in the other half, not in some
  // other group.
  it("stays in the group when a split shell goes", () => {
    const left = live(A, "pty-1");
    const right = split(left.key)!;
    started(right.key, "pty-2");
    live(A, "pty-3");
    select(right.key);
    ended({ id: "pty-2", code: 0, clean: true });
    expect(terminals.active).toBe(left.key);
    expect(groupOf(left.key)).toHaveLength(1);
  });

  it("prefers the shell on the left, then the one on the right", () => {
    const left = live(A, "pty-1");
    const middle = split(left.key)!;
    started(middle.key, "pty-2");
    const right = split(middle.key)!;
    started(right.key, "pty-3");

    select(middle.key);
    close(middle.key);
    expect(terminals.active).toBe(left.key);

    close(left.key);
    expect(terminals.active).toBe(right.key);
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
