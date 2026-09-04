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
 * the whole model stays testable without a DOM. It belongs to whichever
 * terminal has focus, the agent's or a shell's, and to the chrome otherwise.
 */

export type Action =
  | { type: "focus"; pane: PaneId }
  | { type: "toggle"; pane: "sessions" | "changes" }
  | { type: "cycleTheme" }
  | { type: "toggleReview" }
  | { type: "toggleView" }
  | { type: "toggleScope" }
  | { type: "toggleTerminal" }
  | { type: "exitReview" }
  /** Next or previous session, or shell when the terminal panel has focus. */
  | { type: "cycle"; direction: 1 | -1 };

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

/** Panes that hold a pty, whose keys are the process's rather than the app's. */
function isTerminal(pane: PaneId): boolean {
  return pane === "agent" || pane === "terminal";
}

/** Returns the chrome action for a key event, or null to pass it to the pane. */
export function resolveAction(e: KeyState, ctx: KeyContext = DEFAULT_CONTEXT): Action | null {
  const mac = ctx.mac ?? isMac();
  const mod = Boolean(mac ? e.metaKey : e.ctrlKey);

  if (!mod) {
    // Escape belongs to the agent whenever the agent has it. A pane that owns
    // focus may use it: the viewer closes on it, and a list pane hands the
    // keyboard back to the agent, so a look at the side panes ends where
    // typing resumes.
    if (e.key === "Escape" && !isTerminal(ctx.focus)) {
      return ctx.reviewing ? { type: "exitReview" } : { type: "focus", pane: "agent" };
    }
    return null;
  }

  if (e.shiftKey) {
    switch (e.key.toLowerCase()) {
      case "t":
        return { type: "cycleTheme" };
      case "a":
        return { type: "toggleScope" };
      case "arrowdown":
        return { type: "cycle", direction: 1 };
      case "arrowup":
        return { type: "cycle", direction: -1 };
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
    case "4":
      return { type: "focus", pane: "terminal" };
    case "j":
      return { type: "toggleTerminal" };
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
    { keys: `${m}1 ${m}2 ${m}3 ${m}4`, does: "focus", minor: true },
    { keys: `${m}B`, does: "sessions", minor: true },
    { keys: `${m}\\`, does: "changes", minor: true },
    { keys: `${m}J`, does: "terminal" },
    { keys: `${shift}↑↓`, does: "switch session" },
    { keys: `${m}D`, does: "review" },
    { keys: `${m}E`, does: "diff/content" },
    { keys: `${shift}A`, does: "scope", minor: true },
  ];
}

export const BINDINGS: Binding[] = bindingsFor(isMac());
