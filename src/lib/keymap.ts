import type { PaneId } from "$lib/layout.svelte";
import {
  actionOf,
  chordFor,
  chordFromEvent,
  describe,
  sameChord,
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
 * needs while it has the keyboard: Escape, every chord on an arrow key,
 * which moves or selects there, and the viewer's chord, which selects the
 * next occurrence there. Find there is find in the file. Save is editor
 * mode's, from anywhere but a terminal, where on Windows and Linux the same
 * Ctrl chord is the process's. Close closes what is in front, from
 * anywhere on macOS; elsewhere a terminal keeps Ctrl+W and closes on the
 * chord with Shift added. A new untitled file is the app's from anywhere,
 * in either mode, but a terminal on Windows and Linux, where Ctrl+N is the
 * shell's next line of history.
 *
 * An integrated session has no terminal: its composer stops a running turn
 * on Escape and lets the key through when none runs, and then it closes the
 * viewer while reviewing, goes back to the editor in editor mode, and does
 * nothing else. Save and close are the app's from it, and find is left
 * free there.
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
  /** An untitled file in a new tab of the editor, from either mode. */
  | { type: "newUntitled" }
  /** The file in front in the editor written to disk. */
  | { type: "save" }
  /** What is in front closed: see `closeTarget`. */
  | { type: "close" }
  /** A new shell in the terminal panel, with the keyboard in it. */
  | { type: "newShell" }
  /** The keyboard to the status bar's first control. */
  | { type: "focusStatus" }
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
  /** Whether the agent pane holds an integrated session, which has no
      terminal to own the keyboard. */
  integrated?: boolean;
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
  "focus.status": { type: "focusStatus" },
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
  "file.untitled": { type: "newUntitled" },
  "file.save": { type: "save" },
  "file.close": { type: "close" },
  "terminal.new": { type: "newShell" },
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
    // An integrated session's composer lets Escape through when no turn
    // runs: it closes the viewer while reviewing, and hands the keyboard
    // back to the editor in editor mode, as a list pane does there.
    if (e.key === "Escape" && ctx.focus === "agent" && ctx.integrated) {
      if (ctx.editing) return { type: "toEditor" };
      if (ctx.reviewing) return { type: "exitReview" };
    }
    return null;
  }

  if (ctx.inEditor && chord.key.startsWith("Arrow")) return null;

  let action = actionOf(chord);
  if (action === null) {
    const plain = plainEquals(chord);
    if (plain !== null) action = actionOf(plain);
  }
  if (action === null) {
    const also = closeAlso(mac);
    return also !== null && sameChord(chord, also) ? ACTION_OF["file.close"] : null;
  }
  // Filtering the tree is the changes pane's own: in a terminal the same
  // chord is the process's, Ctrl+F most of all. In the editor it finds in
  // the file.
  if (action === "find" && ctx.inEditor) return { type: "findInFile" };
  if (action === "find" && isTerminal(ctx.focus)) return null;
  // The viewer's chord has no viewer to open in editor mode; in the editor
  // it is the editor's own.
  if (action === "review" && ctx.editing) return null;
  // Saving is editor mode's, from anywhere but a terminal: the tree, the
  // editor, and an integrated session's composer, which is a text field
  // with no use for it. A terminal keeps the chord: Ctrl+S is the
  // process's on Windows and Linux. On macOS the File menu answers what the
  // page lets through. Close is the app's from anywhere on macOS, where no
  // process has Cmd+W; elsewhere a terminal keeps Ctrl+W, which deletes a
  // word there, and `closeAlso` closes from it instead.
  const terminal = isTerminal(ctx.focus) && !(ctx.focus === "agent" && ctx.integrated);
  if (action === "file.save" && (!ctx.editing || terminal)) return null;
  if (action === "file.close" && !mac && terminal) return null;
  // A new untitled file is the app's in either mode. On Windows and Linux
  // a terminal keeps Ctrl+N, its next line of history; on macOS Cmd is
  // never the terminal's.
  if (action === "file.untitled" && terminal && !mac) return null;
  return ACTION_OF[action];
}

/** Off macOS, the close chord with Shift added, which closes as well, from
    anywhere: it is the one a terminal lets through, as Ctrl+Shift+T opens a
    shell from one. None on macOS, where the close chord is never a
    process's, nor when the close chord has Shift already or another action
    holds the shifted one. */
export function closeAlso(mac: boolean = isMac()): Chord | null {
  if (mac) return null;
  const close = chordFor("file.close");
  if (close.shift) return null;
  const also = { ...close, shift: true };
  return actionOf(also) === null ? also : null;
}

/** What close acts on, the first of these that holds. */
export type CloseTarget =
  /** The palette, put away as Escape does. */
  | "palette"
  /** A dialog that holds the keyboard, closed as Escape does. */
  | "dialog"
  /** Nothing: a question in a strip holds the keyboard, and a second
      press neither answers it nor reaches past it. */
  | "nothing"
  /** The shell in front, with the keyboard in the terminal panel. */
  | "shell"
  /** The browser's tab in front, while the browser is shown. */
  | "browserTab"
  /** In editor mode, what took the editor's place: what the agent
      presented, or a plugin's page. */
  | "other"
  /** The editor's tab in front. */
  | "tab"
  /** The viewer, while reviewing. */
  | "viewer"
  /** The window, which asks first while sessions run or edits are
      unsaved. */
  | "window";

export interface CloseState {
  /** The palette is up. */
  palette: boolean;
  /** A dialog that holds the keyboard is up: the settings, the remote or
      resume lists, or an action's input. */
  dialog: boolean;
  /** A question in a strip has the keyboard. */
  question: boolean;
  focus: PaneId;
  editing: boolean;
  reviewing: boolean;
  /** The terminal panel has a shell in front. */
  shell: boolean;
  /** The editor has a tab in front. */
  tab: boolean;
  /** In editor mode, something other than a file takes the editor's
      place: what the agent presented, a plugin's page, or the browser. */
  other: boolean;
  /** The browser is what the viewer or the editor's place shows, with a
      tab in front. */
  browserTab: boolean;
}

/**
 * What close closes. It is the thing in front, wherever the keyboard is,
 * except that the terminal panel holding the keyboard puts its shell in
 * front. It never closes a session: a session is closed from its row,
 * which says what goes with it. Where nothing smaller is in front, it is
 * the window, and the window asks first while anything would be lost.
 */
export function closeTarget(state: CloseState): CloseTarget {
  if (state.palette) return "palette";
  if (state.dialog) return "dialog";
  if (state.question) return "nothing";
  if (state.focus === "terminal" && state.shell) return "shell";
  if (state.editing) {
    if (state.other) return state.browserTab ? "browserTab" : "other";
    return state.tab ? "tab" : "window";
  }
  if (state.reviewing) return state.browserTab ? "browserTab" : "viewer";
  return "window";
}

/** The close item's name in the File menu, for what it would close. */
export function closeLabel(target: CloseTarget): string {
  switch (target) {
    case "shell":
      return "Close Shell";
    case "tab":
    case "browserTab":
      return "Close Tab";
    case "viewer":
    case "other":
      return "Close Viewer";
    case "window":
      return "Close Window";
    default:
      return "Close";
  }
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
