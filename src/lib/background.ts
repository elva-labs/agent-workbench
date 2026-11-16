/**
 * A background of the user's own, and the guard that keeps every text on
 * it readable.
 *
 * A background is one to three dots on a colour pad, each a hue and how
 * much colour, from none at the centre to the rim. It says nothing about
 * lightness: the chrome it lies on sets that, light or dark, so one
 * background is painted for both appearances and switching between them
 * can leave nothing hard to read. Whether the chrome is light or dark is
 * read from its own colours, not from the appearance's name, so a theme
 * that is dark in both appearances is painted dark in both. The rim is
 * capped for each, so the strongest choice is still a tint. Strength says how far the background shows through the chrome's
 * own ground, and grain lays a fine speckle over it.
 *
 * Two or three colours make a gradient across the window: the first two run
 * from the top left down to the foot, mixed in OKLCH so the middle never
 * greys out, and a third glows from the top right. A harmony keeps the dots
 * a fixed turn of the hue apart, so dragging the first carries the others.
 *
 * The background tints the chrome only, and every surface that holds text
 * to read stays solid. The guard judges each kind of text on a tinted part
 * at the worst point of the gradient behind it, grain included, and draws
 * the text a step stronger, towards black on a light chrome and white on a
 * dark one, just as far as it takes to hold 4.5:1. Lines on or beside a tinted part are the
 * ink let through at one amount for the whole window, so they take the
 * colour of what they cross and stand off it at least as far as today's
 * lines stand off the plain chrome.
 *
 * Everything here is arithmetic; painting it into the page is the theme's.
 */

export type Appearance = "light" | "dark";
export type Look = "modern" | "terminal";
export type Harmony = "single" | "complementary" | "analogous" | "triad" | "free";

/** A place on the pad: the hue in degrees, and how much colour from none
    at the centre to the rim at 1. */
export interface Dot {
  hue: number;
  chroma: number;
}

export interface Background {
  dots: Dot[];
  harmony: Harmony;
  /** How far the background shows through the chrome's ground, 0.1 to 1. */
  strength: number;
  /** How strong the speckle over it is, 0 to 1. */
  grain: number;
}

export const MOST_DOTS = 3;
export const LEAST_STRENGTH = 0.1;
/** The most of the strength the cards let through. */
export const MOST_CARDS = 0.25;
/** The most strength the terminal look takes, and it takes no grain. */
export const TERMINAL_STRENGTH = 0.5;
/** How far a speck of grain darkens or lightens, at full grain. */
export const GRAIN_SPECK = 0.14;
/** The contrast every text on a tinted part holds, at its worst point. */
export const LEAST_CONTRAST = 4.5;
/** What the guard aims for: a hair above, so a worst point between the
    places it samples, or a step of rounding, still holds the least. */
const AIM = LEAST_CONTRAST + 0.05;

/** How much of the ink a hovered row or a field lays over a tinted part,
    and how much of the accent a chosen row lays over it, so they stay part
    of the tint rather than solid patches on it. The guard reads text on
    them at a little more than either, which covers a control that mixes
    a fill with more ink. */
export const FILL = { ink: 0.07, accent: 0.14 };
const GUARD_FILL = { ink: 0.12, accent: 0.16 };
// The guard reads text over one fill at a time. A fill laid over another,
// such as a hovered row inside a chosen one, can leave ink-2, ink-3 and
// the accent a little under 4.5:1 at the worst point, so no text in those
// tokens sits on stacked fills; a part that stacks them has to be read
// here as well.

/** The lightness a light and a dark chrome paint at, and the most colour
    each takes at the rim, in OKLCH. */
export const BAND: Record<Appearance, { lightness: number; chroma: number }> = {
  light: { lightness: 0.94, chroma: 0.066 },
  dark: { lightness: 0.235, chroma: 0.075 },
};

/** The harmonies, in the order the picker shows them: each a turn of the
    hue from the first dot for every dot. */
export const HARMONIES: { name: Exclude<Harmony, "free">; label: string; offsets: number[] }[] = [
  { name: "single", label: "Single", offsets: [0] },
  { name: "complementary", label: "Complementary", offsets: [0, 180] },
  { name: "analogous", label: "Analogous", offsets: [0, 40, -40] },
  { name: "triad", label: "Triad", offsets: [0, 120, 240] },
];

/** What a background starts with when the first dot is placed. */
export const FIRST = { strength: 0.6, grain: 0.25 };

/** The ready-made backgrounds: colours only, so choosing one keeps the
    strength and grain already chosen. */
export const READY_MADE: { name: string; label: string; dots: Dot[]; harmony: Harmony }[] = [
  { name: "lagoon", label: "Lagoon", harmony: "free", dots: [{ hue: 192, chroma: 0.9 }, { hue: 252, chroma: 0.8 }] },
  { name: "tide", label: "Tide", harmony: "single", dots: [{ hue: 200, chroma: 0.75 }] },
  { name: "dusk", label: "Dusk", harmony: "free", dots: [{ hue: 282, chroma: 0.85 }, { hue: 352, chroma: 0.8 }] },
  { name: "ember", label: "Ember", harmony: "free", dots: [{ hue: 62, chroma: 0.9 }, { hue: 18, chroma: 0.75 }] },
  {
    name: "orchard",
    label: "Orchard",
    harmony: "analogous",
    dots: [
      { hue: 140, chroma: 0.8 },
      { hue: 180, chroma: 0.8 },
      { hue: 100, chroma: 0.8 },
    ],
  },
  {
    name: "aurora",
    label: "Aurora",
    harmony: "triad",
    dots: [
      { hue: 185, chroma: 0.85 },
      { hue: 305, chroma: 0.85 },
      { hue: 65, chroma: 0.85 },
    ],
  },
  { name: "fog", label: "Fog", harmony: "single", dots: [{ hue: 250, chroma: 0.3 }] },
];

/* ---------------------------------------------------------------------- */
/* The rules a background is kept by. The core keeps the same ones.        */
/* ---------------------------------------------------------------------- */

const FIELDS = ["dots", "harmony", "strength", "grain"];
const HARMONY_NAMES: Harmony[] = ["single", "complementary", "analogous", "triad", "free"];

function inRange(value: unknown, least: number, most: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= least && value <= most;
}

/** How many dots a harmony holds, or null for any number. */
export function dotsOf(harmony: Harmony): number | null {
  return HARMONIES.find((known) => known.name === harmony)?.offsets.length ?? null;
}

/** A background as the rules take it, or the reason it will not do. Left
    out, the harmony is free and the strength and grain are what a new one
    starts with. */
export function checkBackground(value: unknown): Background {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("A background is a table of dots, a harmony, a strength and grain.");
  }
  const fields = value as Record<string, unknown>;
  const other = Object.keys(fields).find((field) => !FIELDS.includes(field));
  if (other !== undefined) {
    throw new Error(`A background has dots, harmony, strength and grain, not ${other}.`);
  }
  const dots = fields.dots;
  if (!Array.isArray(dots) || dots.length < 1 || dots.length > MOST_DOTS) {
    throw new Error(`A background has one to ${MOST_DOTS} dots.`);
  }
  const checked = dots.map((dot) => {
    const { hue, chroma, ...rest } = (typeof dot === "object" && dot !== null ? dot : {}) as Record<
      string,
      unknown
    >;
    if (Object.keys(rest).length > 0 || !inRange(hue, 0, 360) || hue === 360 || !inRange(chroma, 0, 1)) {
      throw new Error("A dot is a hue from 0 up to 360 degrees and a chroma from 0 to 1.");
    }
    return { hue, chroma };
  });
  const harmony = fields.harmony ?? "free";
  if (!HARMONY_NAMES.includes(harmony as Harmony)) {
    throw new Error(`harmony is one of ${HARMONY_NAMES.join(", ")}, not ${JSON.stringify(harmony)}.`);
  }
  const count = dotsOf(harmony as Harmony);
  if (count !== null && count !== checked.length) {
    throw new Error(
      `A ${harmony} harmony holds ${count === 1 ? "one dot" : `${count} dots`}; free holds any number.`,
    );
  }
  const strength = fields.strength ?? FIRST.strength;
  if (!inRange(strength, LEAST_STRENGTH, 1)) {
    throw new Error(`strength is from ${LEAST_STRENGTH} to 1, not ${JSON.stringify(strength)}.`);
  }
  const grain = fields.grain ?? FIRST.grain;
  if (!inRange(grain, 0, 1)) {
    throw new Error(`grain is from 0 to 1, not ${JSON.stringify(grain)}.`);
  }
  return { dots: checked, harmony: harmony as Harmony, strength, grain };
}

/** The backgrounds in a table that pass the rules, the rest left out. */
export function validBackgrounds(value: unknown): Record<string, Background> {
  const out: Record<string, Background> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const [name, background] of Object.entries(value)) {
    try {
      out[name] = checkBackground(background);
    } catch {
      // A background that does not pass is not painted.
    }
  }
  return out;
}

/** How much a palette or theme lets through its cards, as the rules take
    it, or the reason it will not do. */
export function checkCards(value: unknown): number {
  if (!inRange(value, 0, MOST_CARDS)) {
    throw new Error(`cards let through from 0 to ${MOST_CARDS} of the strength, not ${JSON.stringify(value)}.`);
  }
  return value;
}

/** The cards' shares in a table that pass the rules, the rest left out. */
export function validCards(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const [name, share] of Object.entries(value)) {
    try {
      out[name] = checkCards(share);
    } catch {
      // A share that does not pass lets nothing through.
    }
  }
  return out;
}

/** A cards' share rounded as it is kept, in hundredths. */
export const roundedCards = (share: number) => Math.round(Math.min(MOST_CARDS, Math.max(0, share)) * 100) / 100;

/** A background with its numbers rounded as they are kept: whole degrees,
    and hundredths for the rest. */
export function rounded(background: Background): Background {
  const hundredths = (value: number) => Math.round(value * 100) / 100;
  return {
    dots: background.dots.map((dot) => ({
      hue: Math.round(dot.hue) % 360,
      chroma: hundredths(Math.min(1, Math.max(0, dot.chroma))),
    })),
    harmony: background.harmony,
    strength: hundredths(Math.min(1, Math.max(LEAST_STRENGTH, background.strength))),
    grain: hundredths(Math.min(1, Math.max(0, background.grain))),
  };
}

export function sameBackground(a: Background | null, b: Background | null): boolean {
  return JSON.stringify(a === null ? null : rounded(a)) === JSON.stringify(b === null ? null : rounded(b));
}

/** The ready-made a background's colours are, if any. */
export function readyMadeOf(background: Background | null): string | null {
  if (background === null) return null;
  const own = rounded(background);
  const found = READY_MADE.find(
    (ready) =>
      ready.harmony === own.harmony &&
      ready.dots.length === own.dots.length &&
      ready.dots.every((dot, at) => dot.hue === own.dots[at].hue && dot.chroma === own.dots[at].chroma),
  );
  return found?.name ?? null;
}

/** A background in a few words, as the user reads it in a question. */
export function describeBackground(background: Background | null): string {
  if (background === null) return "None";
  const ready = READY_MADE.find((known) => known.name === readyMadeOf(background));
  const colours =
    ready?.label ?? (background.dots.length === 1 ? "One colour" : `${background.dots.length} colours`);
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  return `${colours}, strength ${percent(background.strength)}, grain ${percent(background.grain)}`;
}

/* ---------------------------------------------------------------------- */
/* Moving the dots.                                                        */
/* ---------------------------------------------------------------------- */

const turn = (hue: number) => ((hue % 360) + 360) % 360;

/** The dots a harmony spreads from the first one. */
export function withHarmony(background: Background, harmony: Exclude<Harmony, "free">): Background {
  const first = background.dots[0];
  const offsets = HARMONIES.find((known) => known.name === harmony)!.offsets;
  return {
    ...background,
    harmony,
    dots: offsets.map((offset) => ({ hue: turn(first.hue + offset), chroma: first.chroma })),
  };
}

/** One dot moved. While a harmony holds, the first carries the others
    with it; moving any other sets the harmony free. */
export function moveDot(background: Background, index: number, dot: Dot): Background {
  const placed = { hue: turn(dot.hue), chroma: Math.min(1, Math.max(0, dot.chroma)) };
  if (index === 0 && background.harmony !== "free") {
    return withHarmony({ ...background, dots: [placed, ...background.dots.slice(1)] }, background.harmony);
  }
  const dots = background.dots.map((old, at) => (at === index ? placed : old));
  return { ...background, dots, harmony: index === 0 ? background.harmony : "free" };
}

/** A dot more, up to three. One becomes a complementary pair and a pair in
    harmony a triad; a free pair gains a dot in the widest gap of hue. */
export function addDot(background: Background): Background {
  const count = background.dots.length;
  if (count >= MOST_DOTS) return background;
  if (background.harmony === "single") return withHarmony(background, "complementary");
  if (background.harmony === "complementary") return withHarmony(background, "triad");
  const hues = background.dots.map((dot) => dot.hue).sort((a, b) => a - b);
  let widest = { from: hues[hues.length - 1], gap: hues[0] + 360 - hues[hues.length - 1] };
  for (let at = 1; at < hues.length; at++) {
    const gap = hues[at] - hues[at - 1];
    if (gap > widest.gap) widest = { from: hues[at - 1], gap };
  }
  const dot = { hue: turn(Math.round(widest.from + widest.gap / 2)), chroma: background.dots[0].chroma };
  return { ...background, dots: [...background.dots, dot], harmony: "free" };
}

/** A dot taken away; taking the last leaves no background. */
export function removeDot(background: Background, index: number): Background | null {
  const dots = background.dots.filter((_, at) => at !== index);
  if (dots.length === 0) return null;
  return { ...background, dots, harmony: dots.length === 1 ? "single" : "free" };
}

/* ---------------------------------------------------------------------- */
/* Colour arithmetic: sRGB, OKLab and OKLCH, and contrast as WCAG has it.  */
/* ---------------------------------------------------------------------- */

/** A colour as sRGB channels from 0 to 255, not rounded. */
export type Rgb = [number, number, number];
/** A colour in OKLab. */
export type Lab = [number, number, number];

const clamp = (value: number, least: number, most: number) => Math.min(most, Math.max(least, value));

export function hexToRgb(hex: string): Rgb {
  let digits = hex.replace("#", "");
  if (digits.length === 3) digits = [...digits].map((digit) => digit + digit).join("");
  return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16)) as Rgb;
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((value) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
}

const toLinear = (value: number) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const toGamma = (linear: number) => {
  const x = clamp(linear, 0, 1);
  return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
};

function linearToLab([r, g, b]: Rgb): Lab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function labToLinear([L, a, b]: Lab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export const rgbToLab = (rgb: Rgb): Lab => linearToLab(rgb.map(toLinear) as Rgb);
export const labToRgb = (lab: Lab): Rgb => labToLinear(lab).map(toGamma) as Rgb;

function lchToLab(L: number, C: number, hue: number): Lab {
  const angle = (hue * Math.PI) / 180;
  return [L, C * Math.cos(angle), C * Math.sin(angle)];
}

function labToLch([L, a, b]: Lab): [number, number, number] {
  return [L, Math.hypot(a, b), turn((Math.atan2(b, a) * 180) / Math.PI)];
}

const inGamut = (linear: Rgb) => linear.every((value) => value >= -1e-4 && value <= 1 + 1e-4);

/** The colour at a lightness and hue with as much of the chroma asked as
    the screen can show. */
export function fitLch(L: number, C: number, hue: number): Lab {
  if (inGamut(labToLinear(lchToLab(L, C, hue)))) return lchToLab(L, C, hue);
  let low = 0;
  let high = C;
  for (let step = 0; step < 16; step++) {
    const middle = (low + high) / 2;
    if (inGamut(labToLinear(lchToLab(L, middle, hue)))) low = middle;
    else high = middle;
  }
  return lchToLab(L, low, hue);
}

/** Relative luminance, as WCAG reckons it. */
export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** The contrast between two luminances, 1 to 21. */
export const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Two colours mixed in sRGB, as CSS's color-mix in srgb does. */
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => a.map((value, at) => value + (b[at] - value) * t) as Rgb;

function mixLch(A: Lab, B: Lab, t: number): Lab {
  const [La, Ca, ha] = labToLch(A);
  const [Lb, Cb, hb] = labToLch(B);
  let hue: number;
  if (Ca < 1e-3) hue = hb;
  else if (Cb < 1e-3) hue = ha;
  else {
    let delta = ((hb - ha + 540) % 360) - 180;
    if (Math.abs(Math.abs(delta) - 180) < 0.5) delta = 180;
    hue = ha + delta * t;
  }
  return lchToLab(La + (Lb - La) * t, Ca + (Cb - Ca) * t, hue);
}

const smooth = (t: number) => t * t * (3 - 2 * t);

export const rgba = (rgb: Rgb, alpha: number) =>
  `rgba(${rgb.map((value) => Math.round(clamp(value, 0, 255))).join(", ")}, ${alpha.toFixed(3)})`;

/* ---------------------------------------------------------------------- */
/* The colours a background paints.                                        */
/* ---------------------------------------------------------------------- */

/** Whether a palette's chrome is painted as light or dark: the band that
    carries its ground away from its ink. It is read from the colours, so a
    theme dark in both appearances is painted dark in both, and its text
    strengthened towards white. */
export function toneOf(colours: Record<string, string>): Appearance {
  const ground = (luminance(hexToRgb(colours.bg)) + luminance(hexToRgb(colours.surface))) / 2;
  return luminance(hexToRgb(colours.ink)) < ground ? "light" : "dark";
}

/** A dot's colour on a light or a dark chrome: its lightness, and its
    share of the rim's colour, held inside what the screen shows. */
export function dotColour(dot: Dot, tone: Appearance): Lab {
  const band = BAND[tone];
  return fitLch(band.lightness, clamp(dot.chroma, 0, 1) * band.chroma, dot.hue);
}

/** A dot as the pad shows it: lighter and fuller than it paints, so the
    pad reads as a colour wheel. */
export function padColour(dot: Dot, appearance: Appearance): string {
  return rgbToHex(labToRgb(fitLch(appearance === "light" ? 0.8 : 0.6, clamp(dot.chroma, 0, 1) * 0.15, dot.hue)));
}

/** A background as a small swatch shows it: its colours laid over a
    palette's ground at its strength, run corner to corner. */
export function swatchOf(background: Background, palette: Record<string, string>): string {
  const under = hexToRgb(palette.bg);
  const tone = toneOf(palette);
  const colours = background.dots.map((dot) =>
    rgbToHex(mix(under, labToRgb(dotColour(dot, tone)), background.strength)),
  );
  return colours.length === 1 ? colours[0] : `linear-gradient(135deg, ${colours.join(", ")})`;
}

/** The pad as pixels, RGBA: hue around it and colour out to the rim, as
    padColour shows a dot, edged smoothly. */
export function padPixels(size: number, appearance: Appearance): Uint8ClampedArray {
  const lightness = appearance === "light" ? 0.8 : 0.6;
  // The most colour the screen shows at each half degree of hue.
  const most = Array.from({ length: 720 }, (_, at) => {
    const [, a, b] = fitLch(lightness, 0.15, at / 2);
    return Math.hypot(a, b);
  });
  const pixels = new Uint8ClampedArray(size * size * 4);
  const radius = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - radius;
      const dy = y + 0.5 - radius;
      const r = Math.hypot(dx, dy) / radius;
      if (r > 1.01) continue;
      const hue = turn((Math.atan2(dy, dx) * 180) / Math.PI);
      const chroma = Math.min(Math.min(r, 1) * 0.15, most[Math.round(hue * 2) % 720]);
      const rgb = labToRgb(lchToLab(lightness, chroma, hue));
      const offset = (y * size + x) * 4;
      pixels[offset] = rgb[0];
      pixels[offset + 1] = rgb[1];
      pixels[offset + 2] = rgb[2];
      pixels[offset + 3] = Math.round(clamp((1.01 - r) * radius, 0, 1) * 255);
    }
  }
  return pixels;
}

/** How far along the run from the first colour to the second a point is,
    and how strongly the third glows there. */
const run = (u: number, v: number) => smooth(clamp(((u * 0.9 + v * 1.5) / 2.4 - 0.04) / 0.9, 0, 1));
const glow = (u: number, v: number) => {
  const dx = (u - 0.94) * 1.6;
  const dy = v + 0.04;
  return 0.92 * Math.exp(-(dx * dx + dy * dy) / 0.55);
};

/** The colour the window gets at (u, v), each 0 to 1 across and down. One
    colour is flat. Two run from the top left down to the foot, steeply, so
    the sessions pane carries the whole run. A third glows from the top
    right. */
export function field(colours: Lab[]): (u: number, v: number) => Lab {
  if (colours.length === 1) return () => colours[0];
  return (u, v) => {
    const colour = mixLch(colours[0], colours[1], run(u, v));
    return colours.length > 2 ? mixLch(colour, colours[2], glow(u, v)) : colour;
  };
}

/** The gradient as pixels, RGBA, for an image stretched over the window.
    The run between the first two colours is worked out once along its
    length, and the whole is dithered by half a step, so a soft run does
    not band. */
export function gradientPixels(colours: Lab[], width: number, height: number): Uint8ClampedArray {
  const steps = 512;
  const along = Array.from({ length: steps }, (_, at) =>
    colours.length === 1 ? colours[0] : mixLch(colours[0], colours[1], at / (steps - 1)),
  );
  const plain = along.map(labToRgb);
  const pixels = new Uint8ClampedArray(width * height * 4);
  let seed = 11;
  const noise = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      const v = y / (height - 1);
      const step = colours.length === 1 ? 0 : Math.round(run(u, v) * (steps - 1));
      const rgb = colours.length > 2 ? labToRgb(mixLch(along[step], colours[2], glow(u, v))) : plain[step];
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        pixels[offset + channel] = Math.round(rgb[channel] + noise());
      }
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

/** A tile of grain as pixels, RGBA: each pixel black or white, as opaque
    as the grain's share of the strongest speck, at random. */
export function grainPixels(size: number, grain: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(size * size * 4);
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let at = 0; at < size * size; at++) {
    const shade = random() < 0.5 ? 0 : 255;
    pixels[at * 4] = pixels[at * 4 + 1] = pixels[at * 4 + 2] = shade;
    pixels[at * 4 + 3] = Math.round(random() * GRAIN_SPECK * grain * 255);
  }
  return pixels;
}

/* ---------------------------------------------------------------------- */
/* The guard.                                                              */
/* ---------------------------------------------------------------------- */

/** The tinted parts: the modern look's ground, which the sessions pane,
    the pane headers and the settings' tab column lie on (side), the
    settings' title row (surf), the status bar (status), and the terminal
    look's ground between its boxes (frame). */
export type Part = "side" | "surf" | "status" | "frame";

/** The kinds of text drawn on tinted parts, by the token each is drawn in. */
export const TEXT_TOKENS = ["ink", "ink-2", "ink-3", "accent", "add", "del", "ansi-yellow"] as const;
export type TextToken = (typeof TEXT_TOKENS)[number];

/** What a background paints in one appearance and look. */
export interface Painted {
  /** The dots' colours in this appearance. */
  colours: Lab[];
  /** The strength and grain after the look's limits. */
  strength: number;
  grain: number;
  /** Each tinted part's own ground, let through by the strength. */
  grounds: Partial<Record<Part, string>>;
  /** The text tokens on tinted parts, a step stronger where they need it. */
  text: Record<TextToken, string>;
  /** Every line, and the stronger marks such as a tag's outline. */
  line: string;
  lineStrong: string;
  /** What a hovered row or a field, and a chosen row, lay over the tint. */
  fill: string;
  fillAccent: string;
  /** Each text's contrast at the worst point behind it, as asked and as
      painted. */
  asked: Record<TextToken, number>;
  contrast: Record<TextToken, number>;
  /** What the cards paint, where they let any of the background through. */
  cards: PaintedCards | null;
}

/** The darkest tone a chrome goes, which the modern look's ground is: a
    step below the background on a light chrome, the background itself on
    a dark one, so the cards on it stand apart either way. */
export function deepOf(colours: Record<string, string>): Rgb {
  const bg = hexToRgb(colours.bg);
  return toneOf(colours) === "dark" ? bg : mix(bg, hexToRgb(colours.ink), 0.04);
}

/** The plain grounds of the tinted parts in a look, as the stylesheets
    paint them without a background. In the modern look the status bar
    lies on the window's ground. */
export function groundsOf(colours: Record<string, string>, look: Look): Partial<Record<Part, Rgb>> {
  const tone = (name: string) => hexToRgb(colours[name]);
  return look === "modern"
    ? { side: deepOf(colours), surf: tone("surface"), status: deepOf(colours) }
    : { frame: tone("bg"), status: tone("surface-2") };
}

/** The parts text sits on in a look: the terminal look's ground holds none. */
const TEXT_PARTS: Record<Look, Part[]> = { modern: ["side", "surf", "status"], terminal: ["status"] };

/** The lightest and darkest a tinted part gets anywhere in the window,
    grain at its strongest speck either way, bare or under a fill. A dark
    speck lowers every channel and a light one raises it, and the tint, a
    fill and luminance all rise with every channel, so a point is at its
    darkest under its dark speck and its lightest under its light one. */
function extremes(
  grid: Rgb[],
  ground: Rgb,
  strength: number,
  speck: number,
  fills: [Rgb, number][],
): [number, number] {
  let low = 1;
  let high = 0;
  for (const colour of grid) {
    const dark = mix(ground, speck > 0 ? (colour.map((value) => value * (1 - speck)) as Rgb) : colour, strength);
    const light = mix(ground, speck > 0 ? (colour.map((value) => value + (255 - value) * speck) as Rgb) : colour, strength);
    low = Math.min(low, luminance(dark));
    high = Math.max(high, luminance(light));
    for (const [fill, amount] of fills) {
      low = Math.min(low, luminance(mix(dark, fill, amount)));
      high = Math.max(high, luminance(mix(light, fill, amount)));
    }
  }
  return [low, high];
}

/** A text's contrast at its worst point over grounds that run from one
    luminance to another. */
function worst(colour: string, [low, high]: [number, number]): number {
  const y = luminance(hexToRgb(colour));
  return y < low ? ratio(y, low) : y > high ? ratio(y, high) : 1;
}

/** A text drawn a step stronger, towards black on a light chrome and
    white on a dark one, just as far as it takes to hold the least
    contrast. Where that end cannot hold it and the other end does better,
    it heads for the other. */
function strengthen(colour: string, range: [number, number], tone: Appearance): string {
  if (worst(colour, range) >= AIM) return colour;
  const from = hexToRgb(colour);
  const black: Rgb = [0, 0, 0];
  const white: Rgb = [255, 255, 255];
  const [towards, away] = tone === "light" ? [black, white] : [white, black];
  const reach = (end: Rgb) => worst(rgbToHex(end), range);
  const to = reach(towards) >= AIM || reach(towards) >= reach(away) ? towards : away;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 20; step++) {
    const middle = (low + high) / 2;
    if (worst(rgbToHex(mix(from, to, middle)), range) >= AIM) high = middle;
    else low = middle;
  }
  // Rounding to whole steps can land a hair short; go on a step at a time.
  let amount = high;
  while (amount < 1 && worst(rgbToHex(mix(from, to, amount)), range) < AIM) {
    amount = Math.min(1, amount + 0.005);
  }
  return rgbToHex(mix(from, to, amount));
}

/** The background's colour at a grid of points across the window. */
function gridOf(at: (u: number, v: number) => Lab, across: number, down: number): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 0; i <= across; i++) {
    for (let j = 0; j <= down; j++) out.push(labToRgb(at(i / across, j / down)));
  }
  return out;
}

/** How much of the ink a line lets through so that at its faintest point
    it stands off what is under it by the ratio asked. */
function lineAmount(under: Rgb[], ink: Rgb, target: number): number {
  const stands = (amount: number) =>
    under.every((colour) => ratio(luminance(mix(colour, ink, amount)), luminance(colour)) >= target);
  let low = 0;
  let high = 0.6;
  for (let step = 0; step < 16; step++) {
    const middle = (low + high) / 2;
    if (stands(middle)) high = middle;
    else low = middle;
  }
  return Math.ceil(high * 1000) / 1000;
}

/** The line each look draws today: the modern look's mixed from the surface
    and the ink, the terminal look's the rule. */
function todayLine(colours: Record<string, string>, look: Look): Rgb {
  return look === "modern"
    ? mix(hexToRgb(colours.surface), hexToRgb(colours.ink), 0.18)
    : hexToRgb(colours.rule);
}

/** What a background paints in a look over a palette's colours in one
    appearance, with the guard's stronger text and the lines' one amount. */
export function paintOf(
  background: Background,
  look: Look,
  colours: Record<string, string>,
  cards = 0,
): Painted {
  const strength = look === "terminal" ? Math.min(background.strength, TERMINAL_STRENGTH) : background.strength;
  const grain = look === "terminal" ? 0 : background.grain;
  const tone = toneOf(colours);
  const dots = background.dots.map((dot) => dotColour(dot, tone));
  const at = field(dots);
  const grounds = groundsOf(colours, look);
  const parts = Object.keys(grounds) as Part[];

  const ink = hexToRgb(colours.ink);
  const accent = hexToRgb(colours.accent);
  const fills: [Rgb, number][] = [
    [ink, GUARD_FILL.ink],
    [accent, GUARD_FILL.accent],
  ];
  const grid = dots.length === 1 ? [labToRgb(dots[0])] : gridOf(at, 24, 15);
  let low = 1;
  let high = 0;
  // Parts that share a ground, as the modern look's headers and status bar
  // do, are read once.
  const textGrounds = new Map(TEXT_PARTS[look].map((part) => [grounds[part]!.join(","), grounds[part]!]));
  for (const ground of textGrounds.values()) {
    const [partLow, partHigh] = extremes(grid, ground, strength, grain * GRAIN_SPECK, fills);
    low = Math.min(low, partLow);
    high = Math.max(high, partHigh);
  }
  const throughCards = cards > 0 ? cardsOf(colours, look, dots, strength, grain, cards) : null;

  const text = {} as Record<TextToken, string>;
  const asked = {} as Record<TextToken, number>;
  const contrast = {} as Record<TextToken, number>;
  for (const token of TEXT_TOKENS) {
    asked[token] = worst(colours[token], [low, high]);
    text[token] = strengthen(colours[token], [low, high], tone);
    contrast[token] = worst(text[token], [low, high]);
  }

  // One amount for every line in the window: the most any part needs to
  // stand as far off it as today's line stands off its plain ground, a
  // solid surface included.
  const surface = hexToRgb(colours.surface);
  const line = todayLine(colours, look);
  const strong = hexToRgb(colours["rule-strong"]);
  const away = (colour: Rgb, from: Rgb) => ratio(luminance(colour), luminance(from));
  let amount = lineAmount([surface], ink, away(line, surface));
  let strongAmount = 0;
  const painted: Partial<Record<Part, string>> = {};
  const coarse = dots.length === 1 ? grid : gridOf(at, 8, 5);
  if (throughCards !== null && throughCards.amount > 0) {
    // A see-through card's ground and its well's are grounds a line lies
    // on as well.
    for (const ground of [hexToRgb(colours.surface), wellOf(colours)]) {
      const under = coarse.map((colour) => mix(ground, colour, throughCards.amount));
      amount = Math.max(amount, lineAmount(under, ink, away(line, ground)));
      strongAmount = Math.max(strongAmount, lineAmount(under, ink, away(strong, ground)));
    }
  }
  for (const part of parts) {
    const ground = grounds[part]!;
    const under = coarse.map((colour) => mix(ground, colour, strength));
    amount = Math.max(amount, lineAmount(under, ink, away(line, ground)));
    strongAmount = Math.max(strongAmount, lineAmount(under, ink, away(strong, ground)));
    painted[part] = rgba(ground, 1 - strength);
  }

  return {
    colours: dots,
    strength,
    grain,
    grounds: painted,
    text,
    line: rgba(ink, amount),
    lineStrong: rgba(ink, Math.max(amount, strongAmount)),
    fill: rgba(ink, FILL.ink),
    fillAccent: rgba(accent, FILL.accent),
    asked,
    contrast,
    cards: throughCards,
  };
}

/* ---------------------------------------------------------------------- */
/* Cards that let the background through.                                  */
/* ---------------------------------------------------------------------- */

/** The terminal's sixteen colours, by token. */
export const ANSI_TOKENS = [
  "ansi-black",
  "ansi-red",
  "ansi-green",
  "ansi-yellow",
  "ansi-blue",
  "ansi-magenta",
  "ansi-cyan",
  "ansi-white",
  "ansi-bright-black",
  "ansi-bright-red",
  "ansi-bright-green",
  "ansi-bright-yellow",
  "ansi-bright-blue",
  "ansi-bright-magenta",
  "ansi-bright-cyan",
  "ansi-bright-white",
] as const;

/** The well's tone: a step from the surface toward the ground, for a list
    beside what is read, read from the colours as the deep is. */
export function wellOf(colours: Record<string, string>): Rgb {
  const bg = hexToRgb(colours.bg);
  return toneOf(colours) === "light" ? bg : mix(bg, hexToRgb(colours.surface), 0.45);
}

/** What the grain comes to behind a card: its speckle blurred to a flat
    grey at the mean opacity of a speck, so a card shows the background
    soft rather than speckled. */
export const veilOf = (grain: number) => (GRAIN_SPECK * grain) / 2;
const VEIL: Rgb = [127.5, 127.5, 127.5];

/** A ground inside a card that text is read on, with a fill over it, and
    the kinds of text read there. A terminal's are its own colours, which
    the guard reads and never redraws. */
interface CardPair {
  ground: "card" | "well";
  fill: "ink" | "accent" | "add" | "del" | null;
  amount: number;
  tokens: readonly string[];
  terminal?: boolean;
}

const CARD_PAIRS: CardPair[] = [
  // The card and the well beside it, bare and under a hovered or chosen
  // row, a field or your message, read as the chrome's parts are.
  ...(["card", "well"] as const).flatMap((ground) => [
    { ground, fill: null, amount: 0, tokens: TEXT_TOKENS },
    { ground, fill: "ink" as const, amount: GUARD_FILL.ink, tokens: TEXT_TOKENS },
    { ground, fill: "accent" as const, amount: GUARD_FILL.accent, tokens: TEXT_TOKENS },
  ]),
  // A diff's added and removed rows with their numbers, selected text, and
  // the current find match.
  { ground: "card", fill: "add", amount: 0.14, tokens: ["ink", "add", "ink-3"] },
  { ground: "card", fill: "del", amount: 0.14, tokens: ["ink", "del", "ink-3"] },
  { ground: "card", fill: "accent", amount: 0.24, tokens: ["ink"] },
  { ground: "card", fill: "accent", amount: 0.38, tokens: ["ink"] },
  // A terminal on the card, a shell without the keyboard on the well, and
  // a selection in a terminal.
  { ground: "card", fill: null, amount: 0, tokens: ["ink", ...ANSI_TOKENS], terminal: true },
  { ground: "well", fill: null, amount: 0, tokens: ["ink", ...ANSI_TOKENS], terminal: true },
  { ground: "card", fill: "accent", amount: 0.22, tokens: ["ink"], terminal: true },
];

/** How far, in OKLab, cards in dark keep standing off the ground at their
    weakest point: about half the least step any palette's plain cards
    have, or the step solid cards have over the background where that is
    already less. */
export const STAND_OFF = 0.015;

/** What the cards paint in one appearance and look. */
export interface PaintedCards {
  /** The share of the strength asked, and the share let through after
      the guard, and why it holds back: a terminal colour that would fall
      under 4.5:1, or cards that would stop standing off the ground. */
  asked: number;
  held: number;
  heldBy: "terminal" | "ground" | null;
  /** How much of the background a card shows: the strength times the
      share let through. */
  amount: number;
  /** The card's ground and the well's, let through by that amount. */
  card: string;
  well: string;
  /** The grain blurred to a flat veil over the background, or null. */
  veil: string | null;
  /** The text tokens on cards, a step stronger where they need it, and
      their contrast at the worst point. */
  text: Record<TextToken, string>;
  contrast: Record<TextToken, number>;
  /** The lowest contrast of any terminal colour the guard reads. */
  terminal: number;
  /** How far cards stand off the ground at their weakest point, as a
      share of the step they have with no background. */
  standOff: number;
}

/** The lightest and darkest a card's ground gets under a fill, anywhere in
    the window, at an amount of the veiled background. */
function cardRange(under: Rgb[], ground: Rgb, amount: number, fill: Rgb | null, share: number): [number, number] {
  let low = 1;
  let high = 0;
  for (const colour of under) {
    const card = mix(ground, colour, amount);
    const y = luminance(fill === null ? card : mix(card, fill, share));
    low = Math.min(low, y);
    high = Math.max(high, y);
  }
  return [low, high];
}

/** The least step, in OKLab, between a card and the ground it stands on. */
function standOff(under: Rgb[], card: Rgb, ground: Rgb, amount: number, strength: number): number {
  let least = Infinity;
  for (const colour of under) {
    const [L1, a1, b1] = rgbToLab(mix(card, colour, amount));
    const [L2, a2, b2] = rgbToLab(mix(ground, colour, strength));
    least = Math.min(least, Math.hypot(L1 - L2, a1 - a2, b1 - b2));
  }
  return least;
}

/** What cards paint that let through a share of a background's strength,
    with the guard's stronger text and the share it holds back to. */
export function cardsOf(
  colours: Record<string, string>,
  look: Look,
  dots: Lab[],
  strength: number,
  grain: number,
  asked: number,
): PaintedCards {
  const tone = toneOf(colours);
  const at = field(dots);
  const grid = dots.length === 1 ? [labToRgb(dots[0])] : gridOf(at, 24, 15);
  const veil = veilOf(grain);
  const under = veil > 0 ? grid.map((colour) => mix(colour, VEIL, veil)) : grid;
  const grounds = { card: hexToRgb(colours.surface), well: wellOf(colours) };
  const fillOf = (name: CardPair["fill"]) => (name === null ? null : hexToRgb(colours[name]));
  const ranges = (amount: number) =>
    CARD_PAIRS.map((pair) => cardRange(under, grounds[pair.ground], amount, fillOf(pair.fill), pair.amount));

  // A terminal colour that holds 4.5:1 on a solid card is to hold it on a
  // see-through one; the share is held back to the most at which each
  // still does.
  const terminalPairs = CARD_PAIRS.flatMap((pair, index) => (pair.terminal ? [index] : []));
  const terminalRanges = (amount: number) =>
    terminalPairs.map((index) => {
      const pair = CARD_PAIRS[index];
      return cardRange(under, grounds[pair.ground], amount, fillOf(pair.fill), pair.amount);
    });
  const solid = terminalRanges(0);
  const judged = terminalPairs.flatMap((index, at) =>
    CARD_PAIRS[index].tokens
      .filter((token) => worst(colours[token], solid[at]) >= LEAST_CONTRAST)
      .map((token) => ({ at, token })),
  );
  const terminalLow = (amount: number) => {
    const now = terminalRanges(amount);
    return judged.reduce((least, { at, token }) => Math.min(least, worst(colours[token], now[at])), Infinity);
  };

  // In dark, the background lifts the ground toward the cards' lightness,
  // so the guard also holds the share where cards would stop standing off
  // the ground.
  const ground = look === "modern" ? deepOf(colours) : hexToRgb(colours.bg);
  const plain = (() => {
    const [L1, a1, b1] = rgbToLab(grounds.card);
    const [L2, a2, b2] = rgbToLab(ground);
    return Math.hypot(L1 - L2, a1 - a2, b1 - b2);
  })();
  const least = tone === "light" ? 0 : Math.min(STAND_OFF, standOff(under, grounds.card, ground, 0, strength)) - 1e-6;
  /** What holds a share back, or null where it holds. */
  const fails = (share: number): PaintedCards["heldBy"] => {
    if (terminalLow(strength * share) < LEAST_CONTRAST) return "terminal";
    if (tone === "dark" && standOff(under, grounds.card, ground, strength * share, strength) < least) return "ground";
    return null;
  };

  // The share asked, or else the most in whole hundredths that holds. Each
  // figure falls as the share grows, so halving finds it.
  let held = asked;
  let heldBy = fails(asked);
  if (heldBy !== null) {
    let low = 0;
    let high = Math.ceil(asked * 100);
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (fails(middle / 100) === null) low = middle;
      else high = middle;
    }
    held = low / 100;
    heldBy = fails(high / 100) ?? heldBy;
  }
  const amount = strength * held;

  // The app's own text is drawn a step stronger, as on the chrome, over
  // every ground and fill it is read on.
  const now = ranges(amount);
  const text = {} as Record<TextToken, string>;
  const contrast = {} as Record<TextToken, number>;
  for (const token of TEXT_TOKENS) {
    let low = 1;
    let high = 0;
    CARD_PAIRS.forEach((pair, index) => {
      if (pair.terminal || !pair.tokens.includes(token)) return;
      low = Math.min(low, now[index][0]);
      high = Math.max(high, now[index][1]);
    });
    text[token] = amount > 0 ? strengthen(colours[token], [low, high], tone) : colours[token];
    contrast[token] = worst(text[token], [low, high]);
  }

  return {
    asked,
    held,
    heldBy,
    amount,
    card: rgba(grounds.card, 1 - amount),
    well: rgba(grounds.well, 1 - amount),
    veil: veil > 0 ? rgba(VEIL, veil) : null,
    text,
    contrast,
    terminal: judged.length === 0 ? Infinity : terminalLow(amount),
    standOff: plain === 0 ? 1 : standOff(under, grounds.card, ground, amount, strength) / plain,
  };
}
