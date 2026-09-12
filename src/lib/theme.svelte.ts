/**
 * Theme choice, in four parts. Appearance: `system` follows
 * prefers-color-scheme and stamps nothing; an explicit choice stamps
 * data-theme on <html> so the CSS override wins. Palette: which colours,
 * stamped as data-palette; teal is the one tokens.css is written in and
 * stamps nothing. Look: the shape of the chrome, stamped as data-look, with
 * terminal the one tokens.css is written in. Fonts: the terminal's family
 * and the interface's, stamped as data-mono and data-sans, with the Plex
 * pair the ones tokens.css is written in.
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

/** Both looks, in the order the settings show them. */
export const LOOKS: LookInfo[] = [
  {
    name: "terminal",
    label: "Terminal",
    hint: "Mono chrome, small capitals, square corners, panes as boxes",
  },
  {
    name: "modern",
    label: "Modern",
    hint: "The sans, sentence case, soft corners, the panes as cards on one canvas",
  },
];

/** The families the terminal can draw with. */
export const TERMINAL_FONTS: FontInfo<MonoName>[] = [
  { name: "plex", label: "IBM Plex Mono", family: "var(--mono-plex)", hint: "" },
  { name: "jetbrains", label: "JetBrains Mono", family: "var(--mono-jetbrains)", hint: "" },
  { name: "system", label: "System", family: "var(--mono-system)", hint: "what the machine has" },
];

/** The families the chrome can be set in. */
export const INTERFACE_FONTS: FontInfo<SansName>[] = [
  { name: "plex", label: "IBM Plex Sans", family: "var(--sans-plex)", hint: "" },
  { name: "inter", label: "Inter", family: "var(--sans-inter)", hint: "" },
  { name: "system", label: "System", family: "var(--sans-system)", hint: "what the machine has" },
];

const KEY = "workbench.theme";
const PALETTE_KEY = "workbench.palette";
const LOOK_KEY = "workbench.look";
const MONO_KEY = "workbench.mono";
const SANS_KEY = "workbench.sans";

export const theme = $state<{
  choice: ThemeChoice;
  palette: PaletteName;
  look: LookName;
  mono: MonoName;
  sans: SansName;
}>({
  choice: "system",
  palette: "teal",
  look: "terminal",
  mono: "plex",
  sans: "plex",
});

function isPalette(value: unknown): value is PaletteName {
  return PALETTES.some((palette) => palette.name === value);
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

/** Keeps a choice for the next start. A storage that refuses is not fatal:
    the choice holds for this window and is gone at the next one. */
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Non-fatal: the choice does not survive a restart.
  }
}

export function setPalette(palette: PaletteName) {
  theme.palette = palette;
  remember(PALETTE_KEY, palette);
  applyTheme();
}

export function setLook(look: LookName) {
  theme.look = look;
  remember(LOOK_KEY, look);
  applyTheme();
}

export function setMono(mono: MonoName) {
  theme.mono = mono;
  remember(MONO_KEY, mono);
  applyTheme();
}

export function setSans(sans: SansName) {
  theme.sans = sans;
  remember(SANS_KEY, sans);
  applyTheme();
}

export function setTheme(choice: ThemeChoice) {
  theme.choice = choice;
  remember(KEY, choice);
  applyTheme();
}

/** Cycles light → dark → system. */
export function cycleTheme() {
  setTheme(theme.choice === "light" ? "dark" : theme.choice === "dark" ? "system" : "light");
}

function applyTheme() {
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
  if (theme.mono === "plex") {
    delete root.dataset.mono;
  } else {
    root.dataset.mono = theme.mono;
  }
  if (theme.sans === "plex") {
    delete root.dataset.sans;
  } else {
    root.dataset.sans = theme.sans;
  }
}

/** What the app is actually painting right now, system preference resolved. */
export function resolvedTheme(): "light" | "dark" {
  if (theme.choice !== "system") return theme.choice;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
