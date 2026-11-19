import { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal } from "@xterm/xterm";

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

/** The colours last read back from the page, by the repaint they were
    read after: the plain ones, and the ones on the well once asked for. */
let read: { painted: number; plain: ITheme; dim: ITheme | null } | null = null;

/**
 * The colours a terminal draws in, as the page paints them after the
 * repaint `painted` counts: the theme's, or with `dim` the theme's on the
 * well's ground, as a shell beside the one with the keyboard is drawn.
 * Reading a custom property back makes the page work out its style and its
 * layout first, so they are read once a repaint and every terminal shares
 * them.
 */
export function pageColours(painted: number, dim: boolean): ITheme {
  if (read === null || read.painted !== painted) {
    read ={ painted, plain: buildTheme(tokenReader(document.documentElement)), dim: null };
  }
  if (!dim) return read.plain;
  read.dim ??= onWell(read.plain);
  return read.dim;
}

/** The theme on the well's ground. The well is a mix, so it is read as
    the page paints it. */
function onWell(plain: ITheme): ITheme {
  const probe = document.createElement("span");
  probe.style.color = "var(--well)";
  document.body.appendChild(probe);
  const well = asRgb(getComputedStyle(probe).color);
  probe.remove();
  return well === null ? plain : { ...plain, background: well, cursorAccent: well };
}

/** A colour as the page reports it, `rgb()` or `color(srgb ...)` for a
    mix, as the `rgb()` xterm reads. */
export function asRgb(colour: string): string | null {
  if (colour.startsWith("rgb")) return colour;
  const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(colour);
  if (srgb === null) return null;
  const [r, g, b] = srgb.slice(1, 4).map((channel) => Math.round(Number(channel) * 255));
  return `rgb(${r}, ${g}, ${b})`;
}

/** Whether two themes draw every colour the same. Giving xterm a theme
    makes it draw every row again, and the GPU renderer its glyphs too. */
export function sameTheme(a: ITheme | undefined, b: ITheme): boolean {
  if (a === undefined) return false;
  const one = a as Record<string, unknown>;
  const other = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(one), ...Object.keys(other)]);
  for (const key of keys) {
    if (JSON.stringify(one[key]) !== JSON.stringify(other[key])) return false;
  }
  return true;
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

/** How long output waits for an animation frame before it is written
    without one. A window out of sight is given no frames, and a terminal
    takes its output all the same: what it holds is what the read tool
    answers with, and its title and its bell are heard from what it parses. */
export const FRAME_WAIT_MS = 100;

/** Runs `run` once: on the next animation frame, or after FRAME_WAIT_MS
    when no frame comes first. Answers with what cancels it. */
export function frameOrSoon(run: () => void): () => void {
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
    frame = null;
    timer = null;
  };
  const once = () => {
    cancel();
    run();
  };
  frame = requestAnimationFrame(once);
  timer = setTimeout(once, FRAME_WAIT_MS);
  return cancel;
}

/**
 * Batches writes onto an animation frame, or onto a short timer when no
 * frame comes.
 *
 * A TUI redrawing itself emits many small writes, and calling `write()` per
 * chunk makes xterm parse and lay out far more often than the screen refreshes.
 * Joining what arrived since the last frame is the difference between a smooth
 * redraw and a stuttering one under something noisy like a build log.
 */
export class WriteQueue {
  private pending: Uint8Array[] = [];
  private frame: unknown = null;

  constructor(
    private readonly write: (data: Uint8Array) => void,
    private readonly schedule: (cb: () => void) => unknown = frameOrSoon,
    private readonly cancel: (handle: unknown) => void = (handle) =>
      (handle as () => void)(),
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
export const RENDERER_KEY = "chord.renderer";

export function domRendererChosen(): boolean {
  try {
    return localStorage.getItem(RENDERER_KEY) === "dom";
  } catch {
    return false;
  }
}

/** The renderer's measurements, read where the fit addon reads them. */
type Rendered = {
  _core: {
    _renderService: {
      dimensions: { device: { cell: { width: number; height: number } } };
    };
  };
};

/**
 * The fit addon, measuring by the cell the renderer draws in device pixels.
 * The DOM renderer's cell in CSS pixels is its row rounded to the pixel and
 * shared out over the columns the grid has now, so a fit by it depends on the
 * grid it starts from: a pane back at the width it had can be given a column
 * more or fewer than it had. The device cell is the same whatever the grid.
 */
export class GridFit extends FitAddon {
  #terminal: Terminal | null = null;

  override activate(terminal: Terminal): void {
    super.activate(terminal);
    this.#terminal = terminal;
  }

  override proposeDimensions(): { cols: number; rows: number } | undefined {
    const terminal = this.#terminal;
    const element = terminal?.element;
    const parent = element?.parentElement;
    if (!terminal || !element || !parent) return undefined;
    const device = (terminal as unknown as Rendered)._core._renderService.dimensions.device.cell;
    const ratio = window.devicePixelRatio || 1;
    const cell = { width: device.width / ratio, height: device.height / ratio };
    if (cell.width === 0 || cell.height === 0) return undefined;

    // The room as the addon counts it: whole pixels, less the element's
    // padding and the scrollbar's gutter when there is scrollback.
    const room = getComputedStyle(parent);
    const own = getComputedStyle(element);
    const px = (style: CSSStyleDeclaration, name: string) => parseInt(style.getPropertyValue(name));
    const scrollbar = terminal.options.scrollback === 0 ? 0 : (terminal.options.overviewRuler?.width || SCROLLBAR);
    const width = Math.max(0, px(room, "width")) - (px(own, "padding-left") || 0) - (px(own, "padding-right") || 0) - scrollbar;
    const height = px(room, "height") - (px(own, "padding-top") || 0) - (px(own, "padding-bottom") || 0);
    // A box that is not laid out has no width or height in pixels, and a
    // grid counted from nothing would be told to the process.
    if (Number.isNaN(width) || Number.isNaN(height)) return undefined;
    return {
      cols: Math.max(2, Math.floor(width / cell.width)),
      rows: Math.max(1, Math.floor(height / cell.height)),
    };
  }
}

/** xterm's scrollbar gutter where no overview ruler sets its own. */
const SCROLLBAR = 14;
