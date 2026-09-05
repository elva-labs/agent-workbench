/**
 * Theme choice, in two parts. Appearance: `system` follows
 * prefers-color-scheme and stamps nothing; an explicit choice stamps
 * data-theme on <html> so the CSS override wins. Palette: which colours,
 * stamped as data-palette; teal is the one tokens.css is written in and
 * stamps nothing.
 */
export type ThemeChoice = "light" | "dark" | "system";
export type PaletteName = "teal" | "indigo" | "amber" | "rose" | "mono";

export interface PaletteInfo {
  name: PaletteName;
  label: string;
  /** The accent, light and dark, for a swatch. */
  swatch: { light: string; dark: string };
}

/** Every palette, in the order the settings show them. */
export const PALETTES: PaletteInfo[] = [
  { name: "teal", label: "Teal", swatch: { light: "#16706a", dark: "#58c0b4" } },
  { name: "indigo", label: "Indigo", swatch: { light: "#3f56b5", dark: "#8ea1ee" } },
  { name: "amber", label: "Amber", swatch: { light: "#a0651a", dark: "#e0b15c" } },
  { name: "rose", label: "Rose", swatch: { light: "#b0426b", dark: "#ec8fb3" } },
  { name: "mono", label: "Mono", swatch: { light: "#2b2b2b", dark: "#d8d8d8" } },
];

const KEY = "workbench.theme";
const PALETTE_KEY = "workbench.palette";

export const theme = $state<{ choice: ThemeChoice; palette: PaletteName }>({
  choice: "system",
  palette: "teal",
});

function isPalette(value: unknown): value is PaletteName {
  return PALETTES.some((palette) => palette.name === value);
}

export function loadTheme() {
  let stored: string | null = null;
  let palette: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
    palette = localStorage.getItem(PALETTE_KEY);
  } catch {
    stored = null;
  }
  if (stored === "light" || stored === "dark" || stored === "system") {
    theme.choice = stored;
  }
  if (isPalette(palette)) theme.palette = palette;
  applyTheme();
}

export function setPalette(palette: PaletteName) {
  theme.palette = palette;
  try {
    localStorage.setItem(PALETTE_KEY, palette);
  } catch {
    // Non-fatal: the choice does not survive a restart.
  }
  applyTheme();
}

export function setTheme(choice: ThemeChoice) {
  theme.choice = choice;
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Storage can throw in a locked-down webview. The in-memory choice still holds.
  }
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
}

/** What the app is actually painting right now, system preference resolved. */
export function resolvedTheme(): "light" | "dark" {
  if (theme.choice !== "system") return theme.choice;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
