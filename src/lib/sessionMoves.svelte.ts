import { untrack } from "svelte";
import { typingInto, waitedOn, wakeComing } from "$lib/conductor.svelte";
import { isInstalled } from "$lib/hook.svelte";
import { linkOf } from "$lib/integrated.svelte";
import { agentVisible } from "$lib/layout.svelte";
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
 * way it will start. A running row moves when it is at rest and on screen,
 * since starting every agent at once is a burst of work for sessions nobody
 * is looking at: each waits to be shown, as a row left from the last quit
 * waits to start. One at work, asking, with messages waiting for it, with
 * subagents at work, waited on by the session that started it, about to be
 * woken, or written to, is never cut short: it moves once all of that is
 * over. One that holds what its run would end with it, a command left
 * running in the background or a permission allowed for that run alone,
 * stays as it is and says so on its row, and the user moves it from its
 * menu. So does a Claude Code session in a terminal with no hooks to say
 * when it is at rest. A row that has ended, or whose agent runs one way
 * only, stays as it is.
 */

/** Why a row due to move has not moved yet: it moves by itself once what
    keeps it busy is over, or it stays until the user moves it. */
export type Hold =
  | { kind: "busy"; why: string }
  | { kind: "stays"; ends: string[]; unknown: boolean };

/** How long a row is at rest on screen before it moves, so a rest that
    the next turn follows at once, as a report of a subagent or a wake
    does, is not taken for one. */
export const REST_FOR = 1000;

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
  if (held !== null) return held;
  if (waitedOn(session.key)) return busy("waited on");
  if (wakeComing(session.key)) return busy("being woken");
  return null;
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
  // What the user is writing goes with the conversation, not into a
  // terminal.
  if (link.draft.trim() !== "" || link.images.length > 0 || link.files.length > 0) return busy("being written to");
  const running = conversation.tasks.filter((task) => task.status === "running" && !task.ambient);
  if (running.some((task) => task.kind === "agent")) return busy("subagents at work");
  const ends = [
    ...running.map((task) => task.description ?? "a command in the background"),
    ...link.granted,
  ];
  return ends.length > 0 ? { kind: "stays", ends, unknown: false } : null;
}

function terminalHold(session: Session): Hold | null {
  if (session.ptyId === null) return busy("starting");
  if (session.working || session.needs !== null || session.delegated) return busy("working");
  // Words on its line are the user's, which quitting it would clear.
  if (drafting(session.key) || typingInto(session.key)) return busy("being written to");
  // Claude Code at work on a long command draws only its spinner's clock,
  // which its output cannot tell from rest: only its hooks say when it is.
  // Codex's turns are read from its own log.
  const unknown = session.agent === "claude-code" && !session.exact && !isInstalled(session.project);
  if (unknown || session.background.length > 0) return { kind: "stays", ends: [...session.background], unknown };
  return null;
}

/** What a row due to move that stays until the user moves it says, in a
    line and in full: what moving it would end, or that the window cannot
    tell when it is at rest. Null for a row that moves by itself. */
export function staysWords(session: Session): { line: string; full: string } | null {
  const to = dueTo(session);
  if (to === null) return null;
  const hold = holdOf(session);
  if (hold === null || hold.kind !== "stays") return null;
  const stays = to === "integrated" ? "Stays in a terminal" : "Stays a conversation";
  const move = to === "integrated" ? "Reopen it as a conversation" : "Reopen it in a terminal";
  if (hold.unknown)
    return {
      line: `${stays}: live updates are off`,
      full: `Live updates are off for this project, so the workbench cannot tell when this session is idle. ${move} from its menu when it is.`,
    };
  return {
    line: `${stays}: moving ends ${listed(hold.ends)}`,
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

/** Things in words, joined with commas and an and. */
export function listed(things: string[]): string {
  if (things.length <= 1) return things[0] ?? "";
  return `${things.slice(0, -1).join(", ")} and ${things.at(-1)}`;
}

/** Whether a row is on screen. */
function shown(session: Session): boolean {
  return sessions.active === session.key && agentVisible();
}

/**
 * Moves the rows due to move as `dueTo` and `holdOf` say, for as long as
 * the window is open: a row left from the last quit at once, a running
 * row once it has been at rest for a moment on screen. A row whose run did
 * not stop in time is left as it was, and tried again the next time it
 * comes on screen. Returns a stop function.
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
        if (dueTo(session) === null) {
          restSince.delete(key);
          continue;
        }
        const hold = holdOf(session);
        if (hold !== null) {
          restSince.delete(key);
          // What holds a row on screen is not all heard of as it changes,
          // such as a line being typed into it: it is looked at again.
          if (hold.kind === "busy" && shown(session)) next = Math.min(next ?? Infinity, REST_FOR);
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
        if (!shown(session) || gaveUp.has(key)) continue;
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
