import type { PaneId } from "$lib/layout.svelte";
import {
  actionOf,
  chordFor,
  chordFromEvent,
  describe,
  type ActionKey,
  type Chord,
} from "$lib/keys.svelte";
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
 *
 * The editor is a text field of the app's own, and keeps what a text field
 * needs while it has the keyboard: Escape, and every chord on an arrow key,
 * which moves or selects there. Find there is find in the file, and save is
 * only there.
 */

export type Action =
  | { type: "focus"; pane: PaneId }
  | { type: "toggle"; pane: "sessions" | "changes" }
  | { type: "cycleTheme" }
  | { type: "toggleReview" }
  | { type: "toggleView" }
  | { type: "toggleScope" }
  | { type: "toggleTerminal" }
  /** Agent mode or editor mode: what takes the middle of the window. */
  | { type: "toggleMode" }
  /** A name field for a new file in the tree, in editor mode. */
  | { type: "newFile" }
  /** The file in the editor written to disk. */
  | { type: "save" }
  /** Find in the file in the editor. */
  | { type: "findInFile" }
  /** The keyboard to the editor, from elsewhere in editor mode. */
  | { type: "toEditor" }
  | { type: "exitReview" }
  | { type: "openSettings" }
  /** The search field: narrowing the tree, or searching inside files. */
  | { type: "find"; mode: "files" | "lines" }
  /** Next or previous session, or shell when the terminal panel has focus. */
  | { type: "cycle"; direction: 1 | -1 }
  /** The palette that goes to a session or project, opened or put away. */
  | { type: "goto" }
  /** The command palette, opened or put away. */
  | { type: "palette" }
  /** The next session waiting on the user. */
  | { type: "attention" }
  /** The terminal with the keyboard drawn a pixel larger, smaller, or at
      its default size. */
  | { type: "zoom"; step: 1 | -1 | 0 };

export interface KeyState {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export interface KeyContext {
  focus: PaneId;
  reviewing: boolean;
  /** The window is in editor mode. */
  editing?: boolean;
  /** The editor has the keyboard. */
  inEditor?: boolean;
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
  mode: { type: "toggleMode" },
  "session.next": { type: "cycle", direction: 1 },
  "session.previous": { type: "cycle", direction: -1 },
  "session.attention": { type: "attention" },
  "zoom.in": { type: "zoom", step: 1 },
  "zoom.out": { type: "zoom", step: -1 },
  "zoom.reset": { type: "zoom", step: 0 },
  goto: { type: "goto" },
  palette: { type: "palette" },
  review: { type: "toggleReview" },
  view: { type: "toggleView" },
  scope: { type: "toggleScope" },
  find: { type: "find", mode: "files" },
  findLines: { type: "find", mode: "lines" },
  "file.new": { type: "newFile" },
  "file.save": { type: "save" },
  theme: { type: "cycleTheme" },
  settings: { type: "openSettings" },
};

/** What a bound action does, for a caller that has the action rather than
    a key event: the palette. */
export function actionFor(key: ActionKey): Action {
  return ACTION_OF[key];
}

/** On a layout where = needs Shift, or + has a key of its own, Cmd+= arrives
    as + or Shift+=. Those read as the plain = when no chord holds them. */
function plainEquals(chord: Chord): Chord | null {
  if (chord.key === "+" || (chord.key === "=" && chord.shift)) {
    return { key: "=", shift: false, alt: chord.alt };
  }
  return null;
}

/** Returns the chrome action for a key event, or null to pass it to the pane. */
export function resolveAction(e: KeyState, ctx: KeyContext = DEFAULT_CONTEXT): Action | null {
  const mac = ctx.mac ?? isMac();
  const chord = chordFromEvent(e, mac);

  if (chord === null) {
    // Escape belongs to the agent whenever the agent has it. A pane that owns
    // focus may use it: the viewer closes on it, and a list pane hands the
    // keyboard back to where typing resumes, the agent, or the editor in
    // editor mode, which keeps its own Escape.
    if (e.key === "Escape" && !isTerminal(ctx.focus)) {
      if (ctx.editing) return ctx.inEditor ? null : { type: "toEditor" };
      return ctx.reviewing ? { type: "exitReview" } : { type: "focus", pane: "agent" };
    }
    return null;
  }

  if (ctx.inEditor && chord.key.startsWith("Arrow")) return null;

  let action = actionOf(chord);
  if (action === null) {
    const plain = plainEquals(chord);
    if (plain !== null) action = actionOf(plain);
  }
  if (action === null) return null;
  // Filtering the tree is the changes pane's own: in a terminal the same
  // chord is the process's, Ctrl+F most of all. In the editor it finds in
  // the file.
  if (action === "find" && ctx.inEditor) return { type: "findInFile" };
  if (action === "find" && isTerminal(ctx.focus)) return null;
  // Saving is the editor's: anywhere else the chord passes through, to a
  // terminal above all, where Ctrl+S is the process's.
  if (action === "file.save" && !ctx.inEditor) return null;
  return ACTION_OF[action];
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
    { keys: d("goto"), does: "go to" },
    { keys: d("palette"), does: "commands" },
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
    { keys: d("view"), does: "view" },
    { keys: d("scope"), does: "scope", minor: true },
    { keys: d("findLines"), does: "search", minor: true },
    { keys: d("settings"), does: "settings", minor: true },
  ];
}
