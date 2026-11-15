import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Background } from "$lib/background";
import { backgroundCss, imagesOf } from "$lib/backgroundPaint";
import { coloursOf } from "$lib/paletteColours";
import { adoptTheme, loadTheme, setPalette, shownBackground, theme } from "$lib/theme.svelte";

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
    expect(imagesOf(LAGOON)).toEqual({ light: null, dark: null, grain: null });
  });
});

describe("painting the background the palette keeps", () => {
  beforeEach(() => {
    theme.palette = "teal";
    theme.backgrounds = {};
    theme.preview = null;
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("sets the background aside while the system asks for more contrast", () => {
    const real = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      ...real(query),
      matches: query === "(prefers-contrast: more)",
    })) as typeof window.matchMedia;
    try {
      adoptTheme({ backgrounds: { teal: LAGOON } });
      expect(document.documentElement.dataset.background).toBeUndefined();
      expect(sheet()).toBe("");
    } finally {
      window.matchMedia = real;
    }
    adoptTheme({});
    expect(document.documentElement.dataset.background).toBe("");
  });
});
