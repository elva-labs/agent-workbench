import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentSelection } from "$lib/selection.svelte";
import { clear, files, pick } from "$lib/files.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

vi.mock("$lib/core", () => ({
  core: () => ({
    async setWindowTitle() {},
    async projectInfo(path: string) {
      return { path, name: path, repository: path, isGit: true };
    },
    async setSelection() {},
  }),
}));

const repo = (path: string) => ({
  path,
  name: path.split("/").pop()!,
  repository: path,
  isGit: true,
});

beforeEach(() => {
  resetWorkspace();
  clear();
  files.view = "diff";
  files.media = null;
  files.target = null;
  workspace.open.push(repo("/one"), repo("ssh://ada@lab/srv/two"));
  workspace.active = "/one";
});

describe("what is on record", () => {
  it("is nothing with no project, and none with nothing open", () => {
    workspace.active = null;
    expect(currentSelection()).toBeNull();
    workspace.active = "/one";
    expect(currentSelection()).toEqual({ project: "/one", selection: null });
  });

  it("is the file, its view and the lines highlighted", () => {
    files.selected = "src/a.rs";
    files.view = "diff";
    expect(currentSelection()?.selection).toEqual({
      project: "/one",
      file: "/one/src/a.rs",
      view: "diff",
      from: null,
      to: null,
      media: null,
    });
    files.view = "content";
    files.target = { path: "src/a.rs", line: 3, to: 5, note: "Here." };
    expect(currentSelection()?.selection).toMatchObject({
      view: "file",
      from: 3,
      to: 5,
    });
    // A target on another file, or a note with no line, marks nothing.
    files.target = { path: "src/b.rs", line: 3 };
    expect(currentSelection()?.selection).toMatchObject({
      from: null,
      to: null,
    });
    files.target = { path: "src/a.rs", line: 0, note: "The rename." };
    expect(currentSelection()?.selection).toMatchObject({
      from: null,
      to: null,
    });
  });

  it("prefers the lines the user selected to the ones pointed at", () => {
    files.selected = "src/a.rs";
    files.target = { path: "src/a.rs", line: 3, to: 5, note: "Here." };
    pick({ from: 12, to: 8 });
    expect(currentSelection()?.selection).toMatchObject({ from: 8, to: 12 });
    pick(null);
    expect(currentSelection()?.selection).toMatchObject({ from: 3, to: 5 });
    // A pick belongs to its file: choosing another drops it.
    pick({ from: 1, to: 1 });
    files.selected = "src/b.rs";
    expect(files.picked?.path).toBe("src/a.rs");
    expect(currentSelection()?.selection).toMatchObject({
      from: null,
      to: null,
    });
  });

  it("is what was presented when the viewer holds that", () => {
    files.media = {
      id: "m1",
      owner: "s1",
      project: "/one",
      files: ["/one/shots/a.png", "/one/shots/b.png"],
      caption: "Both.",
      at: 1,
    };
    expect(currentSelection()?.selection).toEqual({
      project: "/one",
      file: null,
      view: null,
      from: null,
      to: null,
      media: {
        files: ["/one/shots/a.png", "/one/shots/b.png"],
        caption: "Both.",
      },
    });
  });

  it("names paths as the remote sees them, without the host", () => {
    workspace.active = "ssh://ada@lab/srv/two";
    files.selected = "lib/x.rs";
    const now = currentSelection();
    expect(now?.project).toBe("ssh://ada@lab/srv/two");
    expect(now?.selection).toMatchObject({
      project: "/srv/two",
      file: "/srv/two/lib/x.rs",
    });
  });
});
