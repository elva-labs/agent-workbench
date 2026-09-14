/**
 * The sections plugins put under the file tree: their rows for each open
 * project, the actions their headers and rows carry, and what an action
 * that failed had to say.
 *
 * A plugin sends a section's whole list of rows whenever it changes, per
 * project, so the window keeps the latest of each and never merges. A
 * section stands while it has rows, actions or a line of detail, and goes
 * for that project when it has none of the three, which is what a plugin
 * stopping looks like from here.
 *
 * The sections of one plugin are drawn together: the one it declared first
 * is the plugin's face, and the rest are groups inside its fold.
 */

import {
  core,
  type PluginAction,
  type PluginNoticeEvent,
  type PluginRow,
  type PluginSectionEvent,
} from "$lib/core";
import { workspace } from "$lib/workspace.svelte";

/** A section as one project has it. */
export interface PluginSection {
  /** Source, plugin and section, which is what the fold is remembered by. */
  key: string;
  source: string;
  plugin: string;
  section: string;
  title: string;
  /** A short line beside the title, or nothing. */
  detail: string | null;
  project: string;
  rows: PluginRow[];
  actions: PluginAction[];
  /** Whether the group starts folded when nothing is remembered for it. */
  folded: boolean;
  /** Where the section stands among the ones its plugin declared. */
  order: number;
}

/** One plugin's sections in the project on screen, as one fold. */
export interface PluginGroup {
  /** Source and plugin, which is what the fold is remembered by. */
  key: string;
  source: string;
  plugin: string;
  /** The first section's title, which names the fold. */
  title: string;
  /** The first section's detail, beside that title. */
  detail: string | null;
  /** The sections, the first one first. */
  sections: PluginSection[];
  /** Every section's rows counted together. */
  count: number;
}

/** How long a failed action's word stays on its plugin's sections. */
export const NOTICE_MS = 8000;

export const pluginSections = $state({
  sections: [] as PluginSection[],
  /** What went wrong, by `${source}/${plugin}`, until it is cleared. */
  notices: {} as Record<string, string>,
  /** The action whose fields are being asked for, if any. */
  pending: null as {
    key: string;
    action: PluginAction;
    row: string | null;
  } | null,
});

const timers: Record<string, ReturnType<typeof setTimeout>> = {};

export function keyOf(event: {
  source: string;
  plugin: string;
  section: string;
}): string {
  return `${event.source}/${event.plugin}/${event.section}`;
}

function pluginOf(section: { source: string; plugin: string }): string {
  return `${section.source}/${section.plugin}`;
}

/** The latest rows a plugin sent for one of its sections in a project. */
export function sectionChanged(event: PluginSectionEvent) {
  const key = keyOf(event);
  const at = pluginSections.sections.findIndex(
    (section) => section.key === key && section.project === event.project,
  );
  const nothing =
    event.rows.length === 0 &&
    event.actions.length === 0 &&
    (event.detail === null || event.detail === "");
  if (nothing) {
    if (at !== -1) pluginSections.sections.splice(at, 1);
    if (pluginSections.pending?.key === key) pluginSections.pending = null;
    return;
  }
  const section: PluginSection = {
    key,
    source: event.source,
    plugin: event.plugin,
    section: event.section,
    title: event.title,
    detail: event.detail,
    project: event.project,
    rows: event.rows,
    actions: event.actions,
    folded: event.folded,
    order: event.order,
  };
  if (at === -1) pluginSections.sections.push(section);
  else pluginSections.sections[at] = section;
}

/** A word from a plugin, on its sections for a while. */
export function noticed(event: PluginNoticeEvent) {
  say(pluginOf(event), event.text);
}

function say(plugin: string, text: string) {
  pluginSections.notices[plugin] = text;
  const running = timers[plugin];
  if (running !== undefined) clearTimeout(running);
  timers[plugin] = setTimeout(() => {
    delete timers[plugin];
    delete pluginSections.notices[plugin];
  }, NOTICE_MS);
}

/** What a plugin last said, for any section of its. */
export function noticeOf(section: {
  source: string;
  plugin: string;
}): string | null {
  return pluginSections.notices[pluginOf(section)] ?? null;
}

/** The sections of the project on screen, plugin by plugin and section by
    section, so the order under the tree does not move as rows arrive. */
export function listed(): PluginSection[] {
  const project = workspace.active;
  if (project === null) return [];
  return pluginSections.sections
    .filter((section) => section.project === project)
    .sort(
      (a, b) =>
        a.plugin.localeCompare(b.plugin) || a.section.localeCompare(b.section),
    );
}

/** The sections of the project on screen, one group per plugin, in the
    order `listed` puts the plugins in. Within a group the sections stand
    as the plugin declared them, and the first of them names the group. */
export function grouped(): PluginGroup[] {
  const groups: PluginGroup[] = [];
  for (const section of listed()) {
    const key = pluginOf(section);
    let group = groups.find((candidate) => candidate.key === key);
    if (group === undefined) {
      group = {
        key,
        source: section.source,
        plugin: section.plugin,
        title: section.title,
        detail: section.detail,
        sections: [],
        count: 0,
      };
      groups.push(group);
    }
    group.sections.push(section);
  }
  for (const group of groups) {
    group.sections.sort(
      (a, b) => a.order - b.order || a.section.localeCompare(b.section),
    );
    group.title = group.sections[0].title;
    group.detail = group.sections[0].detail;
    group.count = group.sections.reduce(
      (total, section) => total + section.rows.length,
      0,
    );
  }
  return groups;
}

/** The section a key names in the project on screen. */
export function sectionOf(key: string): PluginSection | null {
  return listed().find((section) => section.key === key) ?? null;
}

/** Takes an action, on the section's header when the row is null. What the
    core refuses becomes the plugin's notice. */
export async function run(
  section: PluginSection,
  action: PluginAction,
  row: string | null,
  input: Record<string, string> = {},
) {
  try {
    await core().pluginAction({
      source: section.source,
      plugin: section.plugin,
      section: section.section,
      action: action.id,
      row,
      input,
      project: section.project,
    });
  } catch (error) {
    say(pluginOf(section), String(error));
  }
}

/** Asks for an action's fields before it runs. */
export function askFor(
  section: PluginSection,
  action: PluginAction,
  row: string | null,
) {
  pluginSections.pending = { key: section.key, action, row };
}

export function cancelAction() {
  pluginSections.pending = null;
}

/** Test seam. */
export function resetPluginSections() {
  for (const key of Object.keys(timers)) {
    clearTimeout(timers[key]);
    delete timers[key];
  }
  for (const key of Object.keys(pluginSections.notices))
    delete pluginSections.notices[key];
  pluginSections.sections = [];
  pluginSections.pending = null;
}
