import { dirFor } from "$lib/accounts.svelte";
import { agentLabel } from "$lib/agent.svelte";
import { core, type AgentId, type IntegratedHistory, type IntegratedSnapshot } from "$lib/core";
import type { Conversation, Run } from "$lib/conversation.svelte";
import type { Session } from "$lib/sessions.svelte";
import { workflowsKnown } from "$lib/workflows.svelte";
import { lineageOf } from "$lib/goingOn.svelte";

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

/** Why the earlier messages of a session that was spoken to are not
    drawn, when its agent's record of it holds none. */
export function nothingKept(agent: AgentId): string {
  return `${agentLabel(agent)}'s record of it holds no messages`;
}

/**
 * Reads what the session said before and lays it in its conversation once
 * read, with this run beginning where `run` says. Answers once it is laid,
 * or once `wait` is over. An agent whose history is not read, or a read
 * that fails, leaves the conversation saying it was not read, and why
 * where the read said. So does a read that finds nothing for a session
 * that was `spoken` to, which has something to find; for one that was not,
 * there is nothing to say.
 */
export function layEarlier(
  session: Session,
  conversation: Conversation,
  run: Run | null | Promise<Run | null>,
  wait = EARLIER_WAIT,
  spoken = true,
): Promise<void> {
  const id = session.resumedFrom ?? session.id;
  conversation.earlier = "loading";
  const laid = (async () => {
    let history: IntegratedHistory | null = null;
    let why: string | null = null;
    try {
      // The account's directory comes from the settings, which the window
      // has by the time it has their workflows. A resumed start waits for
      // them too; read before then, the agent's own directory would stand
      // in for the account's, and the session is not kept there.
      await workflowsKnown();
      const read = (one: string) =>
        core().integratedHistory({
          agent: session.agent,
          project: session.project,
          cwd: session.startIn ?? undefined,
          session: one,
          configDir: dirFor(session.account, session.agent),
        });
      if (id !== null) {
        // A conversation that went on from notes draws the ones it went on
        // from above its own, each read on its own; one that cannot be
        // read is passed over.
        const before = lineageOf(id).slice(0, -1);
        const earlier = await Promise.all(before.map((one) => read(one).catch(() => null)));
        const own = await read(id);
        const items = earlier.flatMap((one) => one?.items ?? []);
        history =
          own === null || items.length === 0
            ? own
            : { ...own, items: [...items, ...own.items], cut: earlier[0]?.cut ?? own.cut };
      }
    } catch (error) {
      history = null;
      why = typeof error === "string" ? error : error instanceof Error ? error.message : null;
    }
    const began = await Promise.resolve(run).catch(() => null);
    if (!spoken) conversation.lay(history ?? { items: [], cut: false }, began);
    else if (history === null) conversation.unread(why);
    else if (history.items.length === 0) conversation.unread(nothingKept(session.agent));
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
 * resumed session that was `spoken` to and whose thread holds nothing of
 * it yet, at most notes the window made, draws the line where this run
 * begins and reads it, without waiting for it; one whose earlier messages
 * are still being read, as after a restart, draws the line for them to go
 * above; and one whose thread goes on from a run drawn here, or that
 * nothing was said in, marks where this run begins under it.
 */
export function earlierAtStart(session: Session, conversation: Conversation, spoken = true) {
  const now = Date.now();
  if (session.resumedFrom === null) return;
  if (spoken && conversation.earlier === null && conversation.entries.every((entry) => entry.kind === "note")) {
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
