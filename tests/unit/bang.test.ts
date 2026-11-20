import { describe, expect, it } from "vitest";
import { bangLine, runnable } from "$lib/bang";

describe("a message that runs in the shell", () => {
  it("is one that begins with !, and runs what follows, trimmed", () => {
    expect(bangLine("!ls")).toBe("ls");
    expect(bangLine("! ls -la ")).toBe("ls -la");
    expect(bangLine("!git log --oneline\n")).toBe("git log --oneline");
  });

  it("runs nothing yet while nothing follows the !", () => {
    expect(bangLine("!")).toBe("");
    expect(bangLine("!   ")).toBe("");
  });

  it("is a message to the agent when it does not begin with !", () => {
    expect(bangLine("hello")).toBeNull();
    expect(bangLine(" !ls")).toBeNull();
    expect(bangLine("")).toBeNull();
    expect(bangLine("say !ls")).toBeNull();
  });
});

describe("a command the agent writes for the user to run", () => {
  it("is code that begins with ! and a space, then the command", () => {
    expect(runnable("! npm test")).toBe("npm test");
    expect(runnable("! git status --short ")).toBe("git status --short");
    expect(runnable("!  ls")).toBe("ls");
  });

  it("is nothing else", () => {
    expect(runnable("!important")).toBeNull();
    expect(runnable("! ")).toBeNull();
    expect(runnable("!  ")).toBeNull();
    expect(runnable("a ! b")).toBeNull();
    expect(runnable(" ! ls")).toBeNull();
    expect(runnable("npm test")).toBeNull();
    expect(runnable("! npm install\nnpm test")).toBeNull();
  });

  it("is not one whose drawn text could differ from what runs", () => {
    // Bidirectional overrides, embeddings, isolates and marks.
    for (const mark of ["\u202a", "\u202b", "\u202c", "\u202d", "\u202e"]) {
      expect(runnable(`! echo hi ${mark}fr- mr`)).toBeNull();
    }
    for (const mark of [
      "\u2066",
      "\u2067",
      "\u2068",
      "\u2069",
      "\u200e",
      "\u200f",
      "\u061c",
    ]) {
      expect(runnable(`! echo ${mark}hi`)).toBeNull();
    }
    // Zero-width and other undrawn characters.
    for (const mark of [
      "\u200b",
      "\u200c",
      "\u200d",
      "\u2060",
      "\ufeff",
      "\u00ad",
      "\u034f",
      "\u115f",
      "\u3164",
      "\ufe0f",
    ]) {
      expect(runnable(`! r${mark}m -rf build`)).toBeNull();
    }
    // Controls and separators that break or hide a line.
    for (const mark of [
      "\r",
      "\u0000",
      "\u001b",
      "\u007f",
      "\u0085",
      "\u2028",
      "\u2029",
    ]) {
      expect(runnable(`! ls${mark}rm x`)).toBeNull();
    }
  });

  it("may hold a tab and characters of any script", () => {
    expect(runnable("! printf 'a\\tb'\t| cat")).toBe("printf 'a\\tb'\t| cat");
    expect(runnable("! echo 'héllo wörld' 日本 שלום")).toBe(
      "echo 'héllo wörld' 日本 שלום",
    );
  });
});
