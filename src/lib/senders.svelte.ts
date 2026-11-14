import { lastSegment } from "$lib/paths";
import { label, sessions } from "$lib/sessions.svelte";

/**
 * Who sent a message to a session, when it was not the user: a session
 * that started it, with its prompt, or one that spoke to it with the send
 * tool.
 */

const KEY = "workbench.senders";
/** How many messages from other sessions are remembered. */
const KEEP = 1000;

/** The session that sent each message another session sent, by the id
    the message was sent under: a session's id, or the folder an agent
    outside the workbench called from. Kept between runs, so a message
    reads as its sender's after a restart too. A message is told to be
    another session's by its id alone, never by its words. */
const senders = $state({ byMessage: {} as Record<string, string> });
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return;
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return;
    const byMessage: Record<string, string> = {};
    for (const [message, from] of Object.entries(stored)) if (typeof from === "string") byMessage[message] = from;
    senders.byMessage = byMessage;
  } catch {
    // Nothing remembered, then: such a message reads as the user's.
  }
}

/** A session sent the message with this id. */
export function sentBy(message: string, from: string) {
  load();
  senders.byMessage[message] = from;
  const kept = Object.entries(senders.byMessage);
  if (kept.length > KEEP) senders.byMessage = Object.fromEntries(kept.slice(-KEEP));
  try {
    localStorage.setItem(KEY, JSON.stringify(senders.byMessage));
  } catch {
    // Non-fatal: it is known until the window closes.
  }
}

/** Who started a session, for the prompt it is started with: told by the
    module that knows who started what. */
let starter: (key: string) => string | null = () => null;

export function startersFrom(how: (key: string) => string | null) {
  starter = how;
}

/** The session that started the session with this row key, if one did. */
export function starterOf(key: string): string | null {
  return starter(key);
}

export interface Sender {
  /** The sending session's id, or the folder an outside agent called from. */
  id: string;
  name: string;
  /** Its row, when the window has one to go to. */
  key: string | null;
}

/** Who sent a message: null for the user. */
export function senderOf(message: { id: string }): Sender | null {
  load();
  const from = senders.byMessage[message.id] ?? null;
  if (from === null) return null;
  const row = sessions.all.find((candidate) => candidate.id === from) ?? null;
  return {
    id: from,
    key: row?.key ?? null,
    name: row !== null ? label(row) : from.startsWith("/") ? `an agent in ${lastSegment(from)}` : `session ${from}`,
  };
}

/** Test seam. */
export function resetSenders() {
  senders.byMessage = {};
  loaded = false;
}
