import { describe, expect, it } from "vitest";
import { lineDiff, lineEdits, MOST_EDITS } from "$lib/lineDiff";

/** A diff as the viewer would sign it, one string per line. */
const signed = (before: string, after: string) =>
  lineDiff(before, after).map((line) =>
    line.kind === "add" ? `+${line.text}` : line.kind === "del" ? `-${line.text}` : ` ${line.text}`,
  );

describe("lineDiff", () => {
  it("keeps every line of two equal texts", () => {
    expect(signed("a\nb\n", "a\nb\n")).toEqual([" a", " b"]);
  });

  it("finds a changed line between kept ones", () => {
    expect(signed("a\nb\nc\n", "a\nB\nc\n")).toEqual([" a", "-b", "+B", " c"]);
  });

  it("finds lines added and dropped in the middle with the fewest edits", () => {
    expect(signed("a\nb\nc\nd\ne\n", "a\nc\nd\nX\ne\n")).toEqual([" a", "-b", " c", " d", "+X", " e"]);
  });

  it("numbers each side as the viewer does", () => {
    expect(lineDiff("a\nb\nc\n", "a\nc\nd\n")).toEqual([
      { kind: "ctx", text: "a", old: 1, new: 1 },
      { kind: "del", text: "b", old: 2, new: null },
      { kind: "ctx", text: "c", old: 3, new: 2 },
      { kind: "add", text: "d", old: null, new: 3 },
    ]);
  });

  it("shows a text against nothing as all added, and nothing against it as all dropped", () => {
    expect(signed("", "a\nb")).toEqual(["+a", "+b"]);
    expect(signed("a\nb\n", "")).toEqual(["-a", "-b"]);
  });

  it("reads Windows line endings as line endings", () => {
    expect(signed("a\r\nb\r\n", "a\r\nc\r\n")).toEqual([" a", "-b", "+c"]);
  });

  it("gives the middle whole when the fewest edits are too many to look for", () => {
    const before = Array.from({ length: MOST_EDITS + 10 }, (_, i) => `a${i}`).join("\n");
    const after = Array.from({ length: MOST_EDITS + 10 }, (_, i) => `b${i}`).join("\n");
    const lines = lineDiff(before, after);
    expect(lines.filter((line) => line.kind === "del")).toHaveLength(MOST_EDITS + 10);
    expect(lines.filter((line) => line.kind === "add")).toHaveLength(MOST_EDITS + 10);
    expect(lines[0].kind).toBe("del");
  });

  it("agrees with the texts it was given, whatever they hold", () => {
    const pick = (seed: number) => {
      let state = seed;
      return () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
    };
    const random = pick(7);
    for (let run = 0; run < 60; run++) {
      const words = ["x", "y", "z", "w"];
      const make = () =>
        Array.from({ length: Math.floor(random() * 12) }, () => words[Math.floor(random() * 4)]).join("\n");
      const before = make();
      const after = make();
      const lines = lineDiff(before, after);
      const left = lines.filter((line) => line.kind !== "add").map((line) => line.text);
      const right = lines.filter((line) => line.kind !== "del").map((line) => line.text);
      expect(left.join("\n")).toBe(before);
      expect(right.join("\n")).toBe(after);
    }
  });
});

describe("lineEdits", () => {
  /** Applies edits in the old text's positions, last first. */
  const apply = (text: string, edits: { from: number; to: number; insert: string }[]) =>
    [...edits].reverse().reduce((out, edit) => out.slice(0, edit.from) + edit.insert + out.slice(edit.to), text);

  it("is nothing for equal texts", () => {
    expect(lineEdits("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("is one change per run of lines that differ, leaving the lines between", () => {
    const before = "one\ntwo\nthree\nfour\nfive\n";
    const after = "ONE\ntwo\nthree\nfour\nFIVE\nsix\n";
    const edits = lineEdits(before, after);
    expect(edits).toEqual([
      { from: 0, to: 4, insert: "ONE\n" },
      { from: 19, to: 24, insert: "FIVE\nsix\n" },
    ]);
    expect(apply(before, edits)).toBe(after);
  });

  it("puts an added line before the line kept after it", () => {
    expect(lineEdits("a\nc\n", "a\nb\nc\n")).toEqual([{ from: 2, to: 2, insert: "b\n" }]);
  });

  it("keeps Windows line endings and a missing final newline", () => {
    const before = "a\r\nb\r\nc";
    const after = "a\r\nB\r\nc";
    expect(apply(before, lineEdits(before, after))).toBe(after);
    expect(apply("a\nb", lineEdits("a\nb", "a\nb\n"))).toBe("a\nb\n");
  });

  it("rebuilds the new text, whatever the texts hold", () => {
    let state = 11;
    const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let run = 0; run < 80; run++) {
      const make = () =>
        Array.from({ length: Math.floor(random() * 10) }, () => ["x", "y", "z"][Math.floor(random() * 3)])
          .map((word) => `${word}\n`)
          .join("") + (random() < 0.3 ? "tail" : "");
      const before = make();
      const after = make();
      expect(apply(before, lineEdits(before, after))).toBe(after);
    }
  });
});
