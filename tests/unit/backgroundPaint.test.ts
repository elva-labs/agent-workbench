import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hexToRgb, luminance, type Background } from "$lib/background";
import { FULL, backgroundCss, drawImagesWith, imagesOf } from "$lib/backgroundPaint";
import { coloursOf } from "$lib/paletteColours";
import {
  adoptTheme,
  cardsThrough,
  deleteTheme,
  endPreview,
  loadTheme,
  previewBackground,
  previewCards,
  REST,
  resolvedTheme,
  setBackground,
  setCards,
  setPalette,
  setThemes,
  shownBackground,
  shownCards,
  theme,
  themeSettings,
} from "$lib/theme.svelte";

const LAGOON: Background = {
  dots: [
    { hue: 192, chroma: 0.9 },
    { hue: 252, chroma: 0.8 },
  ],
  harmony: "free",
  strength: 0.6,
  grain: 0.25,
};

const colours = { light: coloursOf("teal", "light"), dark: coloursOf("teal", "dark") };

/** The custom properties a block of the sheet sets, by name. */
function block(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}

const sheet = () => document.getElementById("workbench-background")?.textContent ?? "";

describe("the stylesheet a background is painted from", () => {
  const images = { light: "data:image/png;base64,LIGHT", dark: "data:image/png;base64,DARK", grain: "data:image/png;base64,GRAIN" };
  const css = backgroundCss(LAGOON, colours, images);

  it("names each image once and refers to it from every set", () => {
    expect(css.split("base64,LIGHT").length - 1).toBe(1);
    expect(css.split("base64,DARK").length - 1).toBe(1);
    expect(css.split("base64,GRAIN").length - 1).toBe(1);
    const light = block(css, ':root[data-background][data-look="modern"]');
    expect(light["tint-backdrop"]).toContain("var(--tint-image-light)");
    expect(light["tint-backdrop"]).toContain("var(--tint-grain)");
    const dark = block(css, ':root[data-background][data-look="modern"][data-theme="dark"]');
    expect(dark["tint-backdrop"]).toContain("var(--tint-image-dark)");
  });

  it("paints the modern look's parts, and the terminal look's ground at half strength with no grain", () => {
    const modern = block(css, ':root[data-background][data-look="modern"]');
    expect(Object.keys(modern)).toEqual(expect.arrayContaining(["tint-side", "tint-surf", "tint-status"]));
    expect(modern["tint-side"]).toMatch(/0\.400\)$/);
    const terminal = block(css, ":root[data-background]:not([data-look])");
    expect(Object.keys(terminal)).toEqual(expect.arrayContaining(["tint-frame", "tint-status"]));
    expect(terminal["tint-side"]).toBeUndefined();
    expect(terminal["tint-frame"]).toMatch(/0\.500\)$/);
    expect(terminal["tint-backdrop"]).not.toContain("grain");
  });

  it("writes the dark sets under the system's preference and again under the explicit choice", () => {
    expect(css).toContain(
      '@media (prefers-color-scheme: dark) {\n  :root[data-background][data-look="modern"]:not([data-theme="light"]) {',
    );
    const preferred = block(css, ':root[data-background][data-look="modern"]:not([data-theme="light"])');
    const chosen = block(css, ':root[data-background][data-look="modern"][data-theme="dark"]');
    expect(preferred).toEqual(chosen);
    expect(chosen["tint-ink"]).toBe(colours.dark.ink);
  });

  it("stands a flat colour in for a single dot, and for a gradient the page cannot draw", () => {
    const single = backgroundCss({ ...LAGOON, dots: [LAGOON.dots[0]], harmony: "single" }, colours, images);
    expect(block(single, ':root[data-background][data-look="modern"]')["tint-backdrop"]).toMatch(
      /linear-gradient\(#[0-9a-f]{6}, #[0-9a-f]{6}\) fixed$/,
    );
    const none = backgroundCss(LAGOON, colours, { light: null, dark: null, grain: null });
    expect(none).not.toContain("tint-image");
    expect(imagesOf(LAGOON, colours)).toEqual({ light: null, dark: null, grain: null, rough: false });
  });

  it("paints a theme that is dark in both appearances dark in both, its text lighter", () => {
    const night = { light: colours.dark, dark: colours.dark };
    const single = { ...LAGOON, dots: [LAGOON.dots[0]], harmony: "single" as const };
    const sheet = backgroundCss(single, night, images);
    const light = block(sheet, ':root[data-background][data-look="modern"]');
    const dark = block(sheet, ':root[data-background][data-look="modern"][data-theme="dark"]');
    expect(light).toEqual(dark);
    const flat = /linear-gradient\((#[0-9a-f]{6}),/.exec(light["tint-backdrop"])![1];
    expect(luminance(hexToRgb(flat))).toBeLessThan(0.05);
    expect(luminance(hexToRgb(light["tint-ink-3"]))).toBeGreaterThanOrEqual(luminance(hexToRgb(colours.dark["ink-3"])));
  });
});

/** Draws an image as its size and a count, so a test can tell which size
    a URL is and whether it was drawn again. */
function drawSizes() {
  let count = 0;
  drawImagesWith((_pixels, width, height) => `${width}x${height}#${++count}`);
}

const sizeOf = (url: string | null) => url?.split("#")[0] ?? null;

describe("the gradient's image", () => {
  beforeEach(drawSizes);
  afterEach(() => drawImagesWith(null));

  it("is small while the background moves and full size once asked, and stays full size", () => {
    const full = `${FULL.width}x${FULL.height}`;
    const moving = imagesOf(LAGOON, colours, false);
    expect([sizeOf(moving.light), sizeOf(moving.dark), moving.rough]).toEqual(["192x120", "192x120", true]);
    const rested = imagesOf(LAGOON, colours, true);
    expect([sizeOf(rested.light), sizeOf(rested.dark), rested.rough]).toEqual([full, full, false]);
    // Moved back to where it was, it is not drawn again.
    const again = imagesOf(LAGOON, colours, false);
    expect([again.light, again.dark, again.rough]).toEqual([rested.light, rested.dark, false]);
    // Only the appearance asked for is drawn, and a colour moved is drawn
    // small again.
    const moved = { ...LAGOON, dots: [{ hue: 40, chroma: 0.9 }, LAGOON.dots[1]] };
    const one = imagesOf(moved, { dark: colours.dark }, false);
    expect([one.light, sizeOf(one.dark), one.rough]).toEqual([null, "192x120", true]);
    // A single colour has no gradient to draw.
    const single = imagesOf({ ...LAGOON, dots: [LAGOON.dots[0]], harmony: "single" }, colours, false);
    expect([single.light, single.dark, single.rough]).toEqual([null, null, false]);
  });

  it("is drawn fine enough at full size that a pixel is five device pixels across at most on a 4K window", () => {
    expect(3840 / FULL.width).toBeLessThanOrEqual(5);
    expect(2160 / FULL.height).toBeLessThanOrEqual(5);
  });
});

describe("painting the background the palette keeps", () => {
  beforeEach(() => {
    theme.palette = "teal";
    theme.themes = {};
    theme.backgrounds = {};
    theme.cards = {};
    theme.preview = null;
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    drawImagesWith(null);
  });

  it("draws the gradient small while it moves and at full size once it has rested", () => {
    vi.useFakeTimers();
    drawSizes();
    const [small, full] = ["192x120", `${FULL.width}x${FULL.height}`];
    // The size of the gradient the sheet names for each appearance.
    const images = () =>
      Object.fromEntries(
        [...sheet().matchAll(/--tint-image-(light|dark): url\("(\d+x\d+)#\d+"\)/g)].map((found) => [
          found[1],
          found[2],
        ]),
      );
    const shown = resolvedTheme();
    const other = shown === "light" ? "dark" : "light";
    const moved = (hue: number) => ({ ...LAGOON, dots: [{ hue, chroma: 0.9 }, LAGOON.dots[1]] });
    // A background no other test paints, so no sheet is already worked
    // out for it.
    adoptTheme({ palette: "teal", backgrounds: { teal: moved(30) } });
    expect(images()).toEqual({ light: small, dark: small });
    vi.advanceTimersByTime(REST);
    expect(images()).toEqual({ light: full, dark: full });
    // Painted again with nothing changed, it stays at full size.
    adoptTheme({ palette: "teal", backgrounds: { teal: moved(30) } });
    vi.advanceTimersByTime(REST);
    expect(images()).toEqual({ light: full, dark: full });
    // A dot dragged on the pad: only the appearance on screen is drawn, and
    // each move puts the full size off again.
    previewBackground(moved(40));
    expect(images()).toEqual({ [shown]: small });
    vi.advanceTimersByTime(REST - 1);
    previewBackground(moved(50));
    vi.advanceTimersByTime(REST - 1);
    expect(images()).toEqual({ [shown]: small });
    vi.advanceTimersByTime(1);
    expect(images()).toEqual({ [shown]: full });
    // Let go, it is kept at full size, and the other appearance follows.
    setBackground(moved(50));
    expect(images()).toEqual({ [shown]: full, [other]: small });
    vi.advanceTimersByTime(REST);
    expect(images()).toEqual({ light: full, dark: full });
  });

  it("paints a palette's background and stamps it, and takes both away with another palette", () => {
    adoptTheme({ palette: "teal", backgrounds: { teal: LAGOON } });
    expect(document.documentElement.dataset.background).toBe("");
    expect(sheet()).toContain('--tint-side:');
    setPalette("indigo");
    expect(document.documentElement.dataset.background).toBeUndefined();
    expect(sheet()).toBe("");
    setPalette("teal");
    expect(document.documentElement.dataset.background).toBe("");
  });

  it("paints what is being picked in place of what is kept, until it is let go", () => {
    adoptTheme({ backgrounds: { teal: LAGOON } });
    theme.preview = { background: null };
    expect(shownBackground()).toBeNull();
    theme.preview = null;
    expect(shownBackground()).toEqual(LAGOON);
  });

  it("keeps a background with the palette in use, rounded as it is kept, and takes it away", () => {
    setPalette("rose");
    setBackground({ ...LAGOON, strength: 0.6049 });
    expect(theme.backgrounds).toEqual({ rose: { ...LAGOON, strength: 0.6 } });
    expect(JSON.parse(localStorage.getItem("workbench.backgrounds")!)).toEqual(theme.backgrounds);
    setBackground(null);
    expect(theme.backgrounds).toEqual({});
    expect(document.documentElement.dataset.background).toBeUndefined();
  });

  it("paints a background being picked without keeping it, and the kept one again after", () => {
    previewBackground(LAGOON);
    expect(document.documentElement.dataset.background).toBe("");
    expect(theme.backgrounds).toEqual({});
    endPreview();
    expect(document.documentElement.dataset.background).toBeUndefined();
    previewBackground(LAGOON);
    setBackground(LAGOON);
    expect(theme.preview).toBeNull();
    expect(theme.backgrounds).toEqual({ teal: LAGOON });
  });

  it("takes a theme's background away with the theme, and leaves the others", () => {
    const dusk = { label: "Dusk", light: {}, dark: {}, shape: {} };
    setThemes({ dusk }, "dusk", { dusk: LAGOON, teal: LAGOON });
    expect(Object.keys(theme.backgrounds).sort()).toEqual(["dusk", "teal"]);
    deleteTheme("dusk");
    expect(theme.palette).toBe("teal");
    expect(Object.keys(theme.backgrounds)).toEqual(["teal"]);
  });

  it("leaves out a background that does not keep the rules", () => {
    adoptTheme({ backgrounds: { teal: { dots: [] }, rose: LAGOON } as never });
    expect(Object.keys(theme.backgrounds)).toEqual(["rose"]);
  });

  it("keeps the window's copy for the first frame of the next start", () => {
    adoptTheme({ backgrounds: { teal: LAGOON } });
    theme.backgrounds = {};
    loadTheme();
    expect(theme.backgrounds).toEqual({ teal: LAGOON });
    expect(document.documentElement.dataset.background).toBe("");
  });

  it("sets the background aside while the system asks for more contrast or forces its own colours", () => {
    const real = window.matchMedia;
    for (const asking of ["(prefers-contrast: more)", "(forced-colors: active)"]) {
      window.matchMedia = ((query: string) => ({
        ...real(query),
        matches: query.split(",").some((part) => part.trim() === asking),
      })) as typeof window.matchMedia;
      try {
        adoptTheme({ backgrounds: { teal: LAGOON } });
        expect(document.documentElement.dataset.background, asking).toBeUndefined();
        expect(sheet()).toBe("");
      } finally {
        window.matchMedia = real;
      }
      adoptTheme({});
      expect(document.documentElement.dataset.background).toBe("");
    }
  });
});

describe("the stylesheet with cards that let the background through", () => {
  const images = { light: "data:image/png;base64,LIGHT", dark: "data:image/png;base64,DARK", grain: "data:image/png;base64,GRAIN" };

  it("writes nothing for the cards while they let nothing through", () => {
    const css = backgroundCss(LAGOON, colours, images);
    expect(css).not.toContain("--tint-card");
    expect(backgroundCss(LAGOON, colours, images, null, 0)).toBe(css);
  });

  it("paints the cards from the gradient with the grain blurred to a veil, never the speckle", () => {
    const css = backgroundCss(LAGOON, colours, images, null, 0.25);
    const modern = block(css, ':root[data-background][data-look="modern"]');
    expect(modern["tint-card-backdrop"]).toContain("var(--tint-image-light)");
    expect(modern["tint-card-backdrop"]).not.toContain("--tint-grain");
    expect(modern["tint-card-backdrop"]).toMatch(/^linear-gradient\(rgba\(128, 128, 128, 0\.018\)/);
    // At the end of the range a card shows as much as the ground: the
    // strength, 60%. A white card's tone can lighten no further, so it
    // stays white.
    expect(modern["tint-card"]).toBe("rgba(255, 255, 255, 0.400)");
    expect(Object.keys(modern)).toEqual(expect.arrayContaining(["tint-well", "tint-card-ink", "tint-card-ink-3"]));
    // The terminal look takes no grain, so its cards take no veil, at its
    // held strength.
    const terminal = block(css, ":root[data-background]:not([data-look])");
    expect(terminal["tint-card-backdrop"]).toBe("var(--tint-image-light) 0 0 / 100vw 100vh no-repeat fixed");
    expect(terminal["tint-card"]).toBe("rgba(255, 255, 255, 0.500)");
    const dark = block(css, ':root[data-background][data-look="modern"][data-theme="dark"]');
    expect(dark["tint-card-backdrop"]).toContain("var(--tint-image-dark)");
  });

  it("paints a single colour's cards flat, the veil worked into it", () => {
    const css = backgroundCss({ ...LAGOON, dots: [LAGOON.dots[0]], harmony: "single" }, colours, images, null, 0.25);
    const modern = block(css, ':root[data-background][data-look="modern"]');
    expect(modern["tint-card-backdrop"]).toMatch(/^linear-gradient\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/);
  });
});

describe("keeping the cards' share", () => {
  beforeEach(() => {
    theme.palette = "teal";
    theme.themes = {};
    theme.backgrounds = {};
    theme.cards = {};
    theme.preview = null;
    theme.choice = "system";
    localStorage.clear();
  });

  it("stamps nothing in the appearance where the guard holds the share at none", () => {
    // A theme whose terminal blue holds 4.5:1 on its light card by a hair,
    // so any of the background on that card would take it under.
    const tight = { label: "Tight", light: { "ansi-blue": "#717879" }, dark: {}, shape: {} };
    adoptTheme({ appearance: "light", themes: { tight }, palette: "tight", backgrounds: { tight: LAGOON }, cards: { tight: 0.2 } });
    expect(theme.cardsHeld).toBe(0);
    expect(cardsThrough()).toBe(false);
    expect(document.documentElement.dataset.cards).toBeUndefined();
    adoptTheme({ appearance: "dark" });
    expect(theme.cardsHeld).toBeGreaterThan(0);
    expect(cardsThrough()).toBe(true);
    expect(document.documentElement.dataset.cards).toBe("");
    adoptTheme({ appearance: "system" });
  });

  it("drops a share whose background a change of themes takes away", () => {
    const dusk = { label: "Dusk", light: {}, dark: {}, shape: {} };
    setThemes({ dusk }, "teal", { dusk: LAGOON, teal: LAGOON });
    adoptTheme({ cards: { teal: 0.2, dusk: 0.1 } });
    setThemes({ dusk }, "teal", { dusk: LAGOON });
    expect(theme.cards).toEqual({ dusk: 0.1 });
  });

  it("keeps a share with the palette in use, beside its background, and stamps it while one shows", () => {
    adoptTheme({ backgrounds: { teal: LAGOON } });
    expect(document.documentElement.dataset.cards).toBeUndefined();
    expect(cardsThrough()).toBe(false);
    setCards(0.2049);
    expect(theme.cards).toEqual({ teal: 0.2 });
    expect(theme.backgrounds.teal).toEqual(LAGOON);
    expect(JSON.parse(localStorage.getItem("workbench.cards")!)).toEqual({ teal: 0.2 });
    expect(themeSettings().cards).toEqual({ teal: 0.2 });
    expect(document.documentElement.dataset.cards).toBe("");
    expect(sheet()).toContain("--tint-card:");
    expect(cardsThrough()).toBe(true);
    setCards(0);
    expect(theme.cards).toEqual({});
    expect(document.documentElement.dataset.cards).toBeUndefined();
  });

  it("does nothing without a background, and goes with the background it is kept beside", () => {
    adoptTheme({ cards: { teal: 0.2 } });
    expect(document.documentElement.dataset.cards).toBeUndefined();
    expect(cardsThrough()).toBe(false);
    adoptTheme({ backgrounds: { teal: LAGOON }, cards: { teal: 0.2, rose: 0.1 } });
    expect(document.documentElement.dataset.cards).toBe("");
    setBackground(null);
    expect(theme.cards).toEqual({});
    expect(document.documentElement.dataset.cards).toBeUndefined();
  });

  it("paints a share being picked without keeping it", () => {
    adoptTheme({ backgrounds: { teal: LAGOON } });
    previewCards(0.1);
    expect(shownCards()).toBe(0.1);
    expect(document.documentElement.dataset.cards).toBe("");
    expect(theme.cards).toEqual({});
    endPreview();
    expect(shownCards()).toBe(0);
    expect(document.documentElement.dataset.cards).toBeUndefined();
  });

  it("follows each palette's own share, and takes a theme's away with it", () => {
    const dusk = { label: "Dusk", light: {}, dark: {}, shape: {} };
    setThemes({ dusk }, "dusk", { dusk: LAGOON, teal: LAGOON });
    adoptTheme({ cards: { dusk: 0.25 } });
    expect(shownCards()).toBe(0.25);
    setPalette("teal");
    expect(shownCards()).toBe(0);
    expect(document.documentElement.dataset.cards).toBeUndefined();
    deleteTheme("dusk");
    expect(theme.cards).toEqual({});
  });

  it("leaves out a share that does not keep the rules, and reads the window's copy at start", () => {
    adoptTheme({ backgrounds: { teal: LAGOON }, cards: { teal: 0.9, rose: 0.1 } as never });
    expect(theme.cards).toEqual({ rose: 0.1 });
    adoptTheme({ cards: { teal: 0.15 } });
    theme.cards = {};
    loadTheme();
    expect(theme.cards).toEqual({ teal: 0.15 });
    expect(document.documentElement.dataset.cards).toBe("");
  });

  it("is set aside with the background while the system asks for more contrast", () => {
    const real = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      ...real(query),
      matches: query.includes("prefers-contrast: more"),
    })) as typeof window.matchMedia;
    try {
      adoptTheme({ backgrounds: { teal: LAGOON }, cards: { teal: 0.2 } });
      expect(document.documentElement.dataset.cards).toBeUndefined();
      expect(cardsThrough()).toBe(false);
    } finally {
      window.matchMedia = real;
    }
    adoptTheme({});
    expect(document.documentElement.dataset.cards).toBe("");
  });
});
