import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { FRAME_PADDING, MIN, NEEDS_CHANGES, NEEDS_SESSIONS } from "$lib/layout.svelte";

/**
 * The window minimum and the pane minimums are one constraint expressed in two
 * files. The window may be narrower than all three panes need, because the
 * layout folds panes away to cope. What it may never be is narrower than the
 * agent pane plus the narrowest useful arrangement, or applyLayout has no way
 * to honour MIN.agent and the terminal grid gets squeezed instead.
 */
describe("window minimum", () => {
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const { minWidth } = config.app.windows[0];

  it("is declared, so the constraint cannot be dragged away", () => {
    expect(typeof minWidth).toBe("number");
  });

  it("holds the agent and the changes pane with the sessions pane folded", () => {
    expect(minWidth).toBeGreaterThanOrEqual(NEEDS_CHANGES + FRAME_PADDING);
  });

  it("never squeezes the agent below its minimum", () => {
    expect(minWidth - FRAME_PADDING).toBeGreaterThanOrEqual(MIN.agent);
  });

  /**
   * Half of a 1440-wide laptop display. macOS split-screen is the common case
   * this has to fit, and a minWidth above it means the window simply refuses.
   */
  it("fits half of a 1440-wide display", () => {
    expect(minWidth).toBeLessThanOrEqual(720);
  });

  it("sits below the width that needs all three panes", () => {
    expect(minWidth).toBeLessThan(NEEDS_SESSIONS + FRAME_PADDING);
  });
});
