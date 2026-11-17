/**
 * A background of the user's own, and the guard that keeps the text on it
 * as readable as the colours allow.
 *
 * A background is one to three dots on a colour pad, each a hue and how
 * much colour, from none at the centre to the rim. It says nothing about
 * lightness: the chrome it lies on sets that, light or dark, so one
 * background is painted for both appearances. Whether the chrome is light
 * or dark is read from its own colours, not from the appearance's name, so
 * a theme that is dark in both appearances is painted dark in both. Grain
 * lays a fine speckle over it.
 *
 * Strength runs from a calm tint to the colours themselves. Up to CALM it
 * is how far a tint at about the chrome's darkest lightness shows through
 * the chrome's own ground; by FULL_TINT that tint shows whole; from there
 * to the top the colours rise to the lightness and colour the pad shows
 * them in, so at full strength the window is the colours on the pad. The
 * Strength slider shows it along SLIDER, so each of its steps changes the
 * picture by about as much as any other.
 *
 * Two or three colours make a gradient across the window: the first two run
 * from the top left down to the foot, mixed in OKLCH so the middle never
 * greys out, and a third glows from the top right. A harmony keeps the dots
 * a fixed turn of the hue apart, so dragging the first carries the others.
 * Three colours are placed close together by default, a sixth of a turn
 * either side of the first, since colours that are near in hue belong
 * together and mix cleanly; three spread evenly round the wheel stay a
 * choice.
 *
 * The background tints the chrome, and the cards that hold what is read
 * keep their own lightness. The guard judges each kind of text on a tinted
 * part at the worst point of the gradient behind it, grain included, and
 * draws the text a step stronger, towards black on a light chrome and white
 * on a dark one, just as far as it takes to hold 4.5:1. Where that end
 * cannot, it takes whichever of black or white reads better, so on colours
 * too strong for 4.5:1 the text still has the most contrast there is; the
 * colours are never held back for it. Lines on or beside a tinted part are
 * the ink let through at one amount for the whole window, so they take the
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
  /** How strongly the background shows, 0.1 to 1: see throughAt and
      vividAt. */
  strength: number;
  /** How strong the speckle over it is, 0 to 1. */
  grain: number;
}

export const MOST_DOTS = 3;
export const LEAST_STRENGTH = 0.1;
/** The most a cards' share is kept as. The share is read against this
    end, so 0.25 is the end of the Cards range, shown as 100%. */
export const MOST_CARDS = 0.25;
/** How much of the calm tint a card shows at the end of the Cards range,
    as a share of what the ground lets through. */
export const CARDS_REACH = 1;
/** How far a speck of grain darkens or lightens, at full grain. */
export const GRAIN_SPECK = 0.14;
/** The contrast the guard draws each text on a tinted part to, at its
    worst point, wherever black or white can reach it. */
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
/** How much of white or black a chip, and a chosen row, lay over the
    colours on a tinted part where the text there has turned to the other
    end, whose accent is then too near the ink to mark a row. */
const PATCH = 0.5;
const CHOSEN = 0.3;
const GUARD_FILL = { ink: 0.12, accent: 0.16 };
// The guard reads text over one fill at a time. A fill laid over another,
// such as a hovered row inside a chosen one, can leave ink-2, ink-3 and
// the accent a little under 4.5:1 at the worst point, so no text in those
// tokens sits on stacked fills; a part that stacks them has to be read
// here as well.

/** The calm tint: the lightness a light and a dark chrome paint at up to
    FULL_TINT, and the most colour each takes at the rim, in OKLCH. Each is
    about the lightness of the chrome's darkest tone, the modern look's
    ground, so the ground keeps its place under the cards and they stand
    off it by lightness as well as colour. Near black the screen shows
    little colour at any lightness, so a dark chrome takes more of it at
    the rim, as much as the screen can show for hues that allow it. A card
    takes its colour from this tint at every strength, so it keeps its own
    lightness. */
export const BAND: Record<Appearance, { lightness: number; chroma: number }> = {
  light: { lightness: 0.94, chroma: 0.066 },
  dark: { lightness: 0.18, chroma: 0.13 },
};

/** The colours as the pad shows them on a light and a dark chrome, which
    is what the window paints at full strength: light and full enough to
    read as the hue they are, as much colour at the rim as the screen
    shows. Each hue is as light as its fullest colour on the screen,
    CUSP_BELOW under it, held between `lightness` and `most`: pinks, reds,
    blues and violets are fullest darker and sit at `lightness`, while
    yellows, limes, greens and cyans are fullest much lighter, and at
    `lightness` would read as olive and teal rather than as themselves. */
export const PAD: Record<Appearance, { lightness: number; most: number; chroma: number }> = {
  light: { lightness: 0.8, most: 0.9, chroma: 0.15 },
  dark: { lightness: 0.7, most: 0.86, chroma: 0.15 },
};
const CUSP_BELOW = 0.05;

/** The lightness at which each hue shows the most colour the screen can,
    every two degrees, worked out once. */
let cusps: Float64Array | null = null;

function cuspOf(hue: number): number {
  if (cusps === null) {
    cusps = new Float64Array(181);
    const fullest = (L: number, h: number) => {
      const [, a, b] = fitLch(L, 0.4, h);
      return Math.hypot(a, b);
    };
    for (let at = 0; at <= 180; at++) {
      // The colour the screen shows rises and then falls with lightness.
      let low = 0.3;
      let high = 0.99;
      for (let step = 0; step < 40; step++) {
        const one = low + (high - low) / 3;
        const two = high - (high - low) / 3;
        if (fullest(one, at * 2) < fullest(two, at * 2)) low = one;
        else high = two;
      }
      cusps[at] = (low + high) / 2;
    }
  }
  const at = turn(hue) / 2;
  const below = Math.floor(at);
  const above = Math.min(below + 1, 180);
  return cusps[below] + (cusps[above] - cusps[below]) * (at - below);
}

/** How light a hue paints at full strength on a light or a dark chrome. */
export function padLightness(hue: number, tone: Appearance): number {
  const pad = PAD[tone];
  return clamp(cuspOf(hue) - CUSP_BELOW, pad.lightness, pad.most);
}

/** The strength up to which the calm tint shows through the ground by as
    much as the strength says, and the strength at which it shows whole;
    from there to the top the colours rise from the calm tint to the
    pad's. */
export const CALM = 0.6;
export const FULL_TINT = 0.75;

/** How much of the colours the chrome's ground lets through at a strength:
    the strength itself up to CALM, then all of it by FULL_TINT. */
export function throughAt(strength: number): number {
  if (strength <= CALM) return strength;
  return Math.min(1, CALM + ((strength - CALM) * (1 - CALM)) / (FULL_TINT - CALM));
}

/** How far the colours have risen from the calm tint to the pad's at a
    strength, 0 up to FULL_TINT and 1 at the top. */
export function vividAt(strength: number): number {
  return clamp((strength - FULL_TINT) / (1 - FULL_TINT), 0, 1);
}

/** Where each strength sits on the Strength slider, from 0 at no
    background to 1 at the colours themselves, with a straight run
    between each pair. The slider is even to the eye: each step of it
    changes what the window paints by about the same amount, measured in
    OKLab over every hue at the rim, on a light chrome and a dark one
    alike. Up to CALM the calm tint is a small change, on a dark chrome
    most of all, so it takes the first tenth of the slider; the rest of
    the calm tint takes the next sixteenth, and the rise to the colours
    the rest. */
export const SLIDER: readonly (readonly [number, number])[] = [
  [0, 0],
  [CALM, 0.098],
  [FULL_TINT, 0.161],
  [1, 1],
];

/** Where a strength sits on the Strength slider, 0 to 1. */
export function positionOf(strength: number): number {
  const at = clamp(strength, 0, 1);
  const upper = SLIDER.findIndex(([knot]) => knot >= at);
  if (upper <= 0) return SLIDER[0][1];
  const [s0, p0] = SLIDER[upper - 1];
  const [s1, p1] = SLIDER[upper];
  return p0 + ((at - s0) * (p1 - p0)) / (s1 - s0);
}

/** The strength at a place on the Strength slider, 0 to 1, never under
    LEAST_STRENGTH. */
export function strengthAt(position: number): number {
  const at = clamp(position, 0, 1);
  const upper = SLIDER.findIndex(([, place]) => place >= at);
  if (upper <= 0) return LEAST_STRENGTH;
  const [s0, p0] = SLIDER[upper - 1];
  const [s1, p1] = SLIDER[upper];
  return Math.max(LEAST_STRENGTH, s0 + ((at - p0) * (s1 - s0)) / (p1 - p0));
}

/** A strength as the slider shows it, in whole percent. */
export const strengthPercent = (strength: number) => Math.round(positionOf(strength) * 100);

/** How far either side of the first dot a close colour sits, in degrees. */
export const NEAR = 50;

/** The harmonies, in the order the picker shows them: each a turn of the
    hue from the first dot for every dot. */
export const HARMONIES: { name: Exclude<Harmony, "free">; label: string; offsets: number[] }[] = [
  { name: "single", label: "Single", offsets: [0] },
  { name: "complementary", label: "Complementary", offsets: [0, 180] },
  { name: "analogous", label: "Analogous", offsets: [0, NEAR, -NEAR] },
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
      { hue: 190, chroma: 0.8 },
      { hue: 90, chroma: 0.8 },
    ],
  },
  {
    name: "aurora",
    label: "Aurora",
    harmony: "analogous",
    dots: [
      { hue: 250, chroma: 0.85 },
      { hue: 300, chroma: 0.85 },
      { hue: 200, chroma: 0.85 },
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
    throw new Error(`cards are kept from 0 to ${MOST_CARDS}, not ${JSON.stringify(value)}.`);
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
    thousandths for the strength, fine enough for each step of the even
    slider where the colours rise, and hundredths for the rest. */
export function rounded(background: Background): Background {
  const hundredths = (value: number) => Math.round(value * 100) / 100;
  return {
    dots: background.dots.map((dot) => ({
      hue: Math.round(dot.hue) % 360,
      chroma: hundredths(Math.min(1, Math.max(0, dot.chroma))),
    })),
    harmony: background.harmony,
    strength: Math.round(Math.min(1, Math.max(LEAST_STRENGTH, background.strength)) * 1000) / 1000,
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
  return `${colours}, strength ${strengthPercent(background.strength)}%, grain ${Math.round(background.grain * 100)}%`;
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
    with it, each keeping its own turn of the hue from the first and taking
    the first's colour, so a background kept with other turns than the
    harmony's own keeps them; moving any other sets the harmony free. */
export function moveDot(background: Background, index: number, dot: Dot): Background {
  const placed = { hue: turn(dot.hue), chroma: Math.min(1, Math.max(0, dot.chroma)) };
  if (index === 0 && background.harmony !== "free") {
    const from = background.dots[0].hue;
    return {
      ...background,
      dots: background.dots.map((old, at) =>
        at === 0 ? placed : { hue: turn(placed.hue + old.hue - from), chroma: placed.chroma },
      ),
    };
  }
  const dots = background.dots.map((old, at) => (at === index ? placed : old));
  return { ...background, dots, harmony: index === 0 ? background.harmony : "free" };
}

/** A dot more, up to three. One becomes a complementary pair, and a pair in
    harmony three close colours around the first. A free pair keeps its two
    and gains one a sixth of a turn from the first, on the side away from
    the second. */
export function addDot(background: Background): Background {
  const count = background.dots.length;
  if (count >= MOST_DOTS) return background;
  if (background.harmony === "single") return withHarmony(background, "complementary");
  if (background.harmony !== "free") return withHarmony(background, "analogous");
  const [first, second] = background.dots;
  const towards = ((second.hue - first.hue + 540) % 360) - 180;
  const dot = { hue: turn(first.hue + (towards >= 0 ? -NEAR : NEAR)), chroma: first.chroma };
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
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

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

/** A dot's colour on a light or a dark chrome at a strength: the calm
    tint's lightness and share of the rim's colour up to FULL_TINT, rising
    to the pad's above it, held inside what the screen shows. Left without
    a strength it is the calm tint, which the cards take. */
export function dotColour(dot: Dot, tone: Appearance, strength = 0): Lab {
  const band = BAND[tone];
  const pad = PAD[tone];
  const vivid = vividAt(strength);
  const lightness = vivid === 0 ? band.lightness : band.lightness + (padLightness(dot.hue, tone) - band.lightness) * vivid;
  const chroma = band.chroma + (pad.chroma - band.chroma) * vivid;
  return fitLch(lightness, clamp(dot.chroma, 0, 1) * chroma, dot.hue);
}

/** A dot as the pad shows it, which is how the window paints it at full
    strength. */
export function padColour(dot: Dot, appearance: Appearance): string {
  const pad = PAD[appearance];
  return rgbToHex(labToRgb(fitLch(padLightness(dot.hue, appearance), clamp(dot.chroma, 0, 1) * pad.chroma, dot.hue)));
}

/** A background as a small swatch shows it: its colours laid over a
    palette's ground at its strength, run corner to corner. */
export function swatchOf(background: Background, palette: Record<string, string>): string {
  const under = hexToRgb(palette.bg);
  const tone = toneOf(palette);
  const colours = background.dots.map((dot) =>
    rgbToHex(mix(under, labToRgb(dotColour(dot, tone, background.strength)), throughAt(background.strength))),
  );
  return colours.length === 1 ? colours[0] : `linear-gradient(135deg, ${colours.join(", ")})`;
}

/** The pad as pixels, RGBA: hue around it and colour out to the rim, as
    padColour shows a dot, edged smoothly. */
export function padPixels(size: number, appearance: Appearance): Uint8ClampedArray {
  const { chroma: rim } = PAD[appearance];
  // How light each half degree of hue is, and the most colour the screen
  // shows there.
  const light = Array.from({ length: 720 }, (_, at) => padLightness(at / 2, appearance));
  const most = light.map((lightness, at) => {
    const [, a, b] = fitLch(lightness, rim, at / 2);
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
      const at = Math.round(hue * 2) % 720;
      const chroma = Math.min(Math.min(r, 1) * rim, most[at]);
      const rgb = labToRgb(lchToLab(light[at], chroma, hue));
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
    and how strongly the third glows there: as strongly as its reach across
    to the point's column and its reach down to the point's row together
    allow, so an image works each out once a column and once a row. */
const run = (u: number, v: number) => smooth(clamp(((u * 0.9 + v * 1.5) / 2.4 - 0.04) / 0.9, 0, 1));
const MOST_GLOW = 0.92;
const glowAcross = (u: number) => Math.exp(-(((u - 0.94) * 1.6) ** 2) / 0.55);
const glowDown = (v: number) => MOST_GLOW * Math.exp(-((v + 0.04) ** 2) / 0.55);
const glow = (u: number, v: number) => glowAcross(u) * glowDown(v);

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

/** How many places along the run between the first two colours, and how
    many strengths of a third colour's glow, the gradient's colours are
    worked out at. A pixel takes the nearest place along the run, within a
    tenth of a step of its own colour, rather than reading between two:
    where a third colour glows, the colour jumps between two places at the
    hue where the glow's shortest turn goes the other way round. It reads
    between the two strengths of the glow it falls between, which keeps it
    within a tenth of a step as well, and within one where a channel is
    held at either end of its range. */
const RUN_PLACES = 512;
const GLOW_PLACES = 24;

/** The gradient as pixels, RGBA, for an image stretched over the window.
    Its colours are worked out once, at places along the run and, with a
    third colour, at strengths of its glow, as many of each as `worked`
    asks: RUN_PLACES and GLOW_PLACES unless an image drawn coarsely while
    the background moves asks for fewer. The whole is dithered by half a
    step, so a soft run does not band. */
export function gradientPixels(
  colours: Lab[],
  width: number,
  height: number,
  worked: { run: number; glow: number } = { run: RUN_PLACES, glow: GLOW_PLACES },
): Uint8ClampedArray {
  const places = colours.length > 1 ? worked.run : 1;
  const strengths = colours.length > 2 ? worked.glow : 1;
  // The colours as RGB: a row of places along the run for each strength.
  const table = new Float64Array(places * strengths * 3);
  for (let place = 0; place < places; place++) {
    const along = places === 1 ? colours[0] : mixLch(colours[0], colours[1], place / (places - 1));
    for (let strength = 0; strength < strengths; strength++) {
      const lab =
        strengths === 1 ? along : mixLch(along, colours[2], (strength / (strengths - 1)) * MOST_GLOW);
      table.set(labToRgb(lab), (strength * places + place) * 3);
    }
  }
  const across = Float64Array.from({ length: width }, (_, x) => glowAcross(x / (width - 1)));
  const down = Float64Array.from({ length: height }, (_, y) => glowDown(y / (height - 1)));
  // The last strength a pixel reads from with the one after it.
  const lastStrength = Math.max(strengths - 2, 0);
  const pixels = new Uint8ClampedArray(width * height * 4);
  // A number from -0.5 up to 0.5, the same sequence every time.
  let seed = 11;
  const noise = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296 - 0.5;
  };
  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    for (let x = 0; x < width; x++) {
      // Where the pixel falls in the table: the nearest place along the
      // run, the strength at or below its glow, and how far on towards the
      // next strength.
      const place = Math.round(run(x / (width - 1), v) * (places - 1));
      const strength = ((across[x] * down[y]) / MOST_GLOW) * (strengths - 1);
      const s0 = Math.min(Math.floor(strength), lastStrength);
      const alongGlow = strength - s0;
      const low = (s0 * places + place) * 3;
      const high = (Math.min(s0 + 1, strengths - 1) * places + place) * 3;
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const value = table[low + channel] + (table[high + channel] - table[low + channel]) * alongGlow;
        pixels[offset + channel] = Math.round(value + noise());
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
  /** The dots' colours on the chrome in this appearance, at the strength. */
  colours: Lab[];
  /** The dots' colours a card takes: the calm tint, the same as on the
      chrome up to FULL_TINT. */
  cardColours: Lab[];
  /** How much of the colours the ground lets through, from throughAt, and
      the grain after the look's limits. */
  through: number;
  grain: number;
  /** Each tinted part's own ground, laid over the colours. */
  grounds: Partial<Record<Part, string>>;
  /** The text tokens on tinted parts, a step stronger where they need it,
      or black or white where the colours are too strong for 4.5:1. */
  text: Record<TextToken, string>;
  /** Every line, and the stronger marks such as a tag's outline. */
  line: string;
  lineStrong: string;
  /** The lines on the tinted parts: the same as every other line, unless
      the text there turned to black or white, whose end they then take. */
  partLine: string;
  partLineStrong: string;
  /** What a hovered row or a field, and a chosen row, lay over the tint.
      Where the text has turned to the other end, a chosen row is a step of
      that end instead, since the accent is then too near the ink. */
  fill: string;
  fillAccent: string;
  /** What a chosen row lays over a see-through card: the accent let
      through, whatever the chrome's text has turned to. */
  cardFillAccent: string;
  /** A chip on a tinted part, such as a chosen switch: the palette's
      surface while the text keeps the palette's lean, and the other end let
      through where the text has turned to black or white against it. */
  patch: string;
  /** A glyph on the accent laid as a fill on a tinted part: the palette's
      ground where it stands 3:1 off the accent there, else whichever of
      black or white stands further off. */
  onAccent: string;
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
    contrast. Where that end cannot hold it, it heads for whichever of
    black or white reads better, and where neither holds it, it is that
    end itself: the most contrast the colours leave. */
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
  const own = under.map(luminance);
  const stands = (amount: number) =>
    under.every((colour, at) => ratio(luminance(mix(colour, ink, amount)), own[at]) >= target);
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
    appearance, with the guard's stronger text and the lines' one amount.
    The terminal look takes no grain. */
export function paintOf(
  background: Background,
  look: Look,
  colours: Record<string, string>,
  cards = 0,
): Painted {
  const through = throughAt(background.strength);
  const grain = look === "terminal" ? 0 : background.grain;
  const tone = toneOf(colours);
  const dots = background.dots.map((dot) => dotColour(dot, tone, background.strength));
  const cardDots = vividAt(background.strength) > 0 ? background.dots.map((dot) => dotColour(dot, tone)) : dots;
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
    const [partLow, partHigh] = extremes(grid, ground, through, grain * GRAIN_SPECK, fills);
    low = Math.min(low, partLow);
    high = Math.max(high, partHigh);
  }
  const throughCards = cards > 0 ? cardsOf(colours, look, cardDots, through, grain, cards, dots) : null;

  const text = {} as Record<TextToken, string>;
  const asked = {} as Record<TextToken, number>;
  const contrast = {} as Record<TextToken, number>;
  for (const token of TEXT_TOKENS) {
    asked[token] = worst(colours[token], [low, high]);
    text[token] = strengthen(colours[token], [low, high], tone);
    contrast[token] = worst(text[token], [low, high]);
  }

  // Text that turned against the palette's lean, on colours too strong for
  // it, takes its chips, its chosen rows and its lines from the end it
  // turned to; the palette's own would vanish there.
  const own = luminance(ink);
  const now = luminance(hexToRgb(text.ink));
  const turned = tone === "dark" ? now < own : now > own;
  const towards: Rgb = tone === "dark" ? [0, 0, 0] : [255, 255, 255];
  const other: Rgb = tone === "dark" ? [255, 255, 255] : [0, 0, 0];
  const patch = turned ? rgba(other, PATCH) : colours.surface;
  const accentNow = luminance(hexToRgb(text.accent));
  const off = (colour: string) => ratio(luminance(hexToRgb(colour)), accentNow);
  const onAccent = off(colours.bg) >= 3 ? colours.bg : off("#000000") >= off("#ffffff") ? "#000000" : "#ffffff";

  // One amount for every line in the window: the most any part needs to
  // stand as far off it as today's line stands off its plain ground, a
  // solid surface included. Where the text on the tinted parts turned,
  // their lines are that end let through, at an amount of their own.
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
    const solid = [hexToRgb(colours.surface), wellOf(colours)];
    const laid = [throughCards.laid.card, throughCards.laid.well];
    const behind = cardDots === dots ? coarse : cardDots.length === 1 ? [labToRgb(cardDots[0])] : gridOf(field(cardDots), 8, 5);
    for (const [at, ground] of solid.entries()) {
      const under = behind.map((colour) => mix(laid[at], colour, throughCards.amount));
      amount = Math.max(amount, lineAmount(under, ink, away(line, ground)));
      strongAmount = Math.max(strongAmount, lineAmount(under, ink, away(strong, ground)));
    }
  }
  const partInk = turned ? towards : ink;
  let partAmount = 0;
  let partStrong = 0;
  for (const part of parts) {
    const ground = grounds[part]!;
    const under = coarse.map((colour) => mix(ground, colour, through));
    partAmount = Math.max(partAmount, lineAmount(under, partInk, away(line, ground)));
    partStrong = Math.max(partStrong, lineAmount(under, partInk, away(strong, ground)));
    painted[part] = rgba(ground, 1 - through);
  }
  if (!turned) {
    amount = Math.max(amount, partAmount);
    strongAmount = Math.max(strongAmount, partStrong);
  }
  const lines = { line: rgba(ink, amount), lineStrong: rgba(ink, Math.max(amount, strongAmount)) };
  const partLines = turned
    ? { line: rgba(partInk, partAmount), lineStrong: rgba(partInk, Math.max(partAmount, partStrong)) }
    : lines;

  return {
    colours: dots,
    cardColours: cardDots,
    through,
    grain,
    grounds: painted,
    text,
    line: lines.line,
    lineStrong: lines.lineStrong,
    partLine: partLines.line,
    partLineStrong: partLines.lineStrong,
    fill: rgba(ink, FILL.ink),
    fillAccent: turned ? rgba(other, CHOSEN) : rgba(accent, FILL.accent),
    cardFillAccent: rgba(accent, FILL.accent),
    patch,
    onAccent,
    asked,
    contrast,
    cards: throughCards,
  };
}

/** The lowest contrast any text on a tinted part is left at, after the
    guard: under LEAST_CONTRAST only where the colours are too strong for
    black or white to reach it. */
export const lowestText = (painted: Painted) => Math.min(...TEXT_TOKENS.map((token) => painted.contrast[token]));

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

/** How far, in OKLab, cards in dark stand off the ground at their weakest
    point before the section says they barely do: about half the least step
    any palette's plain cards have, or the step solid cards have over the
    background where that is already less. */
export const STAND_OFF = 0.015;

/** What the cards paint in one appearance and look. */
export interface PaintedCards {
  /** The cards' share asked, which is let through whole. */
  asked: number;
  /** What reads poorly at the share: a terminal colour that held 4.5:1 on
      a solid card and falls under it, or cards that barely stand off the
      ground in dark; null where neither does. */
  poor: "terminal" | "ground" | null;
  /** How much of the calm tint a card shows, from throughOf. */
  amount: number;
  /** The card's ground and the well's, let through by that amount, and
      the solid tones they lay over the background. */
  card: string;
  well: string;
  laid: { card: Rgb; well: Rgb };
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

/** How much of the calm tint a card shows at a share: none at none, and at
    the end of the range CARDS_REACH of what the ground lets through. */
export const throughOf = (share: number, through: number) =>
  through * CARDS_REACH * clamp(share / MOST_CARDS, 0, 1);

/** The grey at the background's lightness: what a card takes out of the
    background so it keeps its own lightness and takes only its colour. */
function greyOf(under: Rgb[]): Rgb {
  const lightness = under.reduce((sum, colour) => sum + rgbToLab(colour)[0], 0) / under.length;
  return labToRgb([lightness, 0, 0]);
}

/** The solid tone a see-through card lays over the background, at one
    less the amount, so that it comes out as its own ground with the
    background's colour let through by the amount: its ground with that
    much of the grey taken out. Where the tone would leave what the screen
    shows, as a white card's does, it stops there, and the card takes on a
    little of the background's lightness as well. */
export function laidOf(ground: Rgb, grey: Rgb, amount: number): Rgb {
  if (amount <= 0) return ground;
  return ground.map((value, at) => clamp((value - amount * grey[at]) / (1 - amount), 0, 255)) as Rgb;
}

/** The lightest and darkest a card's ground gets under a fill, anywhere in
    the window, at an amount of the veiled background, the card laying its
    solid tone over it. */
function cardRange(under: Rgb[], laid: Rgb, amount: number, fill: Rgb | null, share: number): [number, number] {
  let low = 1;
  let high = 0;
  for (const colour of under) {
    const card = mix(laid, colour, amount);
    const y = luminance(fill === null ? card : mix(card, fill, share));
    low = Math.min(low, y);
    high = Math.max(high, y);
  }
  return [low, high];
}

/** The least step, in OKLab, between a card laying its solid tone over the
    calm tint and the ground it stands on, which lets the chrome's colours
    through. */
function standOff(cardUnder: Rgb[], groundUnder: Rgb[], card: Rgb, ground: Rgb, amount: number, through: number): number {
  let least = Infinity;
  for (const [at, colour] of cardUnder.entries()) {
    const [L1, a1, b1] = rgbToLab(mix(card, colour, amount));
    const [L2, a2, b2] = rgbToLab(mix(ground, groundUnder[at], through));
    least = Math.min(least, Math.hypot(L1 - L2, a1 - a2, b1 - b2));
  }
  return least;
}

/** What cards paint that let through a share of a background's calm tint,
    `dots`, with the guard's stronger text, and what reads poorly at that
    share. The share is never held back. `ground` is the chrome's colours
    where they differ from the calm tint, above FULL_TINT. */
export function cardsOf(
  colours: Record<string, string>,
  look: Look,
  dots: Lab[],
  through: number,
  grain: number,
  asked: number,
  ground: Lab[] = dots,
): PaintedCards {
  const tone = toneOf(colours);
  const grid = dots.length === 1 ? [labToRgb(dots[0])] : gridOf(field(dots), 24, 15);
  const veil = veilOf(grain);
  const under = veil > 0 ? grid.map((colour) => mix(colour, VEIL, veil)) : grid;
  const grounds = { card: hexToRgb(colours.surface), well: wellOf(colours) };
  const grey = greyOf(under);
  const amount = throughOf(asked, through);
  const laid = { card: laidOf(grounds.card, grey, amount), well: laidOf(grounds.well, grey, amount) };
  const fillOf = (name: CardPair["fill"]) => (name === null ? null : hexToRgb(colours[name]));
  const rangeOf = (pair: CardPair, at: number) =>
    cardRange(under, laidOf(grounds[pair.ground], grey, at), at, fillOf(pair.fill), pair.amount);
  const now = CARD_PAIRS.map((pair) => rangeOf(pair, amount));

  // A terminal draws its colours as they are: each that holds 4.5:1 on a
  // solid card is read again on the see-through one.
  let terminal = Infinity;
  CARD_PAIRS.forEach((pair, index) => {
    if (!pair.terminal) return;
    const solid = rangeOf(pair, 0);
    for (const token of pair.tokens) {
      if (worst(colours[token], solid) >= LEAST_CONTRAST) terminal = Math.min(terminal, worst(colours[token], now[index]));
    }
  });

  // In dark, a card that takes on the background's colour comes nearer the
  // ground, which is that colour too.
  const plainGround = look === "modern" ? deepOf(colours) : hexToRgb(colours.bg);
  const groundUnder = (() => {
    if (ground === dots) return under;
    const shown = ground.length === 1 ? grid.map(() => labToRgb(ground[0])) : gridOf(field(ground), 24, 15);
    return veil > 0 ? shown.map((colour) => mix(colour, VEIL, veil)) : shown;
  })();
  const apart = (at: number, card: Rgb) => standOff(under, groundUnder, card, plainGround, at, through);
  const plain = (() => {
    const [L1, a1, b1] = rgbToLab(grounds.card);
    const [L2, a2, b2] = rgbToLab(plainGround);
    return Math.hypot(L1 - L2, a1 - a2, b1 - b2);
  })();
  const standing = apart(amount, laid.card);
  const least = Math.min(STAND_OFF, apart(0, grounds.card)) - 1e-6;
  const poor: PaintedCards["poor"] =
    terminal < LEAST_CONTRAST ? "terminal" : tone === "dark" && amount > 0 && standing < least ? "ground" : null;

  // The app's own text is drawn a step stronger, as on the chrome, over
  // every ground and fill it is read on.
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
    poor,
    amount,
    card: rgba(laid.card, 1 - amount),
    well: rgba(laid.well, 1 - amount),
    laid,
    veil: veil > 0 ? rgba(VEIL, veil) : null,
    text,
    contrast,
    terminal,
    standOff: plain === 0 ? 1 : standing / plain,
  };
}
