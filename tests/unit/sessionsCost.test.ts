import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { cleanup, render } from "@testing-library/svelte";

vi.mock("$lib/core", () => ({
  core: () => ({
    transcripts: async () => [],
    kill: async () => {},
    projectInfo: async (path: string) => ({ path, name: path, repository: path, isGit: true }),
    setWindowTitle: async () => {},
    hookStatus: async () => ({ installed: false, settings: "", events: "" }),
  }),
}));

import SessionsPane from "$lib/panes/SessionsPane.svelte";
import { create, reopened, reset as resetSessions, sessions, started } from "$lib/sessions.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";
import { conductor, resetConductor } from "$lib/conductor.svelte";
import { applyDetect, resetAgent } from "$lib/agent.svelte";
import { resetProjects } from "$lib/projects.svelte";

/** A window of the given number of projects, each with three live rows and
    two left from the last quit, and one session in each started by the
    first row of all. */
function stage(projects: number) {
  resetSessions();
  resetWorkspace();
  resetConductor();
  resetProjects();
  for (let p = 0; p < projects; p++) {
    const path = `/work/project-${p}`;
    workspace.open.push({ path, name: path, repository: path, isGit: true });
    for (let s = 0; s < 3; s++) {
      const live = create(path, null, "claude-code", null, null, "claude-opus-4-1");
      started(live.key, `pty-${p}-${s}`, `sid-${p}-${s}`);
    }
    for (let s = 0; s < 2; s++) reopened(path, `t-${p}-${s}`, "claude-code", null, null, null);
  }
  workspace.active = "/work/project-0";
  const starter = sessions.all[0];
  for (let p = 0; p < projects; p++) {
    const kid = create(`/work/project-${p}`, null, "claude-code", null, null, "sonnet");
    started(kid.key, `pty-kid-${p}`, `kid-${p}`);
    conductor.startedBy[kid.key] = starter.id!;
  }
}

/** How long the pane takes to follow one row starting or ending a turn:
    the median of a few. */
function turn(): number {
  render(SessionsPane);
  flushSync();
  const row = sessions.all[sessions.all.length - 4];
  const took: number[] = [];
  for (let i = 0; i < 7; i++) {
    const from = performance.now();
    row.working = !row.working;
    row.changedAt = Date.now() + i;
    flushSync();
    took.push(performance.now() - from);
  }
  cleanup();
  return took.sort((a, b) => a - b)[3];
}

afterEach(() => {
  cleanup();
  resetSessions();
  resetWorkspace();
  resetConductor();
  resetAgent();
});

describe("the sessions pane's cost", () => {
  // A row changing redraws what it changes, and works out where each row
  // stands once for all of them: four times the rows cost about four times
  // as much, not sixteen or sixty-four.
  it("grows with the rows, not with their square", () => {
    applyDetect({ id: "claude-code", path: "/usr/local/bin/claude", caps: null, fromLoginShell: true }, true);
    stage(12);
    const few = turn();
    stage(48);
    const many = turn();
    expect(many / few).toBeLessThan(8);
  }, 300_000);
});
