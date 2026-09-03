/**
 * Pane geometry, focus, and the two layouts.
 *
 * The app has two shapes. **Working** is three panes with the agent taking the
 * room. **Reviewing** is the changes pane grown into a file viewer, with the
 * sessions pane folded away because a session list is no use while reading a
 * diff. One deliberate transition between them, and the agent resizes once on
 * the way in rather than once per file opened.
 *
 * Two kinds of collapse, and they must not be confused:
 *
 *   chosen  — you pressed the toggle. Persisted.
 *   forced  — the window is too narrow to hold the pane. Transient.
 *
 * Keeping them apart is what stops a stint in split-screen from permanently
 * forgetting that you like the sessions pane open.
 */

export type PaneId = "sessions" | "agent" | "changes";
export type Mode = "working" | "reviewing";

export const SPLITTER = 6;
export const FRAME_PADDING = 16;

export const MIN = {
  sessions: 180,
  agent: 360,
  changes: 260,
  /** The viewer below this is too narrow to read a diff in. */
  review: 420,
} as const;

export const DEFAULT = {
  sessions: 232,
  changes: 340,
  review: 640,
} as const;

/** Content width below which the sessions pane cannot fit alongside the rest. */
export const NEEDS_SESSIONS = MIN.sessions + SPLITTER + MIN.changes + SPLITTER + MIN.agent;
/** Content width below which even the changes pane has to go. */
export const NEEDS_CHANGES = MIN.changes + SPLITTER + MIN.agent;
/**
 * Content width below which reviewing hides the agent rather than squeezing it.
 * Hiding costs nothing: the pane keeps its width, so the PTY is never resized
 * and the terminal comes back exactly as it was. Squeezing costs a reflow.
 */
export const NEEDS_AGENT_WHILE_REVIEWING = MIN.agent + SPLITTER + MIN.review;

const KEY = "workbench.layout";

export const layout = $state({
  sessions: DEFAULT.sessions as number,
  changes: DEFAULT.changes as number,
  review: DEFAULT.review as number,
  sessionsChosen: true,
  changesChosen: true,
  sessionsForced: false,
  changesForced: false,
  agentHidden: false,
  /** Set once you drag the viewer's splitter, so we stop sizing it for you. */
  reviewTouched: false,
  mode: "working" as Mode,
  focus: "agent" as PaneId,
  width: 1200,
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

/** The width the changes pane is currently asking for. */
export function changesWidth() {
  return layout.mode === "reviewing" ? layout.review : layout.changes;
}

/**
 * Resolves the layout for a given content width. Called on every resize and on
 * every mode change, and is the only place that decides what is visible.
 */
export function applyLayout(width: number) {
  layout.width = width;

  if (layout.mode === "reviewing") {
    layout.sessionsForced = true;
    layout.changesForced = false;
    layout.agentHidden = width < NEEDS_AGENT_WHILE_REVIEWING;

    const room = layout.agentHidden ? width : width - SPLITTER - MIN.agent;
    layout.review = Math.min(Math.max(layout.review, MIN.review), Math.max(MIN.review, room));
    return;
  }

  layout.agentHidden = false;
  layout.sessionsForced = width < NEEDS_SESSIONS;
  layout.changesForced = width < NEEDS_CHANGES;

  const showSessions = sessionsVisible();
  const showChanges = changesVisible();

  let sessions = showSessions ? Math.max(MIN.sessions, layout.sessions) : layout.sessions;
  let changes = showChanges ? Math.max(MIN.changes, layout.changes) : layout.changes;

  const splitters = (showSessions ? SPLITTER : 0) + (showChanges ? SPLITTER : 0);
  let overflow =
    (showSessions ? sessions : 0) + (showChanges ? changes : 0) + splitters + MIN.agent - width;

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

  // Take exactly what the sessions pane vacates, so opening a file does not
  // move the agent pane at all. Only the floor can force it to give any up.
  if (!layout.reviewTouched) {
    const freed = sessionsVisible() ? layout.sessions + SPLITTER : 0;
    layout.review = Math.max(MIN.review, layout.changes + freed);
  }

  layout.mode = "reviewing";
  layout.focus = "changes";
  applyLayout(layout.width);
  saveLayout();
}

export function exitReview() {
  if (layout.mode === "working") return;
  layout.mode = "working";
  layout.sessionsForced = false;
  layout.focus = "agent";
  applyLayout(layout.width);
  saveLayout();
}

export function togglePane(pane: "sessions" | "changes") {
  if (pane === "sessions") {
    layout.sessionsChosen = !layout.sessionsChosen;
    if (!sessionsVisible() && layout.focus === "sessions") layout.focus = "agent";
  } else {
    layout.changesChosen = !layout.changesChosen;
    if (!changesVisible() && layout.focus === "changes") layout.focus = "agent";
  }
  applyLayout(layout.width);
  saveLayout();
}

export function focusPane(id: PaneId) {
  if (id === "sessions" && !sessionsVisible()) return;
  if (id === "changes" && !changesVisible()) return;
  if (id === "agent" && !agentVisible()) return;
  layout.focus = id;
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
    if (typeof v.reviewTouched === "boolean") layout.reviewTouched = v.reviewTouched;
    if (typeof v.sessionsChosen === "boolean") layout.sessionsChosen = v.sessionsChosen;
    if (typeof v.changesChosen === "boolean") layout.changesChosen = v.changesChosen;
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
        reviewTouched: layout.reviewTouched,
        sessionsChosen: layout.sessionsChosen,
        changesChosen: layout.changesChosen,
      }),
    );
  } catch {
    // Non-fatal: the layout simply does not survive a restart.
  }
}
