/**
 * Pane geometry, focus, and the three layouts.
 *
 * The app has three shapes. **Working** is three panes with the agent taking
 * the room. **Reviewing** is the changes pane grown into a file viewer, with
 * the sessions pane folded to a narrow column because a session list is no
 * use while reading a diff. One deliberate transition between them, and the
 * agent resizes once on the way in rather than once per file opened.
 * **Editing** is the window's other mode: the file tree and an editor take
 * the middle and the agent moves to the right pane at a width of its own.
 * The editor comes before the agent there: when the window cannot give the
 * editor `MIN.editor` with everything open, the sessions pane folds, then the
 * tree column goes, and the agent is hidden rather than squeezed below its
 * minimum.
 *
 * Below either shape sits the terminal panel: a strip along the bottom of the
 * window holding the project's shells, hidden until asked for. It takes its
 * height from the three panes above, which is one resize for the agent on a
 * deliberate toggle, the same bargain review mode strikes.
 *
 * The sessions pane is never gone, only open or folded: folded, its column is
 * `folded()` wide and shows its projects and the dots of their sessions where
 * they stand when it is open. While reviewing it can also be peeked: drawn
 * at its open width over the agent pane, with the column still folded, so
 * a session can be picked without the viewer closing or anything moving.
 * In compact mode it is not in the layout at all: the other panes take the
 * window's width, and the pane is drawn over them from the window's left
 * edge while it is peeked. The fold and the pane's width are left as they
 * are, so turning compact mode off finds them as they were.
 *
 * Two kinds of collapse, for it and the changes pane, and they must not be
 * confused:
 *
 *   chosen  — you pressed the toggle. Persisted.
 *   forced  — the window is too narrow to hold the pane. Transient.
 *
 * Keeping them apart is what stops a stint in split-screen from permanently
 * forgetting that you like the sessions pane open.
 */

import { Tween } from "svelte/motion";
import { isMac } from "$lib/platform";
import { theme } from "$lib/theme.svelte";
import { compact } from "$lib/compact.svelte";

export type PaneId = "sessions" | "agent" | "changes" | "terminal";
export type Mode = "working" | "reviewing" | "editing";

/** The room a divider between two panes takes: the gap between them, which
    is the modern look's and wider than the terminal look's, so the layout's
    sums hold in either. A divider inside a pane takes none. */
export const SPLITTER = 8;
/** The room a divider inside a pane takes, between the tree and what is
    beside it or between the shells and their list: none, since it lies
    over the seam. */
export const INNER = 0;
/** The frame's padding across the window, the most a look gives it. */
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
  /** What the editor keeps with everything open beside it: the sessions
      pane folds, then the tree column goes, before it gets less. */
  editor: 640,
} as const;

/** The review pane holds a tree and the content side by side. */
export const MIN_REVIEW = MIN.tree + INNER + MIN.viewer;

/** The share of the content width the viewer's pane opens at: the file is
    what is being read, the agent is glanced at beside it. */
export const REVIEW_SHARE = 0.6;

export const DEFAULT = {
  sessions: 300,
  changes: 340,
  tree: 220,
  /** The least the viewer's pane opens at, whatever the window's width. */
  review: 700,
  terminal: 260,
  terminalList: 200,
  /** The tree column beside the editor. */
  editTree: 240,
  /** The agent pane on the right while editing. */
  editAgent: 420,
} as const;

/** The room the window's own buttons take at the end of the rightmost
    header, where the app draws them: on Windows and Linux. */
export const WINDOW_CONTROLS = 120;

/** What the right pane's widths add where the app draws the window's own
    buttons: its two defaults and the changes pane's least width. Half the
    buttons' room: the header's status gives way for the rest. */
export const CONTROLS_STEP = 60;

/** Whether the browser reports Windows or Linux, where the window is
    undecorated and the app draws the window's own buttons. */
function drawsWindowButtons(): boolean {
  return /Win|Linux/.test(globalThis.navigator?.platform ?? "");
}

function controlsStep(): number {
  return drawsWindowButtons() ? CONTROLS_STEP : 0;
}

/** The changes pane's width in agent mode until the user drags it. */
export function defaultChanges(): number {
  return DEFAULT.changes + controlsStep();
}

/** The agent pane's width in editor mode until the user drags it. */
export function defaultEditAgent(): number {
  return DEFAULT.editAgent + controlsStep();
}

/** The least the changes pane is drawn at: room in its header for the
    corner, and for the window's own buttons after it where the app draws
    them, so neither ever covers the other. */
export function minChanges(): number {
  return MIN.changes + controlsStep();
}

/** How wide the sessions pane's column is while the pane is folded, on
    Windows and Linux. */
export const FOLDED = 50;

/** The folded column on macOS, wide enough to hold the window's three
    buttons, from 18 to 76 pixels in, on its own ground with even room on
    either side: in the modern look the column starts at the window's edge,
    in the terminal look its box stands inside the frame's padding. It
    keeps that width in full screen, so nothing moves on the way in. */
export const FOLDED_WIDE = { modern: 86, terminal: 74 } as const;

/** How wide the folded sessions column is on this platform and in the
    look in use. */
export function folded(): number {
  return isMac() ? FOLDED_WIDE[theme.look] : FOLDED;
}

/** Content width below which the sessions pane cannot open alongside the rest. */
export const NEEDS_SESSIONS =
  MIN.sessions + SPLITTER + MIN.changes + SPLITTER + MIN.agent;
/** Content width below which even the changes pane has to go, beside the
    folded sessions pane. */
export const NEEDS_CHANGES =
  FOLDED + SPLITTER + MIN.changes + SPLITTER + MIN.agent;

/** What stands before the panes in compact mode, where the sessions pane is
    not in the layout: in the modern look the same gap of ground as at the
    window's right edge, in the terminal look nothing past the frame's
    padding. */
export const COMPACT_EDGE = { modern: SPLITTER, terminal: 0 } as const;

/** What the sessions pane takes in the layout while it is not open, the
    gap beside it included: the folded column, or in compact mode only the
    edge before the panes. */
export function foldedColumn(): number {
  return compact.on ? COMPACT_EDGE[theme.look] : folded() + SPLITTER;
}

/** `NEEDS_SESSIONS` and `NEEDS_CHANGES` on this platform, where the
    changes pane's least width and the folded column are its own. */
function needsSessions(): number {
  return NEEDS_SESSIONS - MIN.changes + minChanges();
}

function needsChanges(): number {
  return foldedColumn() + minChanges() + SPLITTER + MIN.agent;
}

/** `NEEDS_AGENT_WHILE_REVIEWING` beside this platform's folded column, or
    beside nothing in compact mode. */
function needsAgentWhileReviewing(): number {
  return foldedColumn() + MIN.agent + SPLITTER + MIN_REVIEW;
}
/**
 * Content width below which reviewing hides the agent rather than squeezing it.
 * Hiding costs nothing: the pane keeps its width, so the PTY is never resized
 * and the terminal comes back exactly as it was. Squeezing costs a reflow.
 */
export const NEEDS_AGENT_WHILE_REVIEWING =
  FOLDED + SPLITTER + MIN.agent + SPLITTER + MIN_REVIEW;
/** Content height below which the terminal panel cannot fit under the panes. */
export const NEEDS_TERMINAL = MIN.panes + SPLITTER + MIN.terminal;

const KEY = "workbench.layout";

export const layout = $state({
  sessions: DEFAULT.sessions as number,
  changes: defaultChanges(),
  /** Whether the user dragged the changes pane's width, which then stays
      theirs; until then it follows the default. */
  changesDragged: false,
  review: DEFAULT.review as number,
  tree: DEFAULT.tree as number,
  terminal: DEFAULT.terminal as number,
  terminalList: DEFAULT.terminalList as number,
  /** The tree column and the agent pane while editing, remembered apart
      from the other shapes' widths. */
  editTree: DEFAULT.editTree as number,
  editAgent: defaultEditAgent(),
  /** Whether the user dragged the agent's width while editing. */
  editAgentDragged: false,
  /** The tree column and the agent as drawn while editing: the widths
      chosen, or less where the window squeezes them. A squeeze never
      replaces the width chosen, which comes back once there is room. */
  editTreeDrawn: DEFAULT.editTree as number,
  editAgentDrawn: defaultEditAgent(),
  sessionsChosen: true,
  changesChosen: true,
  terminalChosen: false,
  sessionsForced: false,
  changesForced: false,
  terminalForced: false,
  agentHidden: false,
  /** The agent pane on the right while editing, shown rather than put
      away by the right pane's toggle. Persisted. */
  agentChosen: true,
  /** The tree column beside the editor given up because the window cannot
      hold it. Transient. */
  editTreeForced: false,
  /** The folded sessions pane drawn over the pane beside it at its open
      width, while reviewing or while the window folds it for the editor:
      from a hover on its column or the focus chord. Transient. */
  sessionsPeek: false,
  /** Set once you drag the viewer's splitter, so we stop sizing it for you. */
  reviewTouched: false,
  /** The sections under the tree, media, processes and the browser: their
      share of the changes pane's height when one is open, and which are
      open rather than folded to their header. */
  mediaShare: 0.3,
  mediaOpen: false,
  processesOpen: false,
  browserOpen: false,
  /** The sessions the session on screen started, open rather than folded
      to its header: open until folded, since what they are doing is what
      the section is for. */
  startedOpen: true,
  /** A plugin's section, by source, plugin and section: open rather than
      folded. Absent is folded, which is how one first appears. */
  sectionsOpen: {} as Record<string, boolean>,
  /** How the sessions pane orders the projects: the latest used first,
      or by name. */
  projectSort: "used" as ProjectSort,
  mode: "working" as Mode,
  focus: "agent" as PaneId,
  /** Counts every request to focus a pane by key, so a pane that already
      has the focus state still takes the keyboard when asked again. */
  focusRequest: 0,
  width: 1200,
  height: 800,
  /** The window is full screen, or on its way in, which on macOS takes the
      traffic lights off the header. */
  fullScreen: false,
});

export type ProjectSort = "used" | "name";

/** Whether the sessions pane is open in its column. Never in compact mode,
    where it has no column. */
export function sessionsVisible() {
  return !compact.on && layout.sessionsChosen && !layout.sessionsForced;
}

/** Whether the sessions pane is drawn open: in its column, or peeked over
    the panes beside it. */
export function sessionsShown() {
  return sessionsVisible() || layout.sessionsPeek;
}

/** Set while a change of shape waits for the frame that mounts what it
    brings before its columns move: until the sessions column moves, the
    pane is drawn as it was. */
export const shaping = $state({ sessions: false });

/** Whether the sessions pane is drawn open: `sessionsShown`, or while a
    change of shape waits to move, what its column is still set to. It is
    for drawing only: focus, the tab order, what is inert and the palette
    follow `sessionsShown`, which differs from it for as long as the change
    waits. */
export function sessionsDrawnOpen() {
  if (shaping.sessions) return sessionsOpen.target === 1 || layout.sessionsPeek;
  return sessionsShown();
}

/** Whether the folded sessions pane peeks rather than opens: in compact
    mode, where it has no column to open into; while reviewing, where the
    fold is the shape's and opening the pane for real would close the
    viewer; and while editing in a window that folds it to keep the
    editor's room, where there is nothing to open it into. */
export function peekable(): boolean {
  return (
    compact.on ||
    layout.mode === "reviewing" ||
    (layout.mode === "editing" && layout.sessionsForced)
  );
}

/** The pane that had the focus when the pane peeked, which in compact mode
    takes the keyboard back when it goes. */
let peekedFrom: PaneId | null = null;

/** Peeks the folded sessions pane over the pane beside it, or puts it
    back. Only where `peekable` says. Putting it back takes the keyboard
    with it: in compact mode back to the pane it came from, otherwise to
    the files pane, the viewer or the editor. */
export function peekSessions(on: boolean) {
  if (on && (!peekable() || sessionsVisible())) return;
  if (layout.sessionsPeek === on) return;
  layout.sessionsPeek = on;
  if (on) {
    peekedFrom = layout.focus === "sessions" ? null : layout.focus;
    return;
  }
  if (layout.focus === "sessions") {
    layout.focus = compact.on ? cameFrom() : "changes";
    layout.focusRequest += 1;
  }
}

/** The pane the keyboard goes back to from a compact pane: the one it came
    from while that is still there, else the agent, else the files pane. */
function cameFrom(): PaneId {
  const from = peekedFrom;
  if (from === "changes" && changesVisible()) return from;
  if (from === "terminal" && terminalVisible()) return from;
  if (from === "agent" && agentVisible()) return from;
  return agentVisible() ? "agent" : "changes";
}

/**
 * How far the sessions column is open, from 0, folded, to 1, the pane's own
 * width. The panes beside it give up and take back the room as it moves. It
 * follows `sessionsVisible`, eased by the page.
 */
export const sessionsOpen = new Tween(1);

/** The sessions column's width in whole pixels, the splitter beside it
    left out, `open` of the way from folded to open. */
function sessionsWidth(open: number): number {
  return Math.round(folded() + (layout.sessions - folded()) * open);
}

/** The sessions column's width as the grid takes it, folded or open or on
    its way in whole pixels, the splitter beside it included. In compact
    mode the pane is not in the layout, and the column is only the edge
    before the panes. */
export function sessionsTrack(): string {
  return compact.on
    ? `${COMPACT_EDGE[theme.look]}px`
    : `calc(${sessionsWidth(sessionsOpen.current)}px + var(--splitter-w))`;
}

/** The changes column's width in pixels, following `changesWidth` and eased
    by the page between the working and reviewing widths. */
export const changesSpan = new Tween<number>(defaultChanges());

/** The changes column's width in whole pixels, at rest or on its way. */
export function changesColumn(): number {
  return Math.round(changesSpan.current);
}

/** While the changes column is on its way to a new width, how much wider
    than the column its contents are laid out: the width it is going to,
    less the one it has. The contents are laid out once, at the width they
    end at, from the moment the change is asked for, and the column cuts
    them off or stands short of them, so the tree's rows are not laid out
    again at every width on the way. Zero at rest, and while editing, where
    the column takes the room the others leave. */
export function changesHeld(): number {
  if (layout.mode === "editing" || !agentVisible()) return 0;
  return Math.round(changesWidth()) - changesColumn();
}

/** The same for the agent while the columns either side of it move: the
    width it ends at less the one it has, so a conversation wraps once, as
    the columns set off, rather than at every width on the way. While
    editing the agent's column has a width of its own. */
export function agentHeld(): number {
  if (layout.mode === "editing" || !agentVisible()) return 0;
  const sessions = compact.on ? 0 : sessionsWidth(sessionsOpen.current) - sessionsWidth(sessionsOpen.target);
  const changes = changesVisible() ? changesColumn() - Math.round(changesSpan.target) : 0;
  return sessions + changes;
}

/** How far the terminal panel is up, from 0 to 1, following
    `terminalVisible` and eased by the page. */
export const terminalOpen = new Tween(0);

const columnsMoving = $derived(
  sessionsOpen.current !== sessionsOpen.target ||
    changesSpan.current !== changesSpan.target ||
    terminalOpen.current !== terminalOpen.target,
);

/** A column or the terminal panel is on its way to a new size. Terminals
    keep the size they had until it arrives, so a pty hears one resize rather
    than one a frame. */
export function sliding() {
  return columnsMoving;
}

/** The changes pane is there: on the right by its toggle while working
    and reviewing, and always while editing, where it is the middle. */
export function changesVisible() {
  if (layout.mode === "editing") return true;
  return layout.changesChosen && !layout.changesForced;
}

/** The agent pane is shown: everywhere but reviewing in a narrow window,
    and while editing, wherever the window and its toggle leave it. */
export function agentVisible() {
  if (layout.agentHidden) return false;
  return layout.mode !== "editing" || layout.agentChosen;
}

/** The tree column beside the editor is there. */
export function editTreeVisible() {
  return layout.mode === "editing" && !layout.editTreeForced;
}

/** The pane at the right of the window in this mode: the changes pane in
    agent mode, the agent pane while editing. Its toggle shows and hides
    it, and the mode switch stands at the end of its header. */
export function rightPane(): "changes" | "agent" {
  return layout.mode === "editing" ? "agent" : "changes";
}

export function terminalVisible() {
  return layout.terminalChosen && !layout.terminalForced;
}

/** The pane beside the sessions column: the agent, or the changes pane
    when the agent is away, and the changes pane while editing. */
export function besideSessions(): PaneId {
  if (layout.mode === "editing") return "changes";
  return agentVisible() ? "agent" : "changes";
}

/** The pane at the right edge of the top row, whose header carries the
    mode switch, and the window controls on Windows and Linux. */
export function rightmost(): PaneId {
  if (layout.mode === "editing") return agentVisible() ? "agent" : "changes";
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
  resolveLayout(width, height);
  leaveHiddenPane();
}

/** A pane that is no longer shown cannot hold the keyboard: the focus state
    goes to the agent pane, which is there whenever the other panes are gone.
    The panes are asked to take the keyboard only when it is on the page body
    or inside the pane that went away; an overlay holding it keeps it. */
function leaveHiddenPane() {
  const hidden =
    (layout.focus === "sessions" && !sessionsShown()) ||
    (layout.focus === "changes" && !changesVisible()) ||
    (layout.focus === "agent" && !agentVisible() && changesVisible());
  if (!hidden) return;
  const gone = layout.focus;
  // The agent is the pane that is there when the others are gone; while it
  // is hidden, the files pane is.
  layout.focus = gone === "agent" ? "changes" : agentVisible() ? "agent" : "changes";
  if (typeof document === "undefined") {
    layout.focusRequest += 1;
    return;
  }
  const owner = document.activeElement;
  const pane = document.querySelector(`section[data-pane="${gone}"]`);
  if (owner === null || owner === document.body || pane?.contains(owner)) {
    layout.focusRequest += 1;
  }
}

function resolveLayout(width: number, height: number) {
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
  const listRoom = width - INNER - MIN.shells;
  layout.terminalList = Math.min(
    Math.max(layout.terminalList, MIN.terminalList),
    Math.max(MIN.terminalList, listRoom),
  );

  if (layout.mode === "editing") {
    resolveEditing(width);
    return;
  }

  if (layout.mode === "reviewing") {
    layout.sessionsForced = true;
    layout.changesForced = false;
    layout.sessionsPeek &&= !sessionsVisible();
    layout.agentHidden = width < needsAgentWhileReviewing();

    const beside = width - foldedColumn();
    const room = layout.agentHidden ? beside : beside - SPLITTER - MIN.agent;
    layout.review = Math.min(
      Math.max(layout.review, MIN_REVIEW),
      Math.max(MIN_REVIEW, room),
    );

    // Inside the pane, the content keeps its minimum and the tree gives way.
    const treeRoom = layout.review - INNER - MIN.viewer;
    layout.tree = Math.min(
      Math.max(layout.tree, MIN.tree),
      Math.max(MIN.tree, treeRoom),
    );
    return;
  }

  layout.agentHidden = false;
  if (!compact.on) layout.sessionsPeek = false;
  layout.sessionsForced = !compact.on && width < needsSessions();
  layout.changesForced = width < needsChanges();

  const showSessions = sessionsVisible();
  const showChanges = changesVisible();

  let sessions = showSessions
    ? Math.max(MIN.sessions, layout.sessions)
    : layout.sessions;
  let changes = showChanges
    ? Math.max(minChanges(), layout.changes)
    : layout.changes;

  // The sessions column is there either way, folded or open, or only its
  // edge in compact mode.
  let overflow =
    (showSessions ? sessions + SPLITTER : foldedColumn()) +
    (showChanges ? changes + SPLITTER : 0) +
    MIN.agent -
    width;

  // The changes pane gives way first: while you are working, the file list is
  // the thing you can most afford to have narrow.
  if (overflow > 0 && showChanges) {
    const give = Math.min(overflow, changes - minChanges());
    changes -= give;
    overflow -= give;
  }
  if (overflow > 0 && showSessions) {
    sessions -= Math.min(overflow, sessions - MIN.sessions);
  }

  layout.sessions = sessions;
  layout.changes = changes;
}

/**
 * What gives way while editing, in order: the sessions pane folds, the tree
 * column goes, and the agent is hidden rather than squeezed below its
 * minimum. The agent and the tree keep their widths until the editor would
 * get less than `MIN.editor` with the panes before them folded, and then
 * give way down to their minimums before they go.
 */
function resolveEditing(width: number) {
  layout.changesForced = false;
  const beside = width - foldedColumn();

  layout.agentHidden = beside - SPLITTER - MIN.agent < MIN.editor;
  layout.editAgentDrawn = layout.agentHidden
    ? layout.editAgent
    : clamp(layout.editAgent, MIN.agent, beside - SPLITTER - MIN.editor);
  const agent = agentVisible() ? SPLITTER + layout.editAgentDrawn : 0;

  layout.editTreeForced = beside - agent - INNER - MIN.tree < MIN.editor;
  layout.editTreeDrawn = layout.editTreeForced
    ? layout.editTree
    : clamp(layout.editTree, MIN.tree, beside - agent - INNER - MIN.editor);
  const tree = layout.editTreeForced ? 0 : layout.editTreeDrawn + INNER;

  layout.sessionsForced =
    !compact.on && width - layout.sessions - SPLITTER - tree - agent < MIN.editor;
  layout.sessionsPeek &&= compact.on || (!sessionsVisible() && layout.sessionsForced);
}

function clamp(value: number, least: number, most: number) {
  return Math.min(Math.max(value, least), Math.max(least, most));
}

/** What the sessions column takes while editing, the splitter included. */
function sessionsColumn() {
  return sessionsVisible() ? layout.sessions + SPLITTER : foldedColumn();
}

/** Drags the agent pane's edge while editing, from where it is drawn: the
    width the drag ends at is the one chosen. The editor keeps its room
    with the panes as they are: a drag never folds or hides one. */
export function resizeEditAgent(dx: number) {
  const tree = editTreeVisible() ? layout.editTreeDrawn + INNER : 0;
  const most = layout.width - sessionsColumn() - tree - SPLITTER - MIN.editor;
  layout.editAgent = clamp(layout.editAgentDrawn - dx, MIN.agent, most);
  layout.editAgentDragged = true;
  applyLayout(layout.width);
}

/** Drags the tree column's edge while editing, on the same terms. */
export function resizeEditTree(dx: number) {
  const agent = agentVisible() ? SPLITTER + layout.editAgentDrawn : 0;
  const most = layout.width - sessionsColumn() - agent - INNER - MIN.editor;
  layout.editTree = clamp(layout.editTreeDrawn + dx, MIN.tree, most);
  applyLayout(layout.width);
}

/** The editing widths back at their defaults, as far as the window allows. */
export function resetEditAgent() {
  layout.editAgent = defaultEditAgent();
  layout.editAgentDragged = false;
  applyLayout(layout.width);
  saveLayout();
}

export function resetEditTree() {
  layout.editTree = DEFAULT.editTree;
  applyLayout(layout.width);
  saveLayout();
}

/**
 * Flips the window between agent mode and editor mode. Into editing the
 * keyboard goes to the files pane, which puts it in the editor or the tree;
 * back out, the agent has the middle again and takes it. The sessions pane
 * keeps the choice it had: a fold the editor forced is forgotten with the
 * shape.
 */
export function setEditing(on: boolean) {
  if (on === (layout.mode === "editing")) return;
  layout.sessionsPeek = false;
  layout.mode = on ? "editing" : "working";
  layout.sessionsForced = false;
  layout.editTreeForced = false;
  layout.agentHidden = false;
  applyLayout(layout.width);
  layout.focus = on ? "changes" : "agent";
  layout.focusRequest += 1;
  saveLayout();
}

/** Shows or hides the right pane: the changes pane in agent mode, the
    agent pane while editing. */
export function toggleRightPane(): "shown" | "hidden" | "no room" {
  if (layout.mode !== "editing") {
    // A pane the window is too narrow for has nowhere to come back to.
    if (layout.changesForced && !changesVisible()) return "no room";
    togglePane("changes");
    return changesVisible() ? "shown" : "hidden";
  }
  if (layout.agentHidden) return "no room";
  layout.agentChosen = !layout.agentChosen;
  if (!agentVisible() && layout.focus === "agent") {
    layout.focus = "changes";
    layout.focusRequest += 1;
  }
  applyLayout(layout.width);
  saveLayout();
  return agentVisible() ? "shown" : "hidden";
}

export function enterReview() {
  if (layout.mode === "reviewing" || layout.mode === "editing") return;

  // The pane holds a tree beside the content, and the content is what is
  // being read: it opens at its share of the window, or wider when the
  // changes pane and what the sessions pane vacates already come to more.
  // Opening the viewer therefore costs the agent one resize, on a deliberate
  // mode change rather than on every file, and it gets the width straight
  // back on exit.
  if (!layout.reviewTouched) {
    const freed = sessionsVisible() ? layout.sessions - folded() : 0;
    layout.review = Math.max(
      DEFAULT.review,
      layout.changes + freed,
      Math.round(layout.width * REVIEW_SHARE),
    );
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
  if (layout.mode !== "reviewing") return;
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

/** Orders the sessions pane's projects one way or the other, and
    remembers which. */
export function setProjectSort(sort: ProjectSort) {
  if (layout.projectSort === sort) return;
  layout.projectSort = sort;
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
  if (id === "sessions" && !sessionsShown()) return;
  if (id === "changes" && !changesVisible()) return;
  if (id === "agent" && !agentVisible()) return;
  if (id === "terminal" && !terminalVisible()) return;
  layout.focus = id;
  layout.focusRequest += 1;
}

/**
 * A pointer went down inside a browser tab's page: the changes pane is
 * marked focused, since that is where the tab lives, but the keyboard stays
 * with the page. Unlike [`focusPane`] this never bumps `focusRequest`, the
 * signal a pane reads as "take the keyboard, even if you already have it";
 * without it, a pane already holding the DOM's own focus keeps it.
 */
export function browserFocused() {
  if (!changesVisible()) return;
  layout.focus = "changes";
}

/** Whether a dialog or the palette has the keyboard. A pane never takes it
    from one; the overlay hands it back when it goes. */
export function overlayHoldsKeyboard(): boolean {
  if (typeof document === "undefined") return false;
  return document.activeElement?.closest('[aria-modal="true"]') != null;
}

/** Whether a question in a strip has the keyboard: one put in a pane
    before something is taken away, which holds the keyboard without being
    a dialog. */
export function questionHoldsKeyboard(): boolean {
  if (typeof document === "undefined") return false;
  return document.activeElement?.closest('[role="alertdialog"]') != null;
}

/**
 * Hands the keyboard back to the pane that has the focus state. A dialog
 * takes the document's focus while it is up and leaves it on nothing when it
 * goes; without this the pane would still be named as focused while its keys
 * went nowhere.
 */
export function returnFocus() {
  layout.focusRequest += 1;
}

/** Whether a saved width is one the user dragged: as the layout says, or,
    where it does not say, when the width is other than the base default. */
function dragged(said: unknown, width: unknown, base: number): boolean {
  if (typeof width !== "number") return false;
  return typeof said === "boolean" ? said : width !== base;
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
    // A width the user dragged stays theirs; one never dragged follows the
    // default, which differs by platform. A layout saved without saying
    // counts as dragged where it holds other than the base default.
    const changesDragged = dragged(v.changesDragged, v.changes, DEFAULT.changes);
    layout.changes = changesDragged ? v.changes : defaultChanges();
    layout.changesDragged = changesDragged;
    if (typeof v.review === "number") layout.review = v.review;
    if (typeof v.tree === "number") layout.tree = v.tree;
    if (typeof v.terminal === "number") layout.terminal = v.terminal;
    if (typeof v.terminalList === "number")
      layout.terminalList = v.terminalList;
    if (typeof v.editTree === "number") layout.editTree = v.editTree;
    const editAgentDragged = dragged(v.editAgentDragged, v.editAgent, DEFAULT.editAgent);
    layout.editAgent = editAgentDragged ? v.editAgent : defaultEditAgent();
    layout.editAgentDragged = editAgentDragged;
    // Drawn as read until the layout is laid out for the window, so the
    // first frame after a restart draws them, not the defaults.
    layout.editTreeDrawn = layout.editTree;
    layout.editAgentDrawn = layout.editAgent;
    if (typeof v.agentChosen === "boolean") layout.agentChosen = v.agentChosen;
    if (v.editing === true) layout.mode = "editing";
    if (typeof v.reviewTouched === "boolean")
      layout.reviewTouched = v.reviewTouched;
    if (
      typeof v.mediaShare === "number" &&
      v.mediaShare > 0 &&
      v.mediaShare < 1
    )
      layout.mediaShare = v.mediaShare;
    if (typeof v.mediaOpen === "boolean") layout.mediaOpen = v.mediaOpen;
    if (typeof v.processesOpen === "boolean")
      layout.processesOpen = v.processesOpen;
    if (typeof v.browserOpen === "boolean")
      layout.browserOpen = v.browserOpen;
    if (typeof v.startedOpen === "boolean")
      layout.startedOpen = v.startedOpen;
    if (v.sectionsOpen !== null && typeof v.sectionsOpen === "object") {
      const open: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(v.sectionsOpen)) {
        if (typeof value === "boolean") open[key] = value;
      }
      layout.sectionsOpen = open;
    }
    if (v.projectSort === "used" || v.projectSort === "name")
      layout.projectSort = v.projectSort;
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
 * Persists intent and widths, and whether the window is in editor mode,
 * which belongs to the window. Forced collapses are a fact about the current
 * window, and reviewing is where you happen to be right now: neither belongs
 * in storage, and saving either would make the app reopen wrong.
 */
export function saveLayout() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        sessions: layout.sessions,
        changes: layout.changes,
        changesDragged: layout.changesDragged,
        review: layout.review,
        tree: layout.tree,
        terminal: layout.terminal,
        terminalList: layout.terminalList,
        editTree: layout.editTree,
        editAgent: layout.editAgent,
        editAgentDragged: layout.editAgentDragged,
        agentChosen: layout.agentChosen,
        editing: layout.mode === "editing",
        reviewTouched: layout.reviewTouched,
        mediaShare: layout.mediaShare,
        mediaOpen: layout.mediaOpen,
        processesOpen: layout.processesOpen,
        browserOpen: layout.browserOpen,
        startedOpen: layout.startedOpen,
        sectionsOpen: layout.sectionsOpen,
        projectSort: layout.projectSort,
        sessionsChosen: layout.sessionsChosen,
        changesChosen: layout.changesChosen,
        terminalChosen: layout.terminalChosen,
      }),
    );
  } catch {
    // Non-fatal: the layout simply does not survive a restart.
  }
}
