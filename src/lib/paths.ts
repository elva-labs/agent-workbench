/**
 * Paths as the panes show them.
 *
 * The core hands over native paths: forward slashes on macOS and Linux,
 * backslashes on Windows. Git reports forward slashes everywhere. Anything
 * that splits or shortens a path for display goes through here, so that
 * distinction is made once.
 */

import { isWindows } from "$lib/platform";

export { isWindows };

const SEPARATORS = /[\\/]/;

/** The last segment of a path, whichever way its separators lean. */
export function lastSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const segments = trimmed.split(SEPARATORS);
  return segments[segments.length - 1] ?? "";
}

/** A path with the home directory folded to `~`, as a terminal would show
    it: `/Users/ada`, `/home/ada`, or `C:\Users\ada`. */
export function shorten(path: string): string {
  const posix = path.match(/^\/(?:Users|home)\/[^/]+/);
  if (posix) return `~${path.slice(posix[0].length)}`;
  const windows = path.match(/^[A-Za-z]:\\Users\\[^\\]+/);
  if (windows) return `~${path.slice(windows[0].length)}`;
  return path;
}
