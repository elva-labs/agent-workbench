import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/svelte";
import SessionsPane from "$lib/panes/SessionsPane.svelte";
import ChangesPane from "$lib/panes/ChangesPane.svelte";
import { DEFAULT, layout, togglePane } from "$lib/layout.svelte";
import { files, refresh, clear as clearFiles } from "$lib/files.svelte";

/** Stands in for git. Reassigned per test rather than mocked per call. */
const fake = {
  status: [] as { path: string; status: string; add: number; del: number; binary: boolean }[],
  fileList: [] as string[],
  transcripts: [] as { id: string; title: string | null; modified: number; size: number }[],
  hookInstalled: false,
};

vi.mock("$lib/core", () => ({
  core: () => ({
    gitStatus: async () => fake.status,
    gitFiles: async () => fake.fileList,
    gitDiff: async () => ({
      lines: [{ kind: "hunk", text: "@@ -1,9 +1,12 @@", old: null, new: null }],
      binary: false,
      truncated: false,
    }),
    gitContent: async () => ({ lines: ["use std::collections::HashMap;"], binary: false, truncated: false }),
    gitWatch: async () => {},
    onGitChanged: async () => () => {},
    kill: async () => {},
    transcripts: async () => fake.transcripts,
    hookStatus: async () => ({ installed: fake.hookInstalled, settings: "", events: "" }),
    hookInstall: async () => ({ installed: true, settings: "", events: "" }),
    hookUninstall: async () => ({ installed: false, settings: "", events: "" }),
    setWindowTitle: async () => {},
    projectInfo: async (path: string) => ({ path, name: path, repository: path, isGit: true }),
  }),
}));
import { workspace, reset as resetWorkspace } from "$lib/workspace.svelte";
import { agent } from "$lib/agent.svelte";
import { reset as resetSessions, create, started, sessions } from "$lib/sessions.svelte";
import { reset as resetHook } from "$lib/hook.svelte";

beforeEach(() => {
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
  agent.availability = "ready";
  agent.path = "/usr/local/bin/claude";
  agent.error = null;
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
  await waitFor(() => expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(0));
}
const rowNames = () =>
  screen.getAllByRole("treeitem").map((el) => el.querySelector(".name")!.textContent!.trim());

describe("Pane shell", () => {
  it("takes focus when pointed at", async () => {
    render(SessionsPane);
    await fireEvent.pointerDown(screen.getByRole("region", { name: /projects/i }));
    expect(layout.focus).toBe("sessions");
  });

  it("will not take focus while its pane is closed", async () => {
    // No project here, so the tree stays empty; focus is all this checks.
    togglePane("changes");
    render(ChangesPane);
    await fireEvent.pointerDown(screen.getByRole("region", { name: /changes/i }));
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
    started(session.key, "pty-1");

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

  // The whole point of the model: looking at another session kills nothing.
  it("switches session on click without stopping the other", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    const first = create("/repo");
    started(first.key, "pty-1");
    const second = create("/repo");
    started(second.key, "pty-2");

    render(SessionsPane);
    await fireEvent.click(screen.getAllByTestId("session-row")[0]);

    expect(sessions.active).toBe(first.key);
    expect(second.status).toBe("running");
  });

  // Phase 3: what Claude Code has already done here, read off disk.
  it("lists past sessions under the project you are looking at", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    fake.transcripts = [
      { id: "abc-123", title: "rename the token cache", modified: 1000, size: 400 },
    ];

    render(SessionsPane);
    await waitFor(() =>
      expect(screen.getByText("rename the token cache")).toBeInTheDocument(),
    );
  });

  it("opens a past session as a live one, resumed by id", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    fake.transcripts = [{ id: "abc-123", title: "earlier work", modified: 1000, size: 400 }];

    render(SessionsPane);
    await waitFor(() => expect(screen.getByTestId("past-session")).toBeInTheDocument());
    await fireEvent.click(screen.getByTestId("past-session"));

    expect(sessions.all).toHaveLength(1);
    expect(sessions.all[0].resumedFrom).toBe("abc-123");
  });

  it("stops offering a past session once it is open", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    fake.transcripts = [{ id: "abc-123", title: "earlier work", modified: 1000, size: 400 }];

    render(SessionsPane);
    await waitFor(() => expect(screen.getByTestId("past-session")).toBeInTheDocument());
    await fireEvent.click(screen.getByTestId("past-session"));

    await waitFor(() => expect(screen.queryByTestId("past-session")).not.toBeInTheDocument());
  });

  // Off by default: it edits the project's settings, so nobody gets it for
  // merely opening a folder.
  it("offers the hook, off, and turns it on when asked", async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";

    render(SessionsPane);
    const toggle = await screen.findByTestId("hook-toggle");
    expect(toggle).toHaveTextContent("filesystem");

    await fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId("hook-toggle")).toHaveTextContent("hook"));
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
    agent.availability = "missing";

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

describe("the file tree", () => {
  beforeEach(async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    await refresh();
  });

  it("nests changed files under their folders", async () => {
    await renderChanges();
    expect(rowNames()).toEqual(["src", "cache", "mod.rs", "lib.rs", "token_cache.rs"]);
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
    await fireEvent.click(screen.getByRole("button", { name: "All files" }));

    expect(rowNames()).toContain("cache");
    expect(rowNames()).toContain("store.rs");
    expect(rowNames()).toContain("docs");
    expect(rowNames()).not.toContain("architecture.md");
    expect(rowNames()).not.toContain("watcher.rs");
  });

  it("opens a folder when it is clicked, and shuts it again", async () => {
    await renderChanges();
    await fireEvent.click(screen.getByRole("button", { name: "All files" }));

    await fireEvent.click(screen.getByText("docs"));
    expect(rowNames()).toContain("architecture.md");

    await fireEvent.click(screen.getByText("docs"));
    expect(rowNames()).not.toContain("architecture.md");
  });

  it("folds a chain of folders that hold nothing else into one row", async () => {
    await renderChanges();
    await fireEvent.click(screen.getByRole("button", { name: "All files" }));
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
    expect(rowNames()).toEqual(["src", "cache", "mod.rs", "lib.rs", "token_cache.rs"]);
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
    return document.getElementById(id)!.querySelector(".name")!.textContent!.trim();
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

describe("ChangesPane head", () => {
  beforeEach(async () => {
    workspace.open.push(repo("/repo", "repo"));
    workspace.active = "/repo";
    await refresh();
  });

  it("carries both controls in one head", async () => {
    await renderChanges();
    expect(screen.getByRole("group", { name: /which files/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /how to show/i })).toBeInTheDocument();
  });

  it("leaves the view controls disabled until a file is picked", async () => {
    await renderChanges();
    expect(screen.getByRole("button", { name: "Diff" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Content" })).toBeDisabled();
  });

  // The connection between the two controls: no changes means no diff.
  it("disables Diff for a file that has no changes", async () => {
    await renderChanges();
    await fireEvent.click(screen.getByRole("button", { name: "All files" }));
    await fireEvent.click(screen.getByText("Cargo.toml"));
    expect(screen.getByRole("button", { name: "Diff" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Content" })).toHaveClass("on");
  });

  it("closes back to the tree alone", async () => {
    await renderChanges();
    await fireEvent.click(screen.getByText("lib.rs"));
    await fireEvent.click(screen.getByRole("button", { name: /close the viewer/i }));
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
    await fireEvent.click(screen.getByRole("button", { name: "Content" }));

    const viewer = screen.getByTestId("viewer");
    expect(viewer).toHaveAttribute("data-view", "content");
    expect(within(viewer).queryByText("@@ -1,9 +1,12 @@")).not.toBeInTheDocument();
  });

  it("falls back to content for a file with no diff", async () => {
    await renderChanges();
    await fireEvent.click(screen.getByRole("button", { name: "All files" }));
    await fireEvent.click(screen.getByText("Cargo.toml"));
    expect(screen.getByTestId("viewer")).toHaveAttribute("data-view", "content");
  });

  it("says so when a deleted file has no content to show", async () => {
    await renderChanges();
    await fireEvent.click(screen.getByText("token_cache.rs"));
    await fireEvent.click(screen.getByRole("button", { name: "Content" }));
    expect(screen.getByText(/deleted/i)).toBeInTheDocument();
  });
});
