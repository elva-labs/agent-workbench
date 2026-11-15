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
    the message was sent under: the token the sending session's tools name
    it by, or, sent before there were tokens, its id or the folder an agent
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

// Read when the module loads, never while a view is drawn, which may not
// write the state it reads.
load();

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
  /** The sending session's id, as the tools name it, where the window
      knows it; else what the message was sent under. */
  id: string;
  name: string;
  /** Its row, when the window has one to go to. */
  key: string | null;
}

/** What the user knows a session by, by its id, while the window has its
    row. */
export function sessionName(id: string): string | null {
  const row = sessions.all.find((candidate) => candidate.id === id);
  return row === undefined ? null : label(row);
}

/** Who sent a message: null for the user. A sender the window has no row
    for is named by the id the tools know it by. */
export function senderOf(message: { id: string }): Sender | null {
  const from = senders.byMessage[message.id] ?? null;
  if (from === null) return null;
  const row =
    sessions.all.find((candidate) => candidate.token === from) ??
    sessions.all.find((candidate) => candidate.id === from) ??
    null;
  const id =
    row?.id ?? Object.entries(sessions.tokens).find(([, kept]) => kept.token === from)?.[0] ?? from;
  return {
    id,
    key: row?.key ?? null,
    name: row !== null ? label(row) : from.startsWith("/") ? `an agent in ${lastSegment(from)}` : `session ${id}`,
  };
}

/** Test seam. */
export function resetSenders() {
  senders.byMessage = {};
  times.at = {};
  loaded = false;
  load();
  loadTimes();
}

const TIMES_KEY = "workbench.sent-at";

/** When this window sent each message, by its id, kept between runs: a
    message read back from the core after a reload carries no time of its
    own. */
const times = $state({ at: {} as Record<string, number> });

function loadTimes() {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(TIMES_KEY) ?? "{}");
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return;
    const at: Record<string, number> = {};
    for (const [message, when] of Object.entries(stored)) if (typeof when === "number") at[message] = when;
    times.at = at;
  } catch {
    // No times remembered, then: such a message shows none.
  }
}

// Read when the module loads, as the senders are.
loadTimes();

/** The window sent the message with this id at `at`. */
export function sentAt(message: string, at: number) {
  times.at[message] = at;
  const kept = Object.entries(times.at);
  if (kept.length > KEEP) times.at = Object.fromEntries(kept.slice(-KEEP));
  try {
    localStorage.setItem(TIMES_KEY, JSON.stringify(times.at));
  } catch {
    // Non-fatal: it is known until the window closes.
  }
}

/** When the window sent a message, if it did. */
export function timeOf(message: string): number | null {
  return times.at[message] ?? null;
}
