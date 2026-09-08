import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectLabel, reset, workspace } from "$lib/workspace.svelte";

vi.mock("$lib/core", () => ({ core: () => ({}) }));

const repo = (path: string) => ({
  path,
  name: path.split(/[\\/]/).pop()!,
  repository: path,
  isGit: true,
});

beforeEach(() => reset());

describe("what a project is called", () => {
  it("is the folder's name on its own", () => {
    workspace.open.push(repo("/home/ada/dev/one"));
    expect(projectLabel("/home/ada/dev/one")).toBe("one");
  });

  // Two checkouts of the same repository, told apart by where they are.
  it("takes as much of the path as tells two of the same name apart", () => {
    workspace.open.push(
      repo("/home/ada/work/main-truck"),
      repo("/home/ada/spike/main-truck"),
    );
    expect(projectLabel("/home/ada/work/main-truck")).toBe("work/main-truck");
    expect(projectLabel("/home/ada/spike/main-truck")).toBe("spike/main-truck");
  });

  it("goes as deep as it must", () => {
    workspace.open.push(repo("/a/x/main-truck"), repo("/b/x/main-truck"));
    expect(projectLabel("/a/x/main-truck")).toBe("a/x/main-truck");
    expect(projectLabel("/b/x/main-truck")).toBe("b/x/main-truck");
  });

  it("reads past a remote's host and a Windows drive", () => {
    workspace.open.push(
      repo("ssh://lab/srv/demo"),
      repo("C:\\Users\\ada\\dev\\demo"),
    );
    expect(projectLabel("ssh://lab/srv/demo")).toBe("srv/demo");
    expect(projectLabel("C:\\Users\\ada\\dev\\demo")).toBe("dev/demo");
  });

  it("is the folder's name for a path that is not open", () => {
    expect(projectLabel("/home/ada/dev/elsewhere")).toBe("elsewhere");
  });
});
