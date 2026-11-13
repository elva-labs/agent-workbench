import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetViewers, sessionShown, snapshot, unfoldSessions } from "$lib/viewers.svelte";
import {
  clear,
  closeViewer,
  files,
  refresh,
  showBrowser,
  showMedia,
  showPluginView,
  showRange,
} from "$lib/files.svelte";
import { browser, resetBrowser } from "$lib/browser.svelte";
import { enterReview, layout } from "$lib/layout.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

/** The sessions the window knows, by key, with the project each is in. */
const known = new Map<string, string>();

vi.mock("$lib/sessions.svelte", async (original) => ({
  ...(await original<typeof import("$lib/sessions.svelte")>()),
  byKey: (key: string) => {
    const project = known.get(key);
    return project === undefined ? null : { key, project };
  },
}));

vi.mock("$lib/core", () => ({
  core: () => ({
    async setWindowTitle() {},
    async projectInfo(path: string) {
      return { path, name: path, repository: path, isGit: true };
    },
    async gitStatus() {
      return [{ path: "docs/a.md", status: "M", add: 1, del: 0, binary: false }];
    },
    async gitFiles() {
      return ["docs/a.md", "src/b.rs"];
    },
    async gitDiff() {
      return { lines: [], binary: false, truncated: false };
    },
    async gitContent() {
      return { lines: ["one", "two", "three"], binary: false, truncated: false };
    },
    async setSelection() {},
    async watchShown() {},
    async browserFocus() {
      return { tabs: browser.tabs, owner: browser.owner, active: browser.active };
    },
    async browserPlace() {},
    async browserHide() {},
    async browserActivate(id: number) {
      activated.push(id);
      front(id);
      return { tabs: browser.tabs, owner: browser.owner, active: id };
    },
  }),
}));

/** Makes `id` the front tab among the tabs held, the way the core reports it. */
function front(id: number) {
  browser.tabs = browser.tabs.map((each) => ({ ...each, front: each.id === id }));
  browser.active = id;
}

/** The tabs the fake core was asked to bring to the front. */
const activated: number[] = [];

const repo = (path: string) => ({
  path,
  name: path.split("/").pop()!,
  repository: path,
  isGit: true,
});

const item = {
  id: "m1",
  owner: "a",
  project: "/one",
  files: ["/tmp/draft.md"],
  caption: "The draft.",
  at: 1,
};

beforeEach(async () => {
  resetWorkspace();
  clear();
  resetViewers();
  known.clear();
  known.set("a", "/one");
  known.set("b", "/one");
  layout.mode = "working";
  layout.focus = "agent";
  layout.width = 1600;
  files.media = null;
  files.pluginView = null;
  resetBrowser();
  workspace.open.push(repo("/one"), repo("/two"));
  workspace.active = "/one";
  await refresh();
});

describe("what a session had in the viewer", () => {
  it("is nothing while the viewer is closed", () => {
    files.selected = "docs/a.md";
    expect(snapshot()).toBeNull();
  });

  it("is the file, its view and the place marked in it", async () => {
    await showRange("docs/a.md", 2, 3, "Here.");
    expect(snapshot()).toEqual({
      kind: "file",
      project: "/one",
      path: "docs/a.md",
      view: "content",
      target: { path: "docs/a.md", line: 2, to: 3, note: "Here." },
      picked: null,
    });
  });

  it("is what the agent presented", () => {
    showMedia(item);
    expect(snapshot()).toEqual({ kind: "media", project: "/one", item });
  });
});

describe("switching sessions", () => {
  it("keeps the viewer of the session left and brings it back", async () => {
    await sessionShown("a");
    await showRange("docs/a.md", 2, 2, null);
    expect(layout.mode).toBe("reviewing");

    // The other session had nothing: the viewer closes.
    await sessionShown("b");
    expect(files.selected).toBeNull();
    expect(layout.mode).toBe("working");

    await sessionShown("a");
    expect(files.selected).toBe("docs/a.md");
    expect(files.view).toBe("content");
    expect(files.target).toEqual({ path: "docs/a.md", line: 2, to: 2, note: null });
    expect(layout.mode).toBe("reviewing");
  });

  it("keeps what opening the sessions pane closed, for the session it was open beside", async () => {
    await sessionShown("a");
    showMedia(item);
    unfoldSessions();
    expect(layout.mode).toBe("working");
    await sessionShown("b");
    await sessionShown("a");
    expect(files.media).toEqual(item);
    expect(layout.mode).toBe("reviewing");
  });

  it("lets a document opened after the pane was opened take the parked one's place", async () => {
    await sessionShown("a");
    showMedia(item);
    unfoldSessions();
    await showRange("docs/a.md", 1, 1, null);
    await sessionShown("b");
    await sessionShown("a");
    expect(files.media).toBeNull();
    expect(files.selected).toBe("docs/a.md");
  });

  it("leaves the keyboard where picking the session put it", async () => {
    await sessionShown("a");
    await showRange("docs/a.md", 2, 2, null);
    await sessionShown("b");
    layout.focus = "agent";
    await sessionShown("a");
    expect(layout.mode).toBe("reviewing");
    expect(layout.focus).toBe("agent");
  });

  it("keeps a plugin's page and the browser the same way", async () => {
    const page = {
      key: "p:board",
      source: "board",
      plugin: "p",
      project: "/one",
      width: "wide" as const,
      html: "<p>Board</p>",
    };
    await sessionShown("a");
    showPluginView(page);
    await sessionShown("b");
    showBrowser();
    expect(files.pluginView).toBeNull();
    expect(browser.showing).toBe(true);

    await sessionShown("a");
    expect(files.pluginView).toEqual(page);
    expect(browser.showing).toBe(false);
    expect(layout.mode).toBe("reviewing");

    await sessionShown("b");
    expect(files.pluginView).toBeNull();
    expect(browser.showing).toBe(true);
    expect(layout.mode).toBe("reviewing");
  });

  it("puts the browser back on the tab it was left on", async () => {
    const tab = (id: number) => ({
      id,
      url: `http://localhost:${id}/`,
      title: "",
      home: `http://localhost:${id}/`,
      opener: { kind: "user" as const },
      owner: { kind: "project" as const, path: "/one" },
      front: false,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
    });
    browser.tabs = [tab(1), tab(2)];
    browser.owner = { kind: "project", path: "/one" };
    front(1);
    await sessionShown("a");
    showBrowser();
    expect(snapshot()).toEqual({ kind: "browser", project: "/one", tab: 1 });

    await sessionShown("b");
    // The session's agent brought another tab to the front meanwhile.
    front(2);
    showBrowser();

    await sessionShown("a");
    expect(activated).toEqual([1]);
    expect(browser.active).toBe(1);
    expect(browser.showing).toBe(true);

    // Its tab closed in between: the browser comes back on whatever is active.
    await sessionShown("b");
    browser.tabs = [tab(2)];
    front(2);
    activated.length = 0;
    await sessionShown("a");
    expect(activated).toEqual([]);
    expect(browser.showing).toBe(true);
  });

  it("opens the viewer again for a session that had one, after it was closed elsewhere", async () => {
    await sessionShown("a");
    showMedia(item);
    await sessionShown("b");
    closeViewer();
    expect(layout.mode).toBe("working");

    await sessionShown("a");
    expect(files.media).toEqual(item);
    expect(layout.mode).toBe("reviewing");
  });

  it("takes a file that git has not changed from the whole tree", async () => {
    await sessionShown("a");
    await showRange("src/b.rs", 1, 1, null);
    await sessionShown("b");
    files.scope = "changed";
    await sessionShown("a");
    expect(files.scope).toBe("all");
    expect(files.selected).toBe("src/b.rs");
  });

  it("remembers the viewer as it was left, not as it was first opened", async () => {
    await sessionShown("a");
    await showRange("docs/a.md", 1, 1, null);
    closeViewer();
    await sessionShown("b");
    await sessionShown("a");
    expect(files.selected).toBeNull();
    expect(layout.mode).toBe("working");
  });

  it("forgets a session that is gone", async () => {
    await sessionShown("a");
    await showRange("docs/a.md", 1, 1, null);
    await sessionShown("b");
    known.delete("a");
    await sessionShown("b");
    known.set("a", "/one");
    await sessionShown("a");
    expect(files.selected).toBeNull();
  });

  it("keeps the viewer of a session left for another project, under its own", async () => {
    known.set("b", "/two");
    await sessionShown("a");
    await showRange("docs/a.md", 2, 2, null);

    // Picking a session of another project moves the project first; the
    // switch is seen next, and then the tree clears itself and reads the
    // new one.
    workspace.active = "/two";
    let switching = sessionShown("b");
    clear();
    void refresh();
    await switching;
    expect(files.selected).toBeNull();
    expect(layout.mode).toBe("working");

    workspace.active = "/one";
    switching = sessionShown("a");
    clear();
    void refresh();
    await switching;
    expect(files.selected).toBe("docs/a.md");
    expect(files.scope).toBe("changed");
    expect(layout.mode).toBe("reviewing");
  });

  it("leaves a viewer from another project alone", async () => {
    await sessionShown("a");
    await showRange("docs/a.md", 1, 1, null);
    await sessionShown("b");
    workspace.active = "/two";
    clear();
    enterReview();
    await sessionShown("a");
    expect(files.selected).toBeNull();
  });
});
