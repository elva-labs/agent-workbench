import type { Sent } from "$lib/mention";

/**
 * The files a message mentions, kept with it by the id it was sent under:
 * where each mention stands in the message's words and its path. A
 * message's mentions are known only from here, never read from its words,
 * since their sent form is also how a user writes code; a message with
 * none kept, from another session or from before, is its words as they
 * are. Kept between runs, so a message reads the same after a restart.
 */

const KEY = "chord.mentions";
/** How many messages with mentions are remembered. */
const KEEP = 1000;

const mentioned = $state({ byMessage: {} as Record<string, Sent[]> });
let loaded = false;

function valid(found: unknown): found is Sent {
  if (typeof found !== "object" || found === null) return false;
  const { start, end, path } = found as Record<string, unknown>;
  return Number.isInteger(start) && Number.isInteger(end) && typeof path === "string";
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return;
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return;
    const byMessage: Record<string, Sent[]> = {};
    for (const [message, list] of Object.entries(stored))
      if (Array.isArray(list)) byMessage[message] = list.filter(valid);
    mentioned.byMessage = byMessage;
  } catch {
    // Nothing remembered: such messages read as their words.
  }
}

// Read when the module loads, never while a view is drawn, which may not
// write the state it reads.
load();

/** The message with this id was sent with these mentions in its words. */
export function mentionedIn(message: string, mentions: readonly Sent[]) {
  if (mentions.length === 0) return;
  load();
  mentioned.byMessage[message] = mentions.map(({ start, end, path }) => ({ start, end, path }));
  const kept = Object.entries(mentioned.byMessage);
  if (kept.length > KEEP) mentioned.byMessage = Object.fromEntries(kept.slice(-KEEP));
  try {
    localStorage.setItem(KEY, JSON.stringify(mentioned.byMessage));
  } catch {
    // Non-fatal: they are known until the window closes.
  }
}

/** The mentions kept with a message, none for one sent without. */
export function mentionsOf(message: string): Sent[] {
  return mentioned.byMessage[message] ?? [];
}

/** Forgets every message's mentions, for tests. */
export function resetMentioned() {
  mentioned.byMessage = {};
  loaded = true;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing kept, then.
  }
}
