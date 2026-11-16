import { conductor, placeOf, startedFor, type Ask } from "$lib/conductor.svelte";
import type { Conversation, Request } from "$lib/conversation.svelte";
import { linkOf } from "$lib/integrated.svelte";
import { agentVisible } from "$lib/layout.svelte";
import { lastSegment } from "$lib/paths";
import { byKey, byToken, isLive, label, sessions, type Session } from "$lib/sessions.svelte";
import { projectLabel } from "$lib/workspace.svelte";

/**
 * What waits on the user in an integrated session's dock.
 *
 * The session's own requests come first, in the order its agent asked:
 * its conversation is the one on screen, and its turn is the one they
 * hold. A round of review past its workflow's limit that the session asked
 * for follows them, while the session is on screen; elsewhere the round
 * is asked over the window. Then come the requests of the sessions it
 * started, in the order they asked: an integrated one's, answered here
 * exactly as in that session, and a terminal one's, which only that
 * session's terminal can answer, so it is shown with the way there.
 *
 * Nothing here answers anything or reaches an agent. What the dock does
 * with an entry is the user's click or key, and it goes to the session
 * the entry belongs to, by that session's own request.
 */

export type Docked =
  | {
      kind: "request";
      /** The row and the request, unique while it waits. */
      id: string;
      /** The row whose request it is. */
      key: string;
      /** Whether it is the dock's own session's. */
      own: boolean;
      request: Request;
      conversation: Conversation;
      /** When it was asked, for the order. */
      at: number;
    }
  | { kind: "terminal"; id: string; key: string; own: false; at: number }
  | { kind: "round"; id: string; key: string; own: true; ask: Ask; at: number };

/** The session whose dock holds the round of review past its limit that
    waits on the user: its caller, while that is an integrated session on
    screen with its dock drawn. Null while the question goes over the
    window instead, or none waits. */
export function roundDockedIn(): string | null {
  const ask = conductor.asking;
  if (ask === null || ask.round === null) return null;
  const row = byToken(ask.request.caller);
  if (row === null || row.kind !== "integrated" || row.status !== "running") return null;
  if (row.key !== sessions.active || !agentVisible()) return null;
  const link = linkOf(row.key);
  if (link === null || link.untrusted || link.conversation.notLoggedIn) return null;
  return row.key;
}

/** Everything the dock of the session with this key holds, in the order
    it is taken: the session's own, then its started sessions'. Empty for
    a session with no dock. */
export function dockedFor(key: string): Docked[] {
  const session = byKey(key);
  if (session === null || session.kind !== "integrated") return [];
  const out: Docked[] = [];
  const own = linkOf(key)?.conversation ?? null;
  for (const request of own?.open ?? [])
    out.push({ kind: "request", id: `${key}\n${request.request}`, key, own: true, request, conversation: own!, at: request.at ?? 0 });
  const ask = conductor.asking;
  if (ask !== null && ask.round !== null && roundDockedIn() === key)
    out.push({ kind: "round", id: `round\n${ask.request.id}`, key, own: true, ask, at: 0 });
  return [...out, ...theirs(session)];
}

/** The requests of the sessions this one started, in the order asked. */
function theirs(starter: Session): Docked[] {
  const found: Docked[] = [];
  for (const row of sessions.all) {
    if (row.key === starter.key || startedFor(row.key) !== starter.token) continue;
    if (row.kind === "integrated") {
      const conversation = linkOf(row.key)?.conversation ?? null;
      for (const request of conversation?.open ?? [])
        found.push({
          kind: "request",
          id: `${row.key}\n${request.request}`,
          key: row.key,
          own: false,
          request,
          conversation: conversation!,
          at: request.at ?? 0,
        });
    } else if (isLive(row) && row.needs === "permission") {
      found.push({ kind: "terminal", id: `${row.key}\nterminal`, key: row.key, own: false, at: row.changedAt });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/** Whether the dock answers the entry itself, rather than showing the way
    to where it is answered. */
export function answerable(entry: Docked): boolean {
  return entry.kind !== "terminal";
}

/** Who asks, by the name the user knows: null for the dock's own session,
    whose agent's name stands there; else the started session's name, the
    step it was started for, when it was, and the folder it works in, by
    the name the user knows that by: its project's, or its worktree's. */
export function askerOf(entry: Docked): { name: string; step: string | null; where: string } | null {
  if (entry.own) return null;
  const row = byKey(entry.key);
  const folder = folderOf(entry);
  const where = row === null || folder === null ? "its folder" : folder === row.project ? projectLabel(row.project) : lastSegment(folder);
  return { name: row === null ? "a session it started" : label(row), step: placeOf(entry.key)?.step ?? null, where };
}

/** The folder the asking session works in, which a path it names is read
    against. */
export function folderOf(entry: Docked): string | null {
  const row = byKey(entry.key);
  return row === null ? null : (row.startIn ?? row.project);
}
