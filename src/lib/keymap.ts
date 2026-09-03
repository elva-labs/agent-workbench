import type { PaneId } from "$lib/layout.svelte";

/**
 * The focus model, in one place.
 *
 * The agent pane owns the keyboard. Claude Code needs Ctrl+C, Ctrl+R, Esc and
 * Shift+Tab, so the app chrome claims only Cmd (or Ctrl on Windows/Linux)
 * chords and lets everything else through. Tab in particular is never a
 * focus-mover here: it is completion inside the TUI.
 *
 * The modifier is one key per platform, not either: on macOS every Ctrl chord
 * is the agent's, since Cmd is what the chrome answers to, and Ctrl+B or
 * Ctrl+E are readline to the TUI. On Windows and Linux there is only Ctrl,
 * and the bound chords are the ones the chrome takes.
 *
 * Escape is the one key whose meaning depends on where focus is, which is why
 * this function takes the context rather than leaving the caller to decide:
 * the whole model stays testable without a DOM.
 */

export type Action =
  | { type: "focus"; pane: PaneId }
  | { type: "toggle"; pane: "sessions" | "changes" }
  | { type: "cycleTheme" }
  | { type: "toggleReview" }
  | { type: "toggleView" }
  | { type: "toggleScope" }
  | { type: "exitReview" };

export interface KeyState {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export interface KeyContext {
  focus: PaneId;
  reviewing: boolean;
  /** Whether Cmd is the modifier. Defaults to what the browser reports. */
  mac?: boolean;
}

/** Whether this is running on macOS, where Cmd rather than Ctrl is the app key. */
export function isMac(nav: { platform?: string; userAgent?: string } | undefined = globalThis.navigator): boolean {
  if (nav === undefined) return false;
  return /Mac|iPhone|iPad/.test(nav.platform ?? nav.userAgent ?? "");
}

const DEFAULT_CONTEXT: KeyContext = { focus: "agent", reviewing: false };

/** Returns the chrome action for a key event, or null to pass it to the pane. */
export function resolveAction(e: KeyState, ctx: KeyContext = DEFAULT_CONTEXT): Action | null {
  const mac = ctx.mac ?? isMac();
  const mod = Boolean(mac ? e.metaKey : e.ctrlKey);

  if (!mod) {
    // Escape belongs to the agent whenever the agent has it. A pane that owns
    // focus may use it, which is how the viewer closes without a chord.
    if (e.key === "Escape" && ctx.reviewing && ctx.focus !== "agent") {
      return { type: "exitReview" };
    }
    return null;
  }

  if (e.shiftKey) {
    switch (e.key.toLowerCase()) {
      case "t":
        return { type: "cycleTheme" };
      case "a":
        return { type: "toggleScope" };
      default:
        return null;
    }
  }

  switch (e.key.toLowerCase()) {
    case "1":
      return { type: "focus", pane: "sessions" };
    case "2":
      return { type: "focus", pane: "agent" };
    case "3":
      return { type: "focus", pane: "changes" };
    case "b":
      return { type: "toggle", pane: "sessions" };
    case "\\":
      return { type: "toggle", pane: "changes" };
    case "d":
      return { type: "toggleReview" };
    case "e":
      return { type: "toggleView" };
    default:
      return null;
  }
}

export interface Binding {
  keys: string;
  does: string;
  minor?: boolean;
}

/**
 * Human-readable bindings for the status bar, in the platform's own glyphs.
 * `minor` ones are dropped first when the window is too narrow to show them
 * all.
 */
export function bindingsFor(mac: boolean): Binding[] {
  const m = mac ? "⌘" : "Ctrl+";
  const shift = mac ? "⇧⌘" : "Ctrl+Shift+";
  return [
    { keys: `${m}1 ${m}2 ${m}3`, does: "focus", minor: true },
    { keys: `${m}B`, does: "sessions", minor: true },
    { keys: `${m}\\`, does: "changes", minor: true },
    { keys: `${m}D`, does: "review" },
    { keys: `${m}E`, does: "diff/content" },
    { keys: `${shift}A`, does: "scope", minor: true },
  ];
}

export const BINDINGS: Binding[] = bindingsFor(isMac());
