import { beforeEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/svelte";
import SessionsPane from "$lib/panes/SessionsPane.svelte";
import ChangesPane from "$lib/panes/ChangesPane.svelte";
import {
  DEFAULT,
  focusPane,
  layout,
  returnFocus,
  togglePane,
} from "$lib/layout.svelte";
import { files, refresh, clear as clearFiles } from "$lib/files.svelte";

/** Stands in for git. Reassigned per test rather than mocked per call. */
const fake = {
  status: [] as {
    path: string;
    status: string;
    add: number;
    del: number;
    binary: boolean;
  }[],
  fileList: [] as string[],
  transcripts: [] as {
    id: string;
    title: string | null;
    modified: number;
    size: number;
  }[],
  codexTranscripts: [] as {
    id: string;
    title: string | null;
    modified: number;
    size: number;
  }[],
  hookInstalled: false,
  picked: 0,
  controls: [] as string[],
  /** The projects each history request asked for, in order. */
  read: [] as string[][],
};

vi.mock("$lib/core", () => ({
  core: () => ({
    pickProject: async () => {
      fake.picked += 1;
      return null;
    },
    gitStatus: async () => fake.status,
    gitFiles: async () => fake.fileList,
    gitGrep: async (_root: string, query: string) => ({
      hits:
        query === ""
          ? []
          : [{ path: "src/lib.rs", line: 4, text: `found ${query} here` }],
      truncated: false,
    }),
    gitDiff: async () => ({
      lines: [{ kind: "hunk", text: "@@ -1,9 +1,12 @@", old: null, new: null }],
      binary: false,
      truncated: false,
    }),
    gitContent: async () => ({
      lines: ["use std::collections::HashMap;"],
      binary: false,
      truncated: false,
    }),
    gitWatch: async () => {},
    onGitChanged: async () => () => {},
    watchShown: async () => {},
    onShownChanged: async () => () => {},
    kill: async () => {},
    transcripts: async (_project: string, agent: string) =>
      agent === "claude-code" ? fake.transcripts : fake.codexTranscripts,
    transcriptsMany: async (projects: string[], agent: string) => {
      fake.read.push(projects);
      return projects.map(() =>
        agent === "claude-code" ? fake.transcripts : fake.codexTranscripts,
      );
    },
    hookStatus: async () => ({
      installed: fake.hookInstalled,
      settings: "",
      events: "",
    }),
    hookInstall: async () => ({ installed: true, settings: "", events: "" }),
    hookUninstall: async () => ({ installed: false, settings: "", events: "" }),
    windowControl: async (action: string) => {
      fake.controls.push(action);
    },
    openAppMenu: async () => {
      fake.controls.push("menu");
    },
    setWindowTitle: async () => {},
    projectInfo: async (path: string) => ({
      path,
      name: path,
      repository: path,
      isGit: true,
    }),
  }),
}));
import { workspace, reset as resetWorkspace } from "$lib/workspace.svelte";
import { applyDetect, resetAgent } from "$lib/agent.svelte";
import {
  reset as resetSessions,
  create,
  loadRemembered,
  started,
  sessions,
  reopened,
  close as closeStore,
} from "$lib/sessions.svelte";
import { reset as resetHook } from "$lib/hook.svelte";
import { remote, resetRemote } from "$lib/remote.svelte";
import { offered, pickResume, resetResume, resume } from "$lib/resume.svelte";
import { projects, resetProjects, touch } from "$lib/projects.svelte";
import { palette, resetPalette } from "$lib/palette.svelte";
import { settings } from "$lib/settings.svelte";
import { conductor, resetConductor } from "$lib/conductor.svelte";

beforeEach(() => {
  resetRemote();
  resetResume();
  layout.sessions = DEFAULT.sessions;
  layout.changes = DEFAULT.changes;
  layout.review = DEFAULT.review;
  layout.tree = DEFAULT.tree;
  layout.sessionsChosen = true;
  layout.changesChosen = true;
  layout.sessionsForced = false;
  layout.changesForced = false;
  layout.agentHidden = false;
  layout.reviewTouched = false;
  layout.mode = "working";
  layout.focus = "agent";
  layout.width = 1600;
  layout.projectSort = "used";
  resetProjects();
  resetConductor();
  resetPalette();
  settings.open = false;

  files.scope = "changed";
  files.view = "diff";
  files.selected = null;
  files.expanded.clear();
  files.collapsed.clear();

  clearFiles();
  resetWorkspace();
  resetSessions();

  fake.status = [
    { path: "src/cache/mod.rs", status: "M", add: 18, del: 6, binary: false },
    { path: "src/lib.rs", status: "M", add: 2, del: 2, binary: false },
    { path: "src/token_cache.rs", status: "D", add: 0, del: 41, binary: false },
  ];
  fake.transcripts = [];
  fake.codexTranscripts = [];
  fake.hookInstalled = false;
  fake.read = [];
  resetHook();
  fake.fileList = [
    "Cargo.toml",
    "docs/architecture.md",
    "src/cache/eviction.rs",
    "src/cache/mod.rs",
    "src/cache/store.rs",
    "src/git/watcher.rs",
    "src/lib.rs",
    "src/main.rs",
  ];
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

const repo = (path: string, name: string, isGit = true) => ({
  path,
  name,
  repository: isGit ? path : null,
  isGit,
});

const tree = () => screen.getByRole("tree");

/** The pane loads its own data now, so rendering is not the end of it. */
async function renderChanges() {
  render(ChangesPane);
  await waitFor(() =>
    expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(0),
  );
}
const rowNames = () =>
  screen
    .getAllByRole("treeitem")
    .map((el) => el.querySelector(".name")!.textContent!.trim());

describe("Pane shell", () => {
  it("takes focus when pointed at", async () => {
    render(SessionsPane);
    await fireEvent.pointerDown(
      screen.getByRole("region", { name: /projects/i }),
    );
    expect(layout.focus).toBe("sessions");
  });

  it("will not take focus while its pane is closed", async () => {
    // No project here, so the tree stays empty; focus is all this checks.
    togglePane("changes");
    render(ChangesPane);
    await fireEvent.pointerDown(
      screen.getByRole("region", { name: /changes/i }),
    );
    expect(layout.focus).toBe("agent");
  });
});

describe("SessionsPane", () => {
  it("asks for a project when none is open", () => {
    render(SessionsPane);
    expect(screen.getByTestId("no-project")).toBeInTheDocument();
    expect(screen.getByTestId("open-first-project")).toBeInTheDocument();
  });

  it("lists open projects with their sessions", () => {
    workspace.open.push(repo("/home/ada/dev/one", "one"));
    workspace.active = "/home/ada/dev/one";
    const session = create("/home/ada/dev/one");
    started(session.key, "pty-1", "session-1");

    render(SessionsPane);
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("session 1")).toBeInTheDocument();
    // Nothing left for the row: one line, and the dot says what it is
    // doing, in words only for a screen reader.
    const row = screen.getByTestId("session-row");
    expect(row).not.toHaveClass("two");
    expect(row.querySelector(".second")).toBeNull();
    expect(row.querySelector(".state.told")).toHaveTextContent("running");
  });

  // The right pane is entirely git-based, so say so rather than sit there empty.
  it("flags a folder that is not a repository", () => {
    workspace.open.push(repo("/tmp/notes", "notes", false));
    workspace.active = "/tmp/notes";

    render(SessionsPane);
    expect(screen.getByText("no git")).toBeInTheDocument();
  });

  // With codex installed too, the new-session row offers the choice, and
  // every agent's outside sessions are one row of earlier sessions. No row
  // says whose agent it is.
  it("offers both agents and tells their sessions apart", async () => {
    applyDetect(
      {
        id: "codex",
        path: "/usr/local/bin/codex",
        caps: null,
        fromLoginShell: true,
      },
      true,
    );
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    const mine = create("/repo", null, "claude-code");
    started(mine.key, "pty-1", "session-1");
    fake.transcripts = [
      { id: "c1", title: "from a terminal", modified: 1000, size: 400 },
    ];
    fake.codexTranscripts = [
      { id: "x1", title: "Refactor billing", modified: 900, size: 400 },
    ];

    render(SessionsPane);
    expect(screen.queryByTestId("agent-tag")).toBeNull();
    // A new session opens the choice under the project's name, a row per
    // agent.
    await fireEvent.click(screen.getByTestId("new-session"));
    const options = screen.getAllByTestId("agent-option");
    expect(options.map((option) => option.dataset.agent)).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(options[0]).toHaveTextContent("Claude Code");
    expect(options[1]).toHaveTextContent("Codex");

    await waitFor(() =>
      expect(screen.getByTestId("earlier-sessions")).toHaveTextContent("2 earlier sessions"),
    );

    await fireEvent.click(options[1]);
    expect(sessions.all.at(-1)?.agent).toBe("codex");
    expect(layout.focus).toBe("agent");
    expect(screen.queryByTestId("agent-choice")).toBeNull();
    expect(screen.getByTestId("new-session")).toBeInTheDocument();

    // The row opens the list to resume from, every agent's together.
    await fireEvent.click(screen.getByTestId("earlier-sessions"));
    expect(resume.open).toBe(true);
    expect(resume.agent).toBeNull();
    expect(offered().map((entry) => entry.id)).toEqual(["c1", "x1"]);
    pickResume(offered()[1]);
    const resumed = sessions.all.at(-1)!;
    expect(resumed.agent).toBe("codex");
    expect(resumed.resumedFrom).toBe("x1");
    expect(resumed.title).toBeNull();
    expect(resume.open).toBe(false);
  });

  it("picks the agent from the keyboard, Enter opening the choice and Escape closing it", async () => {
    applyDetect(
      {
        id: "codex",
        path: "/usr/local/bin/codex",
        caps: null,
        fromLoginShell: true,
      },
      true,
    );
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    layout.focus = "sessions";

    render(SessionsPane);
    const nav = screen.getByTestId("sessions-nav");
    // The new-session button is the fourth stop: the sort and the menu on
    // the title's row, then the field and the button beside it.
    await fireEvent.keyDown(nav, { key: "Home" });
    for (let step = 0; step < 3; step += 1) await fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(screen.getByTestId("new-session")).toHaveClass("cursor");
    await fireEvent.keyDown(nav, { key: "Enter" });
    // Open under the project's name, with the cursor on its default.
    let options = screen.getAllByTestId("agent-option");
    expect(options[0]).toHaveClass("cursor");
    expect(sessions.all).toHaveLength(0);
    const head = screen.getByTestId("project-head").getBoundingClientRect();
    expect(screen.getByTestId("agent-choice").getBoundingClientRect().top).toBeGreaterThanOrEqual(head.top);

    // Escape closes it and puts the cursor on the project it opened under.
    await fireEvent.keyDown(nav, { key: "Escape" });
    expect(screen.queryByTestId("agent-choice")).toBeNull();
    expect(screen.getByTestId("project-head")).toHaveClass("cursor");

    await fireEvent.click(screen.getByTestId("project-new-session"));
    await fireEvent.keyDown(nav, { key: "ArrowDown" });
    options = screen.getAllByTestId("agent-option");
    expect(options[1]).toHaveClass("cursor");
    await fireEvent.keyDown(nav, { key: "Enter" });
    expect(sessions.all[0].agent).toBe("codex");
    // The choice sticks: the next choice opens on it, and it is marked.
    expect(sessions.preferred["/repo"]).toBe("codex");
    await fireEvent.click(screen.getByTestId("new-session"));
    options = screen.getAllByTestId("agent-option");
    expect(options[1]).toHaveClass("cursor");
    expect(options[1]).toHaveTextContent("last used");
  });

  it("shows a session working, and one waiting for you", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    const busy = create("/repo");
    started(busy.key, "pty-1", "session-1");
    busy.working = true;
    const done = create("/repo");
    started(done.key, "pty-2", "session-2");
    done.unread = true;

    render(SessionsPane);
    const row = (key: string) =>
      document.querySelector<HTMLElement>(`[data-row="session:${key}"] [data-testid="session-row"]`)!;
    expect(row(busy.key).querySelector(".dot")).toHaveClass("working");
    expect(row(busy.key)).toHaveTextContent("working");
    expect(row(done.key).querySelector(".dot")).toHaveClass("unread");
    expect(row(done.key)).toHaveTextContent("waiting for you");
  });

  // A session under another project is that project's work: picking it
  // brings the project forward, so the panes show what the session is doing.
  it("brings a session's project forward when the session is picked", async () => {
    workspace.open.push(repo("/one", "one"), repo("/two", "two"));
    workspace.active = "/one";
    const mine = create("/one");
    started(mine.key, "pty-1", "session-1");
    const theirs = create("/two");
    started(theirs.key, "pty-2", "session-2");
    sessions.active = mine.key;

    render(SessionsPane);
    await fireEvent.click(
      document.querySelector<HTMLElement>(`[data-row="session:${theirs.key}"] [data-testid="session-row"]`)!,
    );
    expect(workspace.active).toBe("/two");
    expect(sessions.active).toBe(theirs.key);
    expect(layout.focus).toBe("agent");
  });

  // A session started by another hangs under its starter. Picking it goes
  // to the session, and the starter's project is the one used and drawn
  // on screen: the project it runs in, with nothing else under it, stays
  // under Inactive rather than coming up as an empty header.
  it("keeps a started session's own project under Inactive when it is picked", async () => {
    workspace.open.push(repo("/starter", "starter"), repo("/kid", "kid"), repo("/other", "other"));
    workspace.active = "/other";
    const own = create("/other");
    started(own.key, "pty-1", "own-1");
    const starter = create("/starter");
    started(starter.key, "pty-2", "starter-1");
    const kid = create("/kid");
    started(kid.key, "pty-3", "kid-1");
    conductor.startedBy[kid.key] = "starter-1";
    sessions.active = own.key;
    touch("/other", Date.now() - 1000);
    touch("/starter", Date.now() - 5000);
    touch("/kid", Date.now() - 30 * 24 * 3600 * 1000);

    render(SessionsPane);
    const names = () =>
      [...document.querySelectorAll<HTMLElement>("[data-row^='project:'] .name")].map((name) => name.textContent);
    await waitFor(() => expect(screen.getByTestId("inactive-fold")).toHaveTextContent("Inactive 1 project"));
    expect(names()).toEqual(["other", "starter"]);

    await fireEvent.click(screen.getByTestId("started-session"));
    expect(sessions.active).toBe(kid.key);
    expect(workspace.active).toBe("/kid");
    expect(Date.now() - projects.used["/starter"]).toBeLessThan(1000);
    expect(Date.now() - projects.used["/kid"]).toBeGreaterThan(24 * 3600 * 1000);
    await tick();
    expect(names()).toEqual(["starter", "other"]);
    expect(screen.getByTestId("inactive-fold")).toHaveTextContent("Inactive 1 project");
    expect(document.querySelector(`[data-row="session:${kid.key}"]`)).toHaveClass("on");
  });

  // Cmd+1, Down, Enter, type: the pane is one tab stop with a cursor in it.
  it("walks the rows with the keyboard and confirms with Enter", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    const first = create("/repo");
    started(first.key, "pty-1", "session-1");
    const second = create("/repo");
    started(second.key, "pty-2", "session-2");
    first.changedAt = second.changedAt - 1000;
    layout.focus = "sessions";

    render(SessionsPane);
    const nav = screen.getByTestId("sessions-nav");
    await waitFor(() => expect(document.activeElement).toBe(nav));

    // The cursor starts on the session you are in, the latest change on
    // top, and the first is under it.
    await fireEvent.keyDown(nav, { key: "ArrowDown" });
    await fireEvent.keyDown(nav, { key: "Enter" });
    expect(sessions.active).toBe(first.key);
    expect(layout.focus).toBe("agent");
  });

  // Down goes through the rows in the order the pane shows them: the
  // sessions, then the row of earlier ones.
  it("walks the rows in the order they are shown", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    const only = create("/repo");
    started(only.key, "pty-1", "session-1");
    fake.transcripts = [
      { id: "abc-123", title: "from a terminal", modified: 1000, size: 400 },
    ];
    layout.focus = "sessions";

    render(SessionsPane);
    const nav = screen.getByTestId("sessions-nav");
    await waitFor(() =>
      expect(screen.getByTestId("earlier-sessions")).toBeInTheDocument(),
    );

    expect(screen.getByTestId("session-row").closest("[data-row]")).toHaveClass("cursor");
    await fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(screen.getByTestId("earlier-sessions")).toHaveClass("cursor");
    await fireEvent.keyDown(nav, { key: "Enter" });
    expect(resume.open).toBe(true);
  });

  // A dialog takes the document's focus and leaves it on nothing when it
  // closes. The pane takes the keyboard back on the row the dialog opened
  // from, so the next arrow carries on from there and Enter still works.
  it("takes the keyboard back on the same row when a dialog closes", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    fake.transcripts = [
      { id: "abc-123", title: "from a terminal", modified: 1000, size: 400 },
    ];
    layout.focus = "sessions";

    render(SessionsPane);
    const nav = screen.getByTestId("sessions-nav");
    await waitFor(() =>
      expect(screen.getByTestId("earlier-sessions")).toBeInTheDocument(),
    );
    await fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(screen.getByTestId("earlier-sessions")).toHaveClass("cursor");
    await fireEvent.keyDown(nav, { key: "Enter" });
    expect(resume.open).toBe(true);

    // The dialog had the keyboard; its going leaves the document on nothing.
    nav.blur();
    expect(document.activeElement).toBe(document.body);
    returnFocus();
    await waitFor(() => expect(document.activeElement).toBe(nav));
    expect(screen.getByTestId("earlier-sessions")).toHaveClass("cursor");
    await fireEvent.keyDown(nav, { key: "ArrowUp" });
    expect(screen.getByTestId("project-head")).toHaveClass("cursor");
  });

  // Coming in from another pane is different: the cursor starts over from
  // the session you are in, whatever a click left it on.
  it("starts the cursor over when entered from another pane", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    const only = create("/repo");
    started(only.key, "pty-1", "session-1");
    layout.focus = "sessions";

    render(SessionsPane);
    const nav = screen.getByTestId("sessions-nav");
    await waitFor(() => expect(document.activeElement).toBe(nav));
    await fireEvent.keyDown(nav, { key: "ArrowUp" });
    expect(screen.getByTestId("project-head")).toHaveClass("cursor");

    focusPane("agent");
    nav.blur();
    await tick();
    focusPane("sessions");
    await waitFor(() => expect(document.activeElement).toBe(nav));
    expect(screen.getByTestId("session-row").closest("[data-row]")).toHaveClass(
      "cursor",
    );
  });

  // Nothing in the pane needs the mouse: the head and the Projects line
  // sit on the same cursor as the rows, the menus are walked with the
  // arrows, and Delete does what the × on a row does.
  it("reaches the title's tools, the head and the menus from the keyboard, and closes with Delete", async () => {
    workspace.open.push(repo("/repo", "repo"), repo("/other", "other"));
    workspace.active = "/repo";
    layout.focus = "sessions";
    fake.picked = 0;

    render(SessionsPane);
    const nav = screen.getByTestId("sessions-nav");
    // The cursor starts on the project you are in, not on the head.
    expect(screen.getByTestId("go-to")).not.toHaveClass("cursor");
    await fireEvent.keyDown(nav, { key: "Home" });
    expect(screen.getByTestId("project-sort")).toHaveClass("cursor");

    // The sort menu: Enter opens it, the arrows walk it and Enter picks,
    // which closes it.
    await fireEvent.keyDown(nav, { key: "Enter" });
    expect(screen.getByTestId("project-sort-menu")).toBeInTheDocument();
    await fireEvent.keyDown(nav, { key: "ArrowDown" });
    await fireEvent.keyDown(nav, { key: "Enter" });
    expect(layout.projectSort).toBe("name");
    expect(screen.queryByTestId("project-sort-menu")).toBeNull();

    // The menu beside it holds the ways to open a project, and the
    // settings with their chord.
    await fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(screen.getByTestId("sessions-menu")).toHaveClass("cursor");
    await fireEvent.keyDown(nav, { key: "Enter" });
    expect(screen.getByTestId("open-project")).toHaveClass("at");
    expect(screen.getByTestId("menu-settings")).toHaveTextContent("Settings…");
    await fireEvent.keyDown(nav, { key: "Enter" });
    expect(fake.picked).toBe(1);
    expect(screen.queryByTestId("sessions-menu-items")).toBeNull();
    await fireEvent.keyDown(nav, { key: "Enter" });
    await fireEvent.keyDown(nav, { key: "ArrowDown" });
    await fireEvent.keyDown(nav, { key: "Enter" });
    expect(remote.open).toBe(true);
    // A click does the same.
    await fireEvent.keyDown(nav, { key: "Enter" });
    await fireEvent.click(screen.getByTestId("open-project"));
    expect(fake.picked).toBe(2);

    // Then the field and the new-session button, then the projects.
    await fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(screen.getByTestId("go-to")).toHaveClass("cursor");
    await fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(screen.getByTestId("new-session")).toHaveClass("cursor");
    await fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(screen.getAllByTestId("project-head")[0]).toHaveClass("cursor");
    await fireEvent.keyDown(nav, { key: "Delete" });
    expect(workspace.open).toHaveLength(1);
  });

  // Closing a project is in its own menu, behind the ⋯ on its header or a
  // right click, never one slip from the + that starts a session.
  it("closes a project from its own menu, not from beside the +", async () => {
    workspace.open.push(repo("/repo", "repo"), repo("/other", "other"));
    workspace.active = "/repo";
    render(SessionsPane);
    const head = document.querySelector<HTMLElement>('[data-row="project:/repo"]')!;
    expect(within(head).queryByTestId("close-project")).toBeNull();
    await fireEvent.click(within(head).getByTestId("project-more"));
    expect(within(head).getByTestId("project-menu")).toBeInTheDocument();
    await fireEvent.click(within(head).getByTestId("close-project"));
    expect(workspace.open.map((project) => project.path)).toEqual(["/other"]);

    // A right click opens it as well, and Escape closes it.
    const other = document.querySelector<HTMLElement>('[data-row="project:/other"] .project-row')!;
    await fireEvent.contextMenu(other);
    expect(screen.getByTestId("project-menu")).toBeInTheDocument();
    await fireEvent.keyDown(screen.getByTestId("sessions-nav"), { key: "Escape" });
    expect(screen.queryByTestId("project-menu")).toBeNull();
  });

  // Projects split by themselves: the one on screen, one with a live
  // session and one used within the span are in use; the rest fold under
  // Inactive at the foot, closed, each with when it was last used.
  it("folds the projects nobody has used lately under Inactive", async () => {
    const now = Date.now();
    workspace.open.push(
      repo("/here", "here"),
      repo("/live", "live"),
      repo("/lately", "lately"),
      repo("/old", "old"),
      repo("/older", "older"),
    );
    workspace.active = "/here";
    const live = create("/live");
    started(live.key, "pty-1", "session-1");
    sessions.active = live.key;
    touch("/here", now - 3600 * 1000);
    touch("/lately", now - 2 * 24 * 3600 * 1000);
    touch("/old", now - 9 * 24 * 3600 * 1000);
    touch("/older", now - 21 * 24 * 3600 * 1000);

    render(SessionsPane);
    const names = () =>
      [...document.querySelectorAll<HTMLElement>("[data-row^='project:'] .name")].map((name) => name.textContent);
    // Ordered by the user's own use: a project only an agent has been at
    // work in comes after the ones the user picked.
    expect(names()).toEqual(["here", "lately", "live"]);
    await waitFor(() => expect(screen.getByTestId("inactive-fold")).toHaveTextContent("Inactive 2 projects"));
    expect(screen.queryByTestId("inactive-project")).toBeNull();

    await fireEvent.click(screen.getByTestId("inactive-fold"));
    const idle = screen.getAllByTestId("inactive-project");
    expect(idle.map((row) => row.querySelector(".name")!.textContent)).toEqual(["old", "older"]);
    expect(screen.getAllByTestId("inactive-when").map((when) => when.textContent)).toEqual(["1w", "3w"]);

    // Picking one brings it forward, and it is in use again.
    await fireEvent.click(idle[0]);
    expect(workspace.active).toBe("/old");
    expect(names()).toContain("old");
    expect(screen.getByTestId("inactive-fold")).toHaveTextContent("Inactive 1 project");

    // With the span at never, nothing folds.
    projects.inactiveAfter = "never";
    await tick();
    expect(screen.queryByTestId("inactive-fold")).toBeNull();
    expect(names()).toHaveLength(5);
  });

  // What the user is pointing at, or walking with the keyboard, stays
  // where it is: the order the user asked for settles once both leave.
  it("holds the order still while the pointer or the keyboard is in the pane", async () => {
    workspace.open.push(repo("/a", "a"), repo("/b", "b"));
    workspace.active = "/a";
    touch("/a", Date.now() - 1000);
    touch("/b", Date.now() - 5000);
    render(SessionsPane);
    const names = () =>
      [...document.querySelectorAll<HTMLElement>("[data-row^='project:'] .name")].map((name) => name.textContent);
    expect(names()).toEqual(["a", "b"]);
    const pane = document.querySelector<HTMLElement>('[data-pane="sessions"]')!;

    await fireEvent.pointerEnter(pane);
    await fireEvent.click(screen.getByText("b"));
    expect(workspace.active).toBe("/b");
    expect(names()).toEqual(["a", "b"]);
    await fireEvent.pointerLeave(pane);
    expect(names()).toEqual(["b", "a"]);

    // The keyboard in the pane holds it the same way.
    screen.getByTestId("sessions-nav").focus();
    touch("/a");
    await tick();
    expect(names()).toEqual(["b", "a"]);
    screen.getByTestId("sessions-nav").blur();
    await tick();
    expect(names()).toEqual(["a", "b"]);
  });

  // An agent at work moves no project: only the user's own use does.
  it("leaves the projects where they are while an agent works", async () => {
    workspace.open.push(repo("/a", "a"), repo("/b", "b"));
    workspace.active = "/a";
    touch("/a", Date.now() - 1000);
    touch("/b", Date.now() - 5000);
    const busy = create("/b");
    started(busy.key, "pty-1", "session-1");
    render(SessionsPane);
    const names = () =>
      [...document.querySelectorAll<HTMLElement>("[data-row^='project:'] .name")].map((name) => name.textContent);
    expect(names()).toEqual(["a", "b"]);
    busy.working = true;
    busy.changedAt = Date.now() + 1000;
    await tick();
    expect(names()).toEqual(["a", "b"]);
  });

  // Picked under Inactive, a project comes forward among the active ones,
  // and the pane goes to where it landed with the cursor on its header.
  it("scrolls to an inactive project picked, where it lands", async () => {
    workspace.open.push(repo("/here", "here"), repo("/old", "old"));
    workspace.active = "/here";
    touch("/here");
    touch("/old", Date.now() - 30 * 24 * 3600 * 1000);
    render(SessionsPane);
    await waitFor(() => expect(screen.getByTestId("inactive-fold")).toBeInTheDocument());
    await fireEvent.click(screen.getByTestId("inactive-fold"));
    const scrolled = vi.mocked(Element.prototype.scrollIntoView);
    scrolled.mockClear();
    await fireEvent.click(screen.getByTestId("inactive-project"));
    const head = document.querySelector<HTMLElement>('[data-row="project:/old"]')!;
    await waitFor(() => expect(scrolled.mock.contexts).toContain(head.closest("section")));
    expect(head).toHaveClass("cursor");
  });

  // The clock that keeps histories fresh passes over inactive projects,
  // so one that comes back is read again on the way out.
  it("reads an inactive project's history again when it leaves Inactive", async () => {
    workspace.open.push(repo("/here", "here"), repo("/old", "old"));
    workspace.active = "/here";
    touch("/here");
    touch("/old", Date.now() - 30 * 24 * 3600 * 1000);
    render(SessionsPane);
    await waitFor(() => expect(screen.getByTestId("inactive-fold")).toBeInTheDocument());
    fake.read = [];
    await fireEvent.click(screen.getByTestId("inactive-fold"));
    await fireEvent.click(screen.getByTestId("inactive-project"));
    await waitFor(() => expect(fake.read.flat()).toContain("/old"));
    expect(fake.read.flat()).not.toContain("/here");
  });

  it("starts a session in an inactive project from its own button", async () => {
    workspace.open.push(repo("/here", "here"), repo("/old", "old"));
    workspace.active = "/here";

    render(SessionsPane);
    await waitFor(() => expect(screen.getByTestId("inactive-fold")).toBeInTheDocument());
    await fireEvent.click(screen.getByTestId("inactive-fold"));
    const idle = document.querySelector<HTMLElement>('[data-row="idle:/old"]')!;
    await fireEvent.click(within(idle).getByTestId("project-more"));
    await fireEvent.click(within(idle).getByTestId("project-menu-new"));
    expect(workspace.active).toBe("/old");
    expect(sessions.all.map((session) => session.project)).toEqual(["/old"]);
    // The project left behind was never used, and takes the other's place
    // under the fold, which stays open.
    expect(screen.getByTestId("inactive-project")).toHaveTextContent("here");
  });

  it("orders the projects by last used or by name, from the sort menu", async () => {
    const now = Date.now();
    workspace.open.push(repo("/b", "beta"), repo("/a", "alpha"), repo("/c", "gamma"));
    workspace.active = "/c";
    touch("/b", now - 1000);
    touch("/a", now - 5000);
    touch("/c", now - 9000);
    const names = () =>
      [...document.querySelectorAll<HTMLElement>("[data-row^='project:'] .name")].map((name) => name.textContent);

    render(SessionsPane);
    expect(screen.getByTestId("project-sort")).toHaveAttribute("aria-label", "Sort projects: Last used");
    expect(names()).toEqual(["beta", "alpha", "gamma"]);

    await fireEvent.click(screen.getByTestId("project-sort"));
    expect(screen.getByTestId("project-sort-used")).toHaveAttribute("aria-checked", "true");
    await fireEvent.click(screen.getByTestId("project-sort-name"));
    expect(screen.queryByTestId("project-sort-menu")).toBeNull();
    expect(screen.getByTestId("project-sort")).toHaveAttribute("aria-label", "Sort projects: Name");
    expect(names()).toEqual(["alpha", "beta", "gamma"]);
  });

  // The fold and what it lets out are on the cursor path like any row,
  // and Delete on an inactive project closes it.
  it("walks the Inactive fold with the keyboard", async () => {
    workspace.open.push(repo("/here", "here"), repo("/old", "old"));
    workspace.active = "/here";
    layout.focus = "sessions";

    render(SessionsPane);
    await waitFor(() => expect(screen.getByTestId("inactive-fold")).toBeInTheDocument());
    const nav = screen.getByTestId("sessions-nav");
    await waitFor(() => expect(document.activeElement).toBe(nav));
    const at = () => nav.querySelector(".cursor")?.getAttribute("data-row");

    await fireEvent.keyDown(nav, { key: "End" });
    expect(at()).toBe("inactive");
    await fireEvent.keyDown(nav, { key: "Enter" });
    await fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(at()).toBe("idle:/old");
    await fireEvent.keyDown(nav, { key: "Delete" });
    expect(workspace.open.map((project) => project.path)).toEqual(["/here"]);
    expect(screen.queryByTestId("inactive-fold")).toBeNull();
  });

  // A live row: the name and when it last changed, then the line the
  // agent left and the model. A row left from the last quit: one line
  // with its time, and nothing else.
  it("draws a live session on two lines and a row left from the last quit on one", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    const live = create("/repo", null, "claude-code", null, null, "claude-opus-4-1");
    started(live.key, "pty-1", "session-1");
    live.note = "Tests green, ready to merge.";
    const left = reopened("/repo", "t-1", "claude-code", null, "sonnet", null);
    fake.transcripts = [{ id: "t-1", title: "yesterday's work", modified: Math.floor(Date.now() / 1000) - 3 * 86_400, size: 1 }];

    render(SessionsPane);
    const row = (key: string) =>
      document.querySelector<HTMLElement>(`[data-row="session:${key}"] [data-testid="session-row"]`)!;
    await waitFor(() => expect(row(left.key).querySelector(".when")!.textContent).not.toBe("now"));
    expect(row(live.key).querySelector(".label")).toHaveTextContent("session 1");
    expect(row(live.key).querySelector(".when")).toHaveTextContent("now");
    expect(within(row(live.key)).getByTestId("session-note")).toHaveTextContent("Tests green, ready to merge.");
    expect(within(row(live.key)).getByTestId("session-model")).toHaveTextContent("Opus 4.1");
    expect(row(live.key)).toHaveClass("two");

    expect(row(left.key)).not.toHaveClass("two");
    expect(row(left.key).querySelector(".dot")).toHaveClass("dormant");
    expect(row(left.key).querySelector(".when")!.textContent).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/);
    expect(within(row(left.key)).queryByTestId("session-model")).toBeNull();
    expect(screen.queryByTestId("agent-tag")).toBeNull();

    // A session asking for a permission says so in the accent.
    live.needs = "permission";
    await tick();
    expect(within(row(live.key)).getByTestId("session-note")).toHaveClass("asking");
  });

  // A session that started others says what they are doing on its
  // second line. Folded, that line says it once in words, with a dot for
  // each beside it, and the chevron at its end lets them out again.
  it("folds the sessions a session started into words and dots, behind a chevron", async () => {
    workspace.open.push(repo("/repo", "repo"), repo("/other", "other"));
    workspace.active = "/repo";
    const starter = create("/repo", null, "claude-code", null, null, "claude-opus-4-1");
    started(starter.key, "pty-1", "starter-1");
    const here = create("/repo", null, "claude-code", null, null, "sonnet");
    started(here.key, "pty-2", "kid-1");
    const there = create("/other", null, "claude-code", null, null, "sonnet");
    started(there.key, "pty-3", "kid-2");
    const done = create("/repo", null, "claude-code", null, null, "sonnet");
    started(done.key, "pty-4", "kid-3");
    for (const kid of [here, there, done]) conductor.startedBy[kid.key] = "starter-1";
    there.needs = "permission";
    done.status = "exited";

    render(SessionsPane);
    const row = () => document.querySelector<HTMLElement>(`[data-row="session:${starter.key}"]`)!;
    const kids = screen.getAllByTestId("started-session");
    expect(kids).toHaveLength(3);
    // Its own name first, then the project it runs in, which gives way first.
    const elsewhere = kids.find((kid) => kid.querySelector(".where") !== null)!;
    expect(elsewhere.querySelector(".label")!.nextElementSibling).toHaveClass("where");
    expect(elsewhere.querySelector(".where")).toHaveTextContent("other");
    expect(within(row()).getByTestId("orchestrator-summary")).toHaveTextContent("2 running, 1 asking");
    expect(within(row()).getByTestId("session-model")).toHaveTextContent("Opus 4.1");

    const chevron = within(row()).getByTestId("collapse-started");
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    await fireEvent.click(chevron);
    expect(screen.queryAllByTestId("started-session")).toHaveLength(0);
    expect(within(row()).getByTestId("orchestrator-summary")).toHaveTextContent("2 running, 1 asking, 1 done");
    const dots = within(row()).getByTestId("started-dots");
    expect(dots.querySelectorAll(".dot")).toHaveLength(3);
    expect(dots).toHaveTextContent(/^$/);
    expect(within(row()).queryByTestId("session-model")).toBeNull();
    expect(within(row()).getByTestId("collapse-started")).toHaveAttribute("aria-expanded", "false");
  });

  // More than a few rows with nothing running fold their tail into one row
  // that counts them, on the cursor path like the rest.
  it("folds the tail of the quiet rows into one row that counts them", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    const day = 86_400;
    const at = Math.floor(Date.now() / 1000);
    fake.transcripts = [1, 2, 3, 4, 5].map((n) => ({ id: `t-${n}`, title: `work ${n}`, modified: at - n * day, size: 1 }));
    for (const n of [1, 2, 3, 4, 5]) reopened("/repo", `t-${n}`, "claude-code", null, null, null);
    layout.focus = "sessions";

    render(SessionsPane);
    // Each row's time is its transcript's, once the history is read.
    await waitFor(() => expect(screen.getByTestId("quiet-more")).toHaveTextContent("3 more from this week"));
    const labels = () => screen.getAllByTestId("session-row").map((row) => row.querySelector(".label")!.textContent);
    expect(labels()).toHaveLength(2);

    const nav = screen.getByTestId("sessions-nav");
    await waitFor(() => expect(document.activeElement).toBe(nav));
    await fireEvent.keyDown(nav, { key: "Home" });
    for (let i = 0; i < 7; i += 1) await fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(screen.getByTestId("quiet-more")).toHaveClass("cursor");
    await fireEvent.keyDown(nav, { key: "Enter" });
    expect(screen.queryByTestId("quiet-more")).toBeNull();
    expect(labels()).toHaveLength(5);
  });

  // A live row's × sits over its end and stops the session, which leaves
  // it under the project's own past; a past row's archive button files it
  // with the sessions to resume. Two steps, never both at once.
  it("closes a live session, then archives it from its past row", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    const one = create("/repo", null, "claude-code");
    started(one.key, "pty-1", "session-1");
    fake.transcripts = [
      { id: "session-1", title: "first", modified: 1000, size: 400 },
      { id: "session-3", title: "third", modified: 800, size: 400 },
    ];
    layout.focus = "sessions";

    render(SessionsPane);
    expect(screen.queryByTestId("archive-past")).toBeNull();
    await fireEvent.click(screen.getByTestId("close-session"));
    expect(sessions.all).toHaveLength(0);
    await waitFor(() =>
      expect(screen.getByTestId("past-session")).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("earlier-sessions")).toHaveTextContent(
        "1 earlier session",
      ),
    );

    await fireEvent.click(screen.getByTestId("archive-past"));
    await waitFor(() =>
      expect(screen.queryByTestId("past-session")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("earlier-sessions")).toHaveTextContent(
        "2 earlier sessions",
      ),
    );

    // Delete on a past row under the cursor archives it the same way.
    const two = create("/repo", null, "claude-code");
    started(two.key, "pty-2", "session-2");
    fake.transcripts.push({
      id: "session-2",
      title: "second",
      modified: 700,
      size: 400,
    });
    closeStore(two.key);
    await waitFor(() =>
      expect(screen.getByTestId("past-session")).toBeInTheDocument(),
    );
    const nav = screen.getByTestId("sessions-nav");
    await fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(screen.getByTestId("past-session").closest(".session")).toHaveClass(
      "cursor",
    );
    await fireEvent.keyDown(nav, { key: "Delete" });
    await waitFor(() =>
      expect(screen.queryByTestId("past-session")).not.toBeInTheDocument(),
    );
  });

  it("starts a new session from the keyboard", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    layout.focus = "sessions";

    render(SessionsPane);
    const nav = screen.getByTestId("sessions-nav");
    // The head's button, after the title's tools and the field.
    await fireEvent.keyDown(nav, { key: "Home" });
    for (let step = 0; step < 3; step += 1) await fireEvent.keyDown(nav, { key: "ArrowDown" });
    await fireEvent.keyDown(nav, { key: "Enter" });
    expect(sessions.all).toHaveLength(1);
    expect(layout.focus).toBe("agent");
  });

  // The whole point of the model: looking at another session kills nothing.
  it("switches session on click without stopping the other", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    const first = create("/repo");
    started(first.key, "pty-1", "session-1");
    const second = create("/repo");
    started(second.key, "pty-2", "session-2");

    render(SessionsPane);
    await fireEvent.click(
      document.querySelector<HTMLElement>(`[data-row="session:${first.key}"] [data-testid="session-row"]`)!,
    );

    expect(sessions.active).toBe(first.key);
    expect(second.status).toBe("running");
  });

  // Phase 3: what Claude Code has already done here, read off disk.
  it("lists past sessions of its own under the project you are looking at", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    fake.transcripts = [
      {
        id: "abc-123",
        title: "rename the token cache",
        modified: 1000,
        size: 400,
      },
    ];
    localStorage.setItem(
      "workbench.mine",
      JSON.stringify({ "/repo": ["abc-123"] }),
    );
    loadRemembered();

    render(SessionsPane);
    await waitFor(() =>
      expect(screen.getByText("rename the token cache")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("earlier-sessions")).not.toBeInTheDocument();
  });

  // Transcripts from Claude Code run in a plain terminal share the directory.
  // They are there to resume, behind a fold, not mixed in with our own.
  it("folds away sessions that came from outside the app", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    fake.transcripts = [
      { id: "abc-123", title: "from a terminal", modified: 1000, size: 400 },
      { id: "def-456", title: "another terminal", modified: 900, size: 400 },
    ];

    render(SessionsPane);
    await waitFor(() =>
      expect(screen.getByTestId("earlier-sessions")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("earlier-sessions")).toHaveTextContent(
      "2 earlier sessions",
    );
    expect(screen.queryByTestId("past-session")).not.toBeInTheDocument();

    await fireEvent.click(screen.getByTestId("earlier-sessions"));
    expect(resume.open).toBe(true);
    expect(offered().map((entry) => entry.id)).toEqual(["abc-123", "def-456"]);
  });

  it("opens a past session as a live one, resumed by id", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    fake.transcripts = [
      { id: "abc-123", title: "earlier work", modified: 1000, size: 400 },
    ];

    render(SessionsPane);
    await waitFor(() =>
      expect(screen.getByTestId("earlier-sessions")).toBeInTheDocument(),
    );
    await fireEvent.click(screen.getByTestId("earlier-sessions"));
    pickResume(offered()[0]);

    expect(sessions.all).toHaveLength(1);
    expect(sessions.all[0].resumedFrom).toBe("abc-123");
  });

  it("stops offering a past session once it is open", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    fake.transcripts = [
      { id: "abc-123", title: "earlier work", modified: 1000, size: 400 },
    ];

    render(SessionsPane);
    await waitFor(() =>
      expect(screen.getByTestId("earlier-sessions")).toBeInTheDocument(),
    );
    await fireEvent.click(screen.getByTestId("earlier-sessions"));
    pickResume(offered()[0]);

    await waitFor(() =>
      expect(screen.queryByTestId("earlier-sessions")).not.toBeInTheDocument(),
    );
  });

  it("adds another session on request", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";

    render(SessionsPane);
    await fireEvent.click(screen.getByTestId("new-session"));
    expect(sessions.all).toHaveLength(1);
  });

  it("offers no new session while there is no agent to run", () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    resetAgent();
    applyDetect(
      { id: "claude-code", path: null, caps: null, fromLoginShell: true },
      true,
    );
    applyDetect(
      { id: "codex", path: null, caps: null, fromLoginShell: true },
      true,
    );

    render(SessionsPane);
    expect(screen.getByTestId("new-session")).toBeDisabled();
  });

  // One new-session button in the head, for the project on screen, and one
  // in each project's header, which brings that project forward first.
  it("offers a new session from the head and from each project's header", async () => {
    workspace.open.push(repo("/one", "one"), repo("/two", "two"));
    workspace.active = "/one";
    touch("/two");

    render(SessionsPane);
    expect(screen.getAllByTestId("new-session")).toHaveLength(1);
    const heads = screen.getAllByTestId("project-new-session");
    expect(heads).toHaveLength(2);
    await fireEvent.click(
      document.querySelector<HTMLElement>('[data-row="project:/two"] [data-testid="project-new-session"]')!,
    );
    expect(workspace.active).toBe("/two");
    expect(sessions.all.map((session) => session.project)).toEqual(["/two"]);
  });

  // Two projects of one name each show the part of the path that tells
  // them apart, dimmed in front of the name.
  it("dims the path that tells two projects of one name apart", () => {
    workspace.open.push(repo("/work/app", "app"), repo("/spike/app", "app"));
    workspace.active = "/work/app";
    touch("/spike/app", Date.now() - 1000);
    touch("/work/app");

    render(SessionsPane);
    const names = screen.getAllByTestId("project-head").map((head) => head.querySelector(".name")!);
    expect(names.map((name) => name.textContent)).toEqual(["work/app", "spike/app"]);
    expect(names.map((name) => name.querySelector(".prefix")?.textContent)).toEqual(["work/", "spike/"]);
  });

  // The field at the top opens the palette, and the foot holds the
  // settings and, once there are accounts, whose login the session on
  // screen runs under.
  // With no accounts there is nothing for a foot to say: the settings are
  // in the menu, and under their chord.
  it("opens the palette from the field and the settings from the menu, with no foot", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";

    render(SessionsPane);
    expect(screen.getByTestId("go-to")).toHaveTextContent("Go to session or project");
    await fireEvent.click(screen.getByTestId("go-to"));
    expect(palette.open).toBe(true);
    expect(document.querySelector(".foot")).toBeNull();
    expect(screen.queryByTestId("pane-settings")).toBeNull();
    await fireEvent.click(screen.getByTestId("sessions-menu"));
    await fireEvent.click(screen.getByTestId("menu-settings"));
    expect(settings.open).toBe(true);
  });

  // The sort and the menu sit on the pane's title row; the head under it
  // is the field and the new-session button, and nothing more.
  it("puts the sort and the menu on the title's row", () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    render(SessionsPane);
    const header = document.querySelector<HTMLElement>('[data-pane="sessions"] > header')!;
    expect(within(header).getByTestId("project-sort")).toBeInTheDocument();
    expect(within(header).getByTestId("sessions-menu")).toBeInTheDocument();
    expect(document.querySelector(".sortbar")).toBeNull();
    expect(screen.queryByText("Projects", { exact: true })).toBeNull();
  });
});

// Off macOS the window is undecorated and the app draws the controls at the
// end of the rightmost header. jsdom reports no platform, which is not a Mac.
describe("the window controls", () => {
  it("sit at the end of the rightmost pane's header and drive the window", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    fake.controls = [];
    render(ChangesPane);
    const controls = screen.getByTestId("window-controls");
    await fireEvent.click(
      within(controls).getByRole("button", { name: "Minimize" }),
    );
    await fireEvent.click(
      within(controls).getByRole("button", { name: "Maximize" }),
    );
    await fireEvent.click(
      within(controls).getByRole("button", { name: "Close" }),
    );
    expect(fake.controls).toEqual(["minimize", "maximize", "close"]);
  });

  it("are not on a pane that is not at the right edge", () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    render(SessionsPane);
    expect(screen.queryByTestId("window-controls")).not.toBeInTheDocument();
  });

  it("have a menu button at the leftmost header that asks for the native menu", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    fake.controls = [];
    render(SessionsPane);
    await fireEvent.click(screen.getByTestId("app-menu"));
    expect(fake.controls).toEqual(["menu"]);
  });
});

describe("the changes toolbar", () => {
  beforeEach(async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    fake.status = [
      { path: "src/cache/mod.rs", status: "M", add: 1, del: 1, binary: false },
      { path: "src/lib.rs", status: "M", add: 1, del: 1, binary: false },
    ];
    fake.fileList = ["Cargo.toml", "src/cache/mod.rs", "src/lib.rs"];
  });

  it("narrows the tree as you type", async () => {
    render(ChangesPane);
    await waitFor(() =>
      expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(0),
    );
    await fireEvent.input(screen.getByTestId("search-field"), {
      target: { value: "cache" },
    });
    const names = screen
      .getAllByRole("treeitem")
      .map((row) => row.textContent?.trim());
    expect(names.some((name) => name?.includes("mod.rs"))).toBe(true);
    expect(names.some((name) => name?.includes("lib.rs"))).toBe(false);
  });

  it("puts scope and view in the menu, with their chords", async () => {
    render(ChangesPane);
    await fireEvent.click(screen.getByTestId("changes-menu"));
    expect(screen.getByTestId("menu-scope-changed")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("menu-scope-all")).toHaveTextContent(
      /⌘⇧A|Ctrl\+Shift\+A/,
    );
    await fireEvent.click(screen.getByTestId("menu-scope-all"));
    expect(files.scope).toBe("all");
    // Choosing closes the menu.
    expect(screen.queryByTestId("changes-menu-items")).not.toBeInTheDocument();
  });

  // Lines mode: the hits stand in for the tree, and one opens the file there.
  it("lists hits in lines mode and opens a file at the line", async () => {
    render(ChangesPane);
    await waitFor(() =>
      expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(0),
    );
    await fireEvent.click(screen.getByTestId("mode-lines"));
    await fireEvent.input(screen.getByTestId("search-field"), {
      target: { value: "needle" },
    });
    await fireEvent.keyDown(screen.getByTestId("search-field"), {
      key: "Enter",
    });
    await waitFor(() =>
      expect(screen.getByTestId("search-hit")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("search-file")).toHaveTextContent("src/lib.rs");
    expect(screen.getByTestId("search-hit")).toHaveTextContent("4");
    expect(
      screen.getByTestId("search-hit").querySelector("mark"),
    ).toHaveTextContent("needle");

    await fireEvent.click(screen.getByTestId("search-hit"));
    expect(files.selected).toBe("src/lib.rs");
    expect(files.target).toEqual({ path: "src/lib.rs", line: 4 });
    expect(files.view).toBe("content");
    expect(layout.mode).toBe("reviewing");
  });

  it("clears the field on Escape before leaving it", async () => {
    render(ChangesPane);
    const field = screen.getByTestId("search-field");
    await fireEvent.input(field, { target: { value: "lib" } });
    await fireEvent.keyDown(field, { key: "Escape" });
    expect(files.query).toBe("");
  });
});

/** Scope and view live in the pane's menu now: open it, pick, it closes. */
async function chooseAll() {
  await fireEvent.click(screen.getByTestId("changes-menu"));
  await fireEvent.click(screen.getByTestId("menu-scope-all"));
}

async function chooseContent() {
  await fireEvent.click(screen.getByTestId("changes-menu"));
  await fireEvent.click(screen.getByTestId("menu-view-content"));
}

describe("the file tree", () => {
  beforeEach(async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    await refresh();
  });

  it("nests changed files under their folders", async () => {
    await renderChanges();
    expect(rowNames()).toEqual([
      "src",
      "cache",
      "mod.rs",
      "lib.rs",
      "token_cache.rs",
    ]);
  });

  it("marks folders as folders and files as selectable", async () => {
    await renderChanges();
    const rows = screen.getAllByRole("treeitem");
    expect(rows[0]).toHaveAttribute("aria-expanded", "true");
    expect(rows[2]).not.toHaveAttribute("aria-expanded");
  });

  it("indents by depth", async () => {
    await renderChanges();
    const rows = screen.getAllByRole("treeitem");
    expect(rows[0]).toHaveAttribute("aria-level", "1");
    expect(rows[1]).toHaveAttribute("aria-level", "2");
    expect(rows[2]).toHaveAttribute("aria-level", "3");
  });

  it("shows the status letter and line counts on a file row", async () => {
    await renderChanges();
    const row = screen.getByText("mod.rs").closest("[role='treeitem']")!;
    expect(within(row as HTMLElement).getByText("M")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("+18")).toBeInTheDocument();
  });

  // The reason the tree is usable with hundreds of files: only the folders
  // holding the agent's work are open.
  it("opens folders with changes and leaves the rest shut", async () => {
    await renderChanges();
    await chooseAll();

    expect(rowNames()).toContain("cache");
    expect(rowNames()).toContain("store.rs");
    expect(rowNames()).toContain("docs");
    expect(rowNames()).not.toContain("architecture.md");
    expect(rowNames()).not.toContain("watcher.rs");
  });

  it("opens a folder when it is clicked, and shuts it again", async () => {
    await renderChanges();
    await chooseAll();

    await fireEvent.click(screen.getByText("docs"));
    expect(rowNames()).toContain("architecture.md");

    await fireEvent.click(screen.getByText("docs"));
    expect(rowNames()).not.toContain("architecture.md");
  });

  it("folds a chain of folders that hold nothing else into one row", async () => {
    await renderChanges();
    await chooseAll();
    // docs holds only one file, so it never folds; src/git holds only one too.
    await fireEvent.click(screen.getByText("git"));
    expect(rowNames()).toContain("watcher.rs");
  });

  it("opens a file into the viewer", async () => {
    await renderChanges();
    await fireEvent.click(screen.getByText("lib.rs"));
    expect(layout.mode).toBe("reviewing");
    expect(files.selected).toBe("src/lib.rs");
    expect(screen.getByTestId("viewer")).toBeInTheDocument();
  });

  it("stays on screen beside the viewer once a file is open", async () => {
    await renderChanges();
    await fireEvent.click(screen.getByText("lib.rs"));
    expect(tree()).toBeInTheDocument();
    expect(rowNames()).toEqual([
      "src",
      "cache",
      "mod.rs",
      "lib.rs",
      "token_cache.rs",
    ]);
  });

  it("switches files without leaving the viewer", async () => {
    await renderChanges();
    await fireEvent.click(screen.getByText("lib.rs"));
    await fireEvent.click(screen.getByText("token_cache.rs"));
    expect(files.selected).toBe("src/token_cache.rs");
    expect(layout.mode).toBe("reviewing");
  });
});

describe("tree keyboard navigation", () => {
  beforeEach(async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    await refresh();
  });

  const cursorName = () => {
    const id = tree().getAttribute("aria-activedescendant")!;
    return document
      .getElementById(id)!
      .querySelector(".name")!
      .textContent!.trim();
  };

  it("starts on the first row", async () => {
    await renderChanges();
    expect(cursorName()).toBe("src");
  });

  it("moves down and up", async () => {
    await renderChanges();
    await fireEvent.keyDown(tree(), { key: "ArrowDown" });
    expect(cursorName()).toBe("cache");
    await fireEvent.keyDown(tree(), { key: "ArrowUp" });
    expect(cursorName()).toBe("src");
  });

  // The column runs on past the last file into the sections' headers, and
  // stops there rather than wrapping.
  it("stops at the ends rather than wrapping", async () => {
    await renderChanges();
    await fireEvent.keyDown(tree(), { key: "ArrowUp" });
    expect(cursorName()).toBe("src");
    await fireEvent.keyDown(tree(), { key: "End" });
    expect(tree().getAttribute("aria-activedescendant")).toBe("browser-fold");
    await fireEvent.keyDown(tree(), { key: "ArrowDown" });
    expect(tree().getAttribute("aria-activedescendant")).toBe("browser-fold");
    await fireEvent.keyDown(tree(), { key: "ArrowUp" });
    expect(tree().getAttribute("aria-activedescendant")).toBe("processes-fold");
    await fireEvent.keyDown(tree(), { key: "ArrowUp" });
    expect(cursorName()).toBe("token_cache.rs");
  });

  it("shuts a folder with left and opens it with right", async () => {
    await renderChanges();
    await fireEvent.keyDown(tree(), { key: "ArrowLeft" });
    expect(rowNames()).toEqual(["src"]);
    await fireEvent.keyDown(tree(), { key: "ArrowRight" });
    expect(rowNames()).toContain("cache");
  });

  it("steps into an open folder with right", async () => {
    await renderChanges();
    await fireEvent.keyDown(tree(), { key: "ArrowRight" });
    expect(cursorName()).toBe("cache");
  });

  it("climbs to the parent with left from a file", async () => {
    await renderChanges();
    await fireEvent.keyDown(tree(), { key: "End" });
    await fireEvent.keyDown(tree(), { key: "ArrowUp" });
    await fireEvent.keyDown(tree(), { key: "ArrowUp" });
    expect(cursorName()).toBe("token_cache.rs");
    await fireEvent.keyDown(tree(), { key: "ArrowLeft" });
    expect(cursorName()).toBe("src");
  });

  it("opens the file under the cursor with Enter", async () => {
    await renderChanges();
    await fireEvent.keyDown(tree(), { key: "Home" });
    await fireEvent.keyDown(tree(), { key: "ArrowDown" });
    await fireEvent.keyDown(tree(), { key: "ArrowDown" });
    expect(cursorName()).toBe("mod.rs");

    await fireEvent.keyDown(tree(), { key: "Enter" });
    expect(files.selected).toBe("src/cache/mod.rs");
    expect(layout.mode).toBe("reviewing");
  });

  it("leaves keys it does not use to the pane", async () => {
    await renderChanges();
    await fireEvent.keyDown(tree(), { key: "a" });
    expect(cursorName()).toBe("src");
  });
});

describe("ChangesPane without git", () => {
  // The pane is entirely git-based, so it says so rather than reporting
  // "not a git repository" as an error on every refresh.
  it("says a folder is not a repository rather than failing to read it", async () => {
    workspace.open.push(repo("/tmp/notes", "notes", false));
    workspace.active = "/tmp/notes";

    render(ChangesPane);
    expect(await screen.findByTestId("not-git")).toBeInTheDocument();
    expect(screen.queryByTestId("changes-error")).not.toBeInTheDocument();
  });

  it("shows nothing of the sort for a repository", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    await renderChanges();
    expect(screen.queryByTestId("not-git")).not.toBeInTheDocument();
  });
});

describe("ChangesPane head", () => {
  beforeEach(async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    await refresh();
  });

  it("carries the field and the menu in one head", async () => {
    await renderChanges();
    expect(screen.getByTestId("search-field")).toBeInTheDocument();
    expect(
      screen.getByRole("radiogroup", { name: /what to search/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("changes-menu")).toBeInTheDocument();
  });

  it("leaves the view items disabled until a file is picked", async () => {
    await renderChanges();
    await fireEvent.click(screen.getByTestId("changes-menu"));
    expect(screen.getByTestId("menu-view-diff")).toBeDisabled();
    expect(screen.getByTestId("menu-view-content")).toBeDisabled();
  });

  // The connection between the two controls: no changes means no diff.
  it("disables Diff for a file that has no changes", async () => {
    await renderChanges();
    await chooseAll();
    await fireEvent.click(screen.getByText("Cargo.toml"));
    await fireEvent.click(screen.getByTestId("changes-menu"));
    expect(screen.getByTestId("menu-view-diff")).toBeDisabled();
    expect(screen.getByTestId("menu-view-content")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("closes back to the tree alone", async () => {
    await renderChanges();
    await fireEvent.click(screen.getByText("lib.rs"));
    await fireEvent.click(
      screen.getByRole("button", { name: /close the viewer/i }),
    );
    expect(layout.mode).toBe("working");
    expect(screen.queryByTestId("viewer")).not.toBeInTheDocument();
    expect(tree()).toBeInTheDocument();
  });
});

describe("FileViewer", () => {
  beforeEach(async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    await refresh();
  });

  it("shows the diff by default", async () => {
    await renderChanges();
    await fireEvent.click(screen.getByText("mod.rs"));

    const viewer = screen.getByTestId("viewer");
    expect(viewer).toHaveAttribute("data-view", "diff");
    expect(within(viewer).getByText("@@ -1,9 +1,12 @@")).toBeInTheDocument();
  });

  it("switches to the whole file", async () => {
    await renderChanges();
    await fireEvent.click(screen.getByText("mod.rs"));
    await chooseContent();

    const viewer = screen.getByTestId("viewer");
    expect(viewer).toHaveAttribute("data-view", "content");
    expect(
      within(viewer).queryByText("@@ -1,9 +1,12 @@"),
    ).not.toBeInTheDocument();
  });

  it("falls back to content for a file with no diff", async () => {
    await renderChanges();
    await chooseAll();
    await fireEvent.click(screen.getByText("Cargo.toml"));
    expect(screen.getByTestId("viewer")).toHaveAttribute(
      "data-view",
      "content",
    );
  });

  it("says so when a deleted file has no content to show", async () => {
    await renderChanges();
    await fireEvent.click(screen.getByText("token_cache.rs"));
    await chooseContent();
    expect(screen.getByText(/deleted/i)).toBeInTheDocument();
  });
});
