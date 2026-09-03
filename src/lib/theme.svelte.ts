/**
 * Theme choice. `system` follows prefers-color-scheme and stamps nothing;
 * an explicit choice stamps data-theme on <html> so the CSS override wins.
 */
export type ThemeChoice = "light" | "dark" | "system";

const KEY = "workbench.theme";

export const theme = $state<{ choice: ThemeChoice }>({ choice: "system" });

export function loadTheme() {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    stored = null;
  }
  if (stored === "light" || stored === "dark" || stored === "system") {
    theme.choice = stored;
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
}

/** What the app is actually painting right now, system preference resolved. */
export function resolvedTheme(): "light" | "dark" {
  if (theme.choice !== "system") return theme.choice;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
