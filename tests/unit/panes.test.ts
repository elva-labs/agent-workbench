import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/svelte";
import SessionsPane from "$lib/panes/SessionsPane.svelte";
import ChangesPane from "$lib/panes/ChangesPane.svelte";
import { DEFAULT, layout, togglePane } from "$lib/layout.svelte";
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
    kill: async () => {},
    transcripts: async (_project: string, agent: string) =>
      agent === "claude-code" ? fake.transcripts : fake.codexTranscripts,
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
} from "$lib/sessions.svelte";
import { reset as resetHook } from "$lib/hook.svelte";
import { remote, resetRemote } from "$lib/remote.svelte";

beforeEach(() => {
  resetRemote();
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
    expect(screen.getByTestId("open-project")).toBeInTheDocument();
  });

  it("lists open projects with their sessions", () => {
    workspace.open.push(repo("/home/ada/dev/one", "one"));
    workspace.active = "/home/ada/dev/one";
    const session = create("/home/ada/dev/one");
    started(session.key, "pty-1", "session-1");

    render(SessionsPane);
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("session 1")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  // The right pane is entirely git-based, so say so rather than sit there empty.
  it("flags a folder that is not a repository", () => {
    workspace.open.push(repo("/tmp/notes", "notes", false));
    workspace.active = "/tmp/notes";

    render(SessionsPane);
    expect(screen.getByText("no git")).toBeInTheDocument();
  });

  // With codex installed too, every row says whose it is, the new-session
  // row offers the choice, and each agent's outside sessions fold apart.
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
    expect(screen.getByTestId("agent-tag")).toHaveTextContent("claude");
    // The new-session row opens, in place, into one row per agent.
    await fireEvent.click(screen.getByTestId("new-session"));
    expect(screen.queryByTestId("new-session")).toBeNull();
    const options = screen.getAllByTestId("agent-option");
    expect(options.map((option) => option.dataset.agent)).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(options[0]).toHaveTextContent("Claude Code");
    expect(options[1]).toHaveTextContent("Codex");

    await waitFor(() =>
      expect(screen.getAllByTestId("outside-fold")).toHaveLength(2),
    );
    const folds = screen.getAllByTestId("outside-fold");
    expect(folds[0]).toHaveTextContent("1 claude session to resume");
    expect(folds[1]).toHaveTextContent("1 codex session to resume");

    await fireEvent.click(options[1]);
    expect(sessions.all.at(-1)?.agent).toBe("codex");
    expect(layout.focus).toBe("agent");
    expect(screen.queryByTestId("agent-choice")).toBeNull();
    expect(screen.getByTestId("new-session")).toBeInTheDocument();

    await fireEvent.click(folds[1]);
    await fireEvent.click(screen.getByTestId("outside-session"));
    const resumed = sessions.all.at(-1)!;
    expect(resumed.agent).toBe("codex");
    expect(resumed.resumedFrom).toBe("x1");
    expect(resumed.title).toBeNull();
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
    await fireEvent.keyDown(nav, { key: "ArrowDown" });
    await fireEvent.keyDown(nav, { key: "Enter" });
    // Open, with the cursor on the project's default.
    let options = screen.getAllByTestId("agent-option");
    expect(options[0]).toHaveClass("cursor");
    expect(sessions.all).toHaveLength(0);

    // Escape closes it and puts the cursor back on the row.
    await fireEvent.keyDown(nav, { key: "Escape" });
    expect(screen.queryByTestId("agent-choice")).toBeNull();
    expect(screen.getByTestId("new-session").closest(".new-row")).toHaveClass(
      "cursor",
    );

    await fireEvent.keyDown(nav, { key: "Enter" });
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
    const rows = screen.getAllByTestId("session-row");
    expect(rows[0].querySelector(".dot")).toHaveClass("working");
    expect(rows[0]).toHaveTextContent("working");
    expect(rows[1].querySelector(".dot")).toHaveClass("unread");
    expect(rows[1]).toHaveTextContent("waiting for you");
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
    await fireEvent.click(screen.getAllByTestId("session-row")[1]);
    expect(workspace.active).toBe("/two");
    expect(sessions.active).toBe(theirs.key);
    expect(layout.focus).toBe("agent");
  });

  // Cmd+1, Down, Enter, type: the pane is one tab stop with a cursor in it.
  it("walks the rows with the keyboard and confirms with Enter", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    const first = create("/repo");
    started(first.key, "pty-1", "session-1");
    const second = create("/repo");
    started(second.key, "pty-2", "session-2");
    layout.focus = "sessions";

    render(SessionsPane);
    const nav = screen.getByTestId("sessions-nav");
    await waitFor(() => expect(document.activeElement).toBe(nav));

    // The cursor starts on the session you are in.
    await fireEvent.keyDown(nav, { key: "ArrowUp" });
    await fireEvent.keyDown(nav, { key: "Enter" });
    expect(sessions.active).toBe(first.key);
    expect(layout.focus).toBe("agent");
  });

  // Down goes through the rows in the order the pane shows them: the new
  // session row sits between the sessions and the fold.
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
      expect(screen.getByTestId("outside-fold")).toBeInTheDocument(),
    );

    await fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(screen.getByTestId("new-session").closest("[data-row]")).toHaveClass(
      "cursor",
    );
    await fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(screen.getByTestId("outside-fold")).toHaveClass("cursor");
    await fireEvent.keyDown(nav, { key: "Enter" });
    await fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(screen.getByTestId("outside-session")).toHaveClass("cursor");
  });

  // Nothing in the pane needs the mouse: the way in sits on the same
  // cursor as the rows, and Delete does what the × on a row does.
  it("reaches Open project and Remote from the keyboard, and closes with Delete", async () => {
    workspace.open.push(repo("/repo", "repo"), repo("/other", "other"));
    workspace.active = "/repo";
    layout.focus = "sessions";
    fake.picked = 0;

    render(SessionsPane);
    const nav = screen.getByTestId("sessions-nav");
    // The cursor starts on the project you are in, not on the way in.
    expect(screen.getByTestId("open-project")).not.toHaveClass("cursor");
    await fireEvent.keyDown(nav, { key: "Home" });
    expect(screen.getByTestId("open-project")).toHaveClass("cursor");
    await fireEvent.keyDown(nav, { key: "Enter" });
    expect(fake.picked).toBe(1);
    await fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(screen.getByTestId("open-remote")).toHaveClass("cursor");
    await fireEvent.keyDown(nav, { key: "Enter" });
    expect(remote.open).toBe(true);

    await fireEvent.keyDown(nav, { key: "ArrowDown" });
    await fireEvent.keyDown(nav, { key: "Delete" });
    expect(workspace.open.map((project) => project.path)).toEqual(["/other"]);
  });

  it("starts a new session from the keyboard", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    layout.focus = "sessions";

    render(SessionsPane);
    const nav = screen.getByTestId("sessions-nav");
    // The last row is the new-session row.
    await fireEvent.keyDown(nav, { key: "End" });
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
    await fireEvent.click(screen.getAllByTestId("session-row")[0]);

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
    expect(screen.queryByTestId("outside-fold")).not.toBeInTheDocument();
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
      expect(screen.getByTestId("outside-fold")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("outside-fold")).toHaveTextContent(
      "2 claude sessions to resume",
    );
    expect(screen.queryByTestId("past-session")).not.toBeInTheDocument();
    expect(screen.queryByTestId("outside-session")).not.toBeInTheDocument();

    await fireEvent.click(screen.getByTestId("outside-fold"));
    expect(screen.getAllByTestId("outside-session")).toHaveLength(2);
    expect(screen.getByText("from a terminal")).toBeInTheDocument();
  });

  it("opens a past session as a live one, resumed by id", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    fake.transcripts = [
      { id: "abc-123", title: "earlier work", modified: 1000, size: 400 },
    ];

    render(SessionsPane);
    await waitFor(() =>
      expect(screen.getByTestId("outside-fold")).toBeInTheDocument(),
    );
    await fireEvent.click(screen.getByTestId("outside-fold"));
    await fireEvent.click(screen.getByTestId("outside-session"));

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
      expect(screen.getByTestId("outside-fold")).toBeInTheDocument(),
    );
    await fireEvent.click(screen.getByTestId("outside-fold"));
    await fireEvent.click(screen.getByTestId("outside-session"));

    await waitFor(() =>
      expect(screen.queryByTestId("outside-session")).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId("outside-fold")).not.toBeInTheDocument();
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

  it("only offers a new session in the project you are looking at", () => {
    workspace.open.push(repo("/one", "one"), repo("/two", "two"));
    workspace.active = "/one";

    render(SessionsPane);
    expect(screen.getAllByTestId("new-session")).toHaveLength(1);
  });

  it("lists recent projects that are not open", () => {
    workspace.recent = ["/home/ada/dev/one", "/home/ada/dev/two"];
    workspace.open.push(repo("/home/ada/dev/one", "one"));

    render(SessionsPane);
    expect(screen.getByText("~/dev/two")).toBeInTheDocument();
    expect(screen.queryByText("~/dev/one")).not.toBeInTheDocument();
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

  it("stops at the ends rather than wrapping", async () => {
    await renderChanges();
    await fireEvent.keyDown(tree(), { key: "ArrowUp" });
    expect(cursorName()).toBe("src");
    await fireEvent.keyDown(tree(), { key: "End" });
    await fireEvent.keyDown(tree(), { key: "ArrowDown" });
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
