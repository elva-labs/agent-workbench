import { DEFAULTS, type CustomTheme } from "$lib/customThemes";

/**
 * Each palette's colours as the stylesheets paint them: the default
 * palette's, with what palettes.css restates for the others laid over, and
 * a theme of the user's own laid over the default the same way. What reads
 * a colour without a page to read it from, such as the guard working out a
 * background for the appearance that is not showing, reads it here.
 */

type Appearance = "light" | "dark";

/** What each palette restates over the default, as palettes.css has it. */
export const PALETTE_COLOURS: Record<string, Record<Appearance, Record<string, string>>> = {
  teal: { light: {}, dark: {} },
  indigo: {
    light: {
      bg: "#f4f5f8",
      "surface-2": "#eef0f5",
      rule: "#dde1ea",
      "rule-strong": "#c5cad6",
      "ink-2": "#4f5666",
      "ink-3": "#7d8493",
      accent: "#3f56b5",
      "accent-soft": "#e6e9f7",
      "ansi-cyan": "#3f56b5",
      "ansi-bright-cyan": "#5f76d3",
    },
    dark: {
      bg: "#0f1114",
      surface: "#17191d",
      "surface-2": "#1e2126",
      rule: "#272b33",
      "rule-strong": "#3a3f49",
      "ink-2": "#a4abb9",
      "ink-3": "#798190",
      accent: "#8ea1ee",
      "accent-soft": "#1c2140",
      "ansi-cyan": "#8ea1ee",
      "ansi-bright-cyan": "#b0bef5",
    },
  },
  amber: {
    light: {
      bg: "#f7f5f2",
      "surface-2": "#f0ece6",
      rule: "#e5ded4",
      "rule-strong": "#cfc6b9",
      "ink-2": "#5a544b",
      "ink-3": "#89817a",
      accent: "#a0651a",
      "accent-soft": "#f7ecdc",
      "ansi-cyan": "#a0651a",
      "ansi-bright-cyan": "#c4863a",
    },
    dark: {
      bg: "#12100e",
      surface: "#1a1714",
      "surface-2": "#1f1b17",
      rule: "#2d2721",
      "rule-strong": "#423a31",
      "ink-2": "#b2aa9e",
      "ink-3": "#857c72",
      accent: "#e0b15c",
      "accent-soft": "#33270f",
      "ansi-cyan": "#e0b15c",
      "ansi-bright-cyan": "#eccb8a",
    },
  },
  rose: {
    light: {
      bg: "#f7f4f6",
      "surface-2": "#f1ebee",
      rule: "#e7dde2",
      "rule-strong": "#d0c3c9",
      "ink-2": "#5a4f55",
      "ink-3": "#897d84",
      accent: "#b0426b",
      "accent-soft": "#f8e6ee",
      "ansi-cyan": "#b0426b",
      "ansi-bright-cyan": "#cf6a8f",
    },
    dark: {
      bg: "#12100f",
      surface: "#1b1618",
      "surface-2": "#201b1e",
      rule: "#2e262a",
      "rule-strong": "#433840",
      "ink-2": "#b3a6ac",
      "ink-3": "#857a80",
      accent: "#ec8fb3",
      "accent-soft": "#341a26",
      "ansi-cyan": "#ec8fb3",
      "ansi-bright-cyan": "#f4b0ca",
    },
  },
  mono: {
    light: {
      bg: "#f4f4f4",
      "surface-2": "#ececec",
      rule: "#dcdcdc",
      "rule-strong": "#c4c4c4",
      "ink-2": "#505050",
      "ink-3": "#808080",
      accent: "#2b2b2b",
      "accent-soft": "#e4e4e4",
    },
    dark: {
      bg: "#101010",
      surface: "#181818",
      "surface-2": "#1f1f1f",
      rule: "#2a2a2a",
      "rule-strong": "#3d3d3d",
      "ink-2": "#a8a8a8",
      "ink-3": "#7c7c7c",
      accent: "#d8d8d8",
      "accent-soft": "#2c2c2c",
    },
  },
};

/** Every colour token of a palette, or of one of the user's own themes,
    for one appearance. A name that is neither is the default palette. */
export function coloursOf(
  palette: string,
  appearance: Appearance,
  themes: Record<string, CustomTheme> = {},
): Record<string, string> {
  const own = Object.hasOwn(themes, palette) ? themes[palette][appearance] : undefined;
  const built = Object.hasOwn(PALETTE_COLOURS, palette) ? PALETTE_COLOURS[palette][appearance] : {};
  return { ...DEFAULTS[appearance], ...built, ...(own ?? {}) };
}
