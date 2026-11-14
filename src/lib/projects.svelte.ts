import type { InactiveAfter, Settings } from "$lib/core";
import type { ProjectSort } from "$lib/layout.svelte";
import { lastSegment } from "$lib/paths";
import { persist } from "$lib/persist";
import { byKey, isLive, sessions, transcriptAt, type Session } from "$lib/sessions.svelte";

/**
 * The projects as the sessions pane splits and orders them.
 *
 * A project is active while a session drawn under it is live or unread,
 * while it is the one on screen, or while it was in use within a span the
 * settings name. The rest fold under Inactive at the foot of the pane.
 * Nothing is filed by hand: a project moves between the two as it is used
 * and left alone.
 *
 * The order is the user's alone: when a project was last brought forward,
 * or had a session started or picked in it, and for a project the window
 * has no such record of, when one of its own transcripts was last written.
 * What the agents do keeps a project out of Inactive and never moves it.
 */

const USED_KEY = "workbench.used";

export const projects = $state({
  /** When each project was last brought forward, in milliseconds, by
      path. Kept between runs. */
  used: {} as Record<string, number>,
  /** How long a project goes unused before it folds under Inactive. */
  inactiveAfter: "week" as InactiveAfter,
});

/** The spans a project may stay active for without use, in the order they
    are offered, with the milliseconds each stands for. Never has no limit:
    nothing folds. */
export const INACTIVE_AFTER: {
  choice: InactiveAfter;
  label: string;
  ms: number | null;
}[] = [
  { choice: "day", label: "1 day", ms: 24 * 60 * 60 * 1000 },
  { choice: "week", label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { choice: "month", label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
  { choice: "never", label: "Never", ms: null },
];

function isInactiveAfter(value: unknown): value is InactiveAfter {
  return INACTIVE_AFTER.some((span) => span.choice === value);
}

/** The split's part of the settings. */
export function inactiveAfterSettings(): Pick<Settings, "inactiveAfter"> {
  return { inactiveAfter: projects.inactiveAfter };
}

/** Takes the core's word for the span. A value it does not know is a
    week, the span every setup starts with. */
export function adoptInactiveAfter(value: unknown) {
  projects.inactiveAfter = isInactiveAfter(value) ? value : "week";
}

export function setInactiveAfter(value: InactiveAfter) {
  if (projects.inactiveAfter === value) return;
  projects.inactiveAfter = value;
  persist({ inactiveAfter: value });
}

/** The user brought the project forward, or started or picked a session
    in it: it counts as used now. Nothing else stamps it: neither the window
    putting a project in front as it opens, nor an agent asking to show
    something in one. */
export function touch(path: string, now = Date.now()) {
  projects.used[path] = now;
  saveUsed();
}

/** Drops a closed project from the record, so the record holds no more
    than the projects the user keeps open. */
export function forgetUsed(path: string) {
  if (!(path in projects.used)) return;
  delete projects.used[path];
  saveUsed();
}

function saveUsed() {
  try {
    localStorage.setItem(USED_KEY, JSON.stringify(projects.used));
  } catch {
    // Non-fatal: the time does not survive a restart, and the project's
    // own transcripts still say when it was last worked in.
  }
}

/** What is remembered between runs. A corrupt entry reads as nothing
    remembered. */
export function loadUsed() {
  try {
    const raw = localStorage.getItem(USED_KEY);
    if (raw === null) return;
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== "object" || stored === null) return;
    const used: Record<string, number> = {};
    for (const [path, at] of Object.entries(stored)) {
      if (typeof at === "number" && Number.isFinite(at)) used[path] = at;
    }
    projects.used = used;
  } catch {
    // Nothing remembered, then.
  }
}

/** The rows by project, in the window's order. */
const byProject = $derived.by(() => {
  const index = new Map<string, Session[]>();
  for (const session of sessions.all) {
    const list = index.get(session.project);
    if (list === undefined) index.set(session.project, [session]);
    else list.push(session);
  }
  return index;
});

function rowsOf(path: string): Session[] {
  return byProject.get(path) ?? [];
}

/** Where the pane draws a row: under its own project, or hanging under
    the session that started it. Told by the module that knows who started
    what; until then every row is drawn in its own project. */
interface Drawing {
  ownFor: (project: string) => Session[];
  childrenOf: (session: Session) => Session[];
  parentOf: (session: Session) => Session | null;
}

let drawing: Drawing = {
  ownFor: rowsOf,
  childrenOf: () => [],
  parentOf: () => null,
};

export function drawnWith(how: Drawing) {
  drawing = how;
}

/** The project a row is drawn under: its starter's while it hangs under
    one, else its own. */
export function drawnIn(session: Session): string {
  return drawing.parentOf(session)?.project ?? session.project;
}

/** The project on screen as the pane draws it: the one the session on
    screen is drawn under, so a session hanging under its starter keeps the
    starter's project on screen rather than the one it runs in. */
export function onScreen(current: string | null): string | null {
  const session = sessions.active === null ? null : byKey(sessions.active);
  if (session === null || session.project !== current) return current;
  return drawnIn(session);
}

/** The rows drawn under a project: its own, and the sessions those
    started, wherever they run. */
function drawnUnder(path: string): Session[] {
  const own = drawing.ownFor(path);
  return [...own, ...own.flatMap(drawing.childrenOf)];
}

/** When a transcript drawn under the project was last written, in
    milliseconds, or null when it has none: its own, but for those of
    sessions that hang under a starter in another project, and those of
    sessions that hang under one of its rows from another project. */
function written(path: string): number | null {
  const elsewhere = new Set(
    rowsOf(path)
      .filter((session) => session.id !== null && drawnIn(session) !== path)
      .map((session) => session.id),
  );
  // Newest first, as the history is kept.
  const newest = (sessions.history[path] ?? []).find(
    (entry) => !elsewhere.has(entry.id),
  );
  let latest = newest === undefined ? null : newest.modified * 1000;
  for (const row of drawing.ownFor(path)) {
    for (const kid of drawing.childrenOf(row)) {
      if (kid.project === path || kid.id === null) continue;
      const at = transcriptAt(kid.project, kid.id);
      if (at !== null && (latest === null || at > latest)) latest = at;
    }
  }
  return latest;
}

/** When the user last used the project, in milliseconds, which is what
    the projects are ordered by: the window's own record, else the newest
    transcript of its own, else null. */
export function lastUsed(path: string): number | null {
  return projects.used[path] ?? written(path);
}

/** When anything last happened in the project, in milliseconds, or null
    when nothing says: the user using it, a row drawn under it changing,
    or a transcript of its own being written. A row left from the last quit
    says it through its transcript, since the row itself was only drawn
    again at the start. */
export function lastActive(path: string): number | null {
  let latest = projects.used[path] ?? null;
  const later = (at: number | null) => {
    if (at !== null && (latest === null || at > latest)) latest = at;
  };
  for (const session of drawnUnder(path)) {
    if (session.status !== "dormant") later(session.changedAt);
  }
  later(written(path));
  return latest;
}

/** Whether a project is active: a session drawn under it is live or
    waiting for the user, it is the one on screen, or something happened
    in it within the span. With the span set to never, every project is. */
export function isActive(
  path: string,
  current: string | null,
  now = Date.now(),
): boolean {
  if (path === current) return true;
  const span = INACTIVE_AFTER.find(
    (choice) => choice.choice === projects.inactiveAfter,
  )?.ms;
  if (span === null || span === undefined) return true;
  if (drawnUnder(path).some((session) => isLive(session) || session.unread))
    return true;
  const at = lastActive(path);
  return at !== null && now - at <= span;
}

/** The projects in the order chosen: the latest used first, the ones
    nothing dates last, or by folder name. Ties go by path, so the order
    never flickers. */
export function sortProjects(paths: string[], sort: ProjectSort): string[] {
  const name = (path: string) => lastSegment(path).toLowerCase();
  const used = new Map(
    paths.map((path) => [path, lastUsed(path) ?? -Infinity]),
  );
  return [...paths].sort((a, b) => {
    if (sort === "used") {
      const at = used.get(b)! - used.get(a)!;
      if (at !== 0 && !Number.isNaN(at)) return at;
    }
    const byName = name(a).localeCompare(name(b));
    return byName !== 0 ? byName : a.localeCompare(b);
  });
}

/** How often an inactive project's history is read again while the
    window is looked at. The active ones are read on every tick of the
    history clock; nothing much happens in an inactive one, but work done
    there outside the app still wakes it. */
export const QUIET_EVERY = 5 * 60_000;

/** When the inactive projects' histories were last asked for. */
let quietAt = -Infinity;

/** The projects whose history the clock reads now: the active ones every
    time, and the inactive ones as well once every few minutes, and on the
    first reading after `readQuietNext`. */
export function historyDue(
  paths: string[],
  current: string | null,
  now = Date.now(),
): string[] {
  if (now - quietAt >= QUIET_EVERY) {
    quietAt = now;
    return paths;
  }
  return paths.filter((path) => isActive(path, current, now));
}

/** The window came back into view: the next reading takes in the
    inactive projects as well. */
export function readQuietNext() {
  quietAt = -Infinity;
}

/** The projects split into the active and the inactive, each in the
    order chosen. A project that is not active by what is known, and whose
    transcripts have not been read yet, is in neither until they are: they
    may well make it active, and it would move as soon as it was drawn. */
export function splitProjects(
  paths: string[],
  current: string | null,
  sort: ProjectSort,
  now = Date.now(),
): { active: string[]; inactive: string[] } {
  const ordered = sortProjects(paths, sort);
  const active = new Set(
    ordered.filter((path) => isActive(path, current, now)),
  );
  return {
    active: ordered.filter((path) => active.has(path)),
    inactive: ordered.filter(
      (path) => !active.has(path) && sessions.history[path] !== undefined,
    ),
  };
}

/**
 * An order that holds still: the ids already in `shown` keep their places
 * among themselves, the ones gone from `next` drop out, and each new one
 * goes in after the id it follows in `next`, or first when it follows
 * none.
 */
export function steady(shown: string[], next: string[]): string[] {
  const wanted = new Set(next);
  const out = shown.filter((id) => wanted.has(id));
  const placed = new Set(out);
  next.forEach((id, at) => {
    if (placed.has(id)) return;
    let after = at - 1;
    while (after >= 0 && !placed.has(next[after])) after -= 1;
    out.splice(after < 0 ? 0 : out.indexOf(next[after]) + 1, 0, id);
    placed.add(id);
  });
  return out;
}

/** Test seam. */
export function resetProjects() {
  projects.used = {};
  projects.inactiveAfter = "week";
  quietAt = -Infinity;
}
