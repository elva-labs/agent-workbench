/**
 * References to a place in a file, as an agent writes them: `src/lib/a.ts:12`,
 * `path/to/file.rs:34:5`, `/abs/file.py:7`. Found in a terminal's lines so
 * a click opens the file there.
 */

export interface Reference {
  /** Where in the text the reference starts and ends, end exclusive. */
  start: number;
  end: number;
  path: string;
  line: number;
}

const REFERENCE =
  /(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?[\w@.~-]+(?:[\\/][\w@.~-]+)*\.[A-Za-z0-9]{1,8}:(\d{1,7})(?::\d{1,7})?/g;

/** Every reference in a line of text, in order. A URL's host and port is
    not one, and neither is a bare number after a word. */
export function references(text: string): Reference[] {
  const found: Reference[] = [];
  for (const match of text.matchAll(REFERENCE)) {
    const start = match.index;
    const whole = match[0];
    const before = text.slice(Math.max(0, start - 3), start);
    if (before.endsWith("//") || before.endsWith(":/")) continue;
    const colon = whole.indexOf(":", whole.lastIndexOf(".") + 1);
    found.push({
      start,
      end: start + whole.length,
      path: whole.slice(0, colon),
      line: Number(match[1]),
    });
  }
  return found;
}
