import type { Settings } from "$lib/core";
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

export const theme = $state<{
  choice: ThemeChoice;
  palette: PaletteName;
  look: LookName;
  mono: MonoName;
  sans: SansName;
}>({
  choice: "system",
  palette: "teal",
  look: "modern",
  mono: "system",
  sans: "system",
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
  remember(KEY, theme.choice);
  remember(PALETTE_KEY, theme.palette);
  remember(LOOK_KEY, theme.look);
  remember(MONO_KEY, theme.mono);
  remember(SANS_KEY, theme.sans);
}

export function setPalette(palette: PaletteName) {
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

/** The theme's part of the settings. */
export function themeSettings(): Pick<
  Settings,
  "appearance" | "look" | "palette" | "terminalFont" | "interfaceFont"
> {
  return {
    appearance: theme.choice,
    look: theme.look,
    palette: theme.palette,
    terminalFont: theme.mono,
    interfaceFont: theme.sans,
  };
}

/** Takes the theme the core has for the machine: each part it knows, the
    rest left as it is. Nothing is sent back, since this is the core's word. */
export function adoptTheme(
  settings: Pick<
    Settings,
    "appearance" | "look" | "palette" | "terminalFont" | "interfaceFont"
  >,
) {
  const choice: unknown = settings.appearance;
  if (choice === "light" || choice === "dark" || choice === "system") {
    theme.choice = choice;
  }
  if (isPalette(settings.palette)) theme.palette = settings.palette;
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
}

/** What the app is actually painting right now, system preference resolved. */
export function resolvedTheme(): "light" | "dark" {
  if (theme.choice !== "system") return theme.choice;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
