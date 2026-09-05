import type { PaneId } from "$lib/layout.svelte";
import { actionOf, chordFor, chordFromEvent, describe, type ActionKey } from "$lib/keys.svelte";
import { isMac } from "$lib/platform";

export { isMac };

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
  | { type: "openSettings" }
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

const DEFAULT_CONTEXT: KeyContext = { focus: "agent", reviewing: false };

/** Panes that hold a pty, whose keys are the process's rather than the app's. */
function isTerminal(pane: PaneId): boolean {
  return pane === "agent" || pane === "terminal";
}

/** What each bound action does. The chords come from the keymap the user
    chose; this is the part that does not change. */
const ACTION_OF: Record<ActionKey, Action> = {
  "focus.sessions": { type: "focus", pane: "sessions" },
  "focus.agent": { type: "focus", pane: "agent" },
  "focus.changes": { type: "focus", pane: "changes" },
  "focus.terminal": { type: "focus", pane: "terminal" },
  "toggle.sessions": { type: "toggle", pane: "sessions" },
  "toggle.changes": { type: "toggle", pane: "changes" },
  "toggle.terminal": { type: "toggleTerminal" },
  "session.next": { type: "cycle", direction: 1 },
  "session.previous": { type: "cycle", direction: -1 },
  review: { type: "toggleReview" },
  view: { type: "toggleView" },
  scope: { type: "toggleScope" },
  theme: { type: "cycleTheme" },
  settings: { type: "openSettings" },
};

/** Returns the chrome action for a key event, or null to pass it to the pane. */
export function resolveAction(e: KeyState, ctx: KeyContext = DEFAULT_CONTEXT): Action | null {
  const mac = ctx.mac ?? isMac();
  const chord = chordFromEvent(e, mac);

  if (chord === null) {
    // Escape belongs to the agent whenever the agent has it. A pane that owns
    // focus may use it: the viewer closes on it, and a list pane hands the
    // keyboard back to the agent, so a look at the side panes ends where
    // typing resumes.
    if (e.key === "Escape" && !isTerminal(ctx.focus)) {
      return ctx.reviewing ? { type: "exitReview" } : { type: "focus", pane: "agent" };
    }
    return null;
  }

  const action = actionOf(chord);
  return action === null ? null : ACTION_OF[action];
}

export interface Binding {
  keys: string;
  does: string;
  minor?: boolean;
}

/**
 * Human-readable bindings for the status bar, in the platform's own glyphs
 * and from the keymap as it is now. `minor` ones are dropped first when the
 * window is too narrow to show them all.
 */
export function bindingsFor(mac: boolean): Binding[] {
  const d = (action: ActionKey) => describe(chordFor(action), mac);
  return [
    {
      keys: `${d("focus.sessions")} ${d("focus.agent")} ${d("focus.changes")} ${d("focus.terminal")}`,
      does: "focus",
      minor: true,
    },
    { keys: d("toggle.sessions"), does: "sessions", minor: true },
    { keys: d("toggle.changes"), does: "changes", minor: true },
    { keys: d("toggle.terminal"), does: "terminal" },
    { keys: `${d("session.next")} ${d("session.previous")}`, does: "switch session" },
    { keys: d("review"), does: "review" },
    { keys: d("view"), does: "diff/content" },
    { keys: d("scope"), does: "scope", minor: true },
    { keys: d("settings"), does: "settings", minor: true },
  ];
}
