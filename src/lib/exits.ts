import type { SessionEnded } from "$lib/core";

/**
 * Exits that arrived before anything owned the pty.
 *
 * The end event and the spawn result race when a process dies at once, and the
 * exit must not be lost to the order they happened to arrive in. Every pty in
 * the app ends through the same event, whether an agent or a shell is behind
 * it, so the stash is shared: whichever store the pty turns out to belong to
 * claims the exit when its row learns the id.
 */
let unclaimed = new Map<string, SessionEnded>();

export function stash(event: SessionEnded) {
  unclaimed.set(event.id, event);
}

export function claim(ptyId: string): SessionEnded | undefined {
  const event = unclaimed.get(ptyId);
  unclaimed.delete(ptyId);
  return event;
}

/** Test seam. */
export function resetExits() {
  unclaimed = new Map();
}
