import { beforeEach, describe, expect, it } from "vitest";
import {
  read,
  register,
  resetScreens,
  screen,
  type Screen,
} from "$lib/screens";

/** A terminal with these lines in its buffer. */
function screenOf(lines: string[]): Screen {
  return {
    buffer: {
      active: {
        length: lines.length,
        getLine: (index: number) => ({ translateToString: () => lines[index] }),
      },
    },
  };
}

beforeEach(resetScreens);

describe("a session's screen", () => {
  it("is nothing until a terminal is mounted for it", () => {
    expect(screen("s1", 10)).toBeNull();
    register("s1", screenOf(["hello"]));
    expect(screen("s1", 10)).toBe("hello");
  });

  it("goes when the terminal goes", () => {
    const forget = register("s1", screenOf(["hello"]));
    forget();
    expect(screen("s1", 10)).toBeNull();
  });

  it("leaves a terminal that took the id after it alone", () => {
    const forget = register("s1", screenOf(["first"]));
    register("s1", screenOf(["second"]));
    forget();
    expect(screen("s1", 10)).toBe("second");
  });

  it("reads the last lines, oldest first", () => {
    expect(read(screenOf(["one", "two", "three"]), 2)).toEqual([
      "two",
      "three",
    ]);
  });

  it("reads what there is when asked for more than was drawn", () => {
    expect(read(screenOf(["one"]), 40)).toEqual(["one"]);
  });

  it("drops the blank lines above and below what was drawn", () => {
    expect(read(screenOf(["", "", "one", "", "two", "", ""]), 40)).toEqual([
      "one",
      "",
      "two",
    ]);
  });

  it("comes back empty for a terminal that has drawn nothing", () => {
    expect(screen("s1", 40)).toBeNull();
    register("s1", screenOf(["", ""]));
    expect(screen("s1", 40)).toBe("");
  });
});
