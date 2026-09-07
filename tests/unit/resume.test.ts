import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import Resume from "$lib/components/Resume.svelte";
import {
  closeResume,
  offered,
  openResume,
  pickResume,
  resetResume,
  resume,
} from "$lib/resume.svelte";
import {
  reset as resetSessions,
  sessions,
  loadHistory,
} from "$lib/sessions.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";
import { layout } from "$lib/layout.svelte";

const fake = {
  transcripts: [] as {
    id: string;
    title: string | null;
    modified: number;
    size: number;
    cwd?: string | null;
  }[],
};

vi.mock("$lib/core", () => ({
  core: () => ({
    transcripts: async (_project: string, agent: string) =>
      agent === "claude-code" ? fake.transcripts : [],
    spawn: async () => ({ ptyId: "pty-1", sessionId: null }),
    kill: async () => {},
  }),
}));

const repo = (path: string, name: string) => ({
  path,
  name,
  repository: path,
  isGit: true,
});

beforeEach(async () => {
  resetSessions();
  resetWorkspace();
  resetResume();
  workspace.open.push(repo("/repo", "repo"));
  workspace.active = "/repo";
  fake.transcripts = [
    {
      id: "aaa-1",
      title: "Gerrit integration",
      modified: 1000,
      size: 10,
      cwd: "/repo/.claude/worktrees/gerrit-integration",
    },
    { id: "bbb-2", title: "fix github login", modified: 900, size: 10 },
    { id: "ccc-3", title: null, modified: 800, size: 10 },
  ];
  await loadHistory("/repo");
});

describe("the sessions to resume", () => {
  it("lists them newest first, with where each ran, and narrows by every word", async () => {
    openResume("/repo", "claude-code");
    render(Resume);
    expect(screen.getByTestId("resume-filter")).toHaveFocus();
    expect(screen.getAllByTestId("resume-row")).toHaveLength(3);
    expect(screen.getByTestId("resume").querySelector("h2")).toHaveTextContent(
      "repo: 3 claude sessions to resume",
    );
    expect(screen.getByTestId("session-where")).toHaveTextContent(
      "gerrit-integration",
    );

    await fireEvent.input(screen.getByTestId("resume-filter"), {
      target: { value: "GERRIT" },
    });
    expect(screen.getAllByTestId("resume-row")).toHaveLength(1);
    // The worktree's name counts as much as the title.
    await fireEvent.input(screen.getByTestId("resume-filter"), {
      target: { value: "integration gerrit" },
    });
    expect(screen.getAllByTestId("resume-row")).toHaveLength(1);
    await fireEvent.input(screen.getByTestId("resume-filter"), {
      target: { value: "nothing here" },
    });
    expect(screen.queryByTestId("resume-row")).toBeNull();
    expect(screen.getByText("Nothing matches.")).toBeInTheDocument();
  });

  it("resumes the picked one where it ran, from a click or the keyboard", async () => {
    openResume("/repo", "claude-code");
    render(Resume);
    await fireEvent.click(screen.getAllByTestId("resume-row")[0]);
    expect(resume.open).toBe(false);
    expect(sessions.all).toHaveLength(1);
    expect(sessions.all[0].resumedFrom).toBe("aaa-1");
    expect(sessions.all[0].startIn).toBe(
      "/repo/.claude/worktrees/gerrit-integration",
    );
    expect(layout.focus).toBe("agent");

    openResume("/repo", "claude-code");
    // The one just started is live now, so two are left.
    expect(offered().map((entry) => entry.id)).toEqual(["bbb-2", "ccc-3"]);
    const dialog = screen.getByTestId("resume");
    await fireEvent.keyDown(dialog, { key: "ArrowDown" });
    await fireEvent.keyDown(dialog, { key: "Enter" });
    expect(sessions.all.map((session) => session.resumedFrom)).toEqual([
      "aaa-1",
      "ccc-3",
    ]);
    expect(sessions.all[1].startIn).toBeNull();
  });

  it("closes on Escape", async () => {
    openResume("/repo", "claude-code");
    render(Resume);
    await fireEvent.keyDown(screen.getByTestId("resume"), { key: "Escape" });
    expect(resume.open).toBe(false);
    closeResume();
    pickResume;
  });
});
