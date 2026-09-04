import type { Terminal } from "@xterm/xterm";
import { layout } from "$lib/layout.svelte";
import { sessions } from "$lib/sessions.svelte";
import { terminals } from "$lib/terminals.svelte";

/**
 * Files dropped on the window.
 *
 * A terminal takes a dropped file as its path typed at the cursor, and that is
 * what the agent expects too: Claude Code reads a pasted path, and shows an
 * image file as an attachment. So a drop is a paste of the paths, into the
 * terminal under the pointer, or failing that the one the keyboard is in.
 *
 * The webview never sees the drop itself. Tauri takes it at the window and
 * hands over the paths and a position, which is all this needs.
 */

export type DragEvent =
  | { type: "over"; x: number; y: number }
  | { type: "drop"; paths: string[]; x: number; y: number }
  | { type: "leave" };

export const drops = $state({
  /** The terminal a drag is hovering over, by id. */
  over: null as string | null,
});

interface Target {
  host: HTMLElement;
  terminal: Terminal;
}

const targets = new Map<string, Target>();

/** A terminal that can take a drop. Called by the view when it mounts. */
export function register(id: string, host: HTMLElement, terminal: Terminal) {
  targets.set(id, { host, terminal });
}

export function unregister(id: string) {
  targets.delete(id);
  if (drops.over === id) drops.over = null;
}

/** The terminal under a point, or the one with the keyboard when there is
    none there: dropping on the pane's header still means this pane. */
export function targetAt(x: number, y: number): string | null {
  const element = document.elementFromPoint(x, y);
  const host = element?.closest<HTMLElement>("[data-terminal]");
  if (host?.dataset.terminal !== undefined && targets.has(host.dataset.terminal)) {
    return host.dataset.terminal;
  }
  const focused = layout.focus === "terminal" ? terminals.active : sessions.active;
  return focused !== null && targets.has(focused) ? focused : null;
}

/**
 * A path as a shell reads it: spaces and metacharacters escaped with a
 * backslash, which is what the terminal apps do and what the agent unescapes.
 */
export function shellPath(path: string): string {
  return path.replace(/([\s"'\\$&|;<>()*?\[\]#~!{}`])/g, "\\$1");
}

/** What a drop of these files types: each path, and a space after the last
    so the next word does not run into it. */
export function pasteFor(paths: string[]): string {
  return paths.map(shellPath).join(" ") + " ";
}

export function handle(event: DragEvent) {
  if (event.type === "leave") {
    drops.over = null;
    return;
  }
  const id = targetAt(event.x, event.y);
  if (event.type === "over") {
    drops.over = id;
    return;
  }
  drops.over = null;
  if (id === null || event.paths.length === 0) return;
  const target = targets.get(id)!;
  // xterm's own paste: bracketed when the program asked for it, plain when not.
  target.terminal.paste(pasteFor(event.paths));
  target.terminal.focus();
}

/** Test seam. */
export function resetDrops() {
  targets.clear();
  drops.over = null;
}
