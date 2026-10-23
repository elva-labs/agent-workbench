import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SIZE,
  MAX_SIZE,
  MIN_SIZE,
  MOST_KEPT,
  identifiedZoom,
  loadZoom,
  resetZoom,
  sizeOf,
  stepped,
  zoom,
  zoomed,
} from "$lib/zoom.svelte";

const KEY = "workbench.zoom";

beforeEach(() => {
  resetZoom();
  localStorage.clear();
});

describe("a step", () => {
  it("is a pixel either way within the bounds, or back to the default", () => {
    expect(stepped(12, 1)).toBe(13);
    expect(stepped(12, -1)).toBe(11);
    expect(stepped(MAX_SIZE, 1)).toBe(MAX_SIZE);
    expect(stepped(MIN_SIZE, -1)).toBe(MIN_SIZE);
    expect(stepped(20, 0)).toBe(DEFAULT_SIZE);
  });
});

describe("a terminal's size", () => {
  it("starts at the default and follows its own steps alone", () => {
    expect(sizeOf("s1", "id-1")).toBe(DEFAULT_SIZE);
    expect(zoomed("s1", "id-1", 1)).toBe(13);
    expect(sizeOf("s1", "id-1")).toBe(13);
    expect(sizeOf("s2", "id-2")).toBe(DEFAULT_SIZE);
  });

  it("is kept by the session's id, for a new row after a restart", () => {
    zoomed("s1", "id-1", 1);
    zoomed("s1", "id-1", 1);
    resetZoom();
    loadZoom();
    expect(sizeOf("s9", "id-1")).toBe(14);
  });

  it("is not kept for a shell", () => {
    zoomed("t1", null, 1);
    expect(sizeOf("t1")).toBe(13);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("is forgotten once it is back at the default", () => {
    zoomed("s1", "id-1", 1);
    zoomed("s1", "id-1", 0);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({});
  });

  it("set before the id was known is kept under the id once it is", () => {
    zoomed("s1", null, -1);
    identifiedZoom("s1", "minted", 5);
    resetZoom();
    loadZoom();
    expect(sizeOf("s2", "minted")).toBe(11);
  });

  it("is kept for the most recently changed sessions only", () => {
    for (let i = 0; i <= MOST_KEPT; i += 1) zoomed(`s${i}`, `id-${i}`, 1, i);
    expect(Object.keys(zoom.kept)).toHaveLength(MOST_KEPT);
    expect(zoom.kept["id-0"]).toBeUndefined();
    expect(zoom.kept[`id-${MOST_KEPT}`]?.size).toBe(13);
  });

  it("passes over what it cannot read", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ a: { size: 99, at: 1 }, b: { size: 14, at: 2 }, c: "x" }),
    );
    loadZoom();
    expect(zoom.kept).toEqual({ b: { size: 14, at: 2 } });
    localStorage.setItem(KEY, '{"__proto__":{"size":14,"at":1},"d":{"size":13.5,"at":1}}');
    resetZoom();
    loadZoom();
    expect(zoom.kept).toEqual({});
    expect(Object.getPrototypeOf(zoom.kept)).not.toEqual({ size: 14, at: 1 });
    for (const bad of ["[]", "null"]) {
      localStorage.setItem(KEY, bad);
      resetZoom();
      loadZoom();
      expect(zoom.kept).toEqual({});
    }
    localStorage.setItem(KEY, "{not json");
    resetZoom();
    loadZoom();
    expect(zoom.kept).toEqual({});
  });

  it("prefers its row's own size to the one kept for its id", () => {
    zoom.kept["id-1"] = { size: 15, at: 1 };
    expect(sizeOf("s1", "id-1")).toBe(15);
    zoom.rows["s1"] = 9;
    expect(sizeOf("s1", "id-1")).toBe(9);
  });

  it("keeps nothing for an id when its row has no size", () => {
    identifiedZoom("s1", "minted", 5);
    expect(zoom.kept).toEqual({});
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("is trimmed to the most recent when loaded over-full", () => {
    const stored: Record<string, { size: number; at: number }> = {};
    for (let i = 0; i <= MOST_KEPT; i += 1) stored[`id-${i}`] = { size: 13, at: i };
    localStorage.setItem(KEY, JSON.stringify(stored));
    loadZoom();
    expect(Object.keys(zoom.kept)).toHaveLength(MOST_KEPT);
    expect(zoom.kept["id-0"]).toBeUndefined();
  });
});
