import {
  TEXT_TOKENS,
  dotColour,
  vividAt,
  gradientPixels,
  grainPixels,
  labToRgb,
  mix,
  paintOf,
  rgbToHex,
  toneOf,
  veilOf,
  type Appearance,
  type Background,
  type Lab,
  type Look,
  type Painted,
} from "$lib/background";

/**
 * Paints a background into the page: a stylesheet of custom properties the
 * window writes, one set for each appearance and look, which background.css
 * lays over the chrome.
 *
 * The sets sit under the same stamps the palettes use, light on the bare
 * one and dark under the system preference unless light was chosen and
 * again under the explicit choice, so switching between light and dark is
 * the stylesheets' to follow and needs nothing from here. The gradient is
 * drawn once for each appearance into an image stretched over the window,
 * and the grain into a tile; each is named once, and the sets refer to them.
 * Above FULL_TINT the cards take the calm tint while the chrome takes the
 * colours at the strength, so where the cards let any through, their
 * gradient is an image of its own.
 */

/** How large the gradient is drawn before it is stretched. It is dithered,
    so a soft run does not band, but the dither only hides steps as fine as
    its own pixels: stretched, each pixel shows as one flat patch, and the
    steps between patches show where the colour runs steeply. At full size
    a pixel is at most five device pixels across on a window 3840 device
    pixels wide, the whole of a 4K screen or 1920 points on a screen of
    twice the density, and no steps show. While a background moves the
    gradient is drawn small, from as few colours worked out as its pixels
    need, so a step costs well under a millisecond and the window keeps up
    with the pointer; it is drawn at full size once it rests. */
const MOVING = { width: 96, height: 60, table: { run: 96, glow: 8 } };
export const FULL = { width: 768, height: 480 };
const GRAIN_TILE = 128;

export interface Images {
  /** The gradient for each appearance, or null where there is a single
      colour or the page cannot draw; a flat colour stands in. */
  light: string | null;
  dark: string | null;
  /** The cards' gradient for each appearance where it is not the
      chrome's, or null where the cards take the chrome's. */
  cardLight?: string | null;
  cardDark?: string | null;
  /** The grain's tile, or null for none. */
  grain: string | null;
  /** The appearances whose gradient here is drawn small, to be drawn at
      full size once the background rests. */
  rough?: Appearance[];
}

const SELECTORS: Record<Look, string> = {
  modern: ':root[data-background][data-look="modern"]',
  terminal: ":root[data-background]:not([data-look])",
};

const LOOKS: Look[] = ["modern", "terminal"];

function block(selector: string, values: Record<string, string>, indent = ""): string {
  const lines = Object.entries(values).map(([name, value]) => `${indent}  --${name}: ${value};`);
  return `${indent}${selector} {\n${lines.join("\n")}\n${indent}}\n`;
}

/** The layers behind a tinted part's own ground: the grain over the
    gradient, both fixed to the window so every part shows its own piece of
    the one background. */
function backdrop(painted: Painted, appearance: Appearance, images: Images): string {
  const layers: string[] = [];
  if (painted.grain > 0 && images.grain !== null) {
    layers.push(`var(--tint-grain) 0 0 / ${GRAIN_TILE}px ${GRAIN_TILE}px repeat fixed`);
  }
  if (painted.colours.length > 1 && images[appearance] !== null) {
    layers.push(`var(--tint-image-${appearance}) 0 0 / 100vw 100vh no-repeat fixed`);
  } else {
    const flat = rgbToHex(labToRgb(painted.colours[0]));
    layers.push(`linear-gradient(${flat}, ${flat}) fixed`);
  }
  return layers.join(", ");
}

/** The layers behind a see-through card's own ground: the gradient with
    the grain blurred into a flat veil over it, so a card shows the
    background soft rather than speckled. A single colour is one flat
    paint. */
function cardBackdrop(painted: Painted, appearance: Appearance, images: Images): string {
  const veil = painted.cards?.veil ?? null;
  const own = images[appearance === "light" ? "cardLight" : "cardDark"] ?? null;
  if (painted.cardColours.length > 1 && images[appearance] !== null) {
    const name = own === null ? `tint-image-${appearance}` : `tint-card-image-${appearance}`;
    const image = `var(--${name}) 0 0 / 100vw 100vh no-repeat fixed`;
    return veil === null ? image : `linear-gradient(${veil}, ${veil}), ${image}`;
  }
  const flat = labToRgb(painted.cardColours[0]);
  const shown = rgbToHex(veil === null ? flat : mix(flat, [127.5, 127.5, 127.5], veilOf(painted.grain)));
  return `linear-gradient(${shown}, ${shown})`;
}

function valuesOf(painted: Painted, appearance: Appearance, images: Images): Record<string, string> {
  const out: Record<string, string> = { "tint-backdrop": backdrop(painted, appearance, images) };
  if (painted.cards !== null) {
    out["tint-card-backdrop"] = cardBackdrop(painted, appearance, images);
    out["tint-card"] = painted.cards.card;
    out["tint-well"] = painted.cards.well;
    out["tint-card-fill-accent"] = painted.cardFillAccent;
    for (const token of TEXT_TOKENS) out[`tint-card-${token}`] = painted.cards.text[token];
  }
  for (const [part, ground] of Object.entries(painted.grounds)) out[`tint-${part}`] = ground;
  out["tint-line"] = painted.line;
  out["tint-line-strong"] = painted.lineStrong;
  out["tint-part-line"] = painted.partLine;
  out["tint-part-line-strong"] = painted.partLineStrong;
  out["tint-fill"] = painted.fill;
  out["tint-fill-accent"] = painted.fillAccent;
  out["tint-patch"] = painted.patch;
  out["tint-on-accent"] = painted.onAccent;
  for (const token of TEXT_TOKENS) out[`tint-${token}`] = painted.text[token];
  return out;
}

/** The custom properties a background paints with in one appearance and
    look, the images it names among them, as backgroundCss writes them for
    that appearance and look. */
export function backgroundValues(
  background: Background,
  colours: Record<string, string>,
  appearance: Appearance,
  look: Look,
  images: Images,
  cards = 0,
): Record<string, string> {
  const named: Record<string, string> = {};
  if (images[appearance] !== null) named[`tint-image-${appearance}`] = `url("${images[appearance]}")`;
  const card = images[appearance === "light" ? "cardLight" : "cardDark"] ?? null;
  if (card !== null) named[`tint-card-image-${appearance}`] = `url("${card}")`;
  if (images.grain !== null) named["tint-grain"] = `url("${images.grain}")`;
  return { ...named, ...valuesOf(paintedOf(background, look, colours, cards), appearance, images) };
}

/** What a background paints, as paintOf works it out, kept for the last
    few asked about: a background being picked is worked out for the
    window and again for the picker's small window in the same appearance,
    and each time the picker opens. */
const worked = new Map<string, Painted>();

export function paintedOf(...args: Parameters<typeof paintOf>): Painted {
  const key = JSON.stringify(args);
  let found = worked.get(key);
  if (found === undefined) {
    found = paintOf(...args);
    worked.set(key, found);
    if (worked.size > 16) worked.delete(worked.keys().next().value!);
  }
  return found;
}

/** The stylesheet for a background: what it paints in each appearance and
    look, worked out for the palette's colours in each appearance, the
    cards' share included where they let any through. */
export function backgroundCss(
  background: Background,
  colours: Record<Appearance, Record<string, string>>,
  images: Images,
  cards = 0,
): string {
  const named: Record<string, string> = {};
  if (images.light !== null) named["tint-image-light"] = `url("${images.light}")`;
  if (images.dark !== null) named["tint-image-dark"] = `url("${images.dark}")`;
  if ((images.cardLight ?? null) !== null) named["tint-card-image-light"] = `url("${images.cardLight}")`;
  if ((images.cardDark ?? null) !== null) named["tint-card-image-dark"] = `url("${images.cardDark}")`;
  if (images.grain !== null) named["tint-grain"] = `url("${images.grain}")`;
  let css = Object.keys(named).length > 0 ? block(":root[data-background]", named) : "";
  const sets = (appearance: Appearance) =>
    LOOKS.map(
      (look) => [look, valuesOf(paintedOf(background, look, colours[appearance], cards), appearance, images)] as const,
    );
  for (const [look, values] of sets("light")) css += block(SELECTORS[look], values);
  const dark = sets("dark");
  css += "@media (prefers-color-scheme: dark) {\n";
  for (const [look, values] of dark) css += block(`${SELECTORS[look]}:not([data-theme="light"])`, values, "  ");
  css += "}\n";
  for (const [look, values] of dark) css += block(`${SELECTORS[look]}[data-theme="dark"]`, values);
  return css;
}

/* ---------------------------------------------------------------------- */
/* Images, drawn where the page has a canvas.                              */
/* ---------------------------------------------------------------------- */

type Draw = (pixels: Uint8ClampedArray, width: number, height: number) => string | null;

let canDraw: boolean | null = null;
let drawInstead: Draw | null = null;

/** How images are drawn: on a canvas where the page has one. */
function drawer(): Draw | null {
  if (drawInstead !== null) return drawInstead;
  canDraw ??=
    typeof document !== "undefined" &&
    !/jsdom/i.test(navigator.userAgent) &&
    typeof document.createElement("canvas").getContext === "function";
  return canDraw ? toUrl : null;
}

/** Test seam: draws images with `draw` in place of a canvas, or as the
    page can again with null, forgetting every image drawn. */
export function drawImagesWith(draw: Draw | null) {
  drawInstead = draw;
  drawn.clear();
  drawnFull.clear();
}

/** An image as a BMP, written out here: the pixels as they are, bottom row
    first, three bytes each and every row padded to four. Nothing is
    compressed, so writing one costs only a pass over its pixels, where a
    canvas costs a round trip to read its pixels back and a PNG encoder
    whatever the size; for the small gradient drawn while a background
    moves that is most of a step. The alpha is left out: every pixel of a
    gradient is opaque. */
export function toBmp(pixels: Uint8ClampedArray, width: number, height: number): string {
  const row = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + row * height;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x42;
  bytes[1] = 0x4d;
  view.setUint32(2, size, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, row * height, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);
  for (let y = 0; y < height; y++) {
    const from = (height - 1 - y) * width * 4;
    let to = 54 + y * row;
    for (let x = 0; x < width; x++, to += 3) {
      bytes[to] = pixels[from + x * 4 + 2];
      bytes[to + 1] = pixels[from + x * 4 + 1];
      bytes[to + 2] = pixels[from + x * 4];
    }
  }
  let binary = "";
  for (let at = 0; at < size; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `data:image/bmp;base64,${btoa(binary)}`;
}

function toUrl(pixels: Uint8ClampedArray, width: number, height: number): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) return null;
  const image = context.createImageData(width, height);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

/** Drawn images, by what they were drawn from. A few small ones are kept,
    so moving a dot back and forth or sliding the grain draws nothing twice,
    and the last six full-size gradients, whichever appearance each is
    for and whether the chrome's or the cards'. */
const drawn = new Map<string, string | null>();
const drawnFull = new Map<string, string | null>();

function remembered(
  kept: Map<string, string | null>,
  most: number,
  key: string,
  draw: () => string | null,
): string | null {
  const known = kept.get(key);
  if (known !== undefined) {
    kept.delete(key);
    kept.set(key, known);
    return known;
  }
  const url = draw();
  kept.set(key, url);
  if (kept.size > most) kept.delete(kept.keys().next().value!);
  return url;
}

/** The images a background needs: a gradient for each appearance it is
    given the palette's colours for, where it has more than one colour, the
    cards' own gradient where they let any through and take other colours
    than the chrome, and the grain's tile where it has grain. A gradient
    already drawn at full size is given at full size. One that is not is
    drawn so in the appearances `full` names, and drawn small in the
    others, which `rough` then names. */
export function imagesOf(
  background: Background,
  palettes: Partial<Record<Appearance, Record<string, string>>>,
  full: readonly Appearance[] = ["light", "dark"],
  cards = 0,
): Images {
  const rough: Appearance[] = [];
  const images: Images = { light: null, dark: null, cardLight: null, cardDark: null, grain: null, rough };
  const draw = drawer();
  if (draw === null) return images;
  // The small gradient is written out as a BMP rather than drawn on a
  // canvas, unless a test draws in its place.
  const drawSmall = drawInstead ?? toBmp;
  const gradient = (appearance: Appearance, colours: Lab[]) => {
    const key = `${appearance}:${colours.map((lab) => lab.map((x) => x.toFixed(4)).join(",")).join("|")}`;
    if (full.includes(appearance) || drawnFull.has(key)) {
      return remembered(drawnFull, 6, key, () =>
        draw(gradientPixels(colours, FULL.width, FULL.height), FULL.width, FULL.height),
      );
    }
    if (!rough.includes(appearance)) rough.push(appearance);
    return remembered(drawn, 32, key, () =>
      drawSmall(gradientPixels(colours, MOVING.width, MOVING.height, MOVING.table), MOVING.width, MOVING.height),
    );
  };
  if (background.dots.length > 1) {
    for (const appearance of ["light", "dark"] as const) {
      const palette = palettes[appearance];
      if (palette === undefined) continue;
      const tone = toneOf(palette);
      images[appearance] = gradient(
        appearance,
        background.dots.map((dot) => dotColour(dot, tone, background.strength)),
      );
      if (cards > 0 && vividAt(background.strength) > 0) {
        images[appearance === "light" ? "cardLight" : "cardDark"] = gradient(
          appearance,
          background.dots.map((dot) => dotColour(dot, tone)),
        );
      }
    }
  }
  if (background.grain > 0) {
    const grain = Math.round(background.grain * 100) / 100;
    images.grain = remembered(drawn, 32, `grain:${grain}`, () =>
      draw(grainPixels(GRAIN_TILE, grain), GRAIN_TILE, GRAIN_TILE),
    );
  }
  return images;
}
