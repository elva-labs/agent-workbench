/**
 * What is on a session's screen.
 *
 * Every live session's terminal is mounted in the window, the one on show
 * and the ones behind it alike, so the lines an agent has drawn are there
 * to be read. A terminal puts itself here while it is mounted and takes
 * itself away when it goes, and the conductor's read tool asks through
 * this: it is the one way into a terminal's buffer.
 */

/** As much of a terminal as reading its lines needs. */
export interface Screen {
  buffer: {
    active: {
      length: number;
      getLine(
        index: number,
      ): { translateToString(trim?: boolean): string } | undefined;
    };
  };
}

const screens = new Map<string, Screen>();

/** Puts a terminal in reach, and answers with how to take it away again. */
export function register(id: string, screen: Screen): () => void {
  screens.set(id, screen);
  return () => {
    if (screens.get(id) === screen) screens.delete(id);
  };
}

/**
 * The last lines on a session's screen, oldest first, or null for a
 * session with no terminal in the window. Blank lines above and below
 * what was drawn are left out, so what comes back is the text.
 */
export function screen(id: string, lines: number): string | null {
  const terminal = screens.get(id);
  if (terminal === undefined) return null;
  return read(terminal, lines).join("\n");
}

export function read(terminal: Screen, lines: number): string[] {
  const buffer = terminal.buffer.active;
  const from = Math.max(0, buffer.length - lines);
  const out: string[] = [];
  for (let index = from; index < buffer.length; index += 1) {
    out.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return trim(out);
}

/** Drops the blank lines a terminal leaves under what it drew, and the
    ones above it. */
export function trim(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end -= 1;
  let start = 0;
  while (start < end && lines[start].trim() === "") start += 1;
  return lines.slice(start, end);
}

/** Test seam. */
export function resetScreens() {
  screens.clear();
}
