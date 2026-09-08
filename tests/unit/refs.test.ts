import { describe, expect, it } from "vitest";
import { references } from "$lib/refs";

describe("references to a place in a file", () => {
  it("finds path:line as an agent writes it, with a column or without", () => {
    const found = references(
      "See src/lib/sessions.svelte.ts:392 and /abs/main.rs:7:3 for it.",
    );
    expect(found.map((ref) => [ref.path, ref.line])).toEqual([
      ["src/lib/sessions.svelte.ts", 392],
      ["/abs/main.rs", 7],
    ]);
    expect(found[0].start).toBe(4);
    expect(found[0].end).toBe(4 + "src/lib/sessions.svelte.ts:392".length);
  });

  it("takes a Windows path, a dotted directory and a home path", () => {
    const found = references(
      String.raw`C:\Users\ada\app.ts:12 ../up/x.py:3 ~/dev/a.b/c.rs:9`,
    );
    expect(found.map((ref) => ref.path)).toEqual([
      String.raw`C:\Users\ada\app.ts`,
      "../up/x.py",
      "~/dev/a.b/c.rs",
    ]);
  });

  it("does not take a URL's host and port, or a time", () => {
    expect(
      references("open https://example.com:8080/x and http://a.b:80"),
    ).toEqual([]);
    expect(references("done at 12:30, ratio 3:1")).toEqual([]);
  });
});
