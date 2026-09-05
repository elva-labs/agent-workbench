import { describe, expect, it } from "vitest";
import { isWindows, lastSegment, shorten } from "$lib/paths";

describe("paths as shown", () => {
  it("takes the last segment whichever way the separators lean", () => {
    expect(lastSegment("/home/ada/dev/demo")).toBe("demo");
    expect(lastSegment("C:\\Users\\ada\\dev\\demo")).toBe("demo");
    expect(lastSegment("/home/ada/dev/demo/")).toBe("demo");
    expect(lastSegment("src/lib.rs")).toBe("lib.rs");
    expect(lastSegment("demo")).toBe("demo");
  });

  it("folds the home directory to a tilde on every platform", () => {
    expect(shorten("/Users/ada/dev/demo")).toBe("~/dev/demo");
    expect(shorten("/home/ada/dev/demo")).toBe("~/dev/demo");
    expect(shorten("C:\\Users\\ada\\dev\\demo")).toBe("~\\dev\\demo");
    expect(shorten("/opt/demo")).toBe("/opt/demo");
    expect(shorten("D:\\work\\demo")).toBe("D:\\work\\demo");
  });

  it("tells Windows apart by what the browser reports", () => {
    expect(isWindows({ platform: "Win32" })).toBe(true);
    expect(isWindows({ platform: "MacIntel" })).toBe(false);
    expect(isWindows({ platform: "Linux x86_64" })).toBe(false);
    expect(isWindows(undefined)).toBe(false);
  });
});
