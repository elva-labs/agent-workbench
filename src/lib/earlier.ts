import { dirFor } from "$lib/accounts.svelte";
import { core, type IntegratedHistory, type IntegratedSnapshot } from "$lib/core";
import type { Conversation, Run } from "$lib/conversation.svelte";
import type { Session } from "$lib/sessions.svelte";

/**
 * What an integrated session said before this window took it up, read
 * from where its agent keeps it and laid in its thread above what is drawn,
 * with a line where this run of it began.
 *
 * What the session says live waits for it a while, so that the live part
 * is drawn under it rather than pushed down when it comes. A history that
 * takes longer than that is laid above the live part all the same.
 */

/** How long what a session says live waits for what it said before. */
export const EARLIER_WAIT = 5000;

/**
 * Reads what the session said before and lays it in its conversation once
 * read, with this run beginning where `run` says. Answers once it is laid,
 * or once `wait` is over. An agent whose history is not read, or a read
 * that fails, leaves the conversation saying it was not read.
 */
export function layEarlier(
  session: Session,
  conversation: Conversation,
  run: Run | null | Promise<Run | null>,
  wait = EARLIER_WAIT,
): Promise<void> {
  const id = session.resumedFrom ?? session.id;
  conversation.earlier = "loading";
  const laid = (async () => {
    let history: IntegratedHistory | null = null;
    try {
      if (id !== null)
        history = await core().integratedHistory({
          agent: session.agent,
          project: session.project,
          cwd: session.startIn ?? undefined,
          session: id,
          configDir: dirFor(session.account, session.agent),
        });
    } catch {
      history = null;
    }
    const began = await Promise.resolve(run).catch(() => null);
    if (history === null) conversation.earlier = "unread";
    else conversation.lay(history, began);
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, wait);
  });
  return Promise.race([laid, waited]).finally(() => clearTimeout(timer));
}

/**
 * What a start of the session's agent does with what it said before: a
 * resumed session whose thread has none of it yet reads it, and one whose
 * thread goes on from a run drawn here marks where this run begins.
 */
export function earlierAtStart(session: Session, conversation: Conversation): Promise<void> {
  const now = Date.now();
  if (session.resumedFrom === null) return Promise.resolve();
  if (conversation.earlier === null && conversation.entries.length === 0)
    return layEarlier(session, conversation, { at: now, since: null });
  if (conversation.earlier !== "loading") conversation.beganHere(now);
  return Promise.resolve();
}

/** Where the run a snapshot is of began, for a conversation it resumed. */
export function runOf(snapshot: IntegratedSnapshot): Run | null {
  const at = snapshot.resumedAt;
  return typeof at === "number" ? { at, since: at } : null;
}
