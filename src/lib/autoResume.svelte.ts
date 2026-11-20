/**
 * A conversation the usage limit cut short goes on by itself once the
 * limit resets, where the user chose so on its composer.
 *
 * The choice is the conversation's own, off unless turned on. The last one
 * made is kept with the settings for the machine, and a conversation takes
 * it when its run first starts in the window. A session another session
 * started has no choice of its own: it follows the session that started
 * it, for as long as the window has that one.
 *
 * It is offered only to a Claude Code conversation whose account has a
 * session window, the five hours a plan meters work over, in its usage
 * figures. An account with none is offered nothing, and a conversation
 * moved to one stops waiting.
 *
 * Only a turn the agent itself reported as refused by that window is
 * waited for: the core says so in an event of its own just before the
 * turn's end, and nothing else is read as one. A turn the user stopped,
 * one that finished, one that failed otherwise, a week's limit and a
 * session waiting on an answer are left as they are. What is waited for is
 * held in the window alone, so quitting the app ends it, and so does the
 * run ending, a turn beginning, or the choice being turned off.
 *
 * At the time the window resets, and a minute for the server to agree,
 * the account's usage is read again. The conversation goes on only where
 * figures read since the reset show the window open: its run is started
 * again as a fresh conversation from its notes, whatever its size, and
 * sent one line asking it to go on. A window that reads as used up until
 * a later time is waited for until then. Where the figures cannot be read
 * for a quarter of an hour the wait ends and the conversation says so.
 * The turn sent is the one try: where the limit refuses it too, the
 * conversation says so and waits for the user.
 */

import { dirFor } from "$lib/accounts.svelte";
import { core, type Settings } from "$lib/core";
import { clock, heardLimits, limitsOf, toneOf } from "$lib/limits.svelte";
import { persist } from "$lib/persist";
import { hostOf } from "$lib/remote.svelte";
import { byKey, type Session } from "$lib/sessions.svelte";

/** A turn the session window's limit cut short, and the wait for it. */
export interface Stopped {
  /** When the window starts over, in milliseconds. */
  resetsAt: number;
  /** The usage is being read, or the run started again, right now. */
  going: boolean;
}

/** How long after the reset the usage is first read. */
export const MARGIN = 60_000;
/** How often the waits are looked at. */
export const LOOK_EVERY = 20_000;
/** How long after the reset the usage is still asked for where no read of
    it since the reset has come. */
export const GIVE_UP_AFTER = 15 * 60_000;
/** The line the agent is sent to go on. */
export const GO_ON = "The usage limit that stopped you has reset. Go on from where you stopped.";

export const autoResume = $state({
  /** The user's last choice, which a conversation takes as it starts. */
  next: false,
  /** Each conversation's own choice, by row key, once it has one. */
  rows: {} as Record<string, boolean>,
  /** The turns the limit cut short that nothing has followed, by row key. */
  stopped: {} as Record<string, Stopped>,
});

/** The rows whose running turn is the one sent to go on. */
const tried = new Set<string>();

/** What the store needs of the integrated sessions, set by them. */
export interface Hands {
  /** Starts the row's run again as a fresh conversation from its notes;
      false where it could not, with nothing changed. */
  goOn(key: string, at: number): Promise<boolean>;
  /** Sends the row's agent a line as the workbench's own. */
  send(key: string, text: string): boolean;
  /** Writes a quiet line into the row's conversation. */
  say(key: string, text: string, warning: boolean): void;
}

let hands: Hands | null = null;

export function setHands(given: Hands | null) {
  hands = given;
}

/** This part of the settings. */
export function autoResumeSettings(): Pick<Settings, "autoResume"> {
  return { autoResume: autoResume.next };
}

/** Takes the core's word for the machine. Anything but true is off. */
export function adoptAutoResume(value: unknown) {
  autoResume.next = value === true;
}

/** The row of the session that started a session, told by the module
    that knows who started what. */
let parentOf: (session: Session) => Session | null = () => null;

export function parentsFrom(how: (session: Session) => Session | null) {
  parentOf = how;
}

/** The session whose choice a session goes by: itself, or the one that
    started it while the window has that one, and so on up. */
function chooser(session: Session): Session {
  let at = session;
  for (let step = 0; step < 8; step += 1) {
    const parent = parentOf(at);
    if (parent === null || parent.key === at.key) break;
    at = parent;
  }
  return at;
}

/** The session a session's choice is set by, where that is another: the
    one that started it. */
export function followed(session: Session): Session | null {
  const other = chooser(session);
  return other.key === session.key ? null : other;
}

/** Whether the conversation can go on by itself at all: a Claude Code
    conversation whose account's figures hold a session window. */
export function offered(session: Session): boolean {
  if (session.kind !== "integrated" || session.agent !== "claude-code") return false;
  const report = limitsOf(hostOf(session.project), session.agent, session.account);
  return report !== null && report.windows.some((window) => window.kind === "session");
}

/** Whether the conversation goes on by itself, as chosen for it. */
export function isOn(session: Session): boolean {
  if (!offered(session)) return false;
  return autoResume.rows[chooser(session).key] ?? autoResume.next;
}

/** The row's run starts: it takes the last choice, unless it has one. */
export function settle(key: string) {
  if (autoResume.rows[key] === undefined) autoResume.rows[key] = autoResume.next;
}

/** The user chose on a conversation's composer. The choice is kept for
    the next new conversation too. */
export function choose(key: string, on: boolean) {
  autoResume.rows[key] = on;
  if (autoResume.next !== on) {
    autoResume.next = on;
    persist({ autoResume: on });
  }
  look();
}

/** When the conversation goes on by itself, in milliseconds: the reset
    of the window that cut its turn short. Null where it does not. */
export function resumesAt(session: Session | null): number | null {
  if (session === null) return null;
  const stopped = autoResume.stopped[session.key];
  if (stopped === undefined || session.status !== "running" || !isOn(session)) return null;
  return stopped.resetsAt;
}

/** What a row and the status bar say of a conversation that waits to go
    on: `resumes 14:00`. Null where it does not. */
export function resumesWords(session: Session | null): string | null {
  const at = resumesAt(session);
  return at === null ? null : `resumes ${clock(at)}`;
}

let timer: ReturnType<typeof setInterval> | null = null;

function watch() {
  const any = Object.keys(autoResume.stopped).length > 0;
  if (any && timer === null) timer = setInterval(() => look(), LOOK_EVERY);
  if (!any && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function forget(key: string) {
  delete autoResume.stopped[key];
  watch();
}

/**
 * The agent said the usage limit refused the turn that just ended:
 * `window` is the window used up and `resetsAt` when it starts over, in
 * seconds. Only the session window with a time is waited for. Where the
 * turn was the one sent to go on, that was the one try.
 */
export function limitEnded(key: string, window: string | null, resetsAt: number | null) {
  if (tried.delete(key)) {
    forget(key);
    hands?.say(key, "The usage limit stopped it again. It does not go on by itself a second time.", true);
    return;
  }
  if (window !== "session" || resetsAt === null) {
    forget(key);
    return;
  }
  autoResume.stopped[key] = { resetsAt: resetsAt * 1000, going: false };
  watch();
}

/** A turn began in the row's run, or ended some other way: nothing waits. */
export function turnMoved(key: string, began: boolean) {
  if (!began) tried.delete(key);
  forget(key);
}

/** The row's run ended, or the row is gone. */
export function runOver(key: string) {
  tried.delete(key);
  forget(key);
}

/** Whether figures read since the reset show the session window open,
    used up until a later time, or neither yet. */
function standing(session: Session, stopped: Stopped, now: number): "open" | "none" | "unread" | number | "shut" {
  const report = limitsOf(hostOf(session.project), session.agent, session.account);
  if (report === null || (report.readAt ?? 0) * 1000 < stopped.resetsAt) return "unread";
  const window = report.windows.find((one) => one.kind === "session");
  if (window === undefined) return "none";
  if (toneOf(window) !== "error") return "open";
  const later = window.resetsAt === null ? null : window.resetsAt * 1000;
  return later !== null && later > now ? later : "shut";
}

async function goOn(session: Session, stopped: Stopped, now: number) {
  const key = session.key;
  stopped.going = true;
  try {
    const report = await core().accountLimits({
      project: session.project,
      agent: session.agent,
      configDir: dirFor(session.account, session.agent),
      read: true,
      worked: true,
      since: Math.ceil(stopped.resetsAt / 1000),
    });
    if (report !== null && report !== undefined) heardLimits(hostOf(session.project), session.account, report);
  } catch {
    // Read as figures that did not come.
  }
  const row = byKey(key);
  // The wait was ended, or the choice turned off, while the usage was read.
  if (row === null || autoResume.stopped[key] !== stopped || resumesAt(row) === null) {
    stopped.going = false;
    return;
  }
  const stands = standing(row, stopped, now);
  if (stands === "unread") {
    stopped.going = false;
    if (now - stopped.resetsAt >= GIVE_UP_AFTER) {
      forget(key);
      hands?.say(key, "Did not go on by itself: the usage could not be read after the limit reset.", true);
    }
    return;
  }
  if (typeof stands === "number") {
    stopped.resetsAt = stands;
    stopped.going = false;
    return;
  }
  if (stands !== "open") {
    forget(key);
    if (stands === "shut") hands?.say(key, "Did not go on by itself: the usage limit still holds.", true);
    return;
  }
  const went = (await hands?.goOn(key, stopped.resetsAt)) ?? false;
  if (autoResume.stopped[key] === stopped) forget(key);
  if (!went) {
    hands?.say(key, "Did not go on by itself: the conversation could not be started again from its notes.", true);
    return;
  }
  tried.add(key);
  if (hands?.send(key, GO_ON) !== true) tried.delete(key);
}

/** Looks at every wait: one whose row is gone or no longer runs ends, and
    one whose time has come reads the usage and goes on. */
export function look(now = Date.now()): Promise<void> {
  const going: Promise<void>[] = [];
  for (const [key, stopped] of Object.entries(autoResume.stopped)) {
    const session = byKey(key);
    if (session === null || session.status !== "running") {
      forget(key);
      continue;
    }
    if (stopped.going || resumesAt(session) === null) continue;
    // Something of the user's is under way in the row: it is theirs now.
    if (session.working || session.needs !== null) continue;
    if (now < stopped.resetsAt + MARGIN) continue;
    going.push(goOn(session, autoResume.stopped[key], now));
  }
  return Promise.all(going).then(() => {});
}

/** Test seam. */
export function resetAutoResume() {
  autoResume.next = false;
  for (const key of Object.keys(autoResume.rows)) delete autoResume.rows[key];
  for (const key of Object.keys(autoResume.stopped)) delete autoResume.stopped[key];
  tried.clear();
  watch();
}
