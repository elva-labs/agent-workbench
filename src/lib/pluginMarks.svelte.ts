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
