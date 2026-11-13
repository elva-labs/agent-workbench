import type { InactiveAfter, Settings } from "$lib/core";
import type { ProjectSort } from "$lib/layout.svelte";
import { lastSegment } from "$lib/paths";
import { persist } from "$lib/persist";
import { isLive, sessions, type Session } from "$lib/sessions.svelte";

/**
 * The projects as the sessions pane splits them: active and inactive.
 *
 * A project is active while one of its sessions is live or unread, or
 * while it was used within a span the settings name. The rest fold under
 * Inactive at the foot of the pane. Nothing is filed by hand: a project
 * moves between the two as it is used and left alone.
 *
 * Last used is the latest of three things: the project being brought
 * forward, a row of its own changing, and a transcript of its own being
 * written, which is how a session run outside the app counts too.
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

/** The project was brought forward: it counts as used now. */
export function touch(path: string, now = Date.now()) {
  projects.used[path] = now;
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

/** When the project was last used, in milliseconds, or null when nothing
    says. A row left from the last quit says it through its transcript,
    since the row itself was only drawn again at the start. */
export function lastUsed(path: string): number | null {
  let latest = projects.used[path] ?? null;
  const later = (at: number) => {
    if (latest === null || at > latest) latest = at;
  };
  for (const session of rowsOf(path)) {
    if (session.status !== "dormant") later(session.changedAt);
  }
  const history = sessions.history[path] ?? [];
  // Newest first, as the history is kept.
  if (history.length > 0) later(history[0].modified * 1000);
  return latest;
}

/** Whether a project is active: one of its sessions is live or waiting
    for the user, it is the one on screen, or it was used within the span.
    With the span set to never, every project is. */
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
  if (rowsOf(path).some((session) => isLive(session) || session.unread))
    return true;
  const at = lastUsed(path);
  return at !== null && now - at <= span;
}

/** The projects in the order chosen: the latest used first, the ones
    nothing dates last, or by folder name. Ties go by path, so the order
    never flickers. */
export function sortProjects(paths: string[], sort: ProjectSort): string[] {
  const name = (path: string) => lastSegment(path).toLowerCase();
  const used = new Map(paths.map((path) => [path, lastUsed(path) ?? -Infinity]));
  return [...paths].sort((a, b) => {
    if (sort === "used") {
      const at = used.get(b)! - used.get(a)!;
      if (at !== 0 && !Number.isNaN(at)) return at;
    }
    const byName = name(a).localeCompare(name(b));
    return byName !== 0 ? byName : a.localeCompare(b);
  });
}

/** The projects split into the active and the inactive, each in the
    order chosen. */
export function splitProjects(
  paths: string[],
  current: string | null,
  sort: ProjectSort,
  now = Date.now(),
): { active: string[]; inactive: string[] } {
  const ordered = sortProjects(paths, sort);
  const active = new Set(ordered.filter((path) => isActive(path, current, now)));
  return {
    active: ordered.filter((path) => active.has(path)),
    inactive: ordered.filter((path) => !active.has(path)),
  };
}

/** Test seam. */
export function resetProjects() {
  projects.used = {};
  projects.inactiveAfter = "week";
}
