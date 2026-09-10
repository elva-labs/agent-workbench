import type { ITheme } from "@xterm/xterm";

/**
 * The terminal's colours, taken from the app's own tokens.
 *
 * An embedded terminal reads as foreign for three reasons, all fixable: its
 * background is not quite the surface colour, its type does not match the app's
 * mono, and its ANSI palette is somebody else's. The tokens already carry all
 * sixteen slots, written in phase 0 for exactly this.
 *
 * The move worth making is that **cyan is the accent**. Claude Code leans on
 * cyan for its own emphasis, so the agent's output carries the app's colour
 * without touching a line of its rendering.
 */

export type TokenReader = (token: string) => string;

/** Reads a custom property off an element, trimmed. */
export function tokenReader(element: Element): TokenReader {
  const style = getComputedStyle(element);
  return (token) => style.getPropertyValue(token).trim();
}

/**
 * Mixes a hex colour with an alpha channel. xterm wants a concrete colour
 * rather than a `color-mix()` expression, so the mixing happens here.
 */
export function withAlpha(hex: string, alpha: number): string {
  const parsed = parseHex(hex);
  if (!parsed) return hex;
  const [r, g, b] = parsed;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function parseHex(hex: string): [number, number, number] | null {
  const value = hex.trim().replace(/^#/, "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

export function buildTheme(read: TokenReader): ITheme {
  const accent = read("--accent");

  return {
    // Exactly the surface token, not a near miss: a background one shade off
    // is the single clearest tell that a terminal was pasted into a window.
    background: read("--surface"),
    foreground: read("--ink"),
    cursor: accent,
    cursorAccent: read("--surface"),
    selectionBackground: withAlpha(accent, 0.22),

    black: read("--ansi-black"),
    red: read("--ansi-red"),
    green: read("--ansi-green"),
    yellow: read("--ansi-yellow"),
    blue: read("--ansi-blue"),
    magenta: read("--ansi-magenta"),
    cyan: read("--ansi-cyan"),
    white: read("--ansi-white"),

    brightBlack: read("--ansi-bright-black"),
    brightRed: read("--ansi-bright-red"),
    brightGreen: read("--ansi-bright-green"),
    brightYellow: read("--ansi-bright-yellow"),
    brightBlue: read("--ansi-bright-blue"),
    brightMagenta: read("--ansi-bright-magenta"),
    brightCyan: read("--ansi-bright-cyan"),
    brightWhite: read("--ansi-bright-white"),
  };
}

/**
 * Batches writes onto an animation frame.
 *
 * A TUI redrawing itself emits many small writes, and calling `write()` per
 * chunk makes xterm parse and lay out far more often than the screen refreshes.
 * Joining what arrived since the last frame is the difference between a smooth
 * redraw and a stuttering one under something noisy like a build log.
 */
export class WriteQueue {
  private pending: Uint8Array[] = [];
  private frame: number | null = null;

  constructor(
    private readonly write: (data: Uint8Array) => void,
    // Wrapped rather than passed by reference: requestAnimationFrame must be
    // called with window as its receiver, and holding it on a field would call
    // it with the queue instead.
    private readonly schedule: (cb: () => void) => number = (cb) =>
      requestAnimationFrame(cb),
    private readonly cancel: (handle: number) => void = (handle) =>
      cancelAnimationFrame(handle),
  ) {}

  push(bytes: Uint8Array) {
    if (bytes.length === 0) return;
    this.pending.push(bytes);
    if (this.frame === null) this.frame = this.schedule(() => this.flush());
  }

  flush() {
    this.frame = null;
    if (this.pending.length === 0) return;

    const joined =
      this.pending.length === 1 ? this.pending[0] : concat(this.pending);
    this.pending = [];
    this.write(joined);
  }

  dispose() {
    if (this.frame !== null) this.cancel(this.frame);
    this.frame = null;
    this.pending = [];
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return joined;
}

/**
 * The answer to a program asking what colour the terminal draws in (OSC 10
 * for the foreground, OSC 11 for the background, `?` as the argument), or
 * null when the sequence is not a query. xterm.js does not answer these by
 * itself, and Codex waits on the answer before drawing its first screen.
 */
export function colorReply(
  osc: 10 | 11,
  data: string,
  theme: ITheme,
): string | null {
  if (data.trim() !== "?") return null;
  const hex =
    (osc === 10 ? theme.foreground : theme.background) ??
    (osc === 10 ? "#000000" : "#ffffff");
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (match === null) return null;
  const [, r, g, b] = match;
  return `\x1b]${osc};rgb:${r}${r}/${g}${g}/${b}${b}\x1b\\`;
}

/**
 * Whether a WebGL renderer name is a software rasteriser: Mesa's llvmpipe
 * under a headless X server, SwiftShader in a browser without a GPU. Those
 * hand out a context and then present frames late or not at all, and the
 * DOM renderer is the one to use.
 */
export function softwareGl(renderer: string | null): boolean {
  if (renderer === null) return false;
  return /llvmpipe|softpipe|swiftshader|swrast|software/i.test(renderer);
}

/** The renderer name a browser hides behind, WebKit's "Apple GPU" on any
    machine, says nothing about the GPU. Under a headless X server the
    software rasteriser behind it presents a third context late or never,
    so a run that knows it is headless asks for the DOM renderer here. */
export const RENDERER_KEY = "workbench.renderer";

export function domRendererChosen(): boolean {
  try {
    return localStorage.getItem(RENDERER_KEY) === "dom";
  } catch {
    return false;
  }
}
