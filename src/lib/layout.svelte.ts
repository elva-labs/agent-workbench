/**
 * Pane geometry, focus, and the two layouts.
 *
 * The app has two shapes. **Working** is three panes with the agent taking the
 * room. **Reviewing** is the changes pane grown into a file viewer, with the
 * sessions pane folded away because a session list is no use while reading a
 * diff. One deliberate transition between them, and the agent resizes once on
 * the way in rather than once per file opened.
 *
 * Below either shape sits the terminal panel: a strip along the bottom of the
 * window holding the project's shells, hidden until asked for. It takes its
 * height from the three panes above, which is one resize for the agent on a
 * deliberate toggle, the same bargain review mode strikes.
 *
 * Two kinds of collapse, and they must not be confused:
 *
 *   chosen  — you pressed the toggle. Persisted.
 *   forced  — the window is too narrow to hold the pane. Transient.
 *
 * Keeping them apart is what stops a stint in split-screen from permanently
 * forgetting that you like the sessions pane open.
 */

export type PaneId = "sessions" | "agent" | "changes" | "terminal";
export type Mode = "working" | "reviewing";

export const SPLITTER = 6;
export const FRAME_PADDING = 20;

export const MIN = {
  sessions: 180,
  agent: 360,
  changes: 260,
  /** Narrower than this and the tree shows indentation rather than names. */
  tree: 160,
  /** The content below this is too narrow to read a diff in. */
  viewer: 400,
  /** Shorter than this and a shell shows a prompt and little else. */
  terminal: 120,
  /** What the three panes keep between them when the terminal is open. */
  panes: 240,
  /** Narrower than this and the terminal list shows dots rather than names. */
  terminalList: 140,
  /** What the shells keep beside the list: one usable shell at least. */
  shells: 320,
} as const;

/** The review pane holds a tree and the content side by side. */
export const MIN_REVIEW = MIN.tree + SPLITTER + MIN.viewer;

export const DEFAULT = {
  sessions: 232,
  changes: 340,
  tree: 220,
  review: 700,
  terminal: 260,
  terminalList: 200,
} as const;

/** Content width below which the sessions pane cannot fit alongside the rest. */
export const NEEDS_SESSIONS =
  MIN.sessions + SPLITTER + MIN.changes + SPLITTER + MIN.agent;
/** Content width below which even the changes pane has to go. */
export const NEEDS_CHANGES = MIN.changes + SPLITTER + MIN.agent;
/**
 * Content width below which reviewing hides the agent rather than squeezing it.
 * Hiding costs nothing: the pane keeps its width, so the PTY is never resized
 * and the terminal comes back exactly as it was. Squeezing costs a reflow.
 */
export const NEEDS_AGENT_WHILE_REVIEWING = MIN.agent + SPLITTER + MIN_REVIEW;
/** Content height below which the terminal panel cannot fit under the panes. */
export const NEEDS_TERMINAL = MIN.panes + SPLITTER + MIN.terminal;

const KEY = "workbench.layout";

export const layout = $state({
  sessions: DEFAULT.sessions as number,
  changes: DEFAULT.changes as number,
  review: DEFAULT.review as number,
  tree: DEFAULT.tree as number,
  terminal: DEFAULT.terminal as number,
  terminalList: DEFAULT.terminalList as number,
  sessionsChosen: true,
  changesChosen: true,
  terminalChosen: false,
  sessionsForced: false,
  changesForced: false,
  terminalForced: false,
  agentHidden: false,
  /** Set once you drag the viewer's splitter, so we stop sizing it for you. */
  reviewTouched: false,
  mode: "working" as Mode,
  focus: "agent" as PaneId,
  /** Counts every request to focus a pane by key, so a pane that already
      has the focus state still takes the keyboard when asked again. */
  focusRequest: 0,
  width: 1200,
  height: 800,
});

export function sessionsVisible() {
  return layout.sessionsChosen && !layout.sessionsForced;
}

export function changesVisible() {
  return layout.changesChosen && !layout.changesForced;
}

export function agentVisible() {
  return !layout.agentHidden;
}

export function terminalVisible() {
  return layout.terminalChosen && !layout.terminalForced;
}

/** The pane at the left edge of the window, whose header the macOS window
    controls sit over. */
export function leftmost(): PaneId {
  if (sessionsVisible()) return "sessions";
  if (agentVisible()) return "agent";
  return "changes";
}

/** The pane at the right edge of the top row, whose header carries the
    window controls on Windows and Linux. */
export function rightmost(): PaneId {
  if (changesVisible()) return "changes";
  if (agentVisible()) return "agent";
  return "sessions";
}

/** Room the macOS window controls take at the top left, in pixels from the
    window edge. The window carries a unified toolbar (see `chrome.rs`), and
    in one of those AppKit puts the buttons about 20px in, 20px apart, and
    level with a header at the frame's normal padding; then the pane's own
    padding again before the title. */
export const CONTROLS_INSET = 88;

/** The width the changes pane is currently asking for. */
export function changesWidth() {
  return layout.mode === "reviewing" ? layout.review : layout.changes;
}

/**
 * Resolves the layout for a given content size. Called on every resize and on
 * every mode change, and is the only place that decides what is visible.
 */
export function applyLayout(width: number, height: number = layout.height) {
  layout.width = width;
  layout.height = height;

  // The terminal is independent of the shape: it sits under whichever one is
  // showing, and only the height decides whether it fits.
  layout.terminalForced = height < NEEDS_TERMINAL;
  if (layout.terminalForced) {
    if (layout.focus === "terminal") layout.focus = "agent";
  } else {
    const room = height - SPLITTER - MIN.panes;
    layout.terminal = Math.min(Math.max(layout.terminal, MIN.terminal), room);
  }
  // Inside the panel, the shells keep their minimum and the list gives way.
  const listRoom = width - SPLITTER - MIN.shells;
  layout.terminalList = Math.min(
    Math.max(layout.terminalList, MIN.terminalList),
    Math.max(MIN.terminalList, listRoom),
  );

  if (layout.mode === "reviewing") {
    layout.sessionsForced = true;
    layout.changesForced = false;
    layout.agentHidden = width < NEEDS_AGENT_WHILE_REVIEWING;

    const room = layout.agentHidden ? width : width - SPLITTER - MIN.agent;
    layout.review = Math.min(
      Math.max(layout.review, MIN_REVIEW),
      Math.max(MIN_REVIEW, room),
    );

    // Inside the pane, the content keeps its minimum and the tree gives way.
    const treeRoom = layout.review - SPLITTER - MIN.viewer;
    layout.tree = Math.min(
      Math.max(layout.tree, MIN.tree),
      Math.max(MIN.tree, treeRoom),
    );
    return;
  }

  layout.agentHidden = false;
  layout.sessionsForced = width < NEEDS_SESSIONS;
  layout.changesForced = width < NEEDS_CHANGES;

  const showSessions = sessionsVisible();
  const showChanges = changesVisible();

  let sessions = showSessions
    ? Math.max(MIN.sessions, layout.sessions)
    : layout.sessions;
  let changes = showChanges
    ? Math.max(MIN.changes, layout.changes)
    : layout.changes;

  const splitters =
    (showSessions ? SPLITTER : 0) + (showChanges ? SPLITTER : 0);
  let overflow =
    (showSessions ? sessions : 0) +
    (showChanges ? changes : 0) +
    splitters +
    MIN.agent -
    width;

  // The changes pane gives way first: while you are working, the file list is
  // the thing you can most afford to have narrow.
  if (overflow > 0 && showChanges) {
    const give = Math.min(overflow, changes - MIN.changes);
    changes -= give;
    overflow -= give;
  }
  if (overflow > 0 && showSessions) {
    sessions -= Math.min(overflow, sessions - MIN.sessions);
  }

  layout.sessions = sessions;
  layout.changes = changes;
}

export function enterReview() {
  if (layout.mode === "reviewing") return;

  // The pane now holds a tree beside the content, so what the sessions pane
  // vacates is no longer enough on its own: at default widths that is 578px,
  // which would leave the tree at its minimum. Opening the viewer therefore
  // costs the agent one resize, on a deliberate mode change rather than on
  // every file, and it gets the width straight back on exit.
  if (!layout.reviewTouched) {
    const freed = sessionsVisible() ? layout.sessions + SPLITTER : 0;
    layout.review = Math.max(DEFAULT.review, layout.changes + freed);
  }

  layout.mode = "reviewing";
  layout.focus = "changes";
  applyLayout(layout.width);
  saveLayout();
}

/** Leaves the viewer. The keyboard stays in the tree, so closing a file is
    a step back to the list and not a jump to the agent; it goes to the agent
    only when the changes pane is not there to hold it. */
export function exitReview() {
  if (layout.mode === "working") return;
  layout.mode = "working";
  layout.sessionsForced = false;
  applyLayout(layout.width);
  if (layout.focus === "changes" && changesVisible()) {
    // The viewer that had the document's focus is gone; the tree takes it.
    layout.focusRequest += 1;
  } else {
    layout.focus = "agent";
  }
  saveLayout();
}

export function togglePane(pane: "sessions" | "changes") {
  if (pane === "sessions") {
    layout.sessionsChosen = !layout.sessionsChosen;
    if (!sessionsVisible() && layout.focus === "sessions")
      layout.focus = "agent";
  } else {
    layout.changesChosen = !layout.changesChosen;
    if (!changesVisible() && layout.focus === "changes") layout.focus = "agent";
  }
  applyLayout(layout.width);
  saveLayout();
}

/**
 * Shows or hides the terminal. Showing it is asking for it, so focus goes
 * there; hiding it hands focus back to the agent, which is where a chord
 * pressed from inside the panel most likely wants to land.
 */
export function toggleTerminal() {
  layout.terminalChosen = !layout.terminalChosen;
  applyLayout(layout.width, layout.height);
  if (terminalVisible()) layout.focus = "terminal";
  else if (layout.focus === "terminal") layout.focus = "agent";
  saveLayout();
}

export function hideTerminal() {
  if (layout.terminalChosen) toggleTerminal();
}

export function focusPane(id: PaneId) {
  if (id === "sessions" && !sessionsVisible()) return;
  if (id === "changes" && !changesVisible()) return;
  if (id === "agent" && !agentVisible()) return;
  if (id === "terminal" && !terminalVisible()) return;
  layout.focus = id;
  layout.focusRequest += 1;
}

export function loadLayout() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (!raw) return;
  try {
    const v = JSON.parse(raw);
    if (typeof v.sessions === "number") layout.sessions = v.sessions;
    if (typeof v.changes === "number") layout.changes = v.changes;
    if (typeof v.review === "number") layout.review = v.review;
    if (typeof v.tree === "number") layout.tree = v.tree;
    if (typeof v.terminal === "number") layout.terminal = v.terminal;
    if (typeof v.terminalList === "number")
      layout.terminalList = v.terminalList;
    if (typeof v.reviewTouched === "boolean")
      layout.reviewTouched = v.reviewTouched;
    if (typeof v.sessionsChosen === "boolean")
      layout.sessionsChosen = v.sessionsChosen;
    if (typeof v.changesChosen === "boolean")
      layout.changesChosen = v.changesChosen;
    if (typeof v.terminalChosen === "boolean")
      layout.terminalChosen = v.terminalChosen;
  } catch {
    // A corrupt entry is not worth a broken window. Defaults stand.
  }
}

/**
 * Persists intent and widths only. Forced collapses are a fact about the
 * current window, and the mode is where you happen to be right now: neither
 * belongs in storage, and saving either would make the app reopen wrong.
 */
export function saveLayout() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        sessions: layout.sessions,
        changes: layout.changes,
        review: layout.review,
        tree: layout.tree,
        terminal: layout.terminal,
        terminalList: layout.terminalList,
        reviewTouched: layout.reviewTouched,
        sessionsChosen: layout.sessionsChosen,
        changesChosen: layout.changesChosen,
        terminalChosen: layout.terminalChosen,
      }),
    );
  } catch {
    // Non-fatal: the layout simply does not survive a restart.
  }
}
