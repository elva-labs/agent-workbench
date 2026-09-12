import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import type { ConductRequest } from "$lib/core";
import {
  CAP,
  allow,
  conductor,
  handle,
  once,
  refuse,
  resetConductor,
  startedBy,
  startedFor,
  stopAll,
  worktreeName,
} from "$lib/conductor.svelte";
import {
  byKey,
  create,
  exact,
  forProject,
  reset as resetSessions,
  sessions,
  started,
} from "$lib/sessions.svelte";
import { register, resetScreens, type Screen } from "$lib/screens";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

const A = "/home/ada/dev/one";
const B = "/home/ada/dev/two";

const answers: {
  id: string;
  cwd: string;
  content: string | null;
  error: string | null;
}[] = [];
const written: [string, string][] = [];
const killed: string[] = [];
const worktrees: [string, string][] = [];
let worktreeFails: string | null = null;

vi.mock("$lib/core", () => ({
  core: () => ({
    async conductAnswer(
      id: string,
      cwd: string,
      content: string | null,
      error: string | null,
    ) {
      answers.push({ id, cwd, content, error });
    },
    async worktreeAdd(project: string, name: string) {
      worktrees.push([project, name]);
      if (worktreeFails !== null) throw worktreeFails;
      return `${project}/.worktrees/${name}`;
    },
    async write(id: string, data: string) {
      written.push([id, data]);
    },
    async kill(id: string) {
      killed.push(id);
    },
    async projectInfo(path: string) {
      return { path, name: path, repository: path, isGit: true };
    },
    async transcripts() {
      return [];
    },
    async setWindowTitle() {},
  }),
}));

let calls = 0;

function call(
  tool: ConductRequest["tool"],
  args: Record<string, unknown> = {},
  extra: Partial<ConductRequest> = {},
): ConductRequest {
  return {
    id: `c${++calls}`,
    tool,
    arguments: args,
    cwd: A,
    session: null,
    ...extra,
  };
}

const last = () => answers[answers.length - 1];

/** A terminal with these lines in its buffer. */
function screenOf(lines: string[]): Screen {
  return {
    buffer: {
      active: {
        length: lines.length,
        getLine: (index: number) => ({ translateToString: () => lines[index] }),
      },
    },
  };
}
/** Lets every promise and every effect the store woke run to the end. */
const settle = () => vi.advanceTimersByTimeAsync(0);

const repo = (path: string) => ({
  path,
  name: path.split("/").pop()!,
  repository: path,
  isGit: true,
});

/** A session that has actually come up, as one does in practice. */
function live(project: string, ptyId: string, id: string) {
  const session = create(project, null, "claude-code", null);
  started(session.key, ptyId, id);
  return session;
}

/** A session the caller started, which is what the tools may act on. */
function own(project: string, ptyId: string, id: string, caller: string = A) {
  const row = live(project, ptyId, id);
  conductor.startedBy[row.key] = caller;
  return row;
}

/** A start the user allows, answered once the new session reports its id. */
async function startAllowed(
  request: ConductRequest,
  ptyId: string,
  id: string,
) {
  const answering = handle(request);
  if (conductor.asking !== null) allow();
  await settle();
  const row = forProject(String(request.arguments.project)).at(-1)!;
  started(row.key, ptyId, id);
  flushSync();
  await answering;
  return row;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetWorkspace();
  resetSessions();
  resetConductor();
  resetScreens();
  answers.length = 0;
  written.length = 0;
  killed.length = 0;
  worktrees.length = 0;
  worktreeFails = null;
  calls = 0;
  workspace.open.push(repo(A), repo(B));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the projects tool", () => {
  it("lists every open project and marks the caller's own", async () => {
    await handle(call("projects", {}, { cwd: `${B}/src/cache` }));
    expect(last().error).toBeNull();
    expect(last().content).toBe(`${A}  one\n${B}  two  (this one)`);
  });

  // A project opened inside another is the one a call from inside it is
  // for: the deepest match, not the first.
  it("takes the deepest project a caller is under", async () => {
    workspace.open.push(repo(`${A}/packages/ui`));
    await handle(call("projects", {}, { cwd: `${A}/packages/ui/src` }));
    expect(last().content).toContain(`${A}/packages/ui  ui  (this one)`);
    expect(last().content).not.toContain(`${A}  one  (this one)`);
  });

  it("says so when nothing is open", async () => {
    workspace.open.length = 0;
    await handle(call("projects"));
    expect(last().content).toBe("No projects are open in the workbench.");
  });
});

describe("the sessions tool", () => {
  it("gives each session its id, name, project, agent, state and line", async () => {
    const session = live(A, "pty-1", "sid-1");
    session.title = "fix the cache";
    session.note = "which cache did you mean?";
    session.needs = "permission";
    await handle(call("sessions"));
    expect(last().content).toBe(
      `sid-1  fix the cache  ${A}  claude-code  asking for permission  last line: which cache did you mean?`,
    );
  });

  it("names the worktree a session runs in", async () => {
    const session = create(A, null, "claude-code", `${A}/.worktrees/fix`);
    started(session.key, "pty-1", "sid-1");
    await handle(call("sessions"));
    expect(last().content).toContain(`worktree ${A}/.worktrees/fix`);
  });

  it("leaves out a session with no id yet, since an id is how it is named", async () => {
    create(A, null, "claude-code", null);
    await handle(call("sessions"));
    expect(last().content).toBe("No sessions are open in the workbench.");
  });

  it("lists one project's sessions when it is asked for one", async () => {
    live(A, "pty-1", "sid-1");
    live(B, "pty-2", "sid-2");
    await handle(call("sessions", { project: B }));
    expect(last().content).toContain("sid-2");
    expect(last().content).not.toContain("sid-1");
  });

  it("says what a session is doing", async () => {
    const session = live(A, "pty-1", "sid-1");
    await handle(call("sessions"));
    expect(last().content).toContain("waiting");
    session.working = true;
    await handle(call("sessions"));
    expect(last().content).toContain("working");
  });
});

describe("starting a session", () => {
  it("asks the user, then starts one and answers with its id", async () => {
    const request = call(
      "start",
      { project: A, prompt: "Fix the flaky test" },
      { session: "caller-1" },
    );
    const answering = handle(request);
    expect(conductor.asking?.project).toBe(A);
    expect(conductor.asking?.prompt).toBe("Fix the flaky test");
    expect(conductor.asking?.worktree).toBe(false);

    allow();
    await settle();
    const row = forProject(A)[0];
    expect(row).toBeDefined();
    started(row.key, "pty-1", "sid-new");
    flushSync();
    await answering;

    expect(last().error).toBeNull();
    expect(last().content).toContain("sid-new");
    expect(startedFor(row.key)).toBe("caller-1");
    expect(startedBy("caller-1")).toHaveLength(1);
  });

  it("leaves the window on the session that started it", async () => {
    const caller = live(A, "pty-0", "caller-1");
    sessions.active = caller.key;
    await startAllowed(
      call("start", { project: A, prompt: "Fix it" }, { session: "caller-1" }),
      "pty-1",
      "sid-1",
    );
    expect(sessions.active).toBe(caller.key);
  });

  it("gives the session its prompt to start with, as one line", async () => {
    const row = await startAllowed(
      call(
        "start",
        { project: A, prompt: "Fix the flaky test\nin the cache" },
        { session: "caller-1" },
      ),
      "pty-1",
      "sid-new",
    );
    expect(row.prompt).toBe("Fix the flaky test in the cache");
    expect(written).toHaveLength(0);
  });

  it("makes a worktree when one is asked for, and starts the session in it", async () => {
    const row = await startAllowed(
      call(
        "start",
        { project: A, prompt: "Fix the flaky test", worktree: true },
        { session: "caller-1" },
      ),
      "pty-1",
      "sid-new",
    );
    expect(worktrees).toEqual([[A, "fix-the-flaky-test"]]);
    expect(row.startIn).toBe(`${A}/.worktrees/fix-the-flaky-test`);
    expect(last().content).toContain(`${A}/.worktrees/fix-the-flaky-test`);
  });

  it("refuses when the worktree cannot be made", async () => {
    worktreeFails = "not a git repository";
    const answering = handle(
      call(
        "start",
        { project: A, prompt: "Fix it", worktree: true },
        { session: "caller-1" },
      ),
    );
    allow();
    await settle();
    await answering;
    expect(last().error).toContain("not a git repository");
    expect(forProject(A)).toHaveLength(0);
  });

  it("refuses a project that is not open", async () => {
    await handle(call("start", { project: "/elsewhere", prompt: "Fix it" }));
    expect(last().content).toBeNull();
    expect(last().error).toBe(
      "No project at /elsewhere is open in the workbench.",
    );
    expect(conductor.asking).toBeNull();
  });

  it("refuses a prompt with nothing in it", async () => {
    await handle(call("start", { project: A, prompt: "  " }));
    expect(last().error).toContain("needs a prompt");
    expect(conductor.asking).toBeNull();
  });

  it("refuses past the cap of running sessions one caller may have", async () => {
    for (let n = 0; n < CAP; n += 1) {
      const row = live(A, `pty-${n}`, `sid-${n}`);
      conductor.startedBy[row.key] = "caller-1";
    }
    await handle(
      call(
        "start",
        { project: A, prompt: "One more" },
        { session: "caller-1" },
      ),
    );
    expect(last().error).toContain(`${CAP} sessions running already`);
    expect(conductor.asking).toBeNull();
  });

  it("counts only the caller's running sessions against the cap", async () => {
    for (let n = 0; n < CAP; n += 1) {
      const row = live(A, `pty-${n}`, `sid-${n}`);
      conductor.startedBy[row.key] = "caller-1";
      row.status = "exited";
    }
    const answering = handle(
      call(
        "start",
        { project: A, prompt: "One more" },
        { session: "caller-1" },
      ),
    );
    expect(conductor.asking).not.toBeNull();
    refuse();
    await answering;
  });

  it("refuses a session that another session started", async () => {
    const row = live(A, "pty-1", "child-1");
    conductor.startedBy[row.key] = "caller-1";
    await handle(
      call("start", { project: A, prompt: "Deeper" }, { session: "child-1" }),
    );
    expect(last().error).toContain("cannot start sessions of its own");
    expect(conductor.asking).toBeNull();
  });

  it("refuses when the user says no", async () => {
    const answering = handle(
      call("start", { project: A, prompt: "Fix it" }, { session: "caller-1" }),
    );
    refuse();
    await answering;
    expect(last().error).toContain("did not allow");
    expect(forProject(A)).toHaveLength(0);
  });
});

describe("the question", () => {
  it("is asked once for a caller and a project, and again for another", async () => {
    await startAllowed(
      call("start", { project: A, prompt: "One" }, { session: "caller-1" }),
      "pty-1",
      "sid-1",
    );
    expect(answers).toHaveLength(1);

    const second = handle(
      call("start", { project: A, prompt: "Two" }, { session: "caller-1" }),
    );
    expect(conductor.asking).toBeNull();
    await settle();
    const row = forProject(A).at(-1)!;
    started(row.key, "pty-2", "sid-2");
    flushSync();
    await second;
    expect(last().content).toContain("sid-2");

    // Another project is another question, and so is another caller.
    handle(
      call("start", { project: B, prompt: "Three" }, { session: "caller-1" }),
    );
    expect(conductor.asking?.project).toBe(B);
    refuse();
    await settle();
    handle(
      call("start", { project: A, prompt: "Four" }, { session: "caller-2" }),
    );
    expect(conductor.asking?.project).toBe(A);
    refuse();
    await settle();
  });

  it("asks again after a once", async () => {
    const first = handle(
      call("start", { project: A, prompt: "One" }, { session: "caller-1" }),
    );
    once();
    await settle();
    const row = forProject(A)[0];
    started(row.key, "pty-1", "sid-1");
    flushSync();
    await first;

    handle(
      call("start", { project: A, prompt: "Two" }, { session: "caller-1" }),
    );
    expect(conductor.asking?.prompt).toBe("Two");
    refuse();
    await settle();
  });

  it("queues a question that arrives while one is up", async () => {
    handle(
      call("start", { project: A, prompt: "One" }, { session: "caller-1" }),
    );
    const second = handle(
      call("start", { project: B, prompt: "Two" }, { session: "caller-2" }),
    );
    expect(conductor.asking?.prompt).toBe("One");
    refuse();
    await settle();
    expect(conductor.asking?.prompt).toBe("Two");
    refuse();
    await second;
    expect(answers).toHaveLength(2);
  });

  it("names the calling session", async () => {
    const row = live(A, "pty-1", "caller-1");
    row.title = "the conductor";
    handle(
      call("start", { project: A, prompt: "One" }, { session: "caller-1" }),
    );
    expect(conductor.asking?.caller).toBe("the conductor");
    refuse();
    await settle();
  });
});

describe("sending and stopping", () => {
  it("sends a line to a session as one typed line", async () => {
    own(A, "pty-1", "sid-1");
    await handle(call("send", { session: "sid-1", text: "yes\nplease" }));
    expect(written).toEqual([["pty-1", "yes please\r"]]);
    expect(last().error).toBeNull();
  });

  it("refuses a session the workbench does not have", async () => {
    await handle(call("send", { session: "nope", text: "hello" }));
    expect(last().error).toBe("The workbench has no session nope.");
    expect(written).toHaveLength(0);
  });

  it("refuses a session that is not running", async () => {
    const row = own(A, "pty-1", "sid-1");
    row.status = "exited";
    await handle(call("send", { session: "sid-1", text: "hello" }));
    expect(last().error).toBe("Session sid-1 is not running.");
  });

  it("stops a session the way the pane's close does", async () => {
    const row = own(A, "pty-1", "sid-1");
    await handle(call("stop", { session: "sid-1" }));
    expect(killed).toEqual(["pty-1"]);
    expect(byKey(row.key)).toBeNull();
    expect(last().content).toBe("Stopped session sid-1.");
  });

  it("refuses to stop a session it does not have", async () => {
    await handle(call("stop", { session: "nope" }));
    expect(last().error).toBe("The workbench has no session nope.");
  });
});

describe("a session the caller did not start", () => {
  /** The user's own session, running beside the caller. */
  const theirs = () => live(A, "pty-9", "sid-9");

  it("takes no line", async () => {
    theirs();
    await handle(call("send", { session: "sid-9", text: "rm -rf /" }));
    expect(last().error).toContain("was not started by you");
    expect(written).toHaveLength(0);
  });

  it("is not stopped", async () => {
    const row = theirs();
    await handle(call("stop", { session: "sid-9" }));
    expect(last().error).toContain("was not started by you");
    expect(killed).toHaveLength(0);
    expect(byKey(row.key)).not.toBeNull();
  });

  it("is not read", async () => {
    const row = theirs();
    register(row.key, screenOf(["the user's own work"]));
    await handle(call("read", { session: "sid-9" }));
    expect(last().error).toContain("was not started by you");
    expect(last().content).toBeNull();
  });

  it("is not waited on", async () => {
    theirs();
    await handle(call("wait", { session: "sid-9" }));
    expect(last().error).toContain("was not started by you");
  });

  it("is still listed, so the caller knows what is running", async () => {
    theirs();
    await handle(call("sessions"));
    expect(last().error).toBeNull();
    expect(last().content).toContain("sid-9");
  });
});

describe("waiting", () => {
  it("comes back when the session stops working", async () => {
    const row = own(A, "pty-1", "sid-1");
    row.working = true;
    row.note = "the cache is fixed";
    const answering = handle(call("wait", { session: "sid-1" }));
    await settle();
    row.working = false;
    flushSync();
    await answering;
    expect(last().content).toBe(
      "Session sid-1 stopped working. Its last line: the cache is fixed",
    );
  });

  it("comes back when the session asks for permission", async () => {
    const row = own(A, "pty-1", "sid-1");
    row.working = true;
    const answering = handle(call("wait", { session: "sid-1" }));
    await settle();
    exact("sid-1", "permission");
    flushSync();
    await answering;
    expect(last().content).toContain("asking for permission");
  });

  it("comes back when the session ends", async () => {
    const row = own(A, "pty-1", "sid-1");
    row.working = true;
    const answering = handle(call("wait", { session: "sid-1" }));
    await settle();
    row.status = "exited";
    flushSync();
    await answering;
    expect(last().content).toContain("exited");
  });

  it("waits on any of the caller's own when none is named", async () => {
    const mine = own(A, "pty-1", "sid-1", "caller-1");
    const other = live(A, "pty-2", "sid-2");
    mine.working = true;
    other.working = true;
    const answering = handle(call("wait", {}, { session: "caller-1" }));
    await settle();
    other.working = false;
    flushSync();
    await settle();
    expect(answers).toHaveLength(0);
    mine.working = false;
    flushSync();
    await answering;
    expect(last().content).toContain("sid-1");
  });

  it("gives up after the seconds it was given", async () => {
    own(A, "pty-1", "sid-1");
    const answering = handle(call("wait", { session: "sid-1", seconds: 5 }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(answers).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    await answering;
    expect(last().error).toBeNull();
    expect(last().content).toBe(
      "Nothing happened within 5 seconds: no session stopped and none asked anything.",
    );
  });

  it("refuses a wait for nothing it has", async () => {
    await handle(call("wait", { session: "nope" }));
    expect(last().error).toBe("The workbench has no session nope.");
    await handle(call("wait", {}, { session: "caller-1" }));
    expect(last().error).toContain("started no sessions");
  });
});

describe("reading", () => {
  it("answers with the last lines on the session's screen", async () => {
    const row = own(A, "pty-1", "sid-1");
    register(row.key, screenOf(["> run the tests", "", "42 passed", "", ""]));
    await handle(call("read", { session: "sid-1", lines: 3 }));
    expect(last().error).toBeNull();
    expect(last().content).toBe(
      "Session sid-1, as it is on screen:\n42 passed",
    );
  });

  it("reads as far back as it was asked to, and no further", async () => {
    const row = own(A, "pty-1", "sid-1");
    register(row.key, screenOf(["one", "two", "three", "four"]));
    await handle(call("read", { session: "sid-1", lines: 2 }));
    expect(last().content).toContain("three\nfour");
    await handle(call("read", { session: "sid-1" }));
    expect(last().content).toContain("one\ntwo\nthree\nfour");
  });

  it("says a session has drawn nothing, and gives the last line", async () => {
    const row = own(A, "pty-1", "sid-1");
    row.note = "waiting on the review";
    await handle(call("read", { session: "sid-1" }));
    expect(last().error).toBeNull();
    expect(last().content).toContain("has drawn nothing yet");
    expect(last().content).toContain("Its last line: waiting on the review");
  });

  it("refuses a session it does not have", async () => {
    await handle(call("read", { session: "nope" }));
    expect(last().error).toBe("The workbench has no session nope.");
  });
});

describe("the parent link", () => {
  it("says who started what, and stops them together", async () => {
    const first = live(A, "pty-1", "sid-1");
    const second = live(A, "pty-2", "sid-2");
    const outside = live(B, "pty-3", "sid-3");
    conductor.startedBy[first.key] = "caller-1";
    conductor.startedBy[second.key] = "caller-1";

    expect(startedFor(first.key)).toBe("caller-1");
    expect(startedFor(outside.key)).toBeNull();
    expect(startedBy("caller-1").map((session) => session.id)).toEqual([
      "sid-1",
      "sid-2",
    ]);

    stopAll("caller-1");
    expect(killed).toEqual(["pty-1", "pty-2"]);
    expect(sessions.all.map((session) => session.id)).toEqual(["sid-3"]);
  });
});

describe("naming a worktree", () => {
  it("makes a name out of the prompt", () => {
    expect(worktreeName("Fix the flaky Test!")).toBe("fix-the-flaky-test");
  });

  it("cuts a long prompt to forty characters", () => {
    const name = worktreeName(
      "Fix the flaky cache test that keeps failing on Windows",
    );
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name).toBe("fix-the-flaky-cache-test-that-keeps");
  });

  it("falls back to a name for a prompt with no words in it", () => {
    expect(worktreeName("!!!")).toBe("session");
  });
});

describe("the answer", () => {
  it("goes back to the machine the call was made on", async () => {
    await handle(call("projects", {}, { cwd: `${A}/src` }));
    expect(last().cwd).toBe(`${A}/src`);

    const remote = "ssh://lab/srv/api";
    workspace.open.push(repo(remote));
    await handle(call("projects", {}, { cwd: `${remote}/src` }));
    expect(last().cwd).toBe(`${remote}/src`);
  });
});
