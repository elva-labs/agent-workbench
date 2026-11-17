import { describe, expect, it } from "vitest";
import {
  fileOf,
  openedKind,
  outerDocument,
  pageDocument,
  pagePolicy,
  plainWhy,
} from "$lib/pageFrame";

const BASE = "awb-page://localhost/0f3a/";

/** A policy's directives by name. */
function directives(policy: string): Record<string, string> {
  return Object.fromEntries(
    policy.split(";").map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources.join(" ")];
    }),
  );
}

describe("a presented page's frame", () => {
  it("lets the page load from its own folder and reach nothing else", () => {
    const policy = directives(pagePolicy(BASE));
    expect(policy["default-src"]).toBe("'none'");
    expect(policy["img-src"]).toBe(`${BASE} data: blob:`);
    expect(policy["media-src"]).toBe(`${BASE} data: blob:`);
    expect(policy["font-src"]).toBe(`${BASE} data:`);
    expect(policy["style-src"]).toBe(`${BASE} 'unsafe-inline'`);
    expect(policy["script-src"]).toBe("'unsafe-inline' 'unsafe-eval'");
    for (const shut of ["connect-src", "frame-src", "child-src", "worker-src", "object-src", "form-action"])
      expect(policy[shut]).toBe("'none'");
    expect(policy["base-uri"]).toBe(BASE);
    expect(pagePolicy(BASE)).not.toMatch(/https?:|\*/);
  });

  it("loads nothing from a folder when the page has no base", () => {
    const policy = directives(pagePolicy(null));
    expect(policy["img-src"]).toBe("data: blob:");
    expect(policy["style-src"]).toBe("'unsafe-inline'");
    expect(policy["base-uri"]).toBe("'none'");
  });

  it("puts the policy and the base after the page's doctype and before the rest", () => {
    const html = "<!-- made by an agent -->\n<!DOCTYPE html><html><head><title>t</title></head></html>";
    const page = pageDocument(html, BASE);
    expect(page.startsWith("<!-- made by an agent -->\n<!DOCTYPE html><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(page).toContain(`<base data-workbench href="${BASE}">`);
    expect(page.indexOf("<base")).toBeLessThan(page.indexOf("<html>"));
    expect(page.endsWith("<html><head><title>t</title></head></html>")).toBe(true);
    const bare = pageDocument("<p>hi</p>", null);
    expect(bare.startsWith("<meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(bare).not.toContain("<base");
  });

  it("holds the page in a frame inside a frame under the same policy", () => {
    const outer = outerDocument('<p title="a&b">"x"</p>', BASE, 'The "shots"');
    expect(outer).toContain(`content="${pagePolicy(BASE)}"`);
    expect(outer).toContain('<iframe sandbox="allow-scripts" title="The &quot;shots&quot;"');
    const srcdoc = /srcdoc="([^"]*)"/.exec(outer)![1];
    const decoded = srcdoc.replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    expect(decoded).toBe(pageDocument('<p title="a&b">"x"</p>', BASE));
  });

  it("says why without asking where it can, and leaves the folder's files to the core", () => {
    expect(plainWhy(`${BASE}a.png`, "failed", BASE)).toBeNull();
    expect(plainWhy("awb-page://localhost/up.png", "blocked:img-src", BASE)).toBe(
      "is outside the page's folder",
    );
    expect(plainWhy("http://awb-page.localhost/up.png", "blocked:img-src", "http://awb-page.localhost/0f3a/")).toBe(
      "is outside the page's folder",
    );
    expect(plainWhy("https://cdn.example.com/a.png", "blocked:img-src", BASE)).toContain("on the network");
    expect(plainWhy("https://example.com/", "link", BASE)).toContain("a link to the web");
    expect(plainWhy("file", "blocked:img-src", BASE)).toBe("is outside the page's folder");
    expect(plainWhy(`${BASE}a.png`, "blocked:connect-src", BASE)).toContain("by a script");
    expect(plainWhy("https://example.com/", "blocked:frame-src", BASE)).toContain("a frame");
  });

  it("names a file by its path in the folder, and opens only pictures, films and sounds", () => {
    expect(fileOf(`${BASE}shots/b%20c.png?x=1#y`, BASE)).toBe("shots/b c.png");
    expect(fileOf(`${BASE}100%.png`, BASE)).toBe("100%.png");
    expect(openedKind("shots/A.JPG")).toBe("image");
    expect(openedKind("demo.webm")).toBe("video");
    expect(openedKind("note.mp3")).toBe("audio");
    expect(openedKind("style.css")).toBeNull();
    expect(openedKind("other.html")).toBeNull();
  });
});
