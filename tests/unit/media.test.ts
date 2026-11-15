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
  renderSaid,
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
import { resetHeld, switched } from "$lib/show.svelte";

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
  resetHeld();
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
    // Two sessions in one directory: the request's token says which.
    expect(
      ownerFor(request(["/one/x.png"], "/one", null, b.token), "/one"),
    ).toBe("s2");
    expect(
      ownerFor(request(["/one/x.png"], "/one", null, a.token), "/one"),
    ).toBe("s1");
    // A plugin names the session by its id.
    expect(ownerFor(request(["/one/x.png"], "/one", null, "s2"), "/one")).toBe(
      "s2",
    );
  });

  it("is the project for a call that names no session the window knows, wherever it is made", () => {
    const a = create("/one");
    started(a.key, "pty-1", "s1");
    const b = create("/one");
    started(b.key, "pty-2", "s2");
    select(a.key);
    // Nothing is taken from the folder or from the session on screen.
    for (const session of [null, "made-up"]) {
      expect(ownerFor(request(["/one/x.png"], "/one", null, session), "/one")).toBe(
        "project:/one",
      );
    }
  });

  it("is the session that presents a file of a nested project", () => {
    workspace.open.push(repo("/one/sub"));
    const a = create("/one");
    started(a.key, "pty-1", "s1");
    const nested = create("/one/sub");
    started(nested.key, "pty-2", "s2");
    presented(request(["/one/sub/x.png"], "/one", "Shot.", a.token));
    expect(itemsFor("s1")).toHaveLength(1);
    expect(itemsFor("s1")[0].project).toBe("/one/sub");
    expect(itemsFor("s2")).toEqual([]);
    expect(itemsFor("project:/one/sub")).toEqual([]);
  });

  it("falls to the project while the session's id is not known", () => {
    const fresh = create("/one");
    select(fresh.key);
    expect(
      ownerFor(request(["/one/x.png"], "/one", null, fresh.token), "/one"),
    ).toBe("project:/one");
  });
});

describe("presenting", () => {
  it("keeps the files on the session, brings the project forward and opens them in the viewer", () => {
    workspace.active = "/two";
    const session = create("/one");
    started(session.key, "pty-1", "s1");
    presented(
      request(["/one/a.png", "/one/b.pdf"], "/one", "Shots.", session.token),
      1_700_000_000_000,
    );
    expect(workspace.active).toBe("/one");
    expect(files.media?.files).toEqual(["/one/a.png", "/one/b.pdf"]);
    expect(layout.mode).toBe("reviewing");
    expect(itemsFor("s1")).toHaveLength(1);
    expect(itemsFor("s1")[0].caption).toBe("Shots.");
    expect(listed()).toHaveLength(1);
  });

  it("keeps the files on a session the user is not looking at, and opens them on switching", () => {
    const a = create("/one");
    started(a.key, "pty-1", "s1");
    const b = create("/one");
    started(b.key, "pty-2", "s2");
    presented(
      request(["/one/a.png"], "/one", "Shot.", "s1"),
      1_700_000_000_000,
    );
    expect(itemsFor("s1")).toHaveLength(1);
    expect(files.media).toBeNull();
    expect(layout.mode).not.toBe("reviewing");
    select(a.key);
    switched(a.key);
    expect(files.media?.files).toEqual(["/one/a.png"]);
    expect(layout.mode).toBe("reviewing");
  });

  it("keeps one item for the same files, newest, with the latest caption", () => {
    const session = create("/one");
    started(session.key, "pty-1", "s1");
    const mine = (files: string[], caption: string | null = "Shots.") =>
      request(files, "/one", caption, session.token);
    presented(mine(["/one/draft.md"], "First."), 1_700_000_000_000);
    presented(mine(["/one/other.png"], "Other."), 1_700_000_001_000);
    const first = itemsFor("s1")[1];
    // The same file again, however it is listed: the item, not another.
    presented(mine(["/one/draft.md"], "Second."), 1_700_000_002_000);
    expect(itemsFor("s1")).toHaveLength(2);
    expect(itemsFor("s1")[0].id).toBe(first.id);
    expect(itemsFor("s1")[0].caption).toBe("Second.");
    expect(itemsFor("s1")[0].at).toBe(1_700_000_002);
    expect(files.media?.id).toBe(first.id);
    // A set is the same set in any order; a different set is another item.
    presented(mine(["/one/b.png", "/one/a.png"]), 1_700_000_003_000);
    presented(mine(["/one/a.png", "/one/b.png"]), 1_700_000_004_000);
    presented(mine(["/one/a.png"]), 1_700_000_005_000);
    expect(itemsFor("s1")).toHaveLength(4);
    expect(itemsFor("s1")[1].files).toEqual(["/one/a.png", "/one/b.png"]);
    // Another session's item is its own.
    const other = create("/one");
    started(other.key, "pty-2", "s2");
    presented(request(["/one/draft.md"], "/one", "Theirs.", other.token));
    expect(itemsFor("s1")).toHaveLength(4);
    expect(itemsFor("s2")).toHaveLength(1);
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

describe("what an agent says in a conversation", () => {
  it("is rendered as a document is, with an image from an address shown as a link to it", () => {
    const html = renderSaid(
      "Look ![chart](https://example.com/leak?x=secret) and ![dot](data:image/png;base64,AAAA) and [docs](https://example.com) <img src=x>",
    );
    expect(html).not.toContain('src="https://example.com');
    expect(html).toContain('<a href="https://example.com/leak?x=secret" rel="noopener noreferrer">chart</a>');
    expect(html).toContain('<img src="data:image/png;base64,AAAA" alt="dot">');
    expect(html).toContain('<a href="https://example.com" rel="noopener noreferrer">docs</a>');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
    expect(renderSaid("![x](javascript:alert(1))")).not.toContain("javascript:");
  });
});

describe("code in Markdown", () => {
  it("shows a less-than sign as itself, in fenced code, in inline code and in text", () => {
    const md = "If `a < b` then:\n\n```ts\nif (a < b && c > d) { return `<b>${a}</b>`; }\n```\n\nand 1 < 2.";
    for (const html of [renderSaid(md), render(md)]) {
      expect(html).not.toContain("&amp;lt;");
      expect(html).toContain("<code>a &lt; b</code>");
      expect(html).toContain("if (a &lt; b &amp;&amp; c &gt; d) { return `&lt;b&gt;${a}&lt;/b&gt;`; }");
      expect(html).toContain("1 &lt; 2");
      const box = document.createElement("div");
      box.innerHTML = html;
      expect(box.querySelector("pre code")?.textContent).toBe("if (a < b && c > d) { return `<b>${a}</b>`; }\n");
      expect(box.querySelector("p code")?.textContent).toBe("a < b");
    }
  });

  it("still draws raw HTML as its text, inline and as a block", () => {
    for (const html of [renderSaid("Hi <b>there</b>\n\n<div onclick=x>block</div>"), render("Hi <b>there</b>\n\n<div onclick=x>block</div>")]) {
      const box = document.createElement("div");
      box.innerHTML = html;
      expect(box.querySelector("b, div")).toBeNull();
      expect(box.textContent).toContain("<b>there</b>");
      expect(box.textContent).toContain("<div onclick=x>block</div>");
    }
  });
});

describe("what Markdown may draw", () => {
  const ELEMENTS = new Set(
    "P,BR,EM,STRONG,DEL,CODE,PRE,A,IMG,UL,OL,LI,BLOCKQUOTE,H1,H2,H3,H4,H5,H6,HR,TABLE,THEAD,TBODY,TR,TH,TD,INPUT".split(","),
  );
  const PAYLOADS = [
    "x <code> <img/src=x onerror=alert(1)>",
    "<pre> <svg/onload=alert(1)>",
    "<kbd> <img/src=x onerror=1> </kbd>",
    "<script> <iframe/src=javascript:1>",
    "a <!-- x --> <img src=x onerror=1>",
    "`x` <b onmouseover=1>y</b>",
    "<details><summary>a</summary><img src=x onerror=1></details>",
    "[a](javascript:alert(1)) ![b](javascript:alert(1))",
    "* <code>\n* <img/src=x onerror=1>",
    "> <pre>\n> <img/src=x onerror=1>",
    "| <code> | <img/src=x onerror=1> |\n| --- | --- |\n| a | b |",
    // Entities that spell markup, before a raw tag and anywhere else.
    "&lt;img src=x onerror=alert(1)&gt;",
    "&#60;script&#62;alert(1)&#60;/script&#62;",
    "&#x3C;svg/onload=1&#x3E; <code> &lt;b onmouseover=1&gt;",
    "[a](&#106;avascript:alert(1)) [b](java&#115;cript:1)",
    "&amp;lt;img src=x onerror=1&amp;gt;",
  ];

  it("draws nothing but Markdown's own elements, with no handlers and no scripted links", () => {
    for (const markdown of PAYLOADS)
      for (const html of [render(markdown), renderSaid(markdown)]) {
        const box = document.createElement("div");
        box.innerHTML = html;
        for (const element of box.querySelectorAll("*")) {
          expect(ELEMENTS.has(element.tagName), `${element.tagName} from ${markdown}`).toBe(true);
          for (const attribute of element.attributes) {
            expect(attribute.name.startsWith("on"), `${attribute.name} from ${markdown}`).toBe(false);
            expect(/javascript:/i.test(attribute.value), `${attribute.value} from ${markdown}`).toBe(false);
          }
        }
      }
  });

  it("draws an entity as its character, and markup an entity spells as its letters", () => {
    for (const html of [render("AT&T &copy; &mdash; a&nbsp;b &amp;"), renderSaid("AT&T &copy; &mdash; a&nbsp;b &amp;")]) {
      const box = document.createElement("div");
      box.innerHTML = html;
      expect(box.textContent?.trim()).toBe("AT&T © — a\u00a0b &");
    }
    for (const html of [render("&lt;b&gt;x&lt;/b&gt; &#60;i&#62;"), renderSaid("&lt;b&gt;x&lt;/b&gt; &#60;i&#62;")]) {
      const box = document.createElement("div");
      box.innerHTML = html;
      expect(box.querySelector("b, i")).toBeNull();
      expect(box.textContent?.trim()).toBe("<b>x</b> <i>");
    }
    // In code an entity is the letters it is.
    const box = document.createElement("div");
    box.innerHTML = renderSaid("`&copy;`");
    expect(box.querySelector("code")?.textContent).toBe("&copy;");
  });

  it("escapes text once, after a raw tag as anywhere else", () => {
    const box = document.createElement("div");
    box.innerHTML = renderSaid("x <code> a & b < c");
    expect(box.textContent?.trim()).toBe("x <code> a & b < c");
  });
});
