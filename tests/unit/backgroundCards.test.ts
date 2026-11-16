import { describe, expect, it } from "vitest";
import {
  ANSI_TOKENS,
  FILL,
  GRAIN_SPECK,
  LEAST_CONTRAST,
  MOST_CARDS,
  READY_MADE,
  STAND_OFF,
  TERMINAL_STRENGTH,
  CARDS_REACH,
  TEXT_TOKENS,
  checkCards,
  deepOf,
  field,
  grainPixels,
  hexToRgb,
  labToRgb,
  luminance,
  mix,
  paintOf,
  ratio,
  rgbToLab,
  throughOf,
  roundedCards,
  toneOf,
  validCards,
  veilOf,
  wellOf,
  type Appearance,
  type Background,
  type Look,
  type Rgb,
} from "$lib/background";
import { DEFAULTS, readability, type CustomTheme } from "$lib/customThemes";
import { PALETTE_COLOURS, coloursOf } from "$lib/paletteColours";

/**
 * Cards that let a share of the background through: the rules the share is
 * kept by, and the guard, checked here with arithmetic of its own on a grid
 * finer than the guard's and offset from it.
 */

const background = (dots: [number, number][], rest: Partial<Background> = {}): Background => ({
  dots: dots.map(([hue, chroma]) => ({ hue, chroma })),
  harmony: dots.length === 1 ? "single" : "free",
  strength: 0.6,
  grain: 0.25,
  ...rest,
});

/** Themes of the user's own with grounds the palettes do not have: dark in
    both appearances and light in both, a grey with white text, a green
    ground, and a light theme whose surface is darker than its ground. */
const MOSS = {
  bg: "#1d2a20",
  surface: "#26362a",
  "surface-2": "#2e4033",
  rule: "#3b5040",
  "rule-strong": "#4a6350",
  ink: "#eef7ef",
  "ink-2": "#c9d8cb",
  "ink-3": "#9fb3a3",
  accent: "#9be0a8",
  add: "#8fdc9c",
  del: "#f0a3a3",
  "ansi-yellow": "#e6cf7a",
};
const SLATE = {
  bg: "#4f5459",
  surface: "#575c62",
  "surface-2": "#5f656b",
  rule: "#6b7178",
  "rule-strong": "#7a8088",
  ink: "#ffffff",
  "ink-2": "#f1f3f5",
  "ink-3": "#e3e6ea",
  accent: "#ffd166",
  add: "#b8f5c8",
  del: "#ffd0d0",
  "ansi-yellow": "#ffe08a",
};
const SUNKEN = {
  bg: "#fbfaf6",
  surface: "#efede6",
  "surface-2": "#e6e3da",
  rule: "#d8d4c8",
  "rule-strong": "#c4bfb0",
  ink: "#1b1a17",
  "ink-2": "#4b4840",
  "ink-3": "#6a665c",
  accent: "#7a4b10",
  add: "#2f5f33",
  del: "#8e2f2f",
  "ansi-yellow": "#6f5510",
};
const THEMES: Record<string, CustomTheme> = {
  night: { label: "Night", light: DEFAULTS.dark, dark: DEFAULTS.dark, shape: {} },
  paper: { label: "Paper", light: DEFAULTS.light, dark: DEFAULTS.light, shape: {} },
  slate: { label: "Slate", light: SLATE, dark: SLATE, shape: {} },
  moss: { label: "Moss", light: MOSS, dark: MOSS, shape: {} },
  sunken: { label: "Sunken", light: SUNKEN, dark: SUNKEN, shape: {} },
};

/** The owner's own background from beta 1: three hues a third of a turn
    apart. */
const HIS = [
  { hue: 185, chroma: 0.85 },
  { hue: 305, chroma: 0.85 },
  { hue: 65, chroma: 0.85 },
];

const SWEPT: [string, Appearance][] = [
  ...Object.keys(PALETTE_COLOURS).flatMap((palette) =>
    (["light", "dark"] as const).map((appearance) => [palette, appearance] as [string, Appearance]),
  ),
  ["night", "light"],
  ["paper", "dark"],
  ["slate", "light"],
  ["moss", "light"],
  ["sunken", "dark"],
];

/** The ready-made row, a dot at the rim every 45 degrees, and a few pairs
    and a triad at the rim. */
function choices(): Background[] {
  const out = READY_MADE.map((ready) => ({ dots: ready.dots, harmony: ready.harmony, strength: 1, grain: 1 }));
  for (let hue = 0; hue < 360; hue += 45) out.push(background([[hue, 1]], { grain: 1 }));
  for (const [first, second] of [
    [0, 180],
    [60, 300],
    [120, 240],
  ])
    out.push(background([[first, 1], [second, 1]], { grain: 1 }));
  out.push(background([[30, 1], [150, 1], [270, 1]], { grain: 1 }));
  return out;
}

/** The background behind a card at a fine grid of points, the grain
    blurred into its veil. */
function behind(painted: ReturnType<typeof paintOf>): Rgb[] {
  const at = field(painted.colours);
  const veil = veilOf(painted.grain);
  const out: Rgb[] = [];
  for (let i = 0; i <= 32; i++) {
    for (let j = 0; j <= 20; j++) {
      out.push(mix(labToRgb(at((i + 0.37) / 33, (j + 0.61) / 21.5)), [127.5, 127.5, 127.5], veil));
    }
  }
  return out;
}

/** A card's paint as the page lays it: a solid tone at an opacity over
    the background. */
function paint(rgba: string): { tone: Rgb; opacity: number } {
  const [r, g, b, a] = rgba.match(/[\d.]+/g)!.map(Number);
  return { tone: [r, g, b], opacity: a };
}

/** The lowest contrast of a colour over a card's paint laid over the
    background, under a fill. */
function lowest(text: string, under: Rgb[], card: { tone: Rgb; opacity: number }, fill: Rgb | null, share: number): number {
  const y = luminance(hexToRgb(text));
  let low = Infinity;
  for (const colour of under) {
    const ground = mix(colour, card.tone, card.opacity);
    const shown = fill === null ? ground : mix(ground, fill, share);
    low = Math.min(low, ratio(y, luminance(shown)));
  }
  return low;
}

/** A solid card's paint. */
const solidPaint = (tone: Rgb) => ({ tone, opacity: 1 });

function step(under: Rgb[], card: { tone: Rgb; opacity: number }, ground: Rgb, strength: number): number {
  let least = Infinity;
  for (const colour of under) {
    const [L1, a1, b1] = rgbToLab(mix(colour, card.tone, card.opacity));
    const [L2, a2, b2] = rgbToLab(mix(ground, colour, strength));
    least = Math.min(least, Math.hypot(L1 - L2, a1 - a2, b1 - b2));
  }
  return least;
}

describe("the share of the cards as the rules keep it", () => {
  it("is kept from none to a quarter, the end of the range", () => {
    expect(MOST_CARDS).toBe(0.25);
    expect(checkCards(0)).toBe(0);
    expect(checkCards(0.25)).toBe(0.25);
    for (const bad of [-0.01, 0.26, "0.1", null, Number.NaN]) expect(() => checkCards(bad)).toThrow(/from 0 to 0.25/);
  });

  it("keeps the entries of a table that pass and leaves the rest out", () => {
    expect(validCards({ teal: 0.2, rose: 0.5, amber: "x" })).toEqual({ teal: 0.2 });
    expect(validCards("teal")).toEqual({});
  });

  it("is kept in hundredths, within its range", () => {
    expect(roundedCards(0.1249)).toBe(0.12);
    expect(roundedCards(0.4)).toBe(0.25);
    expect(roundedCards(-1)).toBe(0);
  });
});

describe("cards that let nothing through", () => {
  it("paint nothing of their own, and the chrome exactly as before", () => {
    const colours = coloursOf("teal", "light");
    const plain = paintOf(background([[200, 1]]), "modern", colours);
    const none = paintOf(background([[200, 1]]), "modern", colours, 0);
    expect(plain.cards).toBeNull();
    expect(none).toEqual(plain);
  });
});

describe("the grain behind a card", () => {
  it("is the speckle blurred: a grey veil at the mean opacity of a speck", () => {
    for (const grain of [0.25, 1]) {
      const tile = grainPixels(128, grain);
      // A speck is black or white, so over any colour the blurred tile is
      // the colour mixed with mid grey at the mean opacity.
      let mean = 0;
      for (let at = 3; at < tile.length; at += 4) mean += tile[at] / 255;
      mean /= tile.length / 4;
      expect(veilOf(grain)).toBeCloseTo(mean, 2);
      expect(veilOf(grain)).toBeCloseTo((GRAIN_SPECK * grain) / 2, 6);
    }
  });

  it("is not there in the terminal look, which takes no grain", () => {
    const painted = paintOf(background([[40, 1]], { grain: 1 }), "terminal", coloursOf("teal", "light"), 0.25);
    expect(painted.cards!.veil).toBeNull();
  });
});

describe("the guard on the cards", () => {
  const all = choices();

  it("is swept over themes that are readable on their own", () => {
    for (const theme of Object.values(THEMES)) expect(readability(theme)).toBeNull();
  });

  for (const [palette, appearance] of SWEPT) {
    for (const look of ["modern", "terminal"] as Look[]) {
      it(`keeps the app's text at 4.5:1 and the terminal's colours as they held, ${palette}, ${look}, ${appearance}`, () => {
        const colours = coloursOf(palette, appearance, THEMES);
        const tone = toneOf(colours);
        const card = hexToRgb(colours.surface);
        const well = wellOf(colours);
        const solids = [solidPaint(card), solidPaint(well)];
        const ground = look === "modern" ? deepOf(colours) : hexToRgb(colours.bg);
        const ink = hexToRgb(colours.ink);
        const accent = hexToRgb(colours.accent);
        for (const choice of all) {
          for (const strength of [0.3, 1]) {
            const painted = paintOf({ ...choice, strength }, look, colours, MOST_CARDS);
            const cards = painted.cards!;
            const under = behind(painted);
            const said = `${JSON.stringify(choice.dots)} at ${strength}`;
            const paints = [paint(cards.card), paint(cards.well)];
            expect(cards.held, said).toBeLessThanOrEqual(MOST_CARDS);
            expect(cards.amount).toBeCloseTo(throughOf(cards.held, painted.strength), 9);
            expect(paints[0].opacity).toBeCloseTo(1 - cards.amount, 3);
            if (look === "terminal") expect(painted.strength).toBeLessThanOrEqual(TERMINAL_STRENGTH);

            // The app's own text, on the card and the well, bare and under a
            // hovered or chosen row, a field and your message.
            for (const token of TEXT_TOKENS) {
              const drawn = cards.text[token];
              for (const ground of paints) {
                for (const [fill, share] of [
                  [null, 0],
                  [ink, FILL.ink],
                  [accent, FILL.accent],
                ] as [Rgb | null, number][]) {
                  const low = lowest(drawn, under, ground, fill, share);
                  if (cards.amount > 0 && low < LEAST_CONTRAST) {
                    throw new Error(`${token} at ${low.toFixed(3)}:1 on a card, ${said}`);
                  }
                }
              }
              // Drawn stronger only the way the chrome leans.
              const own = luminance(hexToRgb(colours[token]));
              const now = luminance(hexToRgb(drawn));
              if (tone === "light" ? now > own + 1e-9 : now < own - 1e-9) {
                throw new Error(`${token} turned the other way, ${said}`);
              }
            }

            // Each terminal colour that holds 4.5:1 on a solid card holds it
            // on this one; the terminal draws them as they are.
            for (const token of ["ink", ...ANSI_TOKENS]) {
              for (const at of [0, 1]) {
                if (lowest(colours[token], under, solids[at], null, 0) < LEAST_CONTRAST) continue;
                const low = lowest(colours[token], under, paints[at], null, 0);
                if (low < LEAST_CONTRAST - 0.02) throw new Error(`${token} at ${low.toFixed(3)}:1 in a terminal, ${said}`);
              }
            }

            // In dark, cards keep standing off the ground.
            if (tone === "dark") {
              const solid = step(under, solids[0], ground, painted.strength);
              const now = step(under, paints[0], ground, painted.strength);
              if (now < Math.min(STAND_OFF, solid) - 0.001) {
                throw new Error(`cards stand off by ${now.toFixed(4)}, ${said}`);
              }
            }

            // Where it holds back, a hundredth more would not do, and a
            // smaller share asked is let through whole.
            if (cards.held < MOST_CARDS) {
              const less = Math.round(cards.held * 50) / 100;
              if (less > 0) expect(paintOf({ ...choice, strength }, look, colours, less).cards!.held, said).toBe(less);
              expect(cards.heldBy, said).not.toBeNull();
              const more = paintOf({ ...choice, strength }, look, colours, cards.held + 0.01).cards!;
              expect(more.held, said).toBe(cards.held);
            } else {
              expect(cards.heldBy).toBeNull();
            }
          }
        }
      });
    }
  }

  it("lets the whole range through in dark, and in light holds back only for a terminal colour", () => {
    for (const [palette, appearance] of SWEPT.slice(0, 10)) {
      for (const ready of READY_MADE) {
        for (const look of ["modern", "terminal"] as Look[]) {
          const cards = paintOf(
            { dots: ready.dots, harmony: ready.harmony, strength: 0.6, grain: 0.25 },
            look,
            coloursOf(palette, appearance),
            MOST_CARDS,
          ).cards!;
          const said = `${palette}, ${appearance}, ${ready.name}, ${look}`;
          if (appearance === "dark") expect(cards.held, said).toBe(MOST_CARDS);
          else if (cards.held < MOST_CARDS) {
            expect(cards.heldBy, said).toBe("terminal");
            // Even held, a card shows a good part of what the ground does.
            expect(cards.amount / 0.6, said).toBeGreaterThanOrEqual(0.4 * CARDS_REACH);
          }
        }
      }
    }
  });

  it("holds the share where a terminal colour would fall under 4.5:1, and says so", () => {
    const painted = paintOf(
      { dots: HIS, harmony: "triad", strength: 1, grain: 0.25 },
      "modern",
      coloursOf("mono", "light"),
      MOST_CARDS,
    );
    expect(painted.cards!.held).toBeLessThan(MOST_CARDS);
    expect(painted.cards!.heldBy).toBe("terminal");
    expect(painted.cards!.terminal).toBeGreaterThanOrEqual(LEAST_CONTRAST);
  });

  it("holds the share in dark where cards would melt into the ground, and says so", () => {
    // At full strength the end of the range would leave the card clear, the
    // ground itself.
    const painted = paintOf(background([[250, 0.3]], { strength: 1 }), "modern", coloursOf("teal", "dark"), MOST_CARDS);
    expect(painted.cards!.heldBy).toBe("ground");
    expect(painted.cards!.held).toBeLessThan(MOST_CARDS);
    expect(painted.cards!.held).toBeGreaterThan(MOST_CARDS * 0.9);
  });

  it("keeps a card's own lightness in dark, taking only the background's colour", () => {
    const colours = coloursOf("rose", "dark");
    const choice = { dots: HIS, harmony: "triad" as const, strength: 0.75, grain: 0.25 };
    const painted = paintOf(choice, "modern", colours, MOST_CARDS);
    const card = paint(painted.cards!.card);
    const solid = rgbToLab(hexToRgb(colours.surface));
    for (const colour of behind(painted)) {
      const shown = rgbToLab(mix(colour, card.tone, card.opacity));
      expect(Math.abs(shown[0] - solid[0])).toBeLessThan(0.02);
    }
  });

  it("shows more of the background at every step of the range, enough to see", () => {
    const choice = { dots: HIS, harmony: "triad" as const, strength: 0.75, grain: 0.25 };
    for (const appearance of ["light", "dark"] as const) {
      const colours = coloursOf("rose", appearance);
      const solid = rgbToLab(hexToRgb(colours.surface));
      // How far the card strays from a solid one at its most coloured point.
      const heldAt = paintOf(choice, "modern", colours, MOST_CARDS).cards!.held;
      const away = (share: number) => {
        const painted = paintOf(choice, "modern", colours, share);
        const card = paint(painted.cards!.card);
        return Math.max(
          ...behind(painted).map((colour) => {
            const shown = rgbToLab(mix(colour, card.tone, card.opacity));
            return Math.hypot(shown[0] - solid[0], shown[1] - solid[1], shown[2] - solid[2]);
          }),
        );
      };
      let before = 0;
      for (const share of [0.05, 0.1, 0.15, 0.2, 0.25].filter((share) => share <= heldAt)) {
        const now = away(share);
        expect(now, `${appearance} at ${share}`).toBeGreaterThan(before + 0.004);
        before = now;
      }
      // A quarter of the range already shows; the end is plainly see-through.
      expect(away(0.0625), appearance).toBeGreaterThan(0.008);
      expect(away(MOST_CARDS), appearance).toBeGreaterThan(0.03);
    }
  });

  it("draws quiet text on a card a step stronger as soon as any shows, as on the chrome", () => {
    const colours = coloursOf("teal", "light");
    const painted = paintOf(background([[192, 0.9], [252, 0.8]]), "modern", colours, 0.05);
    expect(painted.cards!.amount).toBeGreaterThan(0);
    expect(luminance(hexToRgb(painted.cards!.text["ink-3"]))).toBeLessThan(luminance(hexToRgb(colours["ink-3"])));
    expect(painted.cards!.text.ink).toBe(colours.ink);
  });

  it("widens the lines' one amount to stand off a see-through card too", () => {
    const colours = coloursOf("teal", "light");
    const choice = background([[192, 0.9], [252, 0.8]], { strength: 1 });
    const solid = paintOf(choice, "modern", colours);
    const through = paintOf(choice, "modern", colours, MOST_CARDS);
    const alpha = (rgba: string) => Number(/, ([\d.]+)\)$/.exec(rgba)![1]);
    expect(alpha(through.line)).toBeGreaterThanOrEqual(alpha(solid.line));
  });
});
