import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetExits, stash } from "$lib/exits";
import { sessions } from "$lib/sessions.svelte";
import { workspace } from "$lib/workspace.svelte";
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
  closeAsked,
  closeAsking,
  closeOwner,
  closeProject,
  keepAsked,
  runningIn,
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
  besideOf,
  handOver,
  ownShells,
  ownerOnScreen,
  reset,
  resizeSplit,
  select,
  sessionClosed,
  share,
  shownShells,
  shownGroup,
  split,
  started,
  statusMessage,
  terminals,
  withOwner,
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
    // What runs under a pty, as a test planted it.
    ptyProcesses: async (id: string) => {
      if (id === "pty-unreadable") throw "no such pty";
      return under[id] ?? [];
    },
  }),
}));
const written: [string, string][] = [];
let under: Record<string, { pid: number; parent: number; name: string; command: string; started: number }[]> = {};
/** Each spawned shell's output callback, to play a prompt into. */
const outputs: ((bytes: Uint8Array) => void)[] = [];

const noOutput = () => {};

/** The project's own, with no session. */
const at = (project: string) => ({ project, session: null });

function live(project: string, ptyId: string) {
  const shell = create(at(project));
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
  workspace.active = A;
  sessions.active = null;
  sessions.all = [];
  killed.length = 0;
  written.length = 0;
  outputs.length = 0;
  spawned = 0;
  spawnError = null;
  under = {};
  open();
});

describe("a command typed by the agent", () => {
  const prompt = () => outputs.at(-1)?.(new TextEncoder().encode("$ "));

  it("is written to the pty a moment after the shell's first output, without a newline", async () => {
    vi.useFakeTimers();
    const shell = create(at(A), "npm run dev");
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
    const shell = create(at(A), "\r\n");
    await launch(shell.key, 80, 24, noOutput);
    prompt();
    await vi.advanceTimersByTimeAsync(TYPE_AFTER);
    expect(written).toEqual([]);
    vi.useRealTimers();
  });

  it("is dropped when the shell went before it could be typed", async () => {
    vi.useFakeTimers();
    const shell = create(at(A), "npm run dev");
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
    const first = create(at(A));
    const second = create(at(A));
    const other = create(at(B));
    expect(label(first)).toBe("shell 1");
    expect(label(second)).toBe("shell 2");
    expect(label(other)).toBe("shell 1");

    close(second.key);
    expect(label(create(at(A)))).toBe("shell 3");
  });

  it("shows the newest shell", () => {
    create(at(A));
    const second = create(at(A));
    expect(terminals.active).toBe(second.key);
  });

  it("opens each new shell in a group of its own", () => {
    const first = create(at(A));
    const second = create(at(A));
    expect(first.group).not.toBe(second.group);
    expect(groupsFor(at(A))).toHaveLength(2);
    expect(shownGroup()).toBe(second.group);
  });

  it("keeps each project's shells apart", () => {
    create(at(A));
    create(at(B));
    create(at(A));
    expect(forProject(A)).toHaveLength(2);
    expect(forProject(B)).toHaveLength(1);
  });

  it("selects a tab by key and ignores one that is not there", () => {
    const first = create(at(A));
    create(at(A));
    select(first.key);
    expect(activeShell()).toBe(byKey(first.key));
    select("nope");
    expect(terminals.active).toBe(first.key);
  });

  it("steps through the shells on screen in list order, wrapping around", () => {
    const first = create(at(A));
    const beside = split(first.key)!;
    const other = create(at(A));
    create(at(B));
    expect(cycle(1)).toBe(true);
    expect(terminals.active).toBe(first.key);
    expect(cycle(1)).toBe(true);
    expect(terminals.active).toBe(beside.key);
    expect(cycle(-1)).toBe(true);
    expect(cycle(-1)).toBe(true);
    expect(terminals.active).toBe(other.key);
    workspace.active = B;
    follow();
    expect(cycle(1)).toBe(false);
  });

  it("follows a project to its most recent shell, or to nothing", () => {
    follow();
    create(at(A));
    const last = create(at(A));
    create(at(B));
    expect(terminals.active).toBe(last.key);
    workspace.active = "/home/ada/dev/three";
    follow();
    expect(terminals.active).toBeNull();
    workspace.active = null;
    follow();
    expect(terminals.active).toBeNull();
    workspace.active = A;
    follow();
    expect(terminals.active).toBe(last.key);
  });
});

describe("whose shells", () => {
  /** A row on screen in project A, with only what the shells read. */
  function onScreen(key: string, project = A) {
    if (!sessions.all.some((session) => session.key === key)) {
      sessions.all.push({ key, project } as unknown as (typeof sessions.all)[number]);
    }
    workspace.active = project;
    sessions.active = key;
    follow();
  }

  it("gives a shell opened with a session on screen to that session, and one with none to the project", () => {
    const own = create(at(A));
    onScreen("s1");
    expect(ownerOnScreen()).toEqual({ project: A, session: "s1" });
    const beside = create(ownerOnScreen()!);
    expect(beside.session).toBe("s1");
    expect(own.session).toBeNull();
    expect(ownShells().map((shell) => shell.key)).toEqual([beside.key]);
    sessions.active = null;
    follow();
    expect(ownShells().map((shell) => shell.key)).toEqual([own.key]);
  });

  it("numbers each session's shells from one", () => {
    onScreen("s1");
    const first = create(ownerOnScreen()!);
    onScreen("s2");
    const other = create(ownerOnScreen()!);
    expect(label(first)).toBe("shell 1");
    expect(label(other)).toBe("shell 1");
    expect(label(split(other.key)!)).toBe("shell 2");
  });

  it("lists, follows and cycles through only the shells of the session on screen", () => {
    onScreen("s1");
    const one = create(ownerOnScreen()!);
    const two = create(ownerOnScreen()!);
    onScreen("s2");
    expect(terminals.active).toBeNull();
    const theirs = create(ownerOnScreen()!);
    expect(groupsFor(ownerOnScreen())).toHaveLength(1);
    expect(cycle(1)).toBe(false);
    onScreen("s1");
    expect(terminals.active).toBe(two.key);
    expect(cycle(1)).toBe(true);
    expect(terminals.active).toBe(one.key);
    expect(byKey(theirs.key)).not.toBeNull();
  });

  it("comes back to the shell each session had in front", () => {
    onScreen("s1");
    const one = create(ownerOnScreen()!);
    create(ownerOnScreen()!);
    select(one.key);
    onScreen("s2");
    create(ownerOnScreen()!);
    onScreen("s1");
    expect(terminals.active).toBe(one.key);
  });

  it("keeps a shell made for the session coming on screen in front", () => {
    onScreen("s1");
    const old = create(ownerOnScreen()!);
    onScreen("s2");
    sessions.active = "s1";
    const made = create(ownerOnScreen()!);
    follow();
    expect(terminals.active).toBe(made.key);
    expect(byKey(old.key)).not.toBeNull();
  });

  it("makes a shell for an owner not on screen its front shell for later, leaving the screen alone", () => {
    onScreen("s1");
    const mine = create(ownerOnScreen()!);
    const theirs = create({ project: A, session: "s2" });
    expect(terminals.active).toBe(mine.key);
    onScreen("s2");
    expect(terminals.active).toBe(theirs.key);
  });

  it("stops nothing and keeps the panel open on switching to a session with no shells", () => {
    onScreen("s1");
    create(ownerOnScreen()!);
    onScreen("s2");
    expect(terminals.all).toHaveLength(1);
    expect(killed).toEqual([]);
    expect(terminalVisible()).toBe(true);
  });

  it("puts a question about a shell away when its session leaves the screen", async () => {
    onScreen("s1");
    const shell = create(ownerOnScreen()!);
    started(shell.key, "pty-q");
    under = { "pty-q": [{ pid: 7, parent: 1, name: "node", command: "node server.js", started: 1 }] };
    expect(await closeAsking(shell.key)).toBe(false);
    expect(terminals.asking?.key).toBe(shell.key);
    onScreen("s2");
    expect(terminals.asking).toBeNull();
    expect(byKey(shell.key)).not.toBeNull();
  });
});

describe("the project's own beside a session", () => {
  function onScreen(key: string) {
    if (!sessions.all.some((session) => session.key === key)) {
      sessions.all.push({ key, project: A } as unknown as (typeof sessions.all)[number]);
    }
    sessions.active = key;
    follow();
  }

  it("lists them after the session's own, and only beside a session of their project", () => {
    const own = create(at(A));
    create(at(B));
    onScreen("s1");
    const mine = create(ownerOnScreen()!);
    expect(besideOf(ownerOnScreen()).map((shell) => shell.key)).toEqual([own.key]);
    expect(shownShells().map((shell) => shell.key)).toEqual([mine.key, own.key]);
    sessions.active = null;
    follow();
    expect(besideOf(ownerOnScreen())).toEqual([]);
    expect(shownShells().map((shell) => shell.key)).toEqual([own.key]);
  });

  it("puts one in front for a session with none of its own, so nothing running is out of sight", () => {
    const own = create(at(A));
    onScreen("s1");
    expect(terminals.active).toBe(own.key);
    const mine = create(ownerOnScreen()!);
    expect(terminals.active).toBe(mine.key);
  });

  it("leaves them out of the session's cycling", () => {
    const own = create(at(A));
    onScreen("s1");
    const one = create(ownerOnScreen()!);
    const two = create(ownerOnScreen()!);
    expect(cycle(1)).toBe(true);
    expect(terminals.active).toBe(one.key);
    expect(cycle(1)).toBe(true);
    expect(terminals.active).toBe(two.key);
    // From the project's own, a step lands on the session's first.
    select(own.key);
    expect(cycle(1)).toBe(true);
    expect(terminals.active).toBe(one.key);
  });

  it("comes back to one the session had in front, and splits one in its own group", () => {
    const own = create(at(A));
    onScreen("s1");
    create(ownerOnScreen()!);
    select(own.key);
    const half = split(own.key)!;
    expect(half.session).toBeNull();
    expect(terminals.active).toBe(half.key);
    onScreen("s2");
    create(ownerOnScreen()!);
    onScreen("s1");
    expect(terminals.active).toBe(half.key);
  });

  it("closes one by hand like any other, falling back to the session's own", () => {
    const own = create(at(A));
    onScreen("s1");
    const mine = create(ownerOnScreen()!);
    select(own.key);
    close(own.key);
    expect(terminals.active).toBe(mine.key);
    expect(terminalVisible()).toBe(true);
    close(mine.key);
    expect(terminalVisible()).toBe(false);
  });

  it("names a shell with whose it is", () => {
    workspace.open = [{ path: A, name: "one" }, { path: B, name: "two" }] as unknown as typeof workspace.open;
    const own = create(at(A));
    sessions.all.push({ key: "s9", project: B, title: "docs", resumedFrom: null, ordinal: 1 } as unknown as (typeof sessions.all)[number]);
    onScreen("s1");
    const theirs = create({ project: B, session: "s9" });
    expect(withOwner(own)).toBe("shell 1 of one");
    expect(withOwner(theirs)).toBe("shell 1 of docs in two");
  });
});

describe("a row resumed in place of another", () => {
  it("takes the shells of the row it replaces, with their numbers and the one in front", () => {
    sessions.all.push({ key: "s1", project: A } as unknown as (typeof sessions.all)[number]);
    sessions.active = "s1";
    follow();
    const one = create(ownerOnScreen()!);
    const two = create(ownerOnScreen()!);
    select(one.key);
    sessions.all.push({ key: "s2", project: A } as unknown as (typeof sessions.all)[number]);
    handOver("s1", { project: A, session: "s2" });
    expect([one.session, two.session]).toEqual(["s2", "s2"]);
    expect([label(one), label(two)]).toEqual(["shell 1", "shell 2"]);
    sessions.active = "s2";
    follow();
    expect(terminals.active).toBe(one.key);
    expect(label(create(ownerOnScreen()!))).toBe("shell 3");
    expect(killed).toEqual([]);
  });
});

describe("a session closing", () => {
  function onScreen(key: string) {
    sessions.all.push({ key, project: A } as unknown as (typeof sessions.all)[number]);
    sessions.active = key;
    follow();
  }

  it("closes the session's shells, and only those", async () => {
    onScreen("s1");
    const idle = create(ownerOnScreen()!);
    started(idle.key, "pty-1");
    const dead = create(ownerOnScreen()!);
    failed(dead.key, "no shell");
    const project = create(at(A));
    sessions.active = null;
    follow();
    await sessionClosed("s1");
    expect(byKey(idle.key)).toBeNull();
    expect(byKey(dead.key)).toBeNull();
    expect(killed).toEqual(["pty-1"]);
    expect(byKey(project.key)).not.toBeNull();
    expect(terminalVisible()).toBe(true);
  });

  it("gives a busy shell to the project instead of stopping what runs, numbered among its own", async () => {
    create(at(A));
    onScreen("s1");
    const busy = create(ownerOnScreen()!);
    started(busy.key, "pty-busy");
    under = { "pty-busy": [{ pid: 9, parent: 1, name: "npm", command: "npm run dev", started: 1 }] };
    onScreen("s2");
    const theirs = create(ownerOnScreen()!);
    await sessionClosed("s1");
    expect(killed).toEqual([]);
    expect(busy.session).toBeNull();
    expect(label(busy)).toBe("shell 2");
    expect(terminals.active).toBe(theirs.key);
    // Listed beside session 2, at the foot.
    expect(shownShells().map((shell) => shell.key)).toEqual([theirs.key, terminals.all[0].key, busy.key]);
  });

  it("puts a taken-in shell in front where nothing else is", async () => {
    onScreen("s1");
    const busy = create(ownerOnScreen()!);
    started(busy.key, "pty-busy");
    under = { "pty-busy": [{ pid: 9, parent: 1, name: "npm", command: "npm run dev", started: 1 }] };
    sessions.active = null;
    follow();
    await sessionClosed("s1");
    expect(busy.session).toBeNull();
    expect(terminals.active).toBe(busy.key);
  });

  it("closes them all at once when the user said to", () => {
    onScreen("s1");
    const busy = create(ownerOnScreen()!);
    started(busy.key, "pty-busy");
    under = { "pty-busy": [{ pid: 9, parent: 1, name: "npm", command: "npm run dev", started: 1 }] };
    closeOwner({ project: A, session: "s1" });
    expect(killed).toEqual(["pty-busy"]);
    expect(terminals.all).toHaveLength(0);
    expect(terminalVisible()).toBe(true);
  });
});

describe("splitting", () => {
  it("puts the new shell beside the source, in its group, and shows it", () => {
    const first = create(at(A));
    const other = create(at(A));
    const beside = split(first.key)!;
    expect(beside.group).toBe(first.group);
    expect(groupOf(first.key).map((shell) => shell.key)).toEqual([
      first.key,
      beside.key,
    ]);
    expect(groupsFor(at(A))).toHaveLength(2);
    expect(terminals.active).toBe(beside.key);
    expect(shownGroup()).toBe(first.group);
    expect(groupOf(other.key)).toHaveLength(1);
  });

  it("splits the source's own width, not the group's", () => {
    const first = create(at(A));
    const second = split(first.key)!;
    expect(first.weight).toBe(0.5);
    expect(second.weight).toBe(0.5);

    const third = split(second.key)!;
    expect(first.weight).toBe(0.5);
    expect(second.weight).toBe(0.25);
    expect(third.weight).toBe(0.25);
  });

  it("keeps a split beside its source, ahead of later siblings", () => {
    const first = create(at(A));
    const second = split(first.key)!;
    const between = split(first.key)!;
    expect(groupOf(first.key).map((shell) => shell.key)).toEqual([
      first.key,
      between.key,
      second.key,
    ]);
  });

  it("numbers a split like any other shell", () => {
    const first = create(at(A));
    expect(label(split(first.key)!)).toBe("shell 2");
  });

  it("refuses to split a key that is not there", () => {
    expect(split("nope")).toBeNull();
    expect(terminals.all).toHaveLength(0);
  });

  it("moves the boundary between two shells by pixels", () => {
    const left = create(at(A));
    const right = split(left.key)!;
    // 1000px across, so a weight of 0.5 is 500px each.
    resizeSplit(right.key, 100, 1000);
    expect(left.weight).toBeCloseTo(0.6);
    expect(right.weight).toBeCloseTo(0.4);
  });

  it("stops either shell at its minimum width", () => {
    const left = create(at(A));
    const right = split(left.key)!;
    resizeSplit(right.key, 900, 1000);
    expect(right.weight * 1000).toBeCloseTo(MIN_SPLIT);
    resizeSplit(right.key, -900, 1000);
    expect(left.weight * 1000).toBeCloseTo(MIN_SPLIT);
  });

  it("does not move the first shell's left edge", () => {
    const left = create(at(A));
    split(left.key);
    resizeSplit(left.key, 100, 1000);
    expect(left.weight).toBe(0.5);
  });

  it("shares the row out in full, whatever the weights add up to", () => {
    const left = create(at(A));
    const right = split(left.key)!;
    expect(share(left)).toBe(0.5);
    close(right.key);
    expect(share(left)).toBe(1);
  });

  it("makes the group even again", () => {
    const left = create(at(A));
    const right = split(left.key)!;
    resizeSplit(right.key, 100, 1000);
    equalize(left.key);
    expect(left.weight).toBe(1);
    expect(right.weight).toBe(1);
  });
});

describe("starting", () => {
  it("runs once the terminal knows its size", async () => {
    const shell = create(at(A));
    expect(shell.status).toBe("starting");
    expect(await launch(shell.key, 80, 24, noOutput)).toBe(true);
    expect(shell.status).toBe("running");
    expect(shell.ptyId).toBe("pty-1");
  });

  it("records a failure to start", async () => {
    spawnError = "no pty available";
    const shell = create(at(A));
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
    const shell = create(at(A));
    const pending = launch(shell.key, 80, 24, noOutput);
    close(shell.key);
    expect(await pending).toBe(false);
    expect(killed).toEqual(["pty-1"]);
  });

  it("applies an exit that arrived before the start", () => {
    const shell = create(at(A));
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
    closeProject(A);
    expect(killed).toEqual(["pty-1", "pty-2"]);
    expect(forProject(A)).toHaveLength(0);
    expect(forProject(B)).toHaveLength(1);
    expect(terminalVisible()).toBe(true);
  });
});

describe("closing a shell", () => {
  const dev = (pid: number, parent: number, command: string, started: number) => ({
    pid,
    parent,
    name: command.split(" ")[0],
    command,
    started,
  });

  it("closes one at an idle prompt at once", async () => {
    const shell = live(A, "pty-a");
    expect(await closeAsking(shell.key)).toBe(true);
    expect(byKey(shell.key)).toBeNull();
    expect(killed).toEqual(["pty-a"]);
    expect(terminals.asking).toBeNull();
  });

  it("asks first about one with something running, naming what was started at its prompt", async () => {
    const shell = live(A, "pty-a");
    // The shell's own pid is 10; npm started node under it.
    under["pty-a"] = [dev(12, 10, "npm run dev", 200), dev(13, 12, "node vite", 201), dev(11, 10, "sleep 30", 100)];
    expect(await closeAsking(shell.key, true)).toBe(false);
    expect(byKey(shell.key)).not.toBeNull();
    expect(terminals.asking).toEqual({ key: shell.key, running: ["sleep 30", "npm run dev"], fromRow: true });
    closeAsked();
    expect(byKey(shell.key)).toBeNull();
    expect(terminals.asking).toBeNull();
  });

  it("keeps the shell when the answer is to keep it", async () => {
    const shell = live(A, "pty-a");
    under["pty-a"] = [dev(12, 10, "npm run dev", 200)];
    await closeAsking(shell.key);
    keepAsked();
    expect(byKey(shell.key)).not.toBeNull();
    expect(terminals.asking).toBeNull();
    expect(killed).toEqual([]);
  });

  it("brings the shell asked about to the front, and puts the question away when another comes forward", async () => {
    const first = live(A, "pty-a");
    const second = live(A, "pty-b");
    under["pty-a"] = [dev(12, 10, "npm run dev", 200)];
    await closeAsking(first.key);
    expect(terminals.active).toBe(first.key);
    select(second.key);
    expect(terminals.asking).toBeNull();
    expect(byKey(first.key)).not.toBeNull();
  });

  it("puts the question away when the shell goes by itself", async () => {
    const shell = live(A, "pty-a");
    under["pty-a"] = [dev(12, 10, "npm run dev", 200)];
    await closeAsking(shell.key);
    ended({ id: "pty-a", code: 0, clean: true });
    expect(terminals.asking).toBeNull();
  });

  it("closes at once a shell that is not running, or whose processes cannot be read", async () => {
    const crashed = live(A, "pty-c");
    ended({ id: "pty-c", code: 1, clean: false });
    expect(await closeAsking(crashed.key)).toBe(true);
    expect(byKey(crashed.key)).toBeNull();
    const unreadable = live(A, "pty-unreadable");
    expect(await closeAsking(unreadable.key)).toBe(true);
    expect(byKey(unreadable.key)).toBeNull();
  });
});

describe("what counts as running in a shell", () => {
  const proc = (pid: number, parent: number, name: string, command = name, started = pid) => ({
    pid,
    parent,
    name,
    command,
    started,
  });

  it("leaves out a prompt's helper and what runs under it", async () => {
    under["pty-a"] = [proc(11, 10, "gitstatusd-darwin-arm64"), proc(12, 11, "git", "git status")];
    expect(await runningIn("pty-a")).toEqual([]);
  });

  it("counts a shell started under the shell for what it runs, and an idle one for nothing", async () => {
    under["pty-a"] = [proc(11, 10, "zsh"), proc(12, 11, "npm", "npm run dev"), proc(13, 12, "node", "node vite")];
    expect(await runningIn("pty-a")).toEqual(["npm run dev"]);
    under["pty-b"] = [proc(11, 10, "-zsh"), proc(14, 10, "bash.exe")];
    expect(await runningIn("pty-b")).toEqual([]);
  });

  it("still names what the user started beside a helper", async () => {
    under["pty-a"] = [proc(11, 10, "gitstatusd-linux-x86_64"), proc(15, 10, "sleep", "sleep 600")];
    expect(await runningIn("pty-a")).toEqual(["sleep 600"]);
  });
});
