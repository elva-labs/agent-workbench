import { beforeEach, describe, expect, it, vi } from "vitest";
import { cycleTheme, loadTheme, resolvedTheme, setTheme, theme } from "$lib/theme.svelte";

beforeEach(() => {
  theme.choice = "system";
  delete document.documentElement.dataset.theme;
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
