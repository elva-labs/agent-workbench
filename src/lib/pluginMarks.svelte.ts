/**
 * The marks plugins put on session rows: an icon from a fixed set, a count
 * and how it is doing. A plugin has at most one mark on a session, and
 * sends it whole whenever it changes; a mark with no icon is the plugin
 * taking its mark away, which is also what the core sends when the plugin
 * stops or the session ends.
 */

import type { PluginMarkEvent, PluginMarkIcon } from "$lib/core";

/** A plugin's mark on one session's row. */
export interface PluginMark {
  /** Source and plugin, one mark each per session. */
  plugin: string;
  icon: PluginMarkIcon;
  count: number | null;
  state: "ok" | "busy" | "waiting" | "failed" | null;
  label: string | null;
}

export const pluginMarks = $state({
  /** The marks on each session's row, by the session's token. */
  bySession: {} as Record<string, PluginMark[]>,
});

/** A plugin's mark on a session, new, changed or gone. */
export function markChanged(event: PluginMarkEvent) {
  const plugin = `${event.source}/${event.plugin}`;
  const marks = (pluginMarks.bySession[event.session] ?? []).filter(
    (mark) => mark.plugin !== plugin,
  );
  if (event.icon !== null)
    marks.push({
      plugin,
      icon: event.icon,
      count: event.count,
      state: event.state,
      label: event.label,
    });
  marks.sort((a, b) => a.plugin.localeCompare(b.plugin));
  if (marks.length === 0) delete pluginMarks.bySession[event.session];
  else pluginMarks.bySession[event.session] = marks;
}

/** The marks on a session's row, plugin by plugin. */
export function marksOf(token: string): PluginMark[] {
  return pluginMarks.bySession[token] ?? [];
}

/** How many marks a row draws: past two the line beside them has no room
    left. */
export const MARKS_SHOWN = 2;

const STANDING = { failed: 0, waiting: 1, busy: 2, ok: 3 } as const;
const standing = (mark: PluginMark) => (mark.state === null ? 3 : STANDING[mark.state]);

/** The marks a row draws, in the plugins' order: all of them up to
    `MARKS_SHOWN`, and past that the ones that need the user most, a failure
    before a wait before work under way. The rest are still in the row's
    words for a screen reader. */
export function shownMarks(marks: PluginMark[]): PluginMark[] {
  if (marks.length <= MARKS_SHOWN) return marks;
  const kept = new Set(
    [...marks].sort((a, b) => standing(a) - standing(b)).slice(0, MARKS_SHOWN),
  );
  return marks.filter((mark) => kept.has(mark));
}

/** What a mark says on hover and to a screen reader. */
export function markLabel(mark: PluginMark): string {
  if (mark.label !== null && mark.label !== "") return mark.label;
  const name = mark.plugin.slice(mark.plugin.lastIndexOf("/") + 1);
  return mark.count === null ? name : `${name}: ${mark.count}`;
}

/** Test seam. */
export function resetPluginMarks() {
  pluginMarks.bySession = {};
}
