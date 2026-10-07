import { beforeEach, describe, expect, it, vi } from "vitest";
import { viewedFiles } from "$lib/viewed.svelte";
import { clear, files } from "$lib/files.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

vi.mock("$lib/core", () => ({
  core: () => ({
    async setWindowTitle() {},
    async projectInfo(path: string) {
      return { path, name: path, repository: path, isGit: true };
    },
    async watchShown() {},
  }),
}));

const repo = (path: string) => ({
  path,
  name: path.split("/").pop()!,
  repository: path,
  isGit: true,
});

const item = (...paths: string[]) => ({
  id: "m1",
  owner: "s1",
  project: "/one",
  files: paths,
  caption: null,
  at: 1,
});

beforeEach(() => {
  resetWorkspace();
  clear();
  files.media = null;
  workspace.open.push(repo("/one"), repo("ssh://ada@lab/srv/two"));
  workspace.active = "/one";
});

describe("what the viewer reads from disk", () => {
  it("is nothing with no project, and none with nothing open", () => {
    workspace.active = null;
    expect(viewedFiles()).toBeNull();
    workspace.active = "/one";
    expect(viewedFiles()).toEqual({ project: "/one", files: [] });
  });

  it("is every file of what the agent presented", () => {
    files.media = item("/tmp/scratch/draft.md", "/tmp/scratch/shot.png");
    expect(viewedFiles()).toEqual({
      project: "/one",
      files: ["/tmp/scratch/draft.md", "/tmp/scratch/shot.png"],
    });
  });

  it("is the presented files without their host, for the machine they are on", () => {
    workspace.active = "ssh://ada@lab/srv/two";
    files.media = item("ssh://ada@lab/tmp/draft.md");
    expect(viewedFiles()).toEqual({
      project: "ssh://ada@lab/srv/two",
      files: ["/tmp/draft.md"],
    });
  });

  it("is a document rendered or a picture, and nothing for a diff or content", () => {
    files.scope = "all";
    files.everything = [
      { path: "docs/a.md", status: null },
      { path: "shot.png", status: "A", binary: true },
      { path: "src/a.rs", status: "M" },
    ];
    files.everythingLoaded = true;

    files.selected = "docs/a.md";
    files.view = "rendered";
    expect(viewedFiles()?.files).toEqual(["/one/docs/a.md"]);
    files.view = "content";
    expect(viewedFiles()?.files).toEqual([]);

    files.selected = "shot.png";
    files.view = "diff";
    expect(viewedFiles()?.files).toEqual(["/one/shot.png"]);

    files.selected = "src/a.rs";
    files.view = "rendered";
    expect(viewedFiles()?.files).toEqual([]);
  });
});
