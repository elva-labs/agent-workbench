import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BAND,
  CALM,
  FIRST,
  FULL_TINT,
  GRAIN_SPECK,
  HARMONIES,
  LEAST_CONTRAST,
  PAD,
  READY_MADE,
  SLIDER,
  TEXT_TOKENS,
  addDot,
  checkBackground,
  describeBackground,
  dotColour,
  field,
  gradientPixels,
  grainPixels,
  deepOf,
  groundsOf,
  hexToRgb,
  labToRgb,
  lowestText,
  luminance,
  mix,
  moveDot,
  padColour,
  padLightness,
  paintOf,
  positionOf,
  ratio,
  readyMadeOf,
  removeDot,
  rgbToLab,
  rounded,
  sameBackground,
  strengthAt,
  strengthPercent,
  throughAt,
  toneOf,
  validBackgrounds,
  vividAt,
  withHarmony,
  type Appearance,
  type Background,
  type Look,
  type Rgb,
} from "$lib/background";
import { DEFAULTS, readability, type CustomTheme } from "$lib/customThemes";
import { PALETTE_COLOURS, coloursOf } from "$lib/paletteColours";

/** Themes of the user's own that the appearance's name does not describe:
    dark in both appearances, light in both, and two grey ones with text of
    either kind. */
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
const PEWTER = {
  bg: "#a9aeb3",
  surface: "#b4b9be",
  "surface-2": "#a0a5aa",
  rule: "#999ea3",
  "rule-strong": "#8a8f94",
  ink: "#000000",
  "ink-2": "#15181b",
  "ink-3": "#24282c",
  accent: "#0f2f5c",
  add: "#0f3a1c",
  del: "#4a0f18",
  "ansi-yellow": "#3a2c00",
};
const THEMES: Record<string, CustomTheme> = {
  night: { label: "Night", light: DEFAULTS.dark, dark: DEFAULTS.dark, shape: {} },
  paper: { label: "Paper", light: DEFAULTS.light, dark: DEFAULTS.light, shape: {} },
  slate: { label: "Slate", light: SLATE, dark: SLATE, shape: {} },
  pewter: { label: "Pewter", light: PEWTER, dark: PEWTER, shape: {} },
};

const background = (dots: [number, number][], rest: Partial<Background> = {}): Background => ({
  dots: dots.map(([hue, chroma]) => ({ hue, chroma })),
  harmony: dots.length === 1 ? "single" : "free",
  strength: 0.6,
  grain: 0.25,
  ...rest,
});

describe("a background as the rules keep it", () => {
  it("takes dots, a harmony, a strength and grain", () => {
    const taken = checkBackground({
      dots: [{ hue: 192, chroma: 0.9 }, { hue: 252, chroma: 0.8 }],
      harmony: "free",
      strength: 0.4,
      grain: 0,
    });
    expect(taken).toEqual({
      dots: [{ hue: 192, chroma: 0.9 }, { hue: 252, chroma: 0.8 }],
      harmony: "free",
      strength: 0.4,
      grain: 0,
    });
  });

  it("starts a harmony free and the strength and grain where a new one starts", () => {
    expect(checkBackground({ dots: [{ hue: 10, chroma: 1 }] })).toEqual({
      dots: [{ hue: 10, chroma: 1 }],
      harmony: "free",
      strength: FIRST.strength,
      grain: FIRST.grain,
    });
  });

  it("refuses what it is not, saying why", () => {
    const why = (value: unknown) => {
      try {
        checkBackground(value);
      } catch (error) {
        return (error as Error).message;
      }
      return "taken";
    };
    expect(why("blue")).toMatch(/table of dots/);
    expect(why({ dots: [{ hue: 1, chroma: 1 }], colour: "#fff" })).toMatch(/not colour/);
    expect(why({ dots: [] })).toMatch(/one to 3 dots/);
    expect(why({ dots: [1, 2, 3, 4].map((hue) => ({ hue, chroma: 1 })) })).toMatch(/one to 3 dots/);
    expect(why({ dots: [{ hue: 360, chroma: 1 }] })).toMatch(/hue from 0 up to 360/);
    expect(why({ dots: [{ hue: 20, chroma: 1.2 }] })).toMatch(/chroma from 0 to 1/);
    expect(why({ dots: [{ hue: 20, chroma: 1, lightness: 2 }] })).toMatch(/chroma from 0 to 1/);
    expect(why({ dots: [{ hue: 20, chroma: 1 }], harmony: "tetrad" })).toMatch(/harmony is one of/);
    expect(why({ dots: [{ hue: 20, chroma: 1 }], harmony: "triad" })).toMatch(/triad harmony holds 3 dots/);
    expect(why({ dots: [{ hue: 20, chroma: 1 }], strength: 0 })).toMatch(/strength is from 0.1 to 1/);
    expect(why({ dots: [{ hue: 20, chroma: 1 }], grain: 2 })).toMatch(/grain is from 0 to 1/);
  });

  it("keeps the entries of a table that pass and leaves the rest out", () => {
    expect(
      Object.keys(
        validBackgrounds({
          teal: { dots: [{ hue: 1, chroma: 1 }] },
          rose: { dots: "pink" },
        }),
      ),
    ).toEqual(["teal"]);
    expect(validBackgrounds(null)).toEqual({});
    expect(validBackgrounds([1])).toEqual({});
  });

  it("is kept in whole degrees, thousandths for the strength and hundredths for the rest", () => {
    const kept = rounded(background([[359.7, 0.333]], { strength: 0.5555, grain: 0.004 }));
    expect(kept).toEqual({ dots: [{ hue: 0, chroma: 0.33 }], harmony: "single", strength: 0.556, grain: 0 });
    expect(sameBackground(background([[10.2, 0.5]]), background([[10, 0.501]]))).toBe(true);
    expect(sameBackground(background([[10, 0.5]]), null)).toBe(false);
  });

  it("knows a ready-made by its colours, whatever its strength and grain", () => {
    const lagoon = READY_MADE.find((ready) => ready.name === "lagoon")!;
    const own = { dots: lagoon.dots, harmony: lagoon.harmony, strength: 0.3, grain: 0 };
    expect(readyMadeOf(own)).toBe("lagoon");
    expect(readyMadeOf(moveDot(own, 1, { hue: 10, chroma: 0.8 }))).toBeNull();
    // The strength in words is where the slider shows it.
    expect(describeBackground(own)).toBe("Lagoon, strength 5%, grain 0%");
    expect(describeBackground(background([[10, 0.4], [40, 1]]))).toBe("2 colours, strength 10%, grain 25%");
    expect(describeBackground({ ...own, strength: 1 })).toBe("Lagoon, strength 100%, grain 0%");
    expect(describeBackground(null)).toBe("None");
  });
});

describe("moving the dots", () => {
  it("spreads a harmony from the first dot", () => {
    const one = background([[350, 0.7]]);
    expect(withHarmony(one, "complementary").dots).toEqual([
      { hue: 350, chroma: 0.7 },
      { hue: 170, chroma: 0.7 },
    ]);
    expect(withHarmony(one, "analogous").dots.map((dot) => dot.hue)).toEqual([350, 40, 300]);
    expect(withHarmony(one, "triad").dots.map((dot) => dot.hue)).toEqual([350, 110, 230]);
  });

  it("carries the others with the first while a harmony holds, and frees it when another moves", () => {
    const triad = withHarmony(background([[0, 1]]), "triad");
    const turned = moveDot(triad, 0, { hue: 30, chroma: 0.5 });
    expect(turned.harmony).toBe("triad");
    expect(turned.dots).toEqual([
      { hue: 30, chroma: 0.5 },
      { hue: 150, chroma: 0.5 },
      { hue: 270, chroma: 0.5 },
    ]);
    const freed = moveDot(turned, 2, { hue: 300, chroma: 1.4 });
    expect(freed.harmony).toBe("free");
    expect(freed.dots[2]).toEqual({ hue: 300, chroma: 1 });
    expect(freed.dots[0]).toEqual({ hue: 30, chroma: 0.5 });
  });

  it("carries a kept background's own turns with the first, never re-placing them", () => {
    // Kept with the closer turns analogous once had.
    const kept = background([[140, 0.8], [180, 0.8], [100, 0.8]], { harmony: "analogous" });
    const turned = moveDot(kept, 0, { hue: 150, chroma: 0.6 });
    expect(turned.harmony).toBe("analogous");
    expect(turned.dots).toEqual([
      { hue: 150, chroma: 0.6 },
      { hue: 190, chroma: 0.6 },
      { hue: 110, chroma: 0.6 },
    ]);
    // Painting it is painting the dots as they are kept.
    const colours = coloursOf("teal", "dark");
    expect(paintOf(kept, "modern", colours)).toEqual(paintOf({ ...kept, harmony: "free" }, "modern", colours));
  });

  it("adds a dot up to three, and takes the last one away with the background", () => {
    const one = background([[100, 0.6]]);
    const two = addDot(one);
    expect(two.harmony).toBe("complementary");
    // A third makes three close colours around the first, never three
    // spread round the wheel.
    const three = addDot(two);
    expect(three.harmony).toBe("analogous");
    expect(three.dots.map((dot) => dot.hue)).toEqual([100, 150, 50]);
    expect(three.dots.every((dot) => dot.chroma === 0.6)).toBe(true);
    expect(addDot(three)).toBe(three);
    // A free pair keeps both and gains one close to the first, away from
    // the second.
    const freePair = background([[0, 0.5], [90, 1]]);
    const added = addDot(freePair);
    expect(added.harmony).toBe("free");
    expect(added.dots.slice(0, 2)).toEqual(freePair.dots);
    expect(added.dots[2]).toEqual({ hue: 310, chroma: 0.5 });
    expect(addDot(background([[0, 0.5], [300, 1]])).dots[2]).toEqual({ hue: 50, chroma: 0.5 });

    const fewer = removeDot(three, 1)!;
    expect(fewer.dots.map((dot) => dot.hue)).toEqual([100, 50]);
    expect(fewer.harmony).toBe("free");
    expect(removeDot(fewer, 0)!.harmony).toBe("single");
    expect(removeDot(one, 0)).toBeNull();
  });
});

describe("the Strength slider", () => {
  it("runs from the least strength kept to the colours themselves, each place one strength and back", () => {
    expect(positionOf(0)).toBe(0);
    expect(positionOf(1)).toBe(1);
    expect(strengthAt(0)).toBe(0.1);
    expect(strengthAt(1)).toBe(1);
    for (let place = strengthPercent(0.1); place <= 100; place++) {
      // A strength kept in thousandths shows at the place it was set from.
      const kept = Math.round(strengthAt(place / 100) * 1000) / 1000;
      expect(strengthPercent(kept), `${place}%`).toBe(place);
    }
    for (let at = 1; at < SLIDER.length; at++) {
      expect(SLIDER[at][0]).toBeGreaterThan(SLIDER[at - 1][0]);
      expect(SLIDER[at][1]).toBeGreaterThan(SLIDER[at - 1][1]);
    }
  });

  it("shows a background kept before at the place its picture now sits", () => {
    const shown = (strength: number) => strengthPercent(strength);
    expect([0.1, 0.25, 0.5, 0.6, 0.75, 0.8, 0.85, 0.9, 0.95, 1].map(shown)).toEqual([2, 4, 8, 10, 16, 33, 50, 66, 83, 100]);
  });

  /** How far the window's ground has come on its way from no background,
      at each of N + 1 strengths, as a share of the whole way: measured in
      OKLab, over every hue at the rim, on one chrome. */
  function travelled(tone: Appearance, N: number): number[] {
    const ground = deepOf(coloursOf("teal", tone));
    const sums = new Array<number>(N + 1).fill(0);
    for (let hue = 0; hue < 360; hue += 30) {
      const at = (strength: number) =>
        rgbToLab(mix(ground, labToRgb(dotColour({ hue, chroma: 0.9 }, tone, strength)), throughAt(strength)));
      let before = at(0);
      for (let i = 1; i <= N; i++) {
        const now = at(i / N);
        sums[i] += Math.hypot(now[0] - before[0], now[1] - before[1], now[2] - before[2]);
        before = now;
      }
    }
    for (let i = 1; i <= N; i++) sums[i] += sums[i - 1];
    return sums.map((sum) => sum / sums[N]);
  }

  it("changes the picture by about as much at every step, light and dark taken together, with no dead stretch and no jump", () => {
    const N = 1000;
    const ways = { light: travelled("light", N), dark: travelled("dark", N) };
    const read = (way: number[], strength: number) => way[Math.round(strength * N)];
    for (let place = 0.1; place <= 1.0001; place += 0.1) {
      // The slider's first tenth starts from no background at all.
      const [from, to] = [place < 0.15 ? 0 : strengthAt(place - 0.1), strengthAt(place)];
      const light = read(ways.light, to) - read(ways.light, from);
      const dark = read(ways.dark, to) - read(ways.dark, from);
      const said = `from ${Math.round((place - 0.1) * 100)}% to ${Math.round(place * 100)}%`;
      // A tenth of the slider is about a tenth of the way, on the average.
      expect((light + dark) / 2, said).toBeGreaterThan(0.085);
      expect((light + dark) / 2, said).toBeLessThan(0.115);
      // On either chrome it is never under half nor over half again as much.
      for (const [tone, step] of [["light", light], ["dark", dark]] as const) {
        expect(step, `${tone} ${said}`).toBeGreaterThan(0.05);
        expect(step, `${tone} ${said}`).toBeLessThan(0.15);
      }
    }
  });
});

describe("the ready-made backgrounds", () => {
  it("hold colours that belong together: none spread wider than a third of a turn from the first", () => {
    for (const ready of READY_MADE) {
      for (const dot of ready.dots.slice(1)) {
        const apart = Math.abs(((dot.hue - ready.dots[0].hue + 540) % 360) - 180);
        expect(apart, ready.name).toBeLessThanOrEqual(70);
      }
    }
  });

  it("never grey out on the way from one colour to the next", () => {
    for (const tone of ["light", "dark"] as const) {
      for (const ready of READY_MADE) {
        if (ready.dots.length === 1) continue;
        const colours = ready.dots.map((dot) => dotColour(dot, tone));
        const chroma = (lab: number[]) => Math.hypot(lab[1], lab[2]);
        const least = Math.min(...colours.map(chroma));
        const at = field(colours);
        // Along the window, the middle as much as the ends.
        for (let step = 0; step <= 20; step++) {
          const lab = at(step / 20, step / 20);
          expect(chroma(lab), `${ready.name} in ${tone} at ${step / 20}`).toBeGreaterThanOrEqual(least * 0.9);
          expect(lab[0]).toBeCloseTo(colours[0][0], 6);
        }
      }
    }
  });
});

describe("the colours a background paints", () => {
  it("are as light as a light or a dark chrome says wherever the dot is, and a tint at the rim", () => {
    for (const tone of ["light", "dark"] as Appearance[]) {
      for (let hue = 0; hue < 360; hue += 15) {
        for (const chroma of [0, 0.5, 1]) {
          const [L, a, b] = dotColour({ hue, chroma }, tone);
          expect(L).toBeCloseTo(BAND[tone].lightness, 6);
          expect(Math.hypot(a, b)).toBeLessThanOrEqual(BAND[tone].chroma * chroma + 1e-9);
        }
      }
    }
  });

  it("paint a background as they always have up to CALM: the calm tint let through by the strength", () => {
    const colours = coloursOf("rose", "dark");
    for (const strength of [0.1, 0.25, 0.5, CALM]) {
      expect(throughAt(strength)).toBe(strength);
      expect(vividAt(strength)).toBe(0);
      const painted = paintOf(background([[350, 0.9], [40, 0.9], [300, 0.9]], { strength }), "modern", colours);
      painted.colours.forEach((lab, at) => {
        expect(lab).toEqual(dotColour(painted.colours.length === 3 ? [{ hue: 350, chroma: 0.9 }, { hue: 40, chroma: 0.9 }, { hue: 300, chroma: 0.9 }][at] : { hue: 0, chroma: 0 }, "dark"));
      });
      expect(painted.grounds.side).toMatch(new RegExp(`, ${(1 - strength).toFixed(3)}\\)$`));
    }
  });

  it("show the calm tint whole by FULL_TINT and rise to the pad's colours at the top", () => {
    expect(throughAt(FULL_TINT)).toBe(1);
    expect(throughAt(1)).toBe(1);
    expect(vividAt(FULL_TINT)).toBe(0);
    expect(vividAt(1)).toBe(1);
    for (const tone of ["light", "dark"] as Appearance[]) {
      for (let hue = 0; hue < 360; hue += 30) {
        const dot = { hue, chroma: 0.9 };
        expect(dotColour(dot, tone, FULL_TINT)).toEqual(dotColour(dot, tone));
        expect(labToRgb(dotColour(dot, tone, 1)).map(Math.round)).toEqual(hexToRgb(padColour(dot, tone)));
        expect(dotColour(dot, tone, 1)[0]).toBeCloseTo(padLightness(hue, tone), 6);
        // On the way the lightness moves steadily from the one to the other.
        let before = BAND[tone].lightness;
        for (const strength of [0.8, 0.85, 0.9, 0.95, 1]) {
          const now = dotColour(dot, tone, strength)[0];
          expect(tone === "dark" ? now > before : now < before).toBe(true);
          before = now;
        }
      }
    }
  });

  it("rise to as light as each hue is fullest, so yellows and limes read clean, within the pad's floor and cap", () => {
    for (const tone of ["light", "dark"] as Appearance[]) {
      const { lightness, most } = PAD[tone];
      let before = padLightness(0, tone);
      for (let hue = 0; hue <= 360; hue += 1) {
        const now = padLightness(hue, tone);
        expect(now).toBeGreaterThanOrEqual(lightness);
        expect(now).toBeLessThanOrEqual(most);
        // It follows the hue smoothly round the wheel.
        expect(Math.abs(now - before)).toBeLessThan(0.02);
        before = now;
      }
      // Pinks, reds, blues and violets sit at the floor; yellows and limes
      // are lifted to where they are fullest, which at the floor they are
      // far from.
      for (const hue of [355, 20, 260, 305]) expect(padLightness(hue, tone)).toBe(lightness);
      for (const hue of [100, 112, 125]) expect(padLightness(hue, tone)).toBeGreaterThan(lightness + 0.05);
    }
    // In dark the Zen pick's lime is light enough to read as lime: as much
    // green as red, and well over half of each.
    const lime = labToRgb(dotColour({ hue: 112, chroma: 1 }, "dark", 1));
    expect(lime[1]).toBeGreaterThan(200);
    expect(lime[0]).toBeGreaterThan(190);
  });

  it("take the band of the chrome they lie on, whatever the appearance is called", () => {
    for (const palette of Object.keys(PALETTE_COLOURS)) {
      expect(toneOf(coloursOf(palette, "light"))).toBe("light");
      expect(toneOf(coloursOf(palette, "dark"))).toBe("dark");
    }
    expect(toneOf(coloursOf("night", "light", THEMES))).toBe("dark");
    expect(toneOf(coloursOf("paper", "dark", THEMES))).toBe("light");
    expect(toneOf(coloursOf("slate", "light", THEMES))).toBe("dark");
    expect(toneOf(coloursOf("pewter", "dark", THEMES))).toBe("light");
    const night = paintOf(background([[200, 1]]), "modern", coloursOf("night", "light", THEMES));
    expect(night.colours[0][0]).toBeCloseTo(BAND.dark.lightness, 6);
  });

  it("run as a gradient between two colours and glow a third from the top right", () => {
    const colours = [rgbToLab([200, 220, 240]), rgbToLab([240, 210, 200]), rgbToLab([210, 240, 200])];
    const two = field(colours.slice(0, 2));
    const near = (a: Rgb, b: Rgb) => a.forEach((value, at) => expect(value).toBeCloseTo(b[at], 0));
    near(labToRgb(two(0, 0)), [200, 220, 240]);
    near(labToRgb(two(1, 1)), [240, 210, 200]);
    const three = field(colours);
    const glow = labToRgb(three(0.94, 0));
    expect(Math.abs(glow[1] - 240)).toBeLessThan(Math.abs(labToRgb(two(0.94, 0))[1] - 240));
    near(labToRgb(field(colours.slice(0, 1))(0.5, 0.5)), [200, 220, 240]);
  });

  it("draws each pixel of the gradient within a step of its colour, the dither even on the whole", () => {
    const steepest: Background["dots"][] = [
      // Opposite hues at the rim, and three spread evenly round it.
      [{ hue: 300, chroma: 1 }, { hue: 120, chroma: 1 }],
      [{ hue: 0, chroma: 1 }, { hue: 120, chroma: 1 }, { hue: 240, chroma: 1 }],
    ];
    const sets = [...READY_MADE.map((ready) => ready.dots), ...steepest].filter((dots) => dots.length > 1);
    const [width, height] = [96, 60];
    for (const tone of ["light", "dark"] as const) {
      for (const dots of sets) {
        const colours = dots.map((dot) => dotColour(dot, tone));
        const pixels = gradientPixels(colours, width, height);
        const colourAt = field(colours);
        let worst = 0;
        let sum = 0;
        let counted = 0;
        // A pixel stands for its colour if it is within reach of the colour
        // at its centre or at an edge of it: with a third colour glowing,
        // the colour jumps where the glow's shortest turn of hue goes the
        // other way round, and a pixel there may take either side.
        const half = [0.5 / (width - 1), 0.5 / (height - 1)];
        const around = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]];
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const [u, v] = [x / (width - 1), y / (height - 1)];
            const drawn = [0, 1, 2].map((channel) => pixels[(y * width + x) * 4 + channel]);
            const offs = around.map(([dx, dy]) => {
              const exact = labToRgb(colourAt(u + dx * half[0], v + dy * half[1]));
              return exact.map((value, channel) =>
                // A channel at either end is clamped there, which no
                // dither can even out.
                value < 1 || value > 254 ? null : drawn[channel] - value,
              );
            });
            const nearest = offs.reduce((best, off) =>
              Math.max(...off.map((value) => Math.abs(value ?? 0))) <
              Math.max(...best.map((value) => Math.abs(value ?? 0)))
                ? off
                : best,
            );
            for (const off of nearest) {
              if (off === null) continue;
              worst = Math.max(worst, Math.abs(off));
              sum += off;
              counted++;
            }
          }
        }
        const name = `${tone} ${dots.map((dot) => dot.hue).join(", ")}`;
        // Half a step of rounding and half of dither, and a tenth for the
        // nearest place along the run and the strengths of the glow.
        expect(worst, name).toBeLessThan(1.1);
        expect(Math.abs(sum / counted), name).toBeLessThan(0.05);
      }
    }
  });

  it("draws the gradient and the grain the same way each time, the grain no stronger than its speck", () => {
    const colours = [dotColour({ hue: 192, chroma: 0.9 }, "light"), dotColour({ hue: 252, chroma: 0.8 }, "light")];
    expect(gradientPixels(colours, 8, 5)).toEqual(gradientPixels(colours, 8, 5));
    const tile = grainPixels(32, 0.5);
    let strongest = 0;
    for (let at = 3; at < tile.length; at += 4) strongest = Math.max(strongest, tile[at]);
    expect(strongest).toBeGreaterThan(0);
    expect(strongest).toBeLessThanOrEqual(Math.round(GRAIN_SPECK * 0.5 * 255));
  });
});

/* -------------------------------------------------------------------- */
/* The guard across the whole pad.                                       */
/* -------------------------------------------------------------------- */

const PALETTES = Object.keys(PALETTE_COLOURS);
const LOOKS: Look[] = ["modern", "terminal"];
const APPEARANCES: Appearance[] = ["light", "dark"];

/** Every kind of choice the pad allows, at its strongest: a single dot at
    every hue from the centre to the rim, every pair and every harmony at
    the rim, and the ready-made row. */
function everyChoice(): Background[] {
  const choices: Background[] = [];
  for (let hue = 0; hue < 360; hue += 15) {
    for (const chroma of [0.5, 1]) choices.push(background([[hue, chroma]], { grain: 1 }));
  }
  for (let first = 0; first < 360; first += 45) {
    for (let second = first + 45; second < 360; second += 45) {
      choices.push(background([[first, 1], [second, 1]], { grain: 1 }));
    }
  }
  for (let hue = 0; hue < 360; hue += 30) {
    for (const harmony of HARMONIES.filter((known) => known.offsets.length === 3)) {
      choices.push(withHarmony(background([[hue, 1]], { grain: 1 }), harmony.name));
    }
  }
  for (const ready of READY_MADE) choices.push({ dots: ready.dots, harmony: ready.harmony, strength: 1, grain: 1 });
  return choices;
}

/** What a tinted part shows at (u, v), with a speck of grain darkening it
    (-1), lightening it (1) or not there (0): worked out here apart from the
    guard, the way the stylesheets lay the layers. */
function shown(painted: ReturnType<typeof paintOf>, ground: Rgb, u: number, v: number, speck: number): Rgb {
  const colour = labToRgb(field(painted.colours)(u, v));
  const alpha = painted.grain * GRAIN_SPECK;
  const specked =
    speck === 0
      ? colour
      : speck < 0
        ? (colour.map((value) => value * (1 - alpha)) as Rgb)
        : (colour.map((value) => value + (255 - value) * alpha) as Rgb);
  return mix(ground, specked, painted.through);
}

/** A paint the stylesheets lay as rgba(), as a colour and an opacity. */
function rgbaOf(css: string): [Rgb, number] {
  const [r, g, b, a] = css.match(/[\d.]+/g)!.map(Number);
  return [[r, g, b], a];
}

/** Relative luminance as WCAG reckons it, worked out here apart from the
    guard's own. */
const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const wcag = (r: number, g: number, b: number) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** The background's colours over a grid finer than the guard's own and
    offset from it, so a worst point between its samples is found. Worked
    out once for each set of colours and read at every strength; a colour
    met at many points, as a single dot's is at all of them, is read once. */
const fineGrids = new Map<string, Rgb[]>();

function fineGrid(colours: ReturnType<typeof paintOf>["colours"]): Rgb[] {
  const key = colours.map((lab) => lab.join(",")).join("|");
  let points = fineGrids.get(key);
  if (points === undefined) {
    const at = field(colours);
    const found = new Map<string, Rgb>();
    for (let i = 0; i <= 32; i++) {
      for (let j = 0; j <= 20; j++) {
        const point = labToRgb(at((i + 0.37) / 33, (j + 0.61) / 21.5));
        found.set(point.join(","), point);
      }
    }
    points = [...found.values()];
    fineGrids.set(key, points);
  }
  return points;
}

/** The lowest contrast of each text over the fine grid: on the tint, on a
    hovered row's fill and on a chosen row's, with grain at its strongest
    speck either way. A dark speck lowers every channel and a light one
    raises it, and the tint, a fill and luminance all rise with every
    channel, so a point is at its darkest under its dark speck and its
    lightest under its light one; with `everySpeck` all three are read,
    which a test below holds to the same answer. */
function lowestContrast(
  painted: ReturnType<typeof paintOf>,
  grounds: Rgb[],
  colours: Record<string, string>,
  everySpeck = false,
) {
  const low: Record<string, number> = {};
  const texts = TEXT_TOKENS.map((token) => [token, luminance(hexToRgb(painted.text[token]))] as const);
  void colours;
  // The fills a hovered and a chosen row lay, as the stylesheets have them.
  const fills: [Rgb, number][] = [rgbaOf(painted.fill), rgbaOf(painted.fillAccent)];
  const alpha = painted.grain * GRAIN_SPECK;
  const strength = painted.through;
  let darkest = 1;
  let lightest = 0;
  // The layers over one point, in plain numbers: this runs some millions
  // of times across the sweep.
  const read = (ground: Rgb, [r, g, b]: Rgb, dark: boolean, light: boolean) => {
    const R = ground[0] + (r - ground[0]) * strength;
    const G = ground[1] + (g - ground[1]) * strength;
    const B = ground[2] + (b - ground[2]) * strength;
    const take = (y: number) => {
      if (dark && y < darkest) darkest = y;
      if (light && y > lightest) lightest = y;
    };
    take(wcag(R, G, B));
    for (const [[fr, fg, fb], amount] of fills) {
      take(wcag(R + (fr - R) * amount, G + (fg - G) * amount, B + (fb - B) * amount));
    }
  };
  // Parts on the same ground are read once.
  for (const ground of new Map(grounds.map((ground) => [ground.join(","), ground])).values()) {
    for (const [r, g, b] of fineGrid(painted.colours)) {
      const keep = 1 - alpha;
      read(ground, [r * keep, g * keep, b * keep], true, everySpeck);
      read(ground, [r + (255 - r) * alpha, g + (255 - g) * alpha, b + (255 - b) * alpha], everySpeck, true);
      if (everySpeck) read(ground, [r, g, b], true, true);
    }
  }
  for (const [token, text] of texts) {
    low[token] = text > darkest && text < lightest ? 1 : Math.min(ratio(text, darkest), ratio(text, lightest));
  }
  return low;
}

/** What the guard is swept over: every palette in each appearance, and
    each theme in the appearance its name does not describe. */
const SWEPT: [string, Appearance][] = [
  ...PALETTES.flatMap((palette) => APPEARANCES.map((appearance) => [palette, appearance] as [string, Appearance])),
  ["night", "light"],
  ["paper", "dark"],
  ["slate", "light"],
  ["pewter", "dark"],
];

describe("the guard", () => {
  const choices = everyChoice();

  it("is swept over themes that are readable on their own", () => {
    for (const theme of Object.values(THEMES)) expect(readability(theme)).toBeNull();
  });

  /** The grounds text sits on in a look. */
  const textGrounds = (colours: Record<string, string>, look: Look) => {
    const grounds = groundsOf(colours, look);
    return look === "modern" ? [grounds.side!, grounds.surf!, grounds.status!] : [grounds.status!];
  };

  for (const [palette, appearance] of SWEPT) {
    for (const look of LOOKS) {
      for (const strength of [0.1, 0.3, FULL_TINT]) {
        it(`keeps every text at 4.5:1 or more, the way it already leans, ${palette}, ${look}, ${appearance}, at ${strength * 100}%`, () => {
          const colours = coloursOf(palette, appearance, THEMES);
          const texts = textGrounds(colours, look);
          // Text lighter than its chrome only ever gets lighter, and darker
          // text darker, so a light glyph on an accent stays readable too.
          const ground = (luminance(hexToRgb(colours.bg)) + luminance(hexToRgb(colours.surface))) / 2;
          const lighter = luminance(hexToRgb(colours.ink)) > ground;
          for (const choice of choices) {
            const painted = paintOf({ ...choice, strength }, look, colours);
            const low = lowestContrast(painted, texts, colours);
            for (const token of TEXT_TOKENS) {
              const own = luminance(hexToRgb(colours[token]));
              const now = luminance(hexToRgb(painted.text[token]));
              if (low[token] < LEAST_CONTRAST || (lighter ? now < own : now > own)) {
                throw new Error(
                  `${token} at ${low[token].toFixed(3)}:1, ${own.toFixed(3)} to ${now.toFixed(3)}, with ${JSON.stringify(choice.dots)} at ${strength}`,
                );
              }
            }
          }
        });
      }

      // Above the calm tint the colours are the user's to make too strong:
      // nothing is held back, and the text has the most contrast there is.
      // The stretch where a dark chrome's text turns from white to black
      // runs between 0.85 and 0.95, so it is read a step at a time.
      for (const strength of [0.8, 0.85, 0.9, 0.95, 1]) {
        it(`gives every text 4.5:1 where black or white can, and else the better of them, ${palette}, ${look}, ${appearance}, at ${strength * 100}%`, () => {
          const colours = coloursOf(palette, appearance, THEMES);
          const texts = textGrounds(colours, look);
          const ground = (luminance(hexToRgb(colours.bg)) + luminance(hexToRgb(colours.surface))) / 2;
          const lighter = luminance(hexToRgb(colours.ink)) > ground;
          const ends = { black: "#000000", white: "#ffffff" };
          for (const choice of choices) {
            const painted = paintOf({ ...choice, strength }, look, colours);
            const low = lowestContrast(painted, texts, colours);
            const reach = lowestContrast({ ...painted, text: { ...painted.text, ink: ends.black, "ink-2": ends.white } }, texts, colours);
            const black = reach.ink;
            const white = reach["ink-2"];
            const lean = lighter ? white : black;
            const best = Math.max(black, white);
            for (const token of TEXT_TOKENS) {
              const own = luminance(hexToRgb(colours[token]));
              const now = luminance(hexToRgb(painted.text[token]));
              const said = `${token} at ${low[token].toFixed(3)}:1 with ${JSON.stringify(choice.dots)} at ${strength}`;
              // It turns from the palette's lean only where that end cannot
              // hold 4.5:1, a hair of the guard's coarser grid allowed.
              if ((lighter ? now < own : now > own) && lean >= LEAST_CONTRAST + 0.1) throw new Error(`${said} turned`);
              // It holds 4.5:1 or comes within a hair of the best end.
              if (low[token] < Math.min(LEAST_CONTRAST, best) - 0.1) throw new Error(`${said}, the best end reaches ${best.toFixed(3)}`);
            }
          }
        });
      }
    }
  }

  it("finds the same worst points reading only the darkest and lightest speck as reading every one", () => {
    const some = [choices[0], choices[50], choices[80], choices[choices.length - 1]];
    for (const [palette, appearance] of [["teal", "light"], ["amber", "dark"], ["night", "light"]] as const) {
      const colours = coloursOf(palette, appearance, THEMES);
      for (const choice of some) {
        for (const strength of [0.1, 1]) {
          const painted = paintOf({ ...choice, strength }, "modern", colours);
          const texts = textGrounds(colours, "modern");
          expect(lowestContrast(painted, texts, colours)).toEqual(lowestContrast(painted, texts, colours, true));
        }
      }
    }
  });

  it("leaves a text that already holds as it is, and draws one that does not a step stronger", () => {
    const colours = coloursOf("teal", "light");
    const painted = paintOf(background([[200, 1]], { strength: FULL_TINT }), "modern", colours);
    expect(painted.text.ink).toBe(colours.ink);
    expect(painted.asked["ink-3"]).toBeLessThan(LEAST_CONTRAST);
    expect(painted.contrast["ink-3"]).toBeGreaterThanOrEqual(LEAST_CONTRAST);
    expect(luminance(hexToRgb(painted.text["ink-3"]))).toBeLessThan(luminance(hexToRgb(colours["ink-3"])));
    const dark = paintOf(background([[200, 1]], { strength: FULL_TINT }), "modern", coloursOf("teal", "dark"));
    expect(luminance(hexToRgb(dark.text["ink-3"]))).toBeGreaterThan(luminance(hexToRgb(DEFAULTS.dark["ink-3"])));
  });

  it("turns the text on colours too light for white in dark to black, with chips and a chosen row to match", () => {
    const colours = coloursOf("rose", "dark");
    const painted = paintOf(background([[62, 1], [112, 1], [12, 1]], { strength: 1 }), "modern", colours);
    for (const token of TEXT_TOKENS) {
      expect(luminance(hexToRgb(painted.text[token])), token).toBeLessThan(luminance(hexToRgb(colours[token])));
    }
    expect(lowestText(painted)).toBeGreaterThanOrEqual(LEAST_CONTRAST);
    // A chip and a chosen row lay white over the colours, and a glyph on
    // the accent reads against the darker accent.
    expect(painted.patch).toMatch(/^rgba\(255, 255, 255, /);
    expect(painted.fillAccent).toMatch(/^rgba\(255, 255, 255, /);
    expect(ratio(luminance(hexToRgb(painted.onAccent)), luminance(hexToRgb(painted.text.accent)))).toBeGreaterThanOrEqual(3);
    // In the calm range they are the palette's own.
    const calm = paintOf(background([[62, 1], [112, 1], [12, 1]], { strength: FULL_TINT }), "modern", colours);
    expect(calm.patch).toBe(colours.surface);
    expect(calm.onAccent).toBe(colours.bg);
  });

  it("takes the full strength in the terminal look too, with no grain", () => {
    const painted = paintOf(background([[40, 1]], { strength: 0.9, grain: 1 }), "terminal", coloursOf("rose", "dark"));
    expect(painted.through).toBe(1);
    expect(painted.colours[0][0]).toBeGreaterThan(BAND.dark.lightness + 0.1);
    expect(painted.grain).toBe(0);
    expect(Object.keys(painted.grounds).sort()).toEqual(["frame", "status"]);
    const modern = paintOf(background([[40, 1]], { strength: 0.9, grain: 1 }), "modern", coloursOf("rose", "dark"));
    expect(modern.colours).toEqual(painted.colours);
    expect(Object.keys(modern.grounds).sort()).toEqual(["side", "status", "surf"]);
  });
});

describe("the modern look's ground", () => {
  it("is the darkest tone: a step below the background in light, the background in dark", () => {
    const light = coloursOf("teal", "light");
    const dark = coloursOf("teal", "dark");
    expect(deepOf(light)).toEqual(mix(hexToRgb(light.bg), hexToRgb(light.ink), 0.04));
    expect(deepOf(dark)).toEqual(hexToRgb(dark.bg));
    for (const colours of [light, dark]) {
      expect(luminance(deepOf(colours))).toBeLessThan(luminance(hexToRgb(colours.surface)));
    }
  });

  it("is what the headers, the sessions pane and the status bar lie on", () => {
    for (const appearance of ["light", "dark"] as const) {
      const colours = coloursOf("teal", appearance);
      const grounds = groundsOf(colours, "modern");
      expect(grounds.side).toEqual(deepOf(colours));
      expect(grounds.status).toEqual(deepOf(colours));
    }
  });

  it("follows what a theme's colours are rather than the appearance it is worn in", () => {
    const night = coloursOf("night", "light", THEMES);
    expect(deepOf(night)).toEqual(hexToRgb(night.bg));
  });
});

describe("the lines on a background", () => {
  const alpha = (css: string) => Number(/, ([\d.]+)\)$/.exec(css)![1]);
  const over = (under: Rgb, css: string) => {
    const [ink, amount] = rgbaOf(css);
    return mix(under, ink, amount);
  };

  for (const look of LOOKS) {
    for (const appearance of APPEARANCES) {
      it(`stand off every tinted part as far as today's line stands off it plain, ${look}, ${appearance}`, () => {
        for (const palette of PALETTES) {
          const colours = coloursOf(palette, appearance);
          const ink = hexToRgb(colours.ink);
          const today =
            look === "modern"
              ? mix(hexToRgb(colours.surface), ink, 0.18)
              : hexToRgb(colours.rule);
          const grounds = groundsOf(colours, look);
          for (const choice of [
            background([[30, 1]]),
            background([[192, 1], [300, 1]], { strength: FULL_TINT }),
            background([[62, 1], [112, 1], [12, 1]], { strength: 1 }),
          ]) {
            const painted = paintOf(choice, look, colours);
            for (const ground of Object.values(grounds)) {
              const target = ratio(luminance(today), luminance(ground!));
              for (let i = 0; i <= 10; i++) {
                const under = shown(painted, ground!, i / 10, i / 10, 0);
                const line = over(under, painted.partLine);
                expect(ratio(luminance(line), luminance(under))).toBeGreaterThanOrEqual(target - 0.01);
              }
            }
            // On a solid surface the line is at least today's.
            const surface = hexToRgb(colours.surface);
            const onSurface = ratio(luminance(over(surface, painted.line)), luminance(surface));
            expect(onSurface).toBeGreaterThanOrEqual(ratio(luminance(today), luminance(surface)) - 0.01);
            expect(alpha(painted.lineStrong)).toBeGreaterThanOrEqual(alpha(painted.line));
            expect(alpha(painted.partLineStrong)).toBeGreaterThanOrEqual(alpha(painted.partLine));
            // While the text keeps the palette's lean, every line is one paint.
            if (painted.patch === colours.surface) expect(painted.partLine).toBe(painted.line);
          }
        }
      });
    }
  }

  it("stay quieter than the quiet text, and in the calm range leave the accent of a control above 3:1", () => {
    for (const appearance of APPEARANCES) {
      for (const palette of PALETTES) {
        const colours = coloursOf(palette, appearance);
        const grounds = groundsOf(colours, "modern");
        for (const strength of [FULL_TINT, 1]) {
          const painted = paintOf(background([[192, 1], [300, 1]], { strength, grain: 1 }), "modern", colours);
          for (const ground of Object.values(grounds)) {
            for (let i = 0; i <= 10; i++) {
              const under = shown(painted, ground!, i / 10, 1 - i / 10, 0);
              const line = luminance(over(under, painted.partLine));
              const quiet = luminance(hexToRgb(painted.text["ink-3"]));
              expect(ratio(quiet, line)).toBeGreaterThan(2);
              if (strength === FULL_TINT) {
                expect(ratio(luminance(hexToRgb(colours.accent)), luminance(under))).toBeGreaterThanOrEqual(3);
              }
            }
          }
        }
      }
    }
  });
});

describe("the palettes the guard reads", () => {
  const read = (path: string) => readFileSync(`${process.cwd()}/${path}`, "utf8");
  const tokensIn = (css: string, selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    const body = css.slice(start, css.indexOf("}", start));
    const out: Record<string, string> = {};
    for (const [, name, value] of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]+);/g)) out[name] = value;
    return out;
  };

  it("are the colours palettes.css paints, light and dark", () => {
    const css = read("src/lib/styles/palettes.css");
    for (const palette of PALETTES.filter((name) => name !== "teal")) {
      const light = tokensIn(css, `:root[data-palette="${palette}"]`);
      const dark = tokensIn(css, `:root[data-palette="${palette}"][data-theme="dark"]`);
      delete light.dormant;
      delete dark.dormant;
      expect(PALETTE_COLOURS[palette].light, palette).toEqual(light);
      expect(PALETTE_COLOURS[palette].dark, palette).toEqual(dark);
    }
  });

  it("lay a theme of the user's own over the default", () => {
    const themes = { dusk: { label: "Dusk", light: { accent: "#7a4a8c" }, dark: {}, shape: {} } };
    expect(coloursOf("dusk", "light", themes).accent).toBe("#7a4a8c");
    expect(coloursOf("dusk", "dark", themes).accent).toBe(DEFAULTS.dark.accent);
    expect(coloursOf("nothing", "light").ink).toBe(DEFAULTS.light.ink);
  });
});
