/**
 * How panes and rows come and go.
 *
 * What these promise the grid: no column ever animates. A pane on its way out
 * leaves the flow in the same frame it is asked to go, at the box it had, so
 * the panes that stay take their new widths at once and the agent's terminal
 * is told its size once rather than on every frame of a slide. A pane on its
 * way in moves while in flow, since the column it needs is already there. A
 * row fades where it stands, and the rows below it move only once it has gone.
 *
 * A pane going is therefore two things: the box it is held at, which is set
 * before the columns change, and the transition, which is paint from there
 * on.
 *
 * Nothing moves while the system asks for reduced motion: every transition
 * here is instant then, and what it was going to animate is simply the way it
 * ends up.
 */

import { cubicOut } from "svelte/easing";
import type { FlipParams } from "svelte/animate";
import type { TransitionConfig } from "svelte/transition";

/** How long a pane takes to leave or to arrive, in milliseconds. */
export const PANE_MOTION = 180;

/** How far a pane travels on its way in or out, in pixels. */
export const PANE_TRAVEL = 40;

/** How long a row takes to fade, and to move into the space another left. */
export const ROW_MOTION = 150;

/** Whether the system asks for as little movement as possible. */
export function reduced(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Pins a pane to the box it currently has, out of the flow, so the panes that
 * stay resolve their widths without it. Called from a pre-effect, before the
 * columns change: that is the last moment the box is the one the pane had,
 * and it is the only moment early enough for the grid to lay out once. A
 * transition function is no place for it, since Svelte asks a given element
 * for its transition once and reuses the answer.
 *
 * The box is measured against whatever the pane is positioned in: the nearest
 * positioned ancestor, or the page itself.
 */
export function freeze(node: HTMLElement) {
  const box = node.getBoundingClientRect();
  const host = node.offsetParent as HTMLElement | null;
  const origin = host?.getBoundingClientRect();
  const style = node.style;
  style.position = "absolute";
  style.left = `${box.left - (origin ? origin.left + host!.clientLeft : 0)}px`;
  style.top = `${box.top - (origin ? origin.top + host!.clientTop : 0)}px`;
  style.width = `${box.width}px`;
  style.height = `${box.height}px`;
  style.pointerEvents = "none";
  // Above the panes that stay: they take its ground the moment it leaves the
  // flow, and their own positioned parts, the terminal's frame and the status
  // overlay, would otherwise paint over it in document order.
  style.zIndex = "2";
}

/** Hands a pane back to the flow, at the width its column gives it. Called
    from the same pre-effect, so a pane asked back while it was still on its
    way out is in the flow again before the columns change. */
export function release(node: HTMLElement) {
  const style = node.style;
  style.position = "";
  style.left = "";
  style.top = "";
  style.width = "";
  style.height = "";
  style.pointerEvents = "";
  style.zIndex = "";
}

/**
 * A pane going: a slide towards the edge it leaves by, and a fade. Paint
 * only. The pane is already out of the flow by the time this runs, so the
 * grid has resolved without it and nothing here can move a column.
 */
export function depart(_node: Element): TransitionConfig {
  if (reduced()) return { duration: 0 };
  return {
    duration: PANE_MOTION,
    easing: cubicOut,
    css: (t) =>
      `opacity: ${t}; transform: translateX(${(t - 1) * PANE_TRAVEL}px)`,
  };
}

/**
 * A pane arriving, in flow: the column it needs is already there, so it
 * slides in from the edge it comes by and fades up where it will stand.
 */
export function arrive(_node: Element): TransitionConfig {
  if (reduced()) return { duration: 0 };
  return {
    duration: PANE_MOTION,
    easing: cubicOut,
    css: (t) =>
      `opacity: ${t}; transform: translateX(${(t - 1) * PANE_TRAVEL}px)`,
  };
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
