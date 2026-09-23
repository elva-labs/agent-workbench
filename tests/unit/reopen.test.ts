import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conductor, resetConductor } from "$lib/conductor.svelte";
import { reopen } from "$lib/reopen.svelte";
import {
  activeSession,
  close,
  create,
  ended,
  forProject,
  isLive,
  reset as resetSessions,
  sessions,
  started,
  statusLabel,
  wake,
} from "$lib/sessions.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

vi.mock("$lib/core", () => ({
  core: () => ({
    kill: async () => {},
    projectInfo: async (path: string) => ({
      path,
      name: path,
      repository: path,
      isGit: true,
    }),
    transcripts: async () => [],
  }),
}));

const A = "/home/ada/dev/one";
const B = "/home/ada/dev/two";
const KEY = "workbench.open";

const repo = (path: string) => ({ path, name: path, repository: path, isGit: true });

let stop: () => void = () => {};

beforeEach(() => {
  resetSessions();
  resetWorkspace();
  resetConductor();
  workspace.open.push(repo(A), repo(B));
  workspace.active = A;
});

afterEach(() => stop());

/** What is on record for the next start. */
function record(): { open: { project: string; id: string }[]; active: string | null } {
  return JSON.parse(localStorage.getItem(KEY) ?? "null");
}

/** A session that has come up with an id, as one does in practice. */
function live(project: string, id: string) {
  const session = create(project);
  started(session.key, `pty-${id}`, id);
  return session;
}

describe("keeping the record", () => {
  it("records the live sessions and the one on screen", () => {
    stop = reopen();
    live(A, "one");
    live(B, "two");
    flushSync();
    expect(record().open.map((entry) => entry.id)).toEqual(["one", "two"]);
    expect(record().active).toBe("two");
  });

  it("takes a session closed by hand off the record", () => {
    stop = reopen();
    const one = live(A, "one");
    live(A, "two");
    close(one.key);
    flushSync();
    expect(record().open.map((entry) => entry.id)).toEqual(["two"]);
  });

  it("takes a session that ended off the record", () => {
    stop = reopen();
    live(A, "one");
    ended({ id: "pty-one", code: 0, clean: true });
    flushSync();
    expect(record().open).toEqual([]);
  });

  it("leaves out a session another session started", () => {
    stop = reopen();
    live(A, "caller");
    const child = live(B, "child");
    conductor.startedBy[child.key] = "caller";
    flushSync();
    expect(record().open.map((entry) => entry.id)).toEqual(["caller"]);
  });

  it("keeps where a session was started and on which model", () => {
    stop = reopen();
    const session = create(A, "one", "claude-code", "/home/ada/dev/one/tree", null, "opus");
    started(session.key, "pty-1", "one");
    flushSync();
    expect(record().open[0]).toEqual({
      project: A,
      id: "one",
      agent: "claude-code",
      startIn: "/home/ada/dev/one/tree",
      model: "opus",
    });
  });
});

describe("coming back", () => {
  function onRecord(open: object[], active: string | null) {
    localStorage.setItem(KEY, JSON.stringify({ open, active }));
  }

  const entry = (project: string, id: string) => ({
    project,
    id,
    agent: "claude-code",
    startIn: null,
    model: null,
  });

  it("brings each back as a row with nothing running behind it", () => {
    onRecord([entry(A, "one"), entry(A, "two"), entry(B, "three")], "one");
    stop = reopen();
    expect(forProject(A).map((session) => session.id)).toEqual(["one", "two"]);
    expect(forProject(B).map((session) => session.id)).toEqual(["three"]);
    for (const session of sessions.all) {
      expect(session.status).toBe("dormant");
      expect(session.resumedFrom).toBe(session.id);
      expect(isLive(session)).toBe(false);
    }
  });

  it("puts the one that was on screen back on screen", () => {
    onRecord([entry(A, "one"), entry(A, "two")], "one");
    stop = reopen();
    expect(activeSession()?.id).toBe("one");
  });

  it("falls back to the front project's most recent", () => {
    onRecord([entry(A, "one"), entry(A, "two"), entry(B, "three")], "three");
    stop = reopen();
    expect(activeSession()?.id).toBe("two");
  });

  it("brings back the name a session had", () => {
    sessions.names.one = "the refactor";
    onRecord([entry(A, "one")], null);
    stop = reopen();
    expect(forProject(A)[0].title).toBe("the refactor");
  });

  it("leaves out a session whose project is not open", () => {
    onRecord([entry("/gone", "one"), entry(A, "two")], null);
    stop = reopen();
    expect(sessions.all.map((session) => session.id)).toEqual(["two"]);
  });

  it("keeps a row that never started on the record", () => {
    onRecord([entry(A, "one"), entry(A, "two")], "two");
    stop = reopen();
    flushSync();
    expect(record().open.map((item) => item.id)).toEqual(["one", "two"]);
  });

  it("reads a corrupt record as nothing open", () => {
    localStorage.setItem(KEY, "{not json");
    stop = reopen();
    expect(sessions.all).toEqual([]);
  });

  it("drops entries it cannot read and keeps the rest", () => {
    onRecord([{ project: A, id: 7 }, entry(A, "two")], null);
    stop = reopen();
    expect(sessions.all.map((session) => session.id)).toEqual(["two"]);
  });
});

describe("waking", () => {
  it("starts a dormant row as a resumed session", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        open: [{ project: A, id: "one", agent: "claude-code", startIn: null, model: null }],
        active: null,
      }),
    );
    stop = reopen();
    const session = forProject(A)[0];
    expect(statusLabel(session)).toBe("was open, starts when selected");
    wake(session.key);
    expect(session.status).toBe("starting");
    expect(session.resumedFrom).toBe("one");
  });

  it("leaves a row that is already going alone", () => {
    const session = live(A, "one");
    wake(session.key);
    expect(session.status).toBe("running");
  });
});
