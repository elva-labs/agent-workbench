import {
  TEXT_TOKENS,
  dotColour,
  gradientPixels,
  grainPixels,
  labToRgb,
  paintOf,
  rgbToHex,
  toneOf,
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
 * drawn once for each appearance into a small image stretched over the
 * window, and the grain into a tile; each is named once, and the sets refer
 * to them.
 */

/** How large the gradient is drawn before it is stretched: it is smooth,
    and dithered so a soft run does not band. */
const IMAGE = { width: 192, height: 120 };
const GRAIN_TILE = 128;

export interface Images {
  /** The gradient for each appearance, or null where there is a single
      colour or the page cannot draw; a flat colour stands in. */
  light: string | null;
  dark: string | null;
  /** The grain's tile, or null for none. */
  grain: string | null;
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

function valuesOf(painted: Painted, appearance: Appearance, images: Images): Record<string, string> {
  const out: Record<string, string> = { "tint-backdrop": backdrop(painted, appearance, images) };
  for (const [part, ground] of Object.entries(painted.grounds)) out[`tint-${part}`] = ground;
  out["tint-line"] = painted.line;
  out["tint-line-strong"] = painted.lineStrong;
  out["tint-fill"] = painted.fill;
  out["tint-fill-accent"] = painted.fillAccent;
  for (const token of TEXT_TOKENS) out[`tint-${token}`] = painted.text[token];
  return out;
}

/** The stylesheet for a background: what it paints in each appearance and
    look, worked out for the palette's colours in each appearance. While a
    background is being picked only the appearance and look on screen are
    worked out, so the window keeps up with the pointer. */
export function backgroundCss(
  background: Background,
  colours: Record<Appearance, Record<string, string>>,
  images: Images,
  only: { appearance: Appearance; look: Look } | null = null,
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
          (look) => [look, valuesOf(paintOf(background, look, colours[appearance]), appearance, images)] as const,
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

let canDraw: boolean | null = null;

function drawable(): boolean {
  canDraw ??=
    typeof document !== "undefined" &&
    !/jsdom/i.test(navigator.userAgent) &&
    typeof document.createElement("canvas").getContext === "function";
  return canDraw;
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

/** Drawn images, by what they were drawn from. A few are kept, so moving a
    dot back and forth or sliding the grain draws nothing twice. */
const drawn = new Map<string, string | null>();

function remembered(key: string, draw: () => string | null): string | null {
  const known = drawn.get(key);
  if (known !== undefined) {
    drawn.delete(key);
    drawn.set(key, known);
    return known;
  }
  const url = draw();
  drawn.set(key, url);
  if (drawn.size > 32) drawn.delete(drawn.keys().next().value!);
  return url;
}

/** The images a background needs: a gradient for each appearance it is
    given the palette's colours for, where it has more than one colour, and
    the grain's tile where it has grain. */
export function imagesOf(
  background: Background,
  palettes: Partial<Record<Appearance, Record<string, string>>>,
): Images {
  const images: Images = { light: null, dark: null, grain: null };
  if (!drawable()) return images;
  if (background.dots.length > 1) {
    for (const appearance of ["light", "dark"] as const) {
      const palette = palettes[appearance];
      if (palette === undefined) continue;
      const tone = toneOf(palette);
      const colours = background.dots.map((dot) => dotColour(dot, tone));
      const key = `${appearance}:${colours.map((lab) => lab.map((x) => x.toFixed(4)).join(",")).join("|")}`;
      images[appearance] = remembered(key, () =>
        toUrl(gradientPixels(colours, IMAGE.width, IMAGE.height), IMAGE.width, IMAGE.height),
      );
    }
  }
  if (background.grain > 0) {
    const grain = Math.round(background.grain * 100) / 100;
    images.grain = remembered(`grain:${grain}`, () =>
      toUrl(grainPixels(GRAIN_TILE, grain), GRAIN_TILE, GRAIN_TILE),
    );
  }
  return images;
}
