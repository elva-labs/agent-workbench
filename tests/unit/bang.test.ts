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
});
