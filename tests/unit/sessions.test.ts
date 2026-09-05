import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyDetect, resetAgent } from "$lib/agent.svelte";
import { stash } from "$lib/exits";
import { attention, resetAttention } from "$lib/attention.svelte";
import {
  activeSession,
  ago,
  historyFor,
  historyLabel,
  isMine,
  isViewed,
  exact,
  loadRemembered,
  output,
  QUIET_MS,
  rang,
  unreadCount,
  viewed,
  WORK_BYTES,
  located,
  outsideFor,
  followCwd,
  sessionTitle,
  titled,
  byKey,
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
  liveCount,
  reset,
  select,
  sessions,
  started,
  statusLabel,
  statusMessage,
} from "$lib/sessions.svelte";

const A = "/home/ada/dev/one";
const B = "/home/ada/dev/two";

const killed: string[] = [];
let historyReads = 0;
let cwdAnswer: string | null = null;
let cwdAsks = 0;
vi.mock("$lib/core", () => ({
  core: () => ({
    kill: async (id: string) => {
      killed.push(id);
    },
    ptyCwd: async () => {
      cwdAsks += 1;
      return cwdAnswer;
    },
    // The repository of a path is its nearest worktree: the directory itself
    // here, or the parent for anything ending in "/inside".
    projectInfo: async (path: string) => {
      if (path === "/broken") throw new Error("gone");
      const repository = path.endsWith("/inside") ? path.slice(0, -"/inside".length) : path;
      return { path, name: path, repository, isGit: true };
    },
    // Every agent is asked; the count follows one of them.
    transcripts: async (_project: string, agent: string) => {
      if (agent === "claude-code") historyReads += 1;
      return [];
    },
  }),
}));

beforeEach(() => {
  reset();
  resetAttention();
  killed.length = 0;
  historyReads = 0;
  cwdAnswer = null;
  cwdAsks = 0;
  resetAgent();
  applyDetect({ id: "claude-code", path: "/usr/local/bin/claude", caps: null, fromLoginShell: true }, true);
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

  it("remembers which sessions are ours across a restart", () => {
    const session = create(A);
    started(session.key, "pty-1", "kept");
    reset();
    expect(isMine(A, "kept")).toBe(false);
    loadRemembered();
    expect(isMine(A, "kept")).toBe(true);
  });

  it("survives a corrupt record of what is ours", () => {
    localStorage.setItem("workbench.mine", "{not json");
    expect(() => loadRemembered()).not.toThrow();
    localStorage.setItem("workbench.mine", JSON.stringify({ [A]: ["ok", 7] }));
    loadRemembered();
    expect(isMine(A, "ok")).toBe(true);
  });

  it("has nothing for a project it has not read", () => {
    expect(historyFor("/unread")).toEqual([]);
  });

  // A transcript already open as a live session is that session, not a
  // separate row offering to open it again.
  it("hides a transcript that is already resumed", () => {
    sessions.history[A] = [transcript("abc", "one", 1000), transcript("def", "two", 900)];
    create(A, "abc");
    expect(outsideFor(A).map((t) => t.id)).toEqual(["def"]);
  });

  // A fresh session writes a transcript as it goes. That transcript is the
  // live row, not a past session offering to open itself again.
  it("hides the transcript a live session is writing", () => {
    sessions.history[A] = [transcript("fresh", "one", 1000), transcript("def", "two", 900)];
    const session = create(A);
    started(session.key, "pty-1", "fresh");
    expect(historyFor(A)).toEqual([]);
    expect(outsideFor(A).map((t) => t.id)).toEqual(["def"]);
  });

  it("uses the title when there is one", () => {
    expect(historyLabel(transcript("abc", "rename the cache", 1000))).toBe("rename the cache");
  });

  // The format is documented as internal and version-unstable, so a title that
  // could not be read falls back rather than showing an error.
  it("falls back to recency when the title could not be read", () => {
    const now = Date.now();
    const label = historyLabel(transcript("abc", null, Math.floor(now / 1000) - 7200));
    expect(label).toContain("session from");
    expect(label).toContain("2h ago");
  });

  it("treats an empty title as no title", () => {
    expect(historyLabel(transcript("abc", "", 1000))).toContain("session from");
  });
});

describe("ago", () => {
  const now = 1_000_000_000_000;
  const at = (secondsAgo: number) => ago(Math.floor(now / 1000) - secondsAgo, now);

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

  it("ignores an identification for a pty it does not have", () => {
    expect(() => identified("pty-9", "cx", null)).not.toThrow();
  });

  it("starts with the agent last started in the project", () => {
    applyDetect({ id: "codex", path: "/usr/local/bin/codex", caps: null, fromLoginShell: true }, true);
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

describe("titles", () => {
  it.each([
    ["✳ fix-activity-tracking-bugs", "fix-activity-tracking-bugs"],
    ["✻ fix-activity-tracking-bugs · Claude Code", "fix-activity-tracking-bugs"],
    ["fix-activity-tracking-bugs - Claude Code", "fix-activity-tracking-bugs"],
    ["Claude Code · rename the cache", "rename the cache"],
    ["  rename the cache  ", "rename the cache"],
  ])("reads the session's name out of %j", (raw, expected) => {
    expect(sessionTitle(raw)).toBe(expected);
  });

  // The agent names itself before it names the session. That is not a title.
  it.each(["Claude Code", "✳ Claude Code", "claude", "", "✳ "])("takes %j as no title", (raw) => {
    expect(sessionTitle(raw)).toBeNull();
  });

  it("labels the row with the title once the agent sets one", () => {
    const session = live(A, "pty-1");
    expect(label(session)).toBe("session 1");
    titled(session.key, "✳ fix-activity-tracking-bugs");
    expect(label(session)).toBe("fix-activity-tracking-bugs");
    titled(session.key, "Claude Code");
    expect(label(session)).toBe("session 1");
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
      { id: "session-pty-1", title: "a summary", modified: 1000, size: 1, agent: "claude-code" },
    ];
    expect(historyLabel(sessions.history[A][0])).toBe("fix-activity-tracking-bugs");

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

  it("does not remember the agent's own name as a session's", () => {
    const session = live(A, "pty-1");
    titled(session.key, "Claude Code");
    expect(sessions.names).toEqual({});
  });
});

describe("where the session works", () => {
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
  it("is working while more than a redraw's worth of bytes flows", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      output(session.key, WORK_BYTES - 1);
      expect(session.working).toBe(false);
      output(session.key, 1);
      expect(session.working).toBe(true);
      expect(statusLabel(session)).toBe("working");
    } finally {
      vi.useRealTimers();
    }
  });

  it("is waiting after a stretch of quiet, and seen if it was on screen", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      output(session.key, WORK_BYTES);
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
      select(other.key);
      output(busy.key, WORK_BYTES);
      output(busy.key, WORK_BYTES);
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
      attention.focused = false;
      expect(isViewed(session)).toBe(false);
      output(session.key, WORK_BYTES);
      vi.advanceTimersByTime(QUIET_MS + 10);
      expect(session.unread).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps working while bytes keep coming", () => {
    vi.useFakeTimers();
    try {
      const session = live(A, "pty-1");
      output(session.key, WORK_BYTES);
      vi.advanceTimersByTime(QUIET_MS / 2);
      output(session.key, 10);
      vi.advanceTimersByTime(QUIET_MS / 2 + 10);
      expect(session.working).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

      // Granted: output means it went on.
      output(behind.key, WORK_BYTES);
      expect(behind.needs).toBeNull();
      expect(behind.working).toBe(true);
      vi.advanceTimersByTime(QUIET_MS * 3);
      expect(behind.working).toBe(true);

      exact("session-pty-1", "stop");
      expect(behind.working).toBe(false);
      expect(statusLabel(behind)).toBe("waiting for you");
      viewed(behind.key);
      exact("session-pty-1", "idle");
      expect(behind.unread).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a session the user prompted, and ignores an id it does not have", () => {
    const session = live(A, "pty-1");
    session.unread = true;
    exact("session-pty-1", "prompt");
    expect(session.unread).toBe(false);
    expect(() => exact("nope", "stop")).not.toThrow();
  });

  it("does nothing for a key it does not have", () => {
    expect(() => output("nope", 999)).not.toThrow();
    expect(() => rang("nope")).not.toThrow();
    expect(() => viewed("nope")).not.toThrow();
  });
});
