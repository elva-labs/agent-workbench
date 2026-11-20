import { untrack } from "svelte";
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import { dirFor } from "$lib/accounts.svelte";
import { typingInto, waitedOn, wakeComing } from "$lib/conductor.svelte";
import { core, type IntegratedHistoryOptions } from "$lib/core";
import { isInstalled } from "$lib/hook.svelte";
import { linkOf, type Link } from "$lib/integrated.svelte";
import { agentVisible } from "$lib/layout.svelte";
import { settings } from "$lib/settings.svelte";
import { kindFor, sessionKinds, type SessionKind } from "$lib/sessionKind.svelte";
import { agent } from "$lib/agent.svelte";
import {
  drafting,
  isLive,
  onWake,
  otherWayFor,
  reopenOtherWay,
  sessions,
  turnDormant,
  type Session,
} from "$lib/sessions.svelte";

/**
 * Open sessions follow the setting of how their agent's sessions run.
 *
 * A row runs the way its agent's setting says unless the user made it run
 * its own way, by starting it the other way or reopening it the other way
 * from its menu. When the setting is switched, every row that follows it
 * moves: its agent is stopped and the same conversation goes on the new
 * way in the same row, as a reopen from the menu does, with its name, its
 * token, its account, its mode, its worktree, the session that started it
 * and those it started, whether it was read, and its place in the list.
 *
 * A row left from the last quit has nothing running, and only changes the
 * way it will start. A running row moves once it has been at rest for a
 * moment and is on screen with nothing over it: as it comes on screen, or
 * when the settings close over the one on screen. Starting every agent at
 * once is a burst of work for sessions nobody is looking at, so each waits
 * to be shown, as a row left from the last quit waits to start. One that
 * comes to rest while it is looked at is not moved under the reader: it
 * moves the next time it is shown, and says so.
 *
 * One at work, asking, with messages waiting for it, with subagents at
 * work, waited on by the session that started it, about to be woken, or
 * written to, is never cut short: it moves once all of that is over. One
 * with a command left running in the background moves once that ends, and
 * says so. One that holds what never ends by itself stays as it is, says
 * why, and the user moves it from its menu: a permission allowed for its
 * run alone, a Claude Code session in a terminal with no hooks to say when
 * it is at rest, and a Claude Code conversation held at a point it went
 * back to, which its terminal does not take. A row that has ended, or whose
 * agent runs one way only, stays as it is.
 */

/** Why a row due to move has not moved yet: it moves by itself once what
    keeps it busy is over, or once what moving now would end has ended, or
    it stays until the user moves it. */
export type Hold =
  | { kind: "busy"; why: string }
  | { kind: "until"; ends: string[] }
  | { kind: "stays"; why: "ends" | "unknown" | "held"; ends: string[] };

/** How long a row has been at rest before it moves, wherever it rested, so
    a rest that the next turn follows at once, as a report of a subagent or
    a wake does, is not taken for one. */
export const REST_FOR = 1000;

/** What keeps a row busy without anyone seeing it at work: it is coming
    up, or the window is asking whether its conversation went back. */
const UNSEEN = new Set(["starting", "checking"]);

/** The way a row is due to move to: its agent's setting, where the row
    follows it, runs the other way, and can be reopened. Null otherwise, and
    until the core has said what the setting is. */
export function dueTo(session: Session): SessionKind | null {
  if (!sessionKinds.known || session.ownWay) return null;
  // An ended row is what its run left; resuming it is a start of its own.
  if (session.status !== "dormant" && !isLive(session)) return null;
  const other = otherWayFor(session);
  return other !== null && other === kindFor(session.agent) ? other : null;
}

/** The way each row left from the last quit was due to move to when the
    app quit, by its key, from the record of the sessions open then: what it
    starts as while the setting or its agent is not known yet. */
const recorded = new Map<string, SessionKind>();

/** A row brought back from the last quit was due to move this way. */
export function recordMove(key: string, to: SessionKind) {
  recorded.set(key, to);
}

/** The way a row is due to move to, as far as the window can say yet: by
    the setting once it and the row's agent are known, else by what was
    recorded at the last quit. */
export function pendingMove(session: Session): SessionKind | null {
  if (sessionKinds.known && agent.asked.includes(session.agent)) return dueTo(session);
  const to = recorded.get(session.key) ?? null;
  return to !== null && to !== session.kind && !session.ownWay ? to : null;
}

// A row left from the last quit starts the way it is to run, so it never
// starts one way only to move the other a moment later.
onWake((session) => {
  const to = pendingMove(session);
  recorded.delete(session.key);
  if (to !== null && holdOf(session) === null) turnDormant(session.key, to);
});

/**
 * Going back.
 *
 * A Claude Code conversation that went back to an earlier message is held
 * at that point by the core until a message is sent from there. Claude
 * Code's terminal does not take the point: resumed there, it shows and goes
 * on with what was gone back on. So a held conversation is never moved into
 * a terminal by the setting, and reopening one by hand says so first.
 *
 * Whether a conversation is held is the core's `integratedHeld`. The
 * answer is kept by the row's key with the revision of its conversation it
 * was asked at, and asked again once anything in the conversation has
 * changed, such as a message sent from the point, which lets it go.
 */

/** What the core said of each conversation, by the row's key, at the
    revision of the conversation it was asked at: null while it is asked. */
const heldAt = new SvelteMap<string, { revision: number; held: boolean | null }>();

/** Whether a row's conversation could be held: a Claude Code conversation
    with an id. */
function holdable(session: Session): boolean {
  return session.agent === "claude-code" && session.id !== null;
}

function heldOptions(session: Session): IntegratedHistoryOptions {
  return {
    agent: session.agent,
    project: session.project,
    cwd: session.startIn ?? undefined,
    session: session.id!,
    configDir: dirFor(session.account, session.agent),
  };
}

/** Whether a row's conversation is held, as last asked: null until the
    core has answered for the conversation as it is now. */
function heldOf(session: Session, link: Link): boolean | null {
  if (!holdable(session)) return false;
  const known = heldAt.get(session.key);
  return known !== undefined && known.revision === link.conversation.revision ? known.held : null;
}

/** Asks the core whether a row's conversation is held, unless it has been
    asked for the conversation as it is now. */
function askHeld(session: Session, link: Link) {
  if (!holdable(session)) return;
  const key = session.key;
  const revision = link.conversation.revision;
  if (heldAt.get(key)?.revision === revision) return;
  heldAt.set(key, { revision, held: null });
  const settle = (held: boolean) => {
    if (heldAt.get(key)?.revision === revision) heldAt.set(key, { revision, held });
  };
  // A core that cannot say leaves it moving as any other.
  void heldNow(session).then(settle);
}

/** Whether a row's conversation is held now, asked of the core at once:
    for reopening it in a terminal by hand. */
export async function heldNow(session: Session): Promise<boolean> {
  if (!holdable(session)) return false;
  try {
    return await core().integratedHeld(heldOptions(session));
  } catch {
    return false;
  }
}

/** What keeps a row due to move from moving now, or null when nothing
    does. A row left from the last quit has nothing running to hold it. */
export function holdOf(session: Session): Hold | null {
  if (session.status === "dormant") {
    // A run the window is taking up again after a reload is not the row's
    // to turn until it has.
    return linkOf(session.key)?.busy === true ? busy("starting") : null;
  }
  if (session.status !== "running") return busy("starting");
  const held = session.kind === "integrated" ? conversationHold(session) : terminalHold(session);
  if (held !== null && held.kind === "busy") return held;
  if (waitedOn(session.key)) return busy("waited on");
  if (wakeComing(session.key)) return busy("being woken");
  return held;
}

function busy(why: string): Hold {
  return { kind: "busy", why };
}

function conversationHold(session: Session): Hold | null {
  const link = linkOf(session.key);
  if (link === null || link.handle === null || link.busy || link.restarting) return busy("starting");
  const conversation = link.conversation;
  if (conversation.open.length > 0) return busy("asking");
  if (session.working || conversation.working || conversation.interrupting) return busy("working");
  if (
    link.sendingNow ||
    link.sentNow.length > 0 ||
    conversation.waiting.some((message) => ["sending", "queued", "sent"].includes(message.state))
  )
    return busy("messages waiting");
  if (conversation.commanding) return busy("running a command");
  // What the user is writing goes with the conversation, not into a
  // terminal.
  if (link.draft.trim() !== "" || link.images.length > 0 || link.files.length > 0) return busy("being written to");
  const running = conversation.tasks.filter((task) => task.status === "running" && !task.ambient);
  if (running.some((task) => task.kind === "agent")) return busy("subagents at work");
  const held = heldOf(session, link);
  if (held === null) return busy("checking");
  const background = running.map((task) => task.description ?? "a command in the background");
  if (held) return { kind: "stays", why: "held", ends: [...background, ...link.granted] };
  if (link.granted.length > 0) return { kind: "stays", why: "ends", ends: [...background, ...link.granted] };
  return background.length > 0 ? { kind: "until", ends: background } : null;
}

function terminalHold(session: Session): Hold | null {
  if (session.ptyId === null) return busy("starting");
  if (session.working || session.needs !== null || session.delegated) return busy("working");
  // Words on its line are the user's, which quitting it would clear.
  if (drafting(session.key) || typingInto(session.key)) return busy("being written to");
  // Claude Code at work on a long command draws only its spinner's clock,
  // which its output cannot tell from rest: only its hooks say when it is.
  // Codex's turns are read from its own log.
  const background = [...session.background];
  if (session.agent === "claude-code" && !session.exact && !isInstalled(session.project))
    return { kind: "stays", why: "unknown", ends: background };
  return background.length > 0 ? { kind: "until", ends: background } : null;
}

/** Rows due to move that were at work, asking or held while the user
    looked at them, by key, until they leave the screen: once at rest they
    move the next time they are shown, not under the reader. */
const read = new SvelteSet<string>();

/** Whether a row due to move waits for the next time it is shown. */
function nextTime(session: Session): boolean {
  return read.has(session.key);
}

/** What a row due to move that has not moved says of it, in a line, a word
    or two for a row with no room for the line, and in full: when it moves,
    or why it stays and what moving would end. Null for a row that simply
    moves when shown, or is busy in a way its row already shows. */
export function holdWords(session: Session): { line: string; short: string; full: string } | null {
  const to = dueTo(session);
  if (to === null || session.status === "dormant") return null;
  const hold = holdOf(session);
  const where = to === "integrated" ? "a conversation" : "a terminal";
  const move = to === "integrated" ? "Reopen it as a conversation" : "Reopen it in a terminal";
  if (hold === null || hold.kind === "busy") {
    if (!nextTime(session) || (hold !== null && !UNSEEN.has(hold.why))) return null;
    return {
      line: `Moves to ${where} next time`,
      short: "next time",
      full: `It came to rest while you were looking at it, so it moves the next time you come to it. ${move} from its menu to move it now.`,
    };
  }
  if (hold.kind === "until")
    return {
      line: `Moves to ${where} when ${listed(hold.ends)} ${hold.ends.length > 1 ? "end" : "ends"}`,
      short: "waits",
      full: `Moving it now ends ${listed(hold.ends)}. ${move} from its menu to move it now.`,
    };
  const stays = to === "integrated" ? "Stays in a terminal" : "Stays a conversation";
  if (hold.why === "unknown")
    return {
      line: `${stays}: live updates are off`,
      short: "stays",
      full: `Live updates are off for this project, so the workbench cannot tell when this session is idle. ${move} from its menu when it is.`,
    };
  if (hold.why === "held")
    return {
      line: `${stays}: it went back, and a terminal would bring back what was gone back on`,
      short: "stays",
      full: `It went back to an earlier message, which Claude Code's terminal does not take: opened there, it would bring back what was gone back on. It moves once a message is sent from here. ${move} from its menu to move it anyway.`,
    };
  return {
    line: `${stays}: moving ends ${listed(hold.ends)}`,
    short: "stays",
    full: `Moving it ends ${listed(hold.ends)}. ${move} from its menu to move it now.`,
  };
}

/** What reopening a row the other way now would end that the window knows
    of: commands left running in the background, and what was allowed for
    its run alone. */
export function reopenEnds(session: Session): string[] {
  if (session.status !== "running") return [];
  if (session.kind === "terminal") return [...session.background];
  const link = linkOf(session.key);
  if (link === null) return [];
  return [
    ...link.conversation.tasks
      .filter((task) => task.status === "running" && !task.ambient && task.kind !== "agent")
      .map((task) => task.description ?? "a command in the background"),
    ...link.granted,
  ];
}

/** What reopening a held conversation in a terminal brings back, in the
    words the question to reopen it says. */
export const BRINGS_BACK =
  "It went back to an earlier message, which Claude Code's terminal does not take: reopened there, it brings back what was gone back on. Send a message here first to keep it as it is.";

/** Things in words, joined with commas and an and. */
export function listed(things: string[]): string {
  if (things.length <= 1) return things[0] ?? "";
  return `${things.slice(0, -1).join(", ")} and ${things.at(-1)}`;
}

/** Whether a row is on screen with nothing over it: the session shown in
    the agent pane, with the settings closed. */
function lookedAt(session: Session): boolean {
  return sessions.active === session.key && agentVisible() && !settings.open;
}

/**
 * Moves the rows due to move as `dueTo` and `holdOf` say, for as long as
 * the window is open: a row left from the last quit at once, a running
 * row once it has been at rest for a moment and is looked at, unless it
 * came to rest while it was. A row whose run did not stop in time is left
 * as it was, and tried again the next time it comes on screen. Returns a
 * stop function.
 */
export function followSetting(): () => void {
  /** When each row due to move was first seen at rest, by its key. */
  const restSince = new Map<string, number>();
  /** The rows whose move did not stop their run in time, by key, until
      they next leave the screen. */
  const gaveUp = new Set<string>();
  const clock = $state({ tick: 0 });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = (ms: number) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      clock.tick++;
    }, ms);
  };
  const move = (key: string) => {
    void reopenOtherWay(key, true).then((moved) => {
      if (!moved && sessions.active === key) gaveUp.add(key);
    });
  };
  const stop = $effect.root(() => {
    $effect(() => {
      void clock.tick;
      const now = Date.now();
      let next: number | null = null;
      for (const key of gaveUp) if (sessions.active !== key) gaveUp.delete(key);
      for (const session of sessions.all) {
        const key = session.key;
        const looked = lookedAt(session);
        if (!looked) untrack(() => read.delete(key));
        if (dueTo(session) === null) {
          restSince.delete(key);
          untrack(() => read.delete(key));
          continue;
        }
        const hold = holdOf(session);
        // Whether it went back is asked once nothing else holds it, so a
        // turn's stream of changes asks nothing.
        const link = linkOf(key);
        if (hold?.kind === "busy" && hold.why === "checking" && link !== null) untrack(() => askHeld(session, link));
        if (hold !== null) {
          restSince.delete(key);
          // A reader who saw it at work, or held, does not have it moved
          // under them once it comes to rest.
          if (looked && !(hold.kind === "busy" && UNSEEN.has(hold.why))) untrack(() => read.add(key));
          // What holds a row on screen is not all heard of as it changes,
          // such as a line being typed into it: it is looked at again.
          if (hold.kind === "busy" && looked) next = Math.min(next ?? Infinity, REST_FOR);
          continue;
        }
        if (session.status === "dormant") {
          untrack(() => {
            recorded.delete(key);
            turnDormant(key, kindFor(session.agent));
          });
          continue;
        }
        const since = restSince.get(key) ?? now;
        restSince.set(key, since);
        if (!looked || gaveUp.has(key) || untrack(() => read.has(key))) continue;
        const wait = since + REST_FOR - now;
        if (wait <= 0) untrack(() => move(key));
        else next = Math.min(next ?? Infinity, wait);
      }
      if (next !== null) untrack(() => later(next));
    });
  });
  return () => {
    stop();
    if (timer !== null) clearTimeout(timer);
  };
}

/** Test seam. */
export function resetMoves() {
  recorded.clear();
  heldAt.clear();
  read.clear();
}
