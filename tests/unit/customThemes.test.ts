import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN,
  COLOUR_TOKENS,
  DEFAULTS,
  SHAPE_TOKENS,
  checkTheme,
  contrast,
  isThemeName,
  readability,
  themeCss,
  validThemes,
} from "$lib/customThemes";
import { PALETTES } from "$lib/theme.svelte";

const read = (path: string) => readFileSync(`${process.cwd()}/${path}`, "utf8");

/** The custom properties a block of CSS sets, by name. */
function tokensIn(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    out[name] = value.trim();
  }
  return out;
}

describe("the tokens a theme sets", () => {
  const tokens = read("src/lib/styles/tokens.css");

  it("are the default palette's, light and dark, as tokens.css has them", () => {
    const light = tokensIn(tokens, ":root");
    const dark = tokensIn(tokens, ':root[data-theme="dark"]');
    for (const token of COLOUR_TOKENS) {
      expect(DEFAULTS.light[token], token).toBe(light[token]);
      expect(DEFAULTS.dark[token], token).toBe(dark[token]);
    }
  });

  it("are all ones the stylesheets are written in", () => {
    for (const token of [...COLOUR_TOKENS, ...Object.keys(SHAPE_TOKENS)]) {
      expect(tokens).toContain(`--${token}:`);
    }
  });

  it("are the ones the core takes, in the same order", () => {
    const rust = read("src-tauri/crates/core/src/settings.rs");
    const colours = rust
      .slice(rust.indexOf("pub const COLOUR_TOKENS"), rust.indexOf("];", rust.indexOf("pub const COLOUR_TOKENS")))
      .match(/"([a-z0-9-]+)"/g)!
      .map((quoted) => quoted.slice(1, -1));
    expect(colours).toEqual([...COLOUR_TOKENS]);
    const shapes = [...rust.matchAll(/\("([a-z-]+)", (\d+)\)/g)].map(([, token, most]) => [
      token,
      Number(most),
    ]);
    expect(Object.fromEntries(shapes)).toEqual(SHAPE_TOKENS);
  });

  it("leave the palettes the app has out of a theme's names", () => {
    expect(BUILT_IN).toEqual(PALETTES.map((palette) => palette.name));
  });
});

describe("checkTheme", () => {
  it("takes a theme's label, colours and shape, colours in lower case", () => {
    const theme = checkTheme("dusk", {
      label: " Dusk ",
      light: { accent: "#7A4A8C", surface: "#fff" },
      dark: { accent: "#c39ad4" },
      shape: { radius: "10px" },
    });
    expect(theme).toEqual({
      label: "Dusk",
      light: { accent: "#7a4a8c", surface: "#fff" },
      dark: { accent: "#c39ad4" },
      shape: { radius: "10px" },
    });
    expect(checkTheme("dusk", {}).label).toBe("dusk");
  });

  it("refuses what a theme does not set, and a value not in its form", () => {
    const bad = (value: unknown) => () => checkTheme("dusk", value);
    expect(bad({ light: { font: "#fff" } })).toThrow(/not a colour a theme sets/);
    expect(bad({ light: { accent: "red" } })).toThrow(/hex colour/);
    expect(bad({ light: { accent: "#fff; } body { display: none" } })).toThrow(/hex colour/);
    expect(bad({ dark: { accent: "url(https://x)" } })).toThrow(/hex colour/);
    expect(bad({ shape: { radius: "17px" } })).toThrow(/up to 16px/);
    expect(bad({ shape: { radius: "1e2px" } })).toThrow(/whole pixels/);
    expect(bad({ shape: { margin: "4px" } })).toThrow(/not a measure/);
    expect(bad({ css: "body{}" })).toThrow(/not css/);
    expect(bad({ label: "x".repeat(41) })).toThrow(/label/);
    expect(bad("#fff")).toThrow(/table/);
  });

  it("refuses a name the page cannot carry, or one the app has", () => {
    for (const name of ["", "Dusk", "2dusk", "dusk night", 'dusk"]', "teal", "a".repeat(33)]) {
      expect(isThemeName(name), name).toBe(false);
      expect(() => checkTheme(name, {})).toThrow(/not a theme's name/);
    }
    expect(isThemeName("solar-2")).toBe(true);
  });

  it("leaves out of a table the themes that do not pass", () => {
    const themes = validThemes({
      dusk: { light: { accent: "#123456" } },
      broken: { light: { accent: "red" } },
      "Bad Name": {},
    });
    expect(Object.keys(themes)).toEqual(["dusk"]);
    expect(validThemes(null)).toEqual({});
  });
});

describe("readability", () => {
  it("reckons contrast the way WCAG does", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#fff", "#fff")).toBeCloseTo(1, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });

  it("passes the default palette, and a theme that leaves the ink alone", () => {
    expect(readability({ label: "x", light: {}, dark: {}, shape: {} })).toBeNull();
    expect(
      readability({ label: "x", light: { accent: "#7a4a8c" }, dark: { accent: "#c39ad4" }, shape: {} }),
    ).toBeNull();
  });

  it("names the appearance and the pair that cannot be read", () => {
    const pale = readability({ label: "x", light: { ink: "#cccccc" }, dark: {}, shape: {} });
    expect(pale).toMatch(/light appearance, ink on surface has a contrast of 1\.\d to 1/);
    const dim = readability({ label: "x", light: {}, dark: { accent: "#20282a" }, shape: {} });
    expect(dim).toMatch(/dark appearance, accent on surface/);
  });
});

describe("themeCss", () => {
  const css = themeCss({
    dusk: {
      label: "Dusk",
      light: { accent: "#7a4a8c", bg: "#faf7fb" },
      dark: { accent: "#c39ad4" },
      shape: { radius: "10px" },
    },
  });

  it("writes the light colours and the shape on the theme's stamp", () => {
    const light = tokensIn(css, ':root:root[data-palette="dusk"]');
    expect(light).toEqual({ accent: "#7a4a8c", bg: "#faf7fb", radius: "10px" });
  });

  it("writes the dark colours under the preference and under the choice", () => {
    for (const selector of [
      '  :root:root[data-palette="dusk"]:not([data-theme="light"])',
      ':root:root[data-palette="dusk"][data-theme="dark"]',
    ]) {
      const dark = tokensIn(css, selector);
      expect(dark.accent).toBe("#c39ad4");
      // Set for light alone, the dark takes the default's dark value, so the
      // light ground never shows in the dark.
      expect(dark.bg).toBe(DEFAULTS.dark.bg);
      expect(dark.radius).toBeUndefined();
    }
    expect(css).toContain("@media (prefers-color-scheme: dark)");
  });

  it("writes nothing for a theme that does not pass", () => {
    expect(
      themeCss({
        dusk: { label: "x", light: { accent: "red} body{display:none" }, dark: {}, shape: {} },
        'x"],*{': { label: "x", light: {}, dark: {}, shape: {} },
      }),
    ).toBe("");
  });
});
