import { dirFor } from "$lib/accounts.svelte";
import { core, type IntegratedHistory, type IntegratedSnapshot } from "$lib/core";
import type { Conversation, Run } from "$lib/conversation.svelte";
import type { Session } from "$lib/sessions.svelte";

/**
 * What an integrated session said before this window took it up, read
 * from where its agent keeps it and laid in its thread above what is drawn,
 * with a line where this run of it began.
 *
 * A session started on a conversation it resumes draws that line at once
 * and goes on under it while the earlier messages are read; they fill in
 * above it. A window that takes up a session the core still runs waits a
 * while for them before it plays what it heard meanwhile, since what was
 * read holds part of this run too, and lays them above it all the same if
 * they take longer.
 */

/** How long a window that takes up a running session waits for what it
    said before. */
export const EARLIER_WAIT = 5000;

/**
 * Reads what the session said before and lays it in its conversation once
 * read, with this run beginning where `run` says. Answers once it is laid,
 * or once `wait` is over. An agent whose history is not read, or a read
 * that fails, leaves the conversation saying it was not read, and why
 * where the read said.
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
    let why: string | null = null;
    try {
      if (id !== null)
        history = await core().integratedHistory({
          agent: session.agent,
          project: session.project,
          cwd: session.startIn ?? undefined,
          session: id,
          configDir: dirFor(session.account, session.agent),
        });
    } catch (error) {
      history = null;
      why = typeof error === "string" ? error : error instanceof Error ? error.message : null;
    }
    const began = await Promise.resolve(run).catch(() => null);
    if (history === null) conversation.unread(why);
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
 * resumed session whose thread has none of it yet draws the line where
 * this run begins and reads it, without waiting for it; one whose earlier
 * messages are still being read, as after a restart, draws the line for
 * them to go above; and one whose thread goes on from a run drawn here
 * marks where this run begins under it.
 */
export function earlierAtStart(session: Session, conversation: Conversation) {
  const now = Date.now();
  if (session.resumedFrom === null) return;
  if (conversation.earlier === null && conversation.entries.length === 0) {
    conversation.beganAbove(now);
    void layEarlier(session, conversation, { at: now, since: null });
  } else if (conversation.earlier === "loading") conversation.beganAbove(now);
  else conversation.beganHere(now);
}

/** Where the run a snapshot is of began, for a conversation it resumed. */
export function runOf(snapshot: IntegratedSnapshot): Run | null {
  const at = snapshot.resumedAt;
  return typeof at === "number" ? { at, since: at } : null;
}

/** Where the run of a session being taken up began, by its snapshot. A
    snapshot that fails says nothing runs from before, so all that is read
    is from before, and no run has begun yet. */
export function runFrom(snapshot: Promise<IntegratedSnapshot>): Promise<Run | null> {
  return snapshot.then(runOf, () => ({ at: null, since: null }));
}
