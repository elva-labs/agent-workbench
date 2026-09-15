/**
 * How panes and rows come and go.
 *
 * The sessions column eases between folded and open, and the changes column
 * eases between its working and reviewing widths, and the agent between them
 * takes and gives back the room as they go. The terminal panel eases up and
 * down the same way, with the panes above it giving up and taking back the
 * height. The terminals keep their size until the motion arrives, so a pty is
 * told its size once rather than on every frame. A row fades where it stands,
 * and the rows below it move only once it has gone.
 *
 * Nothing moves while the system asks for reduced motion: every transition
 * here is instant then, and what it was going to animate is simply the way it
 * ends up.
 */

import { cubicOut } from "svelte/easing";
import type { FlipParams } from "svelte/animate";
import type { TransitionConfig } from "svelte/transition";

/** How long a pane takes to fold, open, leave or arrive, in milliseconds. */
export const PANE_MOTION = 180;

/** How long a row takes to fade, and to move into the space another left. */
export const ROW_MOTION = 150;

/** Whether the system asks for as little movement as possible. */
export function reduced(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** A row arriving or going: a fade where it stands. */
export function rowFade(_node: Element): TransitionConfig {
  return {
    duration: reduced() ? 0 : ROW_MOTION,
    easing: cubicOut,
    css: (t) => `opacity: ${t}`,
  };
}

/** How a row moves when a row above it goes. */
export function rowMove(): FlipParams {
  return { duration: reduced() ? 0 : ROW_MOTION, easing: cubicOut };
}
