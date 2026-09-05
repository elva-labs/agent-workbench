import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PALETTES,
  cycleTheme,
  loadTheme,
  resolvedTheme,
  setPalette,
  setTheme,
  theme,
} from "$lib/theme.svelte";

beforeEach(() => {
  theme.choice = "system";
  theme.palette = "teal";
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.palette;
  localStorage.clear();
});

describe("setTheme", () => {
  it("stamps data-theme for an explicit choice", () => {
    setTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    setTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  // System is the absence of a stamp, so prefers-color-scheme can win.
  it("removes the stamp for system", () => {
    setTheme("dark");
    setTheme("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("persists the choice", () => {
    setTheme("dark");
    expect(localStorage.getItem("workbench.theme")).toBe("dark");
  });
});

describe("setPalette", () => {
  it("stamps data-palette for a palette other than teal", () => {
    setPalette("indigo");
    expect(document.documentElement.dataset.palette).toBe("indigo");
    expect(theme.palette).toBe("indigo");
    setPalette("teal");
    expect(document.documentElement.dataset.palette).toBeUndefined();
  });

  it("persists the palette and restores it", () => {
    setPalette("amber");
    theme.palette = "teal";
    loadTheme();
    expect(theme.palette).toBe("amber");
    expect(document.documentElement.dataset.palette).toBe("amber");
  });

  it("ignores a palette it does not know", () => {
    localStorage.setItem("workbench.palette", "plaid");
    theme.palette = "teal";
    loadTheme();
    expect(theme.palette).toBe("teal");
  });

  it("lists every palette with a swatch for each appearance", () => {
    expect(PALETTES.map((p) => p.name)).toEqual(["teal", "indigo", "amber", "rose", "mono"]);
    for (const palette of PALETTES) {
      expect(palette.swatch.light).toMatch(/^#[0-9a-f]{6}$/);
      expect(palette.swatch.dark).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("cycleTheme", () => {
  it("goes light, dark, system and back", () => {
    setTheme("light");
    cycleTheme();
    expect(theme.choice).toBe("dark");
    cycleTheme();
    expect(theme.choice).toBe("system");
    cycleTheme();
    expect(theme.choice).toBe("light");
  });
});

describe("loadTheme", () => {
  it("restores a stored choice and applies it", () => {
    localStorage.setItem("workbench.theme", "dark");
    loadTheme();
    expect(theme.choice).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("falls back to system for an unrecognised value", () => {
    localStorage.setItem("workbench.theme", "solarized");
    loadTheme();
    expect(theme.choice).toBe("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("does not throw when storage reads fail", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => loadTheme()).not.toThrow();
    expect(theme.choice).toBe("system");
  });
});

describe("resolvedTheme", () => {
  it("returns the explicit choice unchanged", () => {
    setTheme("light");
    expect(resolvedTheme()).toBe("light");
    setTheme("dark");
    expect(resolvedTheme()).toBe("dark");
  });

  it("asks the system when the choice is system", () => {
    setTheme("system");
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    expect(resolvedTheme()).toBe("dark");
  });
});
