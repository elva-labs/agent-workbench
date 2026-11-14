/**
 * The entries of the keys, the hooks and the accounts the settings file
 * holds and the app does not use, with the rule each breaks. The file keeps
 * them as written.
 */

import type { Settings } from "$lib/core";

export type UnreadEntry = NonNullable<Settings["unreadEntries"]>[number];

export const unread = $state({ entries: [] as UnreadEntry[] });

/** Takes the core's list of what it could not read. */
export function adoptUnread(entries: UnreadEntry[] | undefined) {
  unread.entries = entries ?? [];
}

/** The unread entries of one field. */
export function unreadOf(field: UnreadEntry["field"]): UnreadEntry[] {
  return unread.entries.filter((entry) => entry.field === field);
}
