import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Background } from "$lib/background";
import * as paint from "$lib/backgroundPaint";
import { pageColours, sameTheme } from "$lib/terminal";
import {
  adoptTheme,
  endPreview,
  previewBackground,
  previewCards,
  setBackground,
  setCards,
  setPalette,
  setTheme,
  theme,
} from "$lib/theme.svelte";

/**
 * The work a repaint does, counted: what the terminals follow is counted
 * as a repaint only when it can change their colours, the background's
 * sheet is worked out once for what it is worked out from, and the page's
 * colours are read back once a repaint however many terminals ask.
 */

vi.mock("$lib/backgroundPaint", async (original) => {
  const actual = await original<typeof import("$lib/backgroundPaint")>();
  return { ...actual, backgroundCss: vi.fn(actual.backgroundCss) };
});

const LAGOON: Background = {
  dots: [
    { hue: 192, chroma: 0.9 },
    { hue: 252, chroma: 0.8 },
  ],
  harmony: "free",
  strength: 0.6,
  grain: 0.25,
};

const worked = () => vi.mocked(paint.backgroundCss).mock.calls.length;

beforeEach(() => {
  theme.palette = "teal";
  theme.themes = {};
  theme.backgrounds = {};
  theme.cards = {};
  theme.preview = null;
  theme.choice = "system";
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("what the terminals follow", () => {
  it("counts no repaint while only a background or the cards' share moves", () => {
    setPalette("rose");
    const before = theme.painted;
    setBackground(LAGOON);
    previewBackground({ ...LAGOON, strength: 0.4 });
    previewCards(0.1);
    setCards(0.2);
    previewCards(0.04);
    endPreview();
    setBackground(null);
    expect(theme.painted).toBe(before);
  });

  it("counts a repaint when the colours they read can change", () => {
    setTheme("light");
    setPalette("teal");
    const before = theme.painted;
    setPalette("rose");
    setTheme("dark");
    setTheme("dark");
    expect(theme.painted).toBe(before + 2);
  });

  it("counts no repaint when the same settings are taken again", () => {
    adoptTheme({ appearance: "dark", palette: "rose", backgrounds: { rose: LAGOON }, cards: { rose: 0.1 } });
    const before = theme.painted;
    adoptTheme({ appearance: "dark", palette: "rose", backgrounds: { rose: LAGOON }, cards: { rose: 0.1 } });
    expect(theme.painted).toBe(before);
  });
});

describe("the background's sheet", () => {
  it("is worked out once for the same background, colours and share", () => {
    adoptTheme({ appearance: "dark", palette: "rose", backgrounds: { rose: LAGOON }, cards: { rose: 0.1 } });
    const once = worked();
    adoptTheme({ appearance: "dark", palette: "rose", backgrounds: { rose: LAGOON }, cards: { rose: 0.1 } });
    adoptTheme({ appearance: "dark" });
    expect(worked()).toBe(once);
    expect(document.documentElement.dataset.background).toBe("");
    adoptTheme({ cards: { rose: 0.2 } });
    expect(worked()).toBe(once + 1);
  });

  it("is worked out for each step of a share being picked, and not again for one picked twice", () => {
    adoptTheme({ appearance: "dark", palette: "rose", backgrounds: { rose: LAGOON }, cards: {} });
    const before = worked();
    previewCards(0.1);
    previewCards(0.12);
    previewCards(0.12);
    expect(worked()).toBe(before + 2);
    endPreview();
  });
});

describe("the page's colours for the terminals", () => {
  it("are read back once a repaint, however many terminals ask", () => {
    const read = vi.spyOn(window, "getComputedStyle");
    const painted = theme.painted + 1000;
    for (let i = 0; i < 12; i++) pageColours(painted, false);
    expect(read).toHaveBeenCalledTimes(1);
    pageColours(painted, true);
    pageColours(painted, true);
    expect(read).toHaveBeenCalledTimes(2);
    pageColours(painted + 1, false);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("are the same theme when every colour is", () => {
    const one = pageColours(theme.painted + 2000, false);
    expect(sameTheme({ ...one }, one)).toBe(true);
    expect(sameTheme({ ...one, cursor: "#000000" }, one)).toBe(false);
    expect(sameTheme(undefined, one)).toBe(false);
    expect(sameTheme({ ...one, extendedAnsi: ["#111111"] }, { ...one, extendedAnsi: ["#111111"] })).toBe(true);
  });
});
