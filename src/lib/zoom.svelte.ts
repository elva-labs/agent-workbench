/**
 * How large each terminal is drawn, set from the keyboard per terminal.
 *
 * A size is held by the row it belongs to while the window runs. An agent
 * session's size is also kept by the session's id in the window's storage,
 * so a session resumed, or brought back after a restart, comes back at the
 * size it had. A shell's size is not kept. Only sizes off the default are
 * kept, and only for the sessions changed most recently.
 */

export const DEFAULT_SIZE = 12;
export const MIN_SIZE = 8;
export const MAX_SIZE = 24;
/** How many sessions' sizes the storage keeps. */
export const MOST_KEPT = 200;

const KEY = "workbench.zoom";

interface Kept {
  size: number;
  /** When it was set, so the oldest go first. */
  at: number;
}

export const zoom = $state({
  /** By row key: a session's or a shell's. */
  rows: {} as Record<string, number>,
  /** By session id, as the storage keeps them. */
  kept: {} as Record<string, Kept>,
});

/** The size a step leads to: a pixel either way within the bounds, or back
    to the default. */
export function stepped(size: number, step: 1 | -1 | 0): number {
  if (step === 0) return DEFAULT_SIZE;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, size + step));
}

/** The size a terminal is drawn at: its row's, else the one kept for its
    session, else the default. */
export function sizeOf(key: string, id: string | null = null): number {
  return zoom.rows[key] ?? (id !== null ? zoom.kept[id]?.size : undefined) ?? DEFAULT_SIZE;
}

/** Steps a terminal's size, and keeps it by the session's id when it has
    one. Answers with the new size. */
export function zoomed(
  key: string,
  id: string | null,
  step: 1 | -1 | 0,
  now = Date.now(),
): number {
  const size = stepped(sizeOf(key, id), step);
  zoom.rows[key] = size;
  if (id !== null) keep(id, size, now);
  return size;
}

/** A session's id became known after its size was set: the size is kept
    under it from now on. */
export function identifiedZoom(key: string, id: string, now = Date.now()) {
  const size = zoom.rows[key];
  if (size !== undefined) keep(id, size, now);
}

function keep(id: string, size: number, now: number) {
  if (size === DEFAULT_SIZE) delete zoom.kept[id];
  else zoom.kept[id] = { size, at: now };
  prune();
  save();
}

/** Drops the sizes set longest ago once there are more than the storage keeps. */
function prune() {
  const ids = Object.keys(zoom.kept);
  if (ids.length <= MOST_KEPT) return;
  ids.sort((a, b) => zoom.kept[b].at - zoom.kept[a].at);
  for (const old of ids.slice(MOST_KEPT)) delete zoom.kept[old];
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(zoom.kept));
  } catch {
    // Non-fatal: the sizes start at the default next time.
  }
}

export function loadZoom() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return;
  }
  if (raw === null) return;
  try {
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== "object" || stored === null) return;
    const kept: Record<string, Kept> = {};
    for (const [id, value] of Object.entries(stored)) {
      if (id === "__proto__") continue;
      if (isKept(value)) kept[id] = { size: value.size, at: value.at };
    }
    zoom.kept = kept;
    prune();
  } catch {
    // A corrupt entry costs the sizes and nothing more.
  }
}

function isKept(value: unknown): value is Kept {
  if (typeof value !== "object" || value === null) return false;
  const { size, at } = value as Record<string, unknown>;
  return (
    typeof size === "number" &&
    Number.isInteger(size) &&
    size >= MIN_SIZE &&
    size <= MAX_SIZE &&
    typeof at === "number"
  );
}

/** Test seam. */
export function resetZoom() {
  zoom.rows = {};
  zoom.kept = {};
}
