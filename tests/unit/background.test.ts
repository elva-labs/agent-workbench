import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BAND,
  FILL,
  FIRST,
  GRAIN_SPECK,
  HARMONIES,
  LEAST_CONTRAST,
  READY_MADE,
  TERMINAL_STRENGTH,
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
  luminance,
  mix,
  moveDot,
  paintOf,
  ratio,
  readyMadeOf,
  removeDot,
  rgbToLab,
  rounded,
  sameBackground,
  toneOf,
  validBackgrounds,
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

  it("is kept in whole degrees and hundredths", () => {
    const kept = rounded(background([[359.7, 0.333]], { strength: 0.555, grain: 0.004 }));
    expect(kept).toEqual({ dots: [{ hue: 0, chroma: 0.33 }], harmony: "single", strength: 0.56, grain: 0 });
    expect(sameBackground(background([[10.2, 0.5]]), background([[10, 0.501]]))).toBe(true);
    expect(sameBackground(background([[10, 0.5]]), null)).toBe(false);
  });

  it("knows a ready-made by its colours, whatever its strength and grain", () => {
    const lagoon = READY_MADE.find((ready) => ready.name === "lagoon")!;
    const own = { dots: lagoon.dots, harmony: lagoon.harmony, strength: 0.3, grain: 0 };
    expect(readyMadeOf(own)).toBe("lagoon");
    expect(readyMadeOf(moveDot(own, 1, { hue: 10, chroma: 0.8 }))).toBeNull();
    expect(describeBackground(own)).toBe("Lagoon, strength 30%, grain 0%");
    expect(describeBackground(background([[10, 0.4], [40, 1]]))).toBe("2 colours, strength 60%, grain 25%");
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
    expect(withHarmony(one, "analogous").dots.map((dot) => dot.hue)).toEqual([350, 30, 310]);
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

  it("adds a dot up to three, and takes the last one away with the background", () => {
    const one = background([[100, 0.6]]);
    const two = addDot(one);
    expect(two.harmony).toBe("complementary");
    const three = addDot(two);
    expect(three.harmony).toBe("triad");
    expect(addDot(three)).toBe(three);
    const freePair = background([[0, 0.5], [90, 1]]);
    const added = addDot(freePair);
    expect(added.harmony).toBe("free");
    expect(added.dots[2]).toEqual({ hue: 225, chroma: 0.5 });

    const fewer = removeDot(three, 1)!;
    expect(fewer.dots.map((dot) => dot.hue)).toEqual([100, 340]);
    expect(fewer.harmony).toBe("free");
    expect(removeDot(fewer, 0)!.harmony).toBe("single");
    expect(removeDot(one, 0)).toBeNull();
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
  return mix(ground, specked, painted.strength);
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
  const fills: [Rgb, number][] = [
    [hexToRgb(colours.ink), FILL.ink],
    [hexToRgb(colours.accent), FILL.accent],
  ];
  const alpha = painted.grain * GRAIN_SPECK;
  const strength = painted.strength;
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
      for (const strength of [0.1, 0.3, 1]) {
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
    const painted = paintOf(background([[200, 1]], { strength: 1 }), "modern", colours);
    expect(painted.text.ink).toBe(colours.ink);
    expect(painted.asked["ink-3"]).toBeLessThan(LEAST_CONTRAST);
    expect(painted.contrast["ink-3"]).toBeGreaterThanOrEqual(LEAST_CONTRAST);
    expect(luminance(hexToRgb(painted.text["ink-3"]))).toBeLessThan(luminance(hexToRgb(colours["ink-3"])));
    const dark = paintOf(background([[200, 1]], { strength: 1 }), "modern", coloursOf("teal", "dark"));
    expect(luminance(hexToRgb(dark.text["ink-3"]))).toBeGreaterThan(luminance(hexToRgb(DEFAULTS.dark["ink-3"])));
  });

  it("holds the terminal look at half strength with no grain", () => {
    const painted = paintOf(background([[40, 1]], { strength: 0.9, grain: 1 }), "terminal", coloursOf("rose", "dark"));
    expect(painted.strength).toBe(TERMINAL_STRENGTH);
    expect(painted.grain).toBe(0);
    expect(Object.keys(painted.grounds).sort()).toEqual(["frame", "status"]);
    const modern = paintOf(background([[40, 1]], { strength: 0.9, grain: 1 }), "modern", coloursOf("rose", "dark"));
    expect(modern.strength).toBe(0.9);
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
  const over = (under: Rgb, ink: Rgb, css: string) => mix(under, ink, alpha(css));

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
          for (const choice of [background([[30, 1]]), background([[192, 1], [300, 1]], { strength: 1 })]) {
            const painted = paintOf(choice, look, colours);
            for (const ground of Object.values(grounds)) {
              const target = ratio(luminance(today), luminance(ground!));
              for (let i = 0; i <= 10; i++) {
                const under = shown(painted, ground!, i / 10, i / 10, 0);
                const line = over(under, ink, painted.line);
                expect(ratio(luminance(line), luminance(under))).toBeGreaterThanOrEqual(target - 0.01);
              }
            }
            // On a solid surface the line is at least today's.
            const surface = hexToRgb(colours.surface);
            const onSurface = ratio(luminance(over(surface, ink, painted.line)), luminance(surface));
            expect(onSurface).toBeGreaterThanOrEqual(ratio(luminance(today), luminance(surface)) - 0.01);
            expect(alpha(painted.lineStrong)).toBeGreaterThanOrEqual(alpha(painted.line));
          }
        }
      });
    }
  }

  it("stay quieter than the quiet text and leave the accent of a control above 3:1", () => {
    for (const appearance of APPEARANCES) {
      for (const palette of PALETTES) {
        const colours = coloursOf(palette, appearance);
        const ink = hexToRgb(colours.ink);
        const grounds = groundsOf(colours, "modern");
        const painted = paintOf(background([[192, 1], [300, 1]], { strength: 1, grain: 1 }), "modern", colours);
        for (const ground of Object.values(grounds)) {
          for (let i = 0; i <= 10; i++) {
            const under = shown(painted, ground!, i / 10, 1 - i / 10, 0);
            const line = luminance(over(under, ink, painted.line));
            const quiet = luminance(hexToRgb(painted.text["ink-3"]));
            expect(ratio(quiet, line)).toBeGreaterThan(2);
            expect(ratio(luminance(hexToRgb(colours.accent)), luminance(under))).toBeGreaterThanOrEqual(3);
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
