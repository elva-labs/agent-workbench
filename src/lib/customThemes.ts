/**
 * Themes of the user's own: token values laid over the default palette.
 *
 * A theme sets colour tokens for the light appearance and the dark, and a
 * few measures of the chrome's shape, and nothing else. The core checks a
 * theme before it keeps it; the window checks it again before a line of it
 * reaches a stylesheet, so a hand-edited file can recolour the window and
 * no more. The rules are the core's, in the same words.
 *
 * A theme is written into the page the way palettes.css writes a palette:
 * its light colours on the bare stamp, its dark ones under the system
 * preference unless light was chosen and again under the explicit choice.
 * A token the theme sets for light and not for dark takes the default
 * palette's dark value there, so light colours never reach the dark
 * appearance. The selectors carry one more `:root` than the palettes', so a
 * theme holds over whichever look is on.
 */

export interface CustomTheme {
  label: string;
  light: Record<string, string>;
  dark: Record<string, string>;
  shape: Record<string, string>;
}

export const COLOUR_TOKENS = [
  "bg",
  "surface",
  "surface-2",
  "ink",
  "ink-2",
  "ink-3",
  "rule",
  "rule-strong",
  "accent",
  "accent-soft",
  "add",
  "del",
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

/** The measures a theme may set, with the most each may be, in pixels. */
export const SHAPE_TOKENS: Record<string, number> = {
  radius: 16,
  "radius-sm": 12,
  "radius-tag": 12,
  "pane-pad": 24,
};

/** The palettes the app has, which no theme may be called. */
export const BUILT_IN = ["teal", "indigo", "amber", "rose", "mono"];

/** The default palette's colours, as tokens.css has them. */
export const DEFAULTS: Record<"light" | "dark", Record<string, string>> = {
  light: {
    bg: "#f4f6f5",
    surface: "#ffffff",
    "surface-2": "#edf1f0",
    ink: "#14181a",
    "ink-2": "#4e5a59",
    "ink-3": "#7d8988",
    rule: "#dce3e1",
    "rule-strong": "#c3cdcb",
    accent: "#16706a",
    "accent-soft": "#e2efed",
    add: "#2e6b3f",
    del: "#9b3a47",
    "ansi-black": "#14181a",
    "ansi-red": "#9b3a47",
    "ansi-green": "#2e6b3f",
    "ansi-yellow": "#8a6a1f",
    "ansi-blue": "#2f5aa8",
    "ansi-magenta": "#7a4a8c",
    "ansi-cyan": "#16706a",
    "ansi-white": "#4e5a59",
    "ansi-bright-black": "#3a4244",
    "ansi-bright-red": "#be5766",
    "ansi-bright-green": "#43895a",
    "ansi-bright-yellow": "#a9853a",
    "ansi-bright-blue": "#4c76c4",
    "ansi-bright-magenta": "#9765a8",
    "ansi-bright-cyan": "#2a8c85",
    "ansi-bright-white": "#7d8988",
  },
  dark: {
    bg: "#0e1112",
    surface: "#171b1c",
    "surface-2": "#1e2425",
    ink: "#e6eae9",
    "ink-2": "#a3aeac",
    "ink-3": "#788483",
    rule: "#262d2e",
    "rule-strong": "#394243",
    accent: "#58c0b4",
    "accent-soft": "#15302e",
    add: "#7fbf8c",
    del: "#e08894",
    "ansi-black": "#3a4244",
    "ansi-red": "#e08894",
    "ansi-green": "#7fbf8c",
    "ansi-yellow": "#d8b45e",
    "ansi-blue": "#86a9e8",
    "ansi-magenta": "#c39ad4",
    "ansi-cyan": "#58c0b4",
    "ansi-white": "#e6eae9",
    "ansi-bright-black": "#55605f",
    "ansi-bright-red": "#eda4ad",
    "ansi-bright-green": "#9bd3a5",
    "ansi-bright-yellow": "#e8cb86",
    "ansi-bright-blue": "#a4c0f0",
    "ansi-bright-magenta": "#d5b4e2",
    "ansi-bright-cyan": "#7bd3c8",
    "ansi-bright-white": "#f4f7f6",
  },
};

export function isColour(value: unknown): value is string {
  return typeof value === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

function isPixels(value: unknown, most: number): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{1,3})px$/.exec(value);
  return match !== null && Number(match[1]) <= most;
}

export function isThemeName(name: string): boolean {
  return /^[a-z][a-z0-9-]{0,31}$/.test(name) && !BUILT_IN.includes(name);
}

function colours(name: string, appearance: string, value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`The ${appearance} colours of ${name} are a table of tokens.`);
  }
  const out: Record<string, string> = {};
  for (const [token, colour] of Object.entries(value)) {
    if (!(COLOUR_TOKENS as readonly string[]).includes(token)) {
      throw new Error(
        `${token} is not a colour a theme sets; it sets ${COLOUR_TOKENS.join(", ")}.`,
      );
    }
    if (!isColour(colour)) {
      throw new Error(
        `${token} in the ${appearance} colours of ${name} is a hex colour such as #1a2b3c, not ${JSON.stringify(colour)}.`,
      );
    }
    out[token] = colour.toLowerCase();
  }
  return out;
}

function shape(name: string, value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`The shape of ${name} is a table of tokens.`);
  }
  const out: Record<string, string> = {};
  for (const [token, measure] of Object.entries(value)) {
    const most = SHAPE_TOKENS[token];
    if (most === undefined) {
      throw new Error(
        `${token} is not a measure a theme sets; it sets ${Object.keys(SHAPE_TOKENS).join(", ")}.`,
      );
    }
    if (!isPixels(measure, most)) {
      throw new Error(
        `${token} in the shape of ${name} is whole pixels up to ${most}px, such as 6px, not ${JSON.stringify(measure)}.`,
      );
    }
    out[token] = measure;
  }
  return out;
}

/** A theme as the rules take it, or the reason it will not do. */
export function checkTheme(name: string, value: unknown): CustomTheme {
  if (!isThemeName(name)) {
    throw new Error(
      `${JSON.stringify(name)} is not a theme's name: lower-case letters, digits and dashes, starting with a letter, and none of ${BUILT_IN.join(", ")}.`,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`The theme ${name} is a table of a label, colours and a shape.`);
  }
  const fields = value as Record<string, unknown>;
  const other = Object.keys(fields).find(
    (field) => !["label", "light", "dark", "shape"].includes(field),
  );
  if (other !== undefined) {
    throw new Error(`A theme has a label, light, dark and shape, not ${other}.`);
  }
  let label = name;
  if (fields.label !== undefined) {
    if (
      typeof fields.label !== "string" ||
      fields.label.trim() === "" ||
      fields.label.length > 40
    ) {
      throw new Error(`The label of ${name} is a few words, 40 characters at most.`);
    }
    label = fields.label.trim();
  }
  return {
    label,
    light: colours(name, "light", fields.light),
    dark: colours(name, "dark", fields.dark),
    shape: shape(name, fields.shape),
  };
}

/** The themes in a table that pass the rules, the rest left out. */
export function validThemes(value: unknown): Record<string, CustomTheme> {
  const out: Record<string, CustomTheme> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [name, theme] of Object.entries(value)) {
    try {
      out[name] = checkTheme(name, theme);
    } catch {
      // A theme that does not pass is not painted.
    }
  }
  return out;
}

function channel(hex: number): number {
  const c = hex / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(colour: string): number {
  let digits = colour.slice(1);
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join("");
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The contrast between two hex colours, 1 to 21, as WCAG reckons it. */
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** The reason a theme would be hard to read, or null. Each appearance is
    judged with the default palette's colours standing in for what the
    theme leaves out. */
export function readability(theme: CustomTheme): string | null {
  for (const appearance of ["light", "dark"] as const) {
    const colour = (token: string) => theme[appearance][token] ?? DEFAULTS[appearance][token];
    const pairs: [string, string, number][] = [
      ["ink", "surface", 4.5],
      ["ink", "bg", 4.5],
      ["accent", "surface", 3],
    ];
    for (const [fore, back, least] of pairs) {
      const ratio = contrast(colour(fore), colour(back));
      if (ratio < least) {
        return `In the ${appearance} appearance, ${fore} on ${back} has a contrast of ${ratio.toFixed(1)} to 1; it needs ${least} to 1 to be read.`;
      }
    }
  }
  return null;
}

function block(selector: string, tokens: Record<string, string>): string {
  const lines = Object.entries(tokens).map(([token, value]) => `  --${token}: ${value};`);
  return lines.length === 0 ? "" : `${selector} {\n${lines.join("\n")}\n}\n`;
}

/** The stylesheet that paints every theme, each under its own stamp. */
export function themeCss(themes: Record<string, CustomTheme>): string {
  let css = "";
  for (const [name, raw] of Object.entries(themes)) {
    let theme: CustomTheme;
    try {
      theme = checkTheme(name, raw);
    } catch {
      continue;
    }
    const stamp = `:root:root[data-palette="${name}"]`;
    const dark: Record<string, string> = {};
    for (const token of new Set([...Object.keys(theme.light), ...Object.keys(theme.dark)])) {
      dark[token] = theme.dark[token] ?? DEFAULTS.dark[token];
    }
    css += block(stamp, { ...theme.light, ...theme.shape });
    const darkBlock = block(`  ${stamp}:not([data-theme="light"])`, dark);
    if (darkBlock !== "") {
      css += `@media (prefers-color-scheme: dark) {\n${darkBlock}}\n`;
    }
    css += block(`${stamp}[data-theme="dark"]`, dark);
  }
  return css;
}
