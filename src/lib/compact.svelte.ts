/**
 * Compact mode: the sessions pane leaves the layout, and the other panes
 * take the window's width. The pointer at the window's left edge, or the
 * chord that goes to the sessions pane, slides it in over them, and it
 * goes again once the pointer leaves it or the keyboard is done with it.
 *
 * It is a setting kept with the others for the machine, under Appearance,
 * off unless the user turns it on. The window keeps a copy of its own as
 * well, read before the core has answered, so the first frame is laid out
 * as the last one was. It is its own state: the folded column and the
 * pane's width are left as they are, and stand again once it is off.
 */

import type { Settings } from "$lib/core";
import { persist } from "$lib/persist";

const KEY = "workbench.compact";

export const compact = $state({
  /** Whether compact mode is on. */
  on: false,
  /** Whether something in the slid-in pane holds it there: a menu, the
      new-session choice, a question in it, a press under way, or the
      keyboard walking it. Set by the pane. */
  held: false,
});

/** How long the pointer rests on the edge before the pane slides in, so a
    pointer passing along the edge does not bring it. */
export const EDGE_AFTER = 60;

/** How long the pointer is away from the slid-in pane before it goes. */
export const AWAY_AFTER = 400;

/** How wide the strip along the window's left edge is that brings the pane. */
export const EDGE_WIDTH = 6;

/** This part of the settings. */
export function compactSettings(): Pick<Settings, "compact"> {
  return { compact: compact.on };
}

function remember() {
  try {
    localStorage.setItem(KEY, compact.on ? "on" : "off");
  } catch {
    // Non-fatal: the next start lays out the default until the core answers.
  }
}

/** Reads the window's own copy, for the first frame. */
export function loadCompact() {
  try {
    compact.on = localStorage.getItem(KEY) === "on";
  } catch {
    compact.on = false;
  }
}

/** Takes the core's word for the machine. Anything but true is off. */
export function adoptCompact(value: unknown) {
  compact.on = value === true;
  remember();
}

/** Turns compact mode on or off, at once. */
export function setCompact(on: boolean) {
  compact.on = on;
  remember();
  persist({ compact: on });
}

/** Test seam. */
export function resetCompact() {
  compact.on = false;
  compact.held = false;
}
