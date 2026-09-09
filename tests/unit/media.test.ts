import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  itemsFor,
  listed,
  load,
  loadMedia,
  media,
  openItem,
  ownerFor,
  presented,
  render,
  resetMedia,
} from "$lib/media.svelte";
import { closeViewer, files } from "$lib/files.svelte";
import { layout } from "$lib/layout.svelte";
import {
  create,
  located,
  reset as resetSessions,
  select,
  started,
} from "$lib/sessions.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

vi.mock("$lib/core", () => ({
  core: () => ({
    async setWindowTitle() {},
    async projectInfo(path: string) {
      return { path, name: path, repository: path, isGit: true };
    },
    async ptyCwd() {
      return null;
    },
    async readMedia(path: string) {
      if (path.includes("missing")) throw new Error(`could not read ${path}`);
      if (path.endsWith(".md"))
        return { mime: "text/markdown", data: btoa("# Draft"), size: 7 };
      if (path.endsWith(".html"))
        return { mime: "text/html", data: btoa("<h1>Page</h1>"), size: 13 };
      if (path.endsWith(".mmd"))
        return {
          mime: "text/vnd.mermaid",
          data: btoa("graph TD; A-->B"),
          size: 15,
        };
      return {
        mime: path.endsWith(".pdf") ? "application/pdf" : "image/png",
        data: "AAAA",
        size: 3,
      };
    },
  }),
}));

const repo = (path: string) => ({
  path,
  name: path.split("/").pop()!,
  repository: path,
  isGit: true,
});
const request = (
  files: string[],
  cwd = "/one",
  caption: string | null = "Shots.",
  session: string | null = null,
) => ({ files, caption, cwd, session });

beforeEach(() => {
  localStorage.clear();
  resetMedia();
  closeViewer();
  resetWorkspace();
  resetSessions();
  workspace.open.push(repo("/one"), repo("/two"));
  workspace.active = "/one";
});

describe("whose media it is", () => {
  it("is the session the request names, by the agent's id", () => {
    const a = create("/one");
    started(a.key, "pty-1", "s1");
    const b = create("/one");
    started(b.key, "pty-2", "s2");
    // Two sessions in one directory: the request says which.
    expect(ownerFor(request(["/one/x.png"], "/one", null, "s2"), "/one")).toBe(
      "s2",
    );
    expect(ownerFor(request(["/one/x.png"], "/one", null, "s1"), "/one")).toBe(
      "s1",
    );
    // A session of another project is not the owner, whatever it is named.
    expect(ownerFor(request(["/one/x.png"], "/one", null, "s9"), "/one")).toBe(
      "s1",
    );
  });

  it("is the session running where the agent runs, else the project", async () => {
    const a = create("/one");
    started(a.key, "pty-1", "s1");
    const b = create("/one");
    started(b.key, "pty-2", "s2");
    await located(b.key, "/one/.claude/worktrees/w");
    expect(
      ownerFor(request(["/one/x.png"], "/one/.claude/worktrees/w"), "/one"),
    ).toBe("s2");
    expect(
      ownerFor(request(["/one/x.png"], "/one/.claude/worktrees/w/sub"), "/one"),
    ).toBe("s2");
    // The active session in the project when none is at that directory.
    select(a.key);
    expect(ownerFor(request(["/one/x.png"], "/elsewhere"), "/one")).toBe("s1");
    resetSessions();
    expect(ownerFor(request(["/one/x.png"]), "/one")).toBe("project:/one");
  });

  it("falls to the project while the session's id is not known", () => {
    const fresh = create("/one");
    select(fresh.key);
    expect(ownerFor(request(["/one/x.png"]), "/one")).toBe("project:/one");
  });
});

describe("presenting", () => {
  it("keeps the files on the session, brings the project forward and opens them in the viewer", () => {
    workspace.active = "/two";
    const session = create("/one");
    started(session.key, "pty-1", "s1");
    presented(request(["/one/a.png", "/one/b.pdf"]), 1_700_000_000_000);
    expect(workspace.active).toBe("/one");
    expect(files.media?.files).toEqual(["/one/a.png", "/one/b.pdf"]);
    expect(layout.mode).toBe("reviewing");
    expect(itemsFor("s1")).toHaveLength(1);
    expect(itemsFor("s1")[0].caption).toBe("Shots.");
    expect(listed()).toHaveLength(1);
  });

  it("does nothing for files outside every open project", () => {
    presented(request(["/nowhere/a.png"], "/nowhere"));
    expect(files.media).toBeNull();
    expect(media.items).toEqual([]);
  });

  it("survives a restart, newest first, and keeps fifty per owner", () => {
    for (let i = 0; i < 55; i += 1) {
      presented(request([`/one/${i}.png`]), 1_700_000_000_000 + i * 1000);
    }
    resetMedia();
    loadMedia();
    const mine = itemsFor("project:/one");
    expect(mine).toHaveLength(50);
    expect(mine[0].files).toEqual(["/one/54.png"]);
    expect(mine[49].files).toEqual(["/one/5.png"]);
  });

  it("opens a call again from the list, and closes with the viewer", () => {
    presented(request(["/one/a.png", "/one/b.png", "/one/c.png"]));
    closeViewer();
    expect(files.media).toBeNull();
    openItem(media.items[0]);
    expect(files.media?.id).toBe(media.items[0].id);
    expect(layout.mode).toBe("reviewing");
  });

  it("renders a Markdown document, its own HTML as text", async () => {
    const html = render("# Draft\n\nHello *there*, <b>plain</b>.");
    expect(html).toContain("<h1>Draft</h1>");
    expect(html).toContain("<em>there</em>");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b");
    const loaded = await load("/one/draft.md");
    expect("html" in loaded && loaded.html).toContain("<h1>");
  });

  // A document is the agent's, or came with a repository from anywhere.
  it("lets a link point only at the web, and an image only at the web or data", () => {
    const html = render(
      '[run](javascript:alert(1)) [site](https://example.com "Ex") [mail](mailto:a@b.c)\n\n![x](javascript:alert(2)) ![y](https://example.com/y.png)',
    );
    expect(html).not.toContain("javascript:");
    expect(html).toMatch(/<p>run <a /);
    expect(html).toContain(
      'href="https://example.com" title="Ex" rel="noopener noreferrer"',
    );
    expect(html).toContain('href="mailto:a@b.c"');
    expect(html).toContain('<img src="https://example.com/y.png" alt="y">');
    expect(html).toContain("x");
  });

  it("hands a page and a diagram over as their source", async () => {
    expect(await load("/one/page.html")).toEqual({
      mime: "text/html",
      page: "<h1>Page</h1>",
    });
    expect(await load("/one/flow.mmd")).toEqual({
      mime: "text/vnd.mermaid",
      diagram: "graph TD; A-->B",
    });
  });

  it("reads a file as a data URL, or says why it cannot", async () => {
    expect(await load("/one/a.png")).toEqual({
      url: "data:image/png;base64,AAAA",
      mime: "image/png",
    });
    const gone = await load("/one/missing.png");
    expect("error" in gone && gone.error).toContain("could not read");
  });
});
