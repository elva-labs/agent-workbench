import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import type { ConductRequest } from "$lib/core";
import {
  CAP,
  ENTER_AFTER,
  OUTCOME_ASK,
  allow,
  allowedProjects,
  conductor,
  handle,
  loadStarted,
  once,
  refuse,
  resetConductor,
  revoke,
  startedBy,
  startedFor,
  stopAll,
  worktreeName,
} from "$lib/conductor.svelte";
import {
  byKey,
  create,
  ended,
  exact,
  failed,
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
/** The worktrees each project has, as the core lists them. */
let standing: Record<string, string[]> = {};

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
    async worktrees(project: string) {
      return (standing[project] ?? []).map((path) => ({
        path,
        name: path.split("/").pop(),
        branch: "main",
        merged: false,
        dirty: false,
      }));
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
  standing = {};
  calls = 0;
  localStorage.removeItem("workbench.started");
  workspace.open.push(repo(A), repo(B));
});

/** A resume, answered once the row's process is up. Nothing is asked: the
    consent was given when the session was started. */
async function resumed(request: ConductRequest, ptyId: string) {
  const answering = handle(request);
  await settle();
  expect(conductor.asking).toBeNull();
  const row = sessions.all.at(-1)!;
  started(row.key, ptyId, row.id);
  flushSync();
  await answering;
  return row;
}

/** The window came back after the app was closed: the rows are gone, and
    what callers started is read back from storage. */
function restarted() {
  resetSessions();
  resetConductor();
  loadStarted();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the projects tool", () => {
  it("lists every open project and marks the caller's own", async () => {
    await handle(call("projects", {}, { cwd: `${B}/src/cache` }));
    expect(last().error).toBeNull();
    expect(last().content).toBe(`${A}  one\n${B}  two  (this one)`);
  });

  it("tells two projects of the same name apart the way the pane does", async () => {
    workspace.open.push(
      repo("/home/ada/work/dev-portal"),
      repo("/home/ada/spike/dev-portal"),
    );
    await handle(call("projects"));
    const lines = (last().content ?? "").split("\n");
    expect(lines[2]).toBe("/home/ada/work/dev-portal  work/dev-portal");
    expect(lines[3]).toBe("/home/ada/spike/dev-portal  spike/dev-portal");
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
    const session = own(A, "pty-1", "sid-1");
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
    conductor.startedBy[session.key] = A;
    await handle(call("sessions"));
    expect(last().content).toContain(`worktree ${A}/.worktrees/fix`);
  });

  it("leaves out a session with no id yet, since an id is how it is named", async () => {
    const row = create(A, null, "claude-code", null);
    conductor.startedBy[row.key] = A;
    await handle(call("sessions"));
    expect(last().content).toBe("You have started no sessions.");
  });

  it("lists the sessions the caller started and none of the user's own", async () => {
    own(A, "pty-1", "sid-1");
    live(A, "pty-2", "sid-2");
    await handle(call("sessions"));
    expect(last().content).toContain("sid-1");
    expect(last().content).not.toContain("sid-2");
  });

  it("lists one project's sessions when it is asked for one", async () => {
    own(A, "pty-1", "sid-1");
    own(B, "pty-2", "sid-2");
    await handle(call("sessions", { project: B }));
    expect(last().content).toContain("sid-2");
    expect(last().content).not.toContain("sid-1");
  });

  it("says what a session is doing", async () => {
    const session = own(A, "pty-1", "sid-1");
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

  it("names the session and its worktree after the name the caller gives", async () => {
    const row = await startAllowed(
      call(
        "start",
        {
          project: A,
          prompt: "Fix the flaky cache test",
          name: "Cache test flake",
          worktree: true,
        },
        { session: "caller-1" },
      ),
      "pty-1",
      "sid-new",
    );
    expect(row.title).toBe("Cache test flake");
    expect(worktrees).toEqual([[A, "cache-test-flake"]]);
  });

  it("gives the session its prompt as one line, and asks it to say how it went", async () => {
    const row = await startAllowed(
      call(
        "start",
        { project: A, prompt: "Fix the flaky test\nin the cache" },
        { session: "caller-1" },
      ),
      "pty-1",
      "sid-new",
    );
    expect(row.prompt).toBe(`Fix the flaky test in the cache ${OUTCOME_ASK}`);
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

  it("starts the session on the model the caller names", async () => {
    const row = await startAllowed(
      call(
        "start",
        {
          project: A,
          prompt: "Fix the flaky test",
          agent: "claude-code",
          model: "sonnet",
        },
        { session: "caller-1" },
      ),
      "pty-1",
      "sid-new",
    );
    expect(row.model).toBe("sonnet");
    const plain = await startAllowed(
      call("start", { project: A, prompt: "Fix it" }, { session: "caller-1" }),
      "pty-2",
      "sid-2",
    );
    expect(plain.model).toBeNull();
  });

  it("refuses a model named without an agent", async () => {
    await handle(
      call(
        "start",
        { project: A, prompt: "Fix it", model: "sonnet" },
        { session: "caller-1" },
      ),
    );
    expect(last().error).toContain("names the agent too");
    expect(conductor.asking).toBeNull();
    expect(forProject(A)).toHaveLength(0);
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

  it("lists the projects a caller may start in, and asks again once one is taken back", async () => {
    await startAllowed(
      call("start", { project: A, prompt: "One" }, { session: "caller-1" }),
      "pty-1",
      "sid-1",
    );
    expect(allowedProjects("caller-1")).toEqual([A]);
    // What one caller was allowed is not what another was.
    expect(allowedProjects("caller-2")).toEqual([]);

    await startAllowed(
      call("start", { project: B, prompt: "Two" }, { session: "caller-1" }),
      "pty-2",
      "sid-2",
    );
    expect(allowedProjects("caller-1")).toEqual([A, B]);

    revoke("caller-1", A);
    expect(allowedProjects("caller-1")).toEqual([B]);
    // Taking back one the caller never had leaves the rest alone.
    revoke("caller-1", "/elsewhere");
    expect(allowedProjects("caller-1")).toEqual([B]);

    handle(
      call("start", { project: A, prompt: "Three" }, { session: "caller-1" }),
    );
    expect(conductor.asking?.project).toBe(A);
    refuse();
    await settle();
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
  it("sends a line to a session as one typed line, and Enter on its own after it", async () => {
    own(A, "pty-1", "sid-1");
    const answering = handle(
      call("send", { session: "sid-1", text: "yes\nplease" }),
    );
    await settle();
    expect(written).toEqual([["pty-1", "yes please"]]);
    await vi.advanceTimersByTimeAsync(ENTER_AFTER);
    await answering;
    expect(written).toEqual([
      ["pty-1", "yes please"],
      ["pty-1", "\r"],
    ]);
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

  it("stops a session the way the pane's close does, and files it away", async () => {
    const row = own(A, "pty-1", "sid-1");
    sessions.mine[A] = ["sid-1"];
    await handle(call("stop", { session: "sid-1" }));
    expect(killed).toEqual(["pty-1"]);
    expect(byKey(row.key)).toBeNull();
    // Filed with the sessions to resume, behind the fold, rather than left
    // as a past row of the project's own.
    expect(sessions.mine[A]).toEqual([]);
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

  it("is not even listed", async () => {
    theirs();
    await handle(call("sessions"));
    expect(last().error).toBeNull();
    expect(last().content).toBe("You have started no sessions.");
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

describe("what a caller started, between runs", () => {
  async function startTwo() {
    await startAllowed(
      call(
        "start",
        {
          project: A,
          prompt: "Fix the flaky test",
          name: "Cache flake",
          worktree: true,
        },
        { session: "caller-1" },
      ),
      "pty-1",
      "sid-1",
    );
    await startAllowed(
      call(
        "start",
        { project: B, prompt: "Bump deps" },
        { session: "caller-1" },
      ),
      "pty-2",
      "sid-2",
    );
  }

  it("is written down as it is started, and read back after a restart", async () => {
    await startTwo();
    expect(conductor.started["caller-1"]).toEqual([
      {
        id: "sid-1",
        project: A,
        worktree: `${A}/.worktrees/cache-flake`,
        agent: "claude-code",
        name: "Cache flake",
      },
      {
        id: "sid-2",
        project: B,
        worktree: null,
        agent: "claude-code",
        name: null,
      },
    ]);

    restarted();
    expect(sessions.all).toHaveLength(0);
    expect(conductor.started["caller-1"]).toHaveLength(2);
  });

  it("is listed as stopped by the sessions tool, with the way back", async () => {
    await startTwo();
    restarted();
    await handle(call("sessions", {}, { session: "caller-1" }));
    const lines = last().content!.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("sid-1  Cache flake  ");
    expect(lines[0]).toContain(`worktree ${A}/.worktrees/cache-flake`);
    expect(lines[0]).toContain("stopped");
    expect(lines[0]).toContain("naming session sid-1");
    expect(lines[1]).toContain("sid-2  sid-2  ");

    await handle(call("sessions", { project: B }, { session: "caller-1" }));
    expect(last().content!.split("\n")).toHaveLength(1);
    expect(last().content).toContain("sid-2");
  });

  it("is nobody else's to list", async () => {
    await startTwo();
    restarted();
    await handle(call("sessions", {}, { session: "caller-2" }));
    expect(last().content).toBe("You have started no sessions.");
  });

  it("is forgotten when the caller stops it", async () => {
    await startTwo();
    await handle(call("stop", { session: "sid-2" }, { session: "caller-1" }));
    expect(conductor.started["caller-1"].map((entry) => entry.id)).toEqual([
      "sid-1",
    ]);
    restarted();
    expect(conductor.started["caller-1"].map((entry) => entry.id)).toEqual([
      "sid-1",
    ]);
  });

  it("makes a row with that id the caller's, however it came back", async () => {
    await startTwo();
    restarted();
    // The user resumed it from the pane themselves.
    const row = create(B, "sid-2", "claude-code");
    started(row.key, "pty-9", "sid-2");
    expect(startedFor(row.key)).toBe("caller-1");
    expect(startedBy("caller-1")).toHaveLength(1);
    await handle(call("sessions", {}, { session: "caller-1" }));
    const lines = last().content!.split("\n");
    expect(lines[0]).toContain("sid-2");
    expect(lines[0]).toContain("waiting");
    expect(lines[1]).toContain("sid-1");
    expect(lines[1]).toContain("stopped");
  });

  it("reads a corrupt record as nothing started", () => {
    localStorage.setItem("workbench.started", "{not json");
    expect(() => loadStarted()).not.toThrow();
    localStorage.setItem(
      "workbench.started",
      JSON.stringify({
        "caller-1": [
          { id: "ok", project: A, worktree: null, agent: "codex", name: null },
          { id: 7, project: A, worktree: null, agent: "codex", name: null },
          {
            id: "bad-agent",
            project: A,
            worktree: null,
            agent: "x",
            name: null,
          },
        ],
        "caller-2": "not a list",
      }),
    );
    loadStarted();
    expect(conductor.started).toEqual({
      "caller-1": [
        { id: "ok", project: A, worktree: null, agent: "codex", name: null },
      ],
    });
  });
});

describe("resuming a session", () => {
  const tree = `${A}/.worktrees/cache-flake`;

  async function startInTree() {
    await startAllowed(
      call(
        "start",
        {
          project: A,
          prompt: "Fix the flaky test",
          name: "Cache flake",
          worktree: true,
        },
        { session: "caller-1" },
      ),
      "pty-1",
      "sid-1",
    );
    restarted();
    worktrees.length = 0;
    standing = { [A]: [tree] };
  }

  it("brings the session back where it ran, with the prompt and the model, asking nothing: its start was consented to", async () => {
    await startInTree();
    const request = call(
      "start",
      { session: "sid-1", prompt: "Go on with\nthe test", model: "opus" },
      { session: "caller-1" },
    );
    const answering = handle(request);
    await settle();
    // A fresh run: the caller has no standing answer, and none is needed.
    expect(allowedProjects("caller-1")).toEqual([]);
    expect(conductor.asking).toBeNull();

    const row = sessions.all[0];
    expect(row.resumedFrom).toBe("sid-1");
    expect(row.id).toBe("sid-1");
    expect(row.startIn).toBe(tree);
    expect(row.title).toBe("Cache flake");
    expect(row.prompt).toBe(`Go on with the test ${OUTCOME_ASK}`);
    expect(row.model).toBe("opus");
    expect(startedFor(row.key)).toBe("caller-1");
    // Nothing is made: the worktree stands.
    expect(worktrees).toHaveLength(0);

    started(row.key, "pty-5", "sid-1");
    flushSync();
    await answering;
    expect(last().error).toBeNull();
    expect(last().content).toContain(
      `Resumed session sid-1 in ${A}, in ${tree}`,
    );
    expect(last().content).toContain("the prompt");
  });

  it("comes up waiting when no prompt is given", async () => {
    await startInTree();
    const row = await resumed(
      call("start", { session: "sid-1" }, { session: "caller-1" }),
      "pty-5",
    );
    expect(row.prompt).toBeNull();
    expect(conductor.asking).toBeNull();
    expect(last().content).toContain("Send it a line to go on");
  });

  it("leaves the window where it was", async () => {
    await startInTree();
    const caller = live(B, "pty-0", "caller-1");
    sessions.active = caller.key;
    await resumed(
      call("start", { session: "sid-1" }, { session: "caller-1" }),
      "pty-5",
    );
    expect(sessions.active).toBe(caller.key);
  });

  it("says why when the session did not come up", async () => {
    await startInTree();
    const answering = handle(
      call("start", { session: "sid-1" }, { session: "caller-1" }),
    );
    await settle();
    const row = sessions.all[0];
    failed(row.key, "claude was not found on your PATH");
    flushSync();
    await answering;
    expect(last().error).toContain("claude was not found");
  });

  it("takes the place of a row that ended", async () => {
    await startInTree();
    const dead = create(A, "sid-1", "claude-code", tree);
    started(dead.key, "pty-4", "sid-1");
    ended({ id: "pty-4", code: 0, clean: true });
    expect(sessions.all).toHaveLength(1);
    const row = await resumed(
      call("start", { session: "sid-1" }, { session: "caller-1" }),
      "pty-5",
    );
    expect(sessions.all).toHaveLength(1);
    expect(row.key).not.toBe(dead.key);
    expect(row.status).toBe("running");
  });

  it("refuses a session the caller did not start", async () => {
    await startInTree();
    await handle(call("start", { session: "sid-1" }, { session: "caller-2" }));
    expect(last().error).toContain("not one you started");
    expect(sessions.all).toHaveLength(0);
  });

  it("refuses a session that is running", async () => {
    await startInTree();
    await resumed(
      call("start", { session: "sid-1" }, { session: "caller-1" }),
      "pty-5",
    );
    await handle(call("start", { session: "sid-1" }, { session: "caller-1" }));
    expect(last().error).toContain("running already");
    expect(sessions.all).toHaveLength(1);
  });

  it("refuses when the worktree is gone", async () => {
    await startInTree();
    standing = {};
    await handle(call("start", { session: "sid-1" }, { session: "caller-1" }));
    expect(last().error).toContain(`worktree ${tree}, which is gone`);
    expect(sessions.all).toHaveLength(0);
  });

  it("refuses when the project is not open", async () => {
    await startInTree();
    workspace.open.splice(0, workspace.open.length, repo(B));
    await handle(call("start", { session: "sid-1" }, { session: "caller-1" }));
    expect(last().error).toContain(`ran in ${A}, which is not open`);
  });

  it("counts against the cap like a start", async () => {
    await startInTree();
    for (let n = 0; n < CAP; n += 1)
      own(B, `pty-${n + 10}`, `busy-${n}`, "caller-1");
    await handle(call("start", { session: "sid-1" }, { session: "caller-1" }));
    expect(last().error).toContain(`${CAP} sessions running already`);
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
