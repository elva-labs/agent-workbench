import type { PaneId } from "$lib/layout.svelte";

/**
 * The focus model, in one place.
 *
 * The agent pane owns the keyboard. Claude Code needs Ctrl+C, Ctrl+R, Esc and
 * Shift+Tab, so the app chrome claims only Cmd (or Ctrl on Windows/Linux)
 * chords and lets everything else through. Tab in particular is never a
 * focus-mover here: it is completion inside the TUI.
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
}

const DEFAULT_CONTEXT: KeyContext = { focus: "agent", reviewing: false };

/** Returns the chrome action for a key event, or null to pass it to the pane. */
export function resolveAction(e: KeyState, ctx: KeyContext = DEFAULT_CONTEXT): Action | null {
  const mod = Boolean(e.metaKey || e.ctrlKey);

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

/**
 * Human-readable bindings for the status bar. `minor` ones are dropped first
 * when the window is too narrow to show them all.
 */
export const BINDINGS: { keys: string; does: string; minor?: boolean }[] = [
  { keys: "⌘1 ⌘2 ⌘3", does: "focus", minor: true },
  { keys: "⌘B", does: "sessions", minor: true },
  { keys: "⌘\\", does: "changes", minor: true },
  { keys: "⌘D", does: "review" },
  { keys: "⌘E", does: "diff/content" },
  { keys: "⇧⌘A", does: "scope", minor: true },
];
