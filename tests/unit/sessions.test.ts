import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnOptions, Transcript, Workflow } from "$lib/core";
import { applyDetect, resetAgent } from "$lib/agent.svelte";
import { stash } from "$lib/exits";
import { resetZoom, zoom, zoomed } from "$lib/zoom.svelte";
import { attention, resetAttention } from "$lib/attention.svelte";
import { adoptAccounts, reset as resetAccounts } from "$lib/accounts.svelte";
import { register, resetScreens } from "$lib/screens";
import { bodyFor } from "$lib/notify.svelte";
import {
  activeSession,
  adoptPastSessions,
  aged,
  ago,
  historyFor,
  reopened,
  setPastSessions,
  historyLabel,
  loadHistory,
  loadHistories,
  loadMissingHistories,
  groupByHost,
  refreshHistory,
  isMine,
  isViewed,
  belled,
  drawsTurn,
  bulletWatch,
  onDirected,
  PENDING_FOR,
  exact,
  loadRemembered,
  output,
  QUIET_EXACT_MS,
  QUIET_MS,
  rang,
  noted,
  onWaiting,
  unreadCount,
  typed,
  drafting,
  keysStillIn,
  GRACE_MS,
  WORK_WINDOWS,
  viewed,
  WORK_BYTES,
  located,
  outsideFor,
  followCwd,
  sessionTitle,
  titled,
  renamed,
  byKey,
  byStatus,
  nextNeedingYou,
  waitingOnYou,
  close,
  closeProject,
  create,
  cycle,
  defaultAgent,
  ended,
  identified,
  failed,
  forProject,
  isLive,
  label,
  nameTaken,
  liveCount,
  reset,
  select,
  sessions,
  started,
  statusLabel,
  onForgotten,
  resumeWithout,
  statusMessage,
  disown,
  HISTORY_EVERY,
  followHistory,
  launch,
  workflowFor,
  byToken,
  runningByToken,
  wake,
  markUnread,
  markRead,
  onScreenNow,
} from "$lib/sessions.svelte";
import { adoptWorkflows, defaultWorkflow, reset as resetWorkflows } from "$lib/workflows.svelte";
import {
  byKey as shellByKey,
  create as createShell,
  reset as resetShells,
  started as shellStarted,
} from "$lib/terminals.svelte";
import { orchestratorPrompt } from "$lib/workflowInstructions";

const A = "/home/ada/dev/one";
const B = "/home/ada/dev/two";

const killed: string[] = [];
const tabsClosed: unknown[] = [];
let historyReads = 0;
/** The projects each batched reading was asked for. */
const manyCalls: string[][] = [];
let historyAnswer: Transcript[] = [];
/** What each account's directory holds, by directory. */
let historyByDir: Record<string, Transcript[]> = {};
/** Requests for a host's projects wait for the promise held here. */
let holds: Record<string, Promise<void>> = {};
function hold(host: string): () => void {
  let release = () => {};
  holds[host] = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}
const LAB = "ssh://ada@lab/srv/one";
let cwdAnswer: string | null = null;
let cwdAsks = 0;
/** The name the user gave a Claude Code session, by its id, as the core
    reads it from the transcript. */
let givenNames: Record<string, string> = {};
/** The agent whose history directory cannot be read, if any. */
let unreadable: string | null = null;
const spawned: SpawnOptions[] = [];
vi.mock("$lib/core", () => ({
  core: () => ({
    spawn: async (options: SpawnOptions) => {
      spawned.push(options);
      return { ptyId: `pty-${spawned.length}`, sessionId: options.session ?? `sid-${spawned.length}` };
    },
    kill: async (id: string) => {
      killed.push(id);
    },
    browserCloseOwner: async (owner: unknown) => {
      tabsClosed.push(owner);
      return { tabs: [], owner: null, active: null };
    },
    ptyCwd: async () => {
      cwdAsks += 1;
      return cwdAnswer;
    },
    sessionTitle: async (_agent: string, id: string) => givenNames[id] ?? null,
    // The repository of a path is its nearest worktree: the directory itself
    // here, or the parent for anything ending in "/inside".
    projectInfo: async (path: string) => {
      if (path === "/broken") throw new Error("gone");
      const repository = path.endsWith("/inside")
        ? path.slice(0, -"/inside".length)
        : path;
      return { path, name: path, repository, isGit: true };
    },
    // Every agent is asked, in the agents' own directory and in each
    // account's; the count follows one agent's own.
    transcripts: async (_project: string, agent: string, dir?: string) => {
      if (agent !== "claude-code") return [];
      if (dir !== undefined) return historyByDir[dir] ?? [];
      historyReads += 1;
      return historyAnswer;
    },
    // What is answered is what the directory held when the request was
    // made, whenever the answer arrives.
    transcriptsMany: async (projects: string[], agent: string, dir?: string) => {
      manyCalls.push(projects);
      if (agent === unreadable) throw new Error("could not read");
      const answer =
        agent !== "claude-code"
          ? []
          : dir !== undefined
            ? (historyByDir[dir] ?? [])
            : historyAnswer;
      if (agent === "claude-code" && dir === undefined) historyReads += 1;
      const hold = holds[projects[0]?.split("/")[2] ?? ""];
      if (hold !== undefined) await hold;
      return projects.map(() => answer);
    },
  }),
}));

beforeEach(() => {
  // A session follows no workflow here unless a test gives it one.
  resetWorkflows();
  spawned.length = 0;
  reset();
  resetShells();
  resetAttention();
  resetAccounts();
  resetZoom();
  killed.length = 0;
  tabsClosed.length = 0;
  historyReads = 0;
  manyCalls.length = 0;
  holds = {};
  historyAnswer = [];
  historyByDir = {};
  cwdAnswer = null;
  cwdAsks = 0;
  givenNames = {};
  resetAgent();
  applyDetect(
    {
      id: "claude-code",
      path: "/usr/local/bin/claude",
      caps: null,
      fromLoginShell: true,
    },
    true,
  );
});

/** A session that has actually come up, as one does in practice. */
function live(project: string, ptyId: string) {
  const session = create(project);
  started(session.key, ptyId, `session-${ptyId}`);
  return session;
}

describe("creating sessions", () => {
  it("starts as starting, and becomes the active one", () => {
    const session = create(A);
    expect(session.status).toBe("starting");
    expect(sessions.active).toBe(session.key);
    expect(activeSession()).toBe(session);
  });

  // The row exists before the process does, so a failure to start has
  // somewhere to be reported.
  it("has an identity before it has a pty", () => {
    const session = create(A);
    expect(session.ptyId).toBeNull();
    expect(byKey(session.key)).toBe(session);
  });

  it("gives every session a distinct key", () => {
    expect(create(A).key).not.toBe(create(A).key);
  });

  it("holds several sessions in the same project", () => {
    live(A, "pty-1");
    live(A, "pty-2");
    expect(forProject(A)).toHaveLength(2);
    expect(liveCount(A)).toBe(2);
  });

  it("keeps projects apart", () => {
    live(A, "pty-1");
    live(B, "pty-2");
    expect(forProject(A)).toHaveLength(1);
    expect(forProject(B)).toHaveLength(1);
  });

  // The workbench hands the agent its session id, so a fresh session knows
  // which transcript is its own from the moment it is up.
  it("learns its session id when it starts", () => {
    const session = create(A);
    expect(session.id).toBeNull();
    expect(started(session.key, "pty-1", "fresh-id")).toBe(true);
    expect(session.id).toBe("fresh-id");
  });

  it("keeps a size set before it started under the id it starts with", () => {
    const session = create(A);
    zoomed(session.key, null, 1);
    started(session.key, "pty-1", "id-fresh");
    expect(zoom.kept["id-fresh"]?.size).toBe(13);
  });

  it("knows its id from the start when resuming", () => {
    const session = create(A, "old-id");
    expect(session.id).toBe("old-id");
  });

  // The row can be closed while the process is still coming up. The caller
  // has to know, because nothing owns the pty it was just handed.
  it("reports a start for a row that is already gone", () => {
    const session = create(A);
    close(session.key);
    expect(started(session.key, "pty-1", "fresh-id")).toBe(false);
  });
});

describe("switching", () => {
  // The point of the whole model: looking at another session kills nothing.
  it("changes what is active without touching anything else", () => {
    const first = live(A, "pty-1");
    const second = live(A, "pty-2");

    select(first.key);
    expect(sessions.active).toBe(first.key);
    expect(second.status).toBe("running");
    expect(second.ptyId).toBe("pty-2");
    expect(killed).toEqual([]);
  });

  it("ignores a key that is not there", () => {
    const session = live(A, "pty-1");
    select("nope");
    expect(sessions.active).toBe(session.key);
  });

  it("steps through the project's sessions and wraps around", () => {
    const first = live(A, "pty-1");
    const second = live(A, "pty-2");
    live(B, "pty-3");
    select(first.key);
    expect(cycle(A, 1)).toBe(true);
    expect(sessions.active).toBe(second.key);
    expect(cycle(A, 1)).toBe(true);
    expect(sessions.active).toBe(first.key);
    expect(cycle(A, -1)).toBe(true);
    expect(sessions.active).toBe(second.key);
  });

  it("has nowhere to step with one session", () => {
    live(A, "pty-1");
    expect(cycle(A, 1)).toBe(false);
  });
});

describe("the exit policy", () => {
  it("treats code zero as a clean end", () => {
    const session = live(A, "pty-1");
    ended({ id: "pty-1", code: 0, clean: true });
    expect(session.status).toBe("exited");
    expect(session.ptyId).toBeNull();
  });

  it("treats anything else as a crash and names the code", () => {
    const session = live(A, "pty-1");
    ended({ id: "pty-1", code: 127, clean: false });
    expect(session.status).toBe("crashed");
    expect(statusMessage(session)).toContain("code 127");
  });

  it("reports a signal kill without inventing a code", () => {
    const session = live(A, "pty-1");
    ended({ id: "pty-1", code: null, clean: false });
    expect(statusMessage(session)).toBe("The session was stopped.");
  });

  // With several live at once, an exit has to land on the right row.
  it("ends only the session the event belongs to", () => {
    const first = live(A, "pty-1");
    const second = live(A, "pty-2");

    ended({ id: "pty-2", code: 1, clean: false });
    expect(second.status).toBe("crashed");
    expect(first.status).toBe("running");
  });

  it("ignores an exit for a session it does not know", () => {
    const session = live(A, "pty-1");
    expect(ended({ id: "pty-99", code: 1, clean: false })).toBe(false);
    expect(session.status).toBe("running");
  });

  it("claims an exit that belongs to one of its rows", () => {
    live(A, "pty-1");
    expect(ended({ id: "pty-1", code: 0, clean: true })).toBe(true);
  });

  // A process that dies at once can report its exit before the spawn call
  // has even returned. The page stashes what no row claims; the exit must not
  // be lost to the order of arrival.
  it("applies an exit that arrived before the start", () => {
    const session = create(A);
    expect(ended({ id: "pty-1", code: 127, clean: false })).toBe(false);
    stash({ id: "pty-1", code: 127, clean: false });
    expect(session.status).toBe("starting");

    started(session.key, "pty-1", "fresh-id");
    expect(session.status).toBe("crashed");
    expect(session.exitCode).toBe(127);
    expect(session.ptyId).toBeNull();
  });

  // The transcript is complete once the process is gone, so the history it
  // belongs in has moved.
  it("re-reads the project history when a session ends", () => {
    live(A, "pty-1");
    expect(historyReads).toBe(0);
    ended({ id: "pty-1", code: 0, clean: true });
    expect(historyReads).toBe(1);
  });

  it("records a failure to start", () => {
    const session = create(A);
    failed(session.key, "no pty available");
    expect(session.status).toBe("failed");
    expect(statusMessage(session)).toBe("no pty available");
  });
});

describe("closing", () => {
  it("stops a live session and removes its row", () => {
    const session = live(A, "pty-1");
    close(session.key);
    expect(killed).toEqual(["pty-1"]);
    expect(sessions.all).toHaveLength(0);
  });

  it("closes the browser tabs the session owned", () => {
    const session = live(A, "pty-1");
    close(session.key);
    expect(tabsClosed).toEqual([{ kind: "session", key: session.key }]);
  });

  it("closes the shells opened beside the session, and keeps those of a session that only stopped", async () => {
    const stopped = live(A, "pty-1");
    const keep = createShell({ project: A, session: stopped.key });
    shellStarted(keep.key, "pty-s1");
    ended({ id: "pty-1", code: 0, clean: true });
    const session = live(A, "pty-2");
    const shell = createShell({ project: A, session: session.key });
    shellStarted(shell.key, "pty-s2");
    const own = createShell({ project: A, session: null });
    close(session.key);
    await vi.waitFor(() => expect(killed).toContain("pty-s2"));
    expect(shellByKey(shell.key)).toBeNull();
    expect(shellByKey(keep.key)).not.toBeNull();
    expect(shellByKey(own.key)).not.toBeNull();
  });

  it("closes the tabs of every session when its project is closed, and keeps those of a session that only stopped", () => {
    const stopped = live(A, "pty-1");
    ended({ id: "pty-1", code: 0, clean: true });
    const other = live(A, "pty-2");
    expect(tabsClosed).toEqual([]);
    closeProject(A);
    expect(tabsClosed).toEqual([
      { kind: "session", key: stopped.key },
      { kind: "session", key: other.key },
    ]);
  });

  it("does not try to stop one that already ended", () => {
    const session = live(A, "pty-1");
    ended({ id: "pty-1", code: 0, clean: true });
    close(session.key);
    expect(killed).toEqual([]);
  });

  // Closing one should not throw you into a different project's work.
  it("falls back to a sibling in the same project", () => {
    const first = live(A, "pty-1");
    const second = live(A, "pty-2");
    live(B, "pty-3");

    select(second.key);
    close(second.key);
    expect(sessions.active).toBe(first.key);
  });

  it("falls back to another project only when there is no sibling", () => {
    const only = live(A, "pty-1");
    const other = live(B, "pty-2");
    select(only.key);
    close(only.key);
    expect(sessions.active).toBe(other.key);
  });

  it("leaves nothing active when the last one goes", () => {
    close(live(A, "pty-1").key);
    expect(sessions.active).toBeNull();
  });

  it("leaves the active session alone when closing another", () => {
    const first = live(A, "pty-1");
    const second = live(A, "pty-2");
    select(second.key);
    close(first.key);
    expect(sessions.active).toBe(second.key);
  });

  it("closes a whole project's sessions and leaves the rest", () => {
    live(A, "pty-1");
    live(A, "pty-2");
    live(B, "pty-3");

    closeProject(A);
    expect(forProject(A)).toHaveLength(0);
    expect(forProject(B)).toHaveLength(1);
    expect(killed).toEqual(["pty-1", "pty-2"]);
  });

  it("re-reads the project history when a row with a transcript goes", () => {
    const session = live(A, "pty-1");
    close(session.key);
    expect(historyReads).toBe(1);
  });

  it("does not bother for a row that never started", () => {
    const session = create(A);
    close(session.key);
    expect(historyReads).toBe(0);
  });
});

describe("labels", () => {
  it("numbers sessions within their project", () => {
    const first = create(A);
    const second = create(A);
    expect(label(first)).toBe("session 1");
    expect(label(second)).toBe("session 2");
  });

  // Closing session 1 must not turn session 2 into session 1: a label that
  // shifts under you is worse than a gap.
  it("keeps a number once given", () => {
    const first = create(A);
    const second = create(A);
    close(first.key);
    expect(label(second)).toBe("session 2");
    expect(label(create(A))).toBe("session 3");
  });

  it("numbers each project on its own", () => {
    create(A);
    expect(label(create(B))).toBe("session 1");
  });

  it("names a resumed session by its transcript id", () => {
    const session = create(A, "9604da0e-c207-4138-974b-8e1ef8cffd07");
    expect(label(session)).toBe("9604da0e");
  });

  it("reports liveness for the dot in the tree", () => {
    const session = live(A, "pty-1");
    expect(isLive(session)).toBe(true);
    ended({ id: "pty-1", code: 0, clean: true });
    expect(isLive(session)).toBe(false);
  });

  it("names every state the header can be in", () => {
    expect(statusLabel(null)).toBe("no session");

    const session = create(A);
    expect(statusLabel(session)).toBe("starting");
    started(session.key, "pty-1", "session-1");
    expect(statusLabel(session)).toBe("running");
    ended({ id: "pty-1", code: 0, clean: true });
    expect(statusLabel(session)).toBe("ended");

    const other = live(A, "pty-2");
    ended({ id: "pty-2", code: 1, clean: false });
    expect(statusLabel(other)).toBe("stopped");

    // An integrated session's events say when it is at rest.
    const integrated = create(A, null, "claude-code", null, null, null, undefined, undefined, "integrated");
    integrated.status = "running";
    expect(statusLabel(integrated)).toBe("idle");
    integrated.working = true;
    expect(statusLabel(integrated)).toBe("working");
  });
});

describe("closing does not double-kill", () => {
  // The row's terminal unmounts when the row goes, and its teardown kills
  // whatever pty the session still names. Closing has to leave it nothing.
  it("clears the pty id at the point of the kill", () => {
    const session = live(A, "pty-1");
    const key = session.key;
    close(key);
    expect(killed).toEqual(["pty-1"]);
    expect(byKey(key)).toBeNull();
  });

  it("kills each of a project's sessions exactly once", () => {
    live(A, "pty-1");
    live(A, "pty-2");
    closeProject(A);
    expect(killed).toEqual(["pty-1", "pty-2"]);
  });
});

describe("history", () => {
  const transcript = (id: string, title: string | null, modified: number) => ({
    id,
    title,
    modified,
    size: 100,
    agent: "claude-code" as const,
    account: null,
  });

  it("lists what the core reported for the project, once it is ours", () => {
    sessions.history[A] = [transcript("abc", "rename the cache", 1000)];
    expect(historyFor(A)).toHaveLength(0);
    expect(outsideFor(A)).toHaveLength(1);

    const session = create(A);
    started(session.key, "pty-1", "abc");
    close(session.key);
    expect(historyFor(A)).toHaveLength(1);
    expect(outsideFor(A)).toHaveLength(0);
  });

  // A session resumed inside a worktree is reported from there as well as
  // from the project. One entry, the newer, or a list keyed by id breaks.
  it("lists a session reported twice once, as the newer copy", async () => {
    historyAnswer = [
      { id: "same", title: "older copy", modified: 1000, size: 100, cwd: null },
      {
        id: "same",
        title: "newer copy",
        modified: 2000,
        size: 100,
        cwd: "/p/.claude/worktrees/w",
      },
      { id: "other", title: "other", modified: 500, size: 100, cwd: null },
    ];
    await loadHistory(A);
    expect(outsideFor(A).map((t) => [t.id, t.title])).toEqual([
      ["same", "newer copy"],
      ["other", "other"],
    ]);
  });

  // A session run under another account is kept in that account's
  // directory. It is listed under its project all the same, tagged with
  // the account, and a row resumed from it runs under that account.
  it("lists the sessions of every account, each under its own", async () => {
    adoptAccounts({
      list: { Work: { claude: "~/.claude-work", codex: null } },
      everywhere: null,
      overrides: {},
    });
    historyAnswer = [{ id: "own", title: "own", modified: 1000, size: 1, cwd: null }];
    historyByDir["~/.claude-work"] = [
      { id: "work", title: "work", modified: 2000, size: 1, cwd: null },
    ];
    await loadHistory(A);
    expect(outsideFor(A).map((t) => [t.id, t.account])).toEqual([
      ["work", "Work"],
      ["own", null],
    ]);

    const [work] = outsideFor(A);
    const session = create(A, work.id, work.agent, null, null, null, work.account);
    expect(session.account).toBe("Work");
  });

  // Claude Code run in a terminal in the same directory leaves transcripts in
  // the same place. They are not this window's work until it takes one up.
  it("keeps sessions from outside apart, and adopts one when resumed", () => {
    sessions.history[A] = [transcript("theirs", "from a terminal", 1000)];
    expect(isMine(A, "theirs")).toBe(false);

    const session = create(A, "theirs");
    started(session.key, "pty-1", "theirs");
    expect(isMine(A, "theirs")).toBe(true);
    close(session.key);
    expect(historyFor(A).map((t) => t.id)).toEqual(["theirs"]);
    expect(outsideFor(A)).toEqual([]);
  });

  it("reads every project's history from a directory in one request", async () => {
    await loadHistories([A, B]);
    // One request per agent's directory, each for both projects.
    expect(manyCalls.length).toBeGreaterThan(0);
    expect(manyCalls.every((projects) => projects.join() === [A, B].join())).toBe(true);
    expect(sessions.history[A]).toBeDefined();
    expect(sessions.history[B]).toBeDefined();
  });

  it("splits the projects by the machine they are on", () => {
    const groups = groupByHost([A, LAB, B, "ssh://ada@lab/srv/two", "ssh://ada@box/x"]);
    expect([...groups]).toEqual([
      [null, [A, B]],
      ["ada@lab", [LAB, "ssh://ada@lab/srv/two"]],
      ["ada@box", ["ssh://ada@box/x"]],
    ]);
    expect(groupByHost([]).size).toBe(0);
  });

  it("never asks for a project here and one elsewhere in the same request", async () => {
    await loadHistories([A, LAB, B]);
    expect(manyCalls.some((projects) => projects.join() === [A, B].join())).toBe(true);
    expect(manyCalls.some((projects) => projects.join() === LAB)).toBe(true);
    expect(manyCalls.every((projects) => projects.join() === LAB || !projects.includes(LAB))).toBe(true);
  });

  it("puts a machine's answer in when it arrives, whatever the others are doing", async () => {
    const release = hold("ada@lab");
    const pending = loadHistories([A, LAB]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions.history[A]).toBeDefined();
    expect(sessions.history[LAB]).toBeUndefined();
    release();
    await pending;
    expect(sessions.history[LAB]).toBeDefined();
  });

  it("reads again the projects it is told to watch, in one request each per machine", async () => {
    const stop = followHistory(() => [A, B]);
    sessions.history[B] = [];
    sessions.history["/closed"] = [];
    await refreshHistory();
    expect(manyCalls.length).toBeGreaterThan(0);
    expect(manyCalls.every((projects) => projects.join() === [A, B].join())).toBe(true);
    stop();
  });

  it("does not let a host that does not answer hold up the refresh of the others", async () => {
    const stop = followHistory(() => [A, LAB]);
    const release = hold("ada@lab");
    const stalled = refreshHistory();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions.history[A]).toBeDefined();
    // A later refresh reads the local projects again while the host is
    // still being waited for.
    manyCalls.length = 0;
    const second = refreshHistory();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manyCalls.some((projects) => projects.join() === A)).toBe(true);
    expect(manyCalls.some((projects) => projects.join() === LAB)).toBe(false);
    release();
    await Promise.all([stalled, second]);
    stop();
  });

  it("leaves a history that has not changed as the same list", async () => {
    historyAnswer = [{ id: "own", title: "own", modified: 1000, size: 1 }];
    const stop = followHistory(() => [A]);
    await loadHistory(A);
    const first = sessions.history[A];
    await refreshHistory();
    expect(sessions.history[A]).toBe(first);
    historyAnswer = [{ id: "own", title: "renamed", modified: 1001, size: 2 }];
    await refreshHistory();
    expect(sessions.history[A]).not.toBe(first);
    expect(sessions.history[A][0].title).toBe("renamed");
    stop();
  });

  it("serves a refresh asked for while one is under way with that one", async () => {
    const stop = followHistory(() => [A]);
    await loadHistory(A);
    manyCalls.length = 0;
    const first = refreshHistory();
    const second = refreshHistory();
    await Promise.all([first, second]);
    const asked = manyCalls.length;
    await refreshHistory();
    expect(manyCalls.length).toBeGreaterThan(asked);
    // Both the first two were served by one reading.
    expect(asked).toBe(manyCalls.length - asked);
    stop();
  });

  it("leaves no clock running once reset, or once followed again", () => {
    vi.useFakeTimers();
    try {
      followHistory(() => [A]);
      followHistory(() => [B]);
      expect(vi.getTimerCount()).toBe(1);
      reset();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads only the histories not read or being read", async () => {
    await loadHistory(A);
    manyCalls.length = 0;
    const pending = loadMissingHistories([A, B]);
    await loadMissingHistories([A, B]);
    await pending;
    expect(manyCalls.length).toBeGreaterThan(0);
    expect(manyCalls.every((projects) => projects.join() === B)).toBe(true);
    expect(sessions.history[B]).toBeDefined();
  });

  it("reads a project again when an account arrives, and lists that account's sessions", async () => {
    historyAnswer = [{ id: "own", title: "own", modified: 1000, size: 1 }];
    await loadMissingHistories([A]);
    expect(sessions.history[A].map((t) => t.id)).toEqual(["own"]);
    historyByDir["~/.claude-work"] = [
      { id: "work", title: "work", modified: 2000, size: 1 },
    ];
    adoptAccounts({
      list: { Work: { claude: "~/.claude-work", codex: null } },
      everywhere: null,
      overrides: {},
    });
    await loadMissingHistories([A]);
    expect(sessions.history[A].map((t) => [t.id, t.account])).toEqual([
      ["work", "Work"],
      ["own", null],
    ]);
  });

  it("lists a session id held by two accounts once, as the newest copy", async () => {
    adoptAccounts({
      list: {
        Work: { claude: "~/.claude-work", codex: null },
        Play: { claude: "~/.claude-play", codex: null },
      },
      everywhere: null,
      overrides: {},
    });
    historyAnswer = [{ id: "same", title: "default", modified: 1000, size: 1 }];
    historyByDir["~/.claude-work"] = [
      { id: "same", title: "work", modified: 3000, size: 1 },
    ];
    historyByDir["~/.claude-play"] = [
      { id: "same", title: "play", modified: 2000, size: 1 },
    ];
    await loadHistory(A);
    expect(sessions.history[A].map((t) => [t.id, t.title, t.account])).toEqual([
      ["same", "work", "Work"],
    ]);
  });

  // A reading that began earlier and lands later must not undo a newer one.
  it("does not let an older answer overwrite a newer one", async () => {
    const stop = followHistory(() => [LAB]);
    historyAnswer = [{ id: "s", title: "before", modified: 1000, size: 1 }];
    const release = hold("ada@lab");
    const slow = loadHistory(LAB);
    await new Promise((resolve) => setTimeout(resolve, 0));
    historyAnswer = [{ id: "s", title: "after", modified: 2000, size: 2 }];
    delete holds["ada@lab"];
    await loadHistory(LAB);
    expect(sessions.history[LAB][0].title).toBe("after");
    release();
    await slow;
    expect(sessions.history[LAB][0].title).toBe("after");
    stop();
  });

  it("does not let a read from before an account was removed land after one from after", async () => {
    adoptAccounts({
      list: { Work: { claude: "~/.claude-work", codex: null } },
      everywhere: null,
      overrides: {},
    });
    historyByDir["~/.claude-work"] = [
      { id: "work", title: "work", modified: 2000, size: 1 },
    ];
    const release = hold("ada@lab");
    const slow = loadMissingHistories([LAB]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    resetAccounts();
    delete holds["ada@lab"];
    await loadMissingHistories([LAB]);
    expect(sessions.history[LAB].map((t) => t.id)).toEqual([]);
    release();
    await slow;
    expect(sessions.history[LAB].map((t) => t.id)).toEqual([]);
  });

  // What ran outside the app shows up without a restart: the histories
  // are read again on a clock while the window is looked at.
  it("reads the histories again on a clock, while looked at", async () => {
    vi.useFakeTimers();
    try {
      await loadHistory(A);
      const before = historyReads;
      const stop = followHistory(() => [A]);
      attention.focused = true;
      await vi.advanceTimersByTimeAsync(HISTORY_EVERY);
      expect(historyReads).toBe(before + 1);
      // A window nobody is looking at is left alone.
      attention.focused = false;
      await vi.advanceTimersByTimeAsync(HISTORY_EVERY);
      expect(historyReads).toBe(before + 1);
      stop();
      attention.focused = true;
      await vi.advanceTimersByTimeAsync(HISTORY_EVERY);
      expect(historyReads).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("remembers which sessions are ours across a restart", () => {
    const session = create(A);
    started(session.key, "pty-1", "kept");
    reset();
    expect(isMine(A, "kept")).toBe(false);
    loadRemembered();
    expect(isMine(A, "kept")).toBe(true);
  });

  it("survives a corrupt record of what is ours", () => {
    localStorage.setItem("chord.mine", "{not json");
    expect(() => loadRemembered()).not.toThrow();
    localStorage.setItem("chord.mine", JSON.stringify({ [A]: ["ok", 7] }));
    loadRemembered();
    expect(isMine(A, "ok")).toBe(true);
  });

  it("has nothing for a project it has not read", () => {
    expect(historyFor("/unread")).toEqual([]);
  });

  // A transcript already open as a live session is that session, not a
  // separate row offering to open it again.
  it("hides a transcript that is already resumed", () => {
    sessions.history[A] = [
      transcript("abc", "one", 1000),
      transcript("def", "two", 900),
    ];
    create(A, "abc");
    expect(outsideFor(A).map((t) => t.id)).toEqual(["def"]);
  });

  // A fresh session writes a transcript as it goes. That transcript is the
  // live row, not a past session offering to open itself again.
  it("hides the transcript a live session is writing", () => {
    sessions.history[A] = [
      transcript("fresh", "one", 1000),
      transcript("def", "two", 900),
    ];
    const session = create(A);
    started(session.key, "pty-1", "fresh");
    expect(historyFor(A)).toEqual([]);
    expect(outsideFor(A).map((t) => t.id)).toEqual(["def"]);
  });

  it("uses the title when there is one", () => {
    expect(historyLabel(transcript("abc", "rename the cache", 1000))).toBe(
      "rename the cache",
    );
  });

  // The format is documented as internal and version-unstable, so a title that
  // could not be read falls back rather than showing an error.
  it("falls back to recency when the title could not be read", () => {
    const now = Date.now();
    const label = historyLabel(
      transcript("abc", null, Math.floor(now / 1000) - 7200),
    );
    expect(label).toContain("session from");
    expect(label).toContain("2h ago");
  });

  it("treats an empty title as no title", () => {
    expect(historyLabel(transcript("abc", "", 1000))).toContain("session from");
  });
});

describe("ago", () => {
  const now = 1_000_000_000_000;
  const at = (secondsAgo: number) =>
    ago(Math.floor(now / 1000) - secondsAgo, now);

  it("is coarse on purpose: the pane wants recency, not a timestamp", () => {
    expect(at(5)).toBe("just now");
    expect(at(120)).toBe("2m ago");
    expect(at(7200)).toBe("2h ago");
    expect(at(172_800)).toBe("2d ago");
  });

  it("never reads as the future when a clock disagrees", () => {
    expect(ago(Math.floor(now / 1000) + 500, now)).toBe("just now");
  });
});

describe("an agent that mints its own id", () => {
  it("has no id until the core says, then owns it and its name", () => {
    const session = create(A, null, "codex");
    expect(started(session.key, "pty-1", null)).toBe(true);
    expect(session.id).toBeNull();
    expect(isMine(A, "cx-1")).toBe(false);

    identified("pty-1", "cx-1", "Refactor billing");
    expect(session.id).toBe("cx-1");
    expect(isMine(A, "cx-1")).toBe(true);
    expect(label(session)).toBe("Refactor billing");
    expect(sessions.names["cx-1"]).toBe("Refactor billing");
  });

  it("keeps a size set before the id was minted under the minted id", () => {
    const session = create(A, null, "codex");
    started(session.key, "pty-1", null);
    zoomed(session.key, null, 1);
    identified("pty-1", "minted", null);
    expect(zoom.kept["minted"]?.size).toBe(13);
  });

  it("ignores an identification for a pty it does not have", () => {
    expect(() => identified("pty-9", "cx", null)).not.toThrow();
  });

  it("starts with the agent last started in the project", () => {
    applyDetect(
      {
        id: "codex",
        path: "/usr/local/bin/codex",
        caps: null,
        fromLoginShell: true,
      },
      true,
    );
    expect(defaultAgent(A)).toBe("claude-code");
    create(A, null, "codex");
    expect(defaultAgent(A)).toBe("codex");
    expect(defaultAgent(B)).toBe("claude-code");
    reset();
    expect(defaultAgent(A)).toBe("claude-code");
    loadRemembered();
    expect(defaultAgent(A)).toBe("codex");
  });

  it("falls back to an installed agent when the preferred one is gone", () => {
    create(A, null, "codex");
    expect(defaultAgent(A)).toBe("claude-code");
  });
});

describe("the token a session's tools name it by", () => {
  beforeEach(() => {
    localStorage.removeItem("chord.tokens");
  });

  const codexToo = () =>
    applyDetect({ id: "codex", path: "/usr/local/bin/codex", caps: null, fromLoginShell: true }, true);

  it("is the window's own, given to the agent as it starts, and is not the agent's id", async () => {
    const session = create(A);
    const token = session.token;
    expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await launch(session.key, 80, 24, () => {});
    expect(spawned.at(-1)?.token).toBe(token);
    expect(session.id).toBe("sid-1");
    expect(session.token).toBe(token);
    // Two sessions in one folder are two tokens.
    expect(create(A).token).not.toBe(token);
  });

  it("names a Codex session from the start, and is kept by its id once that is known", async () => {
    codexToo();
    const session = create(A, null, "codex");
    const token = session.token;
    expect(started(session.key, "pty-1", null)).toBe(true);
    expect(session.id).toBeNull();
    expect(byToken(token)?.key).toBe(session.key);
    identified("pty-1", "cx-1", null);
    expect(session.token).toBe(token);
    expect(sessions.tokens["cx-1"]).toEqual({ token, project: A });
  });

  it("is the same for the session resumed, after a restart too", async () => {
    codexToo();
    const session = create(A, null, "codex");
    started(session.key, "pty-1", null);
    identified("pty-1", "cx-1", null);
    const token = session.token;
    close(session.key);
    reset();
    loadRemembered();
    const back = create(A, "cx-1", "codex");
    expect(back.token).toBe(token);
    await launch(back.key, 80, 24, () => {});
    expect(spawned.at(-1)).toMatchObject({ session: "cx-1", token });
  });

  it("is a new one for a session from before there were tokens, kept by its id at once", async () => {
    const back = create(A, "old-1");
    expect(back.token).not.toBe("old-1");
    expect(sessions.tokens["old-1"]).toEqual({ token: back.token, project: A });
    expect(JSON.parse(localStorage.getItem("chord.tokens")!)["old-1"].token).toBe(back.token);
    await launch(back.key, 80, 24, () => {});
    expect(spawned.at(-1)).toMatchObject({ session: "old-1", token: back.token });
    expect(sessions.tokens["old-1"]?.token).toBe(back.token);
    // Resumed again, after a restart too, it has the same one.
    close(back.key);
    reset();
    loadRemembered();
    expect(create(A, "old-1").token).toBe(back.token);
  });

  it("is never an agent's id, even one kept as a token by mistake", () => {
    localStorage.setItem("chord.tokens", JSON.stringify({ "old-2": { token: "old-2", project: A } }));
    loadRemembered();
    const back = create(A, "old-2");
    expect(back.token).not.toBe("old-2");
    expect(sessions.tokens["old-2"]?.token).toBe(back.token);
    expect(byToken("old-2")).toBeNull();
  });

  it("is kept for a run taken up after a reload until it stops, and the next start has a new one", () => {
    // The core still runs the session, started with its id as its token by
    // the version before.
    const row = reopened(A, "old-3", "claude-code", null, null, null, "integrated", null, true, "old-3");
    row.status = "running";
    expect(row.token).toBe("old-3");
    expect(runningByToken("old-3")?.key).toBe(row.key);
    // The id is never kept as a token.
    expect(sessions.tokens["old-3"]).toBeUndefined();
    row.status = "exited";
    expect(runningByToken("old-3")).toBeNull();
    // Woken, or started again in place, it is given a token of its own.
    row.status = "dormant";
    wake(row.key);
    expect(row.token).not.toBe("old-3");
    expect(sessions.tokens["old-3"]?.token).toBe(row.token);
    expect(byToken("old-3")).toBeNull();
  });

  it("is kept for neither of two live sessions found to have one id, and the session resumed by it is neither", () => {
    codexToo();
    const one = create(A, null, "codex");
    started(one.key, "pty-1", null);
    const two = create(A, null, "codex");
    started(two.key, "pty-2", null);
    // Both started in one folder close together, and both were found to
    // be the newest thread there.
    identified("pty-1", "cx-same", null);
    expect(sessions.tokens["cx-same"]?.token).toBe(one.token);
    identified("pty-2", "cx-same", null);
    const kept = sessions.tokens["cx-same"]?.token;
    expect(kept).not.toBe(one.token);
    expect(kept).not.toBe(two.token);
    close(one.key);
    close(two.key);
    const back = create(A, "cx-same", "codex");
    expect(back.token).toBe(kept);
    expect([one.token, two.token]).not.toContain(back.token);
  });

  it("is never one that a live row holds already", () => {
    const first = create(A, "sid-9");
    started(first.key, "pty-1", "sid-9");
    const second = create(A, "sid-9");
    expect(second.token).not.toBe(first.token);
    // A row that has stopped gives its token up to the one resumed.
    ended({ id: "pty-1", code: 0, clean: true });
    const third = create(A, "sid-9");
    expect(third.token).toBe(first.token);
    expect(byToken(first.token)?.key).toBe(third.key);
  });
});

describe("titles", () => {
  it.each([
    ["✳ fix-activity-tracking-bugs", "fix-activity-tracking-bugs"],
    [
      "✻ fix-activity-tracking-bugs · Claude Code",
      "fix-activity-tracking-bugs",
    ],
    ["fix-activity-tracking-bugs - Claude Code", "fix-activity-tracking-bugs"],
    ["Retry delay \u2013 Claude Code", "Retry delay"],
    ["Retry delay \u2014 Claude Code", "Retry delay"],
    ["Claude Code · rename the cache", "rename the cache"],
    ["  rename the cache  ", "rename the cache"],
  ])("reads the session's name out of %j", (raw, expected) => {
    expect(sessionTitle(raw)).toBe(expected);
  });

  // The agent names itself before it names the session. That is not a title.
  it.each(["Claude Code", "✳ Claude Code", "claude", "", "✳ "])(
    "takes %j as no title",
    (raw) => {
      expect(sessionTitle(raw)).toBeNull();
    },
  );

  it("labels the row with the title once the agent sets one", () => {
    const session = live(A, "pty-1");
    expect(label(session)).toBe("session 1");
    titled(session.key, "✳ fix-activity-tracking-bugs");
    expect(label(session)).toBe("fix-activity-tracking-bugs");
    titled(session.key, "Claude Code");
    expect(label(session)).toBe("session 1");
  });

  it("keeps a name the user gave over the agent's later titles", () => {
    const session = live(A, "pty-1");
    titled(session.key, "✳ fix-activity-tracking-bugs");
    renamed(session.key, "Shared ARM64 host");
    expect(label(session)).toBe("Shared ARM64 host");
    titled(session.key, "✳ an-automatic-title");
    expect(label(session)).toBe("Shared ARM64 host");
    // A name that reads as the user's own is not taken.
    renamed(session.key, "You");
    expect(label(session)).toBe("Shared ARM64 host");
  });

  it("prefers the title over the resumed id", () => {
    const session = create(A, "0520dd94-aaaa");
    titled(session.key, "earlier work");
    expect(label(session)).toBe("earlier work");
  });

  // The name is what you knew the session by. It outlives the process, so a
  // past session is listed under it, and a resumed one starts out with it.
  it("keeps the name for the past-session list and for resuming", () => {
    const session = live(A, "pty-1");
    titled(session.key, "✳ fix-activity-tracking-bugs");
    close(session.key);
    sessions.history[A] = [
      {
        id: "session-pty-1",
        title: "a summary",
        modified: 1000,
        size: 1,
        agent: "claude-code",
        account: null,
      },
    ];
    expect(historyLabel(sessions.history[A][0])).toBe(
      "fix-activity-tracking-bugs",
    );

    const again = create(A, "session-pty-1");
    expect(label(again)).toBe("fix-activity-tracking-bugs");
  });

  it("remembers names across a restart", () => {
    const session = live(A, "pty-1");
    titled(session.key, "kept name");
    reset();
    expect(sessions.names).toEqual({});
    loadRemembered();
    expect(sessions.names["session-pty-1"]).toBe("kept name");
  });

  it("keeps the user's name over automatic titles after a resume", () => {
    const session = live(A, "pty-1");
    renamed(session.key, "My name");
    close(session.key);
    reset();
    loadRemembered();
    const again = create(A, "session-pty-1");
    expect(label(again)).toBe("My name");
    titled(again.key, "✳ an-automatic-title");
    expect(label(again)).toBe("My name");
  });

  it("does not remember the agent's own name as a session's", () => {
    const session = live(A, "pty-1");
    titled(session.key, "Claude Code");
    expect(sessions.names).toEqual({});
  });
});

describe("where the session works", () => {
  // The pane follows a session into its worktree before the process has said
  // anything, and a session whose process has ended never says anything.
  it("belongs to the worktree it was started in from the start", async () => {
    const tree = `${A}/.claude/worktrees/feature`;
    const session = create(A, null, "claude-code", tree);
    await vi.waitFor(() => expect(session.worktree).toBe(tree));
  });

  it("has no worktree when it was started in the project itself", async () => {
    const session = create(A);
    await Promise.resolve();
    expect(session.worktree).toBeNull();
  });

  // The running session's own cwd is the more current answer.
  it("does not undo what the session's cwd already said", async () => {
    const tree = `${A}/.claude/worktrees/feature`;
    const session = create(A, null, "claude-code", tree);
    session.worktree = "marker";
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.worktree).toBe("marker");
  });

  it("resolves a new directory to its repository", async () => {
    const session = live(A, "pty-1");
    await located(session.key, `${A}/.claude/worktrees/feature/inside`);
    expect(session.cwd).toBe(`${A}/.claude/worktrees/feature/inside`);
    expect(session.worktree).toBe(`${A}/.claude/worktrees/feature`);
  });

  it("ignores an answer it already has, and no answer at all", async () => {
    const session = live(A, "pty-1");
    await located(session.key, A);
    session.worktree = "marker";
    await located(session.key, A);
    expect(session.worktree).toBe("marker");
    await located(session.key, null);
    expect(session.cwd).toBe(A);
  });

  it("has no worktree for a directory the core cannot describe", async () => {
    const session = live(A, "pty-1");
    await located(session.key, "/broken");
    expect(session.worktree).toBeNull();
  });

  it("names a terminal session as the user renamed it in its terminal", async () => {
    vi.useFakeTimers();
    try {
      const stop = followCwd();
      const session = live(A, "pty-1");
      titled(session.key, "✳ fix-activity-tracking-bugs");
      await vi.advanceTimersByTimeAsync(2100);
      expect(label(session)).toBe("fix-activity-tracking-bugs");
      givenNames[session.id!] = "Shared ARM64 host";
      await vi.advanceTimersByTimeAsync(2100);
      expect(label(session)).toBe("Shared ARM64 host");
      titled(session.key, "✳ an-automatic-title");
      expect(label(session)).toBe("Shared ARM64 host");
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks the core for the active running session, and only that", async () => {
    vi.useFakeTimers();
    try {
      const stop = followCwd();
      await vi.advanceTimersByTimeAsync(2100);
      expect(cwdAsks).toBe(0);

      const session = live(A, "pty-1");
      cwdAnswer = `${A}/inside`;
      await vi.advanceTimersByTimeAsync(2100);
      expect(cwdAsks).toBe(1);
      expect(session.worktree).toBe(A);

      ended({ id: "pty-1", code: 0, clean: true });
      await vi.advanceTimersByTimeAsync(2100);
      expect(cwdAsks).toBe(1);

      stop();
      live(A, "pty-2");
      await vi.advanceTimersByTimeAsync(2100);
      expect(cwdAsks).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("working, and waiting for you", () => {
  /** The user sent the agent a line: its output can be work from here. */
  const spokenTo = (session: ReturnType<typeof live>) =>
    typed(session.ptyId!, "hello\r");
  /** A second of more than a redraw, `windows` times running. */
  const streams = (session: ReturnType<typeof live>, windows: number) => {
    for (let i = 0; i < windows; i += 1) {
      if (i > 0) vi.advanceTimersByTime(1010);
      output(session.key, WORK_BYTES);
    }
  };

  it("uses Codex turn events despite idle redraws, Enter, and long silent work", () => {
    vi.useFakeTimers();
    try {
      const session = create(A, null, "codex");
      started(session.key, "codex-pty", null);
      typed("codex-pty", "\r");
      vi.advanceTimersByTime(GRACE_MS);
      streams(session, WORK_WINDOWS + 2);
      expect(session.working).toBe(false);

      exact("codex-id", "prompt");
      identified("codex-pty", "codex-id", null);
      expect(session.working).toBe(true);
      output(session.key, WORK_BYTES);
      vi.advanceTimersByTime(QUIET_EXACT_MS * 2);
      expect(session.working).toBe(true);

      exact("codex-id", "stop");
      streams(session, WORK_WINDOWS + 2);
      expect(session.working).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says how the last turn ended: done, cut short where the agent says so, and nothing while one runs", () => {
    const session = create(A, null, "codex");
    started(session.key, "codex-pty", "codex-id");
    expect(session.turnEnd).toBeNull();
    exact("codex-id", "prompt");
    expect(session.turnEnd).toBeNull();
    exact("codex-id", "stop");
    expect(session.turnEnd).toBe("done");
    exact("codex-id", "prompt");
    expect(session.turnEnd).toBeNull();
    // Cut short, and a hook that calls the same end a stop leaves it so,
    // until the next turn.
    exact("codex-id", "stop", null, true);
    exact("codex-id", "stop");
    expect(session.turnEnd).toBe("cut");
    expect(session.working).toBe(false);
    exact("codex-id", "prompt");
    exact("codex-id", "stop");
    expect(session.turnEnd).toBe("done");
  });

  it("knows when the user's keys may have left words on a terminal's line, and when they last pressed one", () => {
    vi.useFakeTimers();
    try {
      const session = create(A, null, "claude-code");
      started(session.key, "pty-keys", "keys-id");
      expect(drafting(session.key)).toBe(false);
      expect(keysStillIn(session.key, 5000)).toBe(0);
      typed("pty-keys", "fix the");
      expect(drafting(session.key)).toBe(true);
      expect(keysStillIn(session.key, 5000)).toBe(5000);
      vi.advanceTimersByTime(2000);
      expect(keysStillIn(session.key, 5000)).toBe(3000);
      // Enter alone is no sign the line went: the agent's prompt hook is.
      typed("pty-keys", "\r");
      expect(drafting(session.key)).toBe(true);
      exact("keys-id", "prompt");
      expect(drafting(session.key)).toBe(false);
      // A newline, by Ctrl+J, a backslash before Enter or Alt+Enter, is
      // still the line, and the prompt hook of a turn something else began
      // leaves it.
      for (const keys of [["more", "\n"], ["more", "\\", "\r"], ["more", "\x1b\r"]]) {
        for (const key of keys) typed("pty-keys", key);
        exact("keys-id", "prompt");
        expect(drafting(session.key)).toBe(true);
        typed("pty-keys", "\x03");
        expect(drafting(session.key)).toBe(false);
      }
      // Ctrl+U empties one line of several, and leaves the rest.
      typed("pty-keys", "a\nb\x15");
      expect(drafting(session.key)).toBe(true);
      // Ctrl+C empties the line; Backspace and the arrows may leave words;
      // what the terminal sends on its own, focus and the mouse, is no key
      // of the user's.
      typed("pty-keys", "\x03");
      expect(drafting(session.key)).toBe(false);
      typed("pty-keys", "\x1b[A");
      expect(drafting(session.key)).toBe(true);
      typed("pty-keys", "\x03");
      vi.advanceTimersByTime(10_000);
      typed("pty-keys", "\x1b[I");
      typed("pty-keys", "\x1b[<0;10;5M");
      expect(drafting(session.key)).toBe(false);
      expect(keysStillIn(session.key, 5000)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes none of the terminal's replies to the agent's queries for a key", () => {
    vi.useFakeTimers();
    try {
      const session = create(A, null, "codex");
      started(session.key, "pty-replies", "replies-id");
      vi.advanceTimersByTime(10_000);
      // Its attributes, status, cursor position, window size, keyboard
      // flags, a mode, a setting and a colour, alone and run together.
      for (const reply of [
        "\x1b[?1;2c",
        "\x1b[>0;276;0c",
        "\x1b[0n",
        "\x1b[24;80R",
        "\x1b[8;24;80t",
        "\x1b[?0u",
        "\x1b[?2004;1$y",
        "\x1bP1$r0m\x1b\\",
        "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\",
        "\x1b]10;rgb:ffff/ffff/ffff\x07",
        "\x1b[?1;2c\x1b[1;1R",
      ])
        typed("pty-replies", reply);
      expect(drafting(session.key)).toBe(false);
      expect(keysStillIn(session.key, 5000)).toBe(0);
      // A key that looks a little like one is still a key.
      typed("pty-replies", "\x1b[1;5A");
      expect(drafting(session.key)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the keys that answer a permission prompt for the prompt's, not the line's", () => {
    const session = create(A, null, "claude-code");
    started(session.key, "pty-asks", "asks-id");
    exact("asks-id", "prompt");
    exact("asks-id", "permission");
    typed("pty-asks", "2");
    typed("pty-asks", "\r");
    expect(drafting(session.key)).toBe(false);
    // The agent goes on, as its screen says, and a key after that is the
    // line's again.
    output(session.key, WORK_BYTES);
    expect(session.needs).toBeNull();
    typed("pty-asks", "and th");
    expect(drafting(session.key)).toBe(true);
  });

  it("keeps the latest transition received before identification", () => {
    const session = create(A, null, "codex");
    started(session.key, "codex-pty", null);
    exact("codex-id", "prompt");
    exact("codex-id", "stop");
    identified("codex-pty", "codex-id", null);
    expect(session.exact).toBe(true);
    expect(session.working).toBe(false);
  });

  it("replays events received before a resumed spawn returns and ignores ended sessions", () => {
    const session = create(A, "codex-id", "codex");
    exact("codex-id", "prompt");
    started(session.key, "codex-pty", "codex-id");
    expect(session.working).toBe(true);
    ended({ id: "codex-pty", code: 0, clean: true });
    exact("codex-id", "prompt");
    expect(session.working).toBe(false);
    const resumed = create(A, "codex-id", "codex");
    started(resumed.key, "codex-pty-2", "codex-id");
    exact("codex-id", "prompt");
    expect(resumed.working).toBe(true);
    expect(session.working).toBe(false);
  });

  it("is working once more than a redraw's worth flows for seconds running", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      spokenTo(session);
      streams(session, WORK_WINDOWS - 1);
      expect(session.working).toBe(false);
      vi.advanceTimersByTime(1010);
      output(session.key, WORK_BYTES - 1);
      expect(session.working).toBe(false);
      output(session.key, 1);
      expect(session.working).toBe(true);
      expect(statusLabel(session)).toBe("working");
    } finally {
      vi.useRealTimers();
    }
  });

  // A footer's clock ticking over, a status line changing: one burst each,
  // with a still screen between. Not work, and never unread.
  it("does not take a burst now and then for work", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      spokenTo(session);
      attention.focused = false;
      for (let i = 0; i < 5; i += 1) {
        output(session.key, WORK_BYTES * 8);
        vi.advanceTimersByTime(QUIET_MS + 500);
      }
      expect(session.working).toBe(false);
      expect(session.unread).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // An agent starting draws plenty, its spinner while it connects most of
  // all. None of it counts until it is spoken to, or a minute has passed.
  it("takes nothing for work while the agent starts, until spoken to", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      attention.focused = false;
      streams(session, WORK_WINDOWS + 2);
      expect(session.working).toBe(false);
      vi.advanceTimersByTime(QUIET_MS + 10);
      expect(session.unread).toBe(false);

      spokenTo(session);
      streams(session, WORK_WINDOWS);
      expect(session.working).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // A prompt on the command line is a line sent: the agent goes to work on
  // it at once, whether or not anybody ever looks at its terminal.
  it("takes output for work at once from a session started with a prompt", () => {
    vi.useFakeTimers();
    try {
      const session = create(A, null, "claude-code", null, "Fix the test");
      started(session.key, "pty-1", "session-pty-1");
      attention.focused = false;
      streams(session, WORK_WINDOWS);
      expect(session.working).toBe(true);
      vi.advanceTimersByTime(QUIET_MS + 10);
      expect(session.working).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes output for work a minute after the start without a word", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      vi.advanceTimersByTime(GRACE_MS);
      streams(session, WORK_WINDOWS);
      expect(session.working).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is waiting after a stretch of quiet, and seen if it was on screen", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      spokenTo(session);
      streams(session, WORK_WINDOWS);
      expect(session.working).toBe(true);
      vi.advanceTimersByTime(QUIET_MS + 10);
      expect(session.working).toBe(false);
      expect(session.unread).toBe(false);
      expect(statusLabel(session)).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  // The whole point: something finished while you were elsewhere.
  it("goes unread when it stops behind another session, until looked at", () => {
    vi.useFakeTimers();
    try {
      const other = live(A, "pty-1");
      const busy = live(A, "pty-2");
      spokenTo(busy);
      select(other.key);
      streams(busy, WORK_WINDOWS);
      vi.advanceTimersByTime(QUIET_MS + 10);
      expect(busy.unread).toBe(true);
      expect(statusLabel(busy)).toBe("waiting for you");
      expect(unreadCount()).toBe(1);

      viewed(busy.key);
      expect(busy.unread).toBe(false);
      expect(unreadCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes unread when it stops while the window is elsewhere", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      spokenTo(session);
      attention.focused = false;
      expect(isViewed(session)).toBe(false);
      streams(session, WORK_WINDOWS);
      vi.advanceTimersByTime(QUIET_MS + 10);
      expect(session.unread).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps working while more than a redraw keeps coming", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      spokenTo(session);
      streams(session, WORK_WINDOWS);
      vi.advanceTimersByTime(QUIET_MS / 2);
      output(session.key, WORK_BYTES);
      vi.advanceTimersByTime(QUIET_MS / 2 + 10);
      expect(session.working).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // An agent that has stopped and blinks a cursor, or ticks a footer, under
  // a still screen: a few bytes every second, none of them work, and the
  // quiet clock runs out through them.
  it("is waiting despite a redraw now and then", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      spokenTo(session);
      streams(session, WORK_WINDOWS);
      expect(session.working).toBe(true);
      for (let i = 0; i < 4; i += 1) {
        vi.advanceTimersByTime(QUIET_MS / 3);
        output(session.key, 12);
      }
      expect(session.working).toBe(false);
      expect(statusLabel(session)).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the agent's line on the row until someone looks", () => {
    const heard = live(A, "pty-1");
    const behind = live(A, "pty-2");
    select(heard.key);
    noted(behind.key, "Tests green, ready to merge.");
    expect(behind.note).toBe("Tests green, ready to merge.");
    expect(behind.unread).toBe(true);
    viewed(behind.key);
    expect(behind.note).toBeNull();
    expect(behind.unread).toBe(false);
    // On screen already: the line shows, but nothing rings.
    noted(heard.key, "Done.");
    expect(heard.note).toBe("Done.");
    expect(heard.unread).toBe(false);
  });

  // The hooks bring the first line of what the agent said with the stop,
  // so the row says how the turn ended even when the agent left no line
  // of its own; a line it did leave is kept, and the next turn clears it.
  it("takes the agent's last words for the row on a stop", () => {
    const heard = live(A, "pty-1");
    const behind = live(A, "pty-2");
    select(heard.key);
    exact("session-pty-2", "prompt");
    exact("session-pty-2", "stop", "Tests green, ready to merge.");
    expect(behind.note).toBe("Tests green, ready to merge.");
    expect(behind.unread).toBe(true);
    exact("session-pty-2", "prompt");
    expect(behind.note).toBeNull();
    noted(behind.key, "Need the API key");
    exact("session-pty-2", "stop", "I could not find the key.");
    expect(behind.note).toBe("Need the API key");
    exact("session-pty-2", "prompt");
    exact("session-pty-2", "stop");
    expect(behind.note).toBeNull();
    // On screen: the line shows, but nothing rings.
    exact("session-pty-1", "stop", "Done.");
    expect(heard.note).toBe("Done.");
    expect(heard.unread).toBe(false);
  });

  it("marks a ring for attention at once, unless it was heard on screen", () => {
    const heard = live(A, "pty-1");
    const behind = live(A, "pty-2");
    select(heard.key);
    rang(heard.key);
    expect(heard.unread).toBe(false);
    rang(behind.key);
    expect(behind.unread).toBe(true);
  });

  it("marks an ending that nobody saw", () => {
    const behind = live(A, "pty-1");
    live(A, "pty-2");
    ended({ id: "pty-1", code: 0, clean: true });
    expect(behind.unread).toBe(true);
    expect(behind.working).toBe(false);
  });

  // The hooks are exact where the pty is a guess, so they win, and once one
  // has spoken for a session the guess stands down for it.
  it("takes the hooks' word, and the heuristic stands down", () => {
    vi.useFakeTimers();
    try {
      const behind = live(A, "pty-1");
      live(A, "pty-2");
      exact("session-pty-1", "prompt");
      expect(behind.working).toBe(true);
      expect(behind.exact).toBe(true);
      vi.advanceTimersByTime(QUIET_MS * 3);
      expect(behind.working).toBe(true);
      expect(behind.unread).toBe(false);

      exact("session-pty-1", "permission");
      expect(behind.working).toBe(false);
      expect(behind.needs).toBe("permission");
      expect(behind.unread).toBe(true);
      expect(statusLabel(behind)).toBe("needs permission");

      // Granted: output means it went on, and the screen moving keeps it
      // working for as long as it moves.
      output(behind.key, WORK_BYTES);
      expect(behind.needs).toBeNull();
      expect(behind.working).toBe(true);
      vi.advanceTimersByTime(QUIET_EXACT_MS - 1);
      output(behind.key, WORK_BYTES);
      vi.advanceTimersByTime(QUIET_EXACT_MS - 1);
      expect(behind.working).toBe(true);

      exact("session-pty-1", "stop");
      expect(behind.working).toBe(false);
      expect(statusLabel(behind)).toBe("waiting for you");
      // Claude Code's idle notice a minute later says it again: read, it
      // stays read.
      viewed(behind.key);
      exact("session-pty-1", "idle");
      expect(behind.unread).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /** Claude Code's spinner while a command runs or the model thinks, as
      it draws it: a frame of a few dozen bytes four times a second, its
      clock ticking over ("✽ Swooping… (16m 50s)"), well under a busy
      second, for `ms`. */
  const spins = (key: string, ms: number) => {
    for (let at = 0; at < ms; at += 250) {
      vi.advanceTimersByTime(250);
      output(key, 40);
    }
  };

  // Recorded in a real orchestration: a hooked session in the middle of a
  // long turn, running a test suite that printed nothing for minutes, was
  // reported stopped while its screen showed the spinner and its clock.
  it("keeps a hooked session working through a long command that draws only its spinner", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      live(A, "pty-2");
      exact("session-pty-1", "prompt");
      // The tool call goes out with a burst of output.
      output(session.key, WORK_BYTES * 4);
      spins(session.key, 17 * 60_000);
      expect(session.working).toBe(true);
      expect(session.unread).toBe(false);
      // A pause between two tool calls draws nothing at all.
      output(session.key, WORK_BYTES * 2);
      vi.advanceTimersByTime(90_000);
      expect(session.working).toBe(true);
      // The stop hook ends it, and only that.
      exact("session-pty-1", "stop", "Done: tests green");
      expect(session.working).toBe(false);
      expect(session.turnEnd).toBe("done");
      expect(session.note).toBe("Done: tests green");
    } finally {
      vi.useRealTimers();
    }
  });

  // Stopping a turn with Escape or Ctrl+C fires no hook: the hooks still
  // say working, and the screen going still after that key is the sign.
  it("ends a turn as cut short once the screen goes still after the user's Escape", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      live(A, "pty-2");
      exact("session-pty-1", "prompt");
      output(session.key, WORK_BYTES * 2);
      typed("pty-1", "\x1b");
      // Claude Code draws that it was interrupted, then nothing.
      output(session.key, WORK_BYTES);
      vi.advanceTimersByTime(QUIET_EXACT_MS - 1);
      expect(session.working).toBe(true);
      vi.advanceTimersByTime(1);
      expect(session.working).toBe(false);
      expect(session.turnEnd).toBe("cut");
      // The next prompt is the hooks' word again, and quiet ends nothing.
      exact("session-pty-1", "prompt");
      expect(session.working).toBe(true);
      expect(session.turnEnd).toBeNull();
      spins(session.key, QUIET_EXACT_MS * 3);
      expect(session.working).toBe(true);
      // Ctrl+C stops a turn the same way.
      typed("pty-1", "\x03");
      vi.advanceTimersByTime(QUIET_EXACT_MS);
      expect(session.working).toBe(false);
      expect(session.turnEnd).toBe("cut");
    } finally {
      vi.useRealTimers();
    }
  });

  /** A terminal whose last lines are these, for what the screen is read
      for. */
  const showing = (key: string, lines: string[]) =>
    register(key, {
      buffer: {
        active: {
          length: lines.length,
          getLine: (index: number) => ({ translateToString: () => lines[index] }),
        },
      },
    });

  // Escape at Claude Code's permission prompt is its No: the turn ends and
  // no hook fires. The prompt closing redraws the screen.
  it("ends a turn the user stopped by refusing a permission with Escape", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      exact("session-pty-1", "prompt");
      exact("session-pty-1", "permission");
      typed("pty-1", "\x1b");
      output(session.key, WORK_BYTES);
      vi.advanceTimersByTime(QUIET_EXACT_MS);
      expect(session.working).toBe(false);
      expect(session.needs).toBeNull();
      expect(session.turnEnd).toBe("cut");
      // Refused with no redraw to speak of, it ends all the same.
      exact("session-pty-1", "prompt");
      exact("session-pty-1", "permission");
      typed("pty-1", "\x1b");
      vi.advanceTimersByTime(QUIET_EXACT_MS);
      expect(session.needs).toBeNull();
      expect(session.turnEnd).toBe("cut");
    } finally {
      resetScreens();
      vi.useRealTimers();
    }
  });

  // The numbered No is a digit or Enter, as a yes is: the screen says which
  // once it is still.
  it("ends a turn refused with the numbered No by the interrupted line, and not one granted", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      exact("session-pty-1", "prompt");
      exact("session-pty-1", "permission");
      typed("pty-1", "3");
      showing(session.key, [
        "⏺ Bash(rm -rf build)",
        "  ⎿  Interrupted · What should Claude do instead?",
        "",
        "❯ ",
      ]);
      output(session.key, WORK_BYTES);
      vi.advanceTimersByTime(QUIET_EXACT_MS);
      expect(session.working).toBe(false);
      expect(session.turnEnd).toBe("cut");

      // Granted, the command runs quietly under the spinner and the turn
      // goes on, an old interrupted line above its bullet notwithstanding.
      exact("session-pty-1", "prompt");
      exact("session-pty-1", "permission");
      typed("pty-1", "1");
      showing(session.key, [
        "  ⎿  Interrupted · What should Claude do instead?",
        "⏺ Bash(npm test)",
        "  ⎿  Running…",
        "✽ Swooping… (1m 2s)",
      ]);
      output(session.key, WORK_BYTES);
      spins(session.key, 60_000);
      expect(session.working).toBe(true);
      expect(session.turnEnd).toBeNull();
    } finally {
      resetScreens();
      vi.useRealTimers();
    }
  });

  // Claude Code's Ctrl+C with words on the line empties the line, and the
  // turn goes on; the real stop is then the agent's own.
  it("takes Ctrl+C that empties a draft for no stop", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      exact("session-pty-1", "prompt");
      output(session.key, WORK_BYTES);
      typed("pty-1", "also check the docs");
      typed("pty-1", "\x03");
      spins(session.key, 8000);
      expect(session.working).toBe(true);
      expect(session.turnEnd).toBeNull();
      // On the emptied line a second Ctrl+C stops the turn.
      typed("pty-1", "\x03");
      vi.advanceTimersByTime(QUIET_EXACT_MS);
      expect(session.turnEnd).toBe("cut");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the turn to the hooks once one speaks after the user's Escape", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      exact("session-pty-1", "prompt");
      typed("pty-1", "\x1b");
      // Escape closed a menu, and the agent asked for a permission.
      exact("session-pty-1", "permission");
      output(session.key, WORK_BYTES);
      expect(session.working).toBe(true);
      spins(session.key, QUIET_EXACT_MS * 3);
      expect(session.working).toBe(true);
      expect(session.turnEnd).toBeNull();
      // An Escape typed into a session at rest stops nothing.
      exact("session-pty-1", "stop");
      typed("pty-1", "\x1b");
      vi.advanceTimersByTime(QUIET_EXACT_MS * 2);
      expect(session.turnEnd).toBe("done");
      // Nor does one while its subagents run in the background.
      exact("session-pty-1", "prompt");
      exact("session-pty-1", "delegated");
      typed("pty-1", "\x1b");
      vi.advanceTimersByTime(QUIET_EXACT_MS * 2);
      expect(session.working).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // Recorded: a session at its usage limit, the screen saying "You've hit
  // your 5-hour limit · resets 4pm (Europe/Stockholm)", and Claude Code's
  // failed-turn hook in place of its stop.
  it("takes a turn a usage limit ended as failed, with when the limit lifts", () => {
    const session = live(A, "pty-1");
    live(A, "pty-2");
    exact("session-pty-1", "prompt");
    output(session.key, WORK_BYTES);
    exact(
      "session-pty-1",
      "failed",
      "You've hit your 5-hour limit · resets 4pm (Europe/Stockholm)",
      false,
      { error: "rate_limit" },
    );
    expect(session.working).toBe(false);
    expect(session.turnEnd).toBe("failed");
    expect(session.failure).toEqual({
      limit: true,
      until: "4pm",
      line: "You've hit your 5-hour limit · resets 4pm (Europe/Stockholm)",
    });
    expect(session.note).toBe("You've hit your 5-hour limit · resets 4pm (Europe/Stockholm)");
    expect(session.unread).toBe(true);
    // The agent goes on by itself at the reset, and what ended the last
    // turn is past.
    exact("session-pty-1", "prompt");
    expect(session.failure).toBeNull();
    expect(session.turnEnd).toBeNull();
  });

  // Recorded: "API Error: Connection lost mid-response. The response above
  // may be incomplete.", and the same after the laptop slept mid-response.
  it("takes a turn an API error ended as failed, and a laptop's sleep as nothing", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      exact("session-pty-1", "prompt");
      output(session.key, WORK_BYTES);
      // The laptop sleeps for an hour: no output, and every timer late.
      vi.advanceTimersByTime(60 * 60_000);
      expect(session.working).toBe(true);
      // It wakes, and the response it was streaming is gone.
      exact(
        "session-pty-1",
        "failed",
        "API Error: Your computer went to sleep mid-response. The response above may be incomplete.",
        false,
        { error: "server_error" },
      );
      expect(session.working).toBe(false);
      expect(session.failure?.limit).toBe(false);
      expect(session.failure?.line).toContain("went to sleep mid-response");
      exact("session-pty-1", "prompt");
      exact(
        "session-pty-1",
        "failed",
        "API Error: Connection lost mid-response. The response above may be incomplete.",
        false,
        { error: "server_error" },
      );
      expect(session.failure).toEqual({
        limit: false,
        until: null,
        line: "API Error: Connection lost mid-response. The response above may be incomplete.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // Recorded: "The tests are still running in the background. I'll finish
  // the report and notify once they complete." The turn ended; the
  // command's end starts the next one.
  it("keeps the commands a stop left running, until the next turn begins", () => {
    const session = live(A, "pty-1");
    exact("session-pty-1", "prompt");
    exact("session-pty-1", "stop", "Waiting for the unit suite to finish.", false, {
      background: ["Run the unit suite"],
    });
    expect(session.working).toBe(false);
    expect(session.background).toEqual(["Run the unit suite"]);
    const turns = session.turns;
    exact("session-pty-1", "prompt");
    expect(session.background).toEqual([]);
    expect(session.turns).toBe(turns + 1);
  });

  it("counts the turns a session begins, by its hooks or, without them, its output", () => {
    vi.useFakeTimers();
    try {
      const hooked = live(A, "pty-1");
      exact("session-pty-1", "prompt");
      exact("session-pty-1", "permission");
      output(hooked.key, WORK_BYTES);
      expect(hooked.working).toBe(true);
      // A permission granted is the same turn going on.
      expect(hooked.turns).toBe(1);
      exact("session-pty-1", "stop");
      exact("session-pty-1", "prompt");
      expect(hooked.turns).toBe(2);

      const unhooked = live(A, "pty-2");
      typed("pty-2", "go\r");
      for (let second = 0; second < WORK_WINDOWS; second += 1) {
        output(unhooked.key, WORK_BYTES);
        vi.advanceTimersByTime(1010);
      }
      expect(unhooked.working).toBe(true);
      expect(unhooked.turns).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Claude Code runs subagents in the background by default: the agent ends
  // its turn to wait for them, and their report is the next prompt. The
  // stop hook says so, and the row keeps working through the wait, still
  // screen and all.
  it("keeps a session working while its subagents run in the background", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      live(A, "pty-2");
      exact("session-pty-1", "prompt");
      output(session.key, WORK_BYTES);
      exact("session-pty-1", "delegated", "Reviewing in the background.");
      expect(session.working).toBe(true);
      expect(session.unread).toBe(false);
      expect(session.note).toBe("Reviewing in the background.");
      expect(statusLabel(session)).toBe("working");
      // The prompt sits idle on screen for as long as the agents take.
      vi.advanceTimersByTime(QUIET_EXACT_MS * 3);
      output(session.key, 12);
      vi.advanceTimersByTime(QUIET_EXACT_MS * 3);
      expect(session.working).toBe(true);
      expect(session.unread).toBe(false);

      // The report comes back as a prompt, and the turn ends for real.
      exact("session-pty-1", "prompt");
      expect(session.note).toBeNull();
      output(session.key, WORK_BYTES);
      exact("session-pty-1", "stop", "Done.");
      expect(session.working).toBe(false);
      expect(session.unread).toBe(true);
      expect(session.note).toBe("Done.");
    } finally {
      vi.useRealTimers();
    }
  });

  // The agent sends its idle notice only once nothing of its own is
  // running: a wait that never ends, the subagents killed under it, ends
  // there.
  it("ends a delegated wait when the agent says it is idle", () => {
    const session = live(A, "pty-1");
    live(A, "pty-2");
    exact("session-pty-1", "prompt");
    exact("session-pty-1", "delegated");
    expect(session.working).toBe(true);
    exact("session-pty-1", "idle");
    expect(session.working).toBe(false);
    expect(session.unread).toBe(true);
    // Escape during the next turn ends it the usual way again.
    exact("session-pty-1", "prompt");
    expect(session.delegated).toBe(false);
  });

  it("reads a session the user prompted, and ignores an id it does not have", () => {
    const session = live(A, "pty-1");
    session.unread = true;
    exact("session-pty-1", "prompt");
    expect(session.unread).toBe(false);
    expect(() => exact("nope", "stop")).not.toThrow();
  });

  // Disowning takes a session out of ours, so it is listed behind the fold
  // with the sessions from outside, still there to resume.
  it("disowns a session", () => {
    live(A, "pty-1");
    expect(isMine(A, "session-pty-1")).toBe(true);
    disown(A, "session-pty-1");
    expect(isMine(A, "session-pty-1")).toBe(false);
    expect(() => disown(A, "not-ours")).not.toThrow();
  });

  // Claude Code rings the bell and its stop hook fires as one turn ends:
  // the session started waiting once, so it is said once.
  it("says once when a session starts waiting, however many signs there are", () => {
    const told: string[] = [];
    onWaiting((session) => told.push(session.key));
    try {
      const behind = live(A, "pty-1");
      const watched = live(A, "pty-2");
      exact("session-pty-1", "stop", "Done.");
      rang(behind.key);
      noted(behind.key, "Over to you.");
      expect(told).toEqual([behind.key]);

      // On screen, nothing is news.
      rang(watched.key);
      expect(told).toEqual([behind.key]);

      // Read, then waiting again: that is news again.
      viewed(behind.key);
      exact("session-pty-1", "prompt");
      exact("session-pty-1", "permission");
      expect(told).toEqual([behind.key, behind.key]);

      // Asked again: the same ask, not news.
      exact("session-pty-1", "permission");
      expect(told).toHaveLength(2);
      ended({ id: "pty-1", code: 0, clean: true });
      expect(told).toHaveLength(2);

      // Waiting already, then asking for a permission with no prompt
      // between: the ask is news of its own.
      const other = live(A, "pty-3");
      select(watched.key);
      exact("session-pty-3", "stop");
      exact("session-pty-3", "permission");
      expect(told.filter((key) => key === other.key)).toHaveLength(2);
    } finally {
      onWaiting(null);
    }
  });

  it("does nothing for a key it does not have", () => {
    expect(() => output("nope", 999)).not.toThrow();
    expect(() => rang("nope")).not.toThrow();
    expect(() => viewed("nope")).not.toThrow();
  });
});

// What an idle Claude Code session does by itself, recorded from a scratch
// session: the hooks it fires and the bytes it draws each second. The idle
// notice comes a minute after a turn ends, and again a minute after each
// recap and each compaction, which fire no hook the window hears (a recap
// and a compaction each end a subagent, and a compaction starts the session
// again, neither of which the hooks report).
describe("a session read stays read", () => {
  /** Bytes per second a turn drew, its first two seconds with the user's
      words echoed and the reply's bullet in the second. */
  const TURN = [1150, 869, 350, 727];
  const TURN_SAYS = 1;
  /** A recap of the conversation, under a spinner, with no bullet. */
  const RECAP = [4241, 335, 713];
  /** A compaction, under a spinner, with no bullet. */
  const COMPACTION = [5364, 1055, 674, 745, 782, 938, 1247, 837];
  /** A compaction on a full screen, in a second recording: moving the
      conversation, it draws again the bullets already on screen as it
      starts and as it ends. */
  const FULL_COMPACTION = [6833, 714, 983, 691, 991, 991, 989, 985, 871, 1881];
  const FULL_COMPACTION_SAYS = [0, 9];
  /** The whole of a minute's idle: the cursor redrawn as focus left. */
  const IDLE_MINUTE = [44];
  /** A turn the agent started by itself when a command it ran in the
      background ended, in the second recording: two seconds of output with
      bullets in both, too short to count as work. */
  const OWN_TURN = [2843, 2743];

  /** Plays seconds of output into a session, a chunk a second, a bullet in
      each second `says` names. */
  const plays = (key: string, seconds: number[], says: number | number[] = -1) => {
    const drawn = Array.isArray(says) ? says : [says];
    seconds.forEach((bytes, at) => {
      if (at > 0) vi.advanceTimersByTime(1010);
      output(key, bytes, Date.now(), drawn.includes(at));
    });
    vi.advanceTimersByTime(QUIET_MS + 10);
  };

  /** The user reads a session: on screen in a focused window. */
  const look = (session: ReturnType<typeof live>) => {
    select(session.key);
    viewed(session.key);
  };

  /** Two sessions in one project, the second behind the first. */
  const pair = () => {
    const front = live(A, "pty-1");
    const behind = live(A, "pty-2");
    select(front.key);
    return { front, behind };
  };

  it("says idle at rest where hooks report the turns, and running where they are guessed", () => {
    const { front, behind } = pair();
    expect(statusLabel(behind)).toBe("running");
    exact("session-pty-2", "prompt");
    expect(statusLabel(behind)).toBe("working");
    exact("session-pty-2", "stop", "ok");
    look(behind);
    expect(behind.exact).toBe(true);
    expect(statusLabel(behind)).toBe("idle");
    // Codex's turns are read from its log, not its hooks: still guessed.
    behind.agent = "codex";
    expect(statusLabel(behind)).toBe("running");
    expect(statusLabel(front)).toBe("running");
  });

  it("takes the idle notices after a stop, a recap and a compaction for nothing new, with hooks", () => {
    const told: string[] = [];
    onWaiting((session) => told.push(session.key));
    try {
      const { front, behind } = pair();
      exact("session-pty-2", "prompt");
      exact("session-pty-2", "stop", "ok");
      expect(behind.unread).toBe(true);
      expect(told).toEqual([behind.key]);

      look(behind);
      select(front.key);
      expect(behind.unread).toBe(false);
      // A minute after the stop, after the recap, after the compaction.
      for (let notice = 0; notice < 3; notice++) exact("session-pty-2", "idle");
      expect(behind.unread).toBe(false);
      expect(behind.note).toBeNull();
      // Its hooks said the turn ended, so at rest it is idle.
      expect(statusLabel(behind)).toBe("idle");
      expect(told).toEqual([behind.key]);
    } finally {
      onWaiting(null);
    }
  });

  it("takes the idle notice for nothing new after a stop seen on screen", () => {
    const { front, behind } = pair();
    select(behind.key);
    exact("session-pty-2", "prompt");
    exact("session-pty-2", "stop", "Done.");
    expect(behind.unread).toBe(false);
    select(front.key);
    exact("session-pty-2", "idle");
    expect(behind.unread).toBe(false);
  });

  it("marks a read session again for a new turn that ends, a permission, a line or an ending", () => {
    const { front, behind } = pair();
    exact("session-pty-2", "prompt");
    exact("session-pty-2", "stop");
    look(behind);
    select(front.key);

    // A turn that starts and ends while the user is away.
    exact("session-pty-2", "prompt");
    exact("session-pty-2", "stop", "Second answer.");
    expect(behind.unread).toBe(true);
    expect(behind.note).toBe("Second answer.");
    viewed(behind.key);
    expect(behind.unread).toBe(false);

    // A permission, however recently the row was read.
    exact("session-pty-2", "prompt");
    exact("session-pty-2", "permission");
    expect(behind.unread).toBe(true);
    viewed(behind.key);

    // A line it leaves, with nothing else new.
    exact("session-pty-2", "stop");
    viewed(behind.key);
    noted(behind.key, "Over to you.");
    expect(behind.unread).toBe(true);
    viewed(behind.key);

    // Its ending.
    ended({ id: "pty-2", code: 0, clean: true });
    expect(behind.unread).toBe(true);
  });

  // A turn whose stop the hooks never told, as when the agent waited on its
  // subagents: its idle notice is the turn's end, and news.
  it("marks the idle notice that ends a turn", () => {
    const { behind } = pair();
    exact("session-pty-2", "prompt");
    exact("session-pty-2", "delegated");
    viewed(behind.key);
    exact("session-pty-2", "idle");
    expect(behind.working).toBe(false);
    expect(behind.unread).toBe(true);
  });

  it("takes a recap and a compaction for housekeeping, without hooks", () => {
    vi.useFakeTimers();
    try {
      const { front, behind } = pair();
      typed("pty-2", "Reply with the single word ok.\r");
      plays(behind.key, TURN, TURN_SAYS);
      expect(behind.unread).toBe(true);
      look(behind);
      select(front.key);

      plays(behind.key, IDLE_MINUTE);
      plays(behind.key, RECAP);
      expect(behind.working).toBe(false);
      expect(behind.unread).toBe(false);
      plays(behind.key, COMPACTION);
      expect(behind.working).toBe(false);
      expect(behind.unread).toBe(false);
      expect(statusLabel(behind)).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  // The agent starts a turn of its own while read, as it does for a
  // background subagent's report: it says something, so it is a turn.
  it("takes a turn the agent starts by itself for work and news, without hooks", () => {
    vi.useFakeTimers();
    try {
      const { front, behind } = pair();
      typed("pty-2", "go\r");
      plays(behind.key, TURN, TURN_SAYS);
      look(behind);
      select(front.key);
      expect(behind.unread).toBe(false);

      plays(behind.key, [...RECAP, ...TURN], RECAP.length + TURN_SAYS);
      expect(behind.unread).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes housekeeping for work while the session is not read at rest, as before", () => {
    vi.useFakeTimers();
    try {
      const { behind } = pair();
      typed("pty-2", "go\r");
      plays(behind.key, RECAP);
      expect(behind.unread).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes a line the user sends for the start of a turn, bullet or not", () => {
    vi.useFakeTimers();
    try {
      const { front, behind } = pair();
      typed("pty-2", "go\r");
      plays(behind.key, TURN, TURN_SAYS);
      look(behind);
      select(front.key);
      // The model thinks under its spinner before it says a word.
      typed("pty-2", "and then?\r");
      for (let second = 0; second < WORK_WINDOWS; second++) {
        if (second > 0) vi.advanceTimersByTime(1010);
        output(behind.key, WORK_BYTES);
      }
      expect(behind.working).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finds a turn's bullet in a chunk, on macOS and elsewhere", () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(drawsTurn(encode("\x1b[2K⏺ ok"))).toBe(true);
    expect(drawsTurn(encode("● Read(src/a.ts)"))).toBe(true);
    expect(drawsTurn(encode("✻ Transmuting… ⎿ recap"))).toBe(false);
    expect(drawsTurn(encode("✳ Compacting conversation…"))).toBe(false);
    expect(drawsTurn(new Uint8Array([0xe2, 0x8f]))).toBe(false);
  });

  // The core hands the bytes on as the pty gave them, and a read may end
  // inside a character. A reply draws its bullet once.
  it("finds a bullet a read of the pty cuts in two", () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const bytes = encode("\x1b[H\r\x1b[8B\x1b[38;2;255;255;255m⏺\x1b[3G\x1b[39mok");
    const at = bytes.indexOf(0xe2);
    for (const cut of [at + 1, at + 2]) {
      const watch = bulletWatch();
      expect(watch(bytes.slice(0, cut))).toBe(false);
      expect(watch(bytes.slice(cut))).toBe(true);
    }
    const byByte = bulletWatch();
    expect([...bytes].filter((byte) => byByte(new Uint8Array([byte])))).toHaveLength(1);
    const plain = bulletWatch();
    expect(plain(encode("✻ Brewing…"))).toBe(false);
    expect(plain(encode("✶ Brewing…"))).toBe(false);
  });

  // A Claude Code that draws its turns some other way: the window cannot
  // tell its turns from its housekeeping, and takes every spell for work.
  it("takes every spell for work where the agent's turns drew no bullet it knows", () => {
    vi.useFakeTimers();
    try {
      const { front, behind } = pair();
      typed("pty-2", "go\r");
      plays(behind.key, TURN);
      expect(behind.unread).toBe(true);
      look(behind);
      select(front.key);

      plays(behind.key, TURN);
      expect(behind.unread).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a bullet for the spell it starts, not for one a while later", () => {
    vi.useFakeTimers();
    try {
      const { front, behind } = pair();
      typed("pty-2", "go\r");
      plays(behind.key, TURN, TURN_SAYS);
      look(behind);
      select(front.key);

      // A redraw that happens to draw a bullet, a minute before a recap.
      output(behind.key, 44, Date.now(), true);
      vi.advanceTimersByTime(60_000);
      plays(behind.key, RECAP);
      expect(behind.working).toBe(false);
      expect(behind.unread).toBe(false);

      // One in the quiet second just before a spell is the spell's.
      vi.advanceTimersByTime(60_000);
      output(behind.key, 120, Date.now(), true);
      vi.advanceTimersByTime(1010);
      plays(behind.key, RECAP);
      expect(behind.unread).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // What output cannot tell: the bullets a compaction draws again on a full
  // screen are the turns', and the window errs on the side of news.
  it("takes a compaction that draws the turns again on a full screen for work, without hooks", () => {
    vi.useFakeTimers();
    try {
      const { front, behind } = pair();
      typed("pty-2", "go\r");
      plays(behind.key, TURN, TURN_SAYS);
      look(behind);
      select(front.key);

      plays(behind.key, FULL_COMPACTION, FULL_COMPACTION_SAYS);
      expect(behind.unread).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes a bell at rest after the session was read for a reminder, and any other for news", () => {
    vi.useFakeTimers();
    try {
      const { front, behind } = pair();
      exact("session-pty-2", "prompt");
      exact("session-pty-2", "stop");
      look(behind);
      select(front.key);
      // Claude Code set to ring its idle notice.
      belled(behind.key);
      expect(behind.unread).toBe(false);

      // While it works, a bell is news.
      exact("session-pty-2", "prompt");
      belled(behind.key);
      expect(behind.unread).toBe(true);

      // A session nobody has looked at yet rings for its own reasons.
      const fresh = live(A, "pty-3");
      select(front.key);
      belled(fresh.key);
      expect(fresh.unread).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // Without hooks a turn that short shows nothing on the row, and the bell
  // of the idle notice a minute later is the only sign of it.
  it("takes a bell at rest for news without hooks", () => {
    vi.useFakeTimers();
    try {
      const { front, behind } = pair();
      typed("pty-2", "go\r");
      plays(behind.key, TURN, TURN_SAYS);
      look(behind);
      select(front.key);

      plays(behind.key, OWN_TURN, [0, 1]);
      expect(behind.unread).toBe(false);
      vi.advanceTimersByTime(60_000);
      belled(behind.key);
      expect(behind.unread).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a session another session answers for to a permission alone", () => {
    const { behind } = pair();
    onDirected((session) => session.key === behind.key);
    try {
      exact("session-pty-2", "prompt");
      exact("session-pty-2", "stop");
      exact("session-pty-2", "idle");
      belled(behind.key);
      expect(behind.unread).toBe(false);
      exact("session-pty-2", "permission");
      expect(behind.unread).toBe(true);
    } finally {
      onDirected(null);
    }
  });

  // A session run outside the window has its hooks heard all the same; a
  // stop from then is no news to a resume of it here.
  it("drops a transition heard long before the row knew its id", () => {
    vi.useFakeTimers();
    try {
      const front = live(A, "pty-1");
      exact("outside", "stop", "Old answer.");
      vi.advanceTimersByTime(PENDING_FOR);
      const resumed = create(A);
      select(front.key);
      started(resumed.key, "pty-9", "outside");
      expect(resumed.unread).toBe(false);
      expect(resumed.note).toBeNull();

      // One heard just before the id is known is the row's.
      exact("soon", "prompt");
      vi.advanceTimersByTime(PENDING_FOR / 10);
      const fresh = create(A);
      select(front.key);
      started(fresh.key, "pty-10", "soon");
      expect(fresh.working).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("by status", () => {
  it("groups every row by what it is doing, the latest change first, and leaves empty groups out", () => {
    vi.useFakeTimers();
    attention.focused = false;
    try {
      vi.setSystemTime(1_000_000);
      const idle = live(A, "pty-idle");
      vi.setSystemTime(1_001_000);
      const asking = live(B, "pty-ask");
      exact("session-pty-ask", "permission");
      vi.setSystemTime(1_002_000);
      const busy = live(A, "pty-busy");
      exact("session-pty-busy", "prompt");
      vi.setSystemTime(1_003_000);
      const stopped = live(B, "pty-stop");
      exact("session-pty-stop", "stop");
      const dormant = reopened(A, "old-1", "claude-code", null, null, null);

      expect(
        byStatus().map((group) => [group.id, group.sessions.map((session) => session.key)]),
      ).toEqual([
        ["needs", [stopped.key, asking.key]],
        ["working", [busy.key]],
        ["active", [dormant.key, idle.key]],
      ]);
      expect(byStatus().map((group) => group.title)).toEqual([
        "Needs you",
        "Working",
        "Active",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves a row when it is looked at, ends, or asks again, and not otherwise", () => {
    vi.useFakeTimers();
    attention.focused = false;
    try {
      vi.setSystemTime(1_000_000);
      const session = live(A, "pty-1");
      expect(session.changedAt).toBe(1_000_000);

      vi.setSystemTime(1_001_000);
      exact("session-pty-1", "stop");
      expect(session.changedAt).toBe(1_001_000);
      expect(byStatus()[0].id).toBe("needs");

      // Unread already: another stop is no news, and the row stays put.
      vi.setSystemTime(1_002_000);
      exact("session-pty-1", "idle");
      expect(session.changedAt).toBe(1_001_000);

      vi.setSystemTime(1_003_000);
      select(session.key);
      viewed(session.key);
      expect(session.changedAt).toBe(1_003_000);
      expect(byStatus()[0].id).toBe("active");

      // Read, and nothing happened since: looking again changes nothing.
      vi.setSystemTime(1_004_000);
      viewed(session.key);
      expect(session.changedAt).toBe(1_003_000);

      vi.setSystemTime(1_005_000);
      ended({ id: "pty-1", code: 0, clean: true });
      expect(session.changedAt).toBe(1_005_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts an orchestrator as working when the caller says a started session is", () => {
    const quiet = live(A, "pty-1");
    expect(byStatus(() => true)[0]).toMatchObject({ id: "working" });
    expect(byStatus()[0]).toMatchObject({ id: "active", sessions: [quiet] });
  });
});

describe("how long past sessions stay listed", () => {
  const now = Math.floor(Date.now() / 1000);
  const DAY = 24 * 60 * 60;
  const transcript = (id: string, modified: number) => ({
    id,
    title: id,
    modified,
    size: 100,
    agent: "claude-code" as const,
    account: null,
  });

  function ours(...ids: string[]) {
    for (const id of ids) {
      const session = create(A);
      started(session.key, `pty-${id}`, id);
      close(session.key);
    }
  }

  it("lists everything forever to begin with", () => {
    sessions.history[A] = [transcript("old", now - 400 * DAY), transcript("new", now - 60)];
    ours("old", "new");
    expect(aged(transcript("old", now - 400 * DAY))).toBe(false);
    expect(historyFor(A).map((t) => t.id)).toEqual(["old", "new"]);
    expect(outsideFor(A)).toHaveLength(0);
  });

  it("moves one left unchanged past the span behind the fold, and back when the span grows", () => {
    sessions.history[A] = [
      transcript("old", now - 10 * DAY),
      transcript("new", now - 2 * DAY),
    ];
    ours("old", "new");
    setPastSessions("week");
    expect(historyFor(A).map((t) => t.id)).toEqual(["new"]);
    expect(outsideFor(A).map((t) => t.id)).toEqual(["old"]);
    expect(outsideFor(A, "claude-code")).toHaveLength(1);
    expect(outsideFor(A, "codex")).toHaveLength(0);
    setPastSessions("day");
    expect(historyFor(A)).toHaveLength(0);
    setPastSessions("month");
    expect(historyFor(A)).toHaveLength(2);
    // Still ours: resuming is not needed to bring it back.
    expect(isMine(A, "old")).toBe(true);
  });

  it("takes a value the core does not know as forever", () => {
    sessions.history[A] = [transcript("old", now - 10 * DAY)];
    ours("old");
    adoptPastSessions("week");
    expect(historyFor(A)).toHaveLength(0);
    adoptPastSessions("fortnight");
    expect(historyFor(A)).toHaveLength(1);
  });

  it("lets a row left from the last quit go behind the fold once its transcript has aged", async () => {
    reopened(A, "stale", "claude-code", null, null, null);
    reopened(A, "fresh", "claude-code", null, null, null);
    ours("stale", "fresh");
    historyAnswer = [
      { id: "stale", title: "stale", modified: now - 10 * DAY, size: 1, cwd: null },
      { id: "fresh", title: "fresh", modified: now - DAY, size: 1, cwd: null },
    ];
    await loadHistory(A);
    expect(forProject(A).map((s) => s.id)).toEqual(["stale", "fresh"]);

    const stopped = killed.length;
    setPastSessions("week");
    expect(forProject(A).map((s) => s.id)).toEqual(["fresh"]);
    // Nothing was running behind the row, so nothing is stopped.
    expect(killed).toHaveLength(stopped);
    expect(outsideFor(A).map((t) => t.id)).toEqual(["stale"]);

    // Read again later with the span unchanged, the next one to age goes too.
    historyAnswer[1].modified = now - 8 * DAY;
    await loadHistory(A);
    expect(forProject(A)).toHaveLength(0);
  });
});

describe("the next session that needs you", () => {
  it("lists askers first, then the longest waiting, the one on screen included", () => {
    vi.useFakeTimers();
    attention.focused = false;
    try {
      vi.setSystemTime(1_000_000);
      const first = live(A, "pty-1");
      exact("session-pty-1", "stop");
      vi.setSystemTime(1_001_000);
      const second = live(B, "pty-2");
      exact("session-pty-2", "stop");
      vi.setSystemTime(1_002_000);
      const asking = live(A, "pty-3");
      exact("session-pty-3", "permission");
      vi.setSystemTime(1_003_000);
      const here = live(B, "pty-4");
      exact("session-pty-4", "stop");
      expect(sessions.active).toBe(here.key);

      expect(waitingOnYou().map((session) => session.key)).toEqual([
        asking.key,
        first.key,
        second.key,
        here.key,
      ]);
      expect(nextNeedingYou()?.key).toBe(asking.key);
    } finally {
      vi.useRealTimers();
    }
  });

  it("steps from the one on screen, so repeating it reaches every waiting session", () => {
    vi.useFakeTimers();
    attention.focused = false;
    try {
      vi.setSystemTime(1_000_000);
      const a = live(A, "pty-1");
      exact("session-pty-1", "permission");
      vi.setSystemTime(1_001_000);
      const b = live(B, "pty-2");
      exact("session-pty-2", "permission");
      vi.setSystemTime(1_002_000);
      const c = live(A, "pty-3");
      exact("session-pty-3", "permission");
      vi.setSystemTime(1_003_000);
      const stopped = live(B, "pty-4");
      exact("session-pty-4", "stop");
      vi.setSystemTime(1_004_000);
      const fresh = live(A, "pty-5");
      expect(sessions.active).toBe(fresh.key);

      attention.focused = true;
      const path: string[] = [];
      for (let step = 0; step < 8; step++) {
        const next = nextNeedingYou();
        expect(next).not.toBeNull();
        path.push(next!.key);
        select(next!.key);
        viewed(next!.key);
        vi.advanceTimersByTime(1000);
      }
      // Looking at an unread asker moves it behind the others that ask, so
      // the walk passes the stopped session after the first one, and settles
      // into going round the askers once it is read.
      expect(path).toEqual(
        [a, stopped, b, c, a, b, c, a].map((session) => session.key),
      );
      expect(new Set(path.slice(0, 4))).toEqual(
        new Set([a, b, c, stopped].map((session) => session.key)),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("is nobody when nothing waits", () => {
    const idle = live(A, "pty-1");
    exact("session-pty-1", "stop");
    viewed(idle.key);
    live(A, "pty-2");
    exact("session-pty-2", "prompt");
    live(B, "pty-3");
    expect(waitingOnYou()).toEqual([]);
    expect(nextNeedingYou()).toBeNull();
  });

  it("is nobody when the only one waiting is on screen", () => {
    attention.focused = false;
    const only = live(A, "pty-1");
    exact("session-pty-1", "stop");
    expect(sessions.active).toBe(only.key);
    expect(waitingOnYou()).toHaveLength(1);
    expect(nextNeedingYou()).toBeNull();
  });
});

describe("a name the agent or a caller gave", () => {
  beforeEach(() => reset());

  it("is drawn with what cannot be seen in it written out", () => {
    // The reviewer's case: a name with a right-to-left override in it.
    const row = create("/p");
    row.title = "tidy \u202eeman";
    expect(label(row)).toBe("tidy ⟨U+202E⟩eman");
    noted(row.key, "done \u200b\u2066now");
    expect(byKey(row.key)!.note).toBe("done ⟨U+200B⟩⟨U+2066⟩now");
  });

  it("is never You or Workbench, which the thread keeps for the user and the workbench", () => {
    const row = create("/p");
    for (const title of ["You", "you", " YOU ", "\u200byou\u200b", "“You”", "Workbench", " workbench ", "\u200bWORKBENCH"]) {
      row.title = title;
      expect(label(row)).toBe(`session ${row.ordinal}`);
    }
    row.title = "Young";
    expect(label(row)).toBe("Young");
    row.title = "Workbench docs";
    expect(label(row)).toBe("Workbench docs");
    const past = { id: "abc12345-0000", title: "you", modified: 0 } as Transcript;
    expect(historyLabel(past)).toBe("session from " + ago(0));
    expect(historyLabel({ ...past, title: "Workbench" })).toBe("session from " + ago(0));
    // Nor is it a name a session can take.
    expect(nameTaken("Workbench")).toBe(true);
    expect(nameTaken("Workbench docs", row.key)).toBe(false);
  });
});

describe("telling two names apart", () => {
  beforeEach(() => reset());

  it("reads every look-alike of a letter as the same letter, in a name of one script too", () => {
    const six = create("/p");
    started(six.key, "pty-six", "sid-six");
    six.title = "six";
    // All Cyrillic: ѕ, і and х, which read as the Latin six.
    expect(nameTaken("\u0455\u0456\u0445")).toBe(true);
    expect(nameTaken("s\u0457x")).toBe(true);
    expect(nameTaken("s\u03b9x")).toBe(true);
    expect(nameTaken("sox")).toBe(false);
  });
});

describe("following a workflow", () => {
  const P = "/home/ada/dev/one";
  const codexRun = (): Workflow => ({
    ...defaultWorkflow(),
    name: "Codex run",
    orchestrator: { agent: "codex", model: "default" },
    startOnly: false,
  });

  const codexToo = () =>
    applyDetect({ id: "codex", path: "/usr/local/bin/codex", caps: null, fromLoginShell: true }, true);

  it("starts a plain new session on the project's workflow, its orchestrator's agent and model, told the workflow", async () => {
    adoptWorkflows({ list: [defaultWorkflow(), codexRun()], default: "Build and review", overrides: {} });
    const session = create(P);
    expect(session.workflow).toEqual(defaultWorkflow());
    expect(session.agent).toBe("claude-code");
    expect(session.model).toBe("fable");
    await launch(session.key, 80, 24, () => {});
    expect(spawned.at(-1)).toMatchObject({
      agent: "claude-code",
      model: "fable",
      instructions: orchestratorPrompt(defaultWorkflow()),
      startOnly: true,
    });
    expect(workflowFor("sid-1")).toEqual(defaultWorkflow());
  });

  it("starts the one agent installed on the project's workflow, there being nothing to pick", () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: {} });
    expect(create(P, null, "claude-code").workflow?.name).toBe("Build and review");
  });

  it("starts an agent picked from several alone, whatever the project follows", async () => {
    codexToo();
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: {} });
    const session = create(P, null, "codex");
    expect(session.workflow).toBeNull();
    expect(session.agent).toBe("codex");
    expect(defaultAgent(P)).toBe("codex");
    await launch(session.key, 80, 24, () => {});
    expect(spawned.at(-1)?.agent).toBe("codex");
    expect(spawned.at(-1)).not.toHaveProperty("instructions");
    // Picked as Claude Code, it is Claude Code alone, on no model.
    const claude = create(P, null, "claude-code");
    expect(claude.workflow).toBeNull();
    expect(claude.model).toBeNull();
  });

  it("starts the workflow given, and none when given none", () => {
    codexToo();
    adoptWorkflows({ list: [defaultWorkflow(), codexRun()], default: null, overrides: {} });
    expect(create(P, null, undefined, null, null, null, null, codexRun()).agent).toBe("codex");
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: {} });
    expect(create(P, null, undefined, null, null, null, null, null).workflow).toBeNull();
  });

  it("refuses a workflow whose orchestrator's agent is not installed, and starts nothing", async () => {
    adoptWorkflows({ list: [defaultWorkflow(), codexRun()], default: null, overrides: { [P]: "Codex run" } });
    const session = create(P);
    expect(session.status).toBe("failed");
    expect(statusMessage(session)).toBe(
      'The workflow "Codex run" runs its orchestrator on Codex, which is not installed here. Pick an agent to start one alone, or choose another workflow for this project in the settings.',
    );
    expect(await launch(session.key, 80, 24, () => {})).toBe(false);
    expect(spawned).toHaveLength(0);
    // What the project used last is not what failed to start.
    expect(sessions.preferred[P]).toBeUndefined();
  });

  it("starts Codex's orchestrator on its own default, keeping its subagents when the workflow says so", async () => {
    codexToo();
    adoptWorkflows({ list: [defaultWorkflow(), codexRun()], default: null, overrides: { [P]: "Codex run" } });
    const session = create(P);
    expect(session.agent).toBe("codex");
    expect(session.model).toBeNull();
    await launch(session.key, 80, 24, () => {});
    expect(spawned.at(-1)?.startOnly).toBe(false);
    expect(spawned.at(-1)?.instructions).toContain('workflow "Codex run"');
  });

  it("starts a session as it always has where the project follows no workflow", async () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: { [P]: null } });
    const session = create(P, null, "claude-code");
    expect(session.workflow).toBeNull();
    await launch(session.key, 80, 24, () => {});
    expect(spawned.at(-1)).not.toHaveProperty("instructions");
    expect(spawned.at(-1)).not.toHaveProperty("startOnly");
    expect(spawned.at(-1)?.model).toBeUndefined();
  });

  it("keeps its workflow while it runs, and resumed takes the workflow's version of the day, told afresh", async () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: {} });
    const session = create(P);
    await launch(session.key, 80, 24, () => {});
    // The workflow is changed in the settings while the session runs: its
    // orchestrator's model, and the model its work runs on.
    const changed = { ...defaultWorkflow(), orchestrator: { agent: "claude-code" as const, model: "haiku" } };
    changed.steps = structuredClone(changed.steps);
    changed.steps[0].models = [{ agent: "claude-code", model: "haiku" }];
    adoptWorkflows({ list: [changed], default: "Build and review", overrides: {} });
    expect(byKey(session.key)?.workflow?.orchestrator.model).toBe("fable");
    close(session.key);

    // Resumed from the past sessions after a restart, it follows the
    // workflow by name as it is now, though the project follows none.
    reset();
    adoptWorkflows({ list: [changed], default: null, overrides: {} });
    loadRemembered();
    const resumed = create(P, "sid-1", "claude-code");
    await launch(resumed.key, 80, 24, () => {});
    expect(byKey(resumed.key)?.workflow).toEqual(changed);
    expect(byKey(resumed.key)?.workflowGone).toBe(false);
    expect(spawned.at(-1)).toMatchObject({
      session: "sid-1",
      model: "haiku",
      instructions: orchestratorPrompt(changed),
      afresh: true,
    });
    // What it was first told stays what its conversation was first told.
    expect(sessions.workflows["sid-1"].told).toBe(orchestratorPrompt(defaultWorkflow()));

    // Resumed again with the workflow as the conversation was first told
    // it, nothing is told afresh.
    close(resumed.key);
    adoptWorkflows({ list: [defaultWorkflow()], default: null, overrides: {} });
    const again = create(P, "sid-1", "claude-code");
    await launch(again.key, 80, 24, () => {});
    expect(spawned.at(-1)).not.toHaveProperty("afresh");
  });

  it("follows the copy it kept of a workflow deleted since, and says so", async () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: {} });
    const session = create(P);
    await launch(session.key, 80, 24, () => {});
    close(session.key);
    adoptWorkflows({ list: [], default: null, overrides: {} });
    const resumed = create(P, "sid-1", "claude-code");
    await launch(resumed.key, 80, 24, () => {});
    expect(byKey(resumed.key)?.workflow).toEqual(defaultWorkflow());
    expect(byKey(resumed.key)?.workflowGone).toBe(true);
    expect(spawned.at(-1)?.instructions).toBe(orchestratorPrompt(defaultWorkflow()));
  });

  it("asks the user when the workflow is gone and its copy no longer reads, and resumes without one on their word", async () => {
    sessions.workflows["old"] = {
      workflow: { name: "Gone", orchestrator: { agent: "claude-code", model: "fable" }, steps: [] },
      told: "1. Direct the work.",
      project: P,
    };
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: {} });
    const resumed = create(P, "old", "claude-code");
    expect(await launch(resumed.key, 80, 24, () => {})).toBe(false);
    expect(spawned).toHaveLength(0);
    const row = byKey(resumed.key)!;
    expect(row.status).toBe("failed");
    expect(row.workflowLost).toBe("Gone");
    expect(statusMessage(row)).toContain('followed the workflow "Gone", which is gone');
    // It has not started: it waits on the user's word, and says so.
    expect(statusLabel(row)).toBe("waiting for your choice");
    // A shell opened beside the row goes on beside the one resumed in its
    // place, with its number.
    const shell = createShell({ project: P, session: row.key });
    shellStarted(shell.key, "pty-beside");
    const without = resumeWithout(row.key)!;
    expect(byKey(row.key)).toBeNull();
    expect(shellByKey(shell.key)).toMatchObject({ session: without.key, ordinal: 1 });
    expect(killed).not.toContain("pty-beside");
    await launch(without.key, 80, 24, () => {});
    expect(spawned.at(-1)).toMatchObject({ session: "old" });
    expect(spawned.at(-1)).not.toHaveProperty("instructions");
    // Its conversation was first given the workflow's instructions, which
    // the agent would go on giving itself: it is told to let go of them.
    expect(spawned.at(-1)).toMatchObject({ afresh: true });
    // The user's word is kept: resumed again, as after the window reloads,
    // it follows none without asking, and is still told afresh.
    expect(JSON.parse(localStorage.getItem("chord.workflows")!).old).toEqual({
      workflow: null,
      told: "1. Direct the work.",
      project: P,
    });
    close(without.key);
    const again = create(P, "old", "claude-code");
    expect(await launch(again.key, 80, 24, () => {})).toBe(true);
    expect(byKey(again.key)?.workflowLost).toBeNull();
    expect(byKey(again.key)?.workflow).toBeNull();
    expect(spawned.at(-1)).toMatchObject({ session: "old", afresh: true });
    expect(spawned.at(-1)).not.toHaveProperty("instructions");
    // A session never given a workflow is resumed as it always was.
    const plain = create(P, "never", "claude-code");
    await launch(plain.key, 80, 24, () => {});
    expect(spawned.at(-1)).toMatchObject({ session: "never" });
    expect(spawned.at(-1)).not.toHaveProperty("afresh");
  });

  it("lets go of what is kept for a session gone from its project's history", async () => {
    sessions.workflows["gone"] = { workflow: defaultWorkflow(), told: null, project: P };
    sessions.workflows["here"] = { workflow: defaultWorkflow(), told: null, project: P };
    sessions.workflows["elsewhere"] = { workflow: defaultWorkflow(), told: null, project: "/other" };
    sessions.workflows["old"] = { workflow: defaultWorkflow(), told: null, project: P };
    // Their tokens, but for the one from before there were tokens, whose
    // token is its id; and a session with no workflow, gone as well.
    for (const id of ["gone", "here", "elsewhere", "plain"])
      sessions.tokens[id] = { token: `token-${id}`, project: id === "elsewhere" ? "/other" : P };
    historyAnswer = [{ id: "here", title: "Still here", modified: 1, size: 100, cwd: null }];
    const heard: string[][] = [];
    onForgotten((tokens) => heard.push(tokens));
    await loadHistory(P);
    onForgotten(null);
    expect(Object.keys(sessions.workflows).sort()).toEqual(["elsewhere", "here"]);
    expect(Object.keys(sessions.tokens).sort()).toEqual(["elsewhere", "here"]);
    // What their workflows ran, kept under their tokens, is let go of with
    // them.
    // So is what a session from before there were tokens kept under its id.
    expect(heard.map((tokens) => [...tokens].sort())).toEqual([
      ["gone", "old", "plain", "token-gone", "token-plain"],
    ]);
    expect(JSON.parse(localStorage.getItem("chord.workflows")!)).not.toHaveProperty("gone");
    expect(Object.keys(JSON.parse(localStorage.getItem("chord.tokens")!)).sort()).toEqual(["elsewhere", "here"]);
  });

  it("lets go of nothing kept while one source of history cannot be read", async () => {
    sessions.workflows["gone"] = { workflow: defaultWorkflow(), told: null, project: P };
    sessions.tokens["gone"] = { token: "token-gone", project: P };
    historyAnswer = [{ id: "here", title: "Still here", modified: 1, size: 100, cwd: null }];
    const heard: string[][] = [];
    onForgotten((tokens) => heard.push(tokens));
    unreadable = "codex";
    try {
      await loadHistory(P);
    } finally {
      unreadable = null;
    }
    onForgotten(null);
    expect(sessions.history[P]?.map((entry) => entry.id)).toEqual(["here"]);
    expect(Object.keys(sessions.workflows)).toEqual(["gone"]);
    expect(Object.keys(sessions.tokens)).toEqual(["gone"]);
    expect(heard).toEqual([]);
    // Read whole, it goes.
    await loadHistory(P);
    expect(sessions.tokens).toEqual({});
  });

  it("gives a session started with no workflow none, whatever its project follows", () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: "Build and review", overrides: {} });
    const session = create(P, null, "claude-code", null, "go", "sonnet", null, null);
    expect(session.workflow).toBeNull();
    expect(session.model).toBe("sonnet");
  });
});

describe("marking a session unread", () => {
  /** Two sessions in one project, the second behind the first. */
  const pair = () => {
    const front = live(A, "pty-1");
    const behind = live(A, "pty-2");
    select(front.key);
    return { front, behind };
  };

  /** The user puts a session on screen in a focused window. */
  const look = (key: string) => {
    select(key);
    onScreenNow(key);
    viewed(key);
  };

  it("shows the last line the agent left, says nothing, and reads on the next look", () => {
    const told: string[] = [];
    onWaiting((session) => told.push(session.key));
    try {
      const { front, behind } = pair();
      noted(behind.key, "Plugin in main-truck staged, need approvals");
      look(behind.key);
      look(front.key);
      expect(behind.unread).toBe(false);
      expect(behind.note).toBeNull();
      expect(told).toEqual([behind.key]);

      markUnread(behind.key);
      expect(behind.unread).toBe(true);
      expect(behind.note).toBe("Plugin in main-truck staged, need approvals");
      expect(unreadCount()).toBe(1);
      expect(byStatus()[0].sessions.map((session) => session.key)).toEqual([behind.key]);
      expect(waitingOnYou().map((session) => session.key)).toEqual([behind.key]);
      expect(told).toEqual([behind.key]);

      look(behind.key);
      expect(behind.unread).toBe(false);
      expect(behind.note).toBeNull();
    } finally {
      onWaiting(null);
    }
  });

  it("shows the line a turn ended on, and none once a new turn begins", () => {
    const { front, behind } = pair();
    exact("session-pty-2", "prompt");
    exact("session-pty-2", "stop", "Second answer.");
    look(behind.key);
    look(front.key);
    markUnread(behind.key);
    expect(behind.note).toBe("Second answer.");

    markRead(behind.key);
    expect(behind.unread).toBe(false);
    expect(behind.note).toBeNull();

    exact("session-pty-2", "prompt");
    markUnread(behind.key);
    expect(behind.unread).toBe(true);
    expect(behind.note).toBeNull();
  });

  it("keeps the session on screen unread until another is on screen and it comes back", () => {
    const { front, behind } = pair();
    noted(behind.key, "Over to you.");
    look(behind.key);
    markUnread(behind.key);
    expect(behind.unread).toBe(true);
    expect(behind.note).toBe("Over to you.");

    // Still looking: the window losing focus and gaining it again, or the
    // row picked again, reads nothing.
    attention.focused = false;
    onScreenNow(behind.key);
    attention.focused = true;
    look(behind.key);
    expect(behind.unread).toBe(true);

    // Away to another and back.
    look(front.key);
    expect(behind.unread).toBe(true);
    look(behind.key);
    expect(behind.unread).toBe(false);
  });

  it("lets a mark on the session on screen go when it is marked read", () => {
    const { behind } = pair();
    look(behind.key);
    markUnread(behind.key);
    markRead(behind.key);
    markUnread(behind.key);
    markRead(behind.key);
    look(behind.key);
    expect(behind.unread).toBe(false);
  });

  it("announces what happens after a mark with its own line, but not an idle notice", () => {
    const told: string[] = [];
    onWaiting((session) => told.push(session.key));
    try {
      const { front, behind } = pair();
      exact("session-pty-2", "prompt");
      exact("session-pty-2", "stop", "First turn line.");
      look(behind.key);
      look(front.key);
      told.length = 0;

      markUnread(behind.key);
      expect(behind.note).toBe("First turn line.");
      exact("session-pty-2", "idle");
      expect(told).toEqual([]);
      expect(behind.note).toBe("First turn line.");

      // A turn of its own, as when a background task ends: no prompt.
      exact("session-pty-2", "stop", "Background job done.");
      expect(told).toEqual([behind.key]);
      expect(behind.note).toBe("Background job done.");
      expect(bodyFor(behind)).toBe("Background job done.");

      // Unread by now, the next line is no news, as without a mark.
      noted(behind.key, "Need the API key");
      expect(told).toEqual([behind.key]);
      expect(behind.note).toBe("Need the API key");
      expect(bodyFor(behind)).toBe("Need the API key");
    } finally {
      onWaiting(null);
    }
  });

  it("announces a line left through notify over a mark with that line", () => {
    const told: string[] = [];
    onWaiting((session) => told.push(session.key));
    try {
      const { front, behind } = pair();
      noted(behind.key, "Old line.");
      look(behind.key);
      look(front.key);
      told.length = 0;
      markUnread(behind.key);
      noted(behind.key, "New line.");
      expect(told).toEqual([behind.key]);
      expect(bodyFor(behind)).toBe("New line.");
    } finally {
      onWaiting(null);
    }
  });

  it("lets the hold go when the user writes to the session marked on screen", () => {
    const { behind } = pair();
    exact("session-pty-2", "prompt");
    exact("session-pty-2", "stop", "Done.");
    look(behind.key);
    markUnread(behind.key);

    // The user types a prompt into it: read, and the mark is over.
    exact("session-pty-2", "prompt");
    expect(behind.unread).toBe(false);
    attention.focused = false;
    exact("session-pty-2", "stop", "Done again.");
    expect(behind.unread).toBe(true);

    // Back to the window with it still on screen: read.
    attention.focused = true;
    viewed(behind.key);
    expect(behind.unread).toBe(false);
  });

  it("keeps a mark through a director's prompt and its stop, until the user comes back", () => {
    onDirected(() => true);
    try {
      const { front, behind } = pair();
      exact("session-pty-2", "prompt");
      exact("session-pty-2", "stop", "First.");
      look(behind.key);
      look(front.key);
      markUnread(behind.key);

      exact("session-pty-2", "prompt");
      expect(behind.unread).toBe(true);
      expect(behind.note).toBeNull();
      exact("session-pty-2", "stop", "Second.");
      expect(behind.unread).toBe(true);
      expect(behind.note).toBe("Second.");

      look(behind.key);
      expect(behind.unread).toBe(false);
    } finally {
      onDirected(null);
    }
  });

  it("forgets an earlier turn's line once the agent is seen at work, without hooks", () => {
    vi.useFakeTimers();
    try {
      const { front, behind } = pair();
      typed(behind.ptyId!, "hello\r");
      noted(behind.key, "Ready for review");
      look(behind.key);
      look(front.key);
      for (let i = 0; i < WORK_WINDOWS + 1; i += 1) {
        if (i > 0) vi.advanceTimersByTime(1010);
        output(behind.key, WORK_BYTES, Date.now(), true);
      }
      expect(behind.working).toBe(true);
      vi.advanceTimersByTime(QUIET_MS + 10);
      look(behind.key);
      look(front.key);
      markUnread(behind.key);
      expect(behind.unread).toBe(true);
      expect(behind.note).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a session another started, an ended one and one left from the last quit", () => {
    onDirected(() => true);
    try {
      const { behind } = pair();
      markUnread(behind.key);
      expect(behind.unread).toBe(true);
    } finally {
      onDirected(null);
    }
    const ending = live(A, "pty-3");
    select(sessions.all[0].key);
    ended({ id: "pty-3", code: 0, clean: true });
    markRead(ending.key);
    markUnread(ending.key);
    expect(ending.unread).toBe(true);

    const dormant = reopened(A, "old-1", "claude-code", null, null, null);
    markUnread(dormant.key);
    expect(dormant.unread).toBe(true);
    expect(dormant.status).toBe("dormant");
    expect(unreadCount()).toBe(3);
  });
});
