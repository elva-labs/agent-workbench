import { beforeEach, describe, expect, it, vi } from "vitest";
import { attention, badge, followFocus, resetAttention } from "$lib/attention.svelte";

const badges: (number | null)[] = [];
vi.mock("$lib/core", () => ({
  core: () => ({
    setBadge: async (count: number | null) => {
      badges.push(count);
    },
  }),
}));

beforeEach(() => {
  resetAttention();
  badges.length = 0;
});

describe("the window's focus", () => {
  it("follows focus and blur", () => {
    const stop = followFocus();
    window.dispatchEvent(new Event("blur"));
    expect(attention.focused).toBe(false);
    window.dispatchEvent(new Event("focus"));
    expect(attention.focused).toBe(true);
    stop();
    window.dispatchEvent(new Event("blur"));
    expect(attention.focused).toBe(true);
  });
});

describe("the badge", () => {
  it("puts a count on the icon once per change, and none for zero", () => {
    badge(0);
    badge(2);
    badge(2);
    badge(3);
    badge(0);
    expect(badges).toEqual([2, 3, null]);
  });
});
