import type { Settings } from "$lib/core";
import { themeCss, validThemes, type CustomTheme } from "$lib/customThemes";
import { persist } from "$lib/persist";

/**
 * Theme choice, in four parts. Appearance: `system` follows
 * prefers-color-scheme and stamps nothing; an explicit choice stamps
 * data-theme on <html> so the CSS override wins. Palette: which colours,
 * stamped as data-palette; teal is the one tokens.css is written in and
 * stamps nothing. Look: the shape of the chrome, stamped as data-look, with
 * terminal the one tokens.css is written in. Fonts: the terminal's family
 * and the interface's, stamped as data-mono and data-sans, with the machine's own
 * pair the ones tokens.css is written in.
 *
 * A palette may also be one of the user's own themes, painted from a
 * stylesheet the window writes into the page; see customThemes.ts.
 *
 * The core keeps the choice for the machine. The window keeps a copy of
 * its own as well, read before the core has answered, so the first frame
 * is painted in the colours the last one was.
 */
export type ThemeChoice = "light" | "dark" | "system";
export type PaletteName = "teal" | "indigo" | "amber" | "rose" | "mono";
export type LookName = "terminal" | "modern";
export type MonoName = "plex" | "jetbrains" | "system";
export type SansName = "plex" | "inter" | "system";

export interface PaletteInfo {
  name: PaletteName;
  label: string;
  /** The accent, light and dark, for a swatch. */
  swatch: { light: string; dark: string };
}

export interface LookInfo {
  name: LookName;
  label: string;
  /** The line under the name, saying what the look does. */
  hint: string;
}

export interface FontInfo<Name extends string> {
  name: Name;
  label: string;
  /** The custom property holding the stack, so a choice can be shown in its own face. */
  family: string;
  /** A quiet word after the name, where there is one to say. */
  hint: string;
}

/** Every palette, in the order the settings show them. */
export const PALETTES: PaletteInfo[] = [
  { name: "teal", label: "Teal", swatch: { light: "#16706a", dark: "#58c0b4" } },
  { name: "indigo", label: "Indigo", swatch: { light: "#3f56b5", dark: "#8ea1ee" } },
  { name: "amber", label: "Amber", swatch: { light: "#a0651a", dark: "#e0b15c" } },
  { name: "rose", label: "Rose", swatch: { light: "#b0426b", dark: "#ec8fb3" } },
  { name: "mono", label: "Mono", swatch: { light: "#2b2b2b", dark: "#d8d8d8" } },
];

/** Both looks, in the order the settings show them: the one a fresh
    install wears first. */
export const LOOKS: LookInfo[] = [
  {
    name: "modern",
    label: "Modern",
    hint: "The sans, sentence case, soft corners, the panes flush with one hairline between",
  },
  {
    name: "terminal",
    label: "Terminal",
    hint: "Mono chrome, small capitals, square corners, panes as boxes",
  },
];

/** The families the terminal can draw with. */
export const TERMINAL_FONTS: FontInfo<MonoName>[] = [
  { name: "system", label: "System", family: "var(--mono-system)", hint: "what the machine has" },
  { name: "plex", label: "IBM Plex Mono", family: "var(--mono-plex)", hint: "" },
  { name: "jetbrains", label: "JetBrains Mono", family: "var(--mono-jetbrains)", hint: "" },
];

/** The families the chrome can be set in. */
export const INTERFACE_FONTS: FontInfo<SansName>[] = [
  { name: "system", label: "System", family: "var(--sans-system)", hint: "what the machine has" },
  { name: "plex", label: "IBM Plex Sans", family: "var(--sans-plex)", hint: "" },
  { name: "inter", label: "Inter", family: "var(--sans-inter)", hint: "" },
];

const KEY = "workbench.theme";
const PALETTE_KEY = "workbench.palette";
const LOOK_KEY = "workbench.look";
const MONO_KEY = "workbench.mono";
const SANS_KEY = "workbench.sans";
const THEMES_KEY = "workbench.themes";

export const theme = $state<{
  choice: ThemeChoice;
  /** One of the palettes, or the name of one of the user's own themes. */
  palette: string;
  look: LookName;
  mono: MonoName;
  sans: SansName;
  /** The user's own themes, by name. */
  themes: Record<string, CustomTheme>;
  /** Counts every repaint, for what reads the colours back from the page,
      such as a terminal, to follow. */
  painted: number;
}>({
  choice: "system",
  palette: "teal",
  look: "modern",
  mono: "system",
  sans: "system",
  themes: {},
  painted: 0,
});

function isPalette(value: unknown): value is string {
  return (
    PALETTES.some((palette) => palette.name === value) ||
    (typeof value === "string" && Object.hasOwn(theme.themes, value))
  );
}

function isLook(value: unknown): value is LookName {
  return LOOKS.some((look) => look.name === value);
}

function isMono(value: unknown): value is MonoName {
  return TERMINAL_FONTS.some((font) => font.name === value);
}

function isSans(value: unknown): value is SansName {
  return INTERFACE_FONTS.some((font) => font.name === value);
}

export function loadTheme() {
  let stored: string | null = null;
  let palette: string | null = null;
  let look: string | null = null;
  let mono: string | null = null;
  let sans: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
    palette = localStorage.getItem(PALETTE_KEY);
    look = localStorage.getItem(LOOK_KEY);
    mono = localStorage.getItem(MONO_KEY);
    sans = localStorage.getItem(SANS_KEY);
    theme.themes = validThemes(JSON.parse(localStorage.getItem(THEMES_KEY) ?? "{}"));
  } catch {
    // Storage can throw in a locked-down webview. The defaults hold.
  }
  if (stored === "light" || stored === "dark" || stored === "system") {
    theme.choice = stored;
  }
  if (isPalette(palette)) theme.palette = palette;
  if (isLook(look)) theme.look = look;
  if (isMono(mono)) theme.mono = mono;
  if (isSans(sans)) theme.sans = sans;
  applyTheme();
}

/** Keeps the window's copy of a choice, for the first frame of the next
    start. A storage that refuses is not fatal: the core still has it. */
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Non-fatal: the next start paints the defaults until the core answers.
  }
}

function rememberAll() {
  remember(THEMES_KEY, JSON.stringify(theme.themes));
  remember(KEY, theme.choice);
  remember(PALETTE_KEY, theme.palette);
  remember(LOOK_KEY, theme.look);
  remember(MONO_KEY, theme.mono);
  remember(SANS_KEY, theme.sans);
}

export function setPalette(palette: string) {
  if (!isPalette(palette)) return;
  theme.palette = palette;
  remember(PALETTE_KEY, palette);
  applyTheme();
  persist({ palette });
}

export function setLook(look: LookName) {
  theme.look = look;
  remember(LOOK_KEY, look);
  applyTheme();
  persist({ look });
}

export function setMono(mono: MonoName) {
  theme.mono = mono;
  remember(MONO_KEY, mono);
  applyTheme();
  persist({ terminalFont: mono });
}

export function setSans(sans: SansName) {
  theme.sans = sans;
  remember(SANS_KEY, sans);
  applyTheme();
  persist({ interfaceFont: sans });
}

export function setTheme(choice: ThemeChoice) {
  theme.choice = choice;
  remember(KEY, choice);
  applyTheme();
  persist({ appearance: choice });
}

/** Keeps a new set of the user's own themes, and the palette with them:
    one change, so a theme and the choice of it arrive together. A palette
    naming a theme the set no longer has goes back to the default. */
export function setThemes(themes: Record<string, CustomTheme>, palette = theme.palette) {
  theme.themes = validThemes(themes);
  theme.palette = isPalette(palette) ? palette : "teal";
  rememberAll();
  applyTheme();
  persist({ themes: { ...theme.themes }, palette: theme.palette });
}

/** Takes one of the user's own themes away. */
export function deleteTheme(name: string) {
  const { [name]: _gone, ...kept } = theme.themes;
  setThemes(kept);
}

type ThemeFields =
  | "appearance"
  | "look"
  | "palette"
  | "terminalFont"
  | "interfaceFont"
  | "themes";

/** The theme's part of the settings. */
export function themeSettings(): Pick<Settings, ThemeFields> {
  return {
    appearance: theme.choice,
    look: theme.look,
    palette: theme.palette,
    terminalFont: theme.mono,
    interfaceFont: theme.sans,
    themes: { ...theme.themes },
  };
}

/** Takes the theme the core has for the machine: each part it knows, the
    rest left as it is. Nothing is sent back, since this is the core's word. */
export function adoptTheme(settings: Partial<Pick<Settings, ThemeFields>>) {
  const choice: unknown = settings.appearance;
  if (choice === "light" || choice === "dark" || choice === "system") {
    theme.choice = choice;
  }
  if (settings.themes !== undefined) theme.themes = validThemes(settings.themes);
  if (isPalette(settings.palette)) theme.palette = settings.palette;
  else if (!isPalette(theme.palette)) theme.palette = "teal";
  if (isLook(settings.look)) theme.look = settings.look;
  if (isMono(settings.terminalFont)) theme.mono = settings.terminalFont;
  if (isSans(settings.interfaceFont)) theme.sans = settings.interfaceFont;
  rememberAll();
  applyTheme();
}

/** Cycles light → dark → system. */
export function cycleTheme() {
  setTheme(theme.choice === "light" ? "dark" : theme.choice === "dark" ? "system" : "light");
}

/** The stylesheet the user's own themes are painted from, written last
    into the page's head. */
function paintThemes() {
  const id = "workbench-themes";
  let sheet = document.getElementById(id);
  if (sheet === null) {
    sheet = document.createElement("style");
    sheet.id = id;
    document.head.appendChild(sheet);
  }
  const css = themeCss(theme.themes);
  if (sheet.textContent !== css) sheet.textContent = css;
}

function applyTheme() {
  paintThemes();
  const root = document.documentElement;
  if (theme.choice === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme.choice;
  }
  if (theme.palette === "teal") {
    delete root.dataset.palette;
  } else {
    root.dataset.palette = theme.palette;
  }
  if (theme.look === "terminal") {
    delete root.dataset.look;
  } else {
    root.dataset.look = theme.look;
  }
  if (theme.mono === "system") {
    delete root.dataset.mono;
  } else {
    root.dataset.mono = theme.mono;
  }
  if (theme.sans === "system") {
    delete root.dataset.sans;
  } else {
    root.dataset.sans = theme.sans;
  }
  theme.painted += 1;
}

/** What the app is actually painting right now, system preference resolved. */
export function resolvedTheme(): "light" | "dark" {
  if (theme.choice !== "system") return theme.choice;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
