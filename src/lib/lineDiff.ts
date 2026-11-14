import type { DiffLine } from "$lib/core";

/**
 * Two texts compared line by line, as the viewer draws a diff: what the
 * disk holds against what the editor holds, for a file that changed on disk
 * under unsaved edits.
 *
 * The lines both ends share are set aside first, and Myers' algorithm finds
 * the fewest lines to drop and add in what is left. A comparison that would
 * take more than `MOST_EDITS` steps gives up on finding the fewest and shows
 * what is left as dropped, then added, which is still a true account of the
 * two texts.
 */

/** Past this many lines dropped and added, the middle is shown whole. */
export const MOST_EDITS = 4000;

export function lineDiff(before: string, after: string): DiffLine[] {
  return linesOf(splitLines(before), splitLines(after));
}

/**
 * The changes that turn `before` into `after`, one per run of lines that
 * differ, in `before`'s positions: what a reload applies, so the lines
 * between two changes keep their places, and the cursor and the scroll on
 * them hold.
 */
export function lineEdits(
  before: string,
  after: string,
): { from: number; to: number; insert: string }[] {
  if (before === after) return [];
  const a = withEndings(before);
  const b = withEndings(after);
  const starts: number[] = [];
  let offset = 0;
  for (const line of a) {
    starts.push(offset);
    offset += line.length;
  }
  starts.push(offset);
  const edits: { from: number; to: number; insert: string }[] = [];
  let open: { from: number; to: number; insert: string } | null = null;
  // The index in `a` of the next line not yet walked past.
  let next = 0;
  for (const line of linesOf(a, b)) {
    if (line.kind === "ctx") {
      if (open !== null) edits.push(open);
      open = null;
      next = line.old!;
      continue;
    }
    if (open === null) open = { from: starts[next], to: starts[next], insert: "" };
    if (line.kind === "del") {
      next = line.old!;
      open.to = starts[next];
    } else {
      open.insert += b[line.new! - 1];
    }
  }
  if (open !== null) edits.push(open);
  return edits;
}

/** A text's lines with their line endings on, the last without one when
    the text does not end in one. */
function withEndings(text: string): string[] {
  if (text === "") return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function linesOf(a: string[], b: string[]): DiffLine[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;

  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ kind: "ctx", text: a[i], old: i + 1, new: i + 1 });
  const middleA = a.slice(head, a.length - tail);
  const middleB = b.slice(head, b.length - tail);
  for (const step of middle(middleA, middleB)) {
    if (step.kind === "ctx") {
      out.push({ kind: "ctx", text: middleA[step.a], old: head + step.a + 1, new: head + step.b + 1 });
    } else if (step.kind === "del") {
      out.push({ kind: "del", text: middleA[step.a], old: head + step.a + 1, new: null });
    } else {
      out.push({ kind: "add", text: middleB[step.b], old: null, new: head + step.b + 1 });
    }
  }
  for (let i = tail; i > 0; i--) {
    const oldAt = a.length - i;
    const newAt = b.length - i;
    out.push({ kind: "ctx", text: a[oldAt], old: oldAt + 1, new: newAt + 1 });
  }
  return out;
}

/** A text's lines, without the empty one a final newline leaves. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Step = { kind: "ctx" | "del" | "add"; a: number; b: number };

/** The middle of the two texts as kept, dropped and added lines. */
function middle(a: string[], b: string[]): Step[] {
  if (a.length === 0) return b.map((_, at) => ({ kind: "add", a: 0, b: at }));
  if (b.length === 0) return a.map((_, at) => ({ kind: "del", a: at, b: 0 }));
  const trace = myers(a, b);
  if (trace === null) {
    return [
      ...a.map((_, at): Step => ({ kind: "del", a: at, b: 0 })),
      ...b.map((_, at): Step => ({ kind: "add", a: 0, b: at })),
    ];
  }
  return backtrack(trace, a.length, b.length);
}

/** The furthest each diagonal reached after each number of edits, until
    both texts are walked through; null past `MOST_EDITS`. */
function myers(a: string[], b: string[]): Int32Array[] | null {
  const n = a.length;
  const m = b.length;
  const most = Math.min(n + m, MOST_EDITS);
  const offset = most + 1;
  let v = new Int32Array(2 * most + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= most; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(next);
        return trace;
      }
    }
    v = next;
  }
  return null;
}

/** Walks the trace back from the end to the start, collecting the steps. */
function backtrack(trace: Int32Array[], n: number, m: number): Step[] {
  const offset = (trace[0].length - 3) / 2 + 1;
  const steps: Step[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      steps.push({ kind: "ctx", a: x, b: y });
    }
    if (d === 0) break;
    if (down) {
      y--;
      steps.push({ kind: "add", a: x, b: y });
    } else {
      x--;
      steps.push({ kind: "del", a: x, b: y });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    steps.push({ kind: "ctx", a: x, b: y });
  }
  return steps.reverse();
}
