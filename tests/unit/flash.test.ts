import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLASH_MS, flash, hold, letGo, resetFlash, say } from "$lib/flash.svelte";

beforeEach(() => {
  vi.useFakeTimers();
  resetFlash();
});

afterEach(() => vi.useRealTimers());

describe("a word in the status bar", () => {
  it("shows, then goes by itself", () => {
    say("13 px");
    expect(flash.text).toBe("13 px");
    vi.advanceTimersByTime(FLASH_MS);
    expect(flash.text).toBeNull();
  });

  it("is replaced by the next, which gets its own time", () => {
    say("13 px");
    vi.advanceTimersByTime(FLASH_MS - 100);
    say("14 px");
    vi.advanceTimersByTime(200);
    expect(flash.text).toBe("14 px");
    vi.advanceTimersByTime(FLASH_MS);
    expect(flash.text).toBeNull();
  });

  it("clears and shows again when the same word is said twice", () => {
    say("x");
    say("x");
    expect(flash.text).toBeNull();
    vi.advanceTimersByTime(0);
    expect(flash.text).toBe("x");
    vi.advanceTimersByTime(FLASH_MS);
    expect(flash.text).toBeNull();
  });
});

describe("a word held in the status bar", () => {
  it("stays until it is let go, and a word in passing does not take it away", () => {
    hold("Arrows resize");
    vi.advanceTimersByTime(FLASH_MS * 4);
    expect(flash.held).toBe("Arrows resize");
    say("13 px");
    vi.advanceTimersByTime(FLASH_MS);
    expect(flash.text).toBeNull();
    expect(flash.held).toBe("Arrows resize");
    letGo("Arrows resize");
    expect(flash.held).toBeNull();
  });

  it("is let go only by the word that holds it", () => {
    hold("one");
    hold("two");
    letGo("one");
    expect(flash.held).toBe("two");
  });
});
