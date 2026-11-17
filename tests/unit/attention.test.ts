import { beforeEach, describe, expect, it, vi } from "vitest";
import { attention, badge, followFocus, resetAttention, tabFocused, windowFocused } from "$lib/attention.svelte";

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

  it("stays in front while a browser tab of the window holds the keyboard, until the window itself goes", () => {
    const stop = followFocus();
    window.dispatchEvent(new Event("blur"));
    tabFocused();
    expect(attention.focused).toBe(true);
    windowFocused(false);
    expect(attention.focused).toBe(false);
    // Back to the window with the keyboard still in the tab.
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    windowFocused(true);
    expect(attention.focused).toBe(true);
    // The page takes the keyboard back, then loses it to another app.
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("blur"));
    expect(attention.focused).toBe(false);
    vi.restoreAllMocks();
    stop();
  });

  it("goes when the page loses the keyboard to nothing in the window", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const stop = followFocus();
    // The system says the window is in front, with the page holding the
    // keyboard.
    windowFocused(true);
    window.dispatchEvent(new Event("blur"));
    expect(attention.focused).toBe(false);
    vi.restoreAllMocks();
    stop();
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
