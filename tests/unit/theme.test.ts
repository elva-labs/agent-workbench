import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTERFACE_FONTS,
  LOOKS,
  PALETTES,
  TERMINAL_FONTS,
  cycleTheme,
  loadTheme,
  resolvedTheme,
  setLook,
  setMono,
  setPalette,
  setSans,
  setTheme,
  theme,
} from "$lib/theme.svelte";

beforeEach(() => {
  theme.choice = "system";
  theme.palette = "teal";
  theme.look = "terminal";
  theme.mono = "plex";
  theme.sans = "plex";
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.palette;
  delete document.documentElement.dataset.look;
  delete document.documentElement.dataset.mono;
  delete document.documentElement.dataset.sans;
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

describe("setLook", () => {
  it("stamps data-look for modern and nothing for terminal", () => {
    setLook("modern");
    expect(document.documentElement.dataset.look).toBe("modern");
    expect(theme.look).toBe("modern");
    setLook("terminal");
    expect(document.documentElement.dataset.look).toBeUndefined();
  });

  it("persists the look and restores it", () => {
    setLook("modern");
    expect(localStorage.getItem("workbench.look")).toBe("modern");
    theme.look = "terminal";
    loadTheme();
    expect(theme.look).toBe("modern");
    expect(document.documentElement.dataset.look).toBe("modern");
  });

  it("ignores a look it does not know", () => {
    localStorage.setItem("workbench.look", "brutalist");
    loadTheme();
    expect(theme.look).toBe("terminal");
  });

  it("lists both looks with a line each", () => {
    expect(LOOKS.map((look) => look.name)).toEqual(["terminal", "modern"]);
    for (const look of LOOKS) expect(look.hint).not.toBe("");
  });
});

describe("setMono", () => {
  it("stamps data-mono for a family other than plex", () => {
    setMono("jetbrains");
    expect(document.documentElement.dataset.mono).toBe("jetbrains");
    setMono("system");
    expect(document.documentElement.dataset.mono).toBe("system");
    setMono("plex");
    expect(document.documentElement.dataset.mono).toBeUndefined();
  });

  it("persists the family and restores it", () => {
    setMono("jetbrains");
    expect(localStorage.getItem("workbench.mono")).toBe("jetbrains");
    theme.mono = "plex";
    loadTheme();
    expect(theme.mono).toBe("jetbrains");
    expect(document.documentElement.dataset.mono).toBe("jetbrains");
  });

  it("ignores a family it does not ship", () => {
    localStorage.setItem("workbench.mono", "comic");
    loadTheme();
    expect(theme.mono).toBe("plex");
  });
});

describe("setSans", () => {
  it("stamps data-sans for a family other than plex", () => {
    setSans("inter");
    expect(document.documentElement.dataset.sans).toBe("inter");
    setSans("system");
    expect(document.documentElement.dataset.sans).toBe("system");
    setSans("plex");
    expect(document.documentElement.dataset.sans).toBeUndefined();
  });

  it("persists the family and restores it", () => {
    setSans("inter");
    expect(localStorage.getItem("workbench.sans")).toBe("inter");
    theme.sans = "plex";
    loadTheme();
    expect(theme.sans).toBe("inter");
    expect(document.documentElement.dataset.sans).toBe("inter");
  });

  it("ignores a family it does not ship", () => {
    localStorage.setItem("workbench.sans", "comic");
    loadTheme();
    expect(theme.sans).toBe("plex");
  });
});

describe("the font lists", () => {
  it("name every family and point at the stack it is set in", () => {
    expect(TERMINAL_FONTS.map((font) => font.name)).toEqual(["plex", "jetbrains", "system"]);
    expect(INTERFACE_FONTS.map((font) => font.name)).toEqual(["plex", "inter", "system"]);
    for (const font of TERMINAL_FONTS) expect(font.family).toBe(`var(--mono-${font.name})`);
    for (const font of INTERFACE_FONTS) expect(font.family).toBe(`var(--sans-${font.name})`);
  });

  // The stacks live in the stylesheet; the lists only name them.
  it("point at a stack the stylesheet defines", () => {
    const css = readFileSync(`${process.cwd()}/src/lib/styles/fonts.css`, "utf8");
    for (const font of [...TERMINAL_FONTS, ...INTERFACE_FONTS]) {
      expect(css).toContain(`${font.family.replace(/^var\(|\)$/g, "")}:`);
    }
  });

  it("say of system alone that it is the machine's", () => {
    for (const font of [...TERMINAL_FONTS, ...INTERFACE_FONTS]) {
      expect(font.hint === "").toBe(font.name !== "system");
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
