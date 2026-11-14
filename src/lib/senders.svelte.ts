import { spoken } from "$lib/instructions";
import { lastSegment } from "$lib/paths";
import { label, sessions, type Session } from "$lib/sessions.svelte";

/**
 * Who sent a message to a session, when it was not the user: a session
 * that started it, with its prompt, or one that spoke to it with the send
 * tool.
 */

const KEY = "workbench.senders";
/** How many messages from other sessions are remembered per session. */
const KEEP = 100;

interface Sent {
  /** The id the message was sent under. */
  message: string;
  text: string;
  /** The id of the session that sent it, or the folder an agent outside
      the workbench called from. */
  from: string;
}

/** By the id of the session sent to. Kept between runs, so a message reads
    as its sender's after a restart too. */
const senders = $state({ to: {} as Record<string, Sent[]> });
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return;
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== "object" || stored === null) return;
    const to: Record<string, Sent[]> = {};
    for (const [id, list] of Object.entries(stored))
      if (Array.isArray(list))
        to[id] = list.filter(
          (sent): sent is Sent =>
            typeof sent?.message === "string" && typeof sent?.text === "string" && typeof sent?.from === "string",
        );
    senders.to = to;
  } catch {
    // Nothing remembered, then: such a message reads as the user's.
  }
}

/** A session sent a message to the session with the id `to`. */
export function sentBy(to: string, message: string, text: string, from: string) {
  load();
  senders.to[to] = [...(senders.to[to] ?? []), { message, text, from }].slice(-KEEP);
  try {
    localStorage.setItem(KEY, JSON.stringify(senders.to));
  } catch {
    // Non-fatal: it is known until the window closes.
  }
}

export interface Sender {
  /** The sending session's id, or the folder an outside agent called from. */
  id: string;
  name: string;
  /** Its row, when the window has one to go to. */
  key: string | null;
}

/** Who sent a message to a session: null for the user. A started session's
    prompt is its starter's, by the sentence the workbench puts after it. */
export function senderOf(
  session: Session,
  message: { id: string; text: string },
  starter: string | null,
): Sender | null {
  load();
  const list = session.id === null ? [] : (senders.to[session.id] ?? []);
  const known = list.find((sent) => sent.message === message.id) ?? list.find((sent) => sent.text === message.text);
  const from = known?.from ?? (starter !== null && spoken(message.text).instructions !== null ? starter : null);
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
  senders.to = {};
  loaded = false;
}
