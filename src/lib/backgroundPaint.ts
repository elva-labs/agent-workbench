import {
  TEXT_TOKENS,
  dotColour,
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
 */

/** How large the gradient is drawn before it is stretched. It is dithered,
    so a soft run does not band, but the dither only hides steps as fine as
    its own pixels: stretched, each pixel shows as one flat patch, and the
    steps between patches show where the colour runs steeply. At full size
    a pixel is at most five device pixels across on a window 3840 device
    pixels wide, the whole of a 4K screen or 1920 points on a screen of
    twice the density, and no steps show. While a background moves the
    gradient is drawn small, which keeps up with the pointer, and at full
    size once it rests. */
const MOVING = { width: 192, height: 120 };
export const FULL = { width: 768, height: 480 };
const GRAIN_TILE = 128;

export interface Images {
  /** The gradient for each appearance, or null where there is a single
      colour or the page cannot draw; a flat colour stands in. */
  light: string | null;
  dark: string | null;
  /** The grain's tile, or null for none. */
  grain: string | null;
  /** Whether a gradient here is drawn small, to be drawn at full size
      once the background rests. */
  rough?: boolean;
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
  if (painted.colours.length > 1 && images[appearance] !== null) {
    const image = `var(--tint-image-${appearance}) 0 0 / 100vw 100vh no-repeat fixed`;
    return veil === null ? image : `linear-gradient(${veil}, ${veil}), ${image}`;
  }
  const flat = labToRgb(painted.colours[0]);
  const shown = rgbToHex(veil === null ? flat : mix(flat, [127.5, 127.5, 127.5], veilOf(painted.grain)));
  return `linear-gradient(${shown}, ${shown})`;
}

function valuesOf(painted: Painted, appearance: Appearance, images: Images): Record<string, string> {
  const out: Record<string, string> = { "tint-backdrop": backdrop(painted, appearance, images) };
  if (painted.cards !== null) {
    out["tint-card-backdrop"] = cardBackdrop(painted, appearance, images);
    out["tint-card"] = painted.cards.card;
    out["tint-well"] = painted.cards.well;
    for (const token of TEXT_TOKENS) out[`tint-card-${token}`] = painted.cards.text[token];
  }
  for (const [part, ground] of Object.entries(painted.grounds)) out[`tint-${part}`] = ground;
  out["tint-line"] = painted.line;
  out["tint-line-strong"] = painted.lineStrong;
  out["tint-fill"] = painted.fill;
  out["tint-fill-accent"] = painted.fillAccent;
  for (const token of TEXT_TOKENS) out[`tint-${token}`] = painted.text[token];
  return out;
}

/** The stylesheet for a background: what it paints in each appearance and
    look, worked out for the palette's colours in each appearance, the
    cards' share included where they let any through, with the share the
    guard lets through in each appearance and look written into `held`,
    keyed "appearance:look". While a
    background is being picked only the appearance and look on screen are
    worked out, so the window keeps up with the pointer. */
export function backgroundCss(
  background: Background,
  colours: Record<Appearance, Record<string, string>>,
  images: Images,
  only: { appearance: Appearance; look: Look } | null = null,
  cards = 0,
  held: Partial<Record<string, number>> = {},
): string {
  const named: Record<string, string> = {};
  if (images.light !== null) named["tint-image-light"] = `url("${images.light}")`;
  if (images.dark !== null) named["tint-image-dark"] = `url("${images.dark}")`;
  if (images.grain !== null) named["tint-grain"] = `url("${images.grain}")`;
  let css = Object.keys(named).length > 0 ? block(":root[data-background]", named) : "";
  const looks = only === null ? LOOKS : [only.look];
  const sets = (appearance: Appearance) =>
    only !== null && only.appearance !== appearance
      ? []
      : looks.map(
          (look) => {
            const painted = paintOf(background, look, colours[appearance], cards);
            held[`${appearance}:${look}`] = painted.cards?.held ?? 0;
            return [look, valuesOf(painted, appearance, images)] as const;
          },
        );
  for (const [look, values] of sets("light")) css += block(SELECTORS[look], values);
  const dark = sets("dark");
  if (dark.length === 0) return css;
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
    and the full-size gradients of the last two backgrounds in each
    appearance. */
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
    given the palette's colours for, where it has more than one colour, and
    the grain's tile where it has grain. A gradient already drawn at full
    size is given at full size. One that is not is drawn so when `full`
    says to, and drawn small otherwise, which `rough` then says. */
export function imagesOf(
  background: Background,
  palettes: Partial<Record<Appearance, Record<string, string>>>,
  full = true,
): Images {
  const images: Images = { light: null, dark: null, grain: null, rough: false };
  const draw = drawer();
  if (draw === null) return images;
  if (background.dots.length > 1) {
    for (const appearance of ["light", "dark"] as const) {
      const palette = palettes[appearance];
      if (palette === undefined) continue;
      const tone = toneOf(palette);
      const colours = background.dots.map((dot) => dotColour(dot, tone));
      const key = `${appearance}:${colours.map((lab) => lab.map((x) => x.toFixed(4)).join(",")).join("|")}`;
      if (full || drawnFull.has(key)) {
        images[appearance] = remembered(drawnFull, 4, key, () =>
          draw(gradientPixels(colours, FULL.width, FULL.height), FULL.width, FULL.height),
        );
      } else {
        images[appearance] = remembered(drawn, 32, key, () =>
          draw(gradientPixels(colours, MOVING.width, MOVING.height), MOVING.width, MOVING.height),
        );
        images.rough = true;
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
